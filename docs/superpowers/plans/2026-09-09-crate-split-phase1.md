# Crate Split — Phase 1 (workspace skeleton + edge crates) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single `clepsydra` package into a Cargo workspace and peel off the crates with the smallest surfaces: `clep-test-support`, `clep-config`, the `clep` bin, `clep-client`, `clep-mcp`, `clep-frontend-assets`.

**Architecture:** The root package stays named `clepsydra` and keeps everything not yet extracted (vault, index, mutation, features, api, feeds, lsp, doctor); at the end of Phase 3 it is renamed `clep-api` and moved under `crates/` in one commit. Every new crate lives at `crates/clep-*`, uses `[workspace.dependencies]`, and is a leaf or near-leaf. Extraction order is forced by one cycle: the `clep` bin is a target of the `clepsydra` package today, so it must become its own crate before `clep-mcp` (which depends on `clepsydra`) can exist.

**Tech Stack:** Cargo workspaces (`[workspace.dependencies]`, `default-members`), Rust 2024. No new external dependencies.

**Spec:** `docs/superpowers/specs/2026-09-09-crate-split-design.md` (§2 layout, §4 Phase 1, §5 test placement). Two rulings amend it (Task 7 records them): root package stays `clepsydra` until Phase 3; `backup.rs` stays in the lib.

## Global Constraints

- No behaviour change observable through the HTTP API, CLI output, or OpenAPI document. `ui/src/api/schema.d.ts` must not change. `clep --help` output is byte-identical (`tests/docs_cli_coverage_test.rs` guards it).
- No new external dependencies. Every crate's `[dependencies]` entries use `{ workspace = true }` against the root `[workspace.dependencies]` table; add a dependency to a crate only when the compiler demands it.
- Every new crate: `[package] name = "clep-…"`, `version.workspace = true`, `edition.workspace = true`, `publish = false`, `license.workspace = true` if the root defines one.
- Gates after every task, from the repo root: `cargo fmt --all -- --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, `cargo test --locked --workspace --no-fail-fast -- --test-threads=4`. Run the suite in the foreground with a 10-minute timeout, redirect to a log file, read cargo's own exit code. Do not pipe cargo through `tail`. Unset `CLEPSYDRA__VAULT__ROOT` first.
- `Cargo.lock` changes are expected (new packages) and are committed with the task.
- Never run `clep` or `cargo run` without `CLEPSYDRA__VAULT__ROOT` pointing at a scratch dir.
- Worktree `.worktrees/crate-split-1`, branch `feature/crate-split-phase1`, off `develop`. `ui/dist` must exist in the worktree.
- Stage explicit paths (`git add` / `git mv`); `git add .` is intercepted by the user's shell. No attribution trailers.

---

### Task 1: Workspace root and `clep-test-support`

**Files:**
- Modify: `Cargo.toml` (root)
- Create: `crates/clep-test-support/Cargo.toml`, `crates/clep-test-support/src/lib.rs`
- Modify: `src/lib.rs` (delete `mod env_test_support`, ~:1298-1336), and every user: `src/sync_runtime.rs`, `src/doctor/sync.rs`, `src/doctor/mod.rs`, `src/lsp/state.rs`, `src/todo_capture.rs`, `src/vault/gitsync/git.rs`, `src/vault/gitsync/testing.rs`, the `settings_tests` module in `src/lib.rs`

**Interfaces:**
- Produces: root `[workspace]` with `members = ["crates/*"]`, `default-members = [".", "crates/*"]`, `[workspace.package] version = "0.0.0"`, `edition = "2024"`, and `[workspace.dependencies]` holding every dependency and dev-dependency currently in the root package with its version and features.
- Produces: crate `clep-test-support` exporting `pub struct EnvGuard` with `pub fn set(key: &'static str, value: impl AsRef<OsStr>) -> Self` and `pub fn remove(key: &'static str) -> Self` (moved verbatim from `src/lib.rs`, `pub(crate)` → `pub`, no `cfg(test)`).

- [ ] **Step 1: Write the failing check**

Create `crates/clep-test-support/src/lib.rs` with only a doc comment and this test, then confirm it does not compile until the struct exists:

```rust
//! Test-only helpers shared by every crate's test suite. Dev-dependency only.

