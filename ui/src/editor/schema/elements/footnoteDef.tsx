import type { ElementDescriptor } from "../descriptor";
import type { FootnoteDefElement } from "../types";

export const footnoteDefDescriptor: ElementDescriptor<FootnoteDefElement> = {
  type: "footnote-def",
  kind: "block",
  create: () => {
    throw new Error("not implemented until phase 2");
  },
  render: () => {
    throw new Error("not implemented until phase 2");
  },
};
