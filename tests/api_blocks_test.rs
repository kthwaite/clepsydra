mod support;

use std::path::Path;
use std::sync::Arc;

use axum::http::StatusCode;
use axum_test::TestServer;
use tokio::sync::broadcast;

use clepsydra::api::AppState;
use clepsydra::api::events::SyncNotification;
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

    let SyncNotification::IndexChanged { upserted, removed } = recv_change(&mut changes).await;
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
