# Standalone `clep lsp` Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `clep serve --lsp` with a standalone, read-only `clep lsp` command so the LSP and the HTTP server can run concurrently against one vault.

**Architecture:** `clep lsp` opens the vault itself with a private **in-memory** SQLite index and its own file watcher; it never writes vault files — edits are applied by the editor (buffer saves, WorkspaceEdits), and the running server absorbs them like any external edit. The one file-write the LSP does today (`didSave` drift-reconcile, ADR 0001 layer 2) moves into `clep serve`'s watcher, so *any* external editor heals folder drift while the server runs. Vault root comes from the LSP `initialize` workspace root (`.clepsydra` marker, ancestors included), falling back to the `config.toml` lookup.

**Tech Stack:** Rust 2024, tower-lsp, rusqlite (in-memory), notify-debouncer-mini, tokio (`sync::OnceCell`), clap.

## Global Constraints

- Rust 2024 edition; `cargo fmt` and `cargo clippy` clean; full `cargo test` green after every task.
- No new crate dependencies — everything needed (tokio `sync::OnceCell`, rusqlite `open_in_memory`, notify) is already in the tree.
- The LSP process must NEVER write vault files. Grep your diff for `std::fs::write|rename|remove` under `src/lsp/` before committing.
- `clep lsp` speaks LSP on **stdout**; all tracing/logging in that process must go to **stderr** (today's `init_logging` writes to stdout — do not reuse it for the LSP entry point).
- Working branch: `feature/standalone-lsp` off `develop`, in a worktree. Commit after every task.
- The main checkout has unrelated uncommitted changes (TLS path resolution in `src/lib.rs`, `docs/configuration.md`, deleted `config.toml`, `ui/src/routeTree.gen.ts`). Never touch those regions; the feature works only from the worktree's committed base.

---

### Task 1: `VaultIndex::open_in_memory()`

**Files:**
- Modify: `src/vault/index.rs` (constructors around line 290)

**Interfaces:**
- Produces: `pub fn open_in_memory() -> Result<VaultIndex, IndexError>` — a fully-schema'd index backed by an in-memory SQLite connection, behaviourally identical to `open()` except nothing touches disk.

- [ ] **Step 1: Write the failing test** (in `src/vault/index.rs`'s existing `#[cfg(test)] mod`)

```rust
#[test]
fn open_in_memory_builds_and_queries() {
    let tmp = tempfile::TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    crate::vault::init::init_vault(&root).unwrap();
    std::fs::write(root.join("Note.md"), "# Note\n\nbody\n").unwrap();

    let vault = crate::vault::Vault::open(&root).unwrap();
    let mut index = VaultIndex::open_in_memory().unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();
    // Reuse whatever accessor the nearest existing `open()` test uses to
    // assert a page landed in the index (e.g. canonical-name or page lookup).
}
```

Copy the assertion style from the closest existing test of `open()` in this file so the test checks a real query, not just "no panic".

- [ ] **Step 2: Run it to make sure it fails**

Run: `cargo test open_in_memory_builds_and_queries`
Expected: compile error, `open_in_memory` not found.

- [ ] **Step 3: Implement**

Read `VaultIndex::open` (`src/vault/index.rs:290`) and `open_bare` (`:329`). Extract their shared post-connection setup (pragmas, schema/migrations, struct construction) into a private `fn from_connection(conn: rusqlite::Connection) -> Result<Self, IndexError>` if it isn't already factored that way, then:

```rust
/// Open an index backed by an in-memory SQLite database. Used by the
/// standalone LSP process, which must never write inside the vault.
pub fn open_in_memory() -> Result<Self, IndexError> {
    let conn = rusqlite::Connection::open_in_memory()?;
    Self::from_connection(conn)
}
```

If `open()` sets file-oriented pragmas (e.g. `journal_mode=WAL`), leave them in the shared path — SQLite silently reports `memory` for WAL on in-memory DBs; do not special-case unless a pragma actually errors.

- [ ] **Step 4: Run the test and the module's tests**

Run: `cargo test open_in_memory_builds_and_queries` then `cargo test vault::index`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/vault/index.rs
git commit -m "feat(index): add VaultIndex::open_in_memory for the standalone LSP"
```

---

### Task 2: `LspState` and `open_lsp_state`

**Files:**
- Create: `src/lsp/state.rs`
- Modify: `src/lsp/mod.rs` (add `pub mod state;`)

**Interfaces:**
- Consumes: `VaultIndex::open_in_memory()` (Task 1), `IndexHandle::spawn(index, vault)`, `Vault::open(&root)`.
- Produces:
  - `pub struct LspState { pub vault: Vault, pub index: IndexHandle }`
  - `pub fn open_lsp_state(root: &std::path::Path) -> Result<LspState, Box<dyn std::error::Error + Send + Sync>>`

- [ ] **Step 1: Write the failing test** (in `src/lsp/state.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_vault_with_in_memory_index() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        std::fs::write(root.join("Note.md"), "# Note\n\nbody\n").unwrap();

        let state = open_lsp_state(&root).unwrap();
        assert_eq!(state.vault.root(), root.canonicalize().unwrap());
        // No index db file may appear inside the vault:
        assert!(!root.join(".clepsydra/cache.db").exists());
        assert!(!root.join(".clepsydra/index.db").exists());
    }
}
```

(If `Vault::open` does not canonicalize the root, drop the `.canonicalize()` — match what `Vault::root()` actually returns; check its doc/tests.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test lsp::state`
Expected: compile error, module/function not found.

