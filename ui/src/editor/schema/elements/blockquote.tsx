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
      className="relative my-8 pl-7 font-serif text-[25px] italic leading-[1.35] text-ink"
    >
      {/* Pull quote (spec §5.6): a cobalt serif open-quote hangs at the left. */}
      <span
        aria-hidden
        data-quote-mark
        contentEditable={false}
        className="pointer-events-none absolute -left-1.5 -top-3.5 select-none font-serif text-[64px] not-italic leading-none text-accent"
      >
        {"\u201C"}
      </span>
      {children}
    </blockquote>
  ),
  toMdast: (node, ctx) => ({
    type: "blockquote",
    children: ctx.blockChildren(node.children),
  }),
};

export const makeBlockquote = blockquoteDescriptor.create;
