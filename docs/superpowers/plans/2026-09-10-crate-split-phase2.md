# Crate Split Phase 2 — `clep-vault` and `clep-index` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the bottom two layers out of the `clepsydra` remainder: `crates/clep-vault` (vault model + `Vault` handle, ~10.1k lines) and `crates/clep-index` (SQLite index, derivation, fs sync, ~10.2k lines), moving their integration tests with them, with no observable behaviour change.

**Architecture:** Both crates are physical moves of module files that already form clean sets (verified 2026-09-10 by scanning every `crate::`/`super::` reference in production code: the vault set references nothing outside itself and `clep_config`; the index set has exactly one upward edge, `index.rs:806` → `reconcile`). The remainder's `src/vault/mod.rs` keeps every public path alive by re-exporting the moved modules (`pub use clep_vault::{path, page, …}; pub use clep_index::{index, …};`), so nothing outside the two crates needs a path rewrite. The only source edits outside the moves are: inlining the one upward edge, relocating one bases-aware test module, and widening `pub(crate)` items that the boundary now crosses.

**Tech Stack:** Cargo workspace (Phase 1 layout), rusqlite, notify-debouncer-mini, tokio, pulldown-cmark. No new external dependencies.

**Spec:** `docs/superpowers/specs/2026-09-09-crate-split-design.md` (§2 table rows `clep-vault`, `clep-index`; §3 seams; §4 Phase 2; §5 test placement). The spec is the authority; rulings recorded in the ledger where the plan departs from it.

## Global Constraints

- No behaviour change observable through the HTTP API, CLI output, or OpenAPI document. `ui/src/api/schema.d.ts` must not change. `clep --help` output is byte-identical (`crates/clep/tests/docs_cli_coverage_test.rs` guards it).
- No new external dependencies. Every crate's `[dependencies]` entries use `{ workspace = true }` against the root `[workspace.dependencies]` table; add a dependency to a crate only when the compiler demands it. Platform-specific deps (`rustix`, `windows-sys`) keep their `[target.'cfg(...)'.dependencies]` tables, still `{ workspace = true }`.
- Every new crate: `[package] name = "clep-…"`, `version.workspace = true`, `edition.workspace = true`, `publish = false`.
- Existing public paths keep resolving: `clepsydra::vault::<module>::<item>` for every moved module, and `clepsydra::vault::Vault`. The remainder (`src/api`, `src/lsp`, `src/doctor`, `src/feeds`, `src/lib.rs`, `crates/clep`, `crates/clep-mcp`, `tests/`) is edited only where a `pub(crate)` item became cross-crate (widen to `pub`, add a one-line doc `/// Public for the workspace split; not part of the stable API.`).
- No dependency cycles: `clep-vault` depends on `clep-config` only; `clep-index` on `clep-vault` (+ `clep-config` if the compiler demands); neither depends on `clepsydra`, not even as a dev-dependency. Tests that would need the remainder stay in the remainder.
- Gates after every task, from the worktree root: `cargo fmt --all -- --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, `cargo test --locked --workspace --no-fail-fast -- --test-threads=4`. Run the suite in the foreground with a 10-minute timeout, redirect to a log file, read cargo's own exit code. Do not pipe cargo through `tail`. Unset `CLEPSYDRA__VAULT__ROOT` first.
- `Cargo.lock` changes are expected (new packages) and are committed with the task.
- Never run `clep` or `cargo run` without `CLEPSYDRA__VAULT__ROOT` pointing at a scratch dir.
- Worktree `.worktrees/crate-split-2`, branch `feature/crate-split-phase2`, off `develop` (f0013f63 or later). `ui/dist` must exist in the worktree (copy from the main checkout).
- Stage explicit paths (`git add` / `git mv`); `git add .` is intercepted by the user's shell. No attribution trailers. No `git stash`.

---

### Task 1: Seams before the cut

Make the two module sets self-contained while still one crate, so Tasks 2–3 are pure moves.

**Files:**
- Modify: `src/vault/index.rs` (line ~806 and the `linkable_epoch_tests` module at ~3712–3892)
- Create: `tests/linkable_epoch_test.rs`
- Modify (visibility only): `src/vault/atomic_file.rs`, `src/vault/keyring.rs`, `src/vault/link.rs`, `src/vault/rubbish.rs`, `src/vault/task_history.rs`, `src/vault/index.rs`, `src/vault/index_policy.rs`, `src/vault/reference_issues.rs`, `src/vault/sync/mod.rs`

**Interfaces:**
- Produces: `VaultIndex::build_index` (or whichever method holds line 806) no longer calls `reconcile`; `linkable_epoch_tests` live as an integration test; the items listed in Step 3 are `pub`.

- [ ] **Step 1: Inline the upward edge**

In `src/vault/index.rs` the only production reference from the index set to a higher layer is:

```rust
        super::reconcile::reconcile_rubbish_catalog(vault, self)?;
