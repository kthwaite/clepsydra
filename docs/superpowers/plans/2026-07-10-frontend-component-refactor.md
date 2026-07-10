# Frontend Component Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove duplicated Codex and Tasking modal mechanics, centralize tasking statistics, and extract stable repeated tasking presentation without changing behavior.

**Architecture:** Introduce separate React Aria-backed modal shells for Codex and Tasking so each visual language stays explicit. Move checklist/cycle calculations into a pure tasking module, then build only narrow presentation leaves (`CycleMetric`, `ChecklistBar`, and `CycleNavRow`) around exact duplicated structures.

**Tech Stack:** React 19, TypeScript 5.9, React Aria Components 1.17, Zustand, TanStack Query, Vitest, Testing Library, Tailwind CSS 4, Biome, Bun.

## Global Constraints

- Preserve current rendering, keyboard behavior, focus behavior, mutation payloads, labels, dimensions, test IDs, and store transitions.
- Keep Codex and Tasking modal presentation separate.
- Prefer narrow components and pure helpers over configuration-driven universal components.
- Do not combine the Kanban card, backlog register row, and cycle lane row into one universal task row.
- Do not introduce memoization or new state abstractions without a demonstrated need.
- Preserve unrelated working-tree changes.
- Inner controls that call `preventDefault()` for Escape must prevent modal dismissal.

---

### Task 1: Pure tasking statistics

**Files:**
- Create: `ui/src/components/tasking/board-stats.ts`
- Create: `ui/src/components/tasking/__tests__/board-stats.test.ts`
- Modify: `ui/src/components/tasking/CycleView.tsx:75-105,154`
- Modify: `ui/src/components/tasking/OpenCycleModal.tsx:22,41-45`
- Modify: `ui/src/components/tasking/SealCycleModal.tsx:26,29-51,80-81`
- Modify: `ui/src/components/tasking/TaskCard.tsx:48-51`
- Modify: `ui/src/components/tasking/TaskEditPanel.tsx:294-298`
- Modify: `ui/src/components/tasking/BacklogView.tsx:157-160`
- Modify: `ui/src/components/tasking/CycleView.tsx:394-396`
- Modify: `ui/src/components/tasking/__tests__/CycleView.test.tsx:16,153-216`
- Modify: `ui/src/components/tasking/__tests__/cycleModals.test.tsx:21,222-261`

**Interfaces:**
- Consumes: `BoardTask` from `#/api/board`.
- Produces:
  - `checklistProgress(checks: number[]): ChecklistProgress`
  - `cycleStats(items: BoardTask[]): CycleStatsResult`
  - `sealStats(tasks: BoardTask[], code: string): SealStatsResult`

- [ ] **Step 1: Write failing pure-helper tests**

Create `board-stats.test.ts` with explicit contracts:

```ts
import { describe, expect, it } from "vitest";
import type { BoardTask } from "#/api/board";
import {
  checklistProgress,
  cycleStats,
  sealStats,
} from "../board-stats";

const task = (patch: Partial<BoardTask> = {}): BoardTask => ({
  id: "t-1",
  code: "T-001",
  title: "Test",
  status: "FIELD",
  priority: "P2",
  project: null,
  cycle: "C-01",
  assignee: null,
  estimate: null,
  due: null,
  tags: [],
  checks: [],
  hold: null,
  link: null,
  ...patch,
});

describe("checklistProgress", () => {
  it("treats a short tuple as zero progress", () => {
    expect(checklistProgress([3])).toEqual({
      done: 0,
      total: 0,
      percent: 0,
      isComplete: false,
    });
  });

  it("preserves current percentage and exact-completion semantics", () => {
    expect(checklistProgress([1, 4])).toEqual({
      done: 1,
      total: 4,
      percent: 25,
      isComplete: false,
    });
    expect(checklistProgress([4, 4]).isComplete).toBe(true);
    expect(checklistProgress([5, 4]).isComplete).toBe(false);
  });
});

describe("cycleStats", () => {
  it("aggregates statuses, holds, and checklist tuples", () => {
    expect(
      cycleStats([
        task({ checks: [2, 5], hold: "blocked" }),
        task({ id: "t-2", status: "SEALED", checks: [3, 3] }),
      ]),
    ).toEqual({
      committed: 2,
      sealed: 1,
      field: 1,
      hold: 1,
      checkDone: 5,
      checkTot: 8,
      pct: 50,
    });
  });
});

describe("sealStats", () => {
  it("filters by cycle and derives carryover", () => {
    expect(
      sealStats([
        task(),
        task({ id: "t-2", status: "SEALED" }),
        task({ id: "t-3", cycle: "C-02" }),
      ], "C-01"),
    ).toMatchObject({ committed: 2, sealed: 1, carryover: 1, pct: 50 });
  });
});
```

