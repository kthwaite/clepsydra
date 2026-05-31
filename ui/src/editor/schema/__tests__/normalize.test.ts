import { createEditor, Editor } from "slate";
import { describe, expect, it } from "vitest";
import { withSchema } from "../withSchema";

describe("code-block purity invariant", () => {
  it("strips marks from code-block text children", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      { type: "code-block", children: [{ text: "x", bold: true }] },
    ] as never;
    Editor.normalize(editor, { force: true });
    const cb = editor.children[0] as unknown as {
      children: Record<string, unknown>[];
    };
    expect(cb.children[0].bold).toBeUndefined();
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
