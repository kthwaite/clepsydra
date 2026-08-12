# Checkbox, CheckboxGroup, and Select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Vessel-styled RAC Checkbox, CheckboxGroup, and Select primitives, migrate approved low-risk native controls, and document every remaining native checkbox/select.

**Architecture:** Adapt the official React Aria Components field compositions to the existing `ui/src/components/ui` layer. State remains in product components; shared primitives own semantics and presentation. Migrations are a clean cutover from native event objects to RAC boolean/key callbacks.

**Tech Stack:** React 19, TypeScript 5.9, React Aria Components 1.20, Tailwind CSS 4, Lucide React, Vitest, Testing Library, Storybook 10, Biome, Bun.

## Global Constraints

- Work from an isolated feature worktree created from `develop` after commits `7b6f9dbe` and the plan commit.
- Do not include the unrelated untracked `docs/design-notes/2026-08-11-pkm-feature-comparison.md`.
- Reuse the existing `Button`, `Popover`, `DropdownListBox`, `DropdownItem`, `Description`, `cn`, and Vessel semantic tokens; add no dependency and no global design token.
- Preserve the existing generic `Select<T, M>`, `SelectListBox<T>`, and `SelectItem` exports; create no competing Select API or compatibility alias.
- Use RAC `isDisabled`, `isSelected`, `selectedKey`, `onChange`, and `onSelectionChange` contracts rather than native DOM event adapters.
- Geometry remains zero-radius. All controls need visible hover, pressed, focus-visible, disabled, and invalid states; Checkbox also needs selected and indeterminate states; Select also needs placeholder styling.
- TDD: demonstrate each new observable behavior with a failing focused test before production implementation.
- Final verification requires focused tests, affected product tests, UI typecheck, UI lint, full UI tests, Storybook build, browser checks in dark and paper themes, and repository gates.

---

### Task 1: Checkbox and CheckboxGroup primitives

**Files:**
- Create: `ui/src/components/ui/checkbox.tsx`
- Create: `ui/src/components/ui/checkbox-group.tsx`
- Create: `ui/src/components/ui/__tests__/checkbox.test.tsx`
- Create: `ui/src/components/ui/__tests__/checkbox-group.test.tsx`
- Create: `ui/src/components/ui/checkbox.stories.tsx`
- Create: `ui/src/components/ui/checkbox-group.stories.tsx`

**Interfaces:**
- Consumes: RAC `CheckboxFieldProps`, `CheckboxGroupProps`, `ValidationResult`, `composeRenderProps`; shared `Description`; Vessel semantic Tailwind tokens.
- Produces:
  - `export interface CheckboxProps extends CheckboxFieldProps { children?: ReactNode; description?: string; errorMessage?: string | ((validation: ValidationResult) => string) }`
  - `export function Checkbox(props: CheckboxProps): ReactElement`
  - `export interface CheckboxGroupProps extends Omit<RACCheckboxGroupProps, "children"> { label?: string; description?: string; errorMessage?: string | ((validation: ValidationResult) => string); children?: ReactNode; orientation?: "horizontal" | "vertical" }`
  - `export function CheckboxGroup(props: CheckboxGroupProps): ReactElement`

- [ ] **Step 1: Write failing Checkbox behavior tests**

Create tests that exercise the public accessibility/state contract:

```tsx
it("changes controlled selection and exposes help text", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <Checkbox isSelected={false} onChange={onChange} description="Stored locally">
      Encrypt note
    </Checkbox>,
  );
  const checkbox = screen.getByRole("checkbox", { name: "Encrypt note" });
  expect(checkbox).toHaveAccessibleDescription("Stored locally");
  await user.click(checkbox);
  expect(onChange).toHaveBeenCalledWith(true);
});

it("renders selected, indeterminate, invalid, and disabled states", () => {
  const { rerender } = render(<Checkbox isSelected>Selected</Checkbox>);
  expect(screen.getByRole("checkbox", { name: "Selected" })).toBeChecked();
  rerender(<Checkbox isIndeterminate>Mixed</Checkbox>);
  expect(screen.getByRole("checkbox", { name: "Mixed" })).toHaveAttribute("aria-checked", "mixed");
  rerender(<Checkbox isInvalid errorMessage="Required">Consent</Checkbox>);
  expect(screen.getByText("Required")).toBeVisible();
  rerender(<Checkbox isDisabled>Locked</Checkbox>);
  expect(screen.getByRole("checkbox", { name: "Locked" })).toBeDisabled();
});
```