```

`src/vault/reconcile.rs:17-20` is a two-line wrapper:

```rust
pub fn reconcile_rubbish_catalog(vault: &Vault, index: &mut VaultIndex) -> Result<(), IndexError> {
    let store = RubbishStore::for_vault(vault.root());
    index.reconcile_rubbish_catalog(&store)
}
```

Replace the call in `index.rs` with the wrapper's body, using the `rubbish` module (which moves with the vault set):

```rust
        let rubbish_store = super::rubbish::RubbishStore::for_vault(vault.root());
        self.reconcile_rubbish_catalog(&rubbish_store)?;
```

Keep `reconcile::reconcile_rubbish_catalog` for its other callers. Run: `grep -n "reconcile::" src/vault/index.rs` → no output.

- [ ] **Step 2: Move the bases-aware tests out of `index.rs`**

`mod linkable_epoch_tests` (from `#[cfg(test)]` at ~line 3712 to the end of the file) imports `crate::vault::base::{BaseRegistry, BaseLinkableProperties, effective_linkable_properties}`. `base` stays in the remainder, so these tests cannot compile inside `clep-index`. Move the whole module to `tests/linkable_epoch_test.rs` as an integration test of the root package:

- Replace `use super::*;` and `use super::linkable_epoch;` with explicit public imports: `use clepsydra::vault::Vault; use clepsydra::vault::index::{VaultIndex, linkable_epoch}; use clepsydra::vault::base::{BaseLinkableProperties, BaseRegistry, effective_linkable_properties};` plus `std::fs` and `tempfile`.
- If a test uses a private item of `index.rs` (anything not `pub`), either switch it to the public equivalent or make the item `pub` with the workspace-split doc line. Report which, if any.
- Delete the module from `index.rs`; leave the file ending at the previous `#[cfg(test)]` module.

Run: `cargo test --locked --test linkable_epoch_test` → every test that was in the module passes (count them before deleting; the numbers must match). Run: `cargo test --locked -p clepsydra --lib index::` → the remaining `index.rs` tests still pass.

Phase 3 moves this file into `clep-bases`.

- [ ] **Step 3: Widen the `pub(crate)` items the boundary crosses**

The scan found these `pub(crate)` items in the vault/index sets referenced from files that stay behind (or, for vault items, from the index set). Change each to `pub` and add the doc line `/// Public for the workspace split; not part of the stable API.` directly above the existing doc comment (or as the doc comment if there is none):

