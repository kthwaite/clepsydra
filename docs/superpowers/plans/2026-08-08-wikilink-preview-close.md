# Wikilink Preview Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every preview window for an internal link's exact vault path when the user opens that link.

**Architecture:** The Zustand preview store gains an exact-path close action that owns removal, hover identity cleanup, and pinned-window persistence. `CLink` invokes that action immediately before its existing default path-backed navigation, leaving custom and disabled navigation unchanged.

**Tech Stack:** React 19, TypeScript 5.9, Zustand 5, Vitest 4, Testing Library, Biome.

## Global Constraints

- Close matching transient, pinned, and minimized preview windows.
- Preserve preview windows for every non-matching path.
- Treat an absent matching preview as an idempotent no-op.
- Keep custom `onClick`, `noNavigate`, dangling-wikilink creation, hover timing, and Sheaf tab previews unchanged.
- Follow strict red-green TDD: run each focused test before and after its production change.
- Do not modify or revert unrelated worktree changes.

---

### Task 1: Exact-path preview-store closure

**Files:**
- Create: `ui/src/store/preview.test.ts`
- Modify: `ui/src/store/preview.ts:53-64,131-137`

**Interfaces:**
- Consumes: existing `PreviewWindow` state, `savePinned(windows)`, and Zustand `set` callback.
- Produces: `PreviewState.closePath(path: string): void`, available from both `usePreviewStore()` selectors and `usePreviewStore.getState()`.

- [ ] **Step 1: Write the failing store test**

Create `ui/src/store/preview.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { type PreviewWindow, usePreviewStore } from "#/store/preview";

const windows: PreviewWindow[] = [
  {
    id: "hover-target",
    path: "notes/target.md",
    x: 8,
    y: 20,
    pinned: false,
    minimized: false,
    z: 201,
  },
  {
    id: "pinned-target",
    path: "notes/target.md",
    x: 30,
    y: 40,
    pinned: true,
    minimized: true,
    z: 202,
  },
  {
    id: "other",
    path: "notes/other.md",
    x: 50,
    y: 60,
    pinned: true,
    minimized: false,
    z: 203,
  },
];

beforeEach(() => {
  window.localStorage.clear();
  usePreviewStore.setState({ windows: [], topZ: 200, hoverId: null });
});

describe("closePath", () => {
  it("closes every matching preview and preserves unrelated pinned state", () => {
    usePreviewStore.setState({ windows, hoverId: "hover-target" });

    usePreviewStore.getState().closePath("notes/target.md");

    expect(usePreviewStore.getState().windows).toEqual([windows[2]]);
    expect(usePreviewStore.getState().hoverId).toBeNull();
    expect(window.localStorage.getItem("clp.preview.pinned")).toBe(
      JSON.stringify([{ path: "notes/other.md", x: 50, y: 60 }]),
    );
  });

  it("is a no-op when no preview matches", () => {
    usePreviewStore.setState({ windows: [windows[2]], hoverId: null });

    usePreviewStore.getState().closePath("notes/missing.md");

    expect(usePreviewStore.getState().windows).toEqual([windows[2]]);
    expect(usePreviewStore.getState().hoverId).toBeNull();
  });
});
```

A production change that should make this test fail later: removing `closePath` or filtering by anything other than exact `path` equality.

- [ ] **Step 2: Run the focused test and verify RED**

Run from `ui/`:

```bash
bun test src/store/preview.test.ts
```

Expected: FAIL because `PreviewState` and the store do not yet define `closePath`.

- [ ] **Step 3: Add the minimal store action**

In `PreviewState`, add:

```ts
closePath: (path: string) => void;
```

After the existing `close(id)` action, add:

```ts
closePath(path) {
  set((s) => {
    const windows = s.windows.filter((w) => w.path !== path);
    savePinned(windows);
    return {
      windows,
      hoverId:
        s.hoverId && s.windows.some((w) => w.id === s.hoverId && w.path === path)
          ? null
          : s.hoverId,
    };
  });
},
```

