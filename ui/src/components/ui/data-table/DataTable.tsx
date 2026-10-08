import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  attachClosestEdge,
  extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import {
  type ColumnDef,
  columnOrderingFeature,
  columnPinningFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  type RowData,
  type RowSelectionState,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import {
  type MouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ColumnDropEdge,
  moveColumnBy,
  moveColumnTo,
} from "#/components/ui/data-table/column-reorder";
import { useGridNavigation } from "#/components/ui/data-table/grid-navigation";
import { useWidthDrag, WidthResizer } from "#/components/ui/width-resizer";
import { cn } from "#/lib/cn";

export type { RowSelectionState };

export type SortDirection = "ascending" | "descending";

export interface DataColumn<TRow> {
  id: string;
  /** Names the column in its resizer ("Resize the {label} column") and in
   *  reorder announcements. The default header. */
  label: string;
  /** Header content; defaults to the label plus a sort arrow. */
  header?: (ctx: { sorted?: SortDirection }) => ReactNode;
  cell: (row: TRow, index: number) => ReactNode;
  /** Default width in pixels; omit on the fill column. */
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  /** No `<col>` width: the column takes the leftover space. */
  fill?: boolean;
  /** Default: true unless `fill`. */
  resizable?: boolean;
  /** Default: true unless `pinned`. */
  movable?: boolean;
  /** Stays at the start, in column-definition order; never moves. */
  pinned?: boolean;
  /** `aria-sort` is present only on sortable columns. */
  sortable?: boolean;
  /** Cells are row headers; each row is named by its row header. */
  rowHeader?: boolean;
  align?: "start" | "end";
  headerClassName?: string;
  cellClassName?: string;
}

/** Row windowing for long tables; see `DataTableProps.virtualize`. */
interface DataTableVirtualize {
  /** Every body row's height in pixels; rows are not measured. */
  rowHeight: number;
  /** The scroll box's height cap in pixels, header included. */
  maxHeight: number;
  /** Rows rendered past each edge of the view. Default 5. */
  overscan?: number;
}

export interface DataTableSelection<TRow> {
  selected: RowSelectionState;
  onChange(next: RowSelectionState): void;
  /** The header checkbox's name, e.g. "Select all visible rows". */
  allLabel: string;
  rowLabel(row: TRow): string;
}

export interface DataTableProps<TRow extends RowData> {
  ariaLabel: string;
  rows: TRow[];
  columns: DataColumn<TRow>[];
  getRowId(row: TRow): string;
  density: "compact" | "comfortable";
  sort?: { column: string; direction: SortDirection };
  /** A click on a sortable header, unless it came from a control inside. */
  onHeaderSort?(columnId: string): void;
  /** Column ids; unknown ids are ignored, missing ones appended. */
  columnOrder: string[];
  onColumnOrderChange?(next: string[], moved: string): void;
  columnVisibility?: Record<string, boolean>;
  columnWidths: Record<string, number>;
  /** `undefined` resets the column to its default width. */
  onColumnWidthChange?(id: string, width: number | undefined): void;
  /** Renders a pinned checkbox column. */
  selection?: DataTableSelection<TRow>;
  /** A click on the row (not on its controls), or Enter on a focused row or
   *  bare cell. */
  onRowActivate?(row: TRow): void;
  rowClassName?(row: TRow, state: { selected: boolean }): string;
  stickyHeader?: boolean;
  /** Opt-in: the table scrolls in its own box of at most `maxHeight` under a
   *  sticky header, and renders only the rows in view (plus overscan).
   *  Spacer rows keep the full height; `aria-rowcount`/`aria-rowindex` give
   *  each rendered row its place, and grid navigation reaches rows outside
   *  the window through them. A focused row scrolled out of the window
   *  (by wheel or touch) unmounts and focus falls to the body; Tab
   *  re-enters the grid at its first rendered row. */
  virtualize?: DataTableVirtualize;
  emptyState?: ReactNode;
  className?: string;
  tableRef?: Ref<HTMLTableElement>;
}

/** The selection column's id; never a consumer column. */
const SELECT_COLUMN_ID = "__select";
const SELECT_WIDTH = 44;
const DEFAULT_MIN = 40;
const DEFAULT_MAX = 640;
const RESIZE_STEP = 16;
const DRAG_KIND = "data-table-column";
const DEFAULT_OVERSCAN = 5;
/** Header row heights by density; they match the header row's classes. */
const HEADER_HEIGHT = { compact: 34, comfortable: 40 } as const;
/** `aria-rowindex` of the first body row: the header row is 1. */
const FIRST_BODY_ROW_INDEX = 2;

const features = tableFeatures({
  columnSizingFeature,
  columnVisibilityFeature,
  columnOrderingFeature,
  columnPinningFeature,
  rowSelectionFeature,
  rowSortingFeature,
});
type Features = typeof features;

const EMPTY_SELECTION: RowSelectionState = {};
const EMPTY_VISIBILITY: Record<string, boolean> = {};
const noop = () => {};

/** Controls whose clicks belong to them, not to the header or row. Table
 *  keys carry a tabindex from the grid's roving focus, so they are skipped. */
const INTERACTIVE =
  "button, a[href], input, select, textarea, label, [role=button], [role=separator], [tabindex], [contenteditable]";
const GRID_KEYS = new Set(["TR", "TD", "TH"]);

function fromInteractive(target: EventTarget, boundary: Element): boolean {
  for (
    let el = target instanceof Element ? target : null;
    el && el !== boundary;
    el = el.parentElement
  ) {
    if (!GRID_KEYS.has(el.tagName) && el.matches(INTERACTIVE)) return true;
  }
  return false;
}

function isResizable<TRow>(column: DataColumn<TRow>): boolean {
  return column.resizable ?? !column.fill;
}

function isMovable<TRow>(column: DataColumn<TRow>): boolean {
  return !column.pinned && (column.movable ?? true);
}

function clampWidth<TRow>(column: DataColumn<TRow>, width: number): number {
  const min = column.minWidth ?? DEFAULT_MIN;
  const max = column.maxWidth ?? DEFAULT_MAX;
  return Math.round(Math.min(max, Math.max(min, width)));
}

/** Known ids in the given order, missing ones appended, pinned ones first. */
function effectiveOrder<TRow>(
  order: readonly string[],
  columns: DataColumn<TRow>[],
): string[] {
  const ids = columns.map((column) => column.id);
  const known = [...new Set(order.filter((id) => ids.includes(id)))];
  const all = [...known, ...ids.filter((id) => !known.includes(id))];
  const pinned = columns.filter((c) => c.pinned).map((c) => c.id);
  return [...pinned, ...all.filter((id) => !pinned.includes(id))];
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as RefObject<T | null>).current = value;
}

