# RSS Reader Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all eight blocking findings from PR #5 while preserving its single-user RSS-reader behavior.

**Architecture:** Keep the existing subsystem boundaries. Add checked outbound HTTP helpers to `fetch.rs`, serialize manifest mutation through `feeds::update_manifest`, make API parsing explicit and testable, and extract frontend cache filtering into a pure function covered by Vitest.

**Tech Stack:** Rust 2024, Axum 0.8, Tokio, reqwest 0.12, sqlx/SQLite, React 19, TanStack Query 5, TypeScript 5.9, Vitest, Biome.

## Global Constraints

- Bind to loopback by default; non-loopback exposure must be explicit.
- Validate every outbound destination and redirect hop.
- Default maximum remote response size: 10 MiB; default maximum stored entry body: 1 MiB.
- A manifest with parser warnings never changes the last good database subscription set.
- API manifest edits must not overwrite concurrent API or external-editor changes.
- A supplied malformed mark-read cursor returns HTTP 400 without updating entries.
- Optimistic cache updates must preserve each query's unread, saved, and tag filters.
- Leave the dirty `develop` checkout untouched.

---

### Task 1: Network boundary and bounded ingestion

**Files:**
- Modify: `src/main.rs`
- Modify: `src/feeds/fetch.rs`
- Test: `src/feeds/fetch.rs`
- Modify: `README.md`

**Interfaces:**
- Produces: `Config::bind_addr: std::net::IpAddr`, `Config::max_response_bytes: usize`, and `Config::max_entry_content_bytes: usize`.
- Produces: checked request helpers used by `fetch_one` and `resolve_feed_url`; reqwest automatic redirects remain disabled.
- Consumes: existing `AppState::http` and feed fetch pipeline.

- [ ] **Step 1: Add failing address-classification tests**

Cover IPv4 loopback/private/link-local/shared/reserved addresses, IPv6 loopback/unique-local/link-local, and representative global IPv4/IPv6 addresses. Add a redirect test using a loopback Axum server that returns a `Location` pointing at loopback and assert the checked client rejects it before following.

- [ ] **Step 2: Add failing response-limit tests**

Use a loopback Axum test server to return a body one byte above a small test limit. Assert the bounded reader returns an oversized-response error. Add an ingestion test or pure helper test proving entry content above the configured storage limit becomes `None` rather than malformed/truncated HTML.

- [ ] **Step 3: Implement checked requests**

Create a small URL-validation path that:

```rust
async fn validate_remote_url(url: &reqwest::Url) -> anyhow::Result<()>;
async fn send_checked(
    state: &AppState,
    url: reqwest::Url,
    conditional: Option<(&str, &str)>,
) -> anyhow::Result<reqwest::Response>;
async fn read_limited(response: reqwest::Response, limit: usize) -> anyhow::Result<bytes::Bytes>;
```

Reject non-HTTP(S) schemes, localhost names, and any DNS result in a non-public range. Configure `state.http` with `redirect(reqwest::redirect::Policy::none())`; follow at most five redirects manually, validating each resolved target before sending it. Preserve feed conditional headers across redirects.

- [ ] **Step 4: Apply limits to every fetch path**

Use `send_checked` and `read_limited` in scheduled fetches, direct subscription validation, discovered-feed validation, and redirect handling. Do not store an entry body whose UTF-8 byte length exceeds `max_entry_content_bytes`; continue ingesting its metadata.

- [ ] **Step 5: Make server exposure explicit**

Parse `CLEPSYDRA_BIND` as `IpAddr`, defaulting to `127.0.0.1`, and bind `(config.bind_addr, config.port)`. Parse `CLEPSYDRA_MAX_RESPONSE_BYTES` and `CLEPSYDRA_MAX_ENTRY_CONTENT_BYTES` with the defaults above. Document all three variables in `README.md`.

- [ ] **Step 6: Run focused tests**

Run: `cargo test feeds::fetch::tests --all-features`
Expected: all fetch safety and limit tests pass.

---

### Task 2: Manifest and API integrity

**Files:**
- Modify: `src/main.rs`
- Modify: `src/feeds/mod.rs`
- Modify: `src/feeds/api.rs`
- Test: `src/feeds/mod.rs`
- Test: `src/feeds/api.rs`

**Interfaces:**
- Produces: `AppState::manifest_lock: Arc<tokio::sync::Mutex<()>>`.
- Produces: `feeds::update_manifest(state, transform)` as the only API read-modify-write path.
- Produces: `parse_required_cursor(value: Option<&str>) -> Result<Option<(String, i64)>, ApiError>` or an equivalent explicit missing-versus-invalid parser.
- Consumes: `manifest::parse`, `reconcile`, and existing Axum handlers.

- [ ] **Step 1: Add failing reconciliation tests**

Construct a temporary SQLite pool and manifest. Reconcile one valid feed, rewrite the file with a malformed feed-like item that produces a parser warning, reconcile again, and assert the original feed remains subscribed. Assert warnings are still visible through `manifest_warnings`.

