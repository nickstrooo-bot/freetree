import type { FastifyInstance } from "fastify";
import { getDb } from "@kytelink/db";
import { liveBadgeSchema } from "@kytelink/schemas";
import { checkYoutubeLive, type YoutubeLiveStatus } from "../live/youtube-live";

// Public read-only live status for one profile's "LIVE NOW" badge.
// GET /live-status/:username -> { isLive, videoUrl, checkedAt }.
//
// The check runs at read time with a 2-minute in-memory cache per username
// (Kitab-Link polls on a ~2 minute cron; this is the same interval, applied
// lazily instead). A popular profile therefore fetches YouTube at most once
// per 2 minutes no matter how many visitors load it.
//
// Failure rules, also from Kitab-Link: an inconclusive read (network failure
// or YouTube's empty page variant) never flips state — the route serves the
// stale cached value if there is one, else 503. And an offline -> live
// transition is confirmed with a second check before it is trusted, because
// turning the badge on is a visible public effect.
const CACHE_TTL_MS = 120_000;

interface CachedStatus {
  status: YoutubeLiveStatus;
  checkedAt: number;
}

const cache = new Map<string, CachedStatus>();

function youtubeApiKey(): string | null {
  const key = (process.env.YOUTUBE_API_KEY ?? "").trim();
  return key || null;
}

export function registerLiveStatusRoutes(app: FastifyInstance): void {
  app.get("/live-status/:username", async (req, reply) => {
    const { username } = req.params as { username: string };
    const key = username.toLowerCase();

    const db = getDb();
    const published = await db.publishedKyte.findFirst({
      where: { username: key },
      select: { liveBadge: true },
    });
    if (!published) {
      await reply.status(404).send({ error: "NOT_FOUND" });
      return;
    }
    const badge = liveBadgeSchema.safeParse(published.liveBadge);
    if (!badge.success || !badge.data.enabled) {
      await reply.status(404).send({ error: "LIVE_BADGE_OFF" });
      return;
    }

    const cached = cache.get(key);
    if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
      await reply.send({ ...cached.status, checkedAt: cached.checkedAt });
      return;
    }

    const apiKey = youtubeApiKey();
    let status = await checkYoutubeLive(badge.data.youtubeChannelUrl, apiKey);
    if (status === null) {
      if (cached) {
        await reply.send({ ...cached.status, checkedAt: cached.checkedAt, stale: true });
        return;
      }
      await reply.status(503).send({ error: "LIVE_CHECK_FAILED" });
      return;
    }

    if (status.isLive && (!cached || !cached.status.isLive)) {
      const confirm = await checkYoutubeLive(badge.data.youtubeChannelUrl, apiKey);
      if (confirm === null || !confirm.isLive) {
        if (cached) {
          await reply.send({ ...cached.status, checkedAt: cached.checkedAt, stale: true });
          return;
        }
        await reply.status(503).send({ error: "LIVE_CHECK_FAILED" });
        return;
      }
      status = confirm;
    }

    const checkedAt = Date.now();
    cache.set(key, { status, checkedAt });
    await reply.send({ ...status, checkedAt });
  });
}
