use std::path::Path;
use std::sync::Arc;

use axum::Router;
use axum_test::TestServer;
use tokio::sync::broadcast;

use clepsydra::api::{AppState, api_router};
use clepsydra::vault::Vault;
use clepsydra::vault::academic_hook::AcademicMoveHook;
use clepsydra::vault::cas::ContentStore;
use clepsydra::vault::hooks::PostMoveHook;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::index_handle::IndexHandle;
use clepsydra::vault::init::init_vault;
use tempfile::TempDir;

fn production_hooks() -> Arc<Vec<Box<dyn PostMoveHook>>> {
    Arc::new(vec![Box::new(AcademicMoveHook)])
}

fn setup_server_with_files(pre_index: impl FnOnce(&Path)) -> (TestServer, TempDir) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    pre_index(&root);

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let cas_path = tmp.path().join("cas");
    let cas = ContentStore::open(&cas_path).unwrap();
    let index_handle = IndexHandle::spawn(index, vault.clone());

    let (change_tx, _) = broadcast::channel(64);
    let feed_settings = clepsydra::FeedsSettings::default();
    let feeds =
        clepsydra::feeds::store::FeedStoreHandle::open(&root.join(".clepsydra/feeds.db")).unwrap();
    let feed_client =
        clepsydra::feeds::network::CheckedHttpClient::new(feed_settings.max_response_bytes)
            .unwrap();
    let state = Arc::new(AppState {
        started_at: std::time::Instant::now(),
        clock: Arc::new(clepsydra::api::SystemClock),
        vault,
        index: index_handle,
        cas: Arc::new(parking_lot::Mutex::new(cas)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: production_hooks(),
        delete_hooks: Arc::new(vec![]),
        mutation_coordinator: clepsydra::vault::mutation_coordinator::MutationCoordinator::new(),
        feeds,
        feed_client,
        feed_discovery_semaphore: tokio::sync::Semaphore::new(
            feed_settings.fetch_concurrency.max(1),
        ),
        feed_refresh: tokio::sync::Notify::new(),
        feed_manifest_diagnostics: parking_lot::RwLock::new(Vec::new()),
        feed_manifest_lock: tokio::sync::Mutex::new(()),
        feed_settings,
        archive_ingest_lock: tokio::sync::Mutex::new(()),
        bcl: None,
        location: parking_lot::RwLock::new(None),
    });

    let app: Router = Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);

    let server = TestServer::new(app).unwrap();
    (server, tmp)
}

#[tokio::test]
async fn block_ref_link_resolves_to_page() {
    let (server, _dir) = setup_server_with_files(|root| {
        std::fs::write(
            root.join("source.md"),
            "---\ntitle: Source\n---\n- Buy milk ^abc123DEF0a\n",
        )
        .unwrap();
        std::fs::write(
            root.join("referrer.md"),
            "---\ntitle: Referrer\n---\nSee ((abc123DEF0a))\n",
        )
        .unwrap();
    });

    // Check backlinks for source page — referrer should appear
    let response = server.get("/api/vault/index/backlinks/source.md").await;
    response.assert_status_ok();
    let backlinks: Vec<serde_json::Value> = response.json();
    assert!(
        backlinks
            .iter()
            .any(|bl| bl["source_path"].as_str() == Some("referrer.md")),
        "block ref should create a backlink from referrer to source. Got: {backlinks:?}"
    );
}
