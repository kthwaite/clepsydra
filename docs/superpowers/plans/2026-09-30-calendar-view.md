# Calendar view — TDD plan

Branch `feature/calendar-view` (worktree `.worktrees/calendar-view`), off `develop` 8f6b1eeb.
Inspired by obsidian-calendar-plugin. The difference: notes are placed by **creation date**, not by filename.

## Goal

1. A slim server endpoint lists the pages in a time window.
2. A pure client library turns that list into local-day buckets and Monday-start month grids.
3. One `MonthCalendar` component is used in two places: the Folio right rail and a new `/calendar` screen.

## Locked decisions (user)

1. **Date basis.**
   - A `JOURNAL` or `AI_JOURNAL` page with a `journal_date` goes on that date (`pages.journal_date`, a plain `YYYY-MM-DD`).
   - Every other page goes on its `created_at` (`pages.created_at`, RFC3339 UTC), converted to the browser's **local** date.
   - A page with `created_at` NULL is left out. This happens with invalid frontmatter.
   - Plan refinement (Q4 below): a journal-kind page with no `journal_date` falls back to `created_at`. The server and the client apply the same rule.
2. **The server stays timezone-agnostic.** Do not add chrono-tz. The client sends the local-midnight `from` and `to` as RFC3339 strings with their offsets. The server returns flat entries `{ path, title, kind, created_at, journal_date }`. The client does the bucketing.
3. **Journal window.** A journal-kind entry is returned when `journal_date ∈ [date(from), date(to)]`, inclusive. `date(x)` is the calendar date of `x` in its own offset. The window is padded by one day on purpose. The client trims it.
4. **Cap.** At most 5000 entries per response, plus `truncated: bool`.
5. **Filters.** Kind (many), tag (one), project (one).
6. **Rail.**
   - A collapsible "Calendar" section at the **top** of Folio's right rail.
   - The first month shown is the open page's date, or today.
   - The section header has a kind-toggle menu. It is persisted in localStorage. By default every kind is shown.
7. **Screen.**
   - The new CodexView is `calendar`.
   - Modes: Month, Months (a running 3, 6 or 12), and Weeks.
   - A FilterBar syncs to the URL. The mode, the anchor date and the selected day are also in the URL.
   - Each day shows a count. Clicking a day opens a side panel.
8. **Day list.** Notes are grouped by kind. Each note opens through the existing tab mechanism. There is also an "Open journal" action.

## Decisions taken in this plan (reviewer: veto if wrong)

- **Endpoint: `GET /api/vault/index/calendar`**, registered in `index_routes::router()`.
  - Reason: `invalidatePageContent` (`ui/src/api/keys.ts:171`) and the SSE handler (`ui/src/hooks/useVaultEvents.ts:55`) already invalidate every query whose path starts with `/api/vault/index`. Under that prefix, calendar caches refresh on every page edit, create, move or delete for free. A top-level `/api/vault/calendar` would need new invalidation wiring in both places.
  - The handler and DTOs still live in a new file, `crates/clep-api/src/api/calendar.rs`. `index_routes.rs` is already about 1900 lines.
  - OpenAPI tag: `Index`.
- **The `kind` query parameter is one comma-separated string**, for example `kind=JOURNAL,NOTE`. This matches `tags` on `content-index` and avoids the custom `Deserializer` that `ReferenceIssuesQuery` needs for repeated keys. The UI hook joins the array.
- **"Open journal" on a day with no journal needs a new `POST /api/vault/journal/{date}`.**
  - It reuses the existing `ensure_journal(state, HUMAN_JOURNAL, date)` (`journal.rs:162`). That function already takes any date.
  - The server has no get-or-create for an arbitrary date today. Only `POST /journal/today` exists.
  - Today keeps the existing draft mechanism: open `todayJournalPath()`, and the file is created on first write. This is the same as `useOpenTodayJournal`.
  - See Q1.
- **Calendar primitive: react-aria-components `Calendar` / `CalendarGrid` / `CalendarCell`.**
  - Props: `firstDayOfWeek="mon"` (supported in RAC 1.20.0; see `node_modules/react-aria-components/dist/private/Calendar.mjs:197`) and `visibleDuration={{ months: n }}` for Months mode.
  - This gives the grid role, arrow / PageUp / PageDown / Home / End keys and localized headings for free.
  - RAC has no week-number cell. The week-number column is a sibling column with `aria-hidden`, drawn from the pure `monthGrid()` rows. Its cells have a fixed row height, so the two columns align deterministically.
  - The Calendar is driven with `value={null}` and `focusedValue` + `onFocusChange`. Because the value is always null, `onChange` fires on every press, including a press on the same day again. "Selected" and "today" rings are drawn by our own cell render, not by RAC's selection state.
  - Add `@internationalized/date` to `ui/package.json` at the version already installed, `3.12.3`. It is currently only a transitive dependency, and knip flags unlisted imports.
- **Months mode = N month grids in one RAC Calendar**, wrapping in a responsive grid. It is not a single continuous stream of week rows. See Q2.
- **Weeks mode**: `span` ∈ {1, 2, 4} week rows, default 2. Each row lists each day's notes inline. Prev and next move by one week. Month and Months modes move by one month.
- **Rail kind prefs store the *hidden* kinds**, as a JSON array under the key `clepsydra.calendar.rail.hiddenKinds`. A kind added later is therefore visible by default. The collapsed state uses `clepsydra.calendar.rail.collapsed`. Every read and write goes in try/catch, following the `useTableCompact.ts` pattern.
- **The rail filters kinds on the client.** It fetches all kinds for the visible grid, so toggling a kind does not refetch. **The screen filters on the server**, which reduces truncation.
- **Desktop-only rail.** `DesktopFolioLayout` gets a new `calendar` prop, rendered above `{relationships}`. `MobileFolioLayout` does not receive it. See Q3.
- **Contents group: Organise**, listed after Gazetteer. The registry key order sets the Contents order. No shortcut. Not in the mobile bar.

## Open questions — RESOLVED 2026-09-30 (user: Q1 yes, Q2 side-by-side grids; Q3/Q4 defaults accepted)

- **Q1** Should "Open journal" *create* a journal for a past or future day that has none? The default is yes, through the new `POST /journal/{date}`. The alternative: hide or disable the action unless the day is today or already has a journal. This would drop Task A3.
- **Q2** Does "Months (continuous)" mean N month grids side by side (the default), or one continuous scroll of week rows spanning N months, with month labels at the month boundaries?
- **Q3** Should the rail calendar also appear on the mobile Folio? The default is no.
- **Q4** A journal-kind page with no `journal_date` (not a `journals/` filename): fall back to `created_at` (the default), or exclude it?

## Reference facts (pinned from the code)

### Backend

- **Schema.**
  - `crates/clep-index/src/index.rs:159` `const SCHEMA` holds `CREATE INDEX IF NOT EXISTS …` lines (238–248).
  - `setup_connection` (`index.rs:497`) runs `execute_batch(SCHEMA)` on every open, after the column migrations.
  - There is no `user_version` number. **A new index is one `CREATE INDEX IF NOT EXISTS` line in `SCHEMA`.** `created_at` is in the original table, so no migration is needed.
- **Stored `created_at` format.**
  - It comes from `DateTime<Utc>::to_rfc3339()` (`index.rs:1016`, `:2451`), which gives `YYYY-MM-DDTHH:MM:SS[.f]+00:00`.
  - If the bounds are normalised the same way (`parse_from_rfc3339(..)?.with_timezone(&Utc).to_rfc3339()`), a plain string `>=` / `<` comparison is correct and can use the index. Sub-second rows also sort correctly, because `'+'` (0x2B) is less than `'.'` (0x2E).
- **`journal_date`** comes from `extract_journal_date(path)`. It is set only for `journals/…` and `ai-journals/…` paths.
- **Kinds.** Kind tokens come from `clep_vault::kind::Kind::{from_token, as_str}`. The two journal kinds are `Kind::Journal` and `Kind::AiJournal`.
- **Query pattern to copy.**
  - `crates/clep-index/src/unlinked.rs` has `impl VaultIndex { pub fn unlinked_mentions(..) }`, re-exported through `index.rs:21`.
  - The async wrapper is in `index_handle.rs:165`.
  - The integration tests are in `crates/clep-index/tests/unlinked_mentions_test.rs`. Its `setup_vault` / `built` helpers are the model.
