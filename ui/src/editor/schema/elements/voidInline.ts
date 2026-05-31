import { type Editor, Element as SlateElement, type NodeEntry, Transforms } from "slate";
import type { CustomElement } from "../types";

/**
 * Build a normalize rule for a void inline whose `keyField` (e.g. "target",
 * "blockId", "identifier") must be a non-empty string. A malformed node is
 * removed; its only child is an empty text node, so the surrounding text is
 * unaffected.
 */
export function makeVoidIntegrityRule<T extends CustomElement>(keyField: keyof T & string) {
  return (entry: NodeEntry<T>, editor: Editor): boolean => {
    const [node, path] = entry;
    if (!SlateElement.isElement(node)) return false;
    const key = (node as unknown as Record<string, unknown>)[keyField];
    if (typeof key !== "string" || key.length === 0) {
      Transforms.removeNodes(editor, { at: path });
      return true;
    }
    return false;
  };
}
