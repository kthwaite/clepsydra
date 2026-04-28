# SlateJS Editor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the read-only page viewer with an always-edit Notion-style SlateJS editor with debounced autosave, markdown round-tripping, and wikilink autocomplete.

**Architecture:** Custom markdown-to-Slate and Slate-to-markdown converters built on remark/mdast. A `usePageEditor` hook orchestrates editor state, dirty tracking, and autosave via `PUT /api/vault/pages/{path}`. Slate plugins handle wikilinks (inline void with autocomplete) and links (inline). The editor replaces `PageTabContent`'s read-only rendering.

**Tech Stack:** Slate (slate, slate-react, slate-history), unified/remark-parse/mdast-util-to-markdown for conversion, vitest for testing, existing remark-wiki-link for wikilink mdast nodes.

**Design doc:** `docs/plans/2026-02-13-slatejs-editor-design.md`

---

### Task 1: Set Up Vitest and Install Dependencies

**Files:**
- Modify: `ui/package.json`
- Create: `ui/vitest.config.ts`

**Step 1: Install vitest and Slate packages**

Run from `ui/`:
```bash
bun add slate slate-react slate-history unified remark-parse mdast-util-to-markdown mdast-util-gfm remark-gfm
bun add -d vitest @testing-library/react @testing-library/jest-dom jsdom
```

Note: `remark-wiki-link` is already installed and bundles `micromark-extension-wiki-link` + `mdast-util-wiki-link` as transitive deps. No need to install those separately.

**Step 2: Create vitest config**

Create `ui/vitest.config.ts`:
```typescript
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "#": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [],
  },
});
```

**Step 3: Add test script to package.json**

Add to `scripts`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 4: Verify vitest works**

Create a trivial test to verify the setup:

Create `ui/src/editor/convert/__tests__/setup.test.ts`:
```typescript
import { describe, expect, it } from "vitest";

describe("vitest setup", () => {
  it("works", () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run: `bun run test`
Expected: 1 test passes.

**Step 5: Commit**

```bash
git add ui/package.json ui/bun.lock ui/vitest.config.ts ui/src/editor/convert/__tests__/setup.test.ts
git commit -m "chore(ui): add vitest and slate dependencies"
```

---

### Task 2: Slate Type Definitions

**Files:**
- Create: `ui/src/editor/types.ts`

**Step 1: Write the type definition file**

Create `ui/src/editor/types.ts`:
```typescript
import type { BaseEditor, Descendant } from "slate";
import type { HistoryEditor } from "slate-history";
import type { ReactEditor } from "slate-react";

// --- Element types ---

export interface ParagraphElement {
  type: "paragraph";
  children: Descendant[];
}

export interface HeadingElement {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children: Descendant[];
}

export interface CodeBlockElement {
  type: "code-block";
  language?: string;
  children: CustomText[];
}

export interface BlockquoteElement {
  type: "blockquote";
  children: Descendant[];
}

export interface BulletedListElement {
  type: "bulleted-list";
  children: ListItemElement[];
}

export interface NumberedListElement {
  type: "numbered-list";
  children: ListItemElement[];
}

export interface ListItemElement {
  type: "list-item";
  children: Descendant[];
}

export interface ThematicBreakElement {
  type: "thematic-break";
  children: CustomText[];
}

export interface WikilinkElement {
  type: "wikilink";
  target: string;
  alias?: string;
  children: CustomText[];
}

export interface LinkElement {
  type: "link";
  url: string;
  children: Descendant[];
}

export type CustomElement =
  | ParagraphElement
  | HeadingElement
  | CodeBlockElement
  | BlockquoteElement
  | BulletedListElement
  | NumberedListElement
  | ListItemElement
  | ThematicBreakElement
  | WikilinkElement
  | LinkElement;

// --- Text type ---

export interface CustomText {
  text: string;
  bold?: true;
  italic?: true;
  code?: true;
}

// --- Editor type ---

export type CustomEditor = BaseEditor & ReactEditor & HistoryEditor;

// --- Module augmentation ---

declare module "slate" {
  interface CustomTypes {
    Editor: CustomEditor;
    Element: CustomElement;
    Text: CustomText;
  }
}
```

**Step 2: Verify typecheck passes**

Run from `ui/`: `bun run typecheck`
Expected: No errors.

**Step 3: Commit**

```bash
git add ui/src/editor/types.ts
git commit -m "feat(editor): add slate custom type definitions"
```

---

### Task 3: Markdown-to-Slate Converter

**Files:**
- Create: `ui/src/editor/convert/mdast-to-slate.ts`
- Create: `ui/src/editor/convert/__tests__/mdast-to-slate.test.ts`
- Create: `ui/src/editor/convert/index.ts`

This is the core parsing pipeline: markdown string → mdast (via remark) → Slate `Descendant[]`.

**Step 1: Write the failing tests**

Create `ui/src/editor/convert/__tests__/mdast-to-slate.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { markdownToSlate } from "../index";

