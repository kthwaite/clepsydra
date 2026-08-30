import { Minus, Plus } from "lucide-react";
import type { Table, TableCell, TableRow } from "mdast";
import { useLayoutEffect } from "react";
import {
  Editor,
  type NodeEntry,
  type Path,
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
import {
  appendTableColumn,
  appendTableRow,
  deleteTableColumn,
  deleteTableRow,
} from "#/editor/transforms/table";
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

const TOUCH_CONTROL_TRACK_CLASS =
  "max-md:h-11 max-md:min-w-11 [@media(hover:none)]:h-11 [@media(hover:none)]:min-w-11";

function TableRenderer({ attributes, children, element }: TableRendererProps) {
  const editor = useSlateStatic();
  const readOnly = useReadOnly();
  const columnCount = Math.max(
    ...element.children.map((row) => row.children.length),
  );
  const shapeNeedsNormalization =
    element.align?.length !== columnCount ||
    element.children.some((row) => row.children.length !== columnCount);

  useLayoutEffect(() => {
    if (readOnly || !shapeNeedsNormalization) return;

    const normalize = () => {
      Editor.normalize(editor, { force: true });
    };
    if (HistoryEditor.isHistoryEditor(editor)) {
      HistoryEditor.withoutSaving(editor, normalize);
    } else {
      normalize();
    }
  }, [editor, readOnly, shapeNeedsNormalization]);

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
      <div
        className={cn(
          "min-w-0 max-w-full overflow-x-auto",
          readOnly
            ? null
            : "pl-6 pt-6 max-md:pl-11 max-md:pt-11 [@media(hover:none)]:pl-11 [@media(hover:none)]:pt-11",
        )}
      >
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

type TableCellRendererProps = RenderElementProps & {
  element: TableCellElement;
};

function tableCellCoordinates(path: Path) {
  const rowIndex = path.at(-2);
  const columnIndex = path.at(-1);
  if (rowIndex === undefined || columnIndex === undefined) {
    throw new Error("Table cell path must include row and column indices");
  }
  return { rowIndex, columnIndex };
}

function TableCellRenderer({
  attributes,
  children,
  element,
}: TableCellRendererProps) {
  const editor = useSlateStatic();
  const readOnly = useReadOnly();
  const cellPath = ReactEditor.findPath(editor, element);
  const { rowIndex, columnIndex } = tableCellCoordinates(cellPath);

  const selectAfterDelete = (path: number[] | null) => {
    if (path) Transforms.select(editor, Editor.start(editor, path));
  };

  const deleteColumn = () => {
    HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
      const currentCellPath = ReactEditor.findPath(editor, element);
      const tablePath = currentCellPath.slice(0, -2);
      const { columnIndex: currentColumnIndex } =
        tableCellCoordinates(currentCellPath);
      selectAfterDelete(
        deleteTableColumn(editor, tablePath, currentColumnIndex),
      );
    });
    ReactEditor.focus(editor);
  };

  const deleteRow = () => {
    HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
      const currentCellPath = ReactEditor.findPath(editor, element);
      const tablePath = currentCellPath.slice(0, -2);
      const { rowIndex: currentRowIndex } =
        tableCellCoordinates(currentCellPath);
      selectAfterDelete(deleteTableRow(editor, tablePath, currentRowIndex));
    });
    ReactEditor.focus(editor);
  };

  const controls = readOnly ? null : (
    <>
      {rowIndex === 0 ? (
        <button
          type="button"
          aria-label={`Delete column ${columnIndex + 1}`}
          contentEditable={false}
          className={cn(
            APPEND_BUTTON_CLASS,
            "absolute bottom-full left-1/2 -translate-x-1/2",
          )}
          onMouseDown={(event) => event.preventDefault()}
          onClick={deleteColumn}
        >
          <Minus aria-hidden size={14} strokeWidth={1.75} />
        </button>
      ) : null}
      {columnIndex === 0 ? (
        <button
          type="button"
          aria-label={`Delete row ${rowIndex + 1}`}
          contentEditable={false}
          className={cn(
            APPEND_BUTTON_CLASS,
            "absolute right-full top-1/2 -translate-y-1/2",
          )}
          onMouseDown={(event) => event.preventDefault()}
          onClick={deleteRow}
        >
          <Minus aria-hidden size={14} strokeWidth={1.75} />
        </button>
      ) : null}
    </>
  );

  return element.header ? (
    <th
      {...attributes}
      scope="col"
      className={cn(
        "relative border border-rule bg-paper-2 px-3 py-1.5 font-bold text-ink",
        readOnly ? null : TOUCH_CONTROL_TRACK_CLASS,
        element.align ? ALIGN_CLASS[element.align] : "text-left",
      )}
    >
      {children}
      {controls}
    </th>
  ) : (
    <td
      {...attributes}
      className={cn(
        "relative border border-rule px-3 py-1.5 align-top text-ink-2",
        readOnly ? null : TOUCH_CONTROL_TRACK_CLASS,
        element.align && ALIGN_CLASS[element.align],
      )}
    >
      {children}
      {controls}
    </td>
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

  const columnCount = Math.max(
    ...node.children.map((row) => row.children.length),
  );
  const align = Array.from(
    { length: columnCount },
    (_, columnIndex) => node.align?.[columnIndex] ?? null,
  );

  if (
    node.align?.length !== columnCount ||
    align.some(
      (columnAlign, columnIndex) => node.align?.[columnIndex] !== columnAlign,
    )
  ) {
    Transforms.setNodes(editor, { align } as Partial<TableElement>, {
      at: path,
    });
    return true;
  }

  for (let r = 0; r < node.children.length; r++) {
    const row = node.children[r];
    if (row.children.length < columnCount) {
      const columnIndex = row.children.length;
      const columnAlign = align[columnIndex];
      Transforms.insertNodes(
        editor,
        makeTableCell({
          ...(r === 0 ? { header: true as const } : {}),
          ...(columnAlign ? { align: columnAlign } : {}),
        }),
        { at: [...path, r, columnIndex] },
      );
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
  render: (props) => <TableCellRenderer {...props} />,
  normalize: normalizeTableCell,
};

export const makeTable = tableDescriptor.create;
export const makeTableRow = tableRowDescriptor.create;
export const makeTableCell = tableCellDescriptor.create;
