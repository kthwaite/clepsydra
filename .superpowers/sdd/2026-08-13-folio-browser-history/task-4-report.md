# Task 4 report

## Scope

Added real memory-router integration coverage for all nine required Folio history scenarios: A/B Back/Forward positions, distinct repeated visits, refreshed checkpoints, dirty native Back approval, stale closed/reused tuples without snapshots, initialization replacement, graph boundaries, direct fallback restoration, and non-recursive application.

## TDD evidence

### RED

`bun run test -- src/components/codex/__tests__/FolioNavigation.test.tsx`

- Initial run: 26 tests, 3 failures.
- One failure exposed test isolation rather than production behavior: the prior test's ordinary `beta` restoration leaked because the existing reset cleared only `alpha` and `other`. The harness now clears `beta` too.
- Re-run before production corrections: 26 tests, 2 intended failures:
  - dirty native Back traversed directly to Atrium instead of presenting the raw-Markdown guard;
  - Forward to an explicit graph boundary left the prior page active instead of reactivating the graph.
- The remaining new scenarios passed against Tasks 1–3 and therefore required no production correction.

### GREEN

`bun run test -- src/components/codex/__tests__/FolioNavigation.test.tsx`

- 1 file passed; 26 tests passed.

## Focused verification

`bun run test -- src/store/folioRestoration.test.ts src/hooks/useFolioHistoryNavigation.test.tsx src/hooks/useOpenTab.test.tsx src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx src/store/workspace.test.ts src/components/codex/Sheaf.test.tsx`

- 6 files passed; 165 tests passed.
- The brief's final path, `src/components/codex/Sheaf.test.tsx`, does not exist and Vitest ignored it. The actual related suite was run separately with `bun run test -- src/components/codex/__tests__/Sheaf.test.tsx`: 1 file passed; 25 tests passed.

## Static verification

`bunx biome lint src/store/folioRestoration.ts src/store/folioRestoration.test.ts src/hooks/useFolioHistoryNavigation.ts src/hooks/useFolioHistoryNavigation.test.tsx src/hooks/useOpenTab.ts src/hooks/useOpenTab.test.tsx src/components/codex/Folio.tsx src/components/codex/Sheaf.tsx src/routes/workspace.tsx src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx`

- No feature-owned diagnostic remains.
- The command exits non-zero on 13 unrelated baseline diagnostics: six in `Folio.tsx`, three in `folioRestoration.test.ts`, two in `Folio.test.tsx`, and two in pre-existing portions of `FolioNavigation.test.tsx`.

`bun run typecheck`

- Exit 0; `tsc --noEmit --project tsconfig.app.json` passed.

## Failure-driven corrections

- Added a raw-draft traversal guard registration shared by `Folio` and the history controller. Controller-owned Back/Forward wrappers consult it before memory-history traversal and use `ignoreBlocker` only for the approved continuation, so cancellation leaves history, active tab, and history snapshots untouched and Leave dispatches exactly once.
- Recognized graph entries only when all Folio tuple fields are explicitly null and `folioOriginTabId` identifies a programmatic workspace boundary. Traversal activates the existing graph tab without adding graph destination state; unmarked direct initialization retains the existing replacement behavior.
- Preserved stale tuple validation and every prior public navigation interface.

## Self-review

- Guard installation and restoration use identity checks, so StrictMode cleanup cannot overwrite a newer controller wrapper.
- Approved traversal bypasses only the already-resolved blocker; ordinary clean traversal and router blockers keep their existing behavior.
- Graph handling remains bounded to explicit programmatic graph boundaries, so malformed, closed, replaced, and incomplete page tuples cannot activate stale content.
- Tests assert active tab/path and scroll/selection where applicable, and history action count for the non-recursion and dirty-approval cases.

## Files

- `ui/src/components/codex/__tests__/FolioNavigation.test.tsx`
- `ui/src/hooks/useFolioHistoryNavigation.ts`
- `ui/src/components/codex/Folio.tsx`
- `.superpowers/sdd/2026-08-13-folio-browser-history/task-4-report.md`

## Commit

`test(ui): cover Folio browser history traversal`

## Review correction round 1

### RED

`bun run test -- src/components/codex/__tests__/FolioNavigation.test.tsx -t "keeps dirty native Back inert|scopes raw approval"`

- 1 of 2 selected tests failed as intended.
- Registering a second rejecting traversal blocker replaced the raw-draft guard, so Back did not present the raw confirmation dialog. This demonstrated that the singleton guard and global blocker bypass could not preserve independent approvals.

