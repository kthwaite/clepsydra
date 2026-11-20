import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { Plus } from "lucide-react";
import type { Table, TableCell, TableRow } from "mdast";
import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Editor,
  Node,
  type NodeEntry,
  type Path,
  Range,
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
import { useStore } from "zustand";
import { Popover } from "#/components/ui/popover";
import {
  createTableUiStore,
  type DropIndicator,
  isCellEngaged,
  isTableDragData,
  PRAGMATIC_DRAG_TYPE,
  TABLE_CONTROL_ATTRIBUTE,
  type TableController,
  type TableDragData,
  TableGrip,
  TableLayoutContext,
  TableMenu,
  type TableMenuActions,
  type TableUi,
  TableUiContext,
  tableControlClass,
  useTableUi,
} from "#/editor/elements/tableControls";
import {
  appendTableColumn,
  appendTableRow,
  deleteTableColumn,
  deleteTableRow,
  dropBoundary,
  duplicateTableColumn,
  duplicateTableRow,
  insertTableColumn,
  insertTableRow,
  moveTableColumn,
  moveTableRow,
  moveTarget,
  setTableColumnAlign,
  sortTableByColumn,
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
//
// An editable table keeps its chrome out of sight until the pointer asks for
// it: a grip for the hovered column and one for the hovered row (click for the
// menu, drag to reorder), and an append bar along the right or bottom edge
// once the pointer is near that edge. Right-clicking a cell opens the same
// actions for that cell's row and column.
// ---------------------------------------------------------------------------

const ALIGN_CLASS: Record<TableAlign, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

type TableRendererProps = RenderElementProps & { element: TableElement };

const TOUCH_CONTROL_TRACK_CLASS =
  "max-md:h-11 max-md:min-w-11 [@media(hover:none)]:h-11 [@media(hover:none)]:min-w-11";

/** How close (px) the pointer must be to an edge to reveal its append bar. */
const EDGE_REACH = 24;

const TABLE_CLASS =
  "w-full border-separate border-spacing-0 rounded-[14px] bg-raise text-[0.9em] leading-[1.5]";

/**
 * A table whose rows disagree on width (a pasted fragment, a hand-edited
 * file) is squared up as soon as it renders, without a history entry.
 */
function useSquareShape(element: TableElement) {
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

  return columnCount;
}

function TableRenderer(props: TableRendererProps) {
  return useReadOnly() ? (
    <ReadOnlyTable {...props} />
  ) : (
    <EditableTable {...props} />
  );
}

function ReadOnlyTable({ attributes, children, element }: TableRendererProps) {
  useSquareShape(element);
  return (
    <div {...attributes} className="my-4 max-w-full">
      <div className="min-w-0 max-w-full overflow-x-auto">
        {/* Separated by tone and space (spec decision 5): a raised panel,
            the header row on sink, no cell borders. */}
        <table className={TABLE_CLASS}>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

interface DropMeasure {
  boundary: number;
  indicator: DropIndicator | null;
}

function sameIndicator(a: DropIndicator | null, b: DropIndicator | null) {
  if (a === null || b === null) return a === b;
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  );
}

function EditableTable({ attributes, children, element }: TableRendererProps) {
  const editor = useSlateStatic();
  const columnCount = useSquareShape(element);
  const rowCount = element.children.length;

  const [store] = useState(createTableUiStore);
  const controller = useRef<TableController | null>(null);
  const ui = useMemo<TableUi>(() => ({ store, controller }), [store]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);

  const menu = useStore(store, (state) => state.menu);
  const indicator = useStore(store, (state) => state.drag?.indicator ?? null);
  const nearRight = useStore(store, (state) => state.nearRight);
  const nearBottom = useStore(store, (state) => state.nearBottom);

  const layout = element.children
    .map((row) =>
      row.children.map((cell) => ReactEditor.findKey(editor, cell).id).join(),
    )
    .join(";");

  const wrapper = () => scrollRef.current?.parentElement ?? null;

  /**
   * One undo step per action. `edit` returns the cell the caret should land
   * in, or nothing to leave the selection where the edit carried it.
   */
  const run = (edit: (tablePath: Path) => Path | null | undefined) => {
    HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
      const tablePath = ReactEditor.findPath(editor, element);
      const target = edit(tablePath);
      if (target && Node.has(editor, target)) {
        Transforms.select(editor, Editor.start(editor, target));
      }
    });
  };

  // A menu hands focus back to whatever had it as it closes, a frame later;
  // the caret's claim has to come after that.
  const focusEditorSoon = () => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        // Unless another menu has opened meanwhile: focus is its to keep.
        if (store.getState().menu === null) ReactEditor.focus(editor);
      }),
    );
  };

  const act = (edit: (tablePath: Path) => Path | null | undefined) => {
    run(edit);
    focusEditorSoon();
  };

  const actions: TableMenuActions = {
    sort: (column, direction) =>
      act((tablePath) => {
        sortTableByColumn(editor, tablePath, column, direction);
        return null;
      }),
    insertColumn: (index) =>
      act((tablePath) => insertTableColumn(editor, tablePath, index)),
    moveColumn: (from, to) =>
      act((tablePath) => moveTableColumn(editor, tablePath, from, to)),
    alignColumn: (column, align) =>
      act((tablePath) => {
        setTableColumnAlign(editor, tablePath, column, align);
        return null;
      }),
    duplicateColumn: (column) =>
      act((tablePath) => duplicateTableColumn(editor, tablePath, column)),
    deleteColumn: (column) =>
      act((tablePath) => deleteTableColumn(editor, tablePath, column)),
    insertRow: (index) =>
      act((tablePath) => insertTableRow(editor, tablePath, index)),
    moveRow: (from, to) =>
      act((tablePath) => moveTableRow(editor, tablePath, from, to)),
    duplicateRow: (row) =>
      act((tablePath) => duplicateTableRow(editor, tablePath, row)),
    deleteRow: (row) =>
      act((tablePath) => deleteTableRow(editor, tablePath, row)),
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  controller.current = {
    openMenu: (target, point) => {
      const rect = wrapper()?.getBoundingClientRect();
      if (!rect) return;
      store.setState({
        menu: {
          ...target,
          x: point.clientX - rect.left,
          y: point.clientY - rect.top,
        },
      });
    },
    nudge: (axis, index, delta) => {
      const to = index + delta;
      let moved = false;
      run((tablePath) => {
        const landed =
          axis === "column"
            ? moveTableColumn(editor, tablePath, index, to)
            : moveTableRow(editor, tablePath, index, to);
        moved = landed !== null;
        return null;
      });
      if (!moved) return;
      // The grip travels with its column or row; follow it.
      requestAnimationFrame(() => {
        wrapper()
          ?.querySelector<HTMLElement>(
            `[data-table-grip="${axis}"][data-index="${to}"]`,
          )
          ?.focus();
      });
    },
  };

  // The whole table is one drop target; where the drop lands is read off the
  // header cells (columns) or the rows.
  useEffect(() => {
    const element = scrollRef.current?.parentElement;
    if (!element) return;

    const own = (data: Record<string, unknown>): TableDragData | null =>
      isTableDragData(data) && data.store === store ? data : null;

    const measure = (
      data: TableDragData,
      input: { clientX: number; clientY: number },
    ): DropMeasure | null => {
      const table = tableRef.current;
      const scroll = scrollRef.current;
      if (!table || !scroll || table.rows.length === 0) return null;
      const origin = element.getBoundingClientRect();
      const port = scroll.getBoundingClientRect();
      const box = table.getBoundingClientRect();

      if (data.axis === "column") {
        const rects = Array.from(table.rows[0].cells, (cell) =>
          cell.getBoundingClientRect(),
        );
        if (rects.length === 0) return null;
        const boundary = dropBoundary(
          rects.map((rect) => [rect.left, rect.right] as const),
          input.clientX,
        );
        const x =
          boundary < rects.length
            ? rects[boundary].left
            : rects[rects.length - 1].right;
        const shown =
          moveTarget(data.from, boundary) !== data.from &&
          x >= port.left - 1 &&
          x <= port.right + 1;
        return {
          boundary,
          indicator: shown
            ? {
                left: Math.round(x - origin.left) - 1,
                top: Math.round(box.top - origin.top),
                width: 2,
                height: Math.round(box.height),
              }
            : null,
        };
      }

      const rects = Array.from(table.rows, (row) =>
        row.getBoundingClientRect(),
      );
      // Nothing lands above the header row.
      const boundary = Math.max(
        1,
        dropBoundary(
          rects.map((rect) => [rect.top, rect.bottom] as const),
          input.clientY,
        ),
      );
      const y =
        boundary < rects.length
          ? rects[boundary].top
          : rects[rects.length - 1].bottom;
      const left = Math.max(box.left, port.left);
      const right = Math.min(box.right, port.right);
      return {
        boundary,
        indicator:
          moveTarget(data.from, boundary) !== data.from
            ? {
                left: Math.round(left - origin.left),
                top: Math.round(y - origin.top) - 1,
                width: Math.round(right - left),
                height: 2,
              }
            : null,
      };
    };

    const track = ({
      source,
      location,
    }: {
      source: { data: Record<string, unknown> };
      location: { current: { input: { clientX: number; clientY: number } } };
    }) => {
      const data = own(source.data);
      const drag = store.getState().drag;
      const measured = data && measure(data, location.current.input);
      if (!drag || !measured) return;
      if (
        drag.boundary === measured.boundary &&
        sameIndicator(drag.indicator, measured.indicator)
      ) {
        return;
      }
      store.setState({ drag: { ...drag, ...measured } });
    };

    // The table, not the grip, ends the drag: a grip that moved with its row
    // is re-registered mid-drop and never hears about it.
    const endDrag = monitorForElements({
      canMonitor: ({ source }) => own(source.data) !== null,
      onDrop: () => store.setState({ drag: null }),
    });

    const dropTarget = dropTargetForElements({
      element,
      canDrop: ({ source }) => own(source.data) !== null,
      onDragEnter: track,
      onDrag: track,
      onDragLeave: () => {
        const drag = store.getState().drag;
        if (drag) {
          store.setState({
            drag: { ...drag, boundary: null, indicator: null },
          });
        }
      },
      // Measured again from the drop point rather than read from the store,
      // so the move does not depend on which listener ran last.
      onDrop: ({ source, location }) => {
        const data = own(source.data);
        const measured = data && measure(data, location.current.input);
        if (!data || !measured) return;
        const to = moveTarget(data.from, measured.boundary);
        if (data.axis === "column") {
          actionsRef.current.moveColumn(data.from, to);
        } else {
          actionsRef.current.moveRow(data.from, to);
        }
      },
    });

    return combine(endDrag, dropTarget);
  }, [store]);

  const cellUnder = (target: EventTarget): HTMLTableCellElement | null => {
    if (!(target instanceof Element)) return null;
    const cell = target.closest("td,th");
    return cell instanceof HTMLTableCellElement &&
      tableRef.current?.contains(cell)
      ? cell
      : null;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    const state = store.getState();
    const scroll = scrollRef.current;
    if (state.drag || !scroll) return;

    let { hoverRow, hoverColumn } = state;
    const onControl =
      event.target instanceof Element &&
      event.target.closest(`[${TABLE_CONTROL_ATTRIBUTE}]`) !== null;
    const cell = onControl ? null : cellUnder(event.target);
    if (cell) {
      hoverRow = (cell.parentElement as HTMLTableRowElement).rowIndex;
      hoverColumn = cell.cellIndex;
    }
    const port = scroll.getBoundingClientRect();
    const nextNearRight = event.clientX >= port.right - EDGE_REACH;
    const nextNearBottom = event.clientY >= port.bottom - EDGE_REACH;
    if (
      hoverRow !== state.hoverRow ||
      hoverColumn !== state.hoverColumn ||
      nextNearRight !== state.nearRight ||
      nextNearBottom !== state.nearBottom
    ) {
      store.setState({
        hoverRow,
        hoverColumn,
        nearRight: nextNearRight,
        nearBottom: nextNearBottom,
      });
    }
  };

  const onPointerLeave = () => {
    store.setState({
      hoverRow: null,
      hoverColumn: null,
      nearRight: false,
      nearBottom: false,
    });
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const cell = cellUnder(event.target);
    if (!cell) return;
    const grip =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-table-grip]")
        : null;
    // Selected text keeps the browser's menu, which is where Copy lives.
    if (!grip && editor.selection && Range.isExpanded(editor.selection)) {
      return;
    }
    event.preventDefault();
    // A keyboard-summoned menu carries no pointer position.
    const anchor = (grip ?? cell).getBoundingClientRect();
    const point =
      event.clientX !== 0 || event.clientY !== 0
        ? { clientX: event.clientX, clientY: event.clientY }
        : { clientX: anchor.left, clientY: anchor.bottom };
    const row = (cell.parentElement as HTMLTableRowElement).rowIndex;
    const scope =
      (grip?.dataset.tableGrip as "column" | "row" | undefined) ?? "cell";
    controller.current?.openMenu({ scope, row, column: cell.cellIndex }, point);
  };

  // Belt and braces for an `Editable` mounted without `tableDragGuards`:
  // Slate would treat a grip dropped on a cell as dragged text.
  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (
      store.getState().drag ||
      event.dataTransfer.types.includes(PRAGMATIC_DRAG_TYPE)
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const appendColumn = () => {
    run((tablePath) => appendTableColumn(editor, tablePath));
    ReactEditor.focus(editor);
  };

  const appendRow = () => {
    run((tablePath) => appendTableRow(editor, tablePath));
    ReactEditor.focus(editor);
  };

  const closeMenu = () => store.setState({ menu: null });
  const menuInRange =
    menu !== null && menu.row < rowCount && menu.column < columnCount;

  return (
    <TableUiContext.Provider value={ui}>
      <TableLayoutContext.Provider value={layout}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only watches the pointer to decide which of its real controls (grips, append bars) to reveal, and forwards the context-menu gesture to the same menu those grips open. */}
        <div
          {...attributes}
          className="relative my-4 grid max-w-full grid-cols-[minmax(0,1fr)_1.5rem] grid-rows-[auto_1.5rem] max-md:grid-cols-[minmax(0,1fr)_2.75rem] max-md:grid-rows-[auto_2.75rem] [@media(hover:none)]:grid-cols-[minmax(0,1fr)_2.75rem] [@media(hover:none)]:grid-rows-[auto_2.75rem]"
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onContextMenu={onContextMenu}
          onDrop={onDrop}
        >
          {/* The table keeps its own scroll port; controls occupy reserved gutters
            outside it, clear of both the scrollbar and following content. */}
          <div
            ref={scrollRef}
            className="min-w-0 max-w-full overflow-x-auto pl-6 pt-6 max-md:pl-11 max-md:pt-11 [@media(hover:none)]:pl-11 [@media(hover:none)]:pt-11"
          >
            {/* Separated by tone and space (spec decision 5): a raised panel,
              the header row on sink, no cell borders. */}
            <table ref={tableRef} className={TABLE_CLASS}>
              <tbody>{children}</tbody>
            </table>
          </div>
          <button
            type="button"
            aria-label="Add column"
            title="Add column after"
            contentEditable={false}
            {...{ [TABLE_CONTROL_ATTRIBUTE]: "" }}
            className={tableControlClass(
              nearRight,
              "col-start-2 row-start-1 mt-6 ml-1 w-5 cursor-pointer self-stretch max-md:mt-11 max-md:w-10 [@media(hover:none)]:mt-11 [@media(hover:none)]:w-10",
            )}
            onMouseDown={(event) => event.preventDefault()}
            onClick={appendColumn}
          >
            <Plus aria-hidden size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label="Add row"
            title="Add row after"
            contentEditable={false}
            {...{ [TABLE_CONTROL_ATTRIBUTE]: "" }}
            className={tableControlClass(
              nearBottom,
              "col-start-1 row-start-2 mt-1 ml-6 h-5 cursor-pointer max-md:ml-11 max-md:h-10 [@media(hover:none)]:ml-11 [@media(hover:none)]:h-10",
            )}
            onMouseDown={(event) => event.preventDefault()}
            onClick={appendRow}
          >
            <Plus aria-hidden size={14} strokeWidth={1.75} />
          </button>
          {indicator ? (
            <div
              aria-hidden
              contentEditable={false}
              data-table-drop-indicator
              className="pointer-events-none absolute z-20 rounded-full bg-accent"
              style={indicator}
            />
          ) : null}
          {/* The menu is portalled, but its React events still bubble through
            here to the editor; keys typed in the menu are not the editor's. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: this only stops the portalled menu's key events from reaching the editor's key handling; the menu itself is the interactive element. */}
          <div
            contentEditable={false}
            className="pointer-events-none absolute left-0 top-0 size-0"
            onKeyDown={(event) => event.stopPropagation()}
          >
            <span
              ref={anchorRef}
              aria-hidden
              className="absolute size-0"
              style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
            />
            <Popover
              triggerRef={anchorRef}
              isOpen={menuInRange}
              onOpenChange={(open) => {
                if (!open) closeMenu();
              }}
              placement="bottom start"
              offset={0}
            >
              {menu && menuInRange ? (
                <TableMenu
                  menu={menu}
                  rowCount={rowCount}
                  columnCount={columnCount}
                  align={element.align?.[menu.column] ?? null}
                  actions={actions}
                  onClose={closeMenu}
                />
              ) : null}
            </Popover>
          </div>
        </div>
      </TableLayoutContext.Provider>
    </TableUiContext.Provider>
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
  useContext(TableLayoutContext);
  const cellPath = ReactEditor.findPath(editor, element);
  const { rowIndex, columnIndex } = tableCellCoordinates(cellPath);
  // Tinted while its column or row has a menu open or is being dragged.
  const engaged = useTableUi((state) =>
    isCellEngaged(state, rowIndex, columnIndex),
  );

  const controls = readOnly ? null : (
    <>
      {rowIndex === 0 ? (
        <TableGrip axis="column" index={columnIndex} movable />
      ) : null}
      {columnIndex === 0 ? (
        <TableGrip axis="row" index={rowIndex} movable={rowIndex > 0} />
      ) : null}
    </>
  );

  return element.header ? (
    <th
      {...attributes}
      scope="col"
      className={cn(
        "relative bg-sink px-4 py-2.5 align-bottom text-[13px] font-normal text-mute first:rounded-tl-[14px] last:rounded-tr-[14px]",
        readOnly ? null : TOUCH_CONTROL_TRACK_CLASS,
        element.align ? ALIGN_CLASS[element.align] : "text-left",
        engaged && "bg-accent-tint",
      )}
    >
      {children}
      {controls}
    </th>
  ) : (
    <td
      {...attributes}
      className={cn(
        "relative px-4 py-2.5 align-top text-ink-2",
        readOnly ? null : TOUCH_CONTROL_TRACK_CLASS,
        element.align && ALIGN_CLASS[element.align],
        engaged && "bg-accent-tint",
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
