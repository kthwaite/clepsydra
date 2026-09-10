# Workspace crate split — design

**Date:** 2026-09-09
**Status:** All phases landed; Phase 3 on branch feature/crate-split-phase3 pending merge to develop — see §1 for the final numbers
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

Phase 3 (`clep-bases`, `clep-mutate`, `clep-academic`, `clep-archive`,
`clep-gitsync`, `clep-feeds`, `clep-lsp`, `clep-doctor` cut; the remainder
renamed `clep-api`; the workspace root has no package). Remainder-only
(only `clep-api` cleaned — the "edit something in the HTTP layer" case),
each step timed independently with a warm target:

| Step | Wall | Notes |
|---|---|---|
| `cargo check` | 4.70 s | down from 8.53 s (Phase 2) and 8.5 s (develop) |
| `cargo build` (debug) | 13.62 s | down from 21.31 s (Phase 2) and 42 s (develop) |
| `cargo test --no-run` | 22.05 s | down from 31.54 s (Phase 2) and 107 s (develop) |

Per-crate, cleaned in isolation (`cargo clean -p <crate> && cargo test -p
<crate>`):

| Crate | Wall |
|---|---|
| `clep-bases` | 5.44 s |
| `clep-mutate` | 8.22 s |
| `clep-academic` | 4.33 s |
| `clep-archive` | 3.39 s |
| `clep-gitsync` | 8.91 s |
| `clep-feeds` | 7.03 s |
| `clep-lsp` | 6.96 s |
| `clep-doctor` | 5.82 s |

All seventeen `clep*` packages cleaned, then `cargo build`: 16.20 s.

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
| `clep-vault` | path, page, page_filename, legacy_yaml, markdown, link, rewriter, block, block_id, context, canonical, kind, code + wordlists, toml_json, toml_patch, encryption, keyring, board_vocab, projection, project, meeting, attendance, conflict, location, bcl, config (`VaultConfig`), `Vault` handle (`lib.rs`), atomic_file, rubbish, task_history, init, conversation, `extract_journal_date` | 9.5k | config | pulldown-cmark, regex, toml, toml_edit, serde_yaml, blake3, base64, glob, walkdir, rustix, utoipa (derive), dirs, parking_lot, serde_json, sha2, unicode-normalization, windows-sys |
| `clep-index` | index, index_handle, index_policy, derivation, derivers/, search/ (private), sync/ (fs events + watcher), reference_issues, hooks (all three traits), grep, tree (whole; render takes the accent as a parameter) | 8.6k | vault | rusqlite, notify-debouncer-mini, tokio (`sync` only), owo-colors, blake3, walkdir, toml, serde_json |
| `clep-bases` | base, base_document, base_embed, base_member, query, property_value | 12.3k | index, vault | utoipa (derive) |
| `clep-mutate` | mutation, mutation_coordinator, batch_mutation, reconcile, reference_repair, relabel, recode, migrate, new_note (path builders only) | 8.4k | index, vault | tokio (rt), parking_lot, utoipa (derive) |
| `clep-academic` | academic, academic_hook, import, import_doi, import_isbn, import_zotero, checkpoint | 1.5k | index, vault | biblatex, reqwest, rusqlite |
| `clep-archive` | cas, cas_migrate, cas_scan, archive_hook, archive_snapshot, archive_backfill | 4.9k | config, index, vault | fs4, lol_html, sha2, url, rusqlite, windows-sys |
| `clep-gitsync` | gitsync/ | 5.1k | archive, vault | gethostname, reqwest, sha2, toml_edit |
| `clep-feeds` | feeds/ (scheduler takes runtime + root + callback, not `AppState`) | 9k | config | feed-rs, ammonia, quick-xml, reqwest, rusqlite, rustix |
| `clep-client` | `ApiClient` (mcp/client.rs), `configured_api_client`, `base_url`, `load_tls_root_cert`, `host_is_loopback`, todo_capture | 1.1k | config | reqwest, percent-encoding |
| `clep-mcp` | mcp/server, mcp/tasking, mcp/edit, `run_mcp` | 4.4k | api, client | rmcp, schemars |
| `clep-lsp` | lsp/ | 4.5k | bases, config, index, vault | tower-lsp, ropey, tokio, rusqlite |
| `clep-doctor` | doctor/ | 4k | archive, bases, config, gitsync, index, mutate, vault | axum-server (TLS check), glob, walkdir, owo-colors, rusqlite |
| `clep-frontend-assets` | api/frontend.rs | 0.2k | — | rust-embed, mime_guess, axum |
| `clep-api` | api/ (minus frontend.rs), lib.rs bootstrap (`build_app_state`, `build_router`, `run_server`, watcher, TLS serve, shutdown, `run_startup_reconcile`), sync_runtime, deeplink, geocode, events, openapi, `open_vault`, `open_vault_and_index`, `backup` | 24k | academic, archive, bases, config, feeds, gitsync, index, mutate, vault | axum, axum-extra, axum-server, tower, tower-http, utoipa, utoipa-swagger-ui, tokio-stream, rusqlite |
| `clep` (bin) | cli.rs, sync_command, config_command, macos_url_handler, `create_new_note`, grep/tree `render_human`, `run_lsp_standalone` (`create_new_note` stays at the lib crate root through Phase 0 and moves here in Phase 1; `backup.rs` stays in the lib permanently — see §3 item 4) | 4.5k | api, client, config, doctor, frontend-assets, lsp, mcp | clap, anstream, owo-colors, tar, tempfile |
| `clep-test-support` (dev only) | `EnvGuard` | <0.1k | — | — |

