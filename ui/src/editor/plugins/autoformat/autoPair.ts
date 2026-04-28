import {
  Editor,
  Range,
  Element as SlateElement,
  Text,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import type { CustomElement } from "#/editor/types";

const OVERTYPE_CHARS = new Set(["*", "_", "~", "`", "]", ")"]);
const AUTO_PAIR_CHARS = new Set(["*", "_", "~"]);

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