- [ ] **Step 2: Run Checkbox tests and verify the missing module failure**

Run: `bun --cwd ui test src/components/ui/__tests__/checkbox.test.tsx`

Expected: FAIL because `#/components/ui/checkbox` does not exist.

- [ ] **Step 3: Implement Checkbox composition and state styling**

Use `CheckboxField` for field/help/error relationships and `CheckboxButton` for the interactive label. Compose caller classes instead of replacing RAC render-prop classes:

```tsx
export function Checkbox({ children, description, errorMessage, className, ...props }: CheckboxProps) {
  return (
    <CheckboxField {...props} className={cn("group flex flex-col gap-1", className)}>
      <CheckboxButton
        className="relative flex cursor-default items-start gap-2 text-sm text-foreground outline-none transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:text-muted-foreground"
      >
        {({ isSelected, isIndeterminate }) => (
          <>
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center border border-input bg-background text-primary-foreground transition-colors group-data-[hovered]:border-ring group-data-[pressed]:bg-accent group-data-[focus-visible]:outline group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-ring group-data-[focus-visible]:outline-offset-2 group-data-[invalid]:border-destructive group-data-[selected]:border-primary group-data-[selected]:bg-primary group-data-[indeterminate]:border-primary group-data-[indeterminate]:bg-primary group-data-[disabled]:opacity-50">
              {isIndeterminate ? <Minus aria-hidden className="size-3" /> : isSelected ? <Check aria-hidden className="size-3" /> : null}
            </span>
            <span>{children}</span>
          </>
        )}
      </CheckboxButton>
      {description ? <Description className="ml-6 text-xs text-muted-foreground">{description}</Description> : null}
      <FieldError className="ml-6 text-xs text-destructive">{errorMessage}</FieldError>
    </CheckboxField>
  );
}
```

Adjust exact data-attribute selectors only if the installed RAC 1.20 render output requires them; preserve the observable state matrix.

- [ ] **Step 4: Run Checkbox tests and make them pass**

Run: `bun --cwd ui test src/components/ui/__tests__/checkbox.test.tsx`

Expected: PASS.

- [ ] **Step 5: Write failing CheckboxGroup behavior tests**

```tsx
it("updates the selected value array", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <CheckboxGroup label="Notifications" value={["security"]} onChange={onChange}>
      <Checkbox value="product">Product</Checkbox>
      <Checkbox value="security">Security</Checkbox>
    </CheckboxGroup>,
  );
  expect(screen.getByRole("group", { name: "Notifications" })).toBeVisible();
  await user.click(screen.getByRole("checkbox", { name: "Product" }));
  expect(onChange).toHaveBeenCalledWith(["security", "product"]);
});

it("exposes orientation, description, error, and disabled children", () => {
  render(
    <CheckboxGroup label="Kinds" orientation="horizontal" description="Choose one" isInvalid errorMessage="Required" isDisabled>
      <Checkbox value="note">Note</Checkbox>
    </CheckboxGroup>,
  );
  expect(screen.getByRole("group", { name: "Kinds" })).toHaveAttribute("data-orientation", "horizontal");
  expect(screen.getByText("Choose one")).toBeVisible();
  expect(screen.getByText("Required")).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "Note" })).toBeDisabled();
});
```

- [ ] **Step 6: Run CheckboxGroup tests and verify failure**

Run: `bun --cwd ui test src/components/ui/__tests__/checkbox-group.test.tsx`

Expected: FAIL because `#/components/ui/checkbox-group` does not exist.

- [ ] **Step 7: Implement CheckboxGroup composition**

Render RAC Label, an orientation-aware items container, shared Description, and FieldError. Pass `data-orientation={orientation}` to the RAC root and default `orientation="vertical"`. Use `flex-col gap-2` vertically and `flex-row flex-wrap gap-3` horizontally.

- [ ] **Step 8: Run both primitive test files**