#[cfg(test)]
mod tests {
    use super::EnvGuard;

    #[test]
    fn guard_restores_prior_value_on_drop() {
        let key = "CLEP_TEST_SUPPORT_PROBE";
        // SAFETY: single-threaded test, unique key.
        unsafe { std::env::set_var(key, "before") };
        {
            let _g = EnvGuard::set(key, "during");
            assert_eq!(std::env::var(key).unwrap(), "during");
        }
        assert_eq!(std::env::var(key).unwrap(), "before");
        {
            let _g = EnvGuard::remove(key);
            assert!(std::env::var_os(key).is_none());
        }
        assert_eq!(std::env::var(key).unwrap(), "before");
        unsafe { std::env::remove_var(key) };
    }
}
```

- [ ] **Step 2: Workspace root**

Rewrite the root `Cargo.toml`:
- Keep `[package] name = "clepsydra"`, switch `version` and `edition` to `.workspace = true`.
- Add:
  ```toml
  [workspace]
  members = ["crates/*"]
  default-members = [".", "crates/*"]

  [workspace.package]
  version = "0.0.0"
  edition = "2024"
  ```
- Move every `[dependencies]`, `[target.'cfg(windows)'.dependencies]` and `[dev-dependencies]` entry's version + features into `[workspace.dependencies]`; the package sections become `name = { workspace = true }` (windows-sys stays under its target table, still `workspace = true`). Keep `[[bin]]`, `[features]`.
- Add `clep-test-support = { path = "crates/clep-test-support" }` to `[workspace.dependencies]` and to the root `[dev-dependencies]`.

`crates/clep-test-support/Cargo.toml`:
```toml
[package]
name = "clep-test-support"
version.workspace = true
edition.workspace = true
publish = false

[dependencies]
```

Run: `cargo metadata --format-version 1 --no-deps | python3 -c "import json,sys; print([p['name'] for p in json.load(sys.stdin)['packages']])"`
Expected: `['clepsydra', 'clep-test-support']`.

- [ ] **Step 3: Move `EnvGuard`**

Cut the `env_test_support` module body from `src/lib.rs` into `crates/clep-test-support/src/lib.rs` (struct + both impls, `pub`, doc comments intact, no `#[cfg(test)]`). Replace every `crate::env_test_support::EnvGuard` (and `use crate::env_test_support::EnvGuard;`) in the files listed above with `clep_test_support::EnvGuard`.

Run: `cargo test -p clep-test-support` → 1 passed. `grep -rn env_test_support src` → empty.

- [ ] **Step 4: Gates, commit**

Full gates. Expected: pass; `cargo test --no-run` output lists the `clep_test_support` unit-test executable alongside the existing 60.

```bash
git add Cargo.toml Cargo.lock crates/clep-test-support src/lib.rs src/sync_runtime.rs src/doctor/sync.rs src/doctor/mod.rs src/lsp/state.rs src/todo_capture.rs src/vault/gitsync/git.rs src/vault/gitsync/testing.rs
git commit -m "build: cargo workspace root; EnvGuard lives in clep-test-support"
```

---

### Task 2: `clep-config`

**Files:**
- Create: `crates/clep-config/Cargo.toml`, `crates/clep-config/src/lib.rs`, `crates/clep-config/src/app_config.rs` (moved from `src/app_config.rs`)
- Modify: `src/lib.rs` (remove the settings block :56-~460 and `mod settings_tests`; add re-exports), `src/vault/config.rs` (`expand_tilde` moves out; import it), `src/vault/cas_migrate.rs`, `src/doctor/mod.rs`, `src/mcp/mod.rs`, `src/lsp/state.rs`, `src/config_command.rs`, `src/new_note_command.rs`, `src/bin/cli.rs`, `src/feeds/runtime.rs` (any `crate::FeedsSettings`)

