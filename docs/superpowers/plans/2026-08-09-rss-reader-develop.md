# RSS Reader on Develop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure, durable RSS/Atom reader to the current Clepsydra backend and Vessel UI while retaining `feeds.md` as the subscription source of truth.

**Architecture:** A new `src/feeds` subsystem uses a Rusqlite worker handle for durable feed state, a checked HTTP client for ingestion, and the existing vault mutation/watcher/server lifecycle. Utoipa routes below `/api/vault/feeds` generate frontend types; the UI adds a Codex Feeds view and an Atrium river panel without replacing the shell.

**Tech Stack:** Rust 2024, Axum 0.8, Rusqlite, Tokio, Reqwest 0.12, feed-rs 2, ammonia 4, quick-xml, Utoipa 5; React 19, TanStack Router/Query, React Aria Components, Tailwind 4, Vitest.

## Global Constraints

- PR #5 commit `70e7032` is donor reference only; never merge or cherry-pick its branch or merge commit.
- Follow TDD: add one observable-contract test, run it and observe the expected failure, then add production code and run the focused test green.
- Do not add SQLx or a second configuration loader.
- All HTTP routes live below `/api/vault/feeds` and appear in the existing OpenAPI document.
- `feeds.md` writes use `MutationCoordinator` with expected-revision conflict handling; no direct write/rename path.
- `.clepsydra/feeds.db` is durable and must be backed up through a consistent SQLite snapshot.
- Keep `/` as Atrium; add a `/feeds` Codex view plus an Atrium panel.
- Frontend transport types come from generated OpenAPI schemas.
- Preserve checked-destination, redirect, body-limit, sanitization, conditional-fetch, backoff, and filter-aware optimistic-update behavior from PR #5.
- New UI uses Vessel tokens and desktop/mobile conventions, not the PR's generic Zinc/Sky shell.

---

### Task 1: Manifest Model and Conflict-Safe Editing

**Files:**
- Create: `src/feeds/mod.rs`
- Create: `src/feeds/manifest.rs`
- Create: `src/feeds/types.rs`
- Modify: `src/lib.rs` (export module only in this task)
- Test: inline tests in `src/feeds/manifest.rs`

**Interfaces:**
- Produces `Manifest`, `ManifestFeed`, `ManifestWarning`, `parse`, `add_feed`, `update_feed`, and `remove_feed`.
- `ManifestFeed` fields: `url: String`, `title_override: Option<String>`, `group: String`, `tags: Vec<String>`, `line: usize`.
- Text transforms accept the original document and return a complete candidate document while preserving unrelated bytes.

- [ ] **Step 1: Add failing parser tests**

```rust
#[test]
fn parses_groups_inherited_tags_and_title_overrides() {
    let parsed = parse("+++\nid = 'x'\n+++\n\n## Tech #news #tech\n\n- [HN](https://news.example/rss) #hn\n");
    assert!(parsed.warnings.is_empty());
    assert_eq!(parsed.feeds[0].group, "Tech");
    assert_eq!(parsed.feeds[0].title_override.as_deref(), Some("HN"));
    assert_eq!(parsed.feeds[0].tags, ["news", "tech", "hn"]);
}

#[test]
fn transform_preserves_frontmatter_and_unrecognized_prose() {
    let source = "+++\nid = 'x'\n+++\n\nIntro.\n\n## Tech\n\nParagraph.\n";
    let candidate = add_feed(source, "Tech", "https://one.example/feed", None, &[]).unwrap();
    assert!(candidate.starts_with("+++\nid = 'x'\n+++\n\nIntro.\n"));
    assert!(candidate.contains("Paragraph.\n"));
    assert!(candidate.contains("- https://one.example/feed\n"));
}
```

Also cover duplicate URLs, malformed links with line-number warnings, bare URLs, tag normalization, removal of exactly one list item, and group/title update without rewriting surrounding prose.

