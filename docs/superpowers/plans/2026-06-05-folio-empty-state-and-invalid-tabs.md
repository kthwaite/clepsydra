# Folio Empty State & Invalid-Tab Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a tab pointing at a missing file from crashing the frontend, and replace the thin "no folios open" message with a useful launcher.

**Architecture:** Two layers of defense for invalid tabs — `usePage` opts out of the global `throwOnError`, so a 404 surfaces as `editor.error` and Folio renders an extracted `FolioNotFound` recovery panel (close-only); a thin `FolioBoundary` class error boundary wraps the folio render as a backstop for any other thrown error. The empty state becomes a `FolioLauncher` driven entirely by existing stores (`openHistory`, ui actions) with no new data fetching.

**Tech Stack:** React 19, TypeScript, zustand, TanStack Query (openapi-react-query `$api`), Tailwind v4 (Vessel tokens), Vitest + React Testing Library.

---

## Background (read before starting)

Root cause of the crash: `ui/src/lib/queryClient.ts` sets `throwOnError: true` globally and there is **no error boundary** in the tree. A tab with a missing path → `usePage` 404 → React Query throws during render → propagates to root → app unmounts. The `editor.error` branch in `Folio.tsx` (~line 140) is therefore dead code today.

Key existing facts the tasks rely on:
- `usePage` lives in `ui/src/api/pages.ts` and calls `$api.useQuery("get", "/api/vault/pages/{path}", { params: { path: { path } } }, { enabled: !!path })`. The 4th argument is a standard TanStack Query options object.
- `useWorkspaceStore` (`ui/src/store/workspace.ts`) exposes `openHistory: OpenHistoryEntry[]` (`{ path: string; openedAt: number }`, newest-first, de-duped, capped 32), `closeTab(tabId)`, `tabs`, `activeTabId`.
- `useUiStore` (`ui/src/store/ui.ts`) exposes `openSearch()` (opens the ⌘K console; sets `isSearchOpen`) and `openInscribe()` (opens new-folio modal; sets `isInscribeOpen`).
- `useOpenTab()` (`ui/src/hooks/useOpenTab.ts`) returns `(type, path?, label?) => void`.
- Helpers: `shortFolio(path)` in `ui/src/components/codex/folio-utils.ts`; `resolveKind({ path })` + `kindColorVar(kind)` in `ui/src/lib/kind.ts`; `formatRelativeTime(iso)` in `ui/src/components/codex/codex-time.ts` (takes an ISO string or null).
- Vessel utility classes already in use across `Folio.tsx`: `cl-mono`, `cl-marg`, `text-ink`, `text-ink-mute`, `text-hot`, `border-rule`, `border-rule-soft`.

All commands run from the `ui/` directory (the frontend uses Bun). Single test runs use `bunx vitest run <path>`.

---

## File Structure

New files:
- `ui/src/components/codex/FolioNotFound.tsx` — presentational recovery panel (`path`, `onClose`). Shared by Folio's error branch and the boundary fallback.
- `ui/src/components/codex/FolioBoundary.tsx` — class error boundary; backstop that renders `FolioNotFound`.
- `ui/src/components/codex/FolioLauncher.tsx` — rich empty state.
- `ui/src/components/codex/__tests__/FolioNotFound.test.tsx`
- `ui/src/components/codex/__tests__/FolioBoundary.test.tsx`
- `ui/src/components/codex/__tests__/FolioLauncher.test.tsx`

Modified files:
- `ui/src/components/codex/folio-utils.ts` — add `folioDisplayName`.
- `ui/src/components/codex/folio-utils.test.ts` — tests for `folioDisplayName`.
- `ui/src/api/pages.ts` — `usePage` opts out of `throwOnError`.
- `ui/src/components/codex/Folio.tsx` — error branch renders `FolioNotFound`.
- `ui/src/components/TabContent.tsx` — render `FolioLauncher` for empty state; wrap Folio in `FolioBoundary`.

Testing boundary note: the full `Folio` component pulls in many hooks/contexts and is not rendered in tests. The recovery behavior is tested through the extracted `FolioNotFound` and `FolioBoundary` units; the `Folio` error-branch wiring and the `usePage` option change are verified by `bun run typecheck` plus manual smoke.

---

## Task 1: `folioDisplayName` helper

**Files:**
- Modify: `ui/src/components/codex/folio-utils.ts`
- Test: `ui/src/components/codex/folio-utils.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/components/codex/folio-utils.test.ts` (add `folioDisplayName` to the existing import from `./folio-utils`):