Run: `bun --cwd ui test src/components/ui/__tests__/checkbox.test.tsx src/components/ui/__tests__/checkbox-group.test.tsx`

Expected: PASS.

- [ ] **Step 9: Add the approved Checkbox and CheckboxGroup stories**

Create story exports named `Default`, `Selected`, `Indeterminate`, `WithDescription`, `Disabled`, and `Invalid` for Checkbox. Create `Vertical`, `Horizontal`, `Controlled`, and `RequiredInvalid` for CheckboxGroup. The controlled group story must use React state and display the current comma-separated values.

- [ ] **Step 10: Commit Task 1**

```bash
git add ui/src/components/ui/checkbox.tsx ui/src/components/ui/checkbox-group.tsx ui/src/components/ui/__tests__/checkbox.test.tsx ui/src/components/ui/__tests__/checkbox-group.test.tsx ui/src/components/ui/checkbox.stories.tsx ui/src/components/ui/checkbox-group.stories.tsx
git commit -m "feat(ui): add checkbox primitives"
```

---

### Task 2: Complete the shared Select

**Files:**
- Modify: `ui/src/components/ui/select.tsx`
- Modify: `ui/src/components/ui/select.stories.tsx`
- Create: `ui/src/components/ui/__tests__/select.test.tsx`
- Modify if required for shared dropdown states: `ui/src/components/ui/list-box.tsx`

**Interfaces:**
- Consumes: existing generic `SelectProps<T, M>`, shared `Button`, `Popover`, `DropdownListBox`, and `DropdownItem`.
- Produces: the same `Select<T, M>`, `SelectListBox<T>`, and `SelectItem` exports with no caller compatibility layer.

- [ ] **Step 1: Write failing Select interaction tests**

Cover accessible label/description, placeholder, controlled selection, keyboard selection, disabled state, invalid error, and dynamic items. Use real RAC interaction rather than `selectOptions`:

```tsx
it("opens and reports a selected key", async () => {
  const user = userEvent.setup();
  const onSelectionChange = vi.fn();
  render(
    <Select label="Status" placeholder="Choose status" onSelectionChange={onSelectionChange}>
      <SelectItem id="unread">Unread</SelectItem>
      <SelectItem id="done">Done</SelectItem>
    </Select>,
  );
  const trigger = screen.getByRole("button", { name: "Status" });
  expect(trigger).toHaveTextContent("Choose status");
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: "Done" }));
  expect(onSelectionChange).toHaveBeenCalledWith("done");
});

it("supports dynamic items and field messaging", async () => {
  const items = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];
  render(
    <Select label="Letter" items={items} description="Pick one" isInvalid errorMessage="Required">
      {(item) => <SelectItem id={item.id}>{item.name}</SelectItem>}
    </Select>,
  );
  expect(screen.getByRole("button", { name: "Letter" })).toHaveAccessibleDescription("Pick one Required");
});

it("does not open when disabled", async () => {
  const user = userEvent.setup();
  render(<Select aria-label="Status" isDisabled><SelectItem id="done">Done</SelectItem></Select>);
  const trigger = screen.getByRole("button", { name: "Status" });
  expect(trigger).toBeDisabled();
  await user.click(trigger);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});
```

Add a keyboard test that focuses the trigger, presses `ArrowDown`, then `Enter`, and verifies the selected option/key according to RAC behavior.

- [ ] **Step 2: Run Select tests and verify current failures**

Run: `bun --cwd ui test src/components/ui/__tests__/select.test.tsx`

Expected: FAIL on one or more missing field-state, description/error relationship, trigger, or keyboard expectations against the partial implementation.

- [ ] **Step 3: Upgrade Select styling and composition**

Keep the generic API. Compose the root class with `group relative flex w-full flex-col gap-1`. Apply shared field label/error classes. Give the Button a full-width text-start trigger contract, and render:

```tsx
<SelectValue className="min-w-0 flex-1 truncate text-sm normal-case tracking-normal data-[placeholder]:text-muted-foreground" />
<ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground group-data-[disabled]:opacity-50" />
```

Give the Popover `className="min-w-(--trigger-width) border border-border bg-popover text-popover-foreground shadow-lg"`. Bound the ListBox with `max-h-64 overflow-auto p-1 outline-none`. Compose item classes through RAC render props so caller classes survive, and include hovered/focused/selected/disabled states without adding a second selected icon.

