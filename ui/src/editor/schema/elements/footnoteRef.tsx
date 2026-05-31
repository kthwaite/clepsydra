import { FootnoteRefElement } from "#/editor/elements/FootnoteRefElement";
import type { ElementDescriptor } from "../descriptor";
import type { FootnoteRefElement as FootnoteRefElementType } from "../types";
import { makeVoidIntegrityRule } from "./voidInline";

export const footnoteRefDescriptor: ElementDescriptor<FootnoteRefElementType> = {
  type: "footnote-ref",
  kind: "inline-void",
  create: ({ identifier }) => ({
    type: "footnote-ref",
    identifier,
    children: [{ text: "" }],
  }),
  render: (props) => <FootnoteRefElement {...props} element={props.element} />,
  normalize: makeVoidIntegrityRule<FootnoteRefElementType>("identifier"),
};

export const makeFootnoteRef = footnoteRefDescriptor.create;
