// YouTube live detection, no API key required.
//
// Adapted from Kitab-Link's lib/youtube-live.ts (MIT,
// https://github.com/Kurohiko-id/Kitab-Link-Self-Hosted): fetch the channel's
// /live page, parse `ytInitialPlayerResponse` with a brace-matching JSON parse
// (never a per-field regex — the same field names appear in sidebar
// recommendations for *other* channels), and judge live/offline from
// videoDetails + microformat + playabilityStatus scoped to that one video.
//
// Two rules from Kitab-Link that matter and are kept verbatim in spirit:
// - "unknown" is not "offline": when the page carries no player response at
//   all (YouTube serves an emptier variant to some datacenter IPs), the caller
//   must treat it as "check failed, try again later" — never flip a live badge
//   off on an inconclusive read.
// - An optional YouTube Data API path (YOUTUBE_API_KEY) is the reliable route:
//   it never hits the HTML bot wall. It costs ~2 quota units per check
//   (channel id cached) out of the free 10,000/day.
//
// The scrape path can fail from Railway's datacenter IP (YouTube's anti-bot
// page variant). That is a deployment fact, not a code bug: without
// YOUTUBE_API_KEY the badge may stay dark on some hosts.

const FETCH_TIMEOUT_MS = 10_000;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export type YoutubeLiveStatus = { isLive: boolean; videoUrl: string | null };

/** Accept a channel URL, a handle, or a bare "@handle" and normalize to /live. */
export function toLiveUrl(input: string): string {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) {
    // A bare @handle is a YouTube path; a bare domain is its own host — don't
    // glue the domain onto youtube.com.
    url = url.startsWith("@")
      ? `https://www.youtube.com/${url}`
      : `https://${url.replace(/^\/+/, "")}`;
  }
  url = url.replace(/\/+$/, "");
  if (!/\/(live|watch)/.test(url)) url += "/live";
  return url;
}

function extractCanonicalUrl(html: string): string | null {
  const href = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
  // YouTube sometimes renders the literal string "undefined" here — treat it
  // as absent, not as a URL.
  return href && href !== "undefined" ? href : null;
}

// Last resort when the player response is missing entirely: the first videoId
// anywhere in the HTML. Loose on purpose, so only called when nothing better
// exists.
function extractVideoId(html: string): string | null {
  return /"videoId":"([a-zA-Z0-9_-]{11})"/.exec(html)?.[1] ?? null;
}

