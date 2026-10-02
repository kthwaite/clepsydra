# Calendar todos — plan (2026-10-02)

Show todos on the `/calendar` screen.

## Rulings (user, 2026-10-02)

- Sources: both checkbox todos (`- [ ]` blocks, `block_properties.status`) and TASK pages (`pages.kind = 'TASK'`, frontmatter `status`/`due`).
- Placement: **due date only**. Checkbox todos by `[due:: YYYY-MM-DD]`; TASK pages by frontmatter `due`. Todos without a due date are not shown. A todo appears once.
- Done items are shown: checkbox `done`/`cancelled`, TASK `SEALED`. They are struck through and dimmed. Markers count open items only.
- Interaction: the day panel lists the day's todos. A checkbox todo has a `TaskStatusButton` that toggles via `useToggleTaskStatus`. A TASK has the same status `Select` as `AgendaTaskRow`, via `usePatchTask`. Each row links to its source page (`useOpenTab("page", path)`).

## Decisions (agent)

- Filters apply to the **host page**: `kind` matches the host page's kind (a TASK page's kind is `TASK`), `tag`/`project` match the host page. AI_JOURNAL host pages are skipped (as the agenda does).
- Window: due date in `[journal_from, journal_to]` of the existing `CalendarQuery` (padded local dates; the client trims). After SQL, drop any due value that does not parse as a `YYYY-MM-DD` `NaiveDate` (strict 10-char shape). TASK `due` comes from `meta_json` and may be any JSON scalar; use the same string extraction as `agenda_meta_string`.
- Cap: a separate 5000-item cap for todos; `truncated` becomes true if either list is cut.
- Folio rail calendar (`FolioCalendarSection`) is unchanged; todos are screen-only.

## Task A — backend (TDD)

1. `crates/clep-index/src/calendar.rs`: `VaultIndex::calendar_todos(&CalendarQuery) -> Result<CalendarTodoPage, IndexError>` returning checkbox todos and TASK pages with due dates in the window, host-page filters applied, ordered by due then host path then span_start. Index-level types: `CalendarTodoEntry { content, status, due, priority: Option, page_path, page_title, page_kind, span_start }`, `CalendarTaskEntry { id, path, title, status, priority, project, due }` (status default `INTAKE`, priority default `P2` — mirror `DEFAULT_STATUS`/`DEFAULT_PRIORITY` in agenda.rs; skip unknown statuses/priorities as agenda does, but accept `SEALED`). Expose through the async wrapper the way `calendar_entries` is.
   Tests (clep-index tests dir, following the existing calendar tests): window inclusion/exclusion at both edges; done/cancelled included; undated excluded; malformed due excluded; kind/tag/project filters on host page; AI_JOURNAL skipped; SEALED task included; truncation.
2. `crates/clep-api/src/api/calendar.rs`: `CalendarResponse.todos: Vec<CalendarTodoItem>`, an untagged enum with a `kind` discriminator like `AgendaItem`:
   - `CalendarTodo { kind: "todo", content, status: todo|doing|done|cancelled, due, priority: Option<String>, page_path, page_title, span_start }`
   - `CalendarTask { kind: "task", id: Uuid, code, title, status: INTAKE|TRIAGE|FIELD|REVIEW|SEALED, priority: P0..P3, project, due, path }` (`code` = path stem).
   Use utoipa enums so the TS types are string unions. Update the handler doc comment. Add an API integration test in `crates/clep-api/tests` (find the existing calendar test file) covering one checkbox todo and one TASK in the response.
3. Regenerate the schema offline: `cargo run -q -p clep-api --example openapi > target/openapi.json && (cd ui && bun run openapi:file && bunx biome format --write src/api/schema.d.ts)`.
4. Gates: `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test -p clep-index -p clep-api`.

## Task B — frontend (TDD)

1. `ui/src/api/calendar.ts`: export `CalendarTodoItem` (+ `CalendarTodo`, `CalendarTask`) from the schema.
2. `ui/src/lib/calendar/`: `bucketTodos(items, visibleKeys) -> Map<DateKey, CalendarTodoItem[]>` keyed by `due` (already a local date; no tz conversion), trimmed to the visible range; `isTodoOpen(item)` (todo/doing; any TASK status but SEALED). Unit tests.
3. `MonthCalendar`: new optional prop `todosByDay`. `DayMarkers` shows a todo marker (lucide `SquareCheck`/`ListTodo`-style icon, like the cake) when the day has todos, plus the open count in the page variant; dimmed when none are open. The day's accessible description (`dayDescription`) adds "N todos" (open/total wording as you judge best). Tests.
4. `WeekRows`: show the day's todos (check glyph; struck through when done) ahead of page entries, within the existing inline limit logic. Tests.
5. `DayNotesList`: a "Todos" group (after birthdays, before page kinds) with rows:
   - checkbox todo: `TaskStatusButton` + content + priority badge + source link; toggle via `useToggleTaskStatus` (`nextStatus`).
   - TASK: status `Select` (as `AgendaTaskRow`) + title + code badge + source link; via `usePatchTask`.
   - done rows: `line-through` + dimmed text.
   Reuse/extract from `ui/src/components/agenda/AgendaItemList.tsx` rather than duplicating where sensible. Confirm both mutations invalidate the calendar query (key under `/api/vault/index`); fix if `usePatchTask` does not. Tests.
6. `CalendarScreen`: bucket `query.data.todos` (and the one-day out-of-range query's todos) and pass them to `MonthCalendar`, `WeekRows`, `DayNotesList`. Tests.
7. Gates from `ui/`: `bun run typecheck`, `bun run lint`, `bun run test`.