```ts
describe("folioDisplayName", () => {
  it("derives spaced words from a slug with an 8-char short id", () => {
    expect(folioDisplayName("notes/20260101.my-great-note.ab12CD34.md")).toBe(
      "my great note",
    );
  });

  it("falls back to the basename when there is no short id", () => {
    expect(folioDisplayName("journal/2026-06-05.md")).toBe("2026-06-05");
  });

  it("falls back to the basename for a bare filename", () => {
    expect(folioDisplayName("inbox.md")).toBe("inbox");
  });

  it("falls back when the trailing segment is not an 8-char id", () => {
    expect(folioDisplayName("a.b.c.md")).toBe("a.b.c");
  });
});
```

If `folio-utils.test.ts` has no `describe`/`it`/`expect` import (it uses Vitest globals via config), none is needed.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && bunx vitest run src/components/codex/folio-utils.test.ts`
Expected: FAIL — `folioDisplayName is not a function` / import has no such export.

- [ ] **Step 3: Implement the helper**

Append to `ui/src/components/codex/folio-utils.ts`:

```ts
/**
 * Human-readable label for a vault path. Page filenames follow
 * `<yyyymmdd>.<title-slug>.<shortid>.md` (ADR 0002); when that shape is present
 * the title-slug is turned into spaced words. Other paths fall back to the
 * basename (sans `.md`). Used where no stored title is available — e.g. the
 * launcher's recent-files list, which references closed files.
 */
export function folioDisplayName(path: string): string {
  const base = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
  const parts = base.split(".");
  if (parts.length >= 3) {
    const id = parts[parts.length - 1];
    if (/^[0-9A-Za-z]{8}$/.test(id)) {
      const slug = parts.slice(1, -1).join(".");
      if (slug) return slug.replace(/-/g, " ");
    }
  }
  return base;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && bunx vitest run src/components/codex/folio-utils.test.ts`
Expected: PASS (all `folioDisplayName` cases plus the existing `shortFolio`/`countWords`/etc. tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/folio-utils.ts ui/src/components/codex/folio-utils.test.ts
git commit -m "feat(folio): add folioDisplayName helper"
```

---

## Task 2: `FolioNotFound` recovery panel

**Files:**
- Create: `ui/src/components/codex/FolioNotFound.tsx`
- Test: `ui/src/components/codex/__tests__/FolioNotFound.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `ui/src/components/codex/__tests__/FolioNotFound.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FolioNotFound } from "../FolioNotFound";

