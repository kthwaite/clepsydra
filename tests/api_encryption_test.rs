mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::http::StatusCode;
use base64::prelude::{Engine as _, BASE64_STANDARD};
use chrono::{DateTime, Utc};
use clepsydra::api::openapi::ApiDoc;
use clepsydra::api::Clock;
use clepsydra::vault::keyring::MAX_WRAPPED_IDENTITY_BYTES;
use clepsydra::vault::page::{page_revision, Page};
use clepsydra::vault::path::VaultPath;
use serde_json::{json, Value};
use support::ApiFixture;
use utoipa::OpenApi;

const PLAIN_ID: &str = "019fd000-0000-7000-8000-000000000401";
const PROTECTED_ID: &str = "019fd000-0000-7000-8000-000000000402";
const INVALID_ARMOR_ID: &str = "019fd000-0000-7000-8000-000000000403";
const KEY_ID: &str = "019fd000-0000-7000-8000-000000000002";
const UNKNOWN_ID: &str = "019fd000-0000-7000-8000-000000000499";
const KEYRING_ID: &str = "019fd000-0000-7000-8000-000000000504";
const ARMOR: &str = include_str!("support/fixtures/private-note.age");
const FIXED_NOW: &str = "2026-08-07T12:00:00Z";

#[derive(Debug)]
struct FixedClock(DateTime<Utc>);

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

fn plain_page(id: &str, title: &str, body: &str) -> String {
    format!(
        "+++\nid = \"{id}\"\ntitle = \"{title}\"\ntags = [\"kept\"]\naliases = [\"Kept alias\"]\ncustom = \"preserved\"\n+++\n{body}"
    )
}

fn protected_page(id: &str, title: &str) -> String {
    format!(
        "+++\nid = \"{id}\"\ntitle = \"{title}\"\nencryption = {{ format = \"age\", version = 1, key_id = \"{KEY_ID}\" }}\n+++\n{ARMOR}"
    )
}

fn encryption_descriptor() -> Value {
    json!({ "format": "age", "version": 1, "key_id": KEY_ID })
}

fn keyring_recipient() -> String {
    format!("age1{}", "q".repeat(58))
}

fn armor_variant(marker: &[u8]) -> String {
    let mut decoded = b"age-encryption.org/v1\n".to_vec();
    decoded.extend_from_slice(marker);
    let encoded = BASE64_STANDARD.encode(decoded);
    let payload = encoded
        .as_bytes()
        .chunks(64)
        .map(|line| std::str::from_utf8(line).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    format!("-----BEGIN AGE ENCRYPTED FILE-----\n{payload}\n-----END AGE ENCRYPTED FILE-----\n")
}

fn cache_artifacts(db_path: &Path) -> [PathBuf; 3] {
    [
        db_path.to_path_buf(),
        PathBuf::from(format!("{}-wal", db_path.display())),
        PathBuf::from(format!("{}-shm", db_path.display())),
    ]
}

fn file_contains(path: &Path, needle: &[u8]) -> bool {
    fs::read(path)
        .map(|bytes| bytes.windows(needle.len()).any(|window| window == needle))
        .unwrap_or(false)
}

async fn get_json(fixture: &ApiFixture, path: &str) -> Value {
    let response = fixture.server.get(path).await;
    response.assert_status_ok();
    response.json()
}

#[tokio::test]
async fn detail_and_every_summary_source_expose_encryption_state() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::create_dir_all(root.join("notes")).unwrap();
            fs::write(
                root.join("notes/plain.md"),
                plain_page(PLAIN_ID, "Plain", "Visible body"),
            )
            .unwrap();
            fs::write(
                root.join("notes/protected.md"),
                protected_page(PROTECTED_ID, "Protected"),
            )
            .unwrap();
        })
        .post_index_mutation(|state| {
            fs::write(
                state.vault.root().join("notes/not-indexed.md"),
                plain_page(INVALID_ARMOR_ID, "Fallback", "Not indexed yet"),
            )
            .unwrap();
        })
        .build();

    let plain = get_json(&fixture, "/api/vault/pages/notes/plain.md").await;
    assert_eq!(plain["encrypted"], false);
    assert!(plain["encryption"].is_null());

    let protected = get_json(&fixture, "/api/vault/pages/notes/protected.md").await;
    assert_eq!(protected["encrypted"], true);
    assert_eq!(protected["encryption"], encryption_descriptor());
    assert_eq!(protected["body"], ARMOR);

    let listing = get_json(&fixture, "/api/vault/pages").await;
    let items = listing["items"].as_array().unwrap();
    assert_eq!(
        items.iter().find(|item| item["id"] == PLAIN_ID).unwrap()["encrypted"],
        false
    );
    assert_eq!(
        items
            .iter()
            .find(|item| item["id"] == PROTECTED_ID)
            .unwrap()["encrypted"],
        true
    );

    let folder = get_json(&fixture, "/api/vault/folders/notes").await;
    let pages = folder["pages"].as_array().unwrap();
    assert_eq!(
        pages
            .iter()
            .find(|item| item["id"] == PROTECTED_ID)
            .unwrap()["encrypted"],
        true
    );
    assert_eq!(
        pages
            .iter()
            .find(|item| item["path"] == "notes/not-indexed.md")
            .unwrap()["encrypted"],
        false
    );
}

