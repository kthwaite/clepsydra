# Task Board Language Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Task Board's operational/register vocabulary with the approved neutral Kanban language without changing persisted data or behavior.

**Architecture:** Keep internal board status IDs, mode IDs, sentinels, routes, API fields, and Markdown contracts unchanged. Centralize fixed human-facing status and priority labels in the existing `board-constants.tsx` presentation module, then migrate every Task Board component, accessible label, tooltip, placeholder, toast, test, and related help page to those labels.

**Tech Stack:** React 19, TypeScript 5.9, React Aria Components, Vitest, Testing Library, Biome, Vite, Rust backend contracts retained unchanged.

**Spec:** `CONTEXT.md`

## Global Constraints

- This is a display-language cutover only. Keep `/tasking`, component/module names, API fields, store mode IDs, sentinels, persisted status IDs (`INTAKE`, `TRIAGE`, `FIELD`, `REVIEW`, `SEALED`), cycle state IDs, and task/cycle file formats unchanged.
- Human-facing status labels are exactly: `Inbox`, `Ready`, `In Progress`, `Review`, `Done`.
- Human-facing priority labels are exactly: `P0 Critical`, `P1 High`, `P2 Medium`, `P3 Low`; compact cards may show only `P0`–`P3`.
- Main view labels are exactly: `Board`, `List`, `Cycles`, `Timeline`. `List` continues to show all matching tasks. `Backlog` means tasks without a cycle.
- Use title case for short labels, sentence case for messages, and full words instead of register abbreviations.
- Change visible text, accessible names, tooltips, placeholders, Task Board documentation, and tests asserting human-facing copy.
- Do not change unrelated Agenda, Atrium, editor, API, or persistence behavior. `Todo` is canonical glossary language, but this implementation updates only Task Board-related documentation.
- Tests must assert rendered behavior through Testing Library. Do not add source-text assertions.

---

### Task 1: Shared Display Vocabulary

**Files:**
- Modify: `ui/src/components/tasking/board-constants.tsx`
- Modify: `ui/src/components/tasking/TaskingScreen.tsx`
- Modify: `ui/src/components/tasking/fields.tsx`
- Modify: `ui/src/components/tasking/__tests__/board-constants.test.tsx`
- Modify: `ui/src/components/tasking/__tests__/TaskingScreen.test.tsx`

**Interfaces:**
- Consumes: Existing persisted status IDs, `COL_ORDER`, `PRI_ORDER`, `ColLabelFn`, and server `BoardColumn` data.
- Produces: One canonical status-label mapping/function used by every Task Board view; neutral priority labels; neutral mode labels; human-facing filter and radio-group labels.

- [ ] **Step 1: Write failing presentation tests**

Assert that status IDs render as `Inbox`, `Ready`, `In Progress`, `Review`, and `Done`; priority descriptions use `Critical`, `High`, `Medium`, and `Low`; modes expose `Board`, `List`, `Cycles`, and `Timeline`; filters expose `Project`, `Tags`, `Priority`, `Status`, and `Blocked`. Add a regression proving server label `DEPLOYED` cannot replace the fixed `In Progress` display label.

- [ ] **Step 2: Run tests and verify red**

Run: `bun run test src/components/tasking/__tests__/board-constants.test.tsx src/components/tasking/__tests__/TaskingScreen.test.tsx`

Expected: failures name the old status, mode, priority, and filter copy.

- [ ] **Step 3: Implement the minimal shared mappings**

Add the fixed human-facing mapping to `board-constants.tsx`. Keep internal IDs unchanged. Make `TaskingScreen` build `colLabel` from the fixed mapping rather than server display copy. Update `PRI_LABEL`, `MODES`, filter labels, and `fields.tsx` accessible names to the approved terms.

- [ ] **Step 4: Run focused tests and verify green**

Run the Step 2 command. Expected: all selected tests pass.

- [ ] **Step 5: Commit**

Commit message: `feat(tasking): centralize neutral display vocabulary`

---

### Task 2: Board Shell and Views

**Files:**
- Modify: `ui/src/components/tasking/BoardHeader.tsx`
- Modify: `ui/src/components/tasking/ScopeRail.tsx`
- Modify: `ui/src/components/tasking/KanbanView.tsx`
- Modify: `ui/src/components/tasking/BacklogView.tsx`
- Modify: `ui/src/components/tasking/CycleView.tsx`
- Modify: `ui/src/components/tasking/TimelineView.tsx`
- Modify: `ui/src/components/tasking/TaskCard.tsx`
- Modify: matching tests under `ui/src/components/tasking/__tests__/`

**Interfaces:**
- Consumes: Canonical status and priority presentation from Task 1.
- Produces: Neutral Task Board shell, scope rail, board/list/cycle/timeline views, metrics, headings, empty states, WIP copy, and card metadata.

- [ ] **Step 1: Update tests first**

Cover these observable contracts:

