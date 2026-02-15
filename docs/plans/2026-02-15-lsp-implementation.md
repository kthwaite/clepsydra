# LSP Implementation Plan (Phase 0 + Phase 1)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the foundational IndexHandle concurrency refactor and core LSP navigation features (completions, go-to-definition, hover, diagnostics).

**Architecture:** Dedicated index thread owns VaultIndex + Vault; all access via closure-based `IndexHandle` channel. tower-lsp stdio handler runs alongside Axum HTTP server in unified process (`clepsydra serve --lsp`). In-memory diagnostics are instant; SQLite index writes are debounced.

**Tech Stack:** tower-lsp 0.20, ropey 1, tokio mpsc/oneshot channels, existing rusqlite + pulldown-cmark.

**Design doc:** `docs/plans/2026-02-15-lsp-design.md`

---

## Phase 0a: IndexHandle Foundation

### Task 1: Add new dependencies

**Files:**
- Modify: `Cargo.toml`

**Step 1: Add tower-lsp and ropey to Cargo.toml**

Add to `[dependencies]` (after `toml = "0.8"`, ~line 44):

```toml
tower-lsp = "0.20"
ropey = "1"
```

**Step 2: Verify it compiles**

Run: `cargo check`
Expected: compiles with no errors (new deps are unused, that's fine)

**Step 3: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "chore: add tower-lsp and ropey dependencies"
```

---

### Task 2: Create IndexHandle module

**Files:**
- Create: `src/vault/index_handle.rs`
- Modify: `src/vault/mod.rs` (add `pub mod index_handle;`)

The IndexHandle uses a closure-based channel — no enum needed. Every caller
passes a closure that runs on the index thread. Convenience methods wrap common
operations.

**Step 1: Write the test file**

Create `tests/index_handle_test.rs`:

```rust
use std::fs;

use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::index_handle::IndexHandle;
use clepsydra::vault::init::init_vault;
use tempfile::TempDir;

fn setup() -> (TempDir, IndexHandle) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();

    // Create a test page
    fs::write(
        root.join("hello.md"),
        "---\ntitle: Hello\ntags: [test]\n---\nBody text with [[Other Page]] link.\n",
    )
    .unwrap();
    fs::write(
        root.join("other-page.md"),
        "---\ntitle: Other Page\n---\nSome content.\n",
    )
    .unwrap();

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let handle = IndexHandle::spawn(index, vault);
    (tmp, handle)
}

#[tokio::test]
async fn with_index_returns_result() {
    let (_tmp, handle) = setup();
    let count: i64 = handle
        .with_index(|index, _vault| {
            index
                .connection()
                .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
                .unwrap()
        })
        .await
        .unwrap();
    assert_eq!(count, 2);
}

#[tokio::test]
async fn with_index_mut_can_modify() {
    let (_tmp, handle) = setup();
    let stats = handle
        .build()
        .await
        .unwrap();
    assert!(stats.pages_indexed > 0 || stats.pages_skipped > 0);
}

#[tokio::test]
async fn search_returns_results() {
    let (_tmp, handle) = setup();
    let results = handle
        .search("Hello".to_string(), 10)
        .await
        .unwrap();
    assert!(!results.is_empty());
    assert_eq!(results[0].title.as_deref(), Some("Hello"));
}

#[tokio::test]
async fn backlinks_returns_linking_pages() {
    let (_tmp, handle) = setup();
    let backlinks = handle
        .backlinks(
            clepsydra::vault::path::VaultPath::new("other-page.md").unwrap(),
            200,
        )
        .await
        .unwrap();
    assert_eq!(backlinks.len(), 1);
    assert!(backlinks[0].source_path.contains("hello"));
}

#[tokio::test]
async fn handle_is_clone_and_send() {
    let (_tmp, handle) = setup();
    let h2 = handle.clone();
    let join = tokio::spawn(async move {
        h2.with_index(|index, _| {
            index
                .connection()
                .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get::<_, i64>(0))
                .unwrap()
        })
        .await
        .unwrap()
    });
    let count = join.await.unwrap();
    assert_eq!(count, 2);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test index_handle_test`
Expected: compile error — `index_handle` module doesn't exist

**Step 3: Create `src/vault/index_handle.rs`**

```rust
use tokio::sync::{mpsc, oneshot};

use super::Vault;
use super::index::{
    BacklinkWithContext, BuildStats, IndexError, SearchResult, VaultIndex,
};
use super::path::VaultPath;
use super::sync::{ChangeEvent, SyncStats};

/// A boxed closure that runs on the index thread.
///
/// Takes `&mut VaultIndex` and `&Vault`. The index thread executes these
/// sequentially — no concurrent access, no Send requirement on VaultIndex.
type IndexFn = Box<dyn FnOnce(&mut VaultIndex, &Vault) + Send>;

/// Async-friendly handle to the index thread. Clone + Send + Sync.
///
/// All VaultIndex access goes through this handle — from Axum handlers,
/// the LSP backend, and the sync loop. The underlying `rusqlite::Connection`
/// never leaves the dedicated OS thread.
#[derive(Clone)]
pub struct IndexHandle {
    tx: mpsc::Sender<IndexFn>,
}

impl IndexHandle {
    /// Spawn the index thread, returning a handle for async callers.
    ///
    /// The thread owns `VaultIndex` and `Vault` and processes closures
    /// sequentially from the channel. When all `IndexHandle` clones are
    /// dropped, the channel closes and the thread exits.
    pub fn spawn(index: VaultIndex, vault: Vault) -> Self {
        let (tx, mut rx) = mpsc::channel::<IndexFn>(64);
        std::thread::Builder::new()
            .name("index".into())
            .spawn(move || {
                let mut index = index;
                let vault = vault;
                while let Some(f) = rx.blocking_recv() {
                    f(&mut index, &vault);
                }
                tracing::debug!("index thread shutting down");
            })
            .expect("failed to spawn index thread");
        IndexHandle { tx }
    }

    /// Execute a closure on the index thread and return its result.
    ///
    /// The closure has exclusive `&mut VaultIndex` access — no lock needed.
    /// Returns `Err` only if the index thread has shut down.
    pub async fn with_index<F, R>(&self, f: F) -> Result<R, IndexError>
    where
        F: FnOnce(&mut VaultIndex, &Vault) -> R + Send + 'static,
        R: Send + 'static,
    {
        let (reply_tx, reply_rx) = oneshot::channel();
        let cmd: IndexFn = Box::new(move |index, vault| {
            let _ = reply_tx.send(f(index, vault));
        });
        self.tx
            .send(cmd)
            .await
            .map_err(|_| IndexError::Other("index thread shut down".into()))?;
        reply_rx
            .await
            .map_err(|_| IndexError::Other("index thread shut down".into()))
    }

    // -----------------------------------------------------------------
    // Convenience methods (wrap with_index for common operations)
    // -----------------------------------------------------------------

    /// Full index rebuild.
    pub async fn build(&self) -> Result<BuildStats, IndexError> {
        self.with_index(|index, vault| index.build(vault))
            .await?
    }

    /// Resolve all unresolved links.
    pub async fn resolve_links(&self) -> Result<(), IndexError> {
        self.with_index(|index, _| index.resolve_links()).await?
    }

    /// Index a single page.
    pub async fn index_page(&self, vault_path: VaultPath) -> Result<bool, IndexError> {
        self.with_index(move |index, vault| index.index_page(vault, &vault_path))
            .await?
    }

