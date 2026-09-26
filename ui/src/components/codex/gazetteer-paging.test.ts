import { describe, expect, it } from "vitest";
import { pageItems, rangeLabel, repage, rowsThatFit } from "./gazetteer-paging";

describe("rowsThatFit", () => {
  it("falls back to 20 before layout (jsdom, hidden)", () => {
    expect(rowsThatFit(0, true)).toBe(20);
  });
  it("fits compact and comfortable rows under the header", () => {
    expect(rowsThatFit(48 + 32 * 10, true)).toBe(10);
    expect(rowsThatFit(60 + 42 * 7, false)).toBe(7);
    expect(rowsThatFit(60 + 42 * 7 + 41, false)).toBe(7);
  });
  it("never shows fewer than 5 rows", () => {
    expect(rowsThatFit(50, true)).toBe(5);
  });
});

describe("repage", () => {
  it("keeps the first visible row on screen", () => {
    expect(repage(4, 10, 7)).toBe(5); // row 31 → page 5 of 7-row pages
    expect(repage(3, 7, 10)).toBe(2); // row 15 → page 2
    expect(repage(1, 10, 7)).toBe(1);
  });
});

describe("pageItems", () => {
  it("lists every page when there are seven or fewer", () => {
    expect(pageItems(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });
  it("keeps first, last and the current page's neighbours", () => {
    expect(pageItems(1, 14)).toEqual([1, 2, "gap", 14]);
    expect(pageItems(7, 14)).toEqual([1, "gap", 6, 7, 8, "gap", 14]);
    expect(pageItems(14, 14)).toEqual([1, "gap", 13, 14]);
    expect(pageItems(3, 14)).toEqual([1, 2, 3, 4, "gap", 14]);
  });
});

describe("rangeLabel", () => {
  it("names the rows on this page", () => {
    expect(rangeLabel(1, 10, 10, 45)).toBe("1–10 of 45");
    expect(rangeLabel(5, 10, 5, 45)).toBe("41–45 of 45");
    expect(rangeLabel(1, 10, 10, 1204)).toBe("1–10 of 1,204");
  });
  it("says so when nothing matches", () => {
    expect(rangeLabel(1, 10, 0, 0)).toBe("No pages");
  });
});
