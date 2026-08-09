# Final responsive review fix report

## Result

All three Important and both Minor final-review findings are resolved in one integration fix.

1. `CodexFrame` now owns one stable routed-content `<main>` across desktop/mobile chrome swaps. Breakpoint changes replace only chrome siblings, so the routed child is not remounted and a rejected draft save cannot erase editor input.
2. Mobile Folio Back uses TanStack Router history. `history.canGoBack()` gates Back; a direct-loaded Folio falls back to Atrium. Page tabs are never closed. Workspace-origin tab IDs travel in history state, and Constellation presentation state lives in a Zustand store so graph/list, anchor, depth, journal, and orphan selections survive Folio navigation and Back.
3. Mobile Gazetteer uses controlled 20-row pages. Page is held in the existing Gazetteer Zustand controller, resets on query/tag/sort changes, clamps when the result count shrinks, and survives Gazetteer unmount/remount. Previous/Next are named 44px controls and the live page/count status is accessible.
4. Every ForceGraph node has a transparent `44 × 44` target. The target owns click, the node group owns drag, the SVG retains zoom/pan, and glyphs/labels are pointer-transparent.
5. The mobile dense-graph prompt now uses `visibleGraph.nodes.length`, after filters, rather than the raw response size.

Desktop routes, desktop Gazetteer rows/bulk actions, shared editor/API contracts, and the singleton graph-tab contract are unchanged.

## RED evidence

Initial behavior command:

```sh
bun run test -- src/components/codex/__tests__/CodexFrame.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx src/components/codex/Gazetteer.test.ts src/components/codex/__tests__/MobileConstellation.test.tsx src/components/ForceGraph.test.tsx
```

Initial result: `5 failed` files, `8 failed` tests. The shell, Gazetteer, density, and ForceGraph failures were the intended missing behaviors:

- routed draft expected `unsaved`, received an empty value after the frame swap;
- Gazetteer had no accessible `status` or pagination controls;
- filtered visible graph had 2 nodes but still did not render the graph;
- `.node-hit-target` was absent.

The first Folio run exposed an asynchronous memory-router test setup issue rather than product behavior. After changing only the test harness to await initial route mounting, the valid Folio RED command was:

```sh
bun run test -- src/components/codex/__tests__/FolioNavigation.test.tsx
```

Result: `1 failed` file, `4 failed` tests. Atrium, Gazetteer, and direct-load cases remained at `/workspace`; Constellation returned with an empty anchor instead of `alpha-id`. The current Back implementation had closed the page tab.

Self-review added an ownership boundary for graph labels. Its RED command was:

```sh
bun run test -- src/components/ForceGraph.test.tsx
```

Result: `1 failed` test because the label lacked `pointer-events="none"`.

## GREEN evidence

Per-finding GREEN runs:

```sh
bun run test -- src/components/codex/__tests__/CodexFrame.test.tsx
# 1 file passed; 11 tests passed

bun run test -- src/components/codex/__tests__/FolioNavigation.test.tsx
# 1 file passed; 4 tests passed

bun run test -- src/components/codex/Gazetteer.test.ts src/components/codex/__tests__/MobileGazetteer.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx
# 3 files passed; 11 tests passed

bun run test -- src/components/ForceGraph.test.tsx src/components/codex/__tests__/MobileConstellation.test.tsx
# 2 files passed; 7 tests passed
```

Final focused shell/Folio/Gazetteer/Constellation/ForceGraph run:

```sh
bun run test -- src/components/codex/__tests__/CodexFrame.test.tsx src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx src/components/codex/__tests__/MobileFolioLayout.test.tsx src/components/codex/Gazetteer.test.ts src/components/codex/__tests__/MobileGazetteer.test.tsx src/components/codex/__tests__/MobileConstellation.test.tsx src/components/ForceGraph.test.tsx
```

Result: `8 passed` files, `37 passed` tests.

Typecheck:

```sh
bun run typecheck
```

Result: exit 0, no diagnostics.

Changed-file lint:

```sh
bunx biome lint src/components/ForceGraph.tsx src/components/ForceGraph.test.tsx src/components/codex/CodexFrame.tsx src/components/codex/Constellation.tsx src/components/codex/DesktopCodexFrame.tsx src/components/codex/Folio.tsx src/components/codex/Gazetteer.test.ts src/components/codex/Gazetteer.tsx src/components/codex/MobileCodexFrame.tsx src/components/codex/MobileConstellation.tsx src/components/codex/MobileGazetteer.tsx src/components/codex/Sheaf.tsx src/components/codex/__tests__/CodexFrame.test.tsx src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx src/components/codex/__tests__/MobileConstellation.test.tsx src/components/codex/__tests__/MobileGazetteer.test.tsx src/hooks/useOpenTab.ts src/store/constellation.ts src/store/gazetteer.ts
```

Result: `OK`.

Per instruction, no formatter and no full test suite were run.

## Changed files

Production:

- `ui/src/components/ForceGraph.tsx`
- `ui/src/components/codex/CodexFrame.tsx`
- `ui/src/components/codex/Constellation.tsx`
- `ui/src/components/codex/DesktopCodexFrame.tsx`
- `ui/src/components/codex/Folio.tsx`
- `ui/src/components/codex/Gazetteer.tsx`
- `ui/src/components/codex/MobileCodexFrame.tsx`
- `ui/src/components/codex/MobileConstellation.tsx`
- `ui/src/components/codex/MobileGazetteer.tsx`
- `ui/src/components/codex/Sheaf.tsx`
- `ui/src/hooks/useOpenTab.ts`
- `ui/src/store/constellation.ts`
- `ui/src/store/gazetteer.ts`

Tests:

- `ui/src/components/ForceGraph.test.tsx`
- `ui/src/components/codex/Gazetteer.test.ts`
- `ui/src/components/codex/__tests__/CodexFrame.test.tsx`
- `ui/src/components/codex/__tests__/Folio.test.tsx`
- `ui/src/components/codex/__tests__/FolioNavigation.test.tsx`
- `ui/src/components/codex/__tests__/MobileConstellation.test.tsx`
- `ui/src/components/codex/__tests__/MobileGazetteer.test.tsx`

Report:

- `.superpowers/sdd/2026-08-08-responsive-mobile-web/final-fix-report.md`

## Design decisions and self-review

- Kept one common root and content fiber in `CodexFrame`; desktop and mobile components now provide ordered chrome fragments. This is a source fix rather than save-on-unmount compensation.
- Used TanStack Router's public `history.canGoBack()`/`back()` APIs. The history entry records only the originating workspace tab ID; no route, editor, or API contract was duplicated.
- Put Constellation presentation state in one non-persistent Zustand store. The workspace allows only one graph tab, so global graph-view state matches the existing tab invariant without per-tab machinery.
- Kept Gazetteer page state in its existing controller store. Desktop still receives the complete filtered row set; slicing occurs only at the mobile boundary.
- Kept ForceGraph gesture ownership layered: transparent node rect → click, node group → drag, SVG → zoom/pan. Labels and glyphs cannot steal pointer events.
- Reviewed every final finding against its test, checked desktop shell assertions, and found no obsolete close-on-Back path or duplicate pagination/local state.

## Commit and concerns

Commit subject: `fix(ui): resolve final responsive review findings`

No known blocker or unresolved concern. No dependency, backend endpoint, generated file, compatibility shim, or unrelated refactor was added.
