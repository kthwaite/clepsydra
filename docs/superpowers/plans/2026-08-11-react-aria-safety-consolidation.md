# React Aria Safety and Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the affected Bases icon actions accessible, consolidate Codex tag editing into the shared TagInput, and give tasking and Settings choices RAC radio semantics.

**Architecture:** Extend existing shared primitives narrowly. `IconButton` owns icon-only naming, `TagInput` remains the sole tag-editing state machine, and a small `SegmentedControl` composes the existing shared `RadioGroup`/`Radio` components. Domain colors and state remain in their feature modules.

**Tech Stack:** React 19, TypeScript, react-aria-components, Vitest, Testing Library, Tailwind CSS, Bun.

## Global Constraints

- Work only in an isolated feature worktree created from `develop`.
- Reproduce only the current working-copy icon intent from `PropertyDefinitionEditor.tsx` and `ViewDefinitionEditor.tsx`; do not copy `package.json`, `bun.lock`, or unrelated documentation changes.
- Preserve labels, option order, colors, spacing, and control dimensions, except that the affected Bases text actions intentionally become icons.
- Use TDD: every production change follows a focused failing test.
- Clean cutover: delete `src/components/codex/TagsInput.tsx`; leave no alias or compatibility export.
- Do not expand scope into command palettes, menus, modal foundations, fields, tables, Switch, or Tabs.

---

## File structure

**Create**

- `src/components/ui/segmented-control.tsx` — generic string-valued segmented radio control.
- `src/components/ui/__tests__/segmented-control.test.tsx` — shared control semantics and keyboard behavior.
- `src/components/__tests__/SettingsModal.appearance.test.tsx` — Settings appearance integration.

**Modify**

- `src/components/bases/PropertyDefinitionEditor.tsx` — icon actions through `IconButton` with required labels.
- `src/components/bases/ViewDefinitionEditor.tsx` — icon actions through `IconButton` with required labels.
- `src/components/bases/__tests__/PropertiesEditor.test.tsx` — accessible icon regression.
- `src/components/bases/__tests__/ViewsEditor.test.tsx` — accessible icon regression.
- `src/components/ui/tag-input.tsx` — Codex visual variant, display prefix, configurable suggestion limit.
- `src/components/ui/__tests__/tag-input.test.tsx` — prefix normalization and suggestion-limit contracts.
- `src/components/codex/InscribeModal.tsx` — use shared TagInput.
- `src/components/codex/__tests__/InscribeModal.test.tsx` — shared Codex tag behavior at the integration boundary.
- `src/components/tasking/fields.tsx` — tasking choices through RAC RadioGroup/Radio.
- `src/components/tasking/__tests__/NewTaskModal.test.tsx` — radio semantics and selection.
- `src/components/tasking/__tests__/TaskEditPanel.test.tsx` — edit-panel radio semantics.
- `src/components/ui/radio-group.tsx` — allow the segmented wrapper to style the inner option row without duplicating RAC composition.
- `src/components/SettingsModal.tsx` — mode, density, and accent controls through SegmentedControl.

**Delete**

- `src/components/codex/TagsInput.tsx` — duplicate tag state machine.

---

### Task 1: Accessible Bases icon actions

**Files:**
- Modify: `src/components/bases/__tests__/PropertiesEditor.test.tsx:140-170`
- Modify: `src/components/bases/__tests__/ViewsEditor.test.tsx:195-218`
- Modify: `src/components/bases/PropertyDefinitionEditor.tsx:1-5,281-324`
- Modify: `src/components/bases/ViewDefinitionEditor.tsx:1-5,216-265`

**Interfaces:**
- Consumes: `IconButton({ "aria-label": string, variant?, isDisabled?, onPress?, children })` from `#/components/ui/icon-button`.
- Produces: named icon actions with the existing accessible-name contract; no downstream API changes.

- [ ] **Step 1: Add failing visual/accessibility regressions**

Extend the existing reorder tests so they require an accessible name without visible text:

```tsx
const moveBetaUp = screen.getByRole("button", { name: "Move beta up" });
expect(moveBetaUp).not.toHaveTextContent("Move beta up");
expect(moveBetaUp.querySelector("svg")).not.toBeNull();

const removeTitle = screen.getByRole("button", {
  name: "Remove title column",
});
expect(removeTitle).not.toHaveTextContent("Remove title column");
expect(removeTitle.querySelector("svg")).not.toBeNull();
```

