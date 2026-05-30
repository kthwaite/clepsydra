import { type Editor, Element as SlateElement } from "slate";

export function withWikilinks(editor: Editor): Editor {
  const { isInline, isVoid } = editor;

  editor.isInline = (element) => {
    return SlateElement.isElement(element) &&
      (element.type === "wikilink" ||
        element.type === "block-ref" ||
        element.type === "footnote-ref")
      ? true
      : isInline(element);
  };

  editor.isVoid = (element) => {
    if (SlateElement.isElement(element)) {
      if (
        element.type === "wikilink" ||
        element.type === "block-ref" ||
        element.type === "footnote-ref" ||
        element.type === "thematic-break"
      ) {
        return true;
      }
    }
    return isVoid(element);
  };

  return editor;
}