Use the actual required `BoardTask` fixture shape if the API type contains additional required fields; keep assertions unchanged.

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `bun --cwd ui test src/components/tasking/__tests__/board-stats.test.ts`

Expected: FAIL because `../board-stats` does not exist.

- [ ] **Step 3: Implement the pure module**

Create `board-stats.ts`:

```ts
import type { BoardTask } from "#/api/board";

export interface ChecklistProgress {
  done: number;
  total: number;
  percent: number;
  isComplete: boolean;
}

export function checklistProgress(checks: number[]): ChecklistProgress {
  const [done, total] = checks.length >= 2 ? [checks[0], checks[1]] : [0, 0];
  return {
    done,
    total,
    percent: total > 0 ? (done / total) * 100 : 0,
    isComplete: total > 0 && done === total,
  };
}

export interface CycleStatsResult {
  committed: number;
  sealed: number;
  field: number;
  hold: number;
  checkDone: number;
  checkTot: number;
  pct: number;
}

export function cycleStats(items: BoardTask[]): CycleStatsResult {
  const committed = items.length;
  let sealed = 0;
  let field = 0;
  let hold = 0;
  let checkDone = 0;
  let checkTot = 0;

  for (const item of items) {
    if (item.status === "SEALED") sealed += 1;
    if (item.status === "FIELD") field += 1;
    if (item.hold) hold += 1;
    const progress = checklistProgress(item.checks);
    checkDone += progress.done;
    checkTot += progress.total;
  }

  return {
    committed,
    sealed,
    field,
    hold,
    checkDone,
    checkTot,
    pct: committed ? Math.round((sealed / committed) * 100) : 0,
  };
}

export interface SealStatsResult {
  committed: number;
  sealed: number;
  carryover: number;
  pct: number;
}

export function sealStats(tasks: BoardTask[], code: string): SealStatsResult {
  const base = cycleStats(tasks.filter((task) => task.cycle === code));
  return {
    committed: base.committed,
    sealed: base.sealed,
    carryover: base.committed - base.sealed,
    pct: base.pct,
  };
}
```

- [ ] **Step 4: Migrate every caller and existing pure-helper test**

Import `checklistProgress` in `TaskCard`, `TaskEditPanel`, `BacklogView`, and `CycleView`. Replace each local tuple derivation with:

```ts
const { done, total, percent: pct, isComplete: checksDone } =
  checklistProgress(task.checks);
```

Use aliases matching each component’s existing local variable names. Import `cycleStats` and `sealStats` from `./board-stats`; delete their old definitions from component files. Update existing tests to import the helpers from `../board-stats`.

- [ ] **Step 5: Run focused tasking tests**

Run: `bun --cwd ui test src/components/tasking/__tests__/board-stats.test.ts src/components/tasking/__tests__/CycleView.test.tsx src/components/tasking/__tests__/cycleModals.test.tsx src/components/tasking/__tests__/BacklogView.test.tsx src/components/tasking/__tests__/TaskEditPanel.test.tsx src/components/tasking/__tests__/KanbanView.test.tsx`

Expected: all selected tests PASS.

- [ ] **Step 6: Commit the statistics extraction**

```bash
git add ui/src/components/tasking/board-stats.ts ui/src/components/tasking/__tests__/board-stats.test.ts ui/src/components/tasking/CycleView.tsx ui/src/components/tasking/OpenCycleModal.tsx ui/src/components/tasking/SealCycleModal.tsx ui/src/components/tasking/TaskCard.tsx ui/src/components/tasking/TaskEditPanel.tsx ui/src/components/tasking/BacklogView.tsx ui/src/components/tasking/__tests__/CycleView.test.tsx ui/src/components/tasking/__tests__/cycleModals.test.tsx
git commit -m "refactor(ui): centralize tasking statistics"
```

---

### Task 2: Tasking modal frame

