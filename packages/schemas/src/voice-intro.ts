import { z } from "zod";

// ─── Voice intro ─────────────────────────────────────────────────────────────
// A short recorded clip (10–30s) the seller uploads; visitors get a play
// button under the photo. Tap to play, never auto-play. The clip itself is an
// Asset row (kind VOICE_INTRO, stored in MinIO through the asset-upload path);
// profileContent carries only the projection { url }, resolved from the
// voiceIntroAssetId column — the same projection pattern as avatar.
// Null = no voice intro on this profile.
//
// Caps: ~5 MB and 60 seconds. The size cap is enforced server-side (the
// upload URL is refused above it, and finalize re-checks the landed object);
// the duration cap is enforced by the editor before upload (it reads the clip
// length from the file) — the server has no audio prober, so a clip that
// slips past the editor is still bounded by the 5 MB size cap.
export const VOICE_INTRO_MAX_BYTES = 5 * 1024 * 1024;
export const VOICE_INTRO_MAX_SECONDS = 60;
export const VOICE_INTRO_CONTENT_TYPES = ["audio/mpeg", "audio/mp4", "audio/x-m4a"] as const;
export type VoiceIntroContentType = (typeof VOICE_INTRO_CONTENT_TYPES)[number];

export const VOICE_INTRO_EXTENSION: Record<VoiceIntroContentType, string> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
};

export const voiceIntroSchema = z.object({
  url: z.string(),
});

export type VoiceIntro = z.infer<typeof voiceIntroSchema>;