**Interfaces:**
- Produces crate `clep-config` (`clep_config`) with, all `pub`: `Settings`, `FeatureFlags`, `FeedsSettings`, `ServerSettings`, `TlsSettings`, `ServeOverrides`, `VaultSettings`, `Settings::load`, `Settings::load_from`, `resolve_vault_root`, `default_tls_paths`, `expand_tilde`, `INDEX_DB_RELATIVE`, `VESSEL_ACCENT`, and module `app_config` with `config_candidates`, `find_config_path`, `config_candidates_with_env`, `find_config_path_with_env` (the last two widen from `pub(crate)`). `resolve_config_path` stays private inside the crate.
- `src/lib.rs` keeps every old path alive: `pub use clep_config::{Settings, FeatureFlags, FeedsSettings, ServerSettings, TlsSettings, ServeOverrides, VaultSettings, resolve_vault_root, default_tls_paths, expand_tilde, INDEX_DB_RELATIVE, VESSEL_ACCENT}; pub use clep_config::app_config;` so `clepsydra::Settings`, `crate::FeatureFlags`, `clepsydra::app_config::…` and `crate::expand_tilde` all still resolve.

- [ ] **Step 1: Create the crate with its tests first**

`crates/clep-config/Cargo.toml`:
```toml
[package]
name = "clep-config"
version.workspace = true
edition.workspace = true
publish = false

[dependencies]
config = { workspace = true }
dirs = { workspace = true }
serde = { workspace = true }
tracing = { workspace = true }

[dev-dependencies]
clep-test-support = { workspace = true }
tempfile = { workspace = true }
serial_test = { workspace = true }
```
(Drop `tracing` if nothing in the moved code logs; add `toml` only if `app_config.rs` needs it. Take versions only from the workspace table.)

Move `mod settings_tests` from `src/lib.rs` into `crates/clep-config/src/lib.rs` as `#[cfg(test)] mod tests` first, replacing `crate::env_test_support::EnvGuard` with `clep_test_support::EnvGuard`.

Run: `cargo test -p clep-config` → compile errors (`Settings` etc. not found). That is the RED.

- [ ] **Step 2: Move the settings block**

Cut from `src/lib.rs` into `crates/clep-config/src/lib.rs`: `INDEX_DB_RELATIVE` (make it `pub`), `VESSEL_ACCENT`, `Settings` … `VaultSettings` with all `impl`s and `const fn` defaults, `impl Settings { load, load_from }`, `resolve_config_path`, `resolve_vault_root`, `default_tls_paths`. Add `pub mod app_config;` (file moved with `git mv src/app_config.rs crates/clep-config/src/app_config.rs`). Move `expand_tilde` from `src/vault/config.rs` into `clep-config`'s lib.rs (`pub fn`); `src/vault/config.rs` gets `use clep_config::expand_tilde;` and `src/vault/cas_migrate.rs` uses `clep_config::expand_tilde`. Root `Cargo.toml` gains `clep-config = { workspace = true }` under `[dependencies]` (and the path entry under `[workspace.dependencies]`).

In `src/lib.rs` add the re-export block from Interfaces and delete `pub mod app_config;`, the `use app_config::…` and `use config::…`/`use serde::Deserialize` lines if now unused. Fix `crate::{ServerSettings, …}` imports in doctor, mcp, lsp, config_command, new_note_command and `src/feeds/runtime.rs` either by leaving them (the re-exports keep them valid) or by pointing them at `clep_config::…`; leave them unless clippy complains.

Run: `cargo test -p clep-config` → the moved settings tests pass. `grep -n 'struct Settings\|fn resolve_vault_root\|fn default_tls_paths\|fn expand_tilde' src/lib.rs src/vault/config.rs` → empty.

- [ ] **Step 3: Gates, commit**

Full gates. Expected: pass, including `tests/docs_cli_coverage_test.rs` and the lib's `tests` module (which still uses `Settings` via the re-export).

