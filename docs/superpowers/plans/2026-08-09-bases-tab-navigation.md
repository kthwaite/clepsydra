# Bases Property Tab Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plain Tab commit the active Bases property editor and open the next editable property in the same row, or end editing at the last editable property.

**Architecture:** `BaseTableView` owns the identity of the single active editor and derives the next editable column from the active view schema. `EditableCell` remains the display/editor lifecycle boundary, while each type-specific editor owns draft parsing and exposes a distinct valid Tab-commit callback so invalid drafts cannot advance.

**Tech Stack:** React 19, TypeScript 5.9, React Aria Components, Testing Library, user-event, Vitest, Biome.

## Global Constraints

- Plain `Tab` only; `Shift+Tab` retains current browser behavior.
- Navigation stays in the current row and never wraps.
- Skip title, system, undeclared, and read-only columns.
- Invalid drafts stay open and focused without committing.
- Enter commits and Escape cancels exactly as before.
- Use the existing `onCommitCell` property-patch path; do not add a persistence path.
- Read-only Base previews remain non-interactive.

---

### Task 1: Forward Tab Commit and Navigation

**Files:**
- Modify: `ui/src/components/bases/cells/types.ts:12-24`
- Modify: `ui/src/components/bases/cells/TextCell.tsx`
- Modify: `ui/src/components/bases/cells/NumberCell.tsx`
- Modify: `ui/src/components/bases/cells/DateCell.tsx`
- Modify: `ui/src/components/bases/cells/DateTimeCell.tsx`
- Modify: `ui/src/components/bases/cells/BoolCell.tsx`
- Modify: `ui/src/components/bases/cells/SelectCell.tsx`
- Modify: `ui/src/components/bases/cells/MultiSelectCell.tsx`
- Modify: `ui/src/components/bases/cells/RelationCell.tsx`
- Modify: `ui/src/components/bases/EditableCell.tsx`
- Modify: `ui/src/components/bases/BaseTableView.tsx`
- Test: `ui/src/components/bases/__tests__/BaseTableView.test.tsx`

**Interfaces:**
- Consumes: existing `CellValue`, `PropertyType`, `PropertyDefinition`, and `BaseTableViewProps.onCommitCell(row, key, value, hint?)`.
- Produces: `CellEditorProps.onCommitNext(value: CellValue, hint?: PropertyType): void`; controlled `EditableCellProps.isEditing`, `onEdit`, `onCancel`, and `onCommitNext`; `BaseTableView` active editor state `{ rowId: string; column: string } | null`.

- [ ] **Step 1: Write failing table behavior tests**

Add tests beside `commits an edited property cell with only the changed key` in `BaseTableView.test.tsx`. Use a view whose columns deliberately interleave inert columns:

```tsx
it("commits with Tab and opens the next editable property in the row", async () => {
  const user = userEvent.setup();
  const tabDefinition: BaseDetailResponse = {
    ...definition,
    views: [
      {
        name: "Continues",
        layout: "table",
        columns: ["title", "kind", "author", "missing", "rating"],
      },
    ],
  };
  const props = renderView({ definition: tabDefinition });

  await user.click(screen.getByRole("button", { name: "Gene Wolfe" }));
  const author = screen.getByRole("textbox", { name: "Edit text" });
  await user.clear(author);
  await user.type(author, "Ursula Le Guin");
  await user.tab();

  expect(props.onCommitCell).toHaveBeenCalledWith(
    row,
    "author",
    "Ursula Le Guin",
    undefined,
  );
  expect(screen.getByRole("textbox", { name: "Edit number" })).toHaveFocus();
});

it("commits the last editable property with Tab without wrapping rows", async () => {
  const user = userEvent.setup();
  const secondRow = {
    ...row,
    id: "02",
    path: "second.md",
    title: "A Wizard of Earthsea",
    columns: { ...row.columns, author: "Ursula Le Guin", rating: 5 },
  };
  const tabDefinition: BaseDetailResponse = {
    ...definition,
    views: [
      {
        name: "Continues",
        layout: "table",
        columns: ["title", "author", "rating"],
      },
    ],
  };
  const props = renderView({
    definition: tabDefinition,
    output: { shape: "flat", rows: [row, secondRow], total: 2 },
  });

  await user.click(screen.getByRole("button", { name: "4.5" }));
  const rating = screen.getByRole("textbox", { name: "Edit number" });
  await user.clear(rating);
  await user.type(rating, "4.75");
  await user.tab();

  expect(props.onCommitCell).toHaveBeenCalledWith(
    row,
    "rating",
    4.75,
    undefined,
  );
  expect(screen.queryByLabelText(/^Edit /)).not.toBeInTheDocument();
});

it("keeps an invalid number open when Tab cannot accept it", async () => {
  const user = userEvent.setup();
  renderView({
    definition: {
      ...definition,
      views: [
        {
          name: "Continues",
          layout: "table",
          columns: ["title", "rating", "author"],
        },
      ],
    },
  });

  await user.click(screen.getByRole("button", { name: "4.5" }));
  const rating = screen.getByRole("textbox", { name: "Edit number" });
  await user.clear(rating);
  await user.type(rating, "not-a-number");
  await user.tab();

  expect(rating).toHaveFocus();
  expect(rating).toHaveValue(null);
  expect(screen.queryByRole("textbox", { name: "Edit text" })).toBeNull();
});

it("does not use forward commit navigation for Shift+Tab", async () => {
  const user = userEvent.setup();
  const props = renderView({});

  await user.click(screen.getByRole("button", { name: "Gene Wolfe" }));
  await user.tab({ shift: true });

  expect(props.onCommitCell).not.toHaveBeenCalled();
  expect(screen.queryByRole("textbox", { name: "Edit text" })).toBeNull();
});
```

