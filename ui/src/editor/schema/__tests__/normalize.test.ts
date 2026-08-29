import { createEditor, Editor } from "slate";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import { withSchema } from "../withSchema";

describe("code-block purity invariant", () => {
  it("strips marks from code-block text children", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      {
        type: "code-block",
        children: [
          {
            text: "x",
            bold: true,
            italic: true,
            underline: true,
            code: true,
            strikethrough: true,
            superscript: true,
            subscript: true,
            color: "#ff0000",
            backgroundColor: "#00ff00",
          },
        ],
      },
    ] as never;
    Editor.normalize(editor, { force: true });
    const cb = editor.children[0] as unknown as {
      children: Record<string, unknown>[];
    };
    expect(cb.children[0]).toEqual({ text: "x" });
  });

  it("unwraps an inline element inside a code-block to plain text", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      {
        type: "code-block",
        children: [{ type: "wikilink", target: "X", children: [{ text: "" }] }],
      },
    ] as never;
    Editor.normalize(editor, { force: true });
    const cb = editor.children[0] as { children: { type?: string }[] };
    expect(cb.children.every((c) => c.type === undefined)).toBe(true);
  });
});

describe("void-inline integrity invariant", () => {
  it("drops a wikilink with an empty target, leaving surrounding text", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      {
        type: "paragraph",
        children: [
          { text: "a" },
          { type: "wikilink", target: "", children: [{ text: "" }] },
          { text: "b" },
        ],
      },
    ] as never;
    Editor.normalize(editor, { force: true });
    const para = editor.children[0] as { children: { type?: string }[] };
    expect(para.children.some((c) => c.type === "wikilink")).toBe(false);
  });

  it("drops a block-ref with an empty blockId", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      {
        type: "paragraph",
        children: [
          { text: "" },
          { type: "block-ref", blockId: "", children: [{ text: "" }] },
          { text: "" },
        ],
      },
    ] as never;
    Editor.normalize(editor, { force: true });
    const para = editor.children[0] as { children: { type?: string }[] };
    expect(para.children.some((c) => c.type === "block-ref")).toBe(false);
  });

  it("drops a wikilink with no target property at all", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      {
        type: "paragraph",
        children: [
          { text: "a" },
          { type: "wikilink", children: [{ text: "" }] },
          { text: "b" },
        ],
      },
    ] as never;
    Editor.normalize(editor, { force: true });
    const para = editor.children[0] as { children: { type?: string }[] };
    expect(para.children.some((c) => c.type === "wikilink")).toBe(false);
  });

  it("keeps a wikilink with a non-empty target", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      {
        type: "paragraph",
        children: [
          { text: "a" },
          { type: "wikilink", target: "Page", children: [{ text: "" }] },
          { text: "b" },
        ],
      },
    ] as never;
    Editor.normalize(editor, { force: true });
    const para = editor.children[0] as { children: { type?: string }[] };
    expect(para.children.some((c) => c.type === "wikilink")).toBe(true);
  });
});

describe("list structure invariant", () => {
  it("wraps a stray paragraph child of a list into a list-item", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      {
        type: "bulleted-list",
        children: [{ type: "paragraph", children: [{ text: "x" }] }],
      },
    ] as never;
    Editor.normalize(editor, { force: true });
    const list = editor.children[0] as { children: { type: string }[] };
    expect(list.children.every((c) => c.type === "list-item")).toBe(true);
  });

  it("wraps a stray paragraph child of a numbered-list into a list-item", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      {
        type: "numbered-list",
        children: [{ type: "paragraph", children: [{ text: "x" }] }],
      },
    ] as never;
    Editor.normalize(editor, { force: true });
    const list = editor.children[0] as { children: { type: string }[] };
    expect(list.children.every((c) => c.type === "list-item")).toBe(true);
  });
});

function normalizePersistedMath(
  node: Record<string, unknown>,
): Record<string, unknown> {
  const editor = withSchema(createEditor());
  if (node.type === "math-block") {
    editor.children = [node] as never;
  } else {
    editor.children = [
      {
        type: "paragraph",
        children: [{ text: "before" }, node, { text: "after" }],
      },
    ] as never;
  }

  Editor.normalize(editor, { force: true });

  if (node.type === "math-block") {
    return editor.children[0] as unknown as Record<string, unknown>;
  }
  const paragraph = editor.children[0] as unknown as {
    children: Record<string, unknown>[];
  };
  const math = paragraph.children.find((child) => child.type === "inline-math");
  if (!math) throw new Error("Expected inline math to survive normalization");
  return math;
}

