# Stone & Lamp Phase 4.5b — Bases Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Bases table screen (`/bases/$slug`) and the Bases index (`/bases`) to Stone & Lamp. This adds a Compact switch (comfortable by default), Filter / Sort / Group pickers in the view bar, and footer context (file path and row count). Embedded base tables get the new table styling and are always dense.

**Architecture:**
- New `BasePickers.tsx` holds three menu pickers. They are built on the header menu's existing per-column capabilities (`headerFilterPresets`, sortability, groupability), which move into one helper inside `BaseTableView`.
- `BaseTableView` gains a `screen` prop, which `BaseTable` sets. It gates the screen-only chrome (serif header, Compact switch, pickers, footer). Embeds, in both `display = "compact"` and `"full"`, never set it.
- Density: `dense = !screen || compactRows`, where `compactRows` comes from `useTableCompact("bases", false)`, added in phase 4.5a.
- The definition workspace (`/bases/$slug/edit`) waits for phase 5.

**Tech Stack:** React 19, Tailwind v4 tokens, react-aria-components (`Table`, `MenuTrigger`, `SubmenuTrigger`), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` (§5.6 dense tables, §9 Q2). Mockups: canvas https://claude.ai/artifact/WAmCEdwj8osAmkLkRxGkQd, boards `Bases.dc.html` / `BasesCompact.dc.html`.

**User rulings (2026-09-26):**
- Embeds are always compact and have no switch.
- **Build the mocked Filter / Sort / Group pickers.**
- Scope is the table screen plus the Bases index. The editor waits for phase 5.

## Global Constraints

- Dense tables have no cell borders. The header row is Geist 12.5px `mute`, sentence case. Hover is `sink`. Numerals are tabular.
- Compact is 32px rows, title 13.5px, meta 12.5px. Comfortable is 42px rows, title 14.5px, meta 13px. **Bases defaults to comfortable.**
- There is one Compact switch per table screen, persisted per screen (`clepsydra.tableCompact.bases`). The global density preset sets its starting value.
- The footer's right side for Bases shows the file path and the row count (mockup: `bases/reading.base · 24 rows`). The real file is `bases/<slug>.base.toml`.
- Instrument Serif is regular or italic only, never bold. No new hairline borders.
- Guard (`src/__tests__/primitivesGuard.test.ts`) forbids: `uppercase`, positive `tracking-*`, `cl-mono`, `cl-serif`, `font-mono`, `border-ink`, `border-[…]`, `border-rule`, `border-border`, bare `border`, `rounded-none`, `text-[9|10|11px]`, `paper-2`, `ink-mute`, `muted-foreground`.
- Keep accessible names that tests and users rely on: `nav "Views"` with `aria-current="page"` buttons, `Add member`, `Configure <name>`, `Fields`, `Collapse all` / `Expand all`, the `View overrides` chip strip, the named statuses (`View loading`, `Result limit`, `Result window`, `Empty view`), and `Totals`.
- Scope biome `--write` to files you touched, run from `ui/`. Never run `clep` against the live vault.

## Review Focus

1. **Picker vs header menu parity.** For every column, the pickers must offer exactly what that column's header `⋯` menu offers: the same presets, sortability and groupability. The shared helper exists so the two cannot drift.
2. **Effective vs overridden state.** The Sort and Group pills show the saved view's sort and grouping when there is no override, and are tinted only when an override is active. "Use the view's sort" and "Use the view's grouping" appear only when overridden.
3. **Embeds.** Neither embed display (`compact`, or `full` inside a document) may show the Compact switch, the pickers, a serif 52px title or footer controls. Both render dense rows.
4. **Read-only.** Read-only tables show no pickers, and their header menus stay absent, as today.
5. **Editing inside dense rows.** An open cell editor is taller than 32px. The row must grow, not clip.

---

### Task 1: `BasePickers` — Filter, Sort and Group menus

**Files:**
- Create: `ui/src/components/bases/BasePickers.tsx`
- Create: `ui/src/components/bases/__tests__/BasePickers.test.tsx`

**Interfaces:**
- Produces:
  - `interface PickerColumn { column: string; label: string; allowsSorting: boolean; groupable: boolean; presets: QuickFilter[]; optionOverflow: number }`
  - `FilterPicker({ columns, activeCount, onAddQuickFilter })`
  - `SortPicker({ columns, sort: SortKey | undefined, overridden: boolean, onSortChange(sort: SortKey[] | undefined) })`
  - `GroupPicker({ columns, group: string | undefined, overridden: boolean, onSetGroup(group: GroupOverride | undefined) })`
  - `PICKER_PILL(active: boolean): string`, the pill classes. `FieldsPopover` reuses them in Task 3.

- [ ] **Step 1: Write the failing tests** — `BasePickers.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  FilterPicker,
  GroupPicker,
  type PickerColumn,
  SortPicker,
} from "#/components/bases/BasePickers";

