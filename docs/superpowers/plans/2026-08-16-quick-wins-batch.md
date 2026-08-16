# Quick Wins Batch (TSK-0068/0069/0071/0089/0090) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver five small, independent UI improvements: remove the redundant Atrium rail entry, document pip colours, scope the sidebar Attachments block to the current page, make Tasking kanban columns resizable, and make the archived-page banner collapsible.

**Architecture:** Five file-disjoint UI-only tasks on one feature branch (`feature/quick-wins-2026-08-16` off `develop`), one commit per task. No backend changes; no OpenAPI regeneration needed.

**Tech Stack:** React 19, Zustand (persist middleware), Vitest + Testing Library, Tailwind v4 Vessel tokens, MDX docs.

**Spec:** The five TASKING pages `tasks/clepsydra/TSK-{0068,0069,0071,0089,0090}.md` in the vault, plus these interview decisions:
- TSK-0071: default list = attachments referenced by the current page; a "Show all" toggle reveals the full vault list.
- TSK-0090: collapsed state keeps a thin strip with "Captured record", the page title, the toggle, and the back link; state persisted globally in localStorage.
- TSK-0069: documentation lives as a new section in `getting-started.mdx`.

## Global Constraints

- Verification gates: `cd ui && bun run typecheck` and `cd ui && bun run test` must pass before completion. (`bun --cwd` is broken for this repo — always `cd ui && bun run …`.)
- develop is NOT lint-clean (175 pre-existing ui lint errors). NEVER run `biome check --write` repo-wide. Lint gate = `cd ui && bunx biome check <only-the-files-you-touched>` is clean.
- Zero border-radius, Vessel tokens only (`--accent`, `--cool`, `--warn`, `--hot`, ink ramps). Match surrounding class idioms.
- Subagents DO NOT commit. The orchestrator reviews and commits after each task.
- All work UI-side; do not touch `src/` (Rust), `routeTree.gen.ts`, or `schema.d.ts`.

---

### Task 1: Remove the Atrium desktop rail entry (TSK-0068)

**Files:**
- Modify: `ui/src/components/codex/viewRegistry.ts:182-194` (DESKTOP_NAV)
- Test: `ui/src/components/codex/__tests__/CodexFrame.test.tsx`

**Interfaces:**
- Consumes: `DESKTOP_NAV: readonly CodexView[]` rendered by `DesktopCodexFrame` with `pad2(i)` diegetic indices.
- Produces: DESKTOP_NAV without `"atrium"`; new rail indices folio=00, gazetteer=01, stats=02, constellation=03, tasking=04, academic=05, bases=06, feeds=07, docs=08, rubbish=09. MOBILE_NAV unchanged.

- [ ] **Step 1: Update the tests to the post-removal contract (they must fail first)**

In `CodexFrame.test.tsx`:

1. The two `it.each` blocks at ~272 ("keeps near-prefix Docs path %s in Atrium") and ~397 ("does not treat near-prefix path %s as Bases") currently assert `/00.*ATRIUM/` has `aria-current="page"`. Replace that assertion in both with:

```tsx
expect(nav.queryByRole("button", { name: /ATRIUM/i })).not.toBeInTheDocument();
for (const button of nav.getAllByRole("button")) {
  expect(button).not.toHaveAttribute("aria-current", "page");
}
```