- [ ] **Step 2: Run the focused tests and observe RED**

Run: `cargo test feeds::manifest::tests --lib`

Expected: compilation fails because `feeds::manifest` and its interfaces do not exist.

- [ ] **Step 3: Implement the pure manifest model**

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestFeed {
    pub url: String,
    pub title_override: Option<String>,
    pub group: String,
    pub tags: Vec<String>,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestWarning {
    pub line: usize,
    pub message: String,
}

pub struct Manifest {
    pub feeds: Vec<ManifestFeed>,
    pub warnings: Vec<ManifestWarning>,
}
```

Use line spans into the original string so update/remove replace only the recognized line. Preserve tag order while deduplicating inherited then item tags. Reject a candidate if parsing produces warnings or duplicate URLs.

- [ ] **Step 4: Run focused tests GREEN**

Run: `cargo test feeds::manifest::tests --lib`

Expected: all manifest tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/feeds src/lib.rs
git commit -m "feat(feeds): add manifest model"
```

---

### Task 2: Durable Feed Store and Backup Snapshot

**Files:**
- Create: `src/feeds/store.rs`
- Modify: `src/feeds/mod.rs`
- Modify: `src/feeds/types.rs`
- Modify: `src/vault/backup.rs`
- Test: inline tests in `src/feeds/store.rs`
- Test: existing tests in `src/vault/backup.rs`

**Interfaces:**
- Produces cloneable `FeedStoreHandle::open(path: &Path) -> Result<Self, FeedStoreError>`.
- Typed async methods: `reconcile`, `list_feeds`, `due_feeds`, `apply_fetch`, `list_entries`, `patch_entry`, `mark_read`, `schedule_refresh`, `prune`, and `snapshot_to`.
- `EntryCursor { sort_ts: DateTime<Utc>, id: i64 }` encodes as `<RFC3339>|<id>` and parses strictly.
- `EntryFilters` contains `view`, `feed_id`, `group`, `tag`, `limit`, and `cursor`.

- [ ] **Step 1: Add failing store contract tests**

```rust
#[tokio::test]
async fn reconcile_and_entry_upsert_are_idempotent() {
    let store = open_test_store().await;
    store.reconcile(vec![manifest_feed("https://one.example/feed")]).await.unwrap();
    let feed = store.list_feeds().await.unwrap().remove(0);
    let entry = fetched_entry("guid-1", "2026-08-09T10:00:00Z");
    store.apply_fetch(feed.id, successful_fetch(entry.clone())).await.unwrap();
    store.apply_fetch(feed.id, successful_fetch(entry)).await.unwrap();
    assert_eq!(store.list_entries(EntryFilters::all()).await.unwrap().entries.len(), 1);
}

#[tokio::test]
async fn prune_keeps_bookmarks_and_applies_read_unread_horizons() {
    let store = open_test_store().await;
    let now = DateTime::parse_from_rfc3339("2026-08-09T12:00:00Z").unwrap().to_utc();
    let ids = seed_prune_matrix(&store, now).await;
    store.prune(now, 30, 90).await.unwrap();
    let remaining = store.entry_ids().await.unwrap();
    assert!(remaining.contains(&ids.bookmarked_old));
    assert!(remaining.contains(&ids.unread_89_days));
    assert!(!remaining.contains(&ids.unread_91_days));
    assert!(!remaining.contains(&ids.read_31_days));
}

#[tokio::test]
async fn snapshot_opens_as_a_consistent_database() {
    let (store, source_dir) = open_file_store().await;
    let feed = seed_feed_with_bookmark(&store).await;
    let snapshot = source_dir.path().join("snapshot.db");
    store.snapshot_to(snapshot.clone()).await.unwrap();
    let reopened = FeedStoreHandle::open(&snapshot).unwrap();
    assert_eq!(reopened.list_feeds().await.unwrap()[0].id, feed.id);
    assert!(reopened.list_entries(EntryFilters::saved()).await.unwrap().entries[0].bookmarked);
}
```

Also cover cursor order/ties, malformed cursors, filtered listing, read/bookmark/tag patching, soft unsubscription, ETag/Last-Modified persistence, error backoff bookkeeping, and schema reopen.

- [ ] **Step 2: Run store tests RED**

Run: `cargo test feeds::store::tests --lib`

Expected: compilation fails because `FeedStoreHandle` is absent.

- [ ] **Step 3: Implement the worker-backed store**

```rust
#[derive(Clone)]
pub struct FeedStoreHandle {
    tx: std::sync::mpsc::Sender<Command>,
}

enum Command {
    Reconcile { feeds: Vec<ManifestFeed>, reply: tokio::sync::oneshot::Sender<Result<(), FeedStoreError>> },
    ListEntries { filters: EntryFilters, reply: tokio::sync::oneshot::Sender<Result<EntryPage, FeedStoreError>> },
    // one typed variant per public operation
}
```

Open one connection on a named worker thread, enable foreign keys, initialize schema idempotently, and execute every command on that thread. Use `(COALESCE(published_at, fetched_at) DESC, id DESC)` cursor ordering. Store tags as normalized relational rows for entry tags and JSON only for manifest-derived feed tags.

`FeedStoreHandle::snapshot_to` executes SQLite's online backup API or `VACUUM INTO` on the owning thread. Extend `backup.rs` so a present feed database is supplied as a consistent snapshot to the archive instead of traversed as a live file; keep `cache.db` excluded.

- [ ] **Step 4: Run store and backup tests GREEN**

Run: `cargo test feeds::store::tests vault::backup::tests --lib`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/feeds src/vault/backup.rs
git commit -m "feat(feeds): persist feed and entry state"
```

---

### Task 3: Checked Network and Feed Ingestion

**Files:**
- Create: `src/feeds/network.rs`
- Create: `src/feeds/fetch.rs`
- Modify: `src/feeds/types.rs`
- Modify: `src/feeds/mod.rs`
- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Test: inline tests in `src/feeds/network.rs` and `src/feeds/fetch.rs`

**Interfaces:**
- Produces `CheckedHttpClient::new(max_response_bytes)`, `get(url, conditional)`, and redirect-checked response streaming.
- Produces `fetch_subscription`, `fetch_feed`, `discover_feed_url`, and pure `next_fetch_after`.
- `FetchOutcome` distinguishes NotModified, Success, and Failure bookkeeping.

- [ ] **Step 1: Add failing network and parsing tests**

```rust
#[test]
fn rejects_non_global_destinations() {
    for ip in ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1"] {
        assert!(!is_global_destination(ip.parse().unwrap()), "{ip}");
    }
}

