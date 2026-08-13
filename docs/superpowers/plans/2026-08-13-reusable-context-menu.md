# Reusable Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SHEAF's hand-rolled context menu with reusable, accessible React Aria menu primitives while preserving all workspace actions and adding selection, submenu, disabled, destructive, shortcut, and rich-item capabilities.

**Architecture:** `ui/src/components/ui/menu.tsx` owns only RAC composition and shared styling. `SheafContextMenu.tsx` remains the workspace-domain adapter: it builds tab and quire menus, invokes the Zustand store at action time, and owns compact naming dialogs. `Sheaf.tsx` supplies the existing native tab or quire element as the context-menu target without retaining coordinates, global menu state, or manual context handlers.

**Tech Stack:** React 19, TypeScript 5.9, React Aria Components 1.20, Zustand 5, Tailwind CSS 4, Vitest 4, Testing Library, pragmatic-drag-and-drop.

**Spec:** `docs/superpowers/specs/2026-08-13-reusable-context-menu-design.md`

## Global Constraints

- Add primitive capabilities only; do not add new workspace business actions.
- Preserve RAC's native collection, disabled, selection, action, and submenu APIs rather than introducing an item-array schema.
- The shared menu primitive imports no workspace stores or domain types.
- Use RAC `MenuTrigger trigger="contextMenu"` and `Pressable`; do not retain manual viewport math, portals, global event listeners, or pointer-coordinate state.
- Preserve the existing tab and quire DOM layout and pragmatic-drag-and-drop refs.
- Inputs do not appear inside a `role="menu"`; new/rename quire uses the shared `Dialog` and `TextField`.
- Preserve existing workspace mutation semantics and read the current store state when an action activates.
- No compatibility exports, aliases, or deprecated paths: migrate every caller and remove obsolete types/helpers.
- Execute implementation in an isolated feature worktree, review every task, run final behavioral smoke verification, then typecheck, lint, and the full UI test suite before merging to `develop`.

## File structure

- Create `ui/src/components/ui/menu.tsx` — shared RAC triggers, menu collection wrappers, item rendering, submenu popovers, and visual variants.
- Create `ui/src/components/ui/__tests__/menu.test.tsx` — observable interaction and semantics contract for the shared primitive.
- Modify `ui/src/components/codex/SheafContextMenu.tsx` — SHEAF-specific item composition and controlled naming dialogs; remove overlay infrastructure and local row/input primitives.
- Modify `ui/src/components/codex/__tests__/SheafContextMenu.test.tsx` — domain action, submenu, selection, dialog, and disappearing-target coverage.
- Modify `ui/src/components/codex/Sheaf.tsx` — wrap native tab/quire targets and remove coordinate/open state and manual handlers.
- Modify `ui/src/components/codex/__tests__/Sheaf.test.tsx` — integration coverage for context opening and retained drag/drop registration.
- Modify `ui/src/docs/content/codex-and-conversation-capture.mdx` only if its existing interaction copy states that rename or creation is inline; otherwise leave it unchanged.

---

### Task 1: Shared RAC menu primitives

**Files:**
- Create: `ui/src/components/ui/menu.tsx`
- Create: `ui/src/components/ui/__tests__/menu.test.tsx`

**Interfaces:**
- Consumes: `Popover` from `#/components/ui/popover`, `cn` from `#/lib/cn`, and RAC Menu exports.
- Produces:
  - `MenuTrigger(props: AriaMenuTriggerProps): JSX.Element | null`
  - `ContextMenuTrigger(props: Omit<AriaMenuTriggerProps, "trigger">): JSX.Element | null`
  - `Menu<T extends object>(props: AriaMenuProps<T>): JSX.Element`
  - `MenuItem(props: MenuItemProps): JSX.Element`
  - `MenuSection<T extends object>(props: AriaMenuSectionProps<T>): JSX.Element`
  - `MenuSeparator(props: SeparatorProps): JSX.Element`
  - `SubmenuTrigger(props: AriaSubmenuTriggerProps): JSX.Element`
  - `MenuItemProps`, extending RAC item props with `variant`, `icon`, `swatch`, `description`, and `shortcut`.

- [ ] **Step 1: Write trigger and action tests**

