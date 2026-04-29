import { describe, expect, it } from "vitest";
import { extractFootnoteDefinitions } from "./footnotes";

describe("extractFootnoteDefinitions", () => {
  it("returns empty list when none present", () => {
    expect(extractFootnoteDefinitions("plain prose, no notes.")).toEqual([]);
  });

  it("captures id and text for a single-line definition", () => {
    const md = "Body[^one] text.\n\n[^one]: A footnote about Polars.";
    expect(extractFootnoteDefinitions(md)).toEqual([
      { id: "one", text: "A footnote about Polars." },
    ]);
  });

  it("captures multi-line definition until blank line or next definition", () => {
    const md = [
      "[^a]: first line",
      "    second line",
      "    third line",
      "",
      "[^b]: another",
    ].join("\n");
    expect(extractFootnoteDefinitions(md)).toEqual([
      { id: "a", text: "first line second line third line" },
      { id: "b", text: "another" },
    ]);
  });

  it("orders results by appearance, deduping by id (first wins)", () => {
    const md = "[^x]: first\n\n[^x]: second";
    expect(extractFootnoteDefinitions(md)).toEqual([{ id: "x", text: "first" }]);
  });
});
