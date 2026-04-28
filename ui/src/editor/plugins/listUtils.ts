import { Element as SlateElement } from "slate";

export const LIST_TYPES = new Set(["bulleted-list", "numbered-list"]);

export type ListType = "bulleted-list" | "numbered-list";

export function isListElement(
  node: unknown,
): node is SlateElement & { type: ListType } {
  return SlateElement.isElement(node) && LIST_TYPES.has(node.type as string);
}

export function isListItem(
  node: unknown,
): node is SlateElement & { type: "list-item"; checked?: boolean | null } {
  return SlateElement.isElement(node) && node.type === "list-item";
}
