import type { Code } from "mdast";
import {
  type Editor,
  Node,
  type NodeEntry,
  Element as SlateElement,
  Transforms,
} from "slate";
import { CodeBlockElement } from "#/editor/elements/CodeBlockElement";
import type { CreateProps, ElementDescriptor } from "../descriptor";
import type {
  CodeBlockElement as CodeBlockElementType,
  CustomText,
} from "../types";

const CODE_MARKS = [
  "bold",
  "italic",
  "underline",
  "code",
  "strikethrough",
  "superscript",
  "subscript",
  "color",
  "backgroundColor",
] as const;

function normalizeCodeBlock(
  entry: NodeEntry<CodeBlockElementType>,
  editor: Editor,
): boolean {
  const [node, path] = entry;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (SlateElement.isElement(child)) {
      // Replace an element child with its plain text (one fix per pass).
      Transforms.removeNodes(editor, { at: [...path, i] });
      Transforms.insertNodes(
        editor,
        { text: Node.string(child) },
        { at: [...path, i] },
      );
      return true;
    }
    const marks = CODE_MARKS.filter(
      (m) => (child as unknown as Record<string, unknown>)[m],
    );
    if (marks.length > 0) {
      Transforms.unsetNodes(editor, marks, { at: [...path, i] });
      return true;
    }
  }
  return false;
}

export const codeBlockDescriptor: ElementDescriptor<CodeBlockElementType> = {
  type: "code-block",
  kind: "block",
  create: ({
    children = [{ text: "" }],
    ...rest
  }: CreateProps<CodeBlockElementType>) => ({
    type: "code-block",
    children,
    ...rest,
  }),
  render: (props) => (
    <CodeBlockElement
      {...props}
      attributes={
        {
          ...props.attributes,
          "data-block-id": props.element.blockId,
        } as typeof props.attributes
      }
      element={props.element}
    />
  ),
  normalize: normalizeCodeBlock,
  toMdast: (node) => {
    const text = node.children.map((c) => (c as CustomText).text).join("");
    const value = node.blockId
      ? `${text}${text.endsWith("\n") ? "" : "\n"}^${node.blockId}`
      : text;
    const code: Code = {
      type: "code",
      lang: node.language ?? null,
      value,
    };
    return code;
  },
};

export const makeCodeBlock = codeBlockDescriptor.create;
