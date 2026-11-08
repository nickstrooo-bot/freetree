import { beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { getClickhouse } from "@kytelink/clickhouse";
import { appCodeOf, createCallerFactory, type TrpcContext } from "@kytelink/trpc";
import { loadConfig, setConfigForTest } from "../config";
import { logger } from "../logger";
import { createSeededStore, type MemoryStore } from "../store/memory-store";
import { assetsRouter } from "./router";
import { repositoryFor } from "./repository";
import { getObjectBuffer, headObject } from "./s3-client";

const createCaller = createCallerFactory(assetsRouter);

const CDN = process.env.NEXT_PUBLIC_CDN_URL ?? "http://localhost:5003";

function contextFor(store: MemoryStore, userId: string, email: string): TrpcContext {
  return {
    session: { userId, email, isAdmin: false, status: "ACTIVE" },
    user: { id: userId, email },
    ip: "127.0.0.1",
    redis: null,
    db: store,
    ch: getClickhouse(),
    log: logger,
  };
}

async function testJpeg(width: number, height: number): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 60, b: 20 } },
  })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buffer);
}

let store: MemoryStore;

beforeEach(() => {
  store = createSeededStore();
  setConfigForTest(
    loadConfig({
      ...process.env,
      ADMIN_EMAILS: "agent-admin@kytelink.dev",
      WEB_BASE_URL: "http://localhost:3000",
    }),
  );
});

describe("assets.createUploadUrl -> PUT -> assets.finalize (real MinIO)", () => {
  it("uploads, normalizes, and stores an avatar with a real LQIP sibling", async () => {
    const caller = createCaller(contextFor(store, "usr_agent", "agent@kytelink.dev"));
    const image = await testJpeg(1400, 1400);

    const { assetId, uploadUrl, key } = await caller.createUploadUrl({
      kyteId: "usr_agent",
      kind: "AVATAR",
      contentType: "image/jpeg",
      sizeBytes: image.byteLength,
    });

    expect(key.startsWith("u/")).toBe(false);
    expect(uploadUrl).toContain("http://localhost:9000/");

    const putResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: image,
    });
    expect(putResponse.ok).toBe(true);

    const result = await caller.finalize({ assetId });
    expect(result.url.startsWith(`${CDN}/u/usr_agent/avatar/`)).toBe(true);
    expect(result.url.endsWith(".webp")).toBe(true);
    expect(result.lqip).toMatch(/\.lqip\.webp$/);

    const finalKey = result.url.replace(`${CDN}/`, "");
    const lqipKey = result.lqip!.replace(`${CDN}/`, "");

    const mainHead = await headObject(finalKey);
    expect(mainHead.contentType).toBe("image/webp");

    const mainBuffer = Buffer.from(await getObjectBuffer(finalKey));
    const mainMeta = await sharp(mainBuffer).metadata();
    expect(mainMeta.width).toBe(512);
    expect(mainMeta.height).toBe(512);
    expect(mainMeta.format).toBe("webp");

    const lqipBuffer = Buffer.from(await getObjectBuffer(lqipKey));
    const lqipMeta = await sharp(lqipBuffer).metadata();
    expect(lqipMeta.width).toBeLessThanOrEqual(24);

    const rawStillThere = await headObject(key).catch(() => null);
    expect(rawStillThere).toBeNull();

    const assetRow = await repositoryFor(store).getAsset(assetId);
    expect(assetRow?.kind).toBe("AVATAR");
    expect(assetRow?.width).toBe(512);
    expect(assetRow?.height).toBe(512);
    expect(assetRow?.sizeBytes).toBe(mainBuffer.byteLength);

    const kyte = await store.kyteById("usr_agent");
    expect(kyte?.draft.avatar?.url).toBe(result.url);
    expect(kyte?.draft.avatar?.lqip).toBe(result.lqip);
  }, 30000);

  it("caps link images at <=256px and keys them under u/{kyteId}/links/", async () => {
    const caller = createCaller(contextFor(store, "usr_agent", "agent@kytelink.dev"));
    const image = await testJpeg(900, 300);

    const { assetId, uploadUrl } = await caller.createUploadUrl({
      kyteId: "usr_agent",
      kind: "LINK_IMAGE",
      contentType: "image/jpeg",
      sizeBytes: image.byteLength,
    });
    await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: image });

    const result = await caller.finalize({ assetId });
    expect(result.url.startsWith(`${CDN}/u/usr_agent/links/`)).toBe(true);
    expect(result.url.endsWith(".webp")).toBe(true);

    const finalKey = result.url.replace(`${CDN}/`, "");
    const buffer = Buffer.from(await getObjectBuffer(finalKey));
    const meta = await sharp(buffer).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(256);
  }, 30000);
});

