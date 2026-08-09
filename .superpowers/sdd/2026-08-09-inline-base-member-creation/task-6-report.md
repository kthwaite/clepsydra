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

## Review Round 2

Resolved both remaining Important findings:

- Detects the native conflict envelope at HTTP 409 with `detail.code === "base_revision_conflict"`, refetches Base detail, preserves the draft/error, and retries with the refreshed revision.
- Carries operation identity and origin view through submit, refresh, and focus resolution. View changes no longer reset a live lifecycle; Add stays disabled, old-view focus is skipped non-destructively, and guarded async completions cannot settle a newer operation.
- Keyed React Aria table collections by active view as well as draft mode so differing saved-view column counts reconcile safely during a switch.

Latest focused evidence:

```text
bun run --cwd ui test src/components/bases/__tests__/BaseTable.test.tsx src/components/bases/__tests__/BaseTableView.test.tsx src/components/bases/__tests__/BaseMemberDraft.test.tsx src/components/bases/__tests__/member-draft.test.ts
Test Files  4 passed (4)
Tests       40 passed (40)
Duration    3.61s
```

## Browser Focus Fix (Round 3)

Root cause traced in React Aria’s `useSelectableItem`: entering the refreshed Table through the descendant title button initializes `selectionManager.isFocused`/`focusedKey`, then its pending effect focuses the associated row. Browser tracing showed the title receive focus immediately, the `<tr role="row">` reclaim it in the first microtask, and no further reclaim after the manager had settled.

The focused regression simulates that row reclaim and proves the placement callback is not completed early. The source fix primes React Aria’s table focus state, defers one title refocus until after the row effect, verifies focus in the following microtask, and only then settles the member lifecycle. Timer cleanup prevents stale focus work after ref changes/unmount.

Latest focused evidence:

```text
bun run --cwd ui test src/components/bases/__tests__/BaseTable.test.tsx src/components/bases/__tests__/BaseTableView.test.tsx src/components/bases/__tests__/BaseMemberDraft.test.tsx src/components/bases/__tests__/member-draft.test.ts
Test Files  4 passed (4)
Tests       41 passed (41)
Duration    3.55s
```

Task 7 then reran the fresh-vault browser flow on the committed source. After Meta+Enter and authoritative grouped placement, the `The Dispossessed` title button remained `document.activeElement` after 100 ms; its row appeared in the `READING` group with status `reading` and rating `9`. Folio and reload smoke also passed.

## UI Verification Fixes (Round 4)

Resolved all 17 final UI TypeScript errors without changing feature behavior:

- Initialized React 19 refs with explicit `undefined` unions.
- Added the now-required generated `member_creation` field to Base detail preview, story, and test fixtures.
- Narrowed `fromWire` to the shared `BaseFile` input it actually consumes, allowing both detail and mutation responses without weakening generated response types.
- Typed native validity controls and mutable cell/property fixtures precisely.

Fresh verification:

```text
bun run --cwd ui typecheck
PASS (tsc --noEmit --project tsconfig.app.json)

bun run --cwd ui test src/components/bases/__tests__/BaseTable.test.tsx src/components/bases/__tests__/BaseTableView.test.tsx src/components/bases/__tests__/BaseMemberDraft.test.tsx src/components/bases/__tests__/member-draft.test.ts src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx src/components/bases/__tests__/PropertiesEditor.test.tsx src/components/bases/__tests__/definition-model.test.ts src/components/bases/__tests__/cells.test.tsx
Test Files  8 passed (8)
Tests       128 passed (128)
Duration    6.44s

bun run --cwd ui build
PASS (tsc -b && vite build; 4033 modules transformed)
```

### UI Verification Review

The definition-workspace mutation fixture now removes detail-only `member_creation` metadata before constructing `BaseMutationResponse`, matching the native mutation wire schema instead of relying on structural excess properties.

```text
bun run --cwd ui test src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx
Test Files  1 passed (1)
Tests       25 passed (25)

bun run --cwd ui typecheck
PASS
```

## Whole-branch UI Contract Review (Round 5)

- Draft composition now resolves system/property identity before read-only classification, preserving canonical request keys such as simultaneous `kind` and `prop.kind`, plus custom `prop.word_count` and `prop.journal_date`.
- Diagnostics and draft state use the exact canonical key; only labels/property lookup strip namespaces.
- Create payloads omit draft-local `null` values while retaining empty arrays and other native values. Focused endpoint coverage selects then clears project, number, and select editors.
- TagInput leaves Cmd/Ctrl+Enter to the form; the form’s synchronous plain-Enter flush commits pending Tags/Aliases before saving.

Fresh verification:

```text
bun run --cwd ui test src/components/bases/__tests__/BaseTable.test.tsx src/components/bases/__tests__/BaseTableView.test.tsx src/components/bases/__tests__/BaseMemberDraft.test.tsx src/components/bases/__tests__/member-draft.test.ts src/components/ui/__tests__/tag-input.test.tsx
Test Files  5 passed (5)
Tests       66 passed (66)
Duration    4.63s

bun run --cwd ui typecheck
PASS
```

### Canonical Diagnostic Integration

After server commit `3ebecdd`, the namespaced draft integration fixture now feeds the native 422 diagnostic key `prop.kind` alongside simultaneous system `kind`. It asserts that the custom property control—not the system-kind control—receives focus and the exact accessible diagnostic description. No UI fallback or namespace inference was added.

```text
bun run --cwd ui test src/components/bases/__tests__/BaseMemberDraft.test.tsx
Test Files  1 passed (1)
Tests       18 passed (18)

bun run --cwd ui typecheck
PASS
```

## Concerns

None known within focused coverage, UI typecheck/build, or Task 7 browser smoke. Formatter, lint, and the broad UI suite were intentionally skipped per controller instruction.
