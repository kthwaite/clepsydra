# Stone & Lamp phase 4b-3 — mobile Today, Agenda and Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the three phone screens behind the 4b-1 bottom bar: Today (the mocked sections only), Agenda (Overdue / Today / This week), and Tasks (project, cycle, status tabs, cards, new task), replacing Tasking's desktop-only redirect.

**Architecture:** Each screen is a new `components/mobile/Mobile*.tsx` built on existing hooks (`useJournalToday`, `useAgenda`, `useToggleTaskStatus`, `useBaseView("reading","Continues")`, `useBoard`, `useCreateTask`, `useBoardStore`). Each route picks the mobile screen with `useMobileLayout()`. Pure helpers (journal excerpt, agenda buckets, task scoping) live in `components/mobile/mobile-data.ts` with unit tests. `DesktopOnlyRoute` is deleted.

**Tech Stack:** React 19, TanStack Query, zustand, react-aria-components, Tailwind v4, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` §9 Q3 ("Type steps down: … screen titles 44px, prose 17px"). Mockups: MobileToday, MobileAgenda, MobileTasking.

## Global Constraints

- User rulings (2026-09-26): mobile Tasks built as mocked; mobile Today = mocked sections only (greeting, capture pill, Journal, Due today, Continue reading); other Atrium panels stay desktop-only.
- Screen titles 44px serif (Agenda, Tasks); Today's greeting 48px as mocked. Eyebrows = `Tick` + italic serif 20px; content under an eyebrow indented 17px.
- Guard test applies (no caps+tracking, mono, hard borders, 9–11px type). Touch targets ≥ 44px. Tokens only.

## Review Focus

1. No journal today (`useJournalToday` → null): Journal shows a "Nothing written yet" line; Open still opens (creates) today's journal.
2. Base "reading" missing or empty: Continue reading section is omitted, no error.
3. Agenda items that are Tasks (not todos): no checkbox (status needs the Select); tapping opens the task page.
4. Tasks with no active cycle, and "All projects" scope: no cycle line; counts per status still right.
5. Checking a todo off: the row stays until the refetch removes it (no double toggle, button disabled while pending).

## Rulings made while planning

- No user name exists anywhere; the greeting is `greeting(now)` with its last word in italic cobalt ("Good *morning.*").
- The capture pill opens `openInscribe`, matching the Atrium's Capture button.
- Journal excerpt = first prose paragraph of today's body (frontmatter, headings, list markers and link syntax stripped), cut at 180 characters on a word boundary.
- Due today = overdue + today from `useAgenda`, at most 5 rows; "Agenda →" links to /agenda.
- Agenda mobile drops the FilterBar and the Upcoming/Undated tabs: sections Overdue, Today, This week (upcoming within 7 days), Later (other upcoming), No date — empty sections omitted. The header count is the total of all sections.
- Tasks: the project picker sits in the content under the frame top bar (the frame keeps status/New note/Settings); it is a native-feeling RAC `Select` over `deriveProjectScopes` + "All projects", writing `useBoardStore.setOpFilter`. Cards open the task page (`openTab("page", path)`), not the desktop edit dock. "+ New task" reveals a text field; Enter creates via `useCreateTask` with the selected status and project. Done tab shows the 20 most recently updated.
- Cycle line: active cycle's tasks within the current scope, sealed/total, as on desktop.

---

### Task 1: mobile-data helpers

**Files:** Create `ui/src/components/mobile/mobile-data.ts`, `ui/src/components/mobile/mobile-data.test.ts`.

**Produces:**
- `journalExcerpt(body: string, max = 180): string | null`
- `bucketAgenda(data: AgendaResponse, today: string): { key: "overdue"|"today"|"week"|"later"|"undated"; label: string; items: AgendaItem[] }[]` (non-empty buckets only, in that order; labels Overdue, Today, This week, Later, No date; `week` = upcoming dates ≤ today+7).
- `agendaItemTitle(item)`, `agendaItemPath(item)`, `agendaItemKey(item)`.
- `tasksByStatus(tasks: BoardTask[]): Record<(typeof COL_ORDER)[number], BoardTask[]>` (Done sorted by `updated_at` desc, capped at 20; others keep board order).

- [ ] Tests: excerpt skips frontmatter (`---\na: b\n---`), `# Heading`, blank lines, strips `- `, `[[a|b]]`→`b`, `[[a]]`→`a`, `**x**`→`x`, `[t](u)`→`t`; cuts at a word boundary with `…`; returns null for an empty or heading-only body. Buckets: order, empty omitted, 7-day boundary (today+7 in week, +8 later), undated → "No date". tasksByStatus: grouping, Done cap/sort. Run → FAIL → implement → PASS → commit `feat(ui): mobile data helpers`.

### Task 2: MobileToday

**Files:** Create `ui/src/components/mobile/MobileToday.tsx` + `MobileToday.test.tsx`; modify `ui/src/routes/index.tsx` (component picks `MobileToday` when `useMobileLayout()`).

