mod support;

use axum::http::StatusCode;
use serde_json::{Value, json};
use support::ApiFixture;

const PREFIX: &str = "/api/vault/quires";

async fn create_page(fixture: &ApiFixture, path: &str, title: &str) -> Value {
    let response = fixture
        .server
        .post(&format!("/api/vault/pages/{path}"))
        .json(&json!({"title": title, "body": "Unchanged page body."}))
        .await;
    response.assert_status(StatusCode::CREATED);
    response.json()
}

async fn save(fixture: &ApiFixture, members: Value) -> Value {
    let response = fixture
        .server
        .post(PREFIX)
        .json(&json!({
            "name": "Reading", "color": "indigo", "members": members,
        }))
        .await;
    response.assert_status(StatusCode::CREATED);
    response.json()
}

#[tokio::test]
async fn snapshots_persist_order_and_resolve_in_a_fresh_server_without_workspace_state() {
    let fixture = ApiFixture::builder().build();
    create_page(&fixture, "first.md", "First").await;
    create_page(&fixture, "second.md", "Second").await;
    let saved = save(
        &fixture,
        json!([
            {"path": "second.md", "label": "Outdated second"},
            {"path": "first.md", "label": "Outdated first"},
        ]),
    )
    .await;
    assert_eq!(saved["members"][0]["label"], "Second");
    assert_eq!(saved["members"][1]["path"], "first.md");
    assert_eq!(saved["members"][0]["missing"], false);
    assert!(uuid::Uuid::parse_str(saved["members"][0]["page_id"].as_str().unwrap()).is_ok());
    let source = fixture.state.vault.root().to_owned();
    let id = saved["id"].as_str().unwrap().to_owned();
    let snapshot_name = format!("{id}.json");
    let fresh = ApiFixture::builder()
        .pre_index_seed(move |root| {
            for page in ["first.md", "second.md"] {
                std::fs::copy(source.join(page), root.join(page)).unwrap();
            }
            std::fs::create_dir(root.join(".clepsydra/quires")).unwrap();
            std::fs::copy(
                source.join(".clepsydra/quires").join(&snapshot_name),
                root.join(".clepsydra/quires").join(snapshot_name),
            )
            .unwrap();
        })
        .build();
    drop(fixture);
    let reread: Value = fresh.server.get(&format!("{PREFIX}/{id}")).await.json();
    assert_eq!(reread, saved);
    let listed: Value = fresh.server.get(PREFIX).await.json();
    assert_eq!(listed, json!([saved]));
}

#[tokio::test]
async fn explicit_updates_rename_and_delete_are_revision_guarded_and_never_change_pages() {
    let fixture = ApiFixture::builder().build();
    create_page(&fixture, "first.md", "First").await;
    create_page(&fixture, "second.md", "Second").await;
    let first_bytes = std::fs::read(fixture.state.vault.root().join("first.md")).unwrap();
    let second_bytes = std::fs::read(fixture.state.vault.root().join("second.md")).unwrap();
    let saved = save(&fixture, json!([{"path": "first.md", "label": "First"}])).await;
    let url = format!("{PREFIX}/{}", saved["id"].as_str().unwrap());
    let renamed_response = fixture
        .server
        .put(&url)
        .json(&json!({
            "expected_revision": saved["revision"], "name": "Renamed", "color": "madder",
        }))
        .await;
    renamed_response.assert_status_ok();
    let renamed: Value = renamed_response.json();
    assert_eq!(renamed["members"], saved["members"]);
    assert_ne!(renamed["revision"], saved["revision"]);
    fixture
        .server
        .put(&url)
        .json(&json!({
            "expected_revision": saved["revision"], "name": "Stale", "color": "slate",
            "members": [],
        }))
        .await
        .assert_status(StatusCode::CONFLICT);
    fixture
        .server
        .delete(&url)
        .add_query_param("expected_revision", saved["revision"].as_str().unwrap())
        .await
        .assert_status(StatusCode::CONFLICT);
    let updated_response = fixture
        .server
        .put(&url)
        .json(&json!({
            "expected_revision": renamed["revision"], "name": "Updated", "color": "ochre",
            "members": [{"path": "second.md", "label": "Second"}],
        }))
        .await;
    updated_response.assert_status_ok();
    let updated: Value = updated_response.json();
    assert_eq!(updated["members"].as_array().unwrap().len(), 1);
    assert_eq!(updated["members"][0]["path"], "second.md");
    fixture
        .server
        .delete(&url)
        .add_query_param("expected_revision", updated["revision"].as_str().unwrap())
        .await
        .assert_status(StatusCode::NO_CONTENT);
    fixture
        .server
        .get(&url)
        .await
        .assert_status(StatusCode::NOT_FOUND);
    assert_eq!(fixture.server.get(PREFIX).await.json::<Value>(), json!([]));
    assert_eq!(
        std::fs::read(fixture.state.vault.root().join("first.md")).unwrap(),
        first_bytes
    );
    assert_eq!(
        std::fs::read(fixture.state.vault.root().join("second.md")).unwrap(),
        second_bytes
    );
}