#[test]
fn exponential_backoff_caps_at_twenty_four_hours() {
    let base = Duration::minutes(30);
    assert_eq!(next_fetch_after(base, 0), base);
    assert_eq!(next_fetch_after(base, 10), Duration::hours(24));
}

#[test]
fn sanitized_entries_remove_scripts_and_event_handlers() {
    let xml = rss_with_html("<p onclick=\"steal()\">safe</p><script>steal()</script>");
    let entry = parse_feed(&xml, 1_048_576).unwrap().entries.remove(0);
    let html = entry.content_html.unwrap();
    assert!(html.contains("<p>safe</p>"));
    assert!(!html.contains("onclick"));
    assert!(!html.contains("<script"));
}
```

Use local wiremock fixtures to cover HTML alternate discovery, safe redirect, rejected redirect, body limit, 304 conditional headers, RSS and Atom parsing, GUID fallbacks, oversized entry-body omission, and one bad feed not affecting another result.

- [ ] **Step 2: Run fetch tests RED**

Run: `cargo test feeds::network::tests feeds::fetch::tests --lib`

Expected: compilation fails because the checked client and parser are absent.

- [ ] **Step 3: Add only required dependencies and implementation**

Add direct dependencies `ammonia = "4"`, `feed-rs = "2"`, and `quick-xml = "0.37"`. Add a Reqwest feature only if the streamed response API requires it. Reuse existing `sha2`, `chrono`, `reqwest`, `tokio`, `serde`, and `thiserror`; do not add `anyhow`, SQLx, or a second HTTP stack.

Disable automatic redirects. Resolve and validate every address, then bind the validated addresses into the connection path so request execution cannot perform an unchecked second resolution. Stream chunks and stop before exceeding the configured response limit. Sanitize HTML before constructing `FetchedEntry`.

- [ ] **Step 4: Run fetch tests GREEN**

Run: `cargo test feeds::network::tests feeds::fetch::tests --lib`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock src/feeds
git commit -m "feat(feeds): securely fetch and parse feeds"
```

