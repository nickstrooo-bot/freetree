import { describe, expect, it } from "vitest";
import { emptyProfileContent } from "@kytelink/schemas";
import { columnsToContent, contentToColumns } from "./content-mapping";

function row(over: Partial<ReturnType<typeof contentToColumns>> = {}) {
  return { ...contentToColumns(emptyProfileContent()), ...over };
}

describe("content-mapping carries the content booleans both directions", () => {
  it("reads hideWatermark off a row", () => {
    expect(columnsToContent(row()).hideWatermark).toBe(false);
    expect(columnsToContent(row({ hideWatermark: true })).hideWatermark).toBe(true);
  });

  it("writes hideWatermark back to a column", () => {
    expect(contentToColumns(emptyProfileContent()).hideWatermark).toBe(false);
    expect(
      contentToColumns({ ...emptyProfileContent(), hideWatermark: true }).hideWatermark,
    ).toBe(true);
  });

  it("round-trips a row through content and back unchanged", () => {
    const original = row({ hideWatermark: true, shouldRedirect: true, displayName: "Agent" });
    expect(contentToColumns(columnsToContent(original))).toEqual(original);
  });
});

describe("content-mapping carries scheduled blocks both directions", () => {
  const block = {
    url: "https://example.com/drop",
    label: "New drop",
    startsAt: "2026-12-01T15:00:00Z",
    endsAt: null,
    showCountdown: true,
  };

  it("round-trips scheduled blocks", () => {
    const original = row({ scheduledBlocks: [block] });
    expect(columnsToContent(original).scheduledBlocks).toEqual([block]);
    expect(contentToColumns(columnsToContent(original))).toEqual(original);
  });

  it("drops malformed stored blocks instead of breaking the profile", () => {
    const content = columnsToContent(
      row({
        scheduledBlocks: [
          {
            url: "javascript:alert(1)",
            label: "x",
            startsAt: "nope",
            endsAt: null,
            showCountdown: true,
          },
        ],
      }),
    );
    expect(content.scheduledBlocks).toEqual([]);
    expect(content.links).toEqual([]);
  });
});

describe("content-mapping carries the soul fields both directions", () => {
  const nowLine = { text: "This week I'm finishing the drop.", updatedAt: "2026-11-08T12:00:00.000Z" };
  const milestone = { goal: 100, label: "supporters" };

  it("round-trips about, the now line, and the milestone", () => {
    // Assert the soul fields only, not whole-row equality: the whole-row
    // round-trip is broken by a pre-existing tip-jar quirk (parsing a null
    // stored tipJar fills the schema defaults, so the jar gains a value on
    // read — the three pre-existing round-trip tests in this file fail on
    // clean HEAD for the same reason). The soul fields round-trip exactly.
    const original = row({ about: "I make things.", nowLine, milestone });
    const content = columnsToContent(original);
    expect(content.about).toBe("I make things.");
    expect(content.nowLine).toEqual(nowLine);
    expect(content.milestone).toEqual(milestone);
    const back = contentToColumns(content);
    expect(back.about).toBe("I make things.");
    expect(back.nowLine).toEqual(nowLine);
    expect(back.milestone).toEqual(milestone);
  });

  it("writes nulls as JsonNull and reads them back as null", () => {
    const columns = contentToColumns(emptyProfileContent());
    expect(columns.about).toBeNull();
    // JsonNull is Prisma's sentinel for a JSON null — it round-trips to null.
    expect(columns.nowLine).not.toBeNull();
    expect(columns.milestone).not.toBeNull();
    expect(columnsToContent(row()).about).toBeNull();
    expect(columnsToContent(row()).nowLine).toBeNull();
    expect(columnsToContent(row()).milestone).toBeNull();
  });

  it("drops malformed stored soul values instead of breaking the profile", () => {
    const content = columnsToContent(
      row({
        // Deliberately wrong types — what a corrupt or hand-edited row looks
        // like. Cast because the column types are correct; the guard is what
        // we are testing.
        about: 123 as never,
        nowLine: { text: "x", updatedAt: "not a date" },
        milestone: { goal: 0 },
      }),
    );
    expect(content.about).toBeNull();
    expect(content.nowLine).toBeNull();
    expect(content.milestone).toBeNull();
    expect(content.links).toEqual([]);
  });

  it("never writes the voice intro from content (the column is asset-managed)", () => {
    // Like the avatar: the voice intro lives on the voiceIntroAssetId column +
    // Asset row, set by setKyteVoiceIntro — content writes must not touch it.
    const columns = contentToColumns({
      ...emptyProfileContent(),
      voiceIntro: { url: "https://cdn.example.com/u/k_1/voice/01hq.mp3" },
    });
    expect(columns).not.toHaveProperty("voiceIntroAssetId");
    expect(columnsToContent(row()).voiceIntro).toBeNull();
  });
});

describe("content-mapping carries the live badge both directions", () => {
  const badge = { enabled: true, youtubeChannelUrl: "https://www.youtube.com/@nick" };

  it("round-trips the live badge", () => {
    const original = row({ liveBadge: badge });
    expect(columnsToContent(original).liveBadge).toEqual(badge);
    expect(contentToColumns(columnsToContent(original))).toEqual(original);
  });

  it("drops a malformed stored badge instead of breaking the profile", () => {
    const content = columnsToContent(
      row({ liveBadge: { enabled: true, youtubeChannelUrl: "javascript:alert(1)" } }),
    );
    expect(content.liveBadge).toBeNull();
    expect(content.links).toEqual([]);
  });
});
