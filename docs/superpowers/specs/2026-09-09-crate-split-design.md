# Workspace crate split — design

**Date:** 2026-09-09
**Status:** Phase 0 and 1 merged to develop (f0013f63); Phase 2 landed on branch feature/crate-split-phase2; Phase 3 pending
**Scope:** `src/` only. `ui/` and `extension/` are untouched.

## 1. Why

`src/` is one crate of ~100k SLOC (tokei, 166 files). Measured on develop
with dependencies cached and only the `clepsydra` package cleaned:

| Step | Wall | Notes |
|---|---|---|
| `cargo check` | 8.5 s | |
| `cargo build` (debug) | 42 s | lib 40 s, bin 2 s, strictly serial |
| `cargo test --no-run` | 107 s (360 s CPU) | lib rebuilt under `cfg(test)` plus 59 integration test binaries, each linking the whole lib |

Phase 1 (`[workspace]` skeleton; `clep-config`, `clep-client`, `clep-mcp`,
`clep-frontend-assets`, `clep-test-support`, and the `clep` bin peeled out),
measured the same way — `cargo clean -p clepsydra -p clep -p clep-config -p
clep-client -p clep-mcp -p clep-frontend-assets -p clep-test-support`, then
each step timed in turn:

| Step | Wall | Notes |
|---|---|---|
| `cargo check` | 10.97 s | |
| `cargo build` (debug) | 20.89 s | |
| `cargo test --no-run` | 35.76 s | only the seven cleaned crates' lib/test binaries recompile; the rest of the workspace stays cached |

Per-crate, cleaned in isolation:

| Crate | Step | Wall |
|---|---|---|
| `clep-mcp` | `cargo test -p clep-mcp --no-run` | 3.72 s |
| `clep-config` | `cargo test -p clep-config` | 2.49 s |

Phase 2 (`clep-vault`, `clep-index` cut from the vault layer). Remainder-only
(only `clepsydra` cleaned — the "edit something in `src/api`" case):

| Step | Wall | Notes |
|---|---|---|
| `cargo check` | 8.53 s | |
| `cargo build` (debug) | 21.31 s | |
| `cargo test --no-run` | 31.54 s | |

Per-crate, cleaned in isolation:

| Crate | Step | Wall |
|---|---|---|
| `clep-vault` | `cargo test -p clep-vault` | 5.26 s |
| `clep-index` | `cargo test -p clep-index` | 7.99 s |

All nine of our crates cleaned (`clepsydra`, `clep`, `clep-config`,
`clep-client`, `clep-mcp`, `clep-frontend-assets`, `clep-test-support`,
`clep-vault`, `clep-index`), then `cargo build --workspace`: 19.74 s.

Post-`touch ui/dist/index.html`, a release rebuild of `clep` is 8.65 s,
compiling only `clep-frontend-assets` and `clep` (was 38.7–44.3 s with the
lib recompiling, before `clep-frontend-assets` existed).

Two costs follow from the single crate. Every edit anywhere recompiles the
whole unit, and every integration test binary links all of it. The second
cost is the layering: the vault reaches *up* into the crate root and into
feeds in seven places, and two features are hard-wired into the core.
Crate boundaries make those impossible to reintroduce.

## 2. Target layout

Sixteen crates plus one dev-only helper, under `crates/`, prefixed `clep-`.
SLOC are approximate and include in-file tests. "Depends on" lists
workspace crates only; every crate may also use `serde`, `thiserror`,
`chrono`, `uuid`, `tracing`.

