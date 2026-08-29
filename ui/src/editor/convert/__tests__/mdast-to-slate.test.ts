import { describe, expect, it } from "vitest";
import { markdownToSlate } from "../index";

describe("markdownToSlate", () => {
  describe("empty / minimal documents", () => {
    it("returns a single empty paragraph for an empty string", () => {
      const result = markdownToSlate("");
      expect(result).toEqual([{ type: "paragraph", children: [{ text: "" }] }]);
    });

    it("returns a single empty paragraph for whitespace-only input", () => {
      const result = markdownToSlate("   \n  \n  ");
      expect(result).toEqual([{ type: "paragraph", children: [{ text: "" }] }]);
    });
  });

  describe("paragraphs", () => {
    it("converts a simple paragraph", () => {
      const result = markdownToSlate("Hello world");
      expect(result).toEqual([
        { type: "paragraph", children: [{ text: "Hello world" }] },
      ]);
    });

    it("converts multiple paragraphs", () => {
      const result = markdownToSlate("First paragraph\n\nSecond paragraph");
      expect(result).toEqual([
        { type: "paragraph", children: [{ text: "First paragraph" }] },
        { type: "paragraph", children: [{ text: "Second paragraph" }] },
      ]);
    });
  });

  describe("headings", () => {
    it("converts h1", () => {
      const result = markdownToSlate("# Heading 1");
      expect(result).toEqual([
        { type: "heading", level: 1, children: [{ text: "Heading 1" }] },
      ]);
    });

    it("converts h2", () => {
      const result = markdownToSlate("## Heading 2");
      expect(result).toEqual([
        { type: "heading", level: 2, children: [{ text: "Heading 2" }] },
      ]);
    });

    it("converts h3 through h6", () => {
      for (let i = 3; i <= 6; i++) {
        const hashes = "#".repeat(i);
        const result = markdownToSlate(`${hashes} Heading ${i}`);
        expect(result).toEqual([
          {
            type: "heading",
            level: i,
            children: [{ text: `Heading ${i}` }],
          },
        ]);
      }
    });
  });

  describe("inline formatting", () => {
    it("converts bold text", () => {
      const result = markdownToSlate("Some **bold** text");
      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            { text: "Some " },
            { text: "bold", bold: true },
            { text: " text" },
          ],
        },
      ]);
    });

    it("converts italic text", () => {
      const result = markdownToSlate("Some *italic* text");
      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            { text: "Some " },
            { text: "italic", italic: true },
            { text: " text" },
          ],
        },
      ]);
    });

    it("converts bold+italic text", () => {
      const result = markdownToSlate("Some ***bold italic*** text");
      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            { text: "Some " },
            { text: "bold italic", bold: true, italic: true },
            { text: " text" },
          ],
        },
      ]);
    });

    it("converts inline code", () => {
      const result = markdownToSlate("Some `code` text");
      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            { text: "Some " },
            { text: "code", code: true },
            { text: " text" },
          ],
        },
      ]);
    });
  });

  describe("colour marks", () => {
    it("parses text and highlight colours while ignoring unrelated styles", () => {
      const result = markdownToSlate(
        'before <span style="font-size: 20px; color: #336699; background-color: rgb(255, 240, 120); letter-spacing: 2px">painted</span> after',
      );
      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            { text: "before " },
            {
              text: "painted",
              color: "#336699",
              backgroundColor: "rgb(255, 240, 120)",
            },
            { text: " after" },
          ],
        },
      ]);
    });

    it("combines a colour with an existing markdown mark", () => {
      const result = markdownToSlate(
        '<span style="color: rebeccapurple">**nested**</span>',
      );
      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            { text: "nested", bold: true, color: "rebeccapurple" },
          ],
        },
      ]);
    });

    it("represents cleared colours as absent marks", () => {
      const result = markdownToSlate(
        '<span style="color: red">red</span> plain <span style="background-color: yellow">highlight</span>',
      );
      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            { text: "red", color: "red" },
            { text: " plain " },
            { text: "highlight", backgroundColor: "yellow" },
          ],
        },
      ]);
    });

    it("keeps unsupported nested spans literal without clearing outer colour", () => {
      const result = markdownToSlate(
        '<span style="color: red"><span class="x">inner</span> outer</span>',
      );
      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            { text: '<span class="x">', color: "red" },
            { text: "inner", color: "red" },
            { text: "</span>", color: "red" },
            { text: " outer", color: "red" },
          ],
        },
      ]);
    });

    it("consumes style spans with only unsupported declarations", () => {
      const result = markdownToSlate(
        '<span style="font-size: 20px">plain</span>',
      );
      expect(result).toEqual([
        {
          type: "paragraph",
          children: [{ text: "plain" }],
        },
      ]);
    });

    it("consumes style spans with only an unsafe colour value", () => {
      const result = markdownToSlate(
        '<span style="color: url(&quot;javascript:alert(1)&quot;)">plain</span>',
      );
      expect(result).toEqual([
        {
          type: "paragraph",
          children: [{ text: "plain" }],
        },
      ]);
    });
  });

  describe("code blocks", () => {
    it("converts a code block without language", () => {
      const result = markdownToSlate("```\nconst x = 1;\n```");
      expect(result).toEqual([
        {
          type: "code-block",
          children: [{ text: "const x = 1;" }],
        },
      ]);
    });

    it("converts a code block with language", () => {
      const result = markdownToSlate(
        "```typescript\nconst x: number = 1;\n```",
      );
      expect(result).toEqual([
        {
          type: "code-block",
          language: "typescript",
          children: [{ text: "const x: number = 1;" }],
        },
      ]);
    });

    it("extracts a terminal valid block ID from fenced code", () => {
      const result = markdownToSlate(
        "```typescript\nconst answer = 42;\n^abc123DEF0\n```",
      );

      expect(result).toEqual([
        {
          type: "code-block",
          language: "typescript",
          blockId: "abc123DEF0",
          children: [{ text: "const answer = 42;" }],
        },
      ]);
    });
  });

  describe("blockquotes", () => {
    it("converts a simple blockquote", () => {
      const result = markdownToSlate("> A quote");
      expect(result).toEqual([
        {
          type: "blockquote",
          children: [{ type: "paragraph", children: [{ text: "A quote" }] }],
        },
      ]);
    });

    it("converts a blockquote with formatting", () => {
      const result = markdownToSlate("> A **bold** quote");
      expect(result).toEqual([
        {
          type: "blockquote",
          children: [
            {
              type: "paragraph",
              children: [
                { text: "A " },
                { text: "bold", bold: true },
                { text: " quote" },
              ],
            },
          ],
        },
      ]);
    });
  });

  describe("lists", () => {
    it("converts a bulleted list", () => {
      const result = markdownToSlate("- Item 1\n- Item 2\n- Item 3");
      expect(result).toEqual([
        {
          type: "bulleted-list",
          children: [
            {
              type: "list-item",
              children: [{ type: "paragraph", children: [{ text: "Item 1" }] }],
            },
            {
              type: "list-item",
              children: [{ type: "paragraph", children: [{ text: "Item 2" }] }],
            },
            {
              type: "list-item",
              children: [{ type: "paragraph", children: [{ text: "Item 3" }] }],
            },
          ],
        },
      ]);
    });

    it("converts an ordered list", () => {
      const result = markdownToSlate("1. First\n2. Second\n3. Third");
      expect(result).toEqual([
        {
          type: "numbered-list",
          children: [
            {
              type: "list-item",
              children: [{ type: "paragraph", children: [{ text: "First" }] }],
            },
            {
              type: "list-item",
              children: [{ type: "paragraph", children: [{ text: "Second" }] }],
            },
            {
              type: "list-item",
              children: [{ type: "paragraph", children: [{ text: "Third" }] }],
            },
          ],
        },
      ]);
    });

    it("converts nested lists", () => {
      const result = markdownToSlate("- Outer\n  - Inner 1\n  - Inner 2");
      expect(result).toEqual([
        {
          type: "bulleted-list",
          children: [
            {
              type: "list-item",
              children: [
                { type: "paragraph", children: [{ text: "Outer" }] },
                {
                  type: "bulleted-list",
                  children: [
                    {
                      type: "list-item",
                      children: [
                        {
                          type: "paragraph",
                          children: [{ text: "Inner 1" }],
                        },
                      ],
                    },
                    {
                      type: "list-item",
                      children: [
                        {
                          type: "paragraph",
                          children: [{ text: "Inner 2" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]);
    });
  });

  describe("links", () => {
    it("converts a markdown link", () => {
      const result = markdownToSlate("[click here](https://example.com)");
      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "https://example.com",
              children: [{ text: "click here" }],
            },
          ],
        },
      ]);
    });

    it("converts a link with formatting inside", () => {
      const result = markdownToSlate("[**bold link**](https://example.com)");
      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "https://example.com",
              children: [{ text: "bold link", bold: true }],
            },
          ],
        },
      ]);
    });

    it("keeps block references literal throughout ordinary link labels", () => {
      const result = markdownToSlate(
        "[**See ~((abc123DEF0))~**](https://example.com)",
      );

      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "https://example.com",
              children: [
                {
                  text: "See ",
                  bold: true,
                },
                {
                  text: "((abc123DEF0))",
                  bold: true,
                  strikethrough: true,
                },
              ],
            },
          ],
        },
      ]);
    });

    it("resolves link references without converting their labels to block refs", () => {
      const result = markdownToSlate(
        "[**See ((abc123DEF0))**][source]\n\n[source]: notes/source.md",
      );

      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "notes/source.md",
              children: [
                {
                  text: "See ((abc123DEF0))",
                  bold: true,
                },
              ],
            },
          ],
        },
      ]);
    });
  });

  describe("images", () => {
    it("converts a CAS-backed markdown image without dropping its metadata", () => {
      const result = markdownToSlate(
        'Before ![Archived chart](cas:sha256:abc123 "Quarterly chart") after',
      );

      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            { text: "Before " },
            {
              type: "image",
              url: "cas:sha256:abc123",
              alt: "Archived chart",
              title: "Quarterly chart",
              children: [{ text: "" }],
            },
            { text: " after" },
          ],
        },
      ]);
    });
  });

  describe("thematic breaks", () => {
    it("converts a thematic break", () => {
      const result = markdownToSlate("Above\n\n---\n\nBelow");
      expect(result).toEqual([
        { type: "paragraph", children: [{ text: "Above" }] },
        { type: "thematic-break", children: [{ text: "" }] },
        { type: "paragraph", children: [{ text: "Below" }] },
      ]);
    });
  });

  describe("wikilinks", () => {
    it("converts a wikilink without alias", () => {
      const result = markdownToSlate("See [[My Page]] for details");
      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            { text: "See " },
            {
              type: "wikilink",
              target: "My Page",
              children: [{ text: "" }],
            },
            { text: " for details" },
          ],
        },
      ]);
    });

    it("converts a wikilink with alias", () => {
      const result = markdownToSlate(
        "See [[My Page|display text]] for details",
      );
      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            { text: "See " },
            {
              type: "wikilink",
              target: "My Page",
              alias: "display text",
              children: [{ text: "" }],
            },
            { text: " for details" },
          ],
        },
      ]);
    });

    it("converts a standalone wikilink", () => {
      const result = markdownToSlate("[[Some Page]]");
      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            {
              type: "wikilink",
              target: "Some Page",
              children: [{ text: "" }],
            },
          ],
        },
      ]);
    });
  });

  describe("task lists", () => {
    it("converts checkbox list items with checked state", () => {
      const result = markdownToSlate("- [ ] Todo item\n- [x] Done item\n");
      expect(result).toEqual([
        {
          type: "bulleted-list",
          children: [
            {
              type: "list-item",
              checked: false,
              children: [
                { type: "paragraph", children: [{ text: "Todo item" }] },
              ],
            },
            {
              type: "list-item",
              checked: true,
              children: [
                { type: "paragraph", children: [{ text: "Done item" }] },
              ],
            },
          ],
        },
      ]);
    });

    it("leaves checked undefined for non-task items", () => {
      const result = markdownToSlate("- Regular item\n");
      const list = result[0] as {
        children: Array<{ checked?: boolean | null }>;
      };
      expect(list.children[0].checked).toBeUndefined();
    });

    it("handles mixed task and non-task items", () => {
      const result = markdownToSlate("- [ ] Task\n- Regular\n- [x] Done\n");
      const list = result[0] as {
        children: Array<{ type: string; checked?: boolean | null }>;
      };
      expect(list.children[0].checked).toBe(false);
      expect(list.children[1].checked).toBeUndefined();
      expect(list.children[2].checked).toBe(true);
    });
  });

  describe("block IDs", () => {
    it("extracts ^id from end of list item text", () => {
      const result = markdownToSlate("- Item ^abc123DEF0\n");
      const list = result[0] as {
        children: Array<{
          type: string;
          blockId?: string;
          children: Array<{ children: Array<{ text: string }> }>;
        }>;
      };
      expect(list.children[0].blockId).toBe("abc123DEF0");
      expect(list.children[0].children[0].children[0].text).toBe("Item");
    });

    it("extracts ^id from paragraph", () => {
      const result = markdownToSlate("Some text ^abc123DEF0\n");
      const para = result[0] as {
        type: string;
        blockId?: string;
        children: Array<{ text: string }>;
      };
      expect(para.blockId).toBe("abc123DEF0");
      expect(para.children[0].text).toBe("Some text");
    });

    it("extracts ^id from heading", () => {
      const result = markdownToSlate("## My heading ^abc123DEF0\n");
      const heading = result[0] as {
        type: string;
        blockId?: string;
        children: Array<{ text: string }>;
      };
      expect(heading.blockId).toBe("abc123DEF0");
      expect(heading.children[0].text).toBe("My heading");
    });

    it("extracts blockId from parent in nested list", () => {
      const result = markdownToSlate("- Parent ^abc123DEF0\n  - Child\n");
      const list = result[0] as any;
      const parent = list.children[0];
      expect(parent.blockId).toBe("abc123DEF0");
      // Text should be cleaned
      const firstChild = parent.children[0];
      if (firstChild.text !== undefined) {
        expect(firstChild.text.trim()).toBe("Parent");
      }
    });

    it("does not extract IDs shorter than 10 chars", () => {
      const result = markdownToSlate("Text ^short\n");
      const para = result[0] as { blockId?: string };
      expect(para.blockId).toBeUndefined();
    });

    it("does not extract IDs longer than 12 chars", () => {
      const result = markdownToSlate("Text ^abcdefghijklm\n");
      const para = result[0] as { blockId?: string };
      expect(para.blockId).toBeUndefined();
    });
  });

  describe("inline properties", () => {
    it("extracts [key:: value] pairs from list items", () => {
      const result = markdownToSlate(
        "- Buy milk [due:: 2026-03-01] [priority:: A]\n",
      );
      const list = result[0] as {
        children: Array<{
          properties?: Record<string, string>;
          children: Array<{ children: Array<{ text: string }> }>;
        }>;
      };
      expect(list.children[0].properties).toEqual({
        due: "2026-03-01",
        priority: "A",
      });
      expect(list.children[0].children[0].children[0].text).toBe("Buy milk");
    });

    it("extracts [key:: value] from paragraphs", () => {
      const result = markdownToSlate(
        "Some note [status:: draft] [author:: kit]\n",
      );
      const para = result[0] as {
        properties?: Record<string, string>;
        children: Array<{ text: string }>;
      };
      expect(para.properties).toEqual({ status: "draft", author: "kit" });
      expect(para.children[0].text).toBe("Some note");
    });

    it("handles properties with hyphens and underscores in keys", () => {
      const result = markdownToSlate("Text [my_key:: val] [my-key2:: val2]\n");
      const para = result[0] as { properties?: Record<string, string> };
      expect(para.properties).toEqual({ my_key: "val", "my-key2": "val2" });
    });

    it("does not set properties when none are found", () => {
      const result = markdownToSlate("Just plain text\n");
      const para = result[0] as { properties?: Record<string, string> };
      expect(para.properties).toBeUndefined();
    });
  });

  describe("combined block metadata", () => {
    it("extracts both properties and blockId from a list item", () => {
      const result = markdownToSlate(
        "- Buy milk [due:: 2026-03-01] ^abc123DEF0\n",
      );
      const list = result[0] as {
        children: Array<{
          blockId?: string;
          properties?: Record<string, string>;
          children: Array<{ children: Array<{ text: string }> }>;
        }>;
      };
      expect(list.children[0].blockId).toBe("abc123DEF0");
      expect(list.children[0].properties).toEqual({ due: "2026-03-01" });
      expect(list.children[0].children[0].children[0].text).toBe("Buy milk");
    });
  });

  describe("mixed content", () => {
    it("handles a document with varied block types", () => {
      const md = `# Title

A paragraph with **bold** and *italic*.

> A blockquote

- Item one
- Item two

\`\`\`js
console.log("hi");
\`\`\`

---

See [[Other Page]] for more.`;

      const result = markdownToSlate(md);

      // Verify block-level structure
      expect(result[0]).toEqual({
        type: "heading",
        level: 1,
        children: [{ text: "Title" }],
      });
      expect(result[1]).toMatchObject({ type: "paragraph" });
      expect(result[2]).toMatchObject({ type: "blockquote" });
      expect(result[3]).toMatchObject({ type: "bulleted-list" });
      expect(result[4]).toEqual({
        type: "code-block",
        language: "js",
        children: [{ text: 'console.log("hi");' }],
      });
      expect(result[5]).toEqual({
        type: "thematic-break",
        children: [{ text: "" }],
      });
      expect(result[6]).toMatchObject({ type: "paragraph" });
    });
  });

  describe("strikethrough", () => {
    it("converts single-tilde strikethrough", () => {
      const result = markdownToSlate("Some ~deleted~ text");
      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            { text: "Some " },
            { text: "deleted", strikethrough: true },
            { text: " text" },
          ],
        },
      ]);
    });

    it("converts double-tilde strikethrough", () => {
      const result = markdownToSlate("Some ~~deleted~~ text");
      expect(result).toEqual([
        {
          type: "paragraph",
          children: [
            { text: "Some " },
            { text: "deleted", strikethrough: true },
            { text: " text" },
          ],
        },
      ]);
    });
  });

  describe("superscript / subscript", () => {
    type Leaf = {
      text?: string;
      superscript?: true;
      subscript?: true;
      children?: Leaf[];
    };

    it("parses inline <sup>/<sub> back into marks", () => {
      const result = markdownToSlate("H<sub>2</sub>O and x<sup>2</sup>");
      const leaves: Leaf[] = [];
      const walk = (n: Leaf) => {
        if (n.text !== undefined) leaves.push(n);
        for (const child of n.children ?? []) walk(child);
      };
      for (const node of result) walk(node as Leaf);
      expect(leaves.some((l) => l.subscript === true && l.text === "2")).toBe(
        true,
      );
      expect(leaves.some((l) => l.superscript === true && l.text === "2")).toBe(
        true,
      );
    });
  });

  describe("math", () => {
    it("maps positioned inline math to typed inline elements", () => {
      expect(markdownToSlate(String.raw`before $x$ and \(y\) after`)).toEqual([
        {
          type: "paragraph",
          children: [
            { text: "before " },
            {
              type: "inline-math",
              tex: "x",
              delimiter: "$",
              children: [{ text: "" }],
            },
            { text: " and " },
            {
              type: "inline-math",
              tex: "y",
              delimiter: String.raw`\(`,
              children: [{ text: "" }],
            },
            { text: " after" },
          ],
        },
      ]);
    });

    it.each([
      ["$$\nx\n$$", "$$", "\nx\n"],
      [
        String.raw`\[
x
\]`,
        String.raw`\[`,
        "\nx\n",
      ],
    ])("maps display math separately: %s", (source, delimiter, tex) => {
      expect(markdownToSlate(source)).toEqual([
        {
          type: "math-block",
          tex,
          delimiter,
          children: [{ text: "" }],
        },
      ]);
    });
  });
});

