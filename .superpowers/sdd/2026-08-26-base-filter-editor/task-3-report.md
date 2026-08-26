# Task 3 evidence report

## Result

Implemented the clean `BaseFilterEditor` cutover.

- Replaced the public `MembershipEditor` symbol and file with `BaseFilterEditor`.
- Moved the recursive editor into `BaseFilterEditor.tsx` as private `FilterNodeEditor`.
- Centralized nested edits through one `dispatch(FilterTreeAction)` function and `updateFilterTree`.
- Preserved immediate identified-row reconciliation for append, movement, wrapping, and removal.
- Constructed one diagnostic scope per recursive node and passed scoped bindings to both leaf editors.
- Made `registerFocus` optional at the public seam.
- Migrated `BaseDefinitionWorkspace`, `ViewDefinitionEditor`, `BaseEmbedInspector`, and `CreateBaseDialog`.
- Preserved the real workspace registrars and exact saved-view diagnostic root.
- Removed no-op registrars from the embed inspector and create dialog.
- Deleted both obsolete public modules without aliases or re-exports.
- Renamed and expanded the public behavior suite. Added literal contracts for optional registration, nested NOT wrapping, nested-NOT collapse, group append, exact sibling movement, controlled root replacement, and one root change per authoring action.
- Existing caller tests already rendered their real callers. Their root draft update, exact `views[0].filter` routing, embed reset/preservation, and create-dialog submission assertions were retained and exercised unchanged.

## Strict RED-GREEN evidence

### RED: missing public seam

Command:

```text
bun run test -- src/components/bases/__tests__/BaseFilterEditor.test.tsx src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx src/components/bases/__tests__/ViewsEditor.test.tsx src/components/bases/__tests__/BaseEmbedInspector.test.tsx
```

Observed result: exit 1. Three caller suites passed. `BaseFilterEditor.test.tsx` failed before collection because `#/components/bases/BaseFilterEditor` did not exist. This was the expected missing-feature failure before production migration.

### GREEN: cutover and internal contracts

Command:

```text
bun run test -- src/components/bases/__tests__/BaseFilterEditor.test.tsx src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx src/components/bases/__tests__/ViewsEditor.test.tsx src/components/bases/__tests__/BaseEmbedInspector.test.tsx src/components/bases/__tests__/TagConditionEditor.test.tsx src/components/bases/__tests__/filter-tree.test.ts src/components/bases/__tests__/filter-diagnostics.test.ts
```

Observed result: exit 0. Seven files passed. 187 tests passed. The runner emitted only the existing Vite native-config warning.

## Static verification

### Typecheck

Command:

```text
bun run typecheck
```

Observed result: exit 0. `tsc --noEmit --project tsconfig.app.json` completed without diagnostics.

### Production lint

Command:

```text
bun run lint -- src/components/bases/BaseFilterEditor.tsx src/components/bases/FilterComparisonEditor.tsx src/components/bases/TagConditionEditor.tsx src/components/bases/filter-tree.ts src/components/bases/filter-diagnostics.ts src/components/bases/BaseDefinitionWorkspace.tsx src/components/bases/ViewDefinitionEditor.tsx src/components/bases/BaseEmbedInspector.tsx src/components/bases/CreateBaseDialog.tsx
```

Observed result: exit 0. Biome checked nine files with no diagnostics or fixes.

### Public-test lint

Command:

```text
bun run lint -- src/components/bases/__tests__/BaseFilterEditor.test.tsx
```

Observed result: exit 0. Biome checked the file with no diagnostics or fixes.

### Executable callsite exhaustion

A case-sensitive search of `ui/src` for `MembershipEditor|FilterGroupEditor` returned no matches after migration. A search for `BaseFilterEditor` found the public module, its test, and exactly the four production callers.

`git diff --check` exited 0 with no output before commit.

## Commit

`044ff7aa refactor(bases): deepen Base filter editor module`

## Concerns

No implementation concern. The plan's illustrative nested-NOT test names the action `Wrap in NOT`; the existing behavior-preserving control label is `Negate condition`, so the public contract uses that existing label. The existing Vite native-config warning remains unrelated.

## Round 1/5 fix evidence

### Coverage added

- Added non-root append and move contracts inside both nested `all` and nested `any` groups.
- Added a complete-root replacement contract for a leaf below `all` → `any` → `not`.
- Added a complete-root replacement contract for a nested NOT child through its own seed menu.
- Every recursive action asserts the literal complete next root and exactly one new `onChange` call.
- Added duplicate-sibling identity contracts using native input references, focus, an uncommitted freeform draft, controlled movement, and occurrence-specific removal.
- Replaced the permissive recursive focus assertion with an exact live path-to-element registry. It rejects extra live keys and checks native field trigger, operator trigger, and value-control identity for both nested leaves.
- No production change was required.

### RED: unsupported action-menu focus seam

Command:

```text
bun run test -- src/components/bases/__tests__/BaseFilterEditor.test.tsx
```

Observed result: exit 1. One file ran; 28 tests ran; 2 failed and 26 passed. Both first-draft identity cases expected one call but observed two. Opening the action menu blurred the freeform `in` input and committed its draft before the move/remove action. This established that action-menu focus cannot represent an in-progress draft. The tests were narrowed to the supported controlled-rerender seam for draft/focus preservation, while keeping occurrence-specific menu removal coverage.

### RED: index-key mutation resistance

Temporary mutation: changed the recursive child wrapper from `key={id}` to `key={index}`.

Command:

```text
bun run test -- src/components/bases/__tests__/BaseFilterEditor.test.tsx -t "duplicate occurrence|equal-reference duplicate"
```

Observed result: exit 1. One file failed; 2 selected tests failed and 26 were skipped. Controlled movement retained the first-position input instead of the moved occurrence, transferred the draft to the wrong row, and failed element identity. Equal-reference removal retained the removed occurrence's input. The temporary mutation was reverted.

### RED: broken `setChildRows` removal reconciliation

Temporary mutation: removed the immediate `setChildRows` filter from `onRemove`, leaving only the root dispatch.

Command:

```text
bun run test -- src/components/bases/__tests__/BaseFilterEditor.test.tsx -t "equal-reference duplicate"
```

Observed result: exit 1. One file failed; 1 selected test failed and 27 were skipped. The remaining equal-reference value reused the removed occurrence's input instead of the intended survivor. The temporary mutation was reverted.

### GREEN: expanded public editor suite

Command:

```text
bun run test -- src/components/bases/__tests__/BaseFilterEditor.test.tsx
```

Observed result: exit 0. One file passed; 28 tests passed. The runner emitted only the existing Vite native-config warning.

### GREEN: required focused suite

Command:

```text
bun run test -- src/components/bases/__tests__/BaseFilterEditor.test.tsx src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx src/components/bases/__tests__/ViewsEditor.test.tsx src/components/bases/__tests__/BaseEmbedInspector.test.tsx src/components/bases/__tests__/TagConditionEditor.test.tsx src/components/bases/__tests__/filter-tree.test.ts src/components/bases/__tests__/filter-diagnostics.test.ts
```

Observed result: exit 0. Seven files passed; 195 tests passed. The runner emitted only the existing Vite native-config warning.

### Static verification

Command:

```text
bun run typecheck
```

Observed result: exit 0. `tsc --noEmit --project tsconfig.app.json` completed without diagnostics.

Command:

```text
bun run lint -- src/components/bases/__tests__/BaseFilterEditor.test.tsx
```

Observed result: exit 0. Biome checked one file with no diagnostics or fixes.
