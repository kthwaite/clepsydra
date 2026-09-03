//! What the server does with a project slug that contains a space.
//!
//! `validate_project_slug` refuses one, so no API write path can mint such a
//! project. The vault file is the source of truth, though, and the indexer
//! validates nothing: a hand-authored PROJECT page declaring `field notes`
//! becomes a project the existence check accepts. These tests pin down which
//! paths then honour it and which refuse it.

mod support;

use std::path::Path;

use axum::http::StatusCode;
use support::ApiFixture;

const SPACED: &str = "field notes";

/// A hand-authored PROJECT page declaring a slug with a space, plus a note to
/// try assigning to it.
fn seed_spaced_project(root: &Path) {
    std::fs::create_dir_all(root.join("projects/field notes")).unwrap();
    std::fs::write(
        root.join("projects/field notes/field notes.md"),
        "+++\n\
         id = \"01951234-0000-7000-8000-0000000000f1\"\n\
         title = \"Field Notes\"\n\
         type = \"PROJECT\"\n\
         project = \"field notes\"\n\
         +++\n",
    )
    .unwrap();
    std::fs::create_dir_all(root.join("notes")).unwrap();
    std::fs::write(
        root.join("notes/loose.md"),
        "+++\n\
         id = \"01951234-0000-7000-8000-0000000000f2\"\n\
         title = \"Loose\"\n\
         type = \"NOTE\"\n\
         +++\n",
    )
    .unwrap();
}

/// The API's own create path refuses the slug outright.
#[tokio::test]
async fn page_create_rejects_a_project_slug_with_a_space() {
    let (server, _tmp) = ApiFixture::builder().build().into_server_and_temp();

    server
        .post("/api/vault/pages/projects/field-notes/field-notes.md")
        .json(&serde_json::json!({
            "title": "Field Notes",
            "kind": "PROJECT",
            "project": SPACED,
        }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
}

/// A vault-authored spaced slug indexes, lists, and filters like any other.
#[tokio::test]
async fn a_vault_authored_spaced_project_is_indexed_and_filterable() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_spaced_project)
        .build()
        .into_server_and_temp();

    let response = server
        .get("/api/vault/pages")
        .add_query_param("project", SPACED)
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    let items = body["items"].as_array().expect("items array");
    assert_eq!(
        items.len(),
        1,
        "the spaced slug must round-trip through the query filter: {body}"
    );
    assert_eq!(items[0]["project"], SPACED);
}

/// The task path accepts it — existence is the only check — and files the task
/// under a folder whose name carries the space.
#[tokio::test]
async fn task_create_accepts_a_spaced_project_and_writes_a_spaced_folder() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_spaced_project)
        .build();
    let root = fixture.temp_dir.path().join("vault");
    let (server, _tmp) = fixture.into_server_and_temp();

    let response = server
        .post("/api/vault/board/tasks")
        .json(&serde_json::json!({
            "title": "Survey the ridge",
            "project": SPACED,
        }))
        .await;
    response.assert_status(StatusCode::CREATED);

    let body: serde_json::Value = response.json();
    assert_eq!(body["project"], SPACED);
    let path = body["path"].as_str().expect("task path");
    assert!(
        path.starts_with("tasks/field notes/"),
        "task must be filed under the spaced project folder, got {path}"
    );
    assert!(
        root.join(path).exists(),
        "the task file must exist on disk at {path}"
    );
}

/// ...but the assign path refuses the same slug, so a page cannot join a
/// project its own tasks can. This is the inconsistency.
#[tokio::test]
async fn pages_assign_refuses_the_spaced_project_a_task_can_join() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_spaced_project)
        .build()
        .into_server_and_temp();

    let response = server
        .post("/api/vault/pages-assign/notes/loose.md")
        .json(&serde_json::json!({ "project": SPACED }))
        .await;
    assert_eq!(
        response.status_code(),
        StatusCode::BAD_REQUEST,
        "assign currently rejects what task create accepts: {}",
        response.text()
    );
}
