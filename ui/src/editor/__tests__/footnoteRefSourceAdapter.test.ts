import { createEditor, type Descendant, type Editor, Node } from "slate";
import { describe, expect, it } from "vitest";
import { footnoteRefSourceAdapter } from "#/editor/footnoteRefSourceAdapter";
import { INLINE_SOURCE_TYPES } from "#/editor/inlineSourceAdapters";
import { makeFootnoteDef } from "#/editor/schema/elements/footnoteDef";
import { makeFootnoteRef } from "#/editor/schema/elements/footnoteRef";
import { withSchema } from "#/editor/schema/withSchema";

function createFootnoteEditor(): Editor {
  const editor = withSchema(createEditor());
  editor.children = [
    {
      type: "paragraph",
      children: [
        { text: "Claim" },
        makeFootnoteRef({ identifier: "old" }),
        { text: "." },
      ],
    },
    makeFootnoteDef({ identifier: "old" }),
    makeFootnoteDef({ identifier: "other" }),
  ] as Descendant[];
  return editor;
}

function commit(editor: Editor, draft: string) {
  const result = footnoteRefSourceAdapter.parse(draft);
  if (result.kind !== "commit") throw new Error(`expected commit: ${draft}`);
  result.apply(editor, [0, 1]);
}

function defIds(editor: Editor) {
  return editor.children.flatMap((node) =>
    "type" in node && node.type === "footnote-def" ? [node.identifier] : [],
  );
}

describe("footnoteRefSourceAdapter", () => {
  it("is registered for ←/→ entry", () => {
    expect(INLINE_SOURCE_TYPES).toContain("footnote-ref");
  });

  it("drafts the identifier inside [^ ] chrome", () => {
    expect(footnoteRefSourceAdapter.chrome).toEqual({ open: "[^", close: "]" });
    expect(
      footnoteRefSourceAdapter.toDraft(makeFootnoteRef({ identifier: "n1" })),
    ).toBe("n1");
  });

  it("repoints to an existing def without adding one", () => {
    const editor = createFootnoteEditor();

    commit(editor, "other");

    expect(Node.get(editor, [0, 1])).toMatchObject({ identifier: "other" });
    expect(defIds(editor)).toEqual(["old", "other"]);
  });

  it("repoints to a new id and appends an empty def, keeping the old def", () => {
    const editor = createFootnoteEditor();

    commit(editor, "fresh");

    expect(Node.get(editor, [0, 1])).toMatchObject({ identifier: "fresh" });
    expect(defIds(editor)).toEqual(["old", "other", "fresh"]);
    expect(editor.children.at(-1)).toEqual(
      makeFootnoteDef({ identifier: "fresh" }),
    );
  });

  it("changes nothing when the identifier is unchanged", () => {
    const editor = createFootnoteEditor();
    editor.children = editor.children.slice(0, 1);

    commit(editor, "old");

    expect(defIds(editor)).toEqual([]);
  });

  it.each(["", "   "])("cancels an empty draft %j", (draft) => {
    expect(footnoteRefSourceAdapter.parse(draft).kind).toBe("cancel");
  });

  it.each(["a b", "a]b", "a[b"])(
    "marks an identifier that cannot round-trip (%j) invalid",
    (draft) => {
      expect(footnoteRefSourceAdapter.parse(draft).kind).toBe("invalid");
    },
  );
});
