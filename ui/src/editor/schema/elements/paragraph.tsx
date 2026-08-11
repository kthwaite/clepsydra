import type { Paragraph } from "mdast";
import type { CreateProps, ElementDescriptor } from "../descriptor";
import type { ParagraphElement } from "../types";

export const paragraphDescriptor: ElementDescriptor<ParagraphElement> = {
  type: "paragraph",
  kind: "block",
  create: ({
    children = [{ text: "" }],
    ...rest
  }: CreateProps<ParagraphElement>) => ({
    type: "paragraph",
    children,
    ...rest,
  }),
  render: ({ attributes, children, element }) => (
    <p {...attributes} data-block-id={element.blockId}>
      {children}
    </p>
  ),
  toMdast: (node, ctx) => {
    const children = ctx.inlineChildren(node.children);
    ctx.appendBlockMetadata(children, node);
    const p: Paragraph = {
      type: "paragraph",
      children,
    };
    return p;
  },
};

export const makeParagraph = paragraphDescriptor.create;
