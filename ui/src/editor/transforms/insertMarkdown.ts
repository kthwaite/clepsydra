import { type Descendant, type Editor, Transforms } from "slate";
import { markdownToSlate } from "#/editor/convert";

export function insertMarkdown(editor: Editor, markdown: string): void {
  const fragment = markdownToSlate(markdown);
  if (editor.selection) {
    editor.insertFragment(fragment);
    return;
  }
  Transforms.insertNodes(editor, fragment as Descendant[], {
    at: [editor.children.length],
  });
}
