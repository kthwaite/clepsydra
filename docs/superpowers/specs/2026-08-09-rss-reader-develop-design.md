# RSS Reader on Develop — Design

## Goal

Add a durable, secure RSS/Atom reader to the current Clepsydra application without replacing the Vessel shell or creating a second backend architecture. Subscriptions remain human-editable in the vault; fetched entries, read state, and bookmarks remain available through a Vessel-native river.

## Scope

The feature includes:

- a `feeds.md` subscription manifest with section groups, inherited tags, title overrides, and preservation of unrelated prose;
- secure feed discovery and fetching with conditional requests, bounded responses, redirect validation, sanitization, backoff, and pruning;
- durable feed, entry, read, bookmark, and entry-tag state;
- conflict-safe subscription editing, OPML import/export, refresh, filtering, pagination, and bulk mark-read;
- an Atrium summary panel and a full `/feeds` reader/management surface on desktop and mobile.

Annotations and capture-to-vault are excluded. A bookmarked entry remains durable in feed storage but is not materialized as a vault note.

## Source of truth and persistence

`feeds.md` at the vault root is the sole source of truth for subscription membership, ordering, groups, feed-level tags, and title overrides. The parser recognizes second-level headings and feed list items while preserving frontmatter, headings, prose, comments, and unrecognized lines byte-for-byte outside the transformed item.

`feeds.md` is a reserved managed manifest, not an indexed page. Clepsydra excludes that exact root path unconditionally, independently of user-configured exclusion patterns, so index frontmatter repair can never rewrite it. UI writes use a dedicated `MutationCoordinator` exact-create/exact-replace operation with path locking, atomic publication, durability, and expected-content CAS, but deliberately no `IndexHandle::apply_mutation`. Conditional replacement protects completed in-place writes before claim verification by re-reading the claimed inode's exact bytes, and protects atomic path replacements by verifying the claimed filesystem identity. A non-cooperating writer that writes through an already-open file descriptor after Clepsydra has claimed and verified the path cannot be portably linearized and is outside the supported CAS boundary. A stale revision returns HTTP 409 without overwriting external edits. Successful writes reconcile feed storage and notify clients immediately. External edits are detected from the raw existing watcher batch before excluded paths are discarded; the scheduler also reconciles before a due sweep as a recovery path. A warning-bearing manifest updates diagnostics but never replaces the last valid subscription set.

Feed runtime data lives in `.clepsydra/feeds.db`, separate from `.clepsydra/cache.db`. The database uses `rusqlite`, idempotent schema initialization, foreign keys, and forward-compatible column/table migrations. It contains the subscription cache and fetch bookkeeping plus durable entries, read state, bookmarks, and entry tags. A reusable synchronous SQLite snapshot primitive serves both the live `FeedStoreHandle` and the one-shot backup CLI. Backup traversal skips `feeds.db`, `feeds.db-wal`, and `feeds.db-shm`, then archives only the consistent snapshot as `.clepsydra/feeds.db`.

## Backend architecture

`src/feeds/` owns the subsystem:

- `manifest.rs`: pure parser and minimal textual transforms;
- `store.rs`: `FeedStore`, schema, transactions, pagination, state changes, reconciliation, retention, and backup snapshot;
- `network.rs`: destination validation and checked HTTP redirects/body limits;
- `fetch.rs`: discovery, feed parsing, sanitization, deduplication, conditional fetches, and fetch-result application;
- `scheduler.rs`: due-feed sweeps, bounded concurrency, refresh notification, reconciliation, and pruning;
- `types.rs`: domain request/response types shared by storage and API logic.

`FeedStore` follows the existing `IndexHandle` approach: one owning worker thread receives typed operations over channels, keeping `rusqlite::Connection` off Tokio workers and serializing writes without an async mutex around blocking calls.