Create `ui/src/components/ui/__tests__/menu.test.tsx`. Add a native target inside `ContextMenuTrigger`, dispatch `await user.pointer({keys: "[MouseRight]", target})`, and assert that the menu opens at `role="menu"`. Activate an item and assert its `onAction` key. Add a keyboard case that focuses the target, dispatches `{Shift>}{F10}{/Shift}`, selects with ArrowDown/Enter, closes, and restores focus to the target. Add an ordinary `MenuTrigger` case with a RAC `Button`; click it and assert that the same shared menu shell opens and activates its item.

```tsx
it("opens from a native target and dispatches an action", async () => {
  const user = userEvent.setup();
  const onAction = vi.fn();
  render(
    <ContextMenuTrigger>
      <button type="button">Target</button>
      <Menu aria-label="Actions" onAction={onAction}>
        <MenuItem id="open">Open</MenuItem>
      </Menu>
    </ContextMenuTrigger>,
  );

  await user.pointer({ target: screen.getByRole("button", { name: "Target" }), keys: "[MouseRight]" });
  expect(screen.getByRole("menu", { name: "Actions" })).toBeVisible();
  await user.click(screen.getByRole("menuitem", { name: "Open" }));
  expect(onAction).toHaveBeenCalledWith("open");
});
```

- [ ] **Step 2: Write capability tests**

In the same file, add exact cases for:

1. `isDisabled` prevents `onAction` and exposes disabled state.
2. `variant="destructive"` exposes a stable `data-variant="destructive"` hook.
3. `selectionMode="single"` and `selectedKeys` expose `menuitemradio` and the selected indicator.
4. `selectionMode="multiple"` exposes `menuitemcheckbox` and updates through `onSelectionChange`.
5. `SubmenuTrigger` opens from ArrowRight and its child action fires.
6. `MenuSection`, `MenuSeparator`, `icon`, `swatch`, `description`, and `shortcut` render with accessible labels while decorative slots are `aria-hidden`.
7. Escape closes the menu and restores focus.

Use a small stateful `SelectionFixture` in the test file so assertions observe selection changes rather than implementation callbacks alone.

- [ ] **Step 3: Run the primitive tests and confirm RED**

Run:

```bash
bun --cwd ui test src/components/ui/__tests__/menu.test.tsx
```

Expected: FAIL because `#/components/ui/menu` does not exist.

- [ ] **Step 4: Implement trigger and popover composition**

Create `menu.tsx`. Import menu components from `react-aria-components/Menu`, `Pressable` from `react-aria-components`, and the shared `Popover`.

Implement ordinary and context triggers by splitting exactly two children. Ordinary `MenuTrigger` passes the first child directly to RAC and wraps the second in `<Popover hideArrow>`. `ContextMenuTrigger` fixes `trigger="contextMenu"`, wraps the native first child in `<Pressable>`, and wraps the menu in the same popover. Throw a descriptive development-time error when the child count is not two; do not silently drop children.

Implement `SubmenuTrigger` the same way, using `<Popover hideArrow offset={-2} crossOffset={-4}>` for its menu.

- [ ] **Step 5: Implement menu collection and item rendering**

Implement generic `Menu` and `MenuSection` as thin RAC wrappers. Merge consumer classes with these shared defaults:

```tsx
const menuClass =
  "cl-mono min-w-[180px] max-w-[min(320px,calc(100vw-16px))] overflow-auto border-[1.5px] border-ink bg-paper py-1 text-[10px] uppercase tracking-[0.08em] text-ink outline-none";

const itemClass =
  "group flex cursor-default items-center gap-2 px-3 py-[5px] outline-none data-[focused]:bg-ink data-[focused]:text-paper data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40";
```

`MenuItem` must:

- infer `textValue` when `children` is a string;
- put `data-variant` on the RAC item;
- render selected indicators from RAC `isSelected` and `selectionMode`;
- render icon or swatch as decorative leading content;
- render label and optional description in `Text` slots;
- render `Keyboard` for shortcuts;
- render a `ChevronRight` when `hasSubmenu`;
- use destructive text while idle and inherit the focused paper color.

Implement `MenuSeparator` with RAC `Separator` and `my-1 border-t border-rule-soft`.

- [ ] **Step 6: Run primitive tests and confirm GREEN**

Run:

