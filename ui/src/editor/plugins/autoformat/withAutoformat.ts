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
import {
  tryPrefixedLinkBreakTransform,
  tryPrefixedLinkTextTransform,
} from "./prefixedLinkTransform";

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
      // IME / dead-key composition (and autocorrect) commit text through a
      // single multi-character insertText, bypassing the per-key autoformat
      // below. Resolve any markdown delimiters the run contains so typed
      // syntax becomes Slate structure instead of literal (later escaped) text.
      resolveComposedInline(editor);
      return;
    }
    const ch = text;
    const { selection } = editor;
    if (!selection) {
      insertText(ch);
      return;
    }

    // Step 1: overtype -> prefixed link -> inline transform -> return
    // After overtype the closer is already in the text, so pass closerConsumed.
    if (tryOvertype(editor, ch)) {
      if (
        ch === '"' &&
        tryPrefixedLinkTextTransform(editor, ch, /* closerConsumed */ true)
      )
        return;
      tryInlineTransform(editor, ch, /* closerConsumed */ true);
      return;
    }
    // Step 2: thematic break
    if (ch === "-" && tryThematicBreak(editor)) return;
    // Step 3: prefixed link on Space
    if (ch === " " && tryPrefixedLinkTextTransform(editor, ch)) return;
    // Step 4: block transforms
    if (ch === " " && Range.isCollapsed(selection) && tryBlockTransform(editor))
      return;
    // Step 5: inline transform
    if (tryInlineTransform(editor, ch)) return;
    // Step 6: prefixed link on a non-overtype closing quote
    if (ch === '"' && tryPrefixedLinkTextTransform(editor, ch)) return;
    // Step 7: auto-pair
    if (tryAutoPair(editor, ch)) return;
    // Step 8: fallback
    insertText(ch);
  };

  editor.insertBreak = () => {
    const { selection } = editor;
    if (!selection) {
      insertBreak();
      return;
    }
    if (tryCodeBlockNewline(editor)) return;
    if (tryListContinuation(editor)) return;
    if (tryBlockquoteContinuation(editor)) return;
    if (tryHeadingExit(editor)) return;
    if (tryCodeFence(editor)) return;
    if (tryPrefixedLinkBreakTransform(editor, insertBreak)) return;
    insertBreak();
  };

  return editor;
}

/**
 * Enter inside a code block inserts a literal newline into the block's text
 * rather than splitting it into two code blocks (Slate's default insertBreak).
 * A code block is canonically a single text node holding the full multi-line
 * source with embedded `\n`, so a soft break is the correct edit.
 */
function tryCodeBlockNewline(editor: Editor): boolean {
  const { selection } = editor;
  if (!selection) return false;
  const entry = Editor.above(editor, {
    match: (n) =>
      SlateElement.isElement(n) && (n as CustomElement).type === "code-block",
  });
  if (!entry) return false;
  Transforms.insertText(editor, "\n");
  return true;
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
    let bracketRejected = false;
    for (let offset = textBefore.length; offset > 0; offset--) {
      const ch = textBefore[offset - 1];
      if (!(ch in INLINE_CLOSERS)) continue;
      if (ch === "]" && bracketRejected) continue;
      if (ch === "]" && textBefore[offset] === "(") {
        const openBracket = textBefore.lastIndexOf("[", offset - 2);
        if (openBracket === -1 || textBefore[openBracket + 1] !== "^") continue;
      }

      const hasTrailingContent = offset < textBefore.length;
      const endpointRef = Editor.pointRef(editor, anchor, {
        affinity: "forward",
      });
      const beforeCloser = { path: anchor.path, offset: offset - 1 };
      const afterCloser = { path: anchor.path, offset };
      Transforms.select(editor, {
        anchor: beforeCloser,
        focus: afterCloser,
      });
      Transforms.delete(editor);

      if (tryInlineTransform(editor, ch)) {
        const mappedEndpoint = endpointRef.unref();
        if (hasTrailingContent && mappedEndpoint) {
          Transforms.select(editor, mappedEndpoint);
        }
        if (ch === "]") return;
        transformed = true;
        break;
      }

      endpointRef.unref();
      Transforms.insertText(editor, ch);
      if (ch === "]") bracketRejected = true;
    }
    if (!transformed) Transforms.select(editor, selection);
  }
}

/**
 * Enter at the end of a heading drops out to a fresh paragraph below instead
 * of carrying the heading style onto the next line. A mid-heading Enter is left
 * to Slate's default split (which keeps both halves as headings).
 */
function tryHeadingExit(editor: Editor): boolean {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return false;

  const headingEntry = Editor.above(editor, {
    match: (n) =>
      SlateElement.isElement(n) && (n as CustomElement).type === "heading",
  });
  if (!headingEntry) return false;

  const [, headingPath] = headingEntry;
  if (!Editor.isEnd(editor, selection.anchor, headingPath)) return false;

  HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
    const afterPath = Path.next(headingPath);
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
  return true;
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
