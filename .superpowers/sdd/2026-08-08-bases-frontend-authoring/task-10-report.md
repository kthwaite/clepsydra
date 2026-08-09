# Task 10 Report — Views Editor and Unsaved Preview

## Status

Complete on top of `2fd219d`.

Committed implementation paths:

- `ui/src/components/bases/ViewsEditor.tsx`
- `ui/src/components/bases/ViewDefinitionEditor.tsx`
- `ui/src/components/bases/BasePreview.tsx`
- `ui/src/components/bases/__tests__/ViewsEditor.test.tsx`
- `ui/src/components/bases/BaseDefinitionWorkspace.tsx`
- `ui/src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx`

## Implementation

### Complete saved-view authoring

- The Views workspace preserves loaded viewless files until **Add view** is deliberately pressed. Guided editing prevents deletion of the final remaining view.
- Add and duplicate allocate fresh UUIDs. Duplicate uses `structuredClone`, so nested filters, columns, sorts, and aggregates are independent. Generated names remain unique (`View`, `View 2`, `All copy`, `All copy 2`, and so on).
- Rename and immutable move operations retain the view ID. Selection follows duplicate/add and moves to the nearest survivor after deletion.
- Each view authors table layout, ordered visible columns, ordered sort keys with direction, grouping, ordered aggregates, and an optional nested filter.
- System fields and typed declarations share one field vocabulary. Group choices are capability-gated through `canGroup`; aggregate function/field combinations are capability-gated through `aggregateFunctions`; `count` emits no field.
- The per-view filter embeds the existing `MembershipEditor` and is explicitly labelled **Additional filter; always ANDed with base membership.** Its exact nested AST flows unchanged through the draft and `toWire`.
- Unsupported layouts are retained visibly and produce an alert explaining that the guided editor supports table layout. The associated Layout select is focusable and registered to the exact diagnostic path.

### Debounced unsaved preview

- `BasePreview` submits `toWire(draft)` rather than the saved baseline, the selected view name (or no view for membership preview), `offset: 0`, and `limit: 100`.
- Draft/scope changes debounce by 250 ms. Request identity advances when a new debounce is scheduled, so an older in-flight success or failure cannot replace a newer preview.
- The preview exposes explicit selected-view and base-membership scopes.
- Loading is announced through a polite live region. Empty results provide corrective guidance without moving focus.
- Flat output states the returned count and real total, including the 100-row cap. Grouped output states group/returned-row metadata; the reused `BaseTableView` group headers show each group’s real total and aggregate values.
- Structural diagnostics, evaluation errors, and network failures render in an accessible alert. Preview diagnostics can route focus through the workspace diagnostic mechanism.
- Preview presentation reuses `BaseTableView` in its explicit read-only mode, preserving the existing typed flat/grouped query-output formatting without edit, sort, navigation, or tab-switch actions.
- Preview state is independent of workspace save diagnostics. Network or evaluation failures never disable Save.

### Workspace integration and accessibility

- The Task 10 placeholder is removed. Views and preview compose inside the existing section navigation, draft generation, conflict handling, Save/Discard flow, and Validation Summary.
- Existing Button, native labelled form controls, semantic tokens, border rhythm, typography, focus-visible styles, live regions, ordered lists, fieldsets, and table presentation are reused. No stylesheet, hardcoded colour, or parallel component convention was introduced.
- Result refresh does not focus the table. Unsupported-layout and preview failures use named alerts; all authoring controls have distinct accessible names.

## TDD Evidence

RED was observed before production components existed:

```text
FAIL src/components/bases/__tests__/ViewsEditor.test.tsx
Failed to resolve import "#/components/bases/BasePreview"

FAIL src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx
Task 10 view controls absent
```

Final focused verification:

```text
bun run --cwd ui test \
  src/components/bases/__tests__/ViewsEditor.test.tsx \
  src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx

Test Files  2 passed (2)
Tests       31 passed (31)

bun run --cwd ui typecheck
exit 0

bunx biome check --write \
  src/components/bases/ViewsEditor.tsx \
  src/components/bases/ViewDefinitionEditor.tsx \
  src/components/bases/BasePreview.tsx \
  src/components/bases/__tests__/ViewsEditor.test.tsx \
  src/components/bases/BaseDefinitionWorkspace.tsx \
  src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx
OK
```

Focused tests cover add, deep duplicate, fresh IDs, unique names, rename, move, delete guard, viewless loading, selected-survivor behavior, column order, sort order/direction, group capabilities, aggregate capabilities, count field omission, exact nested view filter AST, unsupported layout alerting, debounce, newest-draft submission, stale response suppression, membership/view scope, loading, empty, capped flat totals, grouped totals/aggregates, structural diagnostics, evaluation failure, network failure, exact Save payload, and Save eligibility after preview failure.

## Browser smoke

A real Vite session at 1280 × 900 confirmed the application mounts with the current Vessel design system. The Task 10 component-level browser path could not be completed reliably because the routed query remained pending after run-scoped request interception ended; no browser-only behavior is claimed. Responsive and accessibility behavior is covered by the focused DOM/React Aria tests and token/composition review.

## Concerns

