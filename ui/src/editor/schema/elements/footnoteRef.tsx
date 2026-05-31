import { FootnoteRefElement } from "#/editor/elements/FootnoteRefElement";
import type { ElementDescriptor } from "../descriptor";
import type { FootnoteRefElement as FootnoteRefElementType } from "../types";

export const footnoteRefDescriptor: ElementDescriptor<FootnoteRefElementType> = {
  type: "footnote-ref",
  kind: "inline-void",
  create: ({ identifier }) => ({
    type: "footnote-ref",
    identifier,
    children: [{ text: "" }],
  }),
  render: (props) => <FootnoteRefElement {...props} element={props.element} />,
};

export const makeFootnoteRef = footnoteRefDescriptor.create;
