import { ulid } from "ulid";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  assetKindSchema,
  isKyteEffectivelySuspended,
  LIMIT_DEFAULTS,
  resolveLimit,
  VOICE_INTRO_CONTENT_TYPES,
  VOICE_INTRO_EXTENSION,
  VOICE_INTRO_MAX_BYTES,
  type VoiceIntroContentType,
} from "@kytelink/schemas";
import { featureDisabled, kyteSuspended, limitReached, router } from "@kytelink/trpc";
import { authed, kyte } from "../trpc/procedures";
import { assertCan, resolveKyteAccess } from "../trpc/permissions";
import { suspendedKyteMessage, suspendedOrgMessage } from "../moderation/appeal-copy";
import type { KyteAccessContext } from "../trpc/context-ext";
import type { Store } from "../store/store";
import { enforceRateLimit, isRedisLike, RedisRateLimiter } from "../trpc/rate-limit";
import { okSchema } from "../routers/shapes";
import { getCdnUrl, getLqipUrl } from "@kytelink/cdn";
import { buildAssetKey, buildLqipKey, buildRawUploadKey } from "./keys";
import { createPresignedPutUrl, deleteObject, getObjectBuffer, headObject, putObject } from "./s3-client";
import { imageProcessQueue } from "./image-process-queue";
import { sharpNormalizeModule, type NormalizeKind } from "./sharp-normalize";
import { repositoryFor, type AssetRow } from "./repository";

const ALLOWED_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const ALLOWED_AUDIO_TYPES = new Set<string>(VOICE_INTRO_CONTENT_TYPES);
const UPLOADABLE_KINDS = new Set(["AVATAR", "LINK_IMAGE", "VOICE_INTRO"]);

// Magic-byte check for audio uploads (the image path gets the same guarantee
// from sharp, which refuses non-images). MP3: an ID3 tag or an MPEG frame
// sync. M4A/MP4: an ftyp box at offset 4. Anything else is rejected — the
// declared content type alone is not trusted. Takes Uint8Array (what
// getObjectBuffer returns) and compares bytes directly — no Buffer needed.
function isAudioBytes(buffer: Uint8Array, contentType: string): boolean {
  if (contentType === "audio/mpeg") {
    // "ID3" = 0x49 0x44 0x33
    if (buffer.length >= 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
      return true;
    }
    return buffer.length >= 2 && buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0;
  }
  // "ftyp" = 0x66 0x74 0x79 0x70 at offset 4
  return (
    buffer.length >= 8 &&
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  );
}

function assetUrl(key: string): { url: string; lqip: string } {
  return { url: getCdnUrl(key), lqip: getLqipUrl(key) };
}

// These two run on `authed`, not `kyte`, so they resolve access themselves and
// have to repeat the effective-suspension gate the kyte chain applies.
async function assertNotSuspended(store: Store, access: KyteAccessContext): Promise<void> {
  if (access.org.suspendedAt !== null) {
    throw kyteSuspended(suspendedOrgMessage(access.org.suspensionReason, access.org.id));
  }
  if (
    access.kyte &&
    isKyteEffectivelySuspended({
      moderationStatus: access.kyte.moderationStatus,
      orgSuspendedAt: access.org.suspendedAt,
    })
  ) {
    throw kyteSuspended(
      suspendedKyteMessage(await store.latestModerationReason(access.kyte.id), access.kyte.username),
    );
  }
}

