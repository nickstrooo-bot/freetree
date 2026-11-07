import { describe, expect, it } from "vitest";
import { scheduledBlockSchema } from "./scheduled-block";
import { evaluateScheduledBlock, formatCountdown } from "./scheduled-data";

const base = {
  url: "https://example.com/drop",
  label: "New drop",
  startsAt: "2026-12-01T15:00:00Z",
};

describe("scheduledBlockSchema", () => {
  it("accepts a full block and applies defaults", () => {
    const parsed = scheduledBlockSchema.parse(base);
    expect(parsed.endsAt).toBeNull();
    expect(parsed.showCountdown).toBe(true);
  });

  it("accepts an endsAt window and a hidden countdown", () => {
    const parsed = scheduledBlockSchema.parse({
      ...base,
      endsAt: "2026-12-08T15:00:00Z",
      showCountdown: false,
    });
    expect(parsed.endsAt).toBe("2026-12-08T15:00:00Z");
    expect(parsed.showCountdown).toBe(false);
  });

  it("rejects a javascript: url, an overlong label, and a bad date", () => {
    expect(() => scheduledBlockSchema.parse({ ...base, url: "javascript:alert(1)" })).toThrow();
    expect(() =>
      scheduledBlockSchema.parse({ ...base, label: "x".repeat(61) }),
    ).toThrow();
    expect(() => scheduledBlockSchema.parse({ ...base, startsAt: "tomorrow" })).toThrow();
    expect(() =>
      scheduledBlockSchema.parse({ ...base, endsAt: "2026-12-08" }),
    ).toThrow();
  });
});

describe("evaluateScheduledBlock", () => {
  const block = { startsAt: "2026-12-01T15:00:00Z", endsAt: "2026-12-08T15:00:00Z" };
  it("is upcoming before the start, live inside the window, expired after the end", () => {
    expect(evaluateScheduledBlock(block, new Date("2026-11-30T15:00:00Z"))).toBe("upcoming");
    expect(evaluateScheduledBlock(block, new Date("2026-12-01T15:00:00Z"))).toBe("live");
    expect(evaluateScheduledBlock(block, new Date("2026-12-05T00:00:00Z"))).toBe("live");
    expect(evaluateScheduledBlock(block, new Date("2026-12-08T15:00:01Z"))).toBe("expired");
  });

  it("stays live forever with no endsAt", () => {
    expect(
      evaluateScheduledBlock(
        { startsAt: "2026-12-01T15:00:00Z", endsAt: null },
        new Date("2027-01-01T00:00:00Z"),
      ),
    ).toBe("live");
  });

  it("treats an unparseable startsAt as expired, never live", () => {
    expect(
      evaluateScheduledBlock({ startsAt: "garbage", endsAt: null }, new Date()),
    ).toBe("expired");
  });
});

describe("formatCountdown", () => {
  it.each([
    [0, "00:00:00"],
    [1000, "00:00:01"],
    [3661_000, "01:01:01"],
    [90_061_000, "1:01:01:01"],
    [-5000, "00:00:00"],
  ])("formats %s ms as %s", (ms, expected) => {
    expect(formatCountdown(ms)).toBe(expected);
  });
});
