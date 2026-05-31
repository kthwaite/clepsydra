import type { ElementDescriptor } from "../descriptor";
import type { CodeBlockElement } from "../types";

export const codeBlockDescriptor: ElementDescriptor<CodeBlockElement> = {
  type: "code-block",
  kind: "block",
  create: () => {
    throw new Error("not implemented until phase 2");
  },
  render: () => {
    throw new Error("not implemented until phase 2");
  },
};
