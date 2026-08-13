# Folio Browser History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make browser Back and Forward restore the active Folio and the visit-specific scroll/selection location checkpointed when that history entry was left.

**Architecture:** Extend the existing in-memory Folio restoration module with a 64-record, visit-keyed registry plus one active capture callback and one pending restore request. Add a focused router integration hook that owns complete `{ folioTabId, folioPath, folioLocationId }` history tuples, separates guarded programmatic transitions from native history application, and is mounted by the workspace route. `Folio` remains the sole owner of Slate/scroll snapshots and gives matching history requests precedence over latest-per-tab restoration.

**Tech Stack:** React 19, TypeScript, TanStack Router/history, Zustand, Slate, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-13-folio-browser-history-design.md`

## Global Constraints

- A Folio destination is valid only when `folioTabId`, `folioPath`, and `folioLocationId` are all non-empty strings.
- A history location ID is stable per browser entry; its snapshot is replaced on each approved departure.
- Keep at most 64 history-location snapshots; replacement refreshes last-captured order; evict the oldest last-captured record.
- Guard cancellation occurs before capture and changes neither registry, workspace state, nor browser history.
- Native history application checkpoints once, may activate internally, and never pushes, replaces, redispatches traversal, or re-enters `runWorkspaceTransition`.
- A tab ID/path mismatch is stale and must never activate replacement content.
- A matching history request suppresses latest-per-tab restoration for that mount, including when the history snapshot is missing.
- Invalid changed-revision selection never prevents valid scroll restoration.
- Pending requests survive loading, locked encryption, and retryable non-404 errors; they are discarded on settled not-found, close/path mismatch, supersession, or consumption.
- Page-to-graph navigation clears all Folio destination fields; graph Forward restoration is outside scope.
- Preserve `folioOriginTabId` meaning, but checkpoint before mobile Back activates an origin or navigates to `/`.
- No new persistence, URL parameters, dependencies, or graph-history model.

---

### Task 1: Visit-keyed restoration registry

**Files:**
- Modify: `ui/src/store/folioRestoration.ts`
- Modify: `ui/src/store/folioRestoration.test.ts`

**Interfaces:**
- Consumes: existing `FolioRestoration`, `cloneRecord`, and latest-per-tab APIs.
- Produces:
  ```ts
  export type FolioHistoryDestination = {
    folioTabId: string;
    folioPath: string;
    folioLocationId: string;
  };
  export type FolioHistoryRestoreRequest = {
    tabId: string;
    path: string;
    locationId: string;
  };
  export function readFolioHistoryDestination(state: unknown): FolioHistoryDestination | null;
  export function registerFolioHistoryCapture(
    tabId: string,
    path: string,
    capture: () => FolioRestoration | null,
  ): () => void;
  export function captureFolioHistoryLocation(
    locationId: string,
    tabId: string,
    path: string,
  ): boolean;
  export function readFolioHistoryLocation(
    locationId: string,
    tabId: string,
    path: string,
  ): FolioRestoration | null;
  export function requestFolioHistoryRestoration(
    request: FolioHistoryRestoreRequest,
  ): void;
  export function readFolioHistoryRestorationRequest(
    tabId: string,
    path: string,
  ): { request: FolioHistoryRestoreRequest; restoration: FolioRestoration | null } | null;
  export function consumeFolioHistoryRestorationRequest(locationId: string): void;
  export function clearFolioHistoryForTab(tabId: string): void;
  export function clearFolioHistoryState(): void;
  ```
  `clearFolioHistoryState` is a deterministic reset primitive used on vault/workspace teardown and by tests; it must not touch localStorage.

- [ ] **Step 1: Write failing registry tests**

Add tests that prove complete tuple decoding, cloned reads, path-qualified capture, same-ID replacement, last-captured refresh, 65th-record eviction, capture unregister safety, pending-request supersession, missing-snapshot observability, matching-only consumption, per-tab cleanup, and no localStorage calls. Use a helper like:

```ts
const capture = (tabId: string, scrollTop: number) =>
  registerFolioHistoryCapture(tabId, `notes/${tabId}.md`, () => ({
    ...restoration(tabId),
    scrollTop,
  }));
