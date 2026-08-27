# Task 3 report — global intake placement adapter

## Status

Implemented the global Base-member intake adapter over the shared member-creation session. `BaseMemberIntakeProps` and `onCreated(path, title)` remain unchanged. The modal still owns close, reset, and created-page placement.

## Requirements delivered

- Definition-backed sessions resolve from the current slug, selected view, and complete Base detail.
- First-view fallback and ASCII case-insensitive capability matching now come from `resolveMemberCreationSession`.
- View options and `composeMemberDraftFields` remain definition-backed.
- Submission delegates request normalization, revision ownership, conflict classification, error formatting, and diagnostic decoding to the shared session.
- The API mutation adapter preserves the existing endpoint call shape.
- Conflict refresh inspects both rejected refetches and resolved refetch results carrying an error.
- Successful outcomes call `onCreated` with the response path and title.
- Conflict and failed outcomes preserve the mounted draft and display returned reports.
- A successful conflict refresh causes the next render to resolve a new session; resubmission uses the refreshed revision.
- View change and cancel clear reports without clearing authored values.
- Loading, missing-Base, blocker, and pending presentation remain intact.
- `InscribeModal` integration now pins created-page opening, modal close, and local intake reset.
- Intake-local request construction, null filtering, title trimming, error formatting, and diagnostic decoding were removed.

## TDD evidence

RED command:

```text
bun run test -- src/components/bases/__tests__/BaseMemberIntake.test.tsx
```

Observed before production migration:

```text
Test Files  1 failed (1)
Tests       2 failed | 7 passed (9)
- conflict resubmission sent detail-r1 instead of refreshed detail-r2
- resolved conflict-refetch error displayed the original conflict instead of the refresh failure
```

GREEN focused command:

```text
bun run test -- src/components/bases/__tests__/BaseMemberIntake.test.tsx src/components/codex/__tests__/InscribeModal.test.tsx src/components/bases/__tests__/member-creation.test.ts
Test Files  3 passed (3)
Tests       42 passed (42)
```

The dedicated intake suite covers conflict refresh and resubmission, first-view fallback, case-insensitive capability, blocker copy, exact success request and callback, project input, ordinary diagnostics, failed conflict refresh, view change, cancel, pending, loading, and missing-Base behavior.

## Verification gates

Typecheck:

```text
bun run typecheck
$ tsc --noEmit --project tsconfig.app.json
exit 0
```

Scoped lint:

```text
bun run lint -- src/components/bases/BaseMemberIntake.tsx src/components/bases/__tests__/BaseMemberIntake.test.tsx src/components/codex/__tests__/InscribeModal.test.tsx
Checked 3 files in 5ms. No fixes applied.
exit 0
```

## Concerns

No task-specific concern. Vitest emits the existing Vite native-config migration warnings for `__dirname` and the extensionless `./mdx-plugin` import. Controlled full-suite and running-application checks remain branch-final verification gates.

## Review round 1/5

### Status

Fixed both review findings.

- View selection now carries its Base slug. Reusing the intake for another slug falls back to that Base's first view, capability, and revision.
- An enabled session's composed fields are retained for its slug and view. Conflict refreshes that remove or disable the selected capability keep the same draft mounted.
- Blocker copy now renders beside a retained draft. Save alone is gated when the current session is missing or disabled. Authored controls and Cancel remain available.
- Switching to a viable refreshed view reuses the mounted draft and submits through that view's refreshed session.
- `BaseMemberDraft` now has an explicit `isSaveDisabled` contract. Global intake and table callers were migrated.
- Dedicated `useBase` and `useCreateBaseMember` result factories model complete query, refetch, idle-mutation, and pending-mutation states.

### TDD evidence

Initial intake RED:

```text
bun run test -- src/components/bases/__tests__/BaseMemberIntake.test.tsx src/components/bases/__tests__/BaseMemberDraft.test.tsx
Test Files  1 failed | 1 passed (2)
BaseMemberIntake: 3 failed
- alternate view leaked to the next slug, leaving only the missing-Base alert
- removed selected capability replaced the draft with the missing-Base alert
- disabled selected capability unmounted the authored title and controls
```

Draft save-gating RED:

```text
bun run test -- src/components/bases/__tests__/BaseMemberDraft.test.tsx -t "disables only submission"
Test Files  1 failed (1)
Tests       1 failed | 22 skipped (23)
- Save new member remained enabled when isSaveDisabled was true
```

Required GREEN suite:

```text
bun run test -- src/components/bases/__tests__/BaseMemberIntake.test.tsx src/components/bases/__tests__/BaseMemberDraft.test.tsx src/components/codex/__tests__/InscribeModal.test.tsx src/components/bases/__tests__/member-creation.test.ts
Test Files  4 passed (4)
Tests       68 passed (68)
```

The new intake cases prove slug-scoped selection with an exact Base-B request; removed-capability draft retention, Save gating, view switching, and refreshed-revision resubmission; and disabled-capability draft retention and Save gating. The draft case proves authoring and Cancel remain enabled while pointer and keyboard submission are blocked.

