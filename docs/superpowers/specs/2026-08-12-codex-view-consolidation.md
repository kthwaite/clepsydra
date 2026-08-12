# Codex View Consolidation — Design Spec

**Date:** 2026-08-12
**Status:** Approved (decisions locked in session)

## Problem

The "current view" concept (`CodexView`) is computed and re-derived all over `ui/src`:

- **Parallel resolution.** `resolveCodexView(pathname, tabs, activeTabId)` is called independently by `DesktopCodexFrame.tsx:86` and `MobileCodexFrame.tsx:41`, while three other sites answer "what view am I in?" their own way: `TabContent.tsx:19-45` re-derives graph-vs-folio from scratch; `useGlobalShortcuts.tsx:38-39` sniffs `window.location.pathname` (not the router); `useOpenTab.ts:20` uses exact equality `pathname === "/workspace"` where the resolver uses `startsWith`.
- **Five hand-maintained per-view tables** over one 9-member union: desktop `NAV` labels, the 8-branch `useFolioCode` chain, mobile `ROOTS` tuples, the negated Sheaf exclusion list, and four separate view→route navigation maps (desktop `onNav`, mobile `navigateToRoot`, `CommandPalette` switch, shortcut bindings). Only `NAV` is exhaustive; a new union member silently gets wrong defaults everywhere else.
- **Nine re-implementations of "find the active tab by id"** (store exposes no selector) and **eleven encodings of "graph tab ⇒ constellation"**; the inverse (folio nav) exists exactly once.
- **Behavioral divergences:** with no active tab the resolver says `"folio"` while `TabContent` renders `FolioLauncher` (footer prints `FILE — · VIEW FOLIO` over the launcher); a pathless page tab renders `null` while reporting `"folio"`; ⌃Tab can land on the Sheaf-invisible graph tab and silently flip the view; `/repairs` and `/agenda` have no view so the header highlights ATRIUM there; the resolver's prefix guards are inconsistent (exact-or-slash for four views, bare `startsWith` for two); gazetteer default search `{sort:"ts",page:1}` is repeated in five places; constellation is reached by two code paths that leave different history state; both frames subscribe to the whole workspace store.

## Locked decisions

1. `/repairs` becomes a `CodexView`; `/agenda` too (WIP, keep `Sidebar.tsx`). Neither joins the desktop nav rail or mobile roots for now — the win is an honest footer and no false ATRIUM highlight.
2. The workspace empty state is surfaced as its own view: **`launcher`** (`VIEW LAUNCHER`, `FILE —`). A pathless page tab also resolves to launcher (fixes the render-`null` hole).
3. ⌃Tab landing on the graph tab is a bug: tab cycling is folio-only (page tabs).
4. Constellation navigation unifies on the `useOpenTab` path everywhere (consistent `folioOriginTabId` history stamping).
5. Use TanStack Router and Zustand affordances: route-declared views via `staticData` (no string prefix matching), fine-grained `useRouterState({select})` subscriptions, store selectors, `SearchSchemaInput` for optional navigate search.

## Target architecture

### 1. Route-declared views (`staticData`)

Each route file declares its view; the router's own matcher replaces all pathname sniffing:

```ts
declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    codexView?: RouteView;
  }
}
```

`RouteView` is the route-resolvable subset of `CodexView` plus a `"workspace"` marker. `routeViewFromMatches(matches)` scans matches deepest-first for the first declared `codexView`; the root route declares `"atrium"` as the universal fallback. `/workspace` (and the legacy `/graph`, `/pages/$` redirects) declare `"workspace"`, which defers to the workspace store.

The prefix-guard inconsistency disappears structurally — there is no prefix matching left.

### 2. The view union and workspace modes

```ts
type CodexView =
  | "atrium" | "folio" | "launcher" | "constellation"
  | "gazetteer" | "tasking" | "academic" | "bases"
  | "feeds" | "docs" | "repairs" | "agenda";        // 12 members

type WorkspaceMode = Extract<CodexView, "folio" | "constellation" | "launcher">;
```

`selectWorkspaceMode` (in the workspace store): graph tab active → `constellation`; page tab with path active → `folio`; otherwise → `launcher`. Consumed by **both** the view hook and `TabContent`, so chrome and content can no longer disagree.

### 3. One hook, computed from fine-grained subscriptions

```ts
function useCodexView(): CodexView {
  const routeView = useRouterState({ select: (s) => routeViewFromMatches(s.matches) });
  const mode = useWorkspaceStore(selectWorkspaceMode);
  return routeView === "workspace" ? mode : routeView;
}
```

O(matches) scan, no loops over view lists, re-renders only when the resolved string changes. Imperative contexts (shortcut `when`-gates) call `routeViewFromMatches(router.state.matches)` directly — router state, never `window.location`.

### 4. View descriptor registry

`viewRegistry.ts`, modeled on the editor's schema registry: `VIEW_REGISTRY: Record<CodexView, ViewDescriptor>` — exhaustive at the type level (adding a view fails typecheck until every attribute is declared). Descriptor: `label`, `folioCode` (null = derive from active folio path), `showsSheaf` (positive flag), `navRoot` (which rail entry highlights; null = none — launcher highlights FOLIO, repairs/agenda highlight nothing), `mobile` presentation, and `go(deps)` — the single view→route navigation implementation. `DESKTOP_NAV` and `MOBILE_NAV` are ordered arrays over the registry. All five tables and all four nav maps collapse into it; multi-branch if-chains become record lookups.

### 5. Zustand selectors

`selectActiveTab` and `selectWorkspaceMode` exported from the store; used by the store's own actions, the hook, `TabContent`, and chrome. Frames drop whole-store destructuring for per-field selectors; event handlers read `useWorkspaceStore.getState()` instead of subscribing.

### 6. Search-param defaults (`SearchSchemaInput`)

Gazetteer and feeds `validateSearch` take `Record<string, unknown> & SearchSchemaInput`, making search optional at every `navigate`/`Link` call site while `useSearch` stays fully typed. Kills the five-way `{sort:"ts",page:1}` repetition and the `navigate({to:"/feeds"} as never)` casts.

## Behavior changes (intended)

- Footer over the workspace empty state reads `FILE — · VIEW LAUNCHER` (was `FILE — · VIEW FOLIO`).
- A pathless page tab shows the launcher (was a blank `null` render).
- `/repairs` and `/agenda` show honest footer labels and no rail highlight (was ATRIUM highlighted).
- ⌃Tab cycles page tabs only; from the graph tab it lands on the first/last page tab.
- ⌘G / palette constellation navigation now stamps `folioOriginTabId` (same as every other tab open).
- Gazetteer/feeds URLs and navigation are unchanged for users; only call sites simplify.

## Out of scope

- The diegetic index collision (DOCS and STATUS both render `08`) — cosmetic, untouched.
- Adding repairs/agenda to the nav rail / mobile roots — revisit when agenda ships.
- `stripSearchParams` URL cleaning middleware — YAGNI for now.
- `forceView` stays as a documented test-only prop (breakpoint integration tests pin it).
