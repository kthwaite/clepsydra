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
import type { CreateProps, ElementDescriptor } from "../descriptor";
import type {
  BulletedListElement,
  ListItemElement,
  NumberedListElement,
} from "../types";
import { makeParagraph } from "./paragraph";

// ---------------------------------------------------------------------------
// Task property chips — read-only ledger stamps for due / scheduled / priority
// ---------------------------------------------------------------------------

/** Mirrors Agenda Todo priority labels so the row and editor agree. */
function priorityLabel(value: string): string {
  switch (value) {
    case "A":
      return "HIGH";
    case "B":
      return "MED";
    case "C":
      return "LOW";
    default:
      return value.toUpperCase();
  }
}

interface ChipSpec {
  /** Ledger prefix shown before the value; empty for self-describing values. */
  prefix: string;
  /** Word that opens the accessible name. */
  name: string;
  display: (value: string) => string;
}

const CHIP_SPECS: Record<TaskPropertyKey, ChipSpec> = {
  due: { prefix: "DUE", name: "Due", display: (value) => value },
  scheduled: { prefix: "SCHED", name: "Scheduled", display: (value) => value },
  priority: { prefix: "", name: "Priority", display: priorityLabel },
};

const CHIP_CLASS =
  "cl-mono inline-flex items-center border border-rule px-1 py-px text-[10px] uppercase leading-none tracking-wider text-ink-mute";

const CHIP_INTERACTIVE =
  "cursor-pointer hover:border-ink-mute hover:text-ink focus-visible:border-accent focus-visible:text-accent focus-visible:outline-none";

interface TaskPropertyChip {
  key: string;
  text: string;
  name: string;
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
    const display = spec.display(value);
    chips.push({
      key,
      text: spec.prefix ? `${spec.prefix} ${display}` : display,
      name: `${spec.name} ${display}`,
    });
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
        "ml-2 shrink-0 select-none space-x-1 whitespace-nowrap",
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
            className={cn(CHIP_CLASS, !readOnly && CHIP_INTERACTIVE)}
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
        checked === true && "line-through text-muted-foreground",
      )}
    >
      <label
        contentEditable={false}
        className="mr-2 inline-flex size-4 shrink-0 cursor-pointer select-none max-md:-ml-3.5 max-md:min-h-11 max-md:min-w-11 max-md:items-start max-md:justify-start max-md:pt-1 max-md:pl-3.5"
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
          className="accent-foreground"
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
    <ol {...attributes} className="list-decimal pl-6">
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
