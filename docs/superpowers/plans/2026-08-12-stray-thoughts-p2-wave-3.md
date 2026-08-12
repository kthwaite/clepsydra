# Stray Thoughts P2 Wave 3 Implementation Plan

**Goal:** Replace Base property and visible-column lists with accessible reorderable tables, and add one protected, read-only body excerpt column per saved view.

**Source design:** `docs/superpowers/specs/2026-08-11-stray-thoughts-p2-program-design.md`, Wave 3.

## Global constraints

- Work in an isolated feature worktree branched from `develop`.
- Follow strict TDD: add one observable failing test, run it and record the expected failure, implement the minimum production change, then rerun it green.
- `bases/*.base.toml` remains authoritative. Reordering changes only the unsaved complete-definition draft; only the existing explicit Save action persists through the revision-guarded full-definition update.
- Property keys and visible-column keys remain stable. Reordering or removing declarations never mutates page frontmatter.
- `body` is a view-only system column. It cannot be declared as a property, filtered, sorted, grouped, aggregated, or edited inline.
- Each saved view may contain `body` at most once. Different views may each contain it once.
- Shared Rust validation is authoritative: malformed files and API payloads receive diagnostics even when the UI prevents authoring the state.
- Base evaluation supplies body excerpts in the existing bounded response. Rendering may not issue per-row page-detail requests.
- Body excerpts are plain text, at most 240 Unicode scalar values including a terminal ellipsis when truncated. Empty bodies produce an empty string. Encrypted/protected rows produce JSON `null`, never ciphertext or decrypted content.
- Body cells open the row's Folio through the existing `onOpenPage(path)` path. They are never editable cells.
- Reorder controls support pointer drag, deterministic Move up/down controls, and keyboard `Alt+ArrowUp` / `Alt+ArrowDown` on an explicitly named handle. A polite live region announces the moved item and new 1-based position.
- Narrow layouts retain every action and never require a horizontal drag gesture.
- Save conflicts retain the unsaved reordered draft and continue to use the existing reload/discard conflict UI.
- Do not add compatibility aliases, duplicate persistence paths, or a body page-fetch hook.
- Every implementation task is committed separately and receives task-scoped spec/quality review. Finish with a whole-branch review.

## Task 1: Define and project the body system column

**Files:**
- Modify `src/vault/base.rs`
- Modify `src/vault/query.rs`
- Modify focused Rust tests in those modules and/or `tests/bases_api.rs`
- Regenerate `ui/src/api/schema.d.ts` only after the Rust contract is green

**RED:**
1. Add validation tests proving a property named `body` is rejected, duplicate `body` entries in one view produce a diagnostic, and one `body` entry in each of two views is valid.
2. Add query/API tests proving a requested `body` column is returned in `QueryRow.columns`, is plain text and bounded to 240 Unicode scalar values, and does not require a page-detail request.
3. Add protected-row coverage proving encrypted page content projects as JSON `null` and no armored payload fragment appears.
4. Add capability tests proving `body` is rejected in filters, sort keys, grouping, and aggregates rather than silently becoming a general query field.
5. Run the focused Rust tests and record failures caused by the missing field/validation/projection.

**GREEN:**
1. Reserve `body` against ordinary property declarations without turning it into a generally filterable/sortable system field.
2. Validate view columns for duplicate `body` entries while allowing one per view.
3. Extend only the query column-materialization path to project a body excerpt from the already indexed page body. Use a set-based join/subquery, not filesystem reads or row-by-row requests.
4. Convert Markdown to bounded plain text in Rust. Preserve readable text/code/link labels, normalize whitespace, and truncate by Unicode scalar count to the exact contract above.
5. Return JSON `null` whenever the indexed row is encrypted/protected.
6. Run focused tests green, then regenerate OpenAPI/client types and verify the generated diff contains only the intended contract changes.

**Commit:** `feat(bases): project protected body excerpts`

## Task 2: Convert property declarations to a reorderable table

**Files:**
- Modify `ui/src/components/bases/PropertiesEditor.tsx`
- Modify `ui/src/components/bases/PropertyDefinitionEditor.tsx`
- Add a small shared reorder primitive under `ui/src/components/bases/` only if both property and column tables can use it without hiding semantics
- Modify `ui/src/components/bases/__tests__/PropertiesEditor.test.tsx`

**RED:**
1. Add rendered-behavior tests for table semantics, stable key/type summaries, edit/remove actions, and existing configuration editors.
2. Add pointer drag tests that move a declaration in the supplied draft and do not call any persistence mutation.
3. Add keyboard-handle tests for `Alt+ArrowUp` / `Alt+ArrowDown`, boundary behavior, focus retention, and polite position announcements.
4. Add narrow-layout assertions proving Move up/down, Edit, and Remove remain available without horizontal dragging.
5. Add workspace-level tests proving Save serializes the reordered complete definition, Discard restores loaded order, and a revision conflict retains the unsaved order.
6. Run the focused Vitest file(s) and record expected failures against the current ordered-card list.

