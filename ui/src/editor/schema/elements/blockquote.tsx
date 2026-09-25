import type { CreateProps, ElementDescriptor } from "../descriptor";
import type { BlockquoteElement } from "../types";

export const blockquoteDescriptor: ElementDescriptor<BlockquoteElement> = {
  type: "blockquote",
  kind: "block",
  create: ({
    children = [{ text: "" }],
    ...rest
  }: CreateProps<BlockquoteElement>) => ({
    type: "blockquote",
    children,
    ...rest,
  }),
  render: ({ attributes, children, element }) => (
    <blockquote
      {...attributes}
      data-block-id={element.blockId}
      // Pull quote (spec §5.6): a cobalt serif open-quote hangs at the left.
      // A pseudo-element, not a node, so copied text never carries it.
      className="relative my-8 pl-7 font-serif text-[25px] italic leading-[1.35] text-ink before:pointer-events-none before:absolute before:-left-1.5 before:-top-3.5 before:font-serif before:text-[64px] before:not-italic before:leading-none before:text-accent before:content-['“']"
    >
      {children}
    </blockquote>
  ),
  toMdast: (node, ctx) => ({
    type: "blockquote",
    children: ctx.blockChildren(node.children),
  }),
};

export const makeBlockquote = blockquoteDescriptor.create;