**Files:**
- Create: `ui/src/components/tasking/BoardModalFrame.tsx`
- Create: `ui/src/components/tasking/__tests__/BoardModalFrame.test.tsx`
- Modify: `ui/src/components/tasking/NewTaskModal.tsx:143-159,355-358`
- Modify: `ui/src/components/tasking/NewCycleModal.tsx:163-185,318-321`
- Modify: `ui/src/components/tasking/OpenCycleModal.tsx:65-81,220-223`
- Modify: `ui/src/components/tasking/SealCycleModal.tsx:118-134,289-292`

**Interfaces:**
- Consumes: React Aria `ModalOverlay`, `Modal`, and `Dialog`.
- Produces: `BoardModalFrame(props: BoardModalFrameProps)`.

- [ ] **Step 1: Write failing shell-contract tests**

Test that the frame renders a named dialog and existing test IDs, dismisses through `onOpenChange(false)`, preserves panel width, and forwards keyboard events:

```tsx
render(
  <BoardModalFrame
    ariaLabel="Test Board Dialog"
    widthClassName="w-[460px]"
    backdropTestId="test-backdrop"
    modalTestId="test-panel"
    onClose={onClose}
    onKeyDown={onKeyDown}
  >
    <button type="button">Inside</button>
  </BoardModalFrame>,
);
expect(screen.getByRole("dialog", { name: "Test Board Dialog" })).toBeVisible();
expect(screen.getByTestId("test-backdrop")).toBeVisible();
expect(screen.getByTestId("test-panel")).toHaveClass("border");
await userEvent.keyboard("{Enter}");
expect(onKeyDown).toHaveBeenCalled();
```

Use React Aria-compatible interaction for dismissing the overlay rather than calling implementation internals.

- [ ] **Step 2: Run the frame test and verify failure**

Run: `bun --cwd ui test src/components/tasking/__tests__/BoardModalFrame.test.tsx`

Expected: FAIL because `BoardModalFrame` does not exist.

- [ ] **Step 3: Implement the minimal frame**

```tsx
import type { KeyboardEventHandler, ReactNode } from "react";
import {
  Dialog as RACDialog,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import { cn } from "#/lib/cn";

export interface BoardModalFrameProps {
  ariaLabel: string;
  widthClassName: string;
  backdropTestId: string;
  modalTestId: string;
  onClose: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  constrainHeight?: boolean;
  children: ReactNode;
}

export function BoardModalFrame({
  ariaLabel,
  widthClassName,
  backdropTestId,
  modalTestId,
  onClose,
  onKeyDown,
  constrainHeight = false,
  children,
}: BoardModalFrameProps) {
  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-[9000] flex justify-center bg-black/60 pt-[9vh] backdrop-blur-[2px]"
      data-testid={backdropTestId}
    >
      <Modal className={cn(widthClassName, "max-w-[94vw]")}>
        <RACDialog aria-label={ariaLabel} className="outline-none">
          <div
            className={cn(
              "flex flex-col border border-[var(--ink-3)] bg-[var(--bg)]",
              constrainHeight && "max-h-[82vh]",
            )}
            style={{
              boxShadow:
                "0 20px 80px rgba(0,0,0,0.7), 0 0 0 1px var(--rule)",
            }}
            onKeyDown={onKeyDown}
            data-testid={modalTestId}
          >
            {children}
          </div>
        </RACDialog>
      </Modal>
    </ModalOverlay>
  );
}
```

- [ ] **Step 4: Migrate all four tasking dialogs**

Replace only the duplicated outer wrapper. For example:

```tsx
<BoardModalFrame
  ariaLabel="New Tasking"
  widthClassName="w-[660px]"
  backdropTestId="new-task-modal-backdrop"
  modalTestId="new-task-modal"
  onClose={closeTaskModal}
  onKeyDown={handleKeyDown}
  constrainHeight
>
  {/* existing header, body, and footer unchanged */}
</BoardModalFrame>
```

Use `600px` for New Cycle and `460px` for Open/Seal Cycle. Pass the New Cycle Cmd/Ctrl+Enter handler. Do not add a shell key handler to Open/Seal; React Aria owns Escape dismissal.

- [ ] **Step 5: Run modal-focused tests**

Run: `bun --cwd ui test src/components/tasking/__tests__/BoardModalFrame.test.tsx src/components/tasking/__tests__/NewTaskModal.test.tsx src/components/tasking/__tests__/cycleModals.test.tsx`