    /// Remove a page from the index.
    pub async fn remove_page(&self, vault_path: VaultPath) -> Result<bool, IndexError> {
        self.with_index(move |index, _| index.remove_page(&vault_path))
            .await?
    }

    /// Resolve links for a single page (outgoing + incoming).
    pub async fn resolve_links_for_page(
        &self,
        vault_path: VaultPath,
    ) -> Result<usize, IndexError> {
        self.with_index(move |index, _| index.resolve_links_for_page(&vault_path))
            .await?
    }

    /// Process a batch of sync events (watcher changes).
    pub async fn process_sync_events(
        &self,
        events: Vec<ChangeEvent>,
    ) -> Result<SyncStats, IndexError> {
        self.with_index(move |index, vault| {
            super::sync::SyncEngine::process_events(&events, vault, index)
        })
        .await?
    }

    /// Query backlinks with surrounding text context.
    pub async fn backlinks(
        &self,
        vault_path: VaultPath,
        max_context_chars: usize,
    ) -> Result<Vec<BacklinkWithContext>, IndexError> {
        self.with_index(move |index, vault| {
            index.backlinks_with_context(vault, &vault_path, max_context_chars)
        })
        .await?
    }

    /// Full-text search.
    pub async fn search(
        &self,
        query: String,
        limit: usize,
    ) -> Result<Vec<SearchResult>, IndexError> {
        self.with_index(move |index, _| index.search(&query, limit))
            .await?
    }

    /// Get pages that link to the given target.
    pub async fn reverse_deps(
        &self,
        vault_path: VaultPath,
    ) -> Result<Vec<VaultPath>, IndexError> {
        self.with_index(move |index, _| index.reverse_deps(&vault_path))
            .await?
    }

    /// Invalidate resolved links pointing to a page.
    pub async fn invalidate_links_to(
        &self,
        vault_path: VaultPath,
    ) -> Result<usize, IndexError> {
        self.with_index(move |index, _| index.invalidate_links_to(&vault_path))
            .await?
    }
}
```

**Step 4: Register module in `src/vault/mod.rs`**

Add `pub mod index_handle;` after the existing `pub mod index;` line (after line 15).

**Step 5: Run tests**

Run: `cargo test --test index_handle_test`
Expected: all 5 tests pass

**Step 6: Commit**

```bash
git add src/vault/index_handle.rs src/vault/mod.rs tests/index_handle_test.rs
git commit -m "feat(vault): add IndexHandle for channel-based index access"
```

---

### Task 3: Migrate AppState to use IndexHandle

**Files:**
- Modify: `src/api/mod.rs:24-35`
- Modify: `src/lib.rs:228-277` (index construction + AppState creation)

**Step 1: Update AppState struct**

In `src/api/mod.rs`, change the `index` field (line 26) from:

```rust
pub index: Arc<parking_lot::Mutex<VaultIndex>>,
```

to:

```rust
pub index: IndexHandle,
```

Update imports: remove `VaultIndex` import (line 21), add:

```rust
use crate::vault::index_handle::IndexHandle;
```

Remove `Arc` import if no longer needed (check if `cas` still uses it — it does, so keep `Arc`).

**Step 2: Attempt to compile**

Run: `cargo check`
Expected: many errors in API handlers and `src/lib.rs` — every `state.index.lock()` call is now invalid. This is expected; we fix them in subsequent tasks.

**Step 3: Update `run_server()` in `src/lib.rs`**

Replace lines 228-243 (index open, build, wrap):

```rust
// Open index
let db_path = vault.root().join(".clepsydra/cache.db");
let mut index = VaultIndex::open(&db_path)?;

// Build index and resolve links
let stats = index.build(&vault)?;
info!(
    pages_indexed = stats.pages_indexed,
    pages_skipped = stats.pages_skipped,
    pages_removed = stats.pages_removed,
    warnings = stats.warnings.len(),
    "index built"
);
index.resolve_links()?;

// Wrap index for shared access
let index = Arc::new(parking_lot::Mutex::new(index));
```

with:

```rust
// Open index
let db_path = vault.root().join(".clepsydra/cache.db");
let mut index = VaultIndex::open(&db_path)?;

// Build index and resolve links
let stats = index.build(&vault)?;
info!(
    pages_indexed = stats.pages_indexed,
    pages_skipped = stats.pages_skipped,
    pages_removed = stats.pages_removed,
    warnings = stats.warnings.len(),
    "index built"
);
index.resolve_links()?;

// Spawn index thread
let index_handle = vault::index_handle::IndexHandle::spawn(index, vault.clone());
```

Update the AppState construction (lines 262-272) to use `index_handle`
instead of `Arc::clone(&index)`:

```rust
let state = Arc::new(AppState {
    vault,
    index: index_handle,
    cas: cas_arc,
    warnings: parking_lot::Mutex::new(stats.warnings),
    change_tx: change_broadcast_tx,
    hooks,
    delete_hooks,
    archive_ingest_lock: tokio::sync::Mutex::new(()),
});
```

Remove the now-unused `use std::sync::Arc;` if no other usage remains.
(Check: `Arc` is still used for `state` itself, `cas_arc`. Keep `Arc`.)

**Step 4: Do not commit yet** — compile will still fail until handlers are migrated.

---

### Task 4: Migrate sync loop to use IndexHandle

**Files:**
- Modify: `src/lib.rs:274-313` (sync loop)

**Step 1: Replace the sync loop**

The old sync loop (lines 274-313) locks the mutex and calls
`SyncEngine::process_events` directly. Replace with:

```rust
// Spawn file watcher + sync loop
let vault_root_buf = state.vault.root().to_path_buf();
let sync_index = state.index.clone();
let (change_tx, mut change_rx) = tokio::sync::mpsc::unbounded_channel::<ChangeEvent>();
let sync_change_tx = state.change_tx.clone();

let _watcher = VaultWatcher::start(vault_root_buf, Duration::from_millis(500), change_tx)?;

tokio::spawn(async move {
    loop {
        let batch = match change_rx.recv().await {
            Some(event) => drain_change_batch(event, &mut change_rx),
            None => break,
        };

        match sync_index.process_sync_events(batch).await {
            Ok(stats) => {
                if stats.pages_indexed > 0 || stats.pages_removed > 0 {
                    tracing::info!(
                        indexed = stats.pages_indexed,
                        skipped = stats.pages_skipped,
                        removed = stats.pages_removed,
                        resolved = stats.links_resolved,
                        deps = stats.deps_reresolved,
                        "sync cycle complete"
                    );
                }

                // Reconstruct batch for notification (we moved it into the closure)
                // Actually, we need to send the notification. Restructure:
            }
            Err(e) => {
                tracing::error!("sync error: {e}");
            }
        }
    }
});
```

**Problem:** `process_sync_events` consumes the batch, but we need it for
`notification_from_batch`. Fix by cloning the batch before sending, or by
having the index handle return the notification data. Simplest: clone the
batch for the notification:

```rust
tokio::spawn(async move {
    loop {
        let batch = match change_rx.recv().await {
            Some(event) => drain_change_batch(event, &mut change_rx),
            None => break,
        };

        let notification = notification_from_batch(&batch);

        match sync_index.process_sync_events(batch).await {
            Ok(stats) => {
                if stats.pages_indexed > 0 || stats.pages_removed > 0 {
                    tracing::info!(
                        indexed = stats.pages_indexed,
                        skipped = stats.pages_skipped,
                        removed = stats.pages_removed,
                        resolved = stats.links_resolved,
                        deps = stats.deps_reresolved,
                        "sync cycle complete"
                    );
                }

                if let Some(notification) = notification {
                    let _ = sync_change_tx.send(notification);
                }
            }
            Err(e) => {
                tracing::error!("sync error: {e}");
            }
        }
    }
});
```

Remove the now-unused `sync_index` / `sync_vault` lines that previously
cloned `Arc`s. Remove `SyncEngine` from imports if no longer used directly
in this file (it's used inside `IndexHandle` now).

**Step 2: Do not commit yet** — handlers still need migration.

---

### Task 5: Migrate API handlers

**Files:**
- Modify: `src/api/pages.rs` (9 lock sites)
- Modify: `src/api/index_routes.rs` (12 lock sites)
- Modify: `src/api/academic.rs` (13 lock sites)
- Modify: `src/api/folders.rs` (4 lock sites)
- Modify: `src/api/archive.rs` (2 lock sites)

This is a mechanical transformation. Every `state.index.lock()` call becomes
a `state.index.with_index(...)` call. The pattern:

#### Pattern A: Read-only query (most common)

Before:
```rust
let index = state.index.lock();
let result = index.connection().query_row("SQL", params![x], |row| row.get(0))
    .map_err(|e| ApiError::internal(e.to_string()))?;
