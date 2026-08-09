# Folio Tag Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add New Entry-style tag autosuggestions to the folio tag editor without changing folio styling, derived-tag behavior, or free-form tag entry.

**Architecture:** Extend the shared folio `TagInput` with an optional suggestion list and the established `TagsInput` combobox interaction contract. Load the existing vault tag index in `Folio`, then pass tag names through `PageEditorHeader` only to the tag control; aliases remain suggestion-free.

**Tech Stack:** React 19, TypeScript 5.9, React Aria Components, TanStack Query, Testing Library, Vitest, Biome, Vite.

## Global Constraints

- Match New Entry behavior: case-insensitive substring filtering, first-match highlight, Arrow Up/Down navigation, Tab completion, Enter selection after navigation, and Escape dismissal.
- Preserve raw tag creation with Enter, comma, and blur.
- Preserve empty-Tab focus navigation, empty-draft Backspace removal, derived tags, and folio blur-save.
- Exclude existing editable and derived tags from suggestions.
- Keep the tag index optional: loading or query failure must not block editing or saving.
- Do not offer tag suggestions to the aliases editor.
- Make no API or backend changes and add no dependencies.

---

### Task 1: Optional autosuggest behavior in `TagInput`

**Files:**
- Modify: `ui/src/components/ui/tag-input.tsx:1-157`
- Test: `ui/src/components/ui/__tests__/tag-input.test.tsx:1-225`

**Interfaces:**
- Consumes: existing `TagInputProps` fields and `values`/`readOnlyValues` state.
- Produces: optional `suggestions?: string[]` on `TagInputProps`; when omitted, current behavior is unchanged.

- [ ] **Step 1: Add failing filtering and exclusion tests**

Append tests that render known tags, type a substring, and assert only eligible matches are exposed:

```tsx
it("shows matching suggestions and excludes attached and derived tags", async () => {
  const user = userEvent.setup();
  render(
    <TagInput
      label="Tags"
      values={["rust"]}
      readOnlyValues={["journal"]}
      suggestions={["rust", "journal", "ritual", "slate"]}
      onChange={() => {}}
    />,
  );

  await user.type(screen.getByRole("combobox", { name: "Add tags" }), "ri");

  expect(screen.getByRole("option", { name: "ritual" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "rust" })).toBeNull();
  expect(screen.queryByRole("option", { name: "journal" })).toBeNull();
  expect(screen.queryByRole("option", { name: "slate" })).toBeNull();
});
```

Also assert the list is absent for empty input and for a `TagInput` without `suggestions`.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
bun --cwd ui run test -- src/components/ui/__tests__/tag-input.test.tsx
```

Expected: FAIL because `suggestions` is not a `TagInputProps` field and the textbox has no combobox/listbox semantics.

- [ ] **Step 3: Add failing keyboard parity tests**

Add tests for Tab, arrow-navigation plus Enter, Escape, and plain Enter:

```tsx
it("tab-completes the highlighted suggestion", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <TagInput
      label="Tags"
      values={[]}
      suggestions={["rust", "ritual"]}
      onChange={onChange}
    />,
  );

  await user.type(screen.getByRole("combobox", { name: "Add tags" }), "ru");
  await user.keyboard("{Tab}");

  expect(onChange).toHaveBeenLastCalledWith(["rust"]);
});

it("commits the arrow-highlighted suggestion on Enter", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <TagInput
      label="Tags"
      values={[]}
      suggestions={["rust", "react", "ritual"]}
      onChange={onChange}
    />,
  );

  await user.type(screen.getByRole("combobox", { name: "Add tags" }), "r");
  await user.keyboard("{ArrowDown}{Enter}");

  expect(onChange).toHaveBeenLastCalledWith(["react"]);
});

it("dismisses suggestions with Escape without committing the draft", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <TagInput
      label="Tags"
      values={[]}
      suggestions={["rust"]}
      onChange={onChange}
    />,
  );

  await user.type(screen.getByRole("combobox", { name: "Add tags" }), "ru");
  await user.keyboard("{Escape}");

  expect(screen.queryByRole("listbox", { name: "Tag suggestions" })).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});
```

Retain the existing `adds tag on Enter` test as the raw-entry regression contract.

- [ ] **Step 4: Implement optional suggestion state and matching**

Update React imports to include `useId`; add a shared limit matching New Entry and the optional prop:

```tsx
const MAX_SUGGESTIONS = 5;