- Header title `Task Board`; no `OPS REGISTER`; subtitle/count language uses projects and cycles.
- Metrics `Open`, `In progress`, `Blocked`, `Completed · 14 days`, and `No completed tasks`.
- Scope labels `Scope`, `Projects`, `All projects`, `No project`, `Cycles`, and `Backlog`.
- Column counts use `1 task · limit N` / `N tasks · limit N`; empty column text is `No tasks`.
- List headings are `ID`, `Task`, `Project`, `Status`, `Assignee`, `Estimate`, `Due`, `Checklist`.
- Cycle summaries use `Tasks`, `Done`, `In progress`, `Blocked`, `Checklist items`, `Completion`, and `Progress`.
- Timeline and empty-state copy uses `No scheduled tasks`, `Tasks with no project`, and `No due date · in Backlog or Inbox`.

- [ ] **Step 2: Run changed view tests and verify red**

Run: `bun run test src/components/tasking/__tests__/BoardHeader.test.tsx src/components/tasking/__tests__/ScopeRail.test.tsx src/components/tasking/__tests__/KanbanView.test.tsx src/components/tasking/__tests__/BacklogView.test.tsx src/components/tasking/__tests__/CycleView.test.tsx src/components/tasking/__tests__/TimelineView.test.tsx`

Expected: copy assertions fail against old register vocabulary.

- [ ] **Step 3: Implement shell and view copy**

Replace human-facing literals only. Preserve filtering, drag-and-drop, WIP enforcement, counts, task grouping, cycle selection, burndown data, and timeline calculations. Use canonical label functions instead of duplicating status maps.

- [ ] **Step 4: Run focused tests and verify green**

Run the Step 2 command. Expected: all selected tests pass.

- [ ] **Step 5: Commit**

Commit message: `feat(tasking): rename board shell and views`

---

### Task 3: Task Creation, Editing, and Feedback

**Files:**
- Modify: `ui/src/components/tasking/NewTaskModal.tsx`
- Modify: `ui/src/components/tasking/TaskEditPanel.tsx`
- Modify: `ui/src/components/tasking/QuickAddRow.tsx`
- Modify: `ui/src/api/board.ts`
- Modify: `ui/src/components/tasking/__tests__/NewTaskModal.test.tsx`
- Modify: `ui/src/components/tasking/__tests__/TaskEditPanel.test.tsx`
- Modify: `ui/src/components/tasking/__tests__/QuickAddRow.test.tsx`

**Interfaces:**
- Consumes: Canonical labels from Task 1 and unchanged task mutation APIs.
- Produces: Neutral task form fields, actions, placeholders, accessible labels, save/archive feedback, and action-specific failure messages.

- [ ] **Step 1: Write failing task-form tests**

Assert:

- Trigger/modal/action language: `New task`, `Create task`, `Creating…`, `Cancel`.
- Fields: `Title`, `Description`, `Project`, `Cycle`, `Status`, `Priority`, `Assignee`, `Estimate`, `Start date`, `Due date`, `Tags`, `Checklist`, `Blocker`, `Related page`.
- Select choices: `No project` and `Backlog`.
- Block toggle: `Blocked` and `Active`; blocker reason remains editable.
- Archive copy: `Archive`, `Confirm archive`, `Archiving…`, `Moving to Rubbish Bin…`, `Changes saved automatically`.
- Failure feedback: `Couldn’t create task` and `Couldn’t archive task` where the existing mutation paths expose feedback.
- Existing POST/PATCH payloads remain byte-for-byte equivalent apart from user-entered values.

- [ ] **Step 2: Run focused tests and verify red**

Run: `bun run test src/components/tasking/__tests__/NewTaskModal.test.tsx src/components/tasking/__tests__/TaskEditPanel.test.tsx src/components/tasking/__tests__/QuickAddRow.test.tsx`

Expected: copy assertions fail while payload assertions remain valid.

- [ ] **Step 3: Implement form and feedback copy**

Change only rendered copy, aria labels, tooltips, placeholders, and existing toast messages. Do not rename props, state fields, wire payload keys, sentinels, or mutation hooks.

- [ ] **Step 4: Run focused tests and verify green**

Run the Step 2 command. Expected: all selected tests pass.

- [ ] **Step 5: Commit**

Commit message: `feat(tasking): use neutral task form language`

---

### Task 4: Cycle Lifecycle Language

**Files:**
- Modify: `ui/src/components/tasking/NewCycleModal.tsx`
- Modify: `ui/src/components/tasking/OpenCycleModal.tsx`
- Modify: `ui/src/components/tasking/SealCycleModal.tsx`
- Modify: `ui/src/components/tasking/__tests__/cycleModals.test.tsx`

**Interfaces:**
- Consumes: Unchanged cycle mutation APIs and states `PLANNED`, `ACTIVE`, `CLOSED`.
- Produces: Distinct create/start/close actions and neutral incomplete-task movement choices.

