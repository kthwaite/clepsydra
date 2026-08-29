# Bases view state — design

**Date:** 2026-08-29
**Task:** `TSK-furry-bugle-vkxsq` — items #10, #11, #13 of the note "Bases vs OpenBook: gap analysis"
**Scope:** UI only. No server route, DTO, or `schema.d.ts` change.

Three pieces of ephemeral view state for Base tables:

1. **Group collapse** — collapsible group sections, one collapse/expand-all toggle, remembered per base + view + grouping field in `localStorage`.
2. **Fields visibility** — a **Fields** popover that hides and shows columns through the existing `hiddenColumns` view override.
3. **`?view=` deep link + last-view restore** — the standalone route reads and writes `?view=`, remembers the last explicitly chosen view per base, and scrubs a `?view=` that names no saved view.

## 1. Group collapse

**Where.** `BaseTableView`, grouped output, both chromes (`full`, `compact`) and both modes (standalone, embedded). Presentation state: owned by `BaseTableView`, not the controller.

**Header.** Each group `<section>` header gains a trigger button (ui `Button`, `variant="ghost" size="sm"`) whose content is a chevron (`ChevronDown` when expanded, `ChevronRight` when collapsed) and the group key text. The button carries `aria-expanded` and `aria-controls={panelId}`. The row-count span and `AggregateChips` stay outside the button and remain visible when collapsed.

**Panel.** `<div id={panelId}>` wraps the group's grid. A collapsed group renders no grid (unmounted), so the cost of a collapsed group is its header only.

**Toolbar toggle.** One button after the **Views** nav, rendered only when the output is grouped with at least one group: it reads **Collapse all** while any rendered group is expanded, otherwise **Expand all**. Collapse all stores every rendered group identity; Expand all clears the set.

**Identity.** `groupIdentity(key) = JSON.stringify(key ?? null)` — strings, numbers, booleans, and the empty group stay distinct.

**Persistence.** Key `clepsydra.bases.groups.<slug>.<asciiCaseFold(view)>.<groupField>`, where `groupField` is the *effective* grouping (override before saved `group_by`). Value: JSON array of collapsed identities. Reads validate (array of strings, else empty). Every storage access is try/catch; without storage the fold works in-session only. State is keyed like `useViewOverrides`: a key change reads the new key's stored set.

**Forced open.** A group containing a row that is about to take focus — the just-created member (`focusCreatedId`) or the archive successor (`archiveFocus.nextRowId`) — renders expanded regardless of the stored set, and an effect removes it from the set so it stays open. The `focusRow` handle is unchanged: it returns `false` for a row inside a collapsed group and callers keep their existing fallback.

## 2. Fields visibility

**Trigger.** A **Fields** button (ui `Button`, `variant="secondary" size="sm"`) after the collapse toggle. Its text is `Fields` with no hidden columns, otherwise `Fields (N hidden)`. Rendered only when `!readOnly && onHideColumn && onShowColumn`.

**Popover.** RAC `DialogTrigger` → ui `Popover` (`hideArrow`, `placement="bottom start"`) → RAC `Dialog aria-label="Fields"`. One ui `Checkbox` per saved-view column (`view.columns`, saved order), labelled with the view's display label, `isSelected` when visible. Unticking calls `onHideColumn(column)`; ticking calls `onShowColumn(column)`. A checkbox is disabled, with a description, when the column is `title` (`The title column stays visible`) or when it is the only visible column (`The last column stays visible`) — the same rule the header menu applies. A **Show all** ghost button at the bottom calls `onShowHiddenColumns()` and is disabled when nothing is hidden.

**Override model.** New transition `withoutHiddenColumn(state, column)`; `useViewOverrides` gains `showColumn(column)`; `useBaseTableController` exposes `onShowColumn(column)`; `BaseTableView` gains the optional prop `onShowColumn`. Lifecycle unchanged: hidden columns are a controller-local override, reset on view change, shown as the existing **Hidden: …** chip, dropped by **Clear**, and written to `columns` by **Save to view**.

## 3. `?view=` deep link and last-view restore

**Route.** `/bases/$slug` declares `validateSearch` → `{ view?: string }`: a non-empty trimmed string is kept, anything else is absent. The route component passes `requestedView={search.view}` to `BaseTable`, and two callbacks:

