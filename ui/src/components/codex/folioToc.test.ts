import { describe, expect, it } from "vitest";
import { buildToc } from "./folioToc";

describe("buildToc", () => {
  it("includes frozen journal times as level-two navigation entries", () => {
    expect(
      buildToc([
        { type: "heading", level: 1, children: [{ text: "Day" }] },
        { type: "journal-time", time: "09:07", children: [{ text: "" }] },
        { type: "heading", level: 2, children: [{ text: "Notes" }] },
      ]),
    ).toEqual([
      { number: "1", depth: 1, text: "Day" },
      { number: "1.1", depth: 2, text: "09:07" },
      { number: "1.2", depth: 2, text: "Notes" },
    ]);
  });

  it("ignores malformed journal-time blocks and non-heading content", () => {
    expect(
      buildToc([
        { type: "paragraph", children: [{ text: "Body" }] },
        { type: "journal-time", children: [{ text: "" }] },
        { type: "journal-time", time: "", children: [{ text: "" }] },
      ]),
    ).toEqual([]);
  });

  it("numbers ordinary headings by their clamped depth", () => {
    expect(
      buildToc([
        { type: "heading", level: 0, children: [{ text: "Top" }] },
        { type: "heading", level: 3, children: [{ text: "Nested" }] },
        { type: "heading", level: 9, children: [{ text: "Deep" }] },
        { type: "heading", level: 2, children: [{ text: "Second" }] },
      ]),
    ).toEqual([
      { number: "1", depth: 1, text: "Top" },
      { number: "1.1", depth: 3, text: "Nested" },
      { number: "1.1.1", depth: 6, text: "Deep" },
      { number: "1.1", depth: 2, text: "Second" },
    ]);
  });

  it("uses untitled for headings without text", () => {
    expect(
      buildToc([{ type: "heading", level: 1, children: [{ text: "  " }] }]),
    ).toEqual([{ number: "1", depth: 1, text: "(untitled)" }]);
  });
});
