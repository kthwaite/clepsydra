import { type Editor, Element as SlateElement } from "slate";

export function withWikilinks(editor: Editor): Editor {
  const { isInline, isVoid } = editor;

  editor.isInline = (element) => {
    return SlateElement.isElement(element) && element.type === "wikilink"
      ? true
      : isInline(element);
  };

  editor.isVoid = (element) => {
    return SlateElement.isElement(element) && element.type === "wikilink"
      ? true
      : isVoid(element);
  };

  return editor;
}
