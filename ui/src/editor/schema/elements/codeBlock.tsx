import { CodeBlockElement } from "#/editor/elements/CodeBlockElement";
import type { CreateProps, ElementDescriptor } from "../descriptor";
import type { CodeBlockElement as CodeBlockElementType } from "../types";

export const codeBlockDescriptor: ElementDescriptor<CodeBlockElementType> = {
  type: "code-block",
  kind: "block",
  create: ({ children = [{ text: "" }], ...rest }: CreateProps<CodeBlockElementType>) => ({
    type: "code-block",
    children,
    ...rest,
  }),
  render: (props) => <CodeBlockElement {...props} element={props.element} />,
};

export const makeCodeBlock = codeBlockDescriptor.create;