- [ ] **Step 1: Write failing lifecycle tests**

Assert:

- Creation: `New cycle`, fields `Name`, `ID`, `Start date`, `End date`, `Status`, `Goal`, action `Create cycle`, progress `Creating…`, placeholder `What this cycle should achieve`.
- Activation: `Start cycle`, `Starting…`, target state `Active`.
- Closure: `Close cycle`, `Closing…`, `Incomplete tasks`, `Move to Backlog`, `Move to {cycle}`, `Keep in this cycle`, `{cycle} → Closed`.
- Clean close: `All tasks are done. This cycle is ready to close.`
- Metrics: `Tasks`, `Done`, `Incomplete tasks`, `Completion`.
- Existing PATCH bodies retain `ACTIVE`, `CLOSED`, `BACKLOG`, target cycle codes, and omitted `carry_to` for keep-in-cycle.

- [ ] **Step 2: Run cycle tests and verify red**

Run: `bun run test src/components/tasking/__tests__/cycleModals.test.tsx`

Expected: human-facing copy fails; wire-contract assertions still describe existing IDs.

- [ ] **Step 3: Implement cycle copy**

Replace human-facing lifecycle language. Keep component names, mutation fields, carry sentinels, state IDs, date calculations, and atomic carry behavior unchanged.

- [ ] **Step 4: Run cycle tests and verify green**

Run the Step 2 command. Expected: all selected tests pass.

- [ ] **Step 5: Commit**

Commit message: `feat(tasking): clarify cycle lifecycle language`

---

### Task 5: Glossary and Task Board Documentation

**Files:**
- Create: `CONTEXT.md`
- Modify: `ui/src/docs/content/tasks-agenda-journals-and-board.mdx`
- Modify: `ui/src/docs/content/getting-started.mdx`
- Modify: documentation tests only if the repository has existing rendered-copy assertions for these pages.

**Interfaces:**
- Consumes: Final rendered language from Tasks 1–4.
- Produces: Canonical domain glossary and user documentation that distinguishes Task, Todo, and Checklist Item while documenting persisted codes only where users need the file/API contract.

- [ ] **Step 1: Add or update rendered documentation assertions if an existing convention exists**

Cover the Task Board title, five display statuses paired with persisted IDs in technical sections, view names, Project/Cycle/Backlog terms, Task versus Todo distinction, and cycle create/start/close language. Do not invent a documentation test framework if none exists.

- [ ] **Step 2: Run relevant documentation tests and verify red when applicable**

Run the narrow existing docs test command discovered in the repository. If no rendered documentation assertion exists, record that this task is documentation-only and proceed without a synthetic source-text test.

- [ ] **Step 3: Update glossary and documentation**

Use neutral labels in ordinary prose. Show `Inbox (INTAKE)`, `Ready (TRIAGE)`, `In Progress (FIELD)`, `Review (REVIEW)`, and `Done (SEALED)` only in file/API contract explanations. Define `Task` as page-backed board work, `Todo` as any Markdown checkbox regardless of status, and `Checklist Item` as a Todo inside a Task. Do not rename unrelated Agenda/Atrium/editor copy.

- [ ] **Step 4: Run documentation tests when applicable**

Expected: relevant docs tests pass.

- [ ] **Step 5: Commit**

Commit message: `docs(tasking): document neutral board language`

---

### Task 6: Final Verification and Visual Smoke Test

**Files:**
- Modify only files required to fix findings from verification or review.

**Interfaces:**
- Consumes: Completed Tasks 1–5.
- Produces: Verified feature branch ready to merge.

- [ ] **Step 1: Run focused Task Board suite**

Run: `bun run test src/components/tasking`

Expected: 18 Task Board test files pass.

- [ ] **Step 2: Run UI typecheck**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 3: Run UI lint**

Run: `bun run lint`

Expected: exit 0.

- [ ] **Step 4: Run UI full test suite**

Run: `bun run test`

Expected: exit 0. Baseline note: the initial all-files run produced 64 timeouts/failures under concurrent load while `bun run test src/components/tasking` passed 492/492; any final full-suite failure must be reported exactly and compared against that baseline rather than attributed to this change without evidence.

- [ ] **Step 5: Build UI and run Rust gates**

Run: `bun run build`, then `cargo test` from the repository root. Run the repository's Rust lint command if documented; otherwise run `cargo clippy --all-targets --all-features -- -D warnings`.

Expected: all commands exit 0, aside from any explicitly baselined unrelated failure.

- [ ] **Step 6: Smoke test the actual Task Board**

Start the application using the repository's normal development command. Open `/tasking` in a real browser. Verify the Board, List, Cycles, and Timeline tabs; Scope rail; new/edit Task flows; and create/start/close Cycle dialogs show the approved language. Confirm no persisted IDs or payload behavior changed.

- [ ] **Step 7: Commit verification fixes if any**

Commit message: `fix(tasking): address language cutover verification`
