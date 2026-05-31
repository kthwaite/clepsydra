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
  render: ({ attributes, children }) => (
    <blockquote
      {...attributes}
      className="my-4 border-l-2 border-accent bg-paper-2 py-2 pl-4 pr-3 text-[0.97em] italic text-ink-2"
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
