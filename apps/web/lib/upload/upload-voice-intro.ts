import { VOICE_INTRO_MAX_SECONDS, type VoiceIntroContentType } from "@kytelink/schemas";
import type { ApiClient } from "../api/client";
import { isMockApi } from "../api/client";

// Voice intro upload: mp3/m4a, ~5 MB, 60 seconds. The 5 MB cap is enforced
// server-side (the upload URL is refused above it, and finalize re-checks the
// landed object). The 60-second cap is enforced HERE, before upload — the
// editor reads the clip length from the file itself, because the server has
// no audio prober. A clip whose length cannot be read (some VBR mp3s report
// Infinity) is allowed through; the 5 MB size cap is the backstop.

export interface VoiceIntroUploadResult {
  url: string;
  durationSeconds: number | null;
}

function putWithProgress(
  url: string,
  blob: Blob,
  contentType: string,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => (xhr.status < 400 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("Upload failed"));
    if (signal) signal.addEventListener("abort", () => xhr.abort());
    xhr.send(blob);
  });
}

function audioContentType(file: File): VoiceIntroContentType | null {
  if (
    file.type === "audio/mpeg" ||
    file.type === "audio/mp4" ||
    file.type === "audio/x-m4a"
  ) {
    return file.type;
  }
  // Some browsers report mp3 as audio/mp3 (non-standard); normalize it.
  if (file.type === "audio/mp3") return "audio/mpeg";
  const name = file.name.toLowerCase();
  if (name.endsWith(".mp3")) return "audio/mpeg";
  if (name.endsWith(".m4a")) return "audio/mp4";
  return null;
}

async function readDurationSeconds(file: File): Promise<number | null> {
  const url = URL.createObjectURL(file);
  try {
    const audio = new Audio();
    audio.preload = "metadata";
    audio.src = url;
    await new Promise<void>((resolve, reject) => {
      audio.onloadedmetadata = () => resolve();
      audio.onerror = () => reject(new Error("Could not read this audio file."));
    });
    return Number.isFinite(audio.duration) ? audio.duration : null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function uploadVoiceIntro(
  api: ApiClient,
  kyteId: string,
  file: File,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<VoiceIntroUploadResult> {
  const contentType = audioContentType(file);
  if (!contentType) {
    throw new Error("Please pick an mp3 or m4a file.");
  }

  const durationSeconds = await readDurationSeconds(file);
  if (durationSeconds !== null && durationSeconds > VOICE_INTRO_MAX_SECONDS) {
    throw new Error(
      `That clip is ${Math.round(durationSeconds)} seconds — voice intros are capped at ${VOICE_INTRO_MAX_SECONDS} seconds.`,
    );
  }

  if (isMockApi()) {
    const reader = new FileReader();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      reader.onload = () => {
        onProgress(100);
        resolve(reader.result as string);
      };
      reader.onerror = () => reject(new Error("Read failed"));
      reader.readAsDataURL(file);
    });
    return { url: dataUrl, durationSeconds };
  }

  const created = await api.assets.createUploadUrl({
    kyteId,
    kind: "VOICE_INTRO",
    contentType,
    sizeBytes: file.size,
  });
  await putWithProgress(created.uploadUrl, file, contentType, onProgress, signal);
  const finalized = await api.assets.finalize({ assetId: created.assetId });
  return { url: finalized.url, durationSeconds };
}
