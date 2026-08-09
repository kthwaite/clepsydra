mod support;

use std::fs;
use std::path::Path;

use axum::http::StatusCode;
use clepsydra::api::events::SyncNotification;
use clepsydra::api::openapi::ApiDoc;
use clepsydra::vault::base_document;
use support::ApiFixture;
use tokio::sync::broadcast::error::TryRecvError;
use utoipa::OpenApi;

const READING_BASE: &str = r#"
name = "Reading Log"
description = "Books in flight."

[filter]
all = [ { field = "kind", op = "eq", value = "BOOK" } ]

[properties]
author  = { type = "text" }
status  = { type = "select", options = ["queued", "reading", "finished"] }
rating  = { type = "number" }
started = { type = "date" }

[[views]]
name = "Continues"
layout = "table"
filter = { field = "status", op = "eq", value = "reading" }
sort = [ { field = "started", dir = "desc" } ]
columns = ["title", "author", "rating"]
"#;
const IDENTITY_BASE: &str = r#"name = "Identity"

# logical a
[[views]]
name = "A"
layout = "table"
plugin_view = "for-a"

# logical b
[[views]]
name = "B"
layout = "table"
plugin_view = "for-b"
"#;

fn seed_identity_base(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(root.join("bases/identity.base.toml"), IDENTITY_BASE).unwrap();
}

fn seed(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(root.join("bases/reading.base.toml"), READING_BASE).unwrap();
    fs::write(root.join("bases/broken.base.toml"), "name = = nope").unwrap();

    let page = |id: &str, title: &str, extras: &str| {
        format!("+++\nid = \"{id}\"\ntitle = \"{title}\"\ntype = \"BOOK\"\n{extras}+++\nbody\n")
    };
    fs::write(
        root.join("a.md"),
        page(
            "0190f8a0-0000-7000-8000-0000000000a1",
            "Book A",
            "author = \"Wolfe\"\nstatus = \"reading\"\nrating = 9\nstarted = 2026-07-01\n",
        ),
    )
    .unwrap();
    fs::write(
        root.join("b.md"),
        page(
            "0190f8a0-0000-7000-8000-0000000000b1",
            "Book B",
            "author = \"Le Guin\"\nstatus = \"reading\"\nrating = 10\nstarted = 2026-07-30\n",
        ),
    )
    .unwrap();
    fs::write(
        root.join("c.md"),
        page(
            "0190f8a0-0000-7000-8000-0000000000c1",
            "Book C",
            "author = \"Borges\"\nstatus = \"queued\"\n",
        ),
    )
    .unwrap();
}

fn preview_definition() -> serde_json::Value {
    serde_json::json!({
        "name": "Reading Preview",
        "description": "An unsaved definition.",
        "filter": {
            "all": [{ "field": "kind", "op": "eq", "value": "BOOK" }]
        },
        "properties": {
            "author": { "type": "text" },
            "status": {
                "type": "select",
                "options": ["queued", "reading", "finished"]
            },
            "rating": { "type": "number" },
            "started": { "type": "date" }
        },
        "views": [{
            "name": "Continues",
            "layout": "table",
            "filter": { "field": "status", "op": "eq", "value": "reading" },
            "sort": [{ "field": "started", "dir": "desc" }],
            "columns": ["title", "author", "rating"]
        }]
    })
}

fn base_files(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = fs::read_dir(root.join("bases"))
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            (
                path.file_name().unwrap().to_string_lossy().into_owned(),
                fs::read(path).unwrap(),
            )
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}

fn seed_many(root: &Path) {
    seed(root);
    for index in 0..105 {
        fs::write(
            root.join(format!("extra-{index}.md")),
            format!(
                "+++\nid = \"0190f8a0-0000-7000-8000-{index:012x}\"\ntitle = \"Extra {index}\"\ntype = \"BOOK\"\n+++\nbody\n"
            ),
        )
        .unwrap();
    }
}

fn seed_with_unevaluable_base(root: &Path) {
    seed(root);
    fs::write(
        root.join("bases/unevaluable.base.toml"),
        r#"
name = "Unevaluable"
filter = { field = "rating", op = "contains", value = "9" }

[properties]
rating = { type = "number" }
"#,
    )
    .unwrap();
}

