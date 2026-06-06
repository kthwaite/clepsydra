# Folio empty state & invalid-tab handling — design

**Date:** 2026-06-05
**Status:** Approved (design); pending implementation plan
**Area:** `ui/` — workspace / folio

## Problem

Two gaps on the workspace/folio surface:

1. **Crash on invalid tab.** An open tab that points to a nonexistent file
   takes down the entire frontend. The workspace persists open tabs (zustand
   `persist`, `clepsydra.workspace`), so a file deleted/moved out of band leaves
   a dangling tab that crashes the app on next load.

2. **Thin empty state.** With no tab open, `TabContent` renders a single line
   ("No folios open. Use ⌘K…"). We want a useful landing surface.

### Root cause of the crash

`ui/src/lib/queryClient.ts` sets `throwOnError: true` globally, and there is
**no React error boundary** anywhere in the tree
(`main.tsx` → `RouterProvider` → routes → `TabContent` → `Folio`). When a tab
points to a missing file:

- `usePage(path)` (`ui/src/api/pages.ts`) issues `GET /api/vault/pages/{path}`,
  which 404s.
- With `throwOnError: true`, React Query **throws during render** instead of
  returning an error state.
- The throw propagates to the root with no boundary to catch it, so React
  unmounts the whole tree → blank screen.

Consequence: the `editor.error` branch in `Folio.tsx` (`if (editor.error) …`,
~line 140) is **dead code** — the hook throws before Folio can read
`editor.error`.

## Goals

- A tab pointing to a missing file renders a recoverable **invalid-tab panel**
  in the folio area; the rest of the workspace (other tabs, chrome) stays alive.
- The empty state becomes a **rich launcher**: quick actions + recent files.
- No regression to the intentional global `throwOnError: true` for other
  surfaces (it backs route-level error handling elsewhere).

## Non-goals

- No "create the missing file" recovery action (close-only, per decision).
- No new backend endpoints; no new data fetching for the launcher.
- No general redesign of the folio rails or chrome.

## Approach

Hybrid, two layers of defense:

1. **Per-query opt-out (primary path).** `usePage` opts out of
   `throwOnError` so a 404 surfaces as query `error` state. `usePageEditor`
   already forwards `error`; Folio's existing `editor.error` branch goes live
   and is upgraded from a one-liner into the recovery panel. Declarative, no
   class component on the happy path.

   `useOutlinks` **also** 404s on a missing path (the backend `outlinks`
   handler maps a no-rows lookup to 404), so it inherits the same opt-out
   (`throwOnError: false`) — otherwise it would throw during render before the
   `editor.error` guard and re-crash the app. `useBacklinks` / `useSimilar`
   are pure index queries that return `[]` for unknown paths, so they degrade
   quietly and are left on the global default. (The `FolioBoundary` backstop
   below would catch any residual throw regardless.)

2. **Error boundary (backstop).** A thin, dependency-free class error boundary
   wraps the folio render in `TabContent`. It catches **any** unexpected error
   thrown during a folio render (not just the 404 path) and shows the same
   recovery panel, so a folio error can never again unmount the whole app.

### Alternatives considered

- **Error boundary only** (no per-query opt-out): works, but the happy-path
  "missing file" case is better expressed declaratively via `editor.error` than
  by throwing and catching. Kept as the backstop, not the primary path.
- **Globally disable `throwOnError`**: rejected — the global setting backs
  error handling on other surfaces; scope the change to `usePage`.

## Components

### 1. Invalid-tab recovery panel — `Folio.tsx`

Replace the `editor.error` one-liner with a Vessel-styled in-flow panel:

- Diegetic header (`FILE / —`) consistent with the dossier header.
- A `⁂ FOLIO NOT FOUND` line.
- The missing `path` rendered (break-all, muted).
- Short note: "This tab points to a file that no longer exists."
- A single **Close tab** button → `closeTab(tabId)` from `useWorkspaceStore`.

Single action only (per decision). Folio already has `tabId`, so wiring Close
is local.

### 2. `FolioBoundary` — new `ui/src/components/codex/FolioBoundary.tsx`

