import { type Element, Transforms } from "slate";
import {
  ReactEditor,
  type RenderElementProps,
  useSlateStatic,
} from "slate-react";
import type { ListItemElement } from "#/editor/types";
import { BlockRefElement } from "./BlockRefElement";
import { CodeBlockElement } from "./CodeBlockElement";
import { FootnoteRefElement } from "./FootnoteRefElement";
import { LinkElement } from "./LinkElement";
import { WikilinkElement } from "./WikilinkElement";

export function renderElement(props: RenderElementProps) {
  const { attributes, children, element } = props;

  switch (element.type) {
    case "heading": {
      const Tag = `h${element.level}` as const;
      // Vessel tactical headings: Satoshi display; h2/h3 carry section rules.
      const headingClasses: Record<number, string> = {
        1: "mb-4 mt-8 font-sans text-[28px] font-black tracking-[-0.01em] text-ink",
        2: "mb-3 mt-8 border-t border-rule pt-3 font-sans text-[20px] font-bold text-ink",
        3: "mb-2 mt-6 border-t border-rule-soft pt-2 font-sans text-[16px] font-semibold text-ink",
        4: "mb-2 mt-4 font-sans text-[14px] font-semibold text-ink",
        5: "mb-1 mt-3 font-sans text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-2",
        6: "mb-1 mt-3 font-sans text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-mute",
      };
      return (
        <Tag {...attributes} className={headingClasses[element.level]}>
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
          className="my-4 border-l-2 border-accent bg-paper-2 py-2 pl-4 pr-3 text-[0.97em] italic text-ink-2"
        >
          {children}
        </blockquote>
      );

    case "bulleted-list":
      return (
        <ul {...attributes} className="list-['▸'] pl-5 marker:text-accent">
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

    case "link":
      return <LinkElement {...props} element={element} />;

    case "footnote-ref":
      return <FootnoteRefElement {...props} element={element} />;

    case "footnote-def":
      return (
        <div
          {...attributes}
          className="cl-footnote-def mt-1 flex gap-2 border-t border-rule-soft pt-1 text-[0.85em] text-ink-mute"
        >
          <span contentEditable={false} className="cl-mono text-accent select-none">
            [{element.identifier}]
          </span>
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      );

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
