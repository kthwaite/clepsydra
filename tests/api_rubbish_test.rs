mod support;

use std::fs;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode};
use chrono::{DateTime, Utc};
use clepsydra::api::Clock;
use clepsydra::api::openapi::ApiDoc;
use clepsydra::vault::cas::ContentStore;
use clepsydra::vault::path::VaultPath;
use clepsydra::vault::rubbish::{RubbishListEntry, RubbishManifest, RubbishStore};
use serde_json::{Value, json};
use support::ApiFixture;
use tower::ServiceExt;
use utoipa::OpenApi;
use uuid::Uuid;

const PAGE_ID_A: &str = "019fd000-0000-7000-8000-000000000601";
const PAGE_ID_B: &str = "019fd000-0000-7000-8000-000000000602";
const ITEM_ID_A: &str = "019fd000-0000-7000-8000-000000000611";
const ITEM_ID_B: &str = "019fd000-0000-7000-8000-000000000612";
const INVALID_ITEM_ID: &str = "019fd000-0000-7000-8000-0000000006ee";
const KEY_ID: &str = "019fd000-0000-7000-8000-000000000699";
const ARCHIVE_TIME: &str = "2026-08-14T12:34:56Z";
const PREVIEW_LIMIT_BYTES: usize = 4096;

#[derive(Debug)]
struct FixedClock(DateTime<Utc>);

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

fn fixture_at(timestamp: &str) -> ApiFixture {
    ApiFixture::builder()
        .clock(Arc::new(FixedClock(timestamp.parse().unwrap())))
        .build()
}

fn stored_page(page_id: &str, title: &str, extra_meta: &str, body: &str) -> Vec<u8> {
    format!("+++\nid = \"{page_id}\"\ntitle = \"{title}\"\n{extra_meta}+++\n{body}").into_bytes()
}

fn manifest(
    item_id: &str,
    page_id: &str,
    path: &str,
    title: &str,
    deleted_at: &str,
) -> RubbishManifest {
    RubbishManifest::new(
        Uuid::parse_str(item_id).unwrap(),
        Uuid::parse_str(page_id).unwrap(),
        path,
        title,
        "NOTE",
        deleted_at.parse().unwrap(),
        None,
    )
    .unwrap()
}

async fn publish_item(fixture: &ApiFixture, manifest: RubbishManifest, bytes: Vec<u8>) {
    let store = RubbishStore::for_vault(fixture.state.vault.root());
    let mut prepared = store
        .prepare_item(&manifest.item_id.to_string(), &manifest, &bytes)
        .unwrap();
    prepared.publish().unwrap();
    let catalog_entry = RubbishListEntry::Valid(manifest);
    fixture
        .state
        .index
        .with_index(move |index, _| index.upsert_rubbish_entry(&catalog_entry))
        .await
        .unwrap()
        .unwrap();
}

async fn archive_page(fixture: &ApiFixture, path: &str) -> Value {
    let response = fixture
        .server
        .delete(&format!("/api/vault/pages/{path}"))
        .await;
    response.assert_status(StatusCode::CREATED);
    response.json()
}

