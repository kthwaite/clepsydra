use std::fs;
use std::path::{Path, PathBuf};
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

const TRANSACTION_ID: &str = "0198a4df-f5c2-7cf0-8000-000000000007";

fn init_production_vault(tmp: &TempDir) -> PathBuf {
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    let config_path = root.join(".clepsydra/config.toml");
    let mut config = fs::read_to_string(&config_path).unwrap();
    config.push_str(&format!(
        "\n[archive]\ncas_path = {:?}\n",
        root.join(".clepsydra/cas").to_string_lossy()
    ));
    fs::write(config_path, config).unwrap();
    root.canonicalize().unwrap()
}

fn seed_write_transaction(
    root: &Path,
    phase: &str,
    files: &[(&str, &[u8], &[u8], bool)],
) -> PathBuf {
    seed_write_transaction_at(root, TRANSACTION_ID, phase, files)
}

fn seed_write_transaction_at(
    root: &Path,
    transaction_id: &str,
    phase: &str,
    files: &[(&str, &[u8], &[u8], bool)],
) -> PathBuf {
    let directory = root.join(".clepsydra/transactions").join(transaction_id);
    fs::create_dir_all(directory.join("staged")).unwrap();
    fs::create_dir_all(directory.join("rollback")).unwrap();
    fs::create_dir_all(directory.join("created")).unwrap();

    let mut intents = Vec::with_capacity(files.len());
    let mut index_events = Vec::with_capacity(files.len());
    for (index, (path, before, after, published)) in files.iter().enumerate() {
        fs::write(root.join(path), if *published { after } else { before }).unwrap();
        fs::write(directory.join("staged").join(index.to_string()), after).unwrap();
        fs::write(directory.join("rollback").join(index.to_string()), before).unwrap();
        intents.push(serde_json::json!({
            "kind": "write",
            "path": path,
            "before_hash": blake3::hash(before).to_hex().to_string(),
            "after_hash": blake3::hash(after).to_hex().to_string(),
        }));
        index_events.push(serde_json::json!({
            "kind": "upsert",
            "path": path,
        }));
    }

    fs::write(
        directory.join("manifest.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "phase": phase,
            "create_directories": [],
            "created_directories": [],
            "remove_directories": [],
            "intents": intents,
            "index_events": index_events,
            "moved_pages": [],
        }))
        .unwrap(),
    )
    .unwrap();
    directory
}

fn server_for_state(state: Arc<AppState>) -> TestServer {
    TestServer::new(
        Router::new()
            .nest("/api/vault", api_router())
            .with_state(state),
    )
    .unwrap()
}

fn production_hooks() -> Arc<Vec<Box<dyn PostMoveHook>>> {
    Arc::new(vec![Box::new(AcademicMoveHook)])
}

