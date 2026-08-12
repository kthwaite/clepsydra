import type { RootContent } from "mdast";
import { Element as SlateElement, Text, Transforms } from "slate";
import type {
  FolioInlineMathMdast,
  FolioMathMdast,
} from "#/editor/convert/mdastTypes";
import { MathElement } from "#/editor/elements/MathElement";
import type { ElementDescriptor } from "../descriptor";
import type { InlineMathElement, MathBlockElement } from "../types";

function normalizeMath<T extends InlineMathElement | MathBlockElement>(
  entry: Parameters<NonNullable<ElementDescriptor<T>["normalize"]>>[0],
  editor: Parameters<NonNullable<ElementDescriptor<T>["normalize"]>>[1],
): boolean {
  const [node, path] = entry;
  if (!SlateElement.isElement(node)) return false;

  const persisted = node as unknown as Record<string, unknown>;
  if (typeof persisted.tex !== "string") {
    Transforms.setNodes(editor, { tex: String(persisted.tex ?? "") } as never, {
      at: path,
    });
    return true;
  }

  const inline = node.type === "inline-math";
  const delimiter = persisted.delimiter;
  const validDelimiter = inline
    ? delimiter === "$" || delimiter === "\\("
    : delimiter === "$$" || delimiter === "\\[";
  if (!validDelimiter) {
    Transforms.setNodes(editor, { delimiter: inline ? "$" : "$$" } as never, {
      at: path,
    });
    return true;
  }

  if (node.children.length === 0) {
    Transforms.insertNodes(
      editor,
      { text: "" },
      {
        at: path.concat(0),
        voids: true,
      },
    );
    return true;
  }
  const child = node.children[0];
  const childIsEmptyText =
    node.children.length === 1 &&
    Text.isText(child) &&
    child.text === "" &&
    Object.keys(child).length === 1;
  if (!childIsEmptyText) {
    Transforms.removeNodes(editor, {
      at: path,
      match: (_, childPath) => childPath.length === path.length + 1,
      voids: true,
    });
    return true;
  }

  return false;
}

export const inlineMathDescriptor: ElementDescriptor<InlineMathElement> = {
  type: "inline-math",
  kind: "inline-void",
  create: ({ tex, delimiter }) => ({
    type: "inline-math",
    tex,
    delimiter,
    children: [{ text: "" }],
  }),
  render: (props) => <MathElement {...props} element={props.element} />,
  normalize: normalizeMath,
  toMdast: (node) =>
    ({
      type: "inlineMath",
      value: node.tex,
      data: {
        folioDelimiter: node.delimiter,
        folioSourceBody: node.tex,
      },
    }) satisfies FolioInlineMathMdast as unknown as RootContent,
};

export const mathBlockDescriptor: ElementDescriptor<MathBlockElement> = {
  type: "math-block",
  kind: "void-block",
  create: ({ tex, delimiter }) => ({
    type: "math-block",
    tex,
    delimiter,
    children: [{ text: "" }],
  }),
  render: (props) => <MathElement {...props} element={props.element} />,
  normalize: normalizeMath,
  toMdast: (node) =>
    ({
      type: "math",
      value: node.tex,
      data: {
        folioDelimiter: node.delimiter,
        folioSourceBody: node.tex,
      },
    }) satisfies FolioMathMdast as unknown as RootContent,
};

export const makeInlineMath = inlineMathDescriptor.create;
export const makeMathBlock = mathBlockDescriptor.create;