Caller regression:

```text
bun run test -- src/components/bases/__tests__/BaseTableView.test.tsx
Test Files  1 passed (1)
Tests       63 passed (63)
```

### Verification gates

```text
bun run typecheck
$ tsc --noEmit --project tsconfig.app.json
exit 0
```

```text
bun run lint -- src/components/bases/BaseMemberIntake.tsx src/components/bases/BaseMemberDraft.tsx src/components/bases/__tests__/BaseMemberIntake.test.tsx src/components/bases/__tests__/BaseMemberDraft.test.tsx
Checked 4 files in 6ms. No fixes applied.
exit 0
```

### Concerns

Vitest still emits the existing Vite native-config migration warnings for `__dirname` and the extensionless `./mdx-plugin` import. Whole-file lint of the migrated `BaseTableView.tsx` caller exits successfully but reports its two pre-existing non-null-assertion warnings at lines 665 and 751.

## Review round 2/5

### Status

Fixed the Important keyboard Cancel regression in `BaseMemberDraft`.

- `isSaving` remains the first keyboard guard and continues to disable every draft action.
- A non-prevented Escape now calls `onCancel` before `isSaveDisabled` is considered.
- `isSaveDisabled` gates only pointer and Cmd/Ctrl+Enter submission.
- The behavior test now covers enabled Cancel, disabled Save, blocked Cmd/Ctrl+Enter submission, and Escape cancellation while not saving.

### TDD evidence

RED:

```text
bun run test -- src/components/bases/__tests__/BaseMemberDraft.test.tsx -t "disables only submission"
Test Files  1 failed (1)
Tests       1 failed | 22 skipped (23)
- expected onCancel to be called once after Escape, but it was called 0 times
```

GREEN:

```text
bun run test -- src/components/bases/__tests__/BaseMemberDraft.test.tsx -t "disables only submission"
Test Files  1 passed (1)
Tests       1 passed | 22 skipped (23)
```

Required regression suite:

```text
bun run test -- src/components/bases/__tests__/BaseMemberDraft.test.tsx src/components/bases/__tests__/BaseMemberIntake.test.tsx src/components/codex/__tests__/InscribeModal.test.tsx
Test Files  3 passed (3)
Tests       48 passed (48)
```

### Verification gates

```text
bun run typecheck
$ tsc --noEmit --project tsconfig.app.json
exit 0
```

```text
bun run lint -- src/components/bases/BaseMemberDraft.tsx src/components/bases/__tests__/BaseMemberDraft.test.tsx
Checked 2 files in 29ms. No fixes applied.
exit 0
```

### Concerns

No task-specific concern. Vitest still emits the existing Vite native-config migration warnings for `__dirname` and the extensionless `./mdx-plugin` import.

## Final-review fix wave

### Status

Fixed duplicate global-intake submission during revision-conflict refresh.

- `BaseMemberIntake` now tracks the complete `session.submit` lifetime locally.
- A synchronous in-flight guard prevents repeated handlers from reusing the captured session before React rerenders.
- TanStack mutation pending still disables the whole draft. The longer local submission state disables Save and Cmd/Ctrl+Enter only, so authored fields, Cancel, and Escape remain available while conflict refresh is pending.
- Session capability gating remains combined with the local submission gate.
- The deterministic intake test holds conflict refetch unresolved, verifies the draft stays editable and cancellable while Save is disabled, attempts Cmd+Enter, then resolves refreshed detail and proves the only resubmission uses the new revision.

### TDD evidence

RED:

```text
bun run test -- src/components/bases/__tests__/BaseMemberIntake.test.tsx -t "blocks duplicate submission"
Test Files  1 failed (1)
Tests       1 failed | 12 skipped (13)
- Save new member was enabled while conflict refetch remained pending
```

GREEN:

```text
bun run test -- src/components/bases/__tests__/BaseMemberIntake.test.tsx -t "blocks duplicate submission"
Test Files  1 passed (1)
Tests       1 passed | 12 skipped (13)
```

Required regression suite:

```text
bun run test -- src/components/bases/__tests__/BaseMemberIntake.test.tsx src/components/bases/__tests__/BaseMemberDraft.test.tsx src/components/codex/__tests__/InscribeModal.test.tsx src/components/bases/__tests__/member-creation.test.ts
Test Files  4 passed (4)
Tests       68 passed (68)
```

### Verification gates

```text
bun run typecheck
$ tsc --noEmit --project tsconfig.app.json
exit 0
```

```text
bun run lint -- src/components/bases/BaseMemberIntake.tsx src/components/bases/__tests__/BaseMemberIntake.test.tsx
Checked 2 files in 28ms. No fixes applied.
exit 0
```

### Concerns

No task-specific concern. Vitest still emits the existing Vite native-config migration warnings for `__dirname` and the extensionless `./mdx-plugin` import.