```bash
bun --cwd ui test src/components/ui/__tests__/menu.test.tsx
```

Expected: all menu primitive tests PASS.

- [ ] **Step 7: Run focused typecheck and lint**

Run:

```bash
bun --cwd ui typecheck
bun --cwd ui lint src/components/ui/menu.tsx src/components/ui/__tests__/menu.test.tsx
```

Expected: both commands exit 0.

- [ ] **Step 8: Commit the primitive**

```bash
git add ui/src/components/ui/menu.tsx ui/src/components/ui/__tests__/menu.test.tsx
git commit -m "feat(ui): add reusable context menu primitives"
```

---

### Task 2: Migrate SHEAF menu content and naming flows

**Files:**
- Modify: `ui/src/components/codex/SheafContextMenu.tsx`
- Modify: `ui/src/components/codex/__tests__/SheafContextMenu.test.tsx`

**Interfaces:**
- Consumes: all shared exports from Task 1, `Dialog`, `Button`, `TextField`, `QUIRE_COLORS`, `quireColorVar`, and `useWorkspaceStore`.
- Produces:

```tsx
export type MenuTarget =
  | { kind: "tab"; tabId: string }
  | { kind: "quire"; quireId: string };

export interface SheafContextMenuProps {
  target: MenuTarget;
  children: React.ReactElement<React.DOMAttributes<HTMLElement>, string>;
}

export function SheafContextMenu(props: SheafContextMenuProps): JSX.Element;
```

- [ ] **Step 1: Rewrite tests against a real trigger**

Replace coordinate/onClose fixtures with a helper that renders a native button child and opens it by right-click:

```tsx
async function renderMenu(target: MenuTarget) {
  const user = userEvent.setup();
  render(
    <SheafContextMenu target={target}>
      <button type="button">Target</button>
    </SheafContextMenu>,
  );
  await user.pointer({ target: screen.getByRole("button", { name: "Target" }), keys: "[MouseRight]" });
  return user;
}
```

Preserve close/close-others, remove-from-quire, ungroup, expand/collapse, and close-quire assertions. Change add-to-quire to open `ADD TO QUIRE`, choose `THESIS`, and assert membership. Change recolor to open `COLOR`, choose `MADDER`, and assert both store mutation and the selected radio state when reopened.

- [ ] **Step 2: Add naming-dialog and edge-case tests**

Add exact tests that:

- selecting `NEW QUIRE…` closes the menu and opens a dialog named `New quire`;
- whitespace-only input leaves `Create` disabled;
- entering `drafts` and pressing Enter creates and assigns the quire;
- selecting `RENAME…` opens a dialog prefilled with the current name;
- Escape and Cancel close without mutating;
- submitting `opus` renames the quire;
- deleting the target from `useWorkspaceStore` while open causes subsequent activation to no-op and dismiss safely;
- `CLOSE QUIRE` has `data-variant="destructive"`.

- [ ] **Step 3: Run SHEAF menu tests and confirm RED**

Run:

```bash
bun --cwd ui test src/components/codex/__tests__/SheafContextMenu.test.tsx
```

Expected: FAIL because the component still requires coordinates/onClose and has flat rows and inline inputs.

- [ ] **Step 4: Replace the hand-rolled overlay with shared primitives**

Delete `useEffect`, `useRef`, `createPortal`, `MENU_WIDTH`, `Row`, `Divider`, and `NameInput`. Keep `MenuTarget` but remove `x` and `y`. Change the component to accept one native trigger child and render:

```tsx
<ContextMenuTrigger>
  {children}
  <Menu className="w-[220px]" aria-label="sheaf context menu" onAction={handleRootAction}>
    {menuItems}
  </Menu>
</ContextMenuTrigger>
```

Read tabs and quires through selectors for rendering. In every action handler, call `useWorkspaceStore.getState()` again, verify the target still exists, then mutate. Do not capture a stale tab or quire object inside an action closure.

- [ ] **Step 5: Implement scalable tab and quire submenus**

For tab targets:

- root actions: `close`, `close-others`, `new-quire`, and conditional `remove-from-quire`;
- render `ADD TO QUIRE` only when at least one other quire exists;
- nested quire item ids are the quire ids, with `swatch={quireColorVar(q.color)}`;
- nested `onAction` re-reads the store, verifies both tab and quire, then calls `addTabToQuire`.