(Keep the existing negative DOCS/BASES assertions but fix their indices per step 2's table.)

2. Find every rail-index regex with `rg -n '/0[0-9]\\.\\*' ui/src/components/codex/__tests__/CodexFrame.test.tsx` and decrement each index by one (e.g. `/09.*DOCS/` → `/08.*DOCS/`, `/07.*BASES/` → `/06.*BASES/`). Also check `CodexFrameBreakpoint.integration.test.tsx` and `CommandPalette.test.tsx` for the same patterns (`rg -n '0[0-9]\\.\\*(ATRIUM|FOLIO|GAZETTEER|STATS|CONSTELLATION|TASKING|ACADEMIC|BASES|FEEDS|DOCS|RUBBISH)' ui/src`). The command-palette "Open Atrium" entry is unrelated — leave it.

3. Add one new assertion to an existing desktop-rail test: `nav.getByRole("button", { name: /00.*FOLIO/i })` — locking in that FOLIO now leads the rail. Do NOT touch the mobile-roots tests (~530, ~661) or the wordmark tests (~496, ~742): mobile keeps Atrium, the wordmark keeps returning to it.

- [ ] **Step 2: Run to verify the updated tests fail**

Run: `cd ui && bun run test CodexFrame`
Expected: FAIL — ATRIUM button still present at index 00.

- [ ] **Step 3: Remove `"atrium"` from DESKTOP_NAV**

```ts
export const DESKTOP_NAV: readonly CodexView[] = [
  "folio",
  "gazetteer",
  "stats",
  "constellation",
  "tasking",
  "academic",
  "bases",
  "feeds",
  "docs",
  "rubbish",
];
```

Leave `VIEW_REGISTRY.atrium` (mobile + wordmark + goToView still use it) and MOBILE_NAV untouched.

- [ ] **Step 4: Run to verify pass**

Run: `cd ui && bun run test CodexFrame CodexFrameBreakpoint CommandPalette`
Expected: PASS.

- [ ] **Step 5: Orchestrator review + commit**

```bash
git add ui/src/components/codex/viewRegistry.ts ui/src/components/codex/__tests__/
git commit -m "feat(ui): remove redundant Atrium rail entry (TSK-0068)"
```

---

### Task 2: Collapsible archive provenance banner (TSK-0090)

**Files:**
- Modify: `ui/src/components/codex/ArchiveBanner.tsx`
- Create: `ui/src/components/codex/__tests__/ArchiveBanner.test.tsx`

**Interfaces:**
- Consumes: `ArchiveBannerProps { title, path, archive }` — unchanged; `archive.$.tsx` needs no edits.
- Produces: banner with internal collapse state persisted at localStorage key `clepsydra.archive-banner-collapsed` (`"1"` collapsed).

- [ ] **Step 1: Write the failing tests**

Create `ArchiveBanner.test.tsx`. Wrap renders in a router-less environment: `ArchiveBanner` uses TanStack `Link`, so reuse whatever router test harness `FolioNavigation.test.tsx` or sibling tests use for components with `Link` (a memory-history `RouterProvider` or an existing helper — copy the lightest pattern found there). Fixture:

```tsx
const archive = {
  domain: "example.com",
  url: "https://example.com/article",
  captured_at: "2026-08-01T12:00:00Z",
  site_name: "Example",
  byline: null,
  published_time: null,
  snapshot_hash: "sha256:abc",
} as ArchiveMeta; // cast via components["schemas"]["ArchiveMetaResponse"]
```

Tests:
1. `renders expanded by default with provenance details` — `getByRole("heading", { name: "Example Article" })` visible, "Captured" label present, toggle has `aria-expanded="true"`.
2. `collapse hides provenance but keeps title strip and back link` — click toggle (`getByRole("button", { name: /collapse archive banner/i })`); provenance "Captured" label gone; title still visible (in the strip); "← Back to vault page" link still present; toggle now `aria-expanded="false"` with accessible name `/expand archive banner/i`.
3. `collapse state persists via localStorage` — `localStorage.setItem("clepsydra.archive-banner-collapsed", "1")` before render → renders collapsed; toggling writes `"0"`. Clear localStorage in `beforeEach`.

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && bun run test ArchiveBanner`
Expected: FAIL — no toggle button exists.

- [ ] **Step 3: Implement**

In `ArchiveBanner.tsx`:

```tsx
const COLLAPSE_KEY = "clepsydra.archive-banner-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  } catch {
    // Private-mode storage failures degrade to session-only state.
  }
}
```

Component: `const [collapsed, setCollapsed] = useState(readCollapsed);` and a toggle handler that flips state and calls `writeCollapsed`. Layout:
- Top strip (always rendered): keep "Captured record" eyebrow; when collapsed, add a truncated inline title `<span className="min-w-0 truncate font-sans text-[11px] font-bold text-ink">{title}</span>` between eyebrow and the right-side controls; right side = toggle button then the existing back link.
- Toggle button (Vessel idiom, mono, no radius):

```tsx
<button
  type="button"
  onClick={toggle}
  aria-expanded={!collapsed}
  aria-label={collapsed ? "Expand archive banner" : "Collapse archive banner"}
  className="cl-mono shrink-0 cursor-pointer border border-rule px-1.5 text-[9px] uppercase tracking-[0.16em] text-ink-mute hover:border-accent hover:text-accent"