---

### Task 4: Configuration, Scheduler, API, and OpenAPI Integration

**Files:**
- Create: `src/feeds/scheduler.rs`
- Create: `src/api/feeds.rs`
- Modify: `src/api/mod.rs`
- Modify: `src/api/openapi.rs`
- Modify: `src/lib.rs`
- Modify: `src/config_command.rs`
- Modify: `README.md`
- Test: inline tests in `src/api/feeds.rs`, `src/feeds/scheduler.rs`, and existing configuration tests
- Test: `tests/openapi_schema_test.rs` or the existing OpenAPI contract test location

**Interfaces:**
- Adds defaulted `FeedsSettings` to `Settings` with the exact defaults in the design.
- Adds `feeds: FeedStoreHandle`, checked HTTP client, notifier, manifest diagnostics, and manifest-update serialization to `AppState`.
- Produces `feeds::router() -> Router<Arc<AppState>>` nested at `/feeds` from `api_router`.

- [ ] **Step 1: Add failing integration tests**

```rust
#[test]
fn feed_settings_defaults_are_stable() {
    let settings = Settings::default_for_tests();
    assert_eq!(settings.feeds.fetch_interval_minutes, 30);
    assert_eq!(settings.feeds.retention_days, 30);
    assert_eq!(settings.feeds.unread_retention_days, 90);
    assert_eq!(settings.feeds.max_response_bytes, 10_485_760);
    assert_eq!(settings.feeds.max_entry_content_bytes, 1_048_576);
    assert_eq!(settings.feeds.fetch_concurrency, 4);
}

#[tokio::test]
async fn malformed_mark_read_cursor_is_bad_request_and_changes_nothing() {
    let app = feed_test_app_with_two_unread_entries().await;
    let response = app
        .post("/api/vault/feeds/entries/mark-read")
        .json(&serde_json::json!({ "before": "not-a-cursor" }))
        .await;
    response.assert_status_bad_request();
    assert_eq!(unread_count(&app).await, 2);
}

#[test]
fn openapi_contains_feed_routes() {
    let value = serde_json::to_value(ApiDoc::openapi()).unwrap();
    let paths = value["paths"].as_object().unwrap();
    for path in [
        "/api/vault/feeds",
        "/api/vault/feeds/{id}",
        "/api/vault/feeds/entries",
        "/api/vault/feeds/entries/{id}",
        "/api/vault/feeds/entries/mark-read",
        "/api/vault/feeds/import",
        "/api/vault/feeds/export",
    ] {
        assert!(paths.contains_key(path), "{path}");
    }
}
```

Also cover last-good-manifest preservation, stale revision conflict, absent cursor unbounded behavior, boundary cursor behavior, OPML duplicate handling, grouped list diagnostics, and refresh notification.

- [ ] **Step 2: Run API/config tests RED**

Run: `cargo test api::feeds::tests feeds::scheduler::tests --lib`

Expected: compilation fails because settings, state, scheduler, and router are absent.