```bash
git add Cargo.toml Cargo.lock crates/clep-config src/lib.rs src/vault/config.rs src/vault/cas_migrate.rs src/doctor/mod.rs src/mcp/mod.rs src/lsp/state.rs src/config_command.rs src/new_note_command.rs src/bin/cli.rs src/feeds/runtime.rs
git commit -m "build(clep-config): settings, config lookup and tilde expansion in their own crate"
```

---

### Task 3: The `clep` bin crate

**Files:**
- Create: `crates/clep/Cargo.toml`, `crates/clep/src/main.rs` (from `src/bin/cli.rs`), `crates/clep/src/{sync_command,config_command,macos_url_handler,new_note_command}.rs` (moved from `src/`), `crates/clep/tests/{merge_driver_test,docs_cli_coverage_test,macos_url_handler_test}.rs` (moved from `tests/`)
- Modify: root `Cargo.toml` (remove `[[bin]]`, remove `clap`/`anstream` from the package deps if now unused), `src/lib.rs` (remove the four `pub mod` lines)
- Stays in the lib: `src/backup.rs` (its tests use `cfg(test)` barriers inside `vault::cas` and `feeds::store`), `run_lsp_standalone`, `open_vault`, `open_vault_and_index`, `run_server`, `deeplink`, `doctor`.

**Interfaces:**
- Produces package `clep` with a single bin target; `crates/clep/src/main.rs` declares `mod sync_command; mod config_command; mod macos_url_handler; mod new_note_command;` and uses `clepsydra::…` for everything else. Its `Cargo.toml`:
  ```toml
  [package]
  name = "clep"
  version.workspace = true
  edition.workspace = true
  publish = false

  [[bin]]
  name = "clep"
  path = "src/main.rs"

  [dependencies]
  clepsydra = { workspace = true }
  clep-config = { workspace = true }
  clap = { workspace = true }
  anstream = { workspace = true }
  owo-colors = { workspace = true }
  tokio = { workspace = true }
  chrono = { workspace = true }
  serde = { workspace = true }
  serde_json = { workspace = true }
  thiserror = { workspace = true }
  toml = { workspace = true }
  dirs = { workspace = true }
  tempfile = { workspace = true }
  percent-encoding = { workspace = true }

  [dev-dependencies]
  clep-test-support = { workspace = true }
  serial_test = { workspace = true }
  wiremock = { workspace = true }
  url = { workspace = true }
  ```
  (Prune entries the compiler never asks for; add `clepsydra = { path = "." }` under `[workspace.dependencies]` in the root.)
- The moved modules' `crate::` paths become `clepsydra::` (e.g. `clepsydra::api::sync::{SyncReportDto, SyncStatusDto}`, `clepsydra::mcp::client::…`, `clepsydra::mcp::configured_api_client`, `clepsydra::vault::gitsync::…`, `clepsydra::open_vault`, `clep_config::VESSEL_ACCENT`, `clep_config::app_config::…`).

- [ ] **Step 1: Move the binary target**

```bash
mkdir -p crates/clep/src crates/clep/tests
git mv src/bin/cli.rs crates/clep/src/main.rs
git mv src/sync_command.rs src/config_command.rs src/macos_url_handler.rs src/new_note_command.rs crates/clep/src/
git mv tests/merge_driver_test.rs tests/docs_cli_coverage_test.rs tests/macos_url_handler_test.rs crates/clep/tests/
```
Write `crates/clep/Cargo.toml`; remove `[[bin]]` from the root manifest; delete the four `pub mod` lines from `src/lib.rs`. In `main.rs` add the four `mod` declarations and change `clepsydra::sync_command::…`/`config_command`/`macos_url_handler`/`new_note_command` paths to `sync_command::…` etc. In the moved modules replace `crate::` with `clepsydra::` except for `crate::VESSEL_ACCENT` → `clep_config::VESSEL_ACCENT` and `crate::app_config` → `clep_config::app_config`. In the moved tests `clepsydra::macos_url_handler::…` → `clep::…` is not possible for a bin; `macos_url_handler_test.rs` instead becomes an in-file `#[cfg(test)]` module inside `crates/clep/src/macos_url_handler.rs` (move its two tests there; delete the file).

