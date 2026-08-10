import { type Editor, Element as SlateElement, Transforms } from "slate";
import type { FootnoteDefElement } from "./types";

/**
 * Document-level normalization. Runs once per top-level normalization pass
 * (called from withSchema when normalizing the editor root). One fix per pass;
 * returns true if it made a change so Slate re-runs normalization.
 *
 * Rules:
 *  - Footnote-def identifiers are kept unique.
 *  - A terminal block that cannot create a following paragraph itself gets a
 *    trailing empty paragraph so the cursor can reach below it.
 *
 * Dangling footnote-ref detection (a ref with no matching def) is intentionally
 * NOT handled here — it is surfaced non-destructively via decoration elsewhere.
 */
export function runDocumentRules(editor: Editor): boolean {
  if (ensureTrailingParagraph(editor)) return true;

  const seen = new Set<string>();
  for (let i = 0; i < editor.children.length; i++) {
    const node = editor.children[i];
    if (SlateElement.isElement(node) && node.type === "footnote-def") {
      const id = node.identifier;
      if (seen.has(id)) {
        let n = 2;
        let next = `${id}-${n}`;
        while (seen.has(next)) next = `${id}-${++n}`;
        Transforms.setNodes(
          editor,
          { identifier: next } satisfies Partial<FootnoteDefElement>,
          { at: [i] },
        );
        return true; // one fix per pass
      }
      seen.add(id);
    }
  }
  return false;
}

/**
 * If the last top-level node traps the caret or is atomic, append an empty
 * paragraph after it. The paragraph carries no meaningful markdown and is
 * re-derived on reload, so it does not accumulate across save/load cycles.
 */
function ensureTrailingParagraph(editor: Editor): boolean {
  const { children } = editor;
  const last = children[children.length - 1];
  if (
    !SlateElement.isElement(last) ||
    (last.type !== "base-embed" &&
      last.type !== "code-block" &&
      last.type !== "journal-time")
  ) {
    return false;
  }

  Transforms.insertNodes(
    editor,
    {
      type: "paragraph",
      ...(last.type === "base-embed"
        ? { baseEmbedTrailingSentinel: true }
        : {}),
      children: [{ text: "" }],
    } as never,
    { at: [children.length] },
  );
  return true;
}
