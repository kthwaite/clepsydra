import { Trash2 } from "lucide-react";
import type { Heading } from "mdast";
import {
  ReactEditor,
  useReadOnly,
  useSelected,
  useSlateStatic,
} from "slate-react";
import { Tick } from "#/components/codex/Tick";
import { useJournalDate } from "#/editor/journalContext";
import { removeJournalTimeHeading } from "#/editor/transforms/journalTime";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import type { CreateProps, ElementDescriptor } from "../descriptor";
import type { JournalTimeElement } from "../types";

function JournalTimeHeading({
  attributes,
  children,
  element,
}: Parameters<ElementDescriptor<JournalTimeElement>["render"]>[0]) {
  const editor = useSlateStatic();
  const selected = useSelected();
  const readOnly = useReadOnly();
  const journalDate = useJournalDate();
  const text = journalTimeText(element);
  // Inside the matching journal the date is implicit; the markdown keeps it.
  const showDate = element.date !== undefined && element.date !== journalDate;

  return (
    <div
      {...attributes}
      contentEditable={false}
      className={cn(
        "group relative -mx-3 mb-3 mt-8 flex items-center gap-3 rounded-[12px] px-3 py-1.5",
        selected && "bg-accent-tint",
      )}
      data-selected={selected || undefined}
    >
      <h2
        aria-label={`Time heading, ${text} local time`}
        className="flex min-w-0 flex-1 items-center gap-3 font-normal"
      >
        <Tick />
        <time
          dateTime={text}
          className="font-serif text-[24px] leading-none text-ink"
        >
          {showDate && <span>{element.date} </span>}
          {element.time}
        </time>
      </h2>
      {!readOnly && (
        <button
          type="button"
          aria-label={`Delete time heading ${text}`}
          className={cn(
            "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-mute transition-colors hover:bg-sink hover:text-ink group-hover:pointer-events-auto group-hover:opacity-100 focus:pointer-events-auto focus:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
            FOCUS_RING_NATIVE,
            selected
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0",
          )}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            removeJournalTimeHeading(
              editor,
              ReactEditor.findPath(editor, element),
            );
            ReactEditor.focus(editor);
          }}
        >
          <Trash2 aria-hidden="true" size={15} />
        </button>
      )}
      {children}
    </div>
  );
}

/** The heading text as written to markdown: `date time` or bare `time`. */
export function journalTimeText(
  node: Pick<JournalTimeElement, "date" | "time">,
): string {
  return node.date ? `${node.date} ${node.time}` : node.time;
}

export const journalTimeDescriptor: ElementDescriptor<JournalTimeElement> = {
  type: "journal-time",
  kind: "void-block",
  create: ({ date, time }: CreateProps<JournalTimeElement>) => ({
    type: "journal-time",
    ...(date ? { date } : {}),
    time,
    children: [{ text: "" }],
  }),
  render: (props) => <JournalTimeHeading {...props} />,
  toMdast: (node) => {
    const heading: Heading = {
      type: "heading",
      depth: 2,
      children: [{ type: "text", value: journalTimeText(node) }],
    };
    return heading;
  },
};

export const makeJournalTime = journalTimeDescriptor.create;
