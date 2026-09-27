import { Element, Node, Transforms } from "slate";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import type { InlineSourceAdapter } from "#/editor/inlineSourceEditing";
import type { LinkElement } from "#/editor/types";

/** The inline Markdown for one link, such as `[**b** x](https://e.com)`. */
function linkMarkdown(link: LinkElement): string {
  return slateToMarkdown([
    { type: "paragraph", children: [{ text: "" }, link, { text: "" }] },
  ]).replace(/\n+$/, "");
}

/**
 * Edits a Markdown link as its full `[label](url)` source. The draft is
 * re-parsed as inline Markdown and its content replaces the link, so marks
 * survive and a draft without link syntax unlinks.
 */
export const linkSourceAdapter: InlineSourceAdapter<LinkElement> = {
  type: "link",
  label: "Edit link",
  toDraft: linkMarkdown,
  parse(draft) {
    if (draft.trim().length === 0) return { kind: "cancel" };
    const blocks = markdownToSlate(draft);
    const [only] = blocks;
    if (
      blocks.length !== 1 ||
      !Element.isElement(only) ||
      only.type !== "paragraph"
    ) {
      return { kind: "invalid" };
    }
    const inlines = only.children;
    return {
      kind: "commit",
      apply(editor, path) {
        const current = Node.get(editor, path) as LinkElement;
        if (linkMarkdown(current) === draft) return;
        Transforms.removeNodes(editor, { at: path });
        Transforms.insertNodes(editor, inlines, { at: path });
      },
    };
  },
};
