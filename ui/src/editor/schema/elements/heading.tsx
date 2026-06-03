import type { Heading } from "mdast";
import type { CreateProps, ElementDescriptor } from "../descriptor";
import type { HeadingElement } from "../types";

const HEADING_CLASSES: Record<number, string> = {
  1: "mb-4 mt-8 font-sans text-[28px] font-black tracking-[-0.01em] text-ink",
  2: "mb-3 mt-8 font-sans text-[20px] font-bold text-ink",
  3: "mb-2 mt-6 font-sans text-[16px] font-semibold text-ink",
  4: "mb-2 mt-4 font-sans text-[14px] font-semibold text-ink",
  5: "mb-1 mt-3 font-sans text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-2",
  6: "mb-1 mt-3 font-sans text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-mute",
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
      <Tag {...attributes} className={HEADING_CLASSES[element.level]}>
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