This keeps unrelated hover identity intact, removes all matching states, and uses the existing persistence boundary.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
bun test src/store/preview.test.ts
```

Expected: both `closePath` tests PASS with no warnings.

- [ ] **Step 5: Commit the store contract**

```bash
git add ui/src/store/preview.ts ui/src/store/preview.test.ts
git commit -m "feat(ui): close previews by vault path"
```

---

### Task 2: Close the preview during internal-link navigation

**Files:**
- Create: `ui/src/components/codex/CLink.test.tsx`
- Modify: `ui/src/components/codex/CLink.tsx:53-55,83-91`

**Interfaces:**
- Consumes: `PreviewState.closePath(path: string): void` from Task 1 and existing `useOpenTab()`.
- Produces: default path-backed `CLink` click behavior ordered as `closePath(path)` then `openTab("page", path)`.

- [ ] **Step 1: Write the failing interaction test**

Create `ui/src/components/codex/CLink.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLink } from "#/components/codex/CLink";
import type { PreviewWindow } from "#/store/preview";
import { usePreviewStore } from "#/store/preview";

const { openTabMock } = vi.hoisted(() => ({ openTabMock: vi.fn() }));

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));

const matching: PreviewWindow = {
  id: "matching",
  path: "notes/target.md",
  x: 8,
  y: 20,
  pinned: true,
  minimized: true,
  z: 201,
};
const unrelated: PreviewWindow = {
  id: "unrelated",
  path: "notes/other.md",
  x: 30,
  y: 40,
  pinned: true,
  minimized: false,
  z: 202,
};

beforeEach(() => {
  openTabMock.mockReset();
  usePreviewStore.setState({
    windows: [matching, unrelated],
    topZ: 202,
    hoverId: null,
  });
});

describe("CLink navigation", () => {
  it("closes the matching preview before opening its page", async () => {
    const user = userEvent.setup();
    render(<CLink path="notes/target.md">Target</CLink>);

    await user.click(screen.getByRole("link", { name: "Target" }));

    expect(usePreviewStore.getState().windows).toEqual([unrelated]);
    expect(openTabMock).toHaveBeenCalledOnce();
    expect(openTabMock).toHaveBeenCalledWith("page", "notes/target.md");
  });
});
```

A production change that should make this test fail later: removing the `closePath(path)` call from default path-backed navigation.

- [ ] **Step 2: Run the focused test and verify RED**

Run from `ui/`:

```bash
bun test src/components/codex/CLink.test.tsx
```

Expected: FAIL because clicking opens the page but leaves both preview windows in the store.

- [ ] **Step 3: Close by path before navigation**

In `CLink`, select the action alongside `openHover`:

```ts
const closePath = usePreviewStore((s) => s.closePath);
```

Update only the default path-backed navigation branch:

```ts
if (path && !noNavigate) {
  closePath(path);
  openTab("page", path);
}
```

Do not call `closePath` in the custom `onClick` branch or for `noNavigate` links.

- [ ] **Step 4: Run both focused tests and verify GREEN**

Run:

```bash
bun test src/store/preview.test.ts src/components/codex/CLink.test.tsx
```

Expected: all tests PASS with no warnings.

- [ ] **Step 5: Commit the interaction**

```bash
git add ui/src/components/codex/CLink.tsx ui/src/components/codex/CLink.test.tsx
git commit -m "fix(ui): dismiss wikilink preview on open"
```

---

### Task 3: Verification and integration

**Files:**
- Verify only; modify production or test files only if a gate exposes a regression caused by Tasks 1-2.

**Interfaces:**
- Consumes: completed preview-store and `CLink` behavior.
- Produces: evidence that focused behavior, UI static gates, the full UI suite, and the live interaction all work.

- [ ] **Step 1: Run focused regression tests**

From `ui/`:

```bash
bun test src/store/preview.test.ts src/components/codex/CLink.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run UI typecheck**

```bash
bun run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Run UI lint**

```bash
bun run lint
```

Expected: exit 0 with no diagnostics attributable to this change.

- [ ] **Step 4: Run the full UI test suite**

```bash
bun test
```

Expected: exit 0; all UI tests pass.

- [ ] **Step 5: Smoke-test the live behavior**

From the repository root, start the API:

```bash
cargo run -- serve
```

In a second terminal, start Vite:

```bash
bun --cwd ui run dev
```

Open `http://127.0.0.1:5173`. Hover a resolved internal wikilink until its preview opens, pin or minimize it, restore if needed, click the same wikilink, and verify that the destination folio opens and every preview for that exact path disappears while unrelated preview windows remain.

- [ ] **Step 6: Review the implementation against the approved spec**

Confirm exact-path matching, all matching preview states close, unrelated previews remain, and custom/non-navigating links are untouched. Do not reformat or revert unrelated files.

- [ ] **Step 7: Integrate to the repository's current integration branch**

Commit any gate-driven corrections with their affected tests, then merge the completed feature branch/worktree into the project's integration branch without including unrelated worktree changes.
