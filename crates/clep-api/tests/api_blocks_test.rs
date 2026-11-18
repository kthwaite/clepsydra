mod support;

use std::path::Path;
use std::sync::Arc;

use axum::http::StatusCode;
use axum_test::TestServer;
use tokio::sync::broadcast;

use clep_api::api::AppState;
use clep_api::api::events::SyncNotification;
use tempfile::TempDir;

use support::ApiFixture;

fn setup_server_with_files(pre_index: impl FnOnce(&Path) + 'static) -> (TestServer, TempDir) {
    ApiFixture::builder()
        .pre_index_seed(pre_index)
        .build()
        .into_server_and_temp()
}

fn setup_server_with_state(
    pre_index: impl FnOnce(&Path) + 'static,
) -> (TestServer, TempDir, Arc<AppState>) {
    ApiFixture::builder()
        .pre_index_seed(pre_index)
        .build()
        .into_parts()
}

async fn recv_change(changes: &mut broadcast::Receiver<SyncNotification>) -> SyncNotification {
    tokio::time::timeout(std::time::Duration::from_secs(5), changes.recv())
        .await
        .expect("timed out waiting for index-change notification")
        .expect("index-change notification channel closed")
}

#[tokio::test]
async fn mutation_assign_id_emits_coordinator_notification() {
    let (server, _dir, state) = setup_server_with_state(|root| {
        std::fs::write(
            root.join("target.md"),
            "---\nid: 01951234-0000-7000-8000-000000000090\ntitle: Target\n---\n",
        )
        .unwrap();
        std::fs::write(
            root.join("page.md"),
            "---\ntitle: Test\n---\n- Notify [[Target]] this block\n",
        )
        .unwrap();
    });
    let search_response = server.get("/api/vault/blocks/search?q=Notify").await;
    let blocks: Vec<serde_json::Value> = search_response.json();
    let span_start = blocks[0]["span_start"].as_i64().unwrap();
    let mut changes = state.change_tx.subscribe();

    server
        .post("/api/vault/blocks/assign-id")
        .json(&serde_json::json!({
            "page_path": "page.md",
            "span_start": span_start
        }))
        .await
        .assert_status_ok();

    let SyncNotification::IndexChanged { upserted, removed } = recv_change(&mut changes).await
    else {
        panic!("expected IndexChanged")
    };
    assert_eq!(upserted, vec!["page.md"]);
    assert!(removed.is_empty());

    let outlinks: Vec<serde_json::Value> =
        server.get("/api/vault/index/outlinks/page.md").await.json();
    assert_eq!(outlinks.len(), 1);
    assert_eq!(outlinks[0]["target_raw"], "Target");
    assert_eq!(outlinks[0]["target_path"], "target.md");
    let backlinks: Vec<serde_json::Value> = server
        .get("/api/vault/index/backlinks/target.md")
        .await
        .json();
    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0]["source_path"], "page.md");
    assert!(
        changes.try_recv().is_err(),
        "block assignment must emit exactly one update notification"
    );
}

#[tokio::test]
async fn get_block_by_id_found() {
    let (server, _dir) = setup_server_with_files(|root| {
        std::fs::write(
            root.join("page.md"),
            "---\ntitle: Test\n---\n- Buy milk ^abc123DEF0a\n",
        )
        .unwrap();
    });

    let response = server.get("/api/vault/blocks/abc123DEF0a").await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    assert_eq!(body["block_id"], "abc123DEF0a");
    assert!(body["content"].as_str().unwrap().contains("Buy milk"));
    assert_eq!(body["page_path"], "page.md");
}

#[tokio::test]
async fn get_block_by_id_not_found() {
    let (server, _dir) = setup_server_with_files(|root| {
        std::fs::write(
            root.join("page.md"),
            "---\ntitle: Test\n---\nNo blocks here\n",
        )
        .unwrap();
    });

    let response = server.get("/api/vault/blocks/nonexistent1").await;
    response.assert_status_not_found();
}

