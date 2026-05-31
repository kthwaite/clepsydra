import { Editor, Element as SlateElement, type NodeEntry } from "slate";
import { kindIsInline, kindIsVoid } from "./descriptor";
import { runDocumentRules } from "./documentRules";
import { getDescriptor } from "./registry";

export function withSchema(editor: Editor): Editor {
  const { isInline, isVoid, normalizeNode } = editor;

  editor.isInline = (element) => {
    if (SlateElement.isElement(element)) {
      const desc = getDescriptor(element.type);
      if (desc) return kindIsInline(desc.kind);
    }
    return isInline(element);
  };

  editor.isVoid = (element) => {
    if (SlateElement.isElement(element)) {
      const desc = getDescriptor(element.type);
      if (desc) return kindIsVoid(desc.kind);
    }
    return isVoid(element);
  };

  editor.normalizeNode = (entry, options) => {
    const [node] = entry;
    if (Editor.isEditor(node)) {
      if (runDocumentRules(editor)) return;
    }
    if (SlateElement.isElement(node)) {
      const desc = getDescriptor(node.type);
      if (desc?.normalize?.(entry as NodeEntry<never>, editor)) return;
    }
    normalizeNode(entry, options);
  };

  return editor;
}