describe("FolioNotFound", () => {
  it("shows the missing path and a not-found message", () => {
    render(<FolioNotFound path="notes/gone.md" onClose={() => {}} />);
    expect(screen.getByText("notes/gone.md")).toBeInTheDocument();
    expect(screen.getByText("Folio not found.")).toBeInTheDocument();
  });

  it("invokes onClose when Close tab is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<FolioNotFound path="notes/gone.md" onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: /close tab/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bunx vitest run src/components/codex/__tests__/FolioNotFound.test.tsx`
Expected: FAIL — cannot resolve `../FolioNotFound`.

- [ ] **Step 3: Implement the component**

Create `ui/src/components/codex/FolioNotFound.tsx`:

```tsx
import { shortFolio } from "#/components/codex/folio-utils";

/**
 * Recovery panel shown in the folio area when a tab points to a file that no
 * longer exists. Close-only: the single action removes the offending tab.
 * Rendered both by Folio's `editor.error` branch and by FolioBoundary's
 * fallback.
 */
export function FolioNotFound({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-[440px] border border-rule">
        <div className="flex items-baseline justify-between border-b border-rule px-3 py-1.5">
          <span className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
            FILE / {path ? shortFolio(path) : "—"}
          </span>
          <span className="cl-mono text-[9px] uppercase tracking-[0.16em] text-hot">
            ⁂ NOT FOUND
          </span>
        </div>
        <div className="px-4 py-4">
          <p className="cl-mono mb-2 text-[12px] text-ink">Folio not found.</p>
          <p className="cl-marg mb-3 text-[12px]">
            This tab points to a file that no longer exists.
          </p>
          <p className="cl-mono mb-4 break-all text-[11px] text-ink-mute">
            {path || "(no path)"}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="cl-mono cursor-pointer border border-rule px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-ink-mute hover:border-ink hover:text-ink"
          >
            Close tab
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bunx vitest run src/components/codex/__tests__/FolioNotFound.test.tsx`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/FolioNotFound.tsx ui/src/components/codex/__tests__/FolioNotFound.test.tsx
git commit -m "feat(folio): add FolioNotFound recovery panel"
```

---

## Task 3: Make `usePage` non-throwing and wire Folio's error branch

**Files:**
- Modify: `ui/src/api/pages.ts:14-21`
- Modify: `ui/src/components/codex/Folio.tsx` (imports + error branch ~line 140)

- [ ] **Step 1: Opt `usePage` out of `throwOnError`**

In `ui/src/api/pages.ts`, replace the `usePage` body:

```ts
export function usePage(path: string) {
  return $api.useQuery(
    "get",
    "/api/vault/pages/{path}",
    { params: { path: { path } } },
    // Opt out of the global throwOnError so a missing-file 404 surfaces as
    // query `error` state and the folio can render a recovery panel instead of
    // unmounting the whole app.
    { enabled: !!path, throwOnError: false },
  );
}
```

- [ ] **Step 2: Render `FolioNotFound` from Folio's error branch**

In `ui/src/components/codex/Folio.tsx`:

Add to the import block near the other `#/components/codex` imports:

```tsx
import { FolioNotFound } from "#/components/codex/FolioNotFound";
```

Add a `closeTab` selector alongside the other `useWorkspaceStore` selectors (near `updateTabLabel`/`updateTabPath`, ~line 41-42):

```tsx
  const closeTab = useWorkspaceStore((s) => s.closeTab);
```

Replace the existing error branch (currently):

```tsx
  if (editor.error) {
    return <div className="cl-marg p-6">⁂ folio not found · {path}</div>;
  }
```

with:

```tsx
  if (editor.error) {
    return <FolioNotFound path={path} onClose={() => closeTab(tabId)} />;
  }
```

Leave the `editor.isLoading` branch above it unchanged.

- [ ] **Step 3: Typecheck**

Run: `cd ui && bun run typecheck`
Expected: PASS (no type errors). Confirms the `throwOnError` option and the new import/selector are well-typed.

- [ ] **Step 4: Run the existing page-editor tests (regression guard)**

Run: `cd ui && bunx vitest run src/editor/__tests__/usePageEditor.test.tsx`
Expected: PASS — these mock `#/api/pages`, so behavior is unaffected; this confirms no import cycle or breakage.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/pages.ts ui/src/components/codex/Folio.tsx
git commit -m "fix(folio): render recovery panel for missing files instead of crashing"
```

---

## Task 4: `FolioBoundary` backstop + wire into TabContent

**Files:**
- Create: `ui/src/components/codex/FolioBoundary.tsx`
- Test: `ui/src/components/codex/__tests__/FolioBoundary.test.tsx`
- Modify: `ui/src/components/TabContent.tsx`

- [ ] **Step 1: Write the failing test**

Create `ui/src/components/codex/__tests__/FolioBoundary.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "#/store/workspace";
import { FolioBoundary } from "../FolioBoundary";

function Boom(): never {
  throw new Error("boom");
}

describe("FolioBoundary", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      tabs: [{ id: "t1", type: "page", path: "notes/gone.md", label: "gone" }],
      activeTabId: "t1",
    });
  });

  it("renders the recovery panel when a child throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <FolioBoundary path="notes/gone.md">
        <Boom />
      </FolioBoundary>,
    );
    expect(screen.getByText("Folio not found.")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("closes the active tab from the recovery panel", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    render(
      <FolioBoundary path="notes/gone.md">
        <Boom />
      </FolioBoundary>,
    );
    await user.click(screen.getByRole("button", { name: /close tab/i }));
    expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
    spy.mockRestore();
  });
});
```

(The `console.error` spy silences React's expected error-boundary logging.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bunx vitest run src/components/codex/__tests__/FolioBoundary.test.tsx`
Expected: FAIL — cannot resolve `../FolioBoundary`.

- [ ] **Step 3: Implement the boundary**

Create `ui/src/components/codex/FolioBoundary.tsx`:

```tsx
import { Component, type ReactNode } from "react";
import { FolioNotFound } from "#/components/codex/FolioNotFound";
import { useWorkspaceStore } from "#/store/workspace";

interface Props {
  /** Active tab path; key this boundary on it so a new tab resets the error. */
  path: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Backstop error boundary around the folio render. Any error thrown while
 * rendering a folio (e.g. an unexpected query throw) is caught here and shown
 * as the recovery panel, so a single bad tab can never unmount the whole app.
 * Keyed on the active path in TabContent, so switching/fixing tabs resets it.
 */
export class FolioBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      const onClose = () => {
        const { activeTabId, closeTab } = useWorkspaceStore.getState();
        if (activeTabId) closeTab(activeTabId);
      };
      return <FolioNotFound path={this.props.path} onClose={onClose} />;
    }
    return this.props.children;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bunx vitest run src/components/codex/__tests__/FolioBoundary.test.tsx`
