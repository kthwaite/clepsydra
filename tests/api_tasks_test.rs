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

fn setup_server_with_seed(seed: impl FnOnce(&std::path::Path)) -> (TestServer, TempDir) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    seed(&root);

    let vault = Vault::open(&root).unwrap();
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

fn setup_server() -> (TestServer, TempDir) {
    setup_server_with_seed(|_| {})
}

#[tokio::test]
async fn task_history_returns_fourteen_daily_seal_counts_for_the_requested_project() {
    let today = chrono::Utc::now().date_naive();
    let yesterday = today - chrono::Duration::days(1);
    let outside_window = today - chrono::Duration::days(14);
    let (server, _tmp) = setup_server_with_seed(|root| {
        std::fs::create_dir_all(root.join("tasks/alpha")).unwrap();
        std::fs::create_dir_all(root.join("tasks/beta")).unwrap();

        for (path, id, project, status, updated_at) in [
            (
                "tasks/alpha/today.md",
                "01951234-0000-7000-8000-bbb000000001",
                "alpha",
                "SEALED",
                today,
            ),
            (
                "tasks/alpha/yesterday.md",
                "01951234-0000-7000-8000-bbb000000002",
                "alpha",
                "SEALED",
                yesterday,
            ),
            (
                "tasks/alpha/old.md",
                "01951234-0000-7000-8000-bbb000000003",
                "alpha",
                "SEALED",
                outside_window,
            ),
            (
                "tasks/alpha/open.md",
                "01951234-0000-7000-8000-bbb000000004",
                "alpha",
                "FIELD",
                today,
            ),
            (
                "tasks/beta/sealed.md",
                "01951234-0000-7000-8000-bbb000000005",
                "beta",
                "SEALED",
                today,
            ),
        ] {
            let content = format!(
                "---\nid: {id}\ntitle: Telemetry task\ntype: TASK\nproject: {project}\nstatus: {status}\npriority: P2\ncreated_at: {updated_at}T09:00:00Z\nupdated_at: {updated_at}T12:00:00Z\n---\n"
            );
            std::fs::write(root.join(path), content).unwrap();
        }
    });

    let response = server
        .get("/api/vault/tasks/history?days=14&project=alpha")
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    let days = body["days"].as_array().expect("history days");

    assert_eq!(
        days.len(),
        14,
        "history must include every day in the window"
    );
    assert_eq!(days[12]["date"], yesterday.format("%Y-%m-%d").to_string());
    assert_eq!(days[12]["count"], 1);
    assert_eq!(days[13]["date"], today.format("%Y-%m-%d").to_string());
    assert_eq!(days[13]["count"], 1);
    assert_eq!(
        days.iter()
            .map(|day| day["count"].as_u64().unwrap())
            .sum::<u64>(),
        2,
        "old, open, and other-project tasks must not affect the series"
    );
}

#[tokio::test]
async fn task_history_survives_later_edits_and_reopening() {
    let today = chrono::Utc::now().date_naive();
    let sealed_on = today - chrono::Duration::days(1);
    let task_id = "01951234-0000-7000-8000-bbb000000099";
    let (server, _tmp) = setup_server_with_seed(|root| {
        std::fs::create_dir_all(root.join("tasks/alpha")).unwrap();
        std::fs::write(
            root.join("tasks/alpha/sealed.md"),
            format!(
                "---\nid: {task_id}\ntitle: Sealed yesterday\ntype: TASK\nproject: alpha\nstatus: SEALED\npriority: P2\ncreated_at: {}T09:00:00Z\nupdated_at: {sealed_on}T12:00:00Z\n---\n",
                sealed_on - chrono::Duration::days(1)
            ),
        )
        .unwrap();
    });

    server
        .patch(&format!("/api/vault/board/tasks/{task_id}"))
        .json(&serde_json::json!({ "title": "Edited after sealing" }))
        .await
        .assert_status_ok();
    server
        .patch(&format!("/api/vault/board/tasks/{task_id}"))
        .json(&serde_json::json!({ "status": "FIELD" }))
        .await
        .assert_status_ok();

    let response = server
        .get("/api/vault/tasks/history?days=14&project=alpha")
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    let counts: std::collections::HashMap<_, _> = body["days"]
        .as_array()
        .unwrap()
        .iter()
        .map(|day| {
            (
                day["date"].as_str().unwrap().to_string(),
                day["count"].as_u64().unwrap(),
            )
        })
        .collect();

    assert_eq!(counts[&sealed_on.format("%Y-%m-%d").to_string()], 1);
    assert_eq!(counts[&today.format("%Y-%m-%d").to_string()], 0);
}