#[tokio::test]
async fn search_blocks_by_content() {
    let (server, _dir) = setup_server_with_files(|root| {
        std::fs::write(
            root.join("page.md"),
            "---\ntitle: Test\n---\n- Buy milk ^abc123DEF0a\n- Walk the dog\n",
        )
        .unwrap();
    });

    let response = server.get("/api/vault/blocks/search?q=milk&limit=8").await;
    response.assert_status_ok();
    let body: Vec<serde_json::Value> = response.json();
    assert_eq!(body.len(), 1);
    assert!(body[0]["content"].as_str().unwrap().contains("milk"));
}

#[tokio::test]
async fn assign_block_id_to_block() {
    let (server, _dir) = setup_server_with_files(|root| {
        std::fs::write(
            root.join("page.md"),
            "---\ntitle: Test\n---\n- Untagged item\n",
        )
        .unwrap();
    });

    // First, find the block's span_start by searching
    let search_response = server.get("/api/vault/blocks/search?q=Untagged").await;
    search_response.assert_status_ok();
    let blocks: Vec<serde_json::Value> = search_response.json();
    assert_eq!(blocks.len(), 1);
    let span_start = blocks[0]["span_start"].as_i64().unwrap();

    // Assign an ID
    let assign_response = server
        .post("/api/vault/blocks/assign-id")
        .json(&serde_json::json!({
            "page_path": "page.md",
            "span_start": span_start
        }))
        .await;
    assign_response.assert_status_ok();

    let result: serde_json::Value = assign_response.json();
    let block_id = result["block_id"].as_str().unwrap();
    assert!(block_id.len() >= 10 && block_id.len() <= 12);

    // Verify the block is now fetchable by ID
    let get_response = server.get(&format!("/api/vault/blocks/{block_id}")).await;
    get_response.assert_status_ok();
}

#[tokio::test]
async fn assign_block_id_concurrently_preserves_every_successful_assignment() {
    let (server, dir) = setup_server_with_files(|root| {
        std::fs::write(
            root.join("page.md"),
            "---\ntitle: Test\n---\n- First untagged item\n- Second untagged item\n",
        )
        .unwrap();
    });

    let first_search = server
        .get("/api/vault/blocks/search?q=First%20untagged")
        .await;
    first_search.assert_status_ok();
    let first_blocks: Vec<serde_json::Value> = first_search.json();
    let first_span_start = first_blocks[0]["span_start"].as_i64().unwrap();

    let second_search = server
        .get("/api/vault/blocks/search?q=Second%20untagged")
        .await;
    second_search.assert_status_ok();
    let second_blocks: Vec<serde_json::Value> = second_search.json();
    let second_span_start = second_blocks[0]["span_start"].as_i64().unwrap();

    let first_request = server
        .post("/api/vault/blocks/assign-id")
        .json(&serde_json::json!({
            "page_path": "page.md",
            "span_start": first_span_start
        }));
    let second_request = server
        .post("/api/vault/blocks/assign-id")
        .json(&serde_json::json!({
            "page_path": "page.md",
            "span_start": second_span_start
        }));
    let (first_response, second_response) = tokio::join!(first_request, second_request);

    let first_status = first_response.status_code();
    let second_status = second_response.status_code();
    assert!(
        [first_status, second_status]
            .iter()
            .all(|status| matches!(*status, StatusCode::OK | StatusCode::CONFLICT))
            && (first_status == StatusCode::OK || second_status == StatusCode::OK),
        "expected two successes or one success plus one conflict, got {first_status} and {second_status}"
    );

    let first_id = (first_status == StatusCode::OK).then(|| {
        let body: serde_json::Value = first_response.json();
        body["block_id"].as_str().unwrap().to_owned()
    });
    let second_id = (second_status == StatusCode::OK).then(|| {
        let body: serde_json::Value = second_response.json();
        body["block_id"].as_str().unwrap().to_owned()
    });
    let content = std::fs::read_to_string(dir.path().join("vault/page.md")).unwrap();

    if let Some(id) = first_id {
        assert!(
            content.contains(&format!("First untagged item ^{id}")),
            "successful first assignment was lost: {content}"
        );
    }
    if let Some(id) = second_id {
        assert!(
            content.contains(&format!("Second untagged item ^{id}")),
            "successful second assignment was lost: {content}"
        );
    }
}