#[tokio::test]
async fn stable_ids_follow_moves_but_never_rebind_an_archived_member_to_a_reused_path() {
    let fixture = ApiFixture::builder().build();
    create_page(&fixture, "original.md", "Original").await;
    let saved = save(
        &fixture,
        json!([{"path": "original.md", "label": "Original"}]),
    )
    .await;
    let url = format!("{PREFIX}/{}", saved["id"].as_str().unwrap());
    fixture
        .server
        .post("/api/vault/pages-move/original.md")
        .json(&json!({"destination": "moved.md"}))
        .await
        .assert_status_ok();
    let moved: Value = fixture.server.get(&url).await.json();
    assert_eq!(moved["members"][0]["path"], "moved.md");
    assert_eq!(
        moved["members"][0]["page_id"],
        saved["members"][0]["page_id"]
    );
    assert_eq!(moved["revision"], saved["revision"], "reads never autosave");
    let page: Value = fixture.server.get("/api/vault/pages/moved.md").await.json();
    fixture
        .server
        .put("/api/vault/pages/moved.md")
        .json(&json!({
            "expected_revision": page["revision"], "title": "New title",
        }))
        .await
        .assert_status_ok();
    let retitled: Value = fixture.server.get(&url).await.json();
    assert_eq!(retitled["members"][0]["label"], "New title");
    assert_eq!(retitled["revision"], saved["revision"]);
    // Use the resolved current path because title edits may relocate the page.
    let current_path = retitled["members"][0]["path"].as_str().unwrap();
    fixture
        .server
        .delete(&format!("/api/vault/pages/{current_path}"))
        .await
        .assert_status(StatusCode::CREATED);
    create_page(&fixture, "original.md", "Different page").await;
    let missing: Value = fixture.server.get(&url).await.json();
    assert_eq!(missing["members"][0]["missing"], true);
    assert_eq!(
        missing["members"][0]["page_id"],
        saved["members"][0]["page_id"]
    );
    assert_eq!(missing["members"][0]["path"], "original.md");
    assert_eq!(missing["members"][0]["label"], "Original");
    assert_eq!(missing["revision"], saved["revision"]);
    let member = json!({
        "page_id": missing["members"][0]["page_id"],
        "path": "original.md", "label": "Forged missing label",
    });
    let preserved_response = fixture
        .server
        .put(&url)
        .json(&json!({
            "expected_revision": missing["revision"], "name": "Still saved", "color": "sepia",
            "members": [member.clone()],
        }))
        .await;
    preserved_response.assert_status_ok();
    let preserved: Value = preserved_response.json();
    assert_eq!(
        preserved["members"], missing["members"],
        "missing metadata is authoritative"
    );
    fixture
        .server
        .post(PREFIX)
        .json(&json!({
            "name": "Cannot import missing identity", "color": "sepia", "members": [member],
        }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn invalid_snapshots_are_rejected_without_persistence() {
    let fixture = ApiFixture::builder().build();
    create_page(&fixture, "page.md", "Page").await;
    for request in [
        json!({"name": " ", "color": "sepia", "members": []}),
        json!({"name": "x".repeat(201), "color": "sepia", "members": []}),
        json!({"name": "bad\nname", "color": "sepia", "members": []}),
        json!({"name": "Name", "color": "purple", "members": []}),
        json!({"name": "Name", "color": "sepia", "members": [
            {"path": "../page.md", "label": "Page"},
        ]}),
        json!({"name": "Name", "color": "sepia", "members": [
            {"path": "/page.md", "label": "Page"},
        ]}),
        json!({"name": "Name", "color": "sepia", "members": [
            {"path": "absent.md", "label": "Page"},
        ]}),
        json!({"name": "Name", "color": "sepia", "members": [
            {"page_id": "not-a-uuid", "path": "page.md", "label": "Page"},
        ]}),
        json!({"name": "Name", "color": "sepia", "members": [
            {"page_id": uuid::Uuid::now_v7().to_string(), "path": "page.md", "label": "Page"},
        ]}),
        json!({"name": "Name", "color": "sepia", "members": [
            {"path": "page.md", "label": "Page"}, {"path": "./page.md", "label": "Duplicate"},
        ]}),
    ] {
        let response = fixture.server.post(PREFIX).json(&request).await;
        response.assert_status(StatusCode::BAD_REQUEST);
        assert!(response.json::<Value>()["error"].is_string());
    }
    fixture
        .server
        .get(&format!("{PREFIX}/not-a-uuid"))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    assert_eq!(fixture.server.get(PREFIX).await.json::<Value>(), json!([]));
}

#[tokio::test]
async fn simultaneous_writers_cannot_overwrite_the_same_revision() {
    let fixture = ApiFixture::builder().build();
    let saved = save(&fixture, json!([])).await;
    let url = format!("{PREFIX}/{}", saved["id"].as_str().unwrap());
    let first = json!({"expected_revision": saved["revision"], "name": "First", "color": "sepia"});
    let second =
        json!({"expected_revision": saved["revision"], "name": "Second", "color": "slate"});
    let (a, b) = tokio::join!(
        async { fixture.server.put(&url).json(&first).await },
        async { fixture.server.put(&url).json(&second).await },
    );
    let mut statuses = [a.status_code(), b.status_code()];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
}

#[tokio::test]
async fn saved_quire_writes_wait_for_the_sync_quiescence_gate() {
    let fixture = ApiFixture::builder().build();
    let exclusion = fixture.state.mutation_coordinator.exclude_mutations().await;
    let request = fixture.server.post(PREFIX).json(&json!({
        "name": "After sync", "color": "verdigris", "members": [],
    }));
    let future = async { request.await };
    tokio::pin!(future);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), &mut future)
            .await
            .is_err()
    );
    drop(exclusion);
    future.await.assert_status(StatusCode::CREATED);
}

