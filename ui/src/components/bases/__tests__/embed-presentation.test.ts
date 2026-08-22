import { describe, expect, it } from "vitest";
import {
  clampEmbedWidth,
  EMBED_WIDTH_MAX,
  EMBED_WIDTH_MIN,
  embedIsCompact,
  embedWidthStyle,
  isBaseEmbedDisplay,
} from "#/components/bases/embed-presentation";

describe("embed display", () => {
  it("is compact unless the author opted out", () => {
    expect(embedIsCompact({})).toBe(true);
    expect(embedIsCompact({ display: "compact" })).toBe(true);
    expect(embedIsCompact({ display: "full" })).toBe(false);
  });

  it("recognises only the two authored values", () => {
    expect(isBaseEmbedDisplay("compact")).toBe(true);
    expect(isBaseEmbedDisplay("full")).toBe(true);
    for (const value of ["Compact", "", null, 1, undefined]) {
      expect(isBaseEmbedDisplay(value)).toBe(false);
    }
  });
});

describe("clampEmbedWidth", () => {
  it("keeps a width inside the range and rounds", () => {
    expect(clampEmbedWidth(900)).toBe(900);
    expect(clampEmbedWidth(10)).toBe(EMBED_WIDTH_MIN);
    expect(clampEmbedWidth(9000)).toBe(EMBED_WIDTH_MAX);
    expect(clampEmbedWidth(900.6)).toBe(901);
  });
});

describe("embedWidthStyle", () => {
  it("fills the column when no width was authored", () => {
    expect(embedWidthStyle(undefined)).toEqual({});
  });

  it("sets the width, bounds it by the pane, and re-centres it", () => {
    // The style must survive without --folio-pane-w: an embed also renders in
    // a preview or a story, where no pane publishes its width.
    expect(embedWidthStyle(1100)).toEqual({
      width: "1100px",
      maxWidth: "var(--folio-pane-w, 100%)",
      marginLeft: "calc((100% - min(1100px, var(--folio-pane-w, 100%))) / 2)",
    });
  });

  it("clamps an out-of-range stored width before using it", () => {
    expect(embedWidthStyle(99_999).width).toBe(`${EMBED_WIDTH_MAX}px`);
  });
});