Expected: PASS (both cases; closing the active tab leaves `tabs` empty).

- [ ] **Step 5: Wrap the Folio render in TabContent**

In `ui/src/components/TabContent.tsx`, add the import:

```tsx
import { FolioBoundary } from "#/components/codex/FolioBoundary";
```

Replace the page branch (currently):

```tsx
  if (activeTab.type === "page" && activeTab.path) {
    return (
      <Folio key={activeTab.path} tabId={activeTab.id} path={activeTab.path} />
    );
  }
```

with (the `key` moves to the boundary so both remount together on path change):

```tsx
  if (activeTab.type === "page" && activeTab.path) {
    return (
      <FolioBoundary key={activeTab.path} path={activeTab.path}>
        <Folio tabId={activeTab.id} path={activeTab.path} />
      </FolioBoundary>
    );
  }
```

- [ ] **Step 6: Typecheck**

Run: `cd ui && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/codex/FolioBoundary.tsx ui/src/components/codex/__tests__/FolioBoundary.test.tsx ui/src/components/TabContent.tsx
git commit -m "feat(folio): add FolioBoundary backstop around folio render"
```

---

## Task 5: `FolioLauncher` empty state

**Files:**
- Create: `ui/src/components/codex/FolioLauncher.tsx`
- Test: `ui/src/components/codex/__tests__/FolioLauncher.test.tsx`
- Modify: `ui/src/components/TabContent.tsx`

- [ ] **Step 1: Write the failing test**

Create `ui/src/components/codex/__tests__/FolioLauncher.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted so the mock factory can reference openTabMock without tripping
// Vitest's hoist-above-imports rule (matches the usePageEditor test pattern).
const { openTabMock } = vi.hoisted(() => ({ openTabMock: vi.fn() }));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));

import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";
import { FolioLauncher } from "../FolioLauncher";

describe("FolioLauncher", () => {
  beforeEach(() => {
    openTabMock.mockClear();
    useWorkspaceStore.setState({ openHistory: [] });
    useUiStore.setState({ isSearchOpen: false, isInscribeOpen: false });
  });

  it("shows the empty note when there is no history", () => {
    render(<FolioLauncher />);
    expect(screen.getByText("No recent folios.")).toBeInTheDocument();
  });

  it("opens the console via the quick action", async () => {
    const user = userEvent.setup();
    render(<FolioLauncher />);
    await user.click(screen.getByRole("button", { name: /open console/i }));
    expect(useUiStore.getState().isSearchOpen).toBe(true);
  });

  it("opens the inscribe modal via the quick action", async () => {
    const user = userEvent.setup();
    render(<FolioLauncher />);
    await user.click(screen.getByRole("button", { name: /inscribe new folio/i }));
    expect(useUiStore.getState().isInscribeOpen).toBe(true);
  });

  it("opens the graph via the quick action", async () => {
    const user = userEvent.setup();
    render(<FolioLauncher />);
    await user.click(screen.getByRole("button", { name: /open constellation/i }));
    expect(openTabMock).toHaveBeenCalledWith("graph");
  });

  it("opens a recent folio when its row is clicked", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      openHistory: [
        { path: "notes/20260101.my-note.ab12CD34.md", openedAt: 1 },
      ],
    });
    render(<FolioLauncher />);
    await user.click(screen.getByText("my note"));
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      "notes/20260101.my-note.ab12CD34.md",
      "my note",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bunx vitest run src/components/codex/__tests__/FolioLauncher.test.tsx`
Expected: FAIL — cannot resolve `../FolioLauncher`.

- [ ] **Step 3: Implement the launcher**

Create `ui/src/components/codex/FolioLauncher.tsx`:

