import type { ElementDescriptor } from "../descriptor";
import type { BlockRefElement } from "../types";

export const blockRefDescriptor: ElementDescriptor<BlockRefElement> = {
  type: "block-ref",
  kind: "inline-void",
  create: () => {
    throw new Error("not implemented until phase 2");
  },
  render: () => {
    throw new Error("not implemented until phase 2");
  },
};