/// Set up a test server backed by a fresh vault in a temporary directory.
fn setup_server() -> (TestServer, TempDir) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();

    let vault = Vault::open(&root).unwrap();
    let rubbish = clepsydra::vault::rubbish::RubbishStore::for_vault(vault.root());
    let archive_resource_concurrency = clepsydra::api::archive::archive_resource_concurrency(
        vault.config().archive.max_blob_size_mb,
    );
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
        rubbish,
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
        archive_view_semaphore: Arc::new(tokio::sync::Semaphore::new(1)),
        archive_resource_semaphore: Arc::new(tokio::sync::Semaphore::new(
            archive_resource_concurrency,
        )),
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
async fn full_vault_lifecycle() {
    let (server, tmp) = setup_server();
    let vault_root = tmp.path().join("vault");

    // 1. Create page "index.md" with body linking to [[Design Notes]]
    let res = server
        .post("/api/vault/pages/index.md")
        .json(&serde_json::json!({
            "title": "Index",
            "body": "Welcome to [[Design Notes]]."
        }))
        .await;
    res.assert_status(StatusCode::CREATED);

    // 2. Create page "design.md" with title "Design Notes" and tags
    let res = server
        .post("/api/vault/pages/design.md")
        .json(&serde_json::json!({
            "title": "Design Notes",
            "tags": ["architecture"],
            "body": "Architecture documentation."
        }))
        .await;
    res.assert_status(StatusCode::CREATED);

    // 3. POST /index/rebuild
    let res = server.post("/api/vault/index/rebuild").await;
    res.assert_status_ok();
    let rebuild: serde_json::Value = res.json();
    // Pages were already indexed during create; rebuild may report them as
    // skipped (hash unchanged) or indexed. Either way it should succeed.
    let total =
        rebuild["pages_indexed"].as_i64().unwrap() + rebuild["pages_skipped"].as_i64().unwrap();
    assert_eq!(total, 2, "expected 2 total pages, got rebuild: {rebuild}");

    // 4. GET /index/backlinks/design.md -> verify index.md is listed
    let res = server.get("/api/vault/index/backlinks/design.md").await;
    res.assert_status_ok();
    let backlinks: Vec<serde_json::Value> = res.json();
    assert_eq!(
        backlinks.len(),
        1,
        "expected 1 backlink, got: {backlinks:?}"
    );
    assert_eq!(backlinks[0]["source_path"], "index.md");

    // 5. GET /index/tags -> verify "architecture" present
    let res = server.get("/api/vault/index/tags").await;
    res.assert_status_ok();
    let tags: Vec<serde_json::Value> = res.json();
    let arch_tag = tags.iter().find(|t| t["tag"] == "architecture");
    assert!(
        arch_tag.is_some(),
        "expected 'architecture' tag, got: {tags:?}"
    );

    // 6. POST /pages-move/design.md with destination "architecture.md"
    let res = server
        .post("/api/vault/pages-move/design.md")
        .json(&serde_json::json!({"destination": "architecture.md"}))
        .await;
    assert_eq!(res.status_code(), StatusCode::OK);

    // Verify file moved
    assert!(
        !vault_root.join("design.md").exists(),
        "design.md should not exist after move"
    );
    assert!(
        vault_root.join("architecture.md").exists(),
        "architecture.md should exist after move"
    );

    // 7. Read index.md from disk -> verify [[Design Notes]] was rewritten
    let index_content_before_archive = fs::read_to_string(vault_root.join("index.md")).unwrap();
    assert!(
        !index_content_before_archive.contains("[[Design Notes]]"),
        "old wikilink should be rewritten, found: {index_content_before_archive}"
    );

    // 8. GET /index/stats -> verify 2 pages
    let res = server.get("/api/vault/index/stats").await;
    res.assert_status_ok();
    let stats: serde_json::Value = res.json();
    assert_eq!(stats["pages"], 2);

    // 9. DELETE /pages/architecture.md -> archive and return the rubbish identity
    let res = server.delete("/api/vault/pages/architecture.md").await;
    res.assert_status(StatusCode::CREATED);
    let archived: serde_json::Value = res.json();
    assert_eq!(archived["original_path"], "architecture.md");
    let item_id = archived["item_id"].as_str().unwrap();

    // The active source leaves every ordinary page surface.
    assert!(
        !vault_root.join("architecture.md").exists(),
        "architecture.md should not remain active after archive"
    );
    server
        .get("/api/vault/pages/architecture.md")
        .await
        .assert_status(StatusCode::NOT_FOUND);
    let pages: serde_json::Value = server.get("/api/vault/pages").await.json();
    assert!(
        pages["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|page| page["path"] != "architecture.md")
    );

    // The opaque lifecycle item remains available in the Rubbish Bin.
    let rubbish = server.get(&format!("/api/vault/rubbish/{item_id}")).await;
    rubbish.assert_status_ok();
    let rubbish: serde_json::Value = rubbish.json();
    assert_eq!(rubbish["item"]["item_id"], item_id);
    assert_eq!(rubbish["item"]["original_path"], "architecture.md");

    // Archival never rewrites the surviving backlink source.
    let index_content_after_archive = fs::read_to_string(vault_root.join("index.md")).unwrap();
    assert_eq!(index_content_after_archive, index_content_before_archive);

    // 11. POST /index/rebuild
    let res = server.post("/api/vault/index/rebuild").await;
    res.assert_status_ok();

    // 12. GET /index/stats -> verify 1 page
    let res = server.get("/api/vault/index/stats").await;
    res.assert_status_ok();
    let stats: serde_json::Value = res.json();
    assert_eq!(stats["pages"], 1);
}

#[tokio::test]
async fn transaction_recovery_restores_partially_committed_files_before_startup_index_build() {
    let tmp = TempDir::new().unwrap();
    let root = init_production_vault(&tmp);
    let before_alpha = b"# Alpha\nrollbackalpha\n";
    let after_alpha = b"# Alpha\ncommittedalpha\n";
    let before_beta = b"# Beta\nrollbackbeta\n";
    let after_beta = b"# Beta\ncommittedbeta\n";
    let directory = seed_write_transaction(
        &root,
        "committing",
        &[
            ("alpha.md", before_alpha, after_alpha, true),
            ("beta.md", before_beta, after_beta, false),
        ],
    );

    let state = clepsydra::build_app_state(&root).await.unwrap();

    let alpha_bytes = fs::read(root.join("alpha.md")).unwrap();
    assert!(alpha_bytes.ends_with(before_alpha));
    assert!(
        !alpha_bytes
            .windows(after_alpha.len())
            .any(|bytes| bytes == after_alpha)
    );
    let beta_bytes = fs::read(root.join("beta.md")).unwrap();
    assert!(beta_bytes.ends_with(before_beta));
    assert!(
        !beta_bytes
            .windows(after_beta.len())
            .any(|bytes| bytes == after_beta)
    );
    assert!(!directory.exists());

    let server = server_for_state(state);
    let alpha_results: serde_json::Value = server
        .get("/api/vault/index/search?q=rollbackalpha")
        .await
        .json();
    assert_eq!(alpha_results[0]["path"], "alpha.md");
    let beta_results: serde_json::Value = server
        .get("/api/vault/index/search?q=rollbackbeta")
        .await
        .json();
    assert_eq!(beta_results[0]["path"], "beta.md");
}

#[tokio::test]
async fn transaction_recovery_indexes_and_finalizes_filesystem_committed_transaction() {
    let tmp = TempDir::new().unwrap();
    let root = init_production_vault(&tmp);
    let before = b"# Gamma\nrollbackgamma\n";
    let after = b"# Gamma\ncommittedgamma\n";
    let directory = seed_write_transaction(
        &root,
        "filesystem_committed",
        &[("gamma.md", before, after, true)],
    );

    let state = clepsydra::build_app_state(&root).await.unwrap();

    assert!(fs::read(root.join("gamma.md")).unwrap().ends_with(after));
    assert!(!directory.exists());
    let server = server_for_state(state);
    let results: serde_json::Value = server
        .get("/api/vault/index/search?q=committedgamma")
        .await
        .json();
    assert_eq!(results[0]["path"], "gamma.md");
}

#[cfg(unix)]
#[tokio::test]
async fn transaction_recovery_finalization_failure_reports_all_observed_retained_workspaces() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = TempDir::new().unwrap();
    let root = init_production_vault(&tmp);
    let first = seed_write_transaction_at(
        &root,
        "0198a4df-f5c2-7cf0-8000-000000000006",
        "filesystem_committed",
        &[(
            "first.md",
            b"# First\nrollbackfirst\n",
            b"# First\ncommittedfirst\n",
            true,
        )],
    );
    let second = seed_write_transaction_at(
        &root,
        "0198a4df-f5c2-7cf0-8000-000000000008",
        "filesystem_committed",
        &[(
            "second.md",
            b"# Second\nrollbacksecond\n",
            b"# Second\ncommittedsecond\n",
            true,
        )],
    );
    let mut permissions = fs::metadata(&first).unwrap().permissions();
    permissions.set_mode(0o500);
    fs::set_permissions(&first, permissions).unwrap();

    let error = clepsydra::build_app_state(&root)
        .await
        .err()
        .expect("first workspace cleanup failure must block startup");

    let mut permissions = fs::metadata(&first).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&first, permissions).unwrap();
    let message = error.to_string();
    assert!(
        message.contains(&first.display().to_string()),
        "startup error must report observed retained workspace {}: {message}",
        first.display()
    );
    assert!(
        message.contains(&second.display().to_string()),
        "startup error must report unattempted retained workspace {}: {message}",
        second.display()
    );
    assert!(first.is_dir());
    assert!(second.is_dir());
}

