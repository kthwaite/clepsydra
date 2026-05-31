import type { ElementDescriptor } from "../descriptor";
import type { ParagraphElement } from "../types";

export const paragraphDescriptor: ElementDescriptor<ParagraphElement> = {
  type: "paragraph",
  kind: "block",
  create: () => {
    throw new Error("not implemented until phase 2");
  },
  render: () => {
    throw new Error("not implemented until phase 2");
  },
};
