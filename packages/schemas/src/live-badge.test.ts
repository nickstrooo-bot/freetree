import { describe, expect, it } from "vitest";
import { liveBadgeSchema } from "./live-badge";

describe("liveBadgeSchema", () => {
  it("accepts a channel URL and defaults to enabled", () => {
    const parsed = liveBadgeSchema.parse({ youtubeChannelUrl: "https://www.youtube.com/@nick" });
    expect(parsed.enabled).toBe(true);
    expect(parsed.youtubeChannelUrl).toBe("https://www.youtube.com/@nick");
  });

  it("accepts a bare @handle (safeWebUrlSchema prefixes https)", () => {
    const parsed = liveBadgeSchema.parse({ youtubeChannelUrl: "youtube.com/@nick" });
    expect(parsed.youtubeChannelUrl).toBe("https://youtube.com/@nick");
  });

  it("accepts an explicit disabled flag", () => {
    const parsed = liveBadgeSchema.parse({
      enabled: false,
      youtubeChannelUrl: "https://www.youtube.com/channel/UC1234567890123456789012",
    });
    expect(parsed.enabled).toBe(false);
  });

  it("rejects a javascript: URL", () => {
    expect(() =>
      liveBadgeSchema.parse({ youtubeChannelUrl: "javascript:alert(1)" }),
    ).toThrow();
  });
});
