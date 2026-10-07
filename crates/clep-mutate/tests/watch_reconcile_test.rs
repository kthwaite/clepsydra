use std::fs;
use std::sync::Arc;
use std::time::Duration;

use clep_index::hooks::PostMoveHook;
use clep_index::index::VaultIndex;
use clep_index::index_handle::IndexHandle;
use clep_index::sync::ChangeEvent;
use clep_mutate::mutation_coordinator::MutationCoordinator;
use clep_mutate::watch_reconcile::{
    BatchChanges, WatchHost, drain_change_batch, index_batch, process_batch, reconcile_upserts,
    run_watch_loop,
};
use clep_vault::Vault;
use clep_vault::init::init_vault;
use clep_vault::path::VaultPath;
use parking_lot::Mutex;
use tempfile::TempDir;

/// A watch host over a temp vault that records every callback.
struct TestHost {
    vault: Vault,
    index: IndexHandle,
    coordinator: MutationCoordinator,
    hooks: Arc<Vec<Box<dyn PostMoveHook>>>,
    received: Mutex<Vec<usize>>,
    indexed: Mutex<Vec<BatchChanges>>,
}

impl WatchHost for TestHost {
    fn vault(&self) -> &Vault {
        &self.vault
    }
    fn index(&self) -> &IndexHandle {
        &self.index
    }
    fn mutation_coordinator(&self) -> &MutationCoordinator {
        &self.coordinator
    }
    fn post_move_hooks(&self) -> Arc<Vec<Box<dyn PostMoveHook>>> {
        Arc::clone(&self.hooks)
    }
    fn batch_received(&self, batch: &[ChangeEvent]) {
        self.received.lock().push(batch.len());
    }
    fn batch_indexed(&self, changes: BatchChanges) {
        self.indexed.lock().push(changes);
    }
}

fn host_with_config(config: Option<&str>) -> (TempDir, Arc<TestHost>) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    if let Some(config) = config {
        fs::write(root.join(".clepsydra/config.toml"), config).unwrap();
    }
    let vault = Vault::open(&root).unwrap();
    let mut raw_index = VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
    raw_index.build(&vault).unwrap();
    raw_index.resolve_links().unwrap();
    let host = TestHost {
        index: IndexHandle::spawn(raw_index, vault.clone()),
        vault,
        coordinator: MutationCoordinator::new(),
        hooks: Arc::new(Vec::new()),
        received: Mutex::new(Vec::new()),
        indexed: Mutex::new(Vec::new()),
    };
    (tmp, Arc::new(host))
}

fn host() -> (TempDir, Arc<TestHost>) {
    host_with_config(None)
}

fn vp(path: &str) -> VaultPath {
    VaultPath::new(path).unwrap()
}

fn write_page(host: &TestHost, path: &str, content: &str) {
    let abs = host.vault.root().join(path);
    fs::create_dir_all(abs.parent().unwrap()).unwrap();
    fs::write(abs, content).unwrap();
}

