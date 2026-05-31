import type { Paragraph } from "mdast";
import { LinkElement } from "#/editor/elements/LinkElement";
import type { ElementDescriptor } from "../descriptor";
import type { LinkElement as LinkElementType } from "../types";

export const linkDescriptor: ElementDescriptor<LinkElementType> = {
  type: "link",
  kind: "inline",
  create: ({ url, children = [{ text: "" }] }) => ({
    type: "link",
    url,
    children,
  }),
  render: (props) => <LinkElement {...props} element={props.element} />,
  toMdast: (node, ctx) => {
    // A link at block level — wrap in paragraph
    const p: Paragraph = {
      type: "paragraph",
      children: [
        {
          type: "link",
          url: node.url,
          children: ctx.inlineChildren(node.children),
        },
      ],
    };
    return p;
  },
};

export const makeLink = linkDescriptor.create;