describe("math integrity invariant", () => {
  it("repairs missing TeX without dropping persisted inline math", () => {
    const math = normalizePersistedMath({
      type: "inline-math",
      delimiter: "$",
      children: [{ text: "" }],
    });

    expect(math).toMatchObject({
      type: "inline-math",
      tex: "",
      delimiter: "$",
      children: [{ text: "" }],
    });
  });

  it("preserves unknown persisted TeX as editable source", () => {
    const math = normalizePersistedMath({
      type: "inline-math",
      tex: 42,
      delimiter: "$",
      children: [{ text: "" }],
    });

    expect(math.tex).toBe("42");
  });

  it.each([
    ["inline-math", "$$", "$"],
    ["inline-math", "unknown", "$"],
    ["math-block", "$", "$$"],
    ["math-block", "unknown", "$$"],
  ])("repairs %s delimiter %s to %s", (type, delimiter, expected) => {
    const math = normalizePersistedMath({
      type,
      tex: "x",
      delimiter,
      children: [{ text: "" }],
    });

    expect(math.delimiter).toBe(expected);
  });

  it.each(["inline-math", "math-block"])(
    "restores one empty text child for %s",
    (type) => {
      const math = normalizePersistedMath({
        type,
        tex: "x",
        delimiter: type === "inline-math" ? "$" : "$$",
        children: [{ text: "stale", bold: true }, { text: "extra" }],
      });

      expect(math.children).toEqual([{ text: "" }]);
    },
  );
});

const RECOVERY_BLOCK = "```base\n```\n";
const RECOVERY_NODE = {
  type: "base-embed",
  status: "invalid",
  rawBlock: RECOVERY_BLOCK,
  parseError: "Invalid persisted base-embed node",
  children: [{ text: "" }],
};

function normalizePersistedBase(
  node: Record<string, unknown>,
): Record<string, unknown> {
  const editor = withSchema(createEditor());
  editor.children = [node] as never;
  Editor.normalize(editor, { force: true });
  return editor.children[0] as unknown as Record<string, unknown>;
}

describe("Base embed integrity invariant", () => {
  it.each([
    {
      type: "base-embed",
      status: "unconfigured",
      children: [{ text: "" }],
    },
    {
      type: "base-embed",
      status: "configured",
      base: "books",
      view: "Reading",
      filter: {
        all: [
          { field: "rating", op: "gte", value: 4 },
          { field: "archived", op: "is_empty" },
        ],
      },
      sort: [],
      limit: 200,
      children: [{ text: "" }],
    },
    {
      type: "base-embed",
      status: "configured",
      base: "books",
      view: "Reading",
      display: "full",
      width: 1100,
      children: [{ text: "" }],
    },
    {
      type: "base-embed",
      status: "invalid",
      rawBlock: "````base\r\nunknown = true\r\n````",
      parseError: "Unknown key",
      children: [{ text: "" }],
    },
  ])("retains the complete valid $status state", (node) => {
    expect(normalizePersistedBase(structuredClone(node))).toEqual(node);
  });

  it.each([
    {
      type: "base-embed",
      status: "unconfigured",
      children: [{ text: "stale", bold: true }, { text: "extra" }],
    },
    {
      type: "base-embed",
      status: "configured",
      base: "books",
      view: "Reading",
      children: [],
    },
    {
      type: "base-embed",
      status: "invalid",
      rawBlock: RECOVERY_BLOCK,
      parseError: "empty body",
      children: [{ type: "paragraph", children: [{ text: "nested" }] }],
    },
  ])("repairs $status to exactly one empty text child", (node) => {
    expect(normalizePersistedBase(node).children).toEqual([{ text: "" }]);
  });

  it.each([
    [
      "unknown status",
      {
        type: "base-embed",
        status: "future",
        children: [{ text: "" }],
      },
    ],
    [
      "configured missing base",
      {
        type: "base-embed",
        status: "configured",
        view: "v",
        children: [{ text: "" }],
      },
    ],
    [
      "configured blank view",
      {
        type: "base-embed",
        status: "configured",
        base: "b",
        view: " ",
        children: [{ text: "" }],
      },
    ],
    [
      "configured malformed filter",
      {
        type: "base-embed",
        status: "configured",
        base: "b",
        view: "v",
        filter: { field: "f", op: "eq" },
        children: [{ text: "" }],
      },
    ],
    [
      "configured malformed sort",
      {
        type: "base-embed",
        status: "configured",
        base: "b",
        view: "v",
        sort: [{ field: "f", dir: "up" }],
        children: [{ text: "" }],
      },
    ],
    [
      "configured malformed limit",
      {
        type: "base-embed",
        status: "configured",
        base: "b",
        view: "v",
        limit: 201,
        children: [{ text: "" }],
      },
    ],
    [
      "unconfigured with stale configured properties",
      {
        type: "base-embed",
        status: "unconfigured",
        base: "b",
        view: "v",
        children: [{ text: "" }],
      },
    ],
    [
      "configured with stale invalid properties",
      {
        type: "base-embed",
        status: "configured",
        base: "b",
        view: "v",
        rawBlock: RECOVERY_BLOCK,
        parseError: "stale",
        children: [{ text: "" }],
      },
    ],
    [
      "invalid with stale configured properties",
      {
        type: "base-embed",
        status: "invalid",
        rawBlock: RECOVERY_BLOCK,
        parseError: "bad",
        base: "b",
        children: [{ text: "" }],
      },
    ],
    [
      "invalid with malformed source",
      {
        type: "base-embed",
        status: "invalid",
        rawBlock: 42,
        parseError: "bad",
        children: [{ text: "" }],
      },
    ],
    [
      "recognized status with an unknown property",
      {
        type: "base-embed",
        status: "unconfigured",
        future: true,
        children: [{ text: "" }],
      },
    ],
  ])("replaces %s with the exact invalid recovery node", (_name, node) => {
    expect(normalizePersistedBase(node as Record<string, unknown>)).toEqual(
      RECOVERY_NODE,
    );
  });

  it("normalizes malformed configured state, serializes a real fence, and reloads one invalid node", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      {
        type: "base-embed",
        status: "configured",
        base: "books",
        children: [{ text: "" }],
      },
    ] as never;
    Editor.normalize(editor, { force: true });

    const markdown = slateToMarkdown(editor.children);
    expect(markdown.startsWith(RECOVERY_BLOCK)).toBe(true);
    const reloaded = markdownToSlate(markdown);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({
      type: "base-embed",
      status: "invalid",
      rawBlock: RECOVERY_BLOCK,
      children: [{ text: "" }],
    });
  });
});

