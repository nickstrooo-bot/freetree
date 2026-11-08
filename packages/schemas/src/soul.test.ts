import { describe, expect, it } from "vitest";
import { aboutSchema } from "./about";
import { nowLineSchema } from "./now-line";
import { milestoneSchema } from "./milestone";
import {
  VOICE_INTRO_CONTENT_TYPES,
  VOICE_INTRO_EXTENSION,
  VOICE_INTRO_MAX_BYTES,
  VOICE_INTRO_MAX_SECONDS,
  voiceIntroSchema,
} from "./voice-intro";
import {
  PROFILE_CONTENT_FIELD_TO_COLUMN,
  emptyProfileContent,
  profileContentSchema,
} from "./profile-content";

describe("aboutSchema", () => {
  it("accepts a short story", () => {
    expect(aboutSchema.parse("I make things.")).toBe("I make things.");
  });

  it("rejects text over 1000 characters", () => {
    expect(() => aboutSchema.parse("a".repeat(1001))).toThrow();
    expect(aboutSchema.parse("a".repeat(1000))).toBe("a".repeat(1000));
  });
});

describe("nowLineSchema", () => {
  it("accepts a line with an ISO written date", () => {
    expect(
      nowLineSchema.parse({ text: "This week I'm finishing the drop.", updatedAt: "2026-11-08T12:00:00.000Z" }),
    ).toEqual({ text: "This week I'm finishing the drop.", updatedAt: "2026-11-08T12:00:00.000Z" });
  });

  it("rejects text over 280 characters and a non-date updatedAt", () => {
    expect(() =>
      nowLineSchema.parse({ text: "a".repeat(281), updatedAt: "2026-11-08T12:00:00.000Z" }),
    ).toThrow();
    expect(() => nowLineSchema.parse({ text: "Fine", updatedAt: "yesterday" })).toThrow();
  });
});

describe("milestoneSchema", () => {
  it("accepts a goal with and without a label", () => {
    expect(milestoneSchema.parse({ goal: 100 })).toEqual({ goal: 100 });
    expect(milestoneSchema.parse({ goal: 100, label: "supporters" })).toEqual({
      goal: 100,
      label: "supporters",
    });
  });

  it("rejects a goal below 1 or above 100,000, and a label over 120 characters", () => {
    expect(() => milestoneSchema.parse({ goal: 0 })).toThrow();
    expect(() => milestoneSchema.parse({ goal: 100_001 })).toThrow();
    expect(milestoneSchema.parse({ goal: 1 })).toEqual({ goal: 1 });
    expect(milestoneSchema.parse({ goal: 100_000 })).toEqual({ goal: 100_000 });
    expect(() => milestoneSchema.parse({ goal: 10, label: "a".repeat(121) })).toThrow();
  });
});

describe("voiceIntroSchema", () => {
  it("accepts a URL string and rejects a non-string (same as the avatar schema)", () => {
    expect(voiceIntroSchema.parse({ url: "https://cdn.example.com/u/k_1/voice/01hq.mp3" })).toEqual({
      url: "https://cdn.example.com/u/k_1/voice/01hq.mp3",
    });
    expect(() => voiceIntroSchema.parse({ url: 42 })).toThrow();
  });

  it("caps uploads at 5MB / 60s and allows mp3 + m4a", () => {
    expect(VOICE_INTRO_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(VOICE_INTRO_MAX_SECONDS).toBe(60);
    expect(VOICE_INTRO_CONTENT_TYPES).toEqual(["audio/mpeg", "audio/mp4", "audio/x-m4a"]);
    expect(VOICE_INTRO_EXTENSION["audio/mpeg"]).toBe("mp3");
    expect(VOICE_INTRO_EXTENSION["audio/mp4"]).toBe("m4a");
    expect(VOICE_INTRO_EXTENSION["audio/x-m4a"]).toBe("m4a");
  });
});

describe("profile-content carries the soul fields", () => {
  it("defaults about, nowLine, milestone, and voiceIntro to null", () => {
    const empty = emptyProfileContent();
    expect(empty.about).toBeNull();
    expect(empty.nowLine).toBeNull();
    expect(empty.milestone).toBeNull();
    expect(empty.voiceIntro).toBeNull();
  });

  it("maps the new fields to columns", () => {
    expect(PROFILE_CONTENT_FIELD_TO_COLUMN.about).toBe("about");
    expect(PROFILE_CONTENT_FIELD_TO_COLUMN.nowLine).toBe("nowLine");
    expect(PROFILE_CONTENT_FIELD_TO_COLUMN.milestone).toBe("milestone");
    expect(PROFILE_CONTENT_FIELD_TO_COLUMN.voiceIntro).toBe("voiceIntroAssetId");
  });

  it("round-trips a profile with all four soul fields set", () => {
    const content = {
      ...emptyProfileContent(),
      about: "I make things.",
      nowLine: { text: "This week I'm finishing the drop.", updatedAt: "2026-11-08T12:00:00.000Z" },
      milestone: { goal: 100, label: "supporters" },
      voiceIntro: { url: "https://cdn.example.com/u/k_1/voice/01hq.mp3" },
    };
    expect(profileContentSchema.parse(content)).toEqual(content);
  });
});