Expected: all selected tests PASS, including Escape, backdrop, close-button, and Cmd/Ctrl+Enter cases.

- [ ] **Step 6: Commit the tasking frame**

```bash
git add ui/src/components/tasking/BoardModalFrame.tsx ui/src/components/tasking/__tests__/BoardModalFrame.test.tsx ui/src/components/tasking/NewTaskModal.tsx ui/src/components/tasking/NewCycleModal.tsx ui/src/components/tasking/OpenCycleModal.tsx ui/src/components/tasking/SealCycleModal.tsx
git commit -m "refactor(ui): share tasking modal frame"
```

---

### Task 3: Cycle metric and checklist bar leaves

**Files:**
- Create: `ui/src/components/tasking/board-presentation.tsx`
- Create: `ui/src/components/tasking/__tests__/board-presentation.test.tsx`
- Modify: `ui/src/components/tasking/OpenCycleModal.tsx:127-163`
- Modify: `ui/src/components/tasking/SealCycleModal.tsx:167-215`
- Modify: `ui/src/components/tasking/TaskCard.tsx:117-135`
- Modify: `ui/src/components/tasking/TaskEditPanel.tsx:493-510`

**Interfaces:**
- Consumes: `ChecklistProgress` values from Task 1.
- Produces:
  - `CycleMetric(props: CycleMetricProps)`
  - `ChecklistBar(props: ChecklistBarProps)`

- [ ] **Step 1: Write failing presentation tests**

Cover zero-padding, optional color, percentage width, completion color, and indicator test ID:

```tsx
render(<CycleMetric label="SEALED" value={3} testId="sealed" color="var(--cool)" />);
expect(screen.getByText("SEALED")).toBeVisible();
expect(screen.getByTestId("sealed")).toHaveTextContent("03");
expect(screen.getByTestId("sealed")).toHaveStyle({ color: "var(--cool)" });

render(
  <ChecklistBar
    percent={50}
    isComplete={false}
    className="h-[6px]"
    indicatorTestId="checklist-indicator"
  />,
);
expect(screen.getByTestId("checklist-indicator")).toHaveStyle({ width: "50%" });
```

- [ ] **Step 2: Run the presentation test and verify failure**

Run: `bun --cwd ui test src/components/tasking/__tests__/board-presentation.test.tsx`

Expected: FAIL because `board-presentation.tsx` does not exist.

- [ ] **Step 3: Implement narrow leaf components**

`CycleMetric` renders the exact repeated label/value typography. `ChecklistBar` renders only the border/background track and its indicator; callers retain margins, count text, and field labels.

```tsx
export function ChecklistBar({
  percent,
  isComplete,
  className,
  indicatorTestId,
}: ChecklistBarProps) {
  return (
    <span className={cn("block border border-[var(--rule)] bg-[var(--bg-3)]", className)}>
      <i
        className="block h-full"
        style={{
          width: `${percent}%`,
          background: isComplete ? "var(--cool)" : "var(--ink-2)",
        }}
        data-testid={indicatorTestId}
      />
    </span>
  );
}
```

- [ ] **Step 4: Migrate exact repeated leaves**

Replace seven cycle metric cells with `CycleMetric`. Preserve every existing metric test ID and conditional color. Replace the card and edit-panel inner progress tracks with `ChecklistBar`; preserve outer spacing, count text, `edit-panel-checklist-bar`, and the existing card appearance.

- [ ] **Step 5: Run affected tests**

Run: `bun --cwd ui test src/components/tasking/__tests__/board-presentation.test.tsx src/components/tasking/__tests__/cycleModals.test.tsx src/components/tasking/__tests__/TaskEditPanel.test.tsx src/components/tasking/__tests__/KanbanView.test.tsx`

Expected: all selected tests PASS.

- [ ] **Step 6: Commit presentation leaves**

```bash
git add ui/src/components/tasking/board-presentation.tsx ui/src/components/tasking/__tests__/board-presentation.test.tsx ui/src/components/tasking/OpenCycleModal.tsx ui/src/components/tasking/SealCycleModal.tsx ui/src/components/tasking/TaskCard.tsx ui/src/components/tasking/TaskEditPanel.tsx
git commit -m "refactor(ui): share tasking progress presentation"
```

---

### Task 4: Codex modal shell