Run: `cargo build -p clep` and `cargo test -p clep --no-run`. Expected: builds; test binaries for `merge_driver_test`, `docs_cli_coverage_test` and the bin's unit tests exist. `ls target/debug/clep` exists.

- [ ] **Step 2: Prove `CARGO_BIN_EXE_clep` still resolves**

Run: `cargo test -p clep --test docs_cli_coverage_test` and `cargo test -p clep --test merge_driver_test`. Expected: pass (both spawn `env!("CARGO_BIN_EXE_clep")`, which only exists for tests inside the package that owns the bin).

- [ ] **Step 3: Gates, commit**

Full gates. Also `cargo run -p clep -- --help` with `CLEPSYDRA__VAULT__ROOT=/tmp/x` set prints the usage.

```bash
git add Cargo.toml Cargo.lock crates/clep src/lib.rs
git commit -m "build(clep): the CLI is its own crate"
```

---

### Task 4: `clep-client`

**Files:**
- Create: `crates/clep-client/Cargo.toml`, `crates/clep-client/src/lib.rs`, `crates/clep-client/src/client.rs` (from `src/mcp/client.rs`), `crates/clep-client/src/todo_capture.rs` (from `src/todo_capture.rs`)
- Modify: `src/mcp/mod.rs` (drop `client`, `configured_api_client`, `base_url`, `load_tls_root_cert`, `host_is_loopback`; import from `clep_client`), `src/mcp/server.rs`/`tasking.rs` (`use crate::mcp::client::…` → `clep_client::…`), `src/lib.rs` (remove `pub mod todo_capture;`), `crates/clep/src/main.rs` and `crates/clep/src/sync_command.rs` (`clepsydra::mcp::client` → `clep_client::client`, `clepsydra::mcp::configured_api_client` → `clep_client::configured_api_client`, `clepsydra::todo_capture` → `clep_client::todo_capture`), root `Cargo.toml`

**Interfaces:**
- Produces crate `clep-client` (`clep_client`): `pub mod client` (`ApiClient`, `ApiCallError`, `encode_vault_path`, `api_error_message` now `pub`), `pub mod todo_capture` (`capture_todo`, its error type), and at the root `pub fn configured_api_client(base_dir: &Path, allow_remote: bool) -> Result<ApiClient, Box<dyn std::error::Error>>` plus `pub(crate)` `base_url`, `load_tls_root_cert`, `host_is_loopback` (with their existing tests moved along). Depends on `clep-config`, `reqwest`, `percent-encoding`, `serde_json`, `thiserror`, `chrono`. Dev: `clep-test-support`, `tokio`, `wiremock`, `serial_test`, `tempfile`.
- `clepsydra` (lib) gains `clep-client = { workspace = true }` because `src/mcp/` still uses it until Task 5.

- [ ] **Step 1: Move and re-point**

