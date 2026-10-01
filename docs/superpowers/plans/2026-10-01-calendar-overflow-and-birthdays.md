# Calendar: overflow-day navigation + PERSON birthdays

Branch `feature/calendar-birthdays`, worktree `.worktrees/calendar-birthdays`, base `develop` @ 6a375d27.
Builds on the calendar view (plan `2026-09-30-calendar-view.md`).

## Rulings (user, 2026-10-01)

1. Muted outside-month days, **both ends**, are clickable. Click jumps to that day's month and gives that day keyboard focus. No popover opens.
2. PERSON pages carry frontmatter `birthday`. Year optional:
   - `birthday = 1983-05-12` (native TOML date; meta JSON shows `"1983-05-12"`)
   - `birthday = "05-12"` when the year is unknown (`"--05-12"` also accepted on read).
3. Birthdays show as a **distinct entry type**, recurring yearly on month-day. Own marker (cake) in cells. Day list shows `<title> — birthday, turns N` (just `birthday` when year unknown or N ≤ 0). Feb 29 falls on Feb 28 in non-leap years. Own toggle in the Folio rail filter.
4. Editing: a PERSON `headerExtras` band (like `MeetingMeta`) with a Birthday date field and a "Year unknown" checkbox.

## Design decisions (mine)

- Server returns birthdays as a separate array `birthdays` on `CalendarResponse`, each `{ path, title, month, day, year: number | null }`. Server does not expand occurrences; the client does (it owns the window and local days). Tag/project filters apply. Kind filter: birthdays returned only when `kind` is empty or includes PERSON. Not counted against the 5000 entry cap.
- Birthday parsing lives in `clep-vault` (`birthday.rs`), one pure function. Invalid values are ignored (no error).
- Screen: birthdays follow the Kind facet (shown when empty or includes PERSON). Rail: separate `Birthdays` toggle, stored at `clepsydra.calendar.rail.hideBirthdays`.
- Multi-month grids (Months planner): an outside day whose date lies inside the visible range behaves like pressing that day in its own grid (activate). Only dates before the first visible month or after the last one navigate, shifting the view by one month.

## Tasks (TDD: failing test first, then code)

### T1 — Overflow-day navigation (UI) — `ui/src/components/calendar/MonthCalendar.tsx` + its test
RAC disables cells outside the visible range, so presses never reach `onChange`. Add our own click handling on outside cells.
- Tests (`__tests__/MonthCalendar.test.tsx`, extend): single month May 2026 → click leading `2026-04-27` calls `onVisibleMonthChange` with an April key and, after rerender with that month, the `2026-04-27` cell holds DOM focus and no `onDayActivate`. Same for trailing day → June. Months mode (months=3): clicking an outside copy of a date inside the visible range calls `onDayActivate` for that date with the in-month cell; clicking a date past the last grid shifts view by +1 month.
- Keep existing tests green.

### T2 — Birthday parse (Rust) — `crates/clep-vault/src/birthday.rs`
`pub struct Birthday { pub year: Option<i32>, pub month: u32, pub day: u32 }`; `pub fn parse(value: &serde_json::Value) -> Option<Birthday>`. Accept `"YYYY-MM-DD"`, `"MM-DD"`, `"--MM-DD"` (trimmed). Validate: with year → real date; without year → valid in leap year (so `02-29` ok). Reject everything else. Unit tests for each form + invalid (`"13-01"`, `"02-30"`, `"1983-02-29"`, number, datetime string).

### T3 — Index + API (Rust) — `crates/clep-index/src/calendar.rs`, `crates/clep-api/src/api/calendar.rs`, openapi, `ui/src/api/schema.d.ts`
- `VaultIndex::calendar_birthdays(&self, tag: Option<&str>, project: Option<&str>) -> Result<Vec<BirthdayEntry>, IndexError>`: PERSON pages whose `meta_json` `birthday` parses via T2. Ordered by month, day, title. Add to the index-handle async wrapper like `calendar_entries`.
- `CalendarResponse.birthdays: Vec<CalendarBirthday>` (`ToSchema`, register in openapi). Empty when kind filter excludes PERSON.
- Tests: index test (PERSON with date, with `"05-12"`, invalid, non-PERSON with birthday ignored, tag/project filtering); API test for the kind rule.
- Regenerate schema offline: `cargo run -q -p clep-api --example openapi > target/openapi.json && (cd ui && bun run openapi:file && bunx biome format --write src/api/schema.d.ts)`.

### T4 — Birthday helpers + PERSON header (UI) — `ui/src/lib/birthday.ts`, `ui/src/components/codex/PersonMeta.tsx`, `ui/src/lib/kindPresentation.tsx`
- `lib/birthday.ts`: `readBirthday(raw: unknown): {year: number|null; month; day} | null` (same forms as T2); `birthdayValue(b)` → `{ value, hint }` for commit (`"1983-05-12"` + hint `"date"` when year known; `"05-12"` string, no hint, when not); `birthdayOccurrences(birthdays, range: {first, last}) → Map<DateKey, BirthdayOccurrence[]>` where `BirthdayOccurrence = { path, title, date: DateKey, age: number | null }` (Feb 29 → Feb 28 in non-leap years; range may span year boundary and up to ~15 months; age null when year unknown or ≤ 0); `birthdayLabel(o)`.
- `PersonMeta`: headerExtras for PERSON. Label "Birthday"; date field (reuse `EditableCell` with a `date` definition, the way `MeetingMeta` uses `datetime`, or a RAC DateField — whichever keeps existing patterns); "Year unknown" checkbox toggles between the two stored forms (keep month/day; when year unknown, pick display year 2000 for the picker so Feb 29 works). Clearing writes `null`. Writes via `usePropertyCommit`.
- Tests: unit tests for all helpers; component test for PersonMeta (renders existing value, year-unknown value, commit payloads for set/clear/toggle). Register `PERSON.headerExtras`.

### T5 — Calendar rendering + filters (UI) — after T1, T3, T4
- `api/calendar.ts` exposes `birthdays` from the response.
- `MonthCalendar`: prop `birthdaysByDay?: ReadonlyMap<DateKey, readonly BirthdayOccurrence[]>`; DayFace shows a small cake marker (lucide `Cake`, accent/ink colour, dimmed when outside) beside kind dots; sr-only text folds into the NoteCount description (e.g. "2 notes, 1 birthday").
- `DayNotesList`: a "Birthdays" group first, rows link to the person page, label from `birthdayLabel`.
- `CalendarScreen`: compute occurrences over the visible range; hide when Kind facet non-empty and lacks PERSON. Also the single-day query path. `WeekRows` if it lists per-day entries.
- `FolioCalendarSection`: rail toggle "Birthdays" next to kind toggles; `railPrefs` gets `readHideBirthdays/writeHideBirthdays`.
- Tests for each touched unit; Folio test files already mock `FolioCalendarSection`.

## Gates
`cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test` (touched crates + clep-api), `cd ui && bun run typecheck && bun run lint && bun run test`.