Minimal class error boundary (no new dependency):

- `key`ed on the active tab path so a corrected/closed tab recovers cleanly.
- Fallback renders the same recovery-panel treatment. The fallback reads the
  active tab from `useWorkspaceStore.getState()` to wire its Close action
  (the boundary sits outside Folio, so it can't receive `tabId` as a prop the
  way Folio's inline branch does).
- Wraps the `<Folio>` element in `TabContent`.

### 3. `FolioLauncher` — new `ui/src/components/codex/FolioLauncher.tsx`

The rich empty state. Rendered by `TabContent` when there is no active tab
(replaces the inline "No folios open" block).

- Vessel header framing + prompt.
- **Quick actions**:
  - Open console (⌘K) → `useUiStore.getState().openSearch()`
  - Inscribe new folio (⌘N) → `useUiStore.getState().openInscribe()`
  - Open Constellation (graph) → `useOpenTab()("graph")`
- **Recent files**: from workspace `openHistory` (already de-duped, newest-first,
  capped at 32). Show up to ~8 rows. Each row:
  - kind pip via `resolveKind({ path })`
  - derived display name (`folioDisplayName`, see below)
  - `shortFolio(path)` code
  - relative opened-time from `openedAt`
  - click → `useOpenTab()("page", path, label)`
- Empty `openHistory`: a quiet "No recent folios." note.
- **No new data fetching** — store/history only.

### 4. `folioDisplayName(path)` — new helper in `folio-utils.ts`

Page filenames follow `<yyyymmdd>.<title-slug>.<shortid>.md` (ADR 0002).
`openHistory` entries reference closed files with no stored title, so derive a
readable label:

- Strip `.md`, split on `.`.
- If shape matches (`>=3` parts, trailing 8-char base62 id), take the
  title-slug part and replace `-` with spaces.
- Otherwise fall back to the basename (sans `.md`).

Pure function, unit-tested.

## Data flow

```
TabContent
  ├─ no active tab            → <FolioLauncher/>            (store/history only)
  ├─ active page tab          → <FolioBoundary key=path>    (backstop)
  │                                └─ <Folio>
  │                                     └─ usePageEditor → usePage (throwOnError:false)
  │                                          ├─ error  → invalid-tab recovery panel
  │                                          └─ data   → normal folio
  └─ active graph tab         → <Constellation/>            (unchanged)
```

## Error handling

- 404 / known-missing file: declarative `editor.error` → recovery panel.
- Any other thrown folio render error: caught by `FolioBoundary` → recovery
  panel. The app never unmounts on a folio error.
- Close action removes the offending tab via the existing `closeTab` store
  action, which already picks a sensible next-active tab.

## Testing

- **`folioDisplayName`** unit tests in `folio-utils.test.ts`:
  filename-with-shortid → slug words; dashed slug → spaced words; non-conforming
  path → basename fallback.
- **Invalid-tab**: render Folio with a mocked 404 `usePage` → asserts the
  recovery panel renders and the Close button invokes `closeTab`.
- **Launcher**: render `FolioLauncher` with a seeded `openHistory` → asserts
  quick actions present and clicking a recent row opens the expected tab; empty
  `openHistory` shows the quiet note.

Test mechanics align with the existing vitest + React Testing Library setup
used by the current `ui/src/components/**` tests.

## Files touched

New:
- `ui/src/components/codex/FolioBoundary.tsx`
- `ui/src/components/codex/FolioLauncher.tsx`

Modified:
- `ui/src/api/pages.ts` — `usePage` opts out of `throwOnError`
- `ui/src/components/codex/Folio.tsx` — recovery panel replaces dead branch
- `ui/src/components/codex/folio-utils.ts` — add `folioDisplayName`
- `ui/src/components/codex/folio-utils.test.ts` — tests
- `ui/src/components/TabContent.tsx` — render `FolioLauncher` / wrap in
  `FolioBoundary`

Plus a new test file for the invalid-tab and launcher behavior (location per
existing conventions, e.g. `ui/src/components/codex/__tests__/`).
