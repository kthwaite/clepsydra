import type { Heading } from "mdast";
import type { CreateProps, ElementDescriptor } from "../descriptor";
import type { HeadingElement } from "../types";

const HEADING_CLASSES: Record<number, string> = {
  1: "mb-4 mt-10 font-serif text-[40px] font-normal leading-[1.1] tracking-[-0.01em] text-ink",
  2: "relative mb-3 mt-11 font-serif text-[30px] font-normal leading-[1.15] text-ink",
  3: "mb-2 mt-8 font-sans text-[19px] font-semibold leading-[1.3] text-ink",
  4: "mb-2 mt-6 font-sans text-[16px] font-semibold text-ink",
  5: "mb-1 mt-4 font-sans text-[14px] font-semibold text-ink-2",
  6: "mb-1 mt-4 font-sans text-[13px] font-medium text-mute",
};

export const headingDescriptor: ElementDescriptor<HeadingElement> = {
  type: "heading",
  kind: "block",
  create: ({
    level,
    children = [{ text: "" }],
    ...rest
  }: CreateProps<HeadingElement>) => ({
    type: "heading",
    level,
    children,
    ...rest,
  }),
  render: ({ attributes, children, element }) => {
    const Tag = `h${element.level}` as const;
    return (
      <Tag
        {...attributes}
        data-block-id={element.blockId}
        className={HEADING_CLASSES[element.level]}
      >
        {element.level === 2 ? (
          // Spec §5.6: prose h2s hang a cobalt tick in the left margin.
          <span
            aria-hidden
            data-tick
            contentEditable={false}
            className="pointer-events-none absolute -left-[22px] top-1/2 h-2 w-2 -translate-y-1/2 select-none rounded-[1px] bg-accent"
          />
        ) : null}
        {children}
      </Tag>
    );
  },
  toMdast: (node, ctx) => {
    const children = ctx.inlineChildren(node.children);
    ctx.appendBlockMetadata(children, node);
    const h: Heading = {
      type: "heading",
      depth: node.level,
      children,
    };
    return h;
  },
};

export const makeHeading = headingDescriptor.create;
