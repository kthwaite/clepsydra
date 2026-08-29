# Bases View State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapsible group sections, a Fields visibility popover over the existing hidden-columns override, and `?view=` deep links with last-view restore on the standalone Base route.

**Architecture:** Two new pure modules (`view-state.ts`, `group-collapse.ts`) own storage keys, parsing, and resolution; two small hooks (`useGroupCollapse`, extended `useViewOverrides`) hold state; `BaseTableView` renders the fold and the Fields popover; `BaseTable` + the `/bases/$slug` route own the URL ↔ memory ↔ first-view resolution. No server change.

**Tech Stack:** React 19, TanStack Router (`validateSearch`, `useNavigate`), react-aria-components (`DialogTrigger`, `Dialog`, `Popover`, `Checkbox`), Vitest + Testing Library, Biome.

**Spec:** `docs/superpowers/specs/2026-08-29-bases-view-state-design.md`

## Global Constraints

- UI only. Do not touch `src/`, `tests/`, or `ui/src/api/schema.d.ts`.
- Storage keys, exactly: `clepsydra.bases.lastView.<slug>` and `clepsydra.bases.groups.<slug>.<asciiCaseFold(view)>.<groupField>`.
- Every `localStorage` access is wrapped in try/catch; without storage the feature works in-session only and never throws.
- Copy, exactly: `Collapse all`, `Expand all`, `Fields`, `Fields (N hidden)`, `Show all`, `The title column stays visible`, `The last column stays visible`.
- `?view=` navigations use `replace: true`. Last view is written only on an explicit view switch.
- Never put `Pressable` or `ContextMenuTrigger` inside the RAC grid (it steals in-cell focus).
- Imports use the `#/` alias for cross-directory paths; sibling files use `./`.
- Commands run from `/Users/kit/Source/_p.pkm/clepsydra/.worktrees/bases-view-state/ui`: `bun run test <file>`, `bun run typecheck`, `bun run lint`, and `bunx biome check --fix <paths>` to format only the files you touched (never a repo-wide sweep).
- Stage explicit paths (`git add <files>`; a bare `git add .` is refused by the user's shell) and commit per task.

---

### Task 1: `withoutHiddenColumn` → `showColumn` → `onShowColumn`

**Files:**
- Modify: `ui/src/components/bases/view-overrides.ts`
- Modify: `ui/src/components/bases/useViewOverrides.ts`
- Modify: `ui/src/components/bases/useBaseTableController.ts`
- Modify: `ui/src/components/bases/BaseTableView.tsx` (interface only)
- Test: `ui/src/components/bases/__tests__/view-overrides.test.ts`
- Test: `ui/src/components/bases/__tests__/useViewOverrides.test.tsx`
- Test: `ui/src/components/bases/__tests__/useBaseTableController.test.tsx`

**Interfaces:**
- Produces: `withoutHiddenColumn(state: ViewOverridesState, column: string): ViewOverridesState`; `ViewOverridesModel.showColumn(column: string): void`; `BaseTableControllerModel.onShowColumn(column: string): void`; `BaseTableViewProps.onShowColumn?(column: string): void`.

- [ ] **Step 1: Write the failing tests**

Append to `view-overrides.test.ts` (add `withoutHiddenColumn` to the import list):

```ts
describe("withoutHiddenColumn", () => {
  it("removes one hidden column and keeps the rest", () => {
    const state = withHiddenColumn(
      withHiddenColumn(EMPTY_OVERRIDES, "author"),
      "rating",
    );
    expect(withoutHiddenColumn(state, "author").hiddenColumns).toEqual([
      "rating",
    ]);
  });

  it("returns the same state when the column is not hidden", () => {
    const state = withHiddenColumn(EMPTY_OVERRIDES, "author");
    expect(withoutHiddenColumn(state, "rating")).toBe(state);
  });
});
```

Append to `useViewOverrides.test.tsx` inside the existing `describe`:

```tsx
  it("shows one hidden column again", () => {
    const { result } = renderHook(() => useViewOverrides("k"));
    act(() => {
      result.current.hideColumn("author");
      result.current.hideColumn("rating");
      result.current.showColumn("author");
    });
    expect(result.current.state.hiddenColumns).toEqual(["rating"]);
  });
```

Append to the `describe("view overrides", …)` block in `useBaseTableController.test.tsx`:

```tsx
  it("exposes onShowColumn, which undoes one onHideColumn", () => {
    const { result } = renderHook(() =>
      useBaseTableController({
        mode: "standalone",
        slug: "reading",
        activeView: "Continues",
        sort: undefined,
        onViewChange: vi.fn(),
        onSortChange: vi.fn(),
      }),
    );
    act(() => {
      result.current.onHideColumn("status");
      result.current.onHideColumn("rating");
    });
    expect(result.current.overrides.hiddenColumns).toEqual([
      "status",
      "rating",
    ]);
    act(() => result.current.onShowColumn("status"));
    expect(result.current.overrides.hiddenColumns).toEqual(["rating"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test src/components/bases/__tests__/view-overrides.test.ts src/components/bases/__tests__/useViewOverrides.test.tsx src/components/bases/__tests__/useBaseTableController.test.tsx`
Expected: FAIL — `withoutHiddenColumn` is not exported; `showColumn` / `onShowColumn` are not functions.

- [ ] **Step 3: Implement**

`view-overrides.ts`, after `withHiddenColumn`:

```ts
export function withoutHiddenColumn(
  state: ViewOverridesState,
  column: string,
): ViewOverridesState {
  if (!state.hiddenColumns.includes(column)) return state;
  return {
    ...state,
    hiddenColumns: state.hiddenColumns.filter((c) => c !== column),
  };
}
```

`useViewOverrides.ts`: import `withoutHiddenColumn`; add `showColumn(column: string): void;` to `ViewOverridesModel` after `hideColumn`; add to the returned object after `hideColumn`:

```ts
    showColumn: useCallback(
      (column) => update((s) => withoutHiddenColumn(s, column)),
      [update],
    ),
```

`useBaseTableController.ts`: add `onShowColumn(column: string): void;` to `BaseTableControllerModel` after `onHideColumn`; add `onShowColumn: overrides.showColumn,` to the returned object after `onHideColumn: overrides.hideColumn,`.

`BaseTableView.tsx`: add `onShowColumn?(column: string): void;` to `BaseTableViewProps` directly after `onHideColumn?(column: string): void;`. Do not destructure it yet (Task 6 does).

- [ ] **Step 4: Run the tests to verify they pass**

Run the same command as Step 2. Expected: PASS. Then `bun run typecheck` and `bun run lint` — clean.

- [ ] **Step 5: Commit**

```bash
bunx biome check --fix src/components/bases/view-overrides.ts src/components/bases/useViewOverrides.ts src/components/bases/useBaseTableController.ts src/components/bases/BaseTableView.tsx src/components/bases/__tests__/view-overrides.test.ts src/components/bases/__tests__/useViewOverrides.test.tsx src/components/bases/__tests__/useBaseTableController.test.tsx
git add src/components/bases/view-overrides.ts src/components/bases/useViewOverrides.ts src/components/bases/useBaseTableController.ts src/components/bases/BaseTableView.tsx src/components/bases/__tests__/view-overrides.test.ts src/components/bases/__tests__/useViewOverrides.test.tsx src/components/bases/__tests__/useBaseTableController.test.tsx
git commit -m "feat(bases): show a single hidden column again (withoutHiddenColumn, onShowColumn)"
```

---

### Task 2: `view-state.ts` — storage, last view, active-view resolution

**Files:**
- Create: `ui/src/components/bases/view-state.ts`
- Test: `ui/src/components/bases/__tests__/view-state.test.ts`

**Interfaces:**
- Produces: `ViewStateStorage`, `getViewStateStorage(): ViewStateStorage | undefined`, `readLastView(storage, slug): string | undefined`, `writeLastView(storage, slug, view): void`, `resolveActiveView(views, requested, remembered): { view: string; scrub: boolean }`.

- [ ] **Step 1: Write the failing tests**

`ui/src/components/bases/__tests__/view-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  readLastView,
  resolveActiveView,
  type ViewStateStorage,
  writeLastView,
} from "#/components/bases/view-state";

class MemoryStorage implements ViewStateStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

const sealed: ViewStateStorage = {
  getItem() {
    throw new Error("sealed");
  },
  setItem() {
    throw new Error("sealed");
  },
};

const views = [{ name: "Continues" }, { name: "Shelf" }];

describe("last view memory", () => {
  it("round-trips under the per-base key", () => {
    const storage = new MemoryStorage();
    writeLastView(storage, "reading", "Shelf");
    expect(storage.items.get("clepsydra.bases.lastView.reading")).toBe(
      "Shelf",
    );
    expect(readLastView(storage, "reading")).toBe("Shelf");
    expect(readLastView(storage, "other")).toBeUndefined();
  });

  it("treats an empty value as nothing remembered", () => {
    const storage = new MemoryStorage();
    storage.setItem("clepsydra.bases.lastView.reading", "");
    expect(readLastView(storage, "reading")).toBeUndefined();
  });

  it("survives missing and throwing storage", () => {
    expect(readLastView(undefined, "reading")).toBeUndefined();
    expect(() => writeLastView(undefined, "reading", "Shelf")).not.toThrow();
    expect(readLastView(sealed, "reading")).toBeUndefined();
    expect(() => writeLastView(sealed, "reading", "Shelf")).not.toThrow();
  });
});

describe("resolveActiveView", () => {
  it("returns nothing while there are no views", () => {
    expect(resolveActiveView([], "Shelf", "Continues")).toEqual({
      view: "",
      scrub: false,
    });
  });

  it("prefers the requested view and returns its canonical name", () => {
    expect(resolveActiveView(views, "shelf", "Continues")).toEqual({
      view: "Shelf",
      scrub: false,
    });
  });

  it("scrubs an unknown request and falls back to memory", () => {
    expect(resolveActiveView(views, "bogus", "shelf")).toEqual({
      view: "Shelf",
      scrub: true,
    });
  });

  it("scrubs an unknown request and falls back to the first view", () => {
    expect(resolveActiveView(views, "bogus", undefined)).toEqual({
      view: "Continues",
      scrub: true,
    });
  });

  it("restores memory without a request and never scrubs", () => {
    expect(resolveActiveView(views, undefined, "SHELF")).toEqual({
      view: "Shelf",
      scrub: false,
    });
  });

  it("ignores stale memory", () => {
    expect(resolveActiveView(views, undefined, "Gone")).toEqual({
      view: "Continues",
      scrub: false,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/components/bases/__tests__/view-state.test.ts`
Expected: FAIL — module `#/components/bases/view-state` not found.

- [ ] **Step 3: Implement**

`ui/src/components/bases/view-state.ts`:

```ts
import { asciiCaseFold } from "./local-validation";

/** The slice of `Storage` the Base view-state helpers touch. */
export interface ViewStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LAST_VIEW_PREFIX = "clepsydra.bases.lastView.";

/** `window.localStorage`, or nothing when the browser refuses access. */
export function getViewStateStorage(): ViewStateStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function lastViewKey(slug: string): string {
  return `${LAST_VIEW_PREFIX}${slug}`;
}

export function readLastView(
  storage: ViewStateStorage | undefined,
  slug: string,
): string | undefined {
  try {
    return storage?.getItem(lastViewKey(slug)) || undefined;
  } catch {
    return undefined;
  }
}

export function writeLastView(
  storage: ViewStateStorage | undefined,
  slug: string,
  view: string,
): void {
  try {
    storage?.setItem(lastViewKey(slug), view);
  } catch {
    // Memory is a convenience; a full or sealed store must not break the table.
  }
}

export interface ActiveViewResolution {
  /** The saved view's canonical name, or "" until the definition arrives. */
  view: string;
  /** True when `requested` named no saved view and the URL should drop it. */
  scrub: boolean;
}

/** Pick the view to show: the URL's, else the remembered one, else the first. */
export function resolveActiveView(
  views: ReadonlyArray<{ name: string }>,
  requested: string | undefined,
  remembered: string | undefined,
): ActiveViewResolution {
  const first = views[0];
  if (first === undefined) return { view: "", scrub: false };
  const find = (name: string | undefined) =>
    name === undefined
      ? undefined
      : views.find(
          (candidate) => asciiCaseFold(candidate.name) === asciiCaseFold(name),
        );
  const fromRequest = find(requested);
  if (fromRequest) return { view: fromRequest.name, scrub: false };
  return {
    view: (find(remembered) ?? first).name,
    scrub: requested !== undefined,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test src/components/bases/__tests__/view-state.test.ts` → PASS. `bun run typecheck`, `bun run lint` — clean.

- [ ] **Step 5: Commit**

```bash
bunx biome check --fix src/components/bases/view-state.ts src/components/bases/__tests__/view-state.test.ts
git add src/components/bases/view-state.ts src/components/bases/__tests__/view-state.test.ts
git commit -m "feat(bases): view-state helpers — last-view memory and active-view resolution"
```

---

### Task 3: `group-collapse.ts` + `useGroupCollapse`

**Files:**
- Create: `ui/src/components/bases/group-collapse.ts`
- Create: `ui/src/components/bases/useGroupCollapse.ts`
- Test: `ui/src/components/bases/__tests__/group-collapse.test.ts`
- Test: `ui/src/components/bases/__tests__/useGroupCollapse.test.tsx`

**Interfaces:**
- Consumes: `ViewStateStorage`, `getViewStateStorage` from Task 2.
- Produces: `groupIdentity(key: unknown): string`, `groupCollapseKey(slug, view, groupField): string`, `readCollapsedGroups(storage, key): Set<string>`, `writeCollapsedGroups(storage, key, collapsed): void`, `useGroupCollapse(storageKey): GroupCollapseModel` with `{ collapsed: ReadonlySet<string>; toggle(id); expand(id); collapseAll(ids); expandAll() }`.

- [ ] **Step 1: Write the failing tests**

`ui/src/components/bases/__tests__/group-collapse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  groupCollapseKey,
  groupIdentity,
  readCollapsedGroups,
  writeCollapsedGroups,
} from "#/components/bases/group-collapse";
import type { ViewStateStorage } from "#/components/bases/view-state";

class MemoryStorage implements ViewStateStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

const sealed: ViewStateStorage = {
  getItem() {
    throw new Error("sealed");
  },
  setItem() {
    throw new Error("sealed");
  },
};

describe("groupIdentity", () => {
  it("keeps strings, numbers, booleans, and the empty group distinct", () => {
    expect(groupIdentity("1")).not.toBe(groupIdentity(1));
    expect(groupIdentity(true)).not.toBe(groupIdentity("true"));
    expect(groupIdentity(null)).toBe(groupIdentity(undefined));
    expect(groupIdentity(null)).not.toBe(groupIdentity(""));
  });
});

describe("groupCollapseKey", () => {
  it("scopes the fold to base, case-folded view, and grouping field", () => {
    expect(groupCollapseKey("reading", "By Status", "status")).toBe(
      "clepsydra.bases.groups.reading.by status.status",
    );
  });
});

describe("collapsed group storage", () => {
  it("round-trips a set of identities", () => {
    const storage = new MemoryStorage();
    const key = groupCollapseKey("reading", "shelf", "status");
    writeCollapsedGroups(storage, key, new Set(['"reading"', "null"]));
    expect(storage.items.get(key)).toBe('["\\"reading\\"","null"]');
    expect([...readCollapsedGroups(storage, key)]).toEqual([
      '"reading"',
      "null",
    ]);
  });

  it("reads nothing from a missing, malformed, or non-string entry", () => {
    const storage = new MemoryStorage();
    expect(readCollapsedGroups(storage, "k").size).toBe(0);
    storage.setItem("k", "{not json");
    expect(readCollapsedGroups(storage, "k").size).toBe(0);
    storage.setItem("k", '{"a":1}');
    expect(readCollapsedGroups(storage, "k").size).toBe(0);
    storage.setItem("k", '["x", 1, null]');
    expect([...readCollapsedGroups(storage, "k")]).toEqual(["x"]);
  });

  it("survives missing and throwing storage", () => {
    expect(readCollapsedGroups(undefined, "k").size).toBe(0);
    expect(() => writeCollapsedGroups(undefined, "k", new Set())).not.toThrow();
    expect(readCollapsedGroups(sealed, "k").size).toBe(0);
    expect(() =>
      writeCollapsedGroups(sealed, "k", new Set(["x"])),
    ).not.toThrow();
  });
});
```

`ui/src/components/bases/__tests__/useGroupCollapse.test.tsx`:

```tsx
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useGroupCollapse } from "#/components/bases/useGroupCollapse";

const KEY = "clepsydra.bases.groups.reading.shelf.status";

describe("useGroupCollapse", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("toggles, expands, and folds everything", () => {
    const { result } = renderHook(() => useGroupCollapse(KEY));
    expect(result.current.collapsed.size).toBe(0);
    act(() => result.current.toggle('"reading"'));
    expect([...result.current.collapsed]).toEqual(['"reading"']);
    act(() => result.current.toggle('"reading"'));
    expect(result.current.collapsed.size).toBe(0);
    act(() => result.current.collapseAll(['"reading"', '"queued"']));
    expect([...result.current.collapsed]).toEqual(['"reading"', '"queued"']);
    act(() => result.current.expand('"queued"'));
    expect([...result.current.collapsed]).toEqual(['"reading"']);
    act(() => result.current.expandAll());
    expect(result.current.collapsed.size).toBe(0);
  });

  it("persists the fold and restores it on the next mount", () => {
    const first = renderHook(() => useGroupCollapse(KEY));
    act(() => first.result.current.toggle('"reading"'));
    expect(window.localStorage.getItem(KEY)).toBe('["\\"reading\\""]');
    first.unmount();
    const second = renderHook(() => useGroupCollapse(KEY));
    expect([...second.result.current.collapsed]).toEqual(['"reading"']);
  });

  it("reads the other key's fold when the key changes", () => {
    window.localStorage.setItem(
      "clepsydra.bases.groups.reading.continues.kind",
      '["\\"BOOK\\""]',
    );
    const { result, rerender } = renderHook(
      ({ key }) => useGroupCollapse(key),
      { initialProps: { key: KEY } },
    );
    act(() => result.current.toggle('"reading"'));
    rerender({ key: "clepsydra.bases.groups.reading.continues.kind" });
    expect([...result.current.collapsed]).toEqual(['"BOOK"']);
    act(() => result.current.toggle('"NOTE"'));
    expect([...result.current.collapsed]).toEqual(['"BOOK"', '"NOTE"']);
    rerender({ key: KEY });
    expect([...result.current.collapsed]).toEqual(['"reading"']);
  });

  it("keeps the same set identity when a transition changes nothing", () => {
    const { result } = renderHook(() => useGroupCollapse(KEY));
    const before = result.current.collapsed;
    act(() => result.current.expand('"never-folded"'));
    expect(result.current.collapsed).toBe(before);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test src/components/bases/__tests__/group-collapse.test.ts src/components/bases/__tests__/useGroupCollapse.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`ui/src/components/bases/group-collapse.ts`:

```ts
import { asciiCaseFold } from "./local-validation";
import type { ViewStateStorage } from "./view-state";

const GROUPS_PREFIX = "clepsydra.bases.groups.";

/** One string per group key, so `null`, numbers, and strings stay distinct. */
export function groupIdentity(key: unknown): string {
  return JSON.stringify(key ?? null);
}

/** Folds are remembered per base, view, and the field the rows are grouped by. */
export function groupCollapseKey(
  slug: string,
  view: string,
  groupField: string,
): string {
  return `${GROUPS_PREFIX}${slug}.${asciiCaseFold(view)}.${groupField}`;
}

export function readCollapsedGroups(
  storage: ViewStateStorage | undefined,
  key: string,
): Set<string> {
  try {
    const stored = storage?.getItem(key);
    if (!stored) return new Set();
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((entry): entry is string => typeof entry === "string"),
    );
  } catch {
    return new Set();
  }
}