**Files:**
- Create: `ui/src/components/codex/CodexModalShell.tsx`
- Create: `ui/src/components/codex/__tests__/CodexModalShell.test.tsx`
- Modify: `ui/src/components/codex/LocationModal.tsx:1,14-45`
- Modify: `ui/src/components/codex/InscribeModal.tsx:1,117-139,215-217`
- Modify: `ui/src/components/codex/ShortcutHelpModal.tsx:1,9-33,76-78`
- Modify: `ui/src/components/codex/CommandPalette.tsx:222-252,362-364`
- Modify: existing Codex modal tests where React Aria portal behavior requires queries against `document.body`.

**Interfaces:**
- Consumes: React Aria `ModalOverlay`, `Modal`, and `Dialog`; `cn`.
- Produces: `CodexModalShell(props: CodexModalShellProps)`.

- [ ] **Step 1: Write failing accessibility/dismissal tests**

Tests must cover:

```tsx
expect(screen.getByRole("dialog", { name: "Test Codex Dialog" })).toBeVisible();
await userEvent.keyboard("{Escape}");
expect(onDismiss).toHaveBeenCalledTimes(1);
```

Add a child input that calls `preventDefault()` and `stopPropagation()` on Escape; assert `onDismiss` remains uncalled for that event. Add backdrop dismissal and focus-restoration assertions using a trigger button focused before render/open.

- [ ] **Step 2: Run the shell test and verify failure**

Run: `bun --cwd ui test src/components/codex/__tests__/CodexModalShell.test.tsx`

Expected: FAIL because `CodexModalShell` does not exist.

- [ ] **Step 3: Implement the React Aria shell**

```tsx
import type { KeyboardEventHandler, ReactNode } from "react";
import {
  Dialog as RACDialog,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import { cn } from "#/lib/cn";

export interface CodexModalShellProps {
  ariaLabel: string;
  maxWidthClassName: string;
  onDismiss: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  panelClassName?: string;
  children: ReactNode;
}

export function CodexModalShell({
  ariaLabel,
  maxWidthClassName,
  onDismiss,
  onKeyDown,
  panelClassName,
  children,
}: CodexModalShellProps) {
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 pt-20"
    >
      <Modal className={cn("w-[88%]", maxWidthClassName)}>
        <RACDialog
          aria-label={ariaLabel}
          onKeyDown={onKeyDown}
          className={cn(
            "border-[1.5px] border-ink bg-paper font-body text-ink outline-none",
            panelClassName,
          )}
        >
          {children}
        </RACDialog>
      </Modal>
    </ModalOverlay>
  );
}
```

If React Aria invokes `onOpenChange(false)` after an inner prevented Escape despite event propagation, guard dismissal with the documented event behavior rather than reintroducing a global `window` listener.

- [ ] **Step 4: Migrate Location, Inscribe, and Shortcut Help**

Delete their custom scrim click and global Escape implementations. Pass each existing dismiss function to `onDismiss`. Preserve widths: `520px`, `520px`, and `560px`. Preserve `flex flex-col` on Shortcut Help via `panelClassName`.

For `InscribeModal`, continue passing `dismiss`, not raw `onClose`, so local state resets on every dismissal path.

- [ ] **Step 5: Migrate Command Palette without changing navigation**

Pass `onKeyDown={onKey}` and `onDismiss={close}`. Preserve its `680px` width, `w-[92%]` behavior through an explicit width prop or panel class, and its flex-column layout. ArrowUp, ArrowDown, Enter, and Escape selection behavior remain in `CommandPalette`.

- [ ] **Step 6: Run all Codex modal tests**

Run: `bun --cwd ui test src/components/codex/__tests__/CodexModalShell.test.tsx src/components/codex/__tests__/LocationModal.test.tsx src/components/codex/__tests__/InscribeModal.test.tsx src/components/codex/__tests__/ShortcutHelpModal.test.tsx`

Also run the existing Command Palette test file located by the repository test glob; if none exists, add `CommandPalette.test.tsx` covering ArrowDown plus Enter and Escape.

Expected: all selected tests PASS.

- [ ] **Step 7: Commit the Codex shell**

