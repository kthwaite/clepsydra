# Base table menus: header, cell, and row — design

Date: 2026-08-28. Vault cards: `TSK-apt-puffin-ccvpf` (header + cell menus, temporary
overrides, save to view) and `TSK-snowy-bench-2064k` (row menu). Source analysis:
vault note "Bases vs OpenBook: gap analysis", items #4, #5, #12.

## Goal

A Base table gets three menus and one overrides strip:

1. **Header menu** on every column: Sort ascending, Sort descending, Filter ▸ (presets),
   Group by / Ungroup, Hide column.
2. **Cell menu** on every property cell: value-derived quick filter, a date submenu, Copy
   value — followed by the row items.
3. **Row menu** (right-click any cell, a ghost `⋯` button in the first cell, or the
   keyboard context-menu key): Open, Open in new tab, Copy wikilink, Duplicate, Archive.
4. **Overrides strip** below the toolbar: one removable chip per temporary override (sort,
   quick filters, grouping, hidden columns), **Clear**, and **Save to view**.

Menus are one component family reused by the standalone table (`/bases/<slug>`) and the
embedded table (Folio embeds), so later layouts (board, gallery) reuse them unchanged.

## Non-goals

- A free-text filter editor in the table. Header "Filter" offers presets only; value-specific
  filters come from cells. (Reuse of `FilterComparisonEditor` in a popover is a later task.)
- Writing reader overrides into an embed fence. Embedded overrides are reader-local.
- Undo for Archive; the Rubbish Bin is the restore path (same as `PageActionsMenu`).
- Copying the page body on Duplicate (the member endpoint cannot seed a body).
- Persisting overrides in the URL or localStorage (`TSK-furry-bugle-vkxsq` owns view state).

## Vocabulary

- **Override**: a request-time change to the active view that is not written to the
  `.base.toml` file. Four kinds: `sort` (exists today, caller-owned), `quick filters`,
  `group`, `hidden columns`.
- **Quick filter**: one `Filter` comparison `{ field, op, value? }` plus a display label,
  produced by a menu item. Quick filters are AND-ed with each other and with the embed's
  fence filter (embedded mode) or the view (both modes).
- **Group override**: `{ kind: "by", field }` or `{ kind: "flat" }`.
- **Overrides strip**: the chip row. `role="group"`, `aria-label="View overrides"`.

## Server contract

### `GET /api/vault/bases/{slug}/views/{view}` (standalone)

`ViewParams` gains two optional query parameters:

| param | type | meaning |
| --- | --- | --- |
| `filter` | JSON-encoded `Filter` string | AND-ed after the base filter and the view filter (same composition as the embed endpoint: `Filter::All([base, view, request])`). |
| `group_by` | string | Replaces the view's `group_by` for this request. The empty string evaluates the view flat. Absent keeps the view's grouping. |

Validation reuses the embed validator: `validate_embed_overrides(base, EmbedOverrides { filter, sort: None, limit: None, group_by })`. Failures return `400` with the same `BaseMemberDiagnostic` body the embed endpoint returns (`ApiError::invalid_embed_query`). Malformed `filter` JSON is `400` with one diagnostic `field: "filter"`, message `filter is not valid JSON`.

### `POST /api/vault/bases/{slug}/views/{view}/evaluate` (embedded)