export const assetsRouter = router({
  createUploadUrl: kyte
    .input(
      z.object({
        kyteId: z.string().min(1),
        kind: assetKindSchema,
        contentType: z.string().min(1),
        sizeBytes: z.number().int().positive(),
      }),
    )
    .output(
      z.object({
        assetId: z.string(),
        uploadUrl: z.string(),
        fields: z.record(z.string(), z.string()).nullable(),
        key: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.config.capabilities.uploads) throw featureDisabled();
      assertCan(ctx.access.effectiveRole, "upload_asset");

      if (!UPLOADABLE_KINDS.has(input.kind)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "OG images are generated server-side and cannot be uploaded directly.",
        });
      }
      // Voice intros get their own allowlist + cap: mp3/m4a only, ~5 MB. The
      // 60-second duration cap is enforced by the editor before upload (it
      // reads the clip length from the file); the server has no audio prober,
      // so the size cap is the hard backstop here.
      if (input.kind === "VOICE_INTRO") {
        if (!ALLOWED_AUDIO_TYPES.has(input.contentType)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Voice intros must be mp3 or m4a audio.",
          });
        }
        if (input.sizeBytes > VOICE_INTRO_MAX_BYTES) {
          throw limitReached(`Voice intros are capped at ${VOICE_INTRO_MAX_BYTES} bytes.`);
        }
      } else {
        if (!ALLOWED_CONTENT_TYPES.has(input.contentType)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Unsupported content type: ${input.contentType}` });
        }
        const uploadMax = resolveLimit(
          LIMIT_DEFAULTS.uploadMaxBytes,
          ctx.access.org.limitOverrides.uploadMaxBytes,
        );
        if (input.sizeBytes > uploadMax) {
          throw limitReached(`Uploads are capped at ${uploadMax} bytes.`);
        }
      }
      if (isRedisLike(ctx.redis)) {
        await enforceRateLimit(
          new RedisRateLimiter(ctx.redis),
          "upload-url",
          { user: ctx.user.id },
          { failOpen: false },
        );
      }

      const org = ctx.access.org;
      const repo = repositoryFor(ctx.store);
      const used = await repo.sumSizeBytesForOrg(org.id);
      const limit = resolveLimit(LIMIT_DEFAULTS.storageBytesPerOrg, org.limitOverrides.storageBytesPerOrg);
      if (used + input.sizeBytes > limit) {
        throw limitReached(`Limit reached for storageBytesPerOrg (${limit} bytes).`);
      }

      const assetId = ulid();
      const rawKey = buildRawUploadKey(input.kyteId, assetId);
      const uploadUrl = await createPresignedPutUrl(rawKey, input.contentType);

      repo.createPendingUpload({
        assetId,
        kyteId: input.kyteId,
        uploadedById: ctx.user.id,
        kind: input.kind as "AVATAR" | "LINK_IMAGE" | "VOICE_INTRO",
        contentType: input.contentType,
        declaredSizeBytes: input.sizeBytes,
        rawKey,
        createdAt: new Date(),
      });

      return { assetId, uploadUrl, fields: null, key: rawKey };
    }),

  finalize: authed
    .input(z.object({ assetId: z.string().min(1) }))
    .output(z.object({ url: z.string(), lqip: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.config.capabilities.uploads) throw featureDisabled();

      const repo = repositoryFor(ctx.store);
      const pending = repo.peekPendingUpload(input.assetId);
      if (!pending) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No pending upload for this asset." });
      }

      const access = await resolveKyteAccess(ctx.store, ctx.user, { kyteId: pending.kyteId });
      assertCan(access.effectiveRole, "upload_asset");
      await assertNotSuspended(ctx.store, access);

      repo.takePendingUpload(input.assetId);

      // Voice intro: audio is stored as-is — no sharp normalization, no lqip.
      // The raw object moves to its final key with the extension matching its
      // declared audio type, the magic bytes are checked (the image path gets
      // the same guarantee from sharp), and the kyte's voice intro points at it.
      if (pending.kind === "VOICE_INTRO") {
        const ext = VOICE_INTRO_EXTENSION[pending.contentType as VoiceIntroContentType];
        const finalKey = buildAssetKey(pending.kyteId, "VOICE_INTRO", ulid(), ext);
        const head = await headObject(pending.rawKey);
        if (head.sizeBytes > VOICE_INTRO_MAX_BYTES) {
          await deleteObject(pending.rawKey).catch(() => undefined);
          throw limitReached(`Voice intros are capped at ${VOICE_INTRO_MAX_BYTES} bytes.`);
        }
        const raw = await getObjectBuffer(pending.rawKey);
        if (!isAudioBytes(raw, pending.contentType)) {
          await deleteObject(pending.rawKey).catch(() => undefined);
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Uploaded file is not a valid audio file.",
          });
        }
        await putObject(finalKey, raw, pending.contentType);
        await deleteObject(pending.rawKey).catch(() => undefined);

        const voiceRow: AssetRow = {
          id: input.assetId,
          kyteId: pending.kyteId,
          uploadedById: pending.uploadedById,
          key: finalKey,
          kind: "VOICE_INTRO",
          contentType: pending.contentType,
          sizeBytes: head.sizeBytes,
          width: null,
          height: null,
          createdAt: new Date(),
        };
        await repo.insertAsset(voiceRow);

        const voiceUrl = getCdnUrl(finalKey);
        if (access.kyte) {
          await ctx.store.setKyteVoiceIntro(access.kyte.id, voiceRow.id);
          await ctx.store.updateDraft(access.kyte.id, {
            ...access.kyte.draft,
            voiceIntro: { url: voiceUrl },
          });
        }
        return { url: voiceUrl, lqip: null };
      }

      const finalKey = buildAssetKey(pending.kyteId, pending.kind, ulid(), "webp");
      const lqipKey = buildLqipKey(finalKey);

      const normalized = await imageProcessQueue.run(async () => {
        const head = await headObject(pending.rawKey);
        // Re-resolved here rather than trusted from the pre-sign step: the cap
        // can change between requesting the URL and the object landing.
        const objectMax = resolveLimit(
          LIMIT_DEFAULTS.uploadMaxBytes,
          access.org.limitOverrides.uploadMaxBytes,
        );
        if (head.sizeBytes > objectMax) {
          await deleteObject(pending.rawKey).catch(() => undefined);
          throw limitReached(`Uploaded object exceeds the ${objectMax} byte cap.`);
        }

        const raw = await getObjectBuffer(pending.rawKey);
        const normalizeKind: NormalizeKind = pending.kind === "AVATAR" ? "avatar" : "link_image";

        let result;
        try {
          result = await sharpNormalizeModule.normalizeImage(raw, normalizeKind);
        } catch (error) {
          await deleteObject(pending.rawKey).catch(() => undefined);
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Uploaded file is not a valid image.",
            cause: error,
          });
        }

        await putObject(finalKey, result.main.buffer, result.main.contentType);
        await putObject(lqipKey, result.lqip.buffer, result.lqip.contentType);
        await deleteObject(pending.rawKey).catch(() => undefined);

        return result;
      });

      const assetRow: AssetRow = {
        id: input.assetId,
        kyteId: pending.kyteId,
        uploadedById: pending.uploadedById,
        key: finalKey,
        kind: pending.kind,
        contentType: normalized.main.contentType,
        sizeBytes: normalized.main.sizeBytes,
        width: normalized.main.width,
        height: normalized.main.height,
        createdAt: new Date(),
      };
      await repo.insertAsset(assetRow);

      const { url, lqip } = assetUrl(finalKey);

      if (pending.kind === "AVATAR" && access.kyte) {
        await ctx.store.setKyteAvatar(access.kyte.id, assetRow.id);
        await ctx.store.updateDraft(access.kyte.id, { ...access.kyte.draft, avatar: { url, lqip } });
      }

      return { url, lqip };
    }),

  // Removes the kyte's voice intro (asset row + column + stored object) and
  // clears the draft projection. The asset id lives server-side — the draft
  // only carries the URL — so removal goes through the kyte, not the asset id.
  clearVoiceIntro: kyte
    .input(z.object({ kyteId: z.string().min(1) }))
    .output(okSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.config.capabilities.uploads) throw featureDisabled();
      assertCan(ctx.access.effectiveRole, "upload_asset");
      const removed = await ctx.store.takeKyteVoiceIntro(input.kyteId);
      if (removed) {
        await deleteObject(removed.key).catch(() => undefined);
      }
      const k = ctx.access.kyte!;
      await ctx.store.updateDraft(input.kyteId, { ...k.draft, voiceIntro: null });
      return { ok: true } as const;
    }),

  delete: authed
    .input(z.object({ assetId: z.string().min(1) }))
    .output(okSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.config.capabilities.uploads) throw featureDisabled();

      const repo = repositoryFor(ctx.store);
      const asset = await repo.getAsset(input.assetId);
      if (!asset) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Asset not found." });
      }

      const access = await resolveKyteAccess(ctx.store, ctx.user, { kyteId: asset.kyteId });
      assertCan(access.effectiveRole, "upload_asset");
      await assertNotSuspended(ctx.store, access);

      await deleteObject(asset.key).catch(() => undefined);
      // Only images have a lqip sidecar; audio has none.
      if (asset.kind !== "VOICE_INTRO") {
        await deleteObject(buildLqipKey(asset.key)).catch(() => undefined);
      }
      await repo.removeAsset(input.assetId);

      const { url } = assetUrl(asset.key);
      if (access.kyte && asset.kind === "AVATAR" && access.kyte.draft.avatar?.url === url) {
        await ctx.store.setKyteAvatar(access.kyte.id, null);
        await ctx.store.updateDraft(access.kyte.id, { ...access.kyte.draft, avatar: null });
      }
      if (access.kyte && asset.kind === "VOICE_INTRO" && access.kyte.draft.voiceIntro?.url === url) {
        await ctx.store.setKyteVoiceIntro(access.kyte.id, null);
        await ctx.store.updateDraft(access.kyte.id, { ...access.kyte.draft, voiceIntro: null });
      }

      return { ok: true } as const;
    }),
});
