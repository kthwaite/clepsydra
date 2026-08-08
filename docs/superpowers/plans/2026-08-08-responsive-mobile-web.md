# Responsive Mobile Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native iOS client with a responsive, touch-friendly version of the existing web application served from the same tailnet HTTPS origin.

**Architecture:** Keep routing, API hooks, TanStack Query state, Zustand stores, encryption, and Slate editing shared. Select dedicated desktop or mobile presentation components at a single `768px` boundary, with mobile-specific shells and view compositions only where desktop geometry cannot adapt cleanly.

**Tech Stack:** React 19, TypeScript, TanStack Router, TanStack Query, Zustand, Slate, React Aria Components, Tailwind CSS v4, Vitest/Testing Library, Vite, Rust/Axum verification.

## Global Constraints

- Treat viewports below `768px` as mobile; `768px` and above remain desktop.
- Preserve all existing desktop capabilities and route behavior.
- Mobile roots are Atrium, Gazetteer, and Constellation; Folio/Journal is a pushed destination.
- Keep Slate rich editing, optimistic concurrency, encryption, and mutation contracts shared.
- Do not add dependencies, backend endpoints, mobile wire models, offline behavior, PWA behavior, or authentication changes.
- Tasking and Docs remain available on desktop and redirect with an explanatory notice on mobile.
- Use the existing Vessel tokens and zero-radius visual language; include safe-area insets and touch-sized controls.
- Implement each behavioral task test-first, dispatch it to a fresh subagent, and run a requirements review followed by a code-quality review before accepting its commit.
- Create the execution worktree with `superpowers:using-git-worktrees`; do not disturb unrelated changes in the main worktree.
- Perform native-client deletion and documentation cleanup only after the responsive browser smoke flow works.

## File Structure

- `ui/src/hooks/useMobileLayout.ts` — the only mobile breakpoint contract.
- `ui/src/hooks/useMobileLayout.test.tsx` — media-query lifecycle coverage.
- `ui/src/components/codex/useCodexView.ts` — shared route/workspace-to-view derivation.
- `ui/src/components/codex/DesktopCodexFrame.tsx` — existing desktop frame moved without behavior changes.
- `ui/src/components/codex/MobileCodexFrame.tsx` — compact top actions, mobile content viewport, and bottom roots.
- `ui/src/components/codex/CodexFrame.tsx` — breakpoint dispatcher only.
- `ui/src/components/codex/DesktopOnlyRoute.tsx` — mobile redirect plus explanatory toast.
- `ui/src/components/codex/MobileFolioLayout.tsx` — single-column Folio composition and disclosure sheets.
- `ui/src/components/codex/MobileGazetteer.tsx` — list and filter-sheet presentation.
- `ui/src/components/codex/MobileConstellation.tsx` — anchor-first graph controls and accessible list.
- Existing `Atrium.tsx`, `Folio.tsx`, `Gazetteer.tsx`, and `Constellation.tsx` retain data ownership and select the mobile presentation where required.
- `ui/src/main.css` — viewport-height and safe-area utilities for the mobile shell.
- Existing component test directories receive behavior-focused mobile tests next to their desktop coverage.

---

### Task 1: Establish the mobile layout contract

**Files:**
- Create: `ui/src/hooks/useMobileLayout.ts`
- Create: `ui/src/hooks/useMobileLayout.test.tsx`

**Interfaces:**
- Produces: `MOBILE_LAYOUT_QUERY = "(max-width: 767px)"`.
- Produces: `useMobileLayout(): boolean`, returning `false` when `window.matchMedia` is unavailable.
- Consumers: shell, route guards, Folio, Gazetteer, Constellation, and responsive overlays.

- [ ] **Step 1: Write the failing media-query lifecycle tests**

