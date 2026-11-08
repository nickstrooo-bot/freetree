-- Soul features (about block, now line, milestone meter, voice intro):
-- four new content columns on Kyte (draft) + PublishedKyte (mirrored at
-- publish time), same pattern as tipJar/liveBadge. The voice intro clip
-- itself is an Asset row (kind VOICE_INTRO); the voiceIntroAssetId column
-- only holds the asset id, exactly like avatarAssetId. The milestone count
-- is computed at read time from completed purchases and is never stored.

ALTER TABLE "Kyte" ADD COLUMN "about" TEXT;
ALTER TABLE "Kyte" ADD COLUMN "nowLine" JSONB;
ALTER TABLE "Kyte" ADD COLUMN "milestone" JSONB;
ALTER TABLE "Kyte" ADD COLUMN "voiceIntroAssetId" TEXT;

ALTER TABLE "PublishedKyte" ADD COLUMN "about" TEXT;
ALTER TABLE "PublishedKyte" ADD COLUMN "nowLine" JSONB;
ALTER TABLE "PublishedKyte" ADD COLUMN "milestone" JSONB;
ALTER TABLE "PublishedKyte" ADD COLUMN "voiceIntroAssetId" TEXT;

-- AssetKind gains VOICE_INTRO. ALTER TYPE ... ADD VALUE cannot run inside a
-- transaction block, so the enum is rebuilt the same way the suspension
-- migration (20260726010000) did it: rename / create / cast / drop.
ALTER TYPE "AssetKind" RENAME TO "AssetKind_old";
CREATE TYPE "AssetKind" AS ENUM ('AVATAR', 'LINK_IMAGE', 'OG_IMAGE', 'VOICE_INTRO');
ALTER TABLE "Asset" ALTER COLUMN "kind" TYPE "AssetKind" USING ("kind"::text)::"AssetKind";
DROP TYPE "AssetKind_old";
