use std::sync::Arc;

use axum::Router;
use axum_test::TestServer;
use chrono::{Duration, Utc};
use tokio::sync::broadcast;

use clepsydra::api::{api_router, AppState};
use clepsydra::vault::academic_hook::AcademicMoveHook;
use clepsydra::vault::cas::ContentStore;
use clepsydra::vault::hooks::PostMoveHook;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::index_handle::IndexHandle;
use clepsydra::vault::init::init_vault;
use clepsydra::vault::Vault;
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

const TODAY: &str = "2026-08-26";

async fn get_agenda(server: &TestServer) -> serde_json::Value {
    let response = server
        .get(&format!("/api/vault/agenda?today={TODAY}"))
        .await;
    response.assert_status_ok();
    response.json()
}

#[tokio::test]
async fn agenda_rejects_missing_malformed_and_impossible_today() {
    let (server, _tmp) = setup_server();
    server
        .get("/api/vault/agenda")
        .await
        .assert_status_bad_request();
    server
        .get("/api/vault/agenda?today=26-08-2026")
        .await
        .assert_status_bad_request();
    server
        .get("/api/vault/agenda?today=2026-8-6")
        .await
        .assert_status_bad_request();
    server
        .get("/api/vault/agenda?today=2026-02-30")
        .await
        .assert_status_bad_request();
}

#[tokio::test]
async fn agenda_rejects_extended_upper_bound_without_panicking() {
    let (server, _tmp) = setup_server();
    server
        .get("/api/vault/agenda?today=%2B262142-12-31")
        .await
        .assert_status_bad_request();
}

