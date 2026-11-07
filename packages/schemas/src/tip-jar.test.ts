import { describe, it, expect } from "vitest";
import { tipJarSchema, emptyTipJar, DEFAULT_TIP_AMOUNTS_CENTS } from "./tip-jar";
import { profileContentSchema, emptyProfileContent } from "./profile-content";

describe("tipJarSchema", () => {
  it("applies defaults: heading, $3/$5/$10 presets, active", () => {
    const result = tipJarSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.heading).toBe("Leave a tip");
      expect(result.data.amountsCents).toEqual([...DEFAULT_TIP_AMOUNTS_CENTS]);
      expect(result.data.active).toBe(true);
    }
  });

  it("accepts a custom jar", () => {
    const result = tipJarSchema.safeParse({
      heading: "Buy me a coffee",
      message: "Every tip keeps the lights on.",
      amountsCents: [100, 500, 2000],
      active: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an amount below the $0.50 Stripe minimum", () => {
    expect(tipJarSchema.safeParse({ amountsCents: [49] }).success).toBe(false);
  });

  it("rejects an amount above the $10,000 cap", () => {
    expect(tipJarSchema.safeParse({ amountsCents: [1_000_001] }).success).toBe(false);
  });

  it("rejects duplicate amounts", () => {
    expect(tipJarSchema.safeParse({ amountsCents: [500, 500] }).success).toBe(false);
  });

  it("rejects unsorted amounts", () => {
    expect(tipJarSchema.safeParse({ amountsCents: [1000, 300] }).success).toBe(false);
  });

  it("rejects more than 5 presets", () => {
    expect(
      tipJarSchema.safeParse({ amountsCents: [100, 200, 300, 400, 500, 600] }).success,
    ).toBe(false);
  });

  it("rejects an empty heading and an overlong message", () => {
    expect(tipJarSchema.safeParse({ heading: "" }).success).toBe(false);
    expect(tipJarSchema.safeParse({ message: "x".repeat(501) }).success).toBe(false);
  });

  it("emptyTipJar matches the parsed defaults", () => {
    expect(emptyTipJar()).toEqual(tipJarSchema.parse({}));
  });
});

describe("profileContent tipJar", () => {
  it("empty content has no tip jar", () => {
    expect(emptyProfileContent().tipJar).toBeNull();
  });

  it("old content without tipJar gets the null default", () => {
    const empty = emptyProfileContent();
    const { tipJar: _removed, ...old } = empty;
    const result = profileContentSchema.safeParse(old);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tipJar).toBeNull();
  });

  it("accepts a tip jar in content", () => {
    const empty = emptyProfileContent();
    const result = profileContentSchema.safeParse({
      ...empty,
      tipJar: { heading: "Tip jar", amountsCents: [300, 500], active: true },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tipJar?.heading).toBe("Tip jar");
  });

  it("rejects an invalid tip jar in content", () => {
    const empty = emptyProfileContent();
    const result = profileContentSchema.safeParse({
      ...empty,
      tipJar: { heading: "Tip jar", amountsCents: [10], active: true },
    });
    expect(result.success).toBe(false);
  });
});