>
  [{collapsed ? "+" : "–"}]
</button>
```

- The details block (the `grid … md:grid-cols-…` div with h1/url/provenance) renders only when `!collapsed`.

- [ ] **Step 4: Run to verify pass**

Run: `cd ui && bun run test ArchiveBanner`
Expected: PASS.

- [ ] **Step 5: Orchestrator review + commit**

```bash
git add ui/src/components/codex/ArchiveBanner.tsx ui/src/components/codex/__tests__/ArchiveBanner.test.tsx
git commit -m "feat(ui): collapsible archive provenance banner (TSK-0090)"
```

---

### Task 3: Scope sidebar attachments to the current page (TSK-0071)

**Files:**
- Modify: `ui/src/components/attachments/AttachmentManager.tsx`
- Modify (only if `pageMarkdown` is not already passed): `ui/src/components/codex/Folio.tsx` (~1304, the sidebar `<AttachmentManager …>` call)
- Test: `ui/src/components/attachments/__tests__/AttachmentManager.test.tsx`

**Interfaces:**
- Consumes: `useAttachments()` (vault-wide list), `attachmentReferences(markdown): AttachmentReference[]` and `canonicalAttachmentPath(path)` from `#/lib/markdown/attachmentReferences`, existing prop `pageMarkdown?: string`.
- Produces: list defaults to referenced-by-current-page; toggle button accessible names `/show all attachments/i` and `/show referenced attachments/i`.

- [ ] **Step 1: Verify the Folio call site passes `pageMarkdown`**

Read the `<AttachmentManager` JSX in `Folio.tsx` (~1304). If `pageMarkdown` is absent, pass the same markdown source the component already has in scope for `missingReferences` handling on protected pages (the current page body state). If present, no Folio change.

- [ ] **Step 2: Write the failing tests**

Extend `AttachmentManager.test.tsx`, following its existing mock setup for `useAttachments`. With two attachments `a.png` and `b.pdf` and `pageMarkdown` containing a reference only to `a.png` (use `attachmentUrl("a.png")`-shaped markdown, e.g. `![shot](/api/vault/attachments/a.png)`):

1. `defaults to attachments referenced by the page` — `a.png` listed, `b.pdf` absent, toggle reads `Show all (2)`.
2. `show-all toggle reveals the vault-wide list` — after click: both listed; toggle reads `Show referenced (1)`; clicking again returns to scoped.
3. `scoped empty state` — `pageMarkdown` with no references: text `No attachments referenced by this page.` plus the toggle still offering `Show all (2)`.
4. `vault-wide empty state unchanged` — zero attachments total: existing `No attachments in this vault.` and no toggle.
5. `no pageMarkdown prop behaves as show-all` — when `pageMarkdown` is `undefined` (non-Folio callers), the full list renders and no toggle appears.

- [ ] **Step 3: Run to verify failure**

Run: `cd ui && bun run test AttachmentManager`
Expected: FAIL — no toggle, all attachments always listed.

- [ ] **Step 4: Implement**

In `AttachmentManager.tsx`:

