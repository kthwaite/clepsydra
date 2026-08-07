import { createEditor, type Descendant, Editor } from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { applyBlockConversion } from "../blockConversions";
import { formatJournalTime, insertJournalTimeHeading } from "../journalTime";

function makeEditor(children: Descendant[], path: number[], offset = 0) {
  const editor = withHistory(createEditor());
  editor.children = children;
  editor.selection = {
    anchor: { path, offset },
    focus: { path, offset },
  };
  return editor;
}

const NOW = new Date(2026, 7, 7, 9, 5);
const TIME = {
  type: "journal-time",
  time: "09:05",
  children: [{ text: "" }],
};
const EMPTY = {
  type: "paragraph",
  children: [{ text: "" }],
} as Descendant;

describe("formatJournalTime", () => {
  it("uses zero-padded browser-local hours and minutes", () => {
    expect(formatJournalTime(NOW)).toBe("09:05");
  });
});

describe("insertJournalTimeHeading", () => {
  it("replaces an empty paragraph and focuses a fresh paragraph below", () => {
    const editor = makeEditor([EMPTY], [0, 0]);

    insertJournalTimeHeading(editor, NOW);

    expect(editor.children).toEqual([TIME, EMPTY]);
    expect(editor.selection?.anchor).toEqual({ path: [1, 0], offset: 0 });
    expect(editor.selection?.focus).toEqual({ path: [1, 0], offset: 0 });
  });

  it("inserts after a non-empty containing block without changing its content", () => {
    const paragraph = {
      type: "paragraph",
      children: [{ text: "keep this" }],
    } as Descendant;
    const editor = makeEditor([paragraph], [0, 0], 4);

    insertJournalTimeHeading(editor, NOW);

    expect(editor.children).toEqual([paragraph, TIME, EMPTY]);
    expect(editor.selection?.anchor.path).toEqual([2, 0]);
  });

  it("inserts after the containing top-level block from a nested selection", () => {
    const list = {
      type: "bulleted-list",
      children: [
        {
          type: "list-item",
          children: [{ type: "paragraph", children: [{ text: "nested" }] }],
        },
      ],
    };
    const after = { type: "paragraph", children: [{ text: "after" }] };
    const editor = makeEditor([list, after] as Descendant[], [0, 0, 0, 0], 3);

    insertJournalTimeHeading(editor, NOW);

    expect(editor.children).toEqual([list, TIME, EMPTY, after]);
    expect(editor.selection?.anchor.path).toEqual([2, 0]);
  });

  it("freezes the formatted time passed at insertion", () => {
    const editor = makeEditor([EMPTY], [0, 0]);
    insertJournalTimeHeading(editor, new Date(2026, 7, 7, 23, 59));
    expect(editor.children[0]).toMatchObject({
      type: "journal-time",
      time: "23:59",
    });
  });

  it("batches the heading, trailing paragraph, and selection as one undo", () => {
    const original = {
      type: "paragraph",
      children: [{ text: "keep this" }],
    } as Descendant;
    const editor = makeEditor([original], [0, 0], 4);

    insertJournalTimeHeading(editor, NOW);
    expect(editor.children).toHaveLength(3);
    HistoryEditor.undo(editor);

    expect(editor.children).toEqual([original]);
    expect(Editor.string(editor, [])).toBe("keep this");
  });
});

describe("time-heading slash conversion", () => {
  it("replaces the slash query and restores it with one undo", () => {
    const original = {
      type: "paragraph",
      children: [{ text: "/time" }],
    } as Descendant;
    const editor = makeEditor([original], [0, 0], 5);

    applyBlockConversion(editor, {
      at: [0],
      deleteRange: {
        anchor: { path: [0, 0], offset: 0 },
        focus: { path: [0, 0], offset: 5 },
      },
      conversion: { type: "journal-time" },
    });

    expect(editor.children[0]).toMatchObject({ type: "journal-time" });
    expect(editor.children[1]).toEqual(EMPTY);
    expect(editor.selection?.anchor).toEqual({ path: [1, 0], offset: 0 });

    HistoryEditor.undo(editor);
    expect(editor.children).toEqual([original]);
    expect(Editor.string(editor, [])).toBe("/time");
  });
});