| Crate | Contents | ~SLOC | Depends on | Notable external deps |
|---|---|---|---|---|
| `clep-config` | `Settings`, `FeatureFlags`, `FeedsSettings`, `ServerSettings`, `TlsSettings`, `ServeOverrides`, `VaultSettings`, `resolve_vault_root`, `default_tls_paths`, `INDEX_DB_RELATIVE`, `VESSEL_ACCENT`, `app_config.rs`, `expand_tilde` | 0.5k | — | config, dirs |
| `clep-vault` | path, page, page_filename, legacy_yaml, markdown, link, rewriter, block, block_id, context, canonical, kind, code + wordlists, toml_json, toml_patch, encryption, keyring, board_vocab, projection, project, meeting, attendance, conflict, location, bcl, config (`VaultConfig`), `Vault` handle (`lib.rs`), atomic_file, rubbish, task_history, init, conversation, `extract_journal_date` | 9.5k | config | pulldown-cmark, regex, toml, toml_edit, serde_yaml, blake3, base64, glob, walkdir, rustix, utoipa (derive) |
| `clep-index` | index, index_handle, index_policy, derivation, derivers/, search/ (private), sync/ (fs events + watcher), reference_issues, hooks (all three traits), grep, tree (whole; render takes the accent as a parameter) | 8.6k | vault | rusqlite, notify-debouncer-mini, tokio (`sync` only) |
| `clep-bases` | base, base_document, base_embed, base_member, query, property_value | 12.3k | index | utoipa (derive) |
| `clep-mutate` | mutation, mutation_coordinator, batch_mutation, reconcile, reference_repair, relabel, recode, migrate, new_note (path builders only) | 8.4k | index | tokio (rt), parking_lot, utoipa (derive) |
| `clep-academic` | academic, academic_hook, import, import_doi, import_isbn, import_zotero, checkpoint | 1.5k | index | biblatex, reqwest, rusqlite |
| `clep-archive` | cas, cas_migrate, cas_scan, archive_hook, archive_snapshot, archive_backfill | 4.9k | index | fs4, lol_html, sha2, url, rusqlite, windows-sys |
| `clep-gitsync` | gitsync/ | 5.1k | vault, archive | gethostname, reqwest, sha2, toml_edit |
| `clep-feeds` | feeds/ (scheduler takes runtime + root + callback, not `AppState`) | 9k | config | feed-rs, ammonia, quick-xml, reqwest, rusqlite, rustix |
| `clep-client` | `ApiClient` (mcp/client.rs), `configured_api_client`, `base_url`, `load_tls_root_cert`, `host_is_loopback`, todo_capture | 1.1k | config | reqwest, percent-encoding |
| `clep-mcp` | mcp/server, mcp/tasking, mcp/edit, `run_mcp` | 4.4k | client, vault | rmcp, schemars |
| `clep-lsp` | lsp/ | 4.5k | config, vault, index, bases | tower-lsp, ropey, tokio, rusqlite |
| `clep-doctor` | doctor/ | 4k | config, vault, index, bases, mutate, archive, gitsync | axum-server (TLS check), glob, walkdir, owo-colors, rusqlite |
| `clep-frontend-assets` | api/frontend.rs | 0.2k | — | rust-embed, mime_guess, axum |
| `clep-api` | api/ (minus frontend.rs), lib.rs bootstrap (`build_app_state`, `build_router`, `run_server`, watcher, TLS serve, shutdown, `run_startup_reconcile`), sync_runtime, deeplink, geocode, events, openapi, `open_vault`, `open_vault_and_index`, `backup` | 24k | every vault-side crate, feeds, config | axum, axum-extra, axum-server, tower, tower-http, utoipa, utoipa-swagger-ui, tokio-stream, rusqlite |
| `clep` (bin) | cli.rs, sync_command, config_command, macos_url_handler, `create_new_note`, grep/tree `render_human`, `run_lsp_standalone` (`create_new_note` stays at the lib crate root through Phase 0 and moves here in Phase 1; `backup.rs` stays in the lib permanently — see §3 item 4) | 4.5k | all, `frontend-assets` | clap, anstream, owo-colors, tar, tempfile |
| `clep-test-support` (dev only) | `EnvGuard` | <0.1k | — | — |

Dev-dependency edges: `clep-mcp` → `clep-api` (in-process router tests);
`clep-doctor` → `clep-gitsync` with the `test-support` feature;
integration tests that need several feature crates at once live in the
bin crate's `tests/`.

Two more dev edges exist after Phase 0 and are resolved in Phase 3 by
moving tests rather than by adding cycles: the bases-aware half of
`index.rs`'s `linkable_epoch_tests` (the seam test and any test that
writes a `bases/*.base.toml`) moves into `clep-bases`; the feeds
scheduler's in-module tests that build an `AppState` fixture move into
`clep-api` or are rewritten over a bare `FeedHost`.

### Dependency graph

```
clep-config ───────► clep-vault          clep-test-support (dev)
   │                  │
   │               clep-index
   │             ┌────┼─────────┬───────────┐
   │        clep-bases  clep-mutate  clep-academic  clep-archive
   │             │                                    │
   │             │                               clep-gitsync
   │             │
clep-feeds   clep-client
   │             │
   │          clep-mcp        clep-lsp          clep-doctor
   │                                                │
   └──────────────────── clep-api ──────────────────┘
                           │
                          clep ◄────────── clep-frontend-assets
```

