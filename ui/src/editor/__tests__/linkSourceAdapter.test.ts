import { createEditor, type Descendant, Editor } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { slateToMarkdown } from "#/editor/convert";
import { INLINE_SOURCE_TYPES } from "#/editor/inlineSourceAdapters";
import { linkSourceAdapter } from "#/editor/linkSourceAdapter";
import { makeLink } from "#/editor/schema/elements/link";
import { withSchema } from "#/editor/schema/withSchema";
import type { LinkElement } from "#/editor/types";

const boldLink = makeLink({
  url: "https://e.com",
  children: [{ text: "b", bold: true }, { text: " x" }],
}) as LinkElement;

function createLinkEditor(link: LinkElement = boldLink): Editor {
  const editor = withSchema(withHistory(createEditor()));
  editor.children = [
    {
      type: "paragraph",
      children: [{ text: "See " }, link, { text: " now." }],
    },
  ] as Descendant[];
  return editor;
}

function commit(editor: Editor, draft: string) {
  const result = linkSourceAdapter.parse(draft);
  if (result.kind !== "commit") throw new Error(`expected commit: ${draft}`);
  Editor.withoutNormalizing(editor, () => result.apply(editor, [0, 1]));
}

describe("linkSourceAdapter", () => {
  it("is registered for ←/→ entry", () => {
    expect(INLINE_SOURCE_TYPES).toContain("link");
  });

  it("drafts the inline Markdown form, with marks and no chrome", () => {
    expect(linkSourceAdapter.chrome).toBeUndefined();
    expect(linkSourceAdapter.toDraft(boldLink)).toBe(
      "[**b** x](https://e.com)",
    );
  });

  it.each(["wiki:Frida_Kahlo", "arxiv:2301.00001"])(
    "keeps a prefixed url %s verbatim through draft and commit",
    (url) => {
      const link = makeLink({
        url,
        children: [{ text: "ref" }],
      }) as LinkElement;
      const editor = createLinkEditor(link);
      const draft = linkSourceAdapter.toDraft(link);
      expect(draft).toBe(`[ref](${url})`);

      commit(editor, draft.replace("ref", "renamed"));

      expect(slateToMarkdown(editor.children)).toBe(
        `See [renamed](${url}) now.\n`,
      );
    },
  );

  it("replaces the link with an edited url, keeping label marks", () => {
    const editor = createLinkEditor();

    commit(editor, "[**b** x](https://other.org)");

    expect(editor.children).toEqual([
      {
        type: "paragraph",
        children: [
          { text: "See " },
          {
            type: "link",
            url: "https://other.org",
            children: [{ text: "b", bold: true }, { text: " x" }],
          },
          { text: " now." },
        ],
      },
    ]);
  });

  it("replaces the label with new Markdown", () => {
    const editor = createLinkEditor();

    commit(editor, "[*new* label](https://e.com)");

    expect(slateToMarkdown(editor.children)).toBe(
      "See [*new* label](https://e.com) now.\n",
    );
  });

  it("unlinks when the draft has no link syntax", () => {
    const editor = createLinkEditor();

    commit(editor, "**b** x");

    expect(editor.children).toEqual([
      {
        type: "paragraph",
        children: [
          { text: "See " },
          { text: "b", bold: true },
          { text: " x now." },
        ],
      },
    ]);
  });

  it("leaves the document untouched when the draft is unchanged", () => {
    const editor = createLinkEditor();
    const before = editor.children;

    commit(editor, linkSourceAdapter.toDraft(boldLink));

    expect(editor.children).toBe(before);
    expect(editor.operations).toEqual([]);
  });

  it.each(["", "   "])("cancels an empty draft %j", (draft) => {
    expect(linkSourceAdapter.parse(draft).kind).toBe("cancel");
  });

  it.each(["# heading", "- item", "a\n\nb"])(
    "marks a draft that is not one paragraph invalid: %j",
    (draft) => {
      expect(linkSourceAdapter.parse(draft).kind).toBe("invalid");
    },
  );
});
