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
});