- **Filtered SQL.** The shape to copy is `index_routes.rs:1499` `content_index`:
  - a `conditions: Vec<String>` plus `Vec<rusqlite::types::Value>`, run with `params_from_iter`;
  - the tag condition is `EXISTS (SELECT 1 FROM tags t WHERE t.page_id = p.id AND t.tag = ?)`;
  - the project condition is `p.project = ?`.
- **DTO kind typing.** Copy `#[schema(value_type = crate::vault::kind::Kind)] kind: String`, as in `ContentEntry`.
- **OpenAPI.** `crates/clep-api/src/api/openapi.rs` lists paths explicitly (the `crate::api::index_routes::…` list, about line 132) and lists schemas explicitly in `components(schemas(..))` (about line 249).
- **Docs coverage.**
  - `crates/clep-api/tests/docs_api_coverage_test.rs` fails unless `ui/src/docs/content/api-reference.mdx` has a `### \`METHOD /api/vault/…\`` heading under the `## <Tag>` section of that operation.
  - `crates/clep-api/tests/openapi_contract.rs` has a required-operations list. Add the new operations to it.
- **Journal ensure.** `journal.rs:162` `ensure_journal` and `:358` `ensure_today` return 201 or 200 plus `PageDetailResponse`. The router is at `journal.rs:94-98`.
- **API test harness.**
  - `crates/clep-api/tests/support/mod.rs` provides `ApiFixture::builder().pre_index_seed(|root| ..).build().into_server_and_temp()`. The `FixedClock` pattern is in `api_journal_test.rs:18-33`.
  - The vault may refile pages by kind or project. Assert by `title`, not by root path, except for `journals/…` fixtures.

### Frontend

- **API hooks.**
  - `ui/src/api/client.ts` exports `$api` (openapi-react-query) and `fetchClient`.
  - Model: `useContentIndex` (`ui/src/api/index.ts:402`), which uses `$api.useQuery("get", path, { params: { query } }, { placeholderData: keepPreviousData })`.
  - Hook test harness: `ui/src/api/contentIndex.test.ts`, with a hoisted `Request` + `fetch` mock.
- **Do NOT put the new hook in `#/api/index`.** `Folio.test.tsx:164` (and other tests) replace that whole module with a fixed export list. Use a new module, `ui/src/api/calendar.ts`, like `outlinks.ts` and `similar.ts`.
- **Folio tests have no `QueryClientProvider`.** Every test file that renders `Folio` must stub the new rail component, or it throws "No QueryClient set". There are 11 of them:
  - `components/codex/Folio.offline.test.tsx`
  - `components/codex/__tests__/{Folio,Folio.readonly,Folio.computed-tags,FolioJournalDraft,FolioAiConversation,FolioNavigation,FolioMeeting,FolioRecipe,WikilinkResolutionWiring,EditorConflictWiring,CodexFrameBreakpoint.integration}.test.tsx`
  - Re-grep with `grep -rln 'components/codex/Folio"' ui/src --include='*.test.tsx'`.
- **Folio right rail.** `ui/src/components/codex/Folio.tsx`:
  - `relationships` fragment: about line 1555;
  - `DesktopFolioLayout`: line 1735;
  - right `<aside aria-label="Page links">`: about line 1850, which renders `{relationships}`.
  - Page data: `editor.kind`, `editor.createdAt` (`usePageEditor.ts:118-122`), and the path.
  - The journal date comes from `journalDateFromPath(path) ?? aiJournalDateFromPath(path)` (`lib/journal.ts`). These already handle canonical filenames.
- **`Section`** (`components/codex/Section.tsx`) takes `label`, `caption`, `action`, `compact` and `pip`. It has no collapse, so build collapse from an `IconButton` in `action` with `aria-expanded`.
- **Opening a page.** `CLink` (`components/codex/CLink.tsx`) with `path` opens the page tab via `useOpenTab()` and gives the hover preview. `LinkList` in `Folio.tsx:2199` is the look to copy: `KindIcon` plus a truncated title.
- **Journals.**
  - `useOpenTodayJournal` (`hooks/useOpenTodayJournal.ts`) opens `page?.path ?? todayJournalPath()` with `openTab("page", path, label)`.
  - `useEnsureJournalToday` (`api/journal.ts:49`) calls `invalidatePageContent(qc, page.path)` on success.
  - `JournalMeta.tsx` repoints its tab with `updateTabPath`. The calendar opens a new tab instead.
- **Kinds.** `lib/kind.ts`: `KINDS`, `KIND_META[kind].color` (a CSS var, for example `var(--quire-ochre)`), `kindDisplayLabel`, `sortKindsByLabel`.
- **Time helpers.** `lib/time.ts`: `localDateKey`, `parseLocalDate`, `isoAddDays`, `pad2`. There is no ISO-week helper yet.
- **Views.**
  - `components/codex/useCodexView.ts` holds the `CodexView` union.
  - `components/codex/viewRegistry.ts` holds `VIEW_REGISTRY: Record<CodexView, …>`.
  - The Contents order is pinned in `viewRegistry.test.ts:84-96` and `ContentsMenu.test.tsx:73`.
- **Routes.**
  - Each route declares `staticData: { codexView }`.
  - The table in `routes/__tests__/routeViews.test.ts` (`OWN_CODEX_VIEW_BY_ROUTE_ID`) must list the new route.
  - `routeTree.gen.ts` regenerates when vite or vitest runs. Never hand-edit or reformat it.
- **Palette.**
  - In `components/codex/commandRegistry.ts`, add to the `StaticCommandAction` union and to `STATIC_COMMANDS`.
  - Add a dispatch `case` in `components/codex/CommandPalette.tsx` (about line 169, copying `navigate-gazetteer`).
  - Add a test in `components/codex/__tests__/CommandPalette.test.tsx`, modelled on "opens the Rubbish Bin" at line 328.
- **Docs inventory.** `ui/src/docs/featureInventory.ts` must list every route (the `/calendar` route) and every static command (`nav.calendar`). This is enforced by `docs/featureInventory.test.ts:74-93`.
- **Filters.**
  - `lib/filters/model.ts` has `FilterField` (`multi | single | flag`).
  - `lib/filters/url.ts` has `parseFilterSearch`, `canonicalizeFilterSearch`, `mergeFilterSearch` and `shouldReplaceFilterHistory`.
  - The route pattern to copy is `routes/agenda.tsx`: the `AGENDA_FILTER_URL` constant, `validateSearch: canonicalizeFilterSearch`, and `navigate({ search: merge…, replace })`.
  - Tag values come from `useTags()` in `#/api/index`. Project values come from `useProjectValues()` in `lib/useProjects.ts`.
- **UI primitives.** `components/ui/{menu,popover,segmented-control,icon-button,button}.tsx`, and `FOCUS_RING` / `FOCUS_RING_NATIVE` from `lib/focusRing.ts`.
- **Guards.** `src/__tests__/primitivesGuard.test.ts` rejects caps, tracking, `font-mono`, hard borders, 9–11px type and Vessel or shadcn colour names. Week numbers and counts must therefore be at least `text-[12px]`, in `text-mute` or `text-faint`. There are no borders. Separate with space and tone.
- **TZ in tests.** Node honours `process.env.TZ = "…"` at runtime. Follow the `components/codex/atrium-time.test.tsx:41-56` pattern: save the old value, set it, and restore it in `finally`.

## Gotchas

- In a fresh worktree, cargo needs `ui/dist` because of rust-embed. It is already seeded here.
- Piped cargo output can hide a failure. Check the exit status.
- **Never run `clep` against a vault** without `CLEPSYDRA__VAULT__ROOT`, because of the ambient-config hazard. Nothing in this plan needs `clep`. Schema regen is offline:
  `cargo run -q -p clep-api --example openapi > target/openapi.json && (cd ui && bun run openapi:file)`.
