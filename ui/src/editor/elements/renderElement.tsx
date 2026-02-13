import type { RenderElementProps } from "slate-react";
import { CodeBlockElement } from "./CodeBlockElement";
import { WikilinkElement } from "./WikilinkElement";

export function renderElement(props: RenderElementProps) {
  const { attributes, children, element } = props;

  switch (element.type) {
    case "heading": {
      const Tag = `h${element.level}` as const;
      const sizeClasses: Record<number, string> = {
        1: "mb-4 mt-8 text-2xl font-bold",
        2: "mb-3 mt-6 text-xl font-bold",
        3: "mb-2 mt-4 text-lg font-bold",
        4: "mb-2 mt-4 text-base font-bold",
        5: "mb-1 mt-3 text-sm font-bold",
        6: "mb-1 mt-3 text-xs font-bold",
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
      return <li {...attributes}>{children}</li>;

    case "thematic-break":
      return (
        <div {...attributes} contentEditable={false}>
          <hr className="my-6 border-border" />
          {children}
        </div>
      );

    case "wikilink":
      return <WikilinkElement {...props} element={element} />;

    case "link":
      return (
        <a
          {...attributes}
          href={element.url}
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

    case "paragraph":
    default:
      return <p {...attributes}>{children}</p>;
  }
}