For the invalid-number assertion, prefer checking the input's displayed string if jsdom normalizes invalid `type="number"` values differently; the required contract assertions are focus retention, no commit, and no next editor.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
bun --cwd ui test src/components/bases/__tests__/BaseTableView.test.tsx
```

Expected: the new Tab tests fail because native Tab triggers `onBlur={onCancel}` and no next editor is activated. Existing tests remain green.

- [ ] **Step 3: Extend the editor contract**

In `cells/types.ts`, add a distinct callback so a type-specific editor can signal a valid commit that should advance:

```ts
export interface CellEditorProps {
  value: CellValue;
  definition: PropertyDefinition;
  onCommit: (value: CellValue, hint?: PropertyType) => void;
  onCommitNext: (value: CellValue, hint?: PropertyType) => void;
  onCancel: () => void;
}
```

Do not infer navigation from every commit: select and boolean editors already commit immediately on change, while Enter must continue to commit without advancing.

- [ ] **Step 4: Implement plain-Tab submission in every editor**

For draft-based editors, route Enter and Tab through the same parser with different callbacks. The number editor must report whether parsing succeeded:

```ts
const commit = (
  submit: CellEditorProps["onCommit"] = onCommit,
): boolean => {
  if (draft === "") {
    submit(null);
    return true;
  }
  const parsed = Number(draft);
  if (!Number.isFinite(parsed)) return false;
  submit(parsed);
  return true;
};

onKeyDown={(e) => {
  if (e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    commit(onCommitNext);
    return;
  }
  if (e.key === "Enter") commit();
  if (e.key === "Escape") onCancel();
}}
```

Apply the same plain-Tab branch to text, date, datetime, multi-select, and relation editors, preserving each editor's existing conversion and optional type hint. Each branch must call `e.preventDefault()` before submitting so `onBlur` cannot cancel the edit during the transition.

For select-like editors, submit the currently represented value on Tab:

```ts
onKeyDown={(e) => {
  if (e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    onCommitNext(current === "" ? null : current);
    return;
  }
  if (e.key === "Escape") onCancel();
}}
```

`BoolCell` uses `null`, `true`, or `false` from its current string representation. Keep its existing immediate `onChange` commit. Do not intercept `Shift+Tab` in any editor.

- [ ] **Step 5: Make `EditableCell` controlled by the table**

Replace local `editing` state with explicit lifecycle props:

```ts
interface EditableCellProps {
  value: CellValue;
  definition: PropertyDefinition;
  isEditing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onCommit: (value: CellValue, hint?: PropertyType) => void;
  onCommitNext: (value: CellValue, hint?: PropertyType) => void;
}
```

Render the editor when `isEditing` is true and pass through all three lifecycle callbacks:

```tsx
if (isEditing) {
  return (
    <Editor
      value={value}
      definition={definition}
      onCommit={onCommit}
      onCommitNext={onCommitNext}
      onCancel={onCancel}
    />
  );
}
```

The display button calls `onEdit`. The table, not `EditableCell`, decides which single cell is active.

- [ ] **Step 6: Coordinate active editor and next-column lookup in `BaseTableView`**

Import `useState`, define the active identity, and derive editability from the same conditions used to render `EditableCell`:

```ts
interface ActiveCell {
  rowId: string;
  column: string;
}

