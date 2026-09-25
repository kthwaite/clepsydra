# Stone & Lamp Phase 4.2 — Atrium Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Atrium to the Stone & Lamp mockup while keeping every panel (spec decision 11): hero, Recent + Outstanding agenda, Feed river, Brimley-Cocoon Line + Sky, Activity, Reading continues.

**Architecture:** Keep the 12-column grid and every region/label the tests rely on; change spacing, type and surfaces. Panels become borderless `Section`s (tick + italic serif eyebrow, indented body) on the page ground, 96px apart horizontally and ~112px vertically. The hero drops the grid texture and the Search button (⌘K covers it). A screen guard extends `primitivesGuard.test.ts` to the Atrium files so Vessel tokens cannot creep back.

**Tech Stack:** React 19, Tailwind v4, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` — decision 11, §3.3 (space), §5.6 "Atrium"; mockup artboard "Atrium".

## Global Constraints

- Page: `px-10 xl:px-[120px] pt-[88px] pb-[120px]`, grid `grid-cols-12 gap-x-24 gap-y-[112px]`, max width 1600px centred.
- Sections: `Section` (tick + italic serif 22px eyebrow, 22px header gap, body indented 19px). No borders, bands or `paper-2` fills; recessed bits use `sink`.
- Type: Geist for UI; Instrument Serif for the greeting, eyebrows, page titles in lists, big numerals; sentence case; 12.5–16px meta in `mute`; tabular numerals for counts/times.
- Hero: day-start line `Tick variant="pulse"` + "Friday 25 September 2026 · Week 39 · Day 268 of 365 · 10:42 local" (14px `mute`, date in `ink`); greeting serif `clamp(56px,8vw,112px)`; right column 340px: primary cobalt journal card (`rounded-[18px] bg-accent text-raise`, title 16px/500, sub 12.5px at 78%), then two quiet tiles (Capture ⌘N, AI journal) `rounded-[14px] bg-sink`. No Search tile, no `cl-grid-texture`.
- Heatmap: cobalt alpha steps 22 / 45 / 70 / 100% over a `sink` empty cell, 3px radius. Moon/day-arc drawn in cobalt on `sink`.
- No `cl-mono`, `uppercase`, `tracking-`, `border-rule`, `paper-2`, `ink-mute`, `text-[9–11px]` in guarded files.
- Out of scope: the full-page Feeds reader (`FeedRiver` full mode) — only its `compact` branch (the Atrium river) is restyled; `PreviewBody`.
- Gates: typecheck, lint, full suite vs develop baseline (836); only new failures count.

## Review Focus

1. Every panel still renders in the approved DOM order and spans (Atrium.test "single-column DOM order").
2. Sky without a location: the overlay prompt and its "Set location" action stay usable.
3. Feeds disabled: no feed panel and no feed query (existing test).
4. Heatmap keyboard: cells stay focusable/pressable and the day popover opens (ActivityHeatmap tests).
5. Charcoal: cobalt heat steps and `mute` meta stay legible on `ground`.

---

### Task 1: Guard, page frame and hero

**Files:** `ui/src/__tests__/primitivesGuard.test.ts`, `ui/src/components/codex/Atrium.tsx`, `ui/src/components/codex/Atrium.test.tsx`, `FeedAtriumQueryPolicy.integration.test.tsx`

- [ ] **Step 1 (RED):**
  - Guard: add a `SCREEN_FILES` list appended to `files` — `../codex/Atrium.tsx`, `../codex/AgendaTile.tsx`, `../codex/FeedRiverPanel.tsx`, `../codex/SkyCard.tsx`, `../codex/ActivityHeatmap.tsx`, `../codex/ReadingContinues.tsx`, `../codex/MoonDisc.tsx`, `../codex/DayArc.tsx` — and put all of them in `PENDING`; later tasks remove them. (If one is already clean, `it.fails` will say so: remove it.)
  - Remove `../codex/Atrium.tsx` from `PENDING` now.
  - Atrium tests: replace every `/DAYSTART \//` lookup with `/Week \d+ · Day \d+ of \d+/`; in "keeps daystart compact…" drop the Search button expectation and add `expect(within(daystart).queryByRole("button", { name: /Search/ })).toBeNull();`; add:

```tsx
  it("greets in serif without the Vessel grid texture", () => {
    render(<Atrium />);
    const greeting = screen.getByRole("heading", { level: 1 });
    expect(greeting).toHaveClass("font-serif");
    expect(document.querySelector(".cl-grid-texture")).toBeNull();
  });
```

  - Integration test: `/DAYSTART \//` → `/Week \d+ · Day \d+ of \d+/`.
- [ ] **Step 2:** Run Atrium.test, the integration test and the guard. Expected: FAIL.
- [ ] **Step 3:** Implement the page frame (Global Constraints) and the hero; recents header count becomes "8 of 1,204" style (`{n} of {total}` with `toLocaleString`) — update the `/^\d+ OF \d+$/` lookups to `/^\d+ of [\d,]+$/`.
- [ ] **Step 4:** Tests pass; typecheck; lint. **Step 5:** Commit `feat(ui): Atrium frame and hero`.

### Task 2: Recent

**Files:** `Atrium.tsx`, `Atrium.test.tsx`

