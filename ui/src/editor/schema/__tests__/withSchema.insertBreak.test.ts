import { createEditor, type Descendant, type Path, Transforms } from "slate";
import { describe, expect, it } from "vitest";
import { makeJournalTime } from "#/editor/schema/elements/journalTime";
import { makeParagraph } from "#/editor/schema/elements/paragraph";
import { makeThematicBreak } from "#/editor/schema/elements/thematicBreak";
import { withSchema } from "../withSchema";

// Import types so module augmentation is active
import "#/editor/types";

/** The document is NOT normalised, so the fixture shape is exactly what is set. */
function makeEditor(children: Descendant[], path: Path, offset = 0) {
  const editor = withSchema(createEditor());
  editor.children = children;
  Transforms.select(editor, { path, offset });
  return editor;
}

const EMPTY = makeParagraph({});
const HELLO = makeParagraph({ children: [{ text: "hello" }] });

describe("withSchema insertBreak on a selected void block", () => {
  it("starts a paragraph below a time heading instead of splitting it", () => {
    const time = makeJournalTime({ time: "09:05" });
    const editor = makeEditor([time, HELLO], [0, 0]);

    editor.insertBreak();

    expect(editor.children).toEqual([time, EMPTY, HELLO]);
    expect(
      editor.children.filter((n) => "type" in n && n.type === "journal-time"),
    ).toHaveLength(1);
    expect(editor.selection?.anchor).toEqual({ path: [1, 0], offset: 0 });
    expect(editor.selection?.focus).toEqual({ path: [1, 0], offset: 0 });
  });

  it("starts a paragraph below a terminal thematic break", () => {
    const editor = makeEditor([HELLO, makeThematicBreak({})], [1, 0]);

    editor.insertBreak();

    expect(editor.children).toEqual([HELLO, makeThematicBreak({}), EMPTY]);
    expect(editor.selection?.anchor).toEqual({ path: [2, 0], offset: 0 });
  });

  it("still splits a paragraph at the caret", () => {
    const editor = makeEditor([HELLO], [0, 0], 2);

    editor.insertBreak();

    expect(editor.children).toEqual([
      makeParagraph({ children: [{ text: "he" }] }),
      makeParagraph({ children: [{ text: "llo" }] }),
    ]);
    expect(editor.selection?.anchor).toEqual({ path: [1, 0], offset: 0 });
  });
});
