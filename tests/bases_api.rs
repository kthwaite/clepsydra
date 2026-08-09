mod support;

use std::fs;
use std::path::Path;
use std::sync::Arc;

use chrono::{DateTime, Utc};

use axum::http::StatusCode;
use clepsydra::api::Clock;
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

#[derive(Debug)]
struct FixedClock(DateTime<Utc>);

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

fn fixed_now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-08-09T12:34:56Z")
        .unwrap()
        .with_timezone(&Utc)
}

fn member_fixture(seed_fn: impl FnOnce(&Path) + 'static) -> ApiFixture {
    ApiFixture::builder()
        .clock(Arc::new(FixedClock(fixed_now())))
        .pre_index_seed(seed_fn)
        .build()
}

fn collect_page_paths(root: &Path, current: &Path, paths: &mut Vec<String>) {
    for entry in fs::read_dir(current).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name == ".clepsydra") {
                continue;
            }
            collect_page_paths(root, &path, paths);
        } else if path.extension().is_some_and(|extension| extension == "md") {
            paths.push(
                path.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
}

fn page_paths(root: &Path) -> Vec<String> {
    let mut paths = Vec::new();
    collect_page_paths(root, root, &mut paths);
    paths.sort();
    paths
}

async fn current_base_revision(fixture: &ApiFixture, slug: &str) -> String {
    let detail: serde_json::Value = fixture
        .server
        .get(&format!("/api/vault/bases/{slug}"))
        .await
        .json();
    detail["revision"].as_str().unwrap().to_owned()
}

async fn indexed_page_count(fixture: &ApiFixture) -> i64 {
    fixture
        .state
        .index
        .with_index(|index, _| {
            index
                .connection()
                .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
                .unwrap()
        })
        .await
        .unwrap()
}

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
    assert_eq!(body["member_creation"][0]["view"], "Continues");
    assert_eq!(body["member_creation"][0]["enabled"], true);
    assert!(
        body["member_creation"][0]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|field| field["field"] == "status"
                && field["membership"] == false
                && field["view"] == true)
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

#[tokio::test]
async fn create_base_member_writes_one_matching_typed_page() {
    let fixture = member_fixture(seed);
    let revision = current_base_revision(&fixture, "reading").await;
    let mut notifications = fixture.state.change_tx.subscribe();

    let response = fixture
        .server
        .post("/api/vault/bases/reading/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "Continues",
            "title": "The Left Hand of Darkness",
            "fields": {
                "kind": "BOOK",
                "author": "Le Guin",
                "status": "reading",
                "rating": 10,
                "started": "2026-08-09"
            }
        }))
        .await;

    response.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = response.json();
    let path = body["path"].as_str().unwrap();
    assert!(path.starts_with("books/20260809.the-left-hand-of-darkness."));
    assert_eq!(body["title"], "The Left Hand of Darkness");

    let vault_path = clepsydra::vault::path::VaultPath::new(path).unwrap();
    let page = clepsydra::vault::page::Page::from_file(
        &fixture.state.vault.resolve(&vault_path),
        vault_path,
    )
    .unwrap();
    assert_eq!(body["id"], page.meta.id.to_string());
    assert_eq!(
        body["revision"],
        clepsydra::vault::page::page_revision(&page.raw_content)
    );
    assert_eq!(page.meta.kind, Some(clepsydra::vault::kind::Kind::Book));
    assert_eq!(page.meta.extra["rating"], toml::Value::Integer(10));
    assert!(matches!(
        page.meta.extra["started"],
        toml::Value::Datetime(_)
    ));
    assert!(page.body.is_empty());

    let view: serde_json::Value = fixture
        .server
        .get("/api/vault/bases/reading/views/continues")
        .await
        .json();
    assert!(
        view["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == body["id"])
    );
    match notifications.try_recv().unwrap() {
        SyncNotification::IndexChanged { upserted, removed } => {
            assert_eq!(upserted, vec![path]);
            assert!(removed.is_empty());
        }
        other => panic!("unexpected notification: {other:?}"),
    }
}