#[tokio::test]
async fn assign_block_id_rejects_stale_target_without_changing_content() {
    let (server, dir) = setup_server_with_files(|root| {
        std::fs::write(
            root.join("page.md"),
            "---\ntitle: Test\n---\n- Original untagged item\n",
        )
        .unwrap();
    });

    let search_response = server
        .get("/api/vault/blocks/search?q=Original%20untagged")
        .await;
    search_response.assert_status_ok();
    let blocks: Vec<serde_json::Value> = search_response.json();
    let span_start = blocks[0]["span_start"].as_i64().unwrap();

    let page_path = dir.path().join("vault/page.md");
    let changed_content =
        "---\ntitle: Test\n---\nPreface inserted after indexing.\n\n- Original untagged item\n";
    std::fs::write(&page_path, changed_content).unwrap();

    let response = server
        .post("/api/vault/blocks/assign-id")
        .json(&serde_json::json!({
            "page_path": "page.md",
            "span_start": span_start
        }))
        .await;

    response.assert_status(StatusCode::CONFLICT);
    assert_eq!(
        std::fs::read_to_string(page_path).unwrap(),
        changed_content,
        "stale assignment must leave the page unchanged"
    );
}

const ASSIGN_FRONT: &str = "+++\nid = \"01951234-0000-7000-8000-ccc000000003\"\ntitle = \"Assign\"\ncreated_at = 2026-01-01T00:00:00Z\nupdated_at = 2026-01-01T00:00:00Z\n+++\n";

fn setup_assign_page(front: String, body: &'static str) -> (TestServer, TempDir) {
    setup_server_with_files(move |root| {
        std::fs::write(root.join("page.md"), format!("{front}{body}")).unwrap();
    })
}

/// Returns the HTTP status and the `block_id` of the response (empty when the
/// response has none).
async fn assign_id_at(server: &TestServer, span_start: usize) -> (StatusCode, String) {
    let response = server
        .post("/api/vault/blocks/assign-id")
        .json(&serde_json::json!({ "page_path": "page.md", "span_start": span_start }))
        .await;
    let json: serde_json::Value = serde_json::from_str(&response.text()).unwrap_or_default();
    (
        response.status_code(),
        json["block_id"].as_str().unwrap_or_default().to_string(),
    )
}

fn assign_page_body(dir: &TempDir, front: &str) -> String {
    let content = std::fs::read_to_string(dir.path().join("vault/page.md")).unwrap();
    content
        .strip_prefix(front)
        .unwrap_or_else(|| panic!("frontmatter changed: {content:?}"))
        .to_string()
}

