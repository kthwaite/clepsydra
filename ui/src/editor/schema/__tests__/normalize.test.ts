import { createEditor, Editor } from "slate";
import { describe, expect, it } from "vitest";
import { withSchema } from "../withSchema";

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
