import { Plus } from "lucide-react";
import type { Table, TableCell, TableRow } from "mdast";
import {
  Editor,
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
import { appendTableColumn, appendTableRow } from "#/editor/transforms/table";
import { cn } from "#/lib/cn";
import type { CreateProps, ElementDescriptor } from "../descriptor";
import type {
  TableAlign,
  TableCellElement,
  TableElement,
  TableRowElement,
} from "../types";

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const ALIGN_CLASS: Record<TableAlign, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

type TableRendererProps = RenderElementProps & { element: TableElement };

const APPEND_BUTTON_CLASS =
  "pointer-events-none z-10 flex size-6 cursor-pointer items-center justify-center rounded-full border border-rule bg-paper text-ink-mute opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:border-accent hover:text-accent focus:pointer-events-auto focus:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent max-md:size-11 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:size-11 [@media(hover:none)]:opacity-100";

function TableRenderer({ attributes, children, element }: TableRendererProps) {
  const editor = useSlateStatic();
  const readOnly = useReadOnly();

  const appendColumn = () => {
    HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
      const tablePath = ReactEditor.findPath(editor, element);
      const cellPath = appendTableColumn(editor, tablePath);
      Transforms.select(editor, Editor.start(editor, cellPath));
    });
    ReactEditor.focus(editor);
  };

  const appendRow = () => {
    HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
      const tablePath = ReactEditor.findPath(editor, element);
      const cellPath = appendTableRow(editor, tablePath);
      Transforms.select(editor, Editor.start(editor, cellPath));
    });
    ReactEditor.focus(editor);
  };

  return (
    <div
      {...attributes}
      className={cn(
        "group my-4 max-w-full",
        readOnly
          ? null
          : "grid grid-cols-[minmax(0,1fr)_1.5rem] grid-rows-[auto_1.5rem] max-md:grid-cols-[minmax(0,1fr)_2.75rem] max-md:grid-rows-[auto_2.75rem] [@media(hover:none)]:grid-cols-[minmax(0,1fr)_2.75rem] [@media(hover:none)]:grid-rows-[auto_2.75rem]",
      )}
    >
      {/* The table keeps its own scroll port; controls occupy reserved gutters
          outside it, clear of both the scrollbar and following content. */}
      <div className="min-w-0 max-w-full overflow-x-auto">
        <table className="w-full border-collapse border border-rule text-[0.95em]">
          <tbody>{children}</tbody>
        </table>
      </div>
      {readOnly ? null : (
        <>
          <button
            type="button"
            aria-label="Add column"
            contentEditable={false}
            className={cn(
              APPEND_BUTTON_CLASS,
              "col-start-2 row-start-1 place-self-center",
            )}
            onMouseDown={(event) => event.preventDefault()}
            onClick={appendColumn}
          >
            <Plus aria-hidden size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label="Add row"
            contentEditable={false}
            className={cn(
              APPEND_BUTTON_CLASS,
              "col-start-1 row-start-2 place-self-center",
            )}
            onMouseDown={(event) => event.preventDefault()}
            onClick={appendRow}
          >
            <Plus aria-hidden size={14} strokeWidth={1.75} />
          </button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Normalization
//
// A table's shape is positional: the leading row is the header and a column's
// alignment comes from the delimiter row. Both are mirrored onto the cells so
// rendering stays a pure function of the cell node; these rules keep the mirror
// honest after edits (row/cell insertion, deletion, paste).
// ---------------------------------------------------------------------------

function normalizeTable(
  entry: NodeEntry<TableElement>,
  editor: Editor,
): boolean {
  const [node, path] = entry;

  // An empty table cannot hold a caret and has no markdown form.
  if (node.children.length === 0) {
    Transforms.removeNodes(editor, { at: path });
    return true;
  }

  for (let r = 0; r < node.children.length; r++) {
    const row = node.children[r];
    if (!(SlateElement.isElement(row) && row.type === "table-row")) {
      // Wrap the stray child in a row at its position (one fix per pass).
      Transforms.wrapNodes(editor, makeTableRow({ children: [] }), {
        at: [...path, r],
      });
      return true;
    }
  }

  for (let r = 0; r < node.children.length; r++) {
    const row = node.children[r];
    for (let c = 0; c < row.children.length; c++) {
      const cell = row.children[c];
      if (!(SlateElement.isElement(cell) && cell.type === "table-cell")) {
        continue; // the row's own rule wraps it
      }
      const header = r === 0 ? (true as const) : undefined;
      const align = node.align?.[c] ?? null;
      if (cell.header !== header || (cell.align ?? null) !== align) {
        // `undefined` unsets the property rather than storing it.
        Transforms.setNodes(
          editor,
          { header, align: align ?? undefined } as Partial<TableCellElement>,
          { at: [...path, r, c] },
        );
        return true;
      }
    }
  }

  return false; // nothing to fix → fall through to defaults
}

function normalizeTableRow(
  entry: NodeEntry<TableRowElement>,
  editor: Editor,
): boolean {
  const [node, path] = entry;

  if (node.children.length === 0) {
    Transforms.insertNodes(editor, makeTableCell({}), { at: [...path, 0] });
    return true;
  }

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (!(SlateElement.isElement(child) && child.type === "table-cell")) {
      Transforms.wrapNodes(editor, makeTableCell({ children: [] }), {
        at: [...path, i],
      });
      return true;
    }
  }

  return false;
}

function normalizeTableCell(
  entry: NodeEntry<TableCellElement>,
  editor: Editor,
): boolean {
  const [node, path] = entry;

  // A GFM cell is a single line of phrasing content. Block content (a pasted
  // paragraph, say) is flattened to its inline children rather than dropped —
  // Slate's default rule would delete one side of the mixed children outright.
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (!SlateElement.isElement(child) || editor.isInline(child)) continue;
    Transforms.unwrapNodes(editor, { at: [...path, i] });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Column alignment for the delimiter row. `table.align` is authoritative; a
 * table assembled without it (a Slate fragment from elsewhere) falls back to
 * the header cells' mirrored values. `undefined` emits a plain `| --- |`.
 */
function columnAlign(node: TableElement): (TableAlign | null)[] | undefined {
  if (node.align && node.align.length > 0) {
    return node.align.map((a) => a ?? null);
  }
  const header = node.children[0];
  if (!header) return undefined;
  const derived = header.children.map((cell) => cell.align ?? null);
  return derived.some((a) => a !== null) ? derived : undefined;
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

export const tableDescriptor: ElementDescriptor<TableElement> = {
  type: "table",
  kind: "block",
  create: ({ children = [], ...rest }: CreateProps<TableElement>) => ({
    type: "table",
    ...rest,
    children,
  }),
  render: (props) => <TableRenderer {...props} />,
  normalize: normalizeTable,
  toMdast: (node, ctx) => {
    const table: Table = {
      type: "table",
      align: columnAlign(node),
      children: node.children.map(
        (row): TableRow => ({
          type: "tableRow",
          children: row.children.map(
            (cell): TableCell => ({
              type: "tableCell",
              children: ctx.inlineChildren(cell.children),
            }),
          ),
        }),
      ),
    };
    return table;
  },
};

export const tableRowDescriptor: ElementDescriptor<TableRowElement> = {
  type: "table-row",
  kind: "block",
  create: ({ children = [] }: CreateProps<TableRowElement>) => ({
    type: "table-row",
    children,
  }),
  render: ({ attributes, children }) => <tr {...attributes}>{children}</tr>,
  normalize: normalizeTableRow,
};

export const tableCellDescriptor: ElementDescriptor<TableCellElement> = {
  type: "table-cell",
  kind: "block",
  create: ({
    children = [{ text: "" }],
    ...rest
  }: CreateProps<TableCellElement>) => ({
    type: "table-cell",
    ...rest,
    children,
  }),
  render: ({ attributes, children, element }) =>
    element.header ? (
      <th
        {...attributes}
        scope="col"
        className={cn(
          "border border-rule bg-paper-2 px-3 py-1.5 font-bold text-ink",
          element.align ? ALIGN_CLASS[element.align] : "text-left",
        )}
      >
        {children}
      </th>
    ) : (
      <td
        {...attributes}
        className={cn(
          "border border-rule px-3 py-1.5 align-top text-ink-2",
          element.align && ALIGN_CLASS[element.align],
        )}
      >
        {children}
      </td>
    ),
  normalize: normalizeTableCell,
};

export const makeTable = tableDescriptor.create;
export const makeTableRow = tableRowDescriptor.create;
export const makeTableCell = tableCellDescriptor.create;