For quire targets:

- root actions: `rename`, `toggle-collapse`, `ungroup`, and `close-quire`;
- `COLOR` is a nested `Menu selectionMode="single" selectedKeys={new Set([quire.color])}`;
- color ids are `QuireColor` values; nested `onAction` validates membership in `QUIRE_COLORS`, re-reads the quire, and calls `recolorQuire`;
- `close-quire` uses `variant="destructive"`.

- [ ] **Step 6: Implement controlled naming dialogs**

Use a discriminated state:

```ts
type NamingAction =
  | { kind: "create"; tabId: string; draft: string }
  | { kind: "rename"; quireId: string; draft: string }
  | null;
```

Render the shared `Dialog` with `size="sm"`, a `TextField autoFocus`, Cancel button, and Create/Rename submit button. Put the field and footer controls in a form linked by `id`, or handle form submission at the dialog content level; Enter must use the same `commitNamingAction` path as the primary button. Trim once in `commitNamingAction`, reject an empty result, re-read the target, mutate if present, then clear state.

- [ ] **Step 7: Run SHEAF menu tests and confirm GREEN**

Run:

```bash
bun --cwd ui test src/components/codex/__tests__/SheafContextMenu.test.tsx
```

Expected: all SHEAF domain-menu tests PASS.

- [ ] **Step 8: Run focused typecheck and lint**

Run:

```bash
bun --cwd ui typecheck
bun --cwd ui lint src/components/codex/SheafContextMenu.tsx src/components/codex/__tests__/SheafContextMenu.test.tsx
```

Expected: both commands exit 0.

- [ ] **Step 9: Commit the domain migration**

```bash
git add ui/src/components/codex/SheafContextMenu.tsx ui/src/components/codex/__tests__/SheafContextMenu.test.tsx
git commit -m "refactor(ui): compose sheaf actions with RAC menus"
```

---

### Task 3: Wire native SHEAF targets and preserve drag/drop

**Files:**
- Modify: `ui/src/components/codex/Sheaf.tsx`
- Modify: `ui/src/components/codex/__tests__/Sheaf.test.tsx`

**Interfaces:**
- Consumes: `SheafContextMenu({target, children})` from Task 2.
- Produces: no new exports; removes `ReactMouseEvent` where only context handlers used it, `menu` state, `openMenu`, and `onContextMenu` props from `QuireHeaderProps` and `FolioTabProps`.

- [ ] **Step 1: Add integration tests for trigger ownership**

In `Sheaf.test.tsx`, add tests that render the live `Sheaf`, right-click the native tab target, and assert `CLOSE` is visible; right-click a quire label while the tab menu is open and assert the quire menu replaces it in one interaction. Assert that no duplicate `sheaf context menu` remains.

Add a drag/drop preservation assertion using the file's existing pragmatic-DnD mock registrations: after render, the tab's draggable registration and drop-target registration still reference the same tab container element, and the quire drop-target registration still references its visible button.

- [ ] **Step 2: Run SHEAF integration tests and confirm RED**

Run:

```bash
bun --cwd ui test src/components/codex/__tests__/Sheaf.test.tsx
```

Expected: the new tests FAIL because `Sheaf` still owns one detached coordinate-driven menu.

- [ ] **Step 3: Remove parent-owned context state**

In `Sheaf`:

- delete `menu` state and `openMenu`;
- remove coordinate-building callbacks from both tab render paths and the quire path;
- remove the detached `{menu && <SheafContextMenu ... />}`;
- remove obsolete context-menu prop declarations and imports;
- keep hover cancellation associated with drag and activation only; do not add new global listeners.

- [ ] **Step 4: Wrap the existing native targets**

Inside `QuireHeader`, wrap the existing button with:

```tsx
<SheafContextMenu target={{ kind: "quire", quireId: quire.id }}>
  <button ref={ref} ...>...</button>
</SheafContextMenu>
```

Inside `FolioTab`, wrap the existing outer `<div ref={ref}>` with:

```tsx
<SheafContextMenu target={{ kind: "tab", tabId: t.id }}>
  <div ref={ref} ...>...</div>
</SheafContextMenu>
```

Do not move `ref`, `dragHandleRef`, mouse-enter/leave handlers, click handlers, or the close button. The wrapper must render no DOM node around the native target.

