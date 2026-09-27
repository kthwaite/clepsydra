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

  it("prefixes dated journal times with their date", () => {
    expect(
      buildToc([
        {
          type: "journal-time",
          date: "2026-09-08",
          time: "14:32",
          children: [{ text: "" }],
        },
        { type: "journal-time", time: "15:00", children: [{ text: "" }] },
      ]),
    ).toEqual([
      { number: "1", depth: 2, text: "2026-09-08 14:32" },
      { number: "2", depth: 2, text: "15:00" },
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

  it("splices an embed's rendered headings in at the embed's position", () => {
    const embed = { type: "base-embed", children: [{ text: "" }] };
    const rendered = [
      { type: "heading", level: 1, children: [{ text: "Lagers" }] },
      { type: "paragraph", children: [{ text: "prose" }] },
      { type: "heading", level: 2, children: [{ text: "Pils" }] },
    ];
    expect(
      buildToc(
        [
          { type: "heading", level: 1, children: [{ text: "Base" }] },
          embed,
          { type: "heading", level: 1, children: [{ text: "After" }] },
        ],
        (node) => (node === embed ? rendered : null),
      ),
    ).toEqual([
      { number: "1", depth: 1, text: "Base" },
      { number: "2", depth: 1, text: "Lagers" },
      { number: "2.1", depth: 2, text: "Pils" },
      { number: "3", depth: 1, text: "After" },
    ]);
  });

  it("does not expand nodes inside an embed's rendered output", () => {
    const inner = { type: "base-embed", children: [{ text: "" }] };
    const outer = { type: "base-embed", children: [{ text: "" }] };
    const expand = (node: unknown) =>
      node === outer
        ? [inner]
        : node === inner
          ? [{ type: "heading", level: 1, children: [{ text: "Nested" }] }]
          : null;
    expect(buildToc([outer], expand)).toEqual([]);
  });
});
