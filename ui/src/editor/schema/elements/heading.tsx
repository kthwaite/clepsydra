import type { ElementDescriptor } from "../descriptor";
import type { HeadingElement } from "../types";

export const headingDescriptor: ElementDescriptor<HeadingElement> = {
  type: "heading",
  kind: "block",
  create: () => {
    throw new Error("not implemented until phase 2");
  },
  render: () => {
    throw new Error("not implemented until phase 2");
  },
};
