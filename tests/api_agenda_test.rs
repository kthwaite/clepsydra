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

fn setup_server_with_seed(seed: impl FnOnce(&std::path::Path)) -> (TestServer, TempDir) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    seed(&root);

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
    let state = Arc::new(AppState {
        started_at: std::time::Instant::now(),
        features: clepsydra::FeatureFlags::default(),
        clock: Arc::new(clepsydra::api::SystemClock),
        vault,
        rubbish,
        index: index_handle,
        cas: Arc::new(parking_lot::Mutex::new(cas)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: production_hooks(),
        delete_hooks: Arc::new(vec![]),
        mutation_coordinator: clepsydra::vault::mutation_coordinator::MutationCoordinator::new(),
        feed_runtime: Some(
            clepsydra::feeds::runtime::FeedRuntime::open(
                &root,
                &clepsydra::FeedsSettings::default(),
            )
            .unwrap(),
        ),
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

fn setup_server() -> (TestServer, TempDir) {
    setup_server_with_seed(|_| {})
}

#[tokio::test]
async fn cycle_burndown_uses_cycle_dates_and_sealed_task_timestamps() {
    let today = Utc::now().date_naive();
    let start = today - Duration::days(3);
    let first_seal = today - Duration::days(2);
    let (server, _tmp) = setup_server_with_seed(|root| {
        std::fs::create_dir_all(root.join("cycles")).unwrap();
        std::fs::create_dir_all(root.join("tasks/alpha")).unwrap();
        std::fs::write(
            root.join("cycles/C-01.md"),
            format!(
                "---\nid: 01951234-0000-7000-8000-aaa000000001\ntitle: Cycle 01\ntype: CYCLE\nstate: ACTIVE\nstart: {start}\nend: {}\n---\n",
                today + Duration::days(3)
            ),
        )
        .unwrap();

        for (path, id, status, updated_at) in [
            (
                "tasks/alpha/first.md",
                "01951234-0000-7000-8000-bbb000000001",
                "SEALED",
                first_seal,
            ),
            (
                "tasks/alpha/second.md",
                "01951234-0000-7000-8000-bbb000000002",
                "SEALED",
                today,
            ),
            (
                "tasks/alpha/open.md",
                "01951234-0000-7000-8000-bbb000000003",
                "FIELD",
                today,
            ),
        ] {
            std::fs::write(
                root.join(path),
                format!(
                    "---\nid: {id}\ntitle: Cycle task\ntype: TASK\nproject: alpha\nstatus: {status}\npriority: P2\ncycle: C-01\ncreated_at: {start}T09:00:00Z\nupdated_at: {updated_at}T12:00:00Z\n---\n"
                ),
            )
            .unwrap();
        }
    });

    let response = server
        .get("/api/vault/agenda/cycle-burndown?cycle=C-01&project=alpha")
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert_eq!(body["cycle"], "C-01");
    assert_eq!(
        body["points"],
        serde_json::json!([
            { "date": start.format("%Y-%m-%d").to_string(), "remaining": 3 },
            { "date": (start + Duration::days(1)).format("%Y-%m-%d").to_string(), "remaining": 2 },
            { "date": (start + Duration::days(2)).format("%Y-%m-%d").to_string(), "remaining": 2 },
            { "date": today.format("%Y-%m-%d").to_string(), "remaining": 1 }
        ])
    );
}

#[tokio::test]
async fn cycle_burndown_uses_event_time_membership_and_status() {
    let today = Utc::now().date_naive();
    let start = today - Duration::days(3);
    let day_one = start + Duration::days(1);
    let day_two = start + Duration::days(2);
    let (server, _tmp) = setup_server_with_seed(|root| {
        std::fs::create_dir_all(root.join("cycles")).unwrap();
        std::fs::create_dir_all(root.join("tasks/alpha")).unwrap();
        std::fs::write(
            root.join("cycles/C-01.md"),
            format!(
                "+++\nid = \"01951234-0000-7000-8000-aaa000000011\"\ntitle = \"Cycle 01\"\ntype = \"CYCLE\"\nstate = \"ACTIVE\"\nstart = \"{start}\"\nend = \"{today}\"\n+++\n"
            ),
        )
        .unwrap();
        std::fs::write(
            root.join("tasks/alpha/first.md"),
            format!(
                "+++\nid = \"01951234-0000-7000-8000-bbb000000011\"\ntitle = \"First task\"\ntype = \"TASK\"\nproject = \"alpha\"\nstatus = \"SEALED\"\npriority = \"P2\"\ncycle = \"C-01\"\ncreated_at = {start}T09:00:00Z\nupdated_at = {day_one}T12:00:00Z\ntask_history = [{{ at = \"{start}T09:00:00Z\", status = \"FIELD\", cycle = \"C-01\", project = \"alpha\" }}, {{ at = \"{day_one}T12:00:00Z\", status = \"SEALED\", cycle = \"C-01\", project = \"alpha\" }}]\n+++\n"
            ),
        )
        .unwrap();
        std::fs::write(
            root.join("tasks/alpha/carried.md"),
            format!(
                "+++\nid = \"01951234-0000-7000-8000-bbb000000012\"\ntitle = \"Late carried task\"\ntype = \"TASK\"\nproject = \"alpha\"\nstatus = \"FIELD\"\npriority = \"P2\"\ncycle = \"C-02\"\ncreated_at = {day_two}T09:00:00Z\nupdated_at = {today}T12:00:00Z\ntask_history = [{{ at = \"{day_two}T09:00:00Z\", status = \"FIELD\", cycle = \"C-01\", project = \"alpha\" }}, {{ at = \"{today}T12:00:00Z\", status = \"FIELD\", cycle = \"C-02\", project = \"alpha\" }}]\n+++\n"
            ),
        )
        .unwrap();
    });

    let response = server
        .get("/api/vault/agenda/cycle-burndown?cycle=C-01&project=alpha")
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    assert_eq!(
        body["points"],
        serde_json::json!([
            { "date": start.format("%Y-%m-%d").to_string(), "remaining": 1 },
            { "date": day_one.format("%Y-%m-%d").to_string(), "remaining": 0 },
            { "date": day_two.format("%Y-%m-%d").to_string(), "remaining": 1 },
            { "date": today.format("%Y-%m-%d").to_string(), "remaining": 0 }
        ])
    );
}

#[tokio::test]
async fn cycle_burndown_rejects_unbounded_date_ranges() {
    let (server, _tmp) = setup_server_with_seed(|root| {
        std::fs::create_dir_all(root.join("cycles")).unwrap();
        std::fs::write(
            root.join("cycles/C-LONG.md"),
            "+++\nid = \"01951234-0000-7000-8000-aaa000000012\"\ntitle = \"Long cycle\"\ntype = \"CYCLE\"\nstate = \"ACTIVE\"\nstart = \"2020-01-01\"\nend = \"2026-01-01\"\n+++\n",
        )
        .unwrap();
    });

    server
        .get("/api/vault/agenda/cycle-burndown?cycle=C-LONG")
        .await
        .assert_status(axum::http::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn cycle_burndown_preserves_membership_after_api_carryover() {
    let today = Utc::now().date_naive();
    let start = today - Duration::days(1);
    let cycle_id = "01951234-0000-7000-8000-aaa000000013";
    let (server, _tmp) = setup_server_with_seed(|root| {
        std::fs::create_dir_all(root.join("cycles")).unwrap();
        std::fs::create_dir_all(root.join("tasks/alpha")).unwrap();
        std::fs::write(
            root.join("cycles/C-01.md"),
            format!(
                "---\nid: {cycle_id}\ntitle: Cycle 01\ntype: CYCLE\nstate: ACTIVE\nstart: {start}\nend: {today}\n---\n"
            ),
        )
        .unwrap();
        std::fs::write(
            root.join("tasks/alpha/open.md"),
            format!(
                "---\nid: 01951234-0000-7000-8000-bbb000000013\ntitle: Open task\ntype: TASK\nproject: alpha\nstatus: FIELD\npriority: P2\ncycle: C-01\ncreated_at: {start}T09:00:00Z\nupdated_at: {start}T09:00:00Z\n---\n"
            ),
        )
        .unwrap();
    });

    server
        .patch(&format!("/api/vault/board/cycles/{cycle_id}"))
        .json(&serde_json::json!({ "state": "CLOSED", "carry_to": "BACKLOG" }))
        .await
        .assert_status_ok();

    let response = server
        .get("/api/vault/agenda/cycle-burndown?cycle=C-01&project=alpha")
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    assert_eq!(
        body["points"],
        serde_json::json!([
            { "date": start.format("%Y-%m-%d").to_string(), "remaining": 1 },
            { "date": today.format("%Y-%m-%d").to_string(), "remaining": 0 }
        ])
    );
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
    assert_eq!(
        tasks.len(),
        1,
        "expected 1 scheduled-today task, got: {tasks:?}"
    );
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
    assert!(
        tasks[0]["content"]
            .as_str()
            .unwrap()
            .contains("Overdue task")
    );
}

#[tokio::test]
async fn agenda_today_includes_journal_tasks() {
    let (server, _tmp) = setup_server();

    // Create today's journal with an incomplete task (no due date)
    server.post("/api/vault/journal/today").await;
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
    assert!(
        tasks[0]["content"]
            .as_str()
            .unwrap()
            .contains("Journal task without due date")
    );
}

#[tokio::test]
async fn agenda_today_deduplicates() {
    let (server, _tmp) = setup_server();
    let today = today_str();

    // Create today's journal with a task that is also due today.
    // This matches BOTH the journal_date condition and the due condition,
    // but should appear only once.
    server.post("/api/vault/journal/today").await;
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
    assert!(
        tasks[0]["content"]
            .as_str()
            .unwrap()
            .contains("Should appear")
    );
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
    assert!(
        tasks.is_empty(),
        "completed overdue tasks should not appear, got: {tasks:?}"
    );
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