#[tokio::test]
async fn encrypted_body_projections_are_absent_from_content_blocks_tasks_and_agenda() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::write(
                root.join("protected.md"),
                protected_page(PROTECTED_ID, "Protected"),
            )
            .unwrap();
        })
        .build();

    let content_index = get_json(&fixture, "/api/vault/index/content-index").await;
    let entry = content_index["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["path"] == "protected.md")
        .expect("protected page remains metadata-visible");
    assert_eq!(entry["description"], "");
    assert!(entry["word_count"].is_null());

    let listing = get_json(&fixture, "/api/vault/pages").await;
    assert_eq!(
        listing["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == PROTECTED_ID)
            .unwrap()["encrypted"],
        true
    );

    let blocks = get_json(&fixture, "/api/vault/blocks/search?q=AGE").await;
    assert_eq!(blocks, json!([]));
    let tasks = get_json(&fixture, "/api/vault/tasks").await;
    assert_eq!(tasks["tasks"], json!([]));
    let agenda = get_json(&fixture, "/api/vault/agenda?today=2026-08-26").await;
    assert_eq!(
        agenda,
        json!({
            "overdue": [],
            "today": [],
            "upcoming": [],
            "undated": []
        })
    );
}

#[tokio::test]
async fn board_task_excerpt_is_null_for_encrypted_body_and_leaks_no_ciphertext() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::create_dir_all(root.join("tasks")).unwrap();
            fs::write(
                root.join("tasks/TSK-0402.md"),
                format!(
                    "+++\nid = \"{PROTECTED_ID}\"\ntitle = \"Protected task\"\ntype = \"TASK\"\n\
                     encryption = {{ format = \"age\", version = 1, key_id = \"{KEY_ID}\" }}\n+++\n\
                     {ARMOR}"
                ),
            )
            .unwrap();
        })
        .build();

    let board = get_json(&fixture, "/api/vault/board").await;
    let task = board["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["id"] == PROTECTED_ID)
        .expect("encrypted TASK remains metadata-visible");

    assert!(task.get("body_excerpt").is_some());
    assert!(task["body_excerpt"].is_null());
    let serialized = serde_json::to_string(&board).unwrap();
    assert!(!serialized.contains("BEGIN AGE ENCRYPTED FILE"));
    assert!(!serialized.contains("YWdlLWVuY3J5cHRpb24"));
}

#[tokio::test]
async fn encrypted_block_and_task_mutations_fail_with_a_protected_page_conflict() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::write(
                root.join("protected.md"),
                protected_page(PROTECTED_ID, "Protected"),
            )
            .unwrap();
        })
        .build();
    let original = fs::read(fixture.state.vault.root().join("protected.md")).unwrap();

    for response in [
        fixture
            .server
            .post("/api/vault/blocks/assign-id")
            .json(&json!({ "page_path": "protected.md", "span_start": 0 }))
            .await,
        fixture
            .server
            .put("/api/vault/tasks/status")
            .json(&json!({
                "page_path": "protected.md",
                "span_start": 0,
                "status": "done",
            }))
            .await,
    ] {
        response.assert_status(StatusCode::CONFLICT);
        let error: Value = response.json();
        assert!(
            error["error"]
                .as_str()
                .is_some_and(|message| message.contains("protected")),
            "unexpected mutation error: {error}"
        );
    }

    assert_eq!(
        fs::read(fixture.state.vault.root().join("protected.md")).unwrap(),
        original
    );
}