- Biome: run `bunx biome format --write <own files>` from `ui/`. Never run it over `routeTree.gen.ts` or `api/schema.d.ts`.
- zsh: quote globs in `--include='*.rs'`. `>` fails under noclobber, so use `>|`. Use `cd ui && bun run X`, never `bun --cwd ui`.
- The UI suite is fully green on develop. Any failure is real.
- Stage explicit paths. `git add .` is intercepted.
- Do not commit. The orchestrator commits.

---

## Task graph

```
Track A (Rust)            Track B (pure TS lib)     Track C (UI)
A1 index query ─┐         B1 dates/grid ─┐          C6 route+registry stub (independent)
                ├─ A2 API │              │          C3 DayNotesList      (needs B2)
A3 POST journal ┘ (after A2: shared files)          C4 MonthCalendar     (needs B1, B2)
        └────── A4 schema regen (needs A2, A3)       C1 hooks             (needs A4)
                          B2 bucketing ──┘          C2 openJournal hook  (needs C1)
                                                    C5 Folio rail        (needs C1, C2, C3, C4)
                                                    C7 Calendar screen   (needs C1, C2, C3, C4, C6, B3)
                          B3 search parsing (needs B1)
                                                    D1 docs (needs C5, C7)   G gates (last)
```

Waves you can run in parallel:

1. A1, B1, B2, C6
2. A2, B3, C3, C4
3. A3
4. A4
5. C1, then C2
6. C5 and C7 in parallel
7. D1
8. G

A2 and A3 both touch `openapi.rs`, `api-reference.mdx` and `openapi_contract.rs`, so run them one after the other. C5 and C7 touch disjoint files.

---

## A1 — clep-index: `calendar_entries` query + `created_at` index

**Files**

- new `crates/clep-index/src/calendar.rs`
- `crates/clep-index/src/lib.rs`: add `mod calendar;`
- `crates/clep-index/src/index.rs`: add a `pub use crate::calendar::{CalendarEntry, CalendarQuery, CalendarPage};` beside line 21, and one `SCHEMA` line
- `crates/clep-index/src/index_handle.rs`: async wrapper
- new `crates/clep-index/tests/calendar_test.rs`

**Interface sketch**

```rust
pub struct CalendarQuery {
    pub from_utc: String,         // normalised: DateTime<Utc>::to_rfc3339()
    pub to_utc: String,           // exclusive
    pub journal_from: NaiveDate,  // inclusive
    pub journal_to: NaiveDate,    // inclusive (padded by design)
    pub kinds: Vec<String>,       // canonical Kind tokens; empty = all
    pub tag: Option<String>,
    pub project: Option<String>,
    pub limit: usize,
}
pub struct CalendarEntry { pub path: String, pub title: Option<String>, pub kind: String,
                           pub created_at: Option<String>, pub journal_date: Option<String> }
pub struct CalendarPage { pub entries: Vec<CalendarEntry>, pub truncated: bool }
impl VaultIndex { pub fn calendar_entries(&self, q: &CalendarQuery) -> Result<CalendarPage, IndexError> }
impl IndexHandle { pub async fn calendar_entries(&self, q: CalendarQuery) -> Result<CalendarPage, IndexError> }
```

SQL, where `J` is the journal kinds from `Kind::Journal.as_str()` and `Kind::AiJournal.as_str()`, bound as parameters:

```
WHERE (
   (p.kind IN (J) AND p.journal_date IS NOT NULL AND p.journal_date BETWEEN ?jf AND ?jt)
OR ((p.kind NOT IN (J) OR p.journal_date IS NULL)
     AND p.created_at IS NOT NULL AND p.created_at >= ?cf AND p.created_at < ?ct)
) [AND p.kind IN (?..)] [AND p.project = ?] [AND EXISTS (tags … t.tag = ?)]
ORDER BY COALESCE(p.journal_date, p.created_at), p.path COLLATE NOCASE
LIMIT ?limit+1
```

`truncated` is `rows > limit`. Truncate the result to `limit`.

Add this line to `SCHEMA`:

```
CREATE INDEX IF NOT EXISTS idx_pages_created_at ON pages(created_at) WHERE created_at IS NOT NULL;
```

**Failing tests first** (`crates/clep-index/tests/calendar_test.rs`)

Copy the `setup_vault` / `built` helpers from `unlinked_mentions_test.rs`. Fixture pages use frontmatter with `id`, `title`, `type`, `project`, `tags` and `created_at`.

Base window: `from_utc = "2026-08-31T23:00:00+00:00"`, `to_utc = "2026-09-30T23:00:00+00:00"`, `journal 2026-09-01..=2026-10-01`. This is September in London.

1. `includes_pages_created_inside_the_window_half_open`
   - Setup: `created_at` values `2026-08-31T23:30:00Z` (in), `2026-09-30T22:59:59Z` (in), `2026-09-30T23:00:00Z` (out) and `2026-08-31T22:59:59Z` (out).
   - Assert: the set of titles is exactly the two "in" pages.
2. `places_journal_kinds_by_journal_date_not_created_at`
   - Setup:
     - `journals/2026-09-15.md` with `created_at: 2026-10-20T00:00:00Z`: included, `journal_date == Some("2026-09-15")`;
     - `journals/2026-08-20.md` with `created_at: 2026-09-10T00:00:00Z`: excluded.
3. `journal_window_is_inclusive_of_both_padded_dates`
   - Setup: journals dated `2026-09-01`, `2026-10-01` and `2026-10-02`.
   - Assert: the first two are in, the third is out.
4. `ai_journal_uses_journal_date`: `ai-journals/2026-09-03.md` is included with kind `AI_JOURNAL`.
5. `excludes_pages_without_created_at`
   - After `build`, run `UPDATE pages SET created_at = NULL WHERE title = 'Broken'` through `index.connection()`. Frontmatter repair may backfill `created_at` at build time, so null it directly.
   - Assert: `Broken` is absent.
6. `filters_by_kinds_tag_and_project`: with `kinds=["RECIPE"]`, only recipes are returned. With `tag=Some("wine")`, only tagged pages. With `project=Some("Cellar")`, only that project. All three together narrow to their intersection.
7. `sub_second_created_at_compares_correctly`: `2026-09-30T22:59:59.500Z` is in. The stored `to_rfc3339` form carries `.5`.
8. `truncates_at_limit_and_flags_it`: with 3 matching pages and `limit=2`, `entries.len()==2` and `truncated==true`. With `limit=3`, `truncated==false`.
9. `orders_by_placement_date_then_path`: assert the order of the returned paths.
10. `creates_created_at_index`: `SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_pages_created_at'` returns 1. Also check that opening the same db path a second time succeeds (idempotent).

**Implementation notes**

- Keep the handler-facing contract in `CalendarQuery`. All RFC3339 parsing happens in the API layer (A2), which keeps this crate string- and date-only.
- Add a rustdoc comment to `calendar_entries` that states the placement rule.

**Verify**

`cargo test -p clep-index --test calendar_test && cargo test -p clep-index`

---

## A2 — clep-api: `GET /api/vault/index/calendar` (depends on A1)

**Files**

- new `crates/clep-api/src/api/calendar.rs`
- `crates/clep-api/src/api/mod.rs`: `pub mod calendar;`
- `crates/clep-api/src/api/index_routes.rs`: add `.route("/calendar", get(super::calendar::calendar_entries))` in `router()` at line 556
- `crates/clep-api/src/api/openapi.rs`: add the path and schemas `CalendarResponse` and `CalendarEntry`
- `ui/src/docs/content/api-reference.mdx`: add a heading under `## Index`
- `crates/clep-api/tests/openapi_contract.rs`: add `("/api/vault/index/calendar", "get")` to the required list
- new `crates/clep-api/tests/api_calendar_test.rs`

**Interface sketch**

