import { z } from "zod";
import { safeWebUrlSchema } from "./content-policy";

// ─── Live badge ───────────────────────────────────────────────────────────────
// A "LIVE NOW" badge on the seller's public profile, driven by their YouTube
// channel. The channel URL (or @handle) is stored here; the live check itself
// runs server-side in the api (apps/api/src/live/youtube-live.ts, adapted
// from Kitab-Link's lib/youtube-live.ts) and the public page polls it.
// Null = no badge on this profile.

export const liveBadgeSchema = z.object({
  enabled: z.boolean().default(true),
  youtubeChannelUrl: safeWebUrlSchema,
});

export type LiveBadge = z.infer<typeof liveBadgeSchema>;
