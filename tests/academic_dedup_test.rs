/// Tests for the dedup early-return paths of `import_doi` and `import_isbn_handler`.
///
/// Both handlers check whether a matching work already exists (by DOI or ISBN)
/// before attempting any network fetch.  When the work IS found, the handler
/// returns `200 OK` with `{ "status": "skipped" }` and never calls
/// `fetch_doi` / `fetch_isbn`.  These tests exercise that path entirely
/// in-process — no real network is used.
use std::sync::Arc;

use axum::Router;
use axum::http::StatusCode;
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

fn setup_server() -> (TestServer, TempDir) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let cas_path = tmp.path().join("cas");
    let cas = ContentStore::open(&cas_path).unwrap();

    let index_handle = IndexHandle::spawn(index, vault.clone());

    let (change_tx, _) = broadcast::channel(64);
    let state = Arc::new(AppState {
        started_at: std::time::Instant::now(),
        vault,
        index: index_handle,
        cas: Arc::new(parking_lot::Mutex::new(cas)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: production_hooks(),
        delete_hooks: Arc::new(vec![]),
        mutation_coordinator: clepsydra::vault::mutation_coordinator::MutationCoordinator::new(),
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

/// `import_doi` returns 200 "skipped" (without hitting the network) when a
/// work with the same DOI already exists in the vault.
#[tokio::test]
async fn import_doi_skips_when_work_already_exists() {
    let (server, _tmp) = setup_server();
    let doi = "10.1234/abcd";

    // 1. Create a work that carries the DOI in its external_ids.
    let create_res = server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "work_type": "paper",
            "title": "A Study of Things",
            "external_ids": { "doi": doi }
        }))
        .await;
    create_res.assert_status(StatusCode::CREATED);
    let created: serde_json::Value = create_res.json();
    let existing_path = created["path"].as_str().expect("path in response");

    // 2. POST /import/doi with the same DOI — dedup should short-circuit.
    let import_res = server
        .post("/api/vault/academic/import/doi")
        .json(&serde_json::json!({ "doi": doi }))
        .await;

    // 3. Assert 200 OK and status == "skipped".
    import_res.assert_status(StatusCode::OK);
    let body: serde_json::Value = import_res.json();
    assert_eq!(
        body["status"].as_str(),
        Some("skipped"),
        "expected status=skipped, got: {body}"
    );
    // page_path should point back to the work we just created.
    assert_eq!(
        body["page_path"].as_str(),
        Some(existing_path),
        "page_path should be the existing work path, got: {body}"
    );
}

/// `import_isbn_handler` returns 200 "skipped" (without hitting the network)
/// when a work with the same ISBN already exists in the vault.
#[tokio::test]
async fn import_isbn_skips_when_work_already_exists() {
    let (server, _tmp) = setup_server();
    let isbn = "9780262011532";

    // 1. Create a work that carries the ISBN in its external_ids.
    let create_res = server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "work_type": "book",
            "title": "Structure and Interpretation of Computer Programs",
            "external_ids": { "isbn": isbn }
        }))
        .await;
    create_res.assert_status(StatusCode::CREATED);
    let created: serde_json::Value = create_res.json();
    let existing_path = created["path"].as_str().expect("path in response");

    // 2. POST /import/isbn with the same ISBN — dedup should short-circuit.
    let import_res = server
        .post("/api/vault/academic/import/isbn")
        .json(&serde_json::json!({ "isbn": isbn }))
        .await;

    // 3. Assert 200 OK and status == "skipped".
    import_res.assert_status(StatusCode::OK);
    let body: serde_json::Value = import_res.json();
    assert_eq!(
        body["status"].as_str(),
        Some("skipped"),
        "expected status=skipped, got: {body}"
    );
    // page_path should point back to the work we just created.
    assert_eq!(
        body["page_path"].as_str(),
        Some(existing_path),
        "page_path should be the existing work path, got: {body}"
    );
}
