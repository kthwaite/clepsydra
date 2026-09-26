import { Button as AriaButton } from "react-aria-components";
import type { SortKey } from "#/api/bases";
import {
  Menu,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  SubmenuTrigger,
} from "#/components/ui/menu";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";
import {
  type GroupOverride,
  type QuickFilter,
  quickFilterIdentity,
} from "./view-overrides";

/** What a column offers the pickers — the same capabilities its header
 *  `⋯` menu offers (BaseTableView computes both from one helper). */
export interface PickerColumn {
  column: string;
  label: string;
  allowsSorting: boolean;
  groupable: boolean;
  presets: QuickFilter[];
  optionOverflow: number;
}

/** The view bar's pill (mockup): tinted while it carries an override. */
export const PICKER_PILL = (active: boolean) =>
  cn(
    "inline-flex h-8 cursor-default items-center gap-1.5 rounded-full px-3 text-[13.5px]",
    active ? "bg-accent-tint text-accent" : "text-ink data-[hovered]:bg-sink",
    FOCUS_RING,
  );

const arrow = (dir: SortKey["dir"]) => (dir === "desc" ? "↓" : "↑");

export function FilterPicker({
  columns,
  activeCount,
  onAddQuickFilter,
}: {
  columns: PickerColumn[];
  activeCount: number;
  onAddQuickFilter(filter: QuickFilter): void;
}) {
  const filterable = columns.filter((c) => c.presets.length > 0);
  if (filterable.length === 0) return null;
  return (
    <MenuTrigger>
      <AriaButton className={PICKER_PILL(activeCount > 0)}>
        {activeCount > 0 ? `Filter · ${activeCount}` : "Filter"}
      </AriaButton>
      <Menu aria-label="Filter by">
        {filterable.map((c) => {
          const byIdentity = new Map(
            c.presets.map((p) => [`filter:${quickFilterIdentity(p)}`, p]),
          );
          return (
            <SubmenuTrigger key={c.column}>
              <MenuItem id={`column:${c.column}`}>{c.label}</MenuItem>
              <Menu
                aria-label={`Filter ${c.label}`}
                onAction={(key) => {
                  const preset = byIdentity.get(String(key));
                  if (preset) onAddQuickFilter(preset);
                }}
              >
                {[...byIdentity].map(([id, preset]) => (
                  <MenuItem key={id} id={id}>
                    {preset.label}
                  </MenuItem>
                ))}
                {c.optionOverflow > 0 ? (
                  <MenuItem id="overflow" isDisabled>
                    {`… and ${c.optionOverflow} more — use a cell`}
                  </MenuItem>
                ) : null}
              </Menu>
            </SubmenuTrigger>
          );
        })}
      </Menu>
    </MenuTrigger>
  );
}

export function SortPicker({
  columns,
  sort,
  overridden,
  onSortChange,
}: {
  columns: PickerColumn[];
  /** The effective primary sort: the override, else the saved view's. */
  sort: SortKey | undefined;
  overridden: boolean;
  onSortChange(sort: SortKey[] | undefined): void;
}) {
  const sortable = columns.filter((c) => c.allowsSorting);
  if (sortable.length === 0) return null;
  const labelOf = (field: string) =>
    columns.find((c) => c.column === field)?.label ?? field;
  return (
    <MenuTrigger>
      <AriaButton className={PICKER_PILL(overridden)}>
        {sort ? `Sort · ${labelOf(sort.field)} ${arrow(sort.dir)}` : "Sort"}
      </AriaButton>
      <Menu
        aria-label="Sort by"
        onAction={(key) => {
          if (key === "inherit") onSortChange(undefined);
        }}
      >
        {sortable.map((c) => (
          <SubmenuTrigger key={c.column}>
            <MenuItem id={`column:${c.column}`}>{c.label}</MenuItem>
            <Menu
              aria-label={`Sort by ${c.label}`}
              onAction={(key) =>
                onSortChange([
                  { field: c.column, dir: key === "desc" ? "desc" : "asc" },
                ])
              }
            >
              <MenuItem id="asc">Ascending</MenuItem>
              <MenuItem id="desc">Descending</MenuItem>
            </Menu>
          </SubmenuTrigger>
        ))}
        {overridden ? (
          <>
            <MenuSeparator />
            <MenuItem id="inherit">Use the view's sort</MenuItem>
          </>
        ) : null}
      </Menu>
    </MenuTrigger>
  );
}

export function GroupPicker({
  columns,
  group,
  savedGroup,
  overridden,
  onSetGroup,
}: {
  columns: PickerColumn[];
  /** The effective grouping column: the override, else the saved view's. */
  group: string | undefined;
  /** The saved view's own grouping column, if it has one. */
  savedGroup: string | undefined;
  overridden: boolean;
  onSetGroup(group: GroupOverride | undefined): void;
}) {
  const groupable = columns.filter((c) => c.groupable);
  // A saved grouping may key on a field the view does not show; the pill
  // still names it and offers No grouping.
  if (groupable.length === 0 && group === undefined) return null;
  const labelOf = (field: string) =>
    columns.find((c) => c.column === field)?.label ?? field;
  return (
    <MenuTrigger>
      <AriaButton className={PICKER_PILL(overridden)}>
        {group ? `Group · ${labelOf(group)}` : "Group"}
      </AriaButton>
      <Menu
        aria-label="Group by"
        selectionMode="single"
        selectedKeys={[group ? `by:${group}` : "flat"]}
        onAction={(key) => {
          const id = String(key);
          if (id === "inherit") {
            onSetGroup(undefined);
            return;
          }
          const field = id.startsWith("by:") ? id.slice(3) : undefined;
          if (id !== "flat" && field === undefined) return;
          // Choosing what the saved view already does is not an override:
          // it drops one if present, and otherwise changes nothing.
          if (field === savedGroup) {
            if (overridden) onSetGroup(undefined);
            return;
          }
          onSetGroup(
            field === undefined ? { kind: "flat" } : { kind: "by", field },
          );
        }}
      >
        <MenuItem id="flat">No grouping</MenuItem>
        {groupable.map((c) => (
          <MenuItem key={c.column} id={`by:${c.column}`}>
            {c.label}
          </MenuItem>
        ))}
        {overridden ? (
          <MenuItem id="inherit">Use the view's grouping</MenuItem>
        ) : null}
      </Menu>
    </MenuTrigger>
  );
}
