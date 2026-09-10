//! Project slugs containing a space.
//!
//! A slug is one or more `/`-separated segments, and a segment may carry
//! spaces: `field notes` is a project like any other. Every write path agrees
//! on that — page create, page assign, task create — so a project declared by
//! hand in the vault behaves exactly like one minted through the API. What a
//! segment may not do is lead or trail with a space, which would name a folder
//! no filesystem round-trips predictably.

mod support;

use std::path::Path;

use axum::http::StatusCode;
use support::ApiFixture;

const SPACED: &str = "field notes";

/// A PROJECT page declaring `field notes`, plus a note to assign to it.
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

/// Create mints a PROJECT page whose slug carries a space.
#[tokio::test]
async fn page_create_accepts_a_project_slug_with_a_space() {
    let fixture = ApiFixture::builder().build();
    let root = fixture.state.vault.root().to_path_buf();

    let response = fixture
        .server
        .post("/api/vault/pages/projects/field%20notes/field%20notes.md")
        .json(&serde_json::json!({
            "title": "Field Notes",
            "kind": "PROJECT",
            "project": SPACED,
        }))
        .await;
    response.assert_status(StatusCode::CREATED);

    let body: serde_json::Value = response.json();
    assert_eq!(body["project"], SPACED);
    assert!(
        root.join("projects/field notes/field notes.md").exists(),
        "the PROJECT page must land in a folder named for its slug"
    );
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

/// Assign joins a page to the spaced project and relocates it accordingly.
#[tokio::test]
async fn pages_assign_joins_a_spaced_project_and_relocates_the_page() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_spaced_project)
        .build();
    let root = fixture.state.vault.root().to_path_buf();

    let response = fixture
        .server
        .post("/api/vault/pages-assign/notes/loose.md")
        .json(&serde_json::json!({ "project": SPACED }))
        .await;
    response.assert_status_ok();

    let body: serde_json::Value = response.json();
    assert_eq!(body["project"], SPACED);
    assert!(
        root.join("notes/field notes/loose.md").exists(),
        "the page must follow its declared project into a spaced folder"
    );
    assert!(
        !root.join("notes/loose.md").exists(),
        "the page must not remain at its old path"
    );
}

/// Task create files a task under the spaced project's folder.
#[tokio::test]
async fn task_create_accepts_a_spaced_project_and_writes_a_spaced_folder() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_spaced_project)
        .build();
    let root = fixture.state.vault.root().to_path_buf();

    let response = fixture
        .server
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

/// A nested slug may carry spaces in any segment.
#[tokio::test]
async fn a_nested_slug_may_carry_spaces_in_every_segment() {
    let fixture = ApiFixture::builder().build();

    fixture
        .server
        .post("/api/vault/pages/projects/field%20notes/river%20survey/river%20survey.md")
        .json(&serde_json::json!({
            "title": "River Survey",
            "kind": "PROJECT",
            "project": "field notes/river survey",
        }))
        .await
        .assert_status(StatusCode::CREATED);
}

/// A PROJECT page can only be authored by hand with a slug the API would have
/// refused. Both write paths must then refuse it alike — existence is not
/// enough to make a malformed slug usable.
#[tokio::test]
async fn a_hand_authored_malformed_slug_is_refused_by_task_create_and_assign() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(|root| {
            std::fs::create_dir_all(root.join("projects/bad.slug")).unwrap();
            std::fs::write(
                root.join("projects/bad.slug/bad.slug.md"),
                "+++\n\
                 id = \"01951234-0000-7000-8000-0000000000f3\"\n\
                 title = \"Bad Slug\"\n\
                 type = \"PROJECT\"\n\
                 project = \"bad.slug\"\n\
                 +++\n",
            )
            .unwrap();
            std::fs::create_dir_all(root.join("notes")).unwrap();
            std::fs::write(
                root.join("notes/loose.md"),
                "+++\n\
                 id = \"01951234-0000-7000-8000-0000000000f4\"\n\
                 title = \"Loose\"\n\
                 type = \"NOTE\"\n\
                 +++\n",
            )
            .unwrap();
        })
        .build();
    let root = fixture.state.vault.root().to_path_buf();

    let task = fixture
        .server
        .post("/api/vault/board/tasks")
        .json(&serde_json::json!({
            "title": "Survey the ridge",
            "project": "bad.slug",
        }))
        .await;
    task.assert_status(StatusCode::BAD_REQUEST);

    let assign = fixture
        .server
        .post("/api/vault/pages-assign/notes/loose.md")
        .json(&serde_json::json!({ "project": "bad.slug" }))
        .await;
    assign.assert_status(StatusCode::BAD_REQUEST);

    let task_error: serde_json::Value = task.json();
    let assign_error: serde_json::Value = assign.json();
    assert_eq!(
        task_error["error"], assign_error["error"],
        "both paths must refuse a malformed slug for the same stated reason"
    );
    assert!(
        !root.join("tasks/bad.slug").exists(),
        "a refused task must leave no project folder behind"
    );
}

/// Padding, empty segments and traversal stay refused.
#[tokio::test]
async fn malformed_slugs_are_still_refused() {
    let fixture = ApiFixture::builder().build();

    for (slug, expected) in [
        (" field notes", "start or end with a space"),
        ("field notes ", "start or end with a space"),
        ("field / notes", "start or end with a space"),
        ("field//notes", "empty path segment"),
        ("/field notes", "empty path segment"),
        ("field notes/", "empty path segment"),
        ("../escape", "`.` or `..` segments"),
        ("field\tnotes", "may contain only"),
        ("field:notes", "may contain only"),
    ] {
        let response = fixture
            .server
            .post("/api/vault/pages/projects/candidate.md")
            .json(&serde_json::json!({
                "title": "Candidate",
                "kind": "PROJECT",
                "project": slug,
            }))
            .await;
        response.assert_status(StatusCode::BAD_REQUEST);

        let error: serde_json::Value = response.json();
        assert!(
            error["error"]
                .as_str()
                .is_some_and(|message| message.contains(expected)),
            "slug {slug:?} should be refused for {expected:?}, got: {error}"
        );
    }
}
