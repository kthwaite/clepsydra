# Final Tasking archive report

## Result

Tasking now archives task pages to the Rubbish Bin instead of destroying them. The two-step action flushes and awaits every pending debounced PATCH before sending DELETE, accepts the typed `RubbishItemSummary` returned with status 201, and closes the editor only after both save and archive succeed.

The Tasking archive request carries no query string. The obsolete `force=true`, `rewrite=plain_text`, `useDeleteTask`, DESTROY naming, test IDs, comments, and user-facing copy were removed rather than aliased.

## TDD evidence

### RED

- `bun run test -- src/api/board.test.ts src/components/tasking/__tests__/TaskEditPanel.test.tsx` — exit 1: 2 files failed; 8 tests failed. The API failures reported `useArchiveTask is not a function`, and all six component archive tests failed because the archive action did not exist. This established the missing cutover before production edits.
- `bun run test -- src/components/tasking/__tests__/TaskEditPanel.test.tsx -t "retries the unsaved PATCH"` — exit 1: 1 failed, 43 skipped. The retry assertion expected two PATCH attempts but observed one, exposing that a failed debounced save was not retained for recovery.

### GREEN

- `bun run test -- src/components/tasking/__tests__/TaskEditPanel.test.tsx -t "retries the unsaved PATCH"` — exit 0: 1 passed, 43 skipped.
- Final focused verification: `bun run test -- src/api/board.test.ts src/components/tasking/__tests__/TaskEditPanel.test.tsx src/api/__tests__/mutation-hooks.test.tsx` — exit 0: 3 files passed, 71 tests passed.
- `bun run typecheck` — exit 0.
- `git diff --check` — exit 0 with no output.

Vitest emitted the existing Vite native-config compatibility warning for `__dirname` and the extensionless `./mdx-plugin` import. Per the task constraint, formatter, lint, build, and full-suite commands were not run.

## Behavior and contract coverage

- A pending title PATCH is issued immediately when archive is confirmed; DELETE remains absent until that PATCH resolves.
- A rejected PATCH prevents DELETE and leaves `editTaskId` unchanged, so the panel stays open.
- Failed pending saves remain retryable. A second archive attempt reissues the PATCH and proceeds only after it succeeds.
- A successful DELETE must return status 201 and its JSON is typed as `ArchivedPage` (`RubbishItemSummary`).
- The DELETE URL has no query string and therefore carries no force or rewrite policy.
- Successful archival invalidates the Tasking board plus the established page-structure and Rubbish query families.
- The confirmation, pending status, action name, comments, and test IDs use archive/Rubbish semantics.
- Escape, scrim, and the close button cannot close the editor while save-and-archive is pending; the confirmation button is disabled and exposes pending copy.

## Commit

Task commit subject: `fix(ui): archive Tasking pages after pending saves`.

Only the four scoped UI source/test files and this report are included. Pre-existing Rust lifecycle worktree changes remain unstaged and untouched.

## Self-review

- The Tasking hook reuses `invalidatePageStructure` and `invalidateRubbish`; it does not introduce a second query-key convention.
- The debounced field helper serializes deliveries, awaits an already-running delivery, restores a failed latest value for retry, and does not restore an older failed value after a newer edit supersedes it.
- Save failure and archive failure both return the action to its retryable first step without closing the editor.
- Immediate and debounced Tasking controls retain the mutation hook's optimistic `onMutate` behavior while sharing one awaited, serial PATCH coordinator.
- The 201 check rejects legacy 204 hard-delete behavior rather than silently accepting it.
- No Rust lifecycle internals were modified for this task.

## Concerns

No scoped correctness concerns. The focused tests rely on the existing global fetch stubs and preserve the current Tasking/property-picker test surface. The pre-existing Vite configuration warning remains outside this assignment.

## Review correction: complete PATCH barrier

### Gap and correction

Review found that the initial barrier covered only the eight debounced producers. Immediate controls still used untracked `mutate`, so an in-flight status, priority, operation, cycle, or hold PATCH could race DELETE. The editor body also remained interactive during the save-and-archive sequence, allowing a trailing debounced edit after the one-pass flush.

All Tasking PATCHes now enter one panel-level serial coordinator through `mutateAsync`. This preserves `usePatchTask`'s optimistic `onMutate` behavior while exposing one queue barrier. Successful retries clear failures for the fields they supersede; a failure in any other field remains visible to the barrier and blocks archive.

Confirming archive now freezes the complete editor fieldset, flushes all debounce producers, awaits the shared PATCH queue and its failure state, and only then sends DELETE. Escape, scrim, header close, duplicate confirmation, and every editor control remain disabled or inert until the sequence settles.

### Additional TDD evidence

- RED: `bun run test -- src/components/tasking/__tests__/TaskEditPanel.test.tsx -t \"in-flight immediate|immediate PATCH rejects|pending debounced\"` — exit 1: 2 failed, 1 passed, 43 skipped. The rejected immediate PATCH allowed archive to proceed and remove the archive action; the gated debounce test found the assignee control enabled during archival.
- GREEN: the same command — exit 0: 3 passed, 43 skipped.
- Final focused verification: `bun run test -- src/api/board.test.ts src/components/tasking/__tests__/TaskEditPanel.test.tsx src/api/__tests__/mutation-hooks.test.tsx` — exit 0: 3 files passed, 73 tests passed.
- `bun run typecheck` — exit 0.

### Follow-up commit and self-review

Follow-up commit subject: `fix(ui): serialize Tasking edits before archive`.

Self-review confirmed immediate optimistic patches start through the same mutation hook, PATCH requests serialize across immediate and debounced producers, the archive barrier observes both active requests and settled failures, a successful same-field retry clears its prior failure, and a task identity change cannot inherit a previous task's failed-field state. The disabled fieldset prevents user-generated trailing change events while archival is pending. No Rust files were touched.

### Concerns

No scoped concerns. The focused run continues to emit only the pre-existing Vite native-config warning documented above.