// use result
```

After:
```rust
let result = state.index.with_index({
    let x = x.clone(); // clone captures that need to be 'static
    move |index, _vault| {
        index.connection().query_row("SQL", params![x], |row| row.get(0))
    }
}).await
    .map_err(|e| ApiError::internal(e.to_string()))?
    .map_err(|e| ApiError::internal(e.to_string()))?;
// use result
```

Note the **double `?`**: the outer `?` handles IndexHandle channel errors,
the inner `?` handles the SQLite query error. To avoid this, wrap the whole
closure body in a single `Result`:

```rust
let result = state.index.with_index({
    let x = x.clone();
    move |index, _vault| -> Result<_, ApiError> {
        Ok(index.connection().query_row("SQL", params![x], |row| row.get(0))
            .map_err(|e| ApiError::internal(e.to_string()))?)
    }
}).await
    .map_err(|e| ApiError::internal(e.to_string()))??;
```

Or more simply, keep the raw value and handle errors outside:

```rust
let result = state.index.with_index({
    let x = x.clone();
    move |index, _vault| {
        index.connection().query_row("SQL", params![x], |row| row.get::<_, String>(0))
    }
}).await.map_err(|e| ApiError::internal(e.to_string()))?
    .map_err(|e| ApiError::internal(e.to_string()))?;
```

#### Pattern B: Mutable operation (index_page, remove_page, etc.)

Before:
```rust
{
    let mut index = state.index.lock();
    index.index_page(&state.vault, &vault_path)?;
}
```

After (use convenience method):
```rust
state.index.index_page(vault_path.clone()).await
    .map_err(|e| ApiError::internal(e.to_string()))?;
```

#### Pattern C: MutationPlanner (two-phase)

Before:
```rust
let plan = {
    let index = state.index.lock();
    let planner = MutationPlanner::new(&state.vault, &index);
    planner.plan(&MutationOp::DeletePage { ... })?
};
{
    let mut index = state.index.lock();
    plan.execute(&state.vault, &mut index, &state.hooks)?;
}
```

After (single closure for both phases):
```rust
let hooks = &state.hooks;
state.index.with_index({
    let op = MutationOp::DeletePage { ... };
    let hooks_ref: Vec<_> = state.hooks.iter().collect(); // if needed
    move |index, vault| -> Result<(), IndexError> {
        let planner = MutationPlanner::new(vault, index);
        let plan = planner.plan(&op)?;
        plan.execute(vault, index, &[])?; // hooks need special handling
        Ok(())
    }
}).await.map_err(|e| ApiError::internal(e.to_string()))??;
```

**Important:** The `PostMoveHook` and `PostDeleteHook` traits are `dyn`
objects stored in `AppState`. They may not be `Send`. Check if they implement
`Send + Sync`. If not, the hooks need to be invoked outside the closure, or
the hook traits need `Send + Sync` bounds.

Check `src/vault/hooks.rs` for trait bounds. If hooks are `Send + Sync`
(likely, since they're stored in `Arc<AppState>` which requires `Send + Sync`
for Axum), they can be captured in closures.

**Migration order:** Work file by file. After each file compiles, run its
related tests. The handlers must become `async` if they aren't already (Axum
handlers are already async).

**Step 1: Migrate `src/api/pages.rs`**

All 9 lock sites. The handler functions are already async. Convert each
`state.index.lock()` to `state.index.with_index(...)`.await.

Key callsites (by line from exploration):
- L158: list_pages — read query
- L241: get_page — read query (page lookup by UUID)
- L348: update_page — mutation (index_page after write)
- L438: delete_page — mutation (invalidate_links_to)
- L510-524: delete_page — read queries (backlinks check)
- L568-578: delete_page — MutationPlanner pattern
- L645-655: move_page — MutationPlanner pattern

**Step 2: Migrate `src/api/index_routes.rs`**

12 lock sites. Mix of reads (backlinks, outlinks, unresolved, tags, stats,
graph, browse, search) and one mutation (rebuild_index, quick_create).

**Step 3: Migrate `src/api/academic.rs`**

13 lock sites. Heavy use of `connection()` for raw SQL (cite_key checks,
work lookups, annotation queries). Plus mutations (index_page after creates).

**Step 4: Migrate `src/api/folders.rs`**

4 lock sites. List folder contents, delete folder (batch orphan removal),
move folder (MutationPlanner).

**Step 5: Migrate `src/api/archive.rs`**

2 lock sites. Ingest dedup check (read) and index_page after write (mutation).

**Step 6: Verify compilation**

Run: `cargo check`
Expected: compiles with no errors

**Step 7: Run full test suite**

Run: `cargo test`
Expected: all existing tests pass (after test setup migration in next task)

---

### Task 6: Migrate test setup

**Files:**
- Modify: `tests/api_test.rs:22-55` (setup_server)
- Modify: `tests/e2e_test.rs:22-55` (setup_server — identical pattern)

Both files construct `AppState` with `Arc::new(parking_lot::Mutex::new(index))`.
Migrate to `IndexHandle::spawn(index, vault.clone())`.

**Step 1: Update `tests/api_test.rs` setup_server()**

Before (lines 28-47):
```rust
let vault = Vault::open(&root).unwrap();
let db_path = vault.root().join(".clepsydra/cache.db");
let mut index = VaultIndex::open(&db_path).unwrap();
index.build(&vault).unwrap();
index.resolve_links().unwrap();
// ...
let state = Arc::new(AppState {
    vault,
    index: Arc::new(parking_lot::Mutex::new(index)),
    // ...
});
```

After:
```rust
let vault = Vault::open(&root).unwrap();
let db_path = vault.root().join(".clepsydra/cache.db");
let mut index = VaultIndex::open(&db_path).unwrap();
index.build(&vault).unwrap();
index.resolve_links().unwrap();