const columns: PickerColumn[] = [
  {
    column: "title",
    label: "Title",
    allowsSorting: true,
    groupable: false,
    presets: [],
    optionOverflow: 0,
  },
  {
    column: "status",
    label: "Status",
    allowsSorting: true,
    groupable: true,
    presets: [
      { field: "status", op: "eq", value: "reading", label: "Status is reading" },
      { field: "status", op: "is_empty", label: "Status is empty" },
    ],
    optionOverflow: 2,
  },
  {
    column: "body",
    label: "Body",
    allowsSorting: false,
    groupable: false,
    presets: [],
    optionOverflow: 0,
  },
];

describe("FilterPicker", () => {
  it("counts active filters and adds a column's preset", async () => {
    const user = userEvent.setup();
    const onAddQuickFilter = vi.fn();
    render(
      <FilterPicker
        columns={columns}
        activeCount={1}
        onAddQuickFilter={onAddQuickFilter}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Filter · 1" }));
    expect(screen.queryByRole("menuitem", { name: "Title" })).toBeNull();
    await user.click(await screen.findByRole("menuitem", { name: "Status" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Status is reading" }),
    );
    expect(onAddQuickFilter).toHaveBeenCalledWith({
      field: "status",
      op: "eq",
      value: "reading",
      label: "Status is reading",
    });
  });

  it("says how many options it left out", async () => {
    const user = userEvent.setup();
    render(
      <FilterPicker columns={columns} activeCount={0} onAddQuickFilter={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Filter" }));
    await user.click(await screen.findByRole("menuitem", { name: "Status" }));
    expect(
      await screen.findByRole("menuitem", { name: "… and 2 more — use a cell" }),
    ).toHaveAttribute("aria-disabled", "true");
  });
});

describe("SortPicker", () => {
  it("names the effective sort and sets a column and direction", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    render(
      <SortPicker
        columns={columns}
        sort={{ field: "title", dir: "asc" }}
        overridden={false}
        onSortChange={onSortChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Sort · Title ↑" }));
    expect(screen.queryByRole("menuitem", { name: "Body" })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Use the view's sort" }),
    ).toBeNull();
    await user.click(await screen.findByRole("menuitem", { name: "Status" }));
    await user.click(await screen.findByRole("menuitem", { name: "Descending" }));
    expect(onSortChange).toHaveBeenCalledWith([{ field: "status", dir: "desc" }]);
  });

  it("offers the view's sort back only when overridden", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    render(
      <SortPicker
        columns={columns}
        sort={{ field: "status", dir: "desc" }}
        overridden
        onSortChange={onSortChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Sort · Status ↓" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Use the view's sort" }),
    );
    expect(onSortChange).toHaveBeenCalledWith(undefined);
  });
});

describe("GroupPicker", () => {
  it("names the effective grouping and ungroups", async () => {
    const user = userEvent.setup();
    const onSetGroup = vi.fn();
    render(
      <GroupPicker
        columns={columns}
        group="status"
        overridden={false}
        onSetGroup={onSetGroup}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Group · Status" }));
    expect(screen.queryByRole("menuitemradio", { name: "Title" })).toBeNull();
    expect(
      screen.getByRole("menuitemradio", { name: "Status" }),
    ).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemradio", { name: "No grouping" }));
    expect(onSetGroup).toHaveBeenCalledWith({ kind: "flat" });
  });

  it("groups by a column and offers the view's grouping back when overridden", async () => {
    const user = userEvent.setup();
    const onSetGroup = vi.fn();
    render(
      <GroupPicker
        columns={columns}
        group={undefined}
        overridden
        onSetGroup={onSetGroup}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Group" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Status" }));
    expect(onSetGroup).toHaveBeenCalledWith({ kind: "by", field: "status" });
    await user.click(screen.getByRole("button", { name: "Group" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Use the view's grouping" }),
    );
    expect(onSetGroup).toHaveBeenLastCalledWith(undefined);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ui && bun run test src/components/bases/__tests__/BasePickers.test.tsx`
Expected: FAIL — cannot resolve `#/components/bases/BasePickers`.

- [ ] **Step 3: Implement** `ui/src/components/bases/BasePickers.tsx`:

```tsx
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
    active
      ? "bg-accent-tint text-accent"
      : "text-ink data-[hovered]:bg-sink",
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
  overridden,
  onSetGroup,
}: {
  columns: PickerColumn[];
  /** The effective grouping column: the override, else the saved view's. */
  group: string | undefined;
  overridden: boolean;
  onSetGroup(group: GroupOverride | undefined): void;
}) {
  const groupable = columns.filter((c) => c.groupable);
  if (groupable.length === 0) return null;
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
          if (id === "flat") onSetGroup({ kind: "flat" });
          else if (id === "inherit") onSetGroup(undefined);
          else if (id.startsWith("by:"))
            onSetGroup({ kind: "by", field: id.slice(3) });
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
```

  If RAC renders `"Use the view's grouping"` inside a single-selection menu as `menuitemradio`, the test above already expects that role. If `onAction` does not fire on a selection menu in the installed RAC version, move the dispatch to `onSelectionChange`. Ledger the ruling.

- [ ] **Step 4: Run to verify they pass**

Run: `cd ui && bun run test src/components/bases/__tests__/BasePickers.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/bases/BasePickers.tsx ui/src/components/bases/__tests__/BasePickers.test.tsx
git commit -m "feat(ui): Bases Filter, Sort and Group pickers"
```

---

### Task 2: The Bases screen chrome — header, Compact switch, view bar, pickers, footer

**Files:**
- Modify: `ui/src/components/bases/BaseTableView.tsx` (props, column-capability helper, header, view bar, footer)
- Modify: `ui/src/components/bases/BaseTable.tsx` (pass `screen`, restyle its two messages)
- Modify: `ui/src/routes/bases.$slug.tsx` (wrapper padding)
- Create: `ui/src/components/bases/__tests__/BaseTableScreen.test.tsx`
- Modify: `ui/src/__tests__/primitivesGuard.test.ts` (add `BASES_FILES`; Task 2's still-Vessel files go in `PENDING`)

**Interfaces:**
- Consumes: pickers and `PickerColumn` (Task 1); `Switch`, `useTableCompact`, `FooterControls`, `Tick` (4.5a).
- Produces: `BaseTableViewProps.screen?: boolean`; the in-component values `dense: boolean` and `rowCountLabel: string | undefined` that Task 3 uses.

- [ ] **Step 1: Guard lists.** In `primitivesGuard.test.ts` add:

```ts
/** Bases (phase 4.5b). */
const BASES_FILES = [
  "../bases/BaseTableView.tsx",
  "../bases/BaseTable.tsx",
  "../bases/BasePickers.tsx",
  "../bases/FieldsPopover.tsx",
  "../bases/ViewOverridesStrip.tsx",
  "../bases/EditableCell.tsx",
  "../bases/BaseMemberDraft.tsx",
  "../bases/BasesIndex.tsx",
  "../bases/CreateBaseDialog.tsx",
  "../../routes/bases.$slug.tsx",
];
```

Spread it into `files`, and set `PENDING` to every `BASES_FILES` entry except `BasePickers.tsx` and `../../routes/bases.$slug.tsx`. Later tasks remove entries as they clean each file.

- [ ] **Step 2: Write the failing tests** — `BaseTableScreen.test.tsx`. Copy the `vi.mock("@tanstack/react-router", …)` block and the `definition`, `row`, `flat`, `enabledCapability`, `memberDraftFields` fixtures verbatim from `__tests__/BaseTableView.test.tsx` (lines 13–97). Then:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BaseTableView } from "#/components/bases/BaseTableView";
import { FooterControlsHost } from "#/components/codex/FooterControls";
import { EMPTY_OVERRIDES } from "#/components/bases/view-overrides";
// …fixtures copied here…

type ViewProps = Parameters<typeof BaseTableView>[0];

function renderScreen(props: Partial<ViewProps> = {}) {
  const spies = {
    onViewChange: vi.fn(),
    onSortChange: vi.fn(),
    onOpenPage: vi.fn(),
    onCommitCell: vi.fn(),
    onAddMember: vi.fn(),
    onAddQuickFilter: vi.fn(),
    onSetGroup: vi.fn(),
    onHideColumn: vi.fn(),
    onShowColumn: vi.fn(),
    onShowHiddenColumns: vi.fn(),
  };
  render(
    <>
      <BaseTableView
        definition={definition}
        activeView="Continues"
        output={flat}
        sort={undefined}
        configureSlug="reading"
        memberCapability={enabledCapability}
        memberDraftFields={memberDraftFields}
        memberDraftOpen={false}
        memberSaving={false}
        memberDiagnostics={[]}
        projects={[]}
        overrides={EMPTY_OVERRIDES}
        screen
        {...spies}
        {...props}
      />
      <FooterControlsHost />
    </>,
  );
  return spies;
}

beforeEach(() => localStorage.clear());

describe("Bases screen chrome", () => {
  it("titles the base in serif under a Base eyebrow with its row count", () => {
    renderScreen();
    expect(
      screen.getByRole("heading", { level: 1, name: "Reading Log" }),
    ).toHaveClass("font-serif");
    expect(screen.getByText("Base")).toBeVisible();
    expect(screen.getAllByText("1 row")[0]).toBeVisible();
  });

  it("starts comfortable and remembers the Compact switch", async () => {
    renderScreen();
    const sw = screen.getByRole("switch", { name: "Compact" });
    expect(sw).not.toBeChecked();
    await userEvent.setup().click(sw);
    expect(sw).toBeChecked();
    expect(localStorage.getItem("clepsydra.tableCompact.bases")).toBe("true");
  });

  it("puts the file path and row count in the footer", () => {
    renderScreen();
    const footer = document.querySelector('[data-slot="footer-controls"]');
    expect(footer).toHaveTextContent("bases/reading.base.toml");
    expect(footer).toHaveTextContent("1 row");
  });

  it("offers Filter, Sort and Group pickers in the view bar", async () => {
    const user = userEvent.setup();
    const spies = renderScreen();
    await user.click(screen.getByRole("button", { name: "Sort" }));
    await user.click(await screen.findByRole("menuitem", { name: "author" }));
    await user.click(await screen.findByRole("menuitem", { name: "Descending" }));
    expect(spies.onSortChange).toHaveBeenCalledWith([
      { field: "author", dir: "desc" },
    ]);
    expect(screen.getByRole("button", { name: "Filter" })).toBeVisible();
  });

  it("names the saved view's grouping on the Group pill", () => {
    renderScreen({ activeView: "Shelf" });
    expect(screen.getByRole("button", { name: "Group · status" })).toBeVisible();
  });

  it("counts filter overrides on the Filter pill", () => {
    renderScreen({
      overrides: {
        ...EMPTY_OVERRIDES,
        quickFilters: [
          { field: "status", op: "eq", value: "reading", label: "status is reading" },
        ],
      },
    });
    expect(screen.getByRole("button", { name: "Filter · 1" })).toBeVisible();
  });

  it("keeps the views as a navigation with the active view current", () => {
    renderScreen();
    const views = screen.getByRole("navigation", { name: "Views" });
    expect(
      within(views).getByRole("button", { name: "Continues" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("shows no pickers when read-only", () => {
    renderScreen({ readOnly: true });
    expect(screen.queryByRole("button", { name: "Sort" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Filter" })).toBeNull();
  });
});

describe("embedded chrome", () => {
  for (const chrome of ["compact", "full"] as const) {
    it(`keeps screen chrome out of a ${chrome} embed`, () => {
      renderScreen({ screen: undefined, chrome });
      expect(screen.queryByRole("switch", { name: "Compact" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Sort" })).toBeNull();
      expect(screen.queryByText("Base")).toBeNull();
      expect(
        document.querySelector('[data-slot="footer-controls"]'),
      ).toBeEmptyDOMElement();
    });
  }
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd ui && bun run test src/components/bases/__tests__/BaseTableScreen.test.tsx`
Expected: FAIL — `screen` is not a prop yet. The heading is not serif, and there is no switch, no pickers and no footer text.

- [ ] **Step 4: Implement** in `BaseTableView.tsx`:

1. Props: add

```ts
  /** The standalone `/bases/$slug` screen: serif header, Compact switch,
   *  view pickers and footer context. Embeds never set it. */
  screen?: boolean;
```

   Destructure `screen = false`.
2. Density, row count and fmt, near the top of the component:

```ts
  // Embeds are always dense (user ruling); the screen follows its switch.
  const [compactRows, setCompactRows] = useTableCompact("bases", false);
  const dense = !screen || compactRows;
```

   After `output` is known, add:

```ts
  const rowCount =
    output?.shape === "flat"
      ? output.total
      : output?.shape === "grouped"
        ? output.groups.reduce((n, g) => n + g.total, 0)
        : undefined;
  const rowCountLabel =
    rowCount === undefined
      ? undefined
      : `${rowCount.toLocaleString("en-US")} ${rowCount === 1 ? "row" : "rows"}`;
```

3. The column-capability helper replaces the inline `allowsSorting` computation in the header `Column`:

```ts
  const columnAllowsSorting = (column: string) => {
    const property = properties.get(column);
    return (
      !readOnly &&
      (SYSTEM_COLUMNS[column] !== undefined
        ? SYSTEM_COLUMNS[column]
        : property != null && canSort(property.type))
    );
  };
  /** One source for the header `⋯` menus and the view-bar pickers. */
  const pickerColumn = (column: string): PickerColumn => {
    const property = properties.get(column);
    const label = displayLabelForColumn(column);
    return {
      column,
      label,
      allowsSorting: columnAllowsSorting(column),
      groupable: groupableColumn(column),
      presets: headerFilterPresets(
        column,
        quickFilterType(column, property),
        property,
        label,
      ),
      optionOverflow: headerOptionOverflow(property),
    };
  };
```

   In the header `Column` render, compute `const capability = pickerColumn(column);` and pass `capability.allowsSorting`, `capability.groupable`, `capability.presets` and `capability.optionOverflow` into `Column`/`BaseHeaderMenu` in place of the inline values.
4. Replace the toolbar `<div className={cn("flex flex-wrap items-center border-b border-rule", …)}>…</div>` with two branches:

```tsx
      {screen ? (
        <>
          <header
            className={cn(
              "flex flex-wrap items-end gap-x-7 gap-y-4",
              dense ? "pt-7" : "pt-10",
            )}
          >
            <div className="flex flex-col gap-2">
              <span className="flex items-center gap-2.5">
                <Tick />
                <span className="font-serif text-[19px] italic text-mute">
                  Base
                </span>
              </span>
              <h1
                className={cn(
                  "font-serif leading-none tracking-[-0.015em] text-ink",
                  dense ? "text-[44px]" : "text-[52px]",
                )}
              >
                {definition.name}
              </h1>
            </div>
            {rowCountLabel ? (
              <span className="pb-1.5 text-[14px] text-mute">
                {rowCountLabel}
              </span>
            ) : null}
            <div className="flex-1" />
            <Switch isSelected={compactRows} onChange={setCompactRows}>
              Compact
            </Switch>
            {configureLink}
            {addMemberButton("primary")}
            {toolbarActions}
          </header>
          <div className="flex min-h-11 flex-wrap items-stretch gap-x-6 gap-y-2">
            {viewsNav}
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {!readOnly ? (
                <>
                  <FilterPicker
                    columns={columns.map(pickerColumn)}
                    activeCount={overrides.quickFilters.length}
                    onAddQuickFilter={onAddQuickFilter ?? noop}
                  />
                  <SortPicker
                    columns={columns.map(pickerColumn)}
                    sort={sort?.[0] ?? view?.sort?.[0]}
                    overridden={sort !== undefined}
                    onSortChange={onSortChange}
                  />
                  <GroupPicker
                    columns={columns.map(pickerColumn)}
                    group={effectiveGroup}
                    overridden={overrides.group !== undefined}
                    onSetGroup={onSetGroup ?? noop}
                  />
                </>
              ) : null}
              {fieldsPopover}
              {collapseAll}
            </div>
          </div>
          <FooterControls>
            <span>{`bases/${definition.slug}.base.toml`}</span>
            {rowCountLabel ? (
              <>
                <span aria-hidden className="text-faint">
                  ·
                </span>
                <span>{rowCountLabel}</span>
              </>
            ) : null}
          </FooterControls>
        </>
      ) : (
        <div
          className={cn(
            "flex flex-wrap items-center",
            compact ? "gap-2 pb-1.5" : "gap-3 pb-2",
          )}
        >
          {compact ? (
            // An embed sits inside someone else's document: naming the Base is
            // still needed, claiming a heading level is not.
            <p className="truncate text-[13px] font-medium text-ink">
              {definition.name}
            </p>
          ) : (
            <h1 className="text-[15px] font-medium text-ink">
              {definition.name}
            </h1>
          )}
          {viewsNav}
          {collapseAll}
          {fieldsPopover}
          {configureLink}
          {addMemberButton("secondary")}
          {toolbarActions}
        </div>
      )}
```

   The `configureLink` / `addMemberButton` `ml-auto` logic moves into the fragments. Build them just above `return` from the existing JSX, unchanged except where noted:
   - `viewsNav`: the existing `<nav aria-label="Views">` with its read-only spans and buttons (`ref`, `aria-current`, `onClick` kept). Restyle it as underline tabs:
     - nav: `className="flex items-stretch gap-5"`.
     - Each button or span: `cn("relative flex items-center px-0.5 text-[13.5px]", screen ? "h-11" : "h-8", active ? "font-medium text-ink after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent" : "text-mute hover:text-ink", FOCUS_RING_NATIVE)`, where `active = asciiCaseFold(v.name) === equivalentActiveView`.
   - `collapseAll`: the existing Collapse/Expand `Button`, same condition.
   - `fieldsPopover`: the existing `FieldsPopover` block, same condition.
   - `configureLink`: the existing `Link`, same condition. Its class is `buttonStyles("secondary", "sm", screen ? undefined : "ml-auto")`.
   - `addMemberButton(variant)`: a function returning the existing Add member `Button` plus its `sr-only` blocker span when `!readOnly`. Its `variant` is the argument. Its class is `screen || configureSlug ? undefined : "ml-auto"`.
5. Imports: `Tick`, `Switch`, `useTableCompact`, `FooterControls`, `FilterPicker` / `SortPicker` / `GroupPicker` / `PickerColumn`, and `FOCUS_RING_NATIVE`.

In `BaseTable.tsx`: pass `screen` to `<BaseTableView>`. Restyle both messages to `className="p-4 text-[13px] text-mute"`.

In `routes/bases.$slug.tsx`: the wrapper becomes `<div className="px-10 pb-10">`.

- [ ] **Step 5: Run to verify they pass**

Run: `cd ui && bun run test src/components/bases src/routes/-bases.slug.test.tsx src/editor src/__tests__/primitivesGuard.test.ts`
Expected: the new file passes. Pending guard cases are expected failures.
- Fix existing assertions that pinned removed chrome, keeping their intent. Each change is a ledger ruling.
- The known risk is `border-accent`/`text-accent` class checks on view buttons. Assert `aria-current` instead.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/bases ui/src/routes/bases.\$slug.tsx ui/src/__tests__/primitivesGuard.test.ts
git commit -m "feat(ui): Bases screen header, Compact switch, view pickers and footer"
```

---

### Task 3: Dense table rows, groups, totals and status notices

**Files:**
- Modify: `ui/src/components/bases/BaseTableView.tsx` (grid, `BodyExcerptCell`, `AggregateChips`, group headers, totals, notices, add-member row)
- Modify: `ui/src/components/bases/EditableCell.tsx`, `FieldsPopover.tsx`, `ViewOverridesStrip.tsx`
- Modify: `ui/src/components/bases/__tests__/BaseTableScreen.test.tsx` (append)
- Modify: `ui/src/__tests__/primitivesGuard.test.ts` (remove `BaseTableView`, `BaseTable`, `EditableCell`, `FieldsPopover`, `ViewOverridesStrip` from `PENDING`)

**Interfaces:**
- Consumes: `dense` (Task 2), `PICKER_PILL` (Task 1).

- [ ] **Step 1: Write the failing tests** — append to `BaseTableScreen.test.tsx`:

```tsx
describe("Bases table density", () => {
  it("renders comfortable rows on the screen by default and compact on request", async () => {
    renderScreen();
    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("data-density", "comfortable");
    await userEvent.setup().click(screen.getByRole("switch", { name: "Compact" }));
    expect(screen.getByRole("grid")).toHaveAttribute("data-density", "compact");
  });

  it("renders embeds dense", () => {
    renderScreen({ screen: undefined, chrome: "compact" });
    expect(screen.getByRole("grid")).toHaveAttribute("data-density", "compact");
  });

  it("shows sentence-case headers and arrows, not caps and triangles", () => {
    renderScreen({ sort: [{ field: "author", dir: "desc" }] });
    const header = screen.getByRole("columnheader", { name: /author/ });
    expect(header).toHaveTextContent("↓");
    expect(header).not.toHaveTextContent("▼");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ui && bun run test src/components/bases/__tests__/BaseTableScreen.test.tsx`
Expected: the three new tests FAIL: there is no `data-density`, and the sort glyph is ▼.

- [ ] **Step 3: Implement**

1. `Table`: add `data-density={dense ? "compact" : "comfortable"}` and `className="w-full border-collapse"`. Then set the size classes for the whole table:
   - `dense`: `text-[12.5px] [--title:13.5px]`;
   - otherwise: `text-[13px] [--title:14.5px]`.
2. `Column` className:

```ts
cn(
  "px-3 text-left text-[12.5px] font-normal text-mute",
  dense ? "h-[34px]" : "h-10",
  allowsSorting && "cursor-pointer data-[hovered]:text-ink",
  compact && "sticky top-0 z-[1] bg-ground",
)
```

   The sort glyph becomes `sortDirection === "ascending" ? "↑" : "↓"`.
3. `Row` className: `cn("group", dense ? "h-8" : "h-[42px]", "data-[hovered]:*:bg-sink")`. `Cell` className: `"px-3 align-middle first:rounded-l-[10px] last:rounded-r-[10px]"`. Rows use `h-*` as a minimum, since table rows grow to fit an open editor (Review Focus 5).
4. Cell contents:
   - Read-only title `<span>`: `block truncate px-1 py-0.5 text-[length:var(--title)] font-medium text-ink`.
   - Title button: `cursor-pointer truncate rounded-md text-left text-[length:var(--title)] font-medium text-ink hover:text-accent` plus `FOCUS_RING_NATIVE`.
   - System read-only span: `block truncate px-1 py-0.5 text-mute tabular-nums`.
5. `BodyExcerptCell` button: `block w-full min-w-0 cursor-pointer truncate rounded-md px-1 py-0.5 text-left text-mute hover:text-accent text-wrap` plus `FOCUS_RING_NATIVE`.
6. `AggregateChips` item:

```tsx
<span
  key={aggregateRow?.id ?? label}
  className="inline-flex h-6 items-center gap-1.5 rounded-full bg-sink px-2.5 text-[12px] text-ink-2 tabular-nums"
>
  <span className="text-mute">{label}</span> {formatCellValue(value as CellValue)}
</span>
```

7. Group `header`: `className={cn("flex flex-wrap items-center gap-3", dense ? "pt-3 pb-1" : "pt-5 pb-1")}`.
   - Toggle `Button` className: `cn("h-auto gap-2 px-1 py-0 font-serif font-normal italic text-ink", dense ? "text-[18px]" : "text-[21px]")`.
   - Chevrons are `h-4 w-4 text-mute`.
   - The count span: `text-[12.5px] text-mute tabular-nums`.
   - The groups container keeps `flex flex-col` with `gap-1` (headers carry their own top padding).
8. Totals `footer`: `mt-2 flex flex-wrap items-center gap-2`; its label span: `text-[12.5px] text-mute`.
9. Notices:
   - `memberNotice` and `capStatus` `<p>`s: `rounded-xl bg-sink px-4 py-2.5 text-[13px] text-mute`.
   - The empty-view `<p>`: same.
   - `viewError` and `rowActionError` alerts: `rounded-xl bg-sink px-4 py-2.5 text-[13px] text-warn`.
   - Loading: `px-1 py-2 text-[13px] text-mute`.
10. The `+ Add member…` row Button className: `w-full justify-start rounded-[10px] px-3 text-[13px] text-mute hover:text-ink`.
11. `EditableCell` display button: `cn("block w-full cursor-text truncate rounded-md px-1 py-0.5 text-left", text === "" ? "text-faint" : "text-ink", "hover:bg-raise", FOCUS_RING_NATIVE)`. It has no size class and inherits the table's size. Read the file's other two guard hits and restyle them with the same vocabulary: `rounded-md`, `bg-raise`/`bg-sink`, `text-mute`, `text-[13px]`.
12. `FieldsPopover` trigger: replace `<Button variant="secondary" size="sm">` with `<AriaButton className={PICKER_PILL(hidden.length > 0)}>`, keeping its children. Restyle its one guard hit.
13. `ViewOverridesStrip`:
    - drop `border-b border-rule pb-1` from the strip;
    - `Chip`: `inline-flex h-7 items-center gap-1.5 rounded-full bg-accent-tint px-3 text-[12.5px] text-accent` with the remove control inside (keep its `aria-label`);
    - alert: `flex items-center gap-2 rounded-xl bg-sink px-4 py-2.5 text-[13px] text-warn`.
14. Guard: remove the five files from `PENDING`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd ui && bun run test src/components/bases src/routes/-bases.slug.test.tsx src/editor src/__tests__/primitivesGuard.test.ts`
Expected: PASS. Fix pinned-glyph or class assertions to the new rendering as ledgered rulings (for example ▲ to ↑).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/bases ui/src/__tests__/primitivesGuard.test.ts
git commit -m "feat(ui): Bases dense rows, serif groups, pill aggregates and quiet notices"
```

---

### Task 4: Member draft row

**Files:**
- Modify: `ui/src/components/bases/BaseMemberDraft.tsx`
- Modify: `ui/src/__tests__/primitivesGuard.test.ts` (remove `BaseMemberDraft.tsx` from `PENDING`)

- [ ] **Step 1: Failing test.** Removing `BaseMemberDraft.tsx` from `PENDING` makes the guard run it as a normal `it`.

Run: `cd ui && bun run test src/__tests__/primitivesGuard.test.ts`
Expected: FAIL, listing its 7 offences.

- [ ] **Step 2: Restyle each offence.**
  - Container: `rounded-xl bg-sink p-4`.
  - Labels: `text-[12.5px] text-mute`.
  - Diagnostics: `text-[13px] text-warn`.
  - No borders, caps or mono.

  Keep every accessible name and role.

- [ ] **Step 3: Run**

Run: `cd ui && bun run test src/__tests__/primitivesGuard.test.ts src/components/bases`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/bases/BaseMemberDraft.tsx ui/src/__tests__/primitivesGuard.test.ts
git commit -m "feat(ui): Bases member draft in Stone & Lamp"
```

---

### Task 5: Bases index and Create base dialog

**Files:**
- Modify: `ui/src/components/bases/BasesIndex.tsx`, `CreateBaseDialog.tsx`
- Modify: `ui/src/components/bases/__tests__/BasesIndex.test.tsx` (append)
- Modify: `ui/src/__tests__/primitivesGuard.test.ts` (empty `PENDING`)

- [ ] **Step 1: Write the failing test** — append to `BasesIndex.test.tsx`, using that file's existing render helper for `BasesIndexView` with at least one base:

```tsx
it("titles the registry in serif under a Registry eyebrow", () => {
  // render BasesIndexView with the file's existing one-base fixture
  expect(screen.getByRole("heading", { level: 1, name: "Bases" })).toHaveClass(
    "font-serif",
  );
  expect(screen.getByText("Registry")).toBeVisible();
});
```

  Also remove the two files from `PENDING`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && bun run test src/components/bases/__tests__/BasesIndex.test.tsx src/__tests__/primitivesGuard.test.ts`
Expected: FAIL: the heading is not serif, the eyebrow reads "Vault registry" in caps, and there are guard offences.

- [ ] **Step 3: Implement.** `BasesIndexView`:
  - **Root:** `mx-auto w-full max-w-5xl px-10 pb-10`.
  - **Header:** `flex flex-wrap items-end justify-between gap-6 pt-10`.
    - Eyebrow: `<span className="flex items-center gap-2.5"><Tick /><span className="font-serif text-[19px] italic text-mute">Registry</span></span>`.
    - h1: `mt-2 font-serif text-[52px] leading-none tracking-[-0.015em] text-ink`.
    - Description: `mt-3 max-w-xl text-[14px] leading-6 text-mute`.
  - **Operation error:** `mt-6 rounded-xl bg-sink px-4 py-2.5 text-[13px] text-hot`.
  - **Empty section:**
    - root `mt-8 rounded-xl bg-sink px-6 py-8`;
    - h2 `font-serif text-[21px] italic text-ink`, text "No saved bases";
    - paragraph `mt-2 max-w-xl text-[14px] leading-6 text-mute`.
  - **List section:** `mt-8 flex flex-col gap-1`.
  - **Article:** `grid gap-3 rounded-xl px-4 py-4 hover:bg-sink md:grid-cols-[minmax(0,1fr)_auto] md:items-center`.
    - Name h2: `text-[16px] font-medium text-ink`.
    - Slug: `text-[12.5px] text-mute`.
    - Description: `mt-1 text-[14px] text-mute`.
    - Meta row: `mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-mute tabular-nums`.
  - **Broken bases:**
    - heading `flex items-center gap-2.5 font-serif text-[19px] italic text-warn` with a `<Tick />` before it, text "Base files needing repair";
    - paragraph `mt-2 text-[14px] text-mute`;
    - list `mt-3 flex flex-col gap-1`.
  - **`BrokenBaseEntry` article:** `flex flex-wrap items-start justify-between gap-3 rounded-xl bg-sink px-4 py-4`.
    - h3: `text-[14px] font-medium text-ink`.
    - Message: `mt-1 text-[13px] text-hot`.
    - Path: `mt-1 break-all text-[12.5px] text-mute`.
  - **Dialog body paragraph:** `text-[14px] leading-6 text-mute`.
  - **Loading and error states:** `mx-auto max-w-5xl px-10 pt-10`, with `text-[13px] text-mute` or `text-hot`.

  `CreateBaseDialog`: replace its 3 guard offences with `text-[12.5px] text-mute`, `rounded-xl bg-sink`, and no borders or mono. Keep the copy.

  Update any existing `BasesIndex.test.tsx` assertion on "Vault registry" to "Registry" as a ledgered ruling.

- [ ] **Step 4: Run**

Run: `cd ui && bun run test src/components/bases src/__tests__/primitivesGuard.test.ts`
Expected: PASS; `PENDING` is empty.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/bases ui/src/__tests__/primitivesGuard.test.ts
git commit -m "feat(ui): Bases index and create dialog in Stone & Lamp"
```

---

### Task 6: Docs, gates, smoke

**Files:**
- Modify: `ui/src/docs/content/bases.mdx`

- [ ] **Step 1: Docs.**
  - At the end of the `/bases/<slug>` paragraph (the one beginning "Open `/bases` to discover"), add:

```mdx
The view bar holds **Filter**, **Sort** and **Group** beside **Fields**. Filter offers each column's presets (the same ones as its header menu); Sort picks a column and a direction; Group picks a column or **No grouping**. The pills name the effective sort and grouping, and turn cobalt while they carry an override; **Use the view's sort** and **Use the view's grouping** drop the override. The **Compact** switch in the header toggles 32px and 42px rows — Bases start comfortable — and is remembered on this device. The footer shows the base file and its row count.
```

  - In the embed section's "An embed renders compact." paragraph, add: "Embedded tables always use compact rows."
  - In the overrides paragraph, change "appear as removable chips in a strip under the toolbar" to "appear as removable chips in a strip under the view bar".

- [ ] **Step 2: Gates**

Run: `cd ui && bun run typecheck && bun run lint && bun run test >| ../.superpowers/gates.log 2>&1; grep -E 'Test Files|Tests ' ../.superpowers/gates.log`
Expected: typecheck 0 errors, lint clean, the full suite green.

- [ ] **Step 3: Browser smoke.** Use a scratch vault with a base that has a select property and a grouped view.
  - Open `/bases/<slug>` in comfortable and compact, in both themes.
  - Exercise Filter, Sort and Group.
  - Edit a cell in a compact row and confirm the row grows.
  - Open a page containing the base as an embed and confirm it has dense rows and no switch or pickers.
  - Check `/bases` in both themes.

- [ ] **Step 4: Commit**

```bash
git add ui/src/docs/content/bases.mdx
git commit -m "docs(ui): Bases pickers, Compact switch and footer"
```
