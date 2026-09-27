import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { withBlockVoidDeletion } from "#/editor/plugins/withBlockVoidDeletion";
import { makeBaseEmbed } from "#/editor/schema/elements/baseEmbed";
import { withSchema } from "#/editor/schema/withSchema";

function makeEditor(children: Descendant[]) {
  const editor = withHistory(withBlockVoidDeletion(withSchema(createEditor())));
  editor.children = children;
  return editor;
}

const heading = (text: string) =>
  ({ type: "heading", level: 1, children: [{ text }] }) as Descendant;
const paragraph = (text: string) =>
  ({ type: "paragraph", children: [{ text }] }) as Descendant;
const embed = () => makeBaseEmbed() as unknown as Descendant;
const rule = () =>
  ({ type: "thematic-break", children: [{ text: "" }] }) as Descendant;

const types = (editor: Editor) =>
  editor.children.map((node) => (node as { type: string }).type);

describe("withBlockVoidDeletion", () => {
  it("Delete in an empty block before a base embed removes the empty block, not the embed", () => {
    const editor = makeEditor([heading(""), embed(), paragraph("after")]);
    Transforms.select(editor, Editor.start(editor, [0]));

    editor.deleteForward("character");

    expect(types(editor)).toEqual(["base-embed", "paragraph"]);
    expect(editor.selection?.anchor.path.slice(0, 1)).toEqual([0]);
  });

  it("Backspace in an empty block after a block void removes the empty block, not the void", () => {
    const editor = makeEditor([paragraph("before"), rule(), paragraph("")]);
    Transforms.select(editor, Editor.start(editor, [2]));

    editor.deleteBackward("character");

    expect(types(editor)).toEqual(["paragraph", "thematic-break"]);
    expect(editor.selection?.anchor.path.slice(0, 1)).toEqual([1]);
  });

  it("leaves Delete in a non-empty block to the default behaviour", () => {
    const editor = makeEditor([paragraph("ab"), rule()]);
    Transforms.select(editor, Editor.start(editor, [0]));

    editor.deleteForward("character");

    expect(Editor.string(editor, [0])).toBe("b");
    expect(types(editor)).toEqual(["paragraph", "thematic-break"]);
  });

  it("leaves Delete in an empty block before an ordinary block to the default behaviour", () => {
    const editor = makeEditor([paragraph(""), paragraph("next")]);
    Transforms.select(editor, Editor.start(editor, [0]));

    editor.deleteForward("character");

    expect(editor.children).toHaveLength(1);
    expect(Editor.string(editor, [0])).toBe("next");
  });

  it("is one undo step", () => {
    const editor = makeEditor([heading(""), embed(), paragraph("after")]);
    Transforms.select(editor, Editor.start(editor, [0]));

    editor.deleteForward("character");
    editor.undo();

    expect(types(editor)).toEqual(["heading", "base-embed", "paragraph"]);
  });
});