- [ ] **Step 5: Run SHEAF integration and domain tests**

Run:

```bash
bun --cwd ui test src/components/codex/__tests__/Sheaf.test.tsx src/components/codex/__tests__/SheafContextMenu.test.tsx src/components/ui/__tests__/menu.test.tsx
```

Expected: all tests PASS.

- [ ] **Step 6: Check user documentation for stale interaction copy**

Read the context-menu paragraph in `ui/src/docs/content/codex-and-conversation-capture.mdx`. If it only lists available actions, leave it unchanged. If it states that rename/create occurs inline, replace that exact statement with dialog-based wording and run:

```bash
bun --cwd ui test src/docs/mdx-smoke.test.tsx
```

Expected: PASS when a docs edit is needed; otherwise record that no docs change was required.

- [ ] **Step 7: Run focused typecheck and lint**

Run:

```bash
bun --cwd ui typecheck
bun --cwd ui lint src/components/codex/Sheaf.tsx src/components/codex/__tests__/Sheaf.test.tsx
```

Expected: both commands exit 0.

- [ ] **Step 8: Commit SHEAF wiring**

```bash
git add ui/src/components/codex/Sheaf.tsx ui/src/components/codex/__tests__/Sheaf.test.tsx ui/src/docs/content/codex-and-conversation-capture.mdx
git commit -m "refactor(ui): wire RAC menus to sheaf targets"
```

If the documentation file was unchanged, omit it from `git add`.

---

### Task 4: Review, runtime verification, and integration gates

**Files:**
- Review all files changed in Tasks 1–3.
- Modify only files with evidence-backed review findings.

**Interfaces:**
- Consumes: completed shared primitive and SHEAF migration.
- Produces: verified feature branch ready to merge into `develop`.

- [ ] **Step 1: Run two-stage task reviews**

For each implementation commit, first review against its task and the approved spec, then review for correctness, accessibility, stale closures, event propagation, DOM/ref stability, and project conventions. Fix every confirmed finding in the owning task's files and rerun that task's focused tests.

- [ ] **Step 2: Launch the actual UI**

Start the Vite application with the project process runner using `bun --cwd ui dev` and wait for its reported local URL. Open `/workspace` in Chromium.

- [ ] **Step 3: Smoke-test the changed surface**

Exercise and observe:

1. Right-click an ungrouped tab; choose Close others.
2. Right-click a tab and open Add to quire; verify submenu keyboard and pointer operation.
3. Select New quire, submit a name, and observe assignment.
4. Right-click a quire; select a color and confirm selected state on reopen.
5. Rename, collapse/expand, ungroup, and close a quire.
6. Open near viewport edges and confirm the menu remains visible.
7. Open with Shift+F10, navigate by arrow keys/typeahead, press Escape, and confirm focus returns.
8. Emulate touch and long-press a target.
9. Right-click a second target while a menu is open and confirm one-gesture retargeting.
10. Drag and reorder a tab before and after menu use; confirm drag/drop remains functional.

Any failure is actionable: reproduce with the narrowest test, fix source, rerun the focused test, and repeat the smoke step.

- [ ] **Step 4: Run final required gates**

Run each command separately:

```bash
bun --cwd ui typecheck
bun --cwd ui lint
bun --cwd ui test
```

Expected: all commands exit 0; report the exact test-file and test counts from Vitest.

- [ ] **Step 5: Commit verification fixes**

If review or smoke testing changed source, commit those exact files:

```bash
git add ui/src/components/ui/menu.tsx ui/src/components/ui/__tests__/menu.test.tsx ui/src/components/codex/SheafContextMenu.tsx ui/src/components/codex/__tests__/SheafContextMenu.test.tsx ui/src/components/codex/Sheaf.tsx ui/src/components/codex/__tests__/Sheaf.test.tsx ui/src/docs/content/codex-and-conversation-capture.mdx
git commit -m "fix(ui): address context menu review findings"
```

Do not create an empty verification commit.

- [ ] **Step 6: Merge to the integration branch**

Use the finishing-development-branch workflow. Confirm the feature branch contains the approved spec, plan, implementation commits, and any review fix. Merge it into `develop` only after all gates pass, then report the merge commit and verification evidence.
