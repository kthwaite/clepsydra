import { createEditor, type Descendant, Editor } from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { handleJournalTimeHeadingDeletion } from "../journalTime";

const TIME = {
  type: "journal-time",
  time: "09:07",
  children: [{ text: "" }],
};
const paragraph = (text: string) =>
  ({
    type: "paragraph",
    children: [{ text }],
  }) as Descendant;

function makeEditor(children: Descendant[], path: number[], offset: number) {
  const editor = createEditor();
  editor.children = children;
  editor.selection = {
    anchor: { path, offset },
    focus: { path, offset },
  };
  return editor;
}

describe("atomic journal-time keyboard deletion", () => {
  it("Backspace selects an adjacent heading first and removes it second", () => {
    const editor = makeEditor(
      [TIME, paragraph("after")] as Descendant[],
      [1, 0],
      0,
    );

    expect(handleJournalTimeHeadingDeletion(editor, "backward")).toBe(true);
    expect(editor.children).toHaveLength(2);
    expect(editor.selection?.anchor.path).toEqual([0, 0]);

    expect(handleJournalTimeHeadingDeletion(editor, "backward")).toBe(true);
    expect(editor.children).toEqual([paragraph("after")]);
  });

  it("Delete selects an adjacent heading first and removes it second", () => {
    const editor = makeEditor(
      [paragraph("before"), TIME] as Descendant[],
      [0, 0],
      "before".length,
    );

    expect(handleJournalTimeHeadingDeletion(editor, "forward")).toBe(true);
    expect(editor.children).toHaveLength(2);
    expect(editor.selection?.anchor.path).toEqual([1, 0]);

    expect(handleJournalTimeHeadingDeletion(editor, "forward")).toBe(true);
    expect(editor.children).toEqual([paragraph("before")]);
  });

  it("restores a removed heading with undo and leaves a valid caret", () => {
    const editor = withHistory(
      makeEditor([TIME, paragraph("after")] as Descendant[], [1, 0], 0),
    );

    handleJournalTimeHeadingDeletion(editor, "backward");
    handleJournalTimeHeadingDeletion(editor, "backward");
    expect(editor.children).toEqual([paragraph("after")]);
    expect(editor.selection).not.toBeNull();
    expect(Editor.hasPath(editor, editor.selection?.anchor.path ?? [])).toBe(
      true,
    );

    HistoryEditor.undo(editor);
    expect(editor.children).toEqual([TIME, paragraph("after")]);
  });

  it("does not intercept deletion when no journal-time heading is adjacent", () => {
    const editor = makeEditor([paragraph("abc")], [0, 0], 1);
    expect(handleJournalTimeHeadingDeletion(editor, "backward")).toBe(false);
    expect(handleJournalTimeHeadingDeletion(editor, "forward")).toBe(false);
    expect(editor.children).toEqual([paragraph("abc")]);
  });
});