- [ ] **Step 3: Implement lifecycle and routes**

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct FeedsSettings {
    #[serde(default = "default_fetch_interval_minutes")]
    pub fetch_interval_minutes: u64,
    // remaining five fields with exact design defaults
}
```

Build feed state in `build_app_state`, preserving the established test support constructor. Reconcile on startup. Start one scheduler from `run_server`; use a cancellation-safe Tokio task and bounded concurrency. Route all subscription transforms through an internal revision-guarded mutation helper using `MutationCoordinator`, then reconcile. Map domain errors through `ApiError` and annotate every request/response with Utoipa.

Update the config template/reference and README with the `[feeds]` section, `feeds.md` format, API location, and retention/security behavior. Do not repeat the obsolete PR setup instructions.

- [ ] **Step 4: Run focused backend integration tests GREEN**

Run: `cargo test api::feeds::tests feeds::scheduler::tests --lib`

Run: the repository's focused OpenAPI schema test target.

Expected: all focused tests pass and OpenAPI includes feed paths/schemas.

- [ ] **Step 5: Regenerate frontend schema**

Run the established local OpenAPI generation workflow against the test/serve schema endpoint, writing `ui/src/api/schema.d.ts`. The generated file must contain every feed request and response type.

- [ ] **Step 6: Commit**

```bash
git add src ui/src/api/schema.d.ts README.md
git commit -m "feat(api): expose RSS reader subsystem"
```

---

### Task 5: Generated Feed API Hooks and Optimistic Cache Semantics

**Files:**
- Create: `ui/src/api/feeds.ts`
- Create: `ui/src/api/feeds.test.ts`
- Modify: `ui/src/api/keys.ts`

**Interfaces:**
- Produces `useFeeds`, `feedEntriesInfiniteOptions`, `useSubscribeFeed`, `useUpdateFeed`, `useDeleteFeed`, `useRefreshFeeds`, `usePatchFeedEntry`, `useMarkFeedEntriesRead`, `useImportOpml`, and `exportOpml`.
- All public types alias `components["schemas"][...]` from generated schema.
- Exports a pure `updateCachedEntryPages(pages, mutation, filters)` for deterministic contract tests.

- [ ] **Step 1: Add failing cache-contract tests**

```ts
it("removes a read entry from unread caches but updates all caches", () => {
  const unread = updateCachedEntryPages(pageWith(unreadEntry), { read: true }, { view: "unread" });
  const all = updateCachedEntryPages(pageWith(unreadEntry), { read: true }, { view: "all" });
  expect(unread.pages[0].entries).toEqual([]);
  expect(all.pages[0].entries[0].read).toBe(true);
});

it("restores the exact captured infinite pages after mutation failure", async () => {
  const before = pageWith(unreadEntry);
  const client = makeFeedQueryClient(before);
  transport.patchEntry.mockRejectedValueOnce(new Error("offline"));
  await expect(runPatch(client, { id: unreadEntry.id, read: true })).rejects.toThrow("offline");
  expect(client.getQueryData(unreadEntriesKey)).toEqual(before);
});
```

Also cover saved view removal, tag-view removal/addition, feed/group filter retention, multiple cached filter keys, and count invalidation.

- [ ] **Step 2: Run frontend API tests RED**

Run: `bun run --cwd ui test -- src/api/feeds.test.ts`

Expected: module/functions are missing.

- [ ] **Step 3: Implement generated hooks**

Use `$api` for ordinary queries/mutations and `fetchClient` only where infinite-page or OPML response handling requires it. Add one `queryKeys.feeds` path prefix. In `onMutate`, cancel matching queries and capture every `[key, data]` pair; in `onError`, restore each exact pair; in `onSettled`, invalidate feed counts and affected entry paths.

- [ ] **Step 4: Run frontend API tests GREEN**

Run: `bun run --cwd ui test -- src/api/feeds.test.ts`

Expected: all feed API cache tests pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api
git commit -m "feat(ui): add generated feed API hooks"
```

