import { type ReactNode, useRef } from "react";
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
  isContextMenuKey,
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
  presets: QuickFilter[];
  onSortChange(sort: SortKey[] | undefined): void;
  onAddQuickFilter(filter: QuickFilter): void;
  onSetGroup(group: GroupOverride | undefined): void;
  onHideColumn(column: string): void;
  children: ReactNode;
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
  presets,
  onSortChange,
  onAddQuickFilter,
  onSetGroup,
  onHideColumn,
}: Omit<BaseHeaderMenuProps, "children">) {
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
    </Menu>
  );
}

/**
 * Column header content with a `⋯` menu button that owns the header's only
 * menu; right-clicking the header content forwards to it.
 *
 * The button's `aria-label` becomes part of the column header's accessible
 * name ("author author column menu"), which is accepted: `aria-hidden` would
 * take the menu away from keyboard users, `Column` drops an `aria-label` of
 * its own (React Aria filters it out), and React Aria collections will not let
 * the button live outside the `<Column>`.
 */
export function BaseHeaderMenu(props: BaseHeaderMenuProps) {
  const { children, label } = props;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const summon = (point: ContextMenuPoint) =>
    forwardContextMenu(triggerRef.current, point);
  return (
    <div className="flex items-center gap-1" data-column={props.column}>
      {/* Not focusable: React Aria focuses a column header's first focusable
          child, which must stay the `⋯` button. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: these handlers only forward the platform's context-menu gesture to the `⋯` button, which is the real, focusable control; a role here would both misdescribe the header and claim the focus React Aria owes that button. */}
      <div
        className="flex min-w-0 flex-1 items-center"
        onContextMenu={(event) => {
          event.preventDefault();
          summon(pointOfContextMenu(event));
        }}
        onKeyDown={(event) => {
          if (!isContextMenuKey(event)) return;
          event.preventDefault();
          summon(pointUnder(event.target as Element));
        }}
      >
        {children}
      </div>
      <MenuTrigger trigger="contextMenu">
        <Button
          ref={triggerRef}
          variant="ghost"
          size="sm"
          aria-label={`${label} column menu`}
          // A context-menu trigger neither presses open nor advertises a
          // popup, so the button supplies both itself.
          aria-haspopup="menu"
          className="px-1 py-0 opacity-60 hover:opacity-100"
          onPress={() => {
            const trigger = triggerRef.current;
            if (trigger) summon(pointUnder(trigger));
          }}
        >
          ⋯
        </Button>
        <HeaderMenu {...props} />
      </MenuTrigger>
    </div>
  );
}