Keep the existing disabled-boundary assertions in `PropertiesEditor.test.tsx`.

- [ ] **Step 2: Run the focused tests and verify the new assertions fail**

Run:

```bash
bun run test -- src/components/bases/__tests__/PropertiesEditor.test.tsx src/components/bases/__tests__/ViewsEditor.test.tsx
```

Expected: FAIL because the `develop` versions render visible text actions rather than SVG icons.

- [ ] **Step 3: Implement the icon controls through IconButton**

Import only the used Lucide icons and `IconButton`:

```tsx
import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react";
import { IconButton } from "#/components/ui/icon-button";
```

Replace each affected action with the required name:

```tsx
<IconButton
  aria-label={`Move ${property.key} up`}
  variant="ghost"
  isDisabled={index === 0}
  onPress={() => onMove(index, index - 1)}
>
  <ArrowUp />
</IconButton>
```

Use corresponding labels for down, rename, remove, and visible-column actions. Do not copy the unrelated dependency changes from the source working tree.

- [ ] **Step 4: Run the focused tests and typecheck**

Run:

```bash
bun run test -- src/components/bases/__tests__/PropertiesEditor.test.tsx src/components/bases/__tests__/ViewsEditor.test.tsx
bun run typecheck
```

Expected: both commands PASS; no unused `Trash` import remains.

- [ ] **Step 5: Commit the independently reviewable change**

```bash
git add src/components/bases/PropertyDefinitionEditor.tsx src/components/bases/ViewDefinitionEditor.tsx src/components/bases/__tests__/PropertiesEditor.test.tsx src/components/bases/__tests__/ViewsEditor.test.tsx
git commit -m "fix(ui): name Bases icon actions"
```

---

### Task 2: Consolidate Codex tag editing

**Files:**
- Modify: `src/components/ui/__tests__/tag-input.test.tsx:329-344,482-502`
- Modify: `src/components/ui/tag-input.tsx:13-58,139-255`
- Modify: `src/components/codex/__tests__/InscribeModal.test.tsx:115-127`
- Modify: `src/components/codex/InscribeModal.tsx:1-15,171-177`
- Delete: `src/components/codex/TagsInput.tsx`

**Interfaces:**
- Produces additions to `TagInputProps`:

```ts
type TagInputVariant = "default" | "codex";

interface TagInputProps {
  variant?: TagInputVariant;
  valuePrefix?: string;
  maxSuggestions?: number;
}
```

- Defaults: `variant="default"`, `valuePrefix=""`, `maxSuggestions=5`.
- Stored and emitted values never include `valuePrefix`.

- [ ] **Step 1: Add failing shared-component contracts**

Add tests that demonstrate display-only prefix normalization and an eight-item limit:

```tsx
it("renders a display prefix without storing it", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <TagInput
      label="Tags"
      values={["rust"]}
      suggestions={["react"]}
      valuePrefix="#"
      onChange={onChange}
    />,
  );

  expect(screen.getByText("#rust")).toBeInTheDocument();
  await user.type(screen.getByRole("combobox", { name: "Add tags" }), "#re");
  expect(screen.getByRole("option", { name: "#react" })).toBeInTheDocument();
  await user.keyboard("{Tab}");
  expect(onChange).toHaveBeenCalledWith(["rust", "react"]);
});

it("honors a caller-provided suggestion limit", async () => {
  const user = userEvent.setup();
  render(
    <TagInput
      label="Tags"
      values={[]}
      suggestions={["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"]}
      maxSuggestions={8}
      onChange={() => {}}
    />,
  );
  await user.type(screen.getByRole("combobox", { name: "Add tags" }), "a");
  expect(screen.getAllByRole("option")).toHaveLength(8);
});
```

Update the Inscribe integration test to assert that the selected chip displays `#rust` while the create request still receives `tags: ["rust"]`.

- [ ] **Step 2: Run tests and verify the new props fail**

Run:

```bash
bun run test -- src/components/ui/__tests__/tag-input.test.tsx src/components/codex/__tests__/InscribeModal.test.tsx
```

Expected: TypeScript/test failure because `valuePrefix`, `maxSuggestions`, and the shared Codex presentation are not implemented.

- [ ] **Step 3: Extend TagInput without forking its behavior**

Normalize drafts by removing one configured leading prefix before filtering or commit:

```ts
const stripValuePrefix = useCallback(
  (value: string) =>
    valuePrefix && value.startsWith(valuePrefix)
      ? value.slice(valuePrefix.length)
      : value,
  [valuePrefix],
);

const query = stripValuePrefix(inputValue.trim());
```

Use `.slice(0, maxSuggestions)`. Render `${valuePrefix}${item.name}` for editable/read-only tags and suggestions. Add Codex classes through `cn` branches on the existing wrapper, tag, input, and suggestion list; do not duplicate event handlers or state.

- [ ] **Step 4: Migrate InscribeModal and delete the duplicate**

Replace the Codex import and call:

```tsx
import { TagInput } from "#/components/ui/tag-input";

<TagInput
  label="Tags"
  ariaLabel="Tags"
  values={tags}
  suggestions={(tagIndex ?? []).map((tag) => tag.tag)}
  onChange={updateTags}
  placeholder="⇥ to complete"
  variant="codex"
  valuePrefix="#"
  maxSuggestions={8}
/>
```

Delete `src/components/codex/TagsInput.tsx`. Search for its import path and confirm no callers remain.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
bun run test -- src/components/ui/__tests__/tag-input.test.tsx src/components/codex/__tests__/InscribeModal.test.tsx
bun run typecheck
```

Expected: PASS. Existing default five-suggestion and keyboard tests must remain unchanged and pass.

- [ ] **Step 6: Commit the clean cutover**

```bash
git add src/components/ui/tag-input.tsx src/components/ui/__tests__/tag-input.test.tsx src/components/codex/InscribeModal.tsx src/components/codex/__tests__/InscribeModal.test.tsx src/components/codex/TagsInput.tsx
git commit -m "refactor(ui): consolidate Codex tag input"
```

---

### Task 3: Give tasking choices radio semantics

**Files:**
- Modify: `src/components/tasking/fields.tsx:9-139`
- Modify: `src/components/tasking/__tests__/NewTaskModal.test.tsx:125-155,190-200`
- Modify: `src/components/tasking/__tests__/TaskEditPanel.test.tsx:260-292`

**Interfaces:**
- Consumes: `RadioGroup` and `Radio` from `#/components/ui/radio-group`.
- Preserves: `DispositionRow` and `PriorityRow` props and every existing `data-testid`.
- Produces: groups named `Disposition` and `Priority`, each with string-valued radios.

- [ ] **Step 1: Add failing semantic and keyboard tests**

In `NewTaskModal.test.tsx`, assert radio roles and selection:

```tsx
const disposition = screen.getByRole("radiogroup", { name: "Disposition" });
expect(within(disposition).getByRole("radio", { name: "In-field" })).toBeChecked();

const priority = screen.getByRole("radiogroup", { name: "Priority" });
const p2 = within(priority).getByRole("radio", { name: "P2" });
p2.focus();
await user.keyboard("{ArrowLeft}");
expect(within(priority).getByRole("radio", { name: "P1" })).toBeChecked();
```

In `TaskEditPanel.test.tsx`, assert the existing status and priority test IDs now have `role="radio"` and their containing groups are named.

- [ ] **Step 2: Run focused tests and verify role queries fail**

Run:

```bash
bun run test -- src/components/tasking/__tests__/NewTaskModal.test.tsx src/components/tasking/__tests__/TaskEditPanel.test.tsx
```

Expected: FAIL because the current choices are independent buttons.

- [ ] **Step 3: Replace buttons with shared radio primitives**

Use controlled string groups while retaining tasking styles:

```tsx
<RadioGroup
  aria-label="Disposition"
  value={value}
  onChange={onChange}
  className="gap-0"
>
  {COL_ORDER.map((colId) => (
    <Radio
      key={colId}
      value={colId}
      data-testid={`${testIdPrefix}-status-${colId}`}
      className={`${RADIO_CLS_BASE} ${value === colId ? RADIO_CLS_ON : RADIO_CLS_OFF_HOVER}`}
    >
      {COL_LABEL[colId] ?? colId}
    </Radio>
  ))}
</RadioGroup>
```