let index_handle = IndexHandle::spawn(index, vault.clone());
// ...
let state = Arc::new(AppState {
    vault,
    index: index_handle,
    // ...
});
```

Add import: `use clepsydra::vault::index_handle::IndexHandle;`
Remove import: `parking_lot` if no longer used in the file.

**Step 2: Apply identical change to `tests/e2e_test.rs`**

**Step 3: Run all tests**

Run: `cargo test`
Expected: all tests pass

**Step 4: Run clippy**

Run: `cargo clippy`
Expected: no new warnings

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: migrate from Arc<Mutex<VaultIndex>> to IndexHandle

Replace direct mutex locking with channel-based IndexHandle across all
API handlers, sync loop, and test setup. VaultIndex now lives on a
dedicated OS thread; all access goes through async closures."
```

---

## Phase 0b: CLI + tower-lsp Scaffold

### Task 7: Add --lsp flag to serve subcommand

**Files:**
- Modify: `src/bin/cli.rs:61-65` (Serve variant)
- Modify: `src/lib.rs` (run_server signature)

**Step 1: Add `lsp` flag to Serve**

In `src/bin/cli.rs`, change the `Serve` variant (line 65) from:

```rust
Serve,
```

to:

```rust
Serve {
    /// Start the LSP server on stdio alongside the HTTP server
    #[arg(long)]
    lsp: bool,
},
```

Update the match arm (line 97) from:

```rust
Commands::Serve => {
    run_server().await?;
}
```

to:

```rust
Commands::Serve { lsp } => {
    run_server(lsp).await?;
}
```

**Step 2: Update `run_server` signature**

In `src/lib.rs`, change line 197:

```rust
pub async fn run_server() -> Result<(), Box<dyn std::error::Error>> {
```

to:

```rust
pub async fn run_server(enable_lsp: bool) -> Result<(), Box<dyn std::error::Error>> {
```

Add a placeholder log after the state construction:

```rust
if enable_lsp {
    info!("LSP mode enabled (not yet implemented)");
}
```

**Step 3: Verify it compiles and runs**

Run: `cargo check`
Run: `cargo run -- serve --help` (should show `--lsp` flag)

**Step 4: Commit**

```bash
git add src/bin/cli.rs src/lib.rs
git commit -m "feat(cli): add --lsp flag to serve subcommand"
```

---

### Task 8: Create tower-lsp scaffold

**Files:**
- Create: `src/lsp/mod.rs`
- Create: `src/lsp/document.rs`
- Modify: `src/lib.rs` (add `pub mod lsp;`, wire up in `run_server`)

**Step 1: Create `src/lsp/mod.rs` with minimal Backend**

```rust
pub mod document;

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;
use tower_lsp::jsonrpc::Result;
use tower_lsp::lsp_types::*;
use tower_lsp::{Client, LanguageServer, LspService, Server};

use crate::api::AppState;

/// The tower-lsp backend. Implements the LanguageServer trait.
pub struct LspBackend {
    client: Client,
    state: Arc<AppState>,
    documents: Mutex<HashMap<Url, document::Document>>,
}

impl LspBackend {
    pub fn new(client: Client, state: Arc<AppState>) -> Self {
        Self {
            client,
            state,
            documents: Mutex::new(HashMap::new()),
        }
    }
}

#[tower_lsp::async_trait]
impl LanguageServer for LspBackend {
    async fn initialize(&self, _params: InitializeParams) -> Result<InitializeResult> {
        Ok(InitializeResult {
            capabilities: ServerCapabilities {
                position_encoding: Some(PositionEncodingKind::UTF8),
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                completion_provider: Some(CompletionOptions {
                    trigger_characters: Some(vec!["[".to_string(), "#".to_string()]),
                    ..Default::default()
                }),
                hover_provider: Some(HoverProviderCapability::Simple(true)),
                definition_provider: Some(OneOf::Left(true)),
                references_provider: Some(OneOf::Left(true)),
                document_symbol_provider: Some(OneOf::Left(true)),
                workspace_symbol_provider: Some(OneOf::Left(true)),
                rename_provider: Some(OneOf::Right(RenameOptions {
                    prepare_provider: Some(true),
                    work_done_progress_options: Default::default(),
                })),
                code_action_provider: Some(CodeActionProviderCapability::Simple(true)),
                code_lens_provider: Some(CodeLensOptions {
                    resolve_provider: Some(true),
                }),
                ..Default::default()
            },
            ..Default::default()
        })
    }

    async fn initialized(&self, _params: InitializedParams) {
        self.client
            .log_message(MessageType::INFO, "clepsydra LSP initialized")
            .await;
    }

    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }
}

/// Start the LSP server on stdin/stdout.
///
/// This function blocks until the editor disconnects (stdin EOF) or sends
/// a shutdown request.
pub async fn run_lsp(state: Arc<AppState>) {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();

    let (service, socket) = LspService::new(|client| LspBackend::new(client, state));

    Server::new(stdin, stdout, socket).serve(service).await;
}
```

**Step 2: Create stub `src/lsp/document.rs`**

```rust
use ropey::Rope;

use crate::vault::link::Link;
use crate::vault::page::PageMeta;

/// An open document buffer with parsed metadata.
pub struct Document {
    /// Efficient text buffer for line/col ↔ byte-offset conversion.
    pub rope: Rope,
    /// Parsed frontmatter metadata.
    pub meta: PageMeta,
    /// Markdown body after frontmatter fences.
    pub body: String,
    /// Byte offset where body starts in the full document text.
    pub body_byte_offset: usize,
    /// Links extracted from the body.
    pub links: Vec<Link>,
    /// Editor-assigned version counter.
    pub version: i32,
    /// True if the persistent index is stale relative to in-memory state.
    pub dirty: bool,
}
```

**Step 3: Register the module**

In `src/lib.rs`, add after line 3 (`pub mod vault;`):

```rust
pub mod lsp;
```

**Step 4: Wire up in `run_server`**

In `src/lib.rs`, replace the placeholder log with:

```rust
if enable_lsp {
    info!("starting LSP server on stdio");
    let lsp_state = Arc::clone(&state);
    tokio::spawn(async move {
        lsp::run_lsp(lsp_state).await;
        // LSP finished (editor disconnected). Shut down the process.
        tracing::info!("LSP disconnected, shutting down");
        std::process::exit(0);
    });
}
```

**Step 5: Verify compilation**

