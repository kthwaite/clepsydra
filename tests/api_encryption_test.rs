mod support;

use std::fs;
use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use clepsydra::vault::page::{Page, page_revision};
use clepsydra::vault::path::VaultPath;
use serde_json::{Value, json};
use support::ApiFixture;

const PLAIN_ID: &str = "019fd000-0000-7000-8000-000000000401";
const PROTECTED_ID: &str = "019fd000-0000-7000-8000-000000000402";
const INVALID_ARMOR_ID: &str = "019fd000-0000-7000-8000-000000000403";
const KEY_ID: &str = "019fd000-0000-7000-8000-000000000002";
const UNKNOWN_ID: &str = "019fd000-0000-7000-8000-000000000499";
const ARMOR: &str = include_str!("support/fixtures/private-note.age");

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
