import { type Element, Transforms } from "slate";
import {
  type RenderElementProps,
  ReactEditor,
  useSlateStatic,
} from "slate-react";
import type { ListItemElement } from "#/editor/types";
import { BlockRefElement } from "./BlockRefElement";
import { CodeBlockElement } from "./CodeBlockElement";
import { WikilinkElement } from "./WikilinkElement";

export function renderElement(props: RenderElementProps) {
  const { attributes, children, element } = props;

  switch (element.type) {
    case "heading": {
      const Tag = `h${element.level}` as const;
      const sizeClasses: Record<number, string> = {
        1: "mb-4 mt-8 font-heading text-2xl font-bold",
        2: "mb-3 mt-6 font-heading text-xl font-bold",
        3: "mb-2 mt-4 font-heading text-lg font-semibold",
        4: "mb-2 mt-4 font-heading text-base font-semibold",
        5: "mb-1 mt-3 font-heading text-sm font-semibold",
        6: "mb-1 mt-3 font-heading text-xs font-semibold",
      };
      return (
        <Tag {...attributes} className={sizeClasses[element.level]}>
          {children}
        </Tag>
      );
    }

    case "code-block":
      return <CodeBlockElement {...props} element={element} />;

    case "blockquote":
      return (
        <blockquote
          {...attributes}
          className="border-l-4 border-border pl-4 italic text-muted-foreground"
        >
          {children}
        </blockquote>
      );

    case "bulleted-list":
      return (
        <ul {...attributes} className="list-disc pl-6">
          {children}
        </ul>
      );

    case "numbered-list":
      return (
        <ol {...attributes} className="list-decimal pl-6">
          {children}
        </ol>
      );

    case "list-item":
      return (
        <ListItem attributes={attributes} element={element}>
          {children}
        </ListItem>
      );

    case "thematic-break":
      return (
        <div {...attributes} contentEditable={false}>
          <hr className="my-6 border-border" />
          {children}
        </div>
      );

    case "wikilink":
      return <WikilinkElement {...props} element={element} />;

    case "block-ref":
      return <BlockRefElement {...props} element={element} />;

    case "link": {
      const isSafeUrl = /^https?:|^mailto:/i.test(element.url);
      return (
        <a
          {...attributes}
          href={isSafeUrl ? element.url : undefined}
          className="underline decoration-1 underline-offset-2 hover:decoration-2"
          onClick={(e) => {
            if (!e.metaKey && !e.ctrlKey) {
              e.preventDefault();
            }
          }}
        >
          {children}
        </a>
      );
    }

    case "paragraph":
    default:
      return <p {...attributes}>{children}</p>;
  }
}

// ---------------------------------------------------------------------------
// ListItem — renders an interactive checkbox when `checked` is set
// ---------------------------------------------------------------------------

function ListItem({
  attributes,
  element,
  children,
}: {
  attributes: RenderElementProps["attributes"];
  element: RenderElementProps["element"];
  children: React.ReactNode;
}) {
  const editor = useSlateStatic();
  const checked = (element as ListItemElement).checked;
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
