import type { ReactNode } from "react";
import type { PropertyDefinition, QueryRow } from "#/api/bases";
import { Button } from "#/components/ui/button";
import {
  ContextMenuTrigger,
  Menu,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  SubmenuTrigger,
} from "#/components/ui/menu";
import type { CellValue } from "./cells/types";
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

export function rowMenuLabel(row: QueryRow): string {
  return row.title ?? row.path;
}

function RowItems({ readOnly }: { readOnly: boolean }) {
  return (
    <>
      <MenuItem id="open">Open</MenuItem>
      <MenuItem id="open-new-tab">Open in new tab</MenuItem>
      <MenuItem id="copy-wikilink">Copy wikilink</MenuItem>
      {readOnly ? null : (
        <>
          <MenuSeparator />
          <MenuItem id="duplicate">Duplicate</MenuItem>
          <MenuItem id="archive" variant="destructive">
            Archive…
          </MenuItem>
        </>
      )}
    </>
  );
}

function dispatchRowAction(
  key: string,
  row: QueryRow,
  actions: RowMenuActions,
): boolean {
  switch (key) {
    case "open":
      actions.onOpenPage(row.path);
      return true;
    case "open-new-tab":
      actions.onOpenPageInNewTab?.(row.path);
      return true;
    case "copy-wikilink":
      actions.onCopyWikilink?.(row);
      return true;
    case "duplicate":
      actions.onDuplicateRow?.(row);
      return true;
    case "archive":
      actions.onArchiveRow?.(row);
      return true;
    default:
      return false;
  }
}

export interface RowActionsButtonProps {
  row: QueryRow;
  readOnly: boolean;
  actions: RowMenuActions;
}

/** The ghost `⋯` button in a row's first cell. */
export function RowActionsButton({
  row,
  readOnly,
  actions,
}: RowActionsButtonProps) {
  const label = `Row actions for ${rowMenuLabel(row)}`;
  return (
    <MenuTrigger>
      <Button
        variant="ghost"
        size="sm"
        aria-label={label}
        className="ml-auto shrink-0 px-1 py-0 opacity-0 focus-visible:opacity-100 group-data-[hovered]:opacity-100"
      >
        ⋯
      </Button>
      <Menu
        aria-label={label}
        onAction={(key) => dispatchRowAction(String(key), row, actions)}
      >
        <RowItems readOnly={readOnly} />
      </Menu>
    </MenuTrigger>
  );
}

export interface CellContextMenuProps {
  row: QueryRow;
  column: string;
  label: string;
  type: QuickFilterType | undefined;
  definition: PropertyDefinition | undefined;
  value: CellValue | undefined;
  readOnly: boolean;
  actions: RowMenuActions;
  onAddQuickFilter?(filter: QuickFilter): void;
  onCopyValue?(value: CellValue): void;
  children: ReactNode;
}

/** Right-click / context-key menu for one cell: quick filters, copy, row items. */
export function CellContextMenu({
  row,
  column,
  label,
  type,
  value,
  readOnly,
  actions,
  onAddQuickFilter,
  onCopyValue,
  children,
}: CellContextMenuProps) {
  const filterable =
    !readOnly && type !== undefined && onAddQuickFilter !== undefined;
  const quick = filterable
    ? quickFiltersForCell(column, type, value, label)
    : [];
  // Keyed by the filter's own identity, so a cell's items keep their keys
  // across a value change and a repeated value collapses into one item.
  const quickById = new Map(
    quick.map((filter) => [`quick:${quickFilterIdentity(filter)}`, filter]),
  );
  const dateLike = filterable && isDateLike(type);
  const copyable = !readOnly && type !== undefined && onCopyValue !== undefined;
  const menuLabel = `${rowMenuLabel(row)} — ${label}`;
  return (
    <ContextMenuTrigger>
      <div
        className="flex min-w-0 flex-1 items-center [&>*:first-child]:min-w-0 [&>*:first-child]:flex-1"
        data-row-id={row.id}
        data-column={column}
        // React Aria makes the context target pressable, and a press target
        // swallows Space so it can activate itself. The cell's own control —
        // an editor input, the title button — must keep that key.
        tabIndex={-1}
        onKeyDownCapture={(event) => {
          if (event.key === " " && event.target !== event.currentTarget)
            event.stopPropagation();
        }}
      >
        {children}
      </div>
      <Menu
        aria-label={menuLabel}
        onAction={(key) => {
          const id = String(key);
          if (dispatchRowAction(id, row, actions)) return;
          if (id === "copy-value") {
            onCopyValue?.(value ?? null);
            return;
          }
          const filter = quickById.get(id);
          if (filter) onAddQuickFilter?.(filter);
        }}
      >
        {[...quickById].map(([id, filter]) => (
          <MenuItem key={id} id={id}>
            {filter.label}
          </MenuItem>
        ))}
        {dateLike ? (
          <SubmenuTrigger>
            <MenuItem id="date">Filter by date</MenuItem>
            <Menu
              aria-label={`Filter ${label} by date`}
              onAction={(key) =>
                onAddQuickFilter?.(
                  datePresetFilter(
                    column,
                    label,
                    String(key) as QuickFilter["op"],
                  ),
                )
              }
            >
              {DATE_PRESETS.map((preset) => (
                <MenuItem key={preset.op} id={preset.op}>
                  {preset.label}
                </MenuItem>
              ))}
            </Menu>
          </SubmenuTrigger>
        ) : null}
        {copyable ? <MenuItem id="copy-value">Copy value</MenuItem> : null}
        {quick.length > 0 || dateLike || copyable ? <MenuSeparator /> : null}
        <RowItems readOnly={readOnly} />
      </Menu>
    </ContextMenuTrigger>
  );
}