export interface TagInputProps {
  label: string;
  values: string[];
  readOnlyValues?: string[];
  suggestions?: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  className?: string;
  onBlur?: () => void;
}
```

Inside `TagInput`, default `suggestions = []`, then track selection and dismissal:

```tsx
const [highlight, setHighlight] = useState(0);
const [navigated, setNavigated] = useState(false);
const [dismissed, setDismissed] = useState(false);
const listId = useId();
const query = inputValue.trim();
const queryLower = query.toLowerCase();
const matches = query
  ? suggestions
      .filter(
        (suggestion) =>
          suggestion.toLowerCase().includes(queryLower) &&
          !values.includes(suggestion) &&
          !readOnlyValues.includes(suggestion),
      )
      .slice(0, MAX_SUGGESTIONS)
  : [];
const open = !dismissed && matches.length > 0;
const selected = Math.min(highlight, Math.max(matches.length - 1, 0));
```

Reset `highlight`, `navigated`, and `dismissed` whenever the draft changes or a value is committed. Extend `handleKeyDown` in this precedence order: Arrow Down, Arrow Up, Tab while open, Enter, comma, Backspace, Escape while open. Enter chooses `matches[selected]` only after arrow navigation; otherwise it commits `query`. Escape calls both `preventDefault()` and `stopPropagation()`.

Render the input with:

```tsx
role="combobox"
aria-expanded={open}
aria-controls={open ? listId : undefined}
aria-activedescendant={open ? `${listId}-${selected}` : undefined}
aria-autocomplete="list"
```

Make the root container `relative`, then render the listbox after the input. Use `onMouseDown` so selecting an option does not trigger raw-draft blur first:

```tsx
{open && (
  <ul
    id={listId}
    role="listbox"
    aria-label="Tag suggestions"
    className="absolute left-0 right-0 top-full z-10 m-0 max-h-[200px] list-none overflow-auto border border-border bg-background p-0.5"
  >
    {matches.map((suggestion, index) => (
      <li
        key={suggestion}
        id={`${listId}-${index}`}
        role="option"
        aria-selected={index === selected}
        onMouseDown={(event) => {
          event.preventDefault();
          addValue(suggestion);
        }}
        className={cn(
          "cursor-pointer px-2 py-1 text-xs",
          index === selected && "bg-muted font-bold",
        )}
      >
        {suggestion}
      </li>
    ))}
  </ul>
)}
```

Keep blur behavior as: commit any raw draft, then call `onBlur` once.

- [ ] **Step 5: Run focused component tests**

Run:

```bash
bun --cwd ui run test -- src/components/ui/__tests__/tag-input.test.tsx
```

Expected: all `TagInput` tests PASS, including pre-existing chip, remove, blur, comma, raw Enter, Backspace, and read-only-tag tests.

- [ ] **Step 6: Commit the component contract**

```bash
git add ui/src/components/ui/tag-input.tsx ui/src/components/ui/__tests__/tag-input.test.tsx
git commit -m "feat(ui): add optional tag input suggestions"
```

---

### Task 2: Wire the vault tag index into folio tags

**Files:**
- Modify: `ui/src/editor/PageEditorHeader.tsx:4-120`
- Modify: `ui/src/components/codex/Folio.tsx:1-290`
- Test: `ui/src/editor/__tests__/PageEditorHeader.test.tsx:6-54`
- Test: `ui/src/components/codex/__tests__/Folio.test.tsx:9-164`

**Interfaces:**
- Consumes: Task 1 `TagInputProps.suggestions?: string[]`; existing `useTags(enabled?: boolean)` returning tag-count records.
- Produces: required `tagSuggestions: string[]` on `PageEditorHeaderProps`, passed only to the `label="Tags"` input.

- [ ] **Step 1: Add a failing header routing test**

Extend `baseProps` with `tagSuggestions: []`, then add a test proving suggestions are visible for tags but absent from aliases:

```tsx
it("offers vault suggestions only for tags", async () => {
  const user = userEvent.setup();
  render(
    <PageEditorHeader
      {...baseProps}
      aliases={["existing alias"]}
      tagSuggestions={["research"]}
    />,
  );

  await user.type(screen.getByRole("combobox", { name: "Add tags" }), "res");
  expect(screen.getByRole("option", { name: "research" })).toBeInTheDocument();

  await user.keyboard("{Escape}");
  await user.type(screen.getByRole("textbox", { name: "Add aliases" }), "res");
  expect(screen.queryByRole("option", { name: "research" })).toBeNull();
});
```

- [ ] **Step 2: Run the header test and confirm failure**

Run:

```bash
bun --cwd ui run test -- src/editor/__tests__/PageEditorHeader.test.tsx
```

Expected: FAIL because `PageEditorHeaderProps` does not accept or forward `tagSuggestions`.

- [ ] **Step 3: Forward suggestions through `PageEditorHeader`**

Add and destructure the required prop:

```tsx
interface PageEditorHeaderProps {
  // existing fields
  tagSuggestions: string[];
}
```

Pass it only to the tag control:

```tsx
<TagInput
  label="Tags"
  values={tags}
  readOnlyValues={derivedTags}
  suggestions={tagSuggestions}
  onChange={onTagsChange}
  onBlur={flush}
  placeholder="Add tag..."
  className="mt-2 max-md:mt-0 max-md:w-full"
