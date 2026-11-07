/**
 * Client-side: read a profile's live status for the "LIVE NOW" badge.
 * Throws on any non-OK response — the caller treats a failure as "badge stays
 * hidden", the same fail-quiet rule as Kitab-Link's "unknown" verdict.
 */
export interface LiveStatus {
  isLive: boolean;
  videoUrl: string | null;
  checkedAt: number;
}

export async function fetchLiveStatus(username: string): Promise<LiveStatus> {
  const base =
    process.env.NEXT_PUBLIC_API_URL ?? (typeof window !== "undefined" ? "" : "http://localhost:3003");
  const response = await fetch(`${base}/live-status/${encodeURIComponent(username)}`);
  const data = (await response.json()) as {
    isLive?: boolean;
    videoUrl?: string | null;
    checkedAt?: number;
    error?: string;
  };
  if (!response.ok || typeof data.isLive !== "boolean") {
    throw new Error(data.error ?? "LIVE_CHECK_FAILED");
  }
  return {
    isLive: data.isLive,
    videoUrl: data.videoUrl ?? null,
    checkedAt: data.checkedAt ?? Date.now(),
  };
}