// Parse the `ytInitialPlayerResponse` object whole, brace by brace (respecting
// string contents), then JSON.parse — never regex for single fields.
export function extractPlayerResponse(html: string): Record<string, unknown> | null {
  const marker = /ytInitialPlayerResponse\s*=/.exec(html);
  if (!marker) return null;

  const start = html.indexOf("{", marker.index + marker[0].length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export type LiveVerdict = "live" | "offline" | "unknown";

/**
 * Judge live/offline from a parsed player response. "unknown" when there is no
 * evidence either way — the caller must not treat it as offline.
 */
export function judgeLiveStatus(html: string): { verdict: LiveVerdict; videoId: string | null } {
  const pr = extractPlayerResponse(html);
  if (!pr) return { verdict: "unknown", videoId: null };

  const videoDetails = (pr.videoDetails ?? {}) as Record<string, unknown>;
  const microformat = (
    (pr.microformat as Record<string, unknown> | undefined)?.playerMicroformatRenderer ?? {}
  ) as Record<string, unknown>;
  const liveBroadcastDetails = (microformat.liveBroadcastDetails ??
    videoDetails.liveBroadcastDetails ??
    null) as { isLiveNow?: boolean } | null;
  const videoId = typeof videoDetails.videoId === "string" ? videoDetails.videoId : null;
  const playabilityStatus = (pr.playabilityStatus as Record<string, unknown> | undefined)?.status;

  // Two independent signals for "scheduled, not started yet" — both more
  // specific than isUpcoming alone; reject them before isLiveNow is read.
  if (playabilityStatus === "LIVE_STREAM_OFFLINE") return { verdict: "offline", videoId };
  if (videoDetails.isUpcoming === true || microformat.isUpcoming === true) {
    return { verdict: "offline", videoId };
  }

  if (liveBroadcastDetails?.isLiveNow === true) return { verdict: "live", videoId };
  if (liveBroadcastDetails?.isLiveNow === false) return { verdict: "offline", videoId };

  return { verdict: "unknown", videoId };
}

// ─── YouTube Data API path (optional, YOUTUBE_API_KEY) ───────────────────────

const API_BASE = "https://www.googleapis.com/youtube/v3";

type ChannelRef = { channelId: string } | { handle: string } | { username: string };

export function parseChannelRef(input: string): ChannelRef | null {
  const s = input.trim();
  const id = /(?:^|\/channel\/)(UC[\w-]{22})(?:[/?#]|$)/.exec(s)?.[1];
  if (id) return { channelId: id };
  const handle = /(?:^|youtube\.com\/)@([\w.-]+)/.exec(s)?.[1];
  if (handle) return { handle };
  const username = /youtube\.com\/user\/([\w.-]+)/.exec(s)?.[1];
  if (username) return { username };
  return null;
}

async function apiGet(
  path: string,
  params: Record<string, string>,
  apiKey: string,
): Promise<Record<string, unknown> | null> {
  const url = `${API_BASE}/${path}?${new URLSearchParams({ ...params, key: apiKey })}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return null;
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) return null;
  return json;
}

// Per-process channel-id cache (a miss costs 1 quota unit, not a failure).
const channelIdCache = new Map<string, string>();

async function resolveChannelId(channelUrl: string, apiKey: string): Promise<string | null> {
  const cached = channelIdCache.get(channelUrl);
  if (cached) return cached;
  const ref = parseChannelRef(channelUrl);
  if (!ref) return null;
  let channelId: string | null = null;
  if ("channelId" in ref) {
    channelId = ref.channelId;
  } else {
    const params: Record<string, string> =
      "handle" in ref
        ? { part: "id", forHandle: `@${ref.handle}` }
        : { part: "id", forUsername: ref.username };
    const json = await apiGet("channels", params, apiKey);
    const items = json?.items as Array<{ id?: string }> | undefined;
    channelId = items?.[0]?.id ?? null;
  }
  if (channelId) channelIdCache.set(channelUrl, channelId);
  return channelId;
}

async function checkYoutubeLiveViaApi(
  channelUrl: string,
  apiKey: string,
): Promise<YoutubeLiveStatus | null> {
  const channelId = await resolveChannelId(channelUrl, apiKey);
  if (!channelId) return null;

  // The channel's uploads playlist ("UU" + id without "UC") holds every public
  // video, newest first — one 1-unit call for up to 50 ids.
  const uploads = await apiGet(
    "playlistItems",
    {
      part: "contentDetails",
      playlistId: `UU${channelId.slice(2)}`,
      maxResults: "50",
      fields: "items/contentDetails/videoId",
    },
    apiKey,
  );
  if (!uploads) return null;
  const items = uploads.items as Array<{ contentDetails?: { videoId?: string } }> | undefined;
  const ids: string[] = (items ?? [])
    .map((i) => i.contentDetails?.videoId)
    .filter((v): v is string => Boolean(v));
  if (ids.length === 0) return { isLive: false, videoUrl: null };

  // liveBroadcastContent is the official signal: "live" | "upcoming" | "none".
  const videos = await apiGet(
    "videos",
    { part: "snippet", id: ids.join(","), fields: "items(id,snippet/liveBroadcastContent)" },
    apiKey,
  );
  if (!videos) return null;
  const videoItems = videos.items as Array<{
    id?: string;
    snippet?: { liveBroadcastContent?: string };
  }> | undefined;
  const live = (videoItems ?? []).find((v) => v.snippet?.liveBroadcastContent === "live");
  return live
    ? { isLive: true, videoUrl: `https://www.youtube.com/watch?v=${live.id}` }
    : { isLive: false, videoUrl: null };
}

// Without a key: fetch the channel's /live page and judge the player response.
// Returns null on network failure OR on an inconclusive read — both mean
// "don't change anything, try again next poll", never "offline".
export async function checkYoutubeLive(
  channelUrl: string,
  apiKey?: string | null,
): Promise<YoutubeLiveStatus | null> {
  try {
    if (apiKey) return await checkYoutubeLiveViaApi(channelUrl, apiKey);

    const res = await fetch(toLiveUrl(channelUrl), {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": BROWSER_USER_AGENT },
    });
    if (!res.ok) return null;

    const html = await res.text();
    const { verdict, videoId } = judgeLiveStatus(html);
    if (verdict === "unknown") return null;
    if (verdict === "offline") return { isLive: false, videoUrl: null };

    const canonical = extractCanonicalUrl(html);
    const videoUrl = videoId
      ? `https://www.youtube.com/watch?v=${videoId}`
      : canonical?.includes("/watch")
        ? canonical
        : extractVideoId(html)
          ? `https://www.youtube.com/watch?v=${extractVideoId(html)}`
          : null;
    // Live but no video URL at all is incomplete data — stay quiet rather than
    // flagging live with nowhere to link (the badge needs the URL).
    if (!videoUrl) return null;
    return { isLive: true, videoUrl };
  } catch {
    return null;
  }
}
