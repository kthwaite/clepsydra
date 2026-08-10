import { createEditor, Editor, Node } from "slate";
import { describe, expect, it } from "vitest";
import { withSchema } from "../withSchema";

describe("footnote document rules", () => {
  it("renames a duplicate footnote-def identifier to keep ids unique", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      { type: "footnote-def", identifier: "1", children: [{ text: "a" }] },
      { type: "footnote-def", identifier: "1", children: [{ text: "b" }] },
    ] as never;
    Editor.normalize(editor, { force: true });
    const ids = editor.children.map(
      (n) => (n as { identifier: string }).identifier,
    );
    expect(new Set(ids).size).toBe(2);
  });

  it("leaves already-unique footnote-def identifiers untouched", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      { type: "footnote-def", identifier: "1", children: [{ text: "a" }] },
      { type: "footnote-def", identifier: "2", children: [{ text: "b" }] },
    ] as never;
    Editor.normalize(editor, { force: true });
    const ids = editor.children.map(
      (n) => (n as { identifier: string }).identifier,
    );
    expect(ids).toEqual(["1", "2"]);
  });
});

describe("trailing paragraph after a code block", () => {
  it("appends an empty paragraph when the last block is a code-block", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      { type: "code-block", children: [{ text: "x" }] },
    ] as never;
    Editor.normalize(editor, { force: true });
    expect(editor.children.length).toBe(2);
    const last = editor.children[1] as { type: string };
    expect(last.type).toBe("paragraph");
    expect(Node.string(editor.children[1])).toBe("");
  });

  it("does not append when a block already follows the code-block", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      { type: "code-block", children: [{ text: "x" }] },
      { type: "paragraph", children: [{ text: "" }] },
    ] as never;
    Editor.normalize(editor, { force: true });
    expect(editor.children.length).toBe(2);
  });

  it("appends an empty paragraph when the last block is a journal-time heading", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      { type: "journal-time", time: "09:07", children: [{ text: "" }] },
    ];
    Editor.normalize(editor, { force: true });
    expect(editor.children).toHaveLength(2);
    expect(editor.children[1]).toEqual({
      type: "paragraph",
      children: [{ text: "" }],
    });
  });

  it("does not append for a document ending in a paragraph", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      { type: "paragraph", children: [{ text: "hello" }] },
    ] as never;
    Editor.normalize(editor, { force: true });
    expect(editor.children.length).toBe(1);
  });

  it("appends an empty paragraph when the last block is a Base embed", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      {
        type: "base-embed",
        status: "configured",
        base: "books",
        view: "Reading",
        children: [{ text: "" }],
      },
    ] as never;

    Editor.normalize(editor, { force: true });

    expect(editor.children).toHaveLength(2);
    expect(editor.children[1]).toEqual({
      type: "paragraph",
      children: [{ text: "" }],
    });
  });
});