- [ ] **Step 2: Add failing mutation serialization/conflict tests**

Exercise concurrent `update_manifest` transforms and assert both additions survive. Add an external-edit conflict test in which the source changes after the initial read and assert the update reports a conflict and preserves the external content.

- [ ] **Step 3: Implement validated reconciliation and manifest mutation**

Split reconciliation into a lock-owning wrapper and an internal implementation. Parse first; store warnings; if warnings are non-empty, return without applying inserts or unsubscriptions. Implement `update_manifest` so one Tokio mutex covers read, validation, synchronous transformation, pre-rename content comparison, atomic temp write/rename, and internal reconciliation. Reject mutation when either the source or transformed manifest has parser warnings.

- [ ] **Step 4: Migrate every manifest-writing handler**

Replace subscribe, update, unsubscribe, and OPML import read-modify-write sequences with `update_manifest`. Map invalid/conflicting manifest errors to a non-500 API response. Remove the obsolete public `write_manifest` mutation path.

- [ ] **Step 5: Add failing cursor and OPML-deduplication tests**

Assert no cursor parses as `Ok(None)`, a valid cursor parses as `Ok(Some(...))`, and `Some("garbage")` returns `BadRequest`. Extract OPML merge/deduplication into a testable helper and assert repeated `xmlUrl` values produce one manifest item and `added == 1`.

- [ ] **Step 6: Implement cursor rejection and import deduplication**

Reject a supplied invalid cursor before constructing or executing the update. Change OPML import to use a mutable URL set and insert each accepted URL into it immediately. Introduce a named OPML item struct or type alias to resolve Clippy's `type_complexity`; return the contextualized future directly from `read_manifest` to resolve `needless_question_mark`.

- [ ] **Step 7: Run focused tests**

Run: `cargo test feeds::api::tests feeds::tests --all-features`
Expected: reconciliation, mutation, cursor, OPML, and existing parser tests pass.

---

### Task 3: Filter-aware optimistic entry updates

**Files:**
- Modify: `ui/package.json`
- Modify: `ui/bun.lock`
- Create: `ui/vitest.config.ts`
- Modify: `ui/src/lib/api.ts`
- Create: `ui/src/lib/api.test.ts`

**Interfaces:**
- Produces: a pure cache-update helper accepting an infinite-query cache value, `EntryFilters`, entry id, and `EntryPatch`.
- Consumes: the existing query key `['entries', filters]` and `EntriesResponse` page shape.

- [ ] **Step 1: Add Vitest and a test script**

Add `vitest` as a dev dependency, configure the Node test environment, and add `"test": "vitest run"`.

- [ ] **Step 2: Write failing cache-membership tests**

Use representative cached pages to assert:

```text
unread + read=true       => entry removed
unread + read=false      => entry retained and updated
saved + bookmarked=false => entry removed
saved + bookmarked=true  => entry retained and updated
tag=rust + tags=[]       => entry removed
tag=rust + tags=[rust]   => entry retained and updated
all view                 => entry always retained and updated
```

Also assert page order, `next_cursor`, and unaffected entries remain unchanged.

- [ ] **Step 3: Implement the pure updater**

Patch the matching entry, evaluate it against the query's `view` and `tag`, and filter only when the patched result stops matching. Group and feed membership cannot change through `EntryPatch` and therefore require no additional filter logic.

- [ ] **Step 4: Wire optimistic update and rollback**

Use `queryClient.getQueriesData` to capture all entry caches before mutation. Update each cache with filters from its query key. Return the snapshot from `onMutate`; restore it in `onError`; keep feed-count invalidation in `onSettled`.

- [ ] **Step 5: Run focused tests**

Run: `bun run test`
Expected: every cache-membership and rollback-helper test passes.

---

### Task 4: Integration verification and delivery

**Files:**
- Review all files changed by Tasks 1-3.

**Interfaces:**
- Consumes all prior task outputs.
- Produces a verified PR-head commit with no compatibility shim or obsolete path.

- [ ] **Step 1: Review each task diff**

Check each change against its interfaces and the design specification. Confirm every old manifest write path and unchecked fetch path is removed.

- [ ] **Step 2: Run Rust gates**

Run:

```text
cargo fmt --check
cargo check --all-targets --all-features
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets --all-features
```

Expected: every command exits zero.

- [ ] **Step 3: Run UI gates**

Run:

```text
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun run build
```

Expected: every command exits zero.

- [ ] **Step 4: Smoke-test server defaults**

Build the UI, launch the server with temporary vault/database paths, and verify it listens on `127.0.0.1:8640`, serves `/`, and returns JSON from `/api/feeds`.

- [ ] **Step 5: Commit and update PR branch**

Commit the reviewed changes with a focused message and push `HEAD:claude/rss-reader-plan-nhqekq`. Confirm PR #5 reports the new head commit.
