import {
  Editor,
  Point,
  Range,
  Element as SlateElement,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";

const TRAILING_PUNCTUATION = /^[,.;:!?]$/;

type TerminalInlineCodeInsertState = "awaiting-first" | { nextPoint: Point };

const TERMINAL_INLINE_CODE_INSERT_STATE = new WeakMap<
  Editor,
  TerminalInlineCodeInsertState
>();

export function exitTerminalInlineCode(editor: Editor): boolean {
  const { selection } = editor;
  if (
    !selection ||
    !Range.isCollapsed(selection) ||
    Editor.marks(editor)?.code !== true
  ) {
    return false;
  }

  const [leaf] = Editor.leaf(editor, selection.anchor);
  if (leaf.code !== true || selection.anchor.offset !== leaf.text.length) {
    return false;
  }

  const block = Editor.above(editor, {
    at: selection.anchor,
    match: (node) =>
      SlateElement.isElement(node) && Editor.isBlock(editor, node),
  });
  if (
    !block ||
    (SlateElement.isElement(block[0]) && block[0].type === "code-block") ||
    !Editor.isEnd(editor, selection.anchor, block[1])
  ) {
    return false;
  }

  Editor.removeMark(editor, "code");
  TERMINAL_INLINE_CODE_INSERT_STATE.set(editor, "awaiting-first");
  return true;
}

export function withInlinePunctuationBoundary(editor: Editor): Editor {
  const { insertText } = editor;

  const insertTextWithExitHistory = (text: string) => {
    // The first unmarked character creates a text node. If the caret stays
    // there, merge only the next character into that batch; Slate merges later
    // adjacent inserts itself.
    const state = TERMINAL_INLINE_CODE_INSERT_STATE.get(editor);
    if (state === "awaiting-first") {
      insertText(text);
      const { selection } = editor;
      if (selection && Range.isCollapsed(selection)) {
        TERMINAL_INLINE_CODE_INSERT_STATE.set(editor, {
          nextPoint: selection.anchor,
        });
      } else {
        TERMINAL_INLINE_CODE_INSERT_STATE.delete(editor);
      }
      return;
    }
    if (state) {
      TERMINAL_INLINE_CODE_INSERT_STATE.delete(editor);
      const { selection } = editor;
      if (
        HistoryEditor.isHistoryEditor(editor) &&
        selection &&
        Range.isCollapsed(selection) &&
        Point.equals(selection.anchor, state.nextPoint)
      ) {
        HistoryEditor.withMerging(editor, () => insertText(text));
      } else {
        insertText(text);
      }
      return;
    }
    insertText(text);
  };

  editor.insertText = (text) => {
    const { selection } = editor;
    if (
      !TRAILING_PUNCTUATION.test(text) ||
      !selection ||
      !Range.isCollapsed(selection)
    ) {
      insertTextWithExitHistory(text);
      return;
    }

    const inline = Editor.above(editor, {
      at: selection.anchor,
      match: (node) =>
        SlateElement.isElement(node) &&
        editor.isInline(node) &&
        !editor.isVoid(node),
    });

    let shouldClearMarks = false;
    if (inline && Editor.isEnd(editor, selection.anchor, inline[1])) {
      const after = Editor.after(editor, inline[1]);
      if (after) {
        Transforms.select(editor, after);
        shouldClearMarks = true;
      }
    } else {
      const [leaf] = Editor.leaf(editor, selection.anchor);
      shouldClearMarks =
        selection.anchor.offset === leaf.text.length &&
        Object.keys(leaf).some((key) => key !== "text");
    }

    if (shouldClearMarks) {
      for (const mark of Object.keys(Editor.marks(editor) ?? {})) {
        Editor.removeMark(editor, mark);
      }
    }
    insertTextWithExitHistory(text);
  };

  return editor;
}
