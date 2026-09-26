import type { List } from "mdast";
import { Children } from "react";
import {
  type Editor,
  type Element,
  Node,
  type NodeEntry,
  Element as SlateElement,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import {
  ReactEditor,
  type RenderElementProps,
  useReadOnly,
  useSlateStatic,
} from "slate-react";
import { TASK_PROPERTY_KEYS, type TaskPropertyKey } from "#/editor/properties";
import { useTaskPropertyPopover } from "#/editor/taskPropertyContext";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { formatDayMonth } from "#/lib/time";
import type { CreateProps, ElementDescriptor } from "../descriptor";
import type {
  BulletedListElement,
  ListItemElement,
  NumberedListElement,
} from "../types";
import { makeParagraph } from "./paragraph";

// ---------------------------------------------------------------------------
// Task property chips — pills for due / scheduled / priority
// ---------------------------------------------------------------------------

/** Matches the todo-properties popover's High / Medium / Low segments. */
function priorityLabel(value: string): string {
  switch (value) {
    case "A":
      return "High";
    case "B":
      return "Medium";
    case "C":
      return "Low";
    default:
      return value.toUpperCase();
  }
}

interface ChipSpec {
  /** Word shown before a date and opening the accessible name. */
  name: string;
  /** Dates read as "30 Sep" on the chip; the name keeps the ISO day. */
  isDate: boolean;
}

const CHIP_SPECS: Record<TaskPropertyKey, ChipSpec> = {
  due: { name: "Due", isDate: true },
  scheduled: { name: "Scheduled", isDate: true },
  priority: { name: "Priority", isDate: false },
};

const CHIP_CLASS =
  "inline-flex h-6 items-center rounded-full px-2.5 align-middle text-[12.5px] leading-none no-underline";

/** Dates carry the accent tint (they are the actionable part of a todo);
 *  priority sits quiet on sink. */
const CHIP_TONE: Record<"date" | "plain", string> = {
  date: "bg-accent-tint text-accent",
  plain: "bg-sink text-mute",
};

const CHIP_INTERACTIVE = cn(
  "cursor-pointer transition-colors hover:text-ink",
  FOCUS_RING_NATIVE,
);

interface TaskPropertyChip {
  key: string;
  text: string;
  name: string;
  tone: "date" | "plain";
}

function taskPropertyChips(
  properties: Record<string, string> | undefined,
): TaskPropertyChip[] {
  if (!properties) return [];
  const chips: TaskPropertyChip[] = [];
  for (const key of TASK_PROPERTY_KEYS) {
    const value = properties[key];
    if (!value) continue;
    const spec = CHIP_SPECS[key];
    if (spec.isDate) {
      chips.push({
        key,
        text: `${spec.name} ${formatDayMonth(value)}`,
        name: `${spec.name} ${value}`,
        tone: "date",
      });
    } else {
      const display = priorityLabel(value);
      chips.push({
        key,
        text: display,
        name: `${spec.name} ${display}`,
        tone: "plain",
      });
    }
  }
  return chips;
}

function TaskPropertyControls({ element }: { element: ListItemElement }) {
  const editor = useSlateStatic();
  const readOnly = useReadOnly();
  const popover = useTaskPropertyPopover();
  const chips = taskPropertyChips(element.properties);

  // Nothing to display and nothing to edit.
  if (readOnly && chips.length === 0) return null;

  const open = (event: React.MouseEvent<HTMLButtonElement>) => {
    popover?.openForPath(
      ReactEditor.findPath(editor, element),
      event.currentTarget,
    );
  };
  // Keep the caret where it was — the popover edits the node, not the text.
  const keepSelection = (event: React.MouseEvent<HTMLButtonElement>) =>
    event.preventDefault();

  return (
    <span
      contentEditable={false}
      data-task-properties=""
      className={cn(
        "ml-2 shrink-0 select-none space-x-1.5 whitespace-nowrap",
        chips.length === 0 && "max-md:hidden",
      )}
    >
      {chips.length > 0 ? (
        chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            aria-label={chip.name}
            disabled={readOnly}
            className={cn(
              CHIP_CLASS,
              CHIP_TONE[chip.tone],
              !readOnly && CHIP_INTERACTIVE,
            )}
            onMouseDown={keepSelection}
            onClick={open}
          >
            {chip.text}
          </button>
        ))
      ) : (
        <button
          type="button"
          aria-label="Todo properties"
          className={cn(
            CHIP_CLASS,
            CHIP_TONE.plain,
            CHIP_INTERACTIVE,
            "opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100",
          )}
          onMouseDown={keepSelection}
          onClick={open}
        >
          +
        </button>
      )}
    </span>
  );
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
  element: ListItemElement;
  children: React.ReactNode;
}) {
  const editor = useSlateStatic();
  const readOnly = useReadOnly();
  const checked = element.checked;
  const isTask = checked !== undefined && checked !== null;

  if (!isTask) {
    return (
      <li {...attributes} data-block-id={element.blockId}>
        {children}
      </li>
    );
  }
  const label = Node.string(element);
  const renderedChildren = Children.toArray(children);
  const firstNestedListIndex = element.children.findIndex(
    (child) =>
      SlateElement.isElement(child) &&
      (child.type === "bulleted-list" || child.type === "numbered-list"),
  );
  const firstRowEnd =
    firstNestedListIndex === -1
      ? renderedChildren.length
      : firstNestedListIndex;

  return (
    <li
      {...attributes}
      data-block-id={element.blockId}
      className={cn(
        "group flex items-baseline max-md:items-start",
        checked === true && "text-mute line-through",
      )}
    >
      <label
        contentEditable={false}
        className="mr-3 inline-flex size-4 shrink-0 cursor-pointer select-none max-md:-ml-3.5 max-md:min-h-11 max-md:min-w-11 max-md:items-start max-md:justify-start max-md:pt-1 max-md:pl-3.5"
      >
        <input
          type="checkbox"
          aria-label={label}
          checked={checked}
          disabled={readOnly}
          onChange={() => {
            if (readOnly) return;
            HistoryEditor.withNewBatch(editor, () => {
              const path = ReactEditor.findPath(editor, element);
              Transforms.setNodes(
                editor,
                { checked: !checked } as Partial<Element>,
                { at: path },
              );
            });
          }}
          className="size-4 cursor-pointer accent-accent disabled:cursor-default"
        />
      </label>
      {/* Chips sit outside the content column so they stay on the first line
          even when the item carries a nested sub-list. */}
      <div data-task-content="" className="min-w-0 flex-1">
        <div data-task-content-row="" className="max-md:min-h-11">
          {renderedChildren.slice(0, firstRowEnd)}
        </div>
        {renderedChildren.slice(firstRowEnd)}
      </div>
      <TaskPropertyControls element={element} />
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
    <ul {...attributes} className="list-disc marker:text-accent">
      {children}
    </ul>
  ),
  normalize: normalizeList,
  toMdast: (node, ctx) => {
    const list: List = {
      type: "list",
      ordered: false,
      spread: false,
      children: node.children.map(ctx.listItem),
    };
    return list;
  },
};

export const numberedListDescriptor: ElementDescriptor<NumberedListElement> = {
  type: "numbered-list",
  kind: "block",
  create: ({ children = [] }: CreateProps<NumberedListElement>) => ({
    type: "numbered-list",
    children,
  }),
  render: ({ attributes, children }) => (
    <ol {...attributes} className="list-decimal pl-6 marker:text-mute">
      {children}
    </ol>
  ),
  normalize: normalizeList,
  toMdast: (node, ctx) => {
    const list: List = {
      type: "list",
      ordered: true,
      start: 1,
      spread: false,
      children: node.children.map(ctx.listItem),
    };
    return list;
  },
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
  toMdast: (node, ctx) => {
    // list-item at top level is unusual; wrap in unordered list
    const li = ctx.listItem(node);
    const list: List = {
      type: "list",
      ordered: false,
      spread: false,
      children: [li],
    };
    return list;
  },
};

export const makeBulletedList = bulletedListDescriptor.create;
export const makeNumberedList = numberedListDescriptor.create;
export const makeListItem = listItemDescriptor.create;