- [ ] **Step 4: Run Select tests and make them pass**

Run: `bun --cwd ui test src/components/ui/__tests__/select.test.tsx`

Expected: PASS.

- [ ] **Step 5: Expand Select stories**

Keep or replace existing stories so the file exports `Default`, `Placeholder`, `WithDefaultValue`, `Controlled`, `Disabled`, `Invalid`, `LongOptions`, and `DynamicItems`. Controlled uses React state; DynamicItems passes `items` and a render function.

- [ ] **Step 6: Run primitive tests together**

Run: `bun --cwd ui test src/components/ui/__tests__/checkbox.test.tsx src/components/ui/__tests__/checkbox-group.test.tsx src/components/ui/__tests__/select.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add ui/src/components/ui/select.tsx ui/src/components/ui/select.stories.tsx ui/src/components/ui/__tests__/select.test.tsx ui/src/components/ui/list-box.tsx
git commit -m "feat(ui): complete select primitive"
```

Do not stage `list-box.tsx` if no shared dropdown-state change was required.

---

### Task 3: Migrate academic form controls

**Files:**
- Modify: `ui/src/components/academic/ImportDialog.tsx`
- Modify: `ui/src/components/academic/AcademicLibrary.tsx`
- Modify: `ui/src/components/academic/WorkDetail.tsx`
- Modify: `ui/src/components/academic/__tests__/academic-library.test.tsx`

**Interfaces:**
- Consumes: `Checkbox`, `Select`, `SelectItem` from Tasks 1–2.
- Produces: unchanged academic mutation payloads and dialog behavior.

- [ ] **Step 1: Update academic tests to exercise RAC interactions**

Replace native-only `user.selectOptions` calls for migrated fields with a helper local to the test file:

```tsx
async function chooseOption(user: ReturnType<typeof userEvent.setup>, name: string, option: string) {
  await user.click(screen.getByRole("button", { name }));
  await user.click(screen.getByRole("option", { name: option }));
}
```

Use `within(dialog)` to locate each trigger before opening when duplicate labels are possible. Add/extend tests that prove:

- Add Work submits the chosen work type and reading status.
- Edit Work submits `status: "done"` and `status: null` for the unspecified item.
- Add Annotation submits the chosen annotation type.
- Zotero import submits selected conflict policy plus `dry_run` and checkpoint booleans after checkbox clicks.

- [ ] **Step 2: Run the academic test and verify failure against native controls**

Run: `bun --cwd ui test src/components/academic/__tests__/academic-library.test.tsx`

Expected: FAIL because native selects expose `combobox` elements rather than RAC trigger buttons/options.

- [ ] **Step 3: Migrate ImportDialog**

Replace source/conflict `<label><select><option>` structures with `Select`/`SelectItem`. Map:

```tsx
<Select
  label="Import source"
  selectedKey={mode}
  onSelectionChange={(key) => changeMode(key as ImportMode)}
  isDisabled={isPending}
  className="w-full"
>
```

Convert dry-run and checkpoint labels to controlled `Checkbox` components using `isSelected`, boolean `onChange`, `isDisabled`, and unchanged copy.

- [ ] **Step 4: Migrate AcademicLibrary and WorkDetail**

Convert the two AcademicLibrary selects and two WorkDetail selects to `selectedKey`/`onSelectionChange`. Give each `Select className="w-full"`; keep every option id/order and all existing labels. Represent WorkDetail's unspecified status as `SelectItem id=""` and continue converting `""` to `null` only in the existing submit path.

- [ ] **Step 5: Run the academic test and make it pass**

Run: `bun --cwd ui test src/components/academic/__tests__/academic-library.test.tsx`

Expected: PASS with unchanged mutation payload assertions.

- [ ] **Step 6: Commit Task 3**

```bash
git add ui/src/components/academic/ImportDialog.tsx ui/src/components/academic/AcademicLibrary.tsx ui/src/components/academic/WorkDetail.tsx ui/src/components/academic/__tests__/academic-library.test.tsx
git commit -m "refactor(ui): migrate academic choice controls"
```

