use std::path::Path;
use std::sync::Arc;

use axum::Router;
use axum_test::TestServer;
use chrono::Utc;
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

    // Allow the caller to write files into the vault before indexing.
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

/// End-to-end smoke test exercising the full tasks/journal workflow:
/// markdown -> index -> query -> mutation -> re-index -> carry-forward -> capture.
#[tokio::test]
async fn full_workflow_tasks_journal_agenda() {
    let yesterday = {
        let today = Utc::now().date_naive();
        (today - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string()
    };
    let today = Utc::now().format("%Y-%m-%d").to_string();

    let yesterday_clone = yesterday.clone();
    let (server, _tmp) = setup_server_with_files(move |vault_root| {
        let journals_dir = vault_root.join("journals");
        std::fs::create_dir_all(&journals_dir).unwrap();

        let journal_content = format!(
            "---\nid: 00000000-0000-0000-0000-111111111111\ntitle: \"{yesterday_clone}\"\ntags:\n  - journal\n---\n\
             - [ ] Write proposal [due:: {yesterday_clone}] [priority:: A]\n\
             - [ ] Review document\n\
             - [x] Buy groceries\n"
        );
        std::fs::write(
            journals_dir.join(format!("{yesterday_clone}.md")),
            &journal_content,
        )
        .unwrap();
    });

    // --- Step 1: Query tasks — should find the two incomplete tasks from yesterday ---
    let res = server.get("/api/vault/tasks?status=todo").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 2, "should find 2 todo tasks: {body:?}");

    // --- Step 2: Verify agenda/today includes yesterday's overdue tasks ---
    let res = server.get("/api/vault/agenda/today").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let agenda_tasks = body["tasks"].as_array().unwrap();
    assert!(!agenda_tasks.is_empty(), "agenda/today should have tasks");
    // The "Write proposal" task has due = yesterday, so it's overdue
    assert!(
        agenda_tasks
            .iter()
            .any(|t| t["content"].as_str().unwrap().contains("Write proposal")),
        "agenda should contain the overdue 'Write proposal' task"
    );

    // --- Step 3: Mark "Write proposal" as done ---
    // Find the span_start of the "Write proposal" task
    let proposal_task = tasks
        .iter()
        .find(|t| t["content"].as_str().unwrap().contains("Write proposal"))
        .unwrap();
    let page_path = proposal_task["page_path"].as_str().unwrap();
    let span_start = proposal_task["span_start"].as_i64().unwrap();

    let res = server
        .put("/api/vault/tasks/status")
        .json(&serde_json::json!({
            "page_path": page_path,
            "span_start": span_start,
            "status": "done"
        }))
        .await;
    res.assert_status_ok();
    let updated: serde_json::Value = res.json();
    assert_eq!(
        updated["status"].as_str().unwrap(),
        "done",
        "task status should be updated to done"
    );

    // --- Step 4: Re-query — should now have only 1 todo task ---
    let res = server.get("/api/vault/tasks?status=todo").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(
        tasks.len(),
        1,
        "should have 1 remaining todo task after marking one done"
    );
    assert!(
        tasks[0]["content"]
            .as_str()
            .unwrap()
            .contains("Review document"),
        "remaining todo task should be 'Review document'"
    );

    // --- Step 5: Get today's journal — carry-forward should include only the remaining incomplete task ---
    // Today's journal must exist before GET can return carried_forward.
    server.post("/api/vault/journal/today").await;

    let res = server.get("/api/vault/journal/today").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();

    // Basic page detail still present
    assert!(
        body["path"].as_str().unwrap().starts_with("journals/"),
        "today's journal path should start with journals/"
    );
    assert!(
        body["path"].as_str().unwrap().contains(&today),
        "today's journal path should contain today's date"
    );

    // Carried forward should only include "Review document" (not "Write proposal" which is done)
    let carried = body["carried_forward"]
        .as_array()
        .expect("carried_forward should be an array");
    assert!(
        !carried.is_empty(),
        "should have carried-forward tasks from yesterday"
    );
    assert!(
        carried
            .iter()
            .any(|t| t["content"].as_str().unwrap().contains("Review document")),
        "carried-forward should contain 'Review document'"
    );
    assert!(
        !carried
            .iter()
            .any(|t| t["content"].as_str().unwrap().contains("Write proposal")),
        "completed task 'Write proposal' should not be carried forward"
    );
    assert!(
        !carried
            .iter()
            .any(|t| t["content"].as_str().unwrap().contains("Buy groceries")),
        "already-completed task 'Buy groceries' should not be carried forward"
    );

    // --- Step 6: Quick capture to today's journal ---
    let res = server
        .post("/api/vault/journal/today/capture")
        .json(&serde_json::json!({ "content": "- [ ] New task from capture" }))
        .await;
    res.assert_status_ok();

    // Verify the captured task appears in task queries
    let res = server.get("/api/vault/tasks?status=todo").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(
        tasks.len(),
        2,
        "should now have 2 todo tasks (yesterday's remaining + captured): {tasks:?}"
    );
    assert!(
        tasks.iter().any(|t| t["content"]
            .as_str()
            .unwrap()
            .contains("New task from capture")),
        "captured task should appear in task queries"
    );
    assert!(
        tasks
            .iter()
            .any(|t| t["content"].as_str().unwrap().contains("Review document")),
        "yesterday's remaining task should still appear"
    );
}
