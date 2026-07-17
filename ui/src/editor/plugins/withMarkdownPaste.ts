import { Editor, Element as SlateElement, Transforms } from "slate";
import { markdownToSlate } from "#/editor/convert";
import type { CustomElement } from "#/editor/types";

/**
 * Parse pasted markdown into Slate elements.
 *
 * Overrides insertData: pastes inside a code-block insert their text/plain
 * literally as one run; internal Slate fragments and non-text pastes defer to
 * the base (withReact) insertData; plain-text pastes are converted via
 * markdownToSlate and inserted as a fragment.
 */
export function withMarkdownPaste(editor: Editor): Editor {
  const { insertData } = editor;

  editor.insertData = (data: DataTransfer) => {
    // 1. Inside a code-block — paste literally (it's code, not markdown).
    // Checked before the internal-fragment case: both base insertData paths
    // would fragment the code-block (insertTextData splits on newlines via
    // Transforms.splitNodes; insertFragmentData splices block nodes into it).
    // A code-block is canonically a single text node with embedded `\n`, so
    // the raw text (CRLF-normalized), inserted as one run, is the right edit.
    if (isInCodeBlock(editor)) {
      const text = data.getData("text/plain");
      if (text) {
        Transforms.insertText(editor, text.replace(/\r\n?/g, "\n"));
        return;
      }
      insertData(data);
      return;
    }
    // 2. Internal copy/paste — never markdown-reparse our own fragments.
    if (data.getData("application/x-slate-fragment")) {
      insertData(data);
      return;
    }
    // 3. Plain text → markdown → Slate fragment.
    const text = data.getData("text/plain");
    if (text) {
      Transforms.insertFragment(editor, markdownToSlate(text));
      return;
    }
    // 4. Files / anything else → default behavior.
    insertData(data);
  };

  return editor;
}

function isInCodeBlock(editor: Editor): boolean {
  const { selection } = editor;
  if (!selection) return false;
  const [match] = Editor.nodes(editor, {
    at: selection,
    match: (n) =>
      SlateElement.isElement(n) &&
      !Editor.isEditor(n) &&
      (n as CustomElement).type === "code-block",
  });
  return !!match;
}