describe("markdownToSlate", () => {
  it("converts a paragraph", () => {
    const result = markdownToSlate("Hello world");
    expect(result).toEqual([
      { type: "paragraph", children: [{ text: "Hello world" }] },
    ]);
  });

  it("converts headings", () => {
    const result = markdownToSlate("# Heading 1\n\n## Heading 2");
    expect(result).toEqual([
      { type: "heading", level: 1, children: [{ text: "Heading 1" }] },
      { type: "heading", level: 2, children: [{ text: "Heading 2" }] },
    ]);
  });

  it("converts bold text", () => {
    const result = markdownToSlate("Hello **bold** world");
    expect(result).toEqual([
      {
        type: "paragraph",
        children: [
          { text: "Hello " },
          { text: "bold", bold: true },
          { text: " world" },
        ],
      },
    ]);
  });

  it("converts italic text", () => {
    const result = markdownToSlate("Hello *italic* world");
    expect(result).toEqual([
      {
        type: "paragraph",
        children: [
          { text: "Hello " },
          { text: "italic", italic: true },
          { text: " world" },
        ],
      },
    ]);
  });

  it("converts bold italic text", () => {
    const result = markdownToSlate("***both***");
    expect(result).toEqual([
      {
        type: "paragraph",
        children: [{ text: "both", bold: true, italic: true }],
      },
    ]);
  });

  it("converts inline code", () => {
    const result = markdownToSlate("Use `console.log` here");
    expect(result).toEqual([
      {
        type: "paragraph",
        children: [
          { text: "Use " },
          { text: "console.log", code: true },
          { text: " here" },
        ],
      },
    ]);
  });

  it("converts code blocks", () => {
    const result = markdownToSlate("```rust\nfn main() {}\n```");
    expect(result).toEqual([
      {
        type: "code-block",
        language: "rust",
        children: [{ text: "fn main() {}" }],
      },
    ]);
  });

  it("converts code blocks without language", () => {
    const result = markdownToSlate("```\nsome code\n```");
    expect(result).toEqual([
      {
        type: "code-block",
        children: [{ text: "some code" }],
      },
    ]);
  });

  it("converts blockquotes", () => {
    const result = markdownToSlate("> A wise quote");
    expect(result).toEqual([
      {
        type: "blockquote",
        children: [
          { type: "paragraph", children: [{ text: "A wise quote" }] },
        ],
      },
    ]);
  });

  it("converts bulleted lists", () => {
    const result = markdownToSlate("- Item one\n- Item two");
    expect(result).toEqual([
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [
              { type: "paragraph", children: [{ text: "Item one" }] },
            ],
          },
          {
            type: "list-item",
            children: [
              { type: "paragraph", children: [{ text: "Item two" }] },
            ],
          },
        ],
      },
    ]);
  });

  it("converts ordered lists", () => {
    const result = markdownToSlate("1. First\n2. Second");
    expect(result).toEqual([
      {
        type: "numbered-list",
        children: [
          {
            type: "list-item",
            children: [
              { type: "paragraph", children: [{ text: "First" }] },
            ],
          },
          {
            type: "list-item",
            children: [
              { type: "paragraph", children: [{ text: "Second" }] },
            ],
          },
        ],
      },
    ]);
  });

  it("converts markdown links", () => {
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

  it("converts thematic breaks", () => {
    const result = markdownToSlate("Above\n\n---\n\nBelow");
    expect(result).toEqual([
      { type: "paragraph", children: [{ text: "Above" }] },
      { type: "thematic-break", children: [{ text: "" }] },
      { type: "paragraph", children: [{ text: "Below" }] },
    ]);
  });

  it("converts wikilinks without alias", () => {
    const result = markdownToSlate("See [[My Page]]");
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
        ],
      },
    ]);
  });

  it("converts wikilinks with alias", () => {
    const result = markdownToSlate("See [[My Page|display text]]");
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
        ],
      },
    ]);
  });

  it("converts empty document to single empty paragraph", () => {
    const result = markdownToSlate("");
    expect(result).toEqual([
      { type: "paragraph", children: [{ text: "" }] },
    ]);
  });

  it("converts nested lists", () => {
    const md = "- Parent\n  - Child";
    const result = markdownToSlate(md);
    expect(result).toEqual([
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [
              { type: "paragraph", children: [{ text: "Parent" }] },
              {
                type: "bulleted-list",
                children: [
                  {
                    type: "list-item",
                    children: [
                      { type: "paragraph", children: [{ text: "Child" }] },
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
```

**Step 2: Run tests to verify they fail**

Run: `cd ui && bun run test -- src/editor/convert/__tests__/mdast-to-slate.test.ts`
Expected: All tests fail (module not found).

**Step 3: Implement mdast-to-slate converter**

Create `ui/src/editor/convert/mdast-to-slate.ts`:
```typescript
import type { Nodes as MdastNode } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import wikiLinkPlugin from "remark-wiki-link";
import { unified } from "unified";
import type { CustomElement, CustomText } from "../types";
import type { Descendant } from "slate";

type Marks = Omit<CustomText, "text">;

/**
 * Parse a markdown string into a Slate Descendant[] tree.
 */
export function mdastToSlate(markdown: string): Descendant[] {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(wikiLinkPlugin, { aliasDivider: "|" });

  const mdast = processor.parse(markdown);
  const transformed = processor.runSync(mdast);

  const result = convertChildren(transformed.children as MdastNode[]);

  // Slate requires at least one child block
  if (result.length === 0) {
    return [{ type: "paragraph", children: [{ text: "" }] }];
  }

  return result;
}

function convertChildren(nodes: MdastNode[]): Descendant[] {
  const result: Descendant[] = [];
  for (const node of nodes) {
    const converted = convertNode(node);
    if (converted !== null) {
      if (Array.isArray(converted)) {
        result.push(...converted);
      } else {
        result.push(converted);
      }
    }
  }
  return result;
}

function convertNode(node: MdastNode): Descendant | Descendant[] | null {
  switch (node.type) {
    case "paragraph":
      return {
        type: "paragraph",
        children: convertInlineChildren(node.children ?? []),
      };

    case "heading":
      return {
        type: "heading",
        level: node.depth as 1 | 2 | 3 | 4 | 5 | 6,
        children: convertInlineChildren(node.children ?? []),
      };

    case "code":
      return {
        type: "code-block",
        ...(node.lang ? { language: node.lang } : {}),
        children: [{ text: node.value ?? "" }],
      } as CustomElement;

    case "blockquote":
      return {
        type: "blockquote",
        children: convertChildren(node.children ?? []),
      };

    case "list": {
      const listType = node.ordered ? "numbered-list" : "bulleted-list";
      return {
        type: listType,
        children: (node.children ?? []).map((child) => convertListItem(child)),
      } as CustomElement;
    }

    case "thematicBreak":
      return {
        type: "thematic-break",
        children: [{ text: "" }],
      };

    default:
      return null;
  }
}

function convertListItem(node: MdastNode): CustomElement {
  const children = convertChildren(
    (node as { children?: MdastNode[] }).children ?? [],
  );
  return {
    type: "list-item",
    children: children.length > 0 ? children : [{ text: "" }],
  } as CustomElement;
}

/**
 * Convert mdast inline/phrasing nodes into Slate inline elements and text leaves.
 */
function convertInlineChildren(
  nodes: MdastNode[],
  marks: Marks = {},
): Descendant[] {
  const result: Descendant[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        result.push({ text: node.value ?? "", ...marks });
        break;

      case "strong":
        result.push(
          ...convertInlineChildren(node.children ?? [], {
            ...marks,
            bold: true,
          }),
        );
        break;

      case "emphasis":
        result.push(
          ...convertInlineChildren(node.children ?? [], {
            ...marks,
            italic: true,
          }),
        );
        break;

      case "inlineCode":
        result.push({ text: node.value ?? "", ...marks, code: true });
        break;

      case "link":
        result.push({
          type: "link",
          url: node.url ?? "",
          children: convertInlineChildren(node.children ?? [], marks),
        } as CustomElement);
        break;

      case "wikiLink": {
        const wikiNode = node as MdastNode & {
          value: string;
          data?: { alias?: string };
        };
        const target = wikiNode.value;
        const alias = wikiNode.data?.alias;
        // alias equals target when no explicit alias was given
        const hasExplicitAlias = alias !== undefined && alias !== target;
        result.push({
          type: "wikilink",
          target,
          ...(hasExplicitAlias ? { alias } : {}),
          children: [{ text: "" }],
        } as CustomElement);
        break;
      }

      default:
        // Unknown inline node — extract text if possible
        if ("value" in node && typeof node.value === "string") {
          result.push({ text: node.value, ...marks });
        } else if ("children" in node && Array.isArray(node.children)) {
          result.push(...convertInlineChildren(node.children, marks));
        }
        break;
    }
  }

  // Slate requires at least one text node in inline containers
  if (result.length === 0) {
    result.push({ text: "", ...marks });
  }

  return result;
}
```

Create `ui/src/editor/convert/index.ts`:
```typescript
export { mdastToSlate as markdownToSlate } from "./mdast-to-slate";
```

**Step 4: Run tests to verify they pass**

Run: `cd ui && bun run test -- src/editor/convert/__tests__/mdast-to-slate.test.ts`
Expected: All tests pass.

Note: Some tests may need adjustment depending on exact mdast output for wikilinks. The `remark-wiki-link` plugin sets `data.alias` to the display name (which equals `value` when no alias is given). The converter checks `alias !== target` to determine if an explicit alias was provided. If tests fail, adjust the alias detection logic accordingly.

**Step 5: Commit**

```bash
git add ui/src/editor/convert/
git commit -m "feat(editor): add markdown-to-slate converter with tests"
```

---

### Task 4: Slate-to-Markdown Converter

**Files:**
- Create: `ui/src/editor/convert/slate-to-mdast.ts`
- Create: `ui/src/editor/convert/__tests__/slate-to-mdast.test.ts`
- Modify: `ui/src/editor/convert/index.ts`

**Step 1: Write the failing tests**

Create `ui/src/editor/convert/__tests__/slate-to-mdast.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { slateToMarkdown } from "../index";

describe("slateToMarkdown", () => {
  it("converts a paragraph", () => {
    const result = slateToMarkdown([
      { type: "paragraph", children: [{ text: "Hello world" }] },
    ]);
    expect(result.trim()).toBe("Hello world");
  });

  it("converts headings", () => {
    const result = slateToMarkdown([
      { type: "heading", level: 1, children: [{ text: "Title" }] },
      { type: "heading", level: 3, children: [{ text: "Subtitle" }] },
    ]);
    expect(result.trim()).toBe("# Title\n\n### Subtitle");
  });

  it("converts bold text", () => {
    const result = slateToMarkdown([
      {
        type: "paragraph",
        children: [
          { text: "Hello " },
          { text: "bold", bold: true },
          { text: " world" },
        ],
      },
    ]);
    expect(result.trim()).toBe("Hello **bold** world");
  });

  it("converts italic text", () => {
    const result = slateToMarkdown([
      {
        type: "paragraph",
        children: [
          { text: "Hello " },
          { text: "italic", italic: true },
          { text: " world" },
        ],
      },
    ]);
    expect(result.trim()).toBe("Hello *italic* world");
  });

  it("converts inline code", () => {
    const result = slateToMarkdown([
      {
        type: "paragraph",
        children: [
          { text: "Use " },
          { text: "foo", code: true },
          { text: " here" },
        ],
      },
    ]);
    expect(result.trim()).toBe("Use `foo` here");
  });

  it("converts code blocks", () => {
    const result = slateToMarkdown([
      {
        type: "code-block",
        language: "rust",
        children: [{ text: "fn main() {}" }],
      },
    ]);
    expect(result.trim()).toBe("```rust\nfn main() {}\n```");
  });

  it("converts blockquotes", () => {
    const result = slateToMarkdown([
      {
        type: "blockquote",
        children: [
          { type: "paragraph", children: [{ text: "A wise quote" }] },
        ],
      },
    ]);
    expect(result.trim()).toBe("> A wise quote");
  });

  it("converts bulleted lists", () => {
    const result = slateToMarkdown([
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [
              { type: "paragraph", children: [{ text: "Item one" }] },
            ],
          },
          {
            type: "list-item",
            children: [
              { type: "paragraph", children: [{ text: "Item two" }] },
            ],
          },
        ],
      },
    ]);
    expect(result.trim()).toBe("* Item one\n\n* Item two");
  });

  it("converts ordered lists", () => {
    const result = slateToMarkdown([
      {
        type: "numbered-list",
        children: [
          {
            type: "list-item",
            children: [
              { type: "paragraph", children: [{ text: "First" }] },
            ],
          },
          {
            type: "list-item",
            children: [
              { type: "paragraph", children: [{ text: "Second" }] },
            ],
          },
        ],
      },
    ]);
    expect(result.trim()).toBe("1. First\n\n2. Second");
  });

  it("converts links", () => {
    const result = slateToMarkdown([
      {
        type: "paragraph",
        children: [
          {
            type: "link",
            url: "https://example.com",
            children: [{ text: "click" }],
          },
        ],
      },
    ]);
    expect(result.trim()).toBe("[click](https://example.com)");
  });

  it("converts thematic breaks", () => {
    const result = slateToMarkdown([
      { type: "paragraph", children: [{ text: "Above" }] },
      { type: "thematic-break", children: [{ text: "" }] },
      { type: "paragraph", children: [{ text: "Below" }] },
    ]);
    expect(result.trim()).toBe("Above\n\n---\n\nBelow");
  });

  it("converts wikilinks without alias", () => {
    const result = slateToMarkdown([
      {
        type: "paragraph",
        children: [
          { text: "See " },
          {
            type: "wikilink",
            target: "My Page",
            children: [{ text: "" }],
          },
        ],
      },
    ]);
    expect(result.trim()).toBe("See [[My Page]]");
  });

  it("converts wikilinks with alias", () => {
    const result = slateToMarkdown([
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
        ],
      },
    ]);
    expect(result.trim()).toBe("See [[My Page|display text]]");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd ui && bun run test -- src/editor/convert/__tests__/slate-to-mdast.test.ts`
Expected: All fail.

**Step 3: Implement slate-to-mdast converter**

Create `ui/src/editor/convert/slate-to-mdast.ts`:
```typescript
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import type {
  BlockContent,
  Code,
  Heading,
  InlineCode,
  Link,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  Strong,
  Emphasis,
  Text,
  ThematicBreak,
  Blockquote,
} from "mdast";
import type { Descendant, Element } from "slate";
import { Text as SlateText } from "slate";
import type { CustomElement, CustomText, WikilinkElement } from "../types";

/**
 * Convert Slate Descendant[] to a markdown string.
 */
export function slateToMdast(nodes: Descendant[]): string {
  const root: Root = {
    type: "root",
    children: nodes.flatMap((node) => convertBlockNode(node)),
  };

  return toMarkdown(root, {
    extensions: [gfmToMarkdown(), wikiLinkToMarkdownExtension()],
    bullet: "*",
    rule: "-",
  });
}

function wikiLinkToMarkdownExtension() {
  return {
    handlers: {
      wikiLink(node: { value: string; data?: { alias?: string } }) {
        const alias = node.data?.alias;
        if (alias && alias !== node.value) {
          return `[[${node.value}|${alias}]]`;
        }
        return `[[${node.value}]]`;
      },
    },
    unsafe: [
      { character: "[", inConstruct: ["phrasing", "label", "reference"] },
      { character: "]", inConstruct: ["label", "reference"] },
    ],
  };
}

function convertBlockNode(node: Descendant): BlockContent[] {
  if (SlateText.isText(node)) {
    // Stray text at block level — wrap in paragraph
    return [{ type: "paragraph", children: [{ type: "text", value: node.text }] }];
  }

  const el = node as CustomElement;

  switch (el.type) {
    case "paragraph":
      return [
        {
          type: "paragraph",
          children: convertInlineNodes(el.children),
        } as Paragraph,
      ];

    case "heading":
      return [
        {
          type: "heading",
          depth: el.level,
          children: convertInlineNodes(el.children),
        } as Heading,
      ];

    case "code-block": {
      const text = el.children.map((c) => (c as CustomText).text).join("");
      return [
        {
          type: "code",
          lang: el.language ?? null,
          value: text,
        } as Code,
      ];
    }

    case "blockquote":
      return [
        {
          type: "blockquote",
          children: el.children.flatMap((c) => convertBlockNode(c)),
        } as Blockquote,
      ];

    case "bulleted-list":
      return [
        {
          type: "list",
          ordered: false,
          spread: false,
          children: el.children.map((c) => convertListItemNode(c)),
        } as List,
      ];

    case "numbered-list":
      return [
        {
          type: "list",
          ordered: true,
          start: 1,
          spread: false,
          children: el.children.map((c) => convertListItemNode(c)),
        } as List,
      ];

    case "thematic-break":
      return [{ type: "thematicBreak" } as ThematicBreak];

    case "list-item":
      // Shouldn't appear at top level, but handle gracefully
      return convertBlockNode({
        type: "bulleted-list",
        children: [el],
      } as CustomElement);

    case "wikilink":
    case "link":
      // Inline-only nodes at block level — wrap in paragraph
      return [
        {
          type: "paragraph",
          children: convertInlineNodes([node]),
        } as Paragraph,
      ];

    default:
      return [];
  }
}

function convertListItemNode(node: Descendant): ListItem {
  if (SlateText.isText(node)) {
    return {
      type: "listItem",
      spread: false,
      children: [
        { type: "paragraph", children: [{ type: "text", value: node.text }] },
      ],
    };
  }

  const el = node as CustomElement;
  return {
    type: "listItem",
    spread: false,
    children: el.children.flatMap((c) => convertBlockNode(c)),
  };
}

function convertInlineNodes(nodes: Descendant[]): PhrasingContent[] {
  const result: PhrasingContent[] = [];

  for (const node of nodes) {
    if (SlateText.isText(node)) {
      result.push(convertTextNode(node as CustomText));
      continue;
    }

    const el = node as CustomElement;

    switch (el.type) {
      case "link":
        result.push({
          type: "link",
          url: el.url,
          children: convertInlineNodes(el.children),
        } as Link);
        break;

      case "wikilink": {
        const wikiEl = el as WikilinkElement;
        const alias =
          wikiEl.alias && wikiEl.alias !== wikiEl.target
            ? wikiEl.alias
            : undefined;
        result.push({
          type: "wikiLink" as "text",
          value: wikiEl.target,
          data: { alias: alias ?? wikiEl.target },
        } as unknown as PhrasingContent);
        break;
      }

      default:
        // Unknown inline element — try to extract text
        if ("children" in el) {
          result.push(...convertInlineNodes(el.children));
        }
        break;
    }
  }

  if (result.length === 0) {
    result.push({ type: "text", value: "" });
  }

  return result;
}

/**
 * Convert a Slate text leaf with marks into nested mdast phrasing nodes.
 * Order: bold wraps italic wraps code wraps text.
 */
function convertTextNode(node: CustomText): PhrasingContent {
  if (node.code) {
    const codeNode: InlineCode = { type: "inlineCode", value: node.text };
    return wrapWithMarks(codeNode, node);
  }

  let result: PhrasingContent = { type: "text", value: node.text } as Text;
  result = wrapWithMarks(result, node);
  return result;
}

function wrapWithMarks(
  inner: PhrasingContent,
  marks: CustomText,
): PhrasingContent {
  let result = inner;

  if (marks.italic) {
    result = { type: "emphasis", children: [result] } as Emphasis;
  }

  if (marks.bold) {
    result = { type: "strong", children: [result] } as Strong;
  }

  return result;
}
```

**Step 4: Update index.ts to export slateToMarkdown**

Update `ui/src/editor/convert/index.ts`:
```typescript
export { mdastToSlate as markdownToSlate } from "./mdast-to-slate";
export { slateToMdast as slateToMarkdown } from "./slate-to-mdast";
```

**Step 5: Run tests to verify they pass**

Run: `cd ui && bun run test -- src/editor/convert/__tests__/slate-to-mdast.test.ts`
Expected: All tests pass.

Note: List bullet character and spacing may need tuning. The serializer uses `bullet: "*"` and `rule: "-"`. If `mdast-util-to-markdown` outputs different spacing (e.g., tight vs loose lists), adjust test expectations to match actual output. The exact markdown formatting (trailing newlines, list spacing) is less important than semantic correctness.

**Step 6: Commit**

```bash
git add ui/src/editor/convert/
git commit -m "feat(editor): add slate-to-markdown converter with tests"
```

---

### Task 5: Round-Trip Fidelity Tests

**Files:**
- Create: `ui/src/editor/convert/__tests__/round-trip.test.ts`

**Step 1: Write round-trip tests**

Create `ui/src/editor/convert/__tests__/round-trip.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "../index";

/**
 * Round-trip test: markdown → slate → markdown.
 * We normalize whitespace for comparison since exact formatting
 * may differ (trailing newlines, list spacing).
 */
function normalize(md: string): string {
  return md.trim().replace(/\n{3,}/g, "\n\n");
}

function roundTrip(input: string): string {
  const slate = markdownToSlate(input);
  return slateToMarkdown(slate);
}

describe("round-trip: markdown → slate → markdown", () => {
  it("preserves a simple paragraph", () => {
    expect(normalize(roundTrip("Hello world"))).toBe("Hello world");
  });

  it("preserves headings", () => {
    const input = "# Title\n\n## Subtitle";
    expect(normalize(roundTrip(input))).toBe(input);
  });

  it("preserves inline formatting", () => {
    const input = "Hello **bold** and *italic* and `code` text";
    expect(normalize(roundTrip(input))).toBe(input);
  });

  it("preserves code blocks with language", () => {
    const input = "```rust\nfn main() {}\n```";
    expect(normalize(roundTrip(input))).toBe(input);
  });

  it("preserves blockquotes", () => {
    const input = "> A wise quote";
    expect(normalize(roundTrip(input))).toBe(input);
  });

  it("preserves links", () => {
    const input = "[click](https://example.com)";
    expect(normalize(roundTrip(input))).toBe(input);
  });

  it("preserves thematic breaks", () => {
    const input = "Above\n\n---\n\nBelow";
    expect(normalize(roundTrip(input))).toBe(input);
  });

  it("preserves wikilinks", () => {
    const input = "See [[My Page]]";
    expect(normalize(roundTrip(input))).toBe(input);
  });

  it("preserves wikilinks with alias", () => {
    const input = "See [[My Page|display text]]";
    expect(normalize(roundTrip(input))).toBe(input);
  });

  it("preserves a complex document", () => {
    const input = [
      "# Document Title",
      "",
      "A paragraph with **bold**, *italic*, and `code`.",
      "",
      "> A blockquote",
      "",
      "* Item one",
      "* Item two",
      "",
      "See [[Other Page]] and [a link](https://example.com).",
      "",
      "---",
      "",
      "```typescript",
      "const x = 1;",
      "```",
    ].join("\n");

    const result = normalize(roundTrip(input));
    // Verify key elements survive round-trip
    expect(result).toContain("# Document Title");
    expect(result).toContain("**bold**");
    expect(result).toContain("*italic*");
    expect(result).toContain("`code`");
    expect(result).toContain("> A blockquote");
    expect(result).toContain("[[Other Page]]");
    expect(result).toContain("[a link](https://example.com)");
    expect(result).toContain("---");
    expect(result).toContain("```typescript");
  });
});
```

**Step 2: Run tests**

Run: `cd ui && bun run test -- src/editor/convert/__tests__/round-trip.test.ts`
Expected: All pass. If some formatting differs (e.g., list bullet `*` vs `-`), adjust the normalize function or expectations. The complex document test uses `toContain` for resilience against whitespace differences.

**Step 3: Delete the setup test**

Remove `ui/src/editor/convert/__tests__/setup.test.ts` — it was a scaffolding test.

**Step 4: Commit**

```bash
git add ui/src/editor/convert/__tests__/
git commit -m "test(editor): add round-trip fidelity tests for markdown conversion"
```

---

### Task 6: Slate Plugins

**Files:**
- Create: `ui/src/editor/plugins/withWikilinks.ts`
- Create: `ui/src/editor/plugins/withLinks.ts`

These plugins configure Slate's inline/void behavior and will be composed into the editor instance.

**Step 1: Create withWikilinks plugin**

Create `ui/src/editor/plugins/withWikilinks.ts`:
```typescript
import { type Editor, Element as SlateElement } from "slate";

/**
 * Plugin that marks wikilink elements as inline and void.
 * The [[ trigger detection is handled at the component level
 * (in SlateEditor's onKeyDown / onChange), not here.
 */
export function withWikilinks(editor: Editor): Editor {
  const { isInline, isVoid } = editor;

  editor.isInline = (element) => {
    return SlateElement.isElement(element) && element.type === "wikilink"
      ? true
      : isInline(element);
  };

  editor.isVoid = (element) => {
    return SlateElement.isElement(element) && element.type === "wikilink"
      ? true
      : isVoid(element);
  };

  return editor;
}
```

**Step 2: Create withLinks plugin**

Create `ui/src/editor/plugins/withLinks.ts`:
```typescript
import { type Editor, Element as SlateElement } from "slate";

/**
 * Plugin that marks link elements as inline (not void — links have editable text children).
 */
export function withLinks(editor: Editor): Editor {
  const { isInline } = editor;

  editor.isInline = (element) => {
    return SlateElement.isElement(element) && element.type === "link"
      ? true
      : isInline(element);
  };

  return editor;
}
```

**Step 3: Verify typecheck passes**

Run: `cd ui && bun run typecheck`
Expected: No errors.

**Step 4: Commit**

```bash
git add ui/src/editor/plugins/
git commit -m "feat(editor): add withWikilinks and withLinks slate plugins"
```

---

### Task 7: Element and Leaf Renderers

**Files:**
- Create: `ui/src/editor/elements/renderElement.tsx`
- Create: `ui/src/editor/elements/renderLeaf.tsx`
- Create: `ui/src/editor/elements/WikilinkElement.tsx`
- Create: `ui/src/editor/elements/CodeBlockElement.tsx`

These apply the brutalist visual language from `MarkdownRenderer.tsx` to Slate's rendered output.

**Step 1: Create WikilinkElement**

Create `ui/src/editor/elements/WikilinkElement.tsx`:
```typescript
import type { RenderElementProps } from "slate-react";
import type { WikilinkElement as WikilinkElementType } from "../types";
import { useOpenTab } from "#/hooks/useOpenTab";

type Props = RenderElementProps & { element: WikilinkElementType };

export function WikilinkElement({ attributes, children, element }: Props) {
  const openTab = useOpenTab();
  const displayText = element.alias ?? element.target;

  return (
    <span {...attributes}>
      <span
        contentEditable={false}
        className="inline cursor-pointer border border-border bg-muted px-1.5 text-sm hover:bg-accent"
        onClick={(e) => {
          e.preventDefault();
          openTab("page", element.target);
        }}
      >
        {displayText}
      </span>
      {children}
    </span>
  );
}
```

**Step 2: Create CodeBlockElement**

Create `ui/src/editor/elements/CodeBlockElement.tsx`:
```typescript
import type { RenderElementProps } from "slate-react";
import type { CodeBlockElement as CodeBlockElementType } from "../types";

type Props = RenderElementProps & { element: CodeBlockElementType };

export function CodeBlockElement({ attributes, children, element }: Props) {
  return (
    <div {...attributes}>
      <pre className="overflow-x-auto border border-border bg-muted p-4 text-sm">
        {element.language && (
          <span
            contentEditable={false}
            className="mb-2 block text-xs text-muted-foreground select-none"
          >
            {element.language}
          </span>
        )}
        <code>{children}</code>
      </pre>
    </div>
  );
}
```

**Step 3: Create renderElement**

Create `ui/src/editor/elements/renderElement.tsx`:
```typescript
import type { RenderElementProps } from "slate-react";
import { CodeBlockElement } from "./CodeBlockElement";
import { WikilinkElement } from "./WikilinkElement";

export function renderElement(props: RenderElementProps) {
  const { attributes, children, element } = props;

  switch (element.type) {
    case "heading": {
      const Tag = `h${element.level}` as const;
      const sizeClasses: Record<number, string> = {
        1: "mb-4 mt-8 text-2xl font-bold",
        2: "mb-3 mt-6 text-xl font-bold",
        3: "mb-2 mt-4 text-lg font-bold",
        4: "mb-2 mt-4 text-base font-bold",
        5: "mb-1 mt-3 text-sm font-bold",
        6: "mb-1 mt-3 text-xs font-bold",
      };
      return (
        <Tag {...attributes} className={sizeClasses[element.level]}>
          {children}
        </Tag>
      );
    }

    case "code-block":
      return <CodeBlockElement {...props} element={element} />;

    case "blockquote":
      return (
        <blockquote
          {...attributes}
          className="border-l-4 border-border pl-4 italic text-muted-foreground"
        >
          {children}
        </blockquote>
      );

    case "bulleted-list":
      return (
        <ul {...attributes} className="list-disc pl-6">
          {children}
        </ul>
      );

    case "numbered-list":
      return (
        <ol {...attributes} className="list-decimal pl-6">
          {children}
        </ol>
      );

    case "list-item":
      return <li {...attributes}>{children}</li>;

    case "thematic-break":
      return (
        <div {...attributes} contentEditable={false}>
          <hr className="my-6 border-border" />
          {children}
        </div>
      );

    case "wikilink":
      return <WikilinkElement {...props} element={element} />;

    case "link":
      return (
        <a
          {...attributes}
          href={element.url}
          className="underline decoration-1 underline-offset-2 hover:decoration-2"
          onClick={(e) => {
            // Prevent navigation while editing — only navigate on ctrl/cmd+click
            if (!e.metaKey && !e.ctrlKey) {
              e.preventDefault();
            }
          }}
        >
          {children}
        </a>
      );

    case "paragraph":
    default:
      return <p {...attributes}>{children}</p>;
  }
}
```

**Step 4: Create renderLeaf**

Create `ui/src/editor/elements/renderLeaf.tsx`:
```typescript
import type { RenderLeafProps } from "slate-react";

export function renderLeaf({ attributes, children, leaf }: RenderLeafProps) {
  if (leaf.code) {
    children = (
      <code className="bg-muted px-1 py-0.5 text-sm">{children}</code>
    );
  }
  if (leaf.bold) {
    children = <strong>{children}</strong>;
  }
  if (leaf.italic) {
    children = <em>{children}</em>;
  }
  return <span {...attributes}>{children}</span>;
}
```

**Step 5: Verify typecheck passes**

Run: `cd ui && bun run typecheck`
Expected: No errors.

**Step 6: Commit**

```bash
git add ui/src/editor/elements/
git commit -m "feat(editor): add slate element and leaf renderers"
```

---

### Task 8: useUpdatePage Mutation Hook

**Files:**
- Modify: `ui/src/api/pages.ts`

**Step 1: Add useUpdatePage**

Add to the end of `ui/src/api/pages.ts`:
```typescript
export function useUpdatePage() {
  const qc = useQueryClient();
  return $api.useMutation("put", "/api/vault/pages/{path}", {
    onSuccess: () => {
      invalidateByPathPrefix(qc, "/api/vault/pages");
      invalidateByPathPrefix(qc, "/api/vault/index");
    },
  });
}
```

**Step 2: Verify typecheck passes**

Run: `cd ui && bun run typecheck`
Expected: No errors. The OpenAPI schema already has `update_page` operation with `put` method on `/api/vault/pages/{path}`.

**Step 3: Commit**

```bash
git add ui/src/api/pages.ts
git commit -m "feat(api): add useUpdatePage mutation hook"
```

---

### Task 9: SaveIndicator Component

**Files:**
- Create: `ui/src/editor/SaveIndicator.tsx`

**Step 1: Create SaveIndicator**

Create `ui/src/editor/SaveIndicator.tsx`:
```typescript
import type { SaveStatus } from "./usePageEditor";

interface SaveIndicatorProps {
  status: SaveStatus;
  error?: string | null;
}

export function SaveIndicator({ status, error }: SaveIndicatorProps) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {status === "saved" && (
        <span className="text-muted-foreground">Saved</span>
      )}
      {status === "saving" && (
        <span className="text-muted-foreground animate-pulse">Saving...</span>
      )}
      {status === "unsaved" && (
        <span className="text-foreground">Unsaved changes</span>
      )}
      {status === "error" && (
        <span className="text-destructive" title={error ?? undefined}>
          Save failed
        </span>
      )}
    </div>
  );
}
```

Note: The `SaveStatus` type will be exported from `usePageEditor.ts` in Task 11. This file will have a temporary type error until then. That's acceptable — the tasks will be committed together or the type can be defined inline temporarily.

**Step 2: Commit**

```bash
git add ui/src/editor/SaveIndicator.tsx
git commit -m "feat(editor): add save status indicator component"
```

---

### Task 10: PageEditorHeader Component

**Files:**
- Create: `ui/src/editor/PageEditorHeader.tsx`

This replaces the read-only `PageHeader` with editable fields for title, tags, and aliases.

**Step 1: Create PageEditorHeader**

Create `ui/src/editor/PageEditorHeader.tsx`:
```typescript
import { useCallback, useState, type KeyboardEvent } from "react";

interface PageEditorHeaderProps {
  path: string;
  title: string;
  onTitleChange: (title: string) => void;
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  aliases: string[];
  onAliasesChange: (aliases: string[]) => void;
}

export function PageEditorHeader({
  path,
  title,
  onTitleChange,
  tags,
  onTagsChange,
  aliases,
  onAliasesChange,
}: PageEditorHeaderProps) {
  return (
    <div className="border-b border-border pb-4">
      {/* Title */}
      <input
        type="text"
        value={title}
        onChange={(e) => onTitleChange(e.target.value)}
        placeholder="Untitled"
        className="w-full bg-transparent text-2xl font-bold outline-none placeholder:text-muted-foreground"
      />

      {/* Path (read-only) */}
      <p className="mt-1 text-sm text-muted-foreground">{path}</p>

      {/* Tags */}
      <ChipInput
        label="Tags"
        values={tags}
        onChange={onTagsChange}
        placeholder="Add tag..."
      />

      {/* Aliases */}
      {(aliases.length > 0 || tags.length > 0) && (
        <ChipInput
          label="Aliases"
          values={aliases}
          onChange={onAliasesChange}
          placeholder="Add alias..."
        />
      )}
    </div>
  );
}

// --- ChipInput sub-component ---

interface ChipInputProps {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
}

function ChipInput({ label, values, onChange, placeholder }: ChipInputProps) {
  const [inputValue, setInputValue] = useState("");

  const addValue = useCallback(
    (val: string) => {
      const trimmed = val.trim();
      if (trimmed && !values.includes(trimmed)) {
        onChange([...values, trimmed]);
      }
      setInputValue("");
    },
    [values, onChange],
  );

  const removeValue = useCallback(
    (index: number) => {
      onChange(values.filter((_, i) => i !== index));
    },
    [values, onChange],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        addValue(inputValue);
      } else if (
        e.key === "Backspace" &&
        inputValue === "" &&
        values.length > 0
      ) {
        removeValue(values.length - 1);
      }
    },
    [inputValue, values, addValue, removeValue],
  );

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      <span className="text-xs text-muted-foreground">{label}:</span>
      {values.map((value, index) => (
        <span
          key={value}
          className="flex items-center gap-1 border border-border bg-muted px-2 py-0.5 text-xs"
        >
          {value}
          <button
            type="button"
            onClick={() => removeValue(index)}
            className="text-muted-foreground hover:text-foreground"
          >
            &times;
          </button>
        </span>
      ))}
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (inputValue.trim()) addValue(inputValue);
        }}
        placeholder={values.length === 0 ? placeholder : ""}
        className="min-w-[80px] flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
```

**Step 2: Verify typecheck passes**

Run: `cd ui && bun run typecheck`
Expected: No errors.

**Step 3: Commit**

```bash
git add ui/src/editor/PageEditorHeader.tsx
git commit -m "feat(editor): add editable page header with title, tags, aliases"
```

---

### Task 11: usePageEditor Hook

**Files:**
- Create: `ui/src/editor/usePageEditor.ts`

This is the central orchestrator: loads page data, initializes Slate value, tracks dirty state, debounces autosave.

**Step 1: Create usePageEditor**

Create `ui/src/editor/usePageEditor.ts`:
```typescript
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Descendant } from "slate";
import { usePage, useUpdatePage } from "#/api/pages";
import { markdownToSlate, slateToMarkdown } from "./convert";

export type SaveStatus = "saved" | "saving" | "unsaved" | "error";

const DEBOUNCE_MS = 1500;

interface PageEditorState {
  // Data loading
  isLoading: boolean;
  error: unknown;

  // Slate state
  initialValue: Descendant[];

  // Metadata state
  title: string;
  setTitle: (t: string) => void;
  tags: string[];
  setTags: (t: string[]) => void;
  aliases: string[];
  setAliases: (a: string[]) => void;

  // Save state
  saveStatus: SaveStatus;
  saveError: string | null;

  // Callbacks
  onSlateChange: (value: Descendant[]) => void;
  saveNow: () => void;
}

export function usePageEditor(path: string): PageEditorState {
  const { data: page, isLoading, error } = usePage(path);
  const updatePage = useUpdatePage();

  // Current editor content (updated on every Slate change)
  const editorValueRef = useRef<Descendant[]>([]);

  // Metadata state
  const [title, setTitleState] = useState("");
  const [tags, setTagsState] = useState<string[]>([]);
  const [aliases, setAliasesState] = useState<string[]>([]);

  // Last-saved values for dirty comparison
  const savedRef = useRef({ title: "", tags: [] as string[], aliases: [] as string[], body: "" });

  // Save state
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Debounce timer
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial value — computed once when page data arrives
  const initialValue = useMemo(() => {
    if (!page) return [{ type: "paragraph" as const, children: [{ text: "" }] }];
    return markdownToSlate(page.body ?? "");
  }, [page]);

  // Sync metadata from loaded page data
  useEffect(() => {
    if (!page) return;
    const t = page.meta.title ?? "";
    const tg = page.meta.tags ?? [];
    const al = page.meta.aliases ?? [];
    setTitleState(t);
    setTagsState(tg);
    setAliasesState(al);
    savedRef.current = { title: t, tags: tg, aliases: al, body: page.body ?? "" };
    editorValueRef.current = initialValue;
    setSaveStatus("saved");
  }, [page, initialValue]);

  // --- Save logic ---

  const doSave = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const body = slateToMarkdown(editorValueRef.current);
    const currentTitle = title;
    const currentTags = tags;
    const currentAliases = aliases;

    // Check if anything actually changed
    const bodyChanged = body !== savedRef.current.body;
    const titleChanged = currentTitle !== savedRef.current.title;
    const tagsChanged =
      JSON.stringify(currentTags) !== JSON.stringify(savedRef.current.tags);
    const aliasesChanged =
      JSON.stringify(currentAliases) !== JSON.stringify(savedRef.current.aliases);

    if (!bodyChanged && !titleChanged && !tagsChanged && !aliasesChanged) {
      setSaveStatus("saved");
      return;
    }

    setSaveStatus("saving");

    updatePage.mutate(
      {
        params: { path: { path } },
        body: {
          ...(titleChanged ? { title: currentTitle || null } : {}),
          ...(tagsChanged ? { tags: currentTags } : {}),
          ...(aliasesChanged ? { aliases: currentAliases } : {}),
          ...(bodyChanged ? { body } : {}),
        },
      },
      {
        onSuccess: () => {
          savedRef.current = {
            title: currentTitle,
            tags: currentTags,
            aliases: currentAliases,
            body,
          };
          setSaveStatus("saved");
          setSaveError(null);
        },
        onError: (err) => {
          setSaveStatus("error");
          setSaveError(err instanceof Error ? err.message : "Save failed");
        },
      },
    );
  }, [path, title, tags, aliases, updatePage]);

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setSaveStatus("unsaved");
    timerRef.current = setTimeout(doSave, DEBOUNCE_MS);
  }, [doSave]);

  // --- Change handlers ---

  const onSlateChange = useCallback(
    (value: Descendant[]) => {
      editorValueRef.current = value;
      // The Slate onChange fires on selection changes too.
      // We always schedule a save check — the doSave function
      // will skip if nothing actually changed.
      scheduleSave();
    },
    [scheduleSave],
  );

  const setTitle = useCallback(
    (t: string) => {
      setTitleState(t);
      scheduleSave();
    },
    [scheduleSave],
  );

  const setTags = useCallback(
    (t: string[]) => {
      setTagsState(t);
      scheduleSave();
    },
    [scheduleSave],
  );

  const setAliases = useCallback(
    (a: string[]) => {
      setAliasesState(a);
      scheduleSave();
    },
    [scheduleSave],
  );

  // --- Flush on visibility change (tab blur, browser close) ---

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden" && timerRef.current) {
        doSave();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [doSave]);

  return {
    isLoading,
    error,
    initialValue,
    title,
    setTitle,
    tags,
    setTags,
    aliases,
    setAliases,
    saveStatus,
    saveError,
    onSlateChange,
    saveNow: doSave,
  };
}
```

**Step 2: Verify typecheck passes**

Run: `cd ui && bun run typecheck`
Expected: No errors.

**Step 3: Commit**

```bash
git add ui/src/editor/usePageEditor.ts
git commit -m "feat(editor): add usePageEditor hook with debounced autosave"
```

---

### Task 12: SlateEditor Component

**Files:**
- Create: `ui/src/editor/SlateEditor.tsx`

**Step 1: Create SlateEditor**

Create `ui/src/editor/SlateEditor.tsx`:
```typescript
import { useCallback, useMemo } from "react";
import { type Descendant, createEditor } from "slate";
import { Editable, Slate, withReact } from "slate-react";
import { withHistory } from "slate-history";
import { renderElement } from "./elements/renderElement";
import { renderLeaf } from "./elements/renderLeaf";
import { withWikilinks } from "./plugins/withWikilinks";
import { withLinks } from "./plugins/withLinks";
// Import types to ensure module augmentation is loaded
import "./types";

