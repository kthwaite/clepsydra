# Stone & Lamp Phase 5.1 — Tasking rest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle every Tasking surface phase 4.3 left in Vessel chrome — Backlog, Cycle, Timeline, the task edit panel and its fields, and the task/cycle modals — to Stone & Lamp, per the approved phase 5 mockups.

**Architecture:** Pure presentation work in `ui/src/components/tasking/*`, plus one behavioural addition: a cycle strip (tabs + "New cycle") at the top of the Cycle view. The source-scan guard (`src/__tests__/primitivesGuard.test.ts`) is the gate: every file joins `TASKING_FILES` in Task 1 and sits in `PENDING` (it.fails) until its task cleans it.

**Tech Stack:** React 19, Tailwind v4 tokens, react-aria-components, zustand (`store/board.ts`), Vitest + Testing Library, Biome.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` (§2 decisions, §3 tokens, §5.5 buttons, §5.6 Tasking + dense tables).

**Mockups (visual authority):** canvas https://claude.ai/artifact/WAmCEdwj8osAmkLkRxGkQd, row p5r1; local copies in the session scratchpad `canvas5/project/`:
`TaskingBacklog.dc.html`, `TaskingCycle.dc.html`, `TaskingTimeline.dc.html`, `TaskingEdit.dc.html`, `TaskingSealCycle.dc.html`.

## Global Constraints

- Tokens only: `ground`, `sink`, `raise`, `ink`, `ink-2`, `mute`, `faint` (decoration only), `rule` (Sheaf only — no separators), `accent`, `accent-tint`, `hot` (warn), `scrim`.
- Geist for UI (14–15px ui, 12.5–13px meta, tabular numerals where aligned). Instrument Serif (`font-serif`) for titles, italic eyebrows with a `Tick`, numerals. No bold serif. No mono outside code.
- Sentence case. No `uppercase`, no positive `tracking-*`, no `text-[9|10|11]px`, no `border*` separators, no `cl-mono`/`cl-serif`/`font-mono`/`paper-2`/`ink-mute`.
- Buttons via `components/ui/button` (`primary` cobalt pill, `quiet` sink, `ghost`); no `cl-btn`.
- Surfaces 12–16px radius; modals 18px on `raise` over `scrim`; shadows only on overlays (dock, modals, popovers).
- Every existing test keeps passing unless it asserted Vessel text/classes; such assertions are rewritten to the new copy, never deleted without replacement.
- Approved mockup rulings: Cycle view gets a cycle strip with "New cycle"; the task edit dock has no dim scrim.

## Review Focus

1. Cycle strip with zero cycles — must still show Backlog + "New cycle", not an empty track.
2. Cycle strip selection must drive `cycleSel` (the same store key ScopeRail uses) so rail and strip agree.
3. Edit dock without scrim must still close on Escape and keep focus contained (it is a dialog).
4. Backlog table rows keep keyboard access (row open via Enter) after losing the Vessel grid markup.
5. Timeline bars in charcoal (night) theme — colours must come from tokens, not bone hex.

---

### Task 1: Guard entries (RED)

**Files:** Modify `ui/src/__tests__/primitivesGuard.test.ts`

- [ ] Add to `TASKING_FILES`: `../tasking/BacklogView.tsx`, `../tasking/CycleView.tsx`, `../tasking/TimelineView.tsx`, `../tasking/TaskEditPanel.tsx`, `../tasking/fields.tsx`, `../tasking/InlineEditPopover.tsx`, `../tasking/NewTaskModal.tsx`, `../tasking/NewCycleModal.tsx`, `../tasking/OpenCycleModal.tsx`, `../tasking/SealCycleModal.tsx`.
- [ ] Put all ten in `PENDING`.
- [ ] Run `bun run test src/__tests__/primitivesGuard.test.ts` — Expected: PASS (pending files fail as expected).
- [ ] Remove one entry from PENDING temporarily and confirm it FAILS with its offences listed; restore.
- [ ] Commit `test(ui): guard the remaining Tasking files`.

### Task 2: Backlog view

**Files:** `BacklogView.tsx`, `__tests__/BacklogView.test.tsx`. Mockup `TaskingBacklog.dc.html`.

- [ ] Remove `BacklogView.tsx` from PENDING; run the guard — Expected: FAIL listing offences.
- [ ] Restyle as a dense table (§5.6): no cell borders, sentence-case 12.5px `mute` header, 40px rows, hover `sink`, selected `accent-tint`, tabular numerals; group headers as tick + italic serif eyebrow with count.
- [ ] Update Vessel-text assertions in `BacklogView.test.tsx`; add a test that a row opens the task on Enter.
- [ ] Run `bun run test src/components/tasking src/__tests__/primitivesGuard.test.ts` — Expected: PASS. Commit.

### Task 3: Cycle view + cycle strip

**Files:** `CycleView.tsx`, `__tests__/CycleView.test.tsx`. Mockup `TaskingCycle.dc.html`.

- [ ] Write failing tests: a `tablist` "Cycles" lists every cycle (code + state word) plus "Backlog" with its unassigned count; the selected tab has `aria-selected=true` for the resolved cycle; clicking a tab calls `setCycleSel(code)` (Backlog → `"BACKLOG"`); a "New cycle" button calls `openCycleModal({kind:"new"})`; with zero cycles the strip still shows Backlog and New cycle.
- [ ] Implement the strip (sink track, raise selected segment, state dot: active cobalt, planned outline, closed faint).
- [ ] Remove from PENDING; restyle header (meta line, serif h2 36px, goal, quiet "Close cycle"/"Open cycle" pills, serif numeral stats) and the column/list body per mockup.
- [ ] Update Vessel assertions. Run tasking tests + guard — PASS. Commit.

### Task 4: Timeline view

**Files:** `TimelineView.tsx`, `__tests__/TimelineView.test.tsx`. Mockup `TaskingTimeline.dc.html`.

- [ ] Remove from PENDING; guard FAILS.
- [ ] Restyle: sans axis labels in `mute`, today marker in `accent`, bars on token colours (status/priority via existing constants, no bone hex literals), cycle bands on `sink`, row labels 14px.
- [ ] Add a test that no inline style in the rendered timeline carries a hex colour literal. Update Vessel assertions. PASS. Commit.

### Task 5: Task edit dock, fields, inline popover, New task modal

**Files:** `TaskEditPanel.tsx`, `fields.tsx`, `InlineEditPopover.tsx`, `NewTaskModal.tsx` + their tests. Mockup `TaskingEdit.dc.html`.

- [ ] Write failing test: the edit panel renders no scrim/backdrop element (no `bg-scrim`), still closes on Escape.
- [ ] Remove the four from PENDING; restyle: floating right dock on `raise`, 18px radius, overlay shadow; serif title; label/value fields with sentence-case `mute` labels on `sink` inputs; checklist/progress per mockup; footer actions via `Button`.
- [ ] Update assertions. Run tasking tests + guard — PASS. Commit.

### Task 6: Cycle modals

**Files:** `NewCycleModal.tsx`, `OpenCycleModal.tsx`, `SealCycleModal.tsx`, `__tests__/cycleModals.test.tsx`. Mockup `TaskingSealCycle.dc.html`.

- [ ] Remove the three from PENDING; guard FAILS.
- [ ] Restyle on `BoardModalFrame`: serif titles, sentence-case labels, summary numerals in serif, carry-over choices as a segmented control / radio list, primary `Button` for the commit action.
- [ ] Update assertions. PENDING must now be empty. Run the full UI suite, typecheck, lint. Commit.

### Task 7: Docs

- [ ] Update `ui/src/docs/content` tasking docs for any label that changed (cycle strip, "New cycle" in the Cycle view). Commit.
