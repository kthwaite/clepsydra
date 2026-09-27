import { createEditor, type Descendant, type Editor, Node } from "slate";
import { describe, expect, it } from "vitest";
import { blockRefSourceAdapter } from "#/editor/blockRefSourceAdapter";
import { INLINE_SOURCE_TYPES } from "#/editor/inlineSourceAdapters";
import { makeBlockRef } from "#/editor/schema/elements/blockRef";
import { withSchema } from "#/editor/schema/withSchema";

function createBlockRefEditor(): Editor {
  const editor = withSchema(createEditor());
  editor.children = [
    {
      type: "paragraph",
      children: [
        { text: "See " },
        makeBlockRef({ blockId: "abc123DEF0" }),
        { text: "." },
      ],
    },
  ] as Descendant[];
  return editor;
}

describe("blockRefSourceAdapter", () => {
  it("is registered for ←/→ entry", () => {
    expect(INLINE_SOURCE_TYPES).toContain("block-ref");
  });

  it("drafts the bare id inside (( )) chrome", () => {
    expect(blockRefSourceAdapter.chrome).toEqual({ open: "((", close: "))" });
    expect(
      blockRefSourceAdapter.toDraft(makeBlockRef({ blockId: "abc123DEF0" })),
    ).toBe("abc123DEF0");
  });

  it("commits a valid new id by setting blockId", () => {
    const editor = createBlockRefEditor();
    const result = blockRefSourceAdapter.parse("zyx987WVU65");
    expect(result.kind).toBe("commit");
    if (result.kind !== "commit") return;

    result.apply(editor, [0, 1]);

    expect(Node.get(editor, [0, 1])).toEqual({
      type: "block-ref",
      blockId: "zyx987WVU65",
      children: [{ text: "" }],
    });
  });

  it.each([
    ["too short", "abc123"],
    ["too long", "abc123DEF0123"],
    ["bad characters", "abc-123-DEF"],
    ["empty", ""],
  ])("marks a %s id invalid", (_name, draft) => {
    expect(blockRefSourceAdapter.parse(draft).kind).toBe("invalid");
  });
});
