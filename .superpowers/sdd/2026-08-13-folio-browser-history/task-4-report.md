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
