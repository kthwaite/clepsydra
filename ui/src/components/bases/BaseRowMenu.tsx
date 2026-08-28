import { type ReactNode, useRef, useState } from "react";
import type { QueryRow } from "#/api/bases";
import { Button } from "#/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  SubmenuTrigger,
} from "#/components/ui/menu";
import type { CellValue } from "./cells/types";
import {
  type ContextMenuPoint,
  forwardContextMenu,
  isContextMenuKey,
  pointOfContextMenu,
  pointUnder,
} from "./context-menu-forward";
import {
  DATE_PRESETS,
  datePresetFilter,
  isDateLike,
  type QuickFilterType,
  quickFiltersForCell,
} from "./quick-filters";
import { type QuickFilter, quickFilterIdentity } from "./view-overrides";

export interface RowMenuActions {
  onOpenPage(path: string): void;
  onOpenPageInNewTab?(path: string): void;
  onCopyWikilink?(row: QueryRow): void;
  onDuplicateRow?(row: QueryRow): void;
  onArchiveRow?(row: QueryRow): void;
}

/** Which cell summoned a row's menu, and what to focus when it closes. */
export interface RowContextTarget {
  rowId: string;
  /** Undefined when the `⋯` button opened the menu: no cell section then. */
  column: string | undefined;
  origin: HTMLElement | null;
}

/** The cell section of a row menu, resolved by the table. */
export interface RowMenuCell {
  column: string;
  label: string;
  type: QuickFilterType | undefined;
  value: CellValue | undefined;
}

/** The row's marker, so a cell can find the button that owns its menu. */
const ROW_MENU_ATTRIBUTE = "data-row-menu";

export function rowMenuLabel(row: QueryRow): string {
  return row.title ?? row.path;
}

function RowItems({
  row,
  readOnly,
  actions,
}: {
  row: QueryRow;
  readOnly: boolean;
  actions: RowMenuActions;
}) {
  const { onOpenPageInNewTab, onCopyWikilink, onDuplicateRow, onArchiveRow } =
    actions;
  const canDuplicate = !readOnly && onDuplicateRow !== undefined;
  const canArchive = !readOnly && onArchiveRow !== undefined;
  return (
    <>
      <MenuItem id="open" onAction={() => actions.onOpenPage(row.path)}>
        Open
      </MenuItem>
      {onOpenPageInNewTab ? (
        <MenuItem
          id="open-new-tab"
          onAction={() => onOpenPageInNewTab(row.path)}
        >
          Open in new tab
        </MenuItem>
      ) : null}
      {onCopyWikilink ? (
        <MenuItem id="copy-wikilink" onAction={() => onCopyWikilink(row)}>
          Copy wikilink
        </MenuItem>
      ) : null}
      {canDuplicate || canArchive ? <MenuSeparator /> : null}
      {canDuplicate ? (
        <MenuItem id="duplicate" onAction={() => onDuplicateRow?.(row)}>
          Duplicate
        </MenuItem>
      ) : null}
      {canArchive ? (
        <MenuItem
          id="archive"
          variant="destructive"
          onAction={() => onArchiveRow?.(row)}
        >
          Archive…
        </MenuItem>
      ) : null}
    </>
  );
}

interface RowMenuContentProps {
  row: QueryRow;
  readOnly: boolean;
  actions: RowMenuActions;
  cell: RowMenuCell | undefined;
  onAddQuickFilter?(filter: QuickFilter): void;
  onCopyValue?(value: CellValue): void;
}

/**
 * One row menu's items: the quick filters and Copy value for the cell it was
 * summoned from, then the row's own actions. Rendered only inside the open
 * popover, so no closed menu pays for deriving its filters.
 */
function RowMenuContent({
  row,
  readOnly,
  actions,
  cell,
  onAddQuickFilter,
  onCopyValue,
}: RowMenuContentProps) {
  const type = cell?.type;
  const quick =
    !readOnly && cell !== undefined && type !== undefined && onAddQuickFilter
      ? quickFiltersForCell(cell.column, type, cell.value, cell.label)
      : [];
  // Keyed by the filter's own identity, so a repeated value collapses into one
  // item instead of colliding in the collection.
  const quickById = new Map(
    quick.map((filter) => [`quick:${quickFilterIdentity(filter)}`, filter]),
  );
  const dateLike =
    !readOnly && cell !== undefined && isDateLike(type) && onAddQuickFilter;
  const copyable = cell !== undefined && type !== undefined && onCopyValue;
  return (
    <>
      {[...quickById].map(([id, filter]) => (
        <MenuItem key={id} id={id} onAction={() => onAddQuickFilter?.(filter)}>
          {filter.label}
        </MenuItem>
      ))}
      {dateLike && cell ? (
        <SubmenuTrigger>
          <MenuItem id="date">Filter by date</MenuItem>
          <Menu aria-label={`Filter ${cell.label} by date`}>
            {DATE_PRESETS.map((preset) => (
              <MenuItem
                key={preset.op}
                id={preset.op}
                onAction={() =>
                  onAddQuickFilter?.(
                    datePresetFilter(cell.column, cell.label, preset.op),
                  )
                }
              >
                {preset.label}
              </MenuItem>
            ))}
          </Menu>
        </SubmenuTrigger>
      ) : null}
      {copyable && cell ? (
        <MenuItem
          id="copy-value"
          onAction={() => onCopyValue?.(cell.value ?? null)}
        >
          Copy value
        </MenuItem>
      ) : null}
      {quickById.size > 0 || dateLike || copyable ? <MenuSeparator /> : null}
      <RowItems row={row} readOnly={readOnly} actions={actions} />
    </>
  );
}

