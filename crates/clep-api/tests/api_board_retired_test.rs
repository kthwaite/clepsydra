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

#[tokio::test]
async fn property_patches_hide_and_restore_a_shared_project_without_deleting_pages() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(|root| {
            project_page(root, "projects/mix-a.md", 1, "mix", None);
            project_page(root, "projects/mix-b.md", 2, "mix", Some(true));
            task_page(root, "TSK-mix", 11, "mix");
            write(
                root,
                "notes/mix.md",
                "---\nid: 00000000-0000-0000-0000-000000000021\ntitle: Project notes\ntype: NOTE\nproject: mix\n---\n\nKeep these notes.\n",
            );
        })
        .build();
    let server = &fixture.server;
    let listing = server
        .get("/api/vault/pages")
        .add_query_param("kind", "PROJECT")
        .add_query_param("project", "mix")
        .await;
    listing.assert_status_ok();
    let listing: Value = listing.json();
    let projects = listing["items"].as_array().unwrap();
    assert_eq!(projects.len(), 2);

    let task_url = "/api/vault/pages/by-id/00000000-0000-0000-0000-000000000011";
    let notes_url = "/api/vault/pages/by-id/00000000-0000-0000-0000-000000000021";
    let task_before: Value = server.get(task_url).await.json();
    let notes_before: Value = server.get(notes_url).await.json();
    let board_before: Value = server.get("/api/vault/board").await.json();
    assert!(
        board_before["columns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|column| column["id"] == "INTAKE")
    );

    for visible in [false, true] {
        for (index, project) in projects.iter().enumerate() {
            let id = project["id"].as_str().unwrap();
            let page_url = format!("/api/vault/pages/by-id/{id}");
            let before: Value = server.get(&page_url).await.json();
            server
                .patch(&format!("{page_url}/properties"))
                .json(&serde_json::json!({
                    "set": { "board": visible },
                    "types": { "board": "bool" },
                    "expected_revision": before["revision"],
                }))
                .await
                .assert_status_ok();
            let after: Value = server.get(&page_url).await.json();
            assert_eq!(after["body"], before["body"]);
            assert_eq!(after["meta"]["id"], before["meta"]["id"]);

            let board: Value = server.get("/api/vault/board").await.json();
            // One still-listed page keeps the entire slug active.
            assert_eq!(
                task_codes(&board),
                if visible || index == 0 {
                    vec!["TSK-mix"]
                } else {
                    vec![]
                },
            );
            assert_eq!(board["columns"], board_before["columns"]);
        }
        let with_retired: Value = server
            .get("/api/vault/board")
            .add_query_param("include_retired", "true")
            .await
            .json();
        assert_eq!(with_retired["tasks"], board_before["tasks"]);
        assert_eq!(server.get(task_url).await.json::<Value>(), task_before);
        assert_eq!(server.get(notes_url).await.json::<Value>(), notes_before);
    }
}