```

The replacement-order test must capture IDs `history-0` through `history-63`, recapture `history-0`, capture `history-64`, then assert `history-1` was evicted while `history-0` remains.

- [ ] **Step 2: Run RED tests**

Run: `bun run test -- src/store/folioRestoration.test.ts`

Expected: FAIL because the history interfaces are not exported.

- [ ] **Step 3: Implement the minimal registry**

Use module-local state only:

```ts
const MAX_HISTORY_RECORDS = 64;
const historyRecords = new Map<string, FolioRestoration>();
let activeCapture: {
  tabId: string;
  path: string;
  capture: () => FolioRestoration | null;
} | null = null;
let pendingHistoryRestoration: FolioHistoryRestoreRequest | null = null;
```

On capture, require active tab/path equality and returned record tab/path equality; clone the record; delete/reinsert an existing ID to refresh order; evict `historyRecords.keys().next().value` above 64. `readFolioHistoryRestorationRequest` returns `null` for a nonmatching request but returns `{ request, restoration: null }` for a matching request whose snapshot is absent. `consume...` clears only the same location ID so a stale effect cannot clear a superseding request.

- [ ] **Step 4: Run GREEN tests**

Run: `bun run test -- src/store/folioRestoration.test.ts`

Expected: all restoration-store tests pass.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`

Commit: `feat(ui): add Folio history restoration registry`

---

### Task 2: Guarded navigation and history tuples

**Files:**
- Create: `ui/src/hooks/useFolioHistoryNavigation.ts`
- Create: `ui/src/hooks/useFolioHistoryNavigation.test.tsx`
- Modify: `ui/src/hooks/useOpenTab.ts`
- Modify: `ui/src/hooks/useOpenTab.test.tsx`
- Modify: `ui/src/components/codex/Sheaf.tsx`
- Modify: `ui/src/routes/workspace.tsx`

**Interfaces:**
- Consumes: Task 1 tuple decoder, capture/request APIs; `runWorkspaceTransition`; `useWorkspaceStore`; TanStack `router.history.subscribe` action types.
- Produces:
  ```ts
  export function useFolioHistoryController(): void;
  export function useOpenTabWithFolioHistory(): (
    type: TabType,
    path?: string,
    label?: string,
    target?: OpenTabTarget,
  ) => void;
  export function useActivateTabWithFolioHistory(): (tabId: string) => void;
  export function useLeaveFolioWorkspace(): (
    navigateAway: () => void,
    options?: { originTabId?: string | null },
  ) => void;
  ```
- `useOpenTab` remains the public compatibility hook and delegates to `useOpenTabWithFolioHistory`; this is a clean internal cutover, not a second navigation convention.

- [ ] **Step 1: Write failing hook tests**

In the new test file, use a memory router and real workspace store. Prove:

```ts
expect(readFolioHistoryDestination(pageCall.state({}))).toMatchObject({
  folioPath: "notes/beta.md",
});
expect(graphCall.state(previousPageState)).toMatchObject({
  folioTabId: null,
  folioPath: null,
  folioLocationId: null,
});
```

Also prove: initialization uses replace without an extra entry; page open captures before mutation; same active page with no block target is a zero-effect no-op; guarded cancellation captures/navigates only after `proceed`; existing-tab activation pushes a fresh tuple; stale ID/path native traversal retains the current tab; valid traversal activates internally and requests restoration without push/replace; PUSH and initialization REPLACE notifications do not recursively apply; graph entries are ignored; programmatic departure captures then invokes its callback.

Update `useOpenTab.test.tsx` expectations so page state includes the destination tuple while retaining `folioOriginTabId`, and off-workspace opening sets origin to `null`.

- [ ] **Step 2: Run RED hook tests**

Run: `bun run test -- src/hooks/useFolioHistoryNavigation.test.tsx src/hooks/useOpenTab.test.tsx`

Expected: FAIL because the coordinator hook and destination fields do not exist.

- [ ] **Step 3: Implement the navigation coordinator**

Declare the TanStack history augmentation once in the new file:

```ts
declare module "@tanstack/history" {
  interface HistoryState {
    folioTabId?: string | null;
    folioPath?: string | null;
    folioLocationId?: string | null;
    folioOriginTabId?: string | null;
  }
}
```

Use `crypto.randomUUID()` for fresh location IDs. Programmatic page navigation must resolve the actual active destination after `openTab`, then push the tuple in the same approved callback. Graph navigation writes explicit nulls. Existing-tab no-op detection occurs before `runWorkspaceTransition`.