describe("tables", () => {
  it("converts a GFM table into table / table-row / table-cell nodes", () => {
    const slate = markdownToSlate(
      ["| A | B |", "| - | - |", "| 1 | 2 |"].join("\n"),
    );
    expect(slate).toEqual([
      {
        type: "table",
        children: [
          {
            type: "table-row",
            children: [
              { type: "table-cell", header: true, children: [{ text: "A" }] },
              { type: "table-cell", header: true, children: [{ text: "B" }] },
            ],
          },
          {
            type: "table-row",
            children: [
              { type: "table-cell", children: [{ text: "1" }] },
              { type: "table-cell", children: [{ text: "2" }] },
            ],
          },
        ],
      },
    ]);
  });

  it("records column alignment on the table and mirrors it onto cells", () => {
    const slate = markdownToSlate(
      ["| L | C | R |", "| :- | :-: | -: |", "| 1 | 2 | 3 |"].join("\n"),
    );
    const table = slate[0] as unknown as {
      align: (string | null)[];
      children: { children: { align?: string }[] }[];
    };
    expect(table.align).toEqual(["left", "center", "right"]);
    expect(table.children[0].children.map((c) => c.align)).toEqual([
      "left",
      "center",
      "right",
    ]);
    expect(table.children[1].children.map((c) => c.align)).toEqual([
      "left",
      "center",
      "right",
    ]);
  });

  it("omits align entirely when no column declares one", () => {
    const slate = markdownToSlate(["| A |", "| - |", "| 1 |"].join("\n"));
    expect(slate[0]).not.toHaveProperty("align");
  });

  it("keeps inline content inside cells", () => {
    const slate = markdownToSlate(
      ["| A |", "| - |", "| **bold** and [[Page]] |"].join("\n"),
    );
    const cell = (
      slate[0] as unknown as {
        children: { children: { children: unknown[] }[] }[];
      }
    ).children[1].children[0];
    expect(cell.children).toEqual([
      { text: "bold", bold: true },
      { text: " and " },
      { type: "wikilink", target: "Page", children: [{ text: "" }] },
    ]);
  });

  it("leaves a short row short rather than padding it", () => {
    const slate = markdownToSlate(
      ["| A | B |", "| - | - |", "| 1 |"].join("\n"),
    );
    const rows = (
      slate[0] as unknown as { children: { children: unknown[] }[] }
    ).children;
    expect(rows[1].children).toHaveLength(1);
  });
});
