# Base Filter Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace shallow Base filter authoring interfaces with one behavior-preserving `BaseFilterEditor` module that owns tree mutation, diagnostics, focus routing, and recursive authoring.

**Architecture:** A private pure `filter-tree.ts` implementation applies immutable node operations. A private `filter-diagnostics.ts` scope converts node-relative control names into validator paths and focus registrations. `BaseFilterEditor.tsx` is the only caller-facing seam; its recursive node editor and leaf modules consume internal node-scoped operations and diagnostic scopes.

**Tech Stack:** TypeScript, React 19, TanStack Router application, React Aria controls, Vitest, Testing Library, Biome.

**Spec:** `docs/superpowers/specs/2026-08-26-base-filter-editor-design.md`

## Global Constraints

- Preserve the generated `BaseFilter` schema and server validation.
- Preserve exact authored AST shapes, child order, seeds, compact tag encodings, empty-ancestor collapse, unsupported wire values, and freeform commit timing.
- Preserve validator-compatible diagnostic paths and native-control focus targets.
- `BaseFilterEditor` is the only public Base filter-authoring module after migration.
- Callers never supply root snapshots, node paths, child positions, or node-level mutation callbacks.
- `registerFocus` is optional; absence performs no external registration.
- No public controller hook, compatibility alias, or unrelated Base redesign.
- Follow strict RED-GREEN TDD. Every production edit follows an observed test failure caused by the missing behavior.

---

## File structure

- Create `ui/src/components/bases/filter-tree.ts`: private immutable `BaseFilter` transaction implementation and internal path/action types.
- Create `ui/src/components/bases/__tests__/filter-tree.test.ts`: exact AST, no-op, boundary, and immutability contracts.
- Create `ui/src/components/bases/filter-diagnostics.ts`: private node diagnostic scope and optional focus registration.
- Create `ui/src/components/bases/__tests__/filter-diagnostics.test.ts`: validator path, exact/subtree matching, and registration contracts.
- Rename `ui/src/components/bases/MembershipEditor.tsx` to `BaseFilterEditor.tsx`: public seam plus private recursive node implementation.
- Rename `ui/src/components/bases/__tests__/MembershipEditor.test.tsx` to `BaseFilterEditor.test.tsx`: public behavior test surface.
- Remove `ui/src/components/bases/FilterGroupEditor.tsx` after its implementation moves behind the public seam.
- Modify `FilterComparisonEditor.tsx` and `TagConditionEditor.tsx`: consume a node diagnostic scope instead of raw path/root/registrar mechanics.
- Modify `definition-model.ts` and `definition-model.test.ts`: remove filter-path replacement/removal responsibilities after migration.
- Modify `BaseDefinitionWorkspace.tsx`, `ViewDefinitionEditor.tsx`, `BaseEmbedInspector.tsx`, and `CreateBaseDialog.tsx`: use the public `BaseFilterEditor` interface.
- Modify `BaseEmbedInspector.test.tsx`, `ViewsEditor.test.tsx`, `BaseDefinitionWorkspace.test.tsx`, and create-dialog coverage in `BaseFilterEditor.test.tsx` only where imports or behavior contracts require it.

---

### Task 1: Private filter-tree transaction implementation

**Files:**
- Create: `ui/src/components/bases/filter-tree.ts`
- Create: `ui/src/components/bases/__tests__/filter-tree.test.ts`
- Modify: `ui/src/components/bases/definition-model.ts:52-144,317-335`
- Modify: `ui/src/components/bases/__tests__/definition-model.test.ts`
- Modify: `ui/src/components/bases/FilterGroupEditor.tsx`

**Interfaces:**
- Consumes: generated `BaseFilter` from `#/api/bases`.
- Produces:

```ts
export type FilterPathSegment = "all" | "any" | "not" | number;
export type FilterPath = readonly FilterPathSegment[];
export type FilterWrapKind = "all" | "any" | "not";

export type FilterTreeAction =
  | { type: "replace"; path: FilterPath; value: BaseFilter }
  | { type: "remove"; path: FilterPath }
  | { type: "append"; path: FilterPath; value: BaseFilter }
  | { type: "move"; path: FilterPath; offset: -1 | 1 }
  | { type: "wrap"; path: FilterPath; kind: FilterWrapKind };

export function updateFilterTree(
  root: BaseFilter,
  action: FilterTreeAction,
): BaseFilter | undefined;
```

`filter-tree.ts` is internal by location and direct imports. It is not re-exported from a package barrel.

- [ ] **Step 1: Write failing transaction tests**

Create literal fixtures that prove:

```ts
it("replaces a condition below all and not without mutating the source", () => {
  const root = {
    all: [{ not: { field: "kind", op: "eq", value: "NOTE" } }],
  } satisfies BaseFilter;

  const next = updateFilterTree(root, {
    type: "replace",
    path: ["all", 0, "not"],
    value: { field: "kind", op: "eq", value: "PROJECT" },
  });

  expect(next).toEqual({
    all: [{ not: { field: "kind", op: "eq", value: "PROJECT" } }],
  });
  expect(root.all[0]).toEqual({
    not: { field: "kind", op: "eq", value: "NOTE" },
  });
});

it("removes a sole child and collapses every empty ancestor", () => {
  const root = {
    all: [{ any: [{ field: "kind", op: "eq", value: "NOTE" }] }],
  } satisfies BaseFilter;
  expect(
    updateFilterTree(root, { type: "remove", path: ["all", 0, "any", 0] }),
  ).toBeUndefined();
});
```

Add independent literal tests for root removal, append to `all` and `any`, sibling moves in both directions, boundary moves as no-ops, wrapping in all three kinds, malformed branch/index as the same root object, and source immutability.

- [ ] **Step 2: Run the new tests RED**

Run:

```bash
bun run test -- src/components/bases/__tests__/filter-tree.test.ts
```

Expected: FAIL because `#/components/bases/filter-tree` and `updateFilterTree` do not exist.

- [ ] **Step 3: Implement one recursive updater**

Implement path lookup/update once. `replace`, `remove`, `append`, `move`, and `wrap` all call the same traversal implementation. Required behavior:

```ts
function wrap(kind: FilterWrapKind, value: BaseFilter): BaseFilter {
  if (kind === "all") return { all: [value] };
  if (kind === "any") return { any: [value] };
  return { not: value };
}
```

A malformed segment returns the original node reference. Removing the last child returns `undefined` to its parent. A parent receiving `undefined` removes that child and likewise collapses when empty. A move whose destination is outside the sibling array returns the original root reference.

Move `FilterPath` into `filter-tree.ts`. Replace `FilterGroupEditor` imports of `replaceFilterAtPath`, `removeFilterAtPath`, and `moveItem` with `updateFilterTree` actions while keeping its current props and recursive shape for this task. Remove `FilterPath`, `replaceFilterAtPath`, and `removeFilterAtPath` from `definition-model.ts`. Keep generic `moveItem` there because non-filter authoring also consumes it. Move the corresponding filter traversal tests out of `definition-model.test.ts`; retain unrelated definition-model tests unchanged.

- [ ] **Step 4: Run transaction and definition-model tests GREEN**

```bash
bun run test -- src/components/bases/__tests__/filter-tree.test.ts src/components/bases/__tests__/definition-model.test.ts src/components/bases/__tests__/MembershipEditor.test.tsx
```

Expected: all three files pass; existing public authoring and definition-model contracts remain intact.

- [ ] **Step 5: Run typecheck and commit**

```bash
bun run typecheck
git add ui/src/components/bases/filter-tree.ts ui/src/components/bases/__tests__/filter-tree.test.ts ui/src/components/bases/FilterGroupEditor.tsx ui/src/components/bases/definition-model.ts ui/src/components/bases/__tests__/definition-model.test.ts
git commit -m "refactor(bases): isolate filter tree transactions"
```

