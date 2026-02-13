import type { Descendant } from "slate";
import { describe, expect, it } from "vitest";
import { slateToMarkdown } from "../index";

describe("slateToMarkdown", () => {
  it("converts a paragraph to plain text", () => {
    const slate: Descendant[] = [
      { type: "paragraph", children: [{ text: "Hello world" }] },
    ];
    expect(slateToMarkdown(slate).trim()).toBe("Hello world");
  });

  it("converts headings", () => {
    const slate: Descendant[] = [
      { type: "heading", level: 1, children: [{ text: "Title" }] },
      { type: "heading", level: 2, children: [{ text: "Subtitle" }] },
      { type: "heading", level: 3, children: [{ text: "Section" }] },
    ];
    expect(slateToMarkdown(slate).trim()).toBe(
      "# Title\n\n## Subtitle\n\n### Section",
    );
  });

  it("converts bold text", () => {
    const slate: Descendant[] = [
      {
        type: "paragraph",
        children: [
          { text: "some " },
          { text: "bold", bold: true },
          { text: " text" },
        ],
      },
    ];
    expect(slateToMarkdown(slate).trim()).toBe("some **bold** text");
  });

  it("converts italic text", () => {
    const slate: Descendant[] = [
      {
        type: "paragraph",
        children: [
          { text: "some " },
          { text: "italic", italic: true },
          { text: " text" },
        ],
      },
    ];
    expect(slateToMarkdown(slate).trim()).toBe("some *italic* text");
  });

  it("converts inline code", () => {
    const slate: Descendant[] = [
      {
        type: "paragraph",
        children: [
          { text: "use " },
          { text: "useState", code: true },
          { text: " hook" },
        ],
      },
    ];
    expect(slateToMarkdown(slate).trim()).toBe("use `useState` hook");
  });

  it("converts code blocks", () => {
    const slate: Descendant[] = [
      {
        type: "code-block",
        language: "typescript",
        children: [{ text: "const x = 1;\nconsole.log(x);" }],
      },
    ];
    expect(slateToMarkdown(slate).trim()).toBe(
      "```typescript\nconst x = 1;\nconsole.log(x);\n```",
    );
  });

  it("converts code blocks without language", () => {
    const slate: Descendant[] = [
      {
        type: "code-block",
        children: [{ text: "hello" }],
      },
    ];
    expect(slateToMarkdown(slate).trim()).toBe("```\nhello\n```");
  });

  it("converts blockquotes", () => {
    const slate: Descendant[] = [
      {
        type: "blockquote",
        children: [{ type: "paragraph", children: [{ text: "quoted text" }] }],
      },
    ];
    expect(slateToMarkdown(slate).trim()).toBe("> quoted text");
  });

  it("converts bulleted lists", () => {
    const slate: Descendant[] = [
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [{ type: "paragraph", children: [{ text: "first" }] }],
          },
          {
            type: "list-item",
            children: [{ type: "paragraph", children: [{ text: "second" }] }],
          },
        ],
      },
    ];
    expect(slateToMarkdown(slate).trim()).toBe("* first\n* second");
  });

  it("converts ordered lists", () => {
    const slate: Descendant[] = [
      {
        type: "numbered-list",
        children: [
          {
            type: "list-item",
            children: [{ type: "paragraph", children: [{ text: "first" }] }],
          },
          {
            type: "list-item",
            children: [{ type: "paragraph", children: [{ text: "second" }] }],
          },
        ],
      },
    ];
    expect(slateToMarkdown(slate).trim()).toBe("1. first\n2. second");
  });

  it("converts links", () => {
    const slate: Descendant[] = [
      {
        type: "paragraph",
        children: [
          { text: "visit " },
          {
            type: "link",
            url: "https://example.com",
            children: [{ text: "Example" }],
          },
          { text: " site" },
        ],
      },
    ];
    expect(slateToMarkdown(slate).trim()).toBe(
      "visit [Example](https://example.com) site",
    );
  });

  it("converts thematic breaks", () => {
    const slate: Descendant[] = [
      { type: "paragraph", children: [{ text: "above" }] },
      { type: "thematic-break", children: [{ text: "" }] },
      { type: "paragraph", children: [{ text: "below" }] },
    ];
    expect(slateToMarkdown(slate).trim()).toBe("above\n\n---\n\nbelow");
  });

  it("converts wikilinks without alias", () => {
    const slate: Descendant[] = [
      {
        type: "paragraph",
        children: [
          { text: "see " },
          {
            type: "wikilink",
            target: "My Page",
            children: [{ text: "" }],
          },
          { text: " for details" },
        ],
      },
    ];
    expect(slateToMarkdown(slate).trim()).toBe("see [[My Page]] for details");
  });

  it("converts wikilinks with alias", () => {
    const slate: Descendant[] = [
      {
        type: "paragraph",
        children: [
          { text: "see " },
          {
            type: "wikilink",
            target: "My Page",
            alias: "display text",
            children: [{ text: "" }],
          },
          { text: " for details" },
        ],
      },
    ];
    expect(slateToMarkdown(slate).trim()).toBe(
      "see [[My Page|display text]] for details",
    );
  });

  it("converts bold + italic combined", () => {
    const slate: Descendant[] = [
      {
        type: "paragraph",
        children: [{ text: "bold and italic", bold: true, italic: true }],
      },
    ];
    expect(slateToMarkdown(slate).trim()).toBe("***bold and italic***");
  });

  it("converts bold + code combined", () => {
    const slate: Descendant[] = [
      {
        type: "paragraph",
        children: [{ text: "code", bold: true, code: true }],
      },
    ];
    // code mark takes precedence — inline code cannot be bold in markdown
    expect(slateToMarkdown(slate).trim()).toBe("`code`");
  });

  it("handles empty document", () => {
    const slate: Descendant[] = [];
    expect(slateToMarkdown(slate).trim()).toBe("");
  });
});
