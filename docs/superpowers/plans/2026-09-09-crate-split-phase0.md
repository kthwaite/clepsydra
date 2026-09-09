# Crate Split — Phase 0 (seam fixes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every upward dependency and hard-wired feature coupling inside the single `clepsydra` crate so the later workspace split is a mechanical file move.

**Architecture:** Six independent seam changes, each its own commit, each verified by the existing suite. Two introduce trait seams with two adapters (linkable properties, rubbish purge), one inverts a subsystem's dependency on `AppState` (feeds scheduler), and three relocate code or test plumbing. No behaviour changes.

**Tech Stack:** Rust 2024, cargo features, thiserror trait objects. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-09-crate-split-design.md` (§3 lists the seams; this plan implements §3.1–§3.6).

## Global Constraints

- No behaviour change observable through the HTTP API, CLI output, or OpenAPI document. `ui/src/api/schema.d.ts` must not change.
- No new external dependencies.
- Gates after every task, run from the repo root:
  `cargo fmt --all -- --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked --no-fail-fast -- --test-threads=4`.
- Never run `clep` or `cargo run` without `CLEPSYDRA__VAULT__ROOT` set to a scratch dir (ambient config points at the live vault).
- Work in the worktree `.worktrees/crate-split` on branch `feature/crate-split-phase0`, off `develop`. `ui/dist` must exist in the worktree for `cargo test` to compile (`cp -R ../../ui/dist ui/dist` or `cd ui && bun run build`).
- Stage explicit paths (`git add <files>`); `git add .` is intercepted by the user's shell.
- Commit messages: conventional prefix, no attribution trailers.

---

### Task 1: `LinkablePropertiesProvider` seam

The index computes the set of frontmatter properties whose wikilink values become `links` rows. Today it calls up into `base::BaseRegistry` (index.rs:678-683 and :854-858). After this task the index owns a trait object; two adapters exist (config-only, bases-aware); the composition roots inject the bases adapter.

**Files:**
- Modify: `src/vault/index.rs` (struct at :421-433, `from_connection` :459-478, `open_bare` :499-511, `build` :674-683, `index_page` :850-858, tests :3674-3830)
- Modify: `src/vault/base.rs` (`BUILTIN_RELATION_PROPERTIES` :1191, `effective_linkable_properties` :1201-1217, `linkable_epoch` :1222-1229)
- Modify: `src/lib.rs` (`VaultIndex::open` at ~:681 in `build_app_state_with_settings`, and in `open_vault_and_index` ~:935)
- Modify: `src/lsp/state.rs:25`
- Modify: `src/doctor/mod.rs:1070`
- Modify: `tests/support/mod.rs:124`

**Interfaces:**
- Produces (in `crate::vault::index`):
  ```rust
  pub trait LinkablePropertiesProvider: Send {
      fn linkable_properties(&self, vault: &Vault) -> Vec<String>;
  }
  pub const BUILTIN_RELATION_PROPERTIES: &[&str];
  pub struct ConfigLinkableProperties;            // impl LinkablePropertiesProvider
  pub fn merge_linkable_properties(config_linkable: &[String], extra: &[String]) -> Vec<String>;
  pub fn linkable_epoch(effective: &[String]) -> String;
  impl VaultIndex {
      pub fn with_linkable_properties(self, provider: Box<dyn LinkablePropertiesProvider>) -> Self;
  }
  ```
- Produces (in `crate::vault::base`): `pub struct BaseLinkableProperties;` implementing the trait; `effective_linkable_properties(config, registry)` stays as a thin wrapper over `merge_linkable_properties`.

- [ ] **Step 1: Write the failing seam test**

Append to `mod linkable_epoch_tests` in `src/vault/index.rs` (reuse its `SERIES_PAGE`, `SERIES_BASE`, `series_link_count`):

```rust
    /// The seam: the same vault indexes with or without base relations
    /// depending only on the injected provider. Neither adapter is special
    /// to the index.
    #[test]
    fn provider_decides_whether_base_relations_are_linkable() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("book.md"), SERIES_PAGE).unwrap();
        fs::create_dir_all(tmp.path().join("bases")).unwrap();
        fs::write(tmp.path().join("bases/reading.base.toml"), SERIES_BASE).unwrap();
        let vault = Vault::open(tmp.path()).unwrap();

        let mut config_only = VaultIndex::open_in_memory()
            .unwrap()
            .with_linkable_properties(Box::new(ConfigLinkableProperties));
        config_only.build(&vault).unwrap();
        assert_eq!(series_link_count(&config_only), 0, "config-only ignores the base");

        let mut base_aware = VaultIndex::open_in_memory()
            .unwrap()
            .with_linkable_properties(Box::new(crate::vault::base::BaseLinkableProperties));
        base_aware.build(&vault).unwrap();
        assert_eq!(series_link_count(&base_aware), 1, "bases adapter links `series`");
    }
```

Also change the existing `setup` helper in that module so `VaultIndex::open(...)` becomes `VaultIndex::open(...).unwrap().with_linkable_properties(Box::new(crate::vault::base::BaseLinkableProperties))` (drop the trailing `.unwrap()` accordingly), and change the module's `use` line to `use crate::vault::base::{BaseRegistry, effective_linkable_properties};` plus `use super::linkable_epoch;`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --lib linkable_epoch_tests -- --nocapture`
Expected: compile error, `ConfigLinkableProperties` / `with_linkable_properties` not found.

- [ ] **Step 3: Add the trait, adapters and helpers to `index.rs`**