**GREEN:**
1. Render declarations as a compact semantic table with columns for reorder handle, stable key, type/configuration summary, and actions.
2. Keep advanced type/option/relation configuration available through an explicit row Edit action; do not duplicate the configuration state.
3. Implement pointer drag on the named handle and deterministic Move up/down controls. All paths call the existing `onChange(moveItem(...))` draft update only.
4. Implement keyboard movement on the handle, restore focus to the moved handle after rerender, and announce the new position through a shared polite live region.
5. Preserve current rename/remove confirmation behavior and property IDs.
6. Run the focused property/workspace tests green.

**Commit:** `feat(bases): table property declarations`

## Task 3: Convert visible columns and author the unique body field

**Files:**
- Modify `ui/src/components/bases/ViewDefinitionEditor.tsx`
- Modify `ui/src/components/bases/PropertiesEditor.tsx` only for the shared system-field vocabulary if required
- Modify `ui/src/components/bases/__tests__/ViewsEditor.test.tsx`
- Modify `ui/src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx` as needed

**RED:**
1. Add tests for semantic table rendering, pointer reorder, keyboard-handle reorder/focus/announcement, Move up/down boundaries, and Remove.
2. Add tests proving `body` appears in the add-column picker, disappears after being selected in that view, and remains independently selectable in another view.
3. Add tests proving body never appears in the property declaration type/key flow, sort/group/aggregate pickers, or inline-edit affordances.
4. Add save/discard/conflict tests for reordered columns through the existing complete-definition draft.
5. Run focused view/workspace tests and record the expected failures.

**GREEN:**
1. Render visible columns as the same compact accessible reorderable-table pattern used by declarations.
2. Add `body` only to view-column capabilities. Keep general filter/sort/group/aggregate capability lists unchanged.
3. Reuse draft `onChange` and explicit Save; do not add a mutation or preference store.
4. Keep all controls usable in narrow layouts.
5. Run focused view/workspace tests green.

**Commit:** `feat(bases): table visible columns`

## Task 4: Render body excerpts as Folio links

**Files:**
- Modify `ui/src/components/bases/BaseTableView.tsx`
- Modify `ui/src/components/bases/__tests__/BaseTableView.test.tsx`
- Modify route/controller integration tests only where needed to prove no extra fetch and correct Folio opening

**RED:**
1. Add flat and grouped-output tests proving a body cell renders the bounded plain-text value supplied in `row.columns.body` and invokes `onOpenPage(row.path)`.
2. Add tests proving `null` protected bodies and empty bodies reveal no content and remain non-editable.
3. Add tests proving the body column never reaches `EditableCell`, never becomes sortable, and rendering performs no page-detail fetch.
4. Add a narrow-layout rendering assertion for a usable named body-cell control.
5. Run focused Vitest files and record expected failures.

**GREEN:**
1. Treat `body` as an explicitly read-only, non-sortable system column.
2. Render the supplied excerpt in a named button/link-like control that opens the row Folio through `onOpenPage` and exposes no inline editor.
3. Render protected/empty values without leaking metadata or introducing another request.
4. Run focused tests green.

**Commit:** `feat(bases): open body excerpts in Folio`

## Task 5: Review, smoke, verify, and integrate Wave 3

**Files:**
- Test/support files only for defects discovered during review or smoke
- Update `Clepsydra: Stray Thoughts` through the vault MCP only after merged verification

1. Package and perform a whole-branch code review against the Wave 3 source design. Fix all Critical/Important findings with focused regression tests and one scoped re-review.
2. Run focused Rust Bases tests and focused UI Bases tests.
3. Run a real browser smoke against a disposable vault:
   - open a Base definition;
   - pointer-reorder and keyboard-reorder declarations and columns;
   - verify live announcements and focus retention;
   - Discard and observe loaded order return;
   - reorder again, Save, reload, and observe persisted order;
   - add one body column to two different views while duplicate selection stays unavailable within each view;
   - view plain-text excerpts, open a row Folio from the body cell, and verify protected content is absent;
   - repeat core actions at a mobile viewport without horizontal dragging.
4. Run all repository gates in the feature worktree:
   - `bun run typecheck`
   - `bun run lint`
   - `bun run test`
   - `bun run build`
   - `cargo fmt --check`
   - `cargo clippy --all-targets --all-features -- -D warnings`
   - `cargo test`
5. Commit any reviewed smoke corrections separately.
6. Merge the feature branch into `develop` while preserving unrelated local changes, then rerun the same gates on merged `develop`.
7. Remove the merged worktree and feature branch.
8. Mark only these two source-note items complete through the vault MCP:
   - Bases properties/columns as reorderable tables.
   - Bases can expose page body as a unique field.