#[tokio::test]
async fn agenda_classifies_each_open_todo_once() {
    let (server, _tmp) = setup_server();
    server
        .post("/api/vault/pages/agenda-fixture.md")
        .json(&serde_json::json!({
            "title": "Agenda fixture",
            "body": "- [ ] overdue scheduled today [due:: 2026-08-25] [scheduled:: 2026-08-26]\n\
                     - [ ] due today [due:: 2026-08-26]\n\
                     - [ ] due tomorrow [due:: 2026-08-27]\n\
                     - [ ] due at boundary [due:: 2026-09-02]\n\
                     - [ ] beyond boundary [due:: 2026-09-03]\n\
                     - [ ] undated [scheduled:: 2026-09-01]\n\
                     - [x] completed [due:: 2026-08-26]\n\
                     - [-] cancelled [due:: 2026-08-26]\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let body = get_agenda(&server).await;
    assert_eq!(body["overdue"].as_array().unwrap().len(), 1);
    assert_eq!(body["today"].as_array().unwrap().len(), 1);
    assert_eq!(body["upcoming"].as_array().unwrap().len(), 2);
    assert_eq!(body["upcoming"][0]["date"], "2026-08-27");
    assert_eq!(body["upcoming"][1]["date"], "2026-09-02");
    assert_eq!(body["undated"].as_array().unwrap().len(), 1);

    let all_items = body["overdue"]
        .as_array()
        .unwrap()
        .iter()
        .chain(body["today"].as_array().unwrap())
        .chain(
            body["upcoming"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|day| day["items"].as_array().unwrap()),
        )
        .chain(body["undated"].as_array().unwrap())
        .collect::<Vec<_>>();
    let all_content = all_items
        .iter()
        .map(|item| item["content"].as_str().unwrap())
        .collect::<Vec<_>>();

    assert!(all_items
        .iter()
        .all(|item| item["kind"].as_str() == Some("todo")));
    assert_eq!(
        all_content
            .iter()
            .filter(|content| content.contains("overdue scheduled today"))
            .count(),
        1
    );
    assert!(!all_content
        .iter()
        .any(|content| content.contains("beyond boundary")));
    assert!(!all_content
        .iter()
        .any(|content| content.contains("completed")));
    assert!(!all_content
        .iter()
        .any(|content| content.contains("cancelled")));
}

#[tokio::test]
async fn agenda_includes_scheduled_today_and_today_journal_todos() {
    let (server, _tmp) = setup_server();
    server
        .post("/api/vault/pages/scheduled.md")
        .json(&serde_json::json!({
            "title": "Scheduled",
            "body": "- [ ] scheduled today [scheduled:: 2026-08-26]\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);
    server
        .post("/api/vault/pages/journals/2026-08-26.md")
        .json(&serde_json::json!({
            "title": "2026-08-26",
            "body": "- [ ] journal todo without dates\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let body = get_agenda(&server).await;
    let content = body["today"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["content"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(content.len(), 2);
    assert!(content
        .iter()
        .any(|value| value.contains("scheduled today")));
    assert!(content
        .iter()
        .any(|value| value.contains("journal todo without dates")));
}

#[tokio::test]
async fn agenda_orders_todos_by_date_priority_path_and_span() {
    let (server, _tmp) = setup_server();
    server
        .post("/api/vault/pages/zeta.md")
        .json(&serde_json::json!({
            "title": "Zeta",
            "body": "- [ ] later overdue [due:: 2026-08-25] [priority:: A]\n\
                     - [ ] second same-day todo [due:: 2026-08-27] [priority:: B]\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);
    server
        .post("/api/vault/pages/alpha.md")
        .json(&serde_json::json!({
            "title": "Alpha",
            "body": "- [ ] earlier overdue [due:: 2026-08-24] [priority:: C]\n\
                     - [ ] first same-day todo [due:: 2026-08-27] [priority:: A]\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let body = get_agenda(&server).await;
    let overdue = body["overdue"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["content"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(overdue[0].contains("earlier overdue"));
    assert!(overdue[1].contains("later overdue"));

    let upcoming = body["upcoming"][0]["items"].as_array().unwrap();
    assert!(upcoming[0]["content"]
        .as_str()
        .unwrap()
        .contains("first same-day todo"));
    assert!(upcoming[1]["content"]
        .as_str()
        .unwrap()
        .contains("second same-day todo"));
}

#[tokio::test]
async fn agenda_includes_only_dated_not_done_tasks() {
    let (server, _tmp) = setup_server_with_seed(|root| {
        std::fs::create_dir_all(root.join("tasks/clepsydra")).unwrap();
        std::fs::write(
            root.join("tasks/clepsydra/TSK-0200.md"),
            "+++\nid = \"01900000-0000-7000-8000-000000000200\"\ntitle = \"Overdue Task\"\ntype = \"TASK\"\nstatus = \"FIELD\"\npriority = \"P1\"\nproject = \"clepsydra\"\ndue = \"2026-08-25\"\nhold = \"Waiting for input\"\n+++\n",
        )
        .unwrap();
        std::fs::write(
            root.join("tasks/clepsydra/TSK-0201.md"),
            "+++\nid = \"01900000-0000-7000-8000-000000000201\"\ntitle = \"Done Task\"\ntype = \"TASK\"\nstatus = \"SEALED\"\npriority = \"P2\"\nproject = \"clepsydra\"\ndue = \"2026-08-26\"\n+++\n",
        )
        .unwrap();
        std::fs::write(
            root.join("tasks/clepsydra/TSK-0202.md"),
            "+++\nid = \"01900000-0000-7000-8000-000000000202\"\ntitle = \"Undated Task\"\ntype = \"TASK\"\nstatus = \"TRIAGE\"\npriority = \"P2\"\nproject = \"clepsydra\"\n+++\n",
        )
        .unwrap();
    });

    let body = get_agenda(&server).await;
    let overdue = body["overdue"].as_array().unwrap();
    assert_eq!(overdue.len(), 1);
    assert_eq!(overdue[0]["kind"], "task");
    assert_eq!(overdue[0]["id"], "01900000-0000-7000-8000-000000000200");
    assert_eq!(overdue[0]["code"], "TSK-0200");
    assert_eq!(overdue[0]["title"], "Overdue Task");
    assert_eq!(overdue[0]["status"], "FIELD");
    assert_eq!(overdue[0]["priority"], "P1");
    assert_eq!(overdue[0]["project"], "clepsydra");
    assert_eq!(overdue[0]["due"], "2026-08-25");
    assert_eq!(overdue[0]["hold"], "Waiting for input");
    assert_eq!(overdue[0]["path"], "tasks/clepsydra/TSK-0200.md");
    assert!(body["today"].as_array().unwrap().is_empty());
    assert!(body["undated"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn agenda_orders_mixed_sources_by_priority() {
    let (server, _tmp) = setup_server_with_seed(|root| {
        std::fs::create_dir_all(root.join("tasks/clepsydra")).unwrap();
        std::fs::write(
            root.join("tasks/clepsydra/TSK-0210.md"),
            "+++\nid = \"01900000-0000-7000-8000-000000000210\"\ntitle = \"First Task\"\ntype = \"TASK\"\nstatus = \"FIELD\"\npriority = \"P1\"\nproject = \"clepsydra\"\ndue = \"2026-08-26\"\n+++\n",
        )
        .unwrap();
    });
    server
        .post("/api/vault/pages/alpha.md")
        .json(&serde_json::json!({
            "title": "Alpha",
            "body": "- [ ] Second Todo [due:: 2026-08-26] [priority:: P2]\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let body = get_agenda(&server).await;
    let today = body["today"].as_array().unwrap();
    assert_eq!(today.len(), 2);
    assert_eq!(today[0]["kind"], "task");
    assert_eq!(today[0]["code"], "TSK-0210");
    assert_eq!(today[1]["kind"], "todo");
    assert!(today[1]["content"]
        .as_str()
        .unwrap()
        .contains("Second Todo"));
}

#[tokio::test]
async fn agenda_includes_tasks_through_seven_day_boundary() {
    let (server, _tmp) = setup_server_with_seed(|root| {
        std::fs::create_dir_all(root.join("tasks/clepsydra")).unwrap();
        std::fs::write(
            root.join("tasks/clepsydra/TSK-0220.md"),
            "+++\nid = \"01900000-0000-7000-8000-000000000220\"\ntitle = \"Boundary Task\"\ntype = \"TASK\"\nstatus = \"TRIAGE\"\npriority = \"P2\"\nproject = \"clepsydra\"\ndue = \"2026-09-02\"\n+++\n",
        )
        .unwrap();
        std::fs::write(
            root.join("tasks/clepsydra/TSK-0221.md"),
            "+++\nid = \"01900000-0000-7000-8000-000000000221\"\ntitle = \"Beyond Task\"\ntype = \"TASK\"\nstatus = \"TRIAGE\"\npriority = \"P2\"\nproject = \"clepsydra\"\ndue = \"2026-09-03\"\n+++\n",
        )
        .unwrap();
    });

    let body = get_agenda(&server).await;
    assert_eq!(body["upcoming"].as_array().unwrap().len(), 1);
    assert_eq!(body["upcoming"][0]["date"], "2026-09-02");
    let items = body["upcoming"][0]["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["code"], "TSK-0220");
}

#[tokio::test]
async fn agenda_returns_empty_classified_response() {
    let (server, _tmp) = setup_server();
    let body = get_agenda(&server).await;

    assert_eq!(
        body,
        serde_json::json!({
            "overdue": [],
            "today": [],
            "upcoming": [],
            "undated": []
        })
    );
}
