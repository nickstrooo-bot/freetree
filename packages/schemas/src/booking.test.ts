import { describe, it, expect } from "vitest";
import { bookingBlockSchema, profileContentSchema, emptyProfileContent } from "./index";

describe("bookingBlockSchema", () => {
  it("accepts a valid block", () => {
    const result = bookingBlockSchema.safeParse({ url: "calendly.com/nick", label: "Book a call" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBe("https://calendly.com/nick");
      expect(result.data.label).toBe("Book a call");
    }
  });

  it("rejects javascript: URLs", () => {
    const result = bookingBlockSchema.safeParse({ url: "javascript:alert(1)", label: "x" });
    expect(result.success).toBe(false);
  });

  it("defaults the label to 'Book now'", () => {
    const result = bookingBlockSchema.safeParse({ url: "https://cal.com/nick" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.label).toBe("Book now");
  });

  it("rejects overlong labels", () => {
    const result = bookingBlockSchema.safeParse({ url: "https://cal.com/nick", label: "x".repeat(61) });
    expect(result.success).toBe(false);
  });
});

describe("profileContent bookingBlocks", () => {
  it("empty content includes empty bookingBlocks", () => {
    const empty = emptyProfileContent();
    expect(Array.isArray(empty.bookingBlocks)).toBe(true);
    expect(empty.bookingBlocks).toHaveLength(0);
  });

  it("old content without bookingBlocks gets the default", () => {
    const empty = emptyProfileContent();
    const { bookingBlocks: _removed, ...old } = empty;
    const result = profileContentSchema.safeParse(old);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.bookingBlocks).toEqual([]);
  });

  it("accepts booking blocks in content", () => {
    const empty = emptyProfileContent();
    const result = profileContentSchema.safeParse({
      ...empty,
      bookingBlocks: [{ url: "https://calendly.com/nick", label: "Book now" }],
    });
    expect(result.success).toBe(true);
  });
});
