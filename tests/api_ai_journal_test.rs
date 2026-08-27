mod support;

use std::sync::Arc;

use axum::http::StatusCode;
use axum_test::TestServer;
use chrono::{DateTime, Utc};
use tempfile::TempDir;

use clepsydra::api::Clock;
use support::ApiFixture;

const FIXED_NOW: &str = "2042-05-17T23:59:59Z";
const PROTECTED_ID: &str = "019fd000-0000-7000-8000-000000000410";
const KEY_ID: &str = "019fd000-0000-7000-8000-000000000002";
const ARMOR: &str = include_str!("support/fixtures/private-note.age");

#[derive(Debug)]
struct FixedClock(DateTime<Utc>);

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

fn fixed_now() -> DateTime<Utc> {
    FIXED_NOW.parse().unwrap()
}

fn fixture_builder() -> support::ApiFixtureBuilder {
    ApiFixture::builder().clock(Arc::new(FixedClock(fixed_now())))
}

fn setup_server() -> (TestServer, TempDir) {
    fixture_builder().build().into_server_and_temp()
}

fn today_str() -> String {
    fixed_now().format("%Y-%m-%d").to_string()
}

fn protected_ai_journal_page(id: &str, title: &str) -> String {
    format!(
        "+++\nid = \"{id}\"\ntitle = \"{title}\"\nencryption = {{ format = \"age\", version = 1, key_id = \"{KEY_ID}\" }}\n+++\n{ARMOR}"
    )
}

// ---------------------------------------------------------------------------
// 1. ensure is idempotent and lands in ai-journals/
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ensure_is_idempotent_and_lands_in_ai_journals() {
    let (server, _tmp) = setup_server();
    let today = today_str();

    let first = server.post("/api/vault/ai-journal/today").await;
    first.assert_status(StatusCode::CREATED);
    let first_body: serde_json::Value = first.json();
    let path = first_body["path"].as_str().unwrap().to_string();
    assert!(
        path.starts_with("ai-journals/"),
        "AI journal path was: {path}"
    );
    assert_eq!(first_body["meta"]["title"].as_str().unwrap(), today);

    let second = server.post("/api/vault/ai-journal/today").await;
    second.assert_status_ok(); // 200, not 201
    let second_body: serde_json::Value = second.json();
    assert_eq!(second_body["path"].as_str().unwrap(), path);
}

// ---------------------------------------------------------------------------
// 2. GET today 404s when absent, and ignores an existing HUMAN journal
// ---------------------------------------------------------------------------