interface DropFeedback {
  columnId: string;
  edge: ColumnDropEdge;
}

interface ColumnDragData {
  kind: typeof DRAG_KIND;
  tableId: string;
  columnId: string;
  [key: string]: unknown;
}

function dragColumnId(data: Record<string | symbol, unknown>, tableId: string) {
  return data.kind === DRAG_KIND &&
    data.tableId === tableId &&
    typeof data.columnId === "string"
    ? data.columnId
    : null;
}

/** Handlers the header drag registrations read at event time, so the
 *  registrations need not change on every render. */
interface ReorderHandlers {
  onDragStart(columnId: string): void;
  onDragEnd(): void;
  setFeedback(feedback: DropFeedback | null): void;
  onDrop(columnId: string, targetId: string, edge: ColumnDropEdge): void;
}

/**
 * One grid over TanStack Table v9: widths through a `<colgroup>`, resize
 * handles, header drag and Alt+Arrow reorder, an optional checkbox column,
 * and `useGridNavigation`'s roving focus. Sorting is the caller's (server
 * side); the table only shows it.
 */
export function DataTable<TRow extends RowData>({
  ariaLabel,
  rows,
  columns,
  getRowId,
  density,
  sort,
  onHeaderSort,
  columnOrder,
  onColumnOrderChange,
  columnVisibility = EMPTY_VISIBILITY,
  columnWidths,
  onColumnWidthChange,
  selection,
  onRowActivate,
  rowClassName,
  stickyHeader,
  virtualize,
  emptyState,
  className,
  tableRef,
}: DataTableProps<TRow>) {
  const tableId = useId();
  const gridRef = useRef<HTMLTableElement | null>(null);
  const setGridRef = useCallback(
    (el: HTMLTableElement | null) => {
      gridRef.current = el;
      assignRef(tableRef, el);
    },
    [tableRef],
  );

  const byId = useMemo(
    () => new Map(columns.map((column) => [column.id, column])),
    [columns],
  );
  const order = useMemo(
    () => effectiveOrder(columnOrder, columns),
    [columnOrder, columns],
  );
  const pinnedIds = useMemo(
    () => columns.filter((c) => c.pinned).map((c) => c.id),
    [columns],
  );

  // TanStack owns the model (order, pinning, visibility, selection); the
  // cells render from the caller's specs, so the defs carry only ids.
  const idsKey = columns.map((column) => column.id).join("\u0000");
  const selectable = selection !== undefined;
  const defs = useMemo<ColumnDef<Features, TRow, unknown>[]>(() => {
    const ids = idsKey.split("\u0000");
    const list = selectable ? [SELECT_COLUMN_ID, ...ids] : ids;
    return list.map((id) => ({ id, header: id, cell: () => null }));
  }, [idsKey, selectable]);

  const [preview, setPreview] = useState<{ id: string; width: number } | null>(
    null,
  );
  const widthOf = (column: DataColumn<TRow>): number | undefined => {
    if (preview?.id === column.id) return preview.width;
    const width = columnWidths[column.id] ?? column.width;
    return width === undefined ? undefined : clampWidth(column, width);
  };

  const sizing = useMemo(() => {
    const out: Record<string, number> = {};
    for (const column of columns) {
      const width = columnWidths[column.id] ?? column.width;
      if (width !== undefined) out[column.id] = width;
    }
    return out;
  }, [columns, columnWidths]);

  const selected = selection?.selected ?? EMPTY_SELECTION;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const table = useTable({
    features,
    columns: defs,
    data: rows,
    getRowId: (row) => getRowId(row),
    manualSorting: true,
    enableRowSelection: selection !== undefined,
    state: {
      columnOrder: selection ? [SELECT_COLUMN_ID, ...order] : order,
      columnPinning: {
        start: selection ? [SELECT_COLUMN_ID, ...pinnedIds] : pinnedIds,
        end: [],
      },
      columnVisibility,
      columnSizing: sizing,
      rowSelection: selected,
      sorting: sort
        ? [{ id: sort.column, desc: sort.direction === "descending" }]
        : [],
    },
    // Order, visibility, widths and sort change only through the caller.
    onColumnOrderChange: noop,
    onColumnPinningChange: noop,
    onColumnVisibilityChange: noop,
    onColumnSizingChange: noop,
    onSortingChange: noop,
    onRowSelectionChange: (updater) => {
      const current = selectionRef.current;
      if (!current) return;
      current.onChange(
        typeof updater === "function" ? updater(current.selected) : updater,
      );
    },
  });

  const headers = table.getHeaderGroups().at(-1)?.headers ?? [];
  const visibleIds = headers
    .map((h) => h.column.id)
    .filter((id) => id !== SELECT_COLUMN_ID);
  const visibleColumns = visibleIds.flatMap((id) => byId.get(id) ?? []);
  const modelRows = table.getRowModel().rows;
  const allSelected =
    modelRows.length > 0 && modelRows.every((r) => selected[r.id]);
  const someSelected = modelRows.some((r) => selected[r.id]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const headerHeight = HEADER_HEIGHT[density];
  const virtualizer = useVirtualizer({
    count: virtualize ? modelRows.length : 0,
    enabled: virtualize !== undefined,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => virtualize?.rowHeight ?? 0,
    overscan: virtualize?.overscan ?? DEFAULT_OVERSCAN,
    // Body rows start under the header, which also covers the top of the
    // view when a row is scrolled to.
    paddingStart: headerHeight,
    scrollPaddingStart: headerHeight,
    initialRect: { width: 0, height: virtualize?.maxHeight ?? 0 },
    // A box with no layout (display:none, or jsdom) measures 0px, and the
    // virtualiser would render no rows: render the capped window instead.
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) =>
        cb(
          rect.height > 0
            ? rect
            : { width: rect.width, height: virtualize?.maxHeight ?? 0 },
        ),
      ),
  });

  const minWidth =
    (selection ? SELECT_WIDTH : 0) +
    visibleColumns.reduce(
      (sum, column) =>
        sum + (column.fill ? (column.minWidth ?? 0) : (widthOf(column) ?? 0)),
      0,
    );

  // Reorder: announcements, and focus kept on a moved header.
  const [announcement, setAnnouncement] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropFeedback, setDropFeedback] = useState<DropFeedback | null>(null);
  const restoreFocus = useRef<Element | null>(null);

  const commitOrder = (next: string[] | null, moved: string) => {
    if (!next || !onColumnOrderChange) return;
    const active = gridRef.current?.ownerDocument.activeElement ?? null;
    if (active && gridRef.current?.contains(active)) {
      restoreFocus.current = active;
    }
    onColumnOrderChange(next, moved);
    const visible = next.filter((id) => visibleIds.includes(id));
    const label = byId.get(moved)?.label ?? moved;
    setAnnouncement(
      `Moved ${label} to position ${visible.indexOf(moved) + 1} of ${visible.length}.`,
    );
  };

  useLayoutEffect(() => {
    const el = restoreFocus.current;
    restoreFocus.current = null;
    if (el instanceof HTMLElement && el.isConnected) {
      if (el.ownerDocument.activeElement !== el) el.focus();
    }
  });

  const reorderHandlers = useRef<ReorderHandlers>(null as never);
  reorderHandlers.current = {
    onDragStart: setDragging,
    onDragEnd: () => setDragging(null),
    setFeedback: setDropFeedback,
    onDrop: (columnId, targetId, edge) => {
      setDragging(null);
      setDropFeedback(null);
      commitOrder(
        moveColumnTo(order, columnId, targetId, edge, pinnedIds),
        columnId,
      );
    },
  };

  const moveByKeyboard = (id: string, delta: -1 | 1) => {
    const column = byId.get(id);
    if (!column || !isMovable(column)) return;
    commitOrder(moveColumnBy(order, id, delta, pinnedIds, visibleIds), id);
  };

  const rowsById = useRef(new Map<string, TRow>());
  rowsById.current = new Map(modelRows.map((r) => [r.id, r.original]));

  useGridNavigation(gridRef, {
    onActivateRow: (tr) => {
      const row = rowsById.current.get(tr.dataset.rowId ?? "");
      if (row !== undefined && onRowActivate) onRowActivate(row);
    },
    onHeaderMove: (th, delta) => {
      if (th.dataset.column) moveByKeyboard(th.dataset.column, delta);
    },
    revealRow: virtualize
      ? (rowIndex) => {
          const box = scrollRef.current;
          if (!box) return;
          virtualizer.scrollToIndex(rowIndex - FIRST_BODY_ROW_INDEX);
          // The virtualiser reads the offset on scroll events and renders
          // synchronously on them, so the row is in the DOM on return.
          box.dispatchEvent(new Event("scroll"));
        }
      : undefined,
  });

  const reorderable = onColumnOrderChange !== undefined;
  const sorted = (id: string): SortDirection | undefined =>
    sort?.column === id ? sort.direction : undefined;

  const showEmpty = modelRows.length === 0 && emptyState !== undefined;
  const colSpan = visibleColumns.length + (selection ? 1 : 0);
  const windowed = virtualize ? virtualizer.getVirtualItems() : null;
  const padTop = windowed?.length ? windowed[0].start - headerHeight : 0;
  const padBottom = windowed?.length
    ? virtualizer.getTotalSize() - (windowed.at(-1)?.end ?? 0)
    : 0;

  const renderRow = (row: (typeof modelRows)[number], index: number) => {
    const isSelected = !!selected[row.id];
    const headerId = visibleColumns.some((c) => c.rowHeader)
      ? `${tableId}-r${index}`
      : undefined;
    return (
      <tr
        key={row.id}
        data-row-id={row.id}
        aria-labelledby={headerId}
        aria-selected={selection ? isSelected : undefined}
        aria-rowindex={virtualize ? index + FIRST_BODY_ROW_INDEX : undefined}
        style={virtualize ? { height: virtualize.rowHeight } : undefined}
        onClick={(event: MouseEvent<HTMLTableRowElement>) => {
          if (!onRowActivate) return;
          if (fromInteractive(event.target, event.currentTarget)) {
            return;
          }
          onRowActivate(row.original);
        }}
        className={cn(
          "group",
          KEY_FOCUS,
          onRowActivate && "cursor-pointer",
          rowClassName?.(row.original, { selected: isSelected }),
        )}
      >
        {row.getVisibleCells().map((cell) => {
          const id = cell.column.id;
          if (id === SELECT_COLUMN_ID && selection) {
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: only stops a checkbox click from activating the row; the checkbox owns its keys
              // biome-ignore lint/a11y/useFocusableInteractive: useGridNavigation gives every cell its roving tabindex
              <td
                key={id}
                // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a grid cell; useGridNavigation gives it a roving tabindex
                role="gridcell"
                data-column={id}
                className={cn("px-3", KEY_FOCUS)}
                // Toggling a row never activates it.
                onClick={(event) => event.stopPropagation()}
              >
                <input
                  type="checkbox"
                  aria-label={selection.rowLabel(row.original)}
                  checked={isSelected}
                  onChange={(event) => row.toggleSelected(event.target.checked)}
                  className="cursor-pointer accent-accent"
                />
              </td>
            );
          }
          const column = byId.get(id);
          if (!column) return null;
          return (
            <td
              key={id}
              id={column.rowHeader ? headerId : undefined}
              role={column.rowHeader ? "rowheader" : "gridcell"}
              data-column={id}
              className={cn(
                "px-3",
                column.align === "end" && "text-right",
                KEY_FOCUS,
                column.cellClassName,
              )}
            >
              {column.cell(row.original, index)}
            </td>
          );
        })}
      </tr>
    );
  };

  const grid = (
    <table
      ref={setGridRef}
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the ARIA grid pattern on a native table
      role="grid"
      aria-label={ariaLabel}
      aria-rowcount={
        virtualize
          ? (showEmpty ? 1 : modelRows.length) + 1 // + the header row
          : undefined
      }
      data-density={density}
      className={cn("w-full table-fixed border-collapse text-left", className)}
      style={{ minWidth }}
    >
      <colgroup>
        {selection && (
          <col data-column={SELECT_COLUMN_ID} style={{ width: SELECT_WIDTH }} />
        )}
        {visibleColumns.map((column) => {
          const width = column.fill ? undefined : widthOf(column);
          return (
            <col
              key={column.id}
              data-column={column.id}
              style={width === undefined ? undefined : { width }}
            />
          );
        })}
      </colgroup>
      <thead
        className={cn(
          (stickyHeader || virtualize) && "sticky top-0 z-[1] bg-ground",
        )}
      >
        <tr
          aria-rowindex={virtualize ? 1 : undefined}
          className={cn(
            "text-[12.5px] text-mute",
            density === "compact" ? "h-[34px]" : "h-10",
          )}
        >
          {selection && (
            <th
              data-column={SELECT_COLUMN_ID}
              className={cn("px-3 font-normal", KEY_FOCUS)}
            >
              <input
                type="checkbox"
                aria-label={selection.allLabel}
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected && !allSelected;
                }}
                onChange={() =>
                  // Gazetteer's rule: all visible selected clears the whole
                  // selection; otherwise it becomes exactly the visible rows.
                  table.setRowSelection(
                    allSelected
                      ? {}
                      : Object.fromEntries(modelRows.map((r) => [r.id, true])),
                  )
                }
                disabled={modelRows.length === 0}
                className="cursor-pointer accent-accent"
              />
            </th>
          )}
          {visibleColumns.map((column) => (
            <HeaderCell
              key={column.id}
              column={column}
              tableId={tableId}
              sorted={sorted(column.id)}
              onSort={onHeaderSort}
              width={widthOf(column) ?? column.minWidth ?? DEFAULT_MIN}
              onPreview={(width) =>
                setPreview({
                  id: column.id,
                  width: clampWidth(column, width),
                })
              }
              onWidth={(width) => {
                setPreview(null);
                onColumnWidthChange?.(column.id, clampWidth(column, width));
              }}
              onReset={() => {
                setPreview(null);
                onColumnWidthChange?.(column.id, undefined);
              }}
              resizable={
                isResizable(column) && onColumnWidthChange !== undefined
              }
              reorderable={reorderable}
              dragging={dragging === column.id}
              dropEdge={
                dropFeedback?.columnId === column.id
                  ? dropFeedback.edge
                  : undefined
              }
              handlers={reorderHandlers}
              resizeHintId={`${tableId}-resize-hint`}
            />
          ))}
        </tr>
      </thead>
      <tbody>
        {showEmpty ? (
          <tr aria-rowindex={virtualize ? FIRST_BODY_ROW_INDEX : undefined}>
            <td colSpan={colSpan}>{emptyState}</td>
          </tr>
        ) : windowed ? (
          <>
            {padTop > 0 && <SpacerRow height={padTop} colSpan={colSpan} />}
            {windowed.map((item) =>
              renderRow(modelRows[item.index], item.index),
            )}
            {padBottom > 0 && (
              <SpacerRow height={padBottom} colSpan={colSpan} />
            )}
          </>
        ) : (
          modelRows.map((row, index) => renderRow(row, index))
        )}
      </tbody>
    </table>
  );

  return (
    <>
      {virtualize ? (
        <div
          ref={scrollRef}
          className="overflow-auto"
          style={{ maxHeight: virtualize.maxHeight }}
        >
          {grid}
        </div>
      ) : (
        grid
      )}
      <p id={`${tableId}-resize-hint`} hidden>
        Press Enter to resize
      </p>
      {/* A live region without role="status": the screens hosting a table
          keep that role for their own messages. */}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
    </>
  );
}