export function writeCollapsedGroups(
  storage: ViewStateStorage | undefined,
  key: string,
  collapsed: ReadonlySet<string>,
): void {
  try {
    storage?.setItem(key, JSON.stringify([...collapsed]));
  } catch {
    // A fold is a convenience; a full or sealed store must not break the table.
  }
}
```

`ui/src/components/bases/useGroupCollapse.ts`:

```ts
import { useCallback, useMemo, useState } from "react";
import { readCollapsedGroups, writeCollapsedGroups } from "./group-collapse";
import { getViewStateStorage } from "./view-state";

export interface GroupCollapseModel {
  collapsed: ReadonlySet<string>;
  toggle(identity: string): void;
  expand(identity: string): void;
  collapseAll(identities: readonly string[]): void;
  expandAll(): void;
}

interface StoredFold {
  key: string;
  collapsed: ReadonlySet<string>;
}

function foldFor(key: string): StoredFold {
  return { key, collapsed: readCollapsedGroups(getViewStateStorage(), key) };
}

/** Which groups are folded under `storageKey`, mirrored to localStorage. */
export function useGroupCollapse(storageKey: string): GroupCollapseModel {
  const [stored, setStored] = useState<StoredFold>(() => foldFor(storageKey));
  const collapsed = useMemo(
    () => (stored.key === storageKey ? stored : foldFor(storageKey)).collapsed,
    [stored, storageKey],
  );
  const update = useCallback(
    (transition: (current: ReadonlySet<string>) => ReadonlySet<string>) =>
      setStored((current) => {
        const base =
          current.key === storageKey ? current : foldFor(storageKey);
        const next = transition(base.collapsed);
        if (next === base.collapsed) return base;
        // Idempotent, so a repeated updater call (StrictMode) is harmless.
        writeCollapsedGroups(getViewStateStorage(), storageKey, next);
        return { key: storageKey, collapsed: next };
      }),
    [storageKey],
  );
  return {
    collapsed,
    toggle: useCallback(
      (identity) =>
        update((current) => {
          const next = new Set(current);
          if (!next.delete(identity)) next.add(identity);
          return next;
        }),
      [update],
    ),
    expand: useCallback(
      (identity) =>
        update((current) => {
          if (!current.has(identity)) return current;
          const next = new Set(current);
          next.delete(identity);
          return next;
        }),
      [update],
    ),
    collapseAll: useCallback(
      (identities) => update(() => new Set(identities)),
      [update],
    ),
    expandAll: useCallback(
      () => update((current) => (current.size === 0 ? current : new Set())),
      [update],
    ),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command → PASS. `bun run typecheck`, `bun run lint` — clean.

- [ ] **Step 5: Commit**

```bash
bunx biome check --fix src/components/bases/group-collapse.ts src/components/bases/useGroupCollapse.ts src/components/bases/__tests__/group-collapse.test.ts src/components/bases/__tests__/useGroupCollapse.test.tsx
git add src/components/bases/group-collapse.ts src/components/bases/useGroupCollapse.ts src/components/bases/__tests__/group-collapse.test.ts src/components/bases/__tests__/useGroupCollapse.test.tsx
git commit -m "feat(bases): persisted group-collapse state helpers and hook"
```

---

### Task 4: `?view=` on the route and view restore in `BaseTable`

**Files:**
- Modify: `ui/src/routes/bases.$slug.tsx`
- Modify: `ui/src/components/bases/BaseTable.tsx`
- Test: `ui/src/routes/-bases.slug.test.tsx` (create)
- Test: `ui/src/components/bases/__tests__/BaseTable.test.tsx` (append a describe)

**Interfaces:**
- Consumes: `getViewStateStorage`, `readLastView`, `writeLastView`, `resolveActiveView` (Task 2).
- Produces: `parseBasesSlugSearch(search: Record<string, unknown>): { view?: string }`; `BaseTableProps { slug; requestedView?; onViewChange?(name); onScrubView?() }`.

- [ ] **Step 1: Write the failing tests**

`ui/src/routes/-bases.slug.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  search: {} as { view?: string },
  navigate: vi.fn(),
  tableProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ slug: "reading" }),
    useSearch: () => routeMocks.search,
  }),
  useNavigate: () => routeMocks.navigate,
  useMatchRoute: () => () => false,
  Outlet: () => null,
}));
vi.mock("#/components/bases/BaseTable", () => ({
  BaseTable: (props: {
    slug: string;
    requestedView?: string;
    onViewChange?: (name: string) => void;
    onScrubView?: () => void;
  }) => {
    routeMocks.tableProps.push(props);
    return (
      <div>
        <button type="button" onClick={() => props.onViewChange?.("Shelf")}>
          switch
        </button>
        <button type="button" onClick={() => props.onScrubView?.()}>
          scrub
        </button>
      </div>
    );
  },
}));

import { parseBasesSlugSearch, Route } from "#/routes/bases.$slug";

const BasesRoute = Route.options.component as () => ReactNode;

describe("/bases/$slug search", () => {
  it("keeps a trimmed non-empty view and drops everything else", () => {
    expect(parseBasesSlugSearch({ view: "  Shelf " })).toEqual({
      view: "Shelf",
    });
    expect(parseBasesSlugSearch({ view: "   " })).toEqual({});
    expect(parseBasesSlugSearch({ view: 3 })).toEqual({});
    expect(parseBasesSlugSearch({})).toEqual({});
    expect(Route.options.validateSearch).toBe(parseBasesSlugSearch);
  });
});

describe("/bases/$slug component", () => {
  beforeEach(() => {
    routeMocks.navigate.mockReset();
    routeMocks.tableProps.length = 0;
    routeMocks.search = { view: "Shelf" };
  });

  it("hands the URL view to the table", () => {
    render(<BasesRoute />);
    expect(routeMocks.tableProps.at(-1)).toMatchObject({
      slug: "reading",
      requestedView: "Shelf",
    });
  });

  it("writes a switched view into the URL by replacement", async () => {
    render(<BasesRoute />);
    await userEvent.click(screen.getByRole("button", { name: "switch" }));
    expect(routeMocks.navigate).toHaveBeenCalledWith({
      to: "/bases/$slug",
      params: { slug: "reading" },
      search: { view: "Shelf" },
      replace: true,
    });
  });

  it("drops the view from the URL on scrub", async () => {
    render(<BasesRoute />);
    await userEvent.click(screen.getByRole("button", { name: "scrub" }));
    expect(routeMocks.navigate).toHaveBeenCalledWith({
      to: "/bases/$slug",
      params: { slug: "reading" },
      search: {},
      replace: true,
    });
  });
});
```

Append to `BaseTable.test.tsx` (the file already mocks `useBase` to return the `definition` with views `Continues` then `Shelf`, and records `mocks.useBaseView(slug, view, overrides)`):

```tsx
describe("BaseTable view restore", () => {
  const LAST_VIEW_KEY = "clepsydra.bases.lastView.reading";

  beforeEach(() => {
    window.localStorage.clear();
    mocks.useBaseView.mockClear();
  });

  it("opens the URL view, case-insensitively, over memory", () => {
    window.localStorage.setItem(LAST_VIEW_KEY, "Continues");
    const onScrubView = vi.fn();
    render(
      <BaseTable
        slug="reading"
        requestedView="shelf"
        onScrubView={onScrubView}
      />,
    );
    expect(mocks.useBaseView).toHaveBeenLastCalledWith(
      "reading",
      "Shelf",
      expect.anything(),
    );
    expect(onScrubView).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LAST_VIEW_KEY)).toBe("Continues");
  });

  it("scrubs an unknown URL view and falls back to memory", async () => {
    window.localStorage.setItem(LAST_VIEW_KEY, "Shelf");
    const onScrubView = vi.fn();
    render(
      <BaseTable
        slug="reading"
        requestedView="bogus"
        onScrubView={onScrubView}
      />,
    );
    await waitFor(() => expect(onScrubView).toHaveBeenCalledTimes(1));
    expect(mocks.useBaseView).toHaveBeenLastCalledWith(
      "reading",
      "Shelf",
      expect.anything(),
    );
  });

  it("restores the remembered view on a plain open and ignores a stale one", () => {
    window.localStorage.setItem(LAST_VIEW_KEY, "Shelf");
    const { unmount } = render(<BaseTable slug="reading" />);
    expect(mocks.useBaseView).toHaveBeenLastCalledWith(
      "reading",
      "Shelf",
      expect.anything(),
    );
    unmount();
    window.localStorage.setItem(LAST_VIEW_KEY, "Gone");
    render(<BaseTable slug="reading" />);
    expect(mocks.useBaseView).toHaveBeenLastCalledWith(
      "reading",
      "Continues",
      expect.anything(),
    );
  });

  it("remembers and reports an explicit switch", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    render(<BaseTable slug="reading" onViewChange={onViewChange} />);
    await user.click(screen.getByRole("button", { name: "Shelf" }));
    expect(onViewChange).toHaveBeenCalledWith("Shelf");
    expect(window.localStorage.getItem(LAST_VIEW_KEY)).toBe("Shelf");
    expect(mocks.useBaseView).toHaveBeenLastCalledWith(
      "reading",
      "Shelf",
      expect.anything(),
    );
  });
});
```

Add `beforeEach` to the vitest import at the top of `BaseTable.test.tsx` if it is not already imported.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test src/routes/-bases.slug.test.tsx src/components/bases/__tests__/BaseTable.test.tsx`
Expected: FAIL — `parseBasesSlugSearch` is not exported; `requestedView` is ignored; nothing is written to storage.

- [ ] **Step 3: Implement**

`ui/src/routes/bases.$slug.tsx` (whole file):

```tsx
import {
  createFileRoute,
  Outlet,
  useMatchRoute,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback } from "react";
import { BaseTable } from "#/components/bases/BaseTable";

export interface BasesSlugSearch {
  /** The saved view to open, by name. Absent means remembered-or-first. */
  view?: string;
}

/** A non-empty trimmed `view` survives; anything else is dropped. */
export function parseBasesSlugSearch(
  search: Record<string, unknown>,
): BasesSlugSearch {
  const view = typeof search.view === "string" ? search.view.trim() : "";
  return view ? { view } : {};
}

function BasesRoute() {
  const { slug } = Route.useParams();
  const { view } = Route.useSearch();
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const handleViewChange = useCallback(
    (name: string) => {
      void navigate({
        to: "/bases/$slug",
        params: { slug },
        search: { view: name },
        replace: true,
      });
    },
    [navigate, slug],
  );
  const handleScrubView = useCallback(() => {
    void navigate({
      to: "/bases/$slug",
      params: { slug },
      search: {},
      replace: true,
    });
  }, [navigate, slug]);
  if (matchRoute({ to: "/bases/$slug/edit", params: { slug } })) {
    return <Outlet />;
  }
  return (
    <div className="mx-auto max-w-5xl p-4">
      {/* Keyed by slug so view selection and sort overrides reset when
          navigating between bases (param-only navigation reuses the node). */}
      <BaseTable
        key={slug}
        slug={slug}
        requestedView={view}
        onViewChange={handleViewChange}
        onScrubView={handleScrubView}
      />
    </div>
  );
}

export const Route = createFileRoute("/bases/$slug")({
  staticData: { codexView: "bases" },
  validateSearch: parseBasesSlugSearch,
  component: BasesRoute,
});
```

`ui/src/components/bases/BaseTable.tsx` (whole file):

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { type SortKey, useBase } from "#/api/bases";
import { BaseTableView } from "./BaseTableView";
import { useBaseTableController } from "./useBaseTableController";
import {
  getViewStateStorage,
  readLastView,
  resolveActiveView,
  writeLastView,
} from "./view-state";

interface BaseTableProps {
  slug: string;
  /** The view named in the URL, when there is one. */
  requestedView?: string;
  /** Reports an explicit view switch, for the URL to follow. */
  onViewChange?(name: string): void;
  /** Asks the URL to drop a `view` that names no saved view. */
  onScrubView?(): void;
}

/** A view chosen in this session, valid while the URL still says what it did then. */
interface ChosenView {
  under: string | undefined;
  name: string;
}

/** Standalone Base route wrapper with local view and sort overrides. */
export function BaseTable({
  slug,
  requestedView,
  onViewChange,
  onScrubView,
}: BaseTableProps) {
  // Deduplicated with the controller's query; needed here to resolve the
  // view before the controller asks for its rows.
  const detail = useBase(slug);
  const views = detail.data?.views;
  const remembered = useMemo(
    () => readLastView(getViewStateStorage(), slug),
    [slug],
  );
  const [chosen, setChosen] = useState<ChosenView | undefined>();
  const chosenName =
    chosen !== undefined && chosen.under === requestedView
      ? chosen.name
      : undefined;
  const { view: activeView, scrub } = useMemo(
    () =>
      resolveActiveView(views ?? [], chosenName ?? requestedView, remembered),
    [chosenName, remembered, requestedView, views],
  );
  useEffect(() => {
    if (scrub) onScrubView?.();
  }, [onScrubView, scrub]);
  const [sort, setSort] = useState<SortKey[] | undefined>();
  const handleViewChange = useCallback(
    (name: string) => {
      setChosen({ under: requestedView, name });
      writeLastView(getViewStateStorage(), slug, name);
      onViewChange?.(name);
    },
    [onViewChange, requestedView, slug],
  );
  const controller = useBaseTableController({
    mode: "standalone",
    slug,
    activeView,
    sort,
    onViewChange: handleViewChange,
    onSortChange: setSort,
  });
  const { detailLoading, detailMissing, definition, ...viewProps } = controller;

  if (detailLoading) {
    return <p className="cl-mono p-4 text-[12px] text-ink-mute">Loading…</p>;
  }
  if (detailMissing || !definition) {
    return (
      <p className="cl-mono p-4 text-[12px] text-ink-mute">
        No base named “{slug}” (or it declares no views).
      </p>
    );
  }

  return <BaseTableView definition={definition} {...viewProps} />;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command → PASS. Then `bun run test src/routes` (the `routeViews` coverage test must still pass), `bun run typecheck`, `bun run lint` — clean. If `routeTree.gen.ts` changed, do not commit it unless the typecheck needs it (it should not: only `options` changed).

- [ ] **Step 5: Commit**

```bash
bunx biome check --fix "src/routes/bases.\$slug.tsx" src/routes/-bases.slug.test.tsx src/components/bases/BaseTable.tsx src/components/bases/__tests__/BaseTable.test.tsx
git add "src/routes/bases.\$slug.tsx" src/routes/-bases.slug.test.tsx src/components/bases/BaseTable.tsx src/components/bases/__tests__/BaseTable.test.tsx
git commit -m "feat(bases): ?view= deep link with last-view restore and scrub on /bases/\$slug"
```

---

### Task 5: Collapsible groups in `BaseTableView`

**Files:**
- Modify: `ui/src/components/bases/BaseTableView.tsx`
- Test: `ui/src/components/bases/__tests__/BaseTableViewState.test.tsx` (create)

**Interfaces:**
- Consumes: `groupCollapseKey`, `groupIdentity` (Task 3), `useGroupCollapse` (Task 3).

- [ ] **Step 1: Write the failing tests**

`ui/src/components/bases/__tests__/BaseTableViewState.test.tsx`:

```tsx
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params: { slug: string };
    [key: string]: unknown;
  }) => (
    <a {...props} href={to.replace("$slug", params.slug)}>
      {children}
    </a>
  ),
}));