describe("table structure invariant", () => {
  function tableEditor(children: unknown) {
    const editor = withSchema(createEditor());
    editor.children = children as never;
    Editor.normalize(editor, { force: true });
    return editor;
  }

  it("wraps a stray child of a table in a row and a cell", () => {
    const editor = tableEditor([
      {
        type: "table",
        children: [{ type: "paragraph", children: [{ text: "loose" }] }],
      },
    ]);
    const table = editor.children[0] as unknown as {
      type: string;
      children: { type: string; children: { type: string }[] }[];
    };
    expect(table.type).toBe("table");
    expect(table.children[0].type).toBe("table-row");
    expect(table.children[0].children[0].type).toBe("table-cell");
  });

  it("gives an empty row a cell", () => {
    const editor = tableEditor([
      { type: "table", children: [{ type: "table-row", children: [] }] },
    ]);
    const row = (
      editor.children[0] as unknown as { children: { children: unknown[] }[] }
    ).children[0];
    expect(row.children).toHaveLength(1);
  });

  it("marks only the leading row's cells as headers", () => {
    const editor = tableEditor([
      {
        type: "table",
        children: [
          {
            type: "table-row",
            children: [
              { type: "table-cell", header: true, children: [{ text: "h" }] },
            ],
          },
          {
            type: "table-row",
            children: [
              { type: "table-cell", header: true, children: [{ text: "b" }] },
            ],
          },
        ],
      },
    ]);
    const rows = (
      editor.children[0] as unknown as {
        children: { children: { header?: boolean }[] }[];
      }
    ).children;
    expect(rows[0].children[0].header).toBe(true);
    expect(rows[1].children[0].header).toBeUndefined();
  });

  it("mirrors the table's column alignment onto every cell", () => {
    const editor = tableEditor([
      {
        type: "table",
        align: ["right", null],
        children: [
          {
            type: "table-row",
            children: [
              { type: "table-cell", children: [{ text: "a" }] },
              {
                type: "table-cell",
                align: "center",
                children: [{ text: "b" }],
              },
            ],
          },
        ],
      },
    ]);
    const cells = (
      editor.children[0] as unknown as {
        children: { children: { align?: string }[] }[];
      }
    ).children[0].children;
    expect(cells[0].align).toBe("right");
    expect(cells[1].align).toBeUndefined();
  });

  it("flattens block content pasted into a cell to its inline children", () => {
    const editor = tableEditor([
      {
        type: "table",
        children: [
          {
            type: "table-row",
            children: [
              {
                type: "table-cell",
                children: [
                  { type: "paragraph", children: [{ text: "pasted" }] },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const cell = (
      editor.children[0] as unknown as {
        children: { children: { children: { text?: string }[] }[] }[];
      }
    ).children[0].children[0];
    expect(cell.children).toEqual([{ text: "pasted" }]);
  });

  it("keeps inline elements inside a cell", () => {
    const editor = tableEditor([
      {
        type: "table",
        children: [
          {
            type: "table-row",
            children: [
              {
                type: "table-cell",
                children: [
                  { text: "" },
                  {
                    type: "wikilink",
                    target: "Page",
                    children: [{ text: "" }],
                  },
                  { text: "" },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const json = JSON.stringify(editor.children[0]);
    expect(json).toContain('"type":"wikilink"');
  });

  it("removes a table left with no rows", () => {
    const editor = tableEditor([
      { type: "paragraph", children: [{ text: "keep" }] },
      { type: "table", children: [] },
    ]);
    const types = editor.children.map((n) => (n as { type?: string }).type);
    expect(types).not.toContain("table");
  });
});