`AppState` gains a cloneable feed handle, a checked feed HTTP client, manifest diagnostics, settings-derived limits, and a scheduler notifier. `build_app_state_with_feeds(vault_root, &FeedsSettings)` is the configured constructor; the existing `build_app_state(vault_root)` remains as a default-settings wrapper for MCP and test callers. `run_server` reconciles once, retains an owned scheduler cancellation/join guard while serving, and stops the scheduler when serving returns. The existing watcher notifies that same loop when raw batches contain `feeds.md`. Existing server bind, TLS, static frontend, tracing, and shutdown behavior remain authoritative.

Configuration is added to the existing `Settings` model as a defaulted `[feeds]` section:

- `fetch_interval_minutes = 30`
- `retention_days = 30`
- `unread_retention_days = 90`
- `max_response_bytes = 10485760`
- `max_entry_content_bytes = 1048576`
- `fetch_concurrency = 4`

Environment overrides continue to use the existing `CLEPSYDRA__...` hierarchy. No separate RSS configuration loader is introduced.

## Network boundary

Subscription and refresh requests accept only HTTP and HTTPS. Before every request, including redirects, the checked client resolves all destination addresses and rejects loopback, private, link-local, multicast, unspecified, documentation, benchmarking, and otherwise non-global targets. Automatic redirects are disabled. Every redirect target is resolved relative to the current URL and revalidated.

Responses are streamed under `max_response_bytes`. Oversized documents fail without partial parsing. Entry HTML is sanitized with `ammonia` before persistence. Entry content larger than `max_entry_content_bytes` is omitted rather than truncated; its source URL remains available. Conditional headers use stored ETag and Last-Modified values. Success resets backoff; errors advance exponential backoff from the configured interval to a 24-hour cap.

## API

All routes are part of the existing OpenAPI document and live below `/api/vault/feeds`:

- `GET /api/vault/feeds` — grouped subscriptions, counts, diagnostics, health, and `manifest_revision`;
- `POST /api/vault/feeds` — discover, validate, subscribe, and fetch; requires `expected_revision`;
- `PATCH /api/vault/feeds/{id}` — title override or group move; requires `expected_revision`;
- `DELETE /api/vault/feeds/{id}` — unsubscribe with a JSON body containing `expected_revision`;
- `POST /api/vault/feeds/refresh` and `/refresh/{id}` — schedule refresh through the one pipeline;
- `GET /api/vault/feeds/entries` — cursor-paginated entries filtered by view, feed, group, or tag;
- `PATCH /api/vault/feeds/entries/{id}` — read, bookmark, or tag state;
- `POST /api/vault/feeds/entries/mark-read` — bounded bulk read mutation;
- `POST /api/vault/feeds/import` — OPML folders to manifest groups, deduplicated against existing and same-import URLs; requires `expected_revision`;
- `GET /api/vault/feeds/export` — OPML export preserving groups.

Malformed supplied cursors return HTTP 400 and perform no mutation. An absent mark-read cursor is explicitly unbounded. A boundary cursor prevents entries arriving during the gesture from being marked.

Membership-changing handlers compare the supplied revision with `page_revision(raw_manifest)`, pass the same raw bytes into the coordinator CAS, and map both preflight and publication races through `ApiError::revision_conflict(current_revision)`. Refresh and entry-state mutations do not require a manifest revision.

Handlers use the existing `ApiError` conventions and Utoipa annotations. Frontend types come from regenerated `ui/src/api/schema.d.ts`; handwritten duplicate transport types are prohibited.

## Frontend architecture and interaction

`/` remains the Atrium. A `FeedRiverPanel` is added as a full-width incoming-information card after the activity/tags row and before recents. It shows unread counts, unread/all/saved tabs, a compact initial river, and a clear route to the full reader. Vaults without subscriptions show a quiet setup action rather than hiding the panel.

`/feeds` is a first-class Codex view named `FEEDS`. It contains:

