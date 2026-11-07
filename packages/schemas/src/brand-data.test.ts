import { describe, expect, it } from "vitest";
import {
  BRAND_DOMAINS,
  BRAND_FA_ICON,
  BRAND_STYLES,
  detectLinkBrand,
} from "./brand-data";

describe("detectLinkBrand", () => {
  it.each([
    ["https://www.youtube.com/@nick", "yt"],
    ["https://youtu.be/dQw4w9WgXcQ", "yt"],
    ["youtube.com/@nick", "yt"],
    ["https://music.youtube.com/watch?v=abc", "yt-music"],
    ["https://kick.com/nick", "kick"],
    ["https://www.twitch.tv/nick", "twitch"],
    ["https://www.tiktok.com/@nick", "tiktok"],
    ["https://x.com/nick", "x"],
    ["https://twitter.com/nick", "x"],
    ["https://www.instagram.com/nick", "instagram"],
    ["https://open.spotify.com/track/abc", "spotify"],
    ["https://www.twitch.tv/nick/clip/abc", "twitch"],
    ["https://t.me/nick", "telegram"],
    ["https://wa.me/15551234567", "whatsapp"],
    ["https://www.linkedin.com/in/nick", "linked"],
    ["https://github.com/nick", "github"],
    ["https://www.patreon.com/nick", "patreon"],
    ["https://discord.gg/abc123", "discord"],
    ["https://www.reddit.com/r/test", "reddit"],
    ["https://substack.com/@nick", "substack"],
  ])("detects %s as %s", (url, brand) => {
    expect(detectLinkBrand(url)).toBe(brand);
  });

  it.each([
    "https://example.com/page",
    "https://my-shop.example.com",
    "not a url at all :::",
    "",
    "   ",
  ])("returns null for %s", (url) => {
    expect(detectLinkBrand(url)).toBeNull();
  });

  it("prefers the longest matching domain", () => {
    // music.youtube.com must not collapse to yt.
    expect(detectLinkBrand("https://music.youtube.com/channel/UCx")).toBe("yt-music");
    // scholar.google.com is its own brand, not google-black.
    expect(detectLinkBrand("https://scholar.google.com/citations?user=x")).toBe("google-scholar");
  });
});

describe("BRAND_STYLES", () => {
  it("has a complete style for every domain-mapped brand", () => {
    for (const brand of Object.keys(BRAND_DOMAINS)) {
      const style = BRAND_STYLES[brand];
      expect(style, `missing style for ${brand}`).toBeDefined();
      expect(style.text).toMatch(/^#/);
      expect(style.background.length).toBeGreaterThan(0);
    }
  });

  it("keeps every style's text readable as a hex color", () => {
    for (const [brand, style] of Object.entries(BRAND_STYLES)) {
      expect(style.text, brand).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("maps FA icons only to brands that have a style", () => {
    for (const brand of Object.keys(BRAND_FA_ICON)) {
      expect(BRAND_STYLES[brand], `FA icon for unstyled brand ${brand}`).toBeDefined();
    }
  });
});
