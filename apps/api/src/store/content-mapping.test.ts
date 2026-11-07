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
