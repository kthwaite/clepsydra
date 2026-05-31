import type { ElementDescriptor } from "../descriptor";
import type { ThematicBreakElement } from "../types";

export const thematicBreakDescriptor: ElementDescriptor<ThematicBreakElement> = {
  type: "thematic-break",
  kind: "void-block",
  create: () => {
    throw new Error("not implemented until phase 2");
  },
  render: () => {
    throw new Error("not implemented until phase 2");
  },
};
