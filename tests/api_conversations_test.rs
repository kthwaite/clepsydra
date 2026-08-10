mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::http::StatusCode;
use axum_test::TestServer;
use chrono::{DateTime, Utc};
use clepsydra::api::{AppState, Clock};
use clepsydra::vault::conversation::{
    ConversationRole, ConversationTurn, host_identity_hash, prepare_transcript,
};
use clepsydra::vault::kind::Kind;
use clepsydra::vault::page::Page;
use clepsydra::vault::path::VaultPath;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::broadcast;

use support::ApiFixture;

const FIXED_NOW: &str = "2042-05-17T23:59:59Z";
const RAW_HOST_ID: &str = "raw-provider-id-must-not-persist";

#[derive(Debug)]
struct FixedClock(DateTime<Utc>);

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

fn fixture_builder() -> support::ApiFixtureBuilder {
    ApiFixture::builder().clock(Arc::new(FixedClock(FIXED_NOW.parse().unwrap())))
}

fn setup_server() -> (TestServer, TempDir) {
    fixture_builder().build().into_server_and_temp()
}

fn setup_server_with_state() -> (TestServer, TempDir, Arc<AppState>) {
    fixture_builder().build().into_parts()
}

fn payload(turns: Value) -> Value {
    json!({
        "title": "Conversation about capture semantics",
        "provider": "Claude",
        "host_conversation_id": RAW_HOST_ID,
        "turns": turns,
    })
}

fn turns(contents: &[(&str, &str)]) -> Value {
    Value::Array(
        contents
            .iter()
            .enumerate()
            .map(|(index, (role, content))| {
                json!({
                    "role": role,
                    "content": content,
                    "source_turn_id": format!("turn-{}", index + 1),
                })
            })
            .collect(),
    )
}

async fn capture(server: &TestServer, body: Value) -> (StatusCode, Value) {
    let response = server
        .post("/api/vault/conversations/capture")
        .json(&body)
        .await;
    let status = response.status_code();
    let body = serde_json::from_str(&response.text()).unwrap_or(Value::Null);
    (status, body)
}

fn files_under(root: &Path, folder: &str) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let folder = root.join(folder);
    if !folder.exists() {
        return files;
    }
    let mut pending = vec![folder];
    while let Some(path) = pending.pop() {
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

fn read_page(state: &AppState, path: &str) -> Page {
    let vault_path = VaultPath::new(path).unwrap();
    Page::from_file(&state.vault.resolve(&vault_path), vault_path).unwrap()
}

async fn recv_change(changes: &mut broadcast::Receiver<clepsydra::api::events::SyncNotification>) {
    tokio::time::timeout(std::time::Duration::from_secs(5), changes.recv())
        .await
        .expect("timed out waiting for mutation notification")
        .expect("notification channel closed");
}

#[tokio::test]
async fn creates_conversation_under_conversations_with_declared_kind() {
    let (server, tmp) = setup_server();
    let (status, body) = capture(&server, payload(turns(&[("user", "Hello")]))).await;
    assert_eq!(status, StatusCode::CREATED);
    let path = body["path"].as_str().unwrap();
    assert!(path.starts_with("conversations/"));
    assert_eq!(body["operation"], "created");
    assert_eq!(body["appended_turns"], 1);
    assert_eq!(body["skipped_turns"], 0);

    let file = tmp.path().join("vault").join(path);
    let page = Page::from_file(&file, VaultPath::new(path).unwrap()).unwrap();
    assert_eq!(page.meta.kind, Some(Kind::AiConversation));
    assert_eq!(page.meta.extra["conversation"]["provider"].as_str(), Some("claude"));
}

#[tokio::test]
async fn response_contains_provider_summary_and_counts() {
    let (server, _tmp) = setup_server();
    let (status, body) = capture(&server, payload(turns(&[("user", "Hello"), ("assistant", "Hi")]))).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["operation"], "created");
    assert_eq!(body["appended_turns"], 2);
    assert_eq!(body["skipped_turns"], 0);

    let detail: Value = server
        .get(&format!("/api/vault/pages/{}", body["path"].as_str().unwrap()))
        .await
        .json();
    assert_eq!(detail["conversation"]["provider"], "claude");
    let detail_serialized = serde_json::to_string(&detail).unwrap();
    assert!(!detail_serialized.contains("host_id_hash"));
    assert!(!detail_serialized.contains("captured_prefix_hash"));
}

#[tokio::test]
async fn raw_host_id_is_absent_from_file_and_response() {
    let (server, tmp) = setup_server();
    let (_status, body) = capture(&server, payload(turns(&[("user", "Hello")]))).await;
    let serialized = serde_json::to_string(&body).unwrap();
    assert!(!serialized.contains(RAW_HOST_ID));
    let path = body["path"].as_str().unwrap();
    let bytes = fs::read_to_string(tmp.path().join("vault").join(path)).unwrap();
    assert!(!bytes.contains(RAW_HOST_ID));
}