#[tokio::test]
async fn page_delete_archives_with_backlinks_and_excludes_every_normal_page_surface() {
    let fixture = fixture_at(ARCHIVE_TIME);
    fixture
        .server
        .post("/api/vault/pages/target.md")
        .json(&json!({"title": "Target", "body": "Unique rubbish search marker."}))
        .await
        .assert_status(StatusCode::CREATED);
    fixture
        .server
        .post("/api/vault/pages/linker.md")
        .json(&json!({"title": "Linker", "body": "See [[Target]] without rewriting."}))
        .await
        .assert_status(StatusCode::CREATED);
    fixture
        .server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();
    let linker_before = fs::read(fixture.state.vault.root().join("linker.md")).unwrap();

    let archived = archive_page(&fixture, "target.md").await;

    assert_eq!(archived["page_id"].as_str().unwrap().len(), 36);
    assert_eq!(archived["original_path"], "target.md");
    assert_eq!(archived["title"], "Target");
    assert_eq!(archived["kind"], "NOTE");
    assert_eq!(archived["deleted_at"], ARCHIVE_TIME);
    assert!(archived["item_id"].as_str().is_some());
    assert_eq!(
        fs::read(fixture.state.vault.root().join("linker.md")).unwrap(),
        linker_before,
        "archival must not rewrite inbound links"
    );
    assert!(!fixture.state.vault.root().join("target.md").exists());

    fixture
        .server
        .get("/api/vault/pages/target.md")
        .await
        .assert_status(StatusCode::NOT_FOUND);
    fixture
        .server
        .get(&format!(
            "/api/vault/pages/by-id/{}",
            archived["page_id"].as_str().unwrap()
        ))
        .await
        .assert_status(StatusCode::NOT_FOUND);
    let pages: Value = fixture.server.get("/api/vault/pages").await.json();
    assert!(
        pages["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["path"] != "target.md")
    );
    let search: Value = fixture
        .server
        .get("/api/vault/index/search?q=Unique%20rubbish%20search%20marker")
        .await
        .json();
    assert!(search.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn page_delete_maps_missing_source_to_404_and_post_read_byte_drift_to_409() {
    let fixture = fixture_at(ARCHIVE_TIME);
    let missing = fixture.server.delete("/api/vault/pages/missing.md").await;
    missing.assert_status(StatusCode::NOT_FOUND);
    assert_eq!(
        missing.json::<Value>()["error"],
        "page not found: missing.md"
    );

    fixture
        .server
        .post("/api/vault/pages/drift.md")
        .json(&json!({"title": "Drift", "body": "Before."}))
        .await
        .assert_status(StatusCode::CREATED);
    let path = VaultPath::new("drift.md").unwrap();
    let guard = fixture
        .state
        .mutation_coordinator
        .lock_paths(std::slice::from_ref(&path))
        .await;
    let app = fixture.app.clone();
    let request = Request::builder()
        .method(Method::DELETE)
        .uri("/api/vault/pages/drift.md")
        .body(Body::empty())
        .unwrap();
    let request_task = tokio::spawn(async move { app.oneshot(request).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let drifted = fs::read_to_string(fixture.state.vault.resolve(&path))
        .unwrap()
        .replace("Before.", "Changed after the archive read.");
    fs::write(fixture.state.vault.resolve(&path), drifted).unwrap();
    drop(guard);

    let response = request_task.await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["error"], "active page bytes changed: drift.md");
    assert!(
        RubbishStore::for_vault(fixture.state.vault.root())
            .list_entries()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn rubbish_list_is_newest_first_and_retains_invalid_item_rows() {
    let fixture = fixture_at(ARCHIVE_TIME);
    publish_item(
        &fixture,
        manifest(
            ITEM_ID_A,
            PAGE_ID_A,
            "older.md",
            "Older",
            "2026-08-14T10:00:00Z",
        ),
        stored_page(PAGE_ID_A, "Older", "", "Older body."),
    )
    .await;
    publish_item(
        &fixture,
        manifest(
            ITEM_ID_B,
            PAGE_ID_B,
            "newer.md",
            "Newer",
            "2026-08-14T11:00:00Z",
        ),
        stored_page(PAGE_ID_B, "Newer", "", "Newer body."),
    )
    .await;
    let invalid_catalog = RubbishListEntry::Invalid {
        item_id: INVALID_ITEM_ID.to_owned(),
        error: "catalogued invalid manifest".to_owned(),
    };
    fixture
        .state
        .index
        .with_index(move |index, _| index.upsert_rubbish_entry(&invalid_catalog))
        .await
        .unwrap()
        .unwrap();

    let response = fixture.server.get("/api/vault/rubbish").await;
    response.assert_status_ok();
    let entries: Value = response.json();
    let entries = entries.as_array().unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0]["status"], "valid");
    assert_eq!(entries[0]["item"]["item_id"], ITEM_ID_B);
    assert_eq!(entries[1]["status"], "valid");
    assert_eq!(entries[1]["item"]["item_id"], ITEM_ID_A);
    assert_eq!(entries[2]["status"], "invalid");
    assert_eq!(entries[2]["item_id"], INVALID_ITEM_ID);
    assert_eq!(entries[2]["error"], "catalogued invalid manifest");
    let invalid = fixture
        .state
        .vault
        .root()
        .join(format!(".clepsydra/rubbish/{INVALID_ITEM_ID}"));
    fs::create_dir_all(&invalid).unwrap();
    fs::write(invalid.join("page.md"), "unindexed invalid bytes").unwrap();
    fixture
        .server
        .get(&format!("/api/vault/rubbish/{INVALID_ITEM_ID}"))
        .await
        .assert_status(StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn rubbish_detail_is_bounded_read_only_and_never_enters_the_normal_index() {
    let fixture = fixture_at(ARCHIVE_TIME);
    let body = "x".repeat(PREVIEW_LIMIT_BYTES + 777);
    let stored = stored_page(PAGE_ID_A, "Long preview", "readonly = true\n", &body);
    publish_item(
        &fixture,
        manifest(
            ITEM_ID_A,
            PAGE_ID_A,
            "long.md",
            "Long preview",
            ARCHIVE_TIME,
        ),
        stored,
    )
    .await;

    let detail_response = fixture
        .server
        .get(&format!("/api/vault/rubbish/{ITEM_ID_A}"))
        .await;
    detail_response.assert_status_ok();
    let detail: Value = detail_response.json();
    assert_eq!(detail["item"]["item_id"], ITEM_ID_A);
    assert_eq!(detail["preview"]["read_only"], true);
    assert_eq!(detail["preview"]["encrypted"], false);
    assert_eq!(detail["preview"]["truncated"], true);
    assert_eq!(
        detail["preview"]["body"].as_str().unwrap().len(),
        PREVIEW_LIMIT_BYTES
    );

    let pages: Value = fixture.server.get("/api/vault/pages").await.json();
    assert!(pages["items"].as_array().unwrap().is_empty());
    fixture
        .server
        .get(&format!("/api/vault/pages/by-id/{PAGE_ID_A}"))
        .await
        .assert_status(StatusCode::NOT_FOUND);
    let search: Value = fixture
        .server
        .get("/api/vault/index/search?q=Long%20preview")
        .await
        .json();
    assert!(search.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn rubbish_detail_discloses_protected_plaintext_and_encrypted_armor_without_decryption() {
    let fixture = fixture_at(ARCHIVE_TIME);
    publish_item(
        &fixture,
        manifest(
            ITEM_ID_A,
            PAGE_ID_A,
            "readonly.md",
            "Readonly",
            "2026-08-14T10:00:00Z",
        ),
        stored_page(
            PAGE_ID_A,
            "Readonly",
            "readonly = true\n",
            "Visible protected plaintext.",
        ),
    )
    .await;
    let armor = include_str!("support/fixtures/private-note.age");
    publish_item(
        &fixture,
        manifest(
            ITEM_ID_B,
            PAGE_ID_B,
            "encrypted.md",
            "Encrypted",
            "2026-08-14T11:00:00Z",
        ),
        stored_page(
            PAGE_ID_B,
            "Encrypted",
            &format!("encryption = {{ format = \"age\", version = 1, key_id = \"{KEY_ID}\" }}\n"),
            armor,
        ),
    )
    .await;

    let readonly_response = fixture
        .server
        .get(&format!("/api/vault/rubbish/{ITEM_ID_A}"))
        .await;
    readonly_response.assert_status_ok();
    let readonly: Value = readonly_response.json();
    assert_eq!(readonly["preview"]["body"], "Visible protected plaintext.");
    assert_eq!(readonly["preview"]["encrypted"], false);
    assert_eq!(readonly["preview"]["read_only"], true);

    let encrypted_response = fixture
        .server
        .get(&format!("/api/vault/rubbish/{ITEM_ID_B}"))
        .await;
    encrypted_response.assert_status_ok();
    let encrypted: Value = encrypted_response.json();
    assert_eq!(encrypted["preview"]["body"], armor);
    assert_eq!(encrypted["preview"]["encrypted"], true);
    assert_eq!(encrypted["preview"]["read_only"], true);
    assert!(!encrypted.to_string().contains("decrypted"));
}

#[tokio::test]
async fn rubbish_item_routes_map_malformed_uuid_to_400_and_missing_uuid_to_404() {
    let fixture = fixture_at(ARCHIVE_TIME);
    let missing = "019fd000-0000-7000-8000-0000000006ff";
    for (method, path) in [
        (Method::GET, "/api/vault/rubbish/not-a-uuid".to_owned()),
        (
            Method::POST,
            "/api/vault/rubbish/not-a-uuid/restore".to_owned(),
        ),
        (Method::DELETE, "/api/vault/rubbish/not-a-uuid".to_owned()),
    ] {
        let response = fixture
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["status"], 400);
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("invalid rubbish item ID")
        );
    }
    for (method, path) in [
        (Method::GET, format!("/api/vault/rubbish/{missing}")),
        (
            Method::POST,
            format!("/api/vault/rubbish/{missing}/restore"),
        ),
        (Method::DELETE, format!("/api/vault/rubbish/{missing}")),
    ] {
        let request_label = format!("{method} {path}");
        let response = fixture
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{request_label}");
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["status"], 404);
        assert_eq!(body["error"], format!("rubbish item not found: {missing}"));
    }
}

#[tokio::test]
async fn rubbish_restore_returns_original_identity_and_occupied_path_retains_item() {
    let fixture = fixture_at(ARCHIVE_TIME);
    fixture
        .server
        .post("/api/vault/pages/restorable.md")
        .json(&json!({"title": "Restorable", "body": "Exact restore bytes."}))
        .await
        .assert_status(StatusCode::CREATED);
    let expected = fs::read(fixture.state.vault.root().join("restorable.md")).unwrap();
    let archived = archive_page(&fixture, "restorable.md").await;
    let item_id = archived["item_id"].as_str().unwrap();
    let page_id = archived["page_id"].as_str().unwrap();

    let restored = fixture
        .server
        .post(&format!("/api/vault/rubbish/{item_id}/restore"))
        .await;
    restored.assert_status_ok();
    let restored: Value = restored.json();
    assert_eq!(restored["item_id"], item_id);
    assert_eq!(restored["page_id"], page_id);
    assert_eq!(restored["path"], "restorable.md");
    assert_eq!(
        fs::read(fixture.state.vault.root().join("restorable.md")).unwrap(),
        expected
    );

    let archived_again = archive_page(&fixture, "restorable.md").await;
    let retained_id = archived_again["item_id"].as_str().unwrap();
    fs::write(
        fixture.state.vault.root().join("restorable.md"),
        "occupied outside the index",
    )
    .unwrap();
    let conflict = fixture
        .server
        .post(&format!("/api/vault/rubbish/{retained_id}/restore"))
        .await;
    conflict.assert_status(StatusCode::CONFLICT);
    assert_eq!(
        conflict.json::<Value>()["error"],
        "restore destination is occupied: restorable.md"
    );
    fixture
        .server
        .get(&format!("/api/vault/rubbish/{retained_id}"))
        .await
        .assert_status_ok();
}

#[tokio::test]
async fn rubbish_item_delete_purges_exact_item() {
    let fixture = fixture_at(ARCHIVE_TIME);
    fixture
        .server
        .post("/api/vault/pages/purge.md")
        .json(&json!({"title": "Purge", "body": "Permanent only from rubbish."}))
        .await
        .assert_status(StatusCode::CREATED);
    let archived = archive_page(&fixture, "purge.md").await;
    let item_id = archived["item_id"].as_str().unwrap();

    let purged = fixture
        .server
        .delete(&format!("/api/vault/rubbish/{item_id}"))
        .await;
    purged.assert_status_ok();
    let purged: Value = purged.json();
    assert_eq!(purged["item_id"], item_id);
    assert_eq!(purged["page_id"], archived["page_id"]);
    assert_eq!(purged["original_path"], "purge.md");
    fixture
        .server
        .get(&format!("/api/vault/rubbish/{item_id}"))
        .await
        .assert_status(StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn failed_purge_after_cas_release_cannot_restore_and_retry_finishes() {
    let fixture = fixture_at(ARCHIVE_TIME);
    let item_id = Uuid::parse_str(ITEM_ID_A).unwrap();
    let snapshot = b"captured snapshot owned only by the rubbish item";
    let snapshot_hash = fixture
        .state
        .cas
        .lock()
        .store(snapshot, "text/html")
        .unwrap()
        .hash;
    let retained_bytes = stored_page(
        PAGE_ID_A,
        "Purge in progress",
        &format!("[archive]\nsnapshot_hash = \"{snapshot_hash}\"\n"),
        "Retained page bytes.",
    );
    publish_item(
        &fixture,
        manifest(
            ITEM_ID_A,
            PAGE_ID_A,
            "purge-in-progress.md",
            "Purge in progress",
            ARCHIVE_TIME,
        ),
        retained_bytes.clone(),
    )
    .await;
    fixture
        .state
        .index
        .with_index(|index, _| {
            index.connection().execute_batch(&format!(
                "CREATE TRIGGER fail_rubbish_purge_catalog
                 BEFORE DELETE ON rubbish_items
                 WHEN OLD.item_id = '{ITEM_ID_A}'
                 BEGIN
                     SELECT RAISE(FAIL, 'injected rubbish catalog deletion failure');
                 END;"
            ))
        })
        .await
        .unwrap()
        .unwrap();

    let purge_error = fixture
        .server
        .delete(&format!("/api/vault/rubbish/{ITEM_ID_A}"))
        .await;
    purge_error.assert_status(StatusCode::INTERNAL_SERVER_ERROR);
    assert!(
        purge_error.json::<Value>()["error"]
            .as_str()
            .unwrap()
            .contains("rubbish catalog removal failed")
    );
    assert_eq!(
        RubbishStore::for_vault(fixture.state.vault.root())
            .read_item(ITEM_ID_A)
            .unwrap()
            .bytes,
        retained_bytes
    );
    assert!(
        !fixture
            .state
            .vault
            .root()
            .join("purge-in-progress.md")
            .exists()
    );
    assert!(
        fixture
            .state
            .cas
            .lock()
            .rubbish_archive_refs_released(item_id)
            .unwrap()
    );
    assert_eq!(
        fixture
            .state
            .cas
            .lock()
            .gc(std::time::Duration::ZERO)
            .unwrap(),
        1
    );

    let restore = fixture
        .server
        .post(&format!("/api/vault/rubbish/{ITEM_ID_A}/restore"))
        .await;
    restore.assert_status(StatusCode::CONFLICT);
    let restore_error = restore.json::<Value>();
    assert!(
        restore_error["error"]
            .as_str()
            .unwrap()
            .contains("retry permanent deletion"),
        "actual error: {restore_error}"
    );
    assert!(
        !fixture
            .state
            .vault
            .root()
            .join("purge-in-progress.md")
            .exists()
    );
    assert_eq!(
        RubbishStore::for_vault(fixture.state.vault.root())
            .read_item(ITEM_ID_A)
            .unwrap()
            .bytes,
        retained_bytes
    );

    fixture
        .state
        .index
        .with_index(|index, _| {
            index
                .connection()
                .execute_batch("DROP TRIGGER fail_rubbish_purge_catalog")
        })
        .await
        .unwrap()
        .unwrap();
    fixture
        .server
        .delete(&format!("/api/vault/rubbish/{ITEM_ID_A}"))
        .await
        .assert_status_ok();
    fixture
        .server
        .get(&format!("/api/vault/rubbish/{ITEM_ID_A}"))
        .await
        .assert_status(StatusCode::NOT_FOUND);
    assert!(
        !fixture
            .state
            .vault
            .root()
            .join("purge-in-progress.md")
            .exists()
    );
    assert!(
        fixture
            .state
            .cas
            .lock()
            .rubbish_archive_refs_released(item_id)
            .unwrap()
    );
}

#[tokio::test]
async fn empty_rubbish_returns_ordered_partial_outcomes_and_retains_failures() {
    let fixture = fixture_at(ARCHIVE_TIME);
    let missing_blob = ContentStore::hash_bytes(b"blob absent from fixture CAS");
    publish_item(
        &fixture,
        manifest(
            ITEM_ID_A,
            PAGE_ID_A,
            "purge-success.md",
            "Purge success",
            "2026-08-14T10:00:00Z",
        ),
        stored_page(PAGE_ID_A, "Purge success", "", "Success."),
    )
    .await;
    publish_item(
        &fixture,
        manifest(
            ITEM_ID_B,
            PAGE_ID_B,
            "purge-failure.md",
            "Purge failure",
            "2026-08-14T11:00:00Z",
        ),
        stored_page(
            PAGE_ID_B,
            "Purge failure",
            &format!("[archive]\nsnapshot_hash = \"{missing_blob}\"\n"),
            "Failure remains.",
        ),
    )
    .await;

    let response = fixture.server.delete("/api/vault/rubbish").await;
    response.assert_status_ok();
    let body: Value = response.json();
    let outcomes = body["outcomes"].as_array().unwrap();
    assert_eq!(outcomes.len(), 2);
    assert_eq!(outcomes[0]["status"], "failed");
    assert_eq!(outcomes[0]["item_id"], ITEM_ID_B);
    assert!(
        outcomes[0]["error"]
            .as_str()
            .unwrap()
            .contains(&missing_blob)
    );
    assert_eq!(outcomes[1]["status"], "purged");
    assert_eq!(outcomes[1]["item"]["item_id"], ITEM_ID_A);

    fixture
        .server
        .get(&format!("/api/vault/rubbish/{ITEM_ID_A}"))
        .await
        .assert_status(StatusCode::NOT_FOUND);
    fixture
        .server
        .get(&format!("/api/vault/rubbish/{ITEM_ID_B}"))
        .await
        .assert_status_ok();
}

#[test]
fn openapi_registers_rubbish_lifecycle_and_removes_permanent_page_delete_contract() {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();
    for (path, method) in [
        ("/api/vault/rubbish", "get"),
        ("/api/vault/rubbish", "delete"),
        ("/api/vault/rubbish/{item_id}", "get"),
        ("/api/vault/rubbish/{item_id}", "delete"),
        ("/api/vault/rubbish/{item_id}/restore", "post"),
    ] {
        assert!(
            document["paths"][path][method].is_object(),
            "missing {method} {path}"
        );
    }
    for (path, method, expected_statuses) in [
        ("/api/vault/rubbish", "get", vec!["200", "500"]),
        ("/api/vault/rubbish", "delete", vec!["200", "500"]),
        (
            "/api/vault/rubbish/{item_id}",
            "get",
            vec!["200", "400", "404", "500"],
        ),
        (
            "/api/vault/rubbish/{item_id}",
            "delete",
            vec!["200", "400", "404", "500"],
        ),
        (
            "/api/vault/rubbish/{item_id}/restore",
            "post",
            vec!["200", "400", "404", "409", "500"],
        ),
    ] {
        let actual = document["paths"][path][method]["responses"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        assert_eq!(
            actual, expected_statuses,
            "wrong response contract for {method} {path}"
        );
    }

    let page_delete = &document["paths"]["/api/vault/pages/{path}"]["delete"];
    let parameter_names = page_delete["parameters"]
        .as_array()
        .unwrap()
        .iter()
        .map(|parameter| parameter["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(parameter_names, vec!["path"]);
    assert!(page_delete["responses"].get("204").is_none());
    assert_eq!(
        page_delete["responses"]["201"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/RubbishItemSummary"
    );

    let schemas = document["components"]["schemas"].as_object().unwrap();
    assert!(schemas.get("DeleteQuery").is_none());
    for schema in [
        "RubbishItemSummary",
        "RubbishListEntryDto",
        "RubbishItemPreview",
        "RubbishItemDetail",
        "RubbishRestoreResponse",
        "RubbishPurgeResponse",
        "EmptyRubbishItemOutcome",
        "EmptyRubbishResponse",
    ] {
        assert!(schemas.contains_key(schema), "missing schema {schema}");
    }
    assert_eq!(
        schemas["RubbishListEntryDto"]["oneOf"][0]["properties"]["status"]["enum"][0],
        "valid"
    );
    assert_eq!(
        schemas["RubbishListEntryDto"]["oneOf"][1]["properties"]["status"]["enum"][0],
        "invalid"
    );
    assert_eq!(
        schemas["EmptyRubbishItemOutcome"]["oneOf"][0]["properties"]["status"]["enum"][0],
        "purged"
    );
    assert_eq!(
        schemas["EmptyRubbishItemOutcome"]["oneOf"][1]["properties"]["status"]["enum"][0],
        "failed"
    );
}
