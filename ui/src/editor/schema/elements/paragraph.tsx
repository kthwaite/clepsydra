import type { CreateProps, ElementDescriptor } from "../descriptor";
import type { ParagraphElement } from "../types";

export const paragraphDescriptor: ElementDescriptor<ParagraphElement> = {
  type: "paragraph",
  kind: "block",
  create: ({ children = [{ text: "" }], ...rest }: CreateProps<ParagraphElement>) => ({
    type: "paragraph",
    children,
    ...rest,
  }),
  render: ({ attributes, children }) => <p {...attributes}>{children}</p>,
};

export const makeParagraph = paragraphDescriptor.create;
