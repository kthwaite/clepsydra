# Final frontend presentation fixes report

## Status

DONE

## Review source

`agent://FinalBasePreviewReview`

## Changes

- `BaseTableView` now resolves the selected view's label map through the existing `presentationFieldIdentity` helper. The rendered header uses the canonical label while the original column string remains the React Aria column ID and the sort, projection lookup, and edit key.
- Local draft validation now reports blank and whitespace-only preview field references as an `error` at the exact `preview[index].field` path.
- Every Preview properties row now has a field selector. A field change retains the row ID, optional label, row order, unrelated rows, and selector focus. Row and Add selectors disable fields selected elsewhere by canonical identity, including body aliases and system/property disambiguation.
- Every Display labels row now has a field selector and a separate muted, read-only stored-key display. A field change removes only the old map entry and writes the same label under the new key; sibling mappings and view configuration remain intact. Add and row selectors disable canonical duplicates across bare/qualified system aliases, body aliases, shadowed properties, and custom keys requiring `prop.` qualification. Add, field change, and Reset restore focus to an enabled control.
- No second field registry, type cast, compatibility shim, generated schema change, Rust change, or documentation change was introduced.

## Focused regressions added

- `BaseTableView.test.tsx`: canonical bare/qualified system labels, shadowed custom-property labels, body aliases, distinct per-view labels for identical columns, and retention of original sort/query/edit keys.
- `local-validation.test.ts`: empty and whitespace-only preview fields produce the exact save-blocking diagnostic.
- `PreviewPropertiesEditor.test.tsx`: in-place field replacement preserves row metadata and focus while disabling canonical duplicates.
- `ViewsEditor.test.tsx`: manual `sys.title` versus bare `title`, shadowed `title`, `prop.`-prefixed and `sys.`-prefixed custom properties, body, read-only stored keys, mapping-only replacement, and focus preservation.

## Verification

Per the assignment's concurrency constraint, no tests, typecheck, formatter, linter, build, or other behavioral verification command was executed. The changed source and focused test assertions were inspected directly for path, identity, state-preservation, and focus behavior.

## Remaining concerns

The focused tests are intentionally unexecuted in this task and must be included in the main agent's final repository verification. No known frontend implementation concern remains from the assigned findings.