```bash
mkdir -p crates/clep-client/src
git mv src/mcp/client.rs crates/clep-client/src/client.rs
git mv src/todo_capture.rs crates/clep-client/src/todo_capture.rs
```
Write `crates/clep-client/src/lib.rs` = the helpers cut from `src/mcp/mod.rs` (`host_is_loopback`, `base_url`, `load_tls_root_cert`, `configured_api_client`) with `use clep_config::{ServerSettings, Settings, TlsSettings, default_tls_paths};`, `pub mod client; pub mod todo_capture;`, and the `mod tests` from `src/mcp/mod.rs` that exercise those helpers (leave `run_mcp`'s tests behind). In `todo_capture.rs`: `crate::mcp::client` → `crate::client`, `crate::mcp::configured_api_client` → `crate::configured_api_client`. `src/mcp/mod.rs` keeps only `mod edit; pub mod server; pub mod tasking;`, `run_mcp`, and `use clep_client::{client::ApiClient, configured_api_client};`.

Run: `cargo test -p clep-client` → the client and todo_capture tests pass; `grep -rn 'mcp::client\|todo_capture' src crates/clep/src` shows only `clep_client::` paths.

- [ ] **Step 2: Gates, commit**

```bash
git add Cargo.toml Cargo.lock crates/clep-client src/mcp src/lib.rs crates/clep
git commit -m "build(clep-client): HTTP client and todo capture in their own crate"
```

---

### Task 5: `clep-mcp`

**Files:**
- Create: `crates/clep-mcp/Cargo.toml`, `crates/clep-mcp/src/lib.rs` (from `src/mcp/mod.rs`), `crates/clep-mcp/src/{server,tasking,edit}.rs` (moved)
- Modify: `src/lib.rs` (remove `pub mod mcp;`), `crates/clep/src/main.rs` (`clepsydra::mcp::run_mcp` → `clep_mcp::run_mcp`), root `Cargo.toml` (drop `rmcp`, `schemars` and `clep-client` from the lib's deps if nothing else uses them; `cargo tree -p clepsydra -e normal | grep -c rmcp` should be 0 afterwards)

**Interfaces:**
- Produces crate `clep-mcp` (`clep_mcp`): `pub async fn run_mcp(allow_remote: bool) -> Result<(), Box<dyn std::error::Error>>`, `pub mod server`, `pub mod tasking`. Normal deps: `clep-client`, `clep-config`, `clepsydra` (for `vault::{kind::Kind, code::{CodeLookup, resolve_prefix}, page_filename::page_filename, block_id::generate_short_id}` — swapped to `clep-vault` in Phase 2), `rmcp`, `schemars`, `serde`, `serde_json`, `uuid`, `chrono`, `tokio`. Dev: `clep-test-support`, `axum`, `tempfile`, `walkdir`, `tokio`, `serial_test` as the compiler asks (its tests call `clepsydra::build_app_state`, `clepsydra::build_router`, `clepsydra::api::archive::ArchiveViewConfig`, `clepsydra::vault::init::init_vault`).
- No cycle: `clepsydra` must not list `clep-mcp`; only `crates/clep` does.

- [ ] **Step 1: Move**

```bash
mkdir -p crates/clep-mcp/src
git mv src/mcp/mod.rs crates/clep-mcp/src/lib.rs
git mv src/mcp/server.rs src/mcp/tasking.rs src/mcp/edit.rs crates/clep-mcp/src/
```
Replace `crate::vault::` with `clepsydra::vault::`, `crate::build_app_state`/`build_router`/`api::` with `clepsydra::…` in the moved files. `run_mcp` stays in `lib.rs`. Delete `pub mod mcp;` from `src/lib.rs`; point `crates/clep/src/main.rs` at `clep_mcp::run_mcp` and add `clep-mcp = { workspace = true }` to `crates/clep/Cargo.toml`.

Run: `cargo test -p clep-mcp` → all in-module MCP tests pass. `cargo tree -p clepsydra -e normal -i rmcp` → "package ID specification `rmcp` did not match" (i.e. the lib no longer depends on it).

- [ ] **Step 2: Gates, commit**

```bash
git add Cargo.toml Cargo.lock crates/clep-mcp crates/clep src/lib.rs
git commit -m "build(clep-mcp): MCP server in its own crate"
```

---

### Task 6: `clep-frontend-assets`

**Files:**
- Create: `crates/clep-frontend-assets/Cargo.toml`, `crates/clep-frontend-assets/src/lib.rs` (from `src/api/frontend.rs`)
- Modify: `src/api/mod.rs` (remove `pub mod frontend;`), `src/lib.rs` (`api::frontend::frontend_router()` → `clep_frontend_assets::frontend_router()`), root `Cargo.toml` (drop `rust-embed`, `mime_guess` from the lib if unused elsewhere — `mime_guess` is still used by `src/api/attachments.rs`, so it stays)

**Interfaces:**
- Produces crate `clep-frontend-assets` (`clep_frontend_assets`): `pub fn frontend_router<S>() -> Router<S>` unchanged; `#[folder = "../../ui/dist/"]` (relative to the crate's manifest). Deps: `axum`, `rust-embed`, `mime_guess`. Its three existing tests move with it.

- [ ] **Step 1: Move**

```bash
mkdir -p crates/clep-frontend-assets/src
git mv src/api/frontend.rs crates/clep-frontend-assets/src/lib.rs
```
Change the folder attribute to `"../../ui/dist/"`. Remove `pub mod frontend;` from `src/api/mod.rs`; update `src/lib.rs`; add the dependency to the root package.

Run: `cargo test -p clep-frontend-assets` → 3 passed. `cargo build -p clepsydra` → unchanged behaviour.

- [ ] **Step 2: Prove the release-build isolation**

Run: `cargo build --release -p clep 2>&1 | tail -1; touch ui/dist/index.html; cargo build --release -p clep 2>&1 | grep -c 'Compiling clepsydra'`
Expected: the second build recompiles `clep-frontend-assets` and relinks `clep` but prints no `Compiling clepsydra` line. Record the two build times in the report.

- [ ] **Step 3: Gates, commit**

```bash
git add Cargo.toml Cargo.lock crates/clep-frontend-assets src/api/mod.rs src/lib.rs
git commit -m "build(clep-frontend-assets): embedded UI in its own crate"
```

---

### Task 7: Docs, CI check, measurement

**Files:**
- Modify: `CLAUDE.md` (Build & Development Commands, Architecture), `docs/superpowers/specs/2026-09-09-crate-split-design.md` (§1 timings, §2 root-package ruling, §3.4 backup ruling, §4 Phase 1 status), `.github/workflows/ci.yml` (only if Step 1 shows a gap)

- [ ] **Step 1: CI parity**

From the repo root run exactly the CI commands: `cargo clippy --locked --all-targets -- -D warnings` and `cargo test --locked --no-fail-fast -- --test-threads=4` (no `--workspace`). Expected: they cover every crate because `default-members` includes `crates/*`; confirm with `cargo test --no-run 2>&1 | grep -c Executable` equal to the `--workspace` count. If not, add `--workspace` to both CI lines.

- [ ] **Step 2: Measure**

```bash
cargo clean -p clepsydra -p clep -p clep-config -p clep-client -p clep-mcp -p clep-frontend-assets -p clep-test-support
/usr/bin/time -p cargo build 2>&1 | tail -3
cargo clean -p clep-mcp && /usr/bin/time -p cargo test -p clep-mcp --no-run 2>&1 | tail -3
cargo clean -p clep-config && /usr/bin/time -p cargo test -p clep-config 2>&1 | tail -3
```
Add a "Phase 1" row set under §1's table in the spec with the wall times, next to the Phase 0 baseline (check 8.5 s, build 42 s, test --no-run 107 s).

- [ ] **Step 3: Docs**

`CLAUDE.md`: under Build & Development Commands add "**Workspace:** the root package `clepsydra` holds the server library; `crates/clep` is the CLI binary, `crates/clep-*` are extracted crates. `cargo test` at the root covers every crate." Change the offline OpenAPI command to `cargo run -q -p clepsydra --example openapi …`. In Architecture, note `crates/clep/src/main.rs` is the clap dispatch (replacing `src/bin/cli.rs`) and that `mcp/`, `todo_capture`, `app_config` live in `crates/clep-mcp`, `crates/clep-client`, `crates/clep-config`.

Spec: §2 add "Root package: `clepsydra` stays at the repo root as the not-yet-split remainder through Phase 3, then becomes `crates/clep-api`"; §3.4 change the `backup.rs` sentence to "`backup.rs` stays in the lib (its tests use `cfg(test)` barriers in `vault::cas` and `feeds::store`); the bin calls `clepsydra::backup::create_backup`"; §4 Phase 1 line gets "— landed <date>"; **Status:** line updated.

- [ ] **Step 4: Gates, commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-09-crate-split-design.md .github/workflows/ci.yml
git commit -m "docs: workspace layout after crate split phase 1"
```
