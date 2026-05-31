import { type Editor, Element as SlateElement } from "slate";
import { kindIsInline, kindIsVoid } from "./descriptor";
import { getDescriptor } from "./registry";

export function withSchema(editor: Editor): Editor {
  const { isInline, isVoid } = editor;

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

  return editor;
}
