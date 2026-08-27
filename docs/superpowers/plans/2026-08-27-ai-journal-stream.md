# AI Journal Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AI assistants their own daily journal stream (a new `AI_JOURNAL` Kind with full UI parity) so the human journal holds only what the human wrote or explicitly asked to have written.

**Architecture:** A new `Kind::AiJournal` shares the indexed `journal_date` column with the human journal; every journal query becomes kind-discriminated. The existing journal API machinery in `src/api/journal.rs` is parameterized over a `JournalStream` (kind + folder) and a mirrored API lands at `/api/vault/ai-journal`. A new MCP tool `vault_ai_journal_capture` carries agent notes; `vault_journal_capture` keeps its behavior but its contract is re-scoped to explicit user requests. The UI parameterizes `JournalMeta` over a stream spec and registers the new kind with full parity surfaces.

**Tech Stack:** Rust (Axum 0.8, rusqlite, utoipa, rmcp), React 19 + TanStack Query, Vitest, cargo test with axum-test.

**Spec:** `docs/superpowers/specs/2026-08-27-ai-journal-stream-design.md`

## Global Constraints

- Wire values, verbatim everywhere: enum `Kind::AiJournal`, token `AI_JOURNAL`, folder `ai-journals` (synonyms `ai-journals`, `ai-journal`), computed tag `ai_journal`, API mount `/api/vault/ai-journal`, MCP tool `vault_ai_journal_capture`, UI label `AI JOURNAL`.
- `author` validation: optional; when present it must be a single line of 1–64 Unicode scalars after trimming (no control characters); anything else is a 400.
- The repo is NOT fmt/lint clean. NEVER run repo-wide `cargo fmt` or `biome check --write`. Format only files you touched: `rustfmt <file>` / `cd ui && bunx biome format --write <file>`.
- `bun --cwd ui run X` is broken — always `cd ui && bun run X`.
- In a fresh worktree, `cargo test` fails until `ui/dist` exists (rust-embed): run `cd ui && bun install && bun run build` once first. Never pipe cargo output through anything that hides failures.
- Server-created journal pages carry NO `type =` frontmatter — kind is inferred from the folder. Keep this for AI journal pages.
- Work on branch `feature/ai-journal-stream` off `develop`. One commit per task, message prefixes as given.
- Each task's final step: run `cargo test --test <touched test file>` (or `cd ui && bun run test <file>`) plus `cargo clippy --all-targets` / `cd ui && bun run typecheck` for the touched half of the repo, and report the output.

---

### Task 1: `Kind::AiJournal` domain variant

**Files:**
- Modify: `src/vault/kind.rs`
- Modify: `tests/openapi_contract.rs`

**Interfaces:**
- Produces: `Kind::AiJournal` with `as_str() == "AI_JOURNAL"`, `canonical_folder() == "ai-journals"`, `computed_tag() == "ai_journal"`, `from_token("AI_JOURNAL")`, `from_folder("ai-journals" | "ai-journal")`. Every later task consumes these.

- [ ] **Step 1: Write the failing tests**

In `src/vault/kind.rs` `mod tests`, add:

```rust
#[test]
fn ai_journal_kind_round_trips() {
    assert_eq!(Kind::AiJournal.as_str(), "AI_JOURNAL");
    assert_eq!(Kind::from_token("AI_JOURNAL"), Some(Kind::AiJournal));
    assert_eq!(Kind::from_token("ai_journal"), Some(Kind::AiJournal));
    assert_eq!(Kind::AiJournal.canonical_folder(), "ai-journals");
    assert_eq!(Kind::AiJournal.computed_tag(), "ai_journal");
    for folder in ["ai-journals", "ai-journal"] {
        assert_eq!(
            resolve(&format!("{folder}/x.md"), None),
            (Kind::AiJournal, true),
            "folder {folder:?} should infer AI_JOURNAL"
        );
    }
    // The plain journal folders must NOT infer the AI kind.
    assert_eq!(resolve("journals/x.md", None), (Kind::Journal, true));
    assert_eq!(
        serde_json::to_string(&Kind::AiJournal).unwrap(),
        "\"AI_JOURNAL\""
    );
    let decoded: Kind = serde_json::from_str("\"AI_JOURNAL\"").unwrap();
    assert_eq!(decoded, Kind::AiJournal);
}
```

Also extend the existing enumerating tests (they will otherwise silently under-cover):
- `as_str_and_from_token_are_symmetric`: add `Kind::AiJournal` to the `all` array.
- `computed_tags_are_canonical_lowercase_kind_tokens`: add `(Kind::AiJournal, "ai_journal")` to `expected`.

In `tests/openapi_contract.rs`, next to `openapi_kind_enum_contains_meeting_kinds` (line ~311), add:

```rust
#[test]
fn openapi_kind_enum_contains_ai_journal() {
    let document = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI should serialize");
    let kinds = document["components"]["schemas"]["Kind"]["enum"]
        .as_array()
        .expect("Kind should be a string enum");
    assert!(kinds.contains(&serde_json::json!("AI_JOURNAL")));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test ai_journal_kind_round_trips` and `cargo test --test openapi_contract openapi_kind_enum_contains_ai_journal`
Expected: FAIL — no variant `AiJournal`.

- [ ] **Step 3: Add the variant and its five arms**

In `src/vault/kind.rs`:

1. Enum (after `AiConversation`, line ~35):
```rust
    #[schema(rename = "AI_JOURNAL")]
    AiJournal,
```
2. `canonical_folder()`: `Kind::AiJournal => "ai-journals",`
3. `computed_tag()`: `Kind::AiJournal => "ai_journal",`
4. `as_str()`: `Kind::AiJournal => "AI_JOURNAL",`
5. `from_token()`: `"AI_JOURNAL" => Some(Kind::AiJournal),`
6. `from_folder()`: `"ai-journals" | "ai-journal" => Some(Kind::AiJournal),`

The Rust `Kind` enum has exhaustive matches elsewhere; run `cargo build` and fill in any compiler-reported missing arms mechanically (there should be none beyond these — the codebase uses wildcard defaults elsewhere).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib vault::kind` then `cargo test --test openapi_contract`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/kind.rs tests/openapi_contract.rs
git commit -m "feat(vault): add the AI_JOURNAL kind"
```

---

### Task 2: `extract_journal_date` accepts `ai-journals/`

**Files:**
- Modify: `src/vault/index.rs:2146-2177` (`extract_journal_date`)
- Test: `tests/journal_index_test.rs`

**Interfaces:**
- Produces: `pages.journal_date` populated for `ai-journals/…` paths (legacy `ai-journals/YYYY-MM-DD.md` and canonical `ai-journals/<yyyymmdd>.<YYYY-MM-DD>.<shortid>.md`), still only at top level.

- [ ] **Step 1: Write the failing tests**

Read the top of `tests/journal_index_test.rs` for its vault-fixture harness (it writes files into a temp vault and builds the index), then add tests using the same helpers:

```rust
#[test]
fn ai_journal_pages_get_a_journal_date() {
    // same setup pattern as the existing journal_date tests in this file
    // write: "ai-journals/2026-08-27.md" (legacy shape)
    // write: "ai-journals/20260827.2026-08-27.Ab12Cd34.md" (canonical shape)
    // build index, then assert both rows have journal_date = "2026-08-27"
}

#[test]
fn nested_ai_journals_folder_is_not_a_journal() {
    // write: "other/ai-journals/2026-08-27.md"
    // build index, assert journal_date IS NULL for that row
}
```

Replace the comment lines with real code copied from this file's existing `journal_date` tests (see the test asserting `other/journals/…` is rejected, around line 85) — same helpers, new paths.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --test journal_index_test`
Expected: the two new tests FAIL (journal_date is NULL for ai-journals paths).

