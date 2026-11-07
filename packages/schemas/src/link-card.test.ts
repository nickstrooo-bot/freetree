import { describe, expect, it } from "vitest";
import { linkCardFetchResultSchema, linkCardSchema } from "./link-card";
import { linkSchema } from "./link";

const fullCard = {
  title: "A very good article",
  description: "What the article is about.",
  image: "https://example.com/cover.jpg",
  fetchedAt: "2026-11-07T00:00:00.000Z",
};

describe("linkCardSchema", () => {
  it("accepts a full card", () => {
    expect(linkCardSchema.parse(fullCard)).toEqual(fullCard);
  });

  it("accepts a title-only card", () => {
    expect(linkCardSchema.parse({ title: "Just a title" })).toEqual({
      title: "Just a title",
    });
  });

  it("accepts an image-only card", () => {
    expect(linkCardSchema.parse({ image: "https://example.com/cover.jpg" })).toEqual({
      image: "https://example.com/cover.jpg",
    });
  });

  it("rejects an empty card — no title, description, or image", () => {
    expect(linkCardSchema.safeParse({}).success).toBe(false);
    expect(
      linkCardSchema.safeParse({ fetchedAt: "2026-11-07T00:00:00.000Z" }).success,
    ).toBe(false);
  });

  it("rejects non-http(s) image URLs", () => {
    expect(linkCardSchema.safeParse({ image: "javascript:alert(1)" }).success).toBe(
      false,
    );
    expect(linkCardSchema.safeParse({ image: "data:image/png;base64,abc" }).success).toBe(
      false,
    );
  });

  it("rejects over-long titles and descriptions", () => {
    expect(linkCardSchema.safeParse({ title: "x".repeat(201) }).success).toBe(false);
    expect(linkCardSchema.safeParse({ description: "x".repeat(301) }).success).toBe(
      false,
    );
  });

  it("rejects control characters in title and description", () => {
    expect(linkCardSchema.safeParse({ title: "bad\u0000title" }).success).toBe(false);
    expect(linkCardSchema.safeParse({ description: "bad\u0007desc" }).success).toBe(
      false,
    );
  });
});

describe("linkSchema with a card", () => {
  it("accepts a link carrying a card", () => {
    const parsed = linkSchema.parse({
      title: "My article",
      link: "https://example.com/article",
      card: fullCard,
    });
    expect(parsed.card).toEqual(fullCard);
  });

  it("still accepts links with no card (all pre-existing links)", () => {
    const parsed = linkSchema.parse({ title: "Plain", link: "https://example.com" });
    expect(parsed.card).toBeUndefined();
  });

  it("rejects a link whose card is empty", () => {
    expect(
      linkSchema.safeParse({ title: "Plain", link: "https://example.com", card: {} })
        .success,
    ).toBe(false);
  });
});

describe("linkCardFetchResultSchema", () => {
  it("accepts a null card (fetch failed / no metadata — editor keeps manual title)", () => {
    expect(
      linkCardFetchResultSchema.parse({ card: null, fetchedUrl: "https://example.com" }),
    ).toEqual({ card: null, fetchedUrl: "https://example.com" });
  });
});