```tsx
import { formatRelativeTime } from "#/components/codex/codex-time";
import {
  folioDisplayName,
  shortFolio,
} from "#/components/codex/folio-utils";
import { useOpenTab } from "#/hooks/useOpenTab";
import { kindColorVar, resolveKind } from "#/lib/kind";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";

const RECENT_LIMIT = 8;

/**
 * Rich empty state for the workspace when no tab is open: quick actions plus a
 * recent-files list derived entirely from existing stores (no data fetching).
 * Recent labels come from the filename slug via folioDisplayName, since
 * openHistory stores only paths.
 */
export function FolioLauncher() {
  const openTab = useOpenTab();
  const openSearch = useUiStore((s) => s.openSearch);
  const openInscribe = useUiStore((s) => s.openInscribe);
  const history = useWorkspaceStore((s) => s.openHistory);
  const recent = history.slice(0, RECENT_LIMIT);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-[520px]">
        <div className="flex items-baseline justify-between border-b border-rule pb-1.5">
          <span className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
            WORKSPACE / EMPTY
          </span>
          <span className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute">
            NO FOLIO OPEN
          </span>
        </div>

        <div className="mt-4">
          <div className="cl-mono mb-1.5 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
            Actions
          </div>
          <div className="flex flex-col">
            <LauncherAction label="Open console" hint="⌘K" onClick={openSearch} />
            <LauncherAction
              label="Inscribe new folio"
              hint="⌘N"
              onClick={openInscribe}
            />
            <LauncherAction
              label="Open Constellation"
              hint="⌘G"
              onClick={() => openTab("graph")}
            />
          </div>
        </div>

        <div className="mt-5">
          <div className="cl-mono mb-1.5 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
            Recent · {recent.length}
          </div>
          {recent.length === 0 ? (
            <p className="cl-marg m-0">No recent folios.</p>
          ) : (
            <div className="flex flex-col">
              {recent.map((entry) => {
                const name = folioDisplayName(entry.path);
                return (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => openTab("page", entry.path, name)}
                    className="group flex items-center gap-2 border-b border-rule-soft py-1.5 text-left"
                  >
                    <span
                      className="inline-block h-[6px] w-[6px] flex-shrink-0"
                      style={{
                        background: kindColorVar(resolveKind({ path: entry.path })),
                      }}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-ink-mute group-hover:text-ink">
                      {name}
                    </span>
                    <span className="cl-mono flex-shrink-0 text-[9px] text-ink-mute">
                      {shortFolio(entry.path)}
                    </span>
                    <span className="cl-mono flex-shrink-0 text-[9px] text-ink-mute">
                      {formatRelativeTime(new Date(entry.openedAt).toISOString())}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LauncherAction({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center justify-between border-b border-rule-soft py-1.5 text-left"
    >
      <span className="text-[12px] text-ink-mute group-hover:text-ink">
        {label}
      </span>
      <span className="cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute">
        {hint}
      </span>
    </button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bunx vitest run src/components/codex/__tests__/FolioLauncher.test.tsx`
Expected: PASS (all five cases).

- [ ] **Step 5: Render the launcher in TabContent's empty state**

In `ui/src/components/TabContent.tsx`, add the import:

```tsx
import { FolioLauncher } from "#/components/codex/FolioLauncher";
```

Replace the empty-state block (currently):

```tsx
  if (!activeTab) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="cl-marg">
          No folios open. Use{" "}
          <kbd className="cl-mono border border-[var(--rule-soft)] px-1 py-[1px] text-[10px]">
            ⌘K
          </kbd>{" "}
          to invoke the console.
        </p>
      </div>
    );
  }
```

with:

```tsx
  if (!activeTab) {
    return <FolioLauncher />;
  }
```

- [ ] **Step 6: Typecheck**

Run: `cd ui && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/codex/FolioLauncher.tsx ui/src/components/codex/__tests__/FolioLauncher.test.tsx ui/src/components/TabContent.tsx
git commit -m "feat(folio): rich empty-state launcher with recent files"
```

---

## Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full frontend test suite**

Run: `cd ui && bun run test`
Expected: PASS — all suites green, including the four new/extended ones.

- [ ] **Step 2: Typecheck the whole UI**

Run: `cd ui && bun run typecheck`
Expected: PASS — no type errors.

- [ ] **Step 3: Lint/format check**

Run: `cd ui && bun run lint`
Expected: PASS — no Biome violations. If formatting differs, run `cd ui && bun run format`, then re-run lint, then `git add -A && git commit -m "style(folio): apply biome formatting"`.

- [ ] **Step 4: Manual smoke (records the real-app behavior the units don't cover)**

Run the dev server (`cd ui && bun run dev`) and verify:
1. With all tabs closed, the workspace shows the launcher (actions + recent or "No recent folios."); ⌘K action opens the console, the recent row reopens a file.
2. Open a file, then delete/rename it on disk (or edit `localStorage` `clepsydra.workspace` to point a tab at a bogus path) and reload: the folio area shows the "Folio not found." panel, the rest of the chrome and other tabs remain alive, and **Close tab** removes the dangling tab — no full-app crash.

Record the outcome (pass/fail with notes) when reporting completion.

- [ ] **Step 5: Final commit (only if formatting changed in Step 3; otherwise skip)**

Already covered in Step 3.
```
