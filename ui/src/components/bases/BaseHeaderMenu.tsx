import { type ReactNode, useRef, useState } from "react";
import type { SortKey } from "#/api/bases";
import { Button } from "#/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  SubmenuTrigger,
} from "#/components/ui/menu";
import {
  type ContextMenuPoint,
  forwardContextMenu,
  pointOfContextMenu,
  pointUnder,
} from "./context-menu-forward";
import {
  type GroupOverride,
  type QuickFilter,
  quickFilterIdentity,
} from "./view-overrides";

export interface BaseHeaderMenuProps {
  column: string;
  label: string;
  allowsSorting: boolean;
  groupable: boolean;
  /** True when the effective grouping already uses this column. */
  groupedByThis: boolean;
  hideable: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  /** The column has a width handle to hand focus to. */
  resizable: boolean;
  presets: QuickFilter[];
  /** Options the presets left out, from `headerOptionOverflow`. */
  optionOverflow: number;
  onSortChange(sort: SortKey[] | undefined): void;
  onAddQuickFilter(filter: QuickFilter): void;
  onSetGroup(group: GroupOverride | undefined): void;
  onHideColumn(column: string): void;
  /** Move this column one place among the visible columns. */
  onMove(delta: -1 | 1): void;
  children: ReactNode;
}

type HeaderMenuProps = Omit<BaseHeaderMenuProps, "children"> & {
  /** Hand focus to the column's resizer once the menu has closed. */
  onResize(): void;
};

/** Why a column refuses to move one way, for the disabled item's description. */
function moveBlocker(column: string, delta: -1 | 1): string {
  if (column === "title") return "The title column stays first";
  return delta < 0 ? "Cannot move further left" : "Cannot move further right";
}

/** Why a column has no resizer, for the disabled item's description. */
function resizeBlocker(column: string): string {
  return column === "title"
    ? "The title column takes the remaining width"
    : "This column cannot be resized";
}

/** Why a column refuses to hide, for the disabled item's description. */
function hideBlocker(column: string): string {
  return column === "title"
    ? "The title column stays visible"
    : "The last column stays visible";
}

function HeaderMenu({
  column,
  label,
  allowsSorting,
  groupable,
  groupedByThis,
  hideable,
  canMoveLeft,
  canMoveRight,
  resizable,
  presets,
  optionOverflow,
  onSortChange,
  onAddQuickFilter,
  onSetGroup,
  onHideColumn,
  onMove,
  onResize,
}: HeaderMenuProps) {
  // Keyed by the filter's own identity: a preset keeps its key when the
  // column's options change, and a repeated preset collapses into one item.
  const byIdentity = new Map(
    presets.map((preset) => [`filter:${quickFilterIdentity(preset)}`, preset]),
  );
  const addPreset = (key: unknown) => {
    const preset = byIdentity.get(String(key));
    if (preset) onAddQuickFilter(preset);
  };
  return (
    // No `aria-label`: React Aria names a menu after its trigger, and an
    // `aria-label` here loses to the `aria-labelledby` it always sets.
    <Menu
      onAction={(key) => {
        const id = String(key);
        if (id === "sort-asc") onSortChange([{ field: column, dir: "asc" }]);
        else if (id === "sort-desc")
          onSortChange([{ field: column, dir: "desc" }]);
        else if (id === "group")
          onSetGroup(
            groupedByThis ? { kind: "flat" } : { kind: "by", field: column },
          );
        else if (id === "hide") onHideColumn(column);
        else if (id === "move-left") onMove(-1);
        else if (id === "move-right") onMove(1);
        else if (id === "resize") onResize();
        else addPreset(id);
      }}
    >
      <MenuItem
        id="sort-asc"
        isDisabled={!allowsSorting}
        description={allowsSorting ? undefined : "Not sortable"}
      >
        Sort ascending
      </MenuItem>
      <MenuItem
        id="sort-desc"
        isDisabled={!allowsSorting}
        description={allowsSorting ? undefined : "Not sortable"}
      >
        Sort descending
      </MenuItem>
      {presets.length > 0 ? (
        <SubmenuTrigger>
          <MenuItem id="filter">Filter</MenuItem>
          <Menu aria-label={`Filter ${label}`} onAction={addPreset}>
            {[...byIdentity].map(([id, preset]) => (
              <MenuItem key={id} id={id}>
                {preset.label}
              </MenuItem>
            ))}
            {/* The cap is a menu-length limit, not a filter limit: say so
                rather than truncating the options in silence. */}
            {optionOverflow > 0 ? (
              <MenuItem id="overflow" isDisabled>
                {`… and ${optionOverflow} more — use a cell`}
              </MenuItem>
            ) : null}
          </Menu>
        </SubmenuTrigger>
      ) : null}
      <MenuSeparator />
      <MenuItem
        id="group"
        isDisabled={!groupable}
        description={groupable ? undefined : "Cannot group by this column"}
      >
        {groupedByThis ? "Ungroup" : `Group by ${label}`}
      </MenuItem>
      <MenuItem
        id="hide"
        isDisabled={!hideable}
        description={hideable ? undefined : hideBlocker(column)}
      >
        Hide column
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        id="move-left"
        isDisabled={!canMoveLeft}
        description={canMoveLeft ? undefined : moveBlocker(column, -1)}
      >
        Move left
      </MenuItem>
      <MenuItem
        id="move-right"
        isDisabled={!canMoveRight}
        description={canMoveRight ? undefined : moveBlocker(column, 1)}
      >
        Move right
      </MenuItem>
      <MenuItem
        id="resize"
        isDisabled={!resizable}
        description={resizable ? undefined : resizeBlocker(column)}
      >
        Resize column
      </MenuItem>
    </Menu>
  );
}