import type { BaseDetailResponse, QueryOutput } from "#/api/bases";
import {
  BaseTableView,
  type BaseTableViewProps,
} from "#/components/bases/BaseTableView";
import { EMPTY_OVERRIDES } from "#/components/bases/view-overrides";

const definition: BaseDetailResponse = {
  slug: "reading",
  revision: "revision-1",
  name: "Reading Log",
  properties: [
    { key: "author", definition: { type: "text" } },
    { key: "rating", definition: { type: "number" } },
    {
      key: "status",
      definition: { type: "select", options: ["queued", "reading"] },
    },
  ],
  views: [
    {
      name: "Shelf",
      layout: "table",
      group_by: "status",
      columns: ["title", "author", "rating"],
      labels: { author: "Writer" },
    },
    { name: "Bare", layout: "table", columns: ["author", "rating"] },
  ],
  diagnostics: [],
};

const readingRow = {
  id: "row-reading",
  path: "always-coming-home.md",
  title: "Always Coming Home",
  kind: "BOOK",
  columns: { author: "Le Guin", rating: 8 },
};
const queuedRow = {
  id: "row-queued",
  path: "the-dispossessed.md",
  title: "The Dispossessed",
  kind: "BOOK",
  columns: { author: "Le Guin", rating: 9 },
};

