# Sheaf Tab Hover Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hovering an inactive Sheaf tab shows a lightweight, non-pinnable preview card of that page.

**Architecture:** A passive (`pointer-events: none`) preview card is portaled to `document.body` (escaping the Sheaf's `overflow-x-auto` clip) and positioned under the hovered tab. The card body is a new shared `PreviewBody` component extracted from the existing `PreviewWindow`, rendered here with `showTags={false}`. Hover state lives locally in `Sheaf` — no Zustand store, since the card is ephemeral and non-pinnable. Page data is lazily fetched on hover via the existing `usePage`/`useBacklinks` hooks (TanStack-cached).

**Tech Stack:** React 19, TanStack Query, Zustand (existing preview store — *not* extended here), Tailwind v4, Vitest, Storybook 10. Bun for all `ui/` commands.

---

## File Structure

- **`ui/src/components/codex/PreviewBody.tsx`** (new) — Presentational body extracted from `PreviewWindow`. Renders kind label, word/backlink counts, title, excerpt, and (optionally) tags. Consumed by both `PreviewWindow` and `TabPreviewCard`.
- **`ui/src/components/codex/tab-preview.ts`** (new) — Pure logic: `clampPreviewLeft` (right-edge clamp) and `shouldPreviewTab` (path-present && not-active predicate). No React — unit-tested.
- **`ui/src/components/codex/tab-preview.test.ts`** (new) — Unit tests for the two pure functions.
- **`ui/src/components/codex/TabPreviewCard.tsx`** (new) — Portaled card: fetches `usePage`/`useBacklinks` for a path, positions at a rect, renders `<PreviewBody showTags={false} />`.
- **`ui/src/components/codex/LinkPreviewLayer.tsx`** (modify) — Replace the inline body markup in `PreviewWindow` (lines ~126–150) with `<PreviewBody … />`.
- **`ui/src/components/codex/Sheaf.tsx`** (modify) — Add local hover state, wire enter/leave with delay + instant-scrub, drop native `title` on path-bearing tabs, add `aria-label`, render the portaled `TabPreviewCard`.
- **`ui/src/components/codex/PreviewBody.stories.tsx`** (new) — Storybook story for the shared body.
- **`ui/src/components/codex/Sheaf.stories.tsx`** (new) — Storybook story for the Sheaf strip.

---

## Reference: existing helpers (do not reimplement)

These already exist and are imported by the new code:

- `usePage(path: string)` from `#/api/pages` → `{ data?: { meta: { title?, tags? }, body } }`. Internally `enabled: !!path`.
- `useBacklinks(path: string)` from `#/api/index` → `{ data?: unknown[] }`. Internally `enabled: !!path`.
- `resolveKind({ path, body })` from `#/lib/kind` → `Kind`.
- `kindColorVar(kind)`, `kindLabel(kind)` from `#/lib/kind`.
- `firstParagraph(body)`, `countWords(body)`, `shortFolio(path)` from `#/components/codex/folio-utils`.
- `PREVIEW_WIDTH` (= 340) from `#/store/preview`.
- `cn` from `#/lib/cn`.

---

## Task 1: Pure logic — clamp + predicate

**Files:**
- Create: `ui/src/components/codex/tab-preview.ts`
- Test: `ui/src/components/codex/tab-preview.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/components/codex/tab-preview.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { clampPreviewLeft, shouldPreviewTab } from "./tab-preview";

describe("clampPreviewLeft", () => {
  const W = 340;

  it("returns the rect left when fully on-screen", () => {
    expect(clampPreviewLeft(100, 1200, W)).toBe(100);
  });

  it("clamps to the right edge when the card would overflow", () => {
    // 1200 - 340 - 8 = 852
    expect(clampPreviewLeft(1100, 1200, W)).toBe(852);
  });

  it("clamps to the left margin when rect.left is negative", () => {
    expect(clampPreviewLeft(-50, 1200, W)).toBe(8);
  });
});

describe("shouldPreviewTab", () => {
  it("previews an inactive tab with a path", () => {
    expect(shouldPreviewTab("docs/a.md", "tab-1", "tab-2")).toBe(true);
  });

  it("suppresses the active tab", () => {
    expect(shouldPreviewTab("docs/a.md", "tab-1", "tab-1")).toBe(false);
  });

  it("suppresses a tab with no path", () => {
    expect(shouldPreviewTab(undefined, "tab-1", "tab-2")).toBe(false);
    expect(shouldPreviewTab("", "tab-1", "tab-2")).toBe(false);
  });

  it("suppresses a null active id without crashing", () => {
    expect(shouldPreviewTab("docs/a.md", "tab-1", null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test tab-preview`
Expected: FAIL — `Cannot find module './tab-preview'` / functions not defined.

- [ ] **Step 3: Write minimal implementation**

Create `ui/src/components/codex/tab-preview.ts`:

```ts
// Pure positioning + gating logic for the Sheaf tab hover preview. No React,
// no I/O — testable in isolation.

const MARGIN = 8;

/**
 * Horizontal position for a preview card of width `width`, anchored at a tab's
 * left edge but clamped so it never overflows the viewport. Mirrors the clamp
 * used by the floating link-preview window (store/preview.ts).
 */
export function clampPreviewLeft(
  rectLeft: number,
  viewportWidth: number,
  width: number,
): number {
  return Math.min(Math.max(MARGIN, rectLeft), viewportWidth - width - MARGIN);
}

/**
 * Whether hovering a tab should open a preview: it needs a real path and must
 * not be the currently-active tab (whose page is already in the main pane).
 */
export function shouldPreviewTab(
  path: string | undefined,
  tabId: string,
  activeTabId: string | null,
): boolean {
  return !!path && tabId !== activeTabId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun run test tab-preview`
Expected: PASS — all 7 assertions green.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/tab-preview.ts ui/src/components/codex/tab-preview.test.ts
git commit -m "feat(sheaf): pure clamp + preview-gating logic for tab hover"
```

---

## Task 2: Extract shared `PreviewBody`

Pull the body markup out of `PreviewWindow` into a reusable presentational component, then have `PreviewWindow` consume it. This is a pure refactor of existing markup plus a `showTags` flag — no behavior change for the link preview.

**Files:**
- Create: `ui/src/components/codex/PreviewBody.tsx`
- Modify: `ui/src/components/codex/LinkPreviewLayer.tsx`

- [ ] **Step 1: Create `PreviewBody.tsx`**

Create `ui/src/components/codex/PreviewBody.tsx`. The props take already-fetched page data (the parent owns the query), so this component does no I/O:

```tsx
import {
  countWords,
  firstParagraph,
} from "#/components/codex/folio-utils";
import { kindColorVar, kindLabel, resolveKind } from "#/lib/kind";

export type PreviewBodyProps = {
  path: string;
  /** Page payload as returned by `usePage`; undefined while loading. */
  page?: { meta: { title?: string | null; tags?: string[] | null }; body: string };
  /** Backlink rows as returned by `useBacklinks`; undefined while loading. */
  backlinks?: unknown[];
  /** Render the tag row. The floating link window shows tags; the tab card hides them. */
  showTags?: boolean;
};

/**
 * Shared preview body for both the floating link-preview window and the Sheaf
 * tab hover card. Renders chrome immediately (kind label + path-derived title)
 * and fills excerpt / counts in as `page` data arrives.
 */
export function PreviewBody({ path, page, backlinks, showTags = true }: PreviewBodyProps) {
  const title = page?.meta.title || path;
  const kind = resolveKind({ path, body: page?.body });
  const excerpt = page ? firstParagraph(page.body) : "";
  const words = page ? countWords(page.body) : 0;
  const tags = page?.meta.tags ?? [];

  return (
    <div className="px-[10px] py-2">
      <div className="mb-1 flex items-baseline justify-between border-b border-rule-soft pb-[3px]">
        <span className="cl-mono flex items-center gap-1.5 text-[9px] uppercase tracking-[0.12em] text-ink-mute">
          <span
            className="inline-block h-[6px] w-[6px] flex-shrink-0"
            style={{ background: kindColorVar(kind) }}
            aria-hidden
          />
          {kindLabel(kind)}
        </span>
        <span className="cl-mono text-[9px] text-ink-mute">
          {words} wd · ↘{backlinks?.length ?? 0}
        </span>
      </div>
      <div className="mb-[3px] font-sans text-[14px] font-bold leading-[1.2]">
        {title}
      </div>
      {excerpt && (
        <p className="m-0 font-sans text-[11.5px] leading-[1.45] text-ink-mute">
          {excerpt.slice(0, 200)}
          {excerpt.length > 200 ? "…" : ""}
        </p>
      )}
      {showTags && tags.length > 0 && (
        <div className="cl-mono mt-[5px] border-t border-dotted border-rule-soft pt-1 text-[9px] text-accent">
          {tags.map((t) => `#${t}`).join(" ")}
        </div>
      )}
    </div>
  );
}
```

> Note: the kind-color dot moved from the `PreviewWindow` titlebar concept into the body's header row so both consumers show it consistently. The window keeps its own titlebar dot too (see Step 2) — they are different rows and both are intended.

- [ ] **Step 2: Replace the inline body in `PreviewWindow`**

In `ui/src/components/codex/LinkPreviewLayer.tsx`:

1. Add the import near the top (after the existing `folio-utils` import):

```tsx
import { PreviewBody } from "#/components/codex/PreviewBody";
```

2. In `PreviewWindow`, the locals `title`, `kind`, `excerpt`, `words`, `tags` are now only needed for the titlebar. The titlebar uses `kind` (dot) and `title` (passed to `openTab`). Keep those two; delete the now-unused `excerpt`, `words`, `tags` locals. The lines to change currently read:

```tsx
  const title = page?.meta.title || win.path;
  const kind = resolveKind({ path: win.path, body: page?.body });
  const excerpt = page ? firstParagraph(page.body) : "";
  const words = page ? countWords(page.body) : 0;
  const tags = page?.meta.tags ?? [];
```

Replace with:

```tsx
  const title = page?.meta.title || win.path;
  const kind = resolveKind({ path: win.path, body: page?.body });
```

3. Replace the entire `{/* body */}` block (the `<div className="px-[10px] py-2">…</div>` spanning roughly lines 126–150) with:

```tsx
      {/* body */}
      <PreviewBody path={win.path} page={page} backlinks={backlinks} showTags />
```

4. Remove now-unused imports from `LinkPreviewLayer.tsx`: `countWords`, `firstParagraph` (from `folio-utils` — keep `shortFolio`, still used by the titlebar/tray), and `kindLabel` (from `#/lib/kind` — keep `kindColorVar` and `resolveKind`, both still used by the titlebar).

- [ ] **Step 3: Typecheck + lint**

Run: `cd ui && bun run typecheck`
Expected: PASS — no unused-locals errors (biome/tsc `noUnusedLocals` will flag any leftover import; fix per the message).

Run: `cd ui && bun run lint`
Expected: PASS.

- [ ] **Step 4: Verify the link preview still renders**

Run: `cd ui && bun run test LinkPreview` (if no such test exists, this is a no-op — proceed). Then sanity-check by running the full suite:

Run: `cd ui && bun run test`
Expected: PASS — no regressions.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/PreviewBody.tsx ui/src/components/codex/LinkPreviewLayer.tsx
git commit -m "refactor(codex): extract shared PreviewBody from PreviewWindow"
```

---

## Task 3: `TabPreviewCard` (portaled, lazy-fetching)

**Files:**
- Create: `ui/src/components/codex/TabPreviewCard.tsx`

- [ ] **Step 1: Write the component**

Create `ui/src/components/codex/TabPreviewCard.tsx`. It is mounted only while a tab is hovered (Task 4 gates this), so the hooks fire on hover and never before:

```tsx
import { createPortal } from "react-dom";
import { useBacklinks } from "#/api/index";
import { usePage } from "#/api/pages";
import { PreviewBody } from "#/components/codex/PreviewBody";
import { clampPreviewLeft } from "#/components/codex/tab-preview";
import { PREVIEW_WIDTH } from "#/store/preview";

type TabPreviewCardProps = {
  /** Vault path of the hovered tab. Caller guarantees this is non-empty. */
  path: string;
  /** Bounding rect of the hovered tab, in viewport coordinates. */
  rect: DOMRect;
};

/**
 * Passive (pointer-events: none) preview card for a Sheaf tab. Portaled to
 * <body> so it escapes the Sheaf's overflow-x-auto clip. Lazily fetches page +
 * backlinks; renders chrome immediately and fills in as data lands.
 */
export function TabPreviewCard({ path, rect }: TabPreviewCardProps) {
  const { data: page } = usePage(path);
  const { data: backlinks } = useBacklinks(path);

  if (typeof document === "undefined") return null;

  const left = clampPreviewLeft(rect.left, window.innerWidth, PREVIEW_WIDTH);
  const top = rect.bottom + 6;

  return createPortal(
    <div
      style={{ left, top, width: PREVIEW_WIDTH, zIndex: 900 }}
      className="pointer-events-none fixed border-[1.5px] border-ink bg-paper text-ink shadow-[0_14px_40px_rgba(0,0,0,0.7),0_0_0_1px_var(--color-bg)] font-body"
    >
      <PreviewBody path={path} page={page} backlinks={backlinks} showTags={false} />
    </div>,
    document.body,
  );
}
```

> `zIndex: 900` sits below the floating link windows (z ≥ 200 but dynamically raised) and the minimized tray (z 950) by design — the passive tab card should never cover an interactive pinned window or the tray.

- [ ] **Step 2: Typecheck**

Run: `cd ui && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/codex/TabPreviewCard.tsx
git commit -m "feat(codex): TabPreviewCard portaled hover preview"
```

---

## Task 4: Wire hover into `Sheaf`

Add local hover state with a cold-open delay and instant-scrub, render the card, drop the native `title` on path-bearing tabs, and add an `aria-label`.

**Files:**
- Modify: `ui/src/components/codex/Sheaf.tsx`

- [ ] **Step 1: Add imports and hover state**

In `ui/src/components/codex/Sheaf.tsx`:

1. Update the React import (currently the file imports only types). Add `useRef` and `useState`:

```tsx
import { useRef, useState } from "react";
```

2. Add the new component imports near the other `#/` imports:

```tsx
import { TabPreviewCard } from "#/components/codex/TabPreviewCard";
import { shouldPreviewTab } from "#/components/codex/tab-preview";
```

3. Inside `Sheaf`, after the existing store selectors, add hover state and timing constant:

```tsx
  const [hovered, setHovered] = useState<{ id: string; rect: DOMRect } | null>(
    null,
  );
  const openTimer = useRef<number | null>(null);
  // Cold-open delay; once a card is showing, scrubbing to another tab is instant.
  const HOVER_DELAY = 220;
```

4. Add enter/leave handlers (place them inside `Sheaf`, before `return`):

```tsx
  const clearOpenTimer = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };

  const onTabEnter = (id: string, path: string | undefined, el: HTMLElement) => {
    if (!shouldPreviewTab(path, id, activeTabId)) return;
    clearOpenTimer();
    const show = () =>
      setHovered({ id, rect: el.getBoundingClientRect() });
    // Instant-scrub: if a card is already open, switch with no re-delay.
    if (hovered) {
      show();
    } else {
      openTimer.current = window.setTimeout(show, HOVER_DELAY);
    }
  };

  const onTabLeave = () => {
    clearOpenTimer();
    setHovered(null);
  };
```

- [ ] **Step 2: Wire handlers + a11y onto the tab button**

In the `pageTabs.map(...)` button, modify the `<button>`:

1. Replace the `title={t.path ?? t.label}` attribute. Path-bearing tabs drop the native title (the card supersedes it); null-path tabs keep a title:

```tsx
            title={t.path ? undefined : t.label}
            aria-label={t.label || t.path || "untitled folio"}
```

2. Add hover handlers to the button. The `onClick` already exists — add alongside it:

```tsx
            onMouseEnter={(e) => onTabEnter(t.id, t.path, e.currentTarget)}
            onMouseLeave={onTabLeave}
```

> The active tab is gated out inside `onTabEnter` via `shouldPreviewTab`, so no per-button conditional is needed. Clicking a tab calls `onActivate`; the now-active tab won't re-open a preview because `shouldPreviewTab` returns false for it on the next enter. To avoid a stale card lingering over the newly-activated tab, also clear hover on activate (next step).

- [ ] **Step 3: Clear the card on activation**

Update `onActivate` so activating a tab dismisses any open preview:

```tsx
  const onActivate = (id: string) => {
    clearOpenTimer();
    setHovered(null);
    activateTab(id);
    navigate({ to: "/workspace" });
  };
```

- [ ] **Step 4: Render the card**

At the end of the component's returned JSX, just before the closing `</div>` of the root Sheaf container, render the card when a tab is hovered:

```tsx
      {hovered && (
        <TabPreviewCard
          path={
            pageTabs.find((t) => t.id === hovered.id)?.path ?? ""
          }
          rect={hovered.rect}
        />
      )}
```

> `TabPreviewCard` portals to `<body>`, so its DOM position inside the Sheaf is irrelevant; placing it here keeps it lifecycle-bound to the hover state. The `?? ""` is defensive — `hovered` is only ever set for a path-bearing tab, but if the tab closed mid-hover the lookup falls back to empty and `usePage`/`useBacklinks` no-op (`enabled: !!path`).

- [ ] **Step 5: Typecheck + lint**

Run: `cd ui && bun run typecheck`
Expected: PASS.

Run: `cd ui && bun run lint`
Expected: PASS.

- [ ] **Step 6: Run the full test suite**

Run: `cd ui && bun run test`
Expected: PASS — including `tab-preview` from Task 1.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/codex/Sheaf.tsx
git commit -m "feat(sheaf): tab hover preview with cold-open delay + instant-scrub"
```

---

## Task 5: Storybook stories

**Files:**
- Create: `ui/src/components/codex/PreviewBody.stories.tsx`
- Create: `ui/src/components/codex/Sheaf.stories.tsx`

- [ ] **Step 1: `PreviewBody` story**

Create `ui/src/components/codex/PreviewBody.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react";
import { PreviewBody } from "#/components/codex/PreviewBody";

const meta: Meta<typeof PreviewBody> = {
  title: "Codex/PreviewBody",
  component: PreviewBody,
};

export default meta;
type Story = StoryObj<typeof meta>;

const page = {
  meta: { title: "On Water Clocks", tags: ["history", "horology"] },
  body: "The clepsydra measured time by regulated flow. Its earliest forms date to antiquity, long before mechanical escapements.\n\nSecond paragraph that should not appear.",
};

export const WithTags: Story = {
  render: () => (
    <div className="w-[340px] border-[1.5px] border-ink bg-paper">
      <PreviewBody path="notes/water-clocks.md" page={page} backlinks={[1, 2, 3]} showTags />
    </div>
  ),
};

export const NoTags: Story = {
  render: () => (
    <div className="w-[340px] border-[1.5px] border-ink bg-paper">
      <PreviewBody path="notes/water-clocks.md" page={page} backlinks={[1, 2, 3]} showTags={false} />
    </div>
  ),
};

export const Loading: Story = {
  render: () => (
    <div className="w-[340px] border-[1.5px] border-ink bg-paper">
      <PreviewBody path="notes/water-clocks.md" showTags={false} />
    </div>
  ),
};
```

- [ ] **Step 2: `Sheaf` story**

Create `ui/src/components/codex/Sheaf.stories.tsx`. The Sheaf reads from the workspace Zustand store and TanStack Query; the story seeds the store and wraps in the providers. Check an existing codex story that uses the workspace store or a QueryClient wrapper for the exact provider import path before finalizing; the shape below is the target:

```tsx
import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Sheaf } from "#/components/codex/Sheaf";
import { useWorkspaceStore } from "#/store/workspace";

