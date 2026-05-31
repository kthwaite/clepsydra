import type { Paragraph, PhrasingContent } from "mdast";
import { BlockRefElement } from "#/editor/elements/BlockRefElement";
import type { ElementDescriptor } from "../descriptor";
import type { BlockRefElement as BlockRefElementType } from "../types";
import { makeVoidIntegrityRule } from "./voidInline";

export const blockRefDescriptor: ElementDescriptor<BlockRefElementType> = {
  type: "block-ref",
  kind: "inline-void",
  create: ({ blockId }) => ({
    type: "block-ref",
    blockId,
    children: [{ text: "" }],
  }),
  render: (props) => <BlockRefElement {...props} element={props.element} />,
  normalize: makeVoidIntegrityRule<BlockRefElementType>("blockId"),
  toMdast: (node) => {
    // A block-ref at block level — wrap in paragraph
    const p: Paragraph = {
      type: "paragraph",
      children: [
        { type: "text", value: `((${node.blockId}))` } as PhrasingContent,
      ],
    };
    return p;
  },
};

export const makeBlockRef = blockRefDescriptor.create;
