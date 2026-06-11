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

fn setup_server_with(pre_index: impl FnOnce(&Path)) -> (TestServer, TempDir) {
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
        archive_ingest_lock: tokio::sync::Mutex::new(()),
        bcl: None,
        location: None,
    });

    let app: Router = Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);

    let server = TestServer::new(app).unwrap();
    (server, tmp)
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
    assert!(content.contains("status: TRIAGE"), "should have status: TRIAGE");
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
    let content =
        std::fs::read_to_string(tmp.path().join("vault/tasks/TSK-0481.md")).unwrap();
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
    assert!(tag_strs.contains(&"sync"), "tags should contain sync: {body}");

    // Disk frontmatter carries all fields
    let content =
        std::fs::read_to_string(tmp.path().join("vault/tasks/TSK-0001.md")).unwrap();
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
async fn patch_task_project_change_moves_file() {
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
async fn patch_task_project_clear_moves_to_tasks_root() {
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
    let content =
        std::fs::read_to_string(vault_root.join("tasks/TSK-0001.md")).unwrap();
    assert!(
        !content.contains("project:"),
        "frontmatter should not carry project, got:\n{content}"
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
    assert!(tag_strs.contains(&"sync"), "tags should contain sync: {body}");

    // Disk frontmatter reflects all three
    let content =
        std::fs::read_to_string(tmp.path().join("vault/tasks/TSK-0481.md")).unwrap();
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
