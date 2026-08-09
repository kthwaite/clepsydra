# Task 6 Report: Base Table Integration

## Status

Complete. Base tables now expose the server-authorized Add member workflow for the selected saved view.

## Implementation

- Selects `member_creation` capability with ASCII-case-insensitive saved-view matching.
- Presents one controlled `BaseMemberDraft`, disables Add member while unavailable, open, or saving, and associates server blocker text with the disabled action.
- Composes the draft from saved-view columns and capability fields, including project metadata options.
- Submits the complete revision/view/title/fields payload through `useCreateBaseMember`.
- Preserves draft values and surfaces decoded field diagnostics after mutation failure; every user edit clears stale server diagnostics through the expanded optional `BaseMemberDraft.onChange` contract.
- Cancels and resets the draft on explicit cancellation or saved-view changes; existing result rows remain inert while the draft is open.
- Refetches the authoritative Base query after mutation success. Grouping and sorting remain wholly server-driven; no optimistic row is inserted.
- Focuses the created title when its ID appears in refreshed flat or grouped output. A settled successful refresh that excludes the ID clears the focus target and announces a non-destructive notice.

## TDD Evidence

RED was observed before implementation in all three changed integration layers:

- `BaseMemberDraft.test.tsx`: edit callback expected two notifications, received zero.
- `BaseTableView.test.tsx`: Add member action was absent.
- `BaseTable.test.tsx`: member workflow was absent (an initial router harness issue was corrected before behavioral verification).

Focused verification:

```text
bun run --cwd ui test src/components/bases/__tests__/BaseTable.test.tsx src/components/bases/__tests__/BaseTableView.test.tsx src/components/bases/__tests__/BaseMemberDraft.test.tsx src/components/bases/__tests__/member-draft.test.ts
Test Files  4 passed (4)
Tests       36 passed (36)
```

Per the Task 6 harness override, format, lint, typecheck, build, browser, and broad suites were not run.

## Scope Resolution and Self-review

Before editing, raised `NEEDS_CONTEXT`: the brief required clearing diagnostics on user edits, but `BaseMemberDraft` exposed no edit callback and was outside the original four-file scope. The controller expanded scope to `BaseMemberDraft.tsx` and its focused test. The added callback is optional, emits no internal state, and leaves existing consumers unchanged.

Self-review confirmed the workflow uses existing API hooks, React Aria/shared Button and Table patterns, existing tokens/classes, query invalidation plus explicit authoritative refetch, and ref-based focus. No filter interpretation or optimistic grouping/sorting was added to the UI. No Folio code or server/API behavior changed.

## Review Round 1

Resolved all four findings:

- Added an explicit submitting → refreshing → resolving lifecycle so Add remains disabled until authoritative placement focuses or settles to a notice.
- Settled title-less saved views with an accessible “created but focus unavailable” status rather than leaving a latent focus marker.
- On native `base_revision_conflict` 409, preserves the draft/error, refetches Base detail, and resubmits against the refreshed revision.
- Gives every disabled/missing capability an accessible generic description when the server supplies no blocker.

Latest focused evidence (supersedes the earlier 36-test checkpoint):

```text
bun run --cwd ui test src/components/bases/__tests__/BaseTable.test.tsx src/components/bases/__tests__/BaseTableView.test.tsx src/components/bases/__tests__/BaseMemberDraft.test.tsx src/components/bases/__tests__/member-draft.test.ts
Test Files  4 passed (4)
Tests       39 passed (39)
Duration    3.10s
```

## Concerns

None known within focused Task 6 coverage. Controller-owned gates and browser smoke remain intentionally pending.