Critical path for a cold build: vault → index → bases (or mutate) → api →
bin. Bases, mutate, academic and archive compile concurrently; feeds,
client, mcp and lsp never wait on the mutation layer; doctor never waits
on api.

Root package: `clepsydra` stays at the repo root as the not-yet-split
remainder through Phase 3, then becomes `crates/clep-api`.

## 3. Seams that must change (Phase 0)

All of these land inside the current single crate, each as its own commit,
each verified by the existing suite. Doing them first removes almost all
the risk from the later mechanical moves.

1. **Linkable-properties provider.** `VaultIndex::build` (index.rs:674-717)
   and `index_page` (index.rs:850-858) call up into
   `base::BaseRegistry::load`, `effective_linkable_properties` and
   `linkable_epoch`. Replace with a `LinkablePropertiesProvider` trait
   object owned by `VaultIndex`; `clep-bases` supplies the adapter that
   reads `bases/*.base.toml`; a config-only adapter is the default. This is
   the decision "provider inversion" (§6.1). `property_value.rs` moves with
   bases.
2. **`RubbishPurgeHook`.** A third trait in hooks.rs with the signature of
   `archive_hook::release_rubbish_archive_refs_for_purge`
   (archive_hook.rs:66-72). The coordinator holds
   `Arc<Vec<Box<dyn RubbishPurgeHook>>>` where it takes
   `Arc<Mutex<ContentStore>>` today (mutation_coordinator.rs:907, 921,
   1026, 1134) and drops its `archive_hook` and `cas` imports.
   `ArchiveDeleteHook` implements the new trait and is registered at
   lib.rs:746 next to the delete hooks. The `RubbishCleanup` error text
   still says "captured-archive cleanup failed"; it is part of a 500
   response body and changes only with the Phase 3 move.
3. **Feeds scheduler inversion.** `feeds/scheduler.rs:10-11` takes
   `&AppState`; it uses `feed_runtime()`, `vault.root()` and `change_tx`.
   Give it `(FeedRuntime, vault_root: PathBuf, on_change: Arc<dyn Fn() +
   Send + Sync>)` so `SyncNotification` stays in api.
4. **Upward references.** `expand_tilde` moved from lib.rs:354 into the
   vault in Phase 0 (config.rs:195, cas_migrate.rs:240 use it); in Phase 1
   it moved again into `clep-config`, and `vault::config` imports it from
   there (`clep-vault → clep-config`). `render_human` in grep.rs and
   tree.rs takes the accent colour as a parameter so `VESSEL_ACCENT` stays
   in the CLI. `create_new_note` (new_note.rs, uses `app_config`) moves to
   the bin; `build_note_path` and `build_projected_note_path` stay.
   `backup.rs` stays in the lib (its tests use `cfg(test)` barriers in
   `vault::cas` and `feeds::store`); the bin calls
   `clepsydra::backup::create_backup`. In the Phase 0 code as landed,
   `backup.rs` and `new_note_command.rs` stayed at the lib crate root; in
   Phase 1 `new_note_command.rs` moved into the bin as planned, but
   `backup.rs`'s planned move to the bin was reconsidered per the ruling
   above and it stays in the lib; `feeds::store`'s `open_feed_lock_file`,
   `lock_feed_generation_shared` and `snapshot_database_file` stay
   `pub(crate)` (backup.rs is in the same crate, so no widening is
   needed).
5. **Index → reconcile.** `index.rs` called
   `reconcile::reconcile_rubbish_catalog`, a two-line wrapper over
   `RubbishStore::for_vault`; inlined in Phase 2. The root package's tests
   (`batch_mutation.rs`, `mutation_coordinator.rs`) call the
   `test-failpoints` hooks directly, and `cfg(test)` no longer crosses the
   crate boundary, so the root package also needed a
   `[dev-dependencies]` entry `clep-vault = { workspace = true, features =
   ["test-failpoints"] }` in addition to forwarding the feature.
6. **Relocations.** rubbish.rs, task_history.rs, init.rs stay in vault
   (they are already there; only their `pub(crate)` items widen).
   `index::extract_journal_date` (index.rs:2128) moves next to
   `page_filename`. checkpoint.rs goes with academic. geocode.rs goes with
   api.
