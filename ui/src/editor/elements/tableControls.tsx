import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { GripHorizontal, GripVertical } from "lucide-react";
import {
  createContext,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
} from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
  SubmenuTrigger,
} from "#/components/ui/menu";
import type { TableAlign } from "#/editor/schema/types";
import { cn } from "#/lib/cn";

// ---------------------------------------------------------------------------
// Per-table UI state
//
// One store per rendered table. Cells subscribe with boolean selectors, so a
// pointer crossing a cell boundary re-renders only the grips that change.
// ---------------------------------------------------------------------------

export type TableAxis = "column" | "row";

/** What an open table menu acts on, and where (wrapper-relative) it opens. */
export interface TableMenuState {
  scope: TableAxis | "cell";
  row: number;
  column: number;
  x: number;
  y: number;
}

/** Wrapper-relative box of the line showing where a drag would land. */
export interface DropIndicator {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface TableDragState {
  axis: TableAxis;
  from: number;
  /** Insertion boundary under the pointer; null while outside the table. */
  boundary: number | null;
  indicator: DropIndicator | null;
}

interface TableUiState {
  hoverRow: number | null;
  hoverColumn: number | null;
  nearRight: boolean;
  nearBottom: boolean;
  menu: TableMenuState | null;
  drag: TableDragState | null;
}

export type TableUiStore = StoreApi<TableUiState>;

const IDLE: TableUiState = {
  hoverRow: null,
  hoverColumn: null,
  nearRight: false,
  nearBottom: false,
  menu: null,
  drag: null,
};

export function createTableUiStore(): TableUiStore {
  return createStore<TableUiState>(() => IDLE);
}

/** What the grips ask of their table. Rebuilt each render; read via the ref. */
export interface TableController {
  openMenu(
    target: Pick<TableMenuState, "scope" | "row" | "column">,
    point: { clientX: number; clientY: number },
  ): void;
  /** Move one step along the axis and keep keyboard focus on the grip. */
  nudge(axis: TableAxis, index: number, delta: -1 | 1): void;
}

export interface TableUi {
  store: TableUiStore;
  controller: RefObject<TableController | null>;
}

/** A read-only table renders no chrome; its cells read this inert store. */
const INERT: TableUi = {
  store: createTableUiStore(),
  controller: { current: null },
};

export const TableUiContext = createContext<TableUi>(INERT);

/**
 * The order of the table's cells, as one string. Slate re-renders a cell only
 * when its own node changes, so a cell that was moved (or whose neighbour was
 * inserted or removed) would keep the row and column it last rendered with.
 * Reading this context re-renders it exactly when the layout changes.
 */
export const TableLayoutContext = createContext("");

export function useTableUi<T>(selector: (state: TableUiState) => T): T {
  return useStore(useContext(TableUiContext).store, selector);
}

/** True while a menu or a drag is acting on this cell's column or row. */
export function isCellEngaged(
  state: TableUiState,
  row: number,
  column: number,
): boolean {
  const { menu, drag } = state;
  if (drag) return (drag.axis === "column" ? column : row) === drag.from;
  if (menu?.scope === "column") return menu.column === column;
  if (menu?.scope === "row") return menu.row === row;
  return false;
}

function isGripShown(
  state: TableUiState,
  axis: TableAxis,
  index: number,
): boolean {
  const { menu, drag } = state;
  if (drag) return drag.axis === axis && drag.from === index;
  if (menu?.scope === axis) {
    return (axis === "column" ? menu.column : menu.row) === index;
  }
  return (axis === "column" ? state.hoverColumn : state.hoverRow) === index;
}

// ---------------------------------------------------------------------------
// Grip: hover handle for one column or row. Click opens its menu, drag
// reorders, Alt+Arrow moves it from the keyboard.
// ---------------------------------------------------------------------------

/** Marks table chrome so pointer tracking and the cell menu leave it alone. */
export const TABLE_CONTROL_ATTRIBUTE = "data-table-control";

export const TABLE_DRAG_KIND = "clepsydra-editor-table";

/** Pragmatic drag-and-drop's marker on every element drag it starts. */
export const PRAGMATIC_DRAG_TYPE = "application/vnd.pdnd";

/**
 * `Editable` props that keep Slate's text drag-and-drop out of a grip drag.
 * Left alone, Slate serialises the text selection into the drag and moves that
 * text to wherever the grip is dropped. Returning true tells Slate the event
 * is handled. (Stopping propagation on the grip instead would also hide the
 * `dragstart` from the drag library, which listens on the document.)
 */
export const tableDragGuards = {
  onDragStart: (event: ReactDragEvent<HTMLDivElement>): boolean =>
    event.target instanceof Element &&
    event.target.closest("[data-table-grip]") !== null,
  onDrop: (event: ReactDragEvent<HTMLDivElement>): boolean =>
    event.dataTransfer.types.includes(PRAGMATIC_DRAG_TYPE),
};

export interface TableDragData {
  [key: string]: unknown;
  kind: typeof TABLE_DRAG_KIND;
  store: TableUiStore;
  axis: TableAxis;
  from: number;
}

export function isTableDragData(
  data: Record<string, unknown>,
): data is TableDragData {
  return data.kind === TABLE_DRAG_KIND;
}

const CONTROL_HIDDEN =
  "pointer-events-none opacity-0 focus-visible:pointer-events-auto focus-visible:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100";

/** Shared look of the table's hover chrome (grips and append bars). */
export function tableControlClass(shown: boolean, className?: string) {
  return cn(
    "z-10 flex items-center justify-center rounded-full bg-sink text-mute outline-none transition-opacity hover:text-accent focus-visible:ring-2 focus-visible:ring-accent",
    shown ? null : CONTROL_HIDDEN,
    className,
  );
}

const NUDGE_KEYS: Record<TableAxis, Record<string, -1 | 1>> = {
  column: { ArrowLeft: -1, ArrowRight: 1 },
  row: { ArrowUp: -1, ArrowDown: 1 },
};

interface TableGripProps {
  axis: TableAxis;
  index: number;
  /** The header row has a menu but stays where it is. */
  movable: boolean;
}

export function TableGrip({ axis, index, movable }: TableGripProps) {
  const { store, controller } = useContext(TableUiContext);
  const shown = useStore(store, (state) => isGripShown(state, axis, index));
  const expanded = useStore(
    store,
    (state) =>
      state.menu?.scope === axis &&
      (axis === "column" ? state.menu.column : state.menu.row) === index,
  );
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || !movable) return;
    return draggable({
      element,
      getInitialData: (): TableDragData => ({
        kind: TABLE_DRAG_KIND,
        store,
        axis,
        from: index,
      }),
      onDragStart: () =>
        store.setState({
          menu: null,
          drag: { axis, from: index, boundary: null, indicator: null },
        }),
    });
  }, [axis, index, movable, store]);

  const openMenu = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    controller.current?.openMenu(
      {
        scope: axis,
        row: axis === "row" ? index : 0,
        column: axis === "column" ? index : 0,
      },
      { clientX: rect.left, clientY: rect.bottom + 4 },
    );
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu();
      return;
    }
    const delta = event.altKey ? NUDGE_KEYS[axis][event.key] : undefined;
    if (delta === undefined) return;
    event.preventDefault();
    if (movable) controller.current?.nudge(axis, index, delta);
  };

  const Icon = axis === "column" ? GripHorizontal : GripVertical;
  const noun = axis === "column" ? "Column" : "Row";

  return (
    // biome-ignore lint/a11y/useSemanticElements: Firefox never starts a drag from a <button>, and this grip is dragged as well as pressed.
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      contentEditable={false}
      aria-label={`${noun} ${index + 1} options`}
      aria-haspopup="menu"
      aria-expanded={expanded}
      aria-keyshortcuts={
        movable
          ? axis === "column"
            ? "Alt+ArrowLeft Alt+ArrowRight"
            : "Alt+ArrowUp Alt+ArrowDown"
          : undefined
      }
      data-table-grip={axis}
      data-index={index}
      {...{ [TABLE_CONTROL_ATTRIBUTE]: "" }}
      className={tableControlClass(
        shown,
        cn(
          "absolute select-none",
          movable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
          axis === "column"
            ? "bottom-full left-1/2 mb-0.5 h-5 w-8 -translate-x-1/2 max-md:h-10 max-md:w-11 [@media(hover:none)]:h-10 [@media(hover:none)]:w-11"
            : "right-full top-1/2 mr-0.5 h-8 w-5 -translate-y-1/2 max-md:h-11 max-md:w-10 [@media(hover:none)]:h-11 [@media(hover:none)]:w-10",
        ),
      )}
      onClick={openMenu}
      onKeyDown={onKeyDown}
    >
      <Icon aria-hidden size={14} strokeWidth={1.75} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

export interface TableMenuActions {
  sort(column: number, direction: "ascending" | "descending"): void;
  insertColumn(index: number): void;
  moveColumn(from: number, to: number): void;
  alignColumn(column: number, align: TableAlign | null): void;
  duplicateColumn(column: number): void;
  deleteColumn(column: number): void;
  insertRow(index: number): void;
  moveRow(from: number, to: number): void;
  duplicateRow(row: number): void;
  deleteRow(row: number): void;
}

interface TableMenuProps {
  menu: TableMenuState;
  rowCount: number;
  columnCount: number;
  /** Current alignment of the menu's column. */
  align: TableAlign | null;
  actions: TableMenuActions;
  onClose: () => void;
}

const ALIGN_LABEL: Record<TableAlign, string> = {
  left: "Align left",
  center: "Align centre",
  right: "Align right",
};

function isTableAlign(value: unknown): value is TableAlign {
  return value === "left" || value === "center" || value === "right";
}

function columnItems(
  { menu, columnCount, rowCount, align, actions }: TableMenuProps,
  { withAddAndDelete }: { withAddAndDelete: boolean },
): ReactNode {
  const { column } = menu;
  return (
    <>
      <MenuItem
        isDisabled={rowCount < 3}
        onAction={() => actions.sort(column, "ascending")}
      >
        Sort by column (A to Z)
      </MenuItem>
      <MenuItem
        isDisabled={rowCount < 3}
        onAction={() => actions.sort(column, "descending")}
      >
        Sort by column (Z to A)
      </MenuItem>
      <MenuSeparator />
      {withAddAndDelete ? (
        <>
          <MenuItem onAction={() => actions.insertColumn(column)}>
            Add column before
          </MenuItem>
          <MenuItem onAction={() => actions.insertColumn(column + 1)}>
            Add column after
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      <MenuItem
        isDisabled={column === 0}
        onAction={() => actions.moveColumn(column, column - 1)}
      >
        Move column left
      </MenuItem>
      <MenuItem
        isDisabled={column >= columnCount - 1}
        onAction={() => actions.moveColumn(column, column + 1)}
      >
        Move column right
      </MenuItem>
      <MenuSeparator />
      <MenuSection
        aria-label="Column alignment"
        selectionMode="single"
        selectedKeys={align ? [align] : []}
        onSelectionChange={(keys) => {
          const [next] = keys === "all" ? [] : [...keys];
          actions.alignColumn(column, isTableAlign(next) ? next : null);
        }}
      >
        {(["left", "center", "right"] as const).map((value) => (
          <MenuItem key={value} id={value}>
            {ALIGN_LABEL[value]}
          </MenuItem>
        ))}
      </MenuSection>
      <MenuSeparator />
      <MenuItem onAction={() => actions.duplicateColumn(column)}>
        Duplicate column
      </MenuItem>
      {withAddAndDelete ? (
        <MenuItem
          variant="destructive"
          onAction={() => actions.deleteColumn(column)}
        >
          Delete column
        </MenuItem>
      ) : null}
    </>
  );
}

function rowItems(
  { menu, rowCount, actions }: TableMenuProps,
  { withAddAndDelete }: { withAddAndDelete: boolean },
): ReactNode {
  const { row } = menu;
  return (
    <>
      {withAddAndDelete ? (
        <>
          <MenuItem
            isDisabled={row === 0}
            onAction={() => actions.insertRow(row)}
          >
            Add row above
          </MenuItem>
          <MenuItem onAction={() => actions.insertRow(row + 1)}>
            Add row below
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      <MenuItem
        isDisabled={row <= 1}
        onAction={() => actions.moveRow(row, row - 1)}
      >
        Move row up
      </MenuItem>
      <MenuItem
        isDisabled={row === 0 || row >= rowCount - 1}
        onAction={() => actions.moveRow(row, row + 1)}
      >
        Move row down
      </MenuItem>
      <MenuSeparator />
      <MenuItem onAction={() => actions.duplicateRow(row)}>
        Duplicate row
      </MenuItem>
      {withAddAndDelete ? (
        <MenuItem variant="destructive" onAction={() => actions.deleteRow(row)}>
          Delete row
        </MenuItem>
      ) : null}
    </>
  );
}

/**
 * The menu for a column grip, a row grip, or a right-clicked cell. The cell
 * menu keeps adding and deleting one step away and files the rest under Row
 * and Column.
 */
export function TableMenu(props: TableMenuProps) {
  const { menu, actions, onClose } = props;

  if (menu.scope === "column") {
    return (
      <Menu
        aria-label={`Column ${menu.column + 1}`}
        autoFocus="first"
        onClose={onClose}
      >
        {columnItems(props, { withAddAndDelete: true })}
      </Menu>
    );
  }

  if (menu.scope === "row") {
    return (
      <Menu
        aria-label={`Row ${menu.row + 1}`}
        autoFocus="first"
        onClose={onClose}
      >
        {rowItems(props, { withAddAndDelete: true })}
      </Menu>
    );
  }

  return (
    <Menu aria-label="Table" autoFocus="first" onClose={onClose}>
      <MenuItem
        isDisabled={menu.row === 0}
        onAction={() => actions.insertRow(menu.row)}
      >
        Add row above
      </MenuItem>
      <MenuItem onAction={() => actions.insertRow(menu.row + 1)}>
        Add row below
      </MenuItem>
      <MenuItem onAction={() => actions.insertColumn(menu.column)}>
        Add column before
      </MenuItem>
      <MenuItem onAction={() => actions.insertColumn(menu.column + 1)}>
        Add column after
      </MenuItem>
      <MenuSeparator />
      <SubmenuTrigger>
        <MenuItem>Row</MenuItem>
        <Menu aria-label={`Row ${menu.row + 1}`}>
          {rowItems(props, { withAddAndDelete: false })}
        </Menu>
      </SubmenuTrigger>
      <SubmenuTrigger>
        <MenuItem>Column</MenuItem>
        <Menu aria-label={`Column ${menu.column + 1}`}>
          {columnItems(props, { withAddAndDelete: false })}
        </Menu>
      </SubmenuTrigger>
      <MenuSeparator />
      <MenuItem
        variant="destructive"
        onAction={() => actions.deleteRow(menu.row)}
      >
        Delete row
      </MenuItem>
      <MenuItem
        variant="destructive"
        onAction={() => actions.deleteColumn(menu.column)}
      >
        Delete column
      </MenuItem>
    </Menu>
  );
}
