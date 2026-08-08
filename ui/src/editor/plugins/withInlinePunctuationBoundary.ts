import { Editor, Element as SlateElement, Range, Transforms } from "slate";

const TRAILING_PUNCTUATION = /^[,.;:!?]$/;

export function withInlinePunctuationBoundary(editor: Editor): Editor {
  const { insertText } = editor;

  editor.insertText = (text) => {
    const { selection } = editor;
    if (
      !TRAILING_PUNCTUATION.test(text) ||
      !selection ||
      !Range.isCollapsed(selection)
    ) {
      insertText(text);
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
    insertText(text);
  };

  return editor;
}