- [ ] **Step 3: Implement**

```rust
//! Vault state for the standalone LSP process.
//!
//! The LSP is read-only by design: it opens the vault with a private
//! in-memory index and never writes vault files. Edits reach the vault
//! through the editor (buffer saves, applied WorkspaceEdits); the running
//! `clep serve` absorbs them like any other external edit (ADR 0001).
use std::path::Path;

use crate::vault::Vault;
use crate::vault::index::VaultIndex;
use crate::vault::index_handle::IndexHandle;

pub struct LspState {
    pub vault: Vault,
    pub index: IndexHandle,
}

/// Open `root` as a vault and build a fully-derived in-memory index.
/// Blocking (full index build) — call from `spawn_blocking` in async context.
pub fn open_lsp_state(root: &Path) -> Result<LspState, Box<dyn std::error::Error + Send + Sync>> {
    let vault = Vault::open(root).map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.to_string().into() })?;
    let mut index = VaultIndex::open_in_memory()?;
    index.build(&vault)?;
    index.resolve_links()?;
    let index = IndexHandle::spawn(index, vault.clone());
    Ok(LspState { vault, index })
}
```

Adjust the error plumbing to whatever `Vault::open`/`index` errors actually are (the `map_err` above is a fallback if they aren't `Send + Sync`; prefer plain `?` if they are). Add `pub mod state;` to `src/lsp/mod.rs`.

- [ ] **Step 4: Run tests**

Run: `cargo test lsp::state`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lsp/state.rs src/lsp/mod.rs
git commit -m "feat(lsp): add read-only LspState with in-memory index"
```

---

### Task 3: Drift reconcile moves into the serve watcher (ADR 0001 layer 2)

**Files:**
- Modify: `src/lib.rs` (`spawn_sync_watcher` ~line 515, new `reconcile_upserts` next to `process_sync_batch` ~line 485)
- Modify: `docs/adr/0001-metadata-projected-folder-layout.md` (~line 31, the three-layer list)

**Interfaces:**
- Consumes: `crate::vault::reconcile::reconcile_page(vault, index, &VaultPath, &hooks)` — exact call shape copied from today's `did_save` (`src/lsp/mod.rs:160-184`).
- Produces: `async fn reconcile_upserts(index: &IndexHandle, hooks: &Arc<Vec<Box<dyn vault::hooks::PostMoveHook>>>, upserts: Vec<VaultPath>)` in `src/lib.rs`, called from the sync loop after each batch.

- [ ] **Step 1: Write the failing test** (in `src/lib.rs`, next to `startup_reconcile_tests` ~line 910)

Mirror the fixture from `serve_startup_reconciles_drifted_pages` (`src/lib.rs:917`) — read that test first and reuse its way of creating a page whose declared kind/project mismatches its folder. Then:

```rust
#[tokio::test]
async fn watcher_batch_reconciles_drifted_upsert() {
    let (state, _tmp) = state_test_support::make_state().await;
    // <create a drifted page file exactly as serve_startup_reconciles_drifted_pages does,
    //  and index it via state.index.process_sync_events(vec![ChangeEvent::Upsert(vp.clone())])>
    reconcile_upserts(&state.index, &state.hooks, vec![vp.clone()]).await;
    // Assert the file moved to its projected folder (same assertion style as
    // the startup test) and the old path is gone.
}
```

Also add the no-op case:

```rust
#[tokio::test]
async fn reconcile_upserts_leaves_clean_pages_alone() {
    let (state, _tmp) = state_test_support::make_state().await;
    // <create a page whose folder already matches its declared kind, index it>
    reconcile_upserts(&state.index, &state.hooks, vec![vp.clone()]).await;
    // Assert the file did not move.
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test reconcile_upserts`
Expected: compile error, `reconcile_upserts` not found.

- [ ] **Step 3: Implement**

```rust
/// Reconcile pages the watcher just saw change: folder-follows-metadata
/// (ADR 0001 layer 2). Runs after the batch is indexed so projection sees
/// fresh frontmatter. A move produces new watch events; reconciling an
/// already-correct page is a no-op, so the loop terminates.
async fn reconcile_upserts(
    index: &IndexHandle,
    hooks: &Arc<Vec<Box<dyn vault::hooks::PostMoveHook>>>,
    upserts: Vec<VaultPath>,
) {
    for vp in upserts {
        let hooks = Arc::clone(hooks);
        let target = vp.clone();
        let result = index
            .with_index(move |index, vault| {
                crate::vault::reconcile::reconcile_page(vault, index, &target, &hooks)
            })
            .await;
        match result {
            Err(e) | Ok(Err(e)) => tracing::warn!("watcher reconcile failed for {vp}: {e}"),
            Ok(Ok(Some(new_path))) => {
                tracing::info!("watcher reconcile moved {vp} → {new_path} (folder follows kind/project)");
            }
            Ok(Ok(None)) => {}
        }
    }
}
```

(Copy the exact `match` arm types from today's `did_save` at `src/lsp/mod.rs:167-184` — the `Err(e) | Ok(Err(e))` unification works there and must be preserved; if the display of `vp`/`new_path` needs `.as_str()`, match what `did_save` does.)

Wire it into the sync loop in `spawn_sync_watcher` — the loop needs the hooks, so clone them from `state` alongside the other captures:

```rust
let hooks = Arc::clone(&state.hooks);
tokio::spawn(async move {
    loop {
        let batch = match change_rx.recv().await {
            Some(event) => drain_change_batch(event, &mut change_rx),
            None => break,
        };
        let upserts: Vec<VaultPath> = batch
            .iter()
            .filter_map(|e| match e {
                ChangeEvent::Upsert(vp) => Some(vp.clone()),
                _ => None,
            })
            .collect();
        process_sync_batch(&sync_index, batch, &sync_change_tx).await;
        reconcile_upserts(&sync_index, &hooks, upserts).await;
    }
});
```

- [ ] **Step 4: Run tests**

Run: `cargo test reconcile` (covers the two new tests + startup reconcile suite)
Expected: PASS.

- [ ] **Step 5: Amend ADR 0001**

In `docs/adr/0001-metadata-projected-folder-layout.md`, replace the layer list (~line 31):

```markdown
1. UI assignment (backend moves immediately),
2. the `serve` file watcher, after each sync batch (catches saves from any
   external editor — Neovim, Obsidian, scripts — while the server runs;
   until 2026-08 this layer was the LSP's `didSave`, which only covered
   LSP-attached editors and made the LSP process a writer),
3. a `serve`-startup sweep (catch-all when the server was not running).
```

- [ ] **Step 6: Commit**

```bash
git add src/lib.rs docs/adr/0001-metadata-projected-folder-layout.md
git commit -m "feat(sync): reconcile folder drift from the serve watcher (ADR 0001 layer 2)"
```

---

### Task 4: `LspBackend` owns late-initialized state; `initialize` opens the vault; `didSave` stops writing

**Files:**
- Modify: `src/lsp/mod.rs` (struct ~line 25, `initialize` ~line 38, `did_save` ~line 150-190, `run_lsp` ~line 1334, all `self.state.` call sites)
- Modify: `src/lsp/state.rs` (add `resolve_lsp_root`)
- Modify: `src/lsp/test_support.rs`

**Interfaces:**
- Consumes: `LspState`, `open_lsp_state` (Task 2).
- Produces:
  - `LspBackend { client, vault_state: tokio::sync::OnceCell<Arc<LspState>>, documents, canonical_names }`
  - `impl LspBackend { fn state(&self) -> tower_lsp::jsonrpc::Result<Arc<LspState>>; fn state_opt(&self) -> Option<Arc<LspState>> }`
  - `pub(crate) fn resolve_lsp_root(params: &InitializeParams, cwd: &Path) -> Result<PathBuf, String>` in `state.rs`
  - `pub async fn run_lsp()` (no arguments)
  - Test support: `make_backend` unchanged signature, now builds `LspState` (no `AppState`); `uri_for` reads `backend.state().unwrap().vault`.

- [ ] **Step 1: Write the failing tests** (in `src/lsp/state.rs` tests + `src/lsp/mod.rs` tests)

`resolve_lsp_root` unit tests in `state.rs`:

```rust
#[test]
fn resolves_workspace_folder_with_marker() {
    let tmp = tempfile::TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    crate::vault::init::init_vault(&root).unwrap();
    let sub = root.join("notes");
    std::fs::create_dir_all(&sub).unwrap();

    #[allow(deprecated)]
    let params = InitializeParams {
        workspace_folders: Some(vec![WorkspaceFolder {
            uri: Url::from_file_path(&sub).unwrap(),
            name: "notes".into(),
        }]),
        ..Default::default()
    };
    // Marker found by walking ancestors from the workspace folder:
    assert_eq!(resolve_lsp_root(&params, tmp.path()).unwrap(), root);
}

#[test]
fn falls_back_to_config_lookup_without_marker() {
    let tmp = tempfile::TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    crate::vault::init::init_vault(&root).unwrap();
    std::fs::write(
        tmp.path().join("config.toml"),
        format!("[vault]\nroot = \"{}\"\n", root.display()),
    )
    .unwrap();
    let params = InitializeParams::default();
    let resolved = resolve_lsp_root(&params, tmp.path()).unwrap();
    assert_eq!(resolved, root);
}

#[test]
fn errors_when_nothing_resolves() {
    let tmp = tempfile::TempDir::new().unwrap();
    let params = InitializeParams::default();
    assert!(resolve_lsp_root(&params, tmp.path()).is_err());
}
```

In `src/lsp/mod.rs` tests, an end-to-end initialize test:

```rust
#[tokio::test]
async fn initialize_opens_vault_from_root_uri() {
    let tmp = tempfile::TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    crate::vault::init::init_vault(&root).unwrap();
    std::fs::write(root.join("Note.md"), "# Note\n").unwrap();

    let backend = make_uninitialized_backend(); // new test_support helper: empty OnceCell
    #[allow(deprecated)]
    let params = InitializeParams {
        root_uri: Some(Url::from_file_path(&root).unwrap()),
        ..Default::default()
    };
    let result = backend.initialize(params).await.unwrap();
    assert!(result.capabilities.completion_provider.is_some());
    assert!(backend.state().is_ok());
}
```

And the read-only regression test replacing the old didSave-reconcile behavior:

```rust
#[tokio::test]
async fn did_save_reindexes_but_never_moves_files() {
    // Build a backend over a vault containing a DRIFTED page (declared kind
    // mismatching its folder — copy the fixture from lib.rs's
    // serve_startup_reconciles_drifted_pages).
    // did_save on it; assert the file is still at its original path,
    // and the index answered a query reflecting the saved content.
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test lsp`
Expected: compile errors (`make_uninitialized_backend`, `resolve_lsp_root` missing).

- [ ] **Step 3: Implement `resolve_lsp_root`** (in `state.rs`)

```rust
/// Resolve the vault root for a standalone LSP session.
///
/// Priority: any workspace folder (then the deprecated rootUri) whose
/// ancestor chain contains a `.clepsydra` directory; otherwise the
/// application config lookup relative to `cwd` (./config.toml → XDG).
pub(crate) fn resolve_lsp_root(
    params: &InitializeParams,
    cwd: &Path,
) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for folder in params.workspace_folders.iter().flatten() {
        if let Ok(p) = folder.uri.to_file_path() {
            candidates.push(p);
        }
    }
    #[allow(deprecated)]
    if let Some(uri) = &params.root_uri {
        if let Ok(p) = uri.to_file_path() {
            candidates.push(p);
        }
    }
    for candidate in &candidates {
        for dir in candidate.ancestors() {
            if dir.join(".clepsydra").is_dir() {
                return Ok(dir.to_path_buf());
            }
        }
    }
    let (settings, config_path) = crate::Settings::load(cwd).map_err(|e| {
        format!("no .clepsydra directory in the workspace and no config.toml found: {e}")
    })?;
    Ok(crate::resolve_vault_root(&settings.vault.root, &config_path, cwd))
}
```

`Settings::load` and `resolve_vault_root` live in `src/lib.rs` — widen visibility to `pub(crate)` if needed.

- [ ] **Step 4: Restructure `LspBackend`**

```rust
pub struct LspBackend {
    pub client: Client,
    /// Vault + index, opened during `initialize` once the workspace root is known.
    pub vault_state: tokio::sync::OnceCell<Arc<state::LspState>>,
    pub documents: Mutex<HashMap<Url, document::Document>>,
    pub canonical_names: Arc<RwLock<HashMap<String, Vec<String>>>>,
}

impl LspBackend {
    /// State accessor for request handlers (jsonrpc error before initialize).
    fn state(&self) -> tower_lsp::jsonrpc::Result<Arc<state::LspState>> {
        self.vault_state.get().cloned().ok_or_else(|| {
            let mut e = tower_lsp::jsonrpc::Error::internal_error();
            e.message = "clepsydra: vault not initialized".to_string().into();
            e
        })
    }
    /// State accessor for notification handlers (silently skip before initialize).
    fn state_opt(&self) -> Option<Arc<state::LspState>> {
        self.vault_state.get().cloned()
    }
}
```

Then update every `self.state.` call site (grep `self.state.`; ~dozens):
- request handlers returning `Result<…>`: `let state = self.state()?;` then `state.index` / `state.vault`
- notification handlers returning `()`: `let Some(state) = self.state_opt() else { return };`
- helper methods follow whichever of the two shapes their callers need.

`initialize` gains the vault-open, keeping the existing capabilities block **verbatim**:

```rust
async fn initialize(&self, params: InitializeParams) -> Result<InitializeResult> {
    let cwd = std::env::current_dir().map_err(|e| {
        let mut err = tower_lsp::jsonrpc::Error::internal_error();
        err.message = format!("clepsydra: cannot read cwd: {e}").into();
        err
    })?;
    let root = state::resolve_lsp_root(&params, &cwd).map_err(|msg| {
        let mut err = tower_lsp::jsonrpc::Error::internal_error();
        err.message = format!("clepsydra: {msg}").into();
        err
    })?;
    let opened = tokio::task::spawn_blocking(move || state::open_lsp_state(&root))
        .await
        .map_err(|e| {
            let mut err = tower_lsp::jsonrpc::Error::internal_error();
            err.message = format!("clepsydra: vault open task failed: {e}").into();
            err
        })?
        .map_err(|e| {
            let mut err = tower_lsp::jsonrpc::Error::internal_error();
            err.message = format!("clepsydra: cannot open vault: {e}").into();
            err
        })?;
    let _ = self.vault_state.set(Arc::new(opened));
    Ok(InitializeResult { /* existing capabilities + server_info, unchanged */ })
}
```

- [ ] **Step 5: Strip the reconcile from `did_save`**

Replace the reconcile block (`src/lsp/mod.rs:160-184`) with a plain reindex so completion/diagnostics are fresh immediately after save (the serve watcher now owns file moves — Task 3):

```rust
let _ = state
    .index
    .process_sync_events(vec![crate::vault::sync::ChangeEvent::Upsert(reconcile_path)])
    .await;
```

Keep the existing post-save canonical-name refresh + diagnostics republish that follows (~line 185-206) exactly as is. Delete any now-dead imports (`hooks`) and the tests that asserted did_save moves files; the replacement test from Step 1 covers the new contract.

- [ ] **Step 6: `run_lsp` without state; test support**

```rust
/// Start the LSP server on stdio. The vault opens during `initialize`
/// (workspace root → config fallback). Returns on client disconnect.
pub async fn run_lsp() {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let (service, socket) = LspService::new(|client| LspBackend {
        client,
        vault_state: tokio::sync::OnceCell::new(),
        documents: Mutex::new(HashMap::new()),
        canonical_names: Arc::new(RwLock::new(HashMap::new())),
    });
    Server::new(stdin, stdout, socket).serve(service).await;
}
```

`test_support.rs`: `make_backend` drops the whole `AppState`/CAS block and builds:

```rust
let state = Arc::new(crate::lsp::state::LspState { vault, index: index_handle });
let backend = LspBackend {
    client: test_client(),
    vault_state: tokio::sync::OnceCell::new_with(Some(Arc::clone(&state))),
    documents: Mutex::new(HashMap::new()),
    canonical_names: Arc::new(RwLock::new(HashMap::new())),
};
```

Add `make_uninitialized_backend()` (same, but `OnceCell::new()`, no vault needed). `uri_for` becomes `backend.state().unwrap().vault.root().join(rel)`. Keep the index building on a temp-file DB or switch to `open_in_memory()` — in-memory preferred now that it exists.

- [ ] **Step 7: Run the full LSP suite**

Run: `cargo test lsp`
Expected: PASS (large suite — completion, hover, rename, diagnostics, symbols — all through the new accessor).

- [ ] **Step 8: Read-only audit + commit**

Run: `git diff --stat` and grep the diff for `fs::write|fs::rename|fs::remove` under `src/lsp/` — must be removals only.

```bash
git add src/lsp/ src/lib.rs
git commit -m "refactor(lsp): late-initialized read-only vault state; didSave reindexes without moving files"
```

---

### Task 5: LSP-side watcher — stay fresh, republish diagnostics, notify on external moves

**Files:**
- Modify: `src/lsp/mod.rs` (`initialized` ~line 78, `LspBackend` struct, diagnostics publish path ~line 1305)

**Interfaces:**
- Consumes: `VaultWatcher::start(root, debounce, tx)` (`src/vault/sync/watcher.rs:68`), `IndexHandle::process_sync_events`, `LspState` (Task 2/4).
- Produces:
  - `LspBackend.watcher: std::sync::Mutex<Option<crate::vault::sync::watcher::VaultWatcher>>` (keeps the debouncer alive; `None` in tests)
  - `async fn resync_from_watch_batch(client: Client, state: Arc<LspState>, documents: Arc<Mutex<HashMap<Url, Document>>>, canonical_names: Arc<RwLock<HashMap<String, Vec<String>>>>, batch: Vec<ChangeEvent>)` — free function so the spawned loop can own clones.
  - **Struct change:** `documents` becomes `Arc<Mutex<HashMap<Url, Document>>>` so the watcher task can share it.

- [ ] **Step 1: Write the failing test**

The watcher loop's *logic* must be testable without filesystem timing — test `resync_from_watch_batch` directly:

```rust
#[tokio::test]
async fn watch_batch_refreshes_canonical_names() {
    let (backend, _tmp) = make_backend(&[("Note.md", "# Note\n")]);
    backend.refresh_canonical_names().await;
    let state = backend.state().unwrap();
    // Simulate an external creation: write the file, then feed the batch.
    std::fs::write(state.vault.root().join("Fresh.md"), "# Fresh\n").unwrap();
    resync_from_watch_batch(
        backend.client.clone(),
        Arc::clone(&state),
        Arc::clone(&backend.documents),
        Arc::clone(&backend.canonical_names),
        vec![crate::vault::sync::ChangeEvent::Upsert(
            crate::vault::path::VaultPath::new("Fresh.md").unwrap(),
        )],
    )
    .await;
    let names = backend.canonical_names.read().await;
    assert!(names.keys().any(|k| k.eq_ignore_ascii_case("fresh")));
}
```

(Adapt the final assertion to the real canonical-name key format — inspect `refresh_canonical_names` and mirror how existing tests query the map.)

And the moved-open-document notification pairing logic as a pure function test:

```rust
#[test]
fn pairs_remove_and_upsert_by_filename() {
    let batch = vec![
        ChangeEvent::Remove(VaultPath::new("notes/20260807.a.abc123.md").unwrap()),
        ChangeEvent::Upsert(VaultPath::new("projects/x/20260807.a.abc123.md").unwrap()),
    ];
    let moves = pair_moves_by_filename(&batch);
    assert_eq!(moves.len(), 1);
    assert_eq!(moves[0].0.as_str(), "notes/20260807.a.abc123.md");
    assert_eq!(moves[0].1.as_str(), "projects/x/20260807.a.abc123.md");
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test lsp` — compile errors for the two new functions.

- [ ] **Step 3: Implement**

`pair_moves_by_filename` (pure, in `mod.rs` or `state.rs`):

```rust
/// Pair Remove/Upsert events sharing a filename: a folder-projection move
/// (server-side reconcile) shows up as exactly such a pair in one batch.
fn pair_moves_by_filename(batch: &[ChangeEvent]) -> Vec<(VaultPath, VaultPath)> {
    let mut moves = Vec::new();
    for removed in batch {
        let ChangeEvent::Remove(old) = removed else { continue };
        let old_name = old.as_str().rsplit('/').next().unwrap_or(old.as_str());
        for added in batch {
            let ChangeEvent::Upsert(new) = added else { continue };
            let new_name = new.as_str().rsplit('/').next().unwrap_or(new.as_str());
            if old_name == new_name && old.as_str() != new.as_str() {
                moves.push((old.clone(), new.clone()));
            }
        }
    }
    moves
}
```

`resync_from_watch_batch`: process events, refresh the canonical snapshot, republish diagnostics for open docs, and log a message for any open document that was moved externally:

```rust
async fn resync_from_watch_batch(
    client: Client,
    state: Arc<state::LspState>,
    documents: Arc<Mutex<HashMap<Url, document::Document>>>,
    canonical_names: Arc<RwLock<HashMap<String, Vec<String>>>>,
    batch: Vec<ChangeEvent>,
) {
    let moves = pair_moves_by_filename(&batch);
    if let Err(e) = state.index.process_sync_events(batch).await {
        tracing::warn!("lsp watch resync failed: {e}");
        return;
    }
    // Refresh snapshot + republish, mirroring the existing post-save flow at
    // did_save (~line 185-206): extract that flow into a free function
    // `refresh_names_and_republish(client, state, documents, canonical_names)`
    // and call it from BOTH did_save and here, so the two paths cannot drift.
    refresh_names_and_republish(&client, &state, &documents, &canonical_names).await;

    for (old, new) in moves {
        let abs_old = state.vault.root().join(old.as_str());
        if let Ok(uri) = Url::from_file_path(&abs_old) {
            if documents.lock().await.contains_key(&uri) {
                client
                    .log_message(
                        MessageType::INFO,
                        format!(
                            "clepsydra: {old} moved to {new} (folder follows kind/project); reopen the file"
                        ),
                    )
                    .await;
            }
        }
    }
}
```

The extraction of `refresh_names_and_republish` is the fiddly part: today `refresh_canonical_names` and `publish_diagnostics_for` are `&self` methods. Convert their bodies to free functions taking `(&Client, &LspState, &Arc<Mutex<…documents…>>, &Arc<RwLock<…names…>>)` and keep thin `&self` wrappers delegating to them so every existing call site still compiles. Move method bodies verbatim — no logic changes.

Spawn in `initialized` (state is set by then):

```rust
async fn initialized(&self, _params: InitializedParams) {
    self.refresh_canonical_names().await;
    if let Some(state) = self.state_opt() {
        match self.spawn_vault_watcher(Arc::clone(&state)) {
            Ok(w) => *self.watcher.lock().unwrap() = Some(w),
            Err(e) => tracing::warn!("lsp watcher failed to start: {e}"),
        }
    }
    self.client
        .log_message(MessageType::INFO, "clepsydra LSP initialized")
        .await;
}
```

with:

```rust
fn spawn_vault_watcher(
    &self,
    state: Arc<state::LspState>,
) -> Result<crate::vault::sync::watcher::VaultWatcher, notify_debouncer_mini::notify::Error> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let watcher = crate::vault::sync::watcher::VaultWatcher::start(
        state.vault.root().to_path_buf(),
        std::time::Duration::from_millis(500),
        tx,
    )?;
    let client = self.client.clone();
    let documents = Arc::clone(&self.documents);
    let canonical_names = Arc::clone(&self.canonical_names);
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let mut batch = vec![event];
            while let Ok(next) = rx.try_recv() {
                batch.push(next);
            }
            resync_from_watch_batch(
                client.clone(),
                Arc::clone(&state),
                Arc::clone(&documents),
                Arc::clone(&canonical_names),
                batch,
            )
            .await;
        }
    });
    Ok(watcher)
}
```

Add the struct field `pub watcher: std::sync::Mutex<Option<crate::vault::sync::watcher::VaultWatcher>>` (init `Mutex::new(None)` in `run_lsp` and both test-support constructors), and switch `documents` to `Arc<Mutex<…>>` everywhere (mechanical: construction sites gain `Arc::new`, usage sites are unchanged since `Arc` derefs).

- [ ] **Step 4: Run tests**

Run: `cargo test lsp`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lsp/
git commit -m "feat(lsp): private watcher keeps the read-only index fresh; notify on external moves"
```