/// Regression: the id was inserted at the block's `span_end` minus one `\n`.
/// A tight list item's span covers its children and the blank line after the
/// list, and a heading's span covers a setext underline, so the id landed on
/// a child, on a blank line, or on the underline. `{id}` in the expected body
/// stands for the returned id; `content` is the block the id must resolve to.
#[tokio::test]
async fn assign_block_id_appends_to_the_blocks_own_text_line() {
    for (body, span_start, expected, content) in [
        // A parent item: its own line, not its last descendant's.
        (
            "- parent\n  - child\n    - grandchild\n",
            0,
            "- parent ^{id}\n  - child\n    - grandchild\n",
            "parent",
        ),
        (
            "- parent\n  - child\n    - grandchild\n",
            11,
            "- parent\n  - child ^{id}\n    - grandchild\n",
            "child",
        ),
        // Item text continued on a second line, then a child.
        (
            "- a\n  cont\n  - child\n",
            0,
            "- a\n  cont ^{id}\n  - child\n",
            "a cont",
        ),
        // A parent whose child is a fenced code block.
        (
            "- parent\n  ```\n  code\n  ```\n",
            0,
            "- parent ^{id}\n  ```\n  code\n  ```\n",
            "parent",
        ),
        // A parent inside a blockquote.
        (
            "> - parent\n>   - child\n",
            2,
            "> - parent ^{id}\n>   - child\n",
            "parent",
        ),
        // The last item of a list, followed by a blank line and a paragraph.
        ("- item\n\npara\n", 0, "- item ^{id}\n\npara\n", "item"),
        (
            "- one\n  - leaf\n\npara\n",
            8,
            "- one\n  - leaf ^{id}\n\npara\n",
            "leaf",
        ),
        // A definition-list definition followed by a blank line.
        (
            "term\n: def\n\npara\n",
            5,
            "term\n: def ^{id}\n\npara\n",
            "def",
        ),
        // A setext heading: the title line, not the underline.
        (
            "Title\n=====\n\npara\n",
            0,
            "Title ^{id}\n=====\n\npara\n",
            "Title",
        ),
        // An ATX heading with a closing sequence: before the closing hashes.
        ("# Title #\n", 0, "# Title ^{id} #\n", "Title"),
        // Trailing spaces and a missing final newline are kept.
        ("para  \n\nnext\n", 0, "para ^{id}  \n\nnext\n", "para"),
        ("- item", 0, "- item ^{id}", "item"),
        // Unchanged cases: a paragraph of two lines, a quote, a leaf item.
        (
            "one\ntwo\n\nnext\n",
            0,
            "one\ntwo ^{id}\n\nnext\n",
            "one two",
        ),
        ("> quote\n\nnext\n", 2, "> quote ^{id}\n\nnext\n", "quote"),
        ("- a\n- b\n", 4, "- a\n- b ^{id}\n", "b"),
    ] {
        let (server, dir) = setup_assign_page(ASSIGN_FRONT.to_string(), body);
        let (code, id) = assign_id_at(&server, span_start).await;
        assert_eq!(code, StatusCode::OK, "body: {body:?}");
        assert_eq!(
            assign_page_body(&dir, ASSIGN_FRONT),
            expected.replace("{id}", &id),
            "body: {body:?}"
        );
        let block: serde_json::Value = server.get(&format!("/api/vault/blocks/{id}")).await.json();
        assert_eq!(block["content"], content, "body: {body:?}");
        assert_eq!(block["span_start"], span_start, "body: {body:?}");
    }
}

/// Regression: in a CRLF page the id was inserted between the CR and the LF.
#[tokio::test]
async fn assign_block_id_keeps_crlf_line_endings() {
    let front = ASSIGN_FRONT.replace('\n', "\r\n");
    let (server, dir) = setup_assign_page(front.clone(), "- item\r\n- next\r\n");
    let blocks: Vec<serde_json::Value> = server.get("/api/vault/blocks/search?q=item").await.json();
    let span_start = blocks[0]["span_start"].as_u64().unwrap() as usize;

    let (code, id) = assign_id_at(&server, span_start).await;

    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        assign_page_body(&dir, &front),
        format!("- item ^{id}\r\n- next\r\n")
    );
}

/// Regression: a block that already had an id got a second one appended; the
/// first became part of the block's text and stopped resolving.
#[tokio::test]
async fn assign_block_id_returns_the_existing_id_without_writing() {
    for (body, span_start) in [
        ("- item ^abcdefghij\n", 0),
        ("- item ^abcdefghij\n  - child\n", 0),
        ("# Title ^abcdefghij\n", 0),
    ] {
        let (server, dir) = setup_assign_page(ASSIGN_FRONT.to_string(), body);
        let (code, id) = assign_id_at(&server, span_start).await;
        assert_eq!(code, StatusCode::OK, "body: {body:?}");
        assert_eq!(id, "abcdefghij", "body: {body:?}");
        assert_eq!(assign_page_body(&dir, ASSIGN_FRONT), body);
    }
}

/// Regression: an id appended to a closing code fence or to a closing `$$`
/// stops it closing, and the rest of the page becomes code or math. Such a
/// block is refused and the page is left alone.
#[tokio::test]
async fn assign_block_id_refuses_a_block_that_cannot_end_in_an_id() {
    for (body, span_start) in [
        ("```\ncode\n```\n\nafter\n", 0),
        ("~~~rust\ncode\n~~~\n", 0),
        ("    indented code\n\nafter\n", 4),
        ("$$\nx\n$$\n\nafter\n", 0),
    ] {
        let (server, dir) = setup_assign_page(ASSIGN_FRONT.to_string(), body);
        let (code, _) = assign_id_at(&server, span_start).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "body: {body:?}");
        assert_eq!(assign_page_body(&dir, ASSIGN_FRONT), body);
    }
}