#[tokio::test]
async fn preview_matches_saved_evaluation_without_writing() {
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    let vault_root = tmp.path().join("vault");
    let before = base_files(&vault_root);

    let response = server
        .post("/api/vault/bases/preview")
        .json(&serde_json::json!({
            "definition": preview_definition(),
            "view": "Continues",
            "limit": 25,
            "offset": 0
        }))
        .await;
    response.assert_status_ok();
    let preview: serde_json::Value = response.json();

    let saved = server
        .get("/api/vault/bases/reading/views/Continues?limit=25&offset=0")
        .await;
    saved.assert_status_ok();
    assert_eq!(preview["output"], saved.json::<serde_json::Value>());
    assert_eq!(preview["diagnostics"], serde_json::json!([]));
    assert!(preview["evaluation_error"].is_null());
    assert_eq!(base_files(&vault_root), before);
}

#[tokio::test]
async fn preview_without_a_view_evaluates_membership() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();

    let response = server
        .post("/api/vault/bases/preview")
        .json(&serde_json::json!({
            "definition": preview_definition(),
            "view": null
        }))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert_eq!(body["output"]["shape"], "flat");
    assert_eq!(body["output"]["total"], 3);
    assert_eq!(body["output"]["rows"].as_array().unwrap().len(), 3);
    assert_eq!(body["diagnostics"], serde_json::json!([]));
    assert!(body["evaluation_error"].is_null());
}

#[tokio::test]
async fn preview_reports_unknown_view_as_an_evaluation_error_without_writing() {
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    let vault_root = tmp.path().join("vault");
    let before = base_files(&vault_root);

    let response = server
        .post("/api/vault/bases/preview")
        .json(&serde_json::json!({
            "definition": preview_definition(),
            "view": "Missing"
        }))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert!(body["output"].is_null());
    assert!(
        body["evaluation_error"]
            .as_str()
            .unwrap()
            .contains("Missing")
    );
    assert_eq!(body["diagnostics"], serde_json::json!([]));
    assert_eq!(base_files(&vault_root), before);
}

#[tokio::test]
async fn openapi_registers_base_preview_contract() {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();

    assert!(
        document["paths"]["/api/vault/bases/preview"]["post"].is_object(),
        "preview POST should be documented"
    );
    assert!(
        document["components"]["schemas"]["BasePreviewRequest"].is_object(),
        "preview request should be a reusable schema"
    );
    assert!(
        document["components"]["schemas"]["BasePreviewResponse"].is_object(),
        "preview response should be a reusable schema"
    );
}

#[tokio::test]
async fn preview_keeps_structural_diagnostics_separate_from_evaluation_errors() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    let mut definition = preview_definition();
    definition["name"] = serde_json::json!("");

    let response = server
        .post("/api/vault/bases/preview")
        .json(&serde_json::json!({
            "definition": definition,
            "view": null
        }))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert!(body["output"].is_null());
    assert!(body["evaluation_error"].is_null());
    assert!(
        body["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| {
                diagnostic["severity"] == "error"
                    && diagnostic["path"] == "name"
                    && diagnostic["message"] == "base name must not be empty"
            })
    );
}

#[tokio::test]
async fn preview_caps_requested_limit_at_one_hundred() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_many)
        .build()
        .into_server_and_temp();

    let response = server
        .post("/api/vault/bases/preview")
        .json(&serde_json::json!({
            "definition": preview_definition(),
            "view": null,
            "limit": 1_000
        }))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert_eq!(body["output"]["total"], 108);
    assert_eq!(body["output"]["rows"].as_array().unwrap().len(), 100);
}

#[tokio::test]
async fn list_bases_counts_membership_independently() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_with_unevaluable_base)
        .build()
        .into_server_and_temp();

    let response = server.get("/api/vault/bases").await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    let bases = body["bases"].as_array().unwrap();
    let reading = bases.iter().find(|base| base["slug"] == "reading").unwrap();
    let unevaluable = bases
        .iter()
        .find(|base| base["slug"] == "unevaluable")
        .unwrap();

    assert_eq!(reading["match_count"], 3);
    assert!(unevaluable["match_count"].is_null());
}