#[tokio::test]
async fn task_history_unfiled_scope_includes_unknown_and_missing_projects() {
    let today = chrono::Utc::now().date_naive();
    let (server, _tmp) = setup_server_with_seed(|root| {
        std::fs::create_dir_all(root.join("projects")).unwrap();
        std::fs::create_dir_all(root.join("tasks")).unwrap();
        std::fs::write(
            root.join("projects/alpha.md"),
            "---\nid: 01951234-0000-7000-8000-aaa000000099\ntitle: Alpha\ntype: PROJECT\nproject: alpha\nboard: true\n---\n",
        )
        .unwrap();
        for (name, id, project) in [
            (
                "known",
                "01951234-0000-7000-8000-bbb000000091",
                Some("alpha"),
            ),
            (
                "unknown",
                "01951234-0000-7000-8000-bbb000000092",
                Some("orphan"),
            ),
            ("missing", "01951234-0000-7000-8000-bbb000000093", None),
        ] {
            let project_line = project
                .map(|value| format!("project: {value}\n"))
                .unwrap_or_default();
            std::fs::write(
                root.join(format!("tasks/{name}.md")),
                format!(
                    "---\nid: {id}\ntitle: {name}\ntype: TASK\n{project_line}status: SEALED\npriority: P2\ncreated_at: {today}T09:00:00Z\nupdated_at: {today}T09:00:00Z\n---\n"
                ),
            )
            .unwrap();
        }
    });

    let response = server
        .get("/api/vault/tasks/history?days=14&unfiled=true")
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    assert_eq!(body["days"][13]["count"], 2);
}