`useFolioHistoryController` must subscribe to history actions synchronously. Apply only `BACK`, `FORWARD`, or `GO`; capture the previously tracked complete tuple once, validate destination ID and path against a current page tab, activate through a new narrowly scoped store action that bypasses guard re-entry, and issue the restore request. On mount, initialize an incomplete current workspace page entry with `history.replace`; if a complete tuple is already present, apply it without replacing. Ignore PUSH/ordinary REPLACE notifications caused by the coordinator itself.

Add the narrow store action only if required by compilation, named `activateTabFromHistory(tabId: string)`, implemented with the same state mutation as `activateTab` but without `runWorkspaceTransition`. Do not expose a generic guard bypass.

Mount the controller in a named workspace route component:

```tsx
function WorkspaceRoute() {
  useFolioHistoryController();
  return <TabContent />;
}
```

Route `Sheaf.onActivate` through `useActivateTabWithFolioHistory` and remove its local store+navigate sequence.

- [ ] **Step 4: Run GREEN hook tests**

Run: `bun run test -- src/hooks/useFolioHistoryNavigation.test.tsx src/hooks/useOpenTab.test.tsx`

Expected: all focused hook tests pass.

- [ ] **Step 5: Run affected workspace tests and commit**

Run: `bun run test -- src/store/workspace.test.ts src/components/codex/Sheaf.test.tsx`

Run: `bun run typecheck`

Commit: `feat(ui): coordinate Folio browser history navigation`

---

### Task 3: Folio capture and restoration precedence

**Files:**
- Modify: `ui/src/components/codex/Folio.tsx`
- Modify: `ui/src/components/codex/__tests__/Folio.test.tsx`
- Modify: `ui/src/components/codex/__tests__/FolioNavigation.test.tsx`

**Interfaces:**
- Consumes: Task 1 capture registration and pending request APIs; Task 2 `useLeaveFolioWorkspace`.
- Produces: mounted Folio synchronous capture; history-request restoration with deterministic precedence; checkpoint-first mobile Back behavior.

- [ ] **Step 1: Write failing Folio tests**

Update the existing stale-revision test to expect `scrollTop === 64` while stale Slate selection is not applied. Add focused cases proving:

- a matching history request restores its visit snapshot instead of a conflicting latest-per-tab snapshot;
- a matching missing-snapshot request suppresses latest-per-tab restoration and is consumed without moving the current location;
- a pending request survives loading and retryable error, then restores after retry;
- a locked request survives until unlock;
- a read-only `AI_CONVERSATION` Folio consumes a valid request;
- a superseding request cannot be consumed by the previous Folio effect;
- mobile Back with history checkpoints before origin activation/back;
- mobile fallback with no usable history checkpoints before navigation to `/`.

Name the production defect each test catches in its assertion comments; do not assert implementation call counts when DOM/store behavior can prove the contract.

- [ ] **Step 2: Run RED Folio tests**

Run: `bun run test -- src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx`

Expected: FAIL on history request precedence, independent scroll, and checkpoint-first mobile Back.

- [ ] **Step 3: Register synchronous capture**

Extract one snapshot builder inside `Folio` that reads `restorationStateRef`, the current Slate editor, selection, revision, and `bodyRef.current.scrollTop`, returning `FolioRestoration | null`. Register it with `registerFolioHistoryCapture(tabId, path, capture)` in a layout effect. Reuse the builder from the existing latest-per-tab unmount save so capture validation remains single-sourced.

- [ ] **Step 4: Implement restoration precedence and lifecycle**

Before reading latest-per-tab state, read a matching pending history request. If present, it is authoritative even when `restoration` is null. Keep it pending while matching content is loading, locked, or retryably failed. Once content/scroll container is available, apply scroll independently, apply only a validated selection, then consume the exact location ID. Discard on settled `pageNotFound` or destination mismatch. Only when no matching request exists may the existing latest-per-tab restoration run.

Refactor the current early return:

```ts
const requireTextMatch = restoration.revision !== editor.getRevision();
const selection = validatedSelection(...);
scrollContainer.scrollTop = restoration.scrollTop;
if (selection) Transforms.select(slateEditor, selection);
```

Do not return before setting scroll merely because changed-revision selection is invalid.

- [ ] **Step 5: Route mobile Back through checkpoint-first departure**