#[tokio::test]
async fn member_rejections_leave_no_file_or_index_row() {
    let fixture = member_fixture(seed);
    let before_paths = page_paths(fixture.state.vault.root());
    let before_rows = indexed_page_count(&fixture).await;
    let revision = current_base_revision(&fixture, "reading").await;

    for request in [
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Queued", "fields": { "kind": "BOOK", "status": "queued" } }),
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Wrong kind", "fields": { "kind": "NOTE", "status": "reading" } }),
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Bad rating", "fields": { "kind": "BOOK", "status": "reading", "rating": "five" } }),
    ] {
        let response = fixture
            .server
            .post("/api/vault/bases/reading/members")
            .json(&request)
            .await;
        response.assert_status(StatusCode::UNPROCESSABLE_ENTITY);
        let error: serde_json::Value = response.json();
        assert!(error["detail"]["diagnostics"].is_array(), "{error}");
        assert_eq!(page_paths(fixture.state.vault.root()), before_paths);
        assert_eq!(indexed_page_count(&fixture).await, before_rows);
    }
}

#[tokio::test]
async fn member_revision_and_lookup_errors_have_exact_statuses_without_artifacts() {
    let fixture = member_fixture(seed);
    let revision = current_base_revision(&fixture, "reading").await;
    let before = page_paths(fixture.state.vault.root());

    let stale = fixture
        .server
        .post("/api/vault/bases/reading/members")
        .json(&serde_json::json!({
            "base_revision": "stale",
            "view": "Continues",
            "title": "Stale",
            "fields": {}
        }))
        .await;
    stale.assert_status(StatusCode::CONFLICT);
    let error: serde_json::Value = stale.json();
    assert_eq!(error["detail"]["code"], "base_revision_conflict");
    assert_eq!(error["detail"]["current_revision"], revision);

    fixture
        .server
        .post("/api/vault/bases/missing/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "Continues",
            "title": "Missing",
            "fields": {}
        }))
        .await
        .assert_status_not_found();
    fixture
        .server
        .post("/api/vault/bases/reading/members")
        .json(&serde_json::json!({
            "base_revision": current_base_revision(&fixture, "reading").await,
            "view": "Missing",
            "title": "Missing view",
            "fields": {}
        }))
        .await
        .assert_status_not_found();
    assert_eq!(page_paths(fixture.state.vault.root()), before);
}

#[tokio::test]
async fn member_malformed_and_unsupported_fields_are_bad_requests() {
    let fixture = member_fixture(seed);
    let revision = current_base_revision(&fixture, "reading").await;
    let before = page_paths(fixture.state.vault.root());

    for request in [
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "  ", "fields": {} }),
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Unknown", "fields": { "missing": "value" } }),
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Reserved", "fields": { "id": "client-id" } }),
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Bad tags", "fields": { "tags": "not-an-array" } }),
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Bad kind", "fields": { "kind": "MISSING" } }),
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Bad project", "fields": { "project": "../escape" } }),
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Malformed", "fields": [] }),
    ] {
        fixture
            .server
            .post("/api/vault/bases/reading/members")
            .json(&request)
            .await
            .assert_status(StatusCode::BAD_REQUEST);
        assert_eq!(page_paths(fixture.state.vault.root()), before);
    }
}

fn seed_property_types(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(
        root.join("bases/types.base.toml"),
        r#"
name = "Typed"
filter = { field = "kind", op = "eq", value = "NOTE" }

[properties]
text = { type = "text" }
url = { type = "url" }
relation = { type = "relation", many = false }
select = { type = "select", options = ["one", "two"] }
multi = { type = "multi_select", options = ["red", "blue"] }
number = { type = "number" }
bool = { type = "bool" }
date = { type = "date" }
datetime = { type = "datetime" }

[[views]]
name = "Compound"
filter = { all = [
  { any = [
    { field = "select", op = "eq", value = "one" },
    { field = "number", op = "gt", value = 100 }
  ] },
  { not = { field = "bool", op = "eq", value = false } }
] }
"#,
    )
    .unwrap();
}

