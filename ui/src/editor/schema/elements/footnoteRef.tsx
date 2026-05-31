import type { ElementDescriptor } from "../descriptor";
import type { FootnoteRefElement } from "../types";

export const footnoteRefDescriptor: ElementDescriptor<FootnoteRefElement> = {
  type: "footnote-ref",
  kind: "inline-void",
  create: () => {
    throw new Error("not implemented until phase 2");
  },
  render: () => {
    throw new Error("not implemented until phase 2");
  },
};
