# Atrium, Stats, and Agenda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refocus Atrium on current work by moving inventory and subject frequency to Stats, removing quotation UI and Julian-day display, elevating recents and feeds, and adding a correctly prioritized outstanding-task tile.

**Architecture:** Add a dedicated `/stats` Codex view that owns inventory and subject-frequency queries. Keep Atrium composition-only by extracting an `AgendaTile` whose data comes from the existing task endpoint; extend that endpoint with an authoritative `agenda` sort so pagination cannot hide important tasks. Retain backend `QUOTE` support for existing pages while excluding it from user-facing assignment controls.

**Tech Stack:** Rust/Axum/rusqlite, React 19, TanStack Router and Query, React Aria Components, Tailwind CSS, Vitest/Testing Library, cargo integration tests.

**Spec:** Approved bounded design in the 2026-08-13 conversation; all locked decisions are repeated below.

## Global Constraints

- `/stats` is a dedicated Codex route; do not create a Settings subsystem.
- Stats owns Vessel Inventory, reference-repair count, and Subjects by frequency; Activity remains on Atrium.
- Atrium order is Hero → Recents + Agenda → Feed River → BCL + Sky → Activity → Reading Continues.
- Remove Julian day and Aphorism from Atrium and delete dead aphorism derivation.
- Backend `QUOTE`, `quotes/` projection, existing-page rendering, Gazetteer filtering, repair filtering, and Markdown blockquotes remain supported.
- Exclude `QUOTE` only from creation/assignment controls (`KindSelect`); an existing QUOTE value remains displayable.
- Outstanding agenda tasks are `status=todo`, dated before undated, due ascending, then inline-task priority `A`/`B`/`C`, then unknown/absent, then page path and source span.
- Agenda tile displays at most eight rows plus the authoritative total and links to `/agenda`.
- No client-side re-sort of an arbitrary server page; `sort=agenda` is authoritative in SQL.
- Follow red-green-refactor for every behavior. Parent session runs each targeted command once after the test-only edit (RED) and after implementation (GREEN).
- Subagents must not run formatters, linters, builds, tests, or project-wide validation; the parent owns all command execution.

---

### Task 1: Authoritative agenda ordering

**Files:**
- Modify: `tests/api_tasks_test.rs`
- Modify: `src/api/tasks.rs:311-324`

**Interfaces:**
- Consumes: existing `GET /api/vault/tasks`, `TaskQueryParams.sort`, indexed block properties `due` and `priority`.
- Produces: `sort=agenda`, ordered as due-present first → due ascending → priority rank `A`, `B`, `C`, other/absent → `p.path` → `b.span_start`.

- [ ] **Step 1: Write the failing API contract test**

Add `sort_tasks_for_atrium_agenda` to `tests/api_tasks_test.rs`. Create unchecked tasks spanning: overdue A/B; same-date A/B/C; a same-date unknown priority; undated A/C; one completed task. Request `/api/vault/tasks?status=todo&sort=agenda&limit=8` and assert exact content order, exclusion of the completed task, `tasks.len() == 8` when more than eight outstanding tasks exist, and `total` equals the complete outstanding count.

- [ ] **Step 2: Run RED**

Run: `cargo test --test api_tasks_test sort_tasks_for_atrium_agenda -- --exact`
Expected: FAIL because `sort=agenda` falls back to page order.

- [ ] **Step 3: Implement the minimal SQL ordering**

Add a `Some("agenda")` match arm. Use correlated `block_properties` lookups and explicit `CASE` expressions:

```sql
ORDER BY
  CASE WHEN EXISTS (
    SELECT 1 FROM block_properties bp_due
    WHERE bp_due.page_id = b.page_id
      AND bp_due.span_start = b.span_start
      AND bp_due.key = 'due'
  ) THEN 0 ELSE 1 END,
  COALESCE((
    SELECT bp_due.value FROM block_properties bp_due
    WHERE bp_due.page_id = b.page_id
      AND bp_due.span_start = b.span_start
      AND bp_due.key = 'due'
  ), '') ASC,
  CASE COALESCE((
    SELECT bp_pri.value FROM block_properties bp_pri
    WHERE bp_pri.page_id = b.page_id
      AND bp_pri.span_start = b.span_start
      AND bp_pri.key = 'priority'
  ), '')
    WHEN 'A' THEN 0
    WHEN 'B' THEN 1
    WHEN 'C' THEN 2
    ELSE 3
  END,
  p.path ASC,
  b.span_start ASC
```

Do not alter existing `due`, `priority`, `scheduled`, or default sort semantics.

- [ ] **Step 4: Run GREEN**