Layout (px-5 pt-5, sections gap-8): date line 13px mute (`longDate · Week N`); h1 serif 48px/1 `-0.02em` = greeting with last word `<em className="font-serif italic text-accent">`. Capture pill: `<button>` h-13 rounded-full bg-sink pl-[18px] pr-2 "Capture a thought…" 15px mute + 36px round accent "+" (aria-hidden) → `openInscribe`. Sections via a local `Eyebrow({ label, action })` (Tick + italic serif 20px + optional right link 14px accent):
- Journal (action "Open →" → `useOpenTodayJournal()`): excerpt p 15.5px/1.6 `text-ink-2` ml-[17px], or "Nothing written yet." mute.
- Due today (action "Agenda →" → navigate `/agenda`): rows from overdue+today (≤5): todos = label with a real checkbox (RAC `Checkbox` from `components/ui/checkbox`, 18px) toggling `useToggleTaskStatus` to done, disabled while pending; tasks = button opening the page. Meta 12.5px: overdue → `Overdue · 22 Sep` `text-hot`; else mute (`Due today` or source title). Empty → "Nothing due." mute.
- Continue reading (omitted when no rows): rows from `useBaseView("reading","Continues")` flat rows → button with serif 22px title + 12.5px meta (`p. X of Y` / `p. X` / author); opens page.

- [ ] Tests (mock `#/api/journal`, `#/api/tasks`, `#/api/bases`, `#/hooks/useOpenTab`, `#/hooks/useOpenTodayJournal`, `#/hooks/useClock` fixed 2026-09-25 09:00, `#/store/ui`, router `useNavigate`): greeting "Good morning." with "morning." in `em`; date line "Friday 25 September · Week 39"; pill calls openInscribe; journal excerpt shown / null → "Nothing written yet."; Open → calls the journal opener; Due today lists overdue with "Overdue · 22 Sep" in hot and today todo; checking calls toggle `{pagePath, spanStart, status: "done"}`; task row click opens page; >5 items capped; Continue reading renders rows and omits section when base 404s (hook returns `{ data: undefined, isError: true }`). Route test: `routes/-index.test.tsx` renders MobileToday when mobile (mock both screens as stubs). Run → FAIL → implement → PASS; add files to guard `MOBILE_FILES`; commit `feat(ui): mobile Today`.

### Task 3: MobileAgenda

**Files:** Create `ui/src/components/mobile/MobileAgenda.tsx` + test; modify `ui/src/routes/agenda.tsx` (`AgendaPage` returns `<MobileAgenda agenda={agenda} />` when mobile).

Layout: header row h1 serif 44px "Agenda" + `N open` 13px mute (baseline). Loading → "Loading…" mute; error → `role="alert"` "Agenda failed to load." hot. Each bucket: Eyebrow with tick tone (overdue `bg-hot` via `Tick` variant or a span, label `text-hot`; today accent; others faint) + count 12.5px mute; rows as in Today (todo checkbox / task button), meta: todo → source page title (+ due date for week/later); task → `code · status label · priority label`.

- [ ] Tests: sections render in order with counts; header "6 open"; overdue label has `text-hot`; todo toggle; task row has no checkbox and opens its page; empty agenda → "Nothing open." ; loading/error states. Route test in `routes/-agenda.test.tsx`: mobile renders MobileAgenda (mock `#/hooks/useMobileLayout`). Run → FAIL → implement → PASS; guard; commit `feat(ui): mobile Agenda`.

### Task 4: MobileTasking + route, delete DesktopOnlyRoute

**Files:** Create `ui/src/components/mobile/MobileTasking.tsx` + test; modify `ui/src/routes/tasking.tsx`; delete `ui/src/components/codex/DesktopOnlyRoute.tsx`.

Layout: project `Select` (label visually hidden "Project"; trigger = Tick + italic serif 18px mute name + chevron); h1 serif 44px = scope name ("All projects" for ALL, "No project" for UNFILED); cycle line when an ACTIVE cycle has scoped tasks: `Cycle {code} · {fmtCycleWindow}` + 64px `role="progressbar"` bar + `done/total`. Status `Tabs` (`selectedKey` state, default TRIAGE if non-empty else first non-empty else INTAKE): TabList horizontal scroll `overflow-x-auto`, labels `{COL_LABEL} {count}`. Panel: cards (`<button>` rounded-2xl bg-raise px-[18px] py-4, title 15.5px, meta row: 6px priority dot `PRI_COLOR[p].bar`, code, spacer, due short weekday/date `text-hot` when overdue); empty → "No tasks here." Below: "+ New task" button (h-12 rounded-full bg-sink) → shows a `TextField` "New task title"; Enter → `useCreateTask().mutate({ title, status: selected, project: scope slug or null })`, clears on success; Escape hides.

- [ ] Tests (mock `#/api/board` useBoard/useCreateTask, `#/hooks/useOpenTab`, real `useBoardStore` with memory storage): tabs show counts; default tab Ready; switching tab shows its cards; card opens page; project select filters tasks and title; cycle line + progressbar values; no active cycle → no line; new task creates with status+project; Done capped at 20. Route: `routes/-tasking.test.tsx` renders MobileTasking on mobile (mock screens) and no toast/redirect. Run → FAIL → implement → PASS; guard; `rg DesktopOnlyRoute src` empty; commit `feat(ui): mobile Tasks`.

### Task 5: Docs and gates

- [ ] `getting-started.mdx` "On a phone": Today (greeting, capture, journal, due today, continue reading), Agenda sections, Tasks (project, cycle, status tabs, new task). Remove any "Tasking is available on desktop" wording (`rg -n "available on desktop" src`).
- [ ] `bun run typecheck && bun run lint && bun run test`; commit `docs(ui): mobile Today, Agenda and Tasks`.
