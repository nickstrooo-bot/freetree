import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyProfileContent, THEME_KEYS, type ProfileContent } from "@kytelink/schemas";
import { ProfileView } from "./profile-view";

const richContent: ProfileContent = {
  ...emptyProfileContent(),
  displayName: "Agent Smith",
  description: "Testing the one true renderer across every theme.",
  customFont: "serif",
  customColor: "purple.400",
  avatar: {
    url: "u/k_1/avatar/01hq.webp",
    lqip: "data:image/webp;base64,UklGRhoAAABXRUJQ",
  },
  icons: [
    { name: "Twitter", url: "https://twitter.com/agent" },
    { name: "Github", url: "https://github.com/agent" },
    { name: "Contact", url: null },
  ],
  links: [
    { title: "Fa icon link", link: "https://example.com", emoji: "FaSpotify", color: "#1DB954" },
    { title: "Image link", link: "example.org", emoji: "https://cdn.example.com/a.png" },
    { title: "Emoji link", link: "https://kytelink.com", emoji: "🪁" },
    { title: "Bare link", link: "https://plain.com" },
  ],
};

describe("ProfileView soul blocks (about / now line / milestone / voice intro)", () => {
  const soulContent: ProfileContent = {
    ...emptyProfileContent(),
    displayName: "Soul Seller",
    about: "I make things by hand.",
    nowLine: { text: "This week I'm finishing the drop.", updatedAt: "2026-11-08T12:00:00.000Z" },
    milestone: { goal: 100, label: "supporters" },
    voiceIntro: { url: "https://cdn.example.com/u/k_1/voice/01hq.mp3" },
  };

  it("renders the about block above the links when set, and nothing when absent", () => {
    const html = renderToStaticMarkup(<ProfileView content={soulContent} />);
    expect(html).toContain("I make things by hand.");
    expect(html.indexOf("I make things by hand.")).toBeLessThan(html.indexOf("data-kytelink-links"));

    const bare = renderToStaticMarkup(<ProfileView content={emptyProfileContent()} />);
    expect(bare).not.toContain("I make things by hand.");
  });

  it("renders the now line with the date it was written", () => {
    const html = renderToStaticMarkup(<ProfileView content={soulContent} />);
    // React escapes the apostrophe in "I'm" as &#x27; in static markup, so
    // assert on the apostrophe-free part of the line.
    expect(html).toContain("finishing the drop");
    expect(html).toContain("Written");
    expect(html).toContain("2026");
  });

  it("renders the milestone meter from the real supporter count", () => {
    const html = renderToStaticMarkup(<ProfileView content={soulContent} supporterCount={0} />);
    expect(html).toContain("Help me reach 100 supporters");
    expect(html).toContain("0 of 100 supporters so far");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="0"');
    expect(html).toContain('aria-valuemax="100"');
  });

  it("renders the goal-reached state when the count meets the goal", () => {
    const html = renderToStaticMarkup(<ProfileView content={soulContent} supporterCount={100} />);
    expect(html).toContain("Goal reached");
    expect(html).toContain("100 supporters! Thank you.");
  });

  it("does not render a milestone meter when no supporter count is passed", () => {
    const html = renderToStaticMarkup(<ProfileView content={soulContent} />);
    expect(html).not.toContain("Help me reach 100 supporters");
    expect(html).not.toContain("of 100 supporters so far");
  });

  it("renders the voice intro as a play button with the clip, never auto-playing", () => {
    const html = renderToStaticMarkup(<ProfileView content={soulContent} />);
    expect(html).toContain('data-freetree-voice-intro');
    expect(html).toContain("Hear my intro");
    expect(html).toContain("https://cdn.example.com/u/k_1/voice/01hq.mp3");
    expect(html).not.toContain("autoplay");
    expect(html).toContain('aria-label="Play Soul Seller');
  });

  it("renders no voice intro button when there is no clip", () => {
    const html = renderToStaticMarkup(
      <ProfileView content={{ ...soulContent, voiceIntro: null }} />,
    );
    expect(html).not.toContain("data-freetree-voice-intro");
    expect(html).not.toContain("Hear my intro");
    expect(html).not.toContain("voice/01hq.mp3");
  });
});