Run: `cargo test --test api_tasks_test sort_tasks_for_atrium_agenda -- --exact`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat(tasks): add authoritative agenda ordering`

---

### Task 2: Dedicated Stats view

**Files:**
- Create: `ui/src/components/codex/Stats.tsx`
- Create: `ui/src/components/codex/Stats.test.tsx`
- Create: `ui/src/routes/stats.tsx`
- Modify: `ui/src/components/codex/Atrium.tsx`
- Modify: `ui/src/components/codex/useCodexView.ts`
- Modify: `ui/src/components/codex/viewRegistry.ts`
- Modify: `ui/src/components/codex/__tests__/CodexFrame.test.tsx`
- Modify: `ui/src/routes/__tests__/routeViews.test.ts`

**Interfaces:**
- Consumes: `useStats`, `useTags`, `useContentIndex({ limit: 500 })`, `useReferenceIssues({ limit: 1, offset: 0 })`, `deriveInventory`, `Card`, Gazetteer tag-filter route.
- Produces: `Stats` component and `/stats` route with `staticData.codexView = "stats"`; `CodexView` gains `stats`; `VIEW_REGISTRY.stats` navigates to `/stats` and appears in desktop navigation after Gazetteer.

- [ ] **Step 1: Write failing Stats component tests**

Test that `Stats` renders `Vessel · Inventory`, the expected inventory labels from mocked stats/content, `Subjects, by frequency`, clickable tag rows that navigate to `/gazetteer` with `{ tags: [tag] }`, and a repairs action with the current issue count. Assert Atrium no longer contains Inventory or Subjects.

- [ ] **Step 2: Write failing route/navigation tests**

Extend route-view tests to expect `/stats: "stats"`. Extend frame tests to expect a visible Stats rail button, active state on `/stats`, and navigation `{ to: "/stats" }`.

- [ ] **Step 3: Run RED**

Run: `bun --cwd ui run test src/components/codex/Stats.test.tsx src/components/codex/Atrium.test.tsx src/components/codex/__tests__/CodexFrame.test.tsx src/routes/__tests__/routeViews.test.ts`
Expected: FAIL because `Stats`, `/stats`, and the view descriptor do not exist and Atrium still owns both cards.

- [ ] **Step 4: Implement Stats and move the cards**

Create `Stats.tsx` with the existing Vessel visual language and a 12-column responsive grid. Move, rather than duplicate, inventory and subject-frequency rendering from Atrium. Keep the Repairs action and tag-to-Gazetteer behavior. Add the route and view-registry entries. Do not add Stats to `MOBILE_NAV`; mobile reaches it through the Activity-card action added in Task 5.

- [ ] **Step 5: Run GREEN**

Run the Task 2 test command. Expected: PASS.

- [ ] **Step 6: Commit**

Commit: `feat(ui): move vault statistics to dedicated view`

---

### Task 3: Remove aphorism and quote-assignment UI

**Files:**
- Modify: `ui/src/components/codex/atrium-data.ts`
- Modify: `ui/src/components/codex/atrium-data.test.ts`
- Modify: `ui/src/components/codex/atrium-time.ts`
- Modify: `ui/src/components/codex/Atrium.tsx`
- Modify: `ui/src/components/codex/Atrium.test.tsx`
- Modify: `ui/src/lib/kind.ts`
- Modify: `ui/src/lib/kind.test.ts`
- Modify: `ui/src/components/codex/KindSelect.tsx`
- Modify: `ui/src/components/codex/KindSelect.test.tsx`

**Interfaces:**
- Consumes: exhaustive `KINDS` for backend-compatible resolution; `KindSelect` for creation and assignment.
- Produces: `ASSIGNABLE_KINDS: readonly Exclude<Kind, "QUOTE">[]`; KindSelect lists those options while still rendering an existing `value="QUOTE"` trigger.

- [ ] **Step 1: Write failing behavior tests**

Replace the KindSelect test that assigns QUOTE with assertions that QUOTE is absent from the open picker, NOTE remains assignable, and an existing QUOTE value still renders as `QUOTE`. Add Atrium assertions that Aphorism and the known quotation text are absent. Remove the obsolete aphorism rotation test only after the production function is deleted.

- [ ] **Step 2: Run RED**

Run: `bun --cwd ui run test src/components/codex/KindSelect.test.tsx src/components/codex/Atrium.test.tsx src/components/codex/atrium-data.test.ts`
Expected: FAIL because KindSelect still offers QUOTE and Atrium still renders Aphorism.

- [ ] **Step 3: Implement minimal removal**

Keep `KINDS`, `KIND_META.QUOTE`, folder inference, and all existing-page presentation. Export:

```ts
export const ASSIGNABLE_KINDS = KINDS.filter(
  (kind): kind is Exclude<Kind, "QUOTE"> => kind !== "QUOTE",
);
```

Use it only in `KindSelect`. Delete `APHORISMS`, `aphorismForDay`, the `calendar.aphorism` field, and the Atrium Aphorism card. Do not alter Gazetteer or Repair kind filters.

- [ ] **Step 4: Run GREEN**

Run the Task 3 test command. Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `refactor(ui): retire aphorism and quote assignment`

---

### Task 4: Outstanding Agenda tile

**Files:**
- Create: `ui/src/components/codex/AgendaTile.tsx`
- Create: `ui/src/components/codex/AgendaTile.test.tsx`
- Modify only if required for reuse: `ui/src/components/TaskList.tsx`

**Interfaces:**
- Consumes: `useTasks({ status: "todo", sort: "agenda", limit: 8 })`, `useToggleTaskStatus`, task `properties.due`, task `properties.priority`, `/agenda` navigation, `formatTaskDate`/priority-label conventions already used by `TaskList`.
- Produces: `<AgendaTile className?: string />`, a bounded Card-compatible tile showing total outstanding count and at most eight tasks.

- [ ] **Step 1: Write failing tile tests**

Mock task hooks at the API boundary. Assert the hook receives exactly `{ status: "todo", sort: "agenda", limit: 8 }`; rows retain server order; due, overdue, A/B/C labels, source Folio, loading, error, and empty states render; checking a task calls `useToggleTaskStatus` with `{ pagePath, spanStart, status: "done" }`; the heading/action navigates to `/agenda`; and `total` can exceed rendered row count.

- [ ] **Step 2: Run RED**

Run: `bun --cwd ui run test src/components/codex/AgendaTile.test.tsx`
Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the tile**

Use a semantic list and real checkbox/button controls. Do not sort in React. Reuse existing priority labels (`A → HIGH`, `B → MED`, `C → LOW`) and local-date helpers. Keep row text single-line with an accessible full label. Surface query failure inside the tile without failing Atrium.

- [ ] **Step 4: Run GREEN**

Run the Task 4 test command. Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat(ui): add outstanding agenda tile`