---

### Task 2: Node diagnostic scope

**Files:**
- Create: `ui/src/components/bases/filter-diagnostics.ts`
- Create: `ui/src/components/bases/__tests__/filter-diagnostics.test.ts`
- Modify: `ui/src/components/bases/FilterComparisonEditor.tsx`
- Modify: `ui/src/components/bases/TagConditionEditor.tsx`
- Modify: `ui/src/components/bases/__tests__/TagConditionEditor.test.tsx`
- Modify: `ui/src/components/bases/FilterGroupEditor.tsx`

**Interfaces:**
- Consumes: `BaseDiagnostic`, `RegisterFocusTarget`, and internal `FilterPath`.
- Produces:

```ts
export type FilterControl = "field" | "op" | "value";

export interface FilterDiagnosticScope {
  path(control?: FilterControl): string;
  exact(control: FilterControl): BaseDiagnostic[];
  subtree(): BaseDiagnostic[];
  register(control: FilterControl, element: HTMLElement | null): void;
}

export function createFilterDiagnosticScope(options: {
  root: string;
  path: FilterPath;
  diagnostics: readonly BaseDiagnostic[];
  registerFocus?: RegisterFocusTarget;
}): FilterDiagnosticScope;
```

Leaf editor props replace `path`, `diagnosticRoot`, `diagnostics`, and `registerFocus` with one `diagnosticScope`.

- [ ] **Step 1: Write failing scope tests**

```ts
it("derives validator paths and exact control diagnostics", () => {
  const diagnostics = [
    { path: "views[1].filter.all[0].value", severity: "error", message: "Bad value" },
  ] as BaseDiagnostic[];
  const scope = createFilterDiagnosticScope({
    root: "views[1].filter",
    path: ["all", 0],
    diagnostics,
  });

  expect(scope.path("value")).toBe("views[1].filter.all[0].value");
  expect(scope.exact("value")).toEqual(diagnostics);
  expect(scope.exact("field")).toEqual([]);
});
```

Add tests that `subtree()` includes the node path and descendants but excludes siblings, `register()` passes the exact path and element to a supplied registrar, and absent registration is a no-op.

- [ ] **Step 2: Run scope tests RED**

```bash
bun run test -- src/components/bases/__tests__/filter-diagnostics.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the scope and migrate leaf editors**

Move `diagnosticPath`, `filterPathString`, and `subsumedDiagnostics` behavior into `createFilterDiagnosticScope`. `FilterComparisonEditor` uses:

```ts
const fieldDiagnostics = diagnosticScope.exact("field");
// equivalent for op and value
diagnosticScope.register("field", element);
```

`FilterGroupEditor` creates one scope per node from its internal `diagnosticRoot`, `path`, diagnostics, and registrar. It passes that scope to `FilterComparisonEditor` or `TagConditionEditor`. `TagConditionEditor` uses `diagnosticScope.subtree()` for compact conditions and forwards the same scope to its advanced `FilterComparisonEditor`. Keep all existing ARIA IDs, messages, invalid-state checks, and native refs.

- [ ] **Step 4: Run leaf and scope tests GREEN**

```bash
bun run test -- src/components/bases/__tests__/filter-diagnostics.test.ts src/components/bases/__tests__/TagConditionEditor.test.tsx src/components/bases/__tests__/MembershipEditor.test.tsx
```

Expected: all files pass with exact existing diagnostic and focus behavior.

- [ ] **Step 5: Run typecheck and commit**

```bash
bun run typecheck
git add ui/src/components/bases/filter-diagnostics.ts ui/src/components/bases/__tests__/filter-diagnostics.test.ts ui/src/components/bases/FilterGroupEditor.tsx ui/src/components/bases/FilterComparisonEditor.tsx ui/src/components/bases/TagConditionEditor.tsx ui/src/components/bases/__tests__/TagConditionEditor.test.tsx
git commit -m "refactor(bases): scope filter diagnostics"
```

---

### Task 3: BaseFilterEditor clean cutover

**Files:**
- Rename: `ui/src/components/bases/MembershipEditor.tsx` → `ui/src/components/bases/BaseFilterEditor.tsx`
- Rename: `ui/src/components/bases/__tests__/MembershipEditor.test.tsx` → `ui/src/components/bases/__tests__/BaseFilterEditor.test.tsx`
- Remove: `ui/src/components/bases/FilterGroupEditor.tsx`
- Modify: `ui/src/components/bases/BaseDefinitionWorkspace.tsx`
- Modify: `ui/src/components/bases/ViewDefinitionEditor.tsx`
- Modify: `ui/src/components/bases/BaseEmbedInspector.tsx`
- Modify: `ui/src/components/bases/CreateBaseDialog.tsx`
- Modify: `ui/src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx`
- Modify: `ui/src/components/bases/__tests__/ViewsEditor.test.tsx`
- Modify: `ui/src/components/bases/__tests__/BaseEmbedInspector.test.tsx`

**Interfaces:**
- Consumes: `updateFilterTree`, `FilterTreeAction`, `FilterPath`, and `createFilterDiagnosticScope` from Tasks 1 and 2.
- Produces:

```ts
interface BaseFilterEditorProps {
  value: BaseFilter | undefined;
  properties: DraftProperty[];
  onChange(value: BaseFilter | undefined): void;
  registerFocus?: RegisterFocusTarget;
  label?: string;
  diagnostics?: BaseDiagnostic[];
  diagnosticRoot?: string;
}

