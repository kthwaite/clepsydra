import { Trash2 } from "lucide-react";
import type { Heading } from "mdast";
import { ReactEditor, useSelected, useSlateStatic } from "slate-react";
import { removeJournalTimeHeading } from "#/editor/transforms/journalTime";
import type { CreateProps, ElementDescriptor } from "../descriptor";
import type { JournalTimeElement } from "../types";

function JournalTimeHeading({
  attributes,
  children,
  element,
}: Parameters<ElementDescriptor<JournalTimeElement>["render"]>[0]) {
  const editor = useSlateStatic();
  const selected = useSelected();

  return (
    <div
      {...attributes}
      contentEditable={false}
      className={`group relative my-8 flex items-center gap-3 border-y border-border py-2 font-mono ${selected ? "border-accent bg-accent/10 text-ink" : "text-ink-mute"}`}
      data-selected={selected || undefined}
    >
      <h2
        aria-label={`Time heading, ${element.time} local time`}
        className="flex shrink-0 items-baseline gap-2 text-xs font-bold tracking-[0.14em]"
      >
        <span aria-hidden="true" className="text-accent">
          TIME /
        </span>
        <time dateTime={element.time} className="text-ink">
          {element.time}
        </time>
      </h2>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
      <button
        type="button"
        aria-label={`Delete time heading ${element.time}`}
        className={`shrink-0 border border-transparent p-1 text-ink-mute group-hover:pointer-events-auto group-hover:opacity-100 focus:pointer-events-auto focus:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:border-border hover:text-accent focus-visible:border-accent focus-visible:text-accent focus-visible:outline-none ${selected ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          removeJournalTimeHeading(
            editor,
            ReactEditor.findPath(editor, element),
          );
          ReactEditor.focus(editor);
        }}
      >
        <Trash2 aria-hidden="true" size={14} />
      </button>
      {children}
    </div>
  );
}

export const journalTimeDescriptor: ElementDescriptor<JournalTimeElement> = {
  type: "journal-time",
  kind: "void-block",
  create: ({ time }: CreateProps<JournalTimeElement>) => ({
    type: "journal-time",
    time,
    children: [{ text: "" }],
  }),
  render: (props) => <JournalTimeHeading {...props} />,
  toMdast: (node) => {
    const heading: Heading = {
      type: "heading",
      depth: 2,
      children: [{ type: "text", value: node.time }],
    };
    return heading;
  },
};

export const makeJournalTime = journalTimeDescriptor.create;
