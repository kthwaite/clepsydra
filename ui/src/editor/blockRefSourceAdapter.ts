import { Transforms } from "slate";
import type { InlineSourceAdapter } from "#/editor/inlineSourceEditing";
import type { BlockRefElement } from "#/editor/types";
import { isBlockId } from "#/lib/markdown/blockReferences";

/** Edits a `((blockId))` reference. Only a well-formed block id commits. */
export const blockRefSourceAdapter: InlineSourceAdapter<BlockRefElement> = {
  type: "block-ref",
  label: "Edit block reference",
  chrome: { open: "((", close: "))" },
  toDraft: (element) => element.blockId,
  parse(draft) {
    const blockId = draft.trim();
    if (!isBlockId(blockId)) return { kind: "invalid" };
    return {
      kind: "commit",
      apply(editor, path) {
        Transforms.setNodes(editor, { blockId }, { at: path });
      },
    };
  },
};