Directly above `pub struct VaultIndex` (index.rs:421):

```rust
/// The frontmatter properties whose wikilink values derive `links` rows.
///
/// The index asks its provider on every build and single-page index. The
/// config-only adapter is the default; the server injects the Bases adapter
/// so `type = "relation"` properties declared in `bases/*.base.toml` join
/// the set without the index depending on Bases.
pub trait LinkablePropertiesProvider: Send {
    fn linkable_properties(&self, vault: &Vault) -> Vec<String>;
}

/// Property keys that are relations by construction, whatever the config
/// says. `attendees` is one: the server already refuses any value that is
/// not a wikilink list (`vault::attendance`), so a config written before the
/// key existed must not silently drop every attendee backlink.
pub const BUILTIN_RELATION_PROPERTIES: &[&str] = &[crate::vault::attendance::ATTENDEES_KEY];

/// `[vault].linkable_properties` plus the built-in relations, nothing else.
pub struct ConfigLinkableProperties;

impl LinkablePropertiesProvider for ConfigLinkableProperties {
    fn linkable_properties(&self, vault: &Vault) -> Vec<String> {
        merge_linkable_properties(&vault.config().vault.linkable_properties, &[])
    }
}

/// Union of `config_linkable`, the built-in relations and `extra`, in that
/// order, without duplicates.
pub fn merge_linkable_properties(config_linkable: &[String], extra: &[String]) -> Vec<String> {
    let mut effective = config_linkable.to_vec();
    for key in BUILTIN_RELATION_PROPERTIES {
        if !effective.iter().any(|k| k == key) {
            effective.push((*key).to_string());
        }
    }
    for key in extra {
        if !effective.contains(key) {
            effective.push(key.clone());
        }
    }
    effective
}

/// Stable fingerprint of the effective linkable set. Persisted in
/// `derivation_meta`; a mismatch disables skip-unchanged for one build so
/// existing pages get their links re-derived under the new set.
pub fn linkable_epoch(effective: &[String]) -> String {
    let mut sorted = effective.to_vec();
    sorted.sort();
    sorted.dedup();
    blake3::hash(sorted.join("\n").as_bytes())
        .to_hex()
        .to_string()
}
```

Add the field and builder:

```rust
pub struct VaultIndex {
    conn: Connection,
    derivers: Vec<Box<dyn Deriver>>,
    repair_frontmatter: bool,   // keep the existing doc comment
    /// Who decides which frontmatter properties derive links.
    linkable: Box<dyn LinkablePropertiesProvider>,
}

impl VaultIndex {
    /// Replace the linkable-properties provider (default: config only).
    pub fn with_linkable_properties(
        mut self,
        provider: Box<dyn LinkablePropertiesProvider>,
    ) -> Self {
        self.linkable = provider;
        self
    }
}
```

In `from_connection` and `open_bare`, initialise `linkable: Box::new(ConfigLinkableProperties)`.

In `build`, replace the three `crate::vault::base::…` lines (index.rs:678-683) with:

```rust
        let linkable_properties = self.linkable.linkable_properties(vault);
        let epoch = linkable_epoch(&linkable_properties);
```

In `index_page`, replace index.rs:854-858 with:

```rust
        let linkable_properties = &self.linkable.linkable_properties(vault);
```

Update the comment above each to say the provider decides the set.

- [ ] **Step 4: Make `base.rs` an adapter**

Replace `BUILTIN_RELATION_PROPERTIES`, `effective_linkable_properties` and `linkable_epoch` in `src/vault/base.rs` (:1191-1229) with:

```rust
pub use crate::vault::index::BUILTIN_RELATION_PROPERTIES;
use crate::vault::index::{LinkablePropertiesProvider, merge_linkable_properties};

/// Config, built-ins and every `type = "relation"` property declared in
/// `bases/*.base.toml`. The server, LSP and doctor inject this into the index.
pub struct BaseLinkableProperties;

impl LinkablePropertiesProvider for BaseLinkableProperties {
    fn linkable_properties(&self, vault: &Vault) -> Vec<String> {
        let registry = BaseRegistry::load(vault.root());
        effective_linkable_properties(&vault.config().vault.linkable_properties, &registry)
    }
}

/// The effective linkable set given an already-loaded registry.
pub fn effective_linkable_properties(
    config_linkable: &[String],
    registry: &BaseRegistry,
) -> Vec<String> {
    merge_linkable_properties(config_linkable, &registry.relation_property_keys())
}
```

Keep the existing doc comment about `attendees` on `BUILTIN_RELATION_PROPERTIES` in index.rs (moved there). Fix any `base::linkable_epoch` imports elsewhere (`grep -rn linkable_epoch src tests`) to `index::linkable_epoch`.

- [ ] **Step 5: Inject the bases adapter at every composition root**

Each of these currently reads `VaultIndex::open(...)` or `VaultIndex::open_in_memory()`; chain `.with_linkable_properties(Box::new(<path>::BaseLinkableProperties))` after the `?`/`.unwrap()`:

| Site | Path to use |
|---|---|
| `src/lib.rs` `build_app_state_with_settings` (`let mut index = VaultIndex::open(&db_path)…`) | `vault::base::BaseLinkableProperties` |
| `src/lib.rs` `open_vault_and_index` | same |
| `src/lsp/state.rs:25` (`VaultIndex::open_in_memory()?`) | `crate::vault::base::BaseLinkableProperties` |
| `src/doctor/mod.rs:1070` (dry build) | `crate::vault::base::BaseLinkableProperties` |
| `tests/support/mod.rs:124` | `clepsydra::vault::base::BaseLinkableProperties` |

Example for lib.rs:

```rust
    let mut index = VaultIndex::open(&db_path)
        .map_err(|source| startup_index_error("open", source, &recovered_batches))?
        .with_linkable_properties(Box::new(vault::base::BaseLinkableProperties));
```

- [ ] **Step 6: Run the gates**

Run: `cargo test --lib linkable_epoch_tests` then the full gates from Global Constraints.
Expected: all pass. If `tests/bases_api.rs`, `tests/property_patch.rs` or the `src/api/base_members.rs` unit test fail on missing relation links, they build their own index: inject the adapter there the same way.

- [ ] **Step 7: Commit**

```bash
git add src/vault/index.rs src/vault/base.rs src/lib.rs src/lsp/state.rs src/doctor/mod.rs tests/support/mod.rs
git commit -m "refactor(index): linkable properties come from an injected provider"
```

---

### Task 2: `RubbishPurgeHook` seam

The coordinator names the archive feature directly (`archive_hook::release_rubbish_archive_refs_for_purge` at mutation_coordinator.rs:14/:943) and takes `Arc<Mutex<ContentStore>>` on `purge_rubbish` (:907), `purge_rubbish_item` (:921), `empty_rubbish` (:1026) and `restore_rubbish` (:1134). After this task the coordinator only knows a trait; `ArchiveDeleteHook` implements it.

**Files:**
- Modify: `src/vault/hooks.rs`
- Modify: `src/vault/mutation_coordinator.rs` (imports :14/:20, `MutationError::RubbishCleanup` :232-236, the four methods, restore check :1157-1169)
- Modify: `src/vault/archive_hook.rs` (impl block after :115)
- Modify: `src/api/mod.rs` (`AppState` fields :83-85), `src/api/rubbish.rs:280,312,338`, `src/lib.rs:746-749`
- Modify: `tests/support/mod.rs` (AppState construction :107-186), and the seven tests that build `AppState` by hand: `tests/academic_dedup_test.rs`, `tests/api_agenda_test.rs`, `tests/api_tasks_test.rs`, `tests/block_ref_resolution_test.rs`, `tests/e2e_block_refs_test.rs`, `tests/e2e_tasks_journal_test.rs`, `tests/e2e_test.rs`
- Modify: `tests/mutation_test.rs` (purge/empty calls at :986-1417), `tests/archive_test.rs:231`

**Interfaces:**
- Produces (in `crate::vault::hooks`):
  ```rust
  pub trait RubbishPurgeHook: Send + Sync {
      fn on_rubbish_purge(
          &self,
          item_id: Uuid,
          original_path: &VaultPath,
          page_id: &Uuid,
          meta: &PageMeta,
      ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
      fn purge_committed(&self, item_id: Uuid) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
  }
  ```
- Coordinator signatures change: every `cas: Arc<parking_lot::Mutex<ContentStore>>` parameter on the four methods becomes `purge_hooks: Arc<Vec<Box<dyn RubbishPurgeHook>>>`.
- `MutationError::RubbishCleanup { item_id, source: Box<dyn std::error::Error + Send + Sync> }`.
- `AppState.purge_hooks: Arc<Vec<Box<dyn RubbishPurgeHook>>>`.

- [ ] **Step 1: Write the failing test**

In `tests/mutation_test.rs`, next to the purge tests (read the fixture at :986 for how a vault, index, coordinator and a rubbished item are set up; copy that setup), add:

```rust
/// A purge hook that records what the coordinator told it and can be
/// switched into the "already committed" state.
#[derive(Default)]
struct RecordingPurgeHook {
    purged: parking_lot::Mutex<Vec<(uuid::Uuid, String, uuid::Uuid)>>,
    committed: std::sync::atomic::AtomicBool,
}

impl clepsydra::vault::hooks::RubbishPurgeHook for RecordingPurgeHook {
    fn on_rubbish_purge(
        &self,
        item_id: uuid::Uuid,
        original_path: &clepsydra::vault::path::VaultPath,
        page_id: &uuid::Uuid,
        _meta: &clepsydra::vault::page::PageMeta,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.purged
            .lock()
            .push((item_id, original_path.as_str().to_string(), *page_id));
        Ok(())
    }

    fn purge_committed(
        &self,
        _item_id: uuid::Uuid,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self.committed.load(std::sync::atomic::Ordering::SeqCst))
    }
}

#[tokio::test]
async fn purge_invokes_registered_hook_with_item_identity() {
    // <same setup as the existing purge test: vault, index, coordinator,
    //  one page moved to rubbish; bind its manifest as `manifest`>
    let hook = Arc::new(RecordingPurgeHook::default());
    let hooks: Arc<Vec<Box<dyn clepsydra::vault::hooks::RubbishPurgeHook>>> =
        Arc::new(vec![Box::new(SharedHook(Arc::clone(&hook)))]);
    coordinator
        .purge_rubbish(&vault, &index, hooks, &manifest.item_id.to_string())
        .await
        .unwrap();
    let purged = hook.purged.lock();
    assert_eq!(purged.len(), 1);
    assert_eq!(purged[0].0, manifest.item_id);
    assert_eq!(purged[0].1, manifest.original_path.as_str());
    assert_eq!(purged[0].2, manifest.page_id);
}

#[tokio::test]
async fn restore_refuses_when_a_hook_reports_purge_committed() {
    // <same setup, plus the BatchMutationCommand the existing restore test builds>
    let hook = Arc::new(RecordingPurgeHook::default());
    hook.committed.store(true, std::sync::atomic::Ordering::SeqCst);
    let hooks: Arc<Vec<Box<dyn clepsydra::vault::hooks::RubbishPurgeHook>>> =
        Arc::new(vec![Box::new(SharedHook(hook))]);
    let err = coordinator
        .restore_rubbish(&vault, &index, hooks, move_hooks, command, notify)
        .await
        .unwrap_err();
    assert!(matches!(err, clepsydra::vault::mutation_coordinator::MutationError::Conflict(_)));
}

/// `Box<dyn RubbishPurgeHook>` needs an owned value; share the recorder by Arc.
struct SharedHook(Arc<RecordingPurgeHook>);
impl clepsydra::vault::hooks::RubbishPurgeHook for SharedHook {
    fn on_rubbish_purge(&self, i: uuid::Uuid, p: &clepsydra::vault::path::VaultPath, g: &uuid::Uuid, m: &clepsydra::vault::page::PageMeta) -> Result<(), Box<dyn std::error::Error + Send + Sync>> { self.0.on_rubbish_purge(i, p, g, m) }
    fn purge_committed(&self, i: uuid::Uuid) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> { self.0.purge_committed(i) }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --test mutation_test purge_invokes_registered_hook`
Expected: compile error, `RubbishPurgeHook` not found.

- [ ] **Step 3: Add the trait to `hooks.rs`**

```rust
/// Hook invoked while a rubbish item is being purged, before its files are
/// removed. The item ID supplies idempotency; the page identity is carried
/// for truthful diagnostics.
pub trait RubbishPurgeHook: Send + Sync {
    /// Release whatever this hook holds on behalf of the item (captured
    /// archive references, for instance). Must be idempotent per `item_id`.
    fn on_rubbish_purge(
        &self,
        item_id: Uuid,
        original_path: &VaultPath,
        page_id: &Uuid,
        meta: &crate::vault::page::PageMeta,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;

    /// Whether an earlier purge of `item_id` already released this hook's
    /// resources, in which case the item can no longer be restored.
    fn purge_committed(
        &self,
        item_id: Uuid,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
}
```

- [ ] **Step 4: Rewire the coordinator**

In `src/vault/mutation_coordinator.rs`:
- Delete `use super::archive_hook::release_rubbish_archive_refs_for_purge;` and `use super::cas::{CasError, ContentStore};`. Add `use super::hooks::{PostMoveHook, RubbishPurgeHook};` (replacing the existing `PostMoveHook` import).
- `MutationError::RubbishCleanup`: change `source: CasError` to `source: Box<dyn std::error::Error + Send + Sync>` (keep `#[source]`).
- Replace the `cas` parameter on `purge_rubbish`, `purge_rubbish_item`, `empty_rubbish`, `restore_rubbish` with `purge_hooks: Arc<Vec<Box<dyn RubbishPurgeHook>>>`; `empty_rubbish` passes `Arc::clone(&purge_hooks)` into `purge_rubbish_item`.
- In `purge_rubbish_item` (:941-953) replace the `release_rubbish_archive_refs_for_purge` closure body with:

```rust
        let hooks = Arc::clone(&purge_hooks);
        let (guard, context) = run_blocking_fs(root.clone(), guard, move || {
            for hook in hooks.iter() {
                hook.on_rubbish_purge(
                    item_id,
                    &context.original_path,
                    &context.item.manifest.page_id,
                    &context.meta,
                )
                .map_err(|source| MutationError::RubbishCleanup { item_id, source })?;
            }
            Ok(context)
        })
        .await?;
```

- In `restore_rubbish` (:1157-1169) replace the `cas.lock().rubbish_archive_refs_released(item_id)` check with:

```rust
        let hooks = Arc::clone(&purge_hooks);
        let (guard, ()) = run_blocking_fs(root, guard, move || {
            for hook in hooks.iter() {
                if hook
                    .purge_committed(item_id)
                    .map_err(|source| MutationError::RubbishCleanup { item_id, source })?
                {
                    return Err(MutationError::Conflict(format!(
                        "permanent deletion is already in progress for rubbish item {item_id}; \
                         its captured-archive references have been released, so it cannot be \
                         restored; retry permanent deletion"
                    )));
                }
            }
            Ok(())
        })
```

- [ ] **Step 5: Implement the trait on `ArchiveDeleteHook`**

Append to `src/vault/archive_hook.rs`:

```rust
impl RubbishPurgeHook for ArchiveDeleteHook {
    fn on_rubbish_purge(
        &self,
        item_id: Uuid,
        original_path: &VaultPath,
        page_id: &Uuid,
        meta: &PageMeta,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        release_rubbish_archive_refs_for_purge(&self.cas, item_id, original_path, page_id, meta)
            .map(|_| ())
            .map_err(Into::into)
    }

    fn purge_committed(
        &self,
        item_id: Uuid,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        self.cas
            .lock()
            .rubbish_archive_refs_released(item_id)
            .map_err(Into::into)
    }
}
```

Import `RubbishPurgeHook` from `super::hooks`. `release_rubbish_archive_refs_for_purge` can become a private `fn`.

- [ ] **Step 6: Register and thread the hook**

- `src/api/mod.rs`: add `pub purge_hooks: Arc<Vec<Box<dyn vault::hooks::RubbishPurgeHook>>>,` after `delete_hooks`.
- `src/lib.rs:746-749`: after `delete_hooks`, add
  ```rust
    let purge_hooks: Arc<Vec<Box<dyn vault::hooks::RubbishPurgeHook>>> =
        Arc::new(vec![Box::new(vault::archive_hook::ArchiveDeleteHook {
            cas: Arc::clone(&cas_arc),
        })]);
  ```
  and set `purge_hooks,` in the `AppState` literal.
- `src/api/rubbish.rs:280,312,338`: pass `Arc::clone(&state.purge_hooks)` where `Arc::clone(&state.cas)` was passed to the coordinator.
- `tests/support/mod.rs` and the seven hand-built `AppState` tests: add `purge_hooks` built the same way from the fixture's `cas` Arc (`grep -n 'delete_hooks' tests/*.rs tests/support/mod.rs` finds every site).
- `tests/mutation_test.rs`, `tests/archive_test.rs`: where `Arc::clone(&cas)` was passed to `purge_rubbish`/`empty_rubbish`/`restore_rubbish`, pass
  `Arc::new(vec![Box::new(clepsydra::vault::archive_hook::ArchiveDeleteHook { cas: Arc::clone(&cas) }) as Box<dyn clepsydra::vault::hooks::RubbishPurgeHook>])`
  (bind it once per test as `let purge_hooks = …`).

- [ ] **Step 7: Run the gates**

Run: `cargo test --test mutation_test` then the full gates.
Expected: all pass, including the existing `RubbishCleanup { item_id, .. }` match at mutation_test.rs:1098.

- [ ] **Step 8: Commit**

```bash
git add src/vault/hooks.rs src/vault/mutation_coordinator.rs src/vault/archive_hook.rs src/api/mod.rs src/api/rubbish.rs src/lib.rs tests/support/mod.rs tests/mutation_test.rs tests/archive_test.rs tests/academic_dedup_test.rs tests/api_agenda_test.rs tests/api_tasks_test.rs tests/block_ref_resolution_test.rs tests/e2e_block_refs_test.rs tests/e2e_tasks_journal_test.rs tests/e2e_test.rs
git commit -m "refactor(mutation): rubbish purge cleanup goes through RubbishPurgeHook"
```

---

### Task 3: Feeds scheduler takes a `FeedHost`, not `AppState`

`src/feeds/scheduler.rs:10-11` imports `crate::api::AppState` and `SyncNotification`. It uses three things from the state: the feed runtime, the vault root, and the change broadcaster. After this task feeds has no production dependency on `api`.

**Files:**
- Modify: `src/feeds/scheduler.rs` (imports :10-11; fns at :40, :62, :77, :85, :93, :160-166, :204; tests from :215)
- Modify: `src/api/mod.rs` (`feed_runtime: Option<FeedRuntime>` :110 → `Option<Arc<FeedRuntime>>`; add `feed_host()`)
- Modify: `src/lib.rs:730-736` (wrap in `Arc::new`), `:1200-1201`
- Modify: `src/api/feeds.rs:19` (imports), every call that passes `state`/`&state` to a scheduler fn, `:2042`, `:2088`
- Modify: `tests/support/mod.rs:155` (wrap in `Arc::new`), `tests/api_feeds.rs:6` and its `reconcile_feed_manifest(&…)` calls

**Interfaces:**
- Produces (in `crate::feeds::scheduler`):
  ```rust
  #[derive(Clone)]
  pub struct FeedHost {
      pub runtime: Arc<FeedRuntime>,
      pub vault_root: PathBuf,
      /// Called after feed storage changed (manifest reconcile or fetch).
      pub on_change: Arc<dyn Fn() + Send + Sync>,
  }
  pub async fn reconcile_feed_manifest(host: &FeedHost) -> Result<(), SchedulerError>;
  pub(crate) async fn reconcile_feed_manifest_locked(host: &FeedHost) -> Result<(Vec<u8>, bool), SchedulerError>;
  pub(crate) async fn reconcile_feed_manifest_bytes_locked(host: &FeedHost, bytes: &[u8]) -> Result<bool, SchedulerError>;
  pub fn spawn_scheduler(host: FeedHost) -> FeedSchedulerGuard;
  #[cfg(test)] pub(crate) fn set_before_reconcile_commit_hook(runtime: &FeedRuntime, hook: Option<Arc<dyn Fn() + Send + Sync>>);
  ```
- Produces (in `crate::api`): `impl AppState { pub fn feed_host(&self) -> FeedHost }` (panics if feeds are disabled, exactly like `feed_runtime()` does today).

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `src/feeds/scheduler.rs` a test that never touches `AppState`:

```rust
    #[tokio::test]
    async fn reconcile_notifies_host_without_app_state() {
        let tmp = tempfile::tempdir().unwrap();
        crate::vault::init::init_vault(tmp.path()).unwrap();
        std::fs::write(
            tmp.path().join("feeds.md"),
            "+++\ntitle = \"Feeds\"\n+++\n\n- [Example](https://example.com/feed.xml)\n",
        )
        .unwrap();
        let runtime = Arc::new(
            crate::feeds::runtime::FeedRuntime::open(tmp.path(), &crate::FeedsSettings::default())
                .unwrap(),
        );
        let changes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&changes);
        let host = FeedHost {
            runtime,
            vault_root: tmp.path().to_path_buf(),
            on_change: Arc::new(move || {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }),
        };
        reconcile_feed_manifest(&host).await.unwrap();
        assert_eq!(host.runtime.feeds.list_feeds().await.unwrap().len(), 1);
    }
```

(Check `src/feeds/manifest.rs` for the exact manifest line syntax the parser accepts and adjust the fixture string; the existing scheduler tests at :282 write a `feeds.md` you can copy.)

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib feeds::scheduler::tests::reconcile_notifies_host_without_app_state`
Expected: compile error, `FeedHost` not found.

- [ ] **Step 3: Introduce `FeedHost` and rewrite the scheduler**

In `src/feeds/scheduler.rs`: delete the two `crate::api` imports; add `use crate::feeds::runtime::FeedRuntime;` and the `FeedHost` struct above. Then mechanically:
- `state.feed_runtime()` → `host.runtime.as_ref()` (or `&host.runtime`)
- `state.vault.root()` → `&host.vault_root`
- `let _ = state.change_tx.send(SyncNotification::FeedChanged);` → `(host.on_change)();`
- `spawn_scheduler(state: Arc<AppState>)` → `spawn_scheduler(host: FeedHost)`; `scheduler_loop(state, …)` → `scheduler_loop(host, …)` and inside it `&host`.
- `set_before_reconcile_commit_hook(state, hook)` → `(runtime: &FeedRuntime, hook)`.

In `src/api/mod.rs`: change the field to `pub feed_runtime: Option<Arc<crate::feeds::runtime::FeedRuntime>>`; keep `feed_runtime()` returning `&FeedRuntime` (`.as_deref()`); add

```rust
    /// The scheduler's view of this server: runtime, vault root and a
    /// change notifier that fans out on the SSE bus.
    pub fn feed_host(&self) -> crate::feeds::scheduler::FeedHost {
        let change_tx = self.change_tx.clone();
        crate::feeds::scheduler::FeedHost {
            runtime: Arc::clone(
                self.feed_runtime
                    .as_ref()
                    .expect("feed_host called with feeds disabled"),
            ),
            vault_root: self.vault.root().to_path_buf(),
            on_change: Arc::new(move || {
                let _ = change_tx.send(events::SyncNotification::FeedChanged);
            }),
        }
    }
```

- [ ] **Step 4: Update the callers**

- `src/lib.rs:730-736`: `Some(Arc::new(FeedRuntime::open(…)?))`. `:1200-1201`: `reconcile_feed_manifest(&state.feed_host()).await?; let scheduler = spawn_scheduler(state.feed_host());`.
- `src/api/feeds.rs`: every `reconcile_feed_manifest*(state…)` / `(&state…)` call passes `&state.feed_host()` (bind `let host = state.feed_host();` once per handler where used more than once). `:2042/:2088`: `set_before_reconcile_commit_hook(fixture.state.feed_runtime(), …)`.
- `tests/support/mod.rs:155`: wrap in `Arc::new`. `tests/api_feeds.rs`: `reconcile_feed_manifest(&fixture.state.feed_host())`.
- Scheduler in-module tests (:215+): replace `&fixture.state` with `&fixture.state.feed_host()` and `fixture.state.feed_runtime().feed_refresh.notify_one()` stays.

- [ ] **Step 5: Prove feeds no longer names api**

Run: `grep -n 'crate::api' src/feeds/*.rs`
Expected: no hits outside `#[cfg(test)]` modules (the tests may still use `AppState` fixtures).

- [ ] **Step 6: Run the gates**

Run the full gates. Expected: all pass, including `tests/api_feeds.rs`.

- [ ] **Step 7: Commit**

```bash
git add src/feeds/scheduler.rs src/api/mod.rs src/api/feeds.rs src/lib.rs tests/support/mod.rs tests/api_feeds.rs
git commit -m "refactor(feeds): scheduler runs against a FeedHost instead of AppState"
```

---

### Task 4: Move the upward references out of `src/vault/`

Four independent moves; one commit each is fine, or one commit for all four.

**Files:**
- Modify: `src/lib.rs` (`expand_tilde` :354-362 → re-export; `VESSEL_ACCENT` :45 → `pub`)
- Modify: `src/vault/config.rs` (:195), `src/vault/cas_migrate.rs` (:240)
- Modify: `src/vault/grep.rs` (:8, :41, :53, :73, tests :230, :239), `src/vault/tree.rs` (:9, :202, :206, :231, :254, tests :374, :403)
- Modify: `src/bin/cli.rs` (:10, :12, :405, :796, :808)
- Create: `src/new_note_command.rs`; Modify: `src/vault/new_note.rs`
- Move: `src/vault/backup.rs` → `src/backup.rs`; Modify: `src/vault/mod.rs`, `src/lib.rs`

**Interfaces:**
- `crate::vault::config::expand_tilde(p: &str) -> Option<PathBuf>` (re-exported as `clepsydra::expand_tilde`, unchanged signature).
- `crate::vault::grep::render_human(results: &[SearchResult], w: &mut impl Write, accent: (u8, u8, u8)) -> io::Result<()>`; same shape for `tree::render_human(root, w, accent)`.
- `pub const VESSEL_ACCENT: (u8, u8, u8)` in lib.rs.
- `crate::new_note_command::{create_new_note, CreatedNote, load_vault_root_from_config}`; `crate::vault::new_note::{NewNoteError, build_note_path, build_projected_note_path}` remain.
- `crate::backup::{create_backup, BackupError}`.

- [ ] **Step 1: `expand_tilde` down into the vault**

Cut the function from lib.rs:354-362 and paste it (with its doc comment, as `pub fn`) into `src/vault/config.rs` above `resolve_cas_path`. In lib.rs add `pub use vault::config::expand_tilde;` next to the other `pub use` lines so `clepsydra::expand_tilde`, `crate::expand_tilde` (doctor, lib tests) and cli.rs:662 keep compiling. Change config.rs:195 to `expand_tilde(raw)` and cas_migrate.rs:240 to `super::config::expand_tilde(LEGACY_DEFAULT_CAS_PATH)?`.

Run: `grep -rn 'crate::expand_tilde' src/vault` → expected no hits.

- [ ] **Step 2: Accent becomes a parameter of `render_human`**

In grep.rs and tree.rs delete `use crate::VESSEL_ACCENT as ACCENT;`, add `accent: (u8, u8, u8)` as the last parameter of `render_human`, and replace each `ACCENT.0, ACCENT.1, ACCENT.2` with `accent.0, accent.1, accent.2`. Update the four in-file test calls to pass `(0xee, 0x77, 0x33)`. In lib.rs make the constant `pub const VESSEL_ACCENT`. In cli.rs:796 and :808 pass `clepsydra::VESSEL_ACCENT` as the third argument.

Run: `grep -rn 'VESSEL_ACCENT' src/vault` → expected no hits.

- [ ] **Step 3: `create_new_note` up to the crate root**

Create `src/new_note_command.rs` containing, moved verbatim from `src/vault/new_note.rs`: `CreatedNote` (:17-21), `CliConfig`/`CliVaultSection` (:43-52), `load_vault_root_from_config` and `_with_env` (:62-105), `create_new_note` and `create_new_note_in_vault` (:115-176), and the tests `load_vault_root_*` (3), `create_new_note_*` (3), `new_note_filename_is_canonical`, `parent_creation_failure_writes_no_note`. Its imports:

```rust
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::app_config::{config_candidates_with_env, find_config_path_with_env};
use crate::vault::Vault;
use crate::vault::new_note::{NewNoteError, build_note_path};
use crate::vault::page::{PageMeta, write_page_content};
use crate::vault::path::VaultPath;
```

`NewNoteError` stays in `src/vault/new_note.rs` with all its variants (the config variants are only constructed by the moved code; leaving the enum whole avoids a second error type). `build_note_path` becomes `pub fn` (it was `pub(crate)`). Remove the now-unused imports from new_note.rs (`env`, `OsString`, `fs`, `Deserialize`, `app_config`). Add `pub mod new_note_command;` to lib.rs. cli.rs:12 becomes `use clepsydra::new_note_command::create_new_note;`.

Run: `grep -rn 'crate::app_config' src/vault` → expected no hits.

- [ ] **Step 4: `backup.rs` up to the crate root**

```bash
git mv src/vault/backup.rs src/backup.rs
```

Remove `pub mod backup;` from `src/vault/mod.rs`; add `pub mod backup;` to lib.rs. Inside `src/backup.rs` replace the two `super::` references (`grep -n 'super::' src/backup.rs`) with `crate::vault::…` paths. cli.rs:10 becomes `use clepsydra::backup::create_backup;`.

Run: `grep -rn 'crate::feeds' src/vault` → expected no hits.

- [ ] **Step 5: Run the gates**

Full gates. Expected: all pass; `tests/docs_cli_coverage_test.rs` still passes (no CLI surface changed).

- [ ] **Step 6: Commit**

```bash
git add src/lib.rs src/vault/config.rs src/vault/cas_migrate.rs src/vault/grep.rs src/vault/tree.rs src/bin/cli.rs src/new_note_command.rs src/vault/new_note.rs src/backup.rs src/vault/mod.rs
git commit -m "refactor(vault): vault modules no longer reach into the crate root or feeds"
```

---

### Task 5: `extract_journal_date` lives beside `page_filename`

`src/vault/index.rs:2128` defines a pure path function that `gitsync/journal_merge.rs:16` imports, dragging the index into gitsync.

**Files:**
- Modify: `src/vault/page_filename.rs`, `src/vault/index.rs` (:939, :2120-2140, :2409), `src/vault/gitsync/journal_merge.rs:16`

**Interfaces:**
- Produces: `pub fn extract_journal_date(path: &str) -> Option<String>` in `crate::vault::page_filename`.

- [ ] **Step 1: Write the failing tests**

Append to `src/vault/page_filename.rs`:

```rust
#[cfg(test)]
mod journal_date_tests {
    use super::extract_journal_date;

    #[test]
    fn legacy_and_canonical_journal_paths_yield_the_date() {
        assert_eq!(extract_journal_date("journals/2026-02-17.md").as_deref(), Some("2026-02-17"));
        assert_eq!(
            extract_journal_date("ai-journals/20260217.2026-02-17.abcd1234.md").as_deref(),
            Some("2026-02-17")
        );
    }

    #[test]
    fn non_journal_paths_yield_nothing() {
        assert_eq!(extract_journal_date("other/journals/2026-02-17.md"), None);
        assert_eq!(extract_journal_date("notes/2026-02-17.md"), None);
    }
}
```

(Confirm the canonical short-id length against `is_canonical_page_filename` in `src/vault/path.rs` and adjust `abcd1234` to a valid id.)

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib page_filename::journal_date_tests`
Expected: compile error, `extract_journal_date` not in `page_filename`.

- [ ] **Step 3: Move the function**

Cut `extract_journal_date` and its doc comment from index.rs (:2120-~2140) into `src/vault/page_filename.rs` as `pub fn`, changing `crate::vault::path::is_canonical_page_filename` to `super::path::is_canonical_page_filename`. In index.rs add `use super::page_filename::extract_journal_date;`. In journal_merge.rs:16 change the import to `use crate::vault::page_filename::extract_journal_date;`.

- [ ] **Step 4: Run the gates**

Run: `cargo test --lib page_filename` then the full gates. Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/vault/page_filename.rs src/vault/index.rs src/vault/gitsync/journal_merge.rs
git commit -m "refactor(vault): extract_journal_date is a page-filename helper"
```

---

### Task 6: Test plumbing that must survive crate boundaries

`cfg(test)` items are invisible to another crate's tests. The fault-injection failpoints become a cargo feature; the git-isolation helper moves into `gitsync::testing`; the three private `EnvGuard` copies collapse into the shared one.

**Files:**
- Modify: `Cargo.toml` (add `[features]`)
- Modify: `src/vault/atomic_file.rs` (:10-49, :483), `src/vault/rubbish.rs` (:835-847)
- Modify: `src/vault/gitsync/testing.rs`, `src/sync_runtime.rs` (:441-458), `src/doctor/sync.rs` (seven `isolate_git_process_wide` calls)
- Modify: `src/todo_capture.rs` (:164-200), `src/doctor/mod.rs` (:2164-2200), `src/lsp/state.rs` (:125-150)

**Interfaces:**
- Cargo feature `test-failpoints` (no deps). Under it, `crate::vault::atomic_file::{fail_next_directory_flush, TestDirectoryFlushFailureGuard}` and `crate::vault::rubbish::{fail_next_directory_sync, TestDirectorySyncFailureGuard}` are `pub`.
- `crate::vault::gitsync::testing::{GitEnv, isolate_git_process_wide}` (`pub(crate)`, `cfg(test)`).

- [ ] **Step 1: Failpoints behind a feature**

In `Cargo.toml` add:

```toml
[features]
# Enables the directory-flush/sync fault-injection hooks in
# `vault::atomic_file` and `vault::rubbish` for another crate's tests.
test-failpoints = []
```

In `src/vault/atomic_file.rs` replace every `#[cfg(test)]` at :10, :14, :19, :29, :42 and :483 with `#[cfg(any(test, feature = "test-failpoints"))]`, and make `TestDirectoryFlushFailureGuard` and `fail_next_directory_flush` `pub`. Do the same for rubbish.rs:835-847 (`TestDirectorySyncFailureGuard`, `fail_next_directory_sync`). Leave :638 (the tests module) as `#[cfg(test)]`.

`parking_lot` is already a normal dependency, so the static compiles under the feature.

Run: `cargo check --features test-failpoints` and `cargo clippy --features test-failpoints --all-targets -- -D warnings`. Expected: clean (no dead-code warnings; if clippy flags the unused `pub` items under the feature, add `#[allow(dead_code)]` on the guard struct only).

- [ ] **Step 2: Git isolation moves into `gitsync::testing`**

Cut `GitEnv` and `isolate_git_process_wide` from `src/sync_runtime.rs:444-458` into `src/vault/gitsync/testing.rs` (both `pub(crate)`), importing `crate::env_test_support::EnvGuard` there. In sync_runtime.rs add `use crate::vault::gitsync::testing::isolate_git_process_wide;` inside `mod tests`. In `src/doctor/sync.rs` replace the seven `crate::sync_runtime::tests::isolate_git_process_wide()` calls with `crate::vault::gitsync::testing::isolate_git_process_wide()`, and replace the hand-rolled pair at :750-751 with one `let _env = crate::vault::gitsync::testing::isolate_git_process_wide();` if that test sets the same two variables (read it; if it points `GIT_CONFIG_GLOBAL` at a different file, leave it).

- [ ] **Step 3: One `EnvGuard`**

Delete the private `EnvGuard` in `src/todo_capture.rs:164-200`, `src/doctor/mod.rs:2164-2200`, `src/lsp/state.rs:125-150` and replace with `use crate::env_test_support::EnvGuard;` inside each test module. The shared guard's `set` takes `impl AsRef<OsStr>` so the `&str` and `PathBuf` call sites all compile. If a deleted copy did anything the shared one does not (compare before deleting), keep that copy and say so in the commit body.

- [ ] **Step 4: Run the gates**

Full gates, plus `cargo test --features test-failpoints --lib vault::atomic_file` to prove the feature path builds. Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock src/vault/atomic_file.rs src/vault/rubbish.rs src/vault/gitsync/testing.rs src/sync_runtime.rs src/doctor/sync.rs src/todo_capture.rs src/doctor/mod.rs src/lsp/state.rs
git commit -m "test: failpoints behind a cargo feature; shared git isolation and EnvGuard"
```

---

### Task 7: Verify the seams hold and record it

- [ ] **Step 1: Prove no upward references remain**

Run:
```bash
grep -rn 'crate::' src/vault --include='*.rs' | grep -v 'crate::vault' | grep -v 'env_test_support'
grep -rn 'crate::api' src/feeds --include='*.rs' | grep -v '#\[cfg(test)\]'
grep -n 'archive_hook\|cas::' src/vault/mutation_coordinator.rs
grep -n 'vault::base' src/vault/index.rs | grep -v '^.*//\|cfg(test)\|linkable_epoch_tests'
```
Expected: the first shows nothing; the second shows only hits inside `mod tests`; the third and fourth show nothing outside tests.

- [ ] **Step 2: Full gates one last time**

`cargo fmt --all -- --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked --no-fail-fast -- --test-threads=4`

- [ ] **Step 3: Update the design doc status**

In `docs/superpowers/specs/2026-09-09-crate-split-design.md` change `**Status:**` to `Phase 0 landed on develop <commit>; Phases 1–3 pending`. Commit with `docs: crate split phase 0 landed`.
