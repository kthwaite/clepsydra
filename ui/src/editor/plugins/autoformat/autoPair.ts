import {
  Editor,
  Point,
  Range,
  Element as SlateElement,
  Text,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import type { CustomElement } from "#/editor/types";

const OVERTYPE_CHARS = new Set(["*", "_", "~", "`", "]", ")"]);
const AUTO_PAIR_CHARS = new Set(["*", "_", "~"]);

/** Where the latest collapsed auto-pair left the caret, between the pair. */
const AUTO_PAIRED_CARET = new WeakMap<Editor, Point>();

export function tryOvertype(editor: Editor, ch: string): boolean {
  if (!OVERTYPE_CHARS.has(ch)) return false;
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return false;
  const { anchor } = selection;
  const [node] = Editor.node(editor, anchor.path);
  if (!Text.isText(node)) return false;
  if (anchor.offset >= node.text.length) return false;
  if (node.text[anchor.offset] !== ch) return false;
  Transforms.move(editor, { distance: 1, unit: "character" });
  return true;
}

export function tryAutoPair(editor: Editor, ch: string): boolean {
  if (!AUTO_PAIR_CHARS.has(ch)) return false;
  const { selection } = editor;
  if (!selection) return false;

  const blockEntry = Editor.above(editor, {
    match: (n) => SlateElement.isElement(n) && !Editor.isEditor(n),
  });
  if (blockEntry) {
    const [block] = blockEntry;
    if ((block as CustomElement).type === "code-block") return false;
  }
  const marks = Editor.marks(editor);
  if (marks?.code) return false;

  const { anchor } = selection;
  const [node] = Editor.node(editor, anchor.path);
  if (!Text.isText(node)) return false;

  if (Range.isCollapsed(selection)) {
    if (ch === "~") return false;
    if (anchor.offset < node.text.length && node.text[anchor.offset] === ch)
      return false;
    if (anchor.offset > 0) {
      const prev = node.text[anchor.offset - 1];
      if (prev !== " " && prev !== "\t" && prev !== "\n") {
        // Allow auto-pair when previous char is the same marker char
        if (!AUTO_PAIR_CHARS.has(prev)) return false;
      }
    }
    HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
      Transforms.insertText(editor, ch + ch);
      Transforms.move(editor, {
        distance: 1,
        unit: "character",
        reverse: true,
      });
    });
    if (editor.selection) {
      AUTO_PAIRED_CARET.set(editor, editor.selection.anchor);
    }
    return true;
  }

  const { focus } = selection;
  if (anchor.path.join(",") !== focus.path.join(",")) return false;
  const [start, end] = Range.edges(selection);
  HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
    Transforms.insertText(editor, ch, { at: end });
    Transforms.insertText(editor, ch, { at: start });
    Transforms.select(editor, {
      anchor: { path: start.path, offset: end.offset + 2 },
      focus: { path: start.path, offset: end.offset + 2 },
    });
  });
  return true;
}

/**
 * A Space straight after an auto-paired `*` or `_` means it opens nothing, since
 * emphasis needs text after its opener. It is a bullet marker or a literal, so
 * the closer the pairing inserted has to go.
 */
export function dropAutoPairedCloser(editor: Editor): void {
  const caret = AUTO_PAIRED_CARET.get(editor);
  AUTO_PAIRED_CARET.delete(editor);
  const { selection } = editor;
  if (
    !caret ||
    !selection ||
    !Range.isCollapsed(selection) ||
    !Point.equals(selection.anchor, caret)
  ) {
    return;
  }
  const [node] = Editor.node(editor, caret.path);
  if (!Text.isText(node)) return;
  const opener = node.text[caret.offset - 1];
  if (!AUTO_PAIR_CHARS.has(opener) || node.text[caret.offset] !== opener)
    return;
  Transforms.delete(editor, { at: caret, distance: 1, unit: "character" });
}
