mod support;

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::keyring::setup_keyring;
use serde_json::{Value, json};
use support::ApiFixture;
use tracing::instrument::WithSubscriber as _;
use walkdir::WalkDir;

const MARKER: &str = "CLEPSYDRA_E2E_SECRET_7d4b3f9a_日本語_🔐";
const KEY_ID: &str = "019fd000-0000-7000-8000-000000000504";
const TYPESCRIPT_ARMOR: &str =
    include_str!("../ui/src/crypto/__tests__/fixtures/typescript-note.age");
const CLI_ARMOR: &str = include_str!("../ui/src/crypto/__tests__/fixtures/cli-note.age");

fn recipient() -> String {
    "age1x8q5k7397p3jwr4jjt2v428g2k8y5kkpy8gnj0hwrmvn8zujtfsq8lq7y7".to_string()
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

fn assert_tree_excludes(root: &Path, marker: &[u8]) {
    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if entry.file_type().is_file() {
            assert!(
                !file_contains(entry.path(), marker),
                "plaintext marker leaked into {}",
                entry.path().display()
            );
        }
    }
}

#[derive(Clone, Default)]
struct LogCapture(Arc<Mutex<Vec<u8>>>);

struct LogWriter(Arc<Mutex<Vec<u8>>>);

impl Write for LogWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogCapture {
    type Writer = LogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        LogWriter(Arc::clone(&self.0))
    }
}

impl LogCapture {
    fn bytes(&self) -> Vec<u8> {
        self.0.lock().unwrap().clone()
    }
}