```tsx
const scopedToPage = pageMarkdown !== undefined;
const referencedPaths = useMemo(
  () =>
    new Set(
      attachmentReferences(pageMarkdown ?? "").map((reference) => reference.path),
    ),
  [pageMarkdown],
);
const [showAll, setShowAll] = useState(false);
const visibleAttachments = useMemo(() => {
  if (!attachments || !scopedToPage || showAll) return attachments;
  return attachments.filter((attachment) =>
    referencedPaths.has(canonicalAttachmentPath(attachment.path)),
  );
}, [attachments, referencedPaths, scopedToPage, showAll]);
```

Render changes:
- Map over `visibleAttachments` instead of `attachments`.
- Keep `No attachments in this vault.` for `!attachments?.length`. When the vault has attachments but `visibleAttachments` is empty (scoped, not showAll): `<p className="text-ink-mute">No attachments referenced by this page.</p>`.
- Toggle (rendered when `scopedToPage && attachments?.length`), above the list:

```tsx
<button
  type="button"
  onClick={() => setShowAll((current) => !current)}
  className="mb-1.5 cursor-pointer uppercase tracking-[0.08em] text-ink-mute hover:text-accent"
>
  {showAll
    ? `Show referenced attachments (${referencedCount})`
    : `Show all attachments (${attachments.length})`}
</button>
```

where `referencedCount` is computed from `attachments.filter(…referencedPaths…).length` (reuse the scoped array by computing it unconditionally and choosing at render). Leave `missingReferences` (protected-page warning), upload, insert, and delete flows untouched.

- [ ] **Step 5: Run to verify pass**

Run: `cd ui && bun run test AttachmentManager`
Expected: PASS.

- [ ] **Step 6: Orchestrator review + commit**

```bash
git add ui/src/components/attachments/ ui/src/components/codex/Folio.tsx
git commit -m "feat(ui): scope sidebar attachments to the current page (TSK-0071)"
```

---

### Task 4: Resizable Tasking kanban columns (TSK-0089)

**Files:**
- Modify: `ui/src/store/board.ts`
- Modify: `ui/src/components/tasking/KanbanView.tsx`
- Create: `ui/src/components/tasking/__tests__/KanbanResize.test.tsx`

**Interfaces:**
- Consumes: `useBoardStore` (zustand + persist, name `clepsydra.board`, version 1), `KanbanDropColumn` with class `flex-[1_0_282px]`.
- Produces: store fields `columnWidths: Record<string, number>`, actions `setColumnWidth(col: string, width: number)` (clamped) and `resetColumnWidth(col: string)`; exported `KANBAN_COL_MIN = 220`, `KANBAN_COL_MAX = 640`, `clampColumnWidth(width: number): number` from `board.ts`.

- [ ] **Step 1: Write the failing tests**

Create `KanbanResize.test.tsx` (reuse `fixtures.ts` and the render harness from `KanbanView.test.tsx`). Reset the store in `beforeEach` via `useBoardStore.setState({ columnWidths: {} })`.

Store-level:
```tsx
it("clamps column widths to [220, 640]", () => {
  useBoardStore.getState().setColumnWidth("FIELD", 100);
  expect(useBoardStore.getState().columnWidths.FIELD).toBe(220);
  useBoardStore.getState().setColumnWidth("FIELD", 9000);
  expect(useBoardStore.getState().columnWidths.FIELD).toBe(640);
  useBoardStore.getState().resetColumnWidth("FIELD");
  expect(useBoardStore.getState().columnWidths.FIELD).toBeUndefined();
});
```