---

### Task 6: Vessel Feed River and Management Surface

**Files:**
- Create: `ui/src/components/codex/FeedRiver.tsx`
- Create: `ui/src/components/codex/FeedManagement.tsx`
- Create: `ui/src/components/codex/FeedRiver.test.tsx`
- Create: `ui/src/components/codex/FeedManagement.test.tsx`
- Create: `ui/src/routes/feeds.tsx`
- Modify: `ui/src/lib/time.ts`
- Modify: `ui/src/main.css`

**Interfaces:**
- `FeedRiver` accepts `{ filters, compact?: boolean }` and owns infinite loading and one expanded entry.
- `FeedManagement` accepts no transport props; it consumes generated hooks.
- `/feeds` search schema contains `view: "unread" | "all" | "saved"`, optional `group`, `feed`, `tag`, and `manage: boolean`.

- [ ] **Step 1: Add failing interaction tests**

```tsx
it("marks an unread entry read when expanded and preserves the original-link action", async () => {
  renderFeedRiver({ entry: unreadEntry });
  await user.click(screen.getByRole("button", { name: /entry title/i }));
  expect(patchEntry).toHaveBeenCalledWith(expect.objectContaining({ read: true }));
  expect(screen.getByRole("link", { name: /open original/i })).toHaveAttribute("target", "_blank");
});

it("supports keyboard-accessible subscribe and management controls", async () => {
  renderFeedManagement();
  await user.tab();
  expect(screen.getByRole("textbox", { name: /feed or site url/i })).toHaveFocus();
  await user.type(document.activeElement as HTMLElement, "https://one.example/feed");
  await user.tab();
  await user.type(document.activeElement as HTMLElement, "Tech");
  await user.tab();
  await user.keyboard("{Enter}");
  expect(subscribeFeed).toHaveBeenCalledWith(expect.objectContaining({
    url: "https://one.example/feed",
    group: "Tech",
  }));
});
```

Also cover day grouping, empty/loading/error states, unread/all/saved modes, bookmark/tag actions, mark-all boundary, compact load-more handoff, health diagnostics, edit/unsubscribe confirmation, refresh, and OPML import/export.

- [ ] **Step 2: Run component tests RED**

Run: `bun run --cwd ui test -- src/components/codex/FeedRiver.test.tsx src/components/codex/FeedManagement.test.tsx`

Expected: components and route are missing.

- [ ] **Step 3: Implement the Vessel components**

Use `Card`, React Aria form/disclosure/dialog primitives, and existing toast/error conventions. Render square status pips and current paper/ink/rule/accent tokens. Scope sanitized entry HTML under `.feed-entry-content`; style headings, links, images, lists, code, and blockquotes without global element selectors. Set external links to `rel="noreferrer"`.

The full route presents river filters and a management toggle in its own surface. On narrow layouts, filters stack and entry metadata wraps without horizontal scrolling. `compact` limits the Atrium panel page height and links to `/feeds` for continuation.

- [ ] **Step 4: Run component tests GREEN**

Run: `bun run --cwd ui test -- src/components/codex/FeedRiver.test.tsx src/components/codex/FeedManagement.test.tsx`