```tsx
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MOBILE_LAYOUT_QUERY, useMobileLayout } from "#/hooks/useMobileLayout";

function installMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    media: query,
    get matches() { return matches; },
    onchange: null,
    addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: () => true,
  })));
  return (next: boolean) => {
    matches = next;
    act(() => listeners.forEach((listener) => listener({ matches: next, media: MOBILE_LAYOUT_QUERY } as MediaQueryListEvent)));
  };
}

describe("useMobileLayout", () => {
  it("tracks the shared 768px boundary", () => {
    const setMobile = installMatchMedia(false);
    const { result, unmount } = renderHook(() => useMobileLayout());
    expect(matchMedia).toHaveBeenCalledWith(MOBILE_LAYOUT_QUERY);
    expect(result.current).toBe(false);
    setMobile(true);
    expect(result.current).toBe(true);
    unmount();
  });

  it("defaults to desktop without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(renderHook(() => useMobileLayout()).result.current).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `bun --cwd ui test src/hooks/useMobileLayout.test.tsx`

Expected: FAIL because `#/hooks/useMobileLayout` does not exist.

- [ ] **Step 3: Implement the shared hook with `useSyncExternalStore`**

```ts
import { useSyncExternalStore } from "react";

export const MOBILE_LAYOUT_QUERY = "(max-width: 767px)";

function media(): MediaQueryList | undefined {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(MOBILE_LAYOUT_QUERY)
    : undefined;
}

export function useMobileLayout(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = media();
      query?.addEventListener("change", notify);
      return () => query?.removeEventListener("change", notify);
    },
    () => media()?.matches ?? false,
    () => false,
  );
}
```

- [ ] **Step 4: Run the focused test and typecheck**

Run: `bun --cwd ui test src/hooks/useMobileLayout.test.tsx`

Expected: PASS.