const qc = new QueryClient();

function Seeded() {
  // Seed a couple of page tabs so the strip renders.
  useWorkspaceStore.setState({
    tabs: [
      { id: "tab-1", type: "page", path: "notes/water-clocks.md", label: "On Water Clocks" },
      { id: "tab-2", type: "page", path: "projects/clepsydra.md", label: "Clepsydra", pinned: true },
    ],
  });
  return <Sheaf activeTabId="tab-1" />;
}

const meta: Meta<typeof Sheaf> = {
  title: "Codex/Sheaf",
  component: Sheaf,
  decorators: [
    (Story) => (
      <QueryClientProvider client={qc}>
        <Story />
      </QueryClientProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <Seeded />,
};
```

> If the project already has a shared Storybook decorator that provides the QueryClient (check `ui/.storybook/preview.*`), prefer it over the inline `QueryClientProvider` and drop the decorator here.

- [ ] **Step 3: Build Storybook to verify stories compile**

Run: `cd ui && bun run build-storybook`
Expected: PASS — stories compile without type errors. (Alternatively `bun run storybook` and eyeball `Codex/PreviewBody` + `Codex/Sheaf`.)

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/codex/PreviewBody.stories.tsx ui/src/components/codex/Sheaf.stories.tsx
git commit -m "test(codex): stories for PreviewBody and Sheaf"
```

---

## Task 6: Manual verification + final gate

**Files:** none (verification only)

- [ ] **Step 1: Run the app and exercise the feature**

Run: `cd ui && bun run dev`, open the workspace with ≥2 page tabs open, and confirm:
- Hovering an **inactive** tab shows the card after ~220ms, positioned under the tab.
- Hovering the **active** tab shows **nothing**.
- Moving between inactive tabs while a card is open switches **instantly** (no re-delay).
- Leaving the strip closes the card immediately.
- A tab near the **right edge** produces a card that stays on-screen (clamped).
- Clicking a tab activates it and the card disappears.
- The card does **not** intercept clicks (it's `pointer-events: none`).

- [ ] **Step 2: Full gate**

Run: `cd ui && bun run typecheck && bun run lint && bun run test`
Expected: ALL PASS.

- [ ] **Step 3: Final commit (if any fixes were made)**

```bash
git add -A
git commit -m "chore(sheaf): tab hover preview — verification fixes"
```

---

## Self-Review Notes

- **Spec coverage:** target=Sheaf tabs (Task 4); mechanism=lightweight non-pinnable portal card (Task 3); shared `PreviewBody` with `showTags={false}` (Tasks 2–3); lazy `usePage`/`useBacklinks` + chrome-immediately (Tasks 2–3); content matches PreviewWindow minus tags (Task 2 `showTags`); active-tab + null-path suppression (Task 1 `shouldPreviewTab`, used in Task 4); portal + local state, no store (Tasks 3–4); right-edge clamp + `PREVIEW_WIDTH` (Task 1 `clampPreviewLeft`, Task 3); passive `pointer-events: none` (Task 3); 220ms cold-open + immediate close + instant-scrub (Task 4); drop native `title` on path-bearing tabs + `aria-label`, hover-only (Task 4); unit tests for clamp + predicate (Task 1); Storybook for Sheaf + PreviewBody (Task 5). All scoped requirements mapped.
- **Type consistency:** `clampPreviewLeft(rectLeft, viewportWidth, width)` and `shouldPreviewTab(path, tabId, activeTabId)` signatures are identical across Task 1 definition, Task 3 call, and Task 4 call. `PreviewBody` props (`path`, `page`, `backlinks`, `showTags`) are identical in Task 2 definition and Tasks 2–3 usages.
- **Known confirm-on-execution point:** the exact Storybook provider/decorator wiring (Task 5 Step 2) depends on `ui/.storybook/preview.*` — the plan flags this rather than assuming.
