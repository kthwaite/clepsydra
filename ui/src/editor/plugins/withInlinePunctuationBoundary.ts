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

    if (inline && Editor.isEnd(editor, selection.anchor, inline[1])) {
      const after = Editor.after(editor, inline[1]);
      if (after) Transforms.select(editor, after);
    }

    for (const mark of Object.keys(Editor.marks(editor) ?? {})) {
      Editor.removeMark(editor, mark);
    }
    insertText(text);
  };

  return editor;
}