- river modes for unread, all, and saved;
- URL search parameters for group, feed, and tag filters;
- day-grouped, newest-first entries with cursor-based infinite loading;
- inline expansion, mark-on-expand, explicit read/unread, bookmark, tag editing, and original-link actions;
- a management mode for subscribe, title/group edits, unsubscribe, refresh, health, OPML import, and OPML export.

Desktop navigation adds `FEEDS` before `DOCS`; STATUS keeps its explicit non-view affordance. Mobile root navigation adds Feeds. `resolveCodexView`, frame labels, breakpoint behavior, and route tests cover the new view.

Components use the current Vessel vocabulary and tokens: `Card`, `cl-mono`, `cl-marg`, paper/ink/rule/accent variables, square indicators, compact figure captions, and existing responsive breakpoints. Generic Zinc/Sky styling from PR #5 is not carried over. Interactive form, dialog, disclosure, toggle, and selection controls use existing React Aria primitives or React Aria Components where appropriate.

`ui/src/api/feeds.ts` uses `$api`, generated schema types, `queryKeys`, and `invalidateByPath`. Infinite entry queries retain an OpenAPI-shaped key, `["get", "/api/vault/feeds/entries", init]`, so existing path invalidation works. Optimistic entry mutations patch entries already present in each cache if they remain members and remove them if they no longer match; they never invent or reorder an entry absent from a cache. Errors restore exact captured pages; settlement refreshes counts and all affected entry queries so newly matching tag views refetch. Membership-changing hooks carry the latest `manifest_revision` and surface structured revision conflicts.

## Retention and invariants

- Feed `(url)` and entry `(feed_id, guid)` uniqueness make reconciliation and ingestion idempotent.
- Feed GUID fallback order is provided identifier, URL, then SHA-256 of title plus published timestamp.
- Bookmarked entries are never pruned.
- Read, unbookmarked entries expire after `retention_days`.
- Unread, unbookmarked entries expire after `unread_retention_days`.
- Unsubscribing is soft while retained/bookmarked entries exist; stale unbookmarked entries are pruned normally.
- Feed-level tags are copied from the manifest; entry tags are independently authored and normalized without `#`.
- Sanitized HTML is the only HTML stored or rendered.

## Errors and diagnostics

Manifest warnings retain the last good subscriptions and appear in both the feed list response and management UI with line-aware messages. A failing feed never blocks other feeds. Health exposes last fetch, next fetch, error count, and the last human-readable error. API mutations return actionable validation, conflict, not-found, or internal errors through the current error envelope. Optimistic UI failures roll back and show a toast.

## Testing

TDD covers observable contracts:

- manifest parsing, inherited tags, prose/frontmatter preservation, invalid-candidate rejection, and concurrent/external-write conflicts;
- schema initialization/migration, reconciliation, idempotent entry upsert, cursor ordering, filtered listing, state changes, pruning, and consistent backup snapshots;
- address classification, DNS rebinding-resistant connector behavior, redirect validation, response limits, discovery, conditional fetches, sanitization, GUID fallback, and backoff;
- API status/error contracts, malformed cursors, bounded mark-read, OPML deduplication, and generated OpenAPI paths;
- frontend query construction, filtered optimistic membership, exact rollback, navigation resolution, desktop/mobile roots, loading/empty/error states, keyboard interaction, and responsive river behavior.

Final gates are `cargo fmt --check`, `cargo check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test`, `bun run --cwd ui typecheck`, `bun run --cwd ui lint`, `bun run --cwd ui test`, and `bun run --cwd ui build`. Browser verification exercises subscribe, refresh, river filtering, expand/read, bookmark/tag, management, and desktop/mobile navigation against a local fixture feed.

## Integration history

PR #5 and commit `70e7032` are donor references only. The feature is implemented as new commits from `develop`; neither the PR merge commit nor its branch is merged into this branch. The accidental merge `9ccb6da` is reverted separately on `main` with `git revert -m 1`, preserving public history. The completed feature then reaches `main` through the normal `develop` integration path.
