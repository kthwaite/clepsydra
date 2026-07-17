import {
  Editor,
  Node,
  Path,
  Range,
  Element as SlateElement,
  Text,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import type { CustomElement } from "#/editor/types";
import { tryAutoPair, tryOvertype } from "./autoPair";
import {
  tryBlockTransform,
  tryCodeFence,
  tryThematicBreak,
} from "./blockTransforms";
import { tryInlineTransform } from "./inlineTransforms";
import { tryListContinuation } from "./listContinuation";

const INLINE_CLOSERS: Record<string, true> = {
  "`": true,
  "~": true,
  "*": true,
  _: true,
  ")": true,
  "]": true,
};

export function withAutoformat(editor: Editor): Editor {
  const { insertText, insertBreak } = editor;

  editor.insertText = (text: string) => {
    if (text.length !== 1) {
      insertText(text);
      resolveComposedInline(editor);
      return;
    }
    const ch = text;
    const { selection } = editor;
    if (!selection) {
      insertText(ch);
      return;
    }

    // Step 1: overtype -> inline transform -> return
    // After overtype the closer is already in the text, so pass closerConsumed.
    if (tryOvertype(editor, ch)) {
      tryInlineTransform(editor, ch, /* closerConsumed */ true);
      return;
    }
    // Step 2: thematic break
    if (ch === "-" && tryThematicBreak(editor)) return;
    // Step 3: block transforms
    if (ch === " " && Range.isCollapsed(selection) && tryBlockTransform(editor))
      return;
    // Step 4: inline transform
    if (tryInlineTransform(editor, ch)) return;
    // Step 5: auto-pair
    if (tryAutoPair(editor, ch)) return;
    // Step 6: fallback
    insertText(ch);
  };

  editor.insertBreak = () => {
    const { selection } = editor;
    if (!selection) {
      insertBreak();
      return;
    }
    if (tryListContinuation(editor)) return;
    if (tryBlockquoteContinuation(editor)) return;
    if (tryCodeFence(editor)) return;
    insertBreak();
  };

  return editor;
}

function resolveComposedInline(editor: Editor): void {
  let transformed = true;

  while (transformed) {
    transformed = false;
    const { selection } = editor;
    if (!selection || !Range.isCollapsed(selection)) return;

    const { anchor } = selection;
    const [node] = Editor.node(editor, anchor.path);
    if (!Text.isText(node)) return;

    const textBefore = node.text.slice(0, anchor.offset);
    for (let offset = textBefore.length; offset > 0; offset--) {
      const ch = textBefore[offset - 1];
      if (!(ch in INLINE_CLOSERS)) continue;
      if (ch === "]" && textBefore[offset] === "(") continue;

      const beforeCloser = { path: anchor.path, offset: offset - 1 };
      const afterCloser = { path: anchor.path, offset };
      Transforms.select(editor, {
        anchor: beforeCloser,
        focus: afterCloser,
      });
      Transforms.delete(editor);

      if (tryInlineTransform(editor, ch)) {
        if (ch === "]") return;
        transformed = true;
        break;
      }

      Transforms.insertText(editor, ch);
    }
    if (!transformed) Transforms.select(editor, selection);
  }
}

function tryBlockquoteContinuation(editor: Editor): boolean {
  const bqEntry = Editor.above(editor, {
    match: (n) =>
      SlateElement.isElement(n) && (n as CustomElement).type === "blockquote",
  });
  if (!bqEntry) return false;

  const paraEntry = Editor.above(editor, {
    match: (n) =>
      SlateElement.isElement(n) && (n as CustomElement).type === "paragraph",
  });
  if (!paraEntry) return false;

  const [paragraph] = paraEntry;
  const text = Node.string(paragraph);

  if (text.trim() === "") {
    const [, bqPath] = bqEntry;
    HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
      Editor.withoutNormalizing(editor, () => {
        const [, paraPath] = paraEntry;
        Transforms.removeNodes(editor, { at: paraPath });
        try {
          const bq = Editor.node(editor, bqPath)[0];
          if (
            SlateElement.isElement(bq) &&
            (bq as SlateElement).children.length === 0
          ) {
            Transforms.removeNodes(editor, { at: bqPath });
          }
        } catch {
          /* already removed */
        }
        const afterPath = Path.next(bqPath);
        Transforms.insertNodes(
          editor,
          {
            type: "paragraph",
            children: [{ text: "" }],
          } as any,
          { at: afterPath },
        );
        Transforms.select(editor, {
          anchor: { path: [...afterPath, 0], offset: 0 },
          focus: { path: [...afterPath, 0], offset: 0 },
        });
      });
    });
    return true;
  }

  return false;
}