#[tokio::test]
async fn known_secret_is_absent_after_protect_edit_lock_and_index_reopen() {
    let fixture = ApiFixture::builder().build();
    let root = fixture.state.vault.root();
    let db_path = root.join(".clepsydra/cache.db");
    let marker_body = format!("# Private\n\n{MARKER}\n");

    let logs = LogCapture::default();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(logs.clone())
        .finish();

    let (page_id, post_protection_requests, post_protection_responses) = async {
        let created = fixture
            .server
            .post("/api/vault/pages/known-secret.md")
            .json(&json!({ "title": "Known secret", "body": marker_body }))
            .await;
        created.assert_status(StatusCode::CREATED);
        let created: Value = created.json();
        let page_id = created["meta"]["id"].as_str().unwrap().to_string();
        assert!(
            cache_artifacts(&db_path)
                .iter()
                .any(|path| file_contains(path, MARKER.as_bytes())),
            "test precondition failed: plaintext never reached the cache"
        );

        let setup_response = fixture
            .server
            .post("/api/vault/encryption/setup")
            .json(&json!({
                "key_id": KEY_ID,
                "recipient": recipient(),
                "wrapped_identity": TYPESCRIPT_ARMOR,
            }))
            .await;
        setup_response.assert_status(StatusCode::CREATED);

        let protect_request = json!({
            "expected_revision": created["revision"],
            "encryption": encryption_descriptor(),
            "body": TYPESCRIPT_ARMOR,
        });
        let protected_response = fixture
            .server
            .post(&format!("/api/vault/pages/by-id/{page_id}/protect"))
            .json(&protect_request)
            .await;
        protected_response.assert_status_ok();
        let protected_text = protected_response.text();
        let protected: Value = serde_json::from_str(&protected_text).unwrap();

        let edit_request = json!({
            "expected_revision": protected["revision"],
            "body": CLI_ARMOR,
        });
        let edited_response = fixture
            .server
            .put(&format!("/api/vault/pages/by-id/{page_id}"))
            .json(&edit_request)
            .await;
        edited_response.assert_status_ok();
        let edited_text = edited_response.text();

        // Lock is a frontend memory operation. After the fixed adapter fixture has
        // encrypted the edit, a fresh GET represents the locked client's network view.
        let fetched_response = fixture.server.get("/api/vault/pages/known-secret.md").await;
        fetched_response.assert_status_ok();
        let fetched_text = fetched_response.text();

        (
            page_id,
            vec![
                serde_json::to_vec(&protect_request).unwrap(),
                serde_json::to_vec(&edit_request).unwrap(),
            ],
            vec![
                protected_text.into_bytes(),
                edited_text.into_bytes(),
                fetched_text.into_bytes(),
            ],
        )
    }
    .with_subscriber(subscriber)
    .await;

    let note_path = root.join("known-secret.md");
    assert!(!file_contains(&note_path, MARKER.as_bytes()));
    for body in post_protection_requests
        .iter()
        .chain(post_protection_responses.iter())
    {
        assert!(
            !body
                .windows(MARKER.len())
                .any(|window| window == MARKER.as_bytes())
        );
    }

    // Reopen the persisted index as a new process would and verify the protected
    // page has no body projection before checking every SQLite artifact bytewise.
    let reopened = VaultIndex::open(&db_path).unwrap();
    let (encrypted, indexed_body): (i64, String) = reopened
        .connection()
        .query_row(
            "SELECT p.encrypted, f.body FROM pages p JOIN pages_fts f ON f.page_id = p.id WHERE p.id = ?1",
            [page_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(encrypted, 1);
    assert!(indexed_body.is_empty());
    drop(reopened);

    for path in cache_artifacts(&db_path) {
        assert!(
            !file_contains(&path, MARKER.as_bytes()),
            "plaintext marker leaked into {}",
            path.display()
        );
    }
    assert_tree_excludes(&root.join(".clepsydra/crypto"), MARKER.as_bytes());
    assert!(
        !logs
            .bytes()
            .windows(MARKER.len())
            .any(|window| window == MARKER.as_bytes()),
        "plaintext marker leaked into captured application logs"
    );
}

#[tokio::test]
async fn external_change_rejects_an_unlocked_clients_stale_ciphertext_save() {
    let fixture = ApiFixture::builder().build();
    let root = fixture.state.vault.root();
    let created = fixture
        .server
        .post("/api/vault/pages/external-change.md")
        .json(&json!({ "title": "External change", "body": MARKER }))
        .await;
    created.assert_status(StatusCode::CREATED);
    let created: Value = created.json();
    let page_id = created["meta"]["id"].as_str().unwrap();

    let protected = fixture
        .server
        .post(&format!("/api/vault/pages/by-id/{page_id}/protect"))
        .json(&json!({
            "expected_revision": created["revision"],
            "encryption": encryption_descriptor(),
            "body": TYPESCRIPT_ARMOR,
        }))
        .await;
    protected.assert_status_ok();
    let protected: Value = protected.json();

    let note_path = root.join("external-change.md");
    let external = fs::read_to_string(&note_path)
        .unwrap()
        .replace(TYPESCRIPT_ARMOR, CLI_ARMOR);
    fs::write(&note_path, external.as_bytes()).unwrap();

    fixture
        .server
        .put(&format!("/api/vault/pages/by-id/{page_id}"))
        .json(&json!({
            "expected_revision": protected["revision"],
            "body": TYPESCRIPT_ARMOR,
        }))
        .await
        .assert_status(StatusCode::CONFLICT);

    assert_eq!(fs::read(&note_path).unwrap(), external.as_bytes());
    assert!(!file_contains(&note_path, MARKER.as_bytes()));
}

#[tokio::test]
async fn broken_or_unavailable_key_material_never_overwrites_protected_notes() {
    let malformed = ApiFixture::builder()
        .configure(|root| {
            setup_keyring(root, KEY_ID, &recipient(), Some(TYPESCRIPT_ARMOR)).unwrap();
        })
        .pre_index_seed(|root| {
            fs::write(
                root.join("protected.md"),
                format!(
                    "+++\nid = \"019fd000-0000-7000-8000-000000000601\"\ntitle = \"Protected\"\nencryption = {{ format = \"age\", version = 1, key_id = \"{KEY_ID}\" }}\n+++\n{TYPESCRIPT_ARMOR}"
                ),
            )
            .unwrap();
        })
        .build();
    let malformed_note = malformed.state.vault.root().join("protected.md");
    let malformed_before = fs::read(&malformed_note).unwrap();
    fs::write(
        malformed
            .state
            .vault
            .root()
            .join(".clepsydra/crypto/keyring.toml"),
        "this is not valid keyring metadata",
    )
    .unwrap();
    malformed
        .server
        .get("/api/vault/encryption")
        .await
        .assert_status(StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(fs::read(&malformed_note).unwrap(), malformed_before);

    let missing = ApiFixture::builder()
        .configure(|root| {
            setup_keyring(root, KEY_ID, &recipient(), Some(TYPESCRIPT_ARMOR)).unwrap();
        })
        .pre_index_seed(|root| {
            fs::write(
                root.join("protected.md"),
                format!(
                    "+++\nid = \"019fd000-0000-7000-8000-000000000602\"\ntitle = \"Protected\"\nencryption = {{ format = \"age\", version = 1, key_id = \"{KEY_ID}\" }}\n+++\n{TYPESCRIPT_ARMOR}"
                ),
            )
            .unwrap();
        })
        .build();
    let missing_note = missing.state.vault.root().join("protected.md");
    let missing_before = fs::read(&missing_note).unwrap();
    fs::remove_file(
        missing
            .state
            .vault
            .root()
            .join(format!(".clepsydra/crypto/{KEY_ID}.identity.age")),
    )
    .unwrap();
    missing
        .server
        .get("/api/vault/encryption")
        .await
        .assert_status(StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(fs::read(&missing_note).unwrap(), missing_before);

    let imported_only = ApiFixture::builder()
        .configure(|root| {
            setup_keyring(root, KEY_ID, &recipient(), None).unwrap();
        })
        .pre_index_seed(|root| {
            fs::write(
                root.join("protected.md"),
                format!(
                    "+++\nid = \"019fd000-0000-7000-8000-000000000603\"\ntitle = \"Protected\"\nencryption = {{ format = \"age\", version = 1, key_id = \"{KEY_ID}\" }}\n+++\n{TYPESCRIPT_ARMOR}"
                ),
            )
            .unwrap();
        })
        .build();
    let imported_note = imported_only.state.vault.root().join("protected.md");
    let imported_before = fs::read(&imported_note).unwrap();
    let config = imported_only.server.get("/api/vault/encryption").await;
    config.assert_status_ok();
    let config: Value = config.json();
    assert!(config["wrapped_identity"].is_null());
    let detail: Value = imported_only
        .server
        .get("/api/vault/pages/protected.md")
        .await
        .json();
    imported_only
        .server
        .put("/api/vault/pages/protected.md")
        .json(&json!({
            "expected_revision": detail["revision"],
            "body": MARKER,
        }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    assert_eq!(fs::read(&imported_note).unwrap(), imported_before);
}