Component-level (render `KanbanView` with fixtures):
1. `applies a stored width to the column` — `setColumnWidth("INTAKE", 400)`; `getByTestId("kb-col-INTAKE")` has inline style `flex: 0 0 400px`.
2. `each column exposes a resize separator` — `getAllByRole("separator", { name: /resize .* column/i })` has one per column, each with `aria-orientation="vertical"`, `aria-valuemin="220"`, `aria-valuemax="640"`.
3. `keyboard resize` — focus the INTAKE separator, press `ArrowRight`: store width becomes `282 + 16 = 298` (default basis 282 when unset); `ArrowLeft` twice → 266; `Home`… no: press `Enter` is unused; instead assert double-click resets: `fireEvent.doubleClick(separator)` → width undefined again.

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && bun run test KanbanResize`
Expected: FAIL — `setColumnWidth` undefined.

- [ ] **Step 3: Implement the store additions**

In `board.ts` (state + actions + partialize; persisted `version` stays 1 — the new key merges shallowly into old snapshots):

```ts
export const KANBAN_COL_MIN = 220;
export const KANBAN_COL_MAX = 640;
export const KANBAN_COL_DEFAULT = 282;
export const clampColumnWidth = (width: number): number =>
  Math.min(KANBAN_COL_MAX, Math.max(KANBAN_COL_MIN, Math.round(width)));
```

State: `columnWidths: Record<string, number>;` default `{}`. Actions:

```ts
setColumnWidth: (col, width) =>
  set((state) => ({
    columnWidths: { ...state.columnWidths, [col]: clampColumnWidth(width) },
  })),
resetColumnWidth: (col) =>
  set((state) => {
    const { [col]: _removed, ...columnWidths } = state.columnWidths;
    return { columnWidths };
  }),
```

Add `columnWidths: state.columnWidths` to `partialize`.

- [ ] **Step 4: Implement the column + handle**

In `KanbanView.tsx`:
- `KanbanDropColumn` root: add `relative` to the class list, subscribe `const width = useBoardStore((s) => s.columnWidths[status]);` and set `style={{ …existing drop-target background…, ...(width ? { flex: `0 0 ${width}px` } : {}) }}`.
- New `ColumnResizeHandle` rendered as the last child of the column root:

```tsx
function ColumnResizeHandle({ status, label }: { status: string; label: string }) {
  const setColumnWidth = useBoardStore((s) => s.setColumnWidth);
  const resetColumnWidth = useBoardStore((s) => s.resetColumnWidth);
  const width = useBoardStore((s) => s.columnWidths[status]);
  const current = width ?? KANBAN_COL_DEFAULT;

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const column = handle.parentElement;
    const startX = event.clientX;
    const startWidth =
      column?.getBoundingClientRect().width ?? current;
    handle.setPointerCapture(event.pointerId);
    const onMove = (move: PointerEvent) =>
      setColumnWidth(status, startWidth + (move.clientX - startX));
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      aria-valuemin={KANBAN_COL_MIN}
      aria-valuemax={KANBAN_COL_MAX}
      aria-valuenow={current}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => resetColumnWidth(status)}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          setColumnWidth(status, current + 16);
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          setColumnWidth(status, current - 16);
        }
      }}
      className="absolute right-0 top-0 z-[3] h-full w-[5px] cursor-col-resize outline-none hover:bg-[color-mix(in_oklab,var(--accent)_35%,transparent)] focus-visible:bg-[color-mix(in_oklab,var(--accent)_35%,transparent)]"
    />
  );
}
```

- Thread `label` (from `col.label` in the map) into `KanbanDropColumn` or render the handle inside the existing `columns.map` where `col.label` is in scope (pass `label` as a new prop to `KanbanDropColumn` and render `<ColumnResizeHandle status={status} label={label} />` inside it).

- [ ] **Step 5: Run to verify pass, plus the existing suite**

Run: `cd ui && bun run test KanbanResize KanbanView`
Expected: PASS (existing KanbanView drag/drop tests unaffected).

- [ ] **Step 6: Orchestrator review + commit**

```bash
git add ui/src/store/board.ts ui/src/components/tasking/
git commit -m "feat(ui): resizable Tasking board columns (TSK-0089)"
```

---

### Task 5: Document pip colours (TSK-0069)

**Files:**
- Modify: `ui/src/docs/content/getting-started.mdx` (new section after `## Keyboard shortcut help`, before `## Wikilinks`)