interface SlateEditorProps {
  initialValue: Descendant[];
  onChange: (value: Descendant[]) => void;
  onSaveNow: () => void;
}

export function SlateEditor({
  initialValue,
  onChange,
  onSaveNow,
}: SlateEditorProps) {
  const editor = useMemo(
    () => withReact(withHistory(withLinks(withWikilinks(createEditor())))),
    [],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Cmd+S / Ctrl+S — immediate save
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        onSaveNow();
        return;
      }

      // Mark shortcuts
      if (event.metaKey || event.ctrlKey) {
        switch (event.key) {
          case "b": {
            event.preventDefault();
            const { Editor } = await import("slate");
            const marks = Editor.marks(editor);
            if (marks?.bold) {
              Editor.removeMark(editor, "bold");
            } else {
              Editor.addMark(editor, "bold", true);
            }
            return;
          }
          case "i": {
            event.preventDefault();
            const { Editor } = await import("slate");
            const marks = Editor.marks(editor);
            if (marks?.italic) {
              Editor.removeMark(editor, "italic");
            } else {
              Editor.addMark(editor, "italic", true);
            }
            return;
          }
          case "e": {
            event.preventDefault();
            const { Editor } = await import("slate");
            const marks = Editor.marks(editor);
            if (marks?.code) {
              Editor.removeMark(editor, "code");
            } else {
              Editor.addMark(editor, "code", true);
            }
            return;
          }
        }
      }
    },
    [editor, onSaveNow],
  );

  const memoRenderElement = useCallback(renderElement, []);
  const memoRenderLeaf = useCallback(renderLeaf, []);

  return (
    <Slate editor={editor} initialValue={initialValue} onChange={onChange}>
      <Editable
        renderElement={memoRenderElement}
        renderLeaf={memoRenderLeaf}
        onKeyDown={handleKeyDown}
        placeholder="Start writing..."
        className="min-h-[200px] outline-none"
        spellCheck
      />
    </Slate>
  );
}
```

**Important fix:** The `handleKeyDown` above uses dynamic `await import("slate")` inside the callback, which won't work in a non-async callback. Instead, import `Editor` at the top of the file and use it directly:

Replace the dynamic imports with a static import at the top:
```typescript
import { type Descendant, createEditor, Editor } from "slate";
```

And remove the `await import(...)` calls, using `Editor` directly:
```typescript
case "b": {
  event.preventDefault();
  const marks = Editor.marks(editor);
  if (marks?.bold) {
    Editor.removeMark(editor, "bold");
  } else {
    Editor.addMark(editor, "bold", true);
  }
  return;
}
```

(Same pattern for `i` and `e` cases.)

**Step 2: Verify typecheck passes**

Run: `cd ui && bun run typecheck`
Expected: No errors.

**Step 3: Commit**

```bash
git add ui/src/editor/SlateEditor.tsx
git commit -m "feat(editor): add SlateEditor component with keyboard shortcuts"
```

---

### Task 13: WikilinkCombobox

**Files:**
- Create: `ui/src/editor/WikilinkCombobox.tsx`
- Modify: `ui/src/editor/SlateEditor.tsx` — add `[[` trigger detection and combobox integration

This is the most complex UI component. It involves:
- Detecting `[[` in editor input
- Showing a floating popup positioned at the cursor
- Filtering the page list
- Inserting a wikilink void node on selection

**Step 1: Create WikilinkCombobox**

Create `ui/src/editor/WikilinkCombobox.tsx`:
```typescript
import { useCallback, useEffect, useRef, useState } from "react";
import type { PageSummary } from "#/api/types";

interface WikilinkComboboxProps {
  pages: PageSummary[];
  query: string;
  position: { top: number; left: number };
  onSelect: (page: PageSummary) => void;
  onClose: () => void;
}

export function WikilinkCombobox({
  pages,
  query,
  position,
  onSelect,
  onClose,
}: WikilinkComboboxProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const lowerQuery = query.toLowerCase();
  const filtered = pages
    .filter(
      (p) =>
        (p.title?.toLowerCase().includes(lowerQuery) ?? false) ||
        p.canonical_name.toLowerCase().includes(lowerQuery) ||
        p.path.toLowerCase().includes(lowerQuery),
    )
    .slice(0, 8);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (filtered[selectedIndex]) {
            onSelect(filtered[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filtered, selectedIndex, onSelect, onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);

  if (filtered.length === 0) {
    return (
      <div
        ref={containerRef}
        className="fixed z-50 border border-border bg-popover p-2 text-xs text-muted-foreground shadow-md"
        style={{ top: position.top, left: position.left }}
      >
        No pages found
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="fixed z-50 max-h-64 overflow-y-auto border border-border bg-popover shadow-md"
      style={{ top: position.top, left: position.left }}
    >
      {filtered.map((page, index) => (
        <div
          key={page.id}
          className={`cursor-pointer px-3 py-1.5 text-sm ${
            index === selectedIndex
              ? "bg-accent text-accent-foreground"
              : "text-popover-foreground hover:bg-accent/50"
          }`}
          onMouseDown={(e) => {
            e.preventDefault(); // prevent blur
            onSelect(page);
          }}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          <div className="font-medium">{page.title ?? page.canonical_name}</div>
          <div className="text-xs text-muted-foreground">{page.path}</div>
        </div>
      ))}
    </div>
  );
}
```

**Step 2: Add `[[` trigger detection to SlateEditor**

Modify `ui/src/editor/SlateEditor.tsx` to add wikilink trigger state and combobox rendering. The key changes:

1. Track `wikilinkState: { anchor: Point; query: string } | null` in component state
2. In `onKeyDown`, detect `]` after `]` to close/complete
3. In `onChange`, detect `[[` by looking at the text before cursor
4. Render `WikilinkCombobox` when `wikilinkState !== null`

This is a significant modification to `SlateEditor.tsx`. The full updated file:

```typescript
import { useCallback, useMemo, useRef, useState } from "react";
import {
  type Descendant,
  type BasePoint,
  createEditor,
  Editor,
  Range,
  Transforms,
} from "slate";
import {
  Editable,
  ReactEditor,
  Slate,
  withReact,
} from "slate-react";
import { withHistory } from "slate-history";
import { usePages } from "#/api/pages";
import type { PageSummary } from "#/api/types";
import { renderElement } from "./elements/renderElement";
import { renderLeaf } from "./elements/renderLeaf";
import { withWikilinks } from "./plugins/withWikilinks";
import { withLinks } from "./plugins/withLinks";
import { WikilinkCombobox } from "./WikilinkCombobox";
import type { WikilinkElement } from "./types";
import "./types";

interface SlateEditorProps {
  initialValue: Descendant[];
  onChange: (value: Descendant[]) => void;
  onSaveNow: () => void;
}

interface WikilinkTrigger {
  anchor: BasePoint;
  query: string;
}

export function SlateEditor({
  initialValue,
  onChange,
  onSaveNow,
}: SlateEditorProps) {
  const editor = useMemo(
    () => withReact(withHistory(withLinks(withWikilinks(createEditor())))),
    [],
  );

  const { data: pagesData } = usePages();
  const pages: PageSummary[] = pagesData?.items ?? [];

  const [wikilinkTrigger, setWikilinkTrigger] = useState<WikilinkTrigger | null>(null);
  const [comboboxPosition, setComboboxPosition] = useState({ top: 0, left: 0 });

  const updateComboboxPosition = useCallback(() => {
    const { selection } = editor;
    if (!selection || !Range.isCollapsed(selection)) return;
    try {
      const domRange = ReactEditor.toDOMRange(editor, selection);
      const rect = domRange.getBoundingClientRect();
      setComboboxPosition({
        top: rect.bottom + 4,
        left: rect.left,
      });
    } catch {
      // DOM range may not exist during initialization
    }
  }, [editor]);

  const handleChange = useCallback(
    (value: Descendant[]) => {
      onChange(value);

      const { selection } = editor;
      if (!selection || !Range.isCollapsed(selection)) {
        setWikilinkTrigger(null);
        return;
      }

      // Look for [[ trigger before cursor
      const [node] = Editor.node(editor, selection.anchor.path);
      if (!("text" in node)) {
        setWikilinkTrigger(null);
        return;
      }

      const textBefore = (node.text as string).slice(0, selection.anchor.offset);
      const triggerIndex = textBefore.lastIndexOf("[[");

      if (triggerIndex === -1) {
        setWikilinkTrigger(null);
        return;
      }

      // Check no ]] between [[ and cursor (would mean a completed wikilink)
      const afterTrigger = textBefore.slice(triggerIndex + 2);
      if (afterTrigger.includes("]]")) {
        setWikilinkTrigger(null);
        return;
      }

      const query = afterTrigger;
      const anchor: BasePoint = {
        path: selection.anchor.path,
        offset: triggerIndex,
      };

      setWikilinkTrigger({ anchor, query });
      updateComboboxPosition();
    },
    [editor, onChange, updateComboboxPosition],
  );

  const insertWikilink = useCallback(
    (page: PageSummary) => {
      if (!wikilinkTrigger) return;

      const { selection } = editor;
      if (!selection) return;

      // Delete the [[query text
      const deleteRange = {
        anchor: wikilinkTrigger.anchor,
        focus: selection.focus,
      };

      Transforms.select(editor, deleteRange);
      Transforms.delete(editor);

      // Insert wikilink void node
      const wikilinkNode: WikilinkElement = {
        type: "wikilink",
        target: page.title ?? page.canonical_name,
        children: [{ text: "" }],
      };

      Transforms.insertNodes(editor, wikilinkNode);
      Transforms.move(editor); // move cursor past the void

      setWikilinkTrigger(null);
    },
    [editor, wikilinkTrigger],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // If combobox is open, let it handle navigation keys
      if (wikilinkTrigger) {
        if (["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) {
          // These are handled by WikilinkCombobox's document keydown listener
          return;
        }
      }

      // Cmd+S / Ctrl+S — immediate save
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        onSaveNow();
        return;
      }

      // Mark shortcuts
      if (event.metaKey || event.ctrlKey) {
        switch (event.key) {
          case "b": {
            event.preventDefault();
            const marks = Editor.marks(editor);
            if (marks?.bold) {
              Editor.removeMark(editor, "bold");
            } else {
              Editor.addMark(editor, "bold", true);
            }
            return;
          }
          case "i": {
            event.preventDefault();
            const marks = Editor.marks(editor);
            if (marks?.italic) {
              Editor.removeMark(editor, "italic");
            } else {
              Editor.addMark(editor, "italic", true);
            }
            return;
          }
          case "e": {
            event.preventDefault();
            const marks = Editor.marks(editor);
            if (marks?.code) {
              Editor.removeMark(editor, "code");
            } else {
              Editor.addMark(editor, "code", true);
            }
            return;
          }
        }
      }
    },
    [editor, onSaveNow, wikilinkTrigger],
  );

  const memoRenderElement = useCallback(renderElement, []);
  const memoRenderLeaf = useCallback(renderLeaf, []);

  return (
    <div className="relative">
      <Slate editor={editor} initialValue={initialValue} onChange={handleChange}>
        <Editable
          renderElement={memoRenderElement}
          renderLeaf={memoRenderLeaf}
          onKeyDown={handleKeyDown}
          placeholder="Start writing..."
          className="min-h-[200px] outline-none"
          spellCheck
        />
      </Slate>

      {wikilinkTrigger && (
        <WikilinkCombobox
          pages={pages}
          query={wikilinkTrigger.query}
          position={comboboxPosition}
          onSelect={insertWikilink}
          onClose={() => setWikilinkTrigger(null)}
        />
      )}
    </div>
  );
}
```

**Step 3: Verify typecheck passes**

Run: `cd ui && bun run typecheck`
Expected: No errors.

**Step 4: Commit**

```bash
git add ui/src/editor/SlateEditor.tsx ui/src/editor/WikilinkCombobox.tsx
git commit -m "feat(editor): add wikilink autocomplete with [[ trigger"
```

---

### Task 14: Integration — Replace PageTabContent

**Files:**
- Modify: `ui/src/components/PageTabContent.tsx`

**Step 1: Rewrite PageTabContent to use the editor**

Replace the contents of `ui/src/components/PageTabContent.tsx`:

```typescript
import { useEffect } from "react";
import { useBacklinks } from "#/api/index";
import { BacklinksPanel } from "#/components/BacklinksPanel";
import { PageEditorHeader } from "#/editor/PageEditorHeader";
import { SaveIndicator } from "#/editor/SaveIndicator";
import { SlateEditor } from "#/editor/SlateEditor";
import { usePageEditor } from "#/editor/usePageEditor";
import { useWorkspaceStore } from "#/store/workspace";

interface PageTabContentProps {
  tabId: string;
  path: string;
}

export function PageTabContent({ tabId, path }: PageTabContentProps) {
  const editor = usePageEditor(path);
  const { data: backlinks } = useBacklinks(path);
  const updateTabLabel = useWorkspaceStore((s) => s.updateTabLabel);

  useEffect(() => {
    if (editor.title) {
      updateTabLabel(tabId, editor.title);
    }
  }, [tabId, editor.title, updateTabLabel]);

  if (editor.isLoading) {
    return <div className="p-8 text-muted-foreground">Loading...</div>;
  }
  if (editor.error) {
    return <div className="p-8 text-destructive">Page not found</div>;
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-6">
      <div className="mb-2 flex items-center justify-end">
        <SaveIndicator status={editor.saveStatus} error={editor.saveError} />
      </div>

      <PageEditorHeader
        path={path}
        title={editor.title}
        onTitleChange={editor.setTitle}
        tags={editor.tags}
        onTagsChange={editor.setTags}
        aliases={editor.aliases}
        onAliasesChange={editor.setAliases}
      />

      <article className="mt-6">
        <SlateEditor
          initialValue={editor.initialValue}
          onChange={editor.onSlateChange}
          onSaveNow={editor.saveNow}
        />
      </article>

      {backlinks && backlinks.length > 0 && (
        <BacklinksPanel backlinks={backlinks} />
      )}
    </div>
  );
}
```

**Step 2: Verify typecheck passes**

Run: `cd ui && bun run typecheck`
Expected: No errors.

**Step 3: Verify the dev server starts**

Run: `cd ui && bun run dev`
Expected: Vite dev server starts without errors. Navigate to a page tab — it should show the Slate editor instead of the read-only markdown view.

**Step 4: Smoke test in browser**

1. Open a page with existing content → should render in Slate with correct formatting
2. Type text → should appear in the editor
3. Wait 1.5s → SaveIndicator should show "Saving..." then "Saved"
4. Press Cmd+S → should save immediately
5. Type `[[` → should show autocomplete popup
6. Bold (Cmd+B), italic (Cmd+I), code (Cmd+E) shortcuts should work
7. Edit title → should trigger autosave
8. Add/remove tags → should trigger autosave

**Step 5: Run all tests**

Run: `cd ui && bun run test`
Expected: All converter tests pass.

**Step 6: Run format and lint**

Run: `cd ui && bun run format`
Expected: No errors.

**Step 7: Commit**

```bash
git add ui/src/components/PageTabContent.tsx
git commit -m "feat(editor): integrate slate editor into page tabs

Replaces read-only MarkdownRenderer with always-edit SlateEditor.
Includes debounced autosave, keyboard shortcuts, and wikilink autocomplete."
```

---

### Post-Implementation Notes

**What was intentionally deferred:**
- **Markdown shortcuts** (typing `# ` to create heading, `- ` to create list) — nice UX but not required for v1
- **Source toggle** (view raw markdown) — can be added later
- **Conflict detection** (external file changes via SSE) — the SSE broadcast exists but no UI for it yet
- **Images/attachments** — attachment upload endpoint isn't implemented yet
- **Table editing** — complex Slate table handling deferred
- **Slash command menu** — future enhancement for block insertion

**Files created:**
```
ui/src/editor/
  types.ts
  usePageEditor.ts
  SlateEditor.tsx
  SaveIndicator.tsx
  PageEditorHeader.tsx
  WikilinkCombobox.tsx
  elements/
    renderElement.tsx
    renderLeaf.tsx
    WikilinkElement.tsx
    CodeBlockElement.tsx
  plugins/
    withWikilinks.ts
    withLinks.ts
  convert/
    index.ts
    mdast-to-slate.ts
    slate-to-mdast.ts
    __tests__/
      mdast-to-slate.test.ts
      slate-to-mdast.test.ts
      round-trip.test.ts
```

**Files modified:**
```
ui/package.json          — new dependencies
ui/vitest.config.ts      — new file (test config)
ui/src/api/pages.ts      — added useUpdatePage()
ui/src/components/PageTabContent.tsx — rewritten to use editor
```
