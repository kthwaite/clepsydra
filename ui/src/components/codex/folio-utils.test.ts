import { describe, expect, it } from "vitest";
import { countWordsFromSlate } from "./folio-utils";

describe("countWordsFromSlate", () => {
  it("returns 0 for empty value", () => {
    expect(countWordsFromSlate([])).toBe(0);
  });

  it("counts words across leaves", () => {
    const value = [
      {
        type: "paragraph",
        children: [{ text: "the kettle has " }, { text: "stopped twice" }],
      },
      { type: "paragraph", children: [{ text: "outside, a pigeon" }] },
    ];
    expect(countWordsFromSlate(value)).toBe(8);
  });

  it("ignores empty leaves and whitespace-only text", () => {
    const value = [
      {
        type: "paragraph",
        children: [{ text: "  " }, { text: "" }, { text: "one" }],
      },
    ];
    expect(countWordsFromSlate(value)).toBe(1);
  });

  it("walks heading and list-item children recursively", () => {
    const value = [
      { type: "heading", level: 1, children: [{ text: "alpha beta" }] },
      {
        type: "list",
        children: [
          {
            type: "list-item",
            children: [
              { type: "paragraph", children: [{ text: "gamma delta" }] },
            ],
          },
        ],
      },
    ];
    expect(countWordsFromSlate(value)).toBe(4);
  });
});