```rust
#[derive(Debug, Deserialize, IntoParams)] #[into_params(parameter_in = Query)]
pub struct CalendarQueryParams {
    /// Inclusive window start, RFC3339 with offset (client local midnight).
    pub from: String,
    /// Exclusive window end, RFC3339 with offset.
    pub to: String,
    /// Comma-separated canonical Kind tokens; omitted = all kinds.
    pub kind: Option<String>,
    pub tag: Option<String>,
    pub project: Option<String>,
}
#[derive(Serialize, ToSchema)] pub struct CalendarEntry {
    pub path: String, pub title: Option<String>,
    #[schema(value_type = crate::vault::kind::Kind)] pub kind: String,
    pub created_at: Option<String>, pub journal_date: Option<String> }
#[derive(Serialize, ToSchema)] pub struct CalendarResponse { pub entries: Vec<CalendarEntry>, pub truncated: bool }
pub const CALENDAR_ENTRY_LIMIT: usize = 5000;
pub const CALENDAR_MAX_SPAN_DAYS: i64 = 450;
```

**Handler rules**

- Parse `from` and `to` with `DateTime::parse_from_rfc3339`. A parse failure is a 400 with the message `invalid from` or `invalid to`.
- If `to <= from`, return 400.
- If the span is more than `CALENDAR_MAX_SPAN_DAYS`, return 400. The 12-month running grid is at most about 386 days.
- `journal_from = from.date_naive()` and `journal_to = to.date_naive()`. Each is the local date in its own offset.
- The `from_utc` / `to_utc` bounds are `.with_timezone(&Utc).to_rfc3339()`.
- For `kind`, split on `,`, trim, and drop empty values. Map each token with `Kind::from_token`. An unknown token is a 400 `unknown kind: X`. Deduplicate.
- An empty `tag` or `project` (after trim) counts as `None`.
- Call `state.index.calendar_entries(q).await`. An error becomes `ApiError::internal`.

**utoipa annotation:** `path = "/index/calendar"`, `context_path = "/api/vault"`, `tag = "Index"`, `params(CalendarQueryParams)`. Responses: 200 `CalendarResponse`, 400 `ApiError`, 500 `ApiError`.

**Docs heading** (under `## Index`, alphabetical among the Index headings):

```
### `GET /api/vault/index/calendar`
Pages placed on calendar days in a window: journals by `journal_date`, everything else by `created_at`. `from`/`to` are RFC3339 with offset (`to` exclusive); `kind` is comma-separated. Capped at 5000 with `truncated`. Responses: `200` Calendar entries; `400` Invalid window or kind; `500` Internal server error.
```

**Failing tests first** (`api_calendar_test.rs`, `mod support;`)

Seed with `pre_index_seed`, using the same fixtures as A1 in a smaller form.

1. `returns_entries_in_window_with_slim_shape`
   - Request: `GET /api/vault/index/calendar?from=2026-09-01T00:00:00%2B01:00&to=2026-10-01T00:00:00%2B01:00`.
   - Assert: status 200. Each entry has exactly the keys `path, title, kind, created_at, journal_date`. `truncated == false`.
   - Note: the `+` must be URL-encoded as `%2B`. Build the URL with `axum_test`'s `.add_query_param("from", "...")` to avoid mistakes.
2. `journal_entries_carry_journal_date`: `journals/2026-09-15.md` has `journal_date == "2026-09-15"` and `kind == "JOURNAL"`.
3. `offset_is_honoured_for_created_at`
   - A page created `2026-08-31T23:30:00Z` is included for `from=2026-09-01T00:00:00+01:00`.
   - It is excluded for `from=2026-09-01T00:00:00+00:00`.
4. `filters_by_comma_separated_kind_tag_and_project`: `kind=RECIPE,NOTE`, `tag=wine`, `project=Cellar`.
5. `rejects_bad_windows`: each of these returns 400:
   - a missing `from`;
   - `from=yesterday`;
   - `to` equal to `from`;
   - a span of 500 days;
   - `kind=NOPE`.
6. The existing `docs_api_coverage_test` and `openapi_contract` tests must pass after the heading and list edits. Run them.

**Verify**

`cargo test -p clep-api --test api_calendar_test --test docs_api_coverage_test --test openapi_contract`

---

## A3 — clep-api: `POST /api/vault/journal/{date}` get-or-create (after A2; see Q1)

**Files**

- `crates/clep-api/src/api/journal.rs`: the router at line 98 becomes `.route("/{date}", get(get_by_date).post(ensure_by_date))`. Add a new handler `ensure_by_date`.
- `openapi.rs`: add the path
- `api-reference.mdx`: under `## Journal`, add ``### `POST /api/vault/journal/{date}` ``
- `openapi_contract.rs`: add `("/api/vault/journal/{date}", "post")` to the list
- `crates/clep-api/tests/api_journal_test.rs`: tests

**Handler.** Copy the body of `ensure_today`, with `date` taken from `Path` and validated by `parse_date(&date)?`, which returns 400 on a bad date. Call `ensure_journal(&state, HUMAN_JOURNAL, &date)`. Return 201 when created, 200 when it existed, with `PageDetailResponse`.

**Failing tests first**

1. `ensure_by_date_creates_a_journal_for_a_past_date`
   - Request: `POST /api/vault/journal/2042-05-01`.
   - Assert: 201. `meta.title == "2042-05-01"`. The `path` starts with `journals/`. A following `GET /api/vault/journal/2042-05-01` returns 200 with the same path.
2. `ensure_by_date_returns_existing_journal_with_200`: seed `journals/2042-05-02.md`, then POST. Assert 200 and the seeded path.
3. `ensure_by_date_rejects_invalid_date`: `POST /api/vault/journal/2042-13-40` returns 400.
4. `ensure_by_date_is_idempotent_under_concurrency`: `tokio::join!` two POSTs for the same date. Assert exactly one 201, and both paths are equal.

**Verify**

`cargo test -p clep-api --test api_journal_test --test docs_api_coverage_test --test openapi_contract`

---

## A4 — regenerate `ui/src/api/schema.d.ts` (depends on A2, A3)

1. Run:
   `cargo run -q -p clep-api --example openapi >| target/openapi.json && (cd ui && bun run openapi:file)`
2. Check that `schema.d.ts` now has `"/api/vault/index/calendar"`, `CalendarEntry` and `CalendarResponse`, and a `post` on `"/api/vault/journal/{date}"`.
3. Do not format the file.

**Verify**

`cd ui && bun run typecheck`

---

## B1 — pure date/grid lib (independent)

**Files**

- new `ui/src/lib/calendar/dates.ts`
- new `ui/src/lib/calendar/dates.test.ts`

**Interface sketch** (every "key" is a local `YYYY-MM-DD`; every `Date` is local midnight)

```ts
export type DateKey = string;
export interface IsoWeek { isoYear: number; week: number }
export function isoWeek(key: DateKey): IsoWeek;
export function mondayOf(key: DateKey): DateKey;
export interface WeekRow { isoYear: number; week: number; days: DateKey[] /* 7, Mon..Sun */ }
export function monthGrid(year: number, month0: number): WeekRow[];          // Monday-start, only rows touching the month
export function weekRows(anchor: DateKey, count: number): WeekRow[];          // from mondayOf(anchor)
export function addMonths(key: DateKey, n: number): DateKey;                  // clamps day (Jan 31 + 1 → Feb 28/29)
export interface LocalRange { from: Date; to: Date }                          // to exclusive
export function monthGridRange(year: number, month0: number): LocalRange;
export function monthsRange(anchor: DateKey, months: number): LocalRange;     // grid of first month .. grid of last
export type CalendarMode = "month" | "months" | "weeks";
export function rangeForView(v: { mode: CalendarMode; anchor: DateKey; span: number }): LocalRange;
export function toOffsetIso(d: Date): string;                                 // "2026-03-30T00:00:00+01:00"
export function rangeKeys(r: LocalRange): { first: DateKey; last: DateKey };  // inclusive local keys
```

Use UTC arithmetic on the `Y/M/D` components for day stepping (as `dayOfYear` in `lib/time.ts` does). Never add `86_400_000` to a local Date, because that breaks on DST days.

**Failing tests first** (`describe("calendar dates")`)