Use `useLeaveFolioWorkspace`. With usable history, its approved callback captures, then activates a valid `folioOriginTabId` fallback if present, then calls `router.history.back()`. Without usable history, capture then navigate to `/`. Remove the old pre-capture `runWorkspaceTransition` sequences.

- [ ] **Step 6: Run GREEN Folio tests**

Run: `bun run test -- src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx`

Expected: all focused Folio tests pass.

- [ ] **Step 7: Typecheck and commit**

Run: `bun run typecheck`

Commit: `feat(ui): restore Folio locations from browser history`

---

### Task 4: End-to-end history traversal and stale-state boundaries

**Files:**
- Modify: `ui/src/components/codex/__tests__/FolioNavigation.test.tsx`
- Modify as required by failures only: `ui/src/hooks/useFolioHistoryNavigation.ts`
- Modify as required by failures only: `ui/src/components/codex/Folio.tsx`
- Modify as required by failures only: `ui/src/store/folioRestoration.ts`

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: full approved browser-history behavior and regression coverage across real memory-router traversal.

- [ ] **Step 1: Add failing end-to-end traversal cases**

Use the real memory router, workspace store, mocked page source, real `Folio`, and scroll container. Add observable scenarios for:

1. A → B → Back restores A → Forward restores B at B's departure scroll.
2. Distinct A visits restore distinct locations.
3. A → B → Back A → move A → Forward B → Back A restores A's refreshed checkpoint.
4. Dirty raw Markdown rejects native Back with history state, active tab, and registry unchanged; Leave performs exactly one checkpoint and traversal.
5. Closed and replace-mode-reused tab IDs do not activate stale paths, including with an evicted/missing snapshot.
6. Direct `/workspace` initialization replaces state without adding a Back step.
7. Page → graph clears Folio fields; later graph traversal does not reactivate the prior page.
8. Direct workspace → mobile fallback `/` → browser Back returns to and restores the checkpointed Folio.
9. History application does not push, replace, or recursively dispatch traversal.

Drive Back/Forward through `router.history.back()` and `router.history.forward()` rather than calling coordinator internals. Assert active tab/path plus scroll/selection, not only history state.

- [ ] **Step 2: Run RED integration tests**

Run: `bun run test -- src/components/codex/__tests__/FolioNavigation.test.tsx`

Expected: each new case fails for its intended missing integration behavior, not test setup.

- [ ] **Step 3: Make the smallest integration corrections**

Fix only behavior exposed by the RED cases. Preserve the contracts and interfaces from Tasks 1–3. Typical valid corrections are action filtering, previous-entry tracking, request timing, or stale tuple validation; do not add persistence, URL parameters, graph destination state, retries, or alternate navigation APIs.

- [ ] **Step 4: Run GREEN integration and focused suites**

Run: `bun run test -- src/components/codex/__tests__/FolioNavigation.test.tsx`

Run: `bun run test -- src/store/folioRestoration.test.ts src/hooks/useFolioHistoryNavigation.test.tsx src/hooks/useOpenTab.test.tsx src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx src/store/workspace.test.ts src/components/codex/Sheaf.test.tsx`

Expected: all focused tests pass.

- [ ] **Step 5: Run changed-file lint and typecheck**

Run: `bunx biome lint src/store/folioRestoration.ts src/store/folioRestoration.test.ts src/hooks/useFolioHistoryNavigation.ts src/hooks/useFolioHistoryNavigation.test.tsx src/hooks/useOpenTab.ts src/hooks/useOpenTab.test.tsx src/components/codex/Folio.tsx src/components/codex/Sheaf.tsx src/routes/workspace.tsx src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx`

Run: `bun run typecheck`

Expected: no diagnostics in changed files and typecheck exit 0.

- [ ] **Step 6: Commit**

Commit: `test(ui): cover Folio browser history traversal`

---

## Final verification

After all task reviews are clean:

1. Run `cargo test` from the repository root.
2. Run `bun run test` from `ui/`.
3. Run `bun run typecheck` from `ui/`.
4. Run `bun run lint` from `ui/`; report unrelated baseline diagnostics separately, but no changed-file diagnostic may remain.
5. Run `bun run build` from `ui/`.
6. Browser-smoke A → B → Back → Forward against the actual app and confirm active Folio plus scroll restoration.
7. Complete broad whole-branch code review before merge.