7. **Test plumbing.** The `cfg(test)` fault-injection hooks in
   atomic_file.rs:10-45 and rubbish.rs become a `test-failpoints` cargo
   feature. `sync_runtime::tests::isolate_git_process_wide` moves into
   `gitsync::testing`. `env_test_support::EnvGuard` (lib.rs:1298) becomes
   `clep-test-support`. About 26 `pub(crate)` items become `pub`.
   `gitsync::testing` (including `GitEnv`/`isolate_git_process_wide`)
   stays `#[cfg(test)]` in Phase 0; Phase 3 gates it with
   `#[cfg(any(test, feature = "test-support"))]` and makes `tempfile` an
   optional dependency of `clep-gitsync` so `clep-doctor`'s tests can
   reach it. Cross-crate items widened from `pub(crate)` to `pub` for the
   split carry the doc line `/// Public for the workspace split; not part
   of the stable API.`
8. **utoipa.** The 37 `ToSchema` derives in nine vault files stay; utoipa
   (derive only) is a dependency of vault, bases, mutate, academic.
   `utoipa-swagger-ui` is api-only.

Facts that shape the later phases but need no change:

- Raw SQL is the real index interface. `VaultIndex::connection()` is
  called 61× outside `src/vault`; api and lsp keep `rusqlite`.
- api ⇄ sync_runtime is a cycle (api/mod.rs:91, sync_runtime.rs:21); they
  share `clep-api`.
- `AppState` is one struct with one router; `clep-api` is one crate.
- In debug builds rust-embed reads `ui/dist` from disk; in release every
  `ui/dist` change recompiles the whole lib. `clep-frontend-assets`
  confines that to one crate plus a relink. The binary, not the lib, links
  `clep-frontend-assets`; `run_server` takes the UI router as a parameter.

## 4. Phases

- **Phase 0** — the seven seam changes above, in the single crate.
- **Phase 1** — `[workspace]` skeleton under `crates/`; peel `clep-config`,
  `clep-client`, `clep-mcp`, `clep-frontend-assets`, `clep-test-support`,
  and the `clep` bin. Re-measure with `cargo clean -p` — landed 2026-09-09
  on branch feature/crate-split-phase1.
- **Phase 2** — cut the bottom: `clep-vault`, `clep-index`; move their
  integration tests with them — landed 2026-09-10 on branch
  feature/crate-split-phase2.
- **Phase 3** — `clep-bases`, `clep-mutate`, `clep-academic`,
  `clep-archive`, `clep-gitsync`, `clep-feeds`, `clep-lsp`, `clep-doctor`;
  the remainder of the lib becomes `clep-api`.
- **Later, optional** — split `clep-api` by resource under a shared
  `AppState` crate; openapi.rs stays at the top.

## 5. Test placement after the split

| Crate | Integration tests that move there |
|---|---|
| clep-vault | block_id_test, block_parser_test, canonical_name_test, context_test, rewriter_test, frontmatter_test, vault_path_test, keyring_test |
| clep-index | index_handle_test, block_index_test, journal_index_test, link_extraction_test, sync_test, encryption_test |
| clep-bases | property_patch |
| clep-academic | import_test, academic_http_test |
| clep-lsp | lsp_document_test |
| clep-api | the 27 api-level tests, tests/support (ApiFixture), openapi_contract, docs_api_coverage_test, deeplink_test, geocode_http_test, e2e_test, examples/openapi.rs |
| clep (bin) | mutation_test, batch_mutation_test, academic_test, academic_dedup_test, archive_test, e2e_encryption_test, checkpoint_test, merge_driver_test (needs `CARGO_BIN_EXE_clep`), docs_cli_coverage_test, macos_url_handler_test |
| root package (`clepsydra`, until later phases) | linkable_epoch_test (from `index.rs`; stays until `clep-bases` exists), index_test (uses `query`, `tree`; stays until Phase 3) |

`keyring_test` and `encryption_test` only use `clep-vault` and `clep-index`
respectively, so Phase 2 moved them there instead of to the bin. The
`private-note.age` fixture the encryption tests need has one canonical copy
at `tests/support/fixtures/`; crate tests include it by relative path
(`../../../tests/support/fixtures/…`).

## 6. Decisions

1. **Bases:** provider inversion (§3.1), not folding bases into the index.
2. **Granularity:** the full sixteen-crate DAG, delivered in phases.
3. **Doctor:** its own crate, so it builds in parallel with `clep-api`.
4. **Naming:** `clep-*` under `crates/`, matching the binary name.

## 7. Non-goals

- No behaviour change. Every phase is observable only through build
  times and `Cargo.toml`.
- No new abstraction over the SQLite schema.
- No change to `ui/`, the OpenAPI document, or `schema.d.ts`.