- `isoWeek`:
  - `2026-12-28 → {2026, 53}`
  - `2027-01-01 → {2026, 53}`
  - `2027-01-04 → {2027, 1}`
  - `2024-12-30 → {2025, 1}`
  - `2026-09-30 → {2026, 40}`
- `mondayOf`: `2026-09-30 → 2026-09-28`, `2026-09-28 → itself`, `2026-10-04 (Sun) → 2026-09-28`.
- `monthGrid`:
  - August 2026 has 6 rows. The first row's days start `2026-07-27`. The last row starts `2026-08-31`. The week numbers are `[31,32,33,34,35,36]`.
  - February 2027 has exactly 4 rows, because it starts on a Monday and has 28 days.
  - February 2028 (a leap year) contains `2028-02-29`. Its last row ends `2028-03-05`.
  - December 2026 has a last row that spans `2026-12-28..2027-01-03` with week 53. January 2027's first row is that same week, `{2026, 53}`.
- `addMonths`: `2026-01-31 + 1 → 2026-02-28`, `2028-01-31 + 1 → 2028-02-29`, `2026-12-15 + 1 → 2027-01-15`, `2026-03-15 - 3 → 2025-12-15`.
- `monthGridRange` in `TZ=Europe/London` (restore TZ in `finally`), for March 2026:
  - `toOffsetIso(from) === "2026-02-23T00:00:00+00:00"`
  - `toOffsetIso(to) === "2026-04-06T00:00:00+01:00"`
  - This crosses the 29 March DST start.
- `toOffsetIso`:
  - London: `new Date(2026,9,25)` → `"2026-10-25T00:00:00+01:00"` and `new Date(2026,9,26)` → `"2026-10-26T00:00:00+00:00"`.
  - `TZ=America/New_York`: `new Date(2026,0,1)` → `"2026-01-01T00:00:00-05:00"`.
  - `TZ=Asia/Kolkata`: `+05:30`.
- `weekRows("2026-09-30", 2)`: 2 rows. Days `2026-09-28..2026-10-11`. Weeks `[40, 41]`.
- `rangeForView`:
  - month → same as `monthGridRange`;
  - months with span 3 from `2026-11-10` → `from` = the grid start of November 2026, `to` = the grid end of January 2027;
  - weeks with span 2 → `[mondayOf, +14d)`.
- `rangeKeys(monthGridRange(2026,7))` → `{ first: "2026-07-27", last: "2026-09-06" }`.

**Verify**

`cd ui && bun run test src/lib/calendar/dates.test.ts`

---

## B2 — bucketing (independent; local structural types)

**Files**

- new `ui/src/lib/calendar/bucket.ts`
- new `ui/src/lib/calendar/bucket.test.ts`

**Interface sketch**

```ts
import type { Kind } from "#/lib/kind";
export interface CalendarEntryLike { path: string; title?: string | null; kind: Kind;
  created_at?: string | null; journal_date?: string | null }
export const JOURNAL_KINDS: ReadonlySet<Kind>; // JOURNAL, AI_JOURNAL
export function placementKey(e: CalendarEntryLike): DateKey | null;
export function bucketEntries<E extends CalendarEntryLike>(entries: readonly E[],
  range: { first: DateKey; last: DateKey }, hiddenKinds?: ReadonlySet<Kind>): Map<DateKey, E[]>;
export function dayKinds(entries: readonly CalendarEntryLike[], max = 4): Kind[];   // distinct, stable order
export function groupByKind<E extends CalendarEntryLike>(entries: readonly E[]): Array<{ kind: Kind; entries: E[] }>;
```

**Placement rule.**

- If the kind is a journal kind and it has a `journal_date`, use `journal_date`.
- Otherwise, if it has a `created_at`, use `localDateKey(new Date(created_at))`.
- Otherwise, return null.

Entries whose key is outside `[first, last]` are dropped. This is the client trim of the server's padded journal window.

**Order.** Within a day, journal kinds come first, then titles A→Z by `localeCompare`, with the path as the tiebreak. `dayKinds` order follows `KINDS` order, and journal kinds come first.

**Failing tests first**

- `placementKey`:
  - `{kind:"JOURNAL", journal_date:"2026-09-15", created_at:"2026-09-16T08:00:00+00:00"}` → `"2026-09-15"`.
  - `{kind:"JOURNAL", journal_date:null, created_at:"2026-09-16T08:00:00+00:00"}` → the created_at local key (Q4 fallback).
  - `{kind:"NOTE", journal_date:"2026-09-15", created_at:…}` → the created_at key. A non-journal kind ignores `journal_date`.
  - `{kind:"NOTE", created_at:null}` → `null`.
- Local-date conversion under TZ (restore in `finally`):
  - London: `"2026-10-24T23:30:00+00:00"` → `"2026-10-25"` (BST). `"2026-10-25T23:30:00+00:00"` → `"2026-10-25"` (GMT after the fall-back).
  - `America/New_York`: `"2026-09-16T02:00:00+00:00"` → `"2026-09-15"`.
  - `Pacific/Kiritimati`: `"2026-09-15T11:00:00+00:00"` → `"2026-09-16"`.
  - London, year boundary: `"2026-12-31T23:30:00+00:00"` → `"2026-12-31"`. `America/Los_Angeles`: `"2027-01-01T05:00:00+00:00"` → `"2026-12-31"`.
- `bucketEntries`:
  - A journal dated one day past `last` (the server pad) is dropped.
  - `hiddenKinds = {RECIPE}` removes recipes.
  - Two notes on one day come back sorted, with the journal first.
  - The Map has no keys for empty days.
- `dayKinds`: six distinct kinds with `max=4` → length 4, and journal kinds are included first. Duplicates collapse.
- `groupByKind`: groups follow `dayKinds` order, and each group keeps the sorted order.

**Verify**

`cd ui && bun run test src/lib/calendar/bucket.test.ts`

---

## B3 — calendar screen search parsing (depends on B1)

**Files**

- new `ui/src/lib/calendar/search.ts`
- new `ui/src/lib/calendar/search.test.ts`

**Interface**

```ts
export const CALENDAR_FILTER_URL: FilterUrlOptions = { fields: [
  { id: "kind", kind: "multi", normalize: (v) => v.toUpperCase() },
  { id: "tag", kind: "single" }, { id: "project", kind: "single" } ] };
export interface CalendarViewSearch { mode: CalendarMode; date?: DateKey; span: number; day?: DateKey }
export function parseCalendarView(search: Record<string, unknown>): CalendarViewSearch;
export function validateCalendarSearch(search: Record<string, unknown>): Record<string, unknown>; // canonicalizeFilterSearch + view fields
export const SPANS: Record<CalendarMode, readonly number[]>; // month:[1], months:[3,6,12], weeks:[1,2,4]
```

**Failing tests first**

- An empty search gives `{mode:"month", span:1}`, with `date` and `day` undefined.
- `mode=months&span=6` → span 6. `mode=months&span=5` → the default span 3. `mode=weeks` with no span → 2. `mode=bogus` → `"month"`.
- `date=2026-02-30` or `date=nope` → `date` is undefined (strict `YYYY-MM-DD`, and the date must round-trip). `day=2026-09-15` is kept.
- `kind=["journal","NOTE"]` → `["JOURNAL","NOTE"]`. `kind=JOURNAL,NOTE` (comma string) → the same. Unknown kinds are dropped (filter against `KINDS`).
- `validateCalendarSearch` keeps unknown keys (the pattern `canonicalizeFilterSearch` uses) and writes the canonical `mode`, `span`, `date` and `day`.

**Verify**

`cd ui && bun run test src/lib/calendar/search.test.ts`

---

## C1 — query + mutation hooks (depends on A4)

**Files**

- new `ui/src/api/calendar.ts`
- new `ui/src/api/calendar.test.ts`
- `ui/src/api/journal.ts`: add `useEnsureJournalForDate`

**Interface**

