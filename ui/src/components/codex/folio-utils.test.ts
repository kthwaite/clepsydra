import { describe, expect, it } from "vitest";
import type { OutlinkEntry } from "#/api/types";
import {
  countWordsFromSlate,
  folioDisplayName,
  previewMarkdownSource,
  stripFrontmatter,
  visibleFolioOutlinks,
} from "./folio-utils";

const outlink = (kind: string, target_path: string | null): OutlinkEntry => ({
  kind,
  source_field: kind === "property_ref" ? "tags" : null,
  target_id: target_path ? "019ff000-0000-7000-8000-000000000000" : null,
  target_path,
  target_raw: target_path ?? "missing",
});

describe("visibleFolioOutlinks", () => {
  it("keeps only resolved page and block links visible in Folio", () => {
    const visible = visibleFolioOutlinks([
      outlink("property_ref", "notes/tag.md"),
      outlink("property_ref", null),
      outlink("wiki", "notes/page.md"),
      outlink("wiki", null),
      outlink("block_ref", "notes/page.md"),
    ]);

    expect(visible.map(({ kind, target_path }) => [kind, target_path])).toEqual(
      [
        ["wiki", "notes/page.md"],
        ["block_ref", "notes/page.md"],
      ],
    );
  });

  it("returns an empty array for absent data", () => {
    expect(visibleFolioOutlinks(undefined)).toEqual([]);
  });
});

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

describe("folioDisplayName", () => {
  it("derives spaced words from a slug with an 8-char short id", () => {
    expect(folioDisplayName("notes/20260101.my-great-note.ab12CD34.md")).toBe(
      "my great note",
    );
  });

  it("falls back to the basename when there is no short id", () => {
    expect(folioDisplayName("journal/2026-06-05.md")).toBe("2026-06-05");
  });

  it("falls back to the basename for a bare filename", () => {
    expect(folioDisplayName("inbox.md")).toBe("inbox");
  });

  it("falls back when the trailing segment is not an 8-char id", () => {
    expect(folioDisplayName("a.b.c.md")).toBe("a.b.c");
  });
});