#[tokio::test]
async fn list_bases_includes_diagnostics_for_broken_base() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();

    let res = server.get("/api/vault/bases").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();

    let bases = body["bases"].as_array().unwrap();
    assert_eq!(bases.len(), 1);
    assert_eq!(bases[0]["slug"], "reading");
    assert_eq!(bases[0]["name"], "Reading Log");
    assert_eq!(bases[0]["views"], serde_json::json!(["Continues"]));

    let diagnostics = body["diagnostics"].as_array().unwrap();
    assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
    assert_eq!(diagnostics[0]["slug"], "broken");
}

#[tokio::test]
async fn get_base_returns_definition_and_unknown_is_404() {
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();

    let res = server.get("/api/vault/bases/reading").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["slug"], "reading");
    assert_eq!(body["properties"]["status"]["type"], "select");
    assert_eq!(body["views"][0]["name"], "Continues");
    assert_eq!(
        body["revision"],
        base_document::revision(
            &fs::read_to_string(tmp.path().join("vault/bases/reading.base.toml")).unwrap()
        )
    );

    server
        .get("/api/vault/bases/nonexistent")
        .await
        .assert_status_not_found();
}

#[tokio::test]
async fn view_evaluation_honors_view_filter_and_sort() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();

    let res = server.get("/api/vault/bases/reading/views/continues").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["shape"], "flat");
    let rows = body["rows"].as_array().unwrap();
    // Only the two `reading` books, sorted started desc.
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["path"], "b.md");
    assert_eq!(rows[1]["path"], "a.md");
    assert_eq!(rows[0]["columns"]["author"], "Le Guin");
    assert_eq!(rows[0]["columns"]["rating"], 10);

    server
        .get("/api/vault/bases/reading/views/nope")
        .await
        .assert_status_not_found();
}