```ts
export type CalendarEntry = components["schemas"]["CalendarEntry"];
export type CalendarResponse = components["schemas"]["CalendarResponse"];
export interface CalendarEntriesOptions { range: LocalRange; kinds?: readonly Kind[]; tag?: string; project?: string }
export function useCalendarEntries(opts: CalendarEntriesOptions, { enabled = true } = {}):
  // $api.useQuery("get", "/api/vault/index/calendar",
  //   { params: { query: { from: toOffsetIso(range.from), to: toOffsetIso(range.to),
  //       kind: kinds?.length ? [...kinds].sort().join(",") : undefined, tag, project } } },
  //   { enabled, placeholderData: keepPreviousData })
// journal.ts
export function useEnsureJournalForDate(): UseMutationResult<EnsureJournalResult, Error, string>;
//   POST "/api/vault/journal/{date}" { params: { path: { date } } }; onSuccess → invalidatePageStructure(qc) (new file → folders too)
```

**Failing tests first** (copy the fetch harness from `contentIndex.test.ts`)

1. `useCalendarEntries sends offset-bearing bounds and a sorted comma kind list`
   - Setup: set TZ to London and render with `range = monthGridRange(2026, 2)` and `kinds=["NOTE","JOURNAL"]`.
   - Assert, from the URL of the request passed to `fetchMock.mock.calls[0][0]`: `from=2026-02-23T00:00:00+00:00`, `to=2026-04-06T00:00:00+01:00`, `kind=JOURNAL,NOTE`.
2. `omits kind when no kinds are given`.
3. `keeps previous data while the next month loads`: the pattern from `contentIndex.test.ts:36`.
4. `useEnsureJournalForDate posts to the date path and returns created`: the mock returns a 201 body. Assert the POST URL `/api/vault/journal/2026-09-02` and `result.created === true`.
5. The query key starts with `"get", "/api/vault/index/calendar"`. Assert this by spying `invalidateByPath(qc, "/api/vault/index")`: the query must become stale. This proves the free invalidation.

**Verify**

`cd ui && bun run test src/api/calendar.test.ts src/api/__tests__/journal.test.tsx`

---

## C2 — `useOpenJournalForDate` (depends on C1)

**Files**

- new `ui/src/hooks/useOpenJournalForDate.ts`
- new `ui/src/hooks/useOpenJournalForDate.test.tsx`

**Behaviour** of `(dateKey: DateKey, existingPath?: string) => Promise<void>`:

- If `existingPath` is given, call `openTab("page", existingPath, dateKey)`.
- Else, if `dateKey === localDateKey(new Date())`, call `openTab("page", todayJournalPath(), dateKey)`. This is the draft; the file is created on first write, as `useOpenTodayJournal` does.
- Else, call `ensure.mutateAsync(dateKey)` and then `openTab("page", result.page.path, dateKey)`.
- On error, show a toast. Find the repo toast helper via `components/ui/Toaster.tsx`. Do not open a tab.

**Failing tests first** (mock `#/hooks/useOpenTab` and `#/api/journal` exactly as `ui/src/hooks/useOpenTodayJournal.test.tsx` does)

1. `opens the existing journal path without creating`: `mutateAsync` is not called.
2. `opens today's draft path without creating`: use fake timers, with system time 2026-09-30 10:00.
3. `creates then opens a past day's journal`: `mutateAsync("2026-09-02")`, then `openTab("page", "journals/20260930.2026-09-02.abcd1234.md", "2026-09-02")`.
4. `does not open a tab when creation fails`.

**Verify**

`cd ui && bun run test src/hooks/useOpenJournalForDate.test.tsx`

---

## C3 — `DayNotesList` (depends on B2)

**Files**

- new `ui/src/components/calendar/DayNotesList.tsx`
- new `ui/src/components/calendar/__tests__/DayNotesList.test.tsx`

**Props:** `{ dateKey: DateKey; entries: readonly CalendarEntryLike[]; journalPath?: string | null; onOpenJournal: () => void; headingLevel?: 3 | 4 }`

**Render**

- A heading with the long local date, for example "Wednesday 30 September 2026". Format it with `parseLocalDate(dateKey).toLocaleDateString(undefined, {weekday:"long", day:"numeric", month:"long", year:"numeric"})`, which matches `lib/journal.ts` `dayLabel`.
- Then one group per `groupByKind(entries)`:
  - a group label from `kindDisplayLabel(kind)` with a kind-colour dot (`style={{ background: KIND_META[kind].color }}`, `aria-hidden`);
  - then a `CLink path={e.path}` row per entry, with `KindIcon tone="mono"` and a truncated title (`title ?? path`). This matches `Folio.tsx` `LinkList`.
- The group is an `<ul aria-label={kindLabel}>`.
- Footer: a `Button variant="secondary"` labelled "Open journal" when there is no JOURNAL entry, or "Open journal · written" when one exists (`journalPath`). It calls `onOpenJournal`.
- Empty state: "Nothing created this day." in `text-mute`.

**Failing tests first** (mock `CLink` to a plain `<a data-path>` or wrap it in the store providers it needs; check an existing CLink test first)

1. `groups entries by kind in dayKinds order with journals first`: assert the `getAllByRole("list")` names are `["JOURNAL", "NOTE", "RECIPE"]`.
2. `renders each entry as a link to its path, falling back to the path when untitled`.
3. `shows the empty message when there are no entries`.
4. `Open journal calls onOpenJournal; label reflects an existing journal`.
5. `colour dots are aria-hidden and use KIND_META colours`.

**Verify**

`cd ui && bun run test src/components/calendar/__tests__/DayNotesList.test.tsx`

---

## C4 — `MonthCalendar` (depends on B1, B2)

**Files**

- new `ui/src/components/calendar/MonthCalendar.tsx`
- new `ui/src/components/calendar/__tests__/MonthCalendar.test.tsx`
- `ui/package.json`: `bun add @internationalized/date@3.12.3`
- `ui/bun.lock`

Optional: `MonthCalendar.stories.tsx`, for Storybook parity with other primitives.

**Props**

```ts
interface MonthCalendarProps {
  visibleMonth: DateKey;                       // any day in the first visible month
  onVisibleMonthChange: (key: DateKey) => void; // prev/next/Today and keyboard paging
  months?: number;                             // default 1 (Months mode passes 3|6|12)
  byDay: ReadonlyMap<DateKey, readonly CalendarEntryLike[]>;
  today: DateKey;
  selectedDate?: DateKey | null;               // rail: the open page's date
  activeDate?: DateKey | null;                 // day whose popover/panel is open
  onDayActivate: (key: DateKey, cell: HTMLElement) => void;
  variant: "rail" | "page";                    // rail = dots, 32px rows; page = dots + count, taller rows
  headerExtra?: ReactNode;                     // screen puts the mode switch here
}
```

**Structure**

- `Calendar aria-label="Calendar" firstDayOfWeek="mon" value={null} onChange={d => onDayActivate(d.toString(), cellRefs.get(key))} focusedValue={parseDate(visibleMonth)} onFocusChange={d => onVisibleMonthChange(d.toString())} visibleDuration={{ months }}`.
- A header with a `Heading` (month and year, serif italic, following Stone & Lamp) and three buttons:
  - `IconButton slot="previous"` (aria "Previous month");
  - a "Today" `Button size="sm"` that calls `onVisibleMonthChange(today)`;
  - `IconButton slot="next"`.
- For each `i < months`: a wrapper `div.grid grid-cols-[auto_1fr]`, holding:
  - the week-number column (`aria-hidden`) from `monthGrid(y, m + i)`, one fixed-height row per `WeekRow`, `text-[12px] text-faint`;
  - `CalendarGrid offset={{ months: i }}` with a header of `CalendarHeaderCell`s. RAC gives localized short weekday names starting Monday.
- `CalendarCell` render function:
  - the day number;
  - `dayKinds(byDay.get(key))` dots (`aria-hidden`, `KIND_META` colours);
  - a count on the page variant;
  - `data-today`, `data-selected` and `data-active` attributes;
  - classes: an `accent` ring for today, an `accent-tint` fill for selected, a solid `ring-accent` for active; out-of-month days in `text-faint`.
  - Keep a ref map `key → td/div element` for the popover anchor.
