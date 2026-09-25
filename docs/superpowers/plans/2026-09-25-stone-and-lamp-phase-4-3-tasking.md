# Stone & Lamp Phase 4.3 — Tasking Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Tasking board screen to the Stone & Lamp mockup: a serif project header with cycle meta and a 4px progress bar, a sink segmented view switch, a primary "New task" button, tick-and-italic column headers, and borderless `raise` cards.

**Architecture:** Markup and class changes only; board data, drag-and-drop, filters and store behaviour are unchanged. The guard test extends to the board files. Scope ruling (executor, 2026-09-25): spec §5.6 names the header, view switch, New task, columns and cards — so this phase covers `BoardHeader`, `FilterBar` (shared control in the header), `ScopeRail`, `KanbanView`, `TaskCard`, `QuickAddRow`, `board-constants`, `board-presentation`, `TaskingScreen` and the shared `BoardModalFrame`. Backlog/Cycle/Timeline views and modal interiors (`TaskEditPanel`, `NewTaskModal`, cycle modals, `fields`) move to the phase 5 sweep.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` §5.6 "Tasking"; mockup artboard "Tasking".

## Global Constraints

- Header (48px top padding, 40px sides): tick + italic serif 19px eyebrow ("Project", or "All projects" when unscoped), serif 56px title (active project name, or "Task board"); cycle meta 14px `mute` ("Cycle S-quiet-heron · 14–27 Sep") with a 120×4px `sink` track and `accent` fill + "9 of 16"; the view switch is a `bg-sink rounded-full p-1` track with `bg-raise` selected segment (34px tall), `role="tablist"` kept; "New task" is `Button variant="primary"` (opens the task modal).
- Stats (open, in progress, blocked, completed · 14 days) stay, as sentence-case 12.5px `mute` labels over serif 26px tabular values; blocked in `hot` when > 0.
- Columns: `gap-7` between columns, no column rules; header = `Tick` (`faint` for Inbox and Done, `live` otherwise) + italic serif 24px name + 13px `mute` count; column add button a 24px round `IconButton`.
- Cards: `bg-raise rounded-[14px] px-[18px] pt-4 pb-[15px]`, no border; title 14.5px/1.45 `ink`; meta row 12.5px `mute` (6px dot, code, spacer, due); Done cards `bg-transparent` with `mute` title.
- No `cl-mono`, `cl-display`, `uppercase`, `tracking-` (positive), `border-[var(--rule…)]`, `--ink-mute`/`--ink-3`/`--ink-4`, `paper-2`, 9–11px type in guarded files.
- Gates: typecheck, lint, full suite vs develop baseline (836); only new failures count.

## Review Focus

1. Drag-and-drop between columns and column resize still work (KanbanView tests).
2. Filters still filter and count (FilterBar tests), including keyboard focus of `#tasking-filter` (⌘/ shortcut target `/`).
3. Unscoped board (no project) shows a sensible title and hides cycle meta.
4. Done/sealed cards read as done without a fill but stay legible.
5. Charcoal: `raise` cards distinct from `ground`; `faint` ticks visible.

---

### Task 1: Guard + header

**Files:** `ui/src/__tests__/primitivesGuard.test.ts`, `ui/src/components/tasking/BoardHeader.tsx` (+ its tests), `TaskingScreen.tsx` if the header needs new props.

- [ ] RED: add a `TASKING_FILES` list to the guard (`../tasking/BoardHeader.tsx`, `../filters/FilterBar.tsx`, `../tasking/ScopeRail.tsx`, `../tasking/KanbanView.tsx`, `../tasking/TaskCard.tsx`, `../tasking/QuickAddRow.tsx`, `../tasking/board-constants.tsx`, `../tasking/board-presentation.tsx`, `../tasking/TaskingScreen.tsx`, `../tasking/BoardModalFrame.tsx`), all PENDING except `BoardHeader.tsx`. Header tests: `heading level 1` is `font-serif`; the view tablist's selected tab has `bg-raise`; a "New task" button exists and opens the task modal (`useBoardStore.getState().taskModal` set); stats labels are sentence case (no `uppercase` class anywhere in the header).
- [ ] Implement the header per Global Constraints; keep `data-testid`s, the show-completed toggle (quiet `Button`, pressed state `bg-accent-tint`), `FilterBar` placement (strip below the title row on `ground`, no borders), and the op-meta line (sentence case: "Lead", "Health", "Target", "Dossier" link in `accent`).
- [ ] Commit `feat(ui): Tasking header`.

### Task 2: FilterBar

- [ ] RED: unpend `FilterBar.tsx`; test the text input is a pill on `sink`, facet chips are pills (`rounded-full`) with no border, the count is 12.5px `mute`.
- [ ] Implement with the phase-3 form contract; keep every role, label, id (`tasking-filter` via prop) and behaviour.
- [ ] Commit `feat(ui): Stone & Lamp filter bar`.

### Task 3: Scope rail

- [ ] RED: unpend `ScopeRail.tsx`; rail items are rounded rows, the active item `bg-accent-tint`, section labels sentence case italic serif.
- [ ] Implement; keep collapse (`[` toggles) and item semantics.
- [ ] Commit `feat(ui): Tasking scope rail`.

### Task 4: Columns, cards, quick add, presentation

- [ ] RED: unpend `KanbanView`, `TaskCard`, `QuickAddRow`, `board-constants`, `board-presentation`; tests: column header has a `Tick` and an italic serif name; Inbox/Done ticks `bg-faint`; cards `bg-raise rounded-[14px]` without `border`; sealed card has no fill and `text-mute` title; empty column state sentence case on `sink`.
- [ ] Implement; keep drag handles, drop targets, resize handles (restyle only), priority/status presentation mapped to Stone & Lamp tokens (priority: Critical `hot`, High `ink`, Medium `mute`, Low `faint`; status pips as 6px dots).
- [ ] Commit `feat(ui): Tasking columns and cards`.

### Task 5: Screen frame and modal frame

- [ ] RED: unpend `TaskingScreen`, `BoardModalFrame`; the modal frame panel is `bg-raise rounded-2xl` with no border and its title italic serif; the screen has no top/left rules.
- [ ] Implement.
- [ ] Commit `feat(ui): Tasking screen and modal frame`.

### Task 6: Gates, smoke, docs, merge

- [ ] Full suite vs baseline; smoke in bone and charcoal (board with tasks in several statuses, drag a card, filter, switch views, open New task); docs (`tasks-agenda-journals-and-board.mdx` pip/colour table → ticks/dots wording); review; merge.
