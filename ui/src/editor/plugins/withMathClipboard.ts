import { type Descendant, type Editor, Element as SlateElement } from "slate";
import { slateToMarkdown } from "#/editor/convert";

/**
 * Preserve Slate's rich internal clipboard payload while making external plain
 * text source-correct for selections that contain math voids.
 */
export function withMathClipboard(editor: Editor): Editor {
  const { setFragmentData } = editor;

  editor.setFragmentData = (data, originEvent) => {
    setFragmentData(data, originEvent);
    if (!editor.selection) return;

    const fragment = editor.getFragment();
    if (!containsMath(fragment)) return;
    const markdown = slateToMarkdown(fragment);
    data.setData(
      "text/plain",
      markdown.endsWith("\n") ? markdown.slice(0, -1) : markdown,
    );
  };

  return editor;
}

function containsMath(nodes: Descendant[]): boolean {
  for (const node of nodes) {
    if (!SlateElement.isElement(node)) continue;
    if (node.type === "inline-math" || node.type === "math-block") return true;
    if (containsMath(node.children)) return true;
  }
  return false;
}
