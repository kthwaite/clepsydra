# Crate Split Phase 3 — the remaining crates and `clep-api` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the sixteen-crate DAG: extract `clep-bases`, `clep-mutate`, `clep-academic`, `clep-archive`, `clep-gitsync`, `clep-feeds`, `clep-lsp`, `clep-doctor` from the root `clepsydra` package, then move the remainder (api, lib bootstrap, sync_runtime, deeplink, backup, geocode) to `crates/clep-api`, leaving the repo root a virtual workspace. No observable behaviour change.

**Architecture:** Every extraction repeats the Phase 2 pattern: files move (`git mv`), paths inside the moved crate are rewritten to `clep_*::`/`crate::`, and `src/vault/mod.rs` (or `src/lib.rs` for `feeds`) re-exports the crate's modules so every existing `clepsydra::…` path keeps resolving — nothing in the remainder is path-rewritten. A reference scan on 2026-09-10 confirmed the production edges already match the spec DAG (bases/mutate/academic/archive → index; gitsync → archive; feeds → config; lsp → bases; doctor → bases, mutate, archive, gitsync) with no cross-set inherent `impl` blocks. Three test-only couplings need seams first: `cas.rs` and `feeds/{store,manifest,scheduler}.rs` carry `#[cfg(test)]` barriers that `backup.rs` and `api/feeds.rs` tests drive (→ `test-failpoints` features, as `clep-vault` did), `gitsync::testing` is `pub(crate)` and used by `sync_runtime`/`doctor` tests (→ a `test-support` feature), and `feeds/scheduler.rs` tests build an `AppState` (→ move to an integration test of the remainder). The final task renames the remainder: `src/`, `tests/`, `examples/` move under `crates/clep-api/`, the root `Cargo.toml` becomes `[workspace]`-only, and `clepsydra::` becomes `clep_api::` in the bin, `clep-mcp`, and the moved tests.

**Tech Stack:** Cargo workspace (Phase 1–2 layout). No new external dependencies.

**Spec:** `docs/superpowers/specs/2026-09-09-crate-split-design.md` (§2 table + DAG, §3 seams, §4 Phase 3, §5 test placement). The spec is the authority; rulings recorded in the ledger where this plan departs from it.

## Global Constraints

- No behaviour change observable through the HTTP API, CLI output, or OpenAPI document. `ui/src/api/schema.d.ts` must not change. `clep --help` output is byte-identical (`crates/clep/tests/docs_cli_coverage_test.rs` guards it).
- No new external dependencies. Every crate's `[dependencies]` entries use `{ workspace = true }`; add a dependency to a crate only when the compiler demands it. Platform deps (`rustix`, `windows-sys`) under `[target.'cfg(…)'.dependencies]`.
- Every new crate: `[package] name = "clep-…"`, `version.workspace = true`, `edition.workspace = true`, `publish = false`.
- Existing public paths keep resolving through re-exports in `src/vault/mod.rs` / `src/lib.rs` until Task 9. The remainder (`src/api`, `src/lib.rs`, `src/sync_runtime.rs`, `src/deeplink.rs`, `src/backup.rs`, root `tests/`, `crates/clep`, `crates/clep-mcp`) is edited only where a `pub(crate)` item became cross-crate (widen to `pub`, doc line `/// Public for the workspace split; not part of the stable API.`) or where a task says so.
- Dependency direction follows the spec DAG. No new crate depends on `clepsydra` (later `clep-api`), not even as a dev-dependency. Tests that need the remainder stay in the remainder.
- Inside a moved crate: no `crate::vault::`, `crate::feeds::`, `clepsydra::`, or `super::super::` paths remain (string literals and doc prose excepted).
- Gates after every task, from the worktree root: `cargo fmt --all -- --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, `cargo test --locked --workspace --no-fail-fast -- --test-threads=4`. Foreground, 10-minute timeout, output to a log file, read cargo's exit code. Do not pipe cargo through `tail`. Unset `CLEPSYDRA__VAULT__ROOT` first.
- `Cargo.lock` changes are committed with the task.
- Never run `clep` or `cargo run` without `CLEPSYDRA__VAULT__ROOT` pointing at a scratch dir.
- Worktree `.worktrees/crate-split-3`, branch `feature/crate-split-phase3`, off `develop` (9e232e7b or later). `ui/dist` must exist in the worktree.
- Stage explicit paths (`git add` / `git mv`); `git add .` is intercepted by the user's shell. No attribution trailers. No `git stash`.
- Lost-test check for the final review: per-file `git ls-tree` + awk census of `#[test]`/`#[tokio::test]` fn names at base vs head (never `git grep -A3`, which merges context and reports false losses).