### Corrections

- Dirty native Back now exercises Stay first and proves the dialog closes while the exact history state and `__TSR_index`, active tab/path, tab registry, action list, and restoration registry remain unchanged.
- The same test retries Back, approves Leave, directly spies on `captureFolioHistoryLocation`, and proves exactly one capture, one Back action, and the final scroll/selection snapshot.
- Traversal guard registration now preserves multiple guards. Each approved continuation carries only that guard's one-shot approval through the retry chain. The original Back/Forward call is ultimately retried without `ignoreBlocker`, so unrelated blockers retain normal authority.
- A second rejecting-blocker integration case proves raw approval alone does not capture, apply, or traverse. The traversal completes and checkpoints exactly once only after the second blocker permits.

### GREEN and gates

- Targeted review tests: 1 file passed; 2 selected tests passed.
- `FolioNavigation.test.tsx`: 1 file passed; 27 tests passed.
- Exact focused command: 6 files passed; 166 tests passed. The brief's absent `src/components/codex/Sheaf.test.tsx` path was ignored by Vitest.
- Actual Sheaf suite: 1 file passed; 25 tests passed.
- Changed-file lint: the same 13 unrelated baseline diagnostics remain; no review-owned diagnostic was introduced.
- Typecheck: exit 0.

## Final review correction round 2

### RED

- Workspace lifecycle target: 4/4 failures showed pending requests survived close, replacement, bulk close, and no teardown action existed.
- Graph target: explicit-null Forward activated graph instead of remaining inert.
- Representative navigation targets initially failed before shared view-navigation and tab-shortcut cutovers; mobile raw + second-blocker coverage exposed mutation timing when using the mobile Back control.

### Corrections

- `goToView` is now the single coordinated boundary for every non-workspace route exit; desktop logo/rail, mobile roots, command palette actions, and global shortcuts supply the history departure coordinator.
- Open Files and next/previous shortcuts now use `useActivateTabWithFolioHistory`; remaining production raw activation is confined to the coordinator and workspace-store internals.
- Mobile usable-history Back runs every traversal guard before capture or origin mutation, then carries one-shot approvals into the actual Back without bypassing other blockers.
- Workspace replace, close, and bulk close clear removed tab visit state; `clearWorkspace` clears all workspace and Folio history state for workspace/vault teardown.
- Explicit-null graph entries remain tuple-cleared but are ignored by the Folio coordinator on traversal.

### Evidence

- Lifecycle RED: 4 selected tests failed; lifecycle GREEN: 4 selected tests passed.
- Graph RED: 1 selected test failed; graph GREEN: 1 selected test passed.
- Exit/tab/mobile blocker targets: 4 selected tests passed after correction.
- `FolioNavigation.test.tsx`: 31/31 passed.
- Expanded feature-focused suites: 11 files, 272 tests passed.
- Typecheck: exit 0.
- Expanded changed-file lint: 20 baseline diagnostics in nine files. The only initially introduced exhaustive-dependency diagnostics in `CommandPalette.tsx` were removed; no correction-owned diagnostic remains.

### Additional files

- `ui/src/components/codex/viewRegistry.ts`
- `ui/src/components/codex/viewRegistry.test.ts`
- `ui/src/components/codex/DesktopCodexFrame.tsx`
- `ui/src/components/codex/MobileCodexFrame.tsx`
- `ui/src/components/codex/CommandPalette.tsx`
- `ui/src/components/codex/__tests__/CommandPalette.test.tsx`
- `ui/src/hooks/useGlobalShortcuts.tsx`
- `ui/src/store/workspace.ts`
- `ui/src/store/workspace.test.ts`

## Final review correction round 3

### Resolution

- Mobile usable-history Back now delegates immediately to the router's native blocker lifecycle. No origin/store mutation or Folio capture occurs in the button handler; the history subscriber performs the one synchronous checkpoint only after traversal admission, then applies a valid destination tuple. This removes the custom preflight ordering gap for independent TanStack blockers.
- The production vault lifecycle now calls `clearWorkspace` from `EncryptionProvider` teardown, the existing vault/session boundary. A behavioral provider-unmount test proves open workspace tabs and pending Folio restoration state are cleared together.
- The obsolete mobile unit expectation that the button itself owns the raw confirmation was replaced with the observable boundary contract: it dispatches one Back and leaves the active tab unchanged for router blockers to resolve.