/>
```

Do not add `suggestions` to the aliases `TagInput`.

- [ ] **Step 4: Add a failing folio integration test**

Hoist a `useTagsMock`, expose it from the existing `#/api/index` mock, and reset it to return known tags before each test:

```tsx
useTagsMock: vi.fn(() => ({
  data: [
    { tag: "research", count: 4 },
    { tag: "ritual", count: 1 },
  ],
})),
```

Add an editable-folio test:

```tsx
it("suggests indexed tags while editing folio tags", async () => {
  const user = userEvent.setup();
  usePageEditorMock.mockReturnValue(editableEditor());

  render(<Folio tabId="t1" path="notes/alpha.md" />);
  await user.type(screen.getByRole("combobox", { name: "Add tags" }), "res");

  expect(screen.getByRole("option", { name: "research" })).toBeInTheDocument();
});
```

- [ ] **Step 5: Run the folio test and confirm failure**

Run:

```bash
bun --cwd ui run test -- src/components/codex/__tests__/Folio.test.tsx
```

Expected: FAIL because `Folio` does not call `useTags` or provide tag suggestions.

- [ ] **Step 6: Load and map the tag index in `Folio`**

Import `useTags` beside the existing index hooks and call it unconditionally with the other folio queries:

```tsx
import { useBacklinks, useOutlinks, useSimilar, useTags } from "#/api/index";

const { data: tagIndex } = useTags();
const tagSuggestions = useMemo(
  () => (tagIndex ?? []).map(({ tag }) => tag),
  [tagIndex],
);
```

Pass `tagSuggestions={tagSuggestions}` to `PageEditorHeader`. An undefined tag index maps to `[]`, so editing remains available during loading or errors.

- [ ] **Step 7: Run both integration test files**

Run:

```bash
bun --cwd ui run test -- src/editor/__tests__/PageEditorHeader.test.tsx src/components/codex/__tests__/Folio.test.tsx
```

Expected: both files PASS; existing title, lock, derived journal tag, invalid-folio, and mobile behavior remain green.

- [ ] **Step 8: Commit folio wiring**

```bash
git add ui/src/editor/PageEditorHeader.tsx ui/src/components/codex/Folio.tsx ui/src/editor/__tests__/PageEditorHeader.test.tsx ui/src/components/codex/__tests__/Folio.test.tsx
git commit -m "feat(ui): suggest indexed tags in folios"
```

---

### Task 3: End-to-end verification and cleanup

**Files:**
- Modify only if a verification gate finds a real regression in the files changed by Tasks 1-2.

**Interfaces:**
- Consumes: completed autosuggest component and folio wiring.
- Produces: verified UI behavior with no generated artifacts committed.

- [ ] **Step 1: Run the complete UI test suite**

```bash
bun --cwd ui run test
```

Expected: PASS.

- [ ] **Step 2: Run required static verification gates**

```bash
bun --cwd ui run typecheck
bun --cwd ui run lint
```

Expected: both commands PASS with no diagnostics.

- [ ] **Step 3: Build the production UI**

```bash
bun --cwd ui run build
```

Expected: TypeScript build and Vite production build PASS.

- [ ] **Step 4: Smoke-test the real UI in a browser**

Start the backend and Vite frontend in separate supervised terminals:

```bash
cargo run -- serve
bun --cwd ui run dev
```

Open the Vite URL (normally `http://127.0.0.1:5173`) in a real browser. In a real folio:

1. Focus `Add tags`.
2. Type a substring matching a known vault tag.
3. Confirm the accessible suggestion list appears and excludes attached tags.
4. Press Arrow Down and Enter, then confirm the highlighted tag becomes a chip.
5. Type another known prefix and press Tab, then confirm completion.
6. Type a novel tag and press Enter, then confirm free-form creation still works.
7. Move focus away and confirm the folio save indicator completes successfully.

Expected: all seven observations succeed in the running application.

- [ ] **Step 5: Inspect and remove verification-only artifacts**

Remove screenshots, temporary logs, or generated files created solely by the smoke test. Keep only source, tests, and the approved design/plan documents.

- [ ] **Step 6: Commit any gate-driven correction**

Only if verification required a source correction:

```bash
git add ui/src/components/ui/tag-input.tsx ui/src/components/ui/__tests__/tag-input.test.tsx ui/src/editor/PageEditorHeader.tsx ui/src/components/codex/Folio.tsx ui/src/editor/__tests__/PageEditorHeader.test.tsx ui/src/components/codex/__tests__/Folio.test.tsx
git commit -m "fix(ui): preserve folio tag suggestion behavior"
```
