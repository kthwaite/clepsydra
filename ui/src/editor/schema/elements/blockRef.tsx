import { BlockRefElement } from "#/editor/elements/BlockRefElement";
import type { ElementDescriptor } from "../descriptor";
import type { BlockRefElement as BlockRefElementType } from "../types";

export const blockRefDescriptor: ElementDescriptor<BlockRefElementType> = {
  type: "block-ref",
  kind: "inline-void",
  create: ({ blockId }) => ({
    type: "block-ref",
    blockId,
    children: [{ text: "" }],
  }),
  render: (props) => <BlockRefElement {...props} element={props.element} />,
};

export const makeBlockRef = blockRefDescriptor.create;
