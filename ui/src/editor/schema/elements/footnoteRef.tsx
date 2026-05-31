import type { Paragraph, PhrasingContent } from "mdast";
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
  toMdast: (node) => {
    // A footnote-ref at block level — wrap in paragraph
    const p: Paragraph = {
      type: "paragraph",
      children: [
        {
          type: "footnoteReference",
          identifier: node.identifier,
          label: node.identifier,
        } as unknown as PhrasingContent,
      ],
    };
    return p;
  },
};

export const makeFootnoteRef = footnoteRefDescriptor.create;