const grouped: QueryOutput = {
  shape: "grouped",
  groups: [
    { key: "reading", total: 1, aggregates: [], rows: [readingRow] },
    { key: "queued", total: 1, aggregates: [], rows: [queuedRow] },
  ],
};

const GROUPS_KEY = "clepsydra.bases.groups.reading.shelf.status";

function renderView(overrides: Partial<BaseTableViewProps> = {}) {
  const props: BaseTableViewProps = {
    definition,
    activeView: "Shelf",
    onViewChange: vi.fn(),
    output: grouped,
    sort: undefined,
    onSortChange: vi.fn(),
    onOpenPage: vi.fn(),
    onCommitCell: vi.fn(),
    ...overrides,
  };
  return render(<BaseTableView {...props} />);
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("group collapse", () => {
  it("folds one group, keeping its count, and remembers the fold", async () => {
    const user = userEvent.setup();
    const { unmount } = renderView();
    expect(screen.getAllByRole("grid")).toHaveLength(2);
    const trigger = screen.getByRole("button", { name: "reading" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByRole("grid")).toHaveLength(1);
    expect(
      screen.queryByRole("grid", { name: "Reading Log — reading" }),
    ).not.toBeInTheDocument();
    expect(trigger.parentElement).toHaveTextContent("1 row");
    expect(window.localStorage.getItem(GROUPS_KEY)).toBe('["\\"reading\\""]');

    unmount();
    renderView();
    expect(screen.getByRole("button", { name: "reading" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getAllByRole("grid")).toHaveLength(1);
  });

  it("collapses and expands everything from one toolbar toggle", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryAllByRole("grid")).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: "Collapse all" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getAllByRole("grid")).toHaveLength(2);
    expect(window.localStorage.getItem(GROUPS_KEY)).toBe("[]");
  });

  it("offers no toggle for a flat view", () => {
    renderView({
      activeView: "Bare",
      output: { shape: "flat", total: 1, rows: [readingRow], aggregates: [] },
    });
    expect(
      screen.queryByRole("button", { name: /Collapse all|Expand all/ }),
    ).not.toBeInTheDocument();
  });

  it("scopes the fold to the grouping field", () => {
    window.localStorage.setItem(GROUPS_KEY, '["\\"reading\\""]');
    renderView({
      overrides: { ...EMPTY_OVERRIDES, group: { kind: "by", field: "kind" } },
      output: {
        shape: "grouped",
        groups: [{ key: "reading", total: 1, aggregates: [], rows: [readingRow] }],
      },
    });
    expect(screen.getByRole("button", { name: "reading" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("opens a folded group that holds the row about to take focus", async () => {
    window.localStorage.setItem(GROUPS_KEY, '["\\"queued\\""]');
    renderView({ focusCreatedId: "row-queued", onCreatedRowFocused: vi.fn() });
    const queued = screen.getByRole("button", { name: "queued" });
    expect(queued).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("grid", { name: "Reading Log — queued" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(window.localStorage.getItem(GROUPS_KEY)).toBe("[]"),
    );
  });
});
```

`within` is imported for Task 6's tests; if Biome flags it as unused after Task 5, keep it out until Task 6 adds it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/components/bases/__tests__/BaseTableViewState.test.tsx`
Expected: FAIL — no button named `reading`, no toggle.

- [ ] **Step 3: Implement**

In `BaseTableView.tsx`:

1. Imports. Change the lucide import to `import { ChevronDown, ChevronRight, Settings } from "lucide-react";` and add:

```ts
import { groupCollapseKey, groupIdentity } from "./group-collapse";
import { useGroupCollapse } from "./useGroupCollapse";
```

2. Directly after the `effectiveGroup` declaration (`const effectiveGroup = overrides.group ? … : (view?.group_by ?? undefined);`), add:

```ts
  const groupCollapse = useGroupCollapse(
    groupCollapseKey(definition.slug, activeView, effectiveGroup ?? ""),
  );
  const groupPanelIdBase = useId();
```

3. Directly after `const groups: GroupResult[] | null = output?.shape === "grouped" ? output.groups : null;`, add:

```ts
  // A row that is about to take focus must be on screen, so its group is
  // rendered open and the stored fold is dropped.
  const forcedOpenRowIds: Array<string | undefined> = [
    focusCreatedId,
    archiveFocus?.nextRowId,
  ];
  const forcedOpenGroup = groups?.find((group) =>
    group.rows.some((row) => forcedOpenRowIds.includes(String(row.id))),
  );
  const forcedOpenIdentity =
    forcedOpenGroup === undefined
      ? undefined
      : groupIdentity(forcedOpenGroup.key);
  const collapsedGroups = groupCollapse.collapsed;
  const isGroupExpanded = (identity: string) =>
    identity === forcedOpenIdentity || !collapsedGroups.has(identity);
  const groupIdentities = (groups ?? []).map((group) =>
    groupIdentity(group.key),
  );
  const anyGroupExpanded = groupIdentities.some(isGroupExpanded);
  const expandGroup = groupCollapse.expand;
  useEffect(() => {
    if (
      forcedOpenIdentity !== undefined &&
      collapsedGroups.has(forcedOpenIdentity)
    ) {
      expandGroup(forcedOpenIdentity);
    }
  }, [collapsedGroups, expandGroup, forcedOpenIdentity]);
```

4. Toolbar: directly after the closing `</nav>` of the Views nav, add:

```tsx
        {groups && groups.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onPress={() =>
              anyGroupExpanded
                ? groupCollapse.collapseAll(groupIdentities)
                : groupCollapse.expandAll()
            }
          >
            {anyGroupExpanded ? "Collapse all" : "Expand all"}
          </Button>
        ) : null}
```

5. Group sections. Replace the `groups.map((group) => { … })` body with:

```tsx
                {groups.map((group, index) => {
                  const key =
                    group.key == null
                      ? "(empty)"
                      : formatCellValue(group.key as CellValue);
                  const cacheIdentity = `${evaluationIdentity}:group:${JSON.stringify(group.key)}`;
                  const identity = groupIdentity(group.key);
                  const expanded = isGroupExpanded(identity);
                  const panelId = `${groupPanelIdBase}-group-${index}`;
                  return (
                    <section key={cacheIdentity}>
                      <header className="mb-1 flex items-baseline gap-2 border-b border-rule pb-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={expanded}
                          aria-controls={panelId}
                          onPress={() => groupCollapse.toggle(identity)}
                          className="cl-mono h-auto gap-1 px-1 py-0 text-[12px] uppercase tracking-[0.1em] text-ink"
                        >
                          {expanded ? (
                            <ChevronDown aria-hidden="true" className="h-3 w-3" />
                          ) : (
                            <ChevronRight
                              aria-hidden="true"
                              className="h-3 w-3"
                            />
                          )}
                          {key}
                        </Button>
                        <span className="cl-mono text-[10px] text-ink-mute">
                          {group.rows.length < group.total
                            ? `${group.rows.length} of ${group.total} rows`
                            : `${group.total} row${group.total === 1 ? "" : "s"}`}
                        </span>
                        <AggregateChips
                          values={group.aggregates}
                          definition={definition}
                          viewName={activeView}
                          rows={displayAggregateRows}
                        />
                      </header>
                      <div id={panelId}>
                        {expanded
                          ? grid(
                              group.rows,
                              `${definition.name} — ${key}`,
                              cacheIdentity,
                            )
                          : null}
                      </div>
                    </section>
                  );
                })}
```

(The former local `groupIdentity` string is renamed `cacheIdentity`; the imported `groupIdentity` is the function.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test src/components/bases/__tests__/BaseTableViewState.test.tsx src/components/bases/__tests__/BaseTableView.test.tsx src/components/bases/__tests__/BaseTableMenus.test.tsx src/components/bases/__tests__/BaseTable.test.tsx src/editor/elements/BaseEmbedElement.test.tsx`
Expected: PASS. If an existing test now finds two buttons where it expected one (a group trigger named like a cell control), narrow that test's query with `within(...)` on the grid rather than changing the trigger's name. `bun run typecheck`, `bun run lint` — clean.

- [ ] **Step 5: Commit**

```bash
bunx biome check --fix src/components/bases/BaseTableView.tsx src/components/bases/__tests__/BaseTableViewState.test.tsx
git add src/components/bases/BaseTableView.tsx src/components/bases/__tests__/BaseTableViewState.test.tsx
git commit -m "feat(bases): collapsible group sections with a remembered fold and collapse/expand all"
```

---

### Task 6: Fields popover, wiring, docs

**Files:**
- Create: `ui/src/components/bases/FieldsPopover.tsx`
- Modify: `ui/src/components/bases/BaseTableView.tsx`
- Modify: `ui/src/docs/content/bases.mdx`
- Test: `ui/src/components/bases/__tests__/BaseTableViewState.test.tsx` (append)

**Interfaces:**
- Consumes: `BaseTableViewProps.onShowColumn` (Task 1), `displayLabelForColumn`, `columns`, `hiddenColumns`, `onHideColumn`, `onShowHiddenColumns` already in `BaseTableView`.
- Produces: `FieldsPopover({ columns, hidden, labelFor, onHideColumn, onShowColumn, onShowAll })`.

- [ ] **Step 1: Write the failing tests**

Append to `BaseTableViewState.test.tsx` (add `within` to the Testing Library import if Task 5 left it out):

```tsx
describe("Fields popover", () => {
  it("hides and shows columns through the override callbacks", async () => {
    const user = userEvent.setup();
    const onHideColumn = vi.fn();
    const onShowColumn = vi.fn();
    const onShowHiddenColumns = vi.fn();
    renderView({ onHideColumn, onShowColumn, onShowHiddenColumns });

    await user.click(screen.getByRole("button", { name: "Fields" }));
    const dialog = screen.getByRole("dialog", { name: "Fields" });
    const title = within(dialog).getByRole("checkbox", { name: "title" });
    expect(title).toBeChecked();
    expect(title).toBeDisabled();
    expect(dialog).toHaveTextContent("The title column stays visible");
    expect(
      within(dialog).getByRole("button", { name: "Show all" }),
    ).toBeDisabled();

    await user.click(within(dialog).getByRole("checkbox", { name: "Writer" }));
    expect(onHideColumn).toHaveBeenCalledWith("author");
    expect(onShowColumn).not.toHaveBeenCalled();
  });

  it("counts hidden columns, re-shows one, and shows all", async () => {
    const user = userEvent.setup();
    const onHideColumn = vi.fn();
    const onShowColumn = vi.fn();
    const onShowHiddenColumns = vi.fn();
    renderView({
      overrides: { ...EMPTY_OVERRIDES, hiddenColumns: ["author"] },
      onHideColumn,
      onShowColumn,
      onShowHiddenColumns,
    });

    await user.click(screen.getByRole("button", { name: "Fields (1 hidden)" }));
    const dialog = screen.getByRole("dialog", { name: "Fields" });
    const writer = within(dialog).getByRole("checkbox", { name: "Writer" });
    expect(writer).not.toBeChecked();
    await user.click(writer);
    expect(onShowColumn).toHaveBeenCalledWith("author");
    await user.click(within(dialog).getByRole("button", { name: "Show all" }));
    expect(onShowHiddenColumns).toHaveBeenCalledTimes(1);
  });

  it("keeps the last visible column when the view has no title column", async () => {
    const user = userEvent.setup();
    renderView({
      activeView: "Bare",
      output: { shape: "flat", total: 1, rows: [readingRow], aggregates: [] },
      overrides: { ...EMPTY_OVERRIDES, hiddenColumns: ["rating"] },
      onHideColumn: vi.fn(),
      onShowColumn: vi.fn(),
      onShowHiddenColumns: vi.fn(),
    });
    await user.click(screen.getByRole("button", { name: "Fields (1 hidden)" }));
    const dialog = screen.getByRole("dialog", { name: "Fields" });
    expect(within(dialog).getByRole("checkbox", { name: "author" })).toBeDisabled();
    expect(dialog).toHaveTextContent("The last column stays visible");
    expect(within(dialog).getByRole("checkbox", { name: "rating" })).toBeEnabled();
  });

  it("is absent when read-only or when a callback is missing", () => {
    const { unmount } = renderView({
      readOnly: true,
      onHideColumn: vi.fn(),
      onShowColumn: vi.fn(),
    });
    expect(
      screen.queryByRole("button", { name: /^Fields/ }),
    ).not.toBeInTheDocument();
    unmount();
    renderView({ onHideColumn: vi.fn() });
    expect(
      screen.queryByRole("button", { name: /^Fields/ }),
    ).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/components/bases/__tests__/BaseTableViewState.test.tsx`
Expected: FAIL — no button named `Fields`.

- [ ] **Step 3: Implement**

`ui/src/components/bases/FieldsPopover.tsx`:

```tsx
import { Dialog, DialogTrigger } from "react-aria-components";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Popover } from "#/components/ui/popover";

export interface FieldsPopoverProps {
  /** The saved view's columns, in saved order. */
  columns: string[];
  hidden: string[];
  labelFor(column: string): string;
  onHideColumn(column: string): void;
  onShowColumn(column: string): void;
  onShowAll(): void;
}

/** Why a column refuses to hide — the same rule as the header menu. */
function lockReason(column: string): string {
  return column === "title"
    ? "The title column stays visible"
    : "The last column stays visible";
}

/** A checklist of the view's columns; unticking hides one as a view override. */
export function FieldsPopover({
  columns,
  hidden,
  labelFor,
  onHideColumn,
  onShowColumn,
  onShowAll,
}: FieldsPopoverProps) {
  const visibleCount = columns.filter((c) => !hidden.includes(c)).length;
  return (
    <DialogTrigger>
      <Button variant="secondary" size="sm">
        {hidden.length === 0 ? "Fields" : `Fields (${hidden.length} hidden)`}
      </Button>
      <Popover hideArrow placement="bottom start">
        <Dialog
          aria-label="Fields"
          className="cl-mono flex min-w-[200px] flex-col gap-2 border-[1.5px] border-ink bg-paper p-3 text-[11px] text-ink outline-none"
        >
          {columns.map((column) => {
            const visible = !hidden.includes(column);
            const locked =
              column === "title" || (visible && visibleCount === 1);
            return (
              <Checkbox
                key={column}
                isSelected={visible}
                isDisabled={locked}
                description={locked ? lockReason(column) : undefined}
                onChange={(selected) =>
                  selected ? onShowColumn(column) : onHideColumn(column)
                }
              >
                {labelFor(column)}
              </Checkbox>
            );
          })}
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            isDisabled={hidden.length === 0}
            onPress={onShowAll}
          >
            Show all
          </Button>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
```

`BaseTableView.tsx`:

1. Add `import { FieldsPopover } from "./FieldsPopover";`.
2. Destructure `onShowColumn,` directly after `onHideColumn,` in the props destructuring.
3. Directly after the collapse toggle added in Task 5 (still inside the toolbar, before the Configure link), add:

```tsx
        {!readOnly && onHideColumn && onShowColumn ? (
          <FieldsPopover
            columns={columns}
            hidden={hiddenColumns}
            labelFor={displayLabelForColumn}
            onHideColumn={onHideColumn}
            onShowColumn={onShowColumn}
            onShowAll={onShowHiddenColumns ?? noop}
          />
        ) : null}
```

`ui/src/docs/content/bases.mdx`:

1. In the paragraph under `## Web UI, saved tables, and inline editing`, replace the sentence `The UI selects the first view initially and presents the other saved views as tabs.` with:

```
The UI opens the view named by `?view=` in the URL when there is one, otherwise the view you last used in this browser, otherwise the first view, and presents the saved views as tabs. Switching views updates `?view=` in place, so the address can be shared; a `?view=` that names no saved view is dropped from the address.
```

2. Directly before `### Add members inline`, add:

```
### Group collapse and fields

In a grouped table, each group heading is a button: activate it to fold the group, leaving its count and aggregates visible. **Collapse all** and **Expand all** in the toolbar fold or open every group at once. Folds are remembered in this browser per base, view, and grouping field.

**Fields** opens a checklist of the view's columns. Unticking a column hides it as a view override — the same **Hidden** chip, **Clear**, and **Save to view** lifecycle as the header menu's **Hide column** — and ticking it shows it again; **Show all** clears the hidden set. The title column and the last visible column stay.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test src/components/bases/__tests__/BaseTableViewState.test.tsx src/components/bases/__tests__/BaseTableView.test.tsx src/components/bases/__tests__/BaseTableMenus.test.tsx src/components/bases/__tests__/BaseTable.test.tsx src/docs/mdx-smoke.test.tsx`
Expected: PASS except the `mdx-smoke` case "documents warning-only archive deletion hooks and CAS recovery limits", which fails on `develop` already; every other mdx-smoke case must pass. `bun run typecheck`, `bun run lint` — clean.

- [ ] **Step 5: Commit**

```bash
bunx biome check --fix src/components/bases/FieldsPopover.tsx src/components/bases/BaseTableView.tsx src/components/bases/__tests__/BaseTableViewState.test.tsx
git add src/components/bases/FieldsPopover.tsx src/components/bases/BaseTableView.tsx src/components/bases/__tests__/BaseTableViewState.test.tsx src/docs/content/bases.mdx
git commit -m "feat(bases): Fields visibility popover over the hidden-columns override; docs"
```
