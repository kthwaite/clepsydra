import { WikilinkElement } from "#/editor/elements/WikilinkElement";
import type { ElementDescriptor } from "../descriptor";
import type { WikilinkElement as WikilinkElementType } from "../types";

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
};

export const makeWikilink = wikilinkDescriptor.create;
