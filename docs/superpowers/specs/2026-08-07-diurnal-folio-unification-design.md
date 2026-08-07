# Diurnal → Folio Unification Design

## Goal

Retire the standalone DIURNAL view and present journal entries as ordinary
workspace folio tabs. This removes three warts in one move: the diurnal body
rendered in the chrome monospace font (it lacked FOLIO's `codex-prose
font-sans` wrapper), the date appeared twice (bespoke day-label header plus the
editable title, which is also the date), and the Sheaf stayed visible with the
last-active workspace tab highlighted while the diurnal page itself never
appeared in the bar. Once journal pages are workspace tabs, all three
disappear by construction; journal-specific affordances survive as a bespoke
kind presentation inside FOLIO.

## Decisions

- **Retirement is total.** The DIURNAL nav entry, the `/journal` route, and
  `Diurnal.tsx` are deleted. No redirect route remains.
- **Entry points:** the `nav.diurnal` shortcut is renamed `journal.today`
  (chord unchanged: ⌘D, label "Today's journal"); the command-palette entry is
  relabelled to match; the Atrium's existing "Open today's journal" tile is
  repointed; the FolioLauncher gains a "Today's journal" action row. All four
  call one shared open-today action.
- **Draft-first-write survives.** FOLIO wires `usePageEditor`'s existing
  `ensure` option when (and only when) the tab path is today's journal path.
  Opening today never creates a file; the first write does (per the
  2026-08-06 journal-create-on-first-write design, whose Diurnal-specific
  wiring this spec supersedes).
- **Specialisation mechanism:** the `kindPresentation` registry (Approach A),
  not a sibling FOLIO variant and not inline `isJournal` conditionals.
  `KindPresentation` grows a second slot for a read-only title; `metaExtras`
  gets its first registered entry.
- **Surviving affordances:** day navigation (prev/today/next), the FASTI
  recent-entries timeline, and the this-day marginalia move into a JOURNAL
  `metaExtras` block in FOLIO's META rail. The aside quick-capture becomes a
  global command-palette action. The old inline backlinks section is dropped —
  FOLIO's right rail already covers backlinks.
- **Title row:** JOURNAL pages render a non-editable formatted day label
  ("Thursday 7 August 2026") in place of the title input; tags and aliases
  stay editable.
- **Gap days:** prev/next skip to the nearest day *with an entry* (today
  always counts, since it can draft). Skipped days render in FASTI but are
  inert. No backfill of arbitrary past dates.
- **Day navigation replaces in place** via `updateTabPath` (the same follow
  mechanism kind/project assignment uses) rather than opening a tab per day.
- **FASTI markers are lucide icons** (`CircleDot` written / `Circle` skipped,
  ~10 px), not the ◉/◌ text glyphs.
- **Asides are timestamped server-side.** The capture endpoint prepends the
  capture time, so every client (palette, browser extension, MCP
  `vault_journal_capture`) produces a consistent journal timeline.

## Behavior contract

- The header nav shows five entries (ATRIUM, FOLIO, GAZETTEER, CONSTELLATION,
  TASKING). `/journal` no longer resolves; nothing links to it.
- ⌘D, the palette "Today's journal" entry, the Atrium tile, and the
  FolioLauncher row all open (or focus, if already open) a workspace tab bound
  to `journals/<today>.md` and navigate to `/workspace`. Dedup is `openTab`'s
  existing same-path behavior.
- Opening today's tab on an unwritten day renders an editable empty journal;
  no file exists until the first content or metadata edit flushes (existing
  draft-save machinery). The marginalia reads "unwritten" while drafting.
- The journal folio body renders with FOLIO's standard prose styling —
  identical typography to any other page.
- The title row for JOURNAL-kind pages shows the formatted day label derived
  from the journal date and cannot be edited. Tags and aliases behave as on
  any page.
- The META rail on a journal page shows a "Journal" block in the per-kind
  slot (where "Details" renders for other kinds): prev/today/next controls,
  the FASTI timeline (most recent 14 days), and this-day marginalia (day
  N/365, written/unwritten). Clicking a written FASTI day or prev/next
  repoints the *current* tab to that day's path. Prev disables when no older
  entry exists within the fetched window (30 days); next disables when the
  selected day is today (today is always reachable, since it can draft).
- The Sheaf shows the journal tab like any page tab (pin, quire membership,
  context menu all standard). The footer FILE code shows the page's normal
  short-folio code; the VIEW readout reports FOLIO.
- "Capture aside" is available from the command palette anywhere in the app
  (chord ⌘⇧D): a one-line prompt that appends to today's journal via the
  capture endpoint, creating the journal if needed. Success clears and closes
  the prompt; failure shows the error inline in the prompt.
- Captured asides land as `- HH:MM — <content>` (server-local 24-hour time)
  at the end of today's journal body. Multi-line capture content keeps the
  stamp on its first line; subsequent lines append unchanged.

## Backend changes (`src/api/journal.rs`)

`capture_today` prepends the stamp before appending:

- Formats `now` (already obtained from `state.clock`) as `%H:%M` and writes
  `- {stamp} — {content}\n` instead of `{content}\n`. The
  ensure-then-append flow, conflict handling, and response shape are
  untouched. No OpenAPI change (journal routes carry no utoipa annotations).

## Frontend changes

### Retirement

- Delete `components/codex/Diurnal.tsx`, `__tests__/Diurnal.test.tsx`, and
  `routes/journal.tsx` (routeTree regenerates on next dev/build).
- `CodexFrame.tsx`: remove `"diurnal"` from the `View` union, the NAV array,
  the `/journal` branch of view detection, the `onNav` case, and the
  `useFolioCode` case.

### Open-today action

- New `useOpenTodayJournal()` (home: `ui/src/hooks/`, beside `useOpenTab`):
  computes `journals/<localDateKey(new Date())>.md`, calls
  `openTab("page", path, dateKey)` (the date key is the initial tab label;
  FOLIO's existing title-driven `updateTabLabel` takes over once the page
  loads), navigates to `/workspace`. The client-side path derivation is the
  coupling already accepted by the create-on-first-write design.
- `shortcuts.ts`: rename key `nav.diurnal` → `journal.today`, label "Today's
  journal", chord ⌘D unchanged; `useGlobalShortcuts` runs the new action.
  New entry `journal.capture` (⌘⇧D, group Workspace, scope global) opening
  the capture prompt. The ⌘/ help modal picks both up from the registry.
- `CommandPalette.tsx`: "Open Diurnal" → "Today's journal" running the same
  action; new "Capture aside" command.
- `Atrium.tsx`: the journal tile's `onClick` swaps `navigate({ to: "/journal" })`
  for the open-today action. Subtitle logic unchanged.
- `FolioLauncher.tsx`: new `LauncherAction` "Today's journal" (hint ⌘D).

### FOLIO integration

- `Folio.tsx` calls `usePageEditor(path, useJournalEditorOptions(path))`. The
  new hook (in `ui/src/api/journal.ts`) returns
  `{ ensure: () => ensureToday.mutateAsync() }` when `path` equals today's
  journal path at render time, else `undefined` — mirroring Diurnal's current
  memoized wiring.
- The not-found gate becomes draft-aware: a draft renders the editor surface,
  not `FolioNotFound`. (Per `usePageEditor`, a 404 with `ensure` present
  enters draft state without surfacing `editor.error`; the gate change is a
  belt-and-braces guard on `editor.isDraft`.)
- Chronology/Vitals blocks are unchanged: a draft page simply shows "—" dates
  and zero counts until created.

### Kind presentation (`ui/src/lib/kindPresentation.tsx`)

- `KindPresentation` becomes:
  - `metaExtras: ComponentType<{ path: string; tabId: string; isDraft: boolean }> | null`
    — props widened so bespoke blocks can repoint the tab (day nav) and
    reflect draft state. `Folio` passes `tabId` and `editor.isDraft` through;
    the existing call site is the only consumer.
  - `metaExtrasLabel?: string` — the label FOLIO's wrapping `Block` uses for
    the slot; defaults to the current "Details". JOURNAL sets "Journal".
  - `readOnlyTitle?: (path: string, title: string) => string` — when present,
    `PageEditorHeader` renders the returned string as a static heading in
    place of the title input (tags/aliases untouched). `PageEditorHeader`
    gains an optional `readOnlyTitle?: string` prop; `Folio` resolves it from
    the presentation.
- Register `JOURNAL: { metaExtras: JournalMeta, readOnlyTitle }`, where
  `readOnlyTitle` parses the date from the path/title (`YYYY-MM-DD`) and
  formats the long weekday label; if no date parses, it falls back to the raw
  title.

### `JournalMeta` block (new: `ui/src/components/codex/JournalMeta.tsx`)

- Rendered by FOLIO's existing `presentationFor(kind).metaExtras` slot
  (wrapping `Block` labelled "Journal" via `metaExtrasLabel`).
- Data: `useJournalRecent(30)`. The written-day set is the fetched entries
  plus today (draftable). A pure helper
  `nearestEntry(entries, from, direction)` — unit-testable — returns the
  adjacent written day or null.
- Prev/Today/Next buttons call `updateTabPath(tabId, path, dateKey)`;
  disabled states per the behavior contract.
- FASTI: the 14 most recent calendar days of the 30-day fetch as rows
  (lucide `CircleDot` size≈10 for written, `Circle` for skipped; skipped
  rows are non-interactive and muted). Row layout follows the current
  Diurnal timeline (short date + relative-days column).
- This-day marginalia: day N/365 for the page's date, and written/unwritten.
  A journal page that exists is written; today's is unwritten exactly while
  the editor is drafting, which is why `isDraft` arrives as a prop.

### Aside capture prompt

- New `CaptureAsideModal` following the InscribeModal pattern (ui-store
  open/close state, `openCaptureAside` action on `useUiStore`), mounted at
  the frame level; single input, submits via `useQuickCapture`, inline error
  on failure, closes on success.

### Cleanup

- `useJournalByDate` loses its last consumer; delete it (knip confirms).
- `Diurnal`-only helpers (`romanLower`, `relativeDays`, `shortDate`) go with
  the file; anything `JournalMeta` reuses moves with it.
- `EditorConflictWiring.test.tsx` retargets from Diurnal to the journal folio
  wiring.

## Error handling

- Capture failure: inline message in the prompt; the mutation's existing
  error path. No toast system is introduced.
- Draft ensure failure on first save: unchanged `usePageEditor` behavior
  (save status "error", retried on next trigger).
- Ensure race / concurrent creation: unchanged (server conflict arm +
  client-side conflict banner per the create-on-first-write design).
- `journal/recent` fetch failure: the Journal block renders its controls
  disabled with an em-dash timeline; the page editor is unaffected.

## Tests

Backend (`tests/api_journal_test.rs`):

- Capture appends `- HH:MM — text` under a fixed test clock; existing
  capture-creates coverage updated for the new format.

Frontend (vitest):

- `nearestEntry` unit tests: gaps, window edges, today-as-draftable, empty
  set.
- `JournalMeta`: written/skipped rendering, inert skipped days, prev/next
  repoint via `updateTabPath`, disabled edges, marginalia for draft vs
  written.
- `PageEditorHeader`: `readOnlyTitle` renders static text, no input; title
  editing unaffected when absent.
- FOLIO wiring: today's journal path gets `ensure` (draft renders editor, not
  FolioNotFound); non-journal paths get none; JOURNAL kind resolves the
  bespoke presentation.
- Palette/launcher/Atrium: entries present and invoke the open-today action;
  capture prompt submits and handles error inline.
- Route/nav: no `/journal` route; NAV renders five entries.

## Supersedes

- The Diurnal sections of `2026-08-06-journal-create-on-first-write-design.md`
  (the draft-editor wiring moves into FOLIO; the behavioral contract of that
  design is preserved).

## Out of scope

- Backfilling past dates (ensure stays today-only).
- Client "today" vs server "today" skew around midnight (pre-existing: a
  draft tab opened before midnight and first written after it ensures the
  server's current day; unchanged by this design).
- Kind reassignment moving a page out of `journals/` (existing generic
  behavior, unchanged).
- Any change to `GET /journal/today`, `GET /journal/{date}`, `recent`,
  `range`, or the journal template.
- The browser extension and MCP capture clients (they inherit the stamp
  server-side with no client change).