#[tokio::test]
async fn identical_recapture_is_unchanged_without_second_notification() {
    let (server, _tmp, state) = setup_server_with_state();
    let mut changes = state.change_tx.subscribe();
    let body = payload(turns(&[("user", "Hello")])) ;
    let (status, _created) = capture(&server, body.clone()).await;
    assert_eq!(status, StatusCode::CREATED);
    recv_change(&mut changes).await;
    let (status, unchanged) = capture(&server, body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(unchanged["operation"], "unchanged");
    assert_eq!(unchanged["appended_turns"], 0);
    assert_eq!(unchanged["skipped_turns"], 1);
    assert!(changes.try_recv().is_err());
}

#[tokio::test]
async fn complete_prefix_capture_appends_one_suffix_turn() {
    let (server, tmp) = setup_server();
    let (first_status, first) = capture(&server, payload(turns(&[("user", "Hello")]))).await;
    assert_eq!(first_status, StatusCode::CREATED);
    let (status, appended) = capture(
        &server,
        payload(turns(&[("user", "Hello"), ("assistant", "Hi")])) ,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(appended["operation"], "appended");
    assert_eq!(appended["appended_turns"], 1);
    assert_eq!(appended["skipped_turns"], 1);
    let bytes = fs::read_to_string(tmp.path().join("vault").join(first["path"].as_str().unwrap())).unwrap();
    assert!(bytes.contains("> Hi"));
}

#[tokio::test]
async fn edited_existing_body_remains_edited_after_append() {
    let (server, tmp, state) = setup_server_with_state();
    let (_status, first) = capture(&server, payload(turns(&[("user", "Hello")]))).await;
    let path = first["path"].as_str().unwrap();
    let page = read_page(&state, path);
    let edited = page.raw_content.replacen("> Hello", "> Hello (edited)", 1);
    fs::write(tmp.path().join("vault").join(path), edited).unwrap();
    let (status, appended) = capture(&server, payload(turns(&[("user", "Hello"), ("assistant", "Hi")]))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(appended["operation"], "appended");
    let bytes = fs::read_to_string(tmp.path().join("vault").join(path)).unwrap();
    assert!(bytes.contains("> Hello (edited)"));
    assert!(bytes.contains("> Hi"));
}

#[tokio::test]
async fn truncated_or_divergent_transcript_returns_conflict_without_writing() {
    let (server, tmp, state) = setup_server_with_state();
    let (_status, first) = capture(&server, payload(turns(&[("user", "Hello"), ("assistant", "Hi")]))).await;
    let path = first["path"].as_str().unwrap();
    let original = fs::read(tmp.path().join("vault").join(path)).unwrap();
    let (status, _) = capture(&server, payload(turns(&[("user", "Hello")]))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(fs::read(tmp.path().join("vault").join(path)).unwrap(), original);
    let (status, _) = capture(&server, payload(turns(&[("user", "Different"), ("assistant", "Hi")]))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(fs::read(tmp.path().join("vault").join(path)).unwrap(), original);
    let _ = state;
}

#[tokio::test]
async fn no_host_id_creates_new_page_every_time() {
    let (server, tmp) = setup_server();
    let mut body = payload(turns(&[("user", "Hello")]));
    body.as_object_mut().unwrap().remove("host_conversation_id");
    let (first_status, first) = capture(&server, body.clone()).await;
    let (second_status, second) = capture(&server, body).await;
    assert_eq!(first_status, StatusCode::CREATED);
    assert_eq!(second_status, StatusCode::CREATED);
    assert_ne!(first["path"], second["path"]);
    assert_eq!(files_under(&tmp.path().join("vault"), "conversations").len(), 2);
}

#[tokio::test]
async fn invalid_requests_return_bad_request_without_artifacts() {
    let cases = [
        json!({"title":"Title", "host_conversation_id":RAW_HOST_ID, "turns":[{"role":"user","content":"Hello"}]}),
        json!({"title":"", "provider":"Claude", "turns":[{"role":"user","content":"Hello"}]}),
        json!({"title":"Title", "provider":"Claude", "turns":[]}),
        json!({"title":"Title", "provider":"Claude", "turns":[{"role":"user","content":" "}]}),
        json!({"title":"Title", "provider":"bad provider", "turns":[{"role":"user","content":"Hello"}]}),
    ];
    for (index, case) in cases.into_iter().enumerate() {
        let (server, tmp) = setup_server();
        let (status, _) = capture(&server, case).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "case {index}");
        assert!(files_under(&tmp.path().join("vault"), "conversations").is_empty());
    }
}

#[tokio::test]
async fn duplicate_exact_identity_pages_return_conflict() {
    let provider = "claude";
    let host_hash = host_identity_hash(provider, RAW_HOST_ID).unwrap();
    let transcript = prepare_transcript(
        Some(provider),
        Some(host_hash.clone()),
        &[ConversationTurn { role: ConversationRole::User, content: "Hello".into(), source_turn_id: Some("turn-1".into()), timestamp: None }],
    )
    .unwrap();
    let ledger = toml::Value::try_from(&transcript.ledger).unwrap();
    let captured_turn_count = ledger["captured_turn_count"].as_integer().unwrap();
    let captured_prefix_hash = ledger["captured_prefix_hash"].as_str().unwrap().to_owned();
    let last_source_identity = ledger["last_source_identity"].as_str().unwrap().to_owned();
    let source_identity = transcript.turns[0].source_identity.clone();
    let page = move |id: &str| format!(
        "+++\nid = \"{id}\"\ntitle = \"Conversation about capture semantics\"\ntype = \"AI_CONVERSATION\"\n[conversation]\nprovider = \"claude\"\nhost_id_hash = \"{host_hash}\"\ncaptured_turn_count = {captured_turn_count}\ncaptured_prefix_hash = \"{captured_prefix_hash}\"\nlast_source_identity = \"{last_source_identity}\"\n+++\n> [!AI-USER source={source_identity} sequence=1]\n> Hello\n",
    );
    let (server, _tmp) = fixture_builder().pre_index_seed(move |root| {
        fs::create_dir_all(root.join("conversations")).unwrap();
        fs::write(root.join("conversations/one.md"), page("01951234-0000-7000-8000-000000000001")).unwrap();
        fs::write(root.join("conversations/two.md"), page("01951234-0000-7000-8000-000000000002")).unwrap();
    }).build().into_server_and_temp();
    let (status, _) = capture(&server, payload(turns(&[("user", "Hello")]))).await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn protected_matching_page_returns_conflict() {
    let provider = "claude";
    let host_hash = host_identity_hash(provider, RAW_HOST_ID).unwrap();
    let transcript = prepare_transcript(
        Some(provider), Some(host_hash.clone()),
        &[ConversationTurn { role: ConversationRole::User, content: "Hello".into(), source_turn_id: Some("turn-1".into()), timestamp: None }],
    ).unwrap();
    let ledger = &transcript.ledger;
    let armor = include_str!("support/fixtures/private-note.age");
    let page = format!(
        "+++\nid = \"01951234-0000-7000-8000-000000000003\"\ntitle = \"Protected\"\ntype = \"AI_CONVERSATION\"\nencryption = {{ format = \"age\", version = 1, key_id = \"019fd000-0000-7000-8000-000000000002\" }}\n[conversation]\nprovider = \"claude\"\nhost_id_hash = \"{host_hash}\"\ncaptured_turn_count = {}\ncaptured_prefix_hash = \"{}\"\nlast_source_identity = \"{}\"\n+++\n{armor}",
        ledger.captured_turn_count, ledger.captured_prefix_hash, ledger.last_source_identity
    );
    let (server, _tmp) = fixture_builder().pre_index_seed(move |root| {
        fs::create_dir_all(root.join("conversations")).unwrap();
        fs::write(root.join("conversations/protected.md"), page).unwrap();
    }).build().into_server_and_temp();
    let (status, _) = capture(&server, payload(turns(&[("user", "Hello")]))).await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn concurrent_first_captures_for_identity_do_not_duplicate() {
    let fixture = fixture_builder().build();
    let server_left = TestServer::new(fixture.app.clone()).unwrap();
    let server_right = TestServer::new(fixture.app.clone()).unwrap();
    let tmp = fixture.temp_dir;
    let body = payload(turns(&[("user", "Hello")]));
    let (first, second) = tokio::join!(
        capture(&server_left, body.clone()),
        capture(&server_right, body)
    );
    assert!([first.0, second.0]
        .iter()
        .all(|status| *status == StatusCode::CREATED || *status == StatusCode::OK));
    let operations = [
        first.1["operation"].as_str().unwrap(),
        second.1["operation"].as_str().unwrap(),
    ];
    println!("concurrent responses: {:?} {:?}, ops {:?}", first.1, second.1, operations);
    assert!(operations.iter().any(|operation| *operation == "created"));
    assert!(operations
        .iter()
        .any(|operation| *operation == "unchanged" || *operation == "appended"));
    assert_eq!(files_under(&tmp.path().join("vault"), "conversations").len(), 1);
}