#[tokio::test]
async fn transaction_recovery_retains_committed_workspace_and_reports_it_when_index_open_fails() {
    let tmp = TempDir::new().unwrap();
    let root = init_production_vault(&tmp);
    let before = b"# Epsilon\nrollbackepsilon\n";
    let after = b"# Epsilon\ncommittedepsilon\n";
    let directory = seed_write_transaction(
        &root,
        "filesystem_committed",
        &[("epsilon.md", before, after, true)],
    );
    fs::create_dir(root.join(".clepsydra/cache.db")).unwrap();

    let error = clepsydra::build_app_state(&root)
        .await
        .err()
        .expect("index open failure must block startup");

    assert!(
        error.to_string().contains(&directory.display().to_string()),
        "startup error must identify retained workspace {}: {error}",
        directory.display()
    );
    assert!(directory.is_dir());
    assert_eq!(fs::read(root.join("epsilon.md")).unwrap(), after);
}

#[tokio::test]
async fn transaction_recovery_failure_blocks_startup_and_reports_retained_workspace() {
    let tmp = TempDir::new().unwrap();
    let root = init_production_vault(&tmp);
    let before = b"# Delta\nrollbackdelta\n";
    let after = b"# Delta\ncommitteddelta\n";
    let directory =
        seed_write_transaction(&root, "committing", &[("delta.md", before, after, true)]);
    let external = b"# Delta\nexternaldelta\n";
    fs::write(root.join("delta.md"), external).unwrap();

    let error = clepsydra::build_app_state(&root)
        .await
        .err()
        .expect("conflicting retained transaction must block startup");

    assert!(
        error.to_string().contains(&directory.display().to_string()),
        "startup error must identify retained workspace {}: {error}",
        directory.display()
    );
    assert!(directory.is_dir());
    assert_eq!(fs::read(root.join("delta.md")).unwrap(), external);
    assert!(!root.join(".clepsydra/cache.db").exists());
}

#[tokio::test]
async fn folder_tree_returns_all_non_hidden_folders() {
    let (server, tmp) = setup_server();
    let vault_root = tmp.path().join("vault");

    // Create a nested folder structure
    fs::create_dir_all(vault_root.join("notes/sub")).unwrap();
    fs::create_dir_all(vault_root.join("projects/active")).unwrap();
    fs::create_dir_all(vault_root.join(".hidden")).unwrap();

    let res = server.get("/api/vault/folders/tree").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let paths: Vec<&str> = body["paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();

    assert!(paths.contains(&"notes"), "expected 'notes' in {paths:?}");
    assert!(
        paths.contains(&"notes/sub"),
        "expected 'notes/sub' in {paths:?}"
    );
    assert!(
        paths.contains(&"projects"),
        "expected 'projects' in {paths:?}"
    );
    assert!(
        paths.contains(&"projects/active"),
        "expected 'projects/active' in {paths:?}"
    );
    assert!(
        !paths.iter().any(|p| p.starts_with('.')),
        "hidden directories should be excluded: {paths:?}"
    );
    // Paths should be sorted
    let mut sorted = paths.clone();
    sorted.sort();
    assert_eq!(paths, sorted, "paths should be sorted alphabetically");
}