#[tokio::test]
async fn get_today_404s_when_absent() {
    let (server, _tmp) = setup_server();

    // Seed a HUMAN journal for today; it must not satisfy the AI stream.
    server
        .post("/api/vault/journal/today")
        .await
        .assert_status(StatusCode::CREATED);

    server
        .get("/api/vault/ai-journal/today")
        .await
        .assert_status(StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------------
// 3. capture formats prose with author
// ---------------------------------------------------------------------------

#[tokio::test]
async fn capture_formats_prose_with_author() {
    let (server, _tmp) = setup_server();

    let res = server
        .post("/api/vault/ai-journal/today/capture")
        .json(&serde_json::json!({ "content": "did a thing", "author": "claude-code" }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let text = body["body"].as_str().unwrap();
    assert!(
        text.contains("- 23:59 — [claude-code] did a thing"),
        "expected stamped, attributed line, got: {text}"
    );
}

// ---------------------------------------------------------------------------
// 4. capture without author matches human shape
// ---------------------------------------------------------------------------

#[tokio::test]
async fn capture_without_author_matches_human_shape() {
    let (server, _tmp) = setup_server();

    let res = server
        .post("/api/vault/ai-journal/today/capture")
        .json(&serde_json::json!({ "content": "plain note" }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let text = body["body"].as_str().unwrap();
    assert!(
        text.contains("- 23:59 — plain note"),
        "expected unattributed stamped line, got: {text}"
    );
}

// ---------------------------------------------------------------------------
// 5. capture of a block construct passes through verbatim, unattributed
// ---------------------------------------------------------------------------

#[tokio::test]
async fn capture_block_construct_passes_verbatim_unattributed() {
    let (server, _tmp) = setup_server();

    let res = server
        .post("/api/vault/ai-journal/today/capture")
        .json(&serde_json::json!({ "content": "- [ ] a task", "author": "claude-code" }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let text = body["body"].as_str().unwrap();
    assert!(
        text.contains("- [ ] a task"),
        "block construct should pass through verbatim, got: {text}"
    );
    assert!(
        !text.contains("claude-code"),
        "block construct must not be attributed, got: {text}"
    );
    assert!(
        !text.contains("23:59"),
        "block construct must not be stamped, got: {text}"
    );
}

// ---------------------------------------------------------------------------
// 6. capture rejects bad authors, leaving the page untouched
// ---------------------------------------------------------------------------

#[tokio::test]
async fn capture_rejects_bad_author() {
    let (server, _tmp) = setup_server();

    let bad_authors = ["", "  ", "a\nb", &"x".repeat(65)];
    for author in bad_authors {
        let res = server
            .post("/api/vault/ai-journal/today/capture")
            .json(&serde_json::json!({ "content": "should not land", "author": author }))
            .await;
        res.assert_status(StatusCode::BAD_REQUEST);
    }

    // No page was ever created.
    server
        .get("/api/vault/ai-journal/today")
        .await
        .assert_status(StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------------
// 7. capture 409s on an encrypted page
// ---------------------------------------------------------------------------

#[tokio::test]
async fn capture_409_on_encrypted_page() {
    let today = today_str();
    let today_clone = today.clone();
    let fixture = ApiFixture::builder()
        .clock(Arc::new(FixedClock(fixed_now())))
        .pre_index_seed(move |root| {
            std::fs::create_dir_all(root.join("ai-journals")).unwrap();
            std::fs::write(
                root.join(format!("ai-journals/{today_clone}.md")),
                protected_ai_journal_page(PROTECTED_ID, &today_clone),
            )
            .unwrap();
        })
        .build();

    let response = fixture
        .server
        .post("/api/vault/ai-journal/today/capture")
        .json(&serde_json::json!({ "content": "must not be appended" }))
        .await;
    response.assert_status(StatusCode::CONFLICT);
    let error: serde_json::Value = response.json();
    assert!(
        error["error"]
            .as_str()
            .is_some_and(|message| message.contains("protected")),
        "unexpected error: {error}"
    );
}

// ---------------------------------------------------------------------------
// 8. range/recent see only AI pages, and vice versa
// ---------------------------------------------------------------------------

#[tokio::test]
async fn range_and_recent_see_only_ai_pages() {
    let (server, _tmp) = setup_server();
    let today = today_str();

    let human = server.post("/api/vault/journal/today").await;
    human.assert_status(StatusCode::CREATED);
    let human_path = human.json::<serde_json::Value>()["path"]
        .as_str()
        .unwrap()
        .to_string();

    let ai = server.post("/api/vault/ai-journal/today").await;
    ai.assert_status(StatusCode::CREATED);
    let ai_path = ai.json::<serde_json::Value>()["path"]
        .as_str()
        .unwrap()
        .to_string();

    let ai_recent: serde_json::Value = server
        .get("/api/vault/ai-journal/recent?days=7")
        .await
        .json();
    let ai_recent_items = ai_recent.as_array().unwrap();
    assert_eq!(ai_recent_items.len(), 1);
    assert_eq!(ai_recent_items[0]["path"].as_str().unwrap(), ai_path);

    let ai_range: serde_json::Value = server
        .get(&format!(
            "/api/vault/ai-journal/range?from={today}&to={today}"
        ))
        .await
        .json();
    let ai_range_items = ai_range.as_array().unwrap();
    assert_eq!(ai_range_items.len(), 1);
    assert_eq!(ai_range_items[0]["path"].as_str().unwrap(), ai_path);

    // Regression lock: the human stream must still see only the human page.
    let human_recent: serde_json::Value =
        server.get("/api/vault/journal/recent?days=7").await.json();
    let human_recent_items = human_recent.as_array().unwrap();
    assert_eq!(human_recent_items.len(), 1);
    assert_eq!(human_recent_items[0]["path"].as_str().unwrap(), human_path);
}

// ---------------------------------------------------------------------------
// 9. GET by date validates the date format
// ---------------------------------------------------------------------------

#[tokio::test]
async fn get_by_date_validates_format() {
    let (server, _tmp) = setup_server();
    server
        .get("/api/vault/ai-journal/2026-13-99")
        .await
        .assert_status(StatusCode::BAD_REQUEST);
}
