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
- Unsupported layouts are retained visibly and produce a focusable alert explaining that the guided editor supports table layout. Server diagnostic paths register against view controls and remain navigable from Validation Summary.

### Debounced unsaved preview

- `BasePreview` submits `toWire(draft)` rather than the saved baseline, the selected view name (or no view for membership preview), `offset: 0`, and `limit: 100`.
- Draft/scope changes debounce by 250 ms. Request identity advances when a new debounce is scheduled, so an older in-flight success or failure cannot replace a newer preview.
- The preview exposes explicit selected-view and base-membership scopes.
- Loading is announced through a polite live region. Empty results provide corrective guidance without moving focus.
- Flat output states the returned count and real total, including the 100-row cap. Grouped output states group/returned-row metadata; the reused `BaseTableView` group headers show each group’s real total and aggregate values.
- Structural diagnostics, evaluation errors, and network failures render in an accessible alert. Preview diagnostics can route focus through the workspace diagnostic mechanism.
- Preview presentation reuses `BaseTableView`. Passing an empty property declaration map keeps preview cells read-only while preserving the existing flat/grouped query-output formatting.
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

- Preview deliberately reuses `BaseTableView` without changing its public contract. Declared preview properties are hidden from the table definition to prevent cell editing; this also means preview values use the table’s read-only generic formatter rather than editable typed cells.
- The backend-generated TypeScript schema currently exposes only `layout: "table"`. The unsupported-layout UI is defensive for manually authored/future definitions and complements server/preview diagnostics.
- Grouped `QueryOutput` has per-group true totals but no overall total in the API contract. The UI therefore reports returned group/row counts globally and true totals at each group heading.
- No broad test suite or broad lint run was performed, per the assignment. Verification was limited to the two focused test files, UI typecheck, and exact-path Biome check.
