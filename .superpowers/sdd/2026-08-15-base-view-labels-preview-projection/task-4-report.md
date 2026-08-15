# Task 4 Report: Frontend draft model and authoring controls

## Status

DONE

## RED evidence

Model RED:

```text
bun run test -- src/components/bases/__tests__/definition-model.test.ts
# exit 1; 4 failed, 9 passed
# draft.preview was undefined, preview row IDs/conversion were absent,
# and createMinimalDraft had no presentation defaults.
```

Local-validation RED:

```text
bun run test -- src/components/bases/__tests__/local-validation.test.ts
# exit 1; 3 failed, 6 passed
# no empty-label, canonical duplicate, or unknown-reference diagnostics existed.
```

Editor RED:

```text
bun run test -- src/components/bases/__tests__/PreviewPropertiesEditor.test.tsx
# exit 1; PreviewPropertiesEditor module was absent.

bun run test -- src/components/bases/__tests__/ViewsEditor.test.tsx
# exit 1; the Display labels controls were absent. The run also exposed the
# owned BasePreview payload fixture that needed the new draft preview default.

bun run test -- src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx
# exit 1; 4 new presentation-navigation/lifecycle/focus tests failed.
```

Each RED was observed before its corresponding production implementation.

## Implementation

- Added generated-contract-derived `DraftPreviewField`, `BaseDraft.preview`, and `DraftView.labels` without a duplicate wire interface or casts. Conversion supplies client-only row IDs, strips them on the wire, preserves order, clones mutable presentation data, materializes defaults, and leaves source/returned objects isolated.
- Added local diagnostics at backend-compatible paths for blank preview/view labels, repeated canonical preview identities, unknown system references, and undeclared properties. Body aliases and qualified system/property shadows resolve consistently.
- Added a Base-level Preview properties section immediately after Properties. It supports canonical field choices, injective `prop.` qualification, one read-only body choice, duplicate reasons, optional labels, keyboard-operable move controls, focus preservation, announcements, removal, and exact diagnostic targets.
- Added per-view Display labels for all presentation fields, including fields outside visible columns and body. Add/edit/Reset changes only `labels`; existing columns, sort, filter, aggregates, and declarations remain unchanged.
- Extended Save/Discard/conflict behavior through the existing workspace lifecycle. Save sends both presentation additions, Discard restores them, edits remain local before Save, and successful responses retain submitted preview row IDs.
- Migrated all Task 4-owned fixtures to the required draft presentation defaults and payload shape.

## GREEN evidence

```text
bun run test -- src/components/bases/__tests__/definition-model.test.ts src/components/bases/__tests__/local-validation.test.ts src/components/bases/__tests__/PreviewPropertiesEditor.test.tsx src/components/bases/__tests__/ViewsEditor.test.tsx src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx
# 5 files passed; 95 tests passed; 0 failed
```

## TypeScript boundary

```text
bun run typecheck
# exit 2; exactly 4 pre-existing generated-contract consumer fixture errors remain:
# src/api/bases.test.ts: three TS1360 missing-required-preview fixtures
# src/components/codex/__tests__/FolioProperties.test.tsx: one TS2741 missing-required-preview fixture
```

No Task 4 production or owned-test diagnostic remains. These are the four Task 3-recorded downstream page-projection fixtures assigned outside this exact-path task.

## Self-review

- Confirmed canonical identity handling for `body`, system/property shadows, and `prop.`-prefixed custom keys; field choices emit the backend projection's injective custom wire spelling.
- Confirmed no presentation edit mutates unrelated view/property structures and no generated file was hand-edited.
- Confirmed preview row focus/identity survive reorder and successful save, exact server diagnostic paths reach their controls, and blank optional preview labels can be removed without synthesizing an empty wire label.
- `git diff --check` passed. Per brief, no formatter, linter, build, broad suite, or unrelated fixture edit was run.

## Remaining concerns

Only the four expected cross-task required-page-preview fixture errors above remain. No Task 4 concern remains.

## Review corrections

Review found that custom keys beginning with `sys.` were emitted bare and that
post-mutation focus could remain on a disabled or detached button.

Review RED:

```text
bun run test -- src/components/bases/__tests__/PreviewPropertiesEditor.test.tsx src/components/bases/__tests__/ViewsEditor.test.tsx src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx src/components/bases/__tests__/local-validation.test.ts
# exit 1; 4 failed
# Preview: sys-prefixed choices were not qualified; Add and sole-row Remove
# did not restore focus.
# Display labels: sys-prefixed custom keys were not qualified.
```

Corrections:

- Custom keys beginning with either reserved grammar prefix now emit
  `prop.prop.*` or `prop.sys.*`. Tests cover Preview and Display-label choices
  for `prop.title`, `sys.title`, and `sys.custom`. Direct resolution coverage
  proves bare `sys.title` is system, bare unknown `sys.custom` is invalid
  system grammar, and explicitly qualified `prop.sys.*` keys are properties.
- Preview Add focuses the new label input; Move focuses an enabled action on
  the moved logical row and falls back to the opposite direction at either
  boundary; Remove focuses the next/previous row label or the selector.
  Element and input maps use callback-ref deletion on unmount rather than
  caching whichever button happened to receive focus.
- Display-label Reset focuses the stable enabled field selector.
- A deterministic `crypto.randomUUID` successful-save regression proves the
  original preview row input and DOM row survive response hydration rather
  than receiving the response draft's fresh row identity.

Focused correction GREEN:

```text
bun run test -- src/components/bases/__tests__/PreviewPropertiesEditor.test.tsx
# 4 passed; 0 failed

bun run test -- src/components/bases/__tests__/ViewsEditor.test.tsx
# 34 passed; 0 failed

bun run test -- src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx
# 34 passed; 0 failed
```
