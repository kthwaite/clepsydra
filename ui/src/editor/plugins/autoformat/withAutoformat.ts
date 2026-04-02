import {
  Editor,
  Node,
  Path,
  Range,
  Element as SlateElement,
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

export function withAutoformat(editor: Editor): Editor {
  const { insertText, insertBreak } = editor;

  editor.insertText = (text: string) => {
    if (text.length !== 1) {
      insertText(text);
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
