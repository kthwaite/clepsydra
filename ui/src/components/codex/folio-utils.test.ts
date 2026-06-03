import { describe, expect, it } from "vitest";
import {
  countWordsFromSlate,
  previewMarkdownSource,
  stripFrontmatter,
} from "./folio-utils";

describe("stripFrontmatter", () => {
  it("removes a leading YAML block", () => {
    expect(stripFrontmatter("---\ntitle: x\n---\n# Heading")).toBe("# Heading");
  });

  it("leaves bodies without frontmatter untouched", () => {
    expect(stripFrontmatter("# Heading\n\ntext")).toBe("# Heading\n\ntext");
  });
});

describe("previewMarkdownSource", () => {
  it("preserves markdown structure (frontmatter aside)", () => {
    expect(
      previewMarkdownSource(
        "---\ntype: note\n---\n## common expansions\n\nbody",
      ),
    ).toBe("## common expansions\n\nbody");
  });

  it("returns short bodies unchanged", () => {
    expect(previewMarkdownSource("# Hi\n\nshort")).toBe("# Hi\n\nshort");
  });

  it("caps long bodies at a line boundary", () => {
    const body = `${"a".repeat(40)}\n${"b".repeat(40)}\n${"c".repeat(40)}`;
    const out = previewMarkdownSource(body, 50);
    // Cap is 50; the cut falls back to the last newline (offset 40), so only
    // the first line survives.
    expect(out).toBe("a".repeat(40));
  });

  it("closes a dangling code fence left by truncation", () => {
    const body = `\`\`\`sh\n${"echo hi\n".repeat(20)}`;
    const out = previewMarkdownSource(body, 40);
    expect((out.match(/```/g) ?? []).length % 2).toBe(0);
    expect(out.endsWith("```")).toBe(true);
  });
});

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
