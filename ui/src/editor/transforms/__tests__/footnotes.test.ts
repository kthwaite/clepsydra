import { createEditor, type Descendant } from "slate";
import { describe, expect, it } from "vitest";
import { makeFootnoteDef } from "#/editor/schema/elements/footnoteDef";
import { withSchema } from "#/editor/schema/withSchema";
import { ensureFootnoteDef } from "#/editor/transforms/footnotes";

function editorWith(children: Descendant[]) {
  const editor = withSchema(createEditor());
  editor.children = children;
  return editor;
}

const para = { type: "paragraph", children: [{ text: "x" }] } as Descendant;

describe("ensureFootnoteDef", () => {
  it("appends an empty def at the end when none matches", () => {
    const editor = editorWith([para, makeFootnoteDef({ identifier: "a" })]);

    expect(ensureFootnoteDef(editor, "b")).toBe(true);

    expect(editor.children).toHaveLength(3);
    expect(editor.children.at(-1)).toEqual(
      makeFootnoteDef({ identifier: "b" }),
    );
  });

  it("leaves the document alone when a def exists", () => {
    const editor = editorWith([para, makeFootnoteDef({ identifier: "a" })]);

    expect(ensureFootnoteDef(editor, "a")).toBe(false);

    expect(editor.children).toHaveLength(2);
  });
});