```bash
git add ui/src/components/codex/CodexModalShell.tsx ui/src/components/codex/__tests__/CodexModalShell.test.tsx ui/src/components/codex/LocationModal.tsx ui/src/components/codex/InscribeModal.tsx ui/src/components/codex/ShortcutHelpModal.tsx ui/src/components/codex/CommandPalette.tsx ui/src/components/codex/__tests__
git commit -m "refactor(ui): share Codex modal shell"
```

---

### Task 5: Scope rail cycle row

**Files:**
- Modify: `ui/src/components/tasking/ScopeRail.tsx:252-326`
- Modify: `ui/src/components/tasking/__tests__/ScopeRail.test.tsx`

**Interfaces:**
- Consumes: existing `CycleStatePip`, `cn`, and board-store setters.
- Produces: file-local `CycleNavRow(props: CycleNavRowProps)`.

- [ ] **Step 1: Add behavior-preservation tests**

Add assertions that:

- a real cycle displays its code, formatted window, state pip, and count;
- clicking a real cycle sets `cycleSel` and mode;
- backlog displays `BKLG`, `unscheduled`, and counts only tasks without a cycle;
- clicking backlog sets `cycleSel` to `BACKLOG` and mode to `cycle`;
- active real and backlog rows receive the active border/background classes.

- [ ] **Step 2: Run ScopeRail tests before refactoring**

Run: `bun --cwd ui test src/components/tasking/__tests__/ScopeRail.test.tsx`

Expected: new behavior-preservation tests PASS against current code. They are characterization tests; if any fail, correct the test expectation to match observed intended behavior before refactoring.

- [ ] **Step 3: Extract one file-local row component**

```tsx
interface CycleNavRowProps {
  code: string;
  displayCode: string;
  state: string;
  windowLabel: string;
  count: number;
  active: boolean;
  onSelect: () => void;
}
```

Render the existing button structure once. Map real cycle data into it and render backlog with explicit props. Compute counts outside the row so it remains presentational.

- [ ] **Step 4: Run ScopeRail tests after refactoring**

Run: `bun --cwd ui test src/components/tasking/__tests__/ScopeRail.test.tsx`

Expected: all tests PASS with unchanged labels, counts, store state, and active classes.

- [ ] **Step 5: Commit the ScopeRail extraction**

```bash
git add ui/src/components/tasking/ScopeRail.tsx ui/src/components/tasking/__tests__/ScopeRail.test.tsx
git commit -m "refactor(ui): share scope rail cycle rows"
```

---

### Task 6: Integrated verification and cleanup

**Files:**
- Modify only files already touched where formatter, typecheck, or review exposes a defect.

**Interfaces:**
- Consumes: all prior task deliverables.
- Produces: verified behavior-preserving frontend refactor.

- [ ] **Step 1: Review the resulting diff for forbidden abstractions**

Confirm there is no universal task row, no monolithic task form, no cross-domain universal modal configuration, no compatibility alias, and no stale exported `cycleStats`/`sealStats` in component files.

- [ ] **Step 2: Run focused behavioral suites together**

Run:

```bash
bun --cwd ui test src/components/tasking/__tests__ src/components/codex/__tests__
```

Expected: all Tasking and Codex component tests PASS.

- [ ] **Step 3: Run typecheck**

Run: `bun --cwd ui run typecheck`

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 4: Run lint**

Run: `bun --cwd ui run lint`

Expected: exit code 0 with no Biome lint errors.

- [ ] **Step 5: Run the complete frontend test suite**

Run: `bun --cwd ui run test`

Expected: exit code 0 with all Vitest suites passing.

- [ ] **Step 6: Run the production build**

Run: `bun --cwd ui run build`

Expected: exit code 0 with TypeScript and Vite build succeeding.

- [ ] **Step 7: Perform browser smoke tests**

Run the frontend in its normal development environment and exercise:

- open/dismiss Location, Intake, shortcut help, and command palette;
- consume Escape inside the Intake tag suggestions before dismissing the modal;
- navigate and execute one command-palette item with the keyboard;
- open/dismiss New Task, New Cycle, Open Cycle, and Seal Cycle;
- select a real cycle and backlog from ScopeRail;
- verify task checklist bars and cycle metrics visually match their previous layout.

Expected: no visible layout regression; focus remains inside each open dialog and returns to its trigger after dismissal.

- [ ] **Step 8: Commit verification fixes if any were required**

```bash
git add ui/src
git commit -m "fix(ui): preserve refactor behavior contracts"
```

Skip this commit if verification required no changes.