Apply the same pattern to priority, retaining `PRI_ON_STYLE` and `PRI_OFF_STYLE`. Use RAC `onChange`; do not attach `onClick` handlers to radios.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
bun run test -- src/components/tasking/__tests__/NewTaskModal.test.tsx src/components/tasking/__tests__/TaskEditPanel.test.tsx
bun run typecheck
```

Expected: PASS, including existing style and mutation assertions.

- [ ] **Step 5: Commit the semantic migration**

```bash
git add src/components/tasking/fields.tsx src/components/tasking/__tests__/NewTaskModal.test.tsx src/components/tasking/__tests__/TaskEditPanel.test.tsx
git commit -m "refactor(ui): use radio semantics for task choices"
```

---

### Task 4: Add shared SegmentedControl and migrate Settings choices

**Files:**
- Modify: `src/components/ui/radio-group.tsx:11-39`
- Create: `src/components/ui/segmented-control.tsx`
- Create: `src/components/ui/__tests__/segmented-control.test.tsx`
- Create: `src/components/__tests__/SettingsModal.appearance.test.tsx`
- Modify: `src/components/SettingsModal.tsx:1-15,212-287,355-394`

**Interfaces:**
- Adds `optionsClassName?: string` to `RadioGroupProps`; it styles only the inner option container.
- Produces:

```ts
export interface SegmentedControlOption {
  id: string;
  label: string;
  visual?: ReactNode;
}

export interface SegmentedControlProps {
  label: string;
  value: string;
  options: readonly SegmentedControlOption[];
  onChange: (value: string) => void;
  className?: string;
  optionsClassName?: string;
  itemClassName?: string;
}
```

- `label` is the accessible group label. `visual` is display-only; `label` remains the radio's accessible name.

- [ ] **Step 1: Add failing shared SegmentedControl tests**

Create `segmented-control.test.tsx`:

```tsx
it("exposes a named radio group and updates by keyboard", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <SegmentedControl
      label="Mode"
      value="dark"
      options={[
        { id: "dark", label: "Dark" },
        { id: "light", label: "Paper" },
      ]}
      onChange={onChange}
    />,
  );

  const dark = screen.getByRole("radio", { name: "Dark" });
  expect(dark).toBeChecked();
  dark.focus();
  await user.keyboard("{ArrowRight}");
  expect(onChange).toHaveBeenCalledWith("light");
});
```

Also assert an option with `visual={<span data-testid="swatch" />}` retains the label as its accessible name.

- [ ] **Step 2: Run the shared test and verify it fails**

Run:

```bash
bun run test -- src/components/ui/__tests__/segmented-control.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Add the narrow RadioGroup layout extension and SegmentedControl**

Update the shared group:

```tsx
export interface RadioGroupProps extends RACRadioGroupProps {
  label?: string;
  description?: string;
  children?: ReactNode;
  optionsClassName?: string;
}

<div className={cn("flex gap-0", optionsClassName)}>{children}</div>
```

Implement `SegmentedControl` solely by composing shared `RadioGroup` and `Radio`. Use `aria-label={label}` on the group, `value`, and `onChange`. Render `visual` with `aria-hidden` and render the textual label for the accessible name.

- [ ] **Step 4: Add a failing Settings appearance integration test**

Create a focused harness that mocks API hooks, `useUiStore` with `activeSettingsSection: "appearance"`, and `useTheme` with spies for `setMode`, `setDensity`, and `setAccent`.

Assert:

```tsx
expect(screen.getByRole("radiogroup", { name: "Mode" })).toBeVisible();
await user.click(screen.getByRole("radio", { name: "Paper" }));
expect(setMode).toHaveBeenCalledWith("light");

await user.click(screen.getByRole("radio", { name: "Compact" }));
expect(setDensity).toHaveBeenCalledWith("compact");

await user.click(screen.getByRole("radio", { name: "Alert" }));
expect(setAccent).toHaveBeenCalledWith("alert");
```