`BaseViewEvaluateRequest` gains `group_by: Option<String>` with the same sentinel. `validate_embed_window` uses the **effective** grouping (override, else the view's) when refusing `offset > 0`.

### Shared engine changes

- `EmbedOverrides` gains `group_by: Option<&str>`.
- `composed_query_spec` gains a `group_by: Option<GroupOverride>` parameter where
  `enum GroupOverride { Flat, By(String) }`; `None` keeps `view.group_by`.
- `query.rs` exposes `pub(crate) fn is_groupable(resolved: &ResolvedField) -> bool` and `evaluate_grouped` uses it; `base_embed.rs` uses it for `validate_group_semantics` (diagnostic `field: "group_by"`, message ``field `x` cannot group``). Unknown fields reuse `resolve_declared_field`'s messages.
- Aggregates already apply per group or to the flat footer; no change.

### `POST /api/vault/bases/{slug}/members` (Duplicate)

Unchanged. Duplicate is client-composed (below).

### OpenAPI

`ui/src/api/schema.d.ts` is regenerated offline: `cargo run -q --example openapi > target/openapi.json && cd ui && bun run openapi:file`.

## Client state

### Where overrides live

`useBaseTableController` composes a new hook, `useViewOverrides` (`ui/src/components/bases/useViewOverrides.ts`). State:

```ts
interface ViewOverridesState {
  quickFilters: QuickFilter[];       // insertion order; duplicates (same field+op+value) collapse
  group: GroupOverride | undefined;
  hiddenColumns: string[];           // column keys as rendered
}
```

Reset to empty when the active view changes (the controller's `handleViewChange` already resets sort), when the slug changes (standalone route keys `BaseTable` by slug), and on unmount. The sort override stays caller-owned (`options.sort` / `onSortChange`) and is displayed in the strip alongside the others.

Standalone data path: `useBaseView(slug, view, { sort, dir, filter, group_by })` — `ViewOverrides` gains `filter?: BaseFilter` and `groupBy?: GroupOverride`; `filter` is `JSON.stringify`-ed into the query string; `groupBy` maps to `""` or the field.

Embedded data path: the controller composes the **effective filter** = `all([fenceFilter?, ...quickFilters])` (flattened; a single conjunct is sent bare) and passes it as `BaseEmbedConfig.filter`; `BaseEmbedConfig` gains `groupBy?: GroupOverride`, which `normalizeEmbedConfiguration` maps to the `group_by` sentinel in the body and folds into `queryIdentity` (not `predicateIdentity`). The evaluate response's `member_creation` is therefore derived from the effective filter, and member creation sends the effective filter as `embed_filter`, so an embedded member is created to match what the reader sees. Standalone member creation ignores quick filters (the definition-derived capability is unchanged); a created member that falls outside a quick filter triggers the existing "created, but it is not included in the current view" notice.

### Quick-filter derivation (pure, `ui/src/components/bases/quick-filters.ts`)

`quickFilterForCell(column, type, value, definition)` → `QuickFilter | undefined`:

| column type | value | filter | label |
| --- | --- | --- | --- |
| any | empty (`null`, `""`, `[]`) | `is_empty` | `<col> is empty` |
| `bool` | `true` / `false` | `eq true` / `eq false` | `<col> is checked` / `<col> is unchecked` |
| `select`, `text`, `url`, `number`, system scalar (`kind`, `project`) | scalar | `eq value` | `<col> is <value>` (text/url quoted) |
| `multi_select`, `tags`, `aliases` | array | one item per element, `contains e` | `<col> has <e>` |
| `relation` | array of wikilinks | one item per element, `links_to <target>` where `<target>` is the wikilink's target with `[[`/`]]` and any `\|alias` stripped (shared helper with `RelationCell`) — the server's `links_to` canonicalises bare targets only | `<col> links to <target>` |
| `date`, `journal_date` | string | `eq <first 10 chars>` | `<col> is <date>` |
| `datetime`, `created_at`, `updated_at` | string | no equality item (presets only) | — |
| `word_count`, `id`, `title`, `path`, `body`, undeclared columns | — | none (row items only) | — |

`DATE_PRESETS` = the five relative operators. The **cell** menu offers them as a **Filter by date ▸** submenu whose items read Today, This week, Past week, Next week, This month (for `date`, `datetime`, `created_at`, `updated_at`, `journal_date`); the resulting quick filter's label — and therefore its chip — is the full form `<col> is this week`.

`headerFilterPresets(column, type, definition)` for the header **Filter ▸** submenu, in this order (every item's text is its chip text, `<col> <operator label>`):

- `bool`: "<col> is checked", "<col> is unchecked";
- date-like: the five relative presets, "<col> is today" … "<col> is this month";
- `select` / `multi_select` with declared `options`: one "<col> is <option>" / "<col> has <option>" item per option, capped at 12; when options exceed the cap the submenu ends with a disabled item "… and N more — use a cell" (`headerOptionOverflow`);
- every column with a quick-filter type, `number` included: "<col> is empty", "<col> is not empty".

Number columns therefore get the emptiness pair (the server accepts `is_empty`/`not_empty` on numbers); an empty number cell derives `<col> is empty`, a zero derives `<col> is 0`.

Labels reuse `OPERATOR_LABELS` wording; the strip chip text equals the menu item text.

### Save to view (pure, `applyOverridesToView` in `view-overrides.ts`)

Given the wire `ViewDefinition`, the overrides, the sort override, and the currently rendered column list:

- `filter`: `all([view.filter?, ...quickFilters])`, flattened when `view.filter` is already `{ all }`; a single conjunct is stored bare; unchanged when there are no quick filters.
- `group_by`: `by` → field; `flat` → removed; `undefined` → unchanged.
- `sort`: the single sort override key replaces `view.sort` when present.
- `columns`: when `hiddenColumns` is non-empty, `renderedColumns.filter(c => !hidden.includes(c))`; else unchanged.

The PUT body is `{ expected_revision: definition.revision, definition: <BaseFilePayload from the detail response with the one view replaced>, view_origins: views.map(v => ({ kind: "existing", name: v.name })) }`. Success clears every override (including sort, via `onSortChange(undefined)`) and invalidates base queries (the mutation's `onSuccess` already does). `409` → strip message "This base changed elsewhere. Reload, then save again." with a **Reload** button (refetches detail; overrides kept). Other errors → `formatApiError(error, "The view could not be saved.")`.

Save to view is hidden in `readOnly` mode and when `definition` has no matching view.

## Menus

### Primitive

`MenuTrigger` / `Menu` / `MenuItem` / `MenuSeparator` / `SubmenuTrigger` from `#/components/ui/menu`. Every menu in the table hangs off exactly one `⋯` `Button` inside a `MenuTrigger trigger="contextMenu"` — one per column header and one per row (in the row's first visible cell). React Aria's `Pressable`-based `ContextMenuTrigger` is **not** used inside the grid: `Pressable` gives its child a `tabindex`, and React Aria's grid cells focus their first focusable descendant, so a wrapper would steal in-cell focus from the title/editor buttons.

Gestures reach the button by forwarding (`ui/src/components/bases/context-menu-forward.ts`): a non-focusable wrapper `<div>` around each cell's / header's content handles `onContextMenu` (and, for cells, the keyboard context-menu keys: `ContextMenu`, Shift+F10, ⌃Enter on macOS) by re-dispatching a `contextmenu` `MouseEvent` on the row's / header's `⋯` button at the pointer coordinates (or at the origin element's bottom-left for keyboard). React Aria's own `useContextMenu` handler then opens the menu at that point. Forwarded events carry a module-private tag so the button can tell them from a gesture aimed at the button itself. The `⋯` button's press forwards a `contextmenu` at its own rect, and it declares `aria-haspopup="menu"` / `aria-expanded` explicitly (React Aria strips them for context triggers). Menus are named by their trigger button (React Aria's `aria-labelledby`), so they carry no `aria-label` of their own.

### Header

Each `<Column>` body renders a non-focusable forwarding wrapper around the label and sort glyph, followed by the `⋯` button as a sibling:

```
<div class="flex flex-1 items-center gap-1" onContextMenu={forward → header ⋯}>
  <span>{label}{▲▼}</span>
</div>
<MenuTrigger trigger="contextMenu">
  <Button variant="ghost" size="sm" aria-label={`${label} column menu`} aria-haspopup="menu" aria-expanded={isOpen} onPress={forward at own rect}>⋯</Button>
  <Menu>{items}</Menu>
</MenuTrigger>
```

The `⋯` button is the header's only focusable child, so keyboard focus entering a header lands on it (Enter opens the menu; sorting by keyboard goes through the menu). Its label joins the column header's accessible name ("author author column menu") — accepted, since `aria-hidden` would hide it from keyboard users and React Aria's `Column` drops `aria-label`.

Items (`BaseHeaderMenu.tsx`, `headerMenuItems(column)`):

| id | label | enabled when | action |
| --- | --- | --- | --- |
| `sort-asc` | Sort ascending | `allowsSorting` | `onSortChange([{ field, dir: "asc" }])` |
| `sort-desc` | Sort descending | `allowsSorting` | `onSortChange([{ field, dir: "desc" }])` |
| `filter:*` | Filter ▸ submenu | presets non-empty | `onAddQuickFilter(preset)` |
| `group` | Group by <label> / Ungroup | groupable (`canGroup` for properties; system scalars except `id`, `path`, `title`, `body`, `word_count`, `tags`, `aliases`) | `onSetGroup({kind:"by",field})`; when the effective grouping is already this column: "Ungroup" → `onSetGroup({kind:"flat"})` |
| `hide` | Hide column | column ≠ `title` and more than one column visible | `onHideColumn(column)` |

Disabled items carry a `description` explaining why ("Not sortable", "Cannot group by this column", "The title column stays visible"). The header menu is absent in `readOnly` mode.

Effective grouping = `group` override if set, else `view.group_by`.

### Cell + row

Every body cell's content is wrapped in a non-focusable forwarding trigger; the row has one menu, on the `⋯` button in its first visible cell:

```
<Cell>
  <div data-row-id={row.id} data-column={column} onContextMenu={forward → row ⋯} onKeyDown={context keys → forward}>{content}</div>
  {first visible column ? <RowActionsButton …/> : null}   // sibling, not a child, of the wrapper
</Cell>
```

`BaseTableView` keeps one `contextTarget: { rowId, column, origin } | null`. A cell gesture records its column and origin element before forwarding; a press or direct context gesture on the `⋯` button records `{ column: undefined, origin: null }`; the target is cleared when the menu closes. The row `Menu` (rendered only while open) is:

```
{cellItems}          // quick filter(s), Filter by date ▸, Copy value — only when contextTarget.column has a quick-filter type
<MenuSeparator/>     // only when cell items precede row items
{rowItems}
```

On close, React Aria returns focus to the `⋯` button; the table then hands it back to `origin` when that control is still in the document and nothing else (the archive dialog) has claimed focus.

The `⋯` button (`aria-label={`Row actions for ${title}`}`) is a ghost: `opacity-0 pointer-events-none`, revealed on row hover (`Row` has class `group`), `focus-within`, `focus-visible`, and while open. It renders only when at least one row action beyond Open is wired (`onOpenPageInNewTab`, `onCopyWikilink`, `onDuplicateRow`, `onArchiveRow`); a read-only preview with none of them shows no button, and cell right-clicks then fall through to the browser menu. Its label joins the row header cell's accessible name ("<title> Row actions for <title>"), the same trade-off as the header.

Row items (`BaseRowMenu.tsx`, `rowMenuItems(row)`):

| id | label | readOnly | action |
| --- | --- | --- | --- |
| `open` | Open | ✓ | `onOpenPage(row.path)` |
| `open-new-tab` | Open in new tab | ✓ | `onOpenPageInNewTab(row.path)` |
| `copy-wikilink` | Copy wikilink | ✓ | copies `[[${row.title ?? stem(row.path)}]]` via `useCopyToClipboard` (toast owned by the hook) |
| `duplicate` | Duplicate | ✗ | `onDuplicateRow(row)` |
| `archive` | Archive… (`variant="destructive"`) | ✗ | opens the confirm dialog |

Cell items appear only when the cell's column is a declared property or a quick-filterable system column (`quickFilterType` ≠ undefined); the title, path, id, body and word-count cells get row items only. Copy value stays available in `readOnly` (it is non-mutating, like Copy wikilink).

### Copy value

`navigator.clipboard.writeText(formatCellValue(value))` through `useCopyToClipboard`.

## Row actions

`useRowActions` (`ui/src/components/bases/useRowActions.ts`), composed by the controller:

- `openInNewTab(path)`: `openTab("page", path, undefined, { mode: "new" })`. `OpenTabTarget` gains `mode?: "new"`; `workspace.openTab` appends (the `"new"`/`"smart"` branch) when `target.mode === "new"` regardless of `navigationMode`. An existing tab for that page is focused as today.
- `copyWikilink(row)`.
- `duplicate(row)`: 
  1. `GET /api/vault/pages/by-id/{uuid}/properties` and `GET /api/vault/pages/{path}` in parallel.
  2. `fields` = fixed implications from the active capability (`implied.kind === "fixed"`) ⊕ every declared property present on the source with a non-null value ⊕ `kind: row.kind` ⊕ `project: row.project` (when set) ⊕ `tags: meta.tags` (when non-empty). Later entries win. `aliases` are never copied.
  3. `POST /bases/{slug}/members` with `{ base_revision: definition.revision, view: activeView, title: `${title} (copy)`, fields, embed_filter (embedded: the fence filter) }`.
  4. Success: refetch the view and show the notice `Duplicated as “<title> (copy)”.`, or `Duplicated as “<title> (copy)”, but it is not included in the current view.` when the refreshed output lacks the new id. The duplicate does not take focus.
  5. Failure: `rowActionError` = the server message plus each diagnostic message, rendered as `role="alert"` under the toolbar; cleared by the next row action or a view change. `409` → refetch detail and report `The base changed elsewhere; try again.`
- `archive(row)`: confirm dialog (`Dialog`, title "Archive page", description = `row.title ?? row.path`, body copy identical to `PageActionsMenu`: "This page will be removed from normal views.", "Inbound links remain byte-identical and become unresolved after archival.", "You can restore this page from the Rubbish Bin."), confirm button "Confirm archive" (`variant="danger"`). On success: `useArchivePage`'s invalidation runs, the view refetches, and focus moves to the title button of the row that followed the archived one (else the previous row; else the table's entry control via `focusEntry()`). Errors show in the dialog.

The table exposes `focusRow(rowId)` through `BaseTableViewHandle` so the controller can restore focus after archive.

## Overrides strip

Rendered by `ViewOverridesStrip.tsx` between the toolbar and the member draft when any override is present:

```
[View overrides]  Sorted by author ↓ ×   status is reading ×   Grouped by status ×   2 hidden columns ×   [Clear] [Save to view]
```

- Chips are `<Button variant="ghost" size="sm" aria-label="Remove <chip text>">`.
- "Hidden: author, rating ×" lists the hidden column labels (≤3, else "N hidden columns"); removing restores all.
- **Clear** removes everything including the sort override.
- **Save to view** disabled while saving; hidden in `readOnly`.
- Save error / conflict text renders under the strip in `role="alert"`.

## Keyboard

- Column header: arrow/Tab focus lands on the `⋯` button (the header's only focusable child); Enter opens the menu, which carries Sort ascending/descending. Right-click anywhere on the header, or the context-menu key on the button, opens the same menu. Pointer press on the header label still toggles the sort.
- Cell: arrow keys move focus between cells (RAC grid); Tab enters the cell's control (title button / editor button); Shift+F10 / ⌃Enter / Menu key open the cell menu at that control. The `⋯` button is reachable by Tab in the first cell.
- Menus close on Escape and return focus to the trigger (RAC).

## Testing

- Rust unit: `composed_query_spec` with `GroupOverride::{Flat, By}`; `validate_embed_overrides` rejects ungroupable/unknown `group_by`; `validate_embed_window` uses the effective grouping.
- Rust integration (`tests/bases_api.rs`): GET with `filter` narrows (`author eq "Le Guin"` → 1 row), GET `group_by=status` groups the flat `Continues` view, GET `group_by=` (empty) on a grouped view returns flat, GET with invalid JSON → 400, GET `group_by=rating` → 400 with `field: "group_by"`; POST evaluate with `group_by` groups; POST with `group_by` + `offset: 10` → 400.
- UI unit (pure): `quickFilterForCell`, `headerFilterPresets`, `applyOverridesToView`, `composeQuickFilter`, `describe*` labels.
- UI hook: `useViewOverrides` reset on view change; `useBaseTableController` forwards overrides to `useBaseView` (standalone) and to the embed config (embedded); save-to-view PUT body and conflict handling.
- UI component: header menu opens by `⋯` click and right-click; each item calls its callback; disabled items carry descriptions; cell menu shows the derived quick filter; the strip renders chips, removes on click, Clear, Save; row menu items call their callbacks; Archive dialog confirm/cancel; keyboard open via ⌃Enter (mirroring `menu.test.tsx`).
- Store: `openTab` with `{ mode: "new" }` appends in `replace` mode.

## Rulings (recorded for the user)

1. Overrides are controller-local, reset on view change; no URL/fence persistence.
2. Server sentinel for "override to flat" is the empty string, on both endpoints.
3. Header Filter is presets only; no free-text editor.
4. Hide column is a client-only override; `title` never hides; Save to view materialises `columns`.
5. Save to view writes the single sort override over the view's sort list (lossy for multi-key sorts, same as OpenBook).
6. Duplicate copies declared properties + kind/project/tags and the membership implications; body and undeclared keys are not copied.
7. Archive confirms with the `PageActionsMenu` copy; no undo toast.
8. `readOnly`: no header menu, no cell filters, no Duplicate/Archive, no Save.
9. Embedded quick filters travel with the evaluate request and `embed_filter`; standalone member creation ignores them.
11. Duplicate reports through a notice and does not move focus.
12. Context menus are forwarded to one `⋯` `MenuTrigger trigger="contextMenu"` per row / per header (no `Pressable` wrappers inside the grid); keyboard focus in a header lands on `⋯`, so keyboard sorting goes through the menu.
13. Relation quick filters use the unwrapped wikilink target; number columns get the emptiness presets.
14. `ui/vitest.config.ts` `testTimeout` is raised to 15 s: the per-row menu trigger adds ~30% to `BaseTable.test.tsx`'s wall time and the 5 s default was already marginal for jsdom + React Aria suites.
10. Copy wikilink uses the title (`[[Title]]`), falling back to the path stem.