#[tokio::test]
async fn generic_page_edit_persists_a_manually_observed_seal_time() {
    let today = chrono::Utc::now().date_naive();
    let created_on = today - chrono::Duration::days(2);
    let sealed_on = today - chrono::Duration::days(1);
    let (server, tmp) = setup_server_with_seed(|root| {
        std::fs::create_dir_all(root.join("tasks/alpha")).unwrap();
        std::fs::write(
            root.join("tasks/alpha/manual.md"),
            format!(
                "---\nid: 01951234-0000-7000-8000-bbb000000094\ntitle: Manual task\ntype: TASK\nproject: alpha\nstatus: FIELD\npriority: P2\ncreated_at: {created_on}T09:00:00Z\nupdated_at: {created_on}T09:00:00Z\n---\n"
            ),
        )
        .unwrap();
    });
    let path = tmp.path().join("vault/tasks/alpha/manual.md");
    let manually_sealed = std::fs::read_to_string(&path)
        .unwrap()
        .replace("status: FIELD", "status: SEALED")
        .replace(
            &format!("updated_at: {created_on}T09:00:00Z"),
            &format!("updated_at: {sealed_on}T12:00:00Z"),
        );
    std::fs::write(&path, manually_sealed).unwrap();

    let current = server.get("/api/vault/pages/tasks/alpha/manual.md").await;
    current.assert_status_ok();
    let current: serde_json::Value = current.json();
    let property_edit = server
        .patch("/api/vault/pages/by-id/01951234-0000-7000-8000-bbb000000094/properties")
        .json(&serde_json::json!({
            "set": { "note": "Edited after manual seal" },
            "expected_revision": current["revision"]
        }))
        .await;
    property_edit.assert_status_ok();
    let property_edit: serde_json::Value = property_edit.json();
    server
        .put("/api/vault/pages/tasks/alpha/manual.md")
        .json(&serde_json::json!({
            "title": "Edited after manual seal",
            "expected_revision": property_edit["revision"]
        }))
        .await
        .assert_status_ok();

    let response = server
        .get("/api/vault/tasks/history?days=14&project=alpha")
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    let counts: std::collections::HashMap<_, _> = body["days"]
        .as_array()
        .unwrap()
        .iter()
        .map(|day| {
            (
                day["date"].as_str().unwrap().to_string(),
                day["count"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(counts[&sealed_on.format("%Y-%m-%d").to_string()], 1);
    assert_eq!(counts[&today.format("%Y-%m-%d").to_string()], 0);

    let persisted = std::fs::read_to_string(path).unwrap();
    assert!(persisted.contains("task_history"));
    assert!(persisted.contains(&format!("{sealed_on}T12:00:00+00:00")));
}

#[tokio::test]
async fn property_edit_heals_task_history_when_legacy_timestamps_are_missing() {
    let task_id = "01951234-0000-7000-8000-bbb000000095";
    let (server, tmp) = setup_server_with_seed(|root| {
        std::fs::create_dir_all(root.join("tasks")).unwrap();
        std::fs::write(
            root.join("tasks/no-time.md"),
            format!(
                "---\nid: {task_id}\ntitle: No timestamps\ntype: TASK\nstatus: FIELD\npriority: P2\n---\n"
            ),
        )
        .unwrap();
    });
    let current: serde_json::Value = server.get("/api/vault/pages/tasks/no-time.md").await.json();

    server
        .patch(&format!("/api/vault/pages/by-id/{task_id}/properties"))
        .json(&serde_json::json!({
            "set": { "note": "still mutable" },
            "expected_revision": current["revision"]
        }))
        .await
        .assert_status_ok();

    let persisted = std::fs::read_to_string(tmp.path().join("vault/tasks/no-time.md")).unwrap();
    assert!(persisted.contains("note = \"still mutable\""));
    assert!(persisted.contains("task_history"));
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
    let res = server.get("/api/vault/tasks?due_before=2026-03-01").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(
        tasks.len(),
        1,
        "expected 1 task due before March, got: {tasks:?}"
    );
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
    assert!(
        tasks[0]["content"]
            .as_str()
            .unwrap()
            .contains("Undated task")
    );
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
    assert!(
        tasks[0]["page_path"]
            .as_str()
            .unwrap()
            .starts_with("journals/")
    );
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
    assert!(
        tasks[0]["content"]
            .as_str()
            .unwrap()
            .contains("High priority")
    );
}

#[tokio::test]
async fn sort_tasks_for_atrium_agenda() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/z-agenda-ties.md")
        .json(&serde_json::json!({
            "title": "Z Agenda Ties",
            "body": "- [ ] Same-date B in z [due:: 2026-09-01] [priority:: B]\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    server
        .post("/api/vault/pages/a-agenda-ties.md")
        .json(&serde_json::json!({
            "title": "A Agenda Ties",
            "body": "\
- [ ] Same-date B first in a [due:: 2026-09-01] [priority:: B]\n\
- [ ] Same-date B second in a [due:: 2026-09-01] [priority:: B]\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    server
        .post("/api/vault/pages/atrium-agenda.md")
        .json(&serde_json::json!({
            "title": "Atrium Agenda",
            "body": "\
- [ ] Same-date C [due:: 2026-09-01] [priority:: C]\n\
- [ ] Overdue A later [due:: 2025-01-02] [priority:: A]\n\
- [x] Completed earliest [due:: 2024-01-01] [priority:: A]\n\
- [ ] Undated C [priority:: C]\n\
- [ ] Overdue B earlier [due:: 2025-01-01] [priority:: B]\n\
- [ ] Undated A [priority:: A]\n\
- [ ] Same-date unknown [due:: 2026-09-01] [priority:: Z]\n\
- [ ] Same-date A [due:: 2026-09-01] [priority:: A]\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let res = server
        .get("/api/vault/tasks?status=todo&sort=agenda&limit=8")
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    let ordered_tasks: Vec<(&str, &str)> = tasks
        .iter()
        .map(|task| {
            (
                task["page_path"].as_str().unwrap(),
                task["content"].as_str().unwrap(),
            )
        })
        .collect();

    assert_eq!(
        ordered_tasks,
        vec![
            ("atrium-agenda.md", "Overdue B earlier"),
            ("atrium-agenda.md", "Overdue A later"),
            ("atrium-agenda.md", "Same-date A"),
            ("a-agenda-ties.md", "Same-date B first in a"),
            ("a-agenda-ties.md", "Same-date B second in a"),
            ("z-agenda-ties.md", "Same-date B in z"),
            ("atrium-agenda.md", "Same-date C"),
            ("atrium-agenda.md", "Same-date unknown"),
        ]
    );
    assert_eq!(tasks.len(), 8);
    assert_eq!(body["total"], 10);
    assert!(
        tasks
            .iter()
            .all(|task| task["content"] != "Completed earliest"),
        "completed tasks must be excluded from the Atrium agenda"
    );
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

#[tokio::test]
async fn concurrent_status_updates_on_one_page_preserve_both_tasks() {
    let (server, _tmp) = setup_server();
    server
        .post("/api/vault/pages/concurrent-status.md")
        .json(&serde_json::json!({
            "title": "Concurrent",
            "body": "- [ ] First\n- [ ] Second\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let tasks: serde_json::Value = server
        .get("/api/vault/tasks?page=concurrent-status.md")
        .await
        .json();
    let spans: Vec<i64> = tasks["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|task| task["span_start"].as_i64().unwrap())
        .collect();

    let first = server
        .put("/api/vault/tasks/status")
        .json(&serde_json::json!({
            "page_path": "concurrent-status.md",
            "span_start": spans[0],
            "status": "done"
        }));
    let second = server
        .put("/api/vault/tasks/status")
        .json(&serde_json::json!({
            "page_path": "concurrent-status.md",
            "span_start": spans[1],
            "status": "cancelled"
        }));
    let (first, second) = tokio::join!(first, second);
    assert!(
        first.status_code().is_success() || first.status_code() == axum::http::StatusCode::CONFLICT
    );
    assert!(
        second.status_code().is_success()
            || second.status_code() == axum::http::StatusCode::CONFLICT
    );

    let page: serde_json::Value = server
        .get("/api/vault/pages/concurrent-status.md")
        .await
        .json();
    let body = page["body"].as_str().unwrap();
    if first.status_code().is_success() {
        assert!(body.contains("- [x] First"), "{body}");
    }
    if second.status_code().is_success() {
        assert!(body.contains("- [-] Second"), "{body}");
    }
}