Expected: all component tests pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex ui/src/routes/feeds.tsx ui/src/lib/time.ts ui/src/main.css
git commit -m "feat(ui): add Vessel feed river"
```

---

### Task 7: Atrium, Desktop, Mobile, and Route Integration

**Files:**
- Create: `ui/src/components/codex/FeedRiverPanel.tsx`
- Modify: `ui/src/components/codex/Atrium.tsx`
- Modify: `ui/src/components/codex/useCodexView.ts`
- Modify: `ui/src/components/codex/useCodexView.test.ts`
- Modify: `ui/src/components/codex/DesktopCodexFrame.tsx`
- Modify: `ui/src/components/codex/MobileCodexFrame.tsx`
- Modify: relevant frame integration tests under `ui/src/components/codex/__tests__/`
- Regenerate: `ui/src/routeTree.gen.ts`

**Interfaces:**
- `CodexView` adds `"feeds"`.
- `resolveCodexView("/feeds", ...)` returns `"feeds"`.
- Desktop nav places FEEDS before DOCS; mobile roots include Feeds.
- `FeedRiverPanel` renders for zero-subscription, loading, diagnostics, and active-river states.

- [ ] **Step 1: Add failing shell and Atrium tests**

```ts
it("resolves the feed route", () => {
  expect(resolveCodexView("/feeds", [], null)).toBe("feeds");
});
```

Add interaction assertions that desktop FEEDS navigates to `/feeds`, mobile Feeds navigates to `/feeds`, the active state follows the route, and Atrium renders a setup affordance when no feeds exist plus the compact river when subscriptions exist.

- [ ] **Step 2: Run integration tests RED**

Run: `bun run --cwd ui test -- src/components/codex/useCodexView.test.ts src/components/codex/__tests__/CodexFrame.test.tsx src/components/codex/__tests__/CodexFrameBreakpoint.integration.test.tsx`

Expected: `feeds` is absent from `CodexView` and navigation.

- [ ] **Step 3: Implement shell and Atrium integration**

Add FEEDS to desktop and mobile navigation without replacing Atrium. Keep STATUS as the explicit status control and update its displayed index consistently. Hide/show Sheaf according to the same full-surface rules used for Bases/Docs. Insert the panel after Activity/Subjects and before Recents. Regenerate the TanStack route tree using the existing build/generator path; do not edit generated content manually.

- [ ] **Step 4: Run shell tests GREEN**

Run the Step 2 command plus the new Atrium panel test file.

Expected: all navigation and panel tests pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex ui/src/routeTree.gen.ts
git commit -m "feat(ui): integrate feeds into Vessel"
```

---

### Task 8: End-to-End Verification and Delivery

**Files:**
- Modify only files required by failures found in verification.
- Add a regression test before any behavioral fix.

- [ ] **Step 1: Run backend gates**

```bash
cargo fmt --check
cargo check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

Expected: all commands exit 0 without warnings.

- [ ] **Step 2: Run frontend gates**

```bash
bun run --cwd ui typecheck
bun run --cwd ui lint
bun run --cwd ui test
bun run --cwd ui build
```

Expected: all commands exit 0.

- [ ] **Step 3: Run browser smoke test against a local fixture feed**

Start Clepsydra with a temporary vault and a local fixture server whose hostname resolves through the checked connector's test allowance. In Chromium at desktop and mobile widths, verify: empty setup, subscribe/discovery, refresh, unread/all/saved filters, expand/mark-read, bookmark/tag, group/feed filtering, management health, and navigation between Atrium and Feeds. Capture screenshots of Atrium panel, full desktop river, and mobile river for visual review.

- [ ] **Step 4: Run final whole-branch review**

Review the complete branch diff against the design, emphasizing durable-state backup, SSRF/DNS behavior, manifest conflict safety, optimistic cache rollback, OpenAPI accuracy, and responsive/accessibility behavior. Fix every Critical or Important finding through a failing regression test.

- [ ] **Step 5: Commit verification fixes**

```bash
git add -u
git add src ui tests Cargo.toml Cargo.lock README.md
git commit -m "fix(feeds): address final integration review"
```

Skip this commit if verification required no changes.

- [ ] **Step 6: Merge and clean up**

Merge `feature/rss-reader-develop` into `develop`, rerun the full gates on `develop`, remove the feature worktree and branch, then create a separate revert branch from `origin/main` containing `git revert -m 1 9ccb6da9dc1ed9751847a8c120400ed5ebb47667`. Push/opening remote PRs is only performed through the repository's configured integration workflow.