## Test placement rulings (amend spec §5 in Task 10)

- A test moves with a crate only if it uses that crate (plus vault/index/config) and nothing else. Tests spanning two or more Phase 3 crates, or using `tests/support` (ApiFixture) or `clepsydra::api`, stay in the remainder and become `clep-api` tests in Task 9 — not the bin. The bin keeps only tests that spawn it (`CARGO_BIN_EXE_clep`).
- Per crate: `clep-bases` ← `index_test`, `linkable_epoch_test`; `clep-mutate` ← `batch_mutation_test`; `clep-academic` ← `academic_http_test`, `checkpoint_test`, `import_test`; `clep-lsp` ← `lsp_document_test`; everything else in `tests/` → `clep-api` (incl. `mutation_test` (mutate+archive), `academic_test`, `academic_dedup_test`, `archive_test`, `e2e_encryption_test`, `deeplink_test`, `geocode_http_test`, `property_patch`, `frontmatter_migration`, the api_*/e2e_* files, `openapi_contract`, `docs_api_coverage_test`, `reference_repair_test`, `bases_api`, `block_ref_resolution_test`).

---

### Task 1: Seams before the cuts

**Files:**
- Modify: `src/vault/cas.rs` (the `#[cfg(test)]` barrier machinery, lines ~113–225 and the hook points ~338–400), `src/feeds/store.rs`, `src/feeds/manifest.rs`, `src/feeds/scheduler.rs` (their `#[cfg(test)]` barriers/counters/hooks), root `Cargo.toml` (`[features]`), visibility widenings listed below
- Create: `tests/feed_scheduler_test.rs` (from `src/feeds/scheduler.rs`'s `AppState`-fixture tests)

- [ ] **Step 1: Archive and feeds failpoints become feature-gated**

`src/backup.rs`'s tests call `crate::vault::cas::{install_before_backup_database_open_barrier, install_before_backup_blob_use_barrier, backup_blob_verification_passes, reset_backup_blob_verification_passes}` and `crate::feeds::store::install_after_snapshot_source_open_path_resolved_barrier`; `src/api/feeds.rs`'s tests call `crate::feeds::scheduler::set_before_reconcile_commit_hook` and `crate::feeds::manifest::{observed_parse_count, reset_observed_parse_count}`. All of these, and the statics/hook points that back them, are `#[cfg(test)]`. Once `cas.rs` and `feeds/` live in other crates, `cfg(test)` no longer reaches them from the remainder's tests. Do exactly what Phase 2 did for `clep-vault`:

- Change every `#[cfg(test)]` that guards this machinery in `src/vault/cas.rs`, `src/feeds/store.rs`, `src/feeds/manifest.rs`, `src/feeds/scheduler.rs` to `#[cfg(any(test, feature = "test-failpoints"))]`. Leave `#[cfg(test)] mod tests { … }` modules alone — only the barrier/counter/hook items and their call sites in production functions change.
- Widen the six entry points above from `pub(crate)` to `pub` with the workspace-split doc line.
- Root `Cargo.toml` already declares `test-failpoints = ["clep-vault/test-failpoints"]`; leave it (the feature is now also honoured by these files while they are in the root crate; under `cargo test` the `test` cfg is set anyway).

Run: `cargo test --locked -p clepsydra --test backup_test` if such a target exists, else `cargo test --locked -p clepsydra --lib backup::` and `--lib api::feeds::` → pass as before.

- [ ] **Step 2: Feed scheduler tests leave the module**

`src/feeds/scheduler.rs` (from `#[cfg(test)] mod tests` at ~line 220) has tests that build an `AppState` via `crate::{build_app_state_with_settings, FeatureFlags, FeedsSettings}` and `crate::api::AppState`. Move every test that needs `AppState` into `tests/feed_scheduler_test.rs` (public paths: `clepsydra::{build_app_state_with_settings, FeatureFlags, FeedsSettings}`, `clepsydra::api::AppState`, `clepsydra::feeds::scheduler::…`, `AppState::feed_host()`). Keep `reconcile_runs_against_a_bare_feed_host` (which only needs `FeedHost`) in the module. Any scheduler function the moved tests call that is private or `pub(crate)` becomes `pub` with the doc line. Count the tests before and after; the total is unchanged.

Run: `cargo test --locked --test feed_scheduler_test` and `cargo test --locked -p clepsydra --lib feeds::scheduler::` → all pass.

- [ ] **Step 3: Widen the `pub(crate)` items the boundaries will cross**

A name-match scan found these `pub(crate)` items referenced from another future crate. Widen to `pub` with the doc line only where a file outside the item's own set really calls it (verify each with a grep; report the ones you leave):

- `src/feeds/manifest.rs`: `observed_parse_count`, `reset_observed_parse_count` (Step 1 covers them)
- `src/feeds/scheduler.rs`: `reconcile_feed_manifest_bytes_locked`, `reconcile_feed_manifest_locked` (api/feeds.rs), `set_before_reconcile_commit_hook` (Step 1)
- `src/feeds/store.rs`: `FEED_WRITER_LOCK_FILENAME`, `FEED_GENERATION_LOCK_FILENAME`, `open_feed_lock_file`, `lock_feed_generation_shared`, `snapshot_database_file` (backup.rs), `install_after_snapshot_source_open_path_resolved_barrier` (Step 1)
- `src/vault/archive_hook.rs`: `captured_archive_hashes` (doctor)
- `src/vault/base.rs`: `candidate_link_targets`; `src/vault/base_member.rs`: `composed_candidate_matches_with_link_targets` (api/base_members.rs)
- `src/vault/batch_mutation.rs`: `mark_filesystem_committed`, `retained_transaction_directories`, and the `BatchTransaction` methods `prepare`, `publish`, `finish`, `rollback`, `directory` if they are `pub(crate)` and called from `src/lib.rs`, `src/backup.rs`, `src/api/`, `src/feeds/`, `src/lsp/`
- `src/vault/cas.rs`: `blob_relative_path`, `list_blob_hashes` (doctor, gitsync/init.rs), `open_existing`, `ref_count`, `root` if `pub(crate)` and used outside archive
- `src/vault/gitsync/mod.rs`: `first_line` (lsp, api/journal.rs), `plural` (crates/clep/src/sync_command.rs); `src/vault/gitsync/testing.rs` is handled in Task 5
- `src/vault/mutation_coordinator.rs`: `reconcile_recovered_batch_index` (lib.rs), `observe_page_id_lookup` (api/pages.rs)
- `src/vault/new_note.rs`: `build_projected_note_path` (api/conversations.rs, api/base_members.rs)
- `src/vault/query.rs`: `property_type` (doctor, lsp/diagnostics.rs), `body_excerpt` (api), `as_str` if `pub(crate)` and used outside bases

If a widened fn returns a `pub(crate)` type, widen the type the same way (`private_interfaces` lint). Later tasks widen any straggler the compiler finds.

- [ ] **Step 4: Gates, commit**

```bash
git add Cargo.toml src tests/feed_scheduler_test.rs
git commit -m "refactor: seams for the phase 3 crate cuts"
```

---

### Task 2: `clep-bases`

**Files:**
- Create: `crates/clep-bases/Cargo.toml`, `crates/clep-bases/src/lib.rs`
- Move into `crates/clep-bases/src/`: `src/vault/{base,base_document,base_embed,base_member,query,property_value}.rs`
- Move into `crates/clep-bases/tests/`: `tests/index_test.rs`, `tests/linkable_epoch_test.rs`
- Modify: `src/vault/mod.rs` (drop the six `pub mod` lines; add `pub use clep_bases::{base, base_document, base_embed, base_member, property_value, query};`), root `Cargo.toml` (workspace path entry + root dependency)

**Interfaces:** crate `clep_bases` with those six `pub mod`s; depends on `clep-vault`, `clep-index` (+ `clep-config` only if the compiler demands). Inside: vault-set paths → `clep_vault::…`, index-set → `clep_index::…`, own modules → `crate::…`. Expected external deps: rusqlite, pulldown-cmark, toml, toml_edit, utoipa, blake3, serde, serde_json, chrono, uuid, thiserror; dev: tempfile, clep-test-support.

- [ ] Step 1: create the crate, move the files, rewrite paths, wire `src/vault/mod.rs` and the root manifest.
- [ ] Step 2: move the two tests (`clepsydra::vault::{base,query,…}` → `clep_bases::…`; `clepsydra::vault::{index,init,path,config,derivation,tree,rubbish,Vault}` → `clep_index::…`/`clep_vault::…`).
- [ ] Step 3: `cargo test --locked -p clep-bases`; `cargo tree -p clep-bases -e normal | grep clep-` → `clep-vault`, `clep-index` (+config); prune root deps nothing left uses; gates; commit `build(clep-bases): bases, queries and property values in their own crate`.

---

### Task 3: `clep-mutate`

**Files:**
- Create: `crates/clep-mutate/Cargo.toml`, `crates/clep-mutate/src/lib.rs`
- Move into `crates/clep-mutate/src/`: `src/vault/{mutation,mutation_coordinator,batch_mutation,reconcile,reference_repair,relabel,recode,migrate,new_note}.rs`
- Move into `crates/clep-mutate/tests/`: `tests/batch_mutation_test.rs`
- Modify: `src/vault/mod.rs` (drop nine `pub mod`s; add `pub use clep_mutate::{batch_mutation, migrate, mutation, mutation_coordinator, new_note, recode, reconcile, reference_repair, relabel};`), root `Cargo.toml`

**Interfaces:** `clep_mutate`; depends on `clep-vault`, `clep-index` (+config if demanded). The in-file tests in `batch_mutation.rs`/`mutation_coordinator.rs` use `clep_vault`'s failpoints → dev-dep `clep-vault = { workspace = true, features = ["test-failpoints"] }` and `clep-test-support`. Expected deps: rusqlite, tokio, parking_lot, utoipa, regex, blake3, walkdir, toml, serde, serde_json, chrono, uuid, thiserror, tracing.

- [ ] Steps as Task 2. Commit `build(clep-mutate): mutation planning, coordination and repair in their own crate`.

---

### Task 4: `clep-academic` and `clep-archive`

**Files:**
- Create: `crates/clep-academic/{Cargo.toml,src/lib.rs}`; move `src/vault/{academic,academic_hook,import,import_doi,import_isbn,import_zotero,checkpoint}.rs`; move `tests/{academic_http_test,checkpoint_test,import_test}.rs` → `crates/clep-academic/tests/`
- Create: `crates/clep-archive/{Cargo.toml,src/lib.rs}` with `[features] test-failpoints = []`; move `src/vault/{cas,cas_migrate,cas_scan,archive_hook,archive_snapshot,archive_backfill}.rs`
- Modify: `src/vault/mod.rs` (re-exports for both), root `Cargo.toml` (both deps; `test-failpoints = ["clep-vault/test-failpoints", "clep-archive/test-failpoints"]`; `[dev-dependencies] clep-archive = { workspace = true, features = ["test-failpoints"] }` for `backup.rs`'s tests)

**Interfaces:** `clep_academic` (deps clep-vault, clep-index; biblatex, reqwest, rusqlite, dirs, regex, unicode-normalization, utoipa, toml, serde, serde_json, chrono, uuid; dev tempfile, wiremock if the moved tests use it, clep-test-support). `clep_archive` (deps clep-vault, clep-index; fs4, lol_html, sha2, url, rusqlite, base64, parking_lot, pulldown-cmark, regex, walkdir, toml, tracing, uuid, chrono, thiserror; platform rustix/windows-sys; dev tempfile, clep-test-support). The two crates are independent; do archive first (gitsync needs it next), then academic.

- [ ] Steps as Task 2 for each; two commits: `build(clep-archive): content-addressed storage and archive hooks in their own crate`, `build(clep-academic): academic imports and hooks in their own crate`.

---

### Task 5: `clep-gitsync`

**Files:**
- Create: `crates/clep-gitsync/Cargo.toml` (`[features] test-support = ["dep:tempfile"]`; `tempfile = { workspace = true, optional = true }` in `[dependencies]` AND in `[dev-dependencies]`), `crates/clep-gitsync/src/lib.rs` (from `src/vault/gitsync/mod.rs`)
- Move `src/vault/gitsync/{config_writer,conflict_copy,engine,git,init,journal_merge,managed_block,merge_driver,state,testing}.rs` → `crates/clep-gitsync/src/`
- Modify: `src/vault/mod.rs` (`pub mod gitsync;` → `pub use clep_gitsync as gitsync;`), root `Cargo.toml` (`clep-gitsync` dep; `[dev-dependencies] clep-gitsync = { workspace = true, features = ["test-support"] }` because `src/sync_runtime.rs` and `src/doctor/sync.rs` tests use `gitsync::testing`)

**Interfaces:** `clep_gitsync`; `testing` becomes `#[cfg(any(test, feature = "test-support"))] pub mod testing;`. Depends on `clep-vault`, `clep-archive` (LFS init uses `cas::{blob_relative_path, list_blob_hashes}`), `clep-index` only if the compiler demands, `clep-config` if `Settings` is used. Expected deps: gethostname, reqwest, sha2, toml, toml_edit, serde, serde_json, chrono, uuid, thiserror, tracing, tokio, walkdir; dev: serial_test, wiremock, tempfile, clep-test-support. `merge_driver::run_cli` stays `pub` (the bin calls it).

- [ ] Steps as Task 2 (no integration tests move; `merge_driver_test` already lives in the bin). Commit `build(clep-gitsync): git-backed vault sync in its own crate`.

---

### Task 6: `clep-feeds`

**Files:**
- Create: `crates/clep-feeds/Cargo.toml` (`[features] test-failpoints = []`), `crates/clep-feeds/src/lib.rs` (from `src/feeds/mod.rs`)
- Move `src/feeds/{fetch,manifest,network,runtime,scheduler,store,types}.rs` → `crates/clep-feeds/src/`
- Modify: `src/lib.rs` (`pub mod feeds;` → `pub use clep_feeds as feeds;`), root `Cargo.toml` (`clep-feeds` dep; `test-failpoints` forwards to it too; `[dev-dependencies] clep-feeds = { workspace = true, features = ["test-failpoints"] }` for `backup.rs` and `api/feeds.rs` tests)

**Interfaces:** `clep_feeds`; depends on `clep-config` only (`crate::{FeatureFlags, FeedsSettings}` → `clep_config::…`; `crate::feeds::x` → `crate::x`). Expected deps: feed-rs, ammonia, quick-xml, reqwest, rusqlite, sha2, tokio, tokio-stream, parking_lot, axum (if `FeedRuntime` exposes axum types; otherwise not), serde, serde_json, chrono, thiserror, tracing; platform rustix; dev: wiremock, serial_test, tempfile, clep-test-support.

- [ ] Steps as Task 2. `tests/api_feeds.rs` stays (uses ApiFixture). Commit `build(clep-feeds): feed fetching, storage and scheduling in their own crate`.

---

### Task 7: `clep-lsp`

**Files:**
- Create: `crates/clep-lsp/Cargo.toml`, `crates/clep-lsp/src/lib.rs` (from `src/lsp/mod.rs`, plus `run_standalone`)
- Move `src/lsp/{code_action,completion,diagnostics,document,hover,queries,references,rename,state,symbols,test_support}.rs` → `crates/clep-lsp/src/`
- Move `tests/lsp_document_test.rs` → `crates/clep-lsp/tests/`
- Modify: `src/lib.rs` (delete `pub mod lsp;`, `run_lsp_standalone`, and `init_logging_stderr` if nothing else uses it), `crates/clep/src/main.rs` (`clepsydra::run_lsp_standalone()` → `clep_lsp::run_standalone()`), `crates/clep/Cargo.toml` (`clep-lsp` dep), root `Cargo.toml` (workspace path entry only — the root package does NOT depend on `clep-lsp`)

**Interfaces:** `clep_lsp::run_standalone()` = the old `run_lsp_standalone` (stderr logging init + `run_lsp().await`); `pub(crate) mod test_support` stays crate-private. Depends on `clep-config`, `clep-vault`, `clep-index`, `clep-bases`. Expected deps: tower-lsp, ropey, tokio, rusqlite, notify-debouncer-mini, pulldown-cmark, walkdir, toml, chrono, serde_json, tracing, tracing-subscriber; dev: serial_test, tempfile, clep-test-support. Ruling: `clep-api` does not depend on `clep-lsp` (the spec DAG has lsp as a sibling of api under the bin).

- [ ] Steps as Task 2, plus the bin wiring. Commit `build(clep-lsp): the language server in its own crate`.

---

### Task 8: `clep-doctor`

**Files:**
- Create: `crates/clep-doctor/Cargo.toml`, `crates/clep-doctor/src/lib.rs` (from `src/doctor/mod.rs`); move `src/doctor/sync.rs`
- Modify: `src/lib.rs` (delete `pub mod doctor;`), `crates/clep/src/main.rs` (`clepsydra::doctor::{self, DoctorOpts}` → `clep_doctor::{self, DoctorOpts}` and every `doctor::` call), `crates/clep/Cargo.toml` (`clep-doctor` dep), root `Cargo.toml` (workspace path entry; `[dev-dependencies] clep-doctor = { workspace = true }` only if `tests/frontmatter_migration.rs` cannot drop its `clepsydra::doctor` use — check first: if it only calls `doctor::run_with_cwd`, keep it and add the dev-dep; note it in the report)

**Interfaces:** `clep_doctor::{run, run_with_cwd, DoctorOpts, Report, …}` unchanged. Depends on `clep-config`, `clep-vault`, `clep-index`, `clep-bases`, `clep-mutate`, `clep-archive`, `clep-gitsync` (dev: with `test-support`). `crate::{Settings, VESSEL_ACCENT, TlsSettings}` → `clep_config::…`. Expected deps: axum-server, glob, walkdir, owo-colors, rusqlite, dirs, serde, serde_json, chrono, uuid, tokio; dev: serial_test, tempfile, clep-test-support. Ruling: `clep-api` does not depend on `clep-doctor` in `[dependencies]`.

- [ ] Steps as Task 2, plus the bin wiring. Commit `build(clep-doctor): clep doctor in its own crate`.

---

### Task 9: the remainder becomes `clep-api`

**Files:**
- Move: `src/` → `crates/clep-api/src/`; `tests/` → `crates/clep-api/tests/`; `examples/` → `crates/clep-api/examples/`
- Create: `crates/clep-api/Cargo.toml` = the root package's `[package]`, `[features]`, `[dependencies]`, `[dev-dependencies]`, `[target.*]`, `[lib]`/`[[example]]` sections with `name = "clep-api"`, `version.workspace = true`, `edition.workspace = true`, `publish = false`
- Modify: root `Cargo.toml` → only `[workspace]` (`members = ["crates/*"]`, `resolver` as today; drop `default-members` — a virtual workspace defaults to all members), `[workspace.package]`, `[workspace.dependencies]` (replace `clepsydra = { path = "." }` with `clep-api = { path = "crates/clep-api" }`), `[profile.*]` if present; `crates/clep/Cargo.toml`, `crates/clep-mcp/Cargo.toml` (`clepsydra` → `clep-api`); every `clepsydra::` path in `crates/clep/src`, `crates/clep/tests`, `crates/clep-mcp/src`, `crates/clep-api/tests`, `crates/clep-api/examples` → `clep_api::`; `crates/clep-api/src/lib.rs` crate doc names the crate
- Relative paths that change depth: `crates/clep-api/tests/e2e_encryption_test.rs` `include_str!("../ui/…")` → `"../../../ui/…"`; `crates/clep-api/tests/docs_api_coverage_test.rs` reads `ui/src/docs/content/api-reference.mdx` relative to cwd → `Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/src/docs/content/api-reference.mdx")` (cargo sets cwd to the package dir); `crates/clep-mcp/src/lib.rs` eval fixture `../../tests/mcp_evals/vault` → `../clep-api/tests/mcp_evals/vault`; grep `CARGO_MANIFEST_DIR|include_str!|"ui/|"tests/` across the moved tree for any other
- Docs/tooling: `CLAUDE.md` offline OpenAPI command → `cargo run -q -p clep-api --example openapi …`; `.github/workflows/ci.yml` needs no change if `cargo test --locked` at the virtual root still builds all members (verify: `cargo test --no-run 2>&1 | grep -c Executable` equals the `--workspace` count); `Justfile` `cargo test --quiet` likewise; `scripts/*.sh` use `--manifest-path "$repo/Cargo.toml" --bin clep` (still valid — verify `cargo build --bin clep` from the root resolves)

**Interfaces:** `clep_api` exposes exactly what `clepsydra` did (`Settings` re-exports, `build_app_state`, `build_router`, `run_server`, `open_vault`, `open_vault_and_index`, `run_startup_reconcile`, `api`, `backup`, `deeplink`, `sync_runtime`, `vault` (the shim: `geocode` + re-exports of the eight vault-side crates), `feeds` (re-export)). Ruling: the `vault` shim stays inside `clep-api`; rewriting `crate::vault::…` paths across api/lib to direct crate paths is a follow-up, not this phase.

- [ ] Step 1: moves + manifests. `cargo check --locked --workspace --all-targets` → 0.
- [ ] Step 2: path fixes above; `cargo test --locked -p clep-api --test e2e_encryption_test --test docs_api_coverage_test`, `cargo test --locked -p clep-mcp` → pass.
- [ ] Step 3: verify `cargo tree -e normal -i clep-api` lists only `clep` and `clep-mcp`; `cargo tree -p clep-api -e normal | grep clep-` lists the crates the DAG allows (config, vault, index, bases, mutate, academic, archive, gitsync, feeds, client? — never lsp/doctor/frontend-assets); `grep -rn "clepsydra" crates/ --include='*.rs' --include='*.toml'` → only string literals/docs (e.g. `.clepsydra/` dirs, clap's display name); gates; commit `build(clep-api): the server library moves under crates/; the root is a virtual workspace`.

---

### Task 10: Docs, measurement, sweep

**Files:** `docs/superpowers/specs/2026-09-09-crate-split-design.md`, `CLAUDE.md`, live docs (`docs/design-notes/`, `ui/src/docs/content/`, `extension/`, `nvim/`), code comments.

- [ ] **Step 1: Measure.** With a warm target dir: `cargo clean -p clep-api && time cargo check`; `… cargo build`; `… cargo test --no-run`; for each of the eight new crates `cargo clean -p <crate> && time cargo test -p <crate>`; `cargo clean` of all seventeen `clep*` packages then `time cargo build`. Foreground, 600000 ms, log files, exit codes.
- [ ] **Step 2: Spec.** §1: Phase 3 table (remainder = clep-api). §2: final table and DAG reflecting the rulings (clep-api ↛ lsp/doctor/frontend-assets; bin → api, lsp, doctor, mcp, frontend-assets, client, config; gitsync deps as measured; feature notes). §3: the three test-support seams (archive/feeds `test-failpoints`, gitsync `test-support`) and the scheduler-test move. §4: "Phase 3 — landed <date> on branch feature/crate-split-phase3". §5: the placement rulings above as the final table. Status: "All phases landed; merged to develop <sha> — see §1 for the final numbers".
- [ ] **Step 3: CLAUDE.md.** Rewrite Project Overview / Build & Development Commands / Architecture for the final layout: the workspace is seventeen crates under `crates/` (list each with one clause); there is no root package; `crates/clep-api/src/` holds the HTTP API and bootstrap; `cargo test -p <crate>`; the offline OpenAPI command; install via `cargo install --path crates/clep`.
- [ ] **Step 4: Sweep.** `grep -rn "src/\(api\|lsp\|doctor\|feeds\|vault\|lib\.rs\|sync_runtime\|deeplink\|backup\|bin\)" CLAUDE.md CONTEXT.md docs/design-notes docs/adr ui/src/docs/content extension nvim scripts Justfile .github 2>/dev/null` and the same over `crates/**/*.rs` comments and `ui/src/**/*.ts{,x}` comments; rewrite every hit that names a moved file to its new path (`crates/clep-api/src/…` or the crate that owns it). Never `docs/plans/`, `docs/superpowers/plans/`, `_features/`. List every file touched.
- [ ] **Step 5: Gates, commit** `docs: workspace layout after crate split phase 3`.
