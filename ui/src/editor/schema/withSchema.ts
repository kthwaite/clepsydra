import {
  Editor,
  type NodeEntry,
  Path,
  Element as SlateElement,
  Transforms,
} from "slate";
import { kindIsInline, kindIsVoid } from "./descriptor";
import { runDocumentRules } from "./documentRules";
import { makeParagraph } from "./elements/paragraph";
import { getDescriptor } from "./registry";

export function withSchema(editor: Editor): Editor {
  const { insertBreak, isInline, isVoid, normalizeNode } = editor;

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

  // Enter on a selected top-level void block (divider, time heading, …)
  // starts a paragraph below it. Slate's default would split the void and
  // duplicate it.
  editor.insertBreak = () => {
    const voidEntry = Editor.void(editor, { mode: "highest" });
    if (voidEntry) {
      const [voidNode, voidPath] = voidEntry;
      const kind = getDescriptor(voidNode.type)?.kind;
      if (voidPath.length === 1 && kind === "void-block") {
        const at = Path.next(voidPath);
        Transforms.insertNodes(editor, makeParagraph({}), { at });
        Transforms.select(editor, Editor.start(editor, at));
        return;
      }
    }
    insertBreak();
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
