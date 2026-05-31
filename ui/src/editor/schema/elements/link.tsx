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
};

export const makeLink = linkDescriptor.create;
