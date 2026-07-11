use std::path::Path;
use std::sync::Arc;

use axum::Router;
use axum_test::TestServer;
use tokio::sync::broadcast;

use clepsydra::api::events::SyncNotification;
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

fn setup_server_with(pre_index: impl FnOnce(&Path)) -> (TestServer, TempDir) {
    let (server, tmp, _) = setup_server_with_state(pre_index);
    (server, tmp)
}

fn setup_server_with_state(pre_index: impl FnOnce(&Path)) -> (TestServer, TempDir, Arc<AppState>) {
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
        .with_state(Arc::clone(&state));

    let server = TestServer::new(app).unwrap();
    (server, tmp, state)
}

#[tokio::test]
async fn mutation_creates_emit_coordinator_notifications() {
    let (server, _tmp, state) = setup_server_with_state(|_| {});
    let mut changes = state.change_tx.subscribe();

    server
        .post("/api/vault/board/tasks")
        .json(&serde_json::json!({ "title": "notified task" }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);
    let SyncNotification::IndexChanged { upserted, removed } = changes.recv().await.unwrap();
    assert_eq!(upserted.len(), 1);
    assert!(upserted[0].starts_with("tasks/TSK-"));
    assert!(removed.is_empty());

    server
        .post("/api/vault/board/cycles")
        .json(&serde_json::json!({
            "label": "notified cycle",
            "start": "2026-07-13",
            "end": "2026-07-19"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);
    let SyncNotification::IndexChanged { upserted, removed } = changes.recv().await.unwrap();
    assert_eq!(upserted.len(), 1);
    assert!(upserted[0].starts_with("cycles/S-"));
    assert!(removed.is_empty());
}

// ---------------------------------------------------------------------------
// Main aggregation test
// ---------------------------------------------------------------------------

#[tokio::test]
async fn board_aggregates_operations_cycles_tasks() {
    let (server, _tmp) = setup_server_with(|root| {
        // projects/op-sig3.md: PROJECT with board: true
        std::fs::create_dir_all(root.join("projects")).unwrap();
        std::fs::write(
            root.join("projects/op-sig3.md"),
            "---\nid: 01951234-0000-7000-8000-000000000001\n\
             title: SIGNAL-3 MIGRATION\ntype: PROJECT\nproject: op-sig3\n\
             board: true\nhealth: AMBER\nlead: \"0xC1\"\ntarget: W17\n---\n",
        )
        .unwrap();

        // cycles/S-13.md: CYCLE with state ACTIVE
        std::fs::create_dir_all(root.join("cycles")).unwrap();
        std::fs::write(
            root.join("cycles/S-13.md"),
            "---\nid: 01951234-0000-7000-8000-000000000002\n\
             title: CYCLE 13\ntype: CYCLE\nstate: ACTIVE\n\
             start: \"2026-04-13\"\nend: \"2026-04-19\"\ngoal: freeze\n---\n",
        )
        .unwrap();

        // tasks/op-sig3/TSK-0481.md: TASK with checks
        std::fs::create_dir_all(root.join("tasks/op-sig3")).unwrap();
        std::fs::write(
            root.join("tasks/op-sig3/TSK-0481.md"),
            "---\nid: 01951234-0000-7000-8000-000000000003\n\
             title: FREEZE LEGACY SYNC WRITES\ntype: TASK\nproject: op-sig3\n\
             status: FIELD\npriority: P0\ncycle: S-13\nassignee: \"0xC1\"\n\
             due: \"2026-04-21\"\n---\n\
             - [x] a\n- [x] b\n- [ ] c\n",
        )
        .unwrap();
    });

    let res = server.get("/api/vault/board").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();

    // --- columns ---
    let columns = body["columns"].as_array().unwrap();
    assert_eq!(columns.len(), 5, "expected 5 columns, got: {columns:?}");
    assert_eq!(columns[0]["id"], "INTAKE");
    assert_eq!(columns[0]["label"], "INTAKE");
    assert_eq!(columns[0]["sub"], "unfiled");
    assert_eq!(columns[0]["wip"], 0);
    assert_eq!(columns[2]["id"], "FIELD");
    assert_eq!(columns[2]["label"], "IN-FIELD");
    assert_eq!(columns[2]["sub"], "active");
    assert_eq!(columns[2]["wip"], 4);
    assert_eq!(columns[4]["id"], "SEALED");
    assert_eq!(columns[4]["sub"], "closed");

    // --- operations ---
    let ops = body["operations"].as_array().unwrap();
    assert_eq!(ops.len(), 1, "expected 1 operation, got: {ops:?}");
    assert_eq!(ops[0]["code"], "OP-SIG3");
    assert_eq!(ops[0]["name"], "SIGNAL-3 MIGRATION");
    assert_eq!(ops[0]["health"], "AMBER");

    // --- cycles ---
    let cycles = body["cycles"].as_array().unwrap();
    assert_eq!(cycles.len(), 1, "expected 1 cycle, got: {cycles:?}");
    assert_eq!(cycles[0]["code"], "S-13");
    assert_eq!(cycles[0]["state"], "ACTIVE");

    // --- tasks ---
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "expected 1 task, got: {tasks:?}");
    assert_eq!(tasks[0]["code"], "TSK-0481");
    assert_eq!(tasks[0]["status"], "FIELD");
    assert_eq!(tasks[0]["priority"], "P0");
    let checks = tasks[0]["checks"].as_array().unwrap();
    assert_eq!(checks[0], 2, "done count should be 2");
    assert_eq!(checks[1], 3, "total count should be 3");
}

#[tokio::test]
async fn checklist_counts_preserve_checkbox_semantics_across_tasks() {
    let (server, _tmp) = setup_server_with(|root| {
        std::fs::create_dir_all(root.join("tasks")).unwrap();

        for (name, id, body) in [
            ("TSK-0001", "01951234-0000-7000-8000-000000000101", ""),
            (
                "TSK-0002",
                "01951234-0000-7000-8000-000000000102",
                "- [ ] todo\n",
            ),
            (
                "TSK-0003",
                "01951234-0000-7000-8000-000000000103",
                "- [x] done\n",
            ),
            (
                "TSK-0004",
                "01951234-0000-7000-8000-000000000104",
                "- [-] cancelled\n",
            ),
        ] {
            std::fs::write(
                root.join(format!("tasks/{name}.md")),
                format!("---\nid: {id}\ntitle: {name}\ntype: TASK\n---\n{body}"),
            )
            .unwrap();
        }
    });

    let response = server.get("/api/vault/board").await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    let tasks = body["tasks"].as_array().unwrap();

    let counts_for = |code: &str| {
        tasks
            .iter()
            .find(|task| task["code"] == code)
            .unwrap_or_else(|| panic!("{code} missing from board response: {tasks:?}"))["checks"]
            .clone()
    };

    assert_eq!(counts_for("TSK-0001"), serde_json::json!([0, 0]));
    assert_eq!(counts_for("TSK-0002"), serde_json::json!([0, 1]));
    assert_eq!(counts_for("TSK-0003"), serde_json::json!([1, 1]));
    assert_eq!(counts_for("TSK-0004"), serde_json::json!([0, 1]));
}

// ---------------------------------------------------------------------------
// PROJECT without board: true is excluded
// ---------------------------------------------------------------------------

#[tokio::test]
async fn project_without_board_flag_excluded() {
    let (server, _tmp) = setup_server_with(|root| {
        std::fs::create_dir_all(root.join("projects")).unwrap();
        // board: false — must not appear
        std::fs::write(
            root.join("projects/hidden.md"),
            "---\nid: 01951234-0000-7000-8000-000000000010\n\
             title: Hidden Op\ntype: PROJECT\nboard: false\n---\n",
        )
        .unwrap();
        // no board key at all — must not appear
        std::fs::write(
            root.join("projects/no-board.md"),
            "---\nid: 01951234-0000-7000-8000-000000000011\n\
             title: No Board Op\ntype: PROJECT\n---\n",
        )
        .unwrap();
    });

    let res = server.get("/api/vault/board").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let ops = body["operations"].as_array().unwrap();
    assert!(
        ops.is_empty(),
        "expected no operations when board: true absent, got: {ops:?}"
    );
}

// ---------------------------------------------------------------------------
// TASK with no project: field still appears with project: null
// ---------------------------------------------------------------------------

#[tokio::test]
async fn task_without_project_has_null_project() {
    let (server, _tmp) = setup_server_with(|root| {
        std::fs::create_dir_all(root.join("tasks")).unwrap();
        std::fs::write(
            root.join("tasks/TSK-0001.md"),
            "---\nid: 01951234-0000-7000-8000-000000000020\n\
             title: Orphan Task\ntype: TASK\n---\n",
        )
        .unwrap();
    });

    let res = server.get("/api/vault/board").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "expected 1 task, got: {tasks:?}");
    assert_eq!(tasks[0]["code"], "TSK-0001");
    assert!(
        tasks[0]["project"].is_null(),
        "expected project to be null, got: {}",
        tasks[0]["project"]
    );
}

// ---------------------------------------------------------------------------
// TASK link with wikilink alias strips brackets AND display text
// ---------------------------------------------------------------------------

#[tokio::test]
async fn task_link_wikilink_alias_keeps_target_only() {
    let (server, _tmp) = setup_server_with(|root| {
        std::fs::create_dir_all(root.join("tasks")).unwrap();
        std::fs::write(
            root.join("tasks/TSK-0003.md"),
            "---\nid: 01951234-0000-7000-8000-000000000040\n\
             title: Aliased Link Task\ntype: TASK\n\
             link: \"[[CLP-0901-J|the dossier]]\"\n---\n",
        )
        .unwrap();
    });

    let res = server.get("/api/vault/board").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "expected 1 task, got: {tasks:?}");
    assert_eq!(
        tasks[0]["link"], "CLP-0901-J",
        "expected aliased wikilink to yield target only, got: {}",
        tasks[0]["link"]
    );
}

