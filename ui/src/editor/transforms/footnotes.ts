import { type Editor, Element as SlateElement, Transforms } from "slate";
import { makeFootnoteDef } from "#/editor/schema/elements/footnoteDef";

/**
 * Appends an empty `footnote-def` for `identifier` at the end of the
 * document when no top-level def has that identifier. Returns true when it
 * appended one.
 */
export function ensureFootnoteDef(editor: Editor, identifier: string): boolean {
  const hasDefinition = editor.children.some(
    (node) =>
      SlateElement.isElement(node) &&
      node.type === "footnote-def" &&
      node.identifier === identifier,
  );
  if (hasDefinition) return false;
  Transforms.insertNodes(editor, makeFootnoteDef({ identifier }), {
    at: [editor.children.length],
  });
  return true;
}