Use actual labels from `DENSITIES`/`ACCENTS`; match case-insensitively if their display labels differ.

- [ ] **Step 5: Run the Settings test and verify it fails on current button semantics**

Run:

```bash
bun run test -- src/components/__tests__/SettingsModal.appearance.test.tsx
```

Expected: FAIL because mode, density, and accent are buttons rather than named radio groups/radios.

- [ ] **Step 6: Migrate Settings without moving theme knowledge into UI primitives**

Replace local `Segmented` with shared `SegmentedControl` for mode and density. Map accents to options with a swatch visual:

```tsx
<SegmentedControl
  label="Accent"
  value={accent}
  options={ACCENTS.map((item) => ({
    id: item.id,
    label: item.label,
    visual: (
      <span
        className="inline-block h-[10px] w-[10px]"
        style={{ background: swatch(item.id) }}
      />
    ),
  }))}
  onChange={(value) => setAccent(value as (typeof ACCENTS)[number]["id"])}
  optionsClassName="flex-wrap gap-1.5"
  itemClassName="ml-0 flex items-center gap-1.5 border px-2 py-1"
/>
```

Remove the local `Segmented` function. Leave diegetic chrome unchanged.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
bun run test -- src/components/ui/__tests__/segmented-control.test.tsx src/components/__tests__/SettingsModal.appearance.test.tsx src/components/settings/__tests__/IndexHealthPanel.test.tsx
bun run typecheck
```

Expected: PASS, including the pre-existing Settings integration test.

- [ ] **Step 8: Commit the shared choice control**

```bash
git add src/components/ui/radio-group.tsx src/components/ui/segmented-control.tsx src/components/ui/__tests__/segmented-control.test.tsx src/components/SettingsModal.tsx src/components/__tests__/SettingsModal.appearance.test.tsx
git commit -m "refactor(ui): share segmented radio controls"
```

---

### Task 5: Integrated verification and browser smoke test

**Files:**
- Modify only if verification reveals a real defect in the changed contract.

**Interfaces:**
- Consumes all four completed tasks.
- Produces a verified feature branch ready to merge into `develop`.

- [ ] **Step 1: Run all focused tranche tests together**

```bash
bun run test -- src/components/bases/__tests__/PropertiesEditor.test.tsx src/components/bases/__tests__/ViewsEditor.test.tsx src/components/ui/__tests__/tag-input.test.tsx src/components/codex/__tests__/InscribeModal.test.tsx src/components/tasking/__tests__/NewTaskModal.test.tsx src/components/tasking/__tests__/TaskEditPanel.test.tsx src/components/ui/__tests__/segmented-control.test.tsx src/components/__tests__/SettingsModal.appearance.test.tsx src/components/settings/__tests__/IndexHealthPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run mandatory static gates**

```bash
bun run typecheck
bun run lint
```

Expected: PASS. Biome schema-version notices may remain informational; no lint errors are allowed.

- [ ] **Step 3: Run the full test suite**

```bash
bun run test
```

Expected: PASS with no failed test files.

- [ ] **Step 4: Browser-smoke Settings**

Start the app with the project process manager, open Settings → Appearance, and verify:

1. Mode, Accent, and Density retain their existing layout, colors, and labels.
2. Clicking each option updates selection.
3. Arrow keys move selection within each group.
4. Focus-visible styling appears for keyboard navigation.
5. Diegetic chrome remains unchanged.

- [ ] **Step 5: Browser-smoke tasking and Bases**

Open the tasking new/edit controls and a Bases definition editor. Verify:

1. Tasking disposition and priority retain existing colors and dimensions.
2. Arrow keys move radio selection and trigger the existing state update.
3. Bases move/rename/remove actions render icons and expose tool-accessible names.
4. Disabled first/last ordering boundaries remain disabled.

- [ ] **Step 6: Review the complete branch against scope**

Confirm no dependency versions, lockfile entries, unrelated docs, command palettes, menus, modal foundations, fields, tables, Switches, or Tabs changed.

- [ ] **Step 7: Commit any verified corrective change**

If verification required a correction, stage only the files changed for that correction and commit them with `fix(ui): close React Aria tranche regressions`. If verification changed no files, do not create an empty commit.