- [ ] **RED:** add a test that the Recent block is a `Section`-style heading "Recent" (`getByRole("heading", { name: "Recent" })` with `font-serif`), its tabs are text tabs (the selected one has `underline` and `decoration-accent`), and rows render the title in `text-[16px]` with a serif row number.
- [ ] **Implement:** the Recent column as a `section` with the Section header shape (tick + eyebrow "Recent" + inline tabs Edited / Created / Opened + spacer + "{n} of {total}"), body `pl-[19px]`, rows `grid grid-cols-[34px_22px_minmax(0,1fr)_170px_72px] items-baseline gap-3 py-[11px]` (number serif 16px `faint` tabular, `KindIcon tone="mono"` in `mute`, title 16px truncate, folder 13px `mute` truncate, relative time 13px `mute` right); mobile collapses the folder column. Empty states in sentence case `mute`. Keep `col-span-12 lg:col-span-7`, the `role="tab"`-free buttons and their accessible names.
- [ ] Tests, typecheck, lint; commit `feat(ui): Atrium Recent list`.

### Task 3: Outstanding agenda

**Files:** `AgendaTile.tsx`, `AgendaTile.test.tsx`, guard (remove from PENDING)

- [ ] **RED:** remove from PENDING; add to `AgendaTile.test.tsx`: the task text renders at `text-[15.5px]`, the "Agenda →" action is cobalt text (`text-accent`), and no row uses `divide-y`.
- [ ] **Implement:** `Section`-style header (label "Outstanding agenda", count caption, action "Agenda →" as a text link button `text-[14px] text-accent`), list `pl-[19px] flex flex-col gap-[18px]`, row `grid grid-cols-[18px_minmax(0,1fr)] gap-3`: the existing checkbox/toggle, then parent line "↳ parent" 12.5px `mute`, text 15.5px/1.4, meta line 12.5px `mute` (due in `hot` when overdue, priority, source link underlined `mute`). Keep region name and ARIA.
- [ ] Tests; commit `feat(ui): Atrium agenda`.

### Task 4: Feed river (Atrium)

**Files:** `FeedRiverPanel.tsx`, `FeedRiverPanel.test.tsx`, `FeedRiver.tsx` (compact branch only), `FeedRiver.test.tsx`, guard

- [ ] **RED:** remove FeedRiverPanel from PENDING; caption test: counts in sentence case ("14 unread · 3 saved · 9 sources"); the view toggles are a segmented `SegmentedControl`-style track or quiet pills without `bg-ink`; compact rows render a 6px dot + 16px/500 title + 12.5px `mute` meta in a two-column grid (`md:grid-cols-2 gap-x-[72px] gap-y-[26px]`).
- [ ] **Implement:** panel header action "Open feed reader →" as cobalt text; loading/empty/error blocks sentence case on `sink` `rounded-xl` (no dashed border; diagnostics list in `hot`); toggles → two `Button variant="secondary" size="sm"` with `aria-pressed`, pressed state `bg-accent-tint text-ink`; in `FeedRiver` compact mode only, restyle the row markup per the contract (unread dot `bg-accent`, read dot `bg-faint`). Full mode untouched.
- [ ] Tests; commit `feat(ui): Atrium feed river`.

### Task 5: Brimley-Cocoon Line and Sky

**Files:** `Atrium.tsx` (BCL), `SkyCard.tsx`, `MoonDisc.tsx`, `DayArc.tsx`, their tests, guard

- [ ] **RED:** remove SkyCard/MoonDisc/DayArc from PENDING; test the BCL figure uses `font-serif` and `text-accent` with tabular numerals; SkyCard phase name serif 26px, facts as a `dl` with `dt` in `mute`; the no-location overlay still offers its action button.
- [ ] **Implement:** BCL: serif 96px (responsive clamp) numerals with italic serif unit words ("days", "h") in `mute`, sentence line 15px `ink-2`; drop the `[&>div:last-child]` padding overrides so bodies keep the Section indent. Sky: edit button as a 32px round `IconButton` (`aria-label="Edit location"`), grid 96px disc + facts; MoonDisc/DayArc strokes/fills in `var(--accent)` over `var(--sink)`, labels 12px Geist `mute`.
- [ ] Tests; commit `feat(ui): Atrium BCL and Sky`.

### Task 6: Activity and Reading continues

**Files:** `Atrium.tsx` (Activity section), `ActivityHeatmap.tsx`, `ReadingContinues.tsx`, their tests, guard (PENDING empty)

- [ ] **RED:** PENDING empty; heatmap test: level classes are cobalt alpha steps (`bg-accent/[0.22]`, `/[0.45]`, `/[0.7]`, `bg-accent`) and empty cells `bg-sink`, cells `rounded-[3px]`; totals render as serif 56px numerals with 13px `mute` labels ("captures", "longest streak, days", "current streak"); Activity eyebrow "Activity", caption "Rolling 26 weeks · captures per day" — update the Atrium tests that look up "Activity · Rolling 26 weeks" / "Captures per day · UTC". Reading continues: serif 23px titles, 4px progress track `bg-sink` with `bg-accent` fill, no border.
- [ ] **Implement** to the contract; the day popover follows the Task-4 overlay look (`bg-raise rounded-xl shadow-lg`, sentence case).
- [ ] Tests; commit `feat(ui): Atrium activity and reading`.

### Task 7: Gates, smoke, docs, merge

- [ ] Full suite vs baseline; smoke in bone and charcoal (with and without location, BCL and feeds); screenshots; docs (`getting-started.mdx` Atrium section: Search tile removed, daystart wording); review; merge.
