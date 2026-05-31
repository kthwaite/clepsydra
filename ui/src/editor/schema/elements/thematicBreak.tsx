import type { ThematicBreak } from "mdast";
import type { ElementDescriptor } from "../descriptor";
import type { ThematicBreakElement } from "../types";

export const thematicBreakDescriptor: ElementDescriptor<ThematicBreakElement> = {
  type: "thematic-break",
  kind: "void-block",
  create: () => ({ type: "thematic-break", children: [{ text: "" }] }),
  render: ({ attributes, children }) => (
    <div {...attributes} contentEditable={false}>
      <hr className="my-6 border-border" />
      {children}
    </div>
  ),
  toMdast: () => {
    const tb: ThematicBreak = { type: "thematicBreak" };
    return tb;
  },
};

export const makeThematicBreak = thematicBreakDescriptor.create;
