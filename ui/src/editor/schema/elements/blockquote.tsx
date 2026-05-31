import type { ElementDescriptor } from "../descriptor";
import type { BlockquoteElement } from "../types";

export const blockquoteDescriptor: ElementDescriptor<BlockquoteElement> = {
  type: "blockquote",
  kind: "block",
  create: () => {
    throw new Error("not implemented until phase 2");
  },
  render: () => {
    throw new Error("not implemented until phase 2");
  },
};