Run: `bun --cwd ui typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the breakpoint contract**

```bash
git add ui/src/hooks/useMobileLayout.ts ui/src/hooks/useMobileLayout.test.tsx
git commit -m "feat(ui): add shared mobile layout contract"
```

---

### Task 2: Split the desktop and mobile application frames

**Files:**
- Create: `ui/src/components/codex/useCodexView.ts`
- Create: `ui/src/components/codex/useCodexView.test.ts`
- Create: `ui/src/components/codex/DesktopCodexFrame.tsx`
- Create: `ui/src/components/codex/MobileCodexFrame.tsx`
- Create: `ui/src/components/codex/DesktopOnlyRoute.tsx`
- Modify: `ui/src/components/codex/CodexFrame.tsx`
- Modify: `ui/src/components/codex/__tests__/CodexFrame.test.tsx`
- Modify: `ui/src/routes/tasking.tsx`
- Modify: `ui/src/routes/docs.$slug.tsx`
- Modify: `ui/src/main.css`

**Interfaces:**
- Produces: `CodexView = "atrium" | "folio" | "gazetteer" | "constellation" | "tasking" | "docs"`.
- Produces: `resolveCodexView(pathname: string, tabs: TabDescriptor[], activeTabId: string | null): CodexView`.
- Produces: `DesktopOnlyRoute({ name, children }: { name: string; children: ReactNode })`.
- `MobileCodexFrame` consumes the existing UI/workspace stores and `resolveCodexView`; root navigation uses existing routes and `openTab("graph")`.

- [ ] **Step 1: Write failing view-derivation and mobile-shell tests**

Add pure cases proving `/`, `/gazetteer`, `/docs/*`, `/tasking`, page workspaces, and graph workspaces resolve correctly. Extend `CodexFrame.test.tsx` with a mocked `useMobileLayout()` and assertions that mobile mode exposes exactly the three root buttons plus Search and New note, while desktop mode retains the existing header and footer.

```tsx
expect(screen.getByRole("navigation", { name: "Mobile roots" })).toBeVisible();
expect(screen.getByRole("button", { name: "Atrium" })).toHaveAttribute("aria-current", "page");
expect(screen.getByRole("button", { name: "Gazetteer" })).toBeVisible();
expect(screen.getByRole("button", { name: "Constellation" })).toBeVisible();
expect(screen.getByRole("button", { name: "Search" })).toBeVisible();
expect(screen.getByRole("button", { name: "New note" })).toBeVisible();
expect(screen.queryByText("TASKING")).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `bun --cwd ui test src/components/codex/useCodexView.test.ts src/components/codex/__tests__/CodexFrame.test.tsx`

Expected: FAIL because the shared resolver and mobile frame do not exist.

- [ ] **Step 3: Extract the current desktop implementation without changing behavior**

Move the current `CodexFrame` body and helpers into `DesktopCodexFrame.tsx`. Put route/workspace view selection in `useCodexView.ts`. Reduce `CodexFrame.tsx` to the breakpoint boundary:

```tsx
export function CodexFrame(props: CodexFrameProps) {
  return useMobileLayout()
    ? <MobileCodexFrame {...props} />
    : <DesktopCodexFrame {...props} />;
}
```

- [ ] **Step 4: Implement mobile chrome and safe areas**

`MobileCodexFrame` must use `h-dvh`, a compact top rail, `<main className="min-h-0 flex-1 overflow-auto">`, and a bottom `<nav aria-label="Mobile roots">`. Search calls `openSearch`; New note calls `openInscribe`; Constellation calls `openTab("graph")` before navigating to `/workspace`.

Add safe-area utilities to `main.css`:

```css
.cl-mobile-top { padding-top: env(safe-area-inset-top); }
.cl-mobile-bottom { padding-bottom: env(safe-area-inset-bottom); }
```

- [ ] **Step 5: Guard desktop-only routes on mobile**

Implement `DesktopOnlyRoute` with TanStack Router’s `Navigate` and a one-shot Sonner notice. Wrap the Tasking route component and `DocsRoute` in `docs.$slug.tsx`; `/docs` may continue redirecting to the default slug before the guard runs. Desktop rendering must pass children through unchanged.

```tsx
export function DesktopOnlyRoute({ name, children }: DesktopOnlyRouteProps) {
  const mobile = useMobileLayout();
  useEffect(() => {
    if (mobile) toast.info(`${name} is available on desktop.`);
  }, [mobile, name]);
  return mobile ? <Navigate to="/" replace /> : children;
}
```

- [ ] **Step 6: Run shell tests, route tests, and typecheck**

Run: `bun --cwd ui test src/components/codex/useCodexView.test.ts src/components/codex/__tests__/CodexFrame.test.tsx src/routes/__tests__/-docs.test.ts`

Expected: PASS.

Run: `bun --cwd ui typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the responsive shell**

```bash
git add ui/src/components/codex ui/src/routes/tasking.tsx 'ui/src/routes/docs.$slug.tsx' ui/src/main.css
git commit -m "feat(ui): add mobile application frame"
```

---

### Task 3: Adapt Atrium and global overlays for touch

**Files:**
- Modify: `ui/src/components/codex/Atrium.tsx`
- Modify: `ui/src/components/codex/CodexModalShell.tsx`
- Modify: `ui/src/components/codex/__tests__/CodexModalShell.test.tsx`
- Modify: `ui/src/components/SettingsModal.tsx`
- Modify: `ui/src/routes/__tests__/-root-overlays.test.tsx`

**Interfaces:**
- Atrium keeps its existing hooks and actions; this task changes presentation only.
- `CodexModalShell` keeps its public props and gains a full-height mobile presentation below `768px`.

- [ ] **Step 1: Add behavioral dialog coverage before changing geometry**

Extend the shared modal test to prove a named dialog retains focus containment, Escape dismissal, and scrim dismissal after its responsive classes change. Extend root overlay coverage to open Search, Settings, and New note through store actions and assert each exposes one named modal dialog.

- [ ] **Step 2: Run the focused dialog tests**

Run: `bun --cwd ui test src/components/codex/__tests__/CodexModalShell.test.tsx src/routes/__tests__/-root-overlays.test.tsx`

Expected: PASS before the CSS work; these tests protect behavior while browser verification covers geometry.

- [ ] **Step 3: Make shared overlays full-height on phones**

Use responsive classes rather than branching component logic. Below `md`, the overlay starts at the top, the modal is `h-dvh w-full max-w-none`, and the dialog scrolls internally. Apply the same geometry to `SettingsModal`, which does not consume `CodexModalShell`. Keep desktop widths and top offset unchanged.

- [ ] **Step 4: Remove Atrium’s narrow-screen overflow sources**

At mobile widths:

- reduce outer and card padding;
- remove the hero action block’s `min-w-[280px]`;
- keep inventory at two columns with correct border placement;
- make tag rows `grid-cols-[minmax(0,1fr)_minmax(60px,1fr)_32px]`;
- make recent rows use a mobile two-line grid instead of fixed `18px 90px 1fr 72px` columns;
- remove visible shortcut legends while retaining button labels;
- preserve the existing desktop classes from `md` upward.

- [ ] **Step 5: Run focused tests and lint changed files**

Run: `bun --cwd ui test src/components/codex/__tests__/CodexModalShell.test.tsx src/routes/__tests__/-root-overlays.test.tsx src/components/codex/atrium-time.test.tsx`

Expected: PASS.

Run: `bun --cwd ui lint src/components/codex/Atrium.tsx src/components/codex/CodexModalShell.tsx src/components/SettingsModal.tsx`

Expected: PASS.

- [ ] **Step 6: Commit Atrium and overlay responsiveness**

```bash
git add ui/src/components/codex/Atrium.tsx ui/src/components/codex/CodexModalShell.tsx ui/src/components/codex/__tests__/CodexModalShell.test.tsx ui/src/components/SettingsModal.tsx ui/src/routes/__tests__/-root-overlays.test.tsx
git commit -m "feat(ui): adapt atrium and overlays for mobile"
```

---

### Task 4: Build the focused mobile Folio and Journal

**Files:**
- Create: `ui/src/components/codex/MobileFolioLayout.tsx`
- Create: `ui/src/components/codex/__tests__/MobileFolioLayout.test.tsx`
- Modify: `ui/src/components/codex/Folio.tsx`
- Modify: `ui/src/components/codex/__tests__/Folio.test.tsx`
- Modify: `ui/src/components/codex/__tests__/FolioJournalDraft.test.tsx`
- Modify: `ui/src/editor/PageEditorHeader.tsx`
- Modify: `ui/src/editor/SlateEditor.tsx`

**Interfaces:**
- Produces: `MobileFolioLayout`, a presentation component receiving `header`, `document`, `details`, `relationships`, and `contents` React nodes plus `onBack`.
- `Folio` retains all queries, mutations, local state, conflict state, encryption behavior, and save shortcuts.
- `Folio` calls `useMobileLayout()` only to choose `MobileFolioLayout` or the existing three-column composition.

- [ ] **Step 1: Write failing mobile Folio behavior tests**

Mock `useMobileLayout()` as mobile in the existing Folio harness. Assert the page remains editable, the desktop META/LINKS rails and resizers are absent, and the mobile disclosure buttons expose document details and relationships.

```tsx
expect(screen.getByRole("textbox", { name: "Page title" })).toHaveValue("Alpha");
expect(screen.queryByRole("button", { name: "collapse panel" })).not.toBeInTheDocument();
await user.click(screen.getByRole("button", { name: "Document details" }));
expect(screen.getByRole("dialog", { name: "Document details" })).toBeVisible();
expect(screen.getByText("notes/alpha.md")).toBeVisible();
await user.click(screen.getByRole("button", { name: "Page relationships" }));
expect(screen.getByRole("dialog", { name: "Page relationships" })).toBeVisible();
expect(screen.getByText("Backlinks")).toBeVisible();
```

Extend the Journal draft test to run mobile mode and prove opening an unwritten today still does not mutate until the first body change/save.

- [ ] **Step 2: Run the focused Folio tests and confirm failure**

Run: `bun --cwd ui test src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioJournalDraft.test.tsx src/components/codex/__tests__/MobileFolioLayout.test.tsx`

Expected: FAIL because the mobile layout and disclosure dialogs do not exist.

- [ ] **Step 3: Implement `MobileFolioLayout` as a slot-based presentation boundary**

The component owns only disclosure open/close state and geometry. Use React Aria `ModalOverlay`, `Modal`, and `Dialog` for full-height details and relationships sheets. Render the document in one independently scrolling column. Do not move data fetching or mutations into the mobile component.

```ts
export interface MobileFolioLayoutProps {
  header: ReactNode;
  document: ReactNode;
  details: ReactNode;
  relationships: ReactNode;
  contents: ReactNode;
  onBack: () => void;
}
```

- [ ] **Step 4: Reuse Folio domain state in both presentations**

In `Folio.tsx`, create shared React-node fragments for the dossier header/document, metadata, contents, and relationships from the state already loaded by `Folio`. Select `MobileFolioLayout` before calculating desktop rail widths so mobile never initializes or renders resizers. Keep `NoteProtectionDialog`, assignment callbacks, relationship navigation, encryption, save status, and `WikilinkResolutionProvider` identical.

- [ ] **Step 5: Make Slate controls touch-safe without changing editor semantics**

At mobile widths, make the editor full width, ensure interactive controls are at least `44px` high, keep suggestion popovers within `calc(100vw - 24px)`, and collapse PageEditorHeader’s tags/aliases/actions into vertical rows. Do not add a second editor mode or alter serialization.

- [ ] **Step 6: Run Folio/editor tests and typecheck**

Run: `bun --cwd ui test src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioJournalDraft.test.tsx src/components/codex/__tests__/MobileFolioLayout.test.tsx src/editor/__tests__/usePageEditor.test.tsx`

Expected: PASS.

Run: `bun --cwd ui typecheck`

Expected: PASS.

- [ ] **Step 7: Commit focused mobile reading and editing**

```bash
git add ui/src/components/codex/Folio.tsx ui/src/components/codex/MobileFolioLayout.tsx ui/src/components/codex/__tests__ ui/src/editor/PageEditorHeader.tsx ui/src/editor/SlateEditor.tsx
git commit -m "feat(ui): add focused mobile folio"
```

---

### Task 5: Add the mobile Gazetteer list

**Files:**
- Create: `ui/src/components/codex/MobileGazetteer.tsx`
- Create: `ui/src/components/codex/__tests__/MobileGazetteer.test.tsx`
- Modify: `ui/src/components/codex/Gazetteer.tsx`
- Modify: `ui/src/api/types.ts`

**Interfaces:**
- Export: `ContentEntry = components["schemas"]["ContentEntry"]` from `ui/src/api/types.ts`.
- Produces: `MobileGazetteer` with controlled `query`, `selectedTags`, `sort`, `rows`, and callbacks.
- `Gazetteer` retains fetching, filtering, sorting, URL tag initialization, assignment behavior, and page opening.

- [ ] **Step 1: Write failing list and filter-sheet tests**

Render `MobileGazetteer` with two entries. Assert it exposes a list rather than a table, opens a named Filters dialog, emits query/tag/sort changes, and invokes `onOpen` for the selected row.

```tsx
expect(screen.getByRole("list", { name: "Vault pages" })).toBeVisible();
expect(screen.queryByRole("table")).not.toBeInTheDocument();
await user.click(screen.getByRole("button", { name: "Filters" }));
expect(screen.getByRole("dialog", { name: "Gazetteer filters" })).toBeVisible();
await user.click(screen.getByRole("button", { name: "Open Alpha" }));
expect(onOpen).toHaveBeenCalledWith("notes/alpha.md", "Alpha");
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `bun --cwd ui test src/components/codex/__tests__/MobileGazetteer.test.tsx`

Expected: FAIL because `MobileGazetteer` does not exist.

- [ ] **Step 3: Implement the controlled mobile list**

Use React Aria dialog primitives for the filter sheet. Each row must expose title, path, kind/project, tags, words, and modified time without requiring hover. Use semantic list/listitem roles and a single explicit open action per row. Do not render bulk-selection controls.

- [ ] **Step 4: Select the list from the existing Gazetteer controller**

Call `useMobileLayout()` in `Gazetteer.tsx`. After existing data derivation, pass the same controlled state and `openTab` callback to `MobileGazetteer`; preserve the current desktop table branch verbatim. Keep filter state in `Gazetteer` so it survives Folio navigation and presentation changes.

- [ ] **Step 5: Run Gazetteer tests and typecheck**

Run: `bun --cwd ui test src/components/codex/Gazetteer.test.ts src/components/codex/__tests__/MobileGazetteer.test.tsx`

Expected: PASS.

Run: `bun --cwd ui typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the mobile Gazetteer**

```bash
git add ui/src/api/types.ts ui/src/components/codex/Gazetteer.tsx ui/src/components/codex/MobileGazetteer.tsx ui/src/components/codex/__tests__/MobileGazetteer.test.tsx
git commit -m "feat(ui): add mobile gazetteer list"
```

---

### Task 6: Add anchor-first mobile Constellation

**Files:**
- Create: `ui/src/components/codex/MobileConstellation.tsx`
- Create: `ui/src/components/codex/__tests__/MobileConstellation.test.tsx`
- Modify: `ui/src/components/codex/Constellation.tsx`
- Modify: `ui/src/components/codex/constellation-filters.ts`
- Modify: `ui/src/components/codex/constellation-filters.test.ts`
- Modify: `ui/src/components/ForceGraph.tsx`

**Interfaces:**
- Produces: `MobileConstellation({ graph, anchorId, depth, hideDaily, orphansVisible, onAnchorChange, onDepthChange, onHideDailyChange, onOrphansVisibleChange, onOpen })`.
- Reuses: `applyFilters(graph, filters)` for the visible graph.
- Adds no graph endpoint and does not mutate generated API types.

- [ ] **Step 1: Write failing anchor, list-fallback, and navigation tests**

Cover three observable contracts:

1. an anchor selection limits the visible graph according to depth;
2. the “List view” control exposes the same visible node set with semantic list items;
3. selecting a node invokes `onOpen(node)`.

```tsx
await user.selectOptions(screen.getByLabelText("Anchor page"), "alpha-id");
await user.click(screen.getByRole("button", { name: "List view" }));
expect(screen.getByRole("list", { name: "Visible constellation pages" })).toBeVisible();
expect(screen.getByText("Alpha")).toBeVisible();
await user.click(screen.getByRole("button", { name: "Open Alpha" }));
expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "alpha-id" }));
```

Extend pure filter tests for depth-one, depth-two, journal exclusion, and orphan exclusion around a selected anchor.

- [ ] **Step 2: Run graph tests and confirm failure**

Run: `bun --cwd ui test src/components/codex/constellation-filters.test.ts src/components/codex/__tests__/MobileConstellation.test.tsx`

Expected: FAIL because the mobile component and any missing anchor-filter contract are absent.

- [ ] **Step 3: Harden pure graph filtering first**

Make `applyFilters` deterministic for a fixed graph and selected anchor. Return only edges whose source and target remain present. Do not silently truncate nodes. Keep the existing desktop filter results unchanged when no anchor/depth restriction is active.

- [ ] **Step 4: Implement mobile chart controls and accessible list**

Use one stateful mode toggle (`"graph" | "list"`), an anchor selector, depth control (`1 | 2`), journal/orphan switches, and a details sheet for hubs/orphans. Feed the filtered graph to `ForceGraph`; in list mode render the identical node set sorted by title/path. Prompt for an anchor when the unfiltered graph exceeds the component’s explicit density threshold; do not discard data.

- [ ] **Step 5: Make ForceGraph viewport-responsive**

Accept measured container dimensions, recalculate the SVG viewport after `ResizeObserver` changes, and keep touch pan/zoom enabled. Preserve desktop pointer behavior and stop propagation only for gestures the graph owns.

- [ ] **Step 6: Select mobile or desktop presentation in `Constellation`**

Keep `useGraph`, open-page behavior, and filter state in `Constellation.tsx`. Mobile mode renders `MobileConstellation`; desktop mode retains the existing two-column graph plus apparatus.

- [ ] **Step 7: Run graph tests and typecheck**

Run: `bun --cwd ui test src/components/codex/constellation-filters.test.ts src/components/codex/__tests__/MobileConstellation.test.tsx`

Expected: PASS.

Run: `bun --cwd ui typecheck`

Expected: PASS.

- [ ] **Step 8: Commit the mobile Constellation**

```bash
git add ui/src/components/codex/Constellation.tsx ui/src/components/codex/MobileConstellation.tsx ui/src/components/codex/constellation-filters.ts ui/src/components/codex/constellation-filters.test.ts ui/src/components/codex/__tests__/MobileConstellation.test.tsx ui/src/components/ForceGraph.tsx
git commit -m "feat(ui): add mobile constellation"
```

---

### Task 7: Prove the responsive application in a real browser

**Files:**
- Modify only files implicated by observed browser failures.

**Interfaces:**
- Consumes the completed responsive shell and all mobile views.
- Produces evidence for the phone flow before native cleanup begins.

- [ ] **Step 1: Build and serve the application**

Run: `bun --cwd ui build`

Expected: PASS and `ui/dist/` produced.

Create `_scratch/mobile-smoke/vault` with `cargo run -- init _scratch/mobile-smoke/vault`. Write `_scratch/mobile-smoke/config.toml` with the content below, then start `cargo run --manifest-path ../../Cargo.toml -- serve` from `_scratch/mobile-smoke` through the harness process manager and wait for `http://localhost:3100/` to respond. This isolates every smoke-test mutation from the operator’s vault.

```toml
[server]
host = "localhost"
port = 3100
dev_mode = false

[vault]
root = "./vault"
```

- [ ] **Step 2: Exercise the `390 × 844` flow with the browser tool**

Open Atrium; switch Atrium → Gazetteer → Constellation; search and open a Folio; edit and save a disposable note; open document details and relationships; open today’s Journal; quick-capture disposable text; filter Gazetteer; select a Constellation anchor; switch to list view; open a node; visit Tasking and Docs and observe the notice plus redirect.

Expected: every action is reachable without hover, mutations persist after reopening, and unsupported routes explain the redirect.

- [ ] **Step 3: Check geometry at all approved widths**

Repeat visual inspection at `430 × 932`, `768 × 1024`, and the existing desktop viewport. At each width inspect the accessibility tree and screenshot only for appearance. Verify:

- no horizontal page overflow;
- no control hidden behind browser chrome or safe areas;
- mobile roots appear only below `768px`;
- desktop header, Sheaf, Folio rails, Gazetteer table, Tasking, and Docs remain present at `768px` and desktop widths;
- dialogs scroll internally and retain a reachable dismissal action.

- [ ] **Step 4: Fix each observed defect at its source and repeat the failing browser step**

For a layout defect, correct the responsible component or token; do not add viewport-specific JavaScript measurements unless CSS cannot represent the geometry. For a state defect, fix the shared controller rather than duplicating state in the mobile view. Re-run the exact browser action that exposed each defect.

- [ ] **Step 5: Commit browser-proven corrections if the smoke flow required edits**

```bash
git add ui/src
git commit -m "fix(ui): harden responsive mobile flows"
```

If no source file changed, record the browser evidence in the task review and do not create an empty commit.

---

### Task 8: Remove the native client and supersede native guidance

**Files:**
- Delete: `ios/`
- Delete: `scripts/trust-simulator-ca.sh`
- Modify: `.gitignore`
- Modify: `ui/src/docs/content/cli.mdx`
- Modify: `src/bin/cli.rs`
- Modify: `docs/superpowers/specs/2026-08-03-ios-vault-client-design.md`
- Modify: `docs/superpowers/specs/2026-08-07-ios-main-views-design.md`
- Modify: `docs/superpowers/plans/2026-08-03-ios-vault-client.md`
- Modify: `docs/superpowers/plans/2026-08-07-ios-main-views.md`

**Interfaces:**
- The responsive application is now the only phone client.
- Historical documents retain their bodies and gain a superseded notice linking to `docs/superpowers/specs/2026-08-08-responsive-mobile-web-design.md`.

- [ ] **Step 1: Add superseded notices before deleting native code**

Insert directly below each historical document title:

```markdown
> **Superseded (2026-08-08):** The native iOS client was replaced by the responsive web application specified in [`2026-08-08-responsive-mobile-web-design.md`](../specs/2026-08-08-responsive-mobile-web-design.md). This document is retained as historical context and must not be executed.
```

For files already under `specs/`, use the sibling link `./2026-08-08-responsive-mobile-web-design.md`.

- [ ] **Step 2: Remove native implementation and simulator tooling**

Delete the complete `ios/` directory and `scripts/trust-simulator-ca.sh`. Remove the three `ios/` ignore entries from `.gitignore`. Do not remove backend revision, UUID, encryption, or HTTPS behavior that desktop and responsive mobile still use.

- [ ] **Step 3: Update active CLI guidance**

Replace the iOS/ATS-specific explanation in `ui/src/docs/content/cli.mdx` with browser-neutral HTTPS/tailnet guidance. Remove the simulator-trust sentence from the `serve` command’s `after_help` text in `src/bin/cli.rs`. Keep the existing TLS commands accurate; remove simulator trust instructions and native-client claims.

- [ ] **Step 4: Prove no active repository surface points users to the removed client**

Run the repository text search for `ClepsydraMobile`, `trust-simulator-ca`, `ios/Packages`, and “iOS app”. Historical superseded plans/specs and the responsive design’s cutover explanation are allowed matches; active source, scripts, README, and in-app documentation must have none.

Expected: no active reference requires a deleted file or native build command.

- [ ] **Step 5: Run documentation tests**

Run: `bun --cwd ui test src/docs/mdx-smoke.test.tsx src/docs/registry.test.ts src/docs/search.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the clean cutover**

```bash
git add -A ios scripts/trust-simulator-ca.sh .gitignore ui/src/docs/content/cli.mdx src/bin/cli.rs docs/superpowers/specs docs/superpowers/plans
git commit -m "chore: remove native ios client"
```

---

### Task 9: Run release gates and tailnet acceptance

**Files:**
- Modify only files required by a demonstrated gate failure.

**Interfaces:**
- Produces the final verified responsive feature commit series ready to merge into `develop`.

- [ ] **Step 1: Run frontend typecheck**

Run: `bun --cwd ui typecheck`

Expected: PASS.

- [ ] **Step 2: Run frontend lint**

Run: `bun --cwd ui lint`

Expected: PASS.

- [ ] **Step 3: Run the complete frontend test suite**

Run: `bun --cwd ui test`

Expected: PASS.

- [ ] **Step 4: Run the complete Rust test suite**

Run: `cargo test --all-targets`

Expected: PASS.

- [ ] **Step 5: Run the production frontend build**

Run: `bun --cwd ui build`

Expected: PASS.

- [ ] **Step 6: Repeat the core browser smoke against the built application**

At `390 × 844`, repeat Atrium root switching, Gazetteer filtering, Constellation list navigation, Folio edit/save/reopen, and Tasking/Docs redirect checks. At `768 × 1024`, confirm the desktop frame and desktop-only routes remain available.

Expected: both flows pass against production assets.

- [ ] **Step 7: Complete physical-iPhone tailnet acceptance**

On an iPhone connected to the tailnet, open the existing `.ts.net` HTTPS origin in Safari. Open a disposable Folio, edit it, save, reopen it, and confirm the change from desktop Clepsydra. Verify the bottom roots remain above the Safari safe area and no horizontal overflow occurs.

Expected: certificate validation succeeds and the saved text is identical on phone and desktop.

- [ ] **Step 8: Review the complete commit range and merge to `develop`**

Use `superpowers:requesting-code-review` for the full feature range. Address only evidence-backed findings, rerun any gate affected by a correction, commit those corrections, then use `superpowers:finishing-a-development-branch` to merge the verified branch into `develop`.