**Ruling — `clep-mcp` → `clep-api` is a normal dependency, not dev-only.**
The plan above assumed `clep-mcp` only reached `clep-api` in its
in-process router tests. As landed, `clep-mcp`'s production code
(`tasking.rs`, `server.rs`) imports `clep_api::vault::{kind, code,
page_filename, block_id, init}` directly — the `vault` re-export shim
lives inside `clep-api` (it re-exports `clep-vault`, `clep-index`,
`clep-bases`, `clep-mutate`, `clep-archive`, `clep-academic`, and
`gitsync`; `clep_api::feeds` re-exports `clep-feeds`), and nothing has
rewritten those call sites to depend on `clep-vault` directly yet.
Rewriting `clep-mcp` to depend on the leaf crates it actually needs,
instead of reaching through `clep-api`, is a follow-up (see §5).
This edge is not new: `clep-mcp` has carried the server library as a
normal dependency since its Phase 1 extraction (a72901fd, when it was
still `clepsydra`); Phase 3 only renamed the dependency to `clep-api`.

Dev-dependency edges, as measured (`cargo tree -e normal --depth 1`
gives the table above; these are the `[dev-dependencies]` edges on top of
it): `clep-api` → `clep-doctor` (only for `tests/frontmatter_migration.rs`)
and → `clep-test-support`; `clep-doctor` → `clep-gitsync` with the
`test-support` feature, and → `clep-test-support`; `clep-bases`,
`clep-client`, `clep-config`, `clep-index`, `clep-lsp`, `clep-vault` →
`clep-test-support`; `clep-mutate` → `clep-test-support` and → `clep-vault`
with the `test-failpoints` feature. `clep-gitsync`'s `test-support` feature
is a *normal*, optional dependency on `clep-test-support`
(`dep:clep-test-support`), not a dev-dependency, because `clep-doctor` and
`clep-api` need it enabled outside `cfg(test)` in their own dev-dependency
graphs. Integration tests that need several feature crates at once live in
`crates/clep-api/tests` (multi-crate/`ApiFixture` tests) or
`crates/clep/tests` (bin-spawning tests).

The two dev edges flagged after Phase 0 were resolved by moving tests, not
by adding cycles: the bases-aware half of `index.rs`'s
`linkable_epoch_tests` moved into `clep-bases` (now
`provider_decides_whether_base_relations_are_linkable` and its four
siblings); the feeds scheduler's `AppState`-fixture tests moved to
`crates/clep-api/tests/feed_scheduler_test.rs`, and `clep-feeds`'s
in-module `scheduler::tests` were rewritten over a bare `FeedHost`.

