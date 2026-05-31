import { type Element, Transforms } from "slate";
import { ReactEditor, type RenderElementProps, useSlateStatic } from "slate-react";
import type { CreateProps, ElementDescriptor } from "../descriptor";
import type {
  BulletedListElement,
  ListItemElement,
  NumberedListElement,
} from "../types";

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
};

export const makeBulletedList = bulletedListDescriptor.create;
export const makeNumberedList = numberedListDescriptor.create;
export const makeListItem = listItemDescriptor.create;
