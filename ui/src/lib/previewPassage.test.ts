import { render } from "@testing-library/react";
import { createElement } from "react";
import ReactMarkdown from "react-markdown";
import type { Descendant } from "slate";
import { describe, expect, it } from "vitest";
import { slateToMarkdown } from "#/editor/convert";
import { remarkWikilinks } from "#/lib/markdown/wikilinks";
import {
  findPreviewPassage,
  remarkPreviewPassages,
} from "#/lib/previewPassage";

describe("scoped passage lookup", () => {
  it("resolves Unicode and duplicate headings identically without consulting another page", () => {
    const outside = document.createElement("h2");
    outside.id = "研究-café-1";
    document.body.append(outside);
    const root = document.createElement("div");
    root.innerHTML =
      "<h2>研究 Café</h2><p>Context</p><h2>研究 Café</h2><p>Later</p>";
    expect(findPreviewPassage(root, { heading: "研究 Café" })).toBe(
      root.children[0],
    );
    expect(findPreviewPassage(root, { heading: "研究-café-1" })).toBe(
      root.children[2],
    );
    expect(findPreviewPassage(root, { heading: "研究 Cafe\u0301" })).toBe(
      root.children[0],
    );
    expect(findPreviewPassage(root, { heading: "Missing" })).toBeNull();
    outside.remove();
  });

  it("finds only source blocks inside its own surface", () => {
    const root = document.createElement("div");

    root.innerHTML =
      '<p data-block-id="abc123DEF0">Actual block</p><a>Reference ((abc123DEF0))</a>';
    expect(findPreviewPassage(root, { blockId: "abc123DEF0" })).toBe(
      root.firstElementChild,
    );
    expect(findPreviewPassage(root, { blockId: "missing1234" })).toBeNull();
  });
  it("ignores editor controls while retaining inline link labels in a heading", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<h2><span data-slate-string>Meet </span><span contenteditable="false"><a>Jane</a><button>Preview</button></span><span data-slate-zero-width>\\uFEFF</span></h2>';
    expect(findPreviewPassage(root, { heading: "Meet Jane" })).toBe(
      root.firstElementChild,
    );
  });

  it("locates code, nested list items, and quoted source paragraphs after canonical serialization", () => {
    const source: Descendant[] = [
      {
        type: "code-block",
        language: "ts",
        blockId: "code123456",
        children: [{ text: 'const literal = "^literal123";' }],
      },
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            blockId: "parent1234",
            children: [
              { type: "paragraph", children: [{ text: "Parent item" }] },
              {
                type: "bulleted-list",
                children: [
                  {
                    type: "list-item",
                    blockId: "nested1234",
                    children: [
                      {
                        type: "paragraph",
                        children: [{ text: "Nested item" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "blockquote",
        children: [
          {
            type: "paragraph",
            blockId: "quoted1234",
            children: [{ text: "Quoted passage" }],
          },
        ],
      },
    ];
    const { container } = render(
      createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkPreviewPassages] },
        slateToMarkdown(source),
      ),
    );
    const code = findPreviewPassage(container, { blockId: "code123456" });
    expect(code?.tagName).toBe("CODE");
    expect(code).toHaveTextContent('const literal = "^literal123";');
    expect(code).not.toHaveTextContent("^code123456");
    const parent = findPreviewPassage(container, { blockId: "parent1234" });
    const nested = findPreviewPassage(container, { blockId: "nested1234" });
    expect(parent?.tagName).toBe("LI");
    expect(nested?.tagName).toBe("LI");
    expect(parent).toContainElement(nested);
    expect(nested).toHaveTextContent("Nested item");
    const quote = findPreviewPassage(container, { blockId: "quoted1234" });
    expect(quote?.tagName).toBe("P");
    expect(quote?.closest("blockquote")).not.toBeNull();
    expect(quote).toHaveTextContent("Quoted passage");
  });

  it("preserves literal marker-like code and uses rendered wikilink aliases for heading identity", () => {
    const source: Descendant[] = [
      {
        type: "heading",
        level: 2,
        children: [
          { text: "Meet " },
          {
            type: "wikilink",
            target: "Jane Doe",
            alias: "Jane",
            children: [{ text: "" }],
          },
        ],
      },
      {
        type: "code-block",
        language: "ts",
        children: [{ text: 'const literal = "^abc123DEF0";\\n// ^short' }],
      },
      {
        type: "paragraph",
        children: [{ text: "literal ^abc123DEF0", code: true }],
      },
    ];
    const { container } = render(
      createElement(
        ReactMarkdown,
        { remarkPlugins: [...remarkWikilinks, remarkPreviewPassages] },
        slateToMarkdown(source),
      ),
    );
    const heading = findPreviewPassage(container, { heading: "Meet Jane" });
    expect(heading?.tagName).toBe("H2");
    expect(heading).toHaveTextContent("Meet Jane");
    expect(
      findPreviewPassage(container, { heading: "Meet Jane Doe" }),
    ).toBeNull();
    expect(container.querySelector("pre")).toHaveTextContent(
      'const literal = "^abc123DEF0";',
    );
    expect(container.querySelector("p code")).toHaveTextContent(
      "literal ^abc123DEF0",
    );
    expect(findPreviewPassage(container, { blockId: "abc123DEF0" })).toBeNull();
  });
});