- Preview reuses the explicit `BaseTableView` read-only mode. It retains the shared typed value formatter while removing editing, sort, tab-switch, and navigation affordances.
- The generated TypeScript schema correctly represents layout as `string`; the draft model mirrors it so manually authored unsupported values survive guided-editor round trips.
- Grouped `QueryOutput` has per-group true totals but no overall total in the API contract. The UI therefore reports returned group/row counts globally and true totals at each group heading.
- No broad test suite or broad lint run was performed, per the assignment. Final verification covers the four focused related test files, UI typecheck, and exact-path Biome check.

## Review fix round 1

The fix round resolves the Critical finding and all Important/Minor findings:

- `DraftView.layout` now preserves arbitrary persisted strings, matching the generated schema. `fromWire` defaults only omitted layouts to `table`; `toWire` preserves unsupported values. An unrelated workspace edit round-trips `board` unchanged through both preview and Save until the user explicitly selects Table.
- Workspace selection records ID, name, and ordered index for rendering, then snapshots the selected view’s current name and current index from the submitted draft at Save time. Successful response rehydration maps from that submission snapshot, so rename plus reorder cannot make stale selection-time metadata switch views.
- `BaseTableView` has an explicit `readOnly` presentation contract. Preview view labels, column headers, titles, and declared cells have no fake buttons, sorting, navigation, or commit path. Existing interactive callers retain their prior behavior.
- Diagnostic registration uses exact nested paths: view filters prefix the existing `filter...` path once, aggregate function/entry and `.field` controls register separately, and unsupported layout uses the focusable layout select. The view-list button is retained only as a fallback when the selected view has no matching rendered control.
- View field capabilities exclude `encryption`, matching the query engine’s exposed system-field contract while retaining the complete supported system vocabulary.
- Debounce cleanup is regression-tested: unmounting before 250 ms sends no request.
- Preview and unsupported-layout workspace tests assert the complete definition object rather than partial `objectContaining` payloads.

Failing-first evidence produced six expected failures: layout was coerced to table, read-only table controls remained interactive, encryption appeared as a column, nested diagnostic paths focused the list fallback, a board layout was lost from preview, and post-save rehydration selected the first view.

Final fix-round verification:

```text
bun run --cwd ui test \
  src/components/bases/__tests__/definition-model.test.ts \
  src/components/bases/__tests__/BaseTableView.test.tsx \
  src/components/bases/__tests__/ViewsEditor.test.tsx \
  src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx

Test Files  4 passed (4)
Tests       54 passed (54)

bun run --cwd ui typecheck
exit 0

bunx biome check --write <the ten exact fix-round paths>
OK
```

A second real-browser attempt used a unique routed base and run-scoped detail/preview interception. The route query again remained pending until the interception run ended. This is recorded as an environmental smoke limitation; no browser-only result is claimed and the attempt was not looped further.

## Review fix round 2

Save reconciliation now derives logical selection from the submitted draft, not the older selection-time snapshot. It locates the selected stable draft ID after all local rename/reorder operations, captures that view’s submitted name and submitted index, and maps fresh response IDs by unique submitted name with submitted index as the deterministic fallback. Reconciliation is applied only when the submitted generation wins, so edits made during Save retain their current draft and selection.

The failing-first regression selected the second view, renamed it, moved it to the first position, and returned fresh response IDs in submitted order. Before the fix, stale name/index metadata selected **All**. Final focused verification keeps **Later saved** selected and sends it as preview scope.

The report now reflects the actual generated contract (`layout?: string`) and distinguishes the unsupported-layout alert from its exact registered focus target, the native Layout select.

Final round-two verification:

```text
bun run --cwd ui test \
  src/components/bases/__tests__/definition-model.test.ts \
  src/components/bases/__tests__/BaseTableView.test.tsx \
  src/components/bases/__tests__/ViewsEditor.test.tsx \
  src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx

Test Files  4 passed (4)
Tests       54 passed (54)

bun run --cwd ui typecheck
exit 0

bunx biome check --write \
  src/components/bases/BaseDefinitionWorkspace.tsx \
  src/components/bases/definition-model.ts \
  src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx
OK
```

## Review fix round 3

Selection-only navigation during an in-flight Save now survives winning response rehydration. A synchronous selection ref tracks the latest view choice independently of `editGeneration`. When the response wins, that latest ID is resolved against the submitted draft, converted to its submitted logical name/index, and mapped to the response’s fresh IDs. The submission-time selection is used only when the latest selection cannot be resolved.

The failing-first deferred regression began Save with **All**, selected **Later** while the mutation was pending, then resolved fresh response IDs. Before the fix the response reset the editor and preview to **All**. Final behavior retains **Later** in both the editor and preview. The rename-plus-reorder regression from round 2 remains green.

Final round-three verification:

```text
bun run --cwd ui test \
  src/components/bases/__tests__/definition-model.test.ts \
  src/components/bases/__tests__/BaseTableView.test.tsx \
  src/components/bases/__tests__/ViewsEditor.test.tsx \
  src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx

Test Files  4 passed (4)
Tests       55 passed (55)

bun run --cwd ui typecheck
exit 0

bunx biome check --write \
  src/components/bases/BaseDefinitionWorkspace.tsx \
  src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx
OK
```