- Cells get a fixed height per variant: rail `h-8`, page `h-24`. The week-number rows use the same height, which keeps the columns aligned.

**Failing tests first** (render with a fixed `today="2026-09-30"`, `visibleMonth="2026-09-01"`)

1. `renders Monday-first weekday headers`: the first `columnheader` text matches `/^M/` (en-US). `getAllByRole("columnheader").length === 7`.
2. `renders one week number per grid row, aligned with rows`: September 2026 has 5 rows. The week-number column shows `36, 37, 38, 39, 40`, and `getAllByRole("row").length - 1` (minus the header row) equals the number of week labels.
3. `shows one dot per distinct kind, capped at four`: `byDay` for `2026-09-15` holds 6 entries of 5 kinds, so the cell contains 4 `[data-kind-dot]`.
4. `marks today and the selected date`: the cell for `2026-09-30` has `data-today`; the cell for `selectedDate="2026-09-15"` has `data-selected`.
5. `pressing a day calls onDayActivate with its key and cell, including re-pressing the same day`: `user.click` the day-15 button twice, so the mock is called twice with `"2026-09-15"`. This pins the `value={null}` behaviour.
6. `prev/next/Today change the visible month`: clicking "Next month" gives `onVisibleMonthChange` a key in October 2026. "Today" gives `"2026-09-30"`.
7. `keyboard: ArrowRight moves focus to the next day; PageDown requests the next month`: focus a day button, press the key, and assert `document.activeElement` or the callback.
8. `page variant shows the per-day count`: the cell text contains `6`.
9. `months={3} renders three grids with their own week-number columns`: 3 `grid` roles.

**Verify**

`cd ui && bun run test src/components/calendar/__tests__/MonthCalendar.test.tsx`

---

## C5 — Folio right-rail Calendar section (depends on C1, C2, C3, C4)

**Files**

- new `ui/src/lib/calendar/railPrefs.ts` and its test
- new `ui/src/components/calendar/FolioCalendarSection.tsx`
- new `ui/src/components/calendar/__tests__/FolioCalendarSection.test.tsx`
- `ui/src/components/codex/Folio.tsx`
- the stub line in each of the 11 Folio test files (see Reference facts)

**`railPrefs.ts`**

- `readHiddenKinds(): Set<Kind>` and `writeHiddenKinds(set)` under the key `clepsydra.calendar.rail.hiddenKinds`. The value is a JSON array, filtered against `KINDS`.
- `readCollapsed(): boolean` and `writeCollapsed(v)` under `clepsydra.calendar.rail.collapsed`.
- Every access is in try/catch and falls back to the default (no kinds hidden, not collapsed).

Tests:

- round-trip;
- corrupt JSON gives an empty set;
- unknown kinds are dropped;
- `getItem` throwing (stub `window.localStorage.getItem` with `vi.spyOn(...).mockImplementation(() => { throw … })`) gives the defaults and does not throw.

**`FolioCalendarSection` props:** `{ path: string; kind: string | null; createdAt: string | null }`

- `pageDate` is `journalDateFromPath(path) ?? aiJournalDateFromPath(path) ?? (createdAt ? localDateKey(new Date(createdAt)) : null)`.
- State:
  - `visibleMonth`, initialised to `pageDate ?? today` and **reset when `path` changes** (key the effect on `path`);
  - `activeDay` plus the anchor element;
  - the hidden kinds;
  - the collapsed flag.
- `useCalendarEntries({ range: monthGridRange(visibleMonth) })`. There is no kind filter on the server.
- `byDay = bucketEntries(data.entries, rangeKeys(range), hiddenKinds)`.
- Wrap everything in `<Section compact label="Calendar" action={…}>`. The `action` holds:
  - the kind toggle: `MenuTrigger` + `IconButton aria-label="Calendar kinds"` + `Menu selectionMode="multiple" selectedKeys={visibleKinds}` over `sortKindsByLabel(KINDS)`, each item with a colour dot;
  - the collapse toggle: `IconButton aria-label="Collapse calendar" | "Expand calendar"` with `aria-expanded` and `aria-controls`.
- When `truncated`, show the caption "5000+".
- The body renders `MonthCalendar variant="rail"` with `selectedDate={pageDate}` and `activeDate`.
- Day activation opens a RAC `Popover triggerRef={anchor} isOpen onOpenChange placement="left top"` holding a `Dialog aria-label={long date}` with `<DayNotesList … onOpenJournal={() => openJournal(day, journalPathFor(day))} />`.
  - `journalPathFor(day)` is the path of the first `JOURNAL` entry in the bucket.
  - Opening a note or a journal closes the popover.

**`Folio.tsx`**

- Build `const calendar = <FolioCalendarSection path={path} kind={editor.kind} createdAt={editor.createdAt} />` next to `relationships`.
- Pass it to `DesktopFolioLayout` as a new `calendar: React.ReactNode` prop.
- Render it as the first child after `RailHideButton`, inside the right `<aside aria-label="Page links">`, above `{relationships}`.
- Do not pass it to `MobileFolioLayout` (Q3).

**Folio tests.** Add this to each of the 11 files:

```ts
vi.mock("#/components/calendar/FolioCalendarSection", () => ({ FolioCalendarSection: () => null }));
```

**Failing tests first** (`FolioCalendarSection.test.tsx`, with `vi.mock("#/api/calendar")`, `vi.mock("#/hooks/useOpenJournalForDate")` and a mocked `CLink`, or providers)

1. `starts on the journal page's month`: path `journals/2026-03-10.md` → the heading contains "March 2026". The hook is called with the March grid range.
2. `starts on created_at's local month for other kinds`, and `falls back to today when the page has neither`.
3. `re-anchors when the open page changes`: rerender with a different path/createdAt, and the heading follows.
4. `highlights the open page's date`: the `data-selected` cell is day 10.
5. `kind toggle hides dots and persists hidden kinds`: untick RECIPE, the dot count drops, and `localStorage["clepsydra.calendar.rail.hiddenKinds"] === '["RECIPE"]'`. On remount the kind is still hidden.
6. `clicking a day opens a popover listing that day's notes grouped by kind`: `getByRole("dialog", { name: /15 September 2026/ })` contains the `JOURNAL` group.
7. `Open journal passes the existing journal path when one is written`, and passes `undefined` otherwise.
8. `collapse hides the calendar and persists`: `aria-expanded="false"`, no `grid` role, and the storage key is `"1"` or `true`.
9. `shows 5000+ when the response is truncated`.

Also add to `Folio.test.tsx`: `renders the calendar section at the top of the desktop right rail`. Override the stub in that single test with a marker component (`() => <div data-testid="rail-calendar" />`). Assert it is the first element child after the hide button in `getByRole("complementary", { name: "Page links" })`.

**Verify**

`cd ui && bun run test src/components/calendar src/lib/calendar src/components/codex`

---

## C6 — route, CodexView, registry, palette, inventory (independent; stub screen)

**Files**

- `ui/src/components/codex/useCodexView.ts`: add `| "calendar"`
- `ui/src/components/codex/viewRegistry.ts`: add an entry after `gazetteer`:
  ```ts
  calendar: { label: "Calendar", group: "Organise", description: "Pages by the day they were made.",
    shortcut: null, showsSheaf: false, feature: null, navRoot: "calendar", mobile: null,
    go: ({ navigate }) => void navigate({ to: "/calendar" }) },
  ```
- new `ui/src/routes/calendar.tsx`: `createFileRoute("/calendar")({ staticData: { codexView: "calendar" }, validateSearch: validateCalendarSearch, component: CalendarPage })`.
  - Until C7 lands, `CalendarPage` renders a placeholder `<h1>Calendar</h1>`.
  - `validateCalendarSearch` comes from B3. If B3 is not merged yet, use an identity `validateSearch` and let C7 swap it.
