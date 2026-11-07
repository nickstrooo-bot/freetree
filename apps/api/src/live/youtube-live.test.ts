import { describe, expect, it } from "vitest";
import {
  extractPlayerResponse,
  judgeLiveStatus,
  parseChannelRef,
  toLiveUrl,
} from "./youtube-live";

function playerHtml(player: Record<string, unknown>): string {
  return `<html><head><link rel="canonical" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"></head><body><script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script></body></html>`;
}

describe("toLiveUrl", () => {
  it.each([
    ["https://www.youtube.com/@nick", "https://www.youtube.com/@nick/live"],
    ["@nick", "https://www.youtube.com/@nick/live"],
    ["youtube.com/@nick/", "https://youtube.com/@nick/live"],
    ["https://www.youtube.com/channel/UC1234567890123456789012", "https://www.youtube.com/channel/UC1234567890123456789012/live"],
    ["https://www.youtube.com/@nick/live", "https://www.youtube.com/@nick/live"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(toLiveUrl(input)).toBe(expected);
  });
});

describe("parseChannelRef", () => {
  it("parses channel ids, handles, and legacy usernames", () => {
    expect(parseChannelRef("https://www.youtube.com/channel/UC1234567890123456789012")).toEqual({
      channelId: "UC1234567890123456789012",
    });
    expect(parseChannelRef("https://www.youtube.com/@nick")).toEqual({ handle: "nick" });
    expect(parseChannelRef("https://www.youtube.com/user/oldname")).toEqual({ username: "oldname" });
    expect(parseChannelRef("https://example.com")).toBeNull();
  });
});

describe("extractPlayerResponse", () => {
  it("parses the whole object, respecting braces inside strings", () => {
    const html = playerHtml({
      videoDetails: { videoId: "dQw4w9WgXcQ", title: "a } tricky { title" },
    });
    const parsed = extractPlayerResponse(html);
    expect((parsed?.videoDetails as { title?: string } | undefined)?.title).toBe(
      "a } tricky { title",
    );
  });

  it("returns null when the page carries no player response", () => {
    expect(extractPlayerResponse("<html><body>nothing here</body></html>")).toBeNull();
  });
});

describe("judgeLiveStatus", () => {
  it("reads live from videoDetails.liveBroadcastDetails.isLiveNow", () => {
    const { verdict, videoId } = judgeLiveStatus(
      playerHtml({
        videoDetails: { videoId: "dQw4w9WgXcQ", liveBroadcastDetails: { isLiveNow: true } },
      }),
    );
    expect(verdict).toBe("live");
    expect(videoId).toBe("dQw4w9WgXcQ");
  });

  it("reads offline from isLiveNow false", () => {
    const { verdict } = judgeLiveStatus(
      playerHtml({
        videoDetails: { videoId: "dQw4w9WgXcQ", liveBroadcastDetails: { isLiveNow: false } },
      }),
    );
    expect(verdict).toBe("offline");
  });

  it("reads offline from LIVE_STREAM_OFFLINE before anything else", () => {
    const { verdict } = judgeLiveStatus(
      playerHtml({
        videoDetails: { videoId: "dQw4w9WgXcQ", liveBroadcastDetails: { isLiveNow: true } },
        playabilityStatus: { status: "LIVE_STREAM_OFFLINE" },
      }),
    );
    expect(verdict).toBe("offline");
  });

  it("reads offline for a scheduled (upcoming) stream, not live", () => {
    const { verdict } = judgeLiveStatus(
      playerHtml({ videoDetails: { videoId: "dQw4w9WgXcQ", isUpcoming: true } }),
    );
    expect(verdict).toBe("offline");
  });

  it("returns unknown — not offline — when the page carries no evidence", () => {
    const { verdict } = judgeLiveStatus("<html><body>empty variant</body></html>");
    expect(verdict).toBe("unknown");
    const noSignal = judgeLiveStatus(playerHtml({ videoDetails: { videoId: "dQw4w9WgXcQ" } }));
    expect(noSignal.verdict).toBe("unknown");
  });
});