describe("assets.finalize rejects a non-image upload", () => {
  it("returns BAD_REQUEST and never writes an Asset row", async () => {
    const caller = createCaller(contextFor(store, "usr_agent", "agent@kytelink.dev"));
    const notAnImage = new TextEncoder().encode("<html>totally not an image</html>");

    const { assetId, uploadUrl } = await caller.createUploadUrl({
      kyteId: "usr_agent",
      kind: "AVATAR",
      contentType: "image/png",
      sizeBytes: notAnImage.byteLength,
    });
    await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "image/png" }, body: notAnImage });

    await expect(caller.finalize({ assetId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await repositoryFor(store).getAsset(assetId)).toBeUndefined();
  }, 30000);
});

describe("storage limit (LIMIT_REACHED)", () => {
  it("blocks createUploadUrl once the org's declared-incoming total exceeds the storage cap", async () => {
    await store.setOrgLimits("org_agent_personal", [{ key: "storageBytesPerOrg", value: 1024 }]);

    const caller = createCaller(contextFor(store, "usr_agent", "agent@kytelink.dev"));
    const error = await caller
      .createUploadUrl({ kyteId: "usr_agent", kind: "AVATAR", contentType: "image/png", sizeBytes: 2048 })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(appCodeOf(error)).toBe("LIMIT_REACHED");
  });

  it("blocks a declared size over the hard 10MB upload cap", async () => {
    const caller = createCaller(contextFor(store, "usr_agent", "agent@kytelink.dev"));
    const error = await caller
      .createUploadUrl({
        kyteId: "usr_agent",
        kind: "AVATAR",
        contentType: "image/png",
        sizeBytes: 11 * 1024 * 1024,
      })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(appCodeOf(error)).toBe("LIMIT_REACHED");
  });
});