// ---------------------------------------------------------------------------
// TASK with no status/priority defaults to INTAKE/P2
// ---------------------------------------------------------------------------

#[tokio::test]
async fn task_without_status_priority_defaults() {
    let (server, _tmp) = setup_server_with(|root| {
        std::fs::create_dir_all(root.join("tasks")).unwrap();
        std::fs::write(
            root.join("tasks/TSK-0002.md"),
            "---\nid: 01951234-0000-7000-8000-000000000030\n\
             title: Default Task\ntype: TASK\n---\n",
        )
        .unwrap();
    });

    let res = server.get("/api/vault/board").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let tasks = body["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "expected 1 task, got: {tasks:?}");
    assert_eq!(
        tasks[0]["status"], "INTAKE",
        "expected default status INTAKE, got: {}",
        tasks[0]["status"]
    );
    assert_eq!(
        tasks[0]["priority"], "P2",
        "expected default priority P2, got: {}",
        tasks[0]["priority"]
    );
}

// ---------------------------------------------------------------------------
// POST /board/tasks — create task with full fields under a project
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_task_allocates_code_and_files_under_operation() {
    let (server, tmp) = setup_server_with(|root| {
        // projects/op-sig3.md: PROJECT with board: true
        std::fs::create_dir_all(root.join("projects")).unwrap();
        std::fs::write(
            root.join("projects/op-sig3.md"),
            "---\nid: 01951234-0000-7000-8000-000000000001\n\
             title: SIGNAL-3 MIGRATION\ntype: PROJECT\nproject: op-sig3\n\
             board: true\n---\n",
        )
        .unwrap();

        // cycles/S-13.md: CYCLE
        std::fs::create_dir_all(root.join("cycles")).unwrap();
        std::fs::write(
            root.join("cycles/S-13.md"),
            "---\nid: 01951234-0000-7000-8000-000000000002\n\
             title: CYCLE 13\ntype: CYCLE\nstate: ACTIVE\n\
             start: \"2026-04-13\"\nend: \"2026-04-19\"\n---\n",
        )
        .unwrap();
    });

    let res = server
        .post("/api/vault/board/tasks")
        .json(&serde_json::json!({
            "title": "dual-write shim",
            "project": "op-sig3",
            "status": "TRIAGE",
            "priority": "P1",
            "cycle": "S-13",
            "checklist": ["shim", "overlap", "verify"]
        }))
        .await;
    res.assert_status(axum::http::StatusCode::CREATED);

    let body: serde_json::Value = res.json();
    assert_eq!(body["code"], "TSK-0001", "code: {body}");
    assert_eq!(body["path"], "tasks/op-sig3/TSK-0001.md", "path: {body}");
    assert_eq!(body["status"], "TRIAGE", "status: {body}");
    assert_eq!(body["priority"], "P1", "priority: {body}");
    assert_eq!(body["cycle"], "S-13", "cycle: {body}");
    assert_eq!(body["title"], "dual-write shim", "title: {body}");
    let checks = body["checks"].as_array().unwrap();
    assert_eq!(checks[0], 0, "done should be 0");
    assert_eq!(checks[1], 3, "total should be 3");

    // Verify file exists on disk with the expected frontmatter
    let vault_root = tmp.path().join("vault");
    let file_path = vault_root.join("tasks/op-sig3/TSK-0001.md");
    assert!(file_path.exists(), "task file should exist on disk");
    let content = std::fs::read_to_string(&file_path).unwrap();
    assert!(content.contains("type: TASK"), "should have type: TASK");
    assert!(
        content.contains("status: TRIAGE"),
        "should have status: TRIAGE"
    );
    assert!(
        content.contains("- [ ] shim"),
        "should have checklist item 'shim'"
    );
}

// ---------------------------------------------------------------------------
// POST /board/tasks — create task without project goes to tasks root
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_task_without_project_files_at_tasks_root() {
    let (server, tmp) = setup_server_with(|_root| {});

    let res = server
        .post("/api/vault/board/tasks")
        .json(&serde_json::json!({ "title": "stray" }))
        .await;
    res.assert_status(axum::http::StatusCode::CREATED);

    let body: serde_json::Value = res.json();
    assert_eq!(body["code"], "TSK-0001", "code: {body}");
    assert_eq!(body["path"], "tasks/TSK-0001.md", "path: {body}");
    assert!(body["project"].is_null(), "project should be null: {body}");
    assert_eq!(body["status"], "INTAKE", "status should default to INTAKE");
    assert_eq!(body["priority"], "P2", "priority should default to P2");

    let vault_root = tmp.path().join("vault");
    assert!(
        vault_root.join("tasks/TSK-0001.md").exists(),
        "task file should be at tasks root"
    );
}

// ---------------------------------------------------------------------------
// POST /board/tasks — second create increments code
// ---------------------------------------------------------------------------

#[tokio::test]
async fn second_create_increments_code() {
    let (server, _tmp) = setup_server_with(|root| {
        // Pre-seed an existing task at TSK-0481
        std::fs::create_dir_all(root.join("tasks/op-sig3")).unwrap();
        std::fs::write(
            root.join("tasks/op-sig3/TSK-0481.md"),
            "---\nid: 01951234-0000-7000-8000-000000000003\n\
             title: EXISTING TASK\ntype: TASK\nproject: op-sig3\n\
             status: FIELD\npriority: P0\n---\n",
        )
        .unwrap();
    });

    let res = server
        .post("/api/vault/board/tasks")
        .json(&serde_json::json!({ "title": "next task" }))
        .await;
    res.assert_status(axum::http::StatusCode::CREATED);

    let body: serde_json::Value = res.json();
    assert_eq!(
        body["code"], "TSK-0482",
        "should allocate TSK-0482 after TSK-0481, got: {body}"
    );
}

// ---------------------------------------------------------------------------
// POST /board/tasks — unknown cycle rejected with 400
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_task_rejects_unknown_cycle() {
    let (server, _tmp) = setup_server_with(|_root| {});

    let res = server
        .post("/api/vault/board/tasks")
        .json(&serde_json::json!({ "title": "x", "cycle": "S-99" }))
        .await;
    res.assert_status(axum::http::StatusCode::BAD_REQUEST);
}

// ---------------------------------------------------------------------------
// PATCH /board/tasks/{id} — validation failures + BACKLOG sentinel
// ---------------------------------------------------------------------------

/// Seed a single task (with a cycle S-13 page) and return server + tmp.
/// Task UUID: 01951234-0000-7000-8000-000000000060.
fn setup_patch_target() -> (TestServer, TempDir) {
    setup_server_with(|root| {
        std::fs::create_dir_all(root.join("cycles")).unwrap();
        std::fs::write(
            root.join("cycles/S-13.md"),
            "---\nid: 01951234-0000-7000-8000-000000000002\n\
             title: CYCLE 13\ntype: CYCLE\nstate: ACTIVE\n\
             start: \"2026-04-13\"\nend: \"2026-04-19\"\n---\n",
        )
        .unwrap();

        std::fs::create_dir_all(root.join("tasks")).unwrap();
        std::fs::write(
            root.join("tasks/TSK-0481.md"),
            "---\nid: 01951234-0000-7000-8000-000000000060\n\
             title: FREEZE LEGACY SYNC WRITES\ntype: TASK\n\
             status: FIELD\npriority: P0\ncycle: S-13\n---\n",
        )
        .unwrap();
    })
}

#[tokio::test]
async fn patch_task_rejects_unknown_cycle() {
    let (server, _tmp) = setup_patch_target();

    let res = server
        .patch("/api/vault/board/tasks/01951234-0000-7000-8000-000000000060")
        .json(&serde_json::json!({ "cycle": "S-99" }))
        .await;
    res.assert_status(axum::http::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn patch_task_backlog_cycle_clears_like_null() {
    let (server, tmp) = setup_patch_target();

    let res = server
        .patch("/api/vault/board/tasks/01951234-0000-7000-8000-000000000060")
        .json(&serde_json::json!({ "cycle": "BACKLOG" }))
        .await;
    res.assert_status_ok();

    let body: serde_json::Value = res.json();
    assert!(
        body["cycle"].is_null(),
        "cycle should be cleared by BACKLOG: {body}"
    );

    // File frontmatter must no longer carry the cycle key
    let content = std::fs::read_to_string(tmp.path().join("vault/tasks/TSK-0481.md")).unwrap();
    assert!(
        !content.contains("cycle:"),
        "file should not have cycle field, got:\n{content}"
    );
}

#[tokio::test]
async fn patch_task_rejects_bogus_status() {
    let (server, _tmp) = setup_patch_target();

    let res = server
        .patch("/api/vault/board/tasks/01951234-0000-7000-8000-000000000060")
        .json(&serde_json::json!({ "status": "BOGUS" }))
        .await;
    res.assert_status(axum::http::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn patch_task_rejects_bogus_priority() {
    let (server, _tmp) = setup_patch_target();

    let res = server
        .patch("/api/vault/board/tasks/01951234-0000-7000-8000-000000000060")
        .json(&serde_json::json!({ "priority": "P9" }))
        .await;
    res.assert_status(axum::http::StatusCode::BAD_REQUEST);
}

// ---------------------------------------------------------------------------
// POST /board/tasks — all optional fields persist to frontmatter + response
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_task_persists_all_optional_fields() {
    let (server, tmp) = setup_server_with(|_root| {});

    let res = server
        .post("/api/vault/board/tasks")
        .json(&serde_json::json!({
            "title": "full payload",
            "assignee": "kit",
            "estimate": "3d",
            "due": "2026-04-21",
            "tags": ["ops", "sync"],
            "link": "CLP-0901-J"
        }))
        .await;
    res.assert_status(axum::http::StatusCode::CREATED);

    // Response carries all fields
    let body: serde_json::Value = res.json();
    assert_eq!(body["assignee"], "kit", "assignee: {body}");
    assert_eq!(body["estimate"], "3d", "estimate: {body}");
    assert_eq!(body["due"], "2026-04-21", "due: {body}");
    assert_eq!(body["link"], "CLP-0901-J", "link: {body}");
    let tags = body["tags"].as_array().unwrap();
    let tag_strs: Vec<&str> = tags.iter().filter_map(|t| t.as_str()).collect();
    assert!(tag_strs.contains(&"ops"), "tags should contain ops: {body}");
    assert!(
        tag_strs.contains(&"sync"),
        "tags should contain sync: {body}"
    );

    // Disk frontmatter carries all fields
    let content = std::fs::read_to_string(tmp.path().join("vault/tasks/TSK-0001.md")).unwrap();
    assert!(content.contains("assignee: kit"), "frontmatter:\n{content}");
    assert!(content.contains("estimate: 3d"), "frontmatter:\n{content}");
    assert!(
        content.contains("due:") && content.contains("2026-04-21"),
        "frontmatter:\n{content}"
    );
    assert!(
        content.contains("link:") && content.contains("CLP-0901-J"),
        "frontmatter:\n{content}"
    );
    assert!(
        content.contains("- ops") && content.contains("- sync"),
        "frontmatter should list both tags:\n{content}"
    );
}

// ---------------------------------------------------------------------------
// PATCH /board/tasks/{id} — project change A→B physically moves the file
// ---------------------------------------------------------------------------

#[tokio::test]
async fn project_assignment_patch_task_moves_to_set_project() {
    let (server, tmp) = setup_server_with(|root| {
        std::fs::create_dir_all(root.join("tasks/op-a")).unwrap();
        std::fs::write(
            root.join("tasks/op-a/TSK-0001.md"),
            "---\nid: 01951234-0000-7000-8000-000000000070\n\
             title: MOVE ME\ntype: TASK\nproject: op-a\n\
             status: TRIAGE\npriority: P2\n---\n",
        )
        .unwrap();
    });

    let res = server
        .patch("/api/vault/board/tasks/01951234-0000-7000-8000-000000000070")
        .json(&serde_json::json!({ "project": "op-b" }))
        .await;
    res.assert_status_ok();

    let body: serde_json::Value = res.json();
    assert_eq!(
        body["path"], "tasks/op-b/TSK-0001.md",
        "response path should be under op-b: {body}"
    );
    assert_eq!(body["project"], "op-b", "project: {body}");

    let vault_root = tmp.path().join("vault");
    assert!(
        vault_root.join("tasks/op-b/TSK-0001.md").exists(),
        "file should exist under tasks/op-b/"
    );
    assert!(
        !vault_root.join("tasks/op-a/TSK-0001.md").exists(),
        "file should no longer exist under tasks/op-a/"
    );
}

// ---------------------------------------------------------------------------
// PATCH /board/tasks/{id} — project clear ("") moves the file to tasks root
// ---------------------------------------------------------------------------

#[tokio::test]
async fn project_assignment_patch_task_explicit_clear_moves_to_root() {
    let (server, tmp) = setup_server_with(|root| {
        std::fs::create_dir_all(root.join("tasks/op-a")).unwrap();
        std::fs::write(
            root.join("tasks/op-a/TSK-0001.md"),
            "---\nid: 01951234-0000-7000-8000-000000000071\n\
             title: UNFILE ME\ntype: TASK\nproject: op-a\n\
             status: TRIAGE\npriority: P2\n---\n",
        )
        .unwrap();
    });

    let res = server
        .patch("/api/vault/board/tasks/01951234-0000-7000-8000-000000000071")
        .json(&serde_json::json!({ "project": "" }))
        .await;
    res.assert_status_ok();

    let body: serde_json::Value = res.json();
    assert_eq!(
        body["path"], "tasks/TSK-0001.md",
        "response path should be at tasks root: {body}"
    );
    assert!(body["project"].is_null(), "project should be null: {body}");

    let vault_root = tmp.path().join("vault");
    assert!(
        vault_root.join("tasks/TSK-0001.md").exists(),
        "file should exist at tasks root"
    );
    assert!(
        !vault_root.join("tasks/op-a/TSK-0001.md").exists(),
        "file should no longer exist under tasks/op-a/"
    );
    let content = std::fs::read_to_string(vault_root.join("tasks/TSK-0001.md")).unwrap();
    assert!(
        !content.contains("project:"),
        "frontmatter should not carry project, got:\n{content}"
    );
}

#[tokio::test]
async fn project_assignment_patch_task_destination_collision_returns_409() {
    let (server, tmp) = setup_server_with(|root| {
        std::fs::create_dir_all(root.join("tasks/op-a")).unwrap();
        std::fs::create_dir_all(root.join("tasks/op-b")).unwrap();
        std::fs::write(
            root.join("tasks/op-a/TSK-0001.md"),
            "---\nid: 01951234-0000-7000-8000-000000000072\n\
             title: SOURCE\ntype: TASK\nproject: op-a\n\
             status: TRIAGE\npriority: P2\n---\n",
        )
        .unwrap();
        std::fs::write(
            root.join("tasks/op-b/TSK-0001.md"),
            "---\nid: 01951234-0000-7000-8000-000000000073\n\
             title: OCCUPIED\ntype: TASK\nproject: op-b\n\
             status: TRIAGE\npriority: P2\n---\n",
        )
        .unwrap();
    });

    let response = server
        .patch("/api/vault/board/tasks/01951234-0000-7000-8000-000000000072")
        .json(&serde_json::json!({ "project": "op-b" }))
        .await;

    response.assert_status(axum::http::StatusCode::CONFLICT);
    let vault_root = tmp.path().join("vault");
    let persisted = std::fs::read_to_string(vault_root.join("tasks/op-a/TSK-0001.md")).unwrap();
    assert!(
        persisted.contains("project: op-a"),
        "a rejected refile must preserve the original project: {persisted}"
    );
    assert!(
        std::fs::read_to_string(vault_root.join("tasks/op-b/TSK-0001.md"))
            .unwrap()
            .contains("OCCUPIED"),
        "the destination must not be overwritten"
    );
}

// ---------------------------------------------------------------------------
// PATCH /board/tasks/{id} — happy path for title + tags + link
// ---------------------------------------------------------------------------

#[tokio::test]
async fn patch_task_updates_title_tags_and_link() {
    let (server, tmp) = setup_patch_target();

    let res = server
        .patch("/api/vault/board/tasks/01951234-0000-7000-8000-000000000060")
        .json(&serde_json::json!({
            "title": "thaw legacy sync writes",
            "tags": ["ops", "sync"],
            "link": "CLP-0901-J"
        }))
        .await;
    res.assert_status_ok();

    let body: serde_json::Value = res.json();
    assert_eq!(body["title"], "thaw legacy sync writes", "title: {body}");
    assert_eq!(body["link"], "CLP-0901-J", "link: {body}");
    let tags = body["tags"].as_array().unwrap();
    let tag_strs: Vec<&str> = tags.iter().filter_map(|t| t.as_str()).collect();
    assert!(tag_strs.contains(&"ops"), "tags should contain ops: {body}");
    assert!(
        tag_strs.contains(&"sync"),
        "tags should contain sync: {body}"
    );

    // Disk frontmatter reflects all three
    let content = std::fs::read_to_string(tmp.path().join("vault/tasks/TSK-0481.md")).unwrap();
    assert!(
        content.contains("title: thaw legacy sync writes"),
        "frontmatter:\n{content}"
    );
    assert!(
        content.contains("link:") && content.contains("CLP-0901-J"),
        "frontmatter:\n{content}"
    );
    assert!(
        content.contains("- ops") && content.contains("- sync"),
        "frontmatter should list both tags:\n{content}"
    );
}

// ---------------------------------------------------------------------------
// PATCH /board/tasks/{id} — moves column, clears hold
// ---------------------------------------------------------------------------

#[tokio::test]
async fn patch_task_moves_column_and_clears_hold() {
    let (server, tmp) = setup_server_with(|root| {
        // cycles/S-13.md
        std::fs::create_dir_all(root.join("cycles")).unwrap();
        std::fs::write(
            root.join("cycles/S-13.md"),
            "---\nid: 01951234-0000-7000-8000-000000000002\n\
             title: CYCLE 13\ntype: CYCLE\nstate: ACTIVE\n\
             start: \"2026-04-13\"\nend: \"2026-04-19\"\n---\n",
        )
        .unwrap();

        // tasks/TSK-0481.md: TASK in FIELD with hold
        std::fs::create_dir_all(root.join("tasks")).unwrap();
        std::fs::write(
            root.join("tasks/TSK-0481.md"),
            "---\nid: 01951234-0000-7000-8000-000000000050\n\
             title: FREEZE LEGACY SYNC WRITES\ntype: TASK\n\
             status: FIELD\npriority: P0\ncycle: S-13\n\
             hold: \"AWAITING X\"\n---\n",
        )
        .unwrap();
    });

    // PATCH the task
    let res = server
        .patch("/api/vault/board/tasks/01951234-0000-7000-8000-000000000050")
        .json(&serde_json::json!({
            "status": "REVIEW",
            "hold": null
        }))
        .await;
    res.assert_status_ok();

    let body: serde_json::Value = res.json();
    assert_eq!(body["status"], "REVIEW", "status: {body}");
    assert!(body["hold"].is_null(), "hold should be null: {body}");

    // Verify the board reflects the updated state
    let board_res = server.get("/api/vault/board").await;
    board_res.assert_status_ok();
    let board: serde_json::Value = board_res.json();
    let tasks = board["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "board should still have 1 task");
    assert_eq!(tasks[0]["status"], "REVIEW", "board task status: {tasks:?}");
    assert!(
        tasks[0]["hold"].is_null(),
        "board task hold should be null: {tasks:?}"
    );

    // Verify the file on disk has updated frontmatter
    let vault_root = tmp.path().join("vault");
    let file_path = vault_root.join("tasks/TSK-0481.md");
    let content = std::fs::read_to_string(&file_path).unwrap();
    assert!(
        content.contains("status: REVIEW"),
        "file should have status: REVIEW, got:\n{content}"
    );
    assert!(
        !content.contains("hold:"),
        "file should not have hold field, got:\n{content}"
    );
}

// ---------------------------------------------------------------------------
// POST /board/cycles — create cycle with auto-generated code + default state
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_cycle_defaults_code_and_state() {
    let (server, tmp) = setup_server_with(|root| {
        // seed an existing cycle S-13
        std::fs::create_dir_all(root.join("cycles")).unwrap();
        std::fs::write(
            root.join("cycles/S-13.md"),
            "---\nid: 01951234-0000-7000-8000-000000000002\n\
             title: CYCLE 13\ntype: CYCLE\nstate: ACTIVE\n\
             start: \"2026-04-13\"\nend: \"2026-04-19\"\n---\n",
        )
        .unwrap();
    });

    let res = server
        .post("/api/vault/board/cycles")
        .json(&serde_json::json!({
            "label": "CYCLE 14",
            "start": "2026-04-20",
            "end": "2026-04-26"
        }))
        .await;
    res.assert_status(axum::http::StatusCode::CREATED);

    let body: serde_json::Value = res.json();
    assert_eq!(body["code"], "S-14", "code: {body}");
    assert_eq!(
        body["state"], "PLANNED",
        "state should default to PLANNED: {body}"
    );
    assert_eq!(body["path"], "cycles/S-14.md", "path: {body}");
    assert_eq!(body["label"], "CYCLE 14", "label: {body}");
    assert_eq!(body["start"], "2026-04-20", "start: {body}");
    assert_eq!(body["end"], "2026-04-26", "end: {body}");

    // File on disk must have correct frontmatter
    let vault_root = tmp.path().join("vault");
    let file_path = vault_root.join("cycles/S-14.md");
    assert!(file_path.exists(), "cycle file should exist on disk");
    let content = std::fs::read_to_string(&file_path).unwrap();
    assert!(
        content.contains("type: CYCLE"),
        "should have type: CYCLE, got:\n{content}"
    );
    assert!(
        content.contains("state: PLANNED"),
        "should have state: PLANNED, got:\n{content}"
    );
    assert!(
        content.contains("title: CYCLE 14"),
        "should have title, got:\n{content}"
    );
    assert!(
        content.contains("2026-04-20"),
        "should have start date, got:\n{content}"
    );
    assert!(
        content.contains("2026-04-26"),
        "should have end date, got:\n{content}"
    );
}

// ---------------------------------------------------------------------------
// POST /board/cycles — explicit code and state honored
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_cycle_honors_explicit_code_and_state() {
    let (server, _tmp) = setup_server_with(|_root| {});

    let res = server
        .post("/api/vault/board/cycles")
        .json(&serde_json::json!({
            "code": "S-20",
            "label": "CYCLE 20",
            "start": "2026-06-01",
            "end": "2026-06-07",
            "state": "ACTIVE",
            "goal": "finish the thing"
        }))
        .await;
    res.assert_status(axum::http::StatusCode::CREATED);

    let body: serde_json::Value = res.json();
    assert_eq!(body["code"], "S-20", "code: {body}");
    assert_eq!(body["state"], "ACTIVE", "state: {body}");
    assert_eq!(body["goal"], "finish the thing", "goal: {body}");
}

// ---------------------------------------------------------------------------
// POST /board/cycles — duplicate code yields 409
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_cycle_rejects_duplicate_code() {
    let (server, _tmp) = setup_server_with(|root| {
        std::fs::create_dir_all(root.join("cycles")).unwrap();
        std::fs::write(
            root.join("cycles/S-13.md"),
            "---\nid: 01951234-0000-7000-8000-000000000002\n\
             title: CYCLE 13\ntype: CYCLE\nstate: ACTIVE\n---\n",
        )
        .unwrap();
    });

    // Explicit code that already exists
    let res = server
        .post("/api/vault/board/cycles")
        .json(&serde_json::json!({
            "code": "S-13",
            "label": "CYCLE 13 DUP",
            "start": "2026-04-13",
            "end": "2026-04-19"
        }))
        .await;
    res.assert_status(axum::http::StatusCode::CONFLICT);
}

// ---------------------------------------------------------------------------
// PATCH /board/cycles/{id} — seal cycle, carry non-sealed tasks to BACKLOG
// ---------------------------------------------------------------------------

/// Seed two cycles S-13 (ACTIVE) + S-14 (PLANNED) plus two tasks in S-13.
/// Returns (server, tmp, cycle_uuid_s13, task_sealed_uuid, task_field_uuid).
fn setup_cycle_with_tasks() -> (TestServer, TempDir) {
    setup_server_with(|root| {
        std::fs::create_dir_all(root.join("cycles")).unwrap();
        // S-13 ACTIVE
        std::fs::write(
            root.join("cycles/S-13.md"),
            "---\nid: 01951234-0000-7000-8000-aaa000000001\n\
             title: CYCLE 13\ntype: CYCLE\nstate: ACTIVE\n\
             start: \"2026-04-13\"\nend: \"2026-04-19\"\n---\n",
        )
        .unwrap();
        // S-14 PLANNED
        std::fs::write(
            root.join("cycles/S-14.md"),
            "---\nid: 01951234-0000-7000-8000-aaa000000002\n\
             title: CYCLE 14\ntype: CYCLE\nstate: PLANNED\n\
             start: \"2026-04-20\"\nend: \"2026-04-26\"\n---\n",
        )
        .unwrap();

        std::fs::create_dir_all(root.join("tasks")).unwrap();
        // SEALED task in S-13 — should stay in S-13 after carryover
        std::fs::write(
            root.join("tasks/TSK-0001.md"),
            "---\nid: 01951234-0000-7000-8000-bbb000000001\n\
             title: Done Task\ntype: TASK\nstatus: SEALED\npriority: P2\ncycle: S-13\n---\n",
        )
        .unwrap();
        // FIELD task in S-13 — should be carried over
        std::fs::write(
            root.join("tasks/TSK-0002.md"),
            "---\nid: 01951234-0000-7000-8000-bbb000000002\n\
             title: Open Task\ntype: TASK\nstatus: FIELD\npriority: P1\ncycle: S-13\n---\n",
        )
        .unwrap();
    })
}

#[tokio::test]
async fn seal_cycle_routes_carryover_to_backlog() {
    let (server, tmp) = setup_cycle_with_tasks();

    let res = server
        .patch("/api/vault/board/cycles/01951234-0000-7000-8000-aaa000000001")
        .json(&serde_json::json!({
            "state": "CLOSED",
            "carry_to": "BACKLOG"
        }))
        .await;
    res.assert_status_ok();

    let body: serde_json::Value = res.json();
    assert_eq!(body["state"], "CLOSED", "cycle state: {body}");

    let vault_root = tmp.path().join("vault");

    // FIELD task (TSK-0002): cycle key should be REMOVED
    let field_content = std::fs::read_to_string(vault_root.join("tasks/TSK-0002.md")).unwrap();
    assert!(
        !field_content.contains("cycle:"),
        "FIELD task should have cycle removed, got:\n{field_content}"
    );

    // SEALED task (TSK-0001): cycle should still be S-13
    let sealed_content = std::fs::read_to_string(vault_root.join("tasks/TSK-0001.md")).unwrap();
    assert!(
        sealed_content.contains("cycle: S-13"),
        "SEALED task should keep cycle S-13, got:\n{sealed_content}"
    );

    // GET /board should reflect cycle null for the FIELD task
    let board_res = server.get("/api/vault/board").await;
    board_res.assert_status_ok();
    let board: serde_json::Value = board_res.json();
    let tasks = board["tasks"].as_array().unwrap();
    let field_task = tasks
        .iter()
        .find(|t| t["code"] == "TSK-0002")
        .expect("TSK-0002 should exist in board");
    assert!(
        field_task["cycle"].is_null(),
        "board: FIELD task cycle should be null after carryover to BACKLOG, got: {}",
        field_task["cycle"]
    );
}

// ---------------------------------------------------------------------------
// PATCH /board/cycles/{id} — seal with carry_to next cycle
// ---------------------------------------------------------------------------

#[tokio::test]
async fn seal_cycle_can_carry_to_next_cycle() {
    let (server, tmp) = setup_cycle_with_tasks();

    let res = server
        .patch("/api/vault/board/cycles/01951234-0000-7000-8000-aaa000000001")
        .json(&serde_json::json!({
            "state": "CLOSED",
            "carry_to": "S-14"
        }))
        .await;
    res.assert_status_ok();

    let vault_root = tmp.path().join("vault");

    // FIELD task: cycle should now be S-14
    let content = std::fs::read_to_string(vault_root.join("tasks/TSK-0002.md")).unwrap();
    assert!(
        content.contains("cycle: S-14"),
        "FIELD task should now reference S-14, got:\n{content}"
    );

    // SEALED task: cycle should still be S-13
    let sealed_content = std::fs::read_to_string(vault_root.join("tasks/TSK-0001.md")).unwrap();
    assert!(
        sealed_content.contains("cycle: S-13"),
        "SEALED task should keep S-13, got:\n{sealed_content}"
    );
}

// ---------------------------------------------------------------------------
// PATCH /board/cycles/{id} — seal without carry_to leaves tasks alone
// ---------------------------------------------------------------------------

#[tokio::test]
async fn seal_cycle_without_carry_leaves_tasks() {
    let (server, tmp) = setup_cycle_with_tasks();

    let res = server
        .patch("/api/vault/board/cycles/01951234-0000-7000-8000-aaa000000001")
        .json(&serde_json::json!({ "state": "CLOSED" }))
        .await;
    res.assert_status_ok();

    let vault_root = tmp.path().join("vault");

    // FIELD task: cycle should still be S-13
    let content = std::fs::read_to_string(vault_root.join("tasks/TSK-0002.md")).unwrap();
    assert!(
        content.contains("cycle: S-13"),
        "without carry_to, FIELD task cycle should remain S-13, got:\n{content}"
    );
}

// ---------------------------------------------------------------------------
// PATCH /board/cycles/{id} — validation: bogus state + unknown carry target
// ---------------------------------------------------------------------------

#[tokio::test]
async fn patch_cycle_rejects_bad_state_and_unknown_carry_target() {
    let (server, _tmp) = setup_server_with(|root| {
        std::fs::create_dir_all(root.join("cycles")).unwrap();
        std::fs::write(
            root.join("cycles/S-13.md"),
            "---\nid: 01951234-0000-7000-8000-aaa000000001\n\
             title: CYCLE 13\ntype: CYCLE\nstate: ACTIVE\n---\n",
        )
        .unwrap();
    });

    // Bad state value
    let res = server
        .patch("/api/vault/board/cycles/01951234-0000-7000-8000-aaa000000001")
        .json(&serde_json::json!({ "state": "BOGUS" }))
        .await;
    res.assert_status(axum::http::StatusCode::BAD_REQUEST);

    // Unknown carry_to cycle
    let res2 = server
        .patch("/api/vault/board/cycles/01951234-0000-7000-8000-aaa000000001")
        .json(&serde_json::json!({ "state": "CLOSED", "carry_to": "S-99" }))
        .await;
    res2.assert_status(axum::http::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn concurrent_create_requests_reserve_unique_task_and_cycle_codes() {
    let (server, _tmp) = setup_server_with(|_root| {});

    let task_a = server
        .post("/api/vault/board/tasks")
        .json(&serde_json::json!({ "title": "task a" }));
    let task_b = server
        .post("/api/vault/board/tasks")
        .json(&serde_json::json!({ "title": "task b" }));
    let cycle_a = server
        .post("/api/vault/board/cycles")
        .json(&serde_json::json!({
            "label": "cycle a",
            "start": "2026-07-06",
            "end": "2026-07-12"
        }));
    let cycle_b = server
        .post("/api/vault/board/cycles")
        .json(&serde_json::json!({
            "label": "cycle b",
            "start": "2026-07-13",
            "end": "2026-07-19"
        }));

    let (task_a, task_b, cycle_a, cycle_b) = tokio::join!(task_a, task_b, cycle_a, cycle_b);
    for response in [&task_a, &task_b, &cycle_a, &cycle_b] {
        assert_eq!(
            response.status_code(),
            axum::http::StatusCode::CREATED,
            "concurrent create failed: {}",
            response.text()
        );
    }

    let mut task_codes = [
        task_a.json::<serde_json::Value>()["code"]
            .as_str()
            .unwrap()
            .to_string(),
        task_b.json::<serde_json::Value>()["code"]
            .as_str()
            .unwrap()
            .to_string(),
    ];
    task_codes.sort();
    assert_eq!(task_codes, ["TSK-0001", "TSK-0002"]);

    let mut cycle_codes = [
        cycle_a.json::<serde_json::Value>()["code"]
            .as_str()
            .unwrap()
            .to_string(),
        cycle_b.json::<serde_json::Value>()["code"]
            .as_str()
            .unwrap()
            .to_string(),
    ];
    cycle_codes.sort();
    assert_eq!(cycle_codes, ["S-1", "S-2"]);
}
