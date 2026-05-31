import {
  type Editor,
  type Element,
  Element as SlateElement,
  type NodeEntry,
  Transforms,
} from "slate";
import { ReactEditor, type RenderElementProps, useSlateStatic } from "slate-react";
import type { CreateProps, ElementDescriptor } from "../descriptor";
import type {
  BulletedListElement,
  ListItemElement,
  NumberedListElement,
} from "../types";
import { makeParagraph } from "./paragraph";

// ---------------------------------------------------------------------------
// ListItem — renders an interactive checkbox when `checked` is set
// ---------------------------------------------------------------------------

function ListItem({
  attributes,
  element,
  children,
}: {
  attributes: RenderElementProps["attributes"];
  element: ListItemElement;
  children: React.ReactNode;
}) {
  const editor = useSlateStatic();
  const checked = element.checked;
  const isTask = checked !== undefined && checked !== null;

  if (!isTask) {
    return <li {...attributes}>{children}</li>;
  }

  return (
    <li
      {...attributes}
      className={checked === true ? "line-through text-muted-foreground" : ""}
    >
      <span
        contentEditable={false}
        className="mr-2 inline-flex cursor-pointer select-none align-text-top"
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => {
            e.preventDefault();
            const path = ReactEditor.findPath(editor, element);
            Transforms.setNodes(
              editor,
              { checked: !checked } as Partial<Element>,
              { at: path },
            );
          }}
          className="accent-foreground"
        />
      </span>
      {children}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Shared list normalizer — wraps non-list-item children in a list-item
// ---------------------------------------------------------------------------

function normalizeList(
  entry: NodeEntry<BulletedListElement | NumberedListElement>,
  editor: Editor,
): boolean {
  const [node, path] = entry;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (!(SlateElement.isElement(child) && child.type === "list-item")) {
      // Wrap the stray child in a list-item at its position (one fix per pass).
      Transforms.wrapNodes(editor, makeListItem({ children: [] }), {
        at: [...path, i],
      });
      return true;
    }
  }
  return false; // nothing to fix → fall through to defaults
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

export const bulletedListDescriptor: ElementDescriptor<BulletedListElement> = {
  type: "bulleted-list",
  kind: "block",
  create: ({ children = [] }: CreateProps<BulletedListElement>) => ({
    type: "bulleted-list",
    children,
  }),
  render: ({ attributes, children }) => (
    <ul {...attributes} className="list-['▸'] pl-5 marker:text-accent">
      {children}
    </ul>
  ),
  normalize: normalizeList,
};

export const numberedListDescriptor: ElementDescriptor<NumberedListElement> = {
  type: "numbered-list",
  kind: "block",
  create: ({ children = [] }: CreateProps<NumberedListElement>) => ({
    type: "numbered-list",
    children,
  }),
  render: ({ attributes, children }) => (
    <ol {...attributes} className="list-decimal pl-6">
      {children}
    </ol>
  ),
  normalize: normalizeList,
};

export const listItemDescriptor: ElementDescriptor<ListItemElement> = {
  type: "list-item",
  kind: "block",
  create: ({
    children = [{ type: "paragraph", children: [{ text: "" }] }],
    ...rest
  }: CreateProps<ListItemElement>) => ({
    type: "list-item",
    ...rest,
    children,
  }),
  render: ({ attributes, element, children }) => (
    <ListItem attributes={attributes} element={element}>
      {children}
    </ListItem>
  ),
  normalize: (entry, editor) => {
    const [node, path] = entry;
    // Ensure at least one child exists (Slate requires it).
    if (node.children.length === 0) {
      Transforms.insertNodes(editor, makeParagraph({}), { at: [...path, 0] });
      return true;
    }
    // Claim the node to suppress Slate's default block-flattening of mixed
    // (text + nested list) content — preserves the outliner's nesting.
    return true;
  },
};

export const makeBulletedList = bulletedListDescriptor.create;
export const makeNumberedList = numberedListDescriptor.create;
export const makeListItem = listItemDescriptor.create;