#[tokio::test]
async fn member_creation_coerces_every_custom_property_type_and_compound_filters() {
    let fixture = member_fixture(seed_property_types);
    let revision = current_base_revision(&fixture, "types").await;
    let response = fixture
        .server
        .post("/api/vault/bases/types/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "compound",
            "title": "Typed values",
            "fields": {
                "text": "hello",
                "prop.url": "https://example.com",
                "relation": ["alpha", "beta"],
                "select": "one",
                "multi": ["red", "blue"],
                "number": 2.5,
                "bool": true,
                "date": "2026-08-09",
                "datetime": "2026-08-09T12:34:56Z",
                "tags": ["typed"],
                "aliases": ["Types"]
            }
        }))
        .await;
    response.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = response.json();
    let path = clepsydra::vault::path::VaultPath::new(body["path"].as_str().unwrap()).unwrap();
    let page =
        clepsydra::vault::page::Page::from_file(&fixture.state.vault.resolve(&path), path).unwrap();
    assert_eq!(
        page.meta.kind,
        Some(clepsydra::vault::kind::Kind::Note),
        "missing kind must persist the NOTE declaration"
    );
    assert_eq!(page.meta.tags, vec!["typed"]);
    assert_eq!(page.meta.aliases, vec!["Types"]);
    assert_eq!(page.meta.extra["text"], toml::Value::String("hello".into()));
    assert_eq!(
        page.meta.extra["url"],
        toml::Value::String("https://example.com".into())
    );
    assert_eq!(
        page.meta.extra["relation"],
        toml::Value::Array(vec![
            toml::Value::String("alpha".into()),
            toml::Value::String("beta".into())
        ])
    );
    assert_eq!(page.meta.extra["select"], toml::Value::String("one".into()));
    assert_eq!(
        page.meta.extra["multi"],
        toml::Value::Array(vec![
            toml::Value::String("red".into()),
            toml::Value::String("blue".into())
        ])
    );
    assert!(matches!(page.meta.extra["number"], toml::Value::Float(_)));
    assert!(matches!(
        page.meta.extra["bool"],
        toml::Value::Boolean(true)
    ));
    assert!(matches!(page.meta.extra["date"], toml::Value::Datetime(_)));
    assert!(matches!(
        page.meta.extra["datetime"],
        toml::Value::Datetime(_)
    ));
}

fn seed_shadowed_title_base(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(
        root.join("bases/shadow.base.toml"),
        r#"
name = "Shadow"

[properties]
title = { type = "text" }

[[views]]
name = "All"
filter = { field = "prop.title", op = "eq", value = "shadow value" }
"#,
    )
    .unwrap();
}

#[tokio::test]
async fn forbidden_fields_are_rejected_through_prop_aliases_before_candidate_validation() {
    let fixture = member_fixture(seed_shadowed_title_base);
    let revision = current_base_revision(&fixture, "shadow").await;
    let before = page_paths(fixture.state.vault.root());

    fixture
        .server
        .post("/api/vault/bases/shadow/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "All",
            "title": "Visible title",
            "fields": { "prop.title": "shadow value" }
        }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);

    assert_eq!(page_paths(fixture.state.vault.root()), before);
}

#[tokio::test]
async fn duplicate_bare_and_prop_field_aliases_are_bad_request_without_artifacts() {
    let fixture = member_fixture(seed);
    let revision = current_base_revision(&fixture, "reading").await;
    let before = page_paths(fixture.state.vault.root());

    fixture
        .server
        .post("/api/vault/bases/reading/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "Continues",
            "title": "Duplicate status",
            "fields": {
                "kind": "BOOK",
                "status": "reading",
                "prop.status": "reading"
            }
        }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);

    assert_eq!(page_paths(fixture.state.vault.root()), before);
}