**Interfaces:**
- Consumes: the verified pip inventory below (re-verify each against source before writing; cite nothing not in code).
- Produces: a `## Pips and status colours` section.

- [ ] **Step 1: Verify the inventory against source**

Check each mapping in: `ui/src/lib/kind.ts` (KIND_META), `ui/src/components/tasking/board-constants.tsx` (StatePip, CycleStatePip, HealthDot, PriChip), `ui/src/components/codex/Card.tsx` (PIP_CLASS), `ui/src/components/codex/DesktopCodexFrame.tsx` (footer sync + writing pips), `ui/src/components/codex/FeedRiverPanel.tsx` (hot-on-diagnostics). Adjust the drafted section if any mapping differs.

- [ ] **Step 2: Add the section**

```mdx
## Pips and status colours

Small square "pips" carry status throughout the Vessel chrome. They draw
from four signal tokens — **orange** (accent), **cyan** (cool), **amber**
(warn), **red** (hot) — plus the grey ink ramp for neutral states.

### Kind pips

Every page kind has a fixed pip colour, shown in Gazetteer, Constellation,
Sheaf tabs, link previews, and the Folio rails:

| Colour | Kinds |
| --- | --- |
| Orange (accent) | PROJECT |
| Deep orange | BOOK, RECIPE |
| Cyan (cool) | JOURNAL, PERSON, CAPTURE, AI CONVERSATION |
| Amber (warn) | TODO, QUOTE |
| Red (hot) | TASK |
| Ink / greys | CODE (bright), CYCLE, NOTE, ARCHIVE (progressively muted) |

### Board pips (TASKING)

| Pip | Meaning |
| --- | --- |
| Faint grey | INTAKE or SEALED column |
| Grey | TRIAGE column |
| Cyan | IN-FIELD column |
| Amber | REVIEW column |

Cycle pips: outlined box = PLANNED, blinking cyan = ACTIVE, amber =
BACKLOG, faint grey = CLOSED. Operation health dots: cyan = green, amber =
attention, blinking red = critical. Priority chips: P0 red, P1 amber, P2
cyan, P3 grey.

### Dashboard card pips (Atrium)

Card headers carry a pip: pulsing cyan = live and healthy, pulsing orange =
needs attention (for example the Feed river after fetch diagnostics),
static grey = inactive.

### Footer telemetry pips

The VESSEL footer strip shows two pips: the connection pip (cyan =
connected, amber = connecting, red = disconnected from the event stream)
and the write pip, which pulses orange while changes are being sent to the
server.
```

- [ ] **Step 3: Run the docs-affine tests**

Run: `cd ui && bun run test featureInventory docs`
Expected: PASS (the section is additive; no registry entries change).

- [ ] **Step 4: Orchestrator review + commit**

```bash
git add ui/src/docs/content/getting-started.mdx
git commit -m "docs(ui): document pip and status colours (TSK-0069)"
```

---

### Task 6: Gates, merge, board + note bookkeeping (orchestrator)

- [ ] **Step 1: Full gates**

Run: `cd ui && bun run typecheck`, `cd ui && bun run test`, and `cd ui && bunx biome check <every file touched in Tasks 1-5>`.
Expected: typecheck + tests pass; biome clean on touched files (pre-existing repo-wide noise excluded).

- [ ] **Step 2: Merge**

```bash
git checkout develop
git merge --no-ff feature/quick-wins-2026-08-16
git branch -d feature/quick-wins-2026-08-16
```

- [ ] **Step 3: Vault bookkeeping**

Move TSK-0068/0069/0071/0089/0090 to SEALED via `vault_task_update`; tick their checklist boxes; cross off the five source items in "Clepsydra: Stray Thoughts" with `**Completed 2026-08-16:**` annotations and update its Triage sections.