Run: `cargo check`
Expected: compiles (Document fields may warn as unused — that's fine)

**Step 6: Commit**

```bash
git add src/lsp/ src/lib.rs
git commit -m "feat(lsp): add tower-lsp scaffold with initialize/shutdown"
```

---

### Task 9: Implement Document struct with offset mapping

**Files:**
- Modify: `src/lsp/document.rs`
- Create: `tests/lsp_document_test.rs`

**Step 1: Write tests**

Create `tests/lsp_document_test.rs`:

```rust
use clepsydra::lsp::document::Document;

const SIMPLE_DOC: &str = "\
---
title: Test Page
tags: [alpha, beta]
---
Hello world.

This has a [[Wikilink]] in it.
";

#[test]
fn parse_extracts_meta_and_body() {
    let doc = Document::from_text(SIMPLE_DOC, 1);
    assert_eq!(doc.meta.title.as_deref(), Some("Test Page"));
    assert_eq!(doc.meta.tags, vec!["alpha", "beta"]);
    assert!(doc.body.starts_with("Hello world."));
    assert!(doc.body_byte_offset > 0);
}

#[test]
fn body_byte_offset_is_correct() {
    let doc = Document::from_text(SIMPLE_DOC, 1);
    // The body should start right after the closing ---\n
    let expected_body = &SIMPLE_DOC[doc.body_byte_offset..];
    assert_eq!(expected_body, doc.body);
}

#[test]
fn links_are_extracted() {
    let doc = Document::from_text(SIMPLE_DOC, 1);
    assert_eq!(doc.links.len(), 1);
    assert_eq!(doc.links[0].target_raw, "Wikilink");
}

#[test]
fn byte_offset_to_position_first_line() {
    let doc = Document::from_text(SIMPLE_DOC, 1);
    // "Hello" starts at body offset 0
    let pos = doc.byte_offset_to_position(0);
    // Should be on the line right after the closing ---
    assert_eq!(pos.character, 0);
}

#[test]
fn byte_offset_to_position_link_span() {
    let doc = Document::from_text(SIMPLE_DOC, 1);
    let link = &doc.links[0];
    let start_pos = doc.byte_offset_to_position(link.span.start);
    let end_pos = doc.byte_offset_to_position(link.span.end);
    // The link should be on the last non-empty line
    assert_eq!(start_pos.line, end_pos.line);
    assert!(end_pos.character > start_pos.character);
}

#[test]
fn position_to_byte_offset_roundtrip() {
    let doc = Document::from_text(SIMPLE_DOC, 1);
    for offset in [0, 5, 10, doc.body.len().saturating_sub(1)] {
        if offset < doc.body.len() {
            let pos = doc.byte_offset_to_position(offset);
            let back = doc.position_to_body_byte_offset(pos);
            assert_eq!(back, Some(offset), "roundtrip failed for offset {offset}");
        }
    }
}

#[test]
fn malformed_frontmatter_uses_whole_file_as_body() {
    let doc = Document::from_text("no frontmatter here\n[[link]]\n", 1);
    assert!(doc.body_byte_offset == 0 || doc.body.contains("no frontmatter"));
    // Should still extract links from the content
}

#[test]
fn link_at_position_finds_correct_link() {
    let doc = Document::from_text(SIMPLE_DOC, 1);
    let link = &doc.links[0];
    let mid = link.span.start + 1; // somewhere inside the link span
    let pos = doc.byte_offset_to_position(mid);
    let found = doc.link_at_position(pos);
    assert!(found.is_some());
    assert_eq!(found.unwrap().target_raw, "Wikilink");
}

#[test]
fn link_at_position_returns_none_outside_links() {
    let doc = Document::from_text(SIMPLE_DOC, 1);
    // Position at the very start of the body — "Hello" — not a link
    let pos = doc.byte_offset_to_position(0);
    assert!(doc.link_at_position(pos).is_none());
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test lsp_document_test`
Expected: compile error — `Document::from_text` doesn't exist

**Step 3: Implement Document**

Update `src/lsp/document.rs`:

```rust
use ropey::Rope;
use tower_lsp::lsp_types::Position;

use crate::vault::link::{Link, extract_links};
use crate::vault::page::{PageMeta, parse_frontmatter};

/// An open document buffer with parsed metadata.
pub struct Document {
    /// Efficient text buffer for line/col ↔ byte-offset conversion.
    pub rope: Rope,
    /// Parsed frontmatter metadata.
    pub meta: PageMeta,
    /// Markdown body after frontmatter fences.
    pub body: String,
    /// Byte offset where body starts in the full document text.
    pub body_byte_offset: usize,
    /// Links extracted from the body.
    pub links: Vec<Link>,
    /// Editor-assigned version counter.
    pub version: i32,
    /// True if the persistent index is stale relative to in-memory state.
    pub dirty: bool,
}

impl Document {
    /// Parse a full document text into a Document.
    pub fn from_text(text: &str, version: i32) -> Self {
        let rope = Rope::from_str(text);

        let (meta, body, body_byte_offset) = match parse_frontmatter(text) {
            Ok((meta, body)) => {
                // Find where the body starts in the original text.
                // The body is everything after the closing "---\n".
                let offset = text.len() - body.len();
                (meta, body, offset)
            }
            Err(_) => {
                // Malformed frontmatter: treat entire text as body.
                let meta = PageMeta::default();
                (meta, text.to_string(), 0)
            }
        };

        let links = extract_links(&body);

        Document {
            rope,
            meta,
            body,
            body_byte_offset,
            links,
            version,
            dirty: false,
        }
    }

    /// Convert a byte offset within the body to an LSP Position.
    ///
    /// The offset is relative to the body (not the full document).
    /// Returns a Position with UTF-8 byte character offsets (we declare
    /// PositionEncodingKind::UTF8 in capabilities).
    pub fn byte_offset_to_position(&self, body_offset: usize) -> Position {
        let abs_offset = self.body_byte_offset + body_offset;
        // Clamp to document length
        let abs_offset = abs_offset.min(self.rope.len_bytes());
        let line = self.rope.byte_to_line(abs_offset);
        let line_start = self.rope.line_to_byte(line);
        let character = (abs_offset - line_start) as u32;
        Position {
            line: line as u32,
            character,
        }
    }

    /// Convert an LSP Position to a byte offset within the body.
    ///
    /// Returns None if the position is within the frontmatter region.
    pub fn position_to_body_byte_offset(&self, pos: Position) -> Option<usize> {
        let line = pos.line as usize;
        if line >= self.rope.len_lines() {
            return None;
        }
        let line_start = self.rope.line_to_byte(line);
        let abs_offset = line_start + pos.character as usize;
        if abs_offset < self.body_byte_offset {
            return None; // inside frontmatter
        }
        Some(abs_offset - self.body_byte_offset)
    }

    /// Find the Link at a given LSP position, if any.
    pub fn link_at_position(&self, pos: Position) -> Option<&Link> {
        let body_offset = self.position_to_body_byte_offset(pos)?;
        self.links
            .iter()
            .find(|link| link.span.contains(&body_offset))
    }

    /// Convert a Link's span to an LSP Range.
    pub fn link_to_range(&self, link: &Link) -> tower_lsp::lsp_types::Range {
        let start = self.byte_offset_to_position(link.span.start);
        let end = self.byte_offset_to_position(link.span.end);
        tower_lsp::lsp_types::Range { start, end }
    }
}
```

Check if `PageMeta` implements `Default`. If not, provide a fallback
construction in the `Err` branch (create a PageMeta with a generated UUID
and empty fields). Refer to `src/vault/page.rs` for the struct definition.

**Step 4: Run tests**

Run: `cargo test --test lsp_document_test`
Expected: all tests pass

**Step 5: Commit**

```bash
git add src/lsp/document.rs tests/lsp_document_test.rs
git commit -m "feat(lsp): implement Document struct with offset mapping"
```

---

## Phase 1: Core Navigation

### Task 10: Document lifecycle (did_open / did_change / did_close)

**Files:**
- Modify: `src/lsp/mod.rs`

**Step 1: Implement the three lifecycle methods on LspBackend**

Add to the `LanguageServer` impl:

```rust
async fn did_open(&self, params: DidOpenTextDocumentParams) {
    let uri = params.text_document.uri;
    let text = params.text_document.text;
    let version = params.text_document.version;

    let doc = document::Document::from_text(&text, version);

    // TODO: add vault_path to open_files set (Task 12)
    // TODO: publish diagnostics (Task 11)

    let mut docs = self.documents.lock().await;
    docs.insert(uri.clone(), doc);
}

async fn did_change(&self, params: DidChangeTextDocumentParams) {
    let uri = params.text_document.uri;
    let version = params.text_document.version;

    // Full sync: take the last (only) content change
    if let Some(change) = params.content_changes.into_iter().last() {
        let doc = document::Document::from_text(&change.text, version);
        // mark dirty for debounced index update
        let mut docs = self.documents.lock().await;
        if let Some(existing) = docs.get_mut(&uri) {
            *existing = doc;
            existing.dirty = true;
        } else {
            let mut doc = doc;
            doc.dirty = true;
            docs.insert(uri.clone(), doc);
        }

        // TODO: publish diagnostics (Task 11)
        // TODO: send debounce request (Task 15)
    }
}

async fn did_close(&self, params: DidCloseTextDocumentParams) {
    let uri = params.text_document.uri;
    let mut docs = self.documents.lock().await;

    // TODO: flush dirty index update if needed
    // TODO: remove from open_files set

    docs.remove(&uri);
}
```

**Step 2: Verify compilation**

Run: `cargo check`

**Step 3: Commit**

```bash
git add src/lsp/mod.rs
git commit -m "feat(lsp): implement document lifecycle (open/change/close)"
```

---

### Task 11: Diagnostics (in-memory)

**Files:**
- Modify: `src/lsp/mod.rs` (add diagnostics helper + call from lifecycle)

**Step 1: Add a `publish_diagnostics` helper to LspBackend**

Add as an `impl LspBackend` method (outside the LanguageServer trait impl):

```rust
use std::collections::HashSet;

use crate::vault::canonical::CanonicalName;

impl LspBackend {
    /// Compute and publish diagnostics for a single document.
    ///
    /// Uses in-memory state only (canonical name snapshot). No index thread
    /// queries — this must be fast enough to call on every keystroke.
    async fn publish_diagnostics_for(&self, uri: &Url, doc: &document::Document) {
        let mut diagnostics = Vec::new();

        // Check for frontmatter parse errors (doc would have default meta)
        // This is implicit — if meta has no title and body == full text, frontmatter failed.
        // We can detect this by checking body_byte_offset == 0 AND the text starts with non-"---"
        // For now, skip frontmatter diagnostics (they require detecting parse failure).

        // Check links against canonical name snapshot
        // TODO: maintain a HashSet<CanonicalName> snapshot, refreshed on flush
        // For now, skip link diagnostics until Task 15 (debounce + snapshot)

        for link in &doc.links {
            if link.span.start == 0 && link.span.end == 0 {
                continue; // skip property ref links
            }
            // Placeholder: will check against canonical name set
            let range = doc.link_to_range(link);
            // TODO: check if link.target_raw resolves
            let _ = range; // suppress unused warning
        }

        self.client
            .publish_diagnostics(uri.clone(), diagnostics, Some(doc.version))
            .await;
    }
}
```

**Step 2: Call from did_open and did_change**

In `did_open`, after inserting into the documents map, add:

```rust
let docs = self.documents.lock().await;
if let Some(doc) = docs.get(&uri) {
    self.publish_diagnostics_for(&uri, doc).await;
}
```

Similarly in `did_change`.

Note: the lock needs to be held or the doc cloned. Since `publish_diagnostics_for`
is async, we can't hold the lock across it. Clone the relevant data or restructure.
Simplest: read the doc, drop the lock, then publish:

```rust
let (uri_clone, doc_snapshot) = {
    let docs = self.documents.lock().await;
    match docs.get(&uri) {
        Some(doc) => (uri.clone(), /* clone needed fields */),
        None => return,
    }
};
```

For now, `publish_diagnostics_for` can take owned data instead of references,
or we can publish inside the lock (since it's a tokio Mutex, it's safe across
.await). Keep it simple — hold the tokio::Mutex across the publish call:

```rust
// In did_open, after inserting:
{
    let docs = self.documents.lock().await;
    if let Some(doc) = docs.get(&uri) {
        self.publish_diagnostics_for(&uri, doc).await;
    }
}
```

This works because `tokio::sync::Mutex` is designed for .await across lock.

**Step 3: Verify compilation**

Run: `cargo check`

**Step 4: Commit**

```bash
git add src/lsp/mod.rs
git commit -m "feat(lsp): add diagnostic publishing scaffold"
```

---

### Task 12: Go to definition

**Files:**
- Modify: `src/lsp/mod.rs`

**Step 1: Implement `goto_definition`**

Add to the `LanguageServer` impl:

```rust
async fn goto_definition(
    &self,
    params: GotoDefinitionParams,
) -> Result<Option<GotoDefinitionResponse>> {
    let uri = params.text_document_position_params.text_document.uri;
    let pos = params.text_document_position_params.position;

    let link = {
        let docs = self.documents.lock().await;
        let doc = match docs.get(&uri) {
            Some(d) => d,
            None => return Ok(None),
        };
        doc.link_at_position(pos).cloned()
    };

    let link = match link {
        Some(l) => l,
        None => return Ok(None),
    };

    // Resolve the link target via the index
    let target_raw = link.target_raw.clone();
    let canonical = CanonicalName::from_title(&target_raw);

    let target_path: Option<String> = self
        .state
        .index
        .with_index({
            let cn = canonical.as_str().to_string();
            move |index, _vault| {
                index
                    .connection()
                    .query_row(
                        "SELECT p.path FROM canonical_names cn
                         JOIN pages p ON p.id = cn.page_id
                         WHERE cn.canonical_name = ?1
                         LIMIT 1",
                        rusqlite::params![cn],
                        |row| row.get(0),
                    )
                    .ok()
            }
        })
        .await
        .map_err(|e| tower_lsp::jsonrpc::Error::internal_error())?;

    let target_path = match target_path {
        Some(p) => p,
        None => return Ok(None),
    };

    // Convert vault path to file URI
    let abs_path = self.state.vault.resolve(
        &crate::vault::path::VaultPath::new(&target_path)
            .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?,
    );
    let target_uri = Url::from_file_path(&abs_path)
        .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;

    Ok(Some(GotoDefinitionResponse::Scalar(Location {
        uri: target_uri,
        range: tower_lsp::lsp_types::Range::default(), // jump to file start
    })))
}
```

**Step 2: Verify compilation**

Run: `cargo check`

**Step 3: Commit**

```bash
git add src/lsp/mod.rs
git commit -m "feat(lsp): implement go-to-definition for wikilinks"
```

---

### Task 13: Hover

**Files:**
- Modify: `src/lsp/mod.rs`

**Step 1: Implement `hover`**

Add to the `LanguageServer` impl:

```rust
async fn hover(&self, params: HoverParams) -> Result<Option<Hover>> {
    let uri = params.text_document_position_params.text_document.uri;
    let pos = params.text_document_position_params.position;

    let (link, range) = {
        let docs = self.documents.lock().await;
        let doc = match docs.get(&uri) {
            Some(d) => d,
            None => return Ok(None),
        };
        match doc.link_at_position(pos) {
            Some(link) => (link.clone(), doc.link_to_range(link)),
            None => return Ok(None),
        }
    };

    // Resolve target path via index
    let canonical = CanonicalName::from_title(&link.target_raw);
    let target_info: Option<(String, Option<String>)> = self
        .state
        .index
        .with_index({
            let cn = canonical.as_str().to_string();
            move |index, _| {
                index
                    .connection()
                    .query_row(
                        "SELECT p.path, p.title FROM canonical_names cn
                         JOIN pages p ON p.id = cn.page_id
                         WHERE cn.canonical_name = ?1
                         LIMIT 1",
                        rusqlite::params![cn],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                    )
                    .ok()
            }
        })
        .await
        .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;

    let content = match target_info {
        Some((path, title)) => {
            // Read first 10 lines of target body
            let vault_path = crate::vault::path::VaultPath::new(&path)
                .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;
            let abs_path = self.state.vault.resolve(&vault_path);
            let preview = match tokio::fs::read_to_string(&abs_path).await {
                Ok(content) => {
                    let body = match crate::vault::page::parse_frontmatter(&content) {
                        Ok((_, body)) => body,
                        Err(_) => content,
                    };
                    body.lines().take(10).collect::<Vec<_>>().join("\n")
                }
                Err(_) => String::new(),
            };

            let display_title = title.as_deref().unwrap_or(&path);
            format!("**{display_title}**\n`{path}`\n\n---\n\n{preview}")
        }
        None => {
            format!("*Unresolved link:* `{}`", link.target_raw)
        }
    };

    Ok(Some(Hover {
        contents: HoverContents::Markup(MarkupContent {
            kind: MarkupKind::Markdown,
            value: content,
        }),
        range: Some(range),
    }))
}
```

**Step 2: Verify compilation**

Run: `cargo check`

**Step 3: Commit**

```bash
git add src/lsp/mod.rs
git commit -m "feat(lsp): implement hover preview for wikilinks"
```

---

### Task 14: Completions (wikilinks and tags)

**Files:**
- Create: `src/lsp/completion.rs`
- Modify: `src/lsp/mod.rs` (add `pub mod completion;`, wire into handler)

**Step 1: Create `src/lsp/completion.rs`**

```rust
use tower_lsp::lsp_types::*;

/// Detect if the cursor is in a wikilink context.
///
/// Scans backward from cursor for `[[` not closed by `]]`.
/// Returns the filter prefix (text between `[[` and cursor) if found.
pub fn wikilink_prefix(line_text: &str, character: usize) -> Option<String> {
    let before = &line_text[..character.min(line_text.len())];
    // Find last `[[` that isn't closed
    let mut i = before.len();
    while i >= 2 {
        i -= 1;
        if i > 0 && &before[i - 1..=i] == "[[" {
            // Check there's no `]]` between here and cursor
            let between = &before[i + 1..];
            if !between.contains("]]") {
                return Some(between.to_string());
            }
        }
    }
    None
}

/// Detect if the cursor is in a tag context.
///
/// Looks for `#` at word boundary before cursor, not inside code.
/// Returns the prefix after `#` if found.
pub fn tag_prefix(line_text: &str, character: usize) -> Option<String> {
    let before = &line_text[..character.min(line_text.len())];
    // Find last `#` at word boundary
    if let Some(hash_pos) = before.rfind('#') {
        // Check it's at word boundary (start of line or preceded by whitespace)
        if hash_pos == 0 || before.as_bytes()[hash_pos - 1].is_ascii_whitespace() {
            let prefix = &before[hash_pos + 1..];
            // Must not contain spaces (tags are single words)
            if !prefix.contains(' ') {
                return Some(prefix.to_string());
            }
        }
    }
    None
}
```

**Step 2: Write tests for prefix detection**

Add to `src/lsp/completion.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wikilink_prefix_basic() {
        assert_eq!(wikilink_prefix("text [[des", 10), Some("des".into()));
    }

    #[test]
    fn wikilink_prefix_empty() {
        assert_eq!(wikilink_prefix("text [[", 7), Some("".into()));
    }

    #[test]
    fn wikilink_prefix_closed() {
        assert_eq!(wikilink_prefix("text [[done]] more", 18), None);
    }

    #[test]
    fn wikilink_prefix_single_bracket() {
        assert_eq!(wikilink_prefix("text [link", 10), None);
    }

    #[test]
    fn tag_prefix_basic() {
        assert_eq!(tag_prefix("text #tag", 9), Some("tag".into()));
    }

    #[test]
    fn tag_prefix_empty() {
        assert_eq!(tag_prefix("text #", 6), Some("".into()));
    }

    #[test]
    fn tag_prefix_mid_word() {
        // # not at word boundary
        assert_eq!(tag_prefix("text foo#bar", 12), None);
    }
}
```

Run: `cargo test lsp::completion`
Expected: all pass

**Step 3: Implement completion handler**

In `src/lsp/mod.rs`, add to the `LanguageServer` impl:

```rust
async fn completion(
    &self,
    params: CompletionParams,
) -> Result<Option<CompletionResponse>> {
    let uri = params.text_document_position.text_document.uri;
    let pos = params.text_document_position.position;

    let line_text = {
        let docs = self.documents.lock().await;
        let doc = match docs.get(&uri) {
            Some(d) => d,
            None => return Ok(None),
        };
        let line_idx = pos.line as usize;
        if line_idx >= doc.rope.len_lines() {
            return Ok(None);
        }
        doc.rope.line(line_idx).to_string()
    };

    let character = pos.character as usize;

    // Check wikilink context first
    if let Some(prefix) = completion::wikilink_prefix(&line_text, character) {
        let items = self.complete_wikilinks(&prefix).await?;
        return Ok(Some(CompletionResponse::Array(items)));
    }

    // Check tag context
    if let Some(prefix) = completion::tag_prefix(&line_text, character) {
        let items = self.complete_tags(&prefix).await?;
        return Ok(Some(CompletionResponse::Array(items)));
    }

    Ok(None)
}
```

Add helper methods to `impl LspBackend`:

```rust
async fn complete_wikilinks(&self, prefix: &str) -> Result<Vec<CompletionItem>> {
    let prefix = prefix.to_string();
    let results: Vec<(String, String, Option<String>)> = self
        .state
        .index
        .with_index({
            let prefix = prefix.clone();
            move |index, _| {
                let like_pattern = format!("{}%", prefix.to_lowercase());
                let mut stmt = index
                    .connection()
                    .prepare(
                        "SELECT DISTINCT cn.canonical_name, p.path, p.title
                         FROM canonical_names cn
                         JOIN pages p ON p.id = cn.page_id
                         WHERE cn.canonical_name LIKE ?1
                         ORDER BY cn.canonical_name
                         LIMIT 50",
                    )
                    .unwrap();
                stmt.query_map(rusqlite::params![like_pattern], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })
                .unwrap()
                .filter_map(|r| r.ok())
                .collect()
            }
        })
        .await
        .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;

    Ok(results
        .into_iter()
        .map(|(canonical, path, title)| {
            let label = title.unwrap_or_else(|| {
                path.rsplit('/').next().unwrap_or(&path)
                    .trim_end_matches(".md")
                    .to_string()
            });
            CompletionItem {
                label: label.clone(),
                kind: Some(CompletionItemKind::REFERENCE),
                detail: Some(path),
                filter_text: Some(canonical.clone()),
                insert_text: Some(format!("[[{label}]]")),
                ..Default::default()
            }
        })
        .collect())
}

async fn complete_tags(&self, prefix: &str) -> Result<Vec<CompletionItem>> {
    let prefix = prefix.to_string();
    let tags: Vec<String> = self
        .state
        .index
        .with_index({
            let prefix = prefix.clone();
            move |index, _| {
                let like_pattern = format!("{prefix}%");
                let mut stmt = index
                    .connection()
                    .prepare(
                        "SELECT DISTINCT tag FROM tags
                         WHERE tag LIKE ?1
                         ORDER BY tag
                         LIMIT 50",
                    )
                    .unwrap();
                stmt.query_map(rusqlite::params![like_pattern], |row| row.get(0))
                    .unwrap()
                    .filter_map(|r| r.ok())
                    .collect()
            }
        })
        .await
        .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;

    Ok(tags
        .into_iter()
        .map(|tag| CompletionItem {
            label: tag.clone(),
            kind: Some(CompletionItemKind::KEYWORD),
            insert_text: Some(tag),
            ..Default::default()
        })
        .collect())
}
```

**Step 4: Verify compilation**

Run: `cargo check`

**Step 5: Commit**

```bash
git add src/lsp/completion.rs src/lsp/mod.rs
git commit -m "feat(lsp): implement wikilink and tag completions"
```

---

### Task 15: Debounce flush task + canonical name snapshot

**Files:**
- Modify: `src/lsp/mod.rs`

This task wires up the debounced index write and the canonical name snapshot
for in-memory diagnostics.

**Step 1: Add canonical name snapshot to LspBackend**

Add field to `LspBackend`:

```rust
use std::sync::Arc;
use tokio::sync::RwLock;
use std::collections::HashSet;
use crate::vault::canonical::CanonicalName;

pub struct LspBackend {
    client: Client,
    state: Arc<AppState>,
    documents: Mutex<HashMap<Url, document::Document>>,
    /// Snapshot of all canonical names, for instant diagnostic checks.
    canonical_names: Arc<RwLock<HashSet<String>>>,
}
```

**Step 2: Load snapshot on initialization**

In `initialized()`:

```rust
async fn initialized(&self, _params: InitializedParams) {
    // Load canonical name snapshot
    let names = self
        .state
        .index
        .with_index(|index, _| {
            let mut stmt = index
                .connection()
                .prepare("SELECT canonical_name FROM canonical_names")
                .unwrap();
            stmt.query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect::<HashSet<String>>()
        })
        .await
        .unwrap_or_default();

    *self.canonical_names.write().await = names;

    self.client
        .log_message(MessageType::INFO, "clepsydra LSP initialized")
        .await;
}
```

**Step 3: Implement diagnostics using the snapshot**

Update `publish_diagnostics_for`:

```rust
async fn publish_diagnostics_for(&self, uri: &Url, doc: &document::Document) {
    let mut diagnostics = Vec::new();
    let names = self.canonical_names.read().await;

    for link in &doc.links {
        // Skip property ref links (synthetic, no real span)
        if link.span.start == 0 && link.span.end == 0 {
            continue;
        }

        let canonical = CanonicalName::from_title(&link.target_raw);
        let cn_str = canonical.as_str();

        // Count matches
        let match_count = names.iter().filter(|n| *n == cn_str).count();

        if match_count == 0 {
            diagnostics.push(Diagnostic {
                range: doc.link_to_range(link),
                severity: Some(DiagnosticSeverity::WARNING),
                code: Some(NumberOrString::String("unresolved-link".into())),
                source: Some("clepsydra".into()),
                message: format!("Unresolved link: \"{}\"", link.target_raw),
                ..Default::default()
            });
        }
        // Note: ambiguous detection needs count of distinct page_ids per
        // canonical name, which a flat HashSet can't provide. For Phase 1,
        // skip ambiguous detection. Upgrade to HashMap<String, usize> in
        // Phase 2 if needed.
    }

    self.client
        .publish_diagnostics(uri.clone(), diagnostics, Some(doc.version))
        .await;
}
```

**Step 4: Add debounce flush**

The debounce task refreshes the canonical name snapshot after flushing.
Full debounce implementation (dedicated task + timer) is complex. For Phase 1,
use a simpler approach: flush on `did_save` and refresh the snapshot.

Add to the `LanguageServer` impl:

```rust
async fn did_save(&self, params: DidSaveTextDocumentParams) {
    let uri = params.text_document.uri;

    // Flush index update for this file
    let vault_path = match self.uri_to_vault_path(&uri) {
        Some(vp) => vp,
        None => return,
    };

    if let Err(e) = self.state.index.index_page(vault_path.clone()).await {
        tracing::error!("index flush on save failed: {e}");
        return;
    }
    if let Err(e) = self.state.index.resolve_links_for_page(vault_path).await {
        tracing::error!("link resolution on save failed: {e}");
    }

    // Refresh canonical name snapshot
    let names = self
        .state
        .index
        .with_index(|index, _| {
            let mut stmt = index
                .connection()
                .prepare("SELECT canonical_name FROM canonical_names")
                .unwrap();
            stmt.query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect::<HashSet<String>>()
        })
        .await
        .unwrap_or_default();

    *self.canonical_names.write().await = names;

    // Mark document as clean
    {
        let mut docs = self.documents.lock().await;
        if let Some(doc) = docs.get_mut(&uri) {
            doc.dirty = false;
        }
    }

    // Re-publish diagnostics for all open documents (snapshot changed)
    let doc_uris: Vec<Url> = {
        let docs = self.documents.lock().await;
        docs.keys().cloned().collect()
    };
    for doc_uri in doc_uris {
        let docs = self.documents.lock().await;
        if let Some(doc) = docs.get(&doc_uri) {
            self.publish_diagnostics_for(&doc_uri, doc).await;
        }
    }
}
```

Add the `uri_to_vault_path` helper:

```rust
impl LspBackend {
    fn uri_to_vault_path(&self, uri: &Url) -> Option<crate::vault::path::VaultPath> {
        let file_path = uri.to_file_path().ok()?;
        let rel = file_path.strip_prefix(self.state.vault.root()).ok()?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        crate::vault::path::VaultPath::new(&rel_str).ok()
    }
}
```

**Step 5: Verify compilation**

Run: `cargo check`

**Step 6: Commit**

```bash
git add src/lsp/mod.rs
git commit -m "feat(lsp): add diagnostic publishing with canonical name snapshot

Diagnostics computed in-memory on every keystroke using a cached
canonical name set. Index flushed on save, snapshot refreshed after
flush, all open documents re-diagnosed."
```

---

## Phase 2-3: Future Work

Phase 2 (references, symbols, code lens) and Phase 3 (rename, code actions,
formatting) are deferred to a separate plan after Phase 0-1 lands. The design
is fully specified in `docs/plans/2026-02-15-lsp-design.md`.

Key dependencies from Phase 0-1 that Phase 2-3 build on:
- `IndexHandle.backlinks()` — already implemented in Task 2
- `IndexHandle.search()` — already implemented in Task 2
- `Document.link_at_position()` — already implemented in Task 9
- `LspBackend.uri_to_vault_path()` — already implemented in Task 15
- `LspBackend.canonical_names` snapshot — already implemented in Task 15

---

## Summary

| Task | Description | Est. complexity |
|------|-------------|-----------------|
| 1 | Add dependencies | Trivial |
| 2 | IndexHandle module + tests | Medium |
| 3 | Migrate AppState | Small |
| 4 | Migrate sync loop | Small |
| 5 | Migrate API handlers (40 sites, 5 files) | Large (mechanical) |
| 6 | Migrate test setup | Small |
| 7 | Add --lsp CLI flag | Trivial |
| 8 | tower-lsp scaffold | Medium |
| 9 | Document struct + offset mapping + tests | Medium |
| 10 | Document lifecycle | Small |
| 11 | Diagnostics | Medium |
| 12 | Go to definition | Medium |
| 13 | Hover | Medium |
| 14 | Completions | Medium |
| 15 | Debounce + canonical name snapshot | Medium |