#[tokio::test]
async fn every_accepted_named_view_is_ascii_case_insensitively_addressable() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let response = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "addressable",
            "definition": {
                "name": "Addressable",
                "properties": {
                    "rating": { "type": "number" }
                },
                "views": [
                    { "name": "All", "layout": "table" },
                    {
                        "name": "Rated",
                        "layout": "table",
                        "sort": [{ "field": "rating", "dir": "desc" }]
                    }
                ]
            }
        }))
        .await;
    response.assert_status_ok();
    let created: serde_json::Value = response.json();
    assert_eq!(
        created["views"]
            .as_array()
            .unwrap()
            .iter()
            .map(|view| view["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["All", "Rated"]
    );

    for address in ["all", "RATED"] {
        fixture
            .server
            .get(&format!("/api/vault/bases/addressable/views/{address}"))
            .await
            .assert_status_ok();
    }
}

#[tokio::test]
async fn generic_query_filters_numerically_with_inline_types() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();

    let res = server
        .post("/api/vault/query")
        .json(&serde_json::json!({
            "filter": { "all": [
                { "field": "kind", "op": "eq", "value": "BOOK" },
                { "field": "rating", "op": "gt", "value": 9 }
            ]},
            "types": { "rating": "number" },
            "columns": ["rating"]
        }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{body}");
    assert_eq!(rows[0]["path"], "b.md");
    assert_eq!(body["total"], 1);
}

fn assert_base_registry_changed(
    notifications: &mut tokio::sync::broadcast::Receiver<SyncNotification>,
) {
    assert!(
        matches!(
            notifications.try_recv(),
            Ok(SyncNotification::BaseRegistryChanged)
        ),
        "expected one base_registry_changed notification"
    );
}

fn assert_no_notification(notifications: &mut tokio::sync::broadcast::Receiver<SyncNotification>) {
    assert!(
        matches!(notifications.try_recv(), Err(TryRecvError::Empty)),
        "failed mutation must not emit a notification"
    );
}

#[tokio::test]
async fn create_update_and_delete_are_revision_guarded_and_non_owning() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let root = fixture.state.vault.root();
    let page_path = root.join("a.md");
    let page_before = fs::read_to_string(&page_path).unwrap();
    let mut notifications = fixture.state.change_tx.subscribe();

    let create = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "books",
            "definition": {
                "name": "Books",
                "properties": {
                    "status": { "type": "select", "options": [] }
                },
                "views": [{ "name": "All", "layout": "table" }]
            }
        }))
        .await;
    create.assert_status_ok();
    let created: serde_json::Value = create.json();
    let created_revision = created["revision"].as_str().unwrap().to_owned();
    assert_eq!(created["slug"], "books");
    assert_eq!(
        created_revision,
        base_document::revision(&fs::read_to_string(root.join("bases/books.base.toml")).unwrap())
    );
    assert_base_registry_changed(&mut notifications);

    let stale_update = fixture
        .server
        .put("/api/vault/bases/books")
        .json(&serde_json::json!({
            "expected_revision": "stale",
            "definition": {
                "name": "Books Updated",
                "properties": {
                    "status": { "type": "select", "options": [] }
                },
                "views": [{ "name": "All", "layout": "table" }]
            },
            "view_origins": [{ "kind": "existing", "name": "All" }]
        }))
        .await;
    stale_update.assert_status(StatusCode::CONFLICT);
    let stale_update_error: serde_json::Value = stale_update.json();
    assert_eq!(
        stale_update_error["error"],
        "base definition changed since expected_revision"
    );
    assert_eq!(stale_update_error["detail"]["revision"], created_revision);
    assert_no_notification(&mut notifications);

    let update = fixture
        .server
        .put("/api/vault/bases/books")
        .json(&serde_json::json!({
            "expected_revision": created_revision,
            "definition": {
                "name": "Books Updated",
                "properties": {
                    "status": { "type": "select", "options": [] }
                },
                "views": [{ "name": "All", "layout": "table" }]
            },
            "view_origins": [{ "kind": "existing", "name": "All" }]
        }))
        .await;
    update.assert_status_ok();
    let updated: serde_json::Value = update.json();
    let updated_revision = updated["revision"].as_str().unwrap().to_owned();
    assert_eq!(updated["name"], "Books Updated");
    assert_ne!(updated_revision, created["revision"]);
    assert_eq!(
        updated_revision,
        base_document::revision(&fs::read_to_string(root.join("bases/books.base.toml")).unwrap())
    );
    assert_base_registry_changed(&mut notifications);

    let stale_delete = fixture
        .server
        .delete("/api/vault/bases/books")
        .json(&serde_json::json!({
            "expected_revision": created["revision"]
        }))
        .await;
    stale_delete.assert_status(StatusCode::CONFLICT);
    let stale_delete_error: serde_json::Value = stale_delete.json();
    assert_eq!(stale_delete_error["detail"]["revision"], updated_revision);
    assert_no_notification(&mut notifications);

    fixture
        .server
        .delete("/api/vault/bases/books")
        .json(&serde_json::json!({
            "expected_revision": updated_revision
        }))
        .await
        .assert_status_ok();
    assert!(!root.join("bases/books.base.toml").exists());
    assert_base_registry_changed(&mut notifications);
    assert_eq!(fs::read_to_string(page_path).unwrap(), page_before);
}

#[tokio::test]
async fn update_view_origins_are_validated_and_drive_raw_table_identity() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_identity_base)
        .build();
    let path = fixture.state.vault.root().join("bases/identity.base.toml");
    let before = fs::read_to_string(&path).unwrap();
    let detail = fixture
        .server
        .get("/api/vault/bases/identity")
        .await
        .json::<serde_json::Value>();
    let revision = detail["revision"].as_str().unwrap();

    let malformed = fixture
        .server
        .put("/api/vault/bases/identity")
        .json(&serde_json::json!({
            "expected_revision": revision,
            "definition": {
                "name": "Identity",
                "views": [{ "name": "B", "layout": "table" }]
            },
            "view_origins": []
        }))
        .await;
    malformed.assert_status(StatusCode::CONFLICT);
    assert_eq!(fs::read_to_string(&path).unwrap(), before);

    fixture
        .server
        .put("/api/vault/bases/identity")
        .json(&serde_json::json!({
            "expected_revision": revision,
            "definition": {
                "name": "Identity",
                "views": [{ "name": "B", "layout": "table" }]
            },
            "view_origins": [{ "kind": "existing", "name": "A" }]
        }))
        .await
        .assert_status_ok();
    let after = fs::read_to_string(path).unwrap();
    assert!(after.contains("# logical a\n[[views]]\nname = \"B\""));
    assert!(after.contains("plugin_view = \"for-a\""));
    assert!(!after.contains("plugin_view = \"for-b\""));
}

