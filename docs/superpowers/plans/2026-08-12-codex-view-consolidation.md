# Codex View Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralise the "current view" (CodexView) into one route-declared resolver, one descriptor registry, and shared store selectors, eliminating scattered pathname sniffing, per-view if-chains, and active-tab re-derivations.

**Architecture:** Routes declare their view via TanStack Router `staticData`; a single `useCodexView()` hook combines the deepest declared route view with a workspace-store `selectWorkspaceMode` selector; a `VIEW_REGISTRY: Record<CodexView, ViewDescriptor>` (modeled on the editor schema registry) owns labels, folio codes, sheaf visibility, nav highlighting, and navigation.

**Tech Stack:** React 19, TanStack Router v1.170 (`staticData`, `useRouterState({select})`, `SearchSchemaInput`), Zustand v5 selectors, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-08-12-codex-view-consolidation.md`

## Global Constraints

- All frontend commands run from `ui/` with Bun (`bun run typecheck`, `bun run lint`, `bun run test`); prefer `bun --cwd ui …` from repo root.
- Path alias `#/` = `ui/src/`. Biome formatting (2-space, double quotes). Strict TS (`noUnusedLocals`, `verbatimModuleSyntax` — type-only imports must use `import type`).
- Branch: `feature/codex-view-registry` off `develop`. The working tree already contains an uncommitted cosmetic hoist in `DesktopCodexFrame.tsx` (helpers moved above the component) — keep it; it lands with Task 5's commit.
- Do NOT edit `ui/src/routeTree.gen.ts` or `ui/src/api/schema.d.ts` (generated).
- Every task ends with `bun run typecheck && bun run lint` green plus the named tests, then a commit.

---

### Task 1: Workspace store selectors

**Files:**
- Modify: `ui/src/store/workspace.ts` (types at 101–122; internal finds at 234, 441, 565–567, 586, 598–600)
- Create: `ui/src/store/workspaceView.test.ts`

**Interfaces:**
- Consumes: existing `TabDescriptor`, `WorkspaceState` (currently unexported).
- Produces: `export type WorkspaceMode = "folio" | "constellation" | "launcher"`; `export interface WorkspaceState`; `export const selectActiveTab: (s: WorkspaceState) => TabDescriptor | undefined`; `export const selectWorkspaceMode: (s: WorkspaceState) => WorkspaceMode`. Later tasks import all four from `#/store/workspace`.

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/store/workspaceView.test.ts
import { describe, expect, it } from "vitest";
import {
  selectActiveTab,
  selectWorkspaceMode,
  type TabDescriptor,
  type WorkspaceState,
} from "#/store/workspace";

function state(tabs: TabDescriptor[], activeTabId: string | null): WorkspaceState {
  return { tabs, activeTabId, navigationMode: "smart", openHistory: [], quires: {} };
}

const page = (id: string, path?: string): TabDescriptor => ({
  id,
  type: "page",
  path,
  label: path ?? id,
});
const graph: TabDescriptor = { id: "g1", type: "graph", label: "Graph" };

describe("selectActiveTab", () => {
  it("returns the tab matching activeTabId", () => {
    const s = state([page("a", "notes/a.md"), graph], "g1");
    expect(selectActiveTab(s)).toBe(s.tabs[1]);
  });
  it("returns undefined when nothing is active", () => {
    expect(selectActiveTab(state([page("a", "notes/a.md")], null))).toBeUndefined();
  });
});