/**
 * Column header content with a `⋯` menu button that owns the header's only
 * menu; right-clicking the header content forwards to it.
 *
 * The button's `aria-label` becomes part of the column header's accessible
 * name ("author author column menu"), which is accepted: `aria-hidden` would
 * take the menu away from keyboard users, and the header is named by its
 * content. The row menu's button does the same to its row header cell, which
 * reads "Zulu Row actions for Zulu".
 */
export function BaseHeaderMenu(props: BaseHeaderMenuProps) {
  const { children, ...rest } = props;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const resizeRequested = useRef(false);
  const summon = (point: ContextMenuPoint) => {
    if (!triggerRef.current) return false;
    forwardContextMenu(triggerRef.current, point);
    return true;
  };
  return (
    <div className="flex items-center gap-1" data-column={rest.column}>
      {/* Not focusable: the grid focuses a column header's first focusable
          child, which must stay the `⋯` button. Nothing inside can hold focus,
          so there is no context-menu key to catch here — only the pointer. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: this handler only forwards the platform's context-menu gesture to the `⋯` button, which is the real, focusable control; a role here would both misdescribe the header and claim the focus the grid owes that button. */}
      <div
        className="flex min-w-0 flex-1 items-center"
        onContextMenu={(event) => {
          if (summon(pointOfContextMenu(event))) event.preventDefault();
        }}
      >
        {children}
      </div>
      <MenuTrigger
        trigger="contextMenu"
        onOpenChange={(open) => {
          setIsOpen(open);
          if (open || !resizeRequested.current) return;
          resizeRequested.current = false;
          // The header's own cell has no reachable Enter (focus lands on
          // this button), so the menu is the keyboard way into resize mode.
          // React Aria hands focus back to this button as the menu closes;
          // take it over once that has happened.
          const header = triggerRef.current?.closest("th");
          window.setTimeout(() => {
            header?.querySelector<HTMLElement>('[role="separator"]')?.focus();
          }, 0);
        }}
      >
        <Button
          ref={triggerRef}
          variant="ghost"
          size="sm"
          aria-label={`${rest.label} column menu`}
          // A context-menu trigger neither presses open nor advertises a
          // popup, and this button does both, so it says so itself.
          aria-haspopup="menu"
          aria-expanded={isOpen}
          className="px-1 py-0 opacity-60 hover:opacity-100 aria-expanded:opacity-100"
          onPress={() => {
            const trigger = triggerRef.current;
            if (trigger) summon(pointUnder(trigger));
          }}
        >
          ⋯
        </Button>
        {/* Built eagerly, unlike the row menu's `isOpen` gate: a header menu's
            items are bounded by the column's options (`HEADER_OPTION_CAP`) and
            there is one per column, not one per cell. */}
        <HeaderMenu
          {...rest}
          onResize={() => {
            resizeRequested.current = true;
          }}
        />
      </MenuTrigger>
    </div>
  );
}
