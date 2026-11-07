-- Live badge: a "LIVE NOW" pill on a seller's public profile, driven by their
-- YouTube channel. The config (channel URL + enabled flag) is one nullable
-- JSON column on Kyte (draft) and PublishedKyte (mirrored at publish time),
-- same pattern as tipJar. The live check itself runs at read time in the api
-- (apps/api/src/live/youtube-live.ts) with a 2-minute in-memory cache, so no
-- stored live state is needed.
ALTER TABLE "Kyte" ADD COLUMN "liveBadge" JSONB;

ALTER TABLE "PublishedKyte" ADD COLUMN "liveBadge" JSONB;