#[tokio::test]
async fn duplicate_create_is_conflict_without_notification() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let mut notifications = fixture.state.change_tx.subscribe();
    let original =
        fs::read_to_string(fixture.state.vault.root().join("bases/reading.base.toml")).unwrap();

    let response = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "reading",
            "definition": {
                "name": "Replacement",
                "views": [{ "name": "All", "layout": "table" }]
            }
        }))
        .await;
    response.assert_status(StatusCode::CONFLICT);
    assert_no_notification(&mut notifications);
    assert_eq!(
        fs::read_to_string(fixture.state.vault.root().join("bases/reading.base.toml")).unwrap(),
        original
    );
}

#[tokio::test]
async fn unsafe_slug_is_bad_request_without_notification_or_escape() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let mut notifications = fixture.state.change_tx.subscribe();

    let response = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "../escape",
            "definition": {
                "name": "Escape",
                "views": [{ "name": "All", "layout": "table" }]
            }
        }))
        .await;
    response.assert_status(StatusCode::BAD_REQUEST);
    assert_no_notification(&mut notifications);
    assert!(!fixture.temp_dir.path().join("escape.base.toml").exists());
}

#[tokio::test]
async fn blocking_diagnostics_are_bad_request_detail_without_notification() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let mut notifications = fixture.state.change_tx.subscribe();

    let response = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "invalid",
            "definition": {
                "name": "",
                "views": [{ "name": "All", "layout": "table" }]
            }
        }))
        .await;
    response.assert_status(StatusCode::BAD_REQUEST);
    let error: serde_json::Value = response.json();
    assert_eq!(error["status"], 400);
    assert_eq!(error["error"], "base definition is invalid");
    assert!(error.get("hint").is_none());
    let diagnostics = error["detail"]["diagnostics"].as_array().unwrap();
    assert!(diagnostics.iter().any(|diagnostic| {
        diagnostic["slug"] == "invalid"
            && diagnostic["severity"] == "error"
            && diagnostic["path"] == "name"
            && diagnostic["message"] == "base name must not be empty"
    }));
    assert_no_notification(&mut notifications);
    assert!(
        !fixture
            .state
            .vault
            .root()
            .join("bases/invalid.base.toml")
            .exists()
    );
}

#[tokio::test]
async fn case_only_duplicate_view_names_are_rejected_before_publication() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let mut notifications = fixture.state.change_tx.subscribe();

    let response = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "duplicate-views",
            "definition": {
                "name": "Duplicate Views",
                "views": [
                    { "name": "All", "layout": "table" },
                    { "name": "aLL", "layout": "table" }
                ]
            }
        }))
        .await;
    response.assert_status(StatusCode::BAD_REQUEST);
    let error: serde_json::Value = response.json();
    let diagnostics = error["detail"]["diagnostics"].as_array().unwrap();
    assert!(diagnostics.iter().any(|diagnostic| {
        diagnostic["severity"] == "error"
            && diagnostic["path"] == "views[1].name"
            && diagnostic["message"] == "duplicate view name `aLL`"
    }));
    assert_no_notification(&mut notifications);
    assert!(
        !fixture
            .state
            .vault
            .root()
            .join("bases/duplicate-views.base.toml")
            .exists()
    );
}

#[tokio::test]
async fn non_scalar_system_view_sorts_are_rejected_before_publication() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let mut notifications = fixture.state.change_tx.subscribe();

    let response = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "invalid-sorts",
            "definition": {
                "name": "Invalid Sorts",
                "views": [{
                    "name": "All",
                    "layout": "table",
                    "sort": [
                        { "field": "tags" },
                        { "field": "sys.aliases" },
                        { "field": "encryption" }
                    ]
                }]
            }
        }))
        .await;
    response.assert_status(StatusCode::BAD_REQUEST);
    let error: serde_json::Value = response.json();
    let error_paths = error["detail"]["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|diagnostic| diagnostic["severity"] == "error")
        .map(|diagnostic| diagnostic["path"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        error_paths,
        vec![
            "views[0].sort[0].field",
            "views[0].sort[1].field",
            "views[0].sort[2].field",
        ]
    );
    assert_no_notification(&mut notifications);
    assert!(
        !fixture
            .state
            .vault
            .root()
            .join("bases/invalid-sorts.base.toml")
            .exists()
    );
}
