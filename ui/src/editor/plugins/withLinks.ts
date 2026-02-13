import { type Editor, Element as SlateElement } from "slate";

export function withLinks(editor: Editor): Editor {
  const { isInline } = editor;

  editor.isInline = (element) => {
    return SlateElement.isElement(element) && element.type === "link"
      ? true
      : isInline(element);
  };

  return editor;
}