- [ ] **Step 3: Extend the prefix match**

In `src/vault/index.rs` `extract_journal_date`, change the first line and the doc comment:

```rust
/// Extract a journal date from a `journals/` or `ai-journals/` path, in
/// either the legacy `<prefix>/YYYY-MM-DD.md` or the canonical
/// `<prefix>/<yyyymmdd>.YYYY-MM-DD.<shortid>.md` shape.
///
/// Returns `Some("YYYY-MM-DD")` if the path matches, `None` otherwise.
/// Only matches the top-level prefix — e.g. `other/journals/2026-02-17.md`
/// is rejected.
fn extract_journal_date(path: &str) -> Option<String> {
    let filename = path
        .strip_prefix("journals/")
        .or_else(|| path.strip_prefix("ai-journals/"))?;
    // …rest unchanged…
```

(`strip_prefix("journals/")` cannot match an `ai-journals/…` path — prefixes anchor at the start — so the order is safe. A nested `other/ai-journals/…` fails both prefixes; a subfolder like `ai-journals/x/y.md` leaves a `/` in `filename`, which fails `is_canonical_page_filename` and the 10-char check, exactly as today.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --test journal_index_test`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/index.rs tests/journal_index_test.rs
git commit -m "feat(index): derive journal_date for ai-journals paths"
```

---

### Task 3: Stream-parameterized journal machinery; human queries gain kind predicates

**Files:**
- Modify: `src/api/journal.rs`
- Test: `tests/api_journal_test.rs`

**Interfaces:**
- Consumes: `Kind::AiJournal` (Task 1), ai-journals `journal_date` derivation (Task 2).
- Produces (all `pub(crate)` in `src/api/journal.rs`, consumed by Task 4):
  - `struct JournalStream { kind: Kind, folder: &'static str }`
  - `const HUMAN_JOURNAL: JournalStream` and `const AI_JOURNAL: JournalStream`
  - `async fn find_journal_path(state: &Arc<AppState>, stream: JournalStream, date: &str) -> Result<Option<VaultPath>, ApiError>`
  - `async fn ensure_journal(state: &Arc<AppState>, stream: JournalStream, date: &str) -> Result<(VaultPath, bool), ApiError>`
  - `async fn capture_into(state: &Arc<AppState>, stream: JournalStream, entry: &str) -> Result<PageDetail, ApiError>` — appends an ALREADY-FORMATTED entry line/block
  - `async fn journal_summaries(state: &Arc<AppState>, stream: JournalStream, from: &str, to: &str) -> Result<Vec<JournalSummary>, ApiError>`
  - `fn is_block_construct(line: &str) -> bool`
  - `struct JournalSummary` (already public in-module)

- [ ] **Step 1: Write the failing isolation tests**

Read the harness at the top of `tests/api_journal_test.rs` (temp vault + axum-test server), then add, using the same helpers:

```rust
#[tokio::test]
async fn human_journal_queries_never_see_ai_journal_pages() {
    // setup: server with temp vault, fixed clock (same as existing tests here)
    // write a file directly: "ai-journals/<today>.md" with body "- ai note"
    //   (or via fs + reindex, matching how this file seeds pages)
    // GET /api/vault/journal/today            -> 404 (no HUMAN page exists)
    // GET /api/vault/journal/recent?days=7    -> [] (AI page excluded)
    // GET /api/vault/journal/range?from=<today>&to=<today> -> []
    // POST /api/vault/journal/today           -> 201, path starts with "journals/"
    //   (the pre-existing AI page for the same date must NOT satisfy ensure)
}

#[tokio::test]
async fn carried_forward_excludes_ai_journal_todos() {
    // seed a HUMAN journal for today (POST /journal/today)
    // seed an AI journal page dated yesterday containing "- [ ] agent todo"
    // GET /api/vault/journal/today -> carried_forward is empty
}
```

Replace comments with real code following this file's existing patterns.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --test api_journal_test`
Expected: the two new tests FAIL — `find_journal_path` has no kind predicate, so the AI page satisfies today/recent/range, and carried-forward picks up the AI todo.

- [ ] **Step 3: Parameterize the machinery**

In `src/api/journal.rs`:

1. Add near the top (after the request types):

```rust
use crate::vault::kind::Kind;

/// A dated journal stream: the human journal or the AI-assistant journal.
/// Both share the indexed `journal_date` column; the kind discriminates.
#[derive(Clone, Copy)]
pub(crate) struct JournalStream {
    pub kind: Kind,
    pub folder: &'static str,
}

pub(crate) const HUMAN_JOURNAL: JournalStream = JournalStream {
    kind: Kind::Journal,
    folder: "journals",
};

pub(crate) const AI_JOURNAL: JournalStream = JournalStream {
    kind: Kind::AiJournal,
    folder: "ai-journals",
};
```

2. `find_journal_path` gains the stream parameter and predicate:

```rust
pub(crate) async fn find_journal_path(
    state: &Arc<AppState>,
    stream: JournalStream,
    date: &str,
) -> Result<Option<VaultPath>, ApiError> {
    let date = date.to_string();
    let kind = stream.kind.as_str();
    let path = state
        .index
        .with_index(move |index, _vault| {
            index
                .connection()
                .query_row(
                    "SELECT path FROM pages WHERE journal_date = ?1 AND kind = ?2 \
                     ORDER BY path LIMIT 1",
                    params![date, kind],
                    |row| row.get::<_, String>(0),
                )
                .optional()
        })
        // …error mapping unchanged…
```

3. `new_journal_path` takes the stream: `VaultPath::new(&format!("{}/{filename}", stream.folder))`.

4. `ensure_journal(state, stream, date)` passes the stream through to both helpers. The `JOURNAL_ENSURE_LOCK` stays shared by both streams (correct and simplest). The page template is unchanged — no declared kind, title = date.

5. Extract the capture append into a shared function; `capture_today` formats then delegates:

```rust
/// Append an already-formatted entry to today's page of `stream`,
/// creating the page if absent. 409 when the page is encrypted.
pub(crate) async fn capture_into(
    state: &Arc<AppState>,
    stream: JournalStream,
    entry: &str,
) -> Result<PageDetail, ApiError> {
    let now = state.clock.now();
    let date = now.format("%Y-%m-%d").to_string();
    let (vault_path, _created) = ensure_journal(state, stream, &date).await?;
    // …the existing body of capture_today from `let abs_path =` through
    // `.map_err(crate::api::mutation_error)?;`, unchanged, but appending
    // `entry` instead of `format_capture_entry(now, &req.content)`…
    Ok(page_detail(result))
}
```

`capture_today` becomes:

```rust
pub async fn capture_today(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CaptureRequest>,
) -> Result<Response, ApiError> {
    let entry = format_capture_entry(state.clock.now(), &req.content);
    let detail = capture_into(&state, HUMAN_JOURNAL, &entry).await?;
    Ok((StatusCode::OK, Json(detail)).into_response())
}
```

6. Extract the shared range/recent SQL:

```rust
pub(crate) async fn journal_summaries(
    state: &Arc<AppState>,
    stream: JournalStream,
    from: &str,
    to: &str,
) -> Result<Vec<JournalSummary>, ApiError> {
    // the existing get_range query body, with the SQL now:
    // "SELECT id, path, title, journal_date FROM pages \
    //  WHERE journal_date IS NOT NULL \
    //    AND kind = ?3 \
    //    AND journal_date >= ?1 AND journal_date <= ?2 \
    //  ORDER BY journal_date DESC"
    // params![from, to, stream.kind.as_str()]
}
```

`get_range` and `get_recent` call it with `HUMAN_JOURNAL` (recent computes from/to first, as today).

7. Carried-forward SQL in `get_today` (line ~232): after `WHERE p.journal_date IS NOT NULL` add `AND p.kind = 'JOURNAL'`.

8. `get_today`, `ensure_today`, `get_by_date` pass `HUMAN_JOURNAL` to `find_journal_path`/`ensure_journal`.

9. Make `is_block_construct` `pub(crate)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --test api_journal_test && cargo test --test e2e_tasks_journal_test`
Expected: PASS — new isolation tests and all pre-existing journal tests.

- [ ] **Step 5: Commit**

```bash
git add src/api/journal.rs tests/api_journal_test.rs
git commit -m "feat(api): kind-discriminate journal queries behind JournalStream"
```

---

### Task 4: AI journal API at `/api/vault/ai-journal`

**Files:**
- Create: `src/api/ai_journal.rs`
- Modify: `src/api/mod.rs` (module decl + `.nest("/ai-journal", ai_journal::router())` beside the `/journal` nest at line ~208)
- Modify: `src/api/openapi.rs` (register the five new handler paths beside the `journal::` entries)
- Modify: `ui/src/docs/content/tasks-agenda-journals-and-board.mdx` (only if `docs_api_coverage_test` demands endpoint coverage — see Step 5)
- Test: create `tests/api_ai_journal_test.rs`

**Interfaces:**
- Consumes: everything Task 3 produces.
- Produces routes: `GET|POST /api/vault/ai-journal/today`, `POST /api/vault/ai-journal/today/capture` (body `{ content: String, author?: String }`), `GET /api/vault/ai-journal/{date}`, `GET /api/vault/ai-journal/range?from&to`, `GET /api/vault/ai-journal/recent?days`. Today/date responses are plain `PageDetailResponse` (NO `carried_forward`). Capture returns the updated `PageDetailResponse`.

- [ ] **Step 1: Write the failing tests**

Create `tests/api_ai_journal_test.rs` mirroring the harness of `tests/api_journal_test.rs`. Cover:

```rust
// 1. ensure_is_idempotent_and_lands_in_ai_journals:
//    POST /ai-journal/today -> 201, path starts "ai-journals/", title = date;
//    POST again -> 200 same path.
// 2. get_today_404s_when_absent (and ignores an existing HUMAN journal for
//    the same date — seed one via POST /journal/today first).
// 3. capture_formats_prose_with_author:
//    POST /ai-journal/today/capture {"content":"did a thing","author":"claude-code"}
//    -> body contains "— [claude-code] did a thing" prefixed "- HH:MM"
//    (use the fixed test clock to assert the exact line).
// 4. capture_without_author_matches_human_shape:
//    content "plain note" -> "- HH:MM — plain note".
// 5. capture_block_construct_passes_verbatim_unattributed:
//    content "- [ ] a task" with author -> body gains exactly "- [ ] a task".
// 6. capture_rejects_bad_author: for author "" , "  ", "a\nb", "x".repeat(65)
//    -> 400 each; page not created/changed.
// 7. capture_409_on_encrypted_page: seed an encrypted ai-journal page for
//    today (copy the encrypted-fixture pattern from api_journal_test.rs's
//    protected-journal test) -> 409.
// 8. range_and_recent_see_only_ai_pages: seed one HUMAN journal and one AI
//    journal today; /ai-journal/recent?days=7 returns only the ai-journals/
//    path; /ai-journal/range likewise; and /journal/recent still returns
//    only the human page (regression lock on both directions).
// 9. get_by_date_validates_format: GET /ai-journal/2026-13-99 -> 400.
```

Write each as a real `#[tokio::test]` using the harness's request helpers.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --test api_ai_journal_test`
Expected: FAIL — 404s everywhere (routes don't exist).

- [ ] **Step 3: Implement the module**

Create `src/api/ai_journal.rs`:

```rust
//! The AI-assistant journal stream: a daily journal for agent-initiated
//! notes, kept apart from the user's own journal. Same machinery, different
//! `JournalStream`; no carried-forward todos, optional per-entry attribution.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Router, http::StatusCode};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;
use super::journal::{
    AI_JOURNAL, JournalSummary, RangeQuery, RecentQuery, capture_into, ensure_journal,
    find_journal_path, is_block_construct, journal_summaries, parse_date,
};
use super::pages::{PageDetail, page_detail};
use crate::vault::page::Page;

#[derive(Debug, Deserialize, ToSchema)]
pub struct AiCaptureRequest {
    pub content: String,
    /// Short label naming the writing agent (e.g. `claude-code`), rendered
    /// as an entry prefix. Single line, 1-64 characters.
    pub author: Option<String>,
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/today", get(get_today).post(ensure_today))
        .route("/today/capture", post(capture_today))
        .route("/range", get(get_range))
        .route("/recent", get(get_recent))
        .route("/{date}", get(get_by_date))
}

/// Trimmed author label, or a 400 when present but not a single line of
/// 1-64 Unicode scalars.
fn validate_author(author: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(raw) = author else { return Ok(None) };
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > 64
        || trimmed.chars().any(char::is_control)
    {
        return Err(ApiError::bad_request(
            "author must be a single line of 1-64 characters",
        ));
    }
    Ok(Some(trimmed.to_string()))
}

/// `- HH:MM — [author] content` for plain prose; block constructs pass
/// through verbatim and unattributed, exactly as human captures do.
fn format_ai_capture_entry(
    now: DateTime<Utc>,
    content: &str,
    author: Option<&str>,
) -> String {
    let first_line = content.lines().next().unwrap_or("").trim_start();
    if is_block_construct(first_line) {
        return content.to_string();
    }
    match author {
        Some(author) => format!("- {} — [{author}] {content}", now.format("%H:%M")),
        None => format!("- {} — {}", now.format("%H:%M"), content),
    }
}
```

Then the five handlers, each a lean mirror of its `journal.rs` counterpart with `AI_JOURNAL` and NO carried-forward query:

- `get_today`: `find_journal_path(&state, AI_JOURNAL, &date)` → 404 `"AI journal not found: {date}"` → `Page::from_file` → `Json(page_detail(page))`. utoipa: `path = "/ai-journal/today"`, `context_path = "/api/vault"`, `tag = "AI Journal"`, responses 200 `PageDetailResponse` / 404 / 500 `ApiError`.
- `ensure_today`: `ensure_journal(&state, AI_JOURNAL, &date)` → 201/200 with `page_detail`.
- `capture_today`: validate author, format entry, `capture_into(&state, AI_JOURNAL, &entry)` → 200. Responses: 200 / 400 (author) / 409 (protected) / 500.
- `get_by_date`: reuse `journal::parse_date` (make it `pub(crate)` in journal.rs) then find/read as `get_today`.
- `get_range` / `get_recent`: parse/compute dates exactly as journal.rs does, then `journal_summaries(&state, AI_JOURNAL, &from, &to)`.

Make the Task 3 items this module imports `pub(crate)` in `journal.rs` (including `RangeQuery`, `RecentQuery`, `parse_date` if reused). In `src/api/mod.rs`: add `pub mod ai_journal;` and `.nest("/ai-journal", ai_journal::router())`. In `src/api/openapi.rs`: add the five `ai_journal::*` handlers to the `paths(...)` list beside the `journal::*` entries, and `ai_journal::AiCaptureRequest` to the schemas list if request bodies are enumerated there (follow how `journal::CaptureRequest` is registered).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --test api_ai_journal_test && cargo test --test api_journal_test && cargo test --test openapi_contract`
Expected: PASS.

- [ ] **Step 5: Docs coverage gate**

Run: `cargo test --test docs_api_coverage_test`
If it fails on the new operations, open the failure message, and add the five `/ai-journal` endpoints to `ui/src/docs/content/tasks-agenda-journals-and-board.mdx` in the same list/format the `/journal` endpoints use there (grep the MDX for `journal/today` to find the section). Re-run until green.

- [ ] **Step 6: Commit**

```bash
git add src/api/ai_journal.rs src/api/mod.rs src/api/openapi.rs src/api/journal.rs tests/api_ai_journal_test.rs ui/src/docs/content/tasks-agenda-journals-and-board.mdx
git commit -m "feat(api): AI journal endpoints at /api/vault/ai-journal"
```

---

### Task 5: Kind lock and project rejection for journal kinds

**Files:**
- Modify: `src/api/pages.rs` (`validate_kind_assignment` line ~1453, `assign_page` line ~1487, `plan_bulk_assignment` line ~1599)
- Test: `tests/api_pages.rs`

**Interfaces:**
- Consumes: `Kind::AiJournal`.
- Produces: 400 `"AI journal kind cannot be changed"` on reassigning away from AI_JOURNAL; 400 `"journal pages cannot join a project"` on setting a project for a JOURNAL or AI_JOURNAL page (single and bulk). `clear_project` stays allowed on both.

- [ ] **Step 1: Write the failing tests**

In `tests/api_pages.rs`, find the existing assign tests (grep `assign`), and add using the same harness:

```rust
// 1. ai_journal_kind_cannot_be_changed:
//    create "ai-journals/2026-08-27.md" (kind inferred), POST pages-assign
//    with {"kind":"NOTE"} -> 400 "AI journal kind cannot be changed".
// 2. journal_pages_reject_project_assignment:
//    for a journals/ page and an ai-journals/ page:
//    POST pages-assign {"project":"clepsydra"} -> 400
//    "journal pages cannot join a project"; file has NOT moved.
// 3. journal_pages_accept_clear_project:
//    POST pages-assign {"clear_project": true} on a journal page -> 200.
// 4. bulk_assign_rejects_project_on_journal_pages:
//    bulk assign of [note page, journal page] with a project -> the whole
//    batch errors 400 and neither page changed (bulk is atomic).
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --test api_pages`
Expected: the new tests FAIL (assignments currently succeed — test 2 is the latent data-loss bug: the journal page relocates to `journals/<project>/…` and drops out of every journal query).

- [ ] **Step 3: Implement the rules**

In `src/api/pages.rs`:

1. Extend `validate_kind_assignment` (after the JOURNAL guard):

```rust
    if current_kind == Kind::AiJournal && requested_kind != Kind::AiJournal {
        return Err(ApiError::bad_request("AI journal kind cannot be changed"));
    }
```

2. Add beside it:

```rust
/// Journal pages are dateline streams keyed by their top-level folder;
/// projecting one into `journals/<project>/…` would null its journal_date
/// and silently drop it from every journal query.
fn validate_project_assignment(path: &VaultPath, meta: &PageMeta) -> Result<(), ApiError> {
    let (kind, _) = resolve(path.as_str(), meta.kind);
    if matches!(kind, Kind::Journal | Kind::AiJournal) {
        return Err(ApiError::bad_request("journal pages cannot join a project"));
    }
    Ok(())
}
```

3. In `assign_page`, inside the `else if let Some(project) = &body.project` branch (line ~1517), before `validate_project_slug`: `validate_project_assignment(&vp, &page.meta)?;` (call it AFTER the kind branch has updated `page.meta.kind`, which the current statement order already guarantees).

4. In `plan_bulk_assignment`, inside the first per-path loop (line ~1621), after the `validate_kind_assignment` call, add:

```rust
        if body.project.is_some() && !body.clear_project {
            let mut effective = meta.clone();
            if let Some(kind) = assigned_kind {
                effective.kind = Some(kind);
            }
            validate_project_assignment(&path, &effective)?;
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --test api_pages && cargo test --test batch_mutation_test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/pages.rs tests/api_pages.rs
git commit -m "feat(api): lock AI_JOURNAL kind; reject projects on journal pages"
```

---

### Task 6: Agenda excludes the AI journal

**Files:**
- Modify: `src/api/agenda.rs` (SQL at lines ~479-503)
- Test: `tests/api_agenda_test.rs`

**Interfaces:**
- Consumes: AI journal pages with `journal_date` set (Tasks 2-4).
- Produces: no todo inside an AI_JOURNAL page appears in any Agenda bucket; a human journal-dated todo still classifies as Today.

- [ ] **Step 1: Write the failing test**

In `tests/api_agenda_test.rs`, using its harness:

```rust
// ai_journal_todos_never_reach_the_agenda:
//   seed an AI journal page for today containing "- [ ] agent chore" and
//   another AI page dated yesterday containing "- [ ] undated agent item";
//   seed a human journal for today containing "- [ ] human item".
//   GET the agenda for today ->
//     "human item" classified Today;
//     neither agent item appears in overdue/today/upcoming/undated.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --test api_agenda_test`
Expected: FAIL — agent items leak in via `p.journal_date = ?1` and `bp_due.value IS NULL`.

- [ ] **Step 3: Amend the SQL**

In the agenda todo query (line ~479):

1. SELECT list: replace `p.journal_date` with
   `CASE WHEN p.kind = 'JOURNAL' THEN p.journal_date ELSE NULL END AS journal_date`
   (so the Today classification at line ~629 never sees an AI date).
2. WHERE clause: change `OR p.journal_date = ?1` to
   `OR (p.journal_date = ?1 AND p.kind = 'JOURNAL')`.
3. Append to the outer WHERE (after the closing paren of the OR group):
   `AND p.kind != 'AI_JOURNAL'`
   (this keeps AI-journal todos out of the undated bucket too).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --test api_agenda_test`
Expected: PASS, all pre-existing agenda tests included.

- [ ] **Step 5: Commit**

```bash
git add src/api/agenda.rs tests/api_agenda_test.rs
git commit -m "feat(agenda): exclude AI journal todos"
```

---

### Task 7: MCP — `vault_ai_journal_capture` and the re-scoped capture contract

**Files:**
- Modify: `src/mcp/server.rs`

**Interfaces:**
- Consumes: `POST /api/vault/ai-journal/today/capture` (Task 4).
- Produces: MCP tool `vault_ai_journal_capture { content, author? }`; updated `vault_journal_capture` description; updated `MCP_INSTRUCTIONS` and `KIND_TOKENS`.

- [ ] **Step 1: Write the failing tests**

In `src/mcp/server.rs` `mod tests`:

1. Add `"vault_ai_journal_capture"` to the sorted array in `mcp_tool_inventory_exposes_the_archive_rubbish_lifecycle` (line ~1661) — it sorts immediately BEFORE `"vault_append_page"`.
2. Mirror the existing `vault_journal_capture` round-trip test (line ~2702) as `ai_journal_capture_posts_to_the_ai_endpoint`, asserting the request lands on `/api/vault/ai-journal/today/capture` with `{"content": "...", "author": "claude-code"}` passed through.
3. Beside the description-assertion tests around lines 1516-1566, add:

```rust
    #[test]
    fn capture_tools_state_the_split_journal_contract() {
        let tools = VaultMcpServer::tool_router().list_all();
        let description = |name: &str| {
            tools
                .iter()
                .find(|tool| tool.name == name)
                .unwrap_or_else(|| panic!("{name} should be registered"))
                .description
                .clone()
                .unwrap_or_default()
        };
        let human = description("vault_journal_capture");
        for required in ["user's own journal", "explicitly asks", "vault_ai_journal_capture"] {
            assert!(human.contains(required), "human capture contract missing {required:?}: {human}");
        }
        let ai = description("vault_ai_journal_capture");
        for required in ["agent-initiated", "never writes to the user's own journal", "author"] {
            assert!(ai.contains(required), "ai capture contract missing {required:?}: {ai}");
        }
        assert!(MCP_INSTRUCTIONS.contains("vault_ai_journal_capture"));
        assert!(KIND_TOKENS.contains("AI_JOURNAL"));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib mcp`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Implement**

1. Params struct beside `JournalCaptureParams` (line ~261):

```rust
#[derive(Debug, Deserialize, JsonSchema)]
pub struct AiJournalCaptureParams {
    /// Markdown to append to today's AI journal page (created if absent).
    pub content: String,
    /// Optional short label naming the writing agent (e.g. `claude-code`),
    /// rendered as an entry prefix. Single line, 1-64 characters.
    pub author: Option<String>,
}
```

2. Tool beside `vault_journal_capture` (line ~875):

```rust
    #[tool(
        name = "vault_ai_journal_capture",
        description = "Append an agent-initiated note to today's AI journal (ai-journals/<yyyymmdd>.<YYYY-MM-DD>.<shortid>.md), creating it if needed. The default destination for assistant observations, work logs, session notes, and asides — it never writes to the user's own journal. Pass `author` (e.g. `claude-code`) to attribute the entry. Do not add `ai-generated` for an AI journal capture.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    pub async fn vault_ai_journal_capture(
        &self,
        Parameters(params): Parameters<AiJournalCaptureParams>,
    ) -> Result<String, String> {
        let mut value = self
            .client
            .post_json(
                "/api/vault/ai-journal/today/capture",
                &serde_json::json!({ "content": params.content, "author": params.author }),
            )
            .await
            .map_err(|e| e.to_string())?;
        truncate_body(&mut value, MAX_BODY_BYTES);

        render(&value)
    }
```

3. Replace `vault_journal_capture`'s description (line ~877) with:

```text
Quick-capture markdown into today's journal page (journals/<yyyymmdd>.<YYYY-MM-DD>.<shortid>.md), creating it if needed. This is the user's own journal: use it only when the user explicitly asks for a journal capture. Agent-initiated notes, work logs, and observations belong in vault_ai_journal_capture instead. Do not add `ai-generated` merely because an LLM performed the journal capture.
```

4. In `MCP_INSTRUCTIONS` (line ~180), replace the sentence
   `Use vault_journal_capture and vault_capture_conversation for those dedicated intents instead of vault_create_page.` with:
   `Use vault_journal_capture (the user's own journal, only on the user's explicit request), vault_ai_journal_capture (agent-initiated notes and work logs), and vault_capture_conversation for those dedicated intents instead of vault_create_page.`

5. `KIND_TOKENS` (line ~171): append `, AI_JOURNAL`. Update the three hand-written kind lists in doc comments: `CreatePageParams.kind` (line ~201), `AssignParams.kind` (line ~272) — append `AI_JOURNAL` to each.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib mcp`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.rs
git commit -m "feat(mcp): vault_ai_journal_capture; re-scope vault_journal_capture"
```

---

### Task 8: OpenAPI regeneration and UI kind mirrors

**Files:**
- Regenerate: `ui/src/api/schema.d.ts`
- Modify: `ui/src/lib/kind.ts`, `ui/src/lib/intake.ts`

**Interfaces:**
- Produces: `Kind` union includes `"AI_JOURNAL"`; `KINDS`, `KIND_META`, `FOLDER_KIND`, `KIND_FOLDER` complete; `schema.d.ts` carries the `/api/vault/ai-journal/*` routes for Task 9's typed hooks.

- [ ] **Step 1: Regenerate the schema**

The generator needs a running server built from THIS branch (`ui/package.json` fetches `http://localhost:3000/api/openapi.json`). Run `cargo run -- serve --help` to find the port and vault flags, then start the branch server against a scratch vault on a spare port, e.g.:

```bash
mkdir -p /tmp/clep-scratch-vault
cargo run -- serve <vault-flag> /tmp/clep-scratch-vault <port-flag> 3391 &
# wait for it to listen, then:
cd ui && bunx openapi-typescript http://localhost:3391/api/openapi.json -o src/api/schema.d.ts
# then kill the server
```

If the local dev server on :3000 is already running the old binary, do NOT restart it — use the spare port. Verify `git diff ui/src/api/schema.d.ts` shows `AI_JOURNAL` in the Kind enum and the five `/api/vault/ai-journal` paths.

- [ ] **Step 2: Run typecheck to see the mirror failures**

Run: `cd ui && bun run typecheck`
Expected: FAIL — `KINDS` exhaustiveness assertion, `KIND_META`, and `KIND_FOLDER` all miss `AI_JOURNAL`.

- [ ] **Step 3: Fill the mirrors**

`ui/src/lib/kind.ts`:
- `KINDS`: append `"AI_JOURNAL"` after `"AI_CONVERSATION"`.
- `KIND_META`: add
```ts
  // The assistants' own daily stream; deep accent separates it from the
  // human JOURNAL's cool pip at a glance.
  AI_JOURNAL: { label: "AI JOURNAL", color: "var(--accent-deep)" },
```
- `FOLDER_KIND`: add `"ai-journals": "AI_JOURNAL",` and `"ai-journal": "AI_JOURNAL",` (place BEFORE the `journals` block or after — object key order is irrelevant; exact-string keys cannot collide with `journals`).

`ui/src/lib/intake.ts` `KIND_FOLDER`: add `AI_JOURNAL: "ai-journals",`.

- [ ] **Step 4: Run typecheck to verify it passes**

Run: `cd ui && bun run typecheck && bun run test src/lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/schema.d.ts ui/src/lib/kind.ts ui/src/lib/intake.ts
git commit -m "feat(ui): AI_JOURNAL kind mirrors and regenerated schema"
```

---

### Task 9: UI journal lib and AI stream hooks

**Files:**
- Modify: `ui/src/lib/journal.ts`
- Create: `ui/src/api/aiJournal.ts`
- Modify: `ui/src/api/keys.ts`
- Test: beside `ui/src/lib/journal.ts`'s existing tests (run `ls ui/src/lib/__tests__/ 2>/dev/null; ls ui/src/lib/*.test.ts 2>/dev/null` and put the new cases in the file/location the current `journal` lib tests use; if none exist, create `ui/src/lib/__tests__/journal.test.ts` matching the repo's vitest conventions)

**Interfaces:**
- Consumes: `schema.d.ts` routes (Task 8).
- Produces:
  - `lib/journal.ts`: `aiJournalPathForDate(dateKey): string`, `todayAiJournalPath(): string`, `aiJournalDateFromPath(path): string | null`, `aiJournalDayLabel(path, title): string`; `journalDateFromPath` now ALSO matches canonical `journals/<yyyymmdd>.<date>.<shortid>.md` paths.
  - `api/aiJournal.ts`: `useAiJournalToday(enabled?)` (`PageDetailResponse | null`), `useEnsureAiJournalToday()` (returns `{ page, created }` — same `EnsureJournalResult` shape as the human hook), `useAiJournalRecent(days?)` (`JournalSummary[]`).
  - `api/keys.ts`: `queryKeys.aiJournal.{all,today,recent(days)}`.

- [ ] **Step 1: Write the failing lib tests**

```ts
import { describe, expect, it } from "vitest";
import {
  aiJournalDateFromPath,
  aiJournalPathForDate,
  journalDateFromPath,
} from "#/lib/journal";

describe("ai journal paths", () => {
  it("builds the draft path for a date", () => {
    expect(aiJournalPathForDate("2026-08-27")).toBe("ai-journals/2026-08-27.md");
  });
  it("parses legacy and canonical ai-journal paths", () => {
    expect(aiJournalDateFromPath("ai-journals/2026-08-27.md")).toBe("2026-08-27");
    expect(
      aiJournalDateFromPath("ai-journals/20260827.2026-08-27.Ab12Cd34.md"),
    ).toBe("2026-08-27");
    expect(aiJournalDateFromPath("journals/2026-08-27.md")).toBeNull();
    expect(aiJournalDateFromPath("other/ai-journals/2026-08-27.md")).toBeNull();
  });
  it("keeps the human parser off ai paths and extends it to canonical", () => {
    expect(journalDateFromPath("ai-journals/2026-08-27.md")).toBeNull();
    expect(
      journalDateFromPath("journals/20260827.2026-08-27.Ab12Cd34.md"),
    ).toBe("2026-08-27");
    expect(journalDateFromPath("journals/2026-08-27.md")).toBe("2026-08-27");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && bun run test journal`
Expected: FAIL — helpers don't exist.

- [ ] **Step 3: Implement**

`ui/src/lib/journal.ts` — replace the single-shape regex with a stream factory and add the AI helpers:

```ts
/** Matches `<prefix>/YYYY-MM-DD.md` (legacy) and
 *  `<prefix>/<yyyymmdd>.YYYY-MM-DD.<shortid>.md` (canonical). */
const streamPathRe = (prefix: string) =>
  new RegExp(
    `^${prefix}/(?:\\d{8}\\.)?(\\d{4}-\\d{2}-\\d{2})(?:\\.[A-Za-z0-9]{8})?\\.md$`,
  );
const JOURNAL_PATH_RE = streamPathRe("journals");
const AI_JOURNAL_PATH_RE = streamPathRe("ai-journals");

export function aiJournalPathForDate(dateKey: string): string {
  return `ai-journals/${dateKey}.md`;
}

/** Deterministic draft path for today's AI journal — same accepted coupling
 *  to the server vault layout as todayJournalPath. */
export function todayAiJournalPath(): string {
  return aiJournalPathForDate(localDateKey(new Date()));
}

export function aiJournalDateFromPath(path: string): string | null {
  const m = path.match(AI_JOURNAL_PATH_RE);
  return m ? m[1] : null;
}
```

Refactor `journalDayLabel` into a shared internal `dayLabel(dateKey | null, title)` and add:

```ts
export function aiJournalDayLabel(path: string, title: string): string {
  const dateKey =
    aiJournalDateFromPath(path) ?? (DATE_KEY_RE.test(title) ? title : null);
  if (!dateKey) return title;
  return parseLocalDate(dateKey).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
```

(Extract the `toLocaleDateString` block into one helper both label functions call.)

`ui/src/api/keys.ts` — beside `journal` (line ~32):

```ts
  aiJournal: {
    all: ["ai-journal"] as const,
    today: ["ai-journal", "today"] as const,
    recent: (days: number) => ["ai-journal", "recent", days] as const,
  },
```

and in `invalidatePageContent` where `queryKeys.journal.all` is invalidated (line ~177), also invalidate `queryKeys.aiJournal.all`.

`ui/src/api/aiJournal.ts` — mirror `ui/src/api/journal.ts` exactly, with these differences: endpoints `/api/vault/ai-journal/today`, `/api/vault/ai-journal/today/capture` is NOT needed (no UI capture surface), `/api/vault/ai-journal/recent`; `useAiJournalToday` returns `PageDetailResponse | null` directly (no `carried_forward` wrapper); `useEnsureAiJournalToday` returns `{ page, created }`; reuse the module-level `apiError` pattern and `queryKeys.aiJournal.*`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && bun run test journal && bun run typecheck`
Expected: PASS (including the pre-existing lib + JournalMeta + Folio draft tests, which must be unaffected).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/journal.ts ui/src/api/aiJournal.ts ui/src/api/keys.ts ui/src/lib/__tests__/
git commit -m "feat(ui): AI journal path helpers and query hooks"
```

---

### Task 10: Stream-parameterized JournalMeta, AI registration, cross-links

**Files:**
- Modify: `ui/src/components/codex/JournalMeta.tsx`
- Modify: `ui/src/lib/kindPresentation.tsx`
- Test: `ui/src/components/codex/__tests__/JournalMeta.test.tsx`

**Interfaces:**
- Consumes: `useAiJournalRecent`, `aiJournalPathForDate`, `aiJournalDateFromPath`, `aiJournalDayLabel` (Task 9).
- Produces: exported `JournalMeta` (human, behavior-compatible) and `AiJournalMeta` components; `presentationFor("AI_JOURNAL")` = editor body + `AiJournalMeta` + label `"AI Journal"` + `aiJournalDayLabel` title. Both rails carry a cross-link row to the other stream's same-date page.

- [ ] **Step 1: Write the failing tests**

Extend `JournalMeta.test.tsx` (its harness mocks `useJournalRecent` and the workspace store; add a mock for `#/api/aiJournal`'s `useAiJournalRecent` and for `#/hooks/useOpenTab`):

```tsx
// 1. renders the AI rail: <AiJournalMeta path="ai-journals/2026-08-07.md" …/>
//    shows the same day-nav + FASTI structure driven by useAiJournalRecentMock.
// 2. day nav uses the real indexed path when one exists:
//    recent contains { path: "ai-journals/20260806.2026-08-06.Ab12Cd34.md",
//    journal_date: "2026-08-06" }; clicking ‹ calls updateTabPath with that
//    canonical path (NOT "ai-journals/2026-08-06.md").
// 3. human rail shows an "AI journal" cross-link row: with
//    useAiJournalRecentMock returning a page for the rail's date, the row
//    reads "written" and clicking it calls openTab("page", <that path>, date).
// 4. cross-link to an unwritten non-today date is disabled; unwritten TODAY
//    is enabled and opens the draft path aiJournalPathForDate(today).
// 5. AI rail shows the mirror "Journal" cross-link row (mock useJournalRecent).
```

Write these as real tests following the file's existing mock wiring.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && bun run test JournalMeta`
Expected: FAIL — no `AiJournalMeta`, no cross-link row.

- [ ] **Step 3: Refactor JournalMeta over a stream spec**

Rework `JournalMeta.tsx` to an internal generic component plus two thin exports:

```tsx
type StreamEntry = { path: string; journal_date: string };

type StreamSpec = {
  useRecent: (days: number) => { data?: StreamEntry[] };
  pathForDate: (key: string) => string;
  dateFromPath: (path: string) => string | null;
  counterpart: {
    label: string; // row label: "AI journal" on the human rail, "Journal" on the AI rail
    useRecent: (days: number) => { data?: StreamEntry[] };
    pathForDate: (key: string) => string;
  };
};

function JournalStreamMeta({ spec, path, tabId, isDraft }: { spec: StreamSpec } & KindMetaExtrasProps) {
  const { data: recent } = spec.useRecent(FETCH_DAYS);
  const { data: counterpartRecent } = spec.counterpart.useRecent(FETCH_DAYS);
  const updateTabPath = useWorkspaceStore((s) => s.updateTabPath);
  const openTab = useOpenTab();

  const todayKey = localDateKey(new Date());
  const dateKey = spec.dateFromPath(path) ?? todayKey;
  const entries = recent ?? [];
  const byDate = new Map(entries.map((e) => [e.journal_date, e.path]));
  const writtenKeys = [...new Set([...byDate.keys(), todayKey])];

  // Prefer the real indexed path; the draft shape exists only for today.
  const goTo = (key: string) =>
    updateTabPath(tabId, byDate.get(key) ?? spec.pathForDate(key), key);

  const counterpartByDate = new Map(
    (counterpartRecent ?? []).map((e) => [e.journal_date, e.path]),
  );
  const counterpartPath = counterpartByDate.get(dateKey) ?? null;
  const counterpartNavigable = counterpartPath !== null || dateKey === todayKey;
  const openCounterpart = () =>
    openTab(
      "page",
      counterpartPath ?? spec.counterpart.pathForDate(dateKey),
      dateKey,
    );
  // …existing prev/next/FASTI/day-of-year rendering unchanged…
}
```

Keep the existing JSX; add one cross-link row into the bottom `cl-mono` block, matching its `flex justify-between` row style:

```tsx
        <div className="flex justify-between">
          <span className="text-[9px] uppercase tracking-[0.12em] text-ink-mute">
            {spec.counterpart.label}
          </span>
          <button
            type="button"
            className={cn(
              "text-ink-2",
              counterpartNavigable
                ? "cursor-pointer underline decoration-dotted hover:text-ink"
                : "opacity-50",
            )}
            disabled={!counterpartNavigable}
            onClick={openCounterpart}
          >
            {counterpartPath !== null ? "written · open" : "unwritten"}
          </button>
        </div>
```

Exports:

```tsx
const HUMAN_SPEC: StreamSpec = {
  useRecent: useJournalRecent,
  pathForDate: journalPathForDate,
  dateFromPath: journalDateFromPath,
  counterpart: {
    label: "AI journal",
    useRecent: useAiJournalRecent,
    pathForDate: aiJournalPathForDate,
  },
};

const AI_SPEC: StreamSpec = {
  useRecent: useAiJournalRecent,
  pathForDate: aiJournalPathForDate,
  dateFromPath: aiJournalDateFromPath,
  counterpart: {
    label: "Journal",
    useRecent: useJournalRecent,
    pathForDate: journalPathForDate,
  },
};

export function JournalMeta(props: KindMetaExtrasProps) {
  return <JournalStreamMeta spec={HUMAN_SPEC} {...props} />;
}

export function AiJournalMeta(props: KindMetaExtrasProps) {
  return <JournalStreamMeta spec={AI_SPEC} {...props} />;
}
```

Note the pre-existing human tests keep passing: their fixtures use legacy `journals/<d>.md` paths, so `byDate.get(key)` returns those same paths.

`ui/src/lib/kindPresentation.tsx` — import `AiJournalMeta` and `aiJournalDayLabel`, and register:

```tsx
  AI_JOURNAL: {
    bodyPresentation: "editor",
    metaExtras: AiJournalMeta,
    metaExtrasLabel: "AI Journal",
    readOnlyTitle: aiJournalDayLabel,
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && bun run test JournalMeta && bun run typecheck`
Expected: PASS, old and new.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/JournalMeta.tsx ui/src/lib/kindPresentation.tsx ui/src/components/codex/__tests__/JournalMeta.test.tsx
git commit -m "feat(ui): stream-parameterized journal rail with cross-links"
```

---

### Task 11: Folio draft dance for the AI stream; kind/project controls

**Files:**
- Modify: `ui/src/components/codex/Folio.tsx` (lines ~256-259, ~331-339, ~580, ~950, ~1196-1242)
- Modify: `ui/src/api/journal.ts` (`useJournalEditorOptions`)
- Test: `ui/src/components/codex/__tests__/FolioJournalDraft.test.tsx`

**Interfaces:**
- Consumes: `todayAiJournalPath`, `useAiJournalToday`, `useEnsureAiJournalToday` (Task 9).
- Produces: opening `ai-journals/<today>.md` drafts, creates on first write, and repoints the tab to the canonical path; KindSelect shows an immutable reason for AI_JOURNAL; the Project control is static for both journal kinds.

- [ ] **Step 1: Write the failing tests**

Extend `FolioJournalDraft.test.tsx` (read its harness first — it mocks the journal hooks and asserts the draft-then-create dance):

```tsx
// 1. ai_draft_binds_and_repoints: render Folio at todayAiJournalPath() with
//    useAiJournalTodayMock resolving { path: "ai-journals/20260827.2026-08-27.Ab12Cd34.md", meta: { title: "2026-08-27" } … };
//    expect updateTabPath called with the canonical path.
// 2. ai_draft_ensures_on_first_write: the editor options passed for the AI
//    draft path carry an ensure() that calls the AI ensure mutation
//    (mirror how the human test asserts this).
// 3. project_control_is_static_for_journal_kinds: render Folio on a JOURNAL
//    page and on an AI_JOURNAL page; the ProjectCombo is absent and the
//    static project text renders with title "Journal pages cannot join a project.".
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && bun run test FolioJournalDraft`
Expected: FAIL.

- [ ] **Step 3: Implement**

`ui/src/api/journal.ts` — generalize the editor options hook (import `useEnsureAiJournalToday` from `./aiJournal` and `todayAiJournalPath` from `#/lib/journal`):

```ts
export function useJournalEditorOptions(
  path: string,
): PageEditorOptions | undefined {
  const ensureToday = useEnsureJournalToday();
  const ensureAiToday = useEnsureAiJournalToday();
  const humanMutate = ensureToday.mutateAsync;
  const aiMutate = ensureAiToday.mutateAsync;
  const stream =
    path === todayJournalPath()
      ? "human"
      : path === todayAiJournalPath()
        ? "ai"
        : null;
  return useMemo(() => {
    if (stream === "human") return { ensure: () => humanMutate() };
    if (stream === "ai") return { ensure: () => aiMutate() };
    return undefined;
  }, [stream, humanMutate, aiMutate]);
}
```

`ui/src/components/codex/Folio.tsx`:

1. Beside the human draft wiring (line ~256):
```ts
  const isTodayAiDraftPath = path === todayAiJournalPath();
  const { data: aiJournalToday, isLoading: isAiJournalTodayLoading } =
    useAiJournalToday(isTodayAiDraftPath);
```
2. Mirror the repoint effect (after line ~339):
```ts
  useEffect(() => {
    if (isTodayAiDraftPath && aiJournalToday?.path && aiJournalToday.path !== path) {
      updateTabPath(tabId, aiJournalToday.path, aiJournalToday.meta.title ?? undefined);
    }
  }, [isTodayAiDraftPath, aiJournalToday, path, tabId, updateTabPath]);
```
3. Extend the two draft-loading gates (lines ~580 and ~950): wherever the expression `isTodayDraftPath && (isJournalTodayLoading || journalToday)` appears, OR in the AI equivalent `isTodayAiDraftPath && (isAiJournalTodayLoading || aiJournalToday)` with the same surrounding logic.
4. KindSelect `immutableReason` (line ~1199):
```ts
                immutableReason={
                  kind === "JOURNAL"
                    ? "Journal kind cannot be changed."
                    : kind === "AI_JOURNAL"
                      ? "AI journal kind cannot be changed."
                      : undefined
                }
```
5. Project control (line ~1214): compute `const isJournalKind = kind === "JOURNAL" || kind === "AI_JOURNAL";` near the other derived flags, then:
```tsx
        <KV
          k="Project"
          v={
            folioReadOnly || isJournalKind ? (
              <span
                title={
                  isJournalKind
                    ? "Journal pages cannot join a project."
                    : undefined
                }
              >
                {project ?? "—"}
              </span>
            ) : (
              <ProjectCombo /* unchanged */ …
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && bun run test FolioJournalDraft && bun run test Folio.test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/Folio.tsx ui/src/api/journal.ts ui/src/components/codex/__tests__/FolioJournalDraft.test.tsx
git commit -m "feat(ui): AI journal draft dance; journal kind/project controls"
```

---

### Task 12: Entry points — palette, launcher, Atrium, graph

**Files:**
- Create: `ui/src/hooks/useOpenTodayAiJournal.ts`
- Modify: `ui/src/components/codex/commandRegistry.ts`, `ui/src/components/codex/CommandPalette.tsx`, `ui/src/components/codex/FolioLauncher.tsx`, `ui/src/components/codex/Atrium.tsx`, `ui/src/components/codex/constellation-filters.ts`, `ui/src/components/ForceGraph.tsx`
- Test: `ui/src/components/codex/__tests__/CommandPalette.test.tsx`, `ui/src/components/codex/__tests__/FolioLauncher.test.tsx`, the constellation-filters test (grep `constellation-filters` under `ui/src` for its test file)

**Interfaces:**
- Consumes: `useAiJournalToday`, `todayAiJournalPath`, `aiJournalDateFromPath` (Task 9).
- Produces: palette command `journal.ai.today` ("Today's AI journal"), launcher and Atrium entries, `hideDaily` covering `ai-journals/`, a distinct AI_JOURNAL graph glyph.

- [ ] **Step 1: Write the failing tests**

- `CommandPalette.test.tsx`: beside the existing "Today's journal" assertion (line ~155), assert a "Today's AI journal" command exists and that running it opens a tab (mirror how the human command's action is asserted).
- `FolioLauncher.test.tsx`: assert an "AI journal" action row renders.
- constellation-filters test: `hideDaily: true` removes a node with `path: "ai-journals/2026-08-27.md"` (add beside the `journals/` case).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && bun run test CommandPalette && bun run test FolioLauncher && bun run test constellation`
Expected: FAIL.

- [ ] **Step 3: Implement**

`ui/src/hooks/useOpenTodayAiJournal.ts` — mirror `useOpenTodayJournal.ts`:

```ts
import { useCallback } from "react";
import { useAiJournalToday } from "#/api/aiJournal";
import { useOpenTab } from "#/hooks/useOpenTab";
import { aiJournalDateFromPath, todayAiJournalPath } from "#/lib/journal";

/** Open (or focus) today's AI journal as a workspace folio tab. */
export function useOpenTodayAiJournal(): () => void {
  const openTab = useOpenTab();
  const { data: aiToday, refetch } = useAiJournalToday();
  return useCallback(async () => {
    let page = aiToday;
    if (page === undefined) {
      const result = await refetch();
      if (result.isError) return;
      page = result.data ?? null;
    }
    const draftPath = todayAiJournalPath();
    const path = page?.path ?? draftPath;
    const label =
      page?.meta.title ?? aiJournalDateFromPath(draftPath) ?? "today";
    openTab("page", path, label);
  }, [aiToday, openTab, refetch]);
}
```

`commandRegistry.ts`: add `"open-today-ai-journal"` to the action union (line ~6) and to `STATIC_COMMANDS` after `journal.today`:

```ts
  {
    id: "journal.ai.today",
    title: "Today's AI journal",
    action: "open-today-ai-journal",
  },
```

(No `shortcut` field — palette-only.)

`CommandPalette.tsx`: wire the case beside `"open-today-journal"` (line ~123) to `useOpenTodayAiJournal()`.

`FolioLauncher.tsx`: after the "Today's journal" `LauncherAction`, add (hint column is required by `LauncherAction` — pass an em dash):

```tsx
            <LauncherAction
              label="AI journal"
              hint="—"
              onClick={openTodayAiJournal}
            />
```

`Atrium.tsx`: the hero's quick-action grid (line ~139, `grid grid-cols-2 gap-1.5` holding Capture and Search) becomes `grid-cols-3` with a third button in the same style, label `AI journal`, `onClick={openTodayAiJournal}` (import and call the hook beside `openTodayJournal`; no shortcut caption line).

`constellation-filters.ts` (line ~14):

```ts
  let nodes = opts.hideDaily
    ? graph.nodes.filter(
        (node) =>
          !node.path.startsWith("journals/") &&
          !node.path.startsWith("ai-journals/"),
      )
    : graph.nodes;
```

Also grep `Constellation.tsx` for the "hide daily" legend copy; if it says "journals" verbatim, leave the label as-is (it already means both streams colloquially).

`ForceGraph.tsx` `nodeShape` (line ~18): add a `dashed` flag for the AI stream:

```ts
function nodeShape(kind: Kind): { d: string; filled: boolean; dashed?: boolean } {
  // …existing cases…
  if (kind === "AI_JOURNAL")
    return {
      d: `M${-s} 0a${s} ${s} 0 1 0 ${2 * s} 0a${s} ${s} 0 1 0 ${-2 * s} 0`,
      filled: false,
      dashed: true,
    };
  // …dot default…
}
```

Then find where `nodeShape` is consumed (grep `nodeShape(` in the file) and on the node path selection add `.attr("stroke-dasharray", shape.dashed ? "2,2" : null)` following the existing attr chain style.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && bun run test CommandPalette && bun run test FolioLauncher && bun run test constellation && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/hooks/useOpenTodayAiJournal.ts ui/src/components/codex/commandRegistry.ts ui/src/components/codex/CommandPalette.tsx ui/src/components/codex/FolioLauncher.tsx ui/src/components/codex/Atrium.tsx ui/src/components/codex/constellation-filters.ts ui/src/components/ForceGraph.tsx ui/src/components/codex/__tests__/
git commit -m "feat(ui): AI journal entry points and graph treatment"
```

---

### Task 13: Documentation and the vault skill

**Files:**
- Modify: `ui/src/docs/content/tasks-agenda-journals-and-board.mdx`
- Modify: `ui/src/docs/content/mcp.mdx`
- Modify: `.claude/skills/vault/SKILL.md`

**Interfaces:**
- Consumes: everything shipped above; no code.

- [ ] **Step 1: Journals doc**

In `tasks-agenda-journals-and-board.mdx`, in the journal section, document (Simple Technical English, matching the page's voice):
- the two streams: the human journal (`journals/`, kind `JOURNAL`) and the AI journal (`ai-journals/`, kind `AI_JOURNAL`); one page per day per stream;
- attribution: AI capture entries may carry `[author]` after the timestamp;
- the Agenda and carried-forward exclusions (agent notes never feed the agenda);
- the cross-link row in each stream's META rail;
- journal pages of either kind cannot change kind or join a project.

- [ ] **Step 2: MCP doc + vault skill**

In `mcp.mdx`, document the split capture contract: `vault_journal_capture` = the user's own journal, only on the user's explicit request; `vault_ai_journal_capture` = agent-initiated notes with optional `author`; no `ai-generated` tag for either capture.

In `.claude/skills/vault/SKILL.md`, update the capture-intent routing the same way (find its existing `vault_journal_capture` guidance and split it).

- [ ] **Step 3: Verify docs tests**

Run: `cargo test --test docs_api_coverage_test && cargo test --test docs_cli_coverage_test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/docs/content/tasks-agenda-journals-and-board.mdx ui/src/docs/content/mcp.mdx .claude/skills/vault/SKILL.md
git commit -m "docs: document the AI journal stream and split capture contract"
```

---

## Final verification (before merge)

- [ ] `cargo test` (full suite; needs `ui/dist` — `cd ui && bun run build` first in a fresh worktree)
- [ ] `cargo clippy --all-targets`
- [ ] `cd ui && bun run typecheck && bun run lint` (lint: touched files only — the repo baseline is not clean; compare against `git diff --name-only develop`)
- [ ] `cd ui && bun run test`
- [ ] Report all outputs explicitly, then follow superpowers:finishing-a-development-branch to merge `feature/ai-journal-stream` into `develop` and clean up the worktree.
