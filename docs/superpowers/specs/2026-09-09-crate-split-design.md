# Workspace crate split — design

**Date:** 2026-09-09
**Status:** Phase 0 landed on branch feature/crate-split-phase0 (HEAD ff39d564 + this commit); Phases 1–3 pending
**Scope:** `src/` only. `ui/` and `extension/` are untouched.

## 1. Why

`src/` is one crate of ~100k SLOC (tokei, 166 files). Measured on develop
with dependencies cached and only the `clepsydra` package cleaned:

| Step | Wall | Notes |
|---|---|---|
| `cargo check` | 8.5 s | |
| `cargo build` (debug) | 42 s | lib 40 s, bin 2 s, strictly serial |
| `cargo test --no-run` | 107 s (360 s CPU) | lib rebuilt under `cfg(test)` plus 59 integration test binaries, each linking the whole lib |

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
| `clep-config` | `Settings`, `FeatureFlags`, `FeedsSettings`, `ServerSettings`, `TlsSettings`, `ServeOverrides`, `VaultSettings`, `resolve_vault_root`, `default_tls_paths`, `INDEX_DB_RELATIVE`, `VESSEL_ACCENT`, `app_config.rs` | 0.5k | — | config, dirs |
| `clep-vault` | path, page, page_filename, legacy_yaml, markdown, link, rewriter, block, block_id, context, canonical, kind, code + wordlists, toml_json, toml_patch, encryption, keyring, board_vocab, projection, project, meeting, attendance, conflict, location, bcl, config (`VaultConfig`), `Vault` handle (mod.rs), atomic_file, rubbish, task_history, init, conversation, `expand_tilde`, `extract_journal_date` | 9.5k | — | pulldown-cmark, regex, toml, toml_edit, serde_yaml, blake3, base64, glob, walkdir, rustix, utoipa (derive) |
| `clep-index` | index, index_handle, index_policy, derivation, derivers/, search/, sync/ (fs events + watcher), reference_issues, hooks (all three traits), grep + tree (data half) | 8.6k | vault | rusqlite, notify-debouncer-mini, tokio (`sync` only) |
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
| `clep-api` | api/ (minus frontend.rs), lib.rs bootstrap (`build_app_state`, `build_router`, `run_server`, watcher, TLS serve, shutdown, `run_startup_reconcile`), sync_runtime, deeplink, geocode, events, openapi, `open_vault`, `open_vault_and_index` | 24k | every vault-side crate, feeds, config, frontend-assets | axum, axum-extra, axum-server, tower, tower-http, utoipa, utoipa-swagger-ui, tokio-stream, rusqlite |
| `clep` (bin) | cli.rs, sync_command, config_command, macos_url_handler, backup, `create_new_note`, grep/tree `render_human`, `run_lsp_standalone` | 4.5k | all | clap, anstream, owo-colors, tar, tempfile |
| `clep-test-support` (dev only) | `EnvGuard` | <0.1k | — | — |

Dev-dependency edges: `clep-mcp` → `clep-api` (in-process router tests);
`clep-doctor` → `clep-gitsync` with the `test-support` feature;
integration tests that need several feature crates at once live in the
bin crate's `tests/`.

### Dependency graph

```
clep-config        clep-vault          clep-test-support (dev)
   │                  │
   │               clep-index
   │             ┌────┼─────────┬───────────┐
   │        clep-bases  clep-mutate  clep-academic  clep-archive
   │             │                                    │
   │             │                               clep-gitsync
   │             │
clep-feeds   clep-client                          clep-frontend-assets
   │             │
   │          clep-mcp        clep-lsp          clep-doctor
   │                                                │
   └──────────────────── clep-api ──────────────────┘
                           │
                          clep
```

Critical path for a cold build: vault → index → bases (or mutate) → api →
bin. Bases, mutate, academic and archive compile concurrently; feeds,
client, mcp and lsp never wait on the mutation layer; doctor never waits
on api.

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
   lib.rs:746 next to the delete hooks.
3. **Feeds scheduler inversion.** `feeds/scheduler.rs:10-11` takes
   `&AppState`; it uses `feed_runtime()`, `vault.root()` and `change_tx`.
   Give it `(FeedRuntime, vault_root: PathBuf, on_change: Arc<dyn Fn() +
   Send + Sync>)` so `SyncNotification` stays in api.
4. **Upward references.** `expand_tilde` moves from lib.rs:354 into the
   vault (config.rs:195, cas_migrate.rs:240 use it). `render_human` in
   grep.rs and tree.rs takes the accent colour as a parameter so
   `VESSEL_ACCENT` stays in the CLI. `create_new_note` (new_note.rs, uses
   `app_config`) moves to the bin; `build_note_path` and
   `build_projected_note_path` stay. `backup.rs` moves to the bin (it
   imports `feeds::store`; sole caller is cli.rs).
5. **Relocations.** rubbish.rs, task_history.rs, init.rs stay in vault
   (they are already there; only their `pub(crate)` items widen).
   `index::extract_journal_date` (index.rs:2128) moves next to
   `page_filename`. checkpoint.rs goes with academic. geocode.rs goes with
   api. `run_startup_reconcile` (lib.rs:1165) moves beside sync_runtime.
6. **Test plumbing.** The `cfg(test)` fault-injection hooks in
   atomic_file.rs:10-45 and rubbish.rs become a `test-failpoints` cargo
   feature. `sync_runtime::tests::isolate_git_process_wide` moves into
   `gitsync::testing`. `env_test_support::EnvGuard` (lib.rs:1298) becomes
   `clep-test-support`. About 26 `pub(crate)` items become `pub`.
7. **utoipa.** The 37 `ToSchema` derives in nine vault files stay; utoipa
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
  confines that to one crate plus a relink.

## 4. Phases

- **Phase 0** — the seven seam changes above, in the single crate.
- **Phase 1** — `[workspace]` skeleton under `crates/`; peel `clep-config`,
  `clep-client`, `clep-mcp`, `clep-frontend-assets`, `clep-test-support`,
  and the `clep` bin. Re-measure with `cargo clean -p`.
- **Phase 2** — cut the bottom: `clep-vault`, `clep-index`; move their
  integration tests with them.
- **Phase 3** — `clep-bases`, `clep-mutate`, `clep-academic`,
  `clep-archive`, `clep-gitsync`, `clep-feeds`, `clep-lsp`, `clep-doctor`;
  the remainder of the lib becomes `clep-api`.
- **Later, optional** — split `clep-api` by resource under a shared
  `AppState` crate; openapi.rs stays at the top.

## 5. Test placement after the split

| Crate | Integration tests that move there |
|---|---|
| clep-vault | block_id_test, block_parser_test, canonical_name_test, context_test, rewriter_test, frontmatter_test, vault_path_test |
| clep-index | index_handle_test, block_index_test, journal_index_test, link_extraction_test, sync_test |
| clep-bases | property_patch, index_test |
| clep-academic | import_test, academic_http_test |
| clep-lsp | lsp_document_test |
| clep-api | the 27 api-level tests, tests/support (ApiFixture), openapi_contract, docs_api_coverage_test, deeplink_test, geocode_http_test, e2e_test, examples/openapi.rs |
| clep (bin) | mutation_test, batch_mutation_test, academic_test, academic_dedup_test, archive_test, encryption_test, e2e_encryption_test, keyring_test, checkpoint_test, merge_driver_test (needs `CARGO_BIN_EXE_clep`), docs_cli_coverage_test, macos_url_handler_test |

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
