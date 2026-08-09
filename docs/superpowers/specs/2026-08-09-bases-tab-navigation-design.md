# Bases Property Tab Navigation Design

## Goal

While editing a property cell in a Bases table, plain `Tab` accepts the current draft and advances editing to the next editable property column in the same row. If the current cell is the row's last editable property column, `Tab` accepts the draft and ends cell editing without selecting another cell.

## Scope

- Applies only to editable declared-property cells in the interactive Bases table.
- Applies to plain `Tab` only. `Shift+Tab` retains its current browser behavior.
- Navigation stays within the current row and never wraps to the next row.
- Title, system, undeclared, and otherwise read-only columns are skipped.
- Existing Enter-to-commit and Escape-to-cancel behavior remains unchanged.
- Read-only Base previews remain non-interactive.

## Interaction Contract

1. A user opens an editable property cell and changes its draft.
2. Pressing plain `Tab` prevents native focus traversal.
3. The active editor validates and converts the draft using the same rules as its existing commit path.
4. When valid, the editor commits the value through the existing property patch callback.
5. The current editor closes.
6. If a later editable property column exists in the same row, that cell opens its editor and receives focus.
7. Otherwise, editing ends with no property cell selected.
8. If the draft is invalid, no commit occurs and the current editor remains open and focused.

Select-like editors that already commit immediately when their value changes still use `Tab` to accept their current value and advance. Editors must not emit a duplicate property mutation when `Tab` follows an already committed selection.

## Architecture

Use parent-coordinated navigation rather than DOM traversal.

- Extend the shared cell-editor contract with a Tab-specific commit/navigation callback that can report whether the current draft was accepted.
- Keep value parsing and validation inside each type-specific editor, alongside its existing Enter commit behavior.
- Make `EditableCell` controllable for the one transition the table needs: opening a requested editor and reporting a successful Tab commit upward.
- In `BaseTableView`, derive editable column order from the active view's columns and property definitions. The next target is the first later column that is declared, editable, and not a system column.
- Identify navigation targets by row id and column key, not by rendered DOM position. This keeps grouped tables and React Aria markup from affecting behavior.

The existing property commit path remains the sole persistence path. Navigation state coordinates focus only; it does not create a second mutation mechanism.

## Alternatives Rejected

### DOM traversal

Finding the next button/input in rendered markup would avoid explicit target state, but it couples behavior to React Aria's DOM structure and can accidentally cross rows, groups, or unrelated controls.

### Fully controlled table selection

Lifting all edit state into `BaseTableView` would provide a general grid-selection model, but it is unnecessary for forward-only Tab navigation and would broaden the change substantially.

## Error Handling

- Existing property mutation failures continue through the current optimistic-update and refresh behavior.
- A locally invalid draft does not close or advance the editor.
- Missing or stale target cells degrade to ending the edit; navigation must not block a valid commit.

## Verification

Add focused UI tests that prove observable behavior:

- `Tab` commits a text draft and opens the next editable property in the same row.
- Navigation skips title, system, undeclared, and read-only columns.
- `Tab` on the last editable property commits and leaves no editor open.
- Navigation does not wrap to the next row.
- An invalid number remains in its current editor and does not commit or advance.
- `Shift+Tab` does not invoke the new forward-navigation path.
- Existing Enter, Escape, read-only preview, and property-commit tests continue to pass.

After implementation, run the affected Vitest file, the UI smoke scenario in a browser, then the repository-required UI typecheck, lint, and full test suite.
