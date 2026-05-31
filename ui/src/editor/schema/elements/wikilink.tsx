import type { ElementDescriptor } from "../descriptor";
import type { WikilinkElement } from "../types";

export const wikilinkDescriptor: ElementDescriptor<WikilinkElement> = {
  type: "wikilink",
  kind: "inline-void",
  create: () => {
    throw new Error("not implemented until phase 2");
  },
  render: () => {
    throw new Error("not implemented until phase 2");
  },
};