const [activeCell, setActiveCell] = useState<ActiveCell | null>(null);
const editableColumns = columns.filter(
  (column) =>
    SYSTEM_COLUMNS[column] === undefined && properties[column] !== undefined,
);

const nextEditableColumn = (column: string): string | undefined => {
  const index = editableColumns.indexOf(column);
  return index < 0 ? undefined : editableColumns[index + 1];
};
```

Wire each editable cell using `String(row.id)` consistently:

```tsx
<EditableCell
  value={(row.columns as Record<string, CellValue>)[column] ?? null}
  definition={properties[column]}
  isEditing={
    activeCell?.rowId === String(row.id) && activeCell.column === column
  }
  onEdit={() => setActiveCell({ rowId: String(row.id), column })}
  onCancel={() => setActiveCell(null)}
  onCommit={(value, hint) => {
    setActiveCell(null);
    onCommitCell(row, column, value, hint);
  }}
  onCommitNext={(value, hint) => {
    onCommitCell(row, column, value, hint);
    const nextColumn = nextEditableColumn(column);
    setActiveCell(
      nextColumn ? { rowId: String(row.id), column: nextColumn } : null,
    );
  }}
/>
```

Because the next editor mounts with `autoFocus`, changing `activeCell` focuses it without querying or traversing the DOM. The lookup never crosses a row boundary.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```bash
bun --cwd ui test src/components/bases/__tests__/BaseTableView.test.tsx
```

Expected: all `BaseTableView` tests pass, including forward movement, inert-column skipping, last-column deselection, invalid retention, Shift+Tab, Enter, and read-only behavior.

- [ ] **Step 8: Run typecheck and lint for the changed contract**

Run:

```bash
bun --cwd ui typecheck
bun --cwd ui lint
```

Expected: both commands exit 0. Fix only diagnostics caused by this task; do not reformat unrelated files.

- [ ] **Step 9: Commit the implementation**

```bash
git add ui/src/components/bases/cells/types.ts \
  ui/src/components/bases/cells/TextCell.tsx \
  ui/src/components/bases/cells/NumberCell.tsx \
  ui/src/components/bases/cells/DateCell.tsx \
  ui/src/components/bases/cells/DateTimeCell.tsx \
  ui/src/components/bases/cells/BoolCell.tsx \
  ui/src/components/bases/cells/SelectCell.tsx \
  ui/src/components/bases/cells/MultiSelectCell.tsx \
  ui/src/components/bases/cells/RelationCell.tsx \
  ui/src/components/bases/EditableCell.tsx \
  ui/src/components/bases/BaseTableView.tsx \
  ui/src/components/bases/__tests__/BaseTableView.test.tsx
git commit -m "feat(ui): navigate base properties with tab"
```

### Task 2: End-to-End Verification and Cleanup

**Files:**
- Modify only if verification exposes a defect in Task 1.
- Verify: interactive Bases route and repository-required gates.

**Interfaces:**
- Consumes: Task 1's plain-Tab behavior and existing Bases API/property mutation flow.
- Produces: browser evidence that a real Bases table commits and advances; passing UI typecheck, lint, and full test suite.

- [ ] **Step 1: Exercise the behavior in the running UI**

Start the existing development stack using the repository's documented command. Open a Bases table with at least two editable property columns in the browser, edit the first property, and press Tab.

Observe all of the following:

1. The first value changes in the table through the real property mutation path.
2. The next editable property editor opens and is focused.
3. Read-only columns between properties are skipped.
4. Tab from the last editable property closes editing without opening the next row.

If no existing vault fixture exposes two editable properties, use the existing `Bases/BaseTable` Storybook story and its supplied callbacks for the focus transition, then separately exercise one real property commit in the application.

- [ ] **Step 2: Run the full UI verification gates**

Run each command separately:

```bash
bun --cwd ui typecheck
bun --cwd ui lint
bun --cwd ui test
```

Expected: each exits 0. Report exact pass counts from Vitest.

- [ ] **Step 3: Review scope and remove accidental artifacts**

Confirm the implementation contains no DOM query/traversal, no row wrapping, no Shift+Tab interception, no second mutation path, and no generated or scratch files. Keep unrelated workspace changes untouched.

- [ ] **Step 4: Commit any verification-driven correction**

Only if Step 1 or Step 2 required a code correction, stage the exact corrected files and commit:

```bash
git commit -m "fix(ui): preserve bases tab navigation contract"
```

If no correction was needed, do not create an empty commit.
