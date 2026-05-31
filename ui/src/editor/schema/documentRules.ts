import { type Editor, Element as SlateElement, Transforms } from "slate";
import type { FootnoteDefElement } from "./types";

/**
 * Document-level normalization for footnotes. Runs once per top-level
 * normalization pass (called from withSchema when normalizing the editor root).
 * Ensures footnote-def identifiers are unique. One fix per pass; returns true
 * if it made a change so Slate re-runs normalization.
 *
 * Dangling footnote-ref detection (a ref with no matching def) is intentionally
 * NOT handled here — it is surfaced non-destructively via decoration elsewhere.
 */
export function runDocumentRules(editor: Editor): boolean {
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
