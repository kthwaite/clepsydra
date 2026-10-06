//! Retired Projects: a slug whose every PROJECT page says `board: false`
//! hides its Tasks from `GET /board` unless `include_retired=true`.

mod support;

use std::fs;
use std::path::Path;

use serde_json::Value;

use support::ApiFixture;

fn write(root: &Path, rel: &str, body: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}

fn project_page(root: &Path, rel: &str, id: u32, slug: &str, board: Option<bool>) {
    let board_line = board.map_or_else(String::new, |flag| format!("board: {flag}\n"));
    write(
        root,
        rel,
        &format!(
            "---\nid: 00000000-0000-0000-0000-{id:012}\ntitle: {slug} {id}\ntype: PROJECT\n\
             project: {slug}\n{board_line}---\n\n# {slug}\n"
        ),
    );
}

fn task_page(root: &Path, code: &str, id: u32, slug: &str) {
    write(
        root,
        &format!("tasks/{code}.md"),
        &format!(
            "---\nid: 00000000-0000-0000-0000-{id:012}\ntitle: {code}\ntype: TASK\n\
             project: {slug}\nstatus: TRIAGE\n---\n\n# {code}\n"
        ),
    );
}

fn task_codes(board: &Value) -> Vec<String> {
    let mut codes: Vec<String> = board["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["code"].as_str().unwrap().to_string())
        .collect();
    codes.sort();
    codes
}

fn retired_fixture(root: &Path) {
    project_page(root, "projects/old.md", 1, "old", Some(false));
    project_page(root, "projects/live.md", 2, "live", None);
    task_page(root, "TSK-old", 11, "old");
    task_page(root, "TSK-live", 12, "live");
}

#[tokio::test]
async fn retired_project_tasks_hidden() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(retired_fixture)
        .build();
    let board: Value = fixture.server.get("/api/vault/board").await.json();
    assert_eq!(task_codes(&board), vec!["TSK-live"]);
}

#[tokio::test]
async fn include_retired_returns_retired_tasks() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(retired_fixture)
        .build();
    let board: Value = fixture
        .server
        .get("/api/vault/board")
        .add_query_param("include_retired", "true")
        .await
        .json();
    assert_eq!(task_codes(&board), vec!["TSK-live", "TSK-old"]);
    // Operations keep today's behaviour: the `board: false` page stays out.
    let op_projects: Vec<&str> = board["operations"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|op| op["project"].as_str())
        .collect();
    assert_eq!(op_projects, vec!["live"]);
}

#[tokio::test]
async fn slug_with_listed_page_not_retired() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(|root| {
            project_page(root, "projects/mix-a.md", 1, "mix", Some(false));
            project_page(root, "projects/mix-b.md", 2, "mix", None);
            task_page(root, "TSK-mix", 11, "mix");
        })
        .build();
    let board: Value = fixture.server.get("/api/vault/board").await.json();
    assert_eq!(task_codes(&board), vec!["TSK-mix"]);
}

#[tokio::test]
async fn task_slug_without_project_page_not_retired() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(|root| {
            task_page(root, "TSK-orphan", 11, "orphan");
        })
        .build();
    let board: Value = fixture.server.get("/api/vault/board").await.json();
    assert_eq!(task_codes(&board), vec!["TSK-orphan"]);
}