### Dependency graph

```
clep-config ──┬────────────────────► clep-vault        clep-test-support (dev leaf;
              │                         │                consumed by nearly every crate's
              │                     clep-index            [dev-dependencies])
              │           ┌─────┬──────┼───────┬──────────┐
              │      clep-bases  │  clep-mutate  clep-academic
              │           │      │       │            │
              │           │  clep-archive◄────────────┘
              │           │      │
              │           │  clep-gitsync
              │           │      │
   ┌──────────┼───────────┴──────┴────────────┐
clep-feeds  clep-client               (clep-api depends directly on
   │           │                       all nine crates above it:
   │        clep-mcp ──────────────►   academic, archive, bases, config,
   │           │                       feeds, gitsync, index, mutate, vault)
   │           │                              │
   │           │                          clep-api
   │           │                        ┌─────┴──────┐
   │           │                    clep-lsp     clep-doctor
   │           │                   (bases, config,  (archive, bases, config,
   │           │                    index, vault;    gitsync, index, mutate,
   │           │                    parallel with     vault; parallel with api;
   │           │                    api, not a dep)   api → doctor is dev-only)
   │           │                        │             │
   └───────────┴────────────────────────┴─────────────┘
                           │
                          clep ◄────────── clep-frontend-assets
             (clep depends on api, client, config, doctor,
              frontend-assets, lsp, mcp)
```

Critical path for a cold build: config → vault → index → {bases | mutate |
academic | archive → gitsync} → api → {mcp →} clep. Bases, mutate,
academic and archive compile concurrently; feeds and client never wait on
the index layer; lsp and doctor compile in parallel with api rather than
after it — `clep-api` does not depend on either.

Root package: none. The workspace root is a virtual manifest
(`[workspace]`, `resolver = "3"`, no `[package]`); `clepsydra` as a crate
name no longer exists. The former root-package remainder became
`crates/clep-api`.

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
   `create_backup` (then `clepsydra::backup`, now `clep_api::backup`). In the Phase 0 code as landed,
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
   ["test-failpoints"] }` in addition to forwarding the feature. Cargo
   unifies features per package per invocation, so any `cargo test` that
   builds both compiles `clep-vault` with `test-failpoints` for the whole
   workspace, including the `clep` binary that `merge_driver_test` spawns;
   behaviour is unchanged because the failpoint registry is empty unless a
   test arms it, and `cargo build`/`cargo install` are unaffected — but do
   not benchmark a binary produced by `cargo test`.
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

**Test-support seams, as landed in Phase 3.** Three cargo features carry
`cfg(test)` across the crate boundaries item 7 anticipated:

- `test-failpoints`, on `clep-vault`, `clep-archive`, and `clep-feeds`
  (`atomic_file`/`rubbish` fault injection in vault; matching injection
  points in archive and feeds). `clep-api` forwards the feature
  (`clep-api/test-failpoints` enables all three) and also enables it
  directly on its `[dev-dependencies]` copies of the three crates, since
  `cfg(test)` does not cross a crate boundary — the feature is the
  substitute. `clep-mutate` enables `clep-vault/test-failpoints` in its own
  dev-dependencies for the same reason.
- `test-support`, on `clep-gitsync` only, gating `gitsync::testing`
  (`GitEnv`, `isolate_git_process_wide`) behind
  `#[cfg(any(test, feature = "test-support"))]` and making
  `clep-test-support` an optional dependency (`dep:clep-test-support`).
  `clep-doctor` and `clep-api` both enable `clep-gitsync/test-support` in
  their `[dev-dependencies]` so their own tests can reach `gitsync::testing`.
  **Deviation from the plan above:** `tempfile` stays a mandatory,
  unconditional dependency of `clep-gitsync` rather than becoming optional
  — `merge_driver::text_merge` shells out through a real tempdir in
  production, not only in tests, so gating it would have broken the
  non-test build.