#[cfg(unix)]
#[tokio::test]
async fn symlinked_storage_documents_and_member_paths_are_never_followed() {
    use std::os::unix::fs::symlink;
    let fixture = ApiFixture::builder().build();
    let outside = tempfile::tempdir().unwrap();
    let directory = fixture.state.vault.root().join(".clepsydra/quires");
    symlink(outside.path(), &directory).unwrap();
    fixture
        .server
        .post(PREFIX)
        .json(&json!({
            "name": "Unsafe", "color": "sepia", "members": [],
        }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    fixture
        .server
        .get(PREFIX)
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    std::fs::remove_file(&directory).unwrap();
    let saved = save(&fixture, json!([])).await;
    let id = saved["id"].as_str().unwrap();
    let file = directory.join(format!("{id}.json"));
    let outside_file = outside.path().join("snapshot.json");
    std::fs::rename(&file, &outside_file).unwrap();
    let original = std::fs::read(&outside_file).unwrap();
    symlink(&outside_file, &file).unwrap();
    let url = format!("{PREFIX}/{id}");
    fixture
        .server
        .get(&url)
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    fixture
        .server
        .put(&url)
        .json(&json!({
            "expected_revision": saved["revision"], "name": "Unsafe", "color": "sepia",
        }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    fixture
        .server
        .delete(&url)
        .add_query_param("expected_revision", saved["revision"].as_str().unwrap())
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    assert_eq!(std::fs::read(&outside_file).unwrap(), original);
    create_page(&fixture, "page.md", "Page").await;
    symlink(
        fixture.state.vault.root().join("page.md"),
        fixture.state.vault.root().join("alias.md"),
    )
    .unwrap();
    fixture
        .server
        .post(PREFIX)
        .json(&json!({
            "name": "Unsafe member", "color": "sepia",
            "members": [{"path": "alias.md", "label": "Alias"}],
        }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn supplied_page_identity_is_authoritative_and_duplicates_are_by_identity() {
    let fixture = ApiFixture::builder().build();
    let first = create_page(&fixture, "first.md", "First").await;
    create_page(&fixture, "second.md", "Second").await;
    let saved = save(
        &fixture,
        json!([{
            "page_id": first["meta"]["id"], "path": "second.md", "label": "Second",
        }]),
    )
    .await;
    assert_eq!(saved["members"][0]["path"], "first.md");
    assert_eq!(saved["members"][0]["label"], "First");
    fixture
        .server
        .post(PREFIX)
        .json(&json!({
            "name": "Duplicates", "color": "sepia", "members": [
                {"page_id": first["meta"]["id"], "path": "second.md", "label": "Second"},
                {"path": "first.md", "label": "First"},
            ],
        }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn raw_document_bytes_guard_revisions_and_unknown_versions_are_not_overwritten() {
    let fixture = ApiFixture::builder().build();
    let saved = save(&fixture, json!([])).await;
    let id = saved["id"].as_str().unwrap();
    let file = fixture
        .state
        .vault
        .root()
        .join(".clepsydra/quires")
        .join(format!("{id}.json"));
    let mut bytes = std::fs::read(&file).unwrap();
    bytes.push(b'\n');
    std::fs::write(&file, &bytes).unwrap();
    let url = format!("{PREFIX}/{id}");
    let reread: Value = fixture.server.get(&url).await.json();
    assert_ne!(reread["revision"], saved["revision"]);
    fixture
        .server
        .delete(&url)
        .add_query_param("expected_revision", saved["revision"].as_str().unwrap())
        .await
        .assert_status(StatusCode::CONFLICT);
    let mut document: Value = serde_json::from_slice(&bytes).unwrap();
    document["version"] = json!(999);
    let unsupported = serde_json::to_vec(&document).unwrap();
    std::fs::write(&file, &unsupported).unwrap();
    fixture
        .server
        .get(&url)
        .await
        .assert_status(StatusCode::INTERNAL_SERVER_ERROR);
    fixture
        .server
        .put(&url)
        .json(&json!({
            "expected_revision": reread["revision"], "name": "Unsafe", "color": "sepia",
        }))
        .await
        .assert_status(StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(std::fs::read(file).unwrap(), unsupported);
}

#[cfg(unix)]
#[tokio::test]
async fn a_symlinked_metadata_parent_cannot_redirect_saved_quire_storage() {
    let fixture = ApiFixture::builder().build();
    let metadata = fixture.state.vault.root().join(".clepsydra");
    let relocated = fixture.state.vault.root().join("relocated-metadata");
    std::fs::rename(&metadata, &relocated).unwrap();
    std::os::unix::fs::symlink(&relocated, &metadata).unwrap();
    fixture
        .server
        .post(PREFIX)
        .json(&json!({
            "name": "Unsafe", "color": "sepia", "members": [],
        }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    fixture
        .server
        .get(PREFIX)
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    assert!(!relocated.join("quires").exists());
}

#[tokio::test]
async fn member_paths_reject_control_characters_as_client_errors() {
    let fixture = ApiFixture::builder().build();
    fixture
        .server
        .post(PREFIX)
        .json(&json!({
            "name": "Invalid path", "color": "sepia",
            "members": [{"path": "bad\u{0}.md", "label": "Bad"}],
        }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn saved_snapshots_are_tracked_by_normal_vault_sync_initialization() {
    use clep_gitsync::init::{InitOpts, LfsPolicy, init};
    let fixture = ApiFixture::builder().build();
    let saved = save(&fixture, json!([])).await;
    let git = clep_gitsync::testing::git(fixture.state.vault.root());
    init(
        &fixture.state.vault,
        &git,
        InitOpts {
            remote: None,
            author: Some(clep_gitsync::testing::author()),
            lfs: LfsPolicy::Skip,
            prompt: None,
            legacy_cas: None,
        },
    )
    .unwrap();
    let tracked = git.run(&["ls-files"]).unwrap();
    let snapshot_path = format!(".clepsydra/quires/{}.json", saved["id"].as_str().unwrap());
    assert!(tracked.lines().any(|path| path == snapshot_path));
}