export interface RowActionsButtonProps {
  row: QueryRow;
  readOnly: boolean;
  actions: RowMenuActions;
  /** The cell that summoned the menu, when a cell did. */
  cell?: RowMenuCell;
  /** The control to hand focus back to when the menu closes. */
  restoreFocus?: HTMLElement | null;
  onContextTarget(target: RowContextTarget): void;
  onAddQuickFilter?(filter: QuickFilter): void;
  onCopyValue?(value: CellValue): void;
}

/**
 * The ghost `⋯` button in a row's first cell, and the one menu the whole row
 * uses. React Aria names a menu after its trigger, so this button's
 * `aria-label` is the menu's name — the menu carries none of its own.
 */
export function RowActionsButton({
  row,
  readOnly,
  actions,
  cell,
  restoreFocus,
  onContextTarget,
  onAddQuickFilter,
  onCopyValue,
}: RowActionsButtonProps) {
  const label = `Row actions for ${rowMenuLabel(row)}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const restoreRef = useRef<HTMLElement | null>(null);
  restoreRef.current = restoreFocus ?? null;

  const restore = () => {
    const origin = restoreRef.current;
    if (!origin) return;
    // React Aria returns focus to this button as the popover unmounts; the
    // reader summoned the menu from a cell control, so hand it back — unless
    // something else (the archive dialog) has claimed focus by then.
    window.setTimeout(() => {
      const active = document.activeElement;
      if (!origin.isConnected) return;
      if (
        active !== null &&
        active !== document.body &&
        active !== triggerRef.current
      )
        return;
      origin.focus();
    }, 0);
  };

  return (
    <MenuTrigger
      trigger="contextMenu"
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) restore();
      }}
    >
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        aria-label={label}
        // A context-menu trigger neither presses open nor advertises a popup,
        // so the button supplies both itself.
        aria-haspopup="menu"
        data-row-menu=""
        className="ml-auto shrink-0 px-1 py-0 opacity-0 focus-visible:opacity-100 group-data-[hovered]:opacity-100 group-focus-within:opacity-100"
        onPress={() => {
          const trigger = triggerRef.current;
          if (!trigger) return;
          onContextTarget({
            rowId: String(row.id),
            column: undefined,
            origin: null,
          });
          forwardContextMenu(trigger, pointUnder(trigger));
        }}
      >
        ⋯
      </Button>
      <Menu>
        {isOpen ? (
          <RowMenuContent
            row={row}
            readOnly={readOnly}
            actions={actions}
            cell={cell}
            onAddQuickFilter={onAddQuickFilter}
            onCopyValue={onCopyValue}
          />
        ) : null}
      </Menu>
    </MenuTrigger>
  );
}

export interface CellContextTriggerProps {
  row: QueryRow;
  column: string;
  onContextTarget(target: RowContextTarget): void;
  children: ReactNode;
}

/**
 * A cell's context-menu affordance. Right-click or the context-menu key
 * anywhere in the cell re-fires on the row's `⋯` button, which owns the menu.
 * The wrapper is deliberately not focusable: React Aria's grid focuses a
 * cell's *first focusable child*, which must stay the cell's own control.
 */
export function CellContextTrigger({
  row,
  column,
  onContextTarget,
  children,
}: CellContextTriggerProps) {
  const summon = (origin: HTMLElement, point: ContextMenuPoint) => {
    const trigger =
      origin
        .closest("tr")
        ?.querySelector<HTMLElement>(`[${ROW_MENU_ATTRIBUTE}]`) ?? null;
    // The button's own events are React Aria's to handle, not ours to forward.
    if (!trigger || trigger.contains(origin)) return;
    onContextTarget({ rowId: String(row.id), column, origin });
    forwardContextMenu(trigger, point);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: these handlers only forward the platform's context-menu gesture to the row's `⋯` button, which is the real, focusable control; an interactive role here would both mislead about the cell's semantics and take React Aria's in-cell focus off the cell's own control.
    <div
      className="flex min-w-0 flex-1 items-center [&>*:first-child]:min-w-0 [&>*:first-child]:flex-1"
      data-row-id={row.id}
      data-column={column}
      onContextMenu={(event) => {
        event.preventDefault();
        summon(event.target as HTMLElement, pointOfContextMenu(event));
      }}
      onKeyDown={(event) => {
        if (!isContextMenuKey(event)) return;
        event.preventDefault();
        const origin = event.target as HTMLElement;
        summon(origin, pointUnder(origin));
      }}
    >
      {children}
    </div>
  );
}
