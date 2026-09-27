# Shared DataTable on TanStack Table — plan

Branch `feat/tanstack-table` (worktree `.worktrees/tanstack-table`), off `develop` 3e57b80f.
`@tanstack/react-table` 9.2.4 added (`ui/package.json`).

## Goal

Bases (`BaseTableView`, React Aria `Table`) and the Gazetteer desktop table (plain `<table>`) render through
one shared `DataTable` in `ui/src/components/ui/data-table/`, built on `@tanstack/react-table` v9. Both gain
column resize, column reorder, column visibility through TanStack state, and a shared `role="grid"` keyboard
model. Gazetteer row selection moves to TanStack `rowSelection`.

## Locked decisions (user, 2026-09-27)

1. Shared `DataTable` primitive; screens supply column specs and cell renderers.
2. Own `role="grid"` roving focus. Reproduce the React Aria behaviour Bases has today (contract below). Existing tests are the contract.
3. Features: resize (new for Bases), visibility, row selection (Gazetteer), reorder (both).
4. Bases widths: localStorage per base + view, key `clepsydra.bases.columns.<slug>.<asciiCaseFold(view)>`, group-collapse style (pure read/write over `ViewStateStorage`, try/catch).
5. Bases column order: a view override `columnOrder` beside `hiddenColumns`; a strip chip; Save writes `view.columns`.
6. Reorder UI: header drag (pragmatic-drag-and-drop, Sheaf pattern) + keyboard. Bases header `⋯` menu gains "Move left" / "Move right". Both tables: Alt+ArrowLeft/Right on a focused header, `aria-keyshortcuts`, live-region announcement "Moved {label} to position {n} of {count}."
7. Pinned: Bases `title` is first, fills the leftover width, cannot move or resize. Gazetteer checkbox + No. stay first, Title fills; Title cannot resize but can move. Every other column moves and resizes.
8. Editor keys: arrows/Home/End/PageUp/PageDown inside a text input or open editor do NOT navigate (fixes today's accidental blur-cancel). Select/Bool keep Alt+Arrow to open.
9. Real row hover: Bases rows get `bg-sink` on hover and the row `⋯` reveals on hover.
10. Gazetteer: Enter on a focused row or cell opens the page (same as click). Sort stays in the "Sort" RadioGroup; headers only show it.
11. Reset: double-click a resize handle resets that width (both). Bases order reset = the strip chip's ×. Gazetteer: a "Reset columns" button beside the Compact switch, shown only when order or widths differ from defaults.
12. Reorder and resize do NOT remount the grid (focus stays on the moved header). Sort, hide, group, revision still remount (existing `evaluationIdentity` key), as today.
13. Sorting and grouping stay server-side (`manualSorting`; groups stay one grid per group).

## Reference notes (read before starting a task)

Scratchpad: `/private/tmp/claude-501/-Users-kit-Source--p-pkm-clepsydra/216cbab9-405f-419f-9503-004605b65843/scratchpad/`
- `tanstack-v9-notes.md` — v9 API; `__scratch_tanstack_v9__.tsx` compiles against 9.2.4.
- `bases-contract.md` — the Bases keyboard/focus/DOM contract and the tests that pin it.
- `gazetteer-notes.md` — Gazetteer anatomy, store, pinned tests, DnD patterns and test harness.
- Installed skill docs: `ui/node_modules/@tanstack/{react-table,table-core}/skills/*/SKILL.md`.

## Architecture

```
ui/src/components/ui/data-table/
  grid-navigation.ts      useGridNavigation(gridRef, opts) — DOM-driven roving focus; no TanStack
  column-reorder.ts       pure helpers: moveColumn(order, id, delta|{target, edge}), pinned-aware
  DataTable.tsx           useTable (v9) + markup + resize handles + header DnD + announcements
  DataTable.stories.tsx
  index.ts
```

`DataTable` props (shape, adjust names only with reason):

```ts
interface DataColumn<TRow> {
  id: string;
  label: string;                      // resize label "Resize the {label} column", announcements
  header?: (ctx: { sorted?: "ascending" | "descending" }) => ReactNode;  // default: label
  cell: (row: TRow, index: number) => ReactNode;
  width?: number;                     // default width; omitted on the fill column
  minWidth?: number; maxWidth?: number;
  fill?: boolean;                     // no <col> width; takes leftover space
  resizable?: boolean; movable?: boolean; pinned?: boolean;   // pinned ⇒ start, never moves
  sortable?: boolean;                 // aria-sort present only when true
  rowHeader?: boolean;                // cells role=rowheader; <tr aria-labelledby>
  align?: "start" | "end";
  headerClassName?: string; cellClassName?: string;
}
interface DataTableProps<TRow> {
  ariaLabel: string; rows: TRow[]; columns: DataColumn<TRow>[]; getRowId(row): string;
  density: "compact" | "comfortable";            // data-density on the grid
  sort?: { column: string; direction: "ascending" | "descending" };
  onHeaderSort?(columnId: string): void;          // click on sortable th, ignoring interactive descendants
  columnOrder: string[]; onColumnOrderChange?(next: string[], moved: string): void;
  columnVisibility?: Record<string, boolean>;
  columnWidths: Record<string, number>; onColumnWidthChange?(id: string, width: number | undefined): void; // undefined = reset
  selection?: { selected: RowSelectionState; onChange(next: RowSelectionState): void;
                allLabel: string; rowLabel(row: TRow): string };    // renders the pinned checkbox column
  onRowActivate?(row: TRow): void;                // click on row + Enter on focused row/cell
  rowClassName?(row: TRow, state: { selected: boolean }): string;
  stickyHeader?: boolean; emptyState?: ReactNode; className?: string; tableRef?: Ref<HTMLTableElement>;
}
```

Implementation rules:
- v9: module-scope `tableFeatures({ columnSizingFeature, columnVisibilityFeature, columnOrderingFeature, columnPinningFeature, rowSelectionFeature, rowSortingFeature })`, `useTable`, `manualSorting: true`, controlled `state` + `onXChange` pairs. Do NOT register `columnResizingFeature`: drags use the existing `useWidthDrag` + `WidthResizer` (pointer events, preview then commit; keyboard ±16px, Home/End, double-click reset), keeping Gazetteer's resize tests valid.
- Widths render through `<colgroup><col data-column=id style={{width}}>`; the fill column's `<col>` has no width; `table-fixed`, `style.minWidth` = Σ widths + fill min.
- `<table role="grid">` › `thead`/`tbody` › `tr role=row` › `th role=columnheader` / `td role=gridcell|rowheader`. Rows stay `<tr>` (context-menu forwarding uses `closest("tr")`).
- Resize handles keep `role="separator"`; reorder affordances must NOT use `role="separator"`. Header accessible name must stay the label (+ whatever the consumer renders, e.g. Bases' "X column menu"); resizer excluded via `aria-labelledby`.
- No Pressable / focusable wrappers inside cells: each cell's first focusable descendant is its real control.
- Drop indicator: inset box-shadow (`inset 2px 0 0 0 var(--accent)` / `inset -2px …`), Sheaf pattern. No hairlines. Stone & Lamp tokens only; `primitivesGuard` must pass.

## Tasks (TDD: write the failing test first, see it fail, implement, see it pass)

Wave 1 runs in parallel (disjoint files). Agents do NOT commit; the lead reviews and commits each task.

### T1 — Grid navigation (`grid-navigation.ts` + `__tests__/grid-navigation.test.tsx`)
Plain `<table role=grid>` fixtures in tests, no TanStack. Reproduce `bases-contract.md` § Keyboard:
- single tab stop (grid tabIndex 0 until a key is focused; row/cell roving tabIndex; Tab in → first row or last focused key; Shift+Tab in → last row; Tab/Shift+Tab from inside leaves the grid);
- ArrowRight/Left walk focusable children within a cell before moving cells; right → first child of next cell, left → last child of previous; bare cell focuses `td`; Left from first cell → `tr`; Right from `tr` → first cell;
- ArrowUp/Down same column index; Up from first body row → header of that index (its first focusable child, else `th`); Down from header → first row; no wrap; Alt+Arrow not intercepted, and not `preventDefault`ed;
- Home/End (row), Ctrl+Home/End (first/last row), PageUp/PageDown;
- Escape and Mod+A pass through untouched;
- portal guard: ignore events whose target is not DOM-contained in the grid;
- editor guard (decision 8): no navigation when the target is `input`, `textarea`, `[contenteditable]`, `select`, or inside `[data-grid-editor]`;
- pointer on blank cell space focuses the cell's first focusable child; mouse focus on a child records the focused key;
- programmatic focus of a `td` redirects to its first focusable child; a direct `.focus()` on a `tr` is allowed and must not be stolen back;
- scroll focused element into view (`scrollIntoView({block:"nearest"})`, guarded for jsdom);
- Enter on a focused `tr`/`td` (not on a button/input) calls `onActivateRow(rowElement)` option.
Hook signature: `useGridNavigation(ref: RefObject<HTMLTableElement>, opts?: { onActivateRow?(tr: HTMLTableRowElement): void; onHeaderMove?(th: HTMLTableCellElement, delta: -1 | 1): void })` — Alt+ArrowLeft/Right on a focused header (or its child) calls `onHeaderMove` and prevents default.

### T2 — Bases column widths store (`bases/column-widths.ts`, `bases/useColumnWidths.ts` + tests)
Mirror `group-collapse.ts` / `useGroupCollapse.ts`: `columnWidthsKey(slug, view)`, pure `readColumnWidths(storage, key)` (validate: finite numbers, clamp 40..640, drop junk), `writeColumnWidths`, hook `useColumnWidths(key)` → `{ widths, setWidth(id, w|undefined) }` re-derived on key change, try/catch everywhere, StrictMode-idempotent.

### T3 — Bases `columnOrder` override (no table rendering changes)
`view-overrides.ts`: `columnOrder?: string[]` in state (`EMPTY_OVERRIDES` has none), `withColumnOrder`, `withoutColumnOrder`, `orderColumns(columns, order)` (unknown ids dropped, missing appended, `title` forced first when present), `hasOverrides` counts it, `applyOverridesToView` applies order before hidden filter and writes `columns` when either changed. `useViewOverrides` + `useBaseTableController` expose `onReorderColumns(next)` / `onResetColumnOrder()`. `ViewOverridesStrip` chip "Column order" with remove (×) → reset. `FieldsPopover` lists columns in the effective order. `BaseHeaderMenu` gains "Move left" / "Move right" items (props `canMoveLeft/Right`, `onMove(delta)`), disabled for `title` and at the edges (neighbour of title counts as an edge). Tests in the existing `__tests__` files for each unit.

Wave 2 (after T1 is reviewed and committed):

### T4 — DataTable (`DataTable.tsx`, `column-reorder.ts`, stories, `__tests__/DataTable.test.tsx`)
Per the props above. Tests: roles/labels; `aria-sort` only on sortable; header click sorts but not from interactive descendants; `<col>` widths + fill column + minWidth; resize via keyboard and pointer (preview then commit once); double-click reset calls `onColumnWidthChange(id, undefined)`; visibility hides columns; pinned columns stay first whatever the order; drag reorder via the jsdom DnD harness (copy from `Sheaf.test.tsx`) including the inset indicator on enter and cleared on leave; Alt+Arrow keyboard move + announcement text; selection column (all/row labels, indeterminate = some && !all, shift not required); `onRowActivate` on click and on Enter; `rowClassName` receives selected; reorder/resize do not remount (the same grid element and focus survive). Uses `useGridNavigation`. Story with both a Bases-like and a Gazetteer-like configuration.

Wave 3 (parallel, after T2–T4 are committed):

### T5 — Migrate BaseTableView
Replace the React Aria `Table`/`TableHeader`/`Column`/`TableBody`/`Row`/`Cell` in `grid(...)` with `DataTable`. Keep: `key={cacheIdentity}` remount and body remount on draft toggle; grid aria-labels; `data-density`; `rowHeader` on the first visible column; header render = today's `BaseHeaderMenu` + arrow; click-to-sort semantics (same column flips, else asc, replaces whole sort; none when readOnly); compact sticky header; every focus mechanism (activeCell, forward focus, created row, archive, `focusEntry`, `focusRow`). Add: widths via `useColumnWidths(columnWidthsKey(slug, activeView))`; order from T3's override; Move left/right + drag + Alt+Arrow wired to `onReorderColumns`; row hover (decision 9); editor guard (mark editor roots `data-grid-editor` if the input guard is not enough). All existing Bases tests must pass; only change a test where the contract itself changed (list each change + reason in the report). New tests: resize persists per view, reorder writes the override and survives without remount, hover reveals `⋯`, arrows inside a TextCell input move the caret not focus.

### T6 — Migrate Gazetteer desktop table
`gazetteerColumns` store → v2 with `columnOrder` (migrate v1 → v2 keeps widths) and `resetColumns()`. Render via `DataTable`: checkbox (via `selection`, TanStack `rowSelection` keyed by path; keep `toggleInSet` exported or move its test), No., Code (codeFit measure preserved: `[data-code-fit]`), Title (fill, movable, not resizable), Tags, Words, Created, Edited. `role="grid"` now: update `getByRole("table")` → `"grid"` in tests (list each change). Keep: GEOMETRY row/header heights, `data-density`, separators exactly "Resize the No./Code/Tags/Words/Created/Edited column" in visual order, tag buttons stop propagation, row click opens tab. Add: Enter opens (decision 10), drag/Alt+Arrow reorder persisted, "Reset columns" button (decision 11). Drop Gazetteer's own `Th`/`ColumnResizer`. `width-resizer.tsx` stays (Folio + Base embed use it).

### T7 — Cleanup & docs
`bun run knip` clean; remove dead code (Bases RAC table imports, `dependencies` list); docs: `ui/src/docs/content/` page for Bases/Gazetteer (resize, reorder, keys) if one exists; update `ui/CLAUDE.md` primitives list with `DataTable`.

## Gates (every task and final)
`cd ui && bun run typecheck && bun run lint && bun run test` (suite was fully green on develop). `bun run knip` at the end. Backend untouched ⇒ no cargo run needed unless a DTO changes (none planned).
