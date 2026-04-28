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
        vault,
        index: index_handle,
        cas: Arc::new(parking_lot::Mutex::new(cas)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: production_hooks(),
        delete_hooks: Arc::new(vec![]),
        archive_ingest_lock: tokio::sync::Mutex::new(()),
        bcl: None,
    });

    let app: Router = Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);

    let server = TestServer::new(app).unwrap();
    (server, tmp)
}

#[tokio::test]
async fn list_tasks_returns_tasks_from_indexed_pages() {
    let (server, _tmp) = setup_server();

    // Create a page with task items
    server
        .post("/api/vault/pages/tasks.md")
        .json(&serde_json::json!({
            "title": "Tasks",
            "body": "- [ ] Buy milk [due:: 2026-03-01] [priority:: A]\n- [x] Done task\n- Regular item\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    // Query all tasks
    let res = server.get("/api/vault/tasks").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    // Should find 2 tasks (the two checkbox items), not the regular item
    assert_eq!(tasks.len(), 2, "expected 2 tasks, got: {tasks:?}");
    assert_eq!(body["total"], 2);
}

#[tokio::test]
async fn filter_tasks_by_status() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/filtered.md")
        .json(&serde_json::json!({
            "title": "Filtered Tasks",
            "body": "- [ ] Incomplete task\n- [x] Completed task\n- [ ] Another todo\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    // Filter by status=todo
    let res = server.get("/api/vault/tasks?status=todo").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 2, "expected 2 todo tasks, got: {tasks:?}");
    for task in tasks {
        assert_eq!(task["status"], "todo");
    }

    // Filter by status=done
    let res = server.get("/api/vault/tasks?status=done").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "expected 1 done task, got: {tasks:?}");
    assert_eq!(tasks[0]["status"], "done");
}

#[tokio::test]
async fn filter_tasks_by_due_date() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/due-dates.md")
        .json(&serde_json::json!({
            "title": "Due Dates",
            "body": "- [ ] Early task [due:: 2026-01-15]\n- [ ] Late task [due:: 2026-06-01]\n- [ ] No due date\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    // Due before 2026-03-01
    let res = server
        .get("/api/vault/tasks?due_before=2026-03-01")
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "expected 1 task due before March, got: {tasks:?}");
    assert!(tasks[0]["content"].as_str().unwrap().contains("Early task"));
}

#[tokio::test]
async fn filter_tasks_has_no_date() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/no-date.md")
        .json(&serde_json::json!({
            "title": "No Date",
            "body": "- [ ] Dated task [due:: 2026-03-01]\n- [ ] Undated task\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let res = server.get("/api/vault/tasks?has_no_date=true").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "expected 1 undated task, got: {tasks:?}");
    assert!(tasks[0]["content"].as_str().unwrap().contains("Undated task"));
}

#[tokio::test]
async fn filter_tasks_by_page_prefix() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/journals/2026-02-17.md")
        .json(&serde_json::json!({
            "title": "Journal",
            "body": "- [ ] Journal task\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    server
        .post("/api/vault/pages/projects/alpha.md")
        .json(&serde_json::json!({
            "title": "Alpha",
            "body": "- [ ] Project task\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    // Filter to journals/ prefix only
    let res = server.get("/api/vault/tasks?page=journals/").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "expected 1 journal task, got: {tasks:?}");
    assert!(tasks[0]["page_path"]
        .as_str()
        .unwrap()
        .starts_with("journals/"));
}

#[tokio::test]
async fn filter_tasks_by_priority() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/priority.md")
        .json(&serde_json::json!({
            "title": "Priority",
            "body": "- [ ] High priority [priority:: A]\n- [ ] Low priority [priority:: C]\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let res = server.get("/api/vault/tasks?priority=A").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "expected 1 priority-A task, got: {tasks:?}");
    assert!(tasks[0]["content"].as_str().unwrap().contains("High priority"));
}

#[tokio::test]
async fn tasks_include_properties() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/props.md")
        .json(&serde_json::json!({
            "title": "Props",
            "body": "- [ ] Task with props [due:: 2026-04-01] [priority:: B]\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let res = server.get("/api/vault/tasks").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1);
    let props = &tasks[0]["properties"];
    assert_eq!(props["due"], "2026-04-01");
    assert_eq!(props["priority"], "B");
    assert_eq!(props["status"], "todo");
}

#[tokio::test]
async fn update_task_status_rewrites_markdown() {
    let (server, _tmp) = setup_server();

    // Create page with a task
    server
        .post("/api/vault/pages/update-test.md")
        .json(&serde_json::json!({
            "title": "Update Test",
            "body": "- [ ] Incomplete task\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    // Get the task to find its span_start
    let res = server.get("/api/vault/tasks?page=update-test.md").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1);
    let span_start = tasks[0]["span_start"].as_i64().unwrap();

    // Update status to done
    let res = server
        .put("/api/vault/tasks/status")
        .json(&serde_json::json!({
            "page_path": "update-test.md",
            "span_start": span_start,
            "status": "done"
        }))
        .await;
    res.assert_status_ok();
    let updated: serde_json::Value = res.json();
    assert_eq!(updated["status"], "done");

    // Verify the page markdown was rewritten
    let page_res = server.get("/api/vault/pages/update-test.md").await;
    page_res.assert_status_ok();
    let page_body: serde_json::Value = page_res.json();
    let body_text = page_body["body"].as_str().unwrap();
    assert!(
        body_text.contains("[x]"),
        "expected [x] in body after marking done, got: {body_text}"
    );
    assert!(
        !body_text.contains("[ ]"),
        "expected no [ ] in body after marking done, got: {body_text}"
    );
}

#[tokio::test]
async fn update_task_status_done_to_todo() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/toggle.md")
        .json(&serde_json::json!({
            "title": "Toggle",
            "body": "- [x] Completed task\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let res = server.get("/api/vault/tasks?page=toggle.md").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1);
    let span_start = tasks[0]["span_start"].as_i64().unwrap();
    assert_eq!(tasks[0]["status"], "done");

    // Update status back to todo
    let res = server
        .put("/api/vault/tasks/status")
        .json(&serde_json::json!({
            "page_path": "toggle.md",
            "span_start": span_start,
            "status": "todo"
        }))
        .await;
    res.assert_status_ok();
    let updated: serde_json::Value = res.json();
    assert_eq!(updated["status"], "todo");

    // Verify the markdown
    let page_res = server.get("/api/vault/pages/toggle.md").await;
    page_res.assert_status_ok();
    let page_body: serde_json::Value = page_res.json();
    let body_text = page_body["body"].as_str().unwrap();
    assert!(
        body_text.contains("[ ]"),
        "expected [ ] in body after marking todo, got: {body_text}"
    );
}

#[tokio::test]
async fn update_task_status_to_cancelled() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/cancel.md")
        .json(&serde_json::json!({
            "title": "Cancel",
            "body": "- [ ] Task to cancel\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let res = server.get("/api/vault/tasks?page=cancel.md").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    let span_start = tasks[0]["span_start"].as_i64().unwrap();

    let res = server
        .put("/api/vault/tasks/status")
        .json(&serde_json::json!({
            "page_path": "cancel.md",
            "span_start": span_start,
            "status": "cancelled"
        }))
        .await;
    res.assert_status_ok();
    let updated: serde_json::Value = res.json();
    assert_eq!(updated["status"], "cancelled");

    // Verify the markdown
    let page_res = server.get("/api/vault/pages/cancel.md").await;
    page_res.assert_status_ok();
    let page_body: serde_json::Value = page_res.json();
    let body_text = page_body["body"].as_str().unwrap();
    assert!(
        body_text.contains("[-]"),
        "expected [-] in body after cancelling, got: {body_text}"
    );
}

#[tokio::test]
async fn update_task_invalid_status_returns_400() {
    let (server, _tmp) = setup_server();

    let res = server
        .put("/api/vault/tasks/status")
        .json(&serde_json::json!({
            "page_path": "whatever.md",
            "span_start": 0,
            "status": "invalid"
        }))
        .await;
    res.assert_status(axum::http::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn update_task_nonexistent_page_returns_404() {
    let (server, _tmp) = setup_server();

    let res = server
        .put("/api/vault/tasks/status")
        .json(&serde_json::json!({
            "page_path": "nonexistent.md",
            "span_start": 0,
            "status": "done"
        }))
        .await;
    res.assert_status(axum::http::StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn list_tasks_pagination() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/many-tasks.md")
        .json(&serde_json::json!({
            "title": "Many Tasks",
            "body": "- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3\n- [ ] Task 4\n- [ ] Task 5\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    // Get first 2
    let res = server.get("/api/vault/tasks?limit=2&offset=0").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 2);
    assert_eq!(body["total"], 5);

    // Get next 2
    let res = server.get("/api/vault/tasks?limit=2&offset=2").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 2);
    assert_eq!(body["total"], 5);

    // Get last 1
    let res = server.get("/api/vault/tasks?limit=2&offset=4").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(body["total"], 5);
}

#[tokio::test]
async fn filter_tasks_comma_separated_status() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/multi-status.md")
        .json(&serde_json::json!({
            "title": "Multi Status",
            "body": "- [ ] Todo task\n- [x] Done task\n- [-] Cancelled task\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    // Filter by todo,cancelled
    let res = server.get("/api/vault/tasks?status=todo,cancelled").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 2, "expected todo + cancelled, got: {tasks:?}");
    let statuses: Vec<&str> = tasks
        .iter()
        .map(|t| t["status"].as_str().unwrap())
        .collect();
    assert!(statuses.contains(&"todo"));
    assert!(statuses.contains(&"cancelled"));
}