/** Keeps a virtualised body at its full height; grid navigation skips it. */
function SpacerRow({ height, colSpan }: { height: number; colSpan: number }) {
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: never focusable; grid navigation gives spacers no tabindex
    <tr aria-hidden="true" data-grid-spacer style={{ height }}>
      <td colSpan={colSpan} className="p-0" />
    </tr>
  );
}

/** Focus cue for rows and cells, drawn inside so the table never clips it. */
const KEY_FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent";

interface HeaderCellProps<TRow> {
  column: DataColumn<TRow>;
  tableId: string;
  sorted?: SortDirection;
  onSort?(columnId: string): void;
  width: number;
  onPreview(width: number): void;
  onWidth(width: number): void;
  onReset(): void;
  resizable: boolean;
  reorderable: boolean;
  dragging: boolean;
  dropEdge?: ColumnDropEdge;
  handlers: RefObject<ReorderHandlers>;
  /** The table's "Press Enter to resize" hint. */
  resizeHintId: string;
}

function HeaderCell<TRow>({
  column,
  tableId,
  sorted,
  onSort,
  width,
  onPreview,
  onWidth,
  onReset,
  resizable,
  reorderable,
  dragging,
  dropEdge,
  handlers,
  resizeHintId,
}: HeaderCellProps<TRow>) {
  const labelId = useId();
  const thRef = useRef<HTMLTableCellElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const movable = reorderable && isMovable(column);
  const dropTarget = reorderable && !column.pinned;
  const canSort = !!column.sortable && onSort !== undefined;
  const { id } = column;

  useEffect(() => {
    const element = thRef.current;
    const dragHandle = labelRef.current;
    if (!element || !dragHandle) return;
    const cleanups: Array<() => void> = [];
    if (movable) {
      cleanups.push(
        draggable({
          element,
          dragHandle,
          getInitialData: (): ColumnDragData => ({
            kind: DRAG_KIND,
            tableId,
            columnId: id,
          }),
          onDragStart: () => handlers.current.onDragStart(id),
          onDrop: () => handlers.current.onDragEnd(),
        }),
      );
    }
    if (dropTarget) {
      const feedback = (data: Record<string | symbol, unknown>) => {
        const edge = extractClosestEdge(data);
        handlers.current.setFeedback(
          edge === "left" || edge === "right" ? { columnId: id, edge } : null,
        );
      };
      cleanups.push(
        dropTargetForElements({
          element,
          canDrop: ({ source }) => dragColumnId(source.data, tableId) !== null,
          getData: ({ input }) =>
            attachClosestEdge(
              { kind: `${DRAG_KIND}-target`, columnId: id },
              { element, input, allowedEdges: ["left", "right"] },
            ),
          onDragEnter: ({ self }) => feedback(self.data),
          onDrag: ({ self }) => feedback(self.data),
          onDragLeave: () => handlers.current.setFeedback(null),
          onDrop: ({ source, self }) => {
            handlers.current.setFeedback(null);
            const sourceId = dragColumnId(source.data, tableId);
            const edge = extractClosestEdge(self.data);
            if (!sourceId || (edge !== "left" && edge !== "right")) return;
            handlers.current.onDrop(sourceId, id, edge);
          },
        }),
      );
    }
    return cleanups.length ? combine(...cleanups) : undefined;
  }, [dropTarget, handlers, id, movable, tableId]);

  const drag = useWidthDrag({
    width,
    onPreview,
    onCommit: onWidth,
    scale: 1,
  });

  const content = column.header ? (
    column.header({ sorted })
  ) : (
    <>
      {column.label}
      {sorted && (
        <span aria-hidden>{sorted === "descending" ? " ↓" : " ↑"}</span>
      )}
    </>
  );

  return (
    <th
      ref={thRef}
      data-column={id}
      aria-sort={column.sortable ? (sorted ?? "none") : undefined}
      // The resizer has a name of its own; keep it out of the header's.
      aria-labelledby={labelId}
      aria-describedby={resizable ? resizeHintId : undefined}
      aria-keyshortcuts={movable ? "Alt+ArrowLeft Alt+ArrowRight" : undefined}
      onClick={(event) => {
        if (!canSort || fromInteractive(event.target, event.currentTarget)) {
          return;
        }
        onSort?.(id);
      }}
      className={cn(
        "relative truncate px-3 font-normal",
        column.align === "end" ? "text-right" : "text-left",
        sorted && "text-ink",
        canSort && "cursor-pointer hover:text-ink",
        dragging && "opacity-50",
        KEY_FOCUS,
        column.headerClassName,
      )}
      style={
        dropEdge
          ? {
              boxShadow:
                dropEdge === "left"
                  ? "inset 2px 0 0 0 var(--accent)"
                  : "inset -2px 0 0 0 var(--accent)",
            }
          : undefined
      }
    >
      <span ref={labelRef} id={labelId}>
        {content}
      </span>
      {resizable && (
        // Outside grid navigation (React Aria's resizable-table model):
        // Enter on the header focuses the resizer; Escape, Enter or Tab
        // return to the header.
        <span data-grid-skip>
          <WidthResizer
            label={`Resize the ${column.label} column`}
            width={width}
            min={column.minWidth ?? DEFAULT_MIN}
            max={column.maxWidth ?? DEFAULT_MAX}
            step={RESIZE_STEP}
            className="left-auto right-0 translate-x-0"
            onWidth={onWidth}
            onReset={onReset}
            onDragStart={drag.onDragStart}
          />
        </span>
      )}
    </th>
  );
}