The scheduler-test move landed as planned: the `AppState`-fixture half of
the feeds scheduler tests is `crates/clep-api/tests/feed_scheduler_test.rs`;
`clep-feeds`'s own `scheduler::tests` module was rewritten over a bare
`FeedHost` and needs no `AppState`.

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
  the remainder of the lib becomes `clep-api` — landed 2026-09-10 on branch
  feature/crate-split-phase3.
- **Later, optional** — split `clep-api` by resource under a shared
  `AppState` crate; openapi.rs stays at the top.

## 5. Test placement after the split

| Crate | Integration tests that move there |
|---|---|
| clep-vault | block_id_test, block_parser_test, canonical_name_test, context_test, rewriter_test, frontmatter_test, vault_path_test, keyring_test |
| clep-index | index_handle_test, block_index_test, journal_index_test, link_extraction_test, sync_test, encryption_test |
| clep-bases | index_test (uses `query`, `tree`), linkable_epoch_test (moved from the root package's `index.rs` once `clep-bases` existed) |
| clep-academic | import_test, academic_http_test, checkpoint_test |
| clep-mutate | batch_mutation_test |
| clep-lsp | lsp_document_test |
| clep-api | 33 integration test files: 15 `api_*_test` files plus `api_test`, `api_pages`, `api_feeds`; `academic_test`, `academic_dedup_test`, `archive_test`, `mutation_test`, `property_patch`, `bases_api`, `block_ref_resolution_test`, `reference_repair_test`; `e2e_test`, `e2e_block_refs_test`, `e2e_encryption_test`, `e2e_tasks_journal_test`; `deeplink_test`, `docs_api_coverage_test`, `feed_scheduler_test`, `frontmatter_migration`, `geocode_http_test`, `openapi_contract`; plus `tests/support` (the shared `ApiFixture`) and `examples/openapi.rs`. `tests/mcp_evals/` is fixture data (`evaluation.xml`) read by `clep-mcp`'s own eval-fixture drift test, so it is a cross-crate test-fixture reference, not a `clep-api` test itself. **Deviation from the plan above:** `academic_test`, `academic_dedup_test`, `archive_test`, `mutation_test`, and `e2e_encryption_test` were originally planned for the bin crate; they landed in `clep-api` instead because they only need `ApiFixture`, not a spawned `clep` binary. |
| clep (bin) | docs_cli_coverage_test, merge_driver_test (needs `CARGO_BIN_EXE_clep`), serve_archive_limits_test; `macos_url_handler`'s tests are in-module unit tests in `crates/clep/src/macos_url_handler.rs`, not a `tests/` integration file |

**Follow-up.** `clep-mcp`'s production code (`tasking.rs`, `server.rs`)
calls `clep_api::vault::{kind, code, page_filename, block_id, init}`
through the re-export shim rather than depending on `clep-vault` directly
(§2). Rewriting those call sites to depend on the leaf crates `clep-mcp`
actually needs — dropping the `clep-mcp` → `clep-api` production edge
back to a dev-only one, matching the original plan — is unstarted work,
not a Phase 3 deliverable. The same applies to `crates/clep/src/main.rs`, which
reaches `Settings`, `resolve_vault_root`, `expand_tilde`, and
`VESSEL_ACCENT` through `clep_api::` although the bin depends on
`clep-config` directly (an edge inherited from Phase 1); and to its
gitsync, mutate, archive, and vault calls through the `clep_api::vault`
shim, which keep `clep-api` on the build path of CLI-only subcommands
such as `clep merge-driver`.

`keyring_test` and `encryption_test` only use `clep-vault` and `clep-index`
respectively, so Phase 2 moved them there instead of to the bin. The
`private-note.age` fixture the encryption tests need has one canonical copy
at `crates/clep-test-support/fixtures/`, exposed as
`clep_test_support::PRIVATE_NOTE_AGE`, so no test crate reaches outside its
own tree for it.

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