---

### Task 6: `clep lsp` subcommand; `serve --lsp` removed

**Files:**
- Modify: `src/bin/cli.rs` (`Serve` variant ~line 100, dispatch ~line 264)
- Modify: `src/lib.rs` (`run_server` ~line 690, delete `maybe_spawn_lsp` ~line 537, add `run_lsp_standalone` + `init_logging_stderr` near `init_logging` ~line 370)
- Modify: `docs/cli.md` (command table ~line 18, serve flags table ~line 139)

**Interfaces:**
- Consumes: `lsp::run_lsp()` (Task 4).
- Produces: `pub async fn run_lsp_standalone()` in `src/lib.rs`; `run_server(overrides: ServeOverrides)` (the `enable_lsp: bool` parameter is gone).

- [ ] **Step 1: Write the failing test**

CLI parsing test (follow the existing clap-test pattern in `src/bin/cli.rs` if one exists; otherwise add):

```rust
#[test]
fn lsp_is_a_subcommand_and_serve_rejects_the_old_flag() {
    use clap::Parser;
    assert!(Cli::try_parse_from(["clep", "lsp"]).is_ok());
    assert!(Cli::try_parse_from(["clep", "serve", "--lsp"]).is_err());
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --bin cli` (or the crate's test target for `cli.rs`)
Expected: FAIL — `lsp` unknown subcommand, `serve --lsp` still accepted.

- [ ] **Step 3: Implement**

`cli.rs`: remove the `lsp: bool` flag from `Serve`; add the subcommand:

```rust
/// Start the LSP server on stdio (standalone, read-only; the vault is
/// resolved from the editor's workspace root, falling back to config.toml)
Lsp,
```

Dispatch: `Commands::Serve { tls, port } => run_server(ServeOverrides { tls, port }).await?,` and `Commands::Lsp => run_lsp_standalone().await,`.

`lib.rs`: delete `maybe_spawn_lsp` (with its `std::process::exit(0)`); drop the parameter from `run_server`; add:

```rust
/// Entry point for `clep lsp`: LSP on stdio, logging strictly to stderr
/// (stdout carries the LSP protocol).
pub async fn run_lsp_standalone() {
    let _ = fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(Level::INFO.to_string())),
        )
        .with_writer(std::io::stderr)
        .try_init();
    lsp::run_lsp().await;
}
```

`docs/cli.md`: add `| clepsydra lsp | Standalone LSP server on stdio | ✅ implemented |` to the command table; delete the `--lsp` row from the serve flags table; add a short `## lsp` section pointing at `docs/lsp.md` for editor setup.

- [ ] **Step 4: Run the full suite**

Run: `cargo test` and `cargo clippy --all-targets`
Expected: green; clippy may flag newly-unused imports from the `maybe_spawn_lsp` removal — fix them.

- [ ] **Step 5: Manual smoke test**

```bash
cargo build
printf 'Content-Length: 110\r\n\r\n{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"rootUri":null,"capabilities":{}}}' | ./target/debug/clep lsp 2>/dev/null | head -c 400
```

Expected: a JSON-RPC response on stdout — an initialize *error* mentioning the vault (no config in cwd) is fine; protocol framing garbage or tracing output on stdout is a failure. (Byte-count the payload yourself if `Content-Length: 110` is off.)

- [ ] **Step 6: Commit**

```bash
git add src/bin/cli.rs src/lib.rs docs/cli.md
git commit -m "feat(cli): standalone clep lsp command; remove serve --lsp"
```

---

### Task 7: Documentation — lsp.md rewrite, getting-started, memory of the old model purged

**Files:**
- Modify: `docs/lsp.md` (rewrite the process-model and setup sections; capability table gains goto-definition, which the server advertises but the previous doc pass missed)
- Modify: `docs/getting-started.md` (section 8)
- Verify: `docs/cli.md` (done in Task 6), `docs/adr/0001-*.md` (done in Task 3)

**Interfaces:** none — prose only, but every technical claim must match the code as of Task 6.

- [ ] **Step 1: Rewrite `docs/lsp.md`**

Keep the existing house style (mcp.md-like: intro, Setup, Capabilities table, Save behavior, Troubleshooting). The rewrite must state:

- `clep lsp` is standalone and read-only: private in-memory index, own watcher, never writes vault files; run it and `clep serve` concurrently — that's the intended setup.
- Vault root: workspace root sent by the editor (`.clepsydra` marker, ancestors searched), falling back to the `config.toml` lookup; multi-vault "just works" via the editor's `root_dir`.
- Neovim 0.11 config block: same as before but `cmd = { 'clep', 'lsp' }`.
- Capabilities table: previous table **plus** go-to-definition (`definition_provider`, `src/lsp/mod.rs:57`).
- Save behavior: `didSave` reindexes the LSP's private index immediately; folder-drift moves now happen in `clep serve`'s watcher (ADR 0001 layer 2) — with the server running, a drifted save moves the file and the LSP logs `moved … reopen the file` (`:LspLog`); with the server down, drift heals at next `serve` startup.
- Troubleshooting: replace the "attaches then immediately stops = port conflict" entry (no longer possible) with: initialize failure = no `.clepsydra` in workspace and no resolvable config; check `:LspLog` and `clep config path --trace`.

- [ ] **Step 2: Update `docs/getting-started.md` section 8**

`cmd = { 'clep', 'lsp' }` in the Lua block; delete the paragraph about the editor owning the server / not running `clep serve` concurrently — state the opposite: run `clep serve` for the UI and let Neovim spawn `clep lsp` independently. Update the troubleshooting bullet to match the new failure mode (initialize error instead of port conflict).

- [ ] **Step 3: Cross-check every claim**

For each factual statement in the rewritten docs, point at the line of code that makes it true (capabilities list, resolve order, watcher behavior). Fix any mismatch in the docs, not the code.

- [ ] **Step 4: Commit**

```bash
git add docs/lsp.md docs/getting-started.md
git commit -m "docs(lsp): document standalone clep lsp (concurrent with serve)"
```

---

### Task 8: Integration — gates, merge to develop

- [ ] **Step 1: Full gates in the worktree**

Run: `cargo fmt --check`, `cargo clippy --all-targets`, `cargo test`.
Frontend untouched (no API surface changed — no OpenAPI regen needed); still run `bun --cwd ui run typecheck` to prove it.

- [ ] **Step 2: Merge**

The main checkout (`develop`) is dirty with unrelated in-flight work (TLS path resolution in `src/lib.rs`, `docs/configuration.md`, deleted `config.toml`, `ui/src/routeTree.gen.ts`) **plus this session's now-superseded doc edits** (`docs/lsp.md` untracked, `docs/getting-started.md`, `docs/cli.md`). In the main checkout:

```bash
rm docs/lsp.md                                  # superseded by the feature's version
git checkout -- docs/getting-started.md docs/cli.md   # ditto
git stash push -m "tls-path-resolution WIP"     # preserves the unrelated work
git merge --no-ff feature/standalone-lsp
git stash pop                                   # restore TLS WIP; resolve if lib.rs conflicts
git worktree remove <worktree-path>
git branch -d feature/standalone-lsp
```

If `git stash pop` conflicts in `src/lib.rs`, the feature's changes are already committed — resolve in favor of keeping both (the TLS hunks touch `TlsSettings`/`Settings::load_from`, the feature touches `run_server`/watcher/LSP plumbing; they do not overlap semantically).

- [ ] **Step 3: Post-merge gates on develop**

Run: `cargo test` once more on the merged develop with the stash popped.