async fn is_indexed(host: &TestHost, path: &str) -> bool {
    let path = vp(path);
    host.index
        .with_index(move |index, _vault| {
            let count: i64 = index
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM pages WHERE path = ?1",
                    [path.as_str()],
                    |row| row.get(0),
                )
                .unwrap();
            count == 1
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn drain_change_batch_collects_buffered_events() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ChangeEvent>();
    tx.send(ChangeEvent::Upsert(vp("notes/a.md"))).unwrap();
    tx.send(ChangeEvent::Remove(vp("notes/b.md"))).unwrap();
    tx.send(ChangeEvent::Upsert(vp("notes/c.md"))).unwrap();

    let first = rx.recv().await.expect("first event missing");
    let batch = drain_change_batch(first, &mut rx);

    assert_eq!(batch.len(), 3);
    assert!(rx.try_recv().is_err(), "drain must empty the channel");
}

#[test]
fn batch_changes_split_upserts_from_removes_in_order() {
    let batch = vec![
        ChangeEvent::Upsert(vp("notes/a.md")),
        ChangeEvent::Remove(vp("notes/b.md")),
        ChangeEvent::Upsert(vp("notes/c.md")),
    ];

    let changes = BatchChanges::from_batch(&batch);

    assert_eq!(changes.upserted, ["notes/a.md", "notes/c.md"]);
    assert_eq!(changes.removed, ["notes/b.md"]);
    assert!(!changes.base_registry_changed);
    assert!(!changes.is_empty());
}

#[test]
fn batch_changes_flag_base_registry_changes() {
    let changes = BatchChanges::from_batch(&[ChangeEvent::BaseChanged]);

    assert!(changes.upserted.is_empty() && changes.removed.is_empty());
    assert!(changes.base_registry_changed);
    assert!(!changes.is_empty());
}

#[test]
fn batch_changes_of_an_empty_batch_are_empty() {
    assert!(BatchChanges::from_batch(&[]).is_empty());
}

#[tokio::test]
async fn index_batch_indexes_upserts_and_removes_then_reports_them() {
    let (_tmp, host) = host();
    write_page(&host, "notes/gone.md", "---\ntitle: Gone\n---\nbody");
    index_batch(&*host, vec![ChangeEvent::Upsert(vp("notes/gone.md"))]).await;
    assert!(is_indexed(&host, "notes/gone.md").await);
    host.indexed.lock().clear();

    write_page(&host, "notes/new.md", "---\ntitle: New\n---\nbody");
    fs::remove_file(host.vault.root().join("notes/gone.md")).unwrap();
    index_batch(
        &*host,
        vec![
            ChangeEvent::Upsert(vp("notes/new.md")),
            ChangeEvent::Remove(vp("notes/gone.md")),
        ],
    )
    .await;

    assert!(is_indexed(&host, "notes/new.md").await);
    assert!(!is_indexed(&host, "notes/gone.md").await);
    let indexed = host.indexed.lock();
    assert_eq!(indexed.len(), 1);
    assert_eq!(indexed[0].upserted, ["notes/new.md"]);
    assert_eq!(indexed[0].removed, ["notes/gone.md"]);
}

#[tokio::test]
async fn run_watch_loop_drains_queued_events_into_one_batch() {
    let (_tmp, host) = host();
    write_page(&host, "notes/a.md", "---\ntitle: A\n---\nbody");
    write_page(&host, "notes/b.md", "---\ntitle: B\n---\nbody");
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<ChangeEvent>();
    tx.send(ChangeEvent::Upsert(vp("notes/a.md"))).unwrap();
    tx.send(ChangeEvent::Upsert(vp("notes/b.md"))).unwrap();
    tx.send(ChangeEvent::Remove(vp("notes/missing.md")))
        .unwrap();
    drop(tx);

    tokio::time::timeout(
        Duration::from_secs(5),
        run_watch_loop(Arc::clone(&host), rx),
    )
    .await
    .expect("loop must end when the sender is dropped");

    assert_eq!(*host.received.lock(), [3]);
    let indexed = host.indexed.lock();
    assert_eq!(indexed.len(), 1);
    assert_eq!(indexed[0].upserted, ["notes/a.md", "notes/b.md"]);
    assert_eq!(indexed[0].removed, ["notes/missing.md"]);
}

/// The watcher's per-batch reconcile must heal folder drift after indexing:
/// a page declaring `type: quote` that still lives under `notes/` is moved
/// to `quotes/`.
#[tokio::test]
async fn process_batch_reconciles_drifted_upsert() {
    let (_tmp, host) = host();
    let content = "---\nid: 0190f8a0-0000-7000-8000-0000000000a1\ntype: quote\n---\nbody";
    write_page(&host, "notes/q.md", content);

    process_batch(&*host, vec![ChangeEvent::Upsert(vp("notes/q.md"))]).await;

    let root = host.vault.root();
    assert!(
        root.join("quotes/q.md").exists(),
        "drifted page should have moved to quotes/q.md"
    );
    assert!(
        !root.join("notes/q.md").exists(),
        "source notes/q.md should be gone after reconcile"
    );
    assert_eq!(*host.received.lock(), [1]);
}

/// A page whose folder already matches its declared kind must be left
/// alone: reconcile is a no-op, not a rewrite.
#[tokio::test]
async fn reconcile_upserts_leaves_clean_pages_alone() {
    let (_tmp, host) = host();
    let content = "---\nid: 0190f8a0-0000-7000-8000-0000000000a2\ntype: quote\n---\nbody";
    write_page(&host, "quotes/q.md", content);
    index_batch(&*host, vec![ChangeEvent::Upsert(vp("quotes/q.md"))]).await;
    let abs = host.vault.root().join("quotes/q.md");
    let indexed = fs::read_to_string(&abs).unwrap();

    reconcile_upserts(&*host, vec![vp("quotes/q.md")]).await;

    assert_eq!(fs::read_to_string(abs).unwrap(), indexed);
}

/// Exclusions bound the reconcile the same way they bound indexing: a
/// drifted page inside an excluded subtree is not physically relocated.
#[tokio::test]
async fn reconcile_upserts_skips_excluded_paths() {
    let (_tmp, host) = host_with_config(Some(
        "[vault]\nexcluded_patterns = [\".clepsydra\", \".clepsydra/**\", \
         \"_attachments\", \"_attachments/**\", \"private\", \"private/**\"]\n",
    ));
    let content = "---\nid: 0190f8a0-0000-7000-8000-0000000000a3\ntype: quote\n---\nbody";
    write_page(&host, "private/q.md", content);

    reconcile_upserts(&*host, vec![vp("private/q.md")]).await;

    let root = host.vault.root();
    assert!(
        root.join("private/q.md").exists(),
        "excluded page must stay where the user put it"
    );
    assert!(
        !root.join("quotes/q.md").exists(),
        "excluded page must not be projected into a canonical folder"
    );
}

/// The reconcile takes the same `MutationCoordinator` path guard the API
/// write path holds across read → write → index, so a watcher move cannot
/// interleave with an in-flight page write on that path.
#[tokio::test]
async fn reconcile_upserts_waits_for_the_mutation_coordinator_lock() {
    let (_tmp, host) = host();
    let content = "---\nid: 0190f8a0-0000-7000-8000-0000000000a4\ntype: quote\n---\nbody";
    write_page(&host, "notes/q.md", content);
    let path = vp("notes/q.md");
    index_batch(&*host, vec![ChangeEvent::Upsert(path.clone())]).await;

    // Hold the path guard, as a concurrent API write would.
    let guard = host
        .coordinator
        .lock_paths(std::slice::from_ref(&path))
        .await;

    let reconcile = tokio::spawn({
        let host = Arc::clone(&host);
        async move { reconcile_upserts(&*host, vec![path]).await }
    });

    tokio::time::sleep(Duration::from_millis(100)).await;
    let root = host.vault.root();
    assert!(
        root.join("notes/q.md").exists() && !root.join("quotes/q.md").exists(),
        "reconcile must not move the page while the path guard is held"
    );

    drop(guard);
    reconcile.await.unwrap();

    assert!(
        root.join("quotes/q.md").exists(),
        "reconcile must proceed once the guard is released"
    );
}