- `ui/src/components/codex/commandRegistry.ts`: add `"navigate-calendar"` to `StaticCommandAction`, and `{ id: "nav.calendar", title: "Open Calendar", action: "navigate-calendar" }` after `nav.gazetteer`
- `ui/src/components/codex/CommandPalette.tsx`: add `case "navigate-calendar": goToView("calendar", {...}); return;`
- `ui/src/docs/featureInventory.ts`:
  - `{ id: "/calendar", label: "Calendar", surface: "route", disposition: { kind: "guide", slug: "tasks-agenda-journals-and-board" } }`
  - `{ id: "nav.calendar", label: "Open Calendar", surface: "command", disposition: { kind: "guide", slug: "tasks-agenda-journals-and-board" } }`

**Failing tests first** (edit these expectations first; they fail until the code lands)

- `routes/__tests__/routeViews.test.ts`: add `"/calendar": "calendar"` to `OWN_CODEX_VIEW_BY_ROUTE_ID`.
- `components/codex/viewRegistry.test.ts:84-96`: Organise becomes `["constellation","gazetteer","calendar","tasking","bases"]`. Add `goToView("calendar", d)` → `navigate({ to: "/calendar" })`.
- `components/codex/ContentsMenu.test.tsx:73`: the same Organise order.
- `components/codex/__tests__/CommandPalette.test.tsx`: `opens the Calendar with the keyboard`. Type "Open Calendar{Enter}" and expect `navigateMock` called with `{ to: "/calendar" }`.
- `docs/featureInventory.test.ts`: passes once both inventory entries exist. No edit is needed; it is the gate.

**Verify**

`cd ui && bun run test src/routes src/components/codex/viewRegistry.test.ts src/components/codex/ContentsMenu.test.tsx src/components/codex/__tests__/CommandPalette.test.tsx src/docs && bun run typecheck`

`routeTree.gen.ts` regenerates on the vitest run. Include it in the change set unformatted.

---

## C7 — Calendar screen (depends on B3, C1, C2, C3, C4, C6)

**Files**

- `ui/src/routes/calendar.tsx`: replace the stub
- new `ui/src/components/calendar/CalendarScreen.tsx`
- new `ui/src/components/calendar/WeekRows.tsx`
- new `ui/src/components/calendar/__tests__/CalendarScreen.test.tsx`
- new `ui/src/components/calendar/__tests__/WeekRows.test.tsx`
- new `ui/src/routes/-calendar.test.tsx`, following `routes/-agenda.test.tsx`

**Route**

- `CalendarPage` reads `Route.useSearch()`. From it, `parseCalendarView` gives the view and `parseFilterSearch(search, CALENDAR_FILTER_URL)` gives the filters.
- It navigates with `mergeFilterSearch` plus the view fields. Use `replace: shouldReplaceFilterHistory(...)` for filter changes, `replace: true` for month paging and `day` selection, and push for mode changes.
- It renders `CalendarScreen` with plain props, so the screen is testable without the router. Agenda's `AgendaScreen` split is the model.

**`CalendarScreen` props:** `{ view, filterState, onViewChange(patch), onFilterChange(next) }`

- Header: `h1` "Calendar" (the serif display style from `AgendaScreen`), then a `FilterBar`:
  - fields: kind (multi, options `sortKindsByLabel(KINDS)` with `kindDisplayLabel`), tag (single, options from `useTags()`), project (single, `useProjectValues()`);
  - `showText={false}`;
  - `primaryFieldIds={["kind","tag","project"]}`.
- A `SegmentedControl` for Month / Months / Weeks. When the mode is months or weeks, a span `SegmentedControl` (3/6/12 or 1/2/4).
- `anchor = view.date ?? today`, and `range = rangeForView({ mode, anchor, span })`.
- `useCalendarEntries({ range, kinds: facets.kind, tag: facets.tag?.[0], project: facets.project?.[0] })`.
- `byDay = bucketEntries(entries, rangeKeys(range))`.
- Month and Months modes render `MonthCalendar variant="page" months={mode === "months" ? span : 1}`.
- Weeks mode renders `WeekRows`.
- A "Showing the first 5000 pages" notice appears when `truncated`.
- Loading uses `role="status"` and errors use `role="alert"`, both copied from Agenda.
- The side panel (desktop: a right column; mobile: a `Sheet` from `components/ui/sheet.tsx`) shows `DayNotesList` for `view.day`. Day activation sets `day`. The close button clears it.
- `useFooterContext` is optional. It could show the entry count for the range.

**`WeekRows` props:** `{ rows: WeekRow[]; byDay; today; activeDate; onDayActivate }`

- One `<section aria-label="Week 40, 2026">` per row, holding 7 day columns (a responsive grid that stacks on narrow widths).
- Each day shows a header button with the weekday, the date and the count. The button opens the side panel.
- Below the header, the titles as `CLink`s, each with a kind-colour dot (`aria-hidden`) and `KIND_META` colour text or a dot.
- Today gets a ring.

**Failing tests first**

- `CalendarScreen.test.tsx`: mock `#/api/calendar`, `#/api/index` (`useTags`), `#/lib/useProjects` and `#/hooks/useOpenJournalForDate`. Use fake time 2026-09-30.
  1. `month mode queries the anchor month's grid range with server-side filters`: `filterState.facets = { kind: ["NOTE"], tag: ["wine"] }`. The hook is called with `range` equal to `monthGridRange(2026, 8)`, `kinds ["NOTE"]` and `tag "wine"`.
  2. `shows a count per day`: the cell for the 15th contains "3".
  3. `switching mode calls onViewChange({ mode: "months", span: 3 })`, and `months mode renders three grids`.
  4. `weeks mode renders week sections with inline titles`: `getByRole("region", { name: "Week 40, 2026" })` contains a link titled "Tasting Beer".
  5. `clicking a day calls onViewChange({ day })`, and `a day in view.day opens the side panel listing that day's notes`.
  6. `paging months calls onViewChange with the new anchor date`.
  7. `shows the truncation notice when truncated`.
  8. `filter chips call onFilterChange`: FilterBar is already tested, so assert a single wiring case.
- `-calendar.test.tsx`: the route's `validateSearch` canonicalises `?mode=weeks&kind=note`, giving `{ mode: "weeks", span: 2, kind: ["NOTE"] }`. `staticData.codexView === "calendar"`.
- `WeekRows.test.tsx`: renders 7 day columns per row, today has `data-today`, and each title link has its path.

**Verify**

`cd ui && bun run test src/components/calendar src/routes && bun run typecheck`

---

## D1 — docs (depends on C5, C7)

**Files**

- `ui/src/docs/content/tasks-agenda-journals-and-board.mdx`: a new `### Browse the Calendar` under `## Workflow`, after "Open and capture into journals"
- `api-reference.mdx`: already edited in A2 and A3

**Content**, in Simple Technical English:

- The placement rule: journals go by date, other pages by `created_at` in your local time zone, and pages without `created_at` are not shown.
- The rail section: the kind menu, collapse, the popover, and "Open journal". Say whether it creates the journal, per Q1.
- The `/calendar` screen:
  - the modes and spans;
  - the filters and the URL parameters `mode`, `date`, `span`, `day`, `kind`, `tag` and `project`;
  - the 5000 cap.
- The Contents location (Organise) and the palette command "Open Calendar".

**Test first.** `docs/mdx-smoke.test.tsx` and `src/__tests__/primitivesGuard.test.ts` also walk `.mdx` files: no caps and no mono outside code. Run them.

**Verify**

`cd ui && bun run test src/docs src/__tests__/primitivesGuard.test.ts`

---

## G — final gates (last; report each result explicitly)

```bash
cd /Users/kit/Source/_p.pkm/clepsydra/.worktrees/calendar-view
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings      # CI's exact invocation (.github/workflows/ci.yml:96)
cargo test -p clep-index -p clep-api                    # check exit status; don't trust piped output
cd ui && bun run typecheck && bun run lint && bun run test
cd ui && bun run knip                                   # new @internationalized/date dep + new modules must be used
```

Before handing back:

- `git status`: only the files named above, plus `ui/src/routeTree.gen.ts`, `ui/src/api/schema.d.ts`, `ui/package.json` and `ui/bun.lock`.
- `bunx biome format --write` only on new or edited `ui/src` files, never on the generated two.
- No commit. The orchestrator reviews and commits.