### Evidence

- Provider lifecycle target: 1 selected test passed; full provider suite 7/7 passed.
- Full feature-focused suites: 12 files, 279 tests passed.
- Typecheck: exit 0.
- Changed-file lint: 20 baseline diagnostics in nine files; no round-owned diagnostic remains.

### Additional files

- `ui/src/crypto/EncryptionProvider.tsx`
- `ui/src/crypto/__tests__/EncryptionProvider.test.tsx`

## Final review correction round 4

### RED

- Rejected-pop identity simulation failed because an unchanged-entry BACK notification captured the current Folio.
- Explicit lifecycle review showed unconditional provider cleanup would run during StrictMode rehearsal and could erase persisted workspace state.

### Corrections

- The coordinator now tracks TanStack entry identity, preferring `__TSR_key`/legacy `key` and falling back to `__TSR_index`. BACK/FORWARD/GO notifications with unchanged identity return before capture, tracking updates, activation, or restoration request. Same-path repeated visits remain distinct because identity is entry-based, not URL-based.
- Workspace clearing moved from provider effect cleanup to successful explicit vault lock, after flushers and session clearing succeed. StrictMode rehearsal and ordinary unmount preserve workspace tabs; explicit lock clears workspace and Folio state.

### Evidence

- Identity RED: 1 selected failure; GREEN: 1/1 selected passed.
- Lifecycle StrictMode + explicit lock targets: 2/2 passed.
- Full feature-focused suites: 12 files, 280 tests passed.
- Typecheck: exit 0.
- Changed-file lint: 20 baseline diagnostics; the introduced provider dependency diagnostic was corrected.

## Final review correction round 5

### RED

- Off-workspace desktop FOLIO control target failed because the already-active preflight returned on `/` and left the route unchanged.
- Constellation origin target failed because admitted Back checkpointed the outgoing Folio but left that Folio active instead of restoring the outgoing entry's graph origin.
- Settings repairs target failed because `closeSettings` ran before the raw-draft guard resolved, so Stay preserved route/workspace/registry but not Settings.
- Workspace cleanup targets failed because `updateTabPath` retained pending/visit history and `closeQuireTabs` retained latest/visit state for every removed member.

### Corrections

- `useActivateTabWithFolioHistory` now treats already-active as a no-op only on `/workspace`, in both preflight and guarded recheck. Off-workspace activation creates a fresh complete tuple with null origin and navigates; a real desktop FOLIO control test covers `/` with a persisted active page.
- The coordinator tracks each outgoing entry's `folioOriginTabId`. After an admitted BACK and synchronous Folio capture, a missing incoming tuple activates a still-valid outgoing origin through `activateTabFromHistory`. FORWARD and arbitrary tuple boundaries do not use this fallback.
- Settings IndexHealthPanel routes repairs through `useLeaveFolioWorkspace`; `closeSettings` and navigation share the deferred callback. Integration coverage proves Stay leaves Settings, route, workspace, and registry inert, while Leave captures then closes and navigates.
- Real `updateTabPath` changes clear latest plus visit/pending history. `closeQuireTabs` snapshots and clears every removed member before the Zustand updater, preserving unrelated tab records and requests.

### Evidence

- Route-aware activation RED: 1 selected failure; GREEN: 1/1.
- Constellation origin RED: 1 selected failure; GREEN: 1/1.
- Settings departure RED: 1 selected failure; GREEN: 1/1.
- Cleanup RED: 2/2 selected failures; GREEN: 2/2.
- Expanded focused suites: 14 files, 289 tests passed. Final navigation suite: 33/33 passed.
- Typecheck: exit 0.
- Changed-file lint: 20 pre-existing diagnostics in nine files; no round-owned diagnostic.
- Adjacent callsite review found non-workspace Atrium repairs navigation and registry leaf navigators correctly outside the guarded Folio boundary; no additional raw production tab activation consumer remains.

## Post-round verification repair

- RED: the complete `FolioAiConversation.test.tsx` and `FolioRecipe.test.tsx` suites failed 23 tests because their router mocks omitted the now-consumed `useRouterState` export.
- Correction: both mocks now use the same selector-driven workspace match fixture as `Folio.test.tsx`; no production behavior changed.
- GREEN: both repaired suites passed, 2 files and 25 tests.
- Expanded focused verification: 16 files, 314 tests passed.
- Typecheck: exit 0.