---

### Task 5: Compose the streamlined Atrium

**Files:**
- Modify: `ui/src/components/codex/Atrium.tsx`
- Modify: `ui/src/components/codex/Atrium.test.tsx`
- Modify: `ui/src/components/codex/FeedAtriumQueryPolicy.integration.test.tsx`
- Modify as needed: `ui/src/components/codex/FeedRiverPanel.tsx`

**Interfaces:**
- Consumes: `AgendaTile`, `/stats` navigation, existing Recents, `FeedRiverPanel`, BCL, `SkyCard`, Activity, and Reading Continues.
- Produces: approved Atrium ordering and responsive spans.

- [ ] **Step 1: Write failing composition tests**

Assert, using DOM document-position comparisons, this exact order: Daystart hero → Recents/Agenda row → Feed River → BCL/Sky row → Activity → Reading Continues when present. Assert Inventory, Subjects, Aphorism, and `JD ` text are absent. Assert Activity exposes a Stats action that navigates to `/stats`. Test BCL configured: BCL and Sky share the row; BCL absent: Sky spans the full row.

- [ ] **Step 2: Run RED**

Run: `bun --cwd ui run test src/components/codex/Atrium.test.tsx src/components/codex/FeedAtriumQueryPolicy.integration.test.tsx`
Expected: FAIL against the old section order and missing Agenda/Stats actions.

- [ ] **Step 3: Implement the composition**

Remove Atrium-owned stats/tag/reference queries. Remove the Julian-day span and dead calendar field/import. Place Recents at `lg:col-span-7` and Agenda at `lg:col-span-5` directly after Hero. Place Feed River next. Render BCL and Sky in a shared 12-column wrapper so Sky uses five columns with BCL and twelve without it. Make Activity full width and add the Stats action. Preserve existing loading/query policy inside Feed River and all Recents tab behavior.

- [ ] **Step 4: Run GREEN**

Run the Task 5 test command. Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat(ui): streamline Atrium around current work`

---

### Task 6: Documentation, generated artifacts, and final verification

**Files:**
- Modify: `ui/src/docs/content/tasks-agenda-journals-and-board.mdx`
- Modify route/schema generated files only when project commands require them.
- Modify affected feature-inventory or route tests discovered by the gates.

**Interfaces:**
- Consumes: final routes and agenda sort behavior.
- Produces: user-facing documentation that names the Atrium Agenda summary and `sort=agenda` semantics.

- [ ] **Step 1: Update documentation**

Document the Atrium summary as eight outstanding tasks ordered by due then inline priority A/B/C, with undated tasks last and `/agenda` as the full surface. Mention Stats as the location for inventory and subject frequency. Do not describe QUOTE as removed from storage or APIs.

- [ ] **Step 2: Run focused suites**

Run:

```bash
cargo test --test api_tasks_test
bun --cwd ui run test src/components/codex src/routes/__tests__/routeViews.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run required gates**

Run independently and report each result:

```bash
cargo test
cargo clippy --all-targets --all-features -- -D warnings
bun --cwd ui run typecheck
bun --cwd ui run lint
bun --cwd ui run test
```

Expected: all PASS with no warnings treated as errors.

- [ ] **Step 4: Browser smoke test**

Run the actual app, open `/`, and verify desktop and mobile widths. Exercise: Agenda completion; `/agenda` link; Stats action; `/stats` inventory, tags, repairs link; Recents tabs; Feed River placement; BCL-present or absent layout available in the running configuration. Confirm no Aphorism, Inventory, Subjects, or JD remains on Atrium.

- [ ] **Step 5: Final review and integration**

Review every changed file against the approved design, commit remaining documentation/generated changes, merge the feature branch into `develop`, and remove the worktree.