export function BaseFilterEditor(props: BaseFilterEditorProps): ReactNode;
```

`FilterNodeEditor` is a non-exported recursive function in `BaseFilterEditor.tsx`. Its implementation closes over each internal path and dispatches complete `FilterTreeAction` values. Leaf modules receive `value`, `position`, `properties`, `onChange`, and `diagnosticScope`; they never receive a root snapshot or raw diagnostic path.

- [ ] **Step 1: Rename public tests and write failing interface contracts**

Rename the test file first and change its import to `BaseFilterEditor`. Add a case proving the registrar is optional:

```ts
it("authors a filter without an external focus registrar", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <BaseFilterEditor value={undefined} properties={[]} onChange={onChange} />,
  );
  await user.click(screen.getByRole("button", { name: "Add rule" }));
  await user.click(screen.getByRole("menuitem", { name: "Condition" }));
  expect(onChange).toHaveBeenCalledWith({ field: "kind", op: "eq", value: "" });
});
```

Add literal public behavior cases for nested NOT wrapping, nested-not child removal collapse, group append, group movement preserving exact order, controlled root replacement, and one `onChange` call per authoring action:

```ts
it("wraps a nested condition in not through one root change", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  renderEditor({
    value: { all: [{ field: "kind", op: "eq", value: "NOTE" }] },
    onChange,
  });

  await openNodeActions(user, 1);
  await user.click(screen.getByRole("menuitem", { name: "Wrap in NOT" }));

  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenLastCalledWith({
    all: [{ not: { field: "kind", op: "eq", value: "NOTE" } }],
  });
});
```

Update the four caller tests to import/render their real caller with the same existing behavior assertions. Keep exact view diagnostic root `views[0].filter`, embed reset/preservation, root draft updates, and create-dialog submission.

- [ ] **Step 2: Run cutover tests RED**

```bash
bun run test -- src/components/bases/__tests__/BaseFilterEditor.test.tsx src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx src/components/bases/__tests__/ViewsEditor.test.tsx src/components/bases/__tests__/BaseEmbedInspector.test.tsx
```

Expected: FAIL because `BaseFilterEditor.tsx` and its symbol do not exist. Existing caller tests may additionally fail until their imports migrate.

- [ ] **Step 3: Implement the public seam and private recursion**

The repository language server is unavailable in this worktree. Rename the files, then update every known production and test import. Before deleting the old symbols, search executable code for `MembershipEditor` and `FilterGroupEditor`; no occurrence may remain.

Move `FilterGroupEditor` into `BaseFilterEditor.tsx` as private `FilterNodeEditor`. `BaseFilterEditor` owns the controlled draft and one dispatcher:

```ts
function dispatch(action: FilterTreeAction) {
  if (!draftValue) return;
  const next = updateFilterTree(draftValue, action);
  setDraftValue(next);
  onChange(next);
}
```

Root seed and replacement actions continue calling the same `commit(next)` behavior used today. Recursive node actions close over their internal path and call `dispatch` once. Replace direct child-array reconstruction, `moveItem`, old path replacement, and old path removal with `updateFilterTree` actions.

For each node, create one diagnostic scope from `diagnosticRoot`, current path, diagnostics, and optional registrar. Pass that scope to `FilterComparisonEditor` or `TagConditionEditor`. Keep `useIdentifiedRows` reconciliation unchanged.

Migrate callers:

- `BaseDefinitionWorkspace`: passes its real workspace registrar.
- `ViewDefinitionEditor`: passes its real workspace registrar and exact view diagnostic root.
- `BaseEmbedInspector`: omits `registerFocus`.
- `CreateBaseDialog`: omits `registerFocus`.

Delete `MembershipEditor.tsx`, `FilterGroupEditor.tsx`, and obsolete imports. Add no aliases or re-exports.

- [ ] **Step 4: Run cutover and internal tests GREEN**

```bash
bun run test -- src/components/bases/__tests__/BaseFilterEditor.test.tsx src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx src/components/bases/__tests__/ViewsEditor.test.tsx src/components/bases/__tests__/BaseEmbedInspector.test.tsx src/components/bases/__tests__/TagConditionEditor.test.tsx src/components/bases/__tests__/filter-tree.test.ts src/components/bases/__tests__/filter-diagnostics.test.ts
```

Expected: every listed file passes; exact AST, one-change dispatch, row identity, and focus behavior remain unchanged.

- [ ] **Step 5: Run static checks and commit**

```bash
bun run typecheck
bun run lint -- src/components/bases/BaseFilterEditor.tsx src/components/bases/FilterComparisonEditor.tsx src/components/bases/TagConditionEditor.tsx src/components/bases/filter-tree.ts src/components/bases/filter-diagnostics.ts src/components/bases/BaseDefinitionWorkspace.tsx src/components/bases/ViewDefinitionEditor.tsx src/components/bases/BaseEmbedInspector.tsx src/components/bases/CreateBaseDialog.tsx
git add ui/src/components/bases
git commit -m "refactor(bases): deepen Base filter editor module"
```

---

## Final verification

After all three reviewed tasks:

1. Run focused Base authoring tests:

```bash
bun run test -- src/components/bases/__tests__/BaseFilterEditor.test.tsx src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx src/components/bases/__tests__/ViewsEditor.test.tsx src/components/bases/__tests__/BaseEmbedInspector.test.tsx src/components/bases/__tests__/TagConditionEditor.test.tsx src/components/bases/__tests__/filter-tree.test.ts src/components/bases/__tests__/filter-diagnostics.test.ts src/components/bases/__tests__/definition-model.test.ts
```

2. Run UI typecheck and lint:

```bash
bun run typecheck
bun run lint
```

3. Run the controlled full UI suite:

```bash
bun run test -- --maxWorkers=4
```

4. Run the application against the configured backend. Browser-drive a Base definition through condition creation, nested group creation, NOT wrapping, sibling movement, removal/collapse, and a server diagnostic focus action. Confirm saved AST values and focused native controls.

5. Review the complete branch against `docs/superpowers/specs/2026-08-26-base-filter-editor-design.md`. Resolve Critical and Important findings before merge.

6. Fast-forward merge `feature/deepen-base-filter-editor` into `develop`, rerun typecheck, lint, and the controlled full UI suite on the merged tree, remove the worktree and branch, complete all six TSK-0102 checklist items, and move TSK-0102 to Done.