describe("selectWorkspaceMode", () => {
  it("is constellation when the graph tab is active", () => {
    expect(selectWorkspaceMode(state([graph], "g1"))).toBe("constellation");
  });
  it("is folio when a page tab with a path is active", () => {
    expect(selectWorkspaceMode(state([page("a", "notes/a.md")], "a"))).toBe("folio");
  });
  it("is launcher when no tab is active", () => {
    expect(selectWorkspaceMode(state([page("a", "notes/a.md")], null))).toBe("launcher");
  });
  it("is launcher when the active page tab has no path", () => {
    expect(selectWorkspaceMode(state([page("a")], "a"))).toBe("launcher");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --cwd ui run test workspaceView`
Expected: FAIL — `selectActiveTab`/`WorkspaceState` are not exported.

- [ ] **Step 3: Implement**

In `ui/src/store/workspace.ts`: change `interface WorkspaceState` to `export interface WorkspaceState`, then add below it:

```ts
export type WorkspaceMode = "folio" | "constellation" | "launcher";

export const selectActiveTab = (s: WorkspaceState): TabDescriptor | undefined =>
  s.tabs.find((t) => t.id === s.activeTabId);

/** The workspace surface's display mode. Chrome (footer/nav) and content
 * (TabContent) must both read this so they cannot disagree. */
export const selectWorkspaceMode = (s: WorkspaceState): WorkspaceMode => {
  const active = selectActiveTab(s);
  if (active?.type === "graph") return "constellation";
  if (active?.type === "page" && active.path) return "folio";
  return "launcher";
};
```

Then replace the four inline active-tab finds inside store actions with `selectActiveTab(...)`:
- `openTab` (~line 234): `const activeTab = selectActiveTab(state);`
- `toggleQuireCollapse` (~565): `const active = selectActiveTab(current);` and (~586) `const active = selectActiveTab(state);`
- `closeQuireTabs` (~598): `const active = selectActiveTab(current);`

Leave `updateTabPath` (~441) alone — it looks up by `tabId` argument, not the active id.

- [ ] **Step 4: Run tests**

Run: `bun --cwd ui run test workspaceView` then `bun --cwd ui run test workspace` (existing store suites must stay green).
Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
bun --cwd ui run typecheck && bun --cwd ui run lint
git add ui/src/store/workspace.ts ui/src/store/workspaceView.test.ts
git commit -m "feat(ui): add selectActiveTab/selectWorkspaceMode workspace selectors"
```

---

### Task 2: Route-declared views and the useCodexView hook

**Files:**
- Modify: `ui/src/components/codex/useCodexView.ts` (keep the legacy `resolveCodexView` export untouched for now — frames still use it until Tasks 5–6)
- Modify (add `staticData` only): `ui/src/routes/__root.tsx`, `index.tsx`, `gazetteer.tsx`, `tasking.tsx`, `academic.tsx`, `agenda.tsx`, `repairs.tsx`, `feeds.tsx`, `docs.tsx`, `bases.index.tsx`, `bases.$slug.tsx`, `bases.$slug.edit.tsx`, `workspace.tsx`, `graph.tsx`, `pages/$.tsx`
- Modify: `ui/src/components/codex/useCodexView.test.ts` (add new suites; keep legacy suites)
- Create: `ui/src/routes/__tests__/routeViews.test.ts`

**Interfaces:**
- Consumes: `selectWorkspaceMode`, `useWorkspaceStore` from Task 1.
- Produces: extended `export type CodexView` (12 members incl. `"launcher" | "repairs" | "agenda"`); `export type RouteView`; `export function routeViewFromMatches(matches: ReadonlyArray<{ staticData?: { codexView?: RouteView } }>): RouteView`; `export function useCodexView(): CodexView`. The `@tanstack/react-router` `StaticDataRouteOption` augmentation lives here.

- [ ] **Step 1: Write failing unit tests**

Append to `ui/src/components/codex/useCodexView.test.ts`:

```ts
import { routeViewFromMatches, type RouteView } from "#/components/codex/useCodexView";

const m = (codexView?: RouteView) => ({ staticData: codexView ? { codexView } : {} });

describe("routeViewFromMatches", () => {
  it("returns the deepest declared view", () => {
    expect(routeViewFromMatches([m("atrium"), m("docs")])).toBe("docs");
  });
  it("skips undeclared leaf matches and uses the parent", () => {
    expect(routeViewFromMatches([m("atrium"), m("docs"), m()])).toBe("docs");
  });
  it("falls back to atrium when nothing declares", () => {
    expect(routeViewFromMatches([m()])).toBe("atrium");
  });
  it("passes the workspace marker through", () => {
    expect(routeViewFromMatches([m("atrium"), m("workspace")])).toBe("workspace");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --cwd ui run test useCodexView`
Expected: FAIL — no `routeViewFromMatches` export.

- [ ] **Step 3: Implement in `useCodexView.ts`**

Add (keeping the existing `resolveCodexView` and its imports):

```ts
import { useRouterState } from "@tanstack/react-router";
import { selectWorkspaceMode, useWorkspaceStore } from "#/store/workspace";

export type CodexView =
  | "atrium"
  | "folio"
  | "launcher"
  | "constellation"
  | "gazetteer"
  | "tasking"
  | "academic"
  | "bases"
  | "feeds"
  | "docs"
  | "repairs"
  | "agenda";

/** Views resolvable from the route alone, plus the "workspace" marker that
 * defers to the workspace store (folio/constellation/launcher split). */
export type RouteView =
  | Exclude<CodexView, "folio" | "launcher" | "constellation">
  | "workspace";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    codexView?: RouteView;
  }
}

type MatchLike = { staticData?: { codexView?: RouteView } };

/** Deepest-first scan for the first route that declares its view. The root
 * route declares "atrium", so this is total over real match arrays. */
export function routeViewFromMatches(
  matches: ReadonlyArray<MatchLike>,
): RouteView {
  for (let i = matches.length - 1; i >= 0; i--) {
    const view = matches[i].staticData?.codexView;
    if (view) return view;
  }
  return "atrium";
}

/** The current CodexView. Route-declared via staticData; the workspace
 * marker defers to selectWorkspaceMode. Re-renders only when the resolved
 * view string changes. */
export function useCodexView(): CodexView {
  const routeView = useRouterState({
    select: (s) => routeViewFromMatches(s.matches),
  });
  const mode = useWorkspaceStore(selectWorkspaceMode);
  return routeView === "workspace" ? mode : routeView;
}
```

Note: the existing `CodexView` type declaration (9 members) is replaced by the 12-member union above; the legacy `resolveCodexView` keeps compiling because it only ever returns 9 of the 12.

- [ ] **Step 4: Declare `staticData` on every route**

In each route file add a `staticData` key to the existing `createFileRoute(...)({ ... })` (or `createRootRoute`) options object. Exact assignments:

| File | staticData |
|---|---|
| `__root.tsx` | `{ codexView: "atrium" }` (universal fallback, covers not-found) |
| `index.tsx` | `{ codexView: "atrium" }` |
| `gazetteer.tsx` | `{ codexView: "gazetteer" }` |
| `tasking.tsx` | `{ codexView: "tasking" }` |
| `academic.tsx` | `{ codexView: "academic" }` |
| `agenda.tsx` | `{ codexView: "agenda" }` |
| `repairs.tsx` | `{ codexView: "repairs" }` |
| `feeds.tsx` | `{ codexView: "feeds" }` |
| `docs.tsx` | `{ codexView: "docs" }` (layout route; `docs.$slug.tsx` inherits) |
| `bases.index.tsx`, `bases.$slug.tsx`, `bases.$slug.edit.tsx` | `{ codexView: "bases" }` each |
| `workspace.tsx`, `graph.tsx`, `pages/$.tsx` | `{ codexView: "workspace" }` each |

- [ ] **Step 5: Write the route-tree coverage test**

```ts
// ui/src/routes/__tests__/routeViews.test.ts
import { describe, expect, it } from "vitest";
import { routeTree } from "#/routeTree.gen";

// Mirrors the traversal in routes/__tests__/featureInventory.test.ts: walk
// the generated tree and assert every route resolves a codexView through
// itself or an ancestor.
type AnyRoute = {
  fullPath?: string;
  options?: { staticData?: { codexView?: string } };
  children?: AnyRoute[] | Record<string, AnyRoute>;
};

function walk(
  route: AnyRoute,
  inherited: string | undefined,
  out: Array<{ path: string; view: string | undefined }>,
) {
  const view = route.options?.staticData?.codexView ?? inherited;
  if (route.fullPath) out.push({ path: route.fullPath, view });
  const children = route.children
    ? Array.isArray(route.children)
      ? route.children
      : Object.values(route.children)
    : [];
  for (const child of children) walk(child, view, out);
}

describe("route codexView coverage", () => {
  it("every generated route resolves a view", () => {
    const rows: Array<{ path: string; view: string | undefined }> = [];
    walk(routeTree as unknown as AnyRoute, undefined, rows);
    expect(rows.length).toBeGreaterThan(0);
    const missing = rows.filter((r) => r.view === undefined);
    expect(missing).toEqual([]);
  });
});
```

(If the generated tree's shape differs, mirror the accessor `featureInventory.test.ts:63-80` uses to enumerate routes — the assertion stays the same.)

- [ ] **Step 6: Run tests**

Run: `bun --cwd ui run test useCodexView` and `bun --cwd ui run test routeViews`
Expected: PASS.

- [ ] **Step 7: Gates and commit**

```bash
bun --cwd ui run typecheck && bun --cwd ui run lint
git add ui/src/components/codex/useCodexView.ts ui/src/components/codex/useCodexView.test.ts ui/src/routes ui/src/routeTree.gen.ts
git commit -m "feat(ui): declare CodexView per route via staticData; add useCodexView hook"
```

(`routeTree.gen.ts` may be regenerated by the Vite plugin during test/dev — include it if it changed; do not hand-edit it.)

---

### Task 3: View descriptor registry

**Files:**
- Create: `ui/src/components/codex/viewRegistry.ts`
- Create: `ui/src/components/codex/viewRegistry.test.ts`

**Interfaces:**
- Consumes: `CodexView` from Task 2; `runWorkspaceTransition`, `useWorkspaceStore`, `TabType`, `OpenTabTarget` from `#/store/workspace`; `DEFAULT_DOC_SLUG` from `#/docs/constants`.
- Produces:

```ts
export interface ViewNavDeps {
  navigate: (opts: never) => unknown; // actual: ReturnType<typeof useNavigate> — see impl
  openTab: (type: TabType, path?: string, label?: string, target?: OpenTabTarget) => void;
}
export interface ViewDescriptor { label: string; folioCode: string | null; showsSheaf: boolean; navRoot: CodexView | null; mobile: { name: string; label: string } | null; go: ((deps: ViewNavDeps) => void) | null; }
export const VIEW_REGISTRY: Record<CodexView, ViewDescriptor>;
export const DESKTOP_NAV: readonly CodexView[];
export const MOBILE_NAV: readonly CodexView[];
export function goToView(view: CodexView, deps: ViewNavDeps): void;
```

- [ ] **Step 1: Write failing tests**

```ts
// ui/src/components/codex/viewRegistry.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_NAV,
  goToView,
  MOBILE_NAV,
  VIEW_REGISTRY,
  type ViewNavDeps,
} from "#/components/codex/viewRegistry";

const deps = (): ViewNavDeps & { navigate: ReturnType<typeof vi.fn>; openTab: ReturnType<typeof vi.fn> } => ({
  navigate: vi.fn(),
  openTab: vi.fn(),
});

describe("VIEW_REGISTRY", () => {
  it("preserves today's nav rail order and labels", () => {
    expect(DESKTOP_NAV).toEqual([
      "atrium", "folio", "gazetteer", "constellation", "tasking",
      "academic", "bases", "feeds", "docs",
    ]);
    expect(DESKTOP_NAV.map((v) => VIEW_REGISTRY[v].label)).toEqual([
      "ATRIUM", "FOLIO", "GAZETTEER", "CONSTELLATION", "TASKING",
      "ACADEMIC", "BASES", "FEEDS", "DOCS",
    ]);
  });
  it("preserves today's mobile roots order and labels", () => {
    expect(MOBILE_NAV).toEqual([
      "atrium", "gazetteer", "academic", "bases", "feeds", "constellation",
    ]);
    expect(MOBILE_NAV.map((v) => VIEW_REGISTRY[v].mobile?.label)).toEqual([
      "ATR", "GAZ", "ACAD", "BASE", "FEED", "GRAPH",
    ]);
  });
  it("shows the Sheaf exactly for folio, launcher, gazetteer, tasking", () => {
    const withSheaf = (Object.keys(VIEW_REGISTRY) as Array<keyof typeof VIEW_REGISTRY>)
      .filter((v) => VIEW_REGISTRY[v].showsSheaf)
      .sort();
    expect(withSheaf).toEqual(["folio", "gazetteer", "launcher", "tasking"]);
  });
  it("keeps today's folio codes", () => {
    expect(VIEW_REGISTRY.constellation.folioCode).toBe("GRAPH");
    expect(VIEW_REGISTRY.gazetteer.folioCode).toBe("INDEX");
    expect(VIEW_REGISTRY.docs.folioCode).toBe("DOC-001");
    expect(VIEW_REGISTRY.folio.folioCode).toBeNull();
    expect(VIEW_REGISTRY.launcher.folioCode).toBe("—");
  });
  it("highlights FOLIO for launcher, nothing for repairs/agenda", () => {
    expect(VIEW_REGISTRY.launcher.navRoot).toBe("folio");
    expect(VIEW_REGISTRY.repairs.navRoot).toBeNull();
    expect(VIEW_REGISTRY.agenda.navRoot).toBeNull();
  });
});

describe("goToView", () => {
  it("routes simple views through navigate", () => {
    const d = deps();
    goToView("gazetteer", d);
    expect(d.navigate).toHaveBeenCalledWith({ to: "/gazetteer" });
  });
  it("routes docs to the default slug", () => {
    const d = deps();
    goToView("docs", d);
    expect(d.navigate).toHaveBeenCalledWith({
      to: "/docs/$slug",
      params: { slug: "introduction" },
    });
  });
  it("routes constellation through openTab (folioOrigin-stamping path)", () => {
    const d = deps();
    goToView("constellation", d);
    expect(d.openTab).toHaveBeenCalledWith("graph");
    expect(d.navigate).not.toHaveBeenCalled();
  });
  it("is a no-op for launcher", () => {
    const d = deps();
    goToView("launcher", d);
    expect(d.navigate).not.toHaveBeenCalled();
    expect(d.openTab).not.toHaveBeenCalled();
  });
});
```

(If `DEFAULT_DOC_SLUG` is not `"introduction"`, assert against the imported constant instead of the literal.)

- [ ] **Step 2: Run to verify failure**

Run: `bun --cwd ui run test viewRegistry`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `viewRegistry.ts`**

```ts
import type { useNavigate } from "@tanstack/react-router";
import type { CodexView } from "#/components/codex/useCodexView";
import { DEFAULT_DOC_SLUG } from "#/docs/constants";
import {
  type OpenTabTarget,
  runWorkspaceTransition,
  type TabType,
  useWorkspaceStore,
} from "#/store/workspace";

export interface ViewNavDeps {
  navigate: ReturnType<typeof useNavigate>;
  /** useOpenTab's opener: opens the tab, stamps folioOriginTabId, and
   * navigates to /workspace inside a workspace transition. */
  openTab: (
    type: TabType,
    path?: string,
    label?: string,
    target?: OpenTabTarget,
  ) => void;
}

export interface ViewDescriptor {
  /** Rail entry text and the footer's VIEW label. */
  label: string;
  /** Footer FILE code; null = derive from the active folio's path. */
  folioCode: string | null;
  showsSheaf: boolean;
  /** Which rail/mobile entry highlights while this view is current; null =
   * no highlight (repairs, agenda). */
  navRoot: CodexView | null;
  /** Mobile bottom-bar presentation, for views listed in MOBILE_NAV. */
  mobile: { name: string; label: string } | null;
  /** Navigate to this view; null for states that are not direct targets. */
  go: ((deps: ViewNavDeps) => void) | null;
}

export const VIEW_REGISTRY: Record<CodexView, ViewDescriptor> = {
  atrium: {
    label: "ATRIUM",
    folioCode: "ATRIUM",
    showsSheaf: false,
    navRoot: "atrium",
    mobile: { name: "Atrium", label: "ATR" },
    go: ({ navigate }) => void navigate({ to: "/" }),
  },
  folio: {
    label: "FOLIO",
    folioCode: null,
    showsSheaf: true,
    navRoot: "folio",
    mobile: null,
    go: ({ navigate }) => {
      runWorkspaceTransition(() => {
        const store = useWorkspaceStore.getState();
        const firstPage = store.tabs.find((t) => t.type === "page");
        // With no folio open, drop focus off any lingering graph tab so the
        // workspace shows the FolioLauncher empty state rather than the graph.
        if (firstPage) store.activateTab(firstPage.id);
        else store.clearActiveTab();
        void navigate({ to: "/workspace" });
      });
    },
  },
  launcher: {
    label: "LAUNCHER",
    folioCode: "—",
    showsSheaf: true,
    navRoot: "folio",
    mobile: null,
    go: null,
  },
  constellation: {
    label: "CONSTELLATION",
    folioCode: "GRAPH",
    showsSheaf: false,
    navRoot: "constellation",
    mobile: { name: "Constellation", label: "GRAPH" },
    go: ({ openTab }) => openTab("graph"),
  },
  gazetteer: {
    label: "GAZETTEER",
    folioCode: "INDEX",
    showsSheaf: true,
    navRoot: "gazetteer",
    mobile: { name: "Gazetteer", label: "GAZ" },
    go: ({ navigate }) => void navigate({ to: "/gazetteer" }),
  },
  tasking: {
    label: "TASKING",
    folioCode: "TASKING",
    showsSheaf: true,
    navRoot: "tasking",
    mobile: null,
    go: ({ navigate }) => void navigate({ to: "/tasking" }),
  },
  academic: {
    label: "ACADEMIC",
    folioCode: "ACADEMIC",
    showsSheaf: false,
    navRoot: "academic",
    mobile: { name: "Academic", label: "ACAD" },
    go: ({ navigate }) => void navigate({ to: "/academic" }),
  },
  bases: {
    label: "BASES",
    folioCode: "BASES",
    showsSheaf: false,
    navRoot: "bases",
    mobile: { name: "Bases", label: "BASE" },
    go: ({ navigate }) => void navigate({ to: "/bases" }),
  },
  feeds: {
    label: "FEEDS",
    folioCode: "FEEDS",
    showsSheaf: false,
    navRoot: "feeds",
    mobile: { name: "Feeds", label: "FEED" },
    go: ({ navigate }) => void navigate({ to: "/feeds" }),
  },
  docs: {
    label: "DOCS",
    folioCode: "DOC-001",
    showsSheaf: false,
    navRoot: "docs",
    mobile: null,
    go: ({ navigate }) =>
      void navigate({ to: "/docs/$slug", params: { slug: DEFAULT_DOC_SLUG } }),
  },
  repairs: {
    label: "REPAIRS",
    folioCode: "REPAIRS",
    showsSheaf: false,
    navRoot: null,
    mobile: null,
    go: ({ navigate }) => void navigate({ to: "/repairs" }),
  },
  agenda: {
    label: "AGENDA",
    folioCode: "AGENDA",
    showsSheaf: false,
    navRoot: null,
    mobile: null,
    go: ({ navigate }) => void navigate({ to: "/agenda" }),
  },
};

/** Header rail order with diegetic index = position (pad2). */
export const DESKTOP_NAV: readonly CodexView[] = [
  "atrium",
  "folio",
  "gazetteer",
  "constellation",
  "tasking",
  "academic",
  "bases",
  "feeds",
  "docs",
];

export const MOBILE_NAV: readonly CodexView[] = [
  "atrium",
  "gazetteer",
  "academic",
  "bases",
  "feeds",
  "constellation",
];

export function goToView(view: CodexView, deps: ViewNavDeps): void {
  VIEW_REGISTRY[view].go?.(deps);
}
```

Note: `navigate({ to: "/gazetteer" })` and `{ to: "/feeds" }` without `search` only typecheck after Task 4. If executing tasks out of order, do Task 4 first.

- [ ] **Step 4: Run tests**

Run: `bun --cwd ui run test viewRegistry`
Expected: PASS (after Task 4 if the gazetteer/feeds nav types complain).

- [ ] **Step 5: Gates and commit**

```bash
bun --cwd ui run typecheck && bun --cwd ui run lint
git add ui/src/components/codex/viewRegistry.ts ui/src/components/codex/viewRegistry.test.ts
git commit -m "feat(ui): add exhaustive CodexView descriptor registry"
```

---

### Task 4: Optional navigate search via SearchSchemaInput

**Files:**
- Modify: `ui/src/routes/gazetteer.tsx:21-22`, `ui/src/routes/feeds.tsx:16-17`
- Modify: `ui/src/components/codex/Atrium.tsx:307-310` (gazetteer defaults), `ui/src/components/codex/CommandPalette.tsx:187-199` (tag command)

**Interfaces:**
- Produces: `navigate({ to: "/gazetteer" })` and `navigate({ to: "/feeds" })` typecheck with no `search` and no casts; `validateSearch` output types (`GazetteerSearch`, `FeedsSearch`) unchanged, so `Route.useSearch()` consumers are untouched.

- [ ] **Step 1: Relax the validators' input types**

In `gazetteer.tsx`:

```ts
import { createFileRoute, type SearchSchemaInput, useNavigate } from "@tanstack/react-router";
// ...
validateSearch: (
  search: Record<string, unknown> & SearchSchemaInput,
): GazetteerSearch => {
```

In `feeds.tsx`, the same change to its `validateSearch` signature.

- [ ] **Step 2: Simplify call sites that only pass defaults**

- `Atrium.tsx:307-310`: replace `navigate({ to: "/gazetteer", search: { sort: "ts", page: 1 } })` with `navigate({ to: "/gazetteer" })` (keep any non-default search keys if present).
- `CommandPalette.tsx` tag command (~194-197): `navigate({ to: "/gazetteer", search: { tags: [t.tag] } })` — drop `sort`/`page`.

Leave the frame/shortcut/palette nav-map call sites alone — Tasks 5–9 delete them wholesale.

- [ ] **Step 3: Verify**

Run: `bun --cwd ui run typecheck && bun --cwd ui run test gazetteer` and `bun --cwd ui run test feeds`
Expected: PASS — validators still apply `sort: "ts"`, `page: 1`, `view: "all"`, `manage: false` defaults at runtime.

- [ ] **Step 4: Commit**

```bash
bun --cwd ui run lint
git add ui/src/routes/gazetteer.tsx ui/src/routes/feeds.tsx ui/src/components/codex/Atrium.tsx ui/src/components/codex/CommandPalette.tsx
git commit -m "refactor(ui): make gazetteer/feeds search optional at navigate via SearchSchemaInput"
```

---

### Task 5: DesktopCodexFrame consumes the hook and registry

**Files:**
- Modify: `ui/src/components/codex/DesktopCodexFrame.tsx`
- Modify: `ui/src/components/codex/__tests__/CodexFrame.test.tsx` (router mock + launcher expectations)

**Interfaces:**
- Consumes: `useCodexView` (Task 2), `VIEW_REGISTRY`/`DESKTOP_NAV`/`goToView` (Task 3), `selectActiveTab` (Task 1), `useOpenTab` from `#/hooks/useOpenTab`.
- Produces: `DesktopCodexFrame` no longer reads the `pathname` prop (prop removed from the type in Task 6); `NAV`, `useFolioCode`, and `onNav` are deleted.

- [ ] **Step 1: Update the CodexFrame test harness**

`CodexFrame.test.tsx` mocks `@tanstack/react-router` with a mutable `locationState.pathname`. Extend the same `vi.mock` factory with a `useRouterState` whose matches derive from that pathname via an explicit test table (no prefix logic in production is being re-tested here — this is harness plumbing):

```ts
const TEST_ROUTE_VIEWS: ReadonlyArray<[prefix: string, view: string]> = [
  ["/workspace", "workspace"],
  ["/gazetteer", "gazetteer"],
  ["/tasking", "tasking"],
  ["/academic", "academic"],
  ["/bases", "bases"],
  ["/feeds", "feeds"],
  ["/docs", "docs"],
  ["/repairs", "repairs"],
  ["/agenda", "agenda"],
];

function testMatches(pathname: string) {
  const hit = TEST_ROUTE_VIEWS.find(
    ([p]) => pathname === p || pathname.startsWith(`${p}/`),
  );
  return [
    { staticData: { codexView: "atrium" } },
    ...(hit ? [{ staticData: { codexView: hit[1] } }] : []),
  ];
}
// inside the vi.mock("@tanstack/react-router", ...) factory:
useRouterState: ({ select }: { select: (s: { matches: unknown[] }) => unknown }) =>
  select({ matches: testMatches(locationState.pathname) }),
```

Near-prefix suites ("/docs-old", "/feeds-old") now exercise `testMatches` falling through to atrium — assertions unchanged.

- [ ] **Step 2: Add failing desktop expectations**

- New test: on `/workspace` with no active tab, the footer shows `FILE — · VIEW LAUNCHER` and the Sheaf is present, and the FOLIO rail entry has `aria-current="page"`.
- Existing suites (docs/feeds/bases/academic FILE codes, sheaf presence, `aria-current`) must pass unchanged.

Run: `bun --cwd ui run test CodexFrame` — Expected: new test FAILS (still renders VIEW FOLIO).

- [ ] **Step 3: Rewrite the frame internals**

In `DesktopCodexFrame.tsx`:

```tsx
import { useOpenTab } from "#/hooks/useOpenTab";
import { useCodexView } from "#/components/codex/useCodexView";
import {
  DESKTOP_NAV,
  goToView,
  VIEW_REGISTRY,
} from "#/components/codex/viewRegistry";
import { selectActiveTab } from "#/store/workspace";
```

- Delete the `NAV` constant, `useFolioCode`, and the whole `onNav` chain; delete the `resolveCodexView` import and the `runWorkspaceTransition`/`DEFAULT_DOC_SLUG` imports if now unused.
- View: `const resolved = useCodexView(); const view = forceView ?? resolved;`
- Store access becomes two narrow subscriptions (replacing `const { tabs: workspaceTabs, activeTabId, openTab } = useWorkspaceStore()` and `useFolioCode`'s second subscription):

```tsx
const activeTabId = useWorkspaceStore((s) => s.activeTabId);
const activePath = useWorkspaceStore((s) => selectActiveTab(s)?.path);
const openTab = useOpenTab();
const descriptor = VIEW_REGISTRY[view];
const folioCode =
  descriptor.folioCode ?? (activePath ? shortFolio(activePath) : "—");
```

- Nav rail:

```tsx
{DESKTOP_NAV.map((key, i) => {
  const active = VIEW_REGISTRY[view].navRoot === key;
  return (
    <button
      key={key}
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => goToView(key, { navigate, openTab })}
      className={cn(/* unchanged classes */)}
    >
      <span className="text-[9px] text-ink-mute">{pad2(i)}</span>
      <span className="text-[10px]">{VIEW_REGISTRY[key].label}</span>
    </button>
  );
})}
```

- Sheaf: `{descriptor.showsSheaf && <Sheaf activeTabId={activeTabId} className="order-1" />}`
- Footer status line: `FILE {folioCode} · VIEW {descriptor.label} · CORPUS {pages}/{links}` (drop `view.toUpperCase()`).
- Reading progress stays `view === "folio"`.

- [ ] **Step 4: Run tests**

Run: `bun --cwd ui run test CodexFrame` and `bun --cwd ui run test CodexFrameBreakpoint`
Expected: PASS, including the new launcher suite.

- [ ] **Step 5: Gates and commit**

```bash
bun --cwd ui run typecheck && bun --cwd ui run lint
git add ui/src/components/codex/DesktopCodexFrame.tsx ui/src/components/codex/__tests__/CodexFrame.test.tsx
git commit -m "refactor(ui): drive DesktopCodexFrame from useCodexView + view registry"
```

---

### Task 6: MobileCodexFrame and CodexFrame prop cleanup

**Files:**
- Modify: `ui/src/components/codex/MobileCodexFrame.tsx`
- Modify: `ui/src/components/codex/CodexFrame.tsx:15-18, 32-44`
- Modify: `ui/src/components/codex/__tests__/FolioNavigation.test.tsx` only if it referenced the removed prop (it renders `<CodexFrame>` bare — expected no change)

**Interfaces:**
- Consumes: `useCodexView`, `VIEW_REGISTRY`/`MOBILE_NAV`/`goToView`, `useOpenTab`.
- Produces: `CodexFrameChromeProps` loses `pathname` (becomes `Omit<CodexFrameProps, "children"> & { bottomSlot: Element | null }`); both frames receive only `bottomSlot` + `forceView`. `forceView`'s JSDoc becomes: `/** Test-only: pin the view so router/store state isn't the variable under test. */`

- [ ] **Step 1: Rewrite MobileCodexFrame internals**

- Delete `MobileRoot`, `ROOTS`, `navigateToRoot`, the `resolveCodexView` import, and the whole-store subscription (`const { tabs, activeTabId, openTab } = useWorkspaceStore()` — nothing in this frame needs the store anymore); delete the `runWorkspaceTransition` import.
- `const resolved = useCodexView(); const view = forceView ?? resolved; const openTab = useOpenTab();`
- Bottom nav:

```tsx
{MOBILE_NAV.map((root) => {
  const { mobile } = VIEW_REGISTRY[root];
  if (!mobile) return null;
  const active = VIEW_REGISTRY[view].navRoot === root;
  return (
    <button
      key={root}
      type="button"
      onClick={() => goToView(root, { navigate, openTab })}
      aria-label={mobile.name}
      aria-current={active ? "page" : undefined}
      className={cn(/* unchanged classes */)}
    >
      {mobile.label}
    </button>
  );
})}
```

Behavior note: the constellation root now opens via `useOpenTab` (stamps `folioOriginTabId`) — this is decision 4, intended.

- [ ] **Step 2: Trim CodexFrame**

Remove `pathname` from `CodexFrameChromeProps` and from both `<MobileCodexFrame …/>`/`<DesktopCodexFrame …/>` call sites. `CodexFrame` keeps its own `useLocation()` solely for the `key={pathname}` remount.

- [ ] **Step 3: Run tests**

Run: `bun --cwd ui run test CodexFrame` · `bun --cwd ui run test CodexFrameBreakpoint` · `bun --cwd ui run test FolioNavigation`
Expected: PASS. Mobile suites asserting roots order/labels and aria-current stay green (registry preserves both).

- [ ] **Step 4: Gates and commit**

```bash
bun --cwd ui run typecheck && bun --cwd ui run lint
git add ui/src/components/codex/MobileCodexFrame.tsx ui/src/components/codex/CodexFrame.tsx
git commit -m "refactor(ui): drive MobileCodexFrame from the view registry; drop pathname prop"
```

---

### Task 7: TabContent reads selectWorkspaceMode

**Files:**
- Modify: `ui/src/components/TabContent.tsx`
- Test: extend `ui/src/store/workspaceView.test.ts` already covers the mode mapping; add a component test only if one exists for TabContent today (none found — the mode selector tests carry the logic).

**Interfaces:**
- Consumes: `selectActiveTab`, `selectWorkspaceMode` from Task 1.
- Produces: `TabContent` renders launcher/constellation/folio strictly by `WorkspaceMode` — the pathless-page `return null` hole is gone.

- [ ] **Step 1: Rewrite the component body**

```tsx
export function TabContent() {
  const activeTab = useWorkspaceStore(selectActiveTab);
  const mode = useWorkspaceStore(selectWorkspaceMode);

  if (mode === "constellation") {
    return (
      <Suspense
        fallback={
          <div className="cl-marg p-6">… plotting the constellation …</div>
        }
      >
        <Constellation />
      </Suspense>
    );
  }

  if (mode === "folio" && activeTab?.path) {
    return (
      <FolioBoundary key={activeTab.path} path={activeTab.path}>
        <Folio tabId={activeTab.id} path={activeTab.path} />
      </FolioBoundary>
    );
  }

  return <FolioLauncher />;
}
```

(The `mode === "folio" && activeTab?.path` guard is for the type system; `selectWorkspaceMode` already guarantees it.)

- [ ] **Step 2: Verify**

Run: `bun --cwd ui run test TabContent` (if a suite exists) plus `bun --cwd ui run test workspaceView`; then `bun --cwd ui run typecheck && bun --cwd ui run lint`.
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/TabContent.tsx
git commit -m "refactor(ui): render TabContent from selectWorkspaceMode; launcher covers pathless tabs"
```

---

### Task 8: Shortcuts — router-sourced gates, registry nav, ⌃Tab fix

**Files:**
- Modify: `ui/src/hooks/useGlobalShortcuts.tsx`
- Modify: `ui/src/store/quires.ts:105-119`
- Create: `ui/src/store/quires-cycle.test.ts`

**Interfaces:**
- Consumes: `routeViewFromMatches` (Task 2), `goToView` (Task 3), `useRouter` from `@tanstack/react-router`.
- Produces: `cycleTargetId` handles an `activeTabId` not present in the candidate list (returns first/last visible); shortcut `when`-gates read router state.

- [ ] **Step 1: Write failing cycleTargetId tests**

```ts
// ui/src/store/quires-cycle.test.ts
import { describe, expect, it } from "vitest";
import { cycleTargetId } from "#/store/quires";
import type { TabDescriptor } from "#/store/workspace";

const page = (id: string): TabDescriptor => ({ id, type: "page", path: `${id}.md`, label: id });

describe("cycleTargetId with an active id outside the candidate list", () => {
  const tabs = [page("a"), page("b"), page("c")];
  it("enters at the first tab cycling forward", () => {
    expect(cycleTargetId(tabs, {}, "graph-tab", false)).toBe("a");
  });
  it("enters at the last tab cycling backward", () => {
    expect(cycleTargetId(tabs, {}, "graph-tab", true)).toBe("c");
  });
  it("enters a single-tab list from outside", () => {
    expect(cycleTargetId([page("a")], {}, "graph-tab", false)).toBe("a");
  });
  it("still no-ops with fewer than two tabs when active is in the list", () => {
    expect(cycleTargetId([page("a")], {}, "a", false)).toBeNull();
  });
});
```

Run: `bun --cwd ui run test quires-cycle` — Expected: FAIL (backward-from-outside returns `"b"`; single-tab returns null).

- [ ] **Step 2: Fix `cycleTargetId`**

```ts
export function cycleTargetId(
  tabs: TabDescriptor[],
  quires: Record<string, Quire>,
  activeTabId: string | null,
  backwards: boolean,
): string | null {
  const visible = tabs.filter((t) => !isTabHidden(t, quires));
  if (visible.length === 0) return null;
  const idx = visible.findIndex((t) => t.id === activeTabId);
  // Active tab not in the candidate list (e.g. the graph tab while cycling
  // page tabs): enter the ring at its start/end instead of wrapping math.
  if (idx === -1) return visible[backwards ? visible.length - 1 : 0].id;
  if (visible.length < 2) return null;
  const next = backwards
    ? (idx - 1 + visible.length) % visible.length
    : (idx + 1) % visible.length;
  return visible[next].id;
}
```

Run: `bun --cwd ui run test quires` (existing + new suites) — Expected: PASS.

- [ ] **Step 3: Rewire `useGlobalShortcuts`**

- Replace the module-level `inWorkspace`/`inTasking` (lines 38-39) with router-sourced closures inside the hook:

```ts
import { useNavigate, useRouter } from "@tanstack/react-router";
import { routeViewFromMatches } from "#/components/codex/useCodexView";
import { goToView } from "#/components/codex/viewRegistry";
// in useGlobalShortcuts():
const router = useRouter();
const inWorkspace = () =>
  routeViewFromMatches(router.state.matches) === "workspace";
const inTasking = () =>
  routeViewFromMatches(router.state.matches) === "tasking";
```

Add `router` to the `useMemo` dep array; the two closures are defined inside the memo factory (or hoisted above it) so lint stays quiet.

- `cycleTab` filters to page tabs (fixes decision 3):

```ts
function cycleTab(dir: 1 | -1) {
  const { tabs, quires, activeTabId, activateTab } =
    useWorkspaceStore.getState();
  const pageTabs = tabs.filter((t) => t.type === "page");
  const target = cycleTargetId(pageTabs, quires, activeTabId, dir === -1);
  if (target) activateTab(target);
}
```

- Nav bindings go through the registry (one deps object per run):

```ts
"nav.atrium": { run: () => goToView("atrium", { navigate, openTab }) },
"nav.constellation": { run: () => goToView("constellation", { navigate, openTab }) },
"nav.gazetteer": { run: () => goToView("gazetteer", { navigate, openTab }) },
"nav.tasking": { run: () => goToView("tasking", { navigate, openTab }) },
```

- [ ] **Step 4: Verify**

Run: `bun --cwd ui run test shortcuts` (or the file's suite name) and `bun --cwd ui run test quires-cycle`; `bun --cwd ui run typecheck && bun --cwd ui run lint`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/hooks/useGlobalShortcuts.tsx ui/src/store/quires.ts ui/src/store/quires-cycle.test.ts
git commit -m "fix(ui): route-sourced shortcut gates, registry nav, page-only tab cycling"
```

---

### Task 9: CommandPalette and useOpenTab route-awareness

**Files:**
- Modify: `ui/src/components/codex/CommandPalette.tsx:101-158, 205-207`
- Modify: `ui/src/hooks/useOpenTab.ts`

**Interfaces:**
- Consumes: `goToView`, `routeViewFromMatches`, `useRouterState`, `selectActiveTab`.
- Produces: palette nav cases delegate to the registry; `useOpenTab` detects the workspace route via matches instead of `pathname === "/workspace"`.

- [ ] **Step 1: Palette nav cases via the registry**

In the static-command `switch` replace the navigation cases:

```ts
case "navigate-atrium":      goToView("atrium", { navigate, openTab }); return;
case "open-constellation":   goToView("constellation", { navigate, openTab }); return;
case "navigate-gazetteer":   goToView("gazetteer", { navigate, openTab }); return;
case "navigate-bases":       goToView("bases", { navigate, openTab }); return;
case "navigate-academic":    goToView("academic", { navigate, openTab }); return;
case "navigate-repairs":     goToView("repairs", { navigate, openTab }); return;
```

`create-base` keeps its explicit `navigate({ to: "/bases", search: { create: true } })`. All non-navigation cases are untouched. Replace the quire-commands lookup (`workspaceTabs.find((t) => t.id === activeTabId)` at ~206) with `useWorkspaceStore(selectActiveTab)` and drop the now-unneeded `workspaceTabs`/`activeTabId` subscriptions if nothing else uses them.

- [ ] **Step 2: useOpenTab route detection**

```ts
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { routeViewFromMatches } from "#/components/codex/useCodexView";
// in useOpenTab():
const onWorkspaceRoute = useRouterState({
  select: (s) => routeViewFromMatches(s.matches) === "workspace",
});
// in the callback:
const folioOriginTabId = onWorkspaceRoute ? activeTabId : null;
```

Remove the `useLocation` import; update the `useCallback` deps (`onWorkspaceRoute` replaces `pathname`).

- [ ] **Step 3: Verify**

Run: `bun --cwd ui run test CommandPalette` and `bun --cwd ui run test useOpenTab` (if suites exist), plus `bun --cwd ui run test` narrow smoke of `CodexFrame`; `bun --cwd ui run typecheck && bun --cwd ui run lint`.
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/codex/CommandPalette.tsx ui/src/hooks/useOpenTab.ts
git commit -m "refactor(ui): palette nav via view registry; route-aware folio origin in useOpenTab"
```

---

### Task 10: Delete the legacy resolver, full gates

**Files:**
- Modify: `ui/src/components/codex/useCodexView.ts` (delete `resolveCodexView` and its `TabDescriptor` import)
- Modify: `ui/src/components/codex/useCodexView.test.ts` (delete legacy pathname suites; new suites from Task 2 remain — port the workspace page/graph split cases onto `selectWorkspaceMode` in `workspaceView.test.ts` if not already covered)

- [ ] **Step 1: Delete `resolveCodexView`**

Remove the function and any now-unused imports. `git grep -n "resolveCodexView" ui/src` must return nothing.

- [ ] **Step 2: Dead-export sweep**

Run: `bun --cwd ui run knip`
Expected: no new unused exports (fix any it reports from Tasks 1–9).

- [ ] **Step 3: Full verification gates**

Run: `bun --cwd ui run typecheck` · `bun --cwd ui run lint` · `bun --cwd ui run test`
Expected: all green. Report results explicitly.

- [ ] **Step 4: Commit**

```bash
git add -A ui/src
git commit -m "refactor(ui): remove legacy pathname-based resolveCodexView"
```

---

### Task 11: Merge

- [ ] Use superpowers:finishing-a-development-branch — merge `feature/codex-view-registry` into `develop`, delete the branch, clean up any worktree.
