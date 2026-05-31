import type { Code } from "mdast";
import { type Editor, Element as SlateElement, Node, Transforms, type NodeEntry } from "slate";
import { CodeBlockElement } from "#/editor/elements/CodeBlockElement";
import type { CreateProps, ElementDescriptor } from "../descriptor";
import type { CodeBlockElement as CodeBlockElementType, CustomText } from "../types";

const CODE_MARKS = ["bold", "italic", "underline", "code", "strikethrough"] as const;

function normalizeCodeBlock(entry: NodeEntry<CodeBlockElementType>, editor: Editor): boolean {
  const [node, path] = entry;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (SlateElement.isElement(child)) {
      // Replace an element child with its plain text (one fix per pass).
      Transforms.removeNodes(editor, { at: [...path, i] });
      Transforms.insertNodes(editor, { text: Node.string(child) }, { at: [...path, i] });
      return true;
    }
    const marks = CODE_MARKS.filter((m) => (child as unknown as Record<string, unknown>)[m]);
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
  create: ({ children = [{ text: "" }], ...rest }: CreateProps<CodeBlockElementType>) => ({
    type: "code-block",
    children,
    ...rest,
  }),
  render: (props) => <CodeBlockElement {...props} element={props.element} />,
  normalize: normalizeCodeBlock,
  toMdast: (node) => {
    const value = node.children.map((c) => (c as CustomText).text).join("");
    const code: Code = {
      type: "code",
      lang: node.language ?? null,
      value,
    };
    return code;
  },
};

export const makeCodeBlock = codeBlockDescriptor.create;