---

### Task 4: Migrate acknowledgement and page-tree controls

**Files:**
- Modify: `ui/src/components/codex/EncryptionSetupDialog.tsx`
- Modify: `ui/src/components/codex/NoteProtectionDialog.tsx`
- Modify: `ui/src/components/codex/__tests__/EncryptionSetupDialog.test.tsx`
- Modify: `ui/src/components/codex/__tests__/NoteProtectionDialog.test.tsx`
- Modify: `ui/src/components/page-tree/FolderActionsMenu.tsx`
- Modify: `ui/src/components/page-tree/PageActionsMenu.tsx`
- Modify: `ui/src/components/page-tree/__tests__/mutation-actions.test.tsx`

**Interfaces:**
- Consumes: `Checkbox`, `Select`, and `SelectItem`.
- Produces: unchanged security acknowledgement gating, mutation preview arguments, and folder deletion arguments.

- [ ] **Step 1: Add/strengthen failing behavior tests**

In the Codex tests, assert the final action begins disabled, click the acknowledgement checkbox by its full accessible name, and assert the action becomes enabled. Preserve existing submit assertions.

In page-tree tests, interact with destination/rewrite RAC triggers and options rather than `selectOptions`. Assert recursive deletion remains false before clicking `Delete contents recursively`, becomes true afterward, and is passed to the deletion mutation. Assert the selected inbound-link rewrite mode reaches preview/execute unchanged.

- [ ] **Step 2: Run affected tests and verify native-control failures**

Run: `bun --cwd ui test src/components/codex/__tests__/EncryptionSetupDialog.test.tsx src/components/codex/__tests__/NoteProtectionDialog.test.tsx src/components/page-tree/__tests__/mutation-actions.test.tsx`

Expected: FAIL where tests expect RAC trigger/option interaction.

- [ ] **Step 3: Migrate acknowledgement checkboxes**

Replace each wrapping native label/input with:

```tsx
<Checkbox isSelected={acknowledged} onChange={setAcknowledged} isDisabled={busy}>
  {existingCopy}
</Checkbox>
```

EncryptionSetupDialog has no current busy disable on the checkbox; pass `isDisabled={busy}` only if the surrounding workflow already blocks interaction while busy. Do not change final-action gating (`!prepared || !acknowledged || busy` and equivalent).

- [ ] **Step 4: Migrate FolderActionsMenu controls**

Rewrite `FolderSelect` to return shared `Select` with `label`, `selectedKey`, `onSelectionChange`, `isDisabled`, `className="w-full"`, a blank `SelectItem id=""`, and mapped path items. Replace recursive deletion with Checkbox; move the existing secondary explanatory sentence into `description` while preserving its text.

- [ ] **Step 5: Migrate PageActionsMenu rewrite Select**

Replace the native label/select with shared Select. Keep the three ids and labels in the existing order. Keep the preview explanation as the Select `description`; keep request errors product-level beneath the field.

- [ ] **Step 6: Run affected tests and make them pass**

Run: `bun --cwd ui test src/components/codex/__tests__/EncryptionSetupDialog.test.tsx src/components/codex/__tests__/NoteProtectionDialog.test.tsx src/components/page-tree/__tests__/mutation-actions.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add ui/src/components/codex/EncryptionSetupDialog.tsx ui/src/components/codex/NoteProtectionDialog.tsx ui/src/components/codex/__tests__/EncryptionSetupDialog.test.tsx ui/src/components/codex/__tests__/NoteProtectionDialog.test.tsx ui/src/components/page-tree/FolderActionsMenu.tsx ui/src/components/page-tree/PageActionsMenu.tsx ui/src/components/page-tree/__tests__/mutation-actions.test.tsx
git commit -m "refactor(ui): migrate safe choice controls"
```

---

### Task 5: Produce the remaining-control inventory

**Files:**
- Create: `docs/design-notes/2026-08-12-native-checkbox-select-inventory.md`

**Interfaces:**
- Consumes: the post-migration production TSX tree.
- Produces: a path-and-line inventory grouped by disposition; no runtime interface.

- [ ] **Step 1: Enumerate remaining production controls**