fn seed_persistable_shadow_base(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(
        root.join("bases/persistable-shadow.base.toml"),
        r#"
name = "Persistable shadow"
filter = { field = "kind", op = "eq", value = "BOOK" }

[properties]
kind = { type = "text" }
word_count = { type = "number" }
project = { type = "text" }
tags = { type = "text" }
aliases = { type = "text" }

[[views]]
name = "Escaped"
filter = { all = [
  { field = "prop.kind", op = "eq", value = "genre" },
  { field = "prop.word_count", op = "eq", value = 7 }
] }
"#,
    )
    .unwrap();
}

#[tokio::test]
async fn bare_system_and_persistable_prop_shadow_fields_coexist() {
    let fixture = member_fixture(seed_persistable_shadow_base);
    let revision = current_base_revision(&fixture, "persistable-shadow").await;

    let response = fixture
        .server
        .post("/api/vault/bases/persistable-shadow/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "Escaped",
            "title": "Shadow fields",
            "fields": {
                "kind": "BOOK",
                "prop.kind": "genre",
                "prop.word_count": 7
            }
        }))
        .await;
    response.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = response.json();
    let path = clepsydra::vault::path::VaultPath::new(body["path"].as_str().unwrap()).unwrap();
    let page =
        clepsydra::vault::page::Page::from_file(&fixture.state.vault.resolve(&path), path).unwrap();
    assert_eq!(page.meta.kind, Some(clepsydra::vault::kind::Kind::Book));
    assert_eq!(page.meta.extra["kind"], toml::Value::String("genre".into()));
    assert_eq!(page.meta.extra["word_count"], toml::Value::Integer(7));
}

#[tokio::test]
async fn unpersistable_prop_system_shadows_are_bad_request_without_artifacts() {
    for field in ["project", "tags", "aliases"] {
        let fixture = member_fixture(seed_persistable_shadow_base);
        let revision = current_base_revision(&fixture, "persistable-shadow").await;
        let before = page_paths(fixture.state.vault.root());
        let prop_field = format!("prop.{field}");

        fixture
            .server
            .post("/api/vault/bases/persistable-shadow/members")
            .json(&serde_json::json!({
                "base_revision": revision,
                "view": "Escaped",
                "title": "Unpersistable shadow",
                "fields": {
                    "kind": "BOOK",
                    (prop_field): "custom"
                }
            }))
            .await
            .assert_status(StatusCode::BAD_REQUEST);
        assert_eq!(page_paths(fixture.state.vault.root()), before);
    }
}

#[tokio::test]
async fn member_index_failure_rolls_back_generated_page_without_notification() {
    let fixture = member_fixture(seed);
    let revision = current_base_revision(&fixture, "reading").await;
    let before = page_paths(fixture.state.vault.root());
    let mut notifications = fixture.state.change_tx.subscribe();
    let _ = fixture
        .state
        .index
        .with_index(|_, _| -> () { panic!("terminate index thread for failure test") })
        .await;

    fixture
        .server
        .post("/api/vault/bases/reading/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "Continues",
            "title": "Rollback",
            "fields": { "kind": "BOOK", "status": "reading" }
        }))
        .await
        .assert_status(StatusCode::INTERNAL_SERVER_ERROR);

    assert_eq!(page_paths(fixture.state.vault.root()), before);
    assert_no_notification(&mut notifications);
}

#[tokio::test]
async fn openapi_registers_base_member_contract() {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();
    assert!(document["paths"]["/api/vault/bases/{slug}/members"]["post"].is_object());
    for schema in [
        "BaseMemberCreateRequest",
        "BaseMemberCreateResponse",
        "BaseMemberValidationDetail",
        "BaseMemberCapability",
        "BaseMemberDiagnostic",
    ] {
        assert!(
            document["components"]["schemas"][schema].is_object(),
            "missing {schema}"
        );
    }
}