describe("permissions", () => {
  it("blocks a VIEWER from creating an upload url", async () => {
    const caller = createCaller(contextFor(store, "usr_viewer", "viewer@kytelink.dev"));
    const error = await caller
      .createUploadUrl({ kyteId: "kyte_ag_1", kind: "AVATAR", contentType: "image/png", sizeBytes: 100 })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("suspension gate", () => {
  it("blocks createUploadUrl on an already-suspended kyte", async () => {
    const caller = createCaller(contextFor(store, "usr_agency_owner", "owner@kytelink.dev"));
    const error = await caller
      .createUploadUrl({
        kyteId: "kyte_suspended",
        kind: "AVATAR",
        contentType: "image/png",
        sizeBytes: 100,
      })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(appCodeOf(error)).toBe("KYTE_SUSPENDED");
  });

  it("blocks finalize if the kyte gets suspended after the upload started", async () => {
    const caller = createCaller(contextFor(store, "usr_agent", "agent@kytelink.dev"));
    const image = await testJpeg(600, 600);
    const { assetId, uploadUrl } = await caller.createUploadUrl({
      kyteId: "kyte_ag_1",
      kind: "AVATAR",
      contentType: "image/jpeg",
      sizeBytes: image.byteLength,
    });
    await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: image });

    await store.setKyteModeration("kyte_ag_1", "SUSPENDED");

    const error = await caller
      .finalize({ assetId })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(appCodeOf(error)).toBe("KYTE_SUSPENDED");
  }, 30000);
});

describe("feature gate (uploads capability off)", () => {
  it("returns FEATURE_DISABLED instead of touching S3 when AWS_* is unset", async () => {
    setConfigForTest(
      loadConfig({
        ...process.env,
        AWS_ENDPOINT_URL: undefined,
        AWS_ACCESS_KEY_ID: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
        AWS_S3_BUCKET: undefined,
        ADMIN_EMAILS: "agent-admin@kytelink.dev",
        WEB_BASE_URL: "http://localhost:3000",
      }),
    );

    const caller = createCaller(contextFor(store, "usr_agent", "agent@kytelink.dev"));
    const error = await caller
      .createUploadUrl({ kyteId: "usr_agent", kind: "AVATAR", contentType: "image/png", sizeBytes: 100 })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(appCodeOf(error)).toBe("FEATURE_DISABLED");
  });
});

describe("voice intro (VOICE_INTRO)", () => {
  // Minimal audio the server accepts: it only checks magic bytes, never
  // decodes the clip (the 60s duration cap is enforced by the editor before
  // upload; the 5MB size cap is the server backstop).
  function testMp3(): Uint8Array {
    const header = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const payload = new Uint8Array(1024).fill(0xff);
    const out = new Uint8Array(header.length + payload.length);
    out.set(header);
    out.set(payload, header.length);
    return out;
  }

  function testM4a(): Uint8Array {
    const header = new TextEncoder().encode("0000ftypisom");
    const payload = new Uint8Array(512).fill(0x00);
    const out = new Uint8Array(header.length + payload.length);
    out.set(header);
    out.set(payload, header.length);
    return out;
  }

  it("rejects an image mime for a voice intro", async () => {
    const caller = createCaller(contextFor(store, "usr_agent", "agent@kytelink.dev"));
    // A plain TRPCError (not an AppError), so assert on its code property —
    // appCodeOf only reads AppError codes.
    await expect(
      caller.createUploadUrl({
        kyteId: "usr_agent",
        kind: "VOICE_INTRO",
        contentType: "image/png",
        sizeBytes: 100,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a voice clip over the 5MB cap", async () => {
    const caller = createCaller(contextFor(store, "usr_agent", "agent@kytelink.dev"));
    const error = await caller
      .createUploadUrl({
        kyteId: "usr_agent",
        kind: "VOICE_INTRO",
        contentType: "audio/mpeg",
        sizeBytes: 5 * 1024 * 1024 + 1,
      })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(appCodeOf(error)).toBe("LIMIT_REACHED");
  });

  it("uploads an mp3, stores it under u/{kyteId}/voice/, and sets the draft voice intro", async () => {
    const caller = createCaller(contextFor(store, "usr_agent", "agent@kytelink.dev"));
    const mp3 = testMp3();

    const { assetId, uploadUrl, key } = await caller.createUploadUrl({
      kyteId: "usr_agent",
      kind: "VOICE_INTRO",
      contentType: "audio/mpeg",
      sizeBytes: mp3.byteLength,
    });
    const putResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "audio/mpeg" },
      body: mp3,
    });
    expect(putResponse.ok).toBe(true);

    const result = await caller.finalize({ assetId });
    expect(result.url.startsWith(`${CDN}/u/usr_agent/voice/`)).toBe(true);
    expect(result.url.endsWith(".mp3")).toBe(true);
    expect(result.lqip).toBeNull();

    const assetRow = await repositoryFor(store).getAsset(assetId);
    expect(assetRow?.kind).toBe("VOICE_INTRO");
    expect(assetRow?.sizeBytes).toBe(mp3.byteLength);

    const kyte = await store.kyteById("usr_agent");
    expect(kyte?.draft.voiceIntro?.url).toBe(result.url);

    const rawStillThere = await headObject(key).catch(() => null);
    expect(rawStillThere).toBeNull();
  }, 30000);

  it("uploads an m4a and keys it .m4a", async () => {
    const caller = createCaller(contextFor(store, "usr_agent", "agent@kytelink.dev"));
    const m4a = testM4a();

    const { assetId, uploadUrl } = await caller.createUploadUrl({
      kyteId: "usr_agent",
      kind: "VOICE_INTRO",
      contentType: "audio/mp4",
      sizeBytes: m4a.byteLength,
    });
    await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "audio/mp4" }, body: m4a });

    const result = await caller.finalize({ assetId });
    expect(result.url.startsWith(`${CDN}/u/usr_agent/voice/`)).toBe(true);
    expect(result.url.endsWith(".m4a")).toBe(true);
  }, 30000);

  it("rejects a voice finalize whose bytes are not audio", async () => {
    const caller = createCaller(contextFor(store, "usr_agent", "agent@kytelink.dev"));
    const notAudio = new TextEncoder().encode("<html>totally not audio</html>");

    const { assetId, uploadUrl } = await caller.createUploadUrl({
      kyteId: "usr_agent",
      kind: "VOICE_INTRO",
      contentType: "audio/mpeg",
      sizeBytes: notAudio.byteLength,
    });
    await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "audio/mpeg" }, body: notAudio });

    await expect(caller.finalize({ assetId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await repositoryFor(store).getAsset(assetId)).toBeUndefined();
  }, 30000);

  it("clearVoiceIntro removes the asset row and clears the draft voice intro", async () => {
    const caller = createCaller(contextFor(store, "usr_agent", "agent@kytelink.dev"));
    const mp3 = testMp3();
    const { assetId, uploadUrl } = await caller.createUploadUrl({
      kyteId: "usr_agent",
      kind: "VOICE_INTRO",
      contentType: "audio/mpeg",
      sizeBytes: mp3.byteLength,
    });
    await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "audio/mpeg" }, body: mp3 });
    await caller.finalize({ assetId });

    const cleared = await caller.clearVoiceIntro({ kyteId: "usr_agent" });
    expect(cleared.ok).toBe(true);
    expect(await repositoryFor(store).getAsset(assetId)).toBeUndefined();

    const kyte = await store.kyteById("usr_agent");
    expect(kyte?.draft.voiceIntro).toBeNull();
  }, 30000);
});

describe("delete", () => {
  it("removes the object, the LQIP sibling, the Asset row, and clears the kyte avatar", async () => {
    const caller = createCaller(contextFor(store, "usr_agent", "agent@kytelink.dev"));
    const image = await testJpeg(700, 700);
    const { assetId, uploadUrl } = await caller.createUploadUrl({
      kyteId: "usr_agent",
      kind: "AVATAR",
      contentType: "image/jpeg",
      sizeBytes: image.byteLength,
    });
    await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: image });
    const { url } = await caller.finalize({ assetId });
    const finalKey = url.replace("http://localhost:5003/", "");

    await caller.delete({ assetId });

    expect(await repositoryFor(store).getAsset(assetId)).toBeUndefined();
    await expect(headObject(finalKey)).rejects.toThrow();

    const kyte = await store.kyteById("usr_agent");
    expect(kyte?.draft.avatar).toBeNull();
  }, 30000);
});