Vault set, used outside the vault set:
- `src/vault/atomic_file.rs`: `flush_directory` (used by `mutation_coordinator.rs`, `batch_mutation.rs`)
- `src/vault/keyring.rs`: `tighten_crypto_permissions` (gitsync/engine.rs)
- `src/vault/link.rs`: `normalize_links_to_target` (query.rs, base.rs)
- `src/vault/rubbish.rs`: `validate`, `read_item_if_exists`, `finish_purge_tombstone`, `reconcile_purge_tombstones`, `remove_item`, `catalog_entry_for_expected_item`, `publish_transaction_item`, `withdraw_transaction_item`
- `src/vault/task_history.rs`: `effective_indexed_history`, `initialize_task_history`, `heal_task_update`, `heal_task_replacement`, `matches_project_scope`; and the `pub(crate) fn timestamp(&self)` at line ~33 only if a file outside the vault set calls it (check with `grep -rn "\.timestamp()" src/ --include='*.rs'` against the type's users; the scan matched the bare word and may be a false positive)

Index set, used outside the index set:
- `src/vault/index.rs`: `resolve_link_target_id` (api/base_members.rs, base_member.rs), `find_body_start` (api/tasks.rs)
- `src/vault/index_policy.rs`: `apply_mutation` (api/archive.rs, mutation_coordinator.rs) — only if it is the `pub(crate)` free function or method, not an unrelated same-named method on `IndexHandle`
- `src/vault/reference_issues.rs`: `project` (line ~392) — only if a file outside the index set calls `reference_issues::project`; otherwise leave it
- `src/vault/sync/mod.rs`: `process_events_atomically` (mutation_coordinator.rs)

The compiler cannot check these yet (still one crate). Tasks 2 and 3 will surface any item this list missed; they widen those the same way and report them.

Run: `cargo clippy --locked --workspace --all-targets -- -D warnings` → clean (no `unreachable_pub`-style lints are enabled, so widening is warning-free).

- [ ] **Step 4: Gates, commit**

```bash
git add src/vault tests/linkable_epoch_test.rs
git commit -m "refactor(vault): seams for the clep-vault and clep-index cut"
```

---

### Task 2: `clep-vault`

**Files:**
- Create: `crates/clep-vault/Cargo.toml`, `crates/clep-vault/src/lib.rs` (the `Vault` handle and `pub mod` list from `src/vault/mod.rs`)
- Move (`git mv`, into `crates/clep-vault/src/`): `atomic_file.rs`, `attendance.rs`, `bcl.rs`, `block.rs`, `block_id.rs`, `board_vocab.rs`, `canonical.rs`, `code.rs`, `config.rs`, `conflict.rs`, `context.rs`, `conversation.rs`, `encryption.rs`, `init.rs`, `keyring.rs`, `kind.rs`, `legacy_yaml.rs`, `link.rs`, `location.rs`, `markdown.rs`, `meeting.rs`, `page.rs`, `page_filename.rs`, `path.rs`, `project.rs`, `projection.rs`, `rewriter.rs`, `rubbish.rs`, `task_history.rs`, `toml_json.rs`, `toml_patch.rs`, and the directory `wordlists/` (31 modules + wordlists)
- Move (`git mv`, into `crates/clep-vault/tests/`): `tests/block_id_test.rs`, `tests/block_parser_test.rs`, `tests/canonical_name_test.rs`, `tests/context_test.rs`, `tests/frontmatter_test.rs`, `tests/keyring_test.rs`, `tests/rewriter_test.rs`, `tests/vault_path_test.rs`
- Modify: `src/vault/mod.rs` (remove the 31 `pub mod` lines and the `Vault` definition; add re-exports), root `Cargo.toml` (`clep-vault` path entry in `[workspace.dependencies]`, `clep-vault = { workspace = true }` in the root package, `test-failpoints = ["clep-vault/test-failpoints"]`)

**Interfaces:**
- Produces crate `clep-vault` (`clep_vault`): `pub struct Vault` with the same methods; `pub mod` for each of the 31 modules; feature `test-failpoints`. Every `clepsydra::vault::<module>` path above and `clepsydra::vault::Vault` still resolve through the re-export in `src/vault/mod.rs`.
- Consumes: `clep_config::expand_tilde` (already imported by `config.rs`).

- [ ] **Step 1: Create the crate and move the files**

```bash
mkdir -p crates/clep-vault/src crates/clep-vault/tests
for m in atomic_file attendance bcl block block_id board_vocab canonical code config conflict context conversation encryption init keyring kind legacy_yaml link location markdown meeting page page_filename path project projection rewriter rubbish task_history toml_json toml_patch; do git mv src/vault/$m.rs crates/clep-vault/src/$m.rs; done
git mv src/vault/wordlists crates/clep-vault/src/wordlists
```

`crates/clep-vault/src/lib.rs`: crate doc (two sentences: the vault model and `Vault` handle, independent of SQLite and HTTP; the remainder re-exports these modules), the 31 `pub mod` lines in alphabetical order, then the `Vault` struct and its `impl` block cut verbatim from `src/vault/mod.rs` (lines 74 to the end of that impl). `code.rs`'s `include_str!("wordlists/…")` paths are relative to the file and still resolve.

Path rewrite inside the moved files: `crate::vault::` → `crate::`. `super::x` from a top-level file still resolves (the parent is now `lib.rs`). No other rewrite.

`crates/clep-vault/Cargo.toml`:

```toml
[package]
name = "clep-vault"
version.workspace = true
edition.workspace = true
publish = false

[features]
test-failpoints = []

[dependencies]
clep-config = { workspace = true }
# add only what the compiler demands, e.g.:
# base64, blake3, chrono, glob, pulldown-cmark, regex, serde, serde_json,
# serde_yaml, sha2, thiserror, toml, toml_edit, tracing,
# unicode-normalization, utoipa, uuid, walkdir

[target.'cfg(unix)'.dependencies]
rustix = { workspace = true }

[target.'cfg(windows)'.dependencies]
windows-sys = { workspace = true }

[dev-dependencies]
tempfile = { workspace = true }
# plus chrono / uuid / base64 if the moved tests need them
```

Copy the exact feature lists from the root package's current entries when a dep is added (the root uses `{ workspace = true }`, so features live in `[workspace.dependencies]` — nothing to copy unless a crate manifest overrides).

- [ ] **Step 2: Wire the remainder**

`src/vault/mod.rs`: delete the 31 `pub mod` lines and everything from `use std::path::{Path, PathBuf};` through the end of `impl Vault`; add at the top:

```rust
pub use clep_vault::Vault;
pub use clep_vault::{
    atomic_file, attendance, bcl, block, block_id, board_vocab, canonical, code, config, conflict,
    context, conversation, encryption, init, keyring, kind, legacy_yaml, link, location, markdown,
    meeting, page, page_filename, path, project, projection, rewriter, rubbish, task_history,
    toml_json, toml_patch,
};
```

Root `Cargo.toml`: add `clep-vault = { path = "crates/clep-vault" }` to `[workspace.dependencies]`; `clep-vault = { workspace = true }` to the root package `[dependencies]`; change `[features] test-failpoints = []` to `test-failpoints = ["clep-vault/test-failpoints"]`. Then drop from the root package every external dependency that nothing left under `src/`, `tests/`, `examples/` uses (`grep -rn "<crate>::" src tests examples --include='*.rs'`, and `cargo tree -p clepsydra -e normal -i <crate>` to confirm no remaining direct edge); expect candidates like `unicode-normalization`, `serde_yaml`, `glob`, `blake3`, `sha2`, `base64`, `toml_edit`, `pulldown-cmark`, `regex` — keep any that are still used.

Anything that fails to compile because a `pub(crate)` item is now cross-crate: widen it to `pub` with the workspace-split doc line, and list every such item in the report.

- [ ] **Step 3: Move the tests**

```bash
for t in block_id_test block_parser_test canonical_name_test context_test frontmatter_test keyring_test rewriter_test vault_path_test; do git mv tests/$t.rs crates/clep-vault/tests/$t.rs; done
```

In each, `clepsydra::vault::` → `clep_vault::`. Add dev-deps as the compiler demands.

Run: `cargo test --locked -p clep-vault` → all in-file tests plus the eight test files pass. Run: `cargo tree -p clep-vault -e normal | grep "clep-"` → only `clep-config`. Run: `grep -rn "crate::vault::\|clepsydra" crates/clep-vault/src` → no output.

- [ ] **Step 4: Gates, commit**

```bash
git add Cargo.toml Cargo.lock crates/clep-vault src/vault tests
git commit -m "build(clep-vault): vault model and handle in their own crate"
```

(The `src/vault` and `tests` paths cover the moves and deletions.)

---

### Task 3: `clep-index`

**Files:**
- Create: `crates/clep-index/Cargo.toml`, `crates/clep-index/src/lib.rs`
- Move (`git mv`, into `crates/clep-index/src/`): `index.rs`, `index_handle.rs`, `index_policy.rs`, `derivation.rs`, `derivers/` (dir), `search/` (dir), `sync/` (dir), `reference_issues.rs`, `hooks.rs`, `grep.rs`, `tree.rs`
- Move (`git mv`, into `crates/clep-index/tests/`): `tests/block_index_test.rs`, `tests/encryption_test.rs`, `tests/index_handle_test.rs`, `tests/journal_index_test.rs`, `tests/link_extraction_test.rs`, `tests/sync_test.rs`
- Modify: `src/vault/mod.rs` (remove the 11 `pub mod`/`mod` lines, add re-exports), root `Cargo.toml`

**Interfaces:**
- Produces crate `clep-index` (`clep_index`): `pub mod index, index_handle, index_policy, derivation, derivers, sync, reference_issues, hooks, grep, tree`; `mod search` stays private (index.rs already re-exports `SearchQueryError`). Ruling: `grep.rs` and `tree.rs` move whole, render functions included — Phase 0 already made the accent a parameter, so nothing in them depends on config; spec §2 "data half" wording is amended in Task 4.
- Depends on: `clep-vault` (and `clep-config` only if the compiler demands). Never on `clepsydra`.

- [ ] **Step 1: Create the crate and move the files**

```bash
mkdir -p crates/clep-index/src crates/clep-index/tests
for m in index index_handle index_policy derivation reference_issues hooks grep tree; do git mv src/vault/$m.rs crates/clep-index/src/$m.rs; done
git mv src/vault/derivers crates/clep-index/src/derivers
git mv src/vault/search crates/clep-index/src/search
git mv src/vault/sync crates/clep-index/src/sync
```

`crates/clep-index/src/lib.rs`: crate doc (the SQLite index, derivation chain, hooks traits, and filesystem sync over a `clep_vault::Vault`), then:

```rust
pub mod derivation;
pub mod derivers;
pub mod grep;
pub mod hooks;
pub mod index;
pub mod index_handle;
pub mod index_policy;
pub mod reference_issues;
mod search;
pub mod sync;
pub mod tree;
```

Path rewrite inside the moved files: references to a vault-set module (`crate::vault::path`, `super::path`, `super::Vault`, `crate::vault::Vault`, …) → `clep_vault::…`; references to an index-set module (`crate::vault::index`, `super::index`, …) → `crate::…`. Files under `derivers/`, `search/`, `sync/` use `super::` for their own directory module and `crate::` for siblings; check each `super::` carefully — from `derivers/links.rs`, `super::` is `derivers`, and `super::super::x` becomes `crate::x` or `clep_vault::x`.

`crates/clep-index/Cargo.toml`: package block as in Task 2 (name `clep-index`), `[dependencies]` `clep-vault = { workspace = true }` plus what the compiler demands (expect `rusqlite`, `notify-debouncer-mini`, `tokio`, `owo-colors`, `anstream`, `serde`, `serde_json`, `thiserror`, `chrono`, `uuid`, `walkdir`, `blake3`, `toml`, `tracing`), `[dev-dependencies]` `tempfile`, `tokio` (for `#[tokio::test]`), `base64` if `encryption_test` needs it.

- [ ] **Step 2: Wire the remainder**

`src/vault/mod.rs`: remove `pub mod derivation; pub mod derivers; pub mod grep; pub mod hooks; pub mod index; pub mod index_handle; pub mod index_policy; pub mod reference_issues; mod search; pub mod sync; pub mod tree;` and add:

```rust
pub use clep_index::{
    derivation, derivers, grep, hooks, index, index_handle, index_policy, reference_issues, sync,
    tree,
};
```

Root `Cargo.toml`: `clep-index = { path = "crates/clep-index" }` in `[workspace.dependencies]`; `clep-index = { workspace = true }` in the root package; drop root deps nothing left uses (candidates: `notify-debouncer-mini`, `owo-colors`, `anstream`; verify with grep + `cargo tree -i`).

Widen any `pub(crate)` item the compiler reports as inaccessible, with the doc line; list them in the report.

- [ ] **Step 3: Move the tests**

```bash
for t in block_index_test encryption_test index_handle_test journal_index_test link_extraction_test sync_test; do git mv tests/$t.rs crates/clep-index/tests/$t.rs; done
```

In each: `clepsydra::vault::{index, index_handle, index_policy, sync, hooks, …}` → `clep_index::…`; `clepsydra::vault::{init, path, page, encryption, link, Vault}` → `clep_vault::…`.

Run: `cargo test --locked -p clep-index` → all pass. Run: `cargo tree -p clep-index -e normal | grep "clep-"` → `clep-vault` (and `clep-config` if added); never `clepsydra`. Run: `cargo tree -p clep-vault -e normal -i clep-index` → no match. Run: `grep -rn "crate::vault::\|clepsydra" crates/clep-index/src crates/clep-index/tests` → no output.

- [ ] **Step 4: Gates, commit**

```bash
git add Cargo.toml Cargo.lock crates/clep-index src/vault/mod.rs tests
git commit -m "build(clep-index): SQLite index, derivation and fs sync in their own crate"
```

---

### Task 4: Docs, measurement, doc-path sweep

**Files:**
- Modify: `docs/superpowers/specs/2026-09-09-crate-split-design.md` (§1 timings, §2 rows for `clep-vault`/`clep-index`, §3 note, §4 Phase 2 line, §5 test placement, Status line), `CLAUDE.md` (Architecture `src/vault/` bullet), any live doc the sweep finds (`CONTEXT.md`, `docs/design-notes/*`, `docs/adr/*`, `ui/src/docs/content/*.mdx`); never `docs/plans/` or `docs/superpowers/plans/`.

- [ ] **Step 1: Measure**

```bash
cargo clean -p clepsydra && /usr/bin/time -p cargo check 2>&1 | tail -3
cargo clean -p clepsydra && /usr/bin/time -p cargo build 2>&1 | tail -3
cargo clean -p clepsydra && /usr/bin/time -p cargo test --no-run 2>&1 | tail -3
cargo clean -p clep-vault && /usr/bin/time -p cargo test -p clep-vault 2>&1 | tail -3
cargo clean -p clep-index && /usr/bin/time -p cargo test -p clep-index 2>&1 | tail -3
cargo clean -p clepsydra -p clep -p clep-config -p clep-client -p clep-mcp -p clep-frontend-assets -p clep-test-support -p clep-vault -p clep-index && /usr/bin/time -p cargo build 2>&1 | tail -3
```

(Each `/usr/bin/time` line is only for the number; redirect the build to a log file and read the exit code separately.) Record: remainder-only check/build/test --no-run (the "edit something in `src/api`" case), the two per-crate test times, and the all-our-crates build, as a "Phase 2" table under §1 next to Phase 1's (check 10.97 s, build 20.89 s, test --no-run 35.76 s).

- [ ] **Step 2: Spec**

- §2 `clep-vault` row: contents unchanged; note `Vault` handle in `lib.rs`; `wordlists/` moves with `code`.
- §2 `clep-index` row: "grep + tree (data half)" → "grep, tree (whole; render takes the accent as a parameter)"; add "`search` private".
- §3: after item 4, add "5. **Index → reconcile.** `index.rs` called `reconcile::reconcile_rubbish_catalog`, a two-line wrapper over `RubbishStore::for_vault`; inlined in Phase 2."
- §5: `keyring_test` and `encryption_test` moved to `clep-vault` and `clep-index` respectively (they only use those crates), not the bin; `linkable_epoch_test` (from `index.rs`) sits in the root package until `clep-bases` exists; `index_test` stays in the root until Phase 3 (uses `query`, `tree`).
- §4 Phase 2 line: append "— landed <date> on branch feature/crate-split-phase2".
- Status line: "Phase 0 and 1 merged to develop (f0013f63); Phase 2 landed on branch feature/crate-split-phase2; Phase 3 pending".

- [ ] **Step 3: CLAUDE.md and the doc-path sweep**

`CLAUDE.md` Architecture: rewrite the `src/vault/` bullet to: "`crates/clep-vault` — the vault model, independent of SQLite and HTTP: paths (`VaultPath`, NFC-normalized), page/frontmatter parsing, link extraction/rewriting, kinds, codes, config, atomic writes, rubbish, task history, init. `crates/clep-index` — SQLite index + derivation chain (`derivers/`), hooks traits, FTS `grep`/`tree`, filesystem sync/reconcile (`sync/`). `src/vault/` — what remains in the server lib: bases, mutation coordinator, academic imports (DOI/ISBN/Zotero), content-addressed attachment storage (`cas.rs`), archive hooks, gitsync; it re-exports the two crates' modules so `clepsydra::vault::…` paths still resolve." Keep the gitsync and doctor bullets, updating `src/vault/sync/` mentions to `crates/clep-index/src/sync/`.

Sweep: `grep -rn "src/vault/\(path\|page\|page_filename\|link\|rewriter\|block\|kind\|code\|config\|atomic_file\|rubbish\|task_history\|init\|keyring\|encryption\|index\|index_handle\|derivation\|derivers\|hooks\|grep\|tree\|sync/\|search\)" CLAUDE.md CONTEXT.md docs/design-notes docs/adr ui/src/docs/content nvim 2>/dev/null` and rewrite every hit to the new path (live docs only). Record the list of files touched in the report.

- [ ] **Step 4: Gates, commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-09-crate-split-design.md <swept files>
git commit -m "docs: workspace layout after crate split phase 2"
```