Use repository search for `type="checkbox"`, `type='checkbox'`, and `<select`. Exclude stories and tests from the production table, but include a separate note if fixtures intentionally render native controls.

- [ ] **Step 2: Classify every match**

Write a table with columns `Path`, `Control`, `Disposition`, and `Reason`. Use only these dispositions:

- `Direct future migration`
- `Needs Switch primitive`
- `Needs row-selection design`
- `Needs DOM ref/autofocus integration`
- `Needs native multiple-select replacement`
- `Embedded editor content; retain native`
- `Intentional native fixture`

At minimum, explicitly classify Constellation/MobileConstellation switches, Gazetteer row selection, Slate task list, Base editor focus-registry selects, inline Base cells, tasking selects, feed selects, and the conversation-turn editor select. No remaining production match may be omitted.

- [ ] **Step 3: Verify inventory completeness**

Re-run the two searches and compare every production match with a table row. The counts and paths recorded at the bottom of the document must equal the search results after excluding tests/stories.

- [ ] **Step 4: Commit Task 5**

```bash
git add docs/design-notes/2026-08-12-native-checkbox-select-inventory.md
git commit -m "docs: inventory native choice controls"
```

---

### Task 6: Browser verification and final gates

**Files:**
- Modify only if a verified defect is found: files changed in Tasks 1–4 and their tests/stories.

**Interfaces:**
- Consumes: completed component stories and migrated dialogs.
- Produces: verification evidence; no new API.

- [ ] **Step 1: Run focused component and migration tests**

Run:

```bash
bun --cwd ui test src/components/ui/__tests__/checkbox.test.tsx src/components/ui/__tests__/checkbox-group.test.tsx src/components/ui/__tests__/select.test.tsx src/components/academic/__tests__/academic-library.test.tsx src/components/codex/__tests__/EncryptionSetupDialog.test.tsx src/components/codex/__tests__/NoteProtectionDialog.test.tsx src/components/page-tree/__tests__/mutation-actions.test.tsx
```

Expected: all pass.

- [ ] **Step 2: Run UI static gates**

Run: `bun --cwd ui run typecheck`

Expected: exit 0.

Run: `bun --cwd ui run lint`

Expected: exit 0 with no diagnostics.

- [ ] **Step 3: Run the full UI test suite**

Run: `bun --cwd ui test`

Expected: all tests pass.

- [ ] **Step 4: Build Storybook**

Run: `bun --cwd ui run build-storybook`

Expected: exit 0 and a generated static Storybook build.

- [ ] **Step 5: Browser-check component stories**

Start Storybook through the harness process manager. In a real browser, open every Checkbox, CheckboxGroup, and Select story. Exercise pointer selection, Tab focus, Space checkbox toggle, Select opening, arrow navigation, Enter selection, disabled controls, invalid fields, indeterminate display, and long-option truncation. Repeat representative stories after adding `.paper` to the document root. Record observed results; fix and retest any defect.

- [ ] **Step 6: Browser-smoke migrated product flows**

Run the UI application through the harness process manager. Exercise one academic dialog containing migrated Select controls and one acknowledgement-gated encryption/protection dialog containing Checkbox. Confirm state changes and action gating visually and behaviorally.

- [ ] **Step 7: Run repository gates**

Run `just ui` and expect the TypeScript/Vite production build to exit 0. Run `cargo fmt --check` and expect no diff. Run `cargo clippy --all-targets --all-features -- -D warnings` and expect no diagnostics. Run `cargo test` and expect the full Rust suite to pass. Report each command and exact result separately.

- [ ] **Step 8: Review the complete change**

Confirm every design acceptance criterion, every changed call site, every story, and the inventory count. Verify no unrelated working-tree file is staged. Do not add compatibility aliases, migration shims, or unrelated cleanup.

- [ ] **Step 9: Commit verification fixes if any**

If verification required changes, stage only those exact files and commit:

```bash
git commit -m "fix(ui): resolve choice control verification issues"
```

Skip this commit when verification produced no changes.

- [ ] **Step 10: Merge to develop**

After all gates pass and review is clean, merge the feature branch into `develop` without including the unrelated untracked design note. Verify the merge commit or fast-forward contains the design, plan, implementation, stories, tests, migrations, and inventory.
