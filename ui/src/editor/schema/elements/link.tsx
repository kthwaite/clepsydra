import type { ElementDescriptor } from "../descriptor";
import type { LinkElement } from "../types";

export const linkDescriptor: ElementDescriptor<LinkElement> = {
  type: "link",
  kind: "inline",
  create: () => {
    throw new Error("not implemented until phase 2");
  },
  render: () => {
    throw new Error("not implemented until phase 2");
  },
};
