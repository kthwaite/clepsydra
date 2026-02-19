use std::sync::Arc;

use axum::Router;
use axum_test::TestServer;
use chrono::{Duration, Utc};
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
    });

    let app: Router = Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);

    let server = TestServer::new(app).unwrap();
    (server, tmp)
}

fn today_str() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

fn yesterday_str() -> String {
    (Utc::now().date_naive() - Duration::days(1))
        .format("%Y-%m-%d")
        .to_string()
}

// ---------------------------------------------------------------------------
// GET /agenda/today
// ---------------------------------------------------------------------------

#[tokio::test]
async fn agenda_today_returns_due_today_tasks() {
    let (server, _tmp) = setup_server();
    let today = today_str();

    // Create a page with a task due today
    server
        .post("/api/vault/pages/tasks.md")
        .json(&serde_json::json!({
            "title": "Tasks",
            "body": format!("- [ ] Buy milk [due:: {today}]\n")
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let res = server.get("/api/vault/agenda/today").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "expected 1 task due today, got: {tasks:?}");
    assert!(tasks[0]["content"].as_str().unwrap().contains("Buy milk"));
}

#[tokio::test]
async fn agenda_today_includes_scheduled_today() {
    let (server, _tmp) = setup_server();
    let today = today_str();

    server
        .post("/api/vault/pages/sched.md")
        .json(&serde_json::json!({
            "title": "Scheduled",
            "body": format!("- [ ] Meeting [scheduled:: {today}]\n")
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let res = server.get("/api/vault/agenda/today").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "expected 1 scheduled-today task, got: {tasks:?}");
    assert!(tasks[0]["content"].as_str().unwrap().contains("Meeting"));
}

#[tokio::test]
async fn agenda_today_includes_overdue() {
    let (server, _tmp) = setup_server();
    let yesterday = yesterday_str();

    // Create a page with a task due yesterday (overdue)
    server
        .post("/api/vault/pages/overdue.md")
        .json(&serde_json::json!({
            "title": "Overdue",
            "body": format!("- [ ] Overdue task [due:: {yesterday}]\n")
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let res = server.get("/api/vault/agenda/today").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "expected 1 overdue task, got: {tasks:?}");
    assert!(tasks[0]["content"].as_str().unwrap().contains("Overdue task"));
}

#[tokio::test]
async fn agenda_today_includes_journal_tasks() {
    let (server, _tmp) = setup_server();

    // Create today's journal with an incomplete task (no due date)
    server.get("/api/vault/journal/today").await.assert_status_ok();
    server
        .post("/api/vault/journal/today/capture")
        .json(&serde_json::json!({ "content": "- [ ] Journal task without due date" }))
        .await
        .assert_status_ok();

    let res = server.get("/api/vault/agenda/today").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "expected 1 journal task, got: {tasks:?}");
    assert!(tasks[0]["content"]
        .as_str()
        .unwrap()
        .contains("Journal task without due date"));
}

#[tokio::test]
async fn agenda_today_deduplicates() {
    let (server, _tmp) = setup_server();
    let today = today_str();

    // Create today's journal with a task that is also due today.
    // This matches BOTH the journal_date condition and the due condition,
    // but should appear only once.
    server.get("/api/vault/journal/today").await.assert_status_ok();
    server
        .post("/api/vault/journal/today/capture")
        .json(&serde_json::json!({
            "content": format!("- [ ] Dual match [due:: {today}]")
        }))
        .await
        .assert_status_ok();

    let res = server.get("/api/vault/agenda/today").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "expected deduplication, got: {tasks:?}");
}

// ---------------------------------------------------------------------------
// GET /agenda/week
// ---------------------------------------------------------------------------

#[tokio::test]
async fn agenda_week_groups_by_date() {
    let (server, _tmp) = setup_server();
    let today = Utc::now().date_naive();
    let d1 = today.format("%Y-%m-%d").to_string();
    let d2 = (today + Duration::days(2)).format("%Y-%m-%d").to_string();
    let d3 = (today + Duration::days(5)).format("%Y-%m-%d").to_string();

    server
        .post("/api/vault/pages/week-tasks.md")
        .json(&serde_json::json!({
            "title": "Week Tasks",
            "body": format!(
                "- [ ] Task A [due:: {d1}]\n\
                 - [ ] Task B [due:: {d2}]\n\
                 - [ ] Task C [due:: {d3}]\n"
            )
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let res = server.get("/api/vault/agenda/week").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let days = body["days"].as_array().unwrap();
    assert_eq!(days.len(), 3, "expected 3 distinct days, got: {days:?}");
    assert_eq!(days[0]["date"], d1);
    assert_eq!(days[1]["date"], d2);
    assert_eq!(days[2]["date"], d3);
    assert_eq!(days[0]["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(days[1]["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(days[2]["tasks"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn agenda_week_excludes_tasks_beyond_7_days() {
    let (server, _tmp) = setup_server();
    let far_future = (Utc::now().date_naive() + Duration::days(30))
        .format("%Y-%m-%d")
        .to_string();

    server
        .post("/api/vault/pages/far-future.md")
        .json(&serde_json::json!({
            "title": "Far Future",
            "body": format!("- [ ] Far away [due:: {far_future}]\n")
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let res = server.get("/api/vault/agenda/week").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let days = body["days"].as_array().unwrap();
    assert!(days.is_empty(), "expected no days, got: {days:?}");
}

// ---------------------------------------------------------------------------
// GET /agenda/overdue
// ---------------------------------------------------------------------------

#[tokio::test]
async fn agenda_overdue_returns_past_due_incomplete_tasks() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/past-due.md")
        .json(&serde_json::json!({
            "title": "Past Due",
            "body": "- [ ] Should appear [due:: 2020-01-01]\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let res = server.get("/api/vault/agenda/overdue").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "expected 1 overdue task, got: {tasks:?}");
    assert!(tasks[0]["content"]
        .as_str()
        .unwrap()
        .contains("Should appear"));
}

#[tokio::test]
async fn agenda_overdue_excludes_completed() {
    let (server, _tmp) = setup_server();

    // Create overdue task that is already done
    server
        .post("/api/vault/pages/done-overdue.md")
        .json(&serde_json::json!({
            "title": "Done Overdue",
            "body": "- [x] Done task [due:: 2020-01-01]\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let res = server.get("/api/vault/agenda/overdue").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert!(tasks.is_empty(), "completed overdue tasks should not appear, got: {tasks:?}");
}

#[tokio::test]
async fn agenda_overdue_excludes_cancelled() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/cancelled-overdue.md")
        .json(&serde_json::json!({
            "title": "Cancelled Overdue",
            "body": "- [-] Cancelled task [due:: 2020-01-01]\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let res = server.get("/api/vault/agenda/overdue").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert!(
        tasks.is_empty(),
        "cancelled overdue tasks should not appear, got: {tasks:?}"
    );
}

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

#[tokio::test]
async fn agenda_returns_empty_when_no_tasks() {
    let (server, _tmp) = setup_server();

    let res = server.get("/api/vault/agenda/today").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["tasks"].as_array().unwrap().len(), 0);

    let res = server.get("/api/vault/agenda/week").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["days"].as_array().unwrap().len(), 0);

    let res = server.get("/api/vault/agenda/overdue").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["tasks"].as_array().unwrap().len(), 0);
}
