import type { ReactNode } from "react";
import type { SortKey } from "#/api/bases";
import { Button } from "#/components/ui/button";
import {
  ContextMenuTrigger,
  Menu,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  SubmenuTrigger,
} from "#/components/ui/menu";
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

/** Why a column refuses to hide; `undefined` when it does not refuse. */
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
    <Menu
      aria-label={`${label} column menu`}
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
 * Column header content with a `⋯` menu button and a right-click menu. The
 * two triggers stay siblings: a `MenuTrigger` nested inside the
 * `ContextMenuTrigger` inherits that trigger's `aria-labelledby`, which would
 * name the popup after the whole header instead of the button.
 */
export function BaseHeaderMenu(props: BaseHeaderMenuProps) {
  const { children, label } = props;
  return (
    <div className="flex items-center gap-1" data-column={props.column}>
      <ContextMenuTrigger>
        {/* React Aria makes the context target pressable; the column header
            around it is the sort control, so this must not take a tab stop. */}
        <div tabIndex={-1} className="flex min-w-0 items-center">
          {children}
        </div>
        <HeaderMenu {...props} />
      </ContextMenuTrigger>
      <MenuTrigger>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${label} column menu`}
          className="px-1 py-0 opacity-60 hover:opacity-100"
        >
          ⋯
        </Button>
        <HeaderMenu {...props} />
      </MenuTrigger>
    </div>
  );
}
