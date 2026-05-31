import type { Paragraph, PhrasingContent } from "mdast";
import type { WikiLinkMdast } from "#/editor/convert/mdastTypes";
import { WikilinkElement } from "#/editor/elements/WikilinkElement";
import type { ElementDescriptor } from "../descriptor";
import type { WikilinkElement as WikilinkElementType } from "../types";
import { makeVoidIntegrityRule } from "./voidInline";

export const wikilinkDescriptor: ElementDescriptor<WikilinkElementType> = {
  type: "wikilink",
  kind: "inline-void",
  create: ({ target, alias }) => ({
    type: "wikilink",
    target,
    alias,
    children: [{ text: "" }],
  }),
  render: (props) => <WikilinkElement {...props} element={props.element} />,
  normalize: makeVoidIntegrityRule<WikilinkElementType>("target"),
  toMdast: (node) => {
    // A wikilink at block level — wrap in paragraph
    const wl: WikiLinkMdast = {
      type: "wikiLink",
      data: {
        permalink: node.target,
        alias: node.alias,
      },
    };
    const p: Paragraph = {
      type: "paragraph",
      children: [wl as unknown as PhrasingContent],
    };
    return p;
  },
};

export const makeWikilink = wikilinkDescriptor.create;