describe("ProfileView across all 12 themes", () => {
  for (const theme of THEME_KEYS) {
    it(`renders the ${theme} theme without throwing and with key elements`, () => {
      const html = renderToStaticMarkup(
        <ProfileView content={{ ...richContent, theme }} onLinkClick={() => undefined} />,
      );
      expect(html).toContain(`data-theme="${theme}"`);
      expect(html).toContain("Agent Smith");
      expect(html).toContain("Fa icon link");
      expect(html).toContain("Emoji link");
      expect(html).toContain("🪁");
      expect(html).toContain("made with kytelink");
      expect(html).toContain("data-kytelink-watermark");
      expect(html).toContain('href="https://kytelink.com"');
      expect(html).toContain("data-kytelink-icons");
      expect(html.toLowerCase()).toContain('fetchpriority="high"');
      expect(html).toContain("kyte-avatar-lqip");
    });
  }

  it("renders socials above the links, matching v1's stack order", () => {
    const html = renderToStaticMarkup(
      <ProfileView content={richContent} onLinkClick={() => undefined} />,
    );
    expect(html.indexOf("data-kytelink-icons")).toBeGreaterThan(-1);
    expect(html.indexOf("data-kytelink-links")).toBeGreaterThan(-1);
    expect(html.indexOf("data-kytelink-icons")).toBeLessThan(html.indexOf("data-kytelink-links"));
  });

  it("renders a fallback avatar with initials when no avatar url", () => {
    const html = renderToStaticMarkup(
      <ProfileView content={{ ...richContent, avatar: null }} isPreview />,
    );
    expect(html).toContain('data-kytelink-avatar="fallback"');
    expect(html).toContain("AS");
  });

  it("honors themeOverride over content.theme", () => {
    const html = renderToStaticMarkup(
      <ProfileView content={{ ...richContent, theme: "default" }} themeOverride="midnight" />,
    );
    expect(html).toContain('data-theme="midnight"');
  });

  it("normalizes protocol-less hrefs to https", () => {
    const html = renderToStaticMarkup(<ProfileView content={richContent} />);
    expect(html).toContain('href="https://example.org"');
  });

  it("suppresses focus outlines and collapses motion under reduced-motion", () => {
    const html = renderToStaticMarkup(<ProfileView content={richContent} />);
    expect(html).not.toContain("focus-visible");
    expect(html).toContain("outline:none");
    expect(html).toContain("prefers-reduced-motion");
  });

  it("renders empty content without throwing", () => {
    expect(() => renderToStaticMarkup(<ProfileView content={emptyProfileContent()} />)).not.toThrow();
  });

  it("points the watermark at kytelink.com/?ref={username} when username is passed", () => {
    const html = renderToStaticMarkup(<ProfileView content={richContent} username="agent" />);
    expect(html).toContain('data-kytelink-watermark=""');
    expect(html).toContain('href="https://kytelink.com/?ref=agent"');
  });

  it("encodes the ref username", () => {
    const html = renderToStaticMarkup(<ProfileView content={richContent} username="a b&c" />);
    expect(html).toContain("href=\"https://kytelink.com/?ref=a%20b%26c\"");
  });

  it("falls back to the bare watermark without a username", () => {
    const html = renderToStaticMarkup(<ProfileView content={richContent} />);
    expect(html).toContain('href="https://kytelink.com"');
    expect(html).not.toContain("?ref=");
  });

  it("falls back to the bare watermark in preview even with a username", () => {
    const html = renderToStaticMarkup(
      <ProfileView content={richContent} username="agent" isPreview />,
    );
    expect(html).not.toContain("?ref=");
  });

  it("drops the watermark entirely when hideWatermark is set", () => {
    const html = renderToStaticMarkup(
      <ProfileView content={{ ...richContent, hideWatermark: true }} username="agent" />,
    );
    expect(html).not.toContain("data-kytelink-watermark");
    expect(html).not.toContain("made with kytelink");
    expect(html).not.toContain("kytelink.com/?ref=agent");
  });

  it("accepts an onIconClick handler and still renders the icon row", () => {
    const html = renderToStaticMarkup(
      <ProfileView content={richContent} onIconClick={() => undefined} />,
    );
    expect(html).toContain('data-kytelink-icon=""');
    expect(html).toContain('data-icon-name="Twitter"');
  });

  it("renders a rich photo link-card (image + title + description) for links with OG metadata", () => {
    const content: ProfileContent = {
      ...emptyProfileContent(),
      displayName: "Card Seller",
      links: [
        {
          title: "My article",
          link: "https://example.com/article",
          card: {
            title: "The Great Article",
            description: "What the article is about.",
            image: "https://cdn.example.com/cover.jpg",
            fetchedAt: "2026-11-07T00:00:00.000Z",
          },
        },
      ],
    };
    const html = renderToStaticMarkup(<ProfileView content={content} />);
    expect(html).toContain('data-link-card="rich"');
    expect(html).toContain('data-link-card-image=""');
    expect(html).toContain('src="https://cdn.example.com/cover.jpg"');
    expect(html).toContain("My article");
    expect(html).toContain("What the article is about.");
  });

  it("renders a text-only card description under the title when there is no image", () => {
    const content: ProfileContent = {
      ...emptyProfileContent(),
      links: [
        {
          title: "No photo link",
          link: "https://example.com/no-photo",
          card: { description: "A page with words but no picture." },
        },
      ],
    };
    const html = renderToStaticMarkup(<ProfileView content={content} />);
    expect(html).toContain('data-link-card="text"');
    expect(html).not.toContain('data-link-card-image=""');
    expect(html).toContain("A page with words but no picture.");
  });

  it("renders links without a card exactly as before (no card attributes)", () => {
    const html = renderToStaticMarkup(<ProfileView content={richContent} />);
    expect(html).not.toContain("data-link-card");
    expect(html).not.toContain("data-link-card-image");
  });
});