- `onViewChange(name)` → `navigate({ to: "/bases/$slug", params: { slug }, search: { view: name }, replace: true })`
- `onScrubView()` → `navigate({ to: "/bases/$slug", params: { slug }, search: {}, replace: true })`

**Resolution** (`resolveActiveView(views, requested, remembered)` in `view-state.ts`):

1. No views yet (definition loading, or none declared) → `{ view: "", scrub: false }`.
2. `requested` names a view (`asciiCaseFold` match) → that view's canonical name, `scrub: false`.
3. `requested` is set but matches nothing → `scrub: true`, continue.
4. `remembered` names a view → its canonical name.
5. Otherwise the first view.

`BaseTable` runs the scrub through an effect (`onScrubView` once per invalid `requested`). The URL is the source of truth once it carries a `view`; an in-session choice made without a route owner (tests, future hosts) is kept in local state keyed by the `requested` value it was made under, so a later URL change wins.

**Memory.** Key `clepsydra.bases.lastView.<slug>`, value the view name. Written only on an explicit view switch in `BaseTable.handleViewChange` (a deep link alone does not write it). Read once per mount (`BaseTable` is keyed by slug). A remembered name that no longer exists is ignored. Try/catch on both sides.

**Not in scope.** Embedded tables keep their fence-owned `view`; no URL or memory. Sort still resets on view change (existing controller behaviour).

## Accessibility and copy

- Group trigger: name = group key text; `aria-expanded`; `aria-controls`.
- Toggle: `Collapse all` / `Expand all`.
- Fields: button `Fields` / `Fields (N hidden)`; dialog `aria-label="Fields"`; checkboxes named by column label; descriptions `The title column stays visible` / `The last column stays visible`; `Show all`.

## Tests

- `view-state.test.ts` — resolution table (§3), read/write with a fake storage, throwing storage.
- `group-collapse.test.ts` — identity, key format, read validation, write, throwing storage.
- `useGroupCollapse.test.tsx` — toggle / expand / collapseAll / expandAll, persistence, key change re-reads.
- `view-overrides.test.ts`, `useViewOverrides.test.tsx`, `useBaseTableController.test.tsx` — `withoutHiddenColumn` / `showColumn` / `onShowColumn`.
- `routes/-bases.slug.test.tsx` — `validateSearch` trims and drops; navigation on change and scrub uses `replace`.
- `BaseTable.test.tsx` — URL wins over memory (case-insensitive), invalid URL scrubs and falls back to memory, plain open restores memory, stale memory ignored, explicit switch writes memory and reports.
- `BaseTableViewState.test.tsx` — collapse hides the grid and keeps the count, toggle button text and behaviour, persistence across remount, per-key isolation, forced open on `focusCreatedId`; Fields popover behaviours, readOnly and unwired omission.

## Docs

`ui/src/docs/content/bases.mdx` — the Web UI paragraph gains `?view=` and last-view restore; a new **### Group collapse and fields** subsection describes the fold, the toggle, and the Fields popover.

## Rulings

1. Collapse state is presentation state owned by `BaseTableView`, keyed per base + view + effective grouping field, shared by standalone and embedded views of the same base. — Cost if wrong: an embed and the page fold together; trivially split later by adding the mode to the key.
2. A collapsed group unmounts its grid. — Cost if wrong: RAC table state (focused cell) is lost on collapse; acceptable for a fold.
3. One toolbar toggle, not two buttons. — Keeps the compact embed toolbar usable.
4. Focus requests force the containing group open and persist the expansion. — Prevents a created or successor row from being focused into nothing.
5. Fields is a popover of checkboxes, hidden in `readOnly`, with the header menu's title / last-column rule. — Matches the existing Hide column semantics; no second rule to keep in sync.
6. `?view=` navigations use `replace: true`; the URL is authoritative once set; memory is written on explicit switches only; an invalid `?view=` is scrubbed and falls back to memory, then the first view. — Cost if wrong: Back never steps through views (intended).
7. Storage keys `clepsydra.bases.lastView.<slug>` and `clepsydra.bases.groups.<slug>.<view>.<field>`; every access try/catch. — Same posture as `feedDisclosure.ts`.
8. No server change; no `schema.d.ts` regeneration.
