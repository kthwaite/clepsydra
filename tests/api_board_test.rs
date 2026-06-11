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