#[tokio::test]
async fn encrypted_journal_rejects_capture_without_touching_armor() {
    let now: DateTime<Utc> = FIXED_NOW.parse().unwrap();
    let fixture = ApiFixture::builder()
        .clock(Arc::new(FixedClock(now)))
        .pre_index_seed(|root| {
            fs::create_dir_all(root.join("journals")).unwrap();
            fs::write(
                root.join("journals/2026-08-07.md"),
                protected_page(PROTECTED_ID, "2026-08-07"),
            )
            .unwrap();
        })
        .build();
    let path = fixture.state.vault.root().join("journals/2026-08-07.md");
    let original = fs::read(&path).unwrap();

    let response = fixture
        .server
        .post("/api/vault/journal/today/capture")
        .json(&json!({ "content": "must not be appended" }))
        .await;
    response.assert_status(StatusCode::CONFLICT);
    let error: Value = response.json();
    assert!(
        error["error"]
            .as_str()
            .is_some_and(|message| message.contains("protected")),
        "unexpected capture error: {error}"
    );
    assert_eq!(fs::read(path).unwrap(), original);
}

#[tokio::test]
async fn protect_by_uuid_is_revision_locked_atomic_and_clears_plaintext_projections() {
    const LEAKED_BODY: &str =
        "LEAKED_SECRET_BODY\n- private block ^secret1234\n[[Leaked Target]]\n";
    let fixture = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::write(
                root.join("plain.md"),
                plain_page(PLAIN_ID, "Plain", LEAKED_BODY),
            )
            .unwrap();
            fs::write(
                root.join("invalid.md"),
                plain_page(INVALID_ARMOR_ID, "Invalid", "Still plain"),
            )
            .unwrap();
        })
        .build();
    let root = fixture.state.vault.root();
    let db_path = root.join(".clepsydra/cache.db");
    assert!(
        cache_artifacts(&db_path)
            .iter()
            .any(|path| file_contains(path, b"LEAKED_SECRET_BODY")),
        "the plaintext marker must reach the cache before protection"
    );

    let before = get_json(&fixture, "/api/vault/pages/plain.md").await;
    let revision = before["revision"].as_str().unwrap();
    let response = fixture
        .server
        .post(&format!("/api/vault/pages/by-id/{PLAIN_ID}/protect"))
        .json(&json!({
            "expected_revision": revision,
            "encryption": encryption_descriptor(),
            "body": ARMOR,
        }))
        .await;
    response.assert_status_ok();
    let protected: Value = response.json();
    assert_eq!(protected["encrypted"], true);
    assert_eq!(protected["encryption"], encryption_descriptor());
    assert_eq!(protected["body"], ARMOR);

    let raw = fs::read_to_string(root.join("plain.md")).unwrap();
    assert_eq!(protected["revision"], page_revision(&raw));
    let page =
        Page::from_file(&root.join("plain.md"), VaultPath::new("plain.md").unwrap()).unwrap();
    assert!(page.is_encrypted());
    assert_eq!(page.body, ARMOR);
    assert_eq!(page.meta.title.as_deref(), Some("Plain"));
    assert_eq!(page.meta.tags, ["kept"]);
    assert_eq!(page.meta.aliases, ["Kept alias"]);
    assert_eq!(page.meta.extra["custom"].as_str(), Some("preserved"));

    let (encrypted, fts_body, blocks, links): (i64, String, i64, i64) = fixture
        .state
        .index
        .with_index(|index, _vault| {
            let encrypted = index
                .connection()
                .query_row(
                    "SELECT encrypted FROM pages WHERE id = ?1",
                    [PLAIN_ID],
                    |row| row.get(0),
                )
                .unwrap();
            let fts_body = index
                .connection()
                .query_row(
                    "SELECT body FROM pages_fts WHERE page_id = ?1",
                    [PLAIN_ID],
                    |row| row.get(0),
                )
                .unwrap();
            let blocks = index
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM blocks WHERE page_id = ?1",
                    [PLAIN_ID],
                    |row| row.get(0),
                )
                .unwrap();
            let leaked_links = index
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM links WHERE source_id = ?1 AND target_raw = ?2",
                    [PLAIN_ID, "Leaked Target"],
                    |row| row.get(0),
                )
                .unwrap();
            (encrypted, fts_body, blocks, leaked_links)
        })
        .await
        .unwrap();
    assert_eq!((encrypted, fts_body.as_str(), blocks, links), (1, "", 0, 0));
    for path in cache_artifacts(&db_path) {
        assert!(
            !file_contains(&path, b"LEAKED_SECRET_BODY"),
            "the protect route left plaintext in {}",
            path.display()
        );
    }

    let protected_bytes = fs::read(root.join("plain.md")).unwrap();
    fixture
        .server
        .post(&format!("/api/vault/pages/by-id/{PLAIN_ID}/protect"))
        .json(&json!({
            "expected_revision": revision,
            "encryption": encryption_descriptor(),
            "body": ARMOR,
        }))
        .await
        .assert_status(StatusCode::CONFLICT);
    assert_eq!(fs::read(root.join("plain.md")).unwrap(), protected_bytes);

    let invalid_before = get_json(&fixture, "/api/vault/pages/invalid.md").await;
    let invalid_bytes = fs::read(root.join("invalid.md")).unwrap();
    fixture
        .server
        .post(&format!(
            "/api/vault/pages/by-id/{INVALID_ARMOR_ID}/protect"
        ))
        .json(&json!({
            "expected_revision": invalid_before["revision"],
            "encryption": encryption_descriptor(),
            "body": "plaintext is not age armor",
        }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    assert_eq!(fs::read(root.join("invalid.md")).unwrap(), invalid_bytes);

    fixture
        .server
        .post(&format!("/api/vault/pages/by-id/{UNKNOWN_ID}/protect"))
        .json(&json!({
            "expected_revision": "0".repeat(64),
            "encryption": encryption_descriptor(),
            "body": ARMOR,
        }))
        .await
        .assert_status(StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn unprotect_by_uuid_accepts_authenticated_plaintext_and_reindexes_it() {
    const PLAINTEXT: &str = "AUTHENTICATED_PLAINTEXT_BODY\n- restored block ^restored12\n";
    let fixture = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::write(
                root.join("protected.md"),
                protected_page(PROTECTED_ID, "Protected"),
            )
            .unwrap();
        })
        .build();
    let root = fixture.state.vault.root();
    let before = get_json(&fixture, "/api/vault/pages/protected.md").await;
    let old_revision = before["revision"].as_str().unwrap();

    let response = fixture
        .server
        .post(&format!("/api/vault/pages/by-id/{PROTECTED_ID}/unprotect"))
        .json(&json!({
            "expected_revision": old_revision,
            "body": PLAINTEXT,
        }))
        .await;
    response.assert_status_ok();
    let plain: Value = response.json();
    assert_eq!(plain["encrypted"], false);
    assert!(plain["encryption"].is_null());
    assert_eq!(plain["body"], PLAINTEXT);

    let page = Page::from_file(
        &root.join("protected.md"),
        VaultPath::new("protected.md").unwrap(),
    )
    .unwrap();
    assert!(!page.is_encrypted());
    assert_eq!(page.body, PLAINTEXT);
    assert_eq!(plain["revision"], page_revision(&page.raw_content));

    let (encrypted, fts_body, blocks): (i64, String, i64) = fixture
        .state
        .index
        .with_index(|index, _vault| {
            let encrypted = index
                .connection()
                .query_row(
                    "SELECT encrypted FROM pages WHERE id = ?1",
                    [PROTECTED_ID],
                    |row| row.get(0),
                )
                .unwrap();
            let fts_body = index
                .connection()
                .query_row(
                    "SELECT body FROM pages_fts WHERE page_id = ?1",
                    [PROTECTED_ID],
                    |row| row.get(0),
                )
                .unwrap();
            let blocks = index
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM blocks WHERE page_id = ?1",
                    [PROTECTED_ID],
                    |row| row.get(0),
                )
                .unwrap();
            (encrypted, fts_body, blocks)
        })
        .await
        .unwrap();
    assert_eq!(encrypted, 0);
    assert_eq!(fts_body, PLAINTEXT);
    assert!(blocks > 0);

    let plain_bytes = fs::read(root.join("protected.md")).unwrap();
    fixture
        .server
        .post(&format!("/api/vault/pages/by-id/{PROTECTED_ID}/unprotect"))
        .json(&json!({
            "expected_revision": old_revision,
            "body": "stale replacement",
        }))
        .await
        .assert_status(StatusCode::CONFLICT);
    assert_eq!(fs::read(root.join("protected.md")).unwrap(), plain_bytes);

    fixture
        .server
        .post(&format!("/api/vault/pages/by-id/{UNKNOWN_ID}/unprotect"))
        .json(&json!({
            "expected_revision": "0".repeat(64),
            "body": "unknown",
        }))
        .await
        .assert_status(StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn regular_updates_fail_closed_for_protected_bodies_but_allow_metadata() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::write(
                root.join("protected.md"),
                protected_page(PROTECTED_ID, "Protected"),
            )
            .unwrap();
        })
        .build();
    let root = fixture.state.vault.root();
    let detail = get_json(&fixture, "/api/vault/pages/protected.md").await;
    let revision = detail["revision"].as_str().unwrap();
    let original = fs::read(root.join("protected.md")).unwrap();

    fixture
        .server
        .put("/api/vault/pages/protected.md")
        .json(&json!({
            "expected_revision": revision,
            "body": "plaintext",
        }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    assert_eq!(fs::read(root.join("protected.md")).unwrap(), original);

    fixture
        .server
        .put(&format!("/api/vault/pages/by-id/{PROTECTED_ID}"))
        .json(&json!({
            "expected_revision": revision,
            "body": "plaintext",
        }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    assert_eq!(fs::read(root.join("protected.md")).unwrap(), original);

    let response = fixture
        .server
        .put("/api/vault/pages/protected.md")
        .json(&json!({
            "expected_revision": revision,
            "title": "Metadata changed",
        }))
        .await;
    response.assert_status_ok();
    let updated: Value = response.json();
    assert_eq!(updated["encrypted"], true);
    assert_eq!(updated["encryption"], encryption_descriptor());
    assert_eq!(updated["body"], ARMOR);
    let page = Page::from_file(
        &root.join("protected.md"),
        VaultPath::new("protected.md").unwrap(),
    )
    .unwrap();
    assert_eq!(page.meta.title.as_deref(), Some("Metadata changed"));
    assert_eq!(page.body, ARMOR);
}

#[tokio::test]
async fn keyring_setup_read_duplicate_and_revision_locked_rewrap_contract() {
    let fixture = ApiFixture::builder().build();
    let recipient = keyring_recipient();

    let initial = get_json(&fixture, "/api/vault/encryption").await;
    assert_eq!(
        initial,
        json!({
            "initialized": false,
            "key_id": null,
            "recipient": null,
            "wrapped_identity": null,
            "revision": null,
        })
    );

    let response = fixture
        .server
        .post("/api/vault/encryption/setup")
        .json(&json!({
            "key_id": KEYRING_ID,
            "recipient": recipient,
            "wrapped_identity": ARMOR,
        }))
        .await;
    response.assert_status(StatusCode::CREATED);
    let created: Value = response.json();
    assert_eq!(created["initialized"], true);
    assert_eq!(created["key_id"], KEYRING_ID);
    assert_eq!(created["recipient"], keyring_recipient());
    assert_eq!(created["wrapped_identity"], ARMOR);
    assert_eq!(created["revision"].as_str().unwrap().len(), 64);
    assert!(created.get("keys").is_none());
    assert!(created.get("wrapped_identity_file").is_none());
    assert_eq!(get_json(&fixture, "/api/vault/encryption").await, created);

    fixture
        .server
        .post("/api/vault/encryption/setup")
        .json(&json!({
            "key_id": KEYRING_ID,
            "recipient": keyring_recipient(),
            "wrapped_identity": ARMOR,
        }))
        .await
        .assert_status(StatusCode::CONFLICT);

    let replacement = armor_variant(b"password changed");
    let stale = fixture
        .server
        .put("/api/vault/encryption/wrapped-identity")
        .json(&json!({
            "expected_revision": "0".repeat(64),
            "wrapped_identity": replacement,
        }))
        .await;
    stale.assert_status(StatusCode::CONFLICT);
    let stale_error: Value = stale.json();
    assert_eq!(
        stale_error["detail"]["current_revision"],
        created["revision"]
    );
    assert_eq!(get_json(&fixture, "/api/vault/encryption").await, created);

    let response = fixture
        .server
        .put("/api/vault/encryption/wrapped-identity")
        .json(&json!({
            "expected_revision": created["revision"],
            "wrapped_identity": replacement,
        }))
        .await;
    response.assert_status_ok();
    let rewrapped: Value = response.json();
    assert_eq!(rewrapped["initialized"], true);
    assert_eq!(rewrapped["key_id"], KEYRING_ID);
    assert_eq!(rewrapped["recipient"], keyring_recipient());
    assert_eq!(rewrapped["wrapped_identity"], replacement);
    assert_ne!(rewrapped["revision"], created["revision"]);
}

#[tokio::test]
async fn keyring_endpoints_validate_public_inputs_and_wrapped_armor() {
    let fixture = ApiFixture::builder().build();

    fixture
        .server
        .put("/api/vault/encryption/wrapped-identity")
        .json(&json!({
            "expected_revision": "0".repeat(64),
            "wrapped_identity": ARMOR,
        }))
        .await
        .assert_status(StatusCode::NOT_FOUND);

    for request in [
        json!({
            "key_id": "../escape",
            "recipient": keyring_recipient(),
            "wrapped_identity": ARMOR,
        }),
        json!({
            "key_id": KEYRING_ID,
            "recipient": "not-an-age-recipient",
            "wrapped_identity": ARMOR,
        }),
        json!({
            "key_id": KEYRING_ID,
            "recipient": keyring_recipient(),
            "wrapped_identity": "SENSITIVE_INVALID_ARMOR",
        }),
    ] {
        fixture
            .server
            .post("/api/vault/encryption/setup")
            .json(&request)
            .await
            .assert_status(StatusCode::BAD_REQUEST);
    }

    fixture
        .server
        .post("/api/vault/encryption/setup")
        .json(&json!({
            "key_id": KEYRING_ID,
            "recipient": keyring_recipient(),
            "wrapped_identity": "x".repeat(MAX_WRAPPED_IDENTITY_BYTES + 1),
        }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);

    fixture
        .server
        .post("/api/vault/encryption/setup")
        .json(&json!({
            "key_id": KEYRING_ID,
            "recipient": keyring_recipient(),
            "wrapped_identity": ARMOR,
            "password": "must never be accepted",
        }))
        .await
        .assert_status(StatusCode::UNPROCESSABLE_ENTITY);

    assert!(!fixture
        .state
        .vault
        .root()
        .join("escape.identity.age")
        .exists());
    assert!(!fixture
        .state
        .vault
        .root()
        .join(".clepsydra/crypto/keyring.toml")
        .exists());
}

#[test]
fn keyring_openapi_has_only_wrapped_identity_not_unlock_secrets() {
    let spec = serde_json::to_value(ApiDoc::openapi()).unwrap();
    for path in [
        "/api/vault/encryption",
        "/api/vault/encryption/setup",
        "/api/vault/encryption/wrapped-identity",
    ] {
        assert!(spec["paths"].get(path).is_some(), "missing {path}");
    }

    let schemas = &spec["components"]["schemas"];
    let setup = &schemas["SetupEncryptionRequest"]["properties"];
    assert!(setup.get("key_id").is_some());
    assert!(setup.get("recipient").is_some());
    assert!(setup.get("wrapped_identity").is_some());
    let rewrap = &schemas["RewrapIdentityRequest"]["properties"];
    assert!(rewrap.get("expected_revision").is_some());
    assert!(rewrap.get("wrapped_identity").is_some());

    let request_schema_text = format!("{setup}{rewrap}").to_lowercase();
    for forbidden in [
        "password",
        "passphrase",
        "identity",
        "private_key",
        "plaintext",
    ] {
        assert!(setup.get(forbidden).is_none());
        assert!(rewrap.get(forbidden).is_none());
    }
    for forbidden in ["password", "passphrase", "private_key", "plaintext"] {
        assert!(
            !request_schema_text.contains(forbidden),
            "request schema exposed forbidden field: {forbidden}"
        );
    }
}
