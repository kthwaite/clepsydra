mod support;

use std::fs;
use std::path::Path;

use support::ApiFixture;

const PAGE_ID: &str = "0190f8a0-0000-7000-8000-0000000000f1";

const TOML_PAGE: &str = "+++\n\
id = \"0190f8a0-0000-7000-8000-0000000000f1\"\n\
title = \"Book of the New Sun\"\n\
type = \"BOOK\"\n\
created_at = 2026-01-01T00:00:00Z\n\
updated_at = 2026-01-01T00:00:00Z\n\
# hand-tended reading state\n\
author = \"Gene Wolfe\"\n\
status = \"queued\"\n\
rating = 3\n\
+++\n\
Body line one.\n\
Body line two.\n";

fn seed(root: &Path) {
    fs::write(root.join("book.md"), TOML_PAGE).unwrap();
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(
        root.join("bases/reading.base.toml"),
        "name = \"Reading\"\n\n[properties]\nstarted = { type = \"date\" }\nseries = { type = \"relation\" }\n",
    )
    .unwrap();
    fs::write(
        root.join("solar-cycle.md"),
        "+++\nid = \"0190f8a0-0000-7000-8000-0000000000aa\"\ntitle = \"Solar Cycle\"\n+++\n",
    )
    .unwrap();
}

async fn revision_of(server: &axum_test::TestServer, path: &str) -> String {
    let res = server.get(&format!("/api/vault/pages/{path}")).await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    body["revision"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn patch_is_a_lossless_splice() {
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    let revision = revision_of(&server, "book.md").await;

    let res = server
        .patch(&format!("/api/vault/pages/by-id/{PAGE_ID}/properties"))
        .json(&serde_json::json!({
            "set": { "status": "reading", "progress": 120 },
            "clear": ["rating"],
            "expected_revision": revision,
        }))
        .await;
    res.assert_status_ok();

    let on_disk = fs::read_to_string(tmp.path().join("vault/book.md")).unwrap();

    // The marquee lossless assertion: every line outside the edit set is
    // byte-identical, the comment survives, the body is untouched.
    let before: Vec<&str> = TOML_PAGE.lines().collect();
    let after: Vec<&str> = on_disk.lines().collect();
    for line in &before {
        if line.starts_with("status")
            || line.starts_with("rating")
            || line.starts_with("updated_at")
        {
            continue;
        }
        assert!(
            after.contains(line),
            "line lost by splice: {line}\n{on_disk}"
        );
    }
    assert!(on_disk.contains("# hand-tended reading state\n"));
    assert!(on_disk.contains("status = \"reading\"\n"));
    assert!(on_disk.contains("progress = 120\n"));
    assert!(!on_disk.contains("rating"));
    assert!(on_disk.ends_with("+++\nBody line one.\nBody line two.\n"));

    // Response embeds refreshed properties (read-after-write).
    let body: serde_json::Value = res.json();
    assert_eq!(body["properties"]["status"], "reading");
    assert_eq!(body["properties"]["progress"], 120);
    assert!(body["properties"].get("rating").is_none());
    assert_eq!(body["path"], "book.md");
    // The returned revision matches the on-disk bytes.
    assert_eq!(body["revision"], revision_of(&server, "book.md").await);
}

#[tokio::test]
async fn hinted_date_value_lands_as_native_toml_date() {
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    let revision = revision_of(&server, "book.md").await;

    server
        .patch(&format!("/api/vault/pages/by-id/{PAGE_ID}/properties"))
        .json(&serde_json::json!({
            "set": { "started": "2026-08-06", "noted": "2026-08-06" },
            "types": { "started": "date" },
            "expected_revision": revision,
        }))
        .await
        .assert_status_ok();

    let on_disk = fs::read_to_string(tmp.path().join("vault/book.md")).unwrap();
    assert!(on_disk.contains("started = 2026-08-06\n"), "{on_disk}");
    assert!(on_disk.contains("noted = \"2026-08-06\"\n"), "{on_disk}");
}

#[tokio::test]
async fn stale_revision_conflicts_with_current_revision_detail() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    let current = revision_of(&server, "book.md").await;

    let res = server
        .patch(&format!("/api/vault/pages/by-id/{PAGE_ID}/properties"))
        .json(&serde_json::json!({
            "set": { "status": "reading" },
            "expected_revision": "0000000000000000000000000000000000000000000000000000000000000000",
        }))
        .await;
    res.assert_status(axum::http::StatusCode::CONFLICT);
    let body: serde_json::Value = res.json();
    assert_eq!(body["detail"]["revision"], current);
}

#[tokio::test]
async fn setting_a_relation_updates_links() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    let revision = revision_of(&server, "book.md").await;

    server
        .patch(&format!("/api/vault/pages/by-id/{PAGE_ID}/properties"))
        .json(&serde_json::json!({
            "set": { "series": ["[[Solar Cycle]]"] },
            "expected_revision": revision,
        }))
        .await
        .assert_status_ok();

    let res = server
        .post("/api/vault/query")
        .json(&serde_json::json!({
            "filter": { "field": "series", "op": "links_to", "value": "Solar Cycle" },
            "types": { "series": "relation" }
        }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{body}");
    assert_eq!(rows[0]["path"], "book.md");
}

#[tokio::test]
async fn patch_on_legacy_page_heals_to_toml_then_applies() {
    let legacy_id = "0190f8a0-0000-7000-8000-0000000000e2";
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::write(
                root.join("legacy.md"),
                "---\nid: 0190f8a0-0000-7000-8000-0000000000e2\ntitle: Legacy Book\nauthor: Borges\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\nLegacy body.\n",
            )
            .unwrap();
        })
        .build()
        .into_server_and_temp();
    let revision = revision_of(&server, "legacy.md").await;

    let res = server
        .patch(&format!("/api/vault/pages/by-id/{legacy_id}/properties"))
        .json(&serde_json::json!({
            "set": { "status": "reading" },
            "expected_revision": revision,
        }))
        .await;
    res.assert_status_ok();

    let on_disk = fs::read_to_string(tmp.path().join("vault/legacy.md")).unwrap();
    assert!(on_disk.starts_with("+++\n"), "healed to TOML: {on_disk}");
    assert!(on_disk.contains("status = \"reading\""));
    assert!(on_disk.contains("author = \"Borges\""), "extras survive");
    assert!(on_disk.ends_with("Legacy body.\n"));
}

#[tokio::test]
async fn reserved_system_keys_are_rejected() {
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    let revision = revision_of(&server, "book.md").await;
    let before = fs::read_to_string(tmp.path().join("vault/book.md")).unwrap();

    for body in [
        serde_json::json!({ "set": { "id": "not-yours" }, "expected_revision": revision }),
        serde_json::json!({ "set": { "type": "NOTE" }, "expected_revision": revision }),
        serde_json::json!({ "clear": ["created_at"], "expected_revision": revision }),
    ] {
        let res = server
            .patch(&format!("/api/vault/pages/by-id/{PAGE_ID}/properties"))
            .json(&body)
            .await;
        res.assert_status(axum::http::StatusCode::BAD_REQUEST);
    }

    // Defense in depth: the file is untouched.
    assert_eq!(
        fs::read_to_string(tmp.path().join("vault/book.md")).unwrap(),
        before
    );
}

#[tokio::test]
async fn encryption_system_key_is_reserved() {
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    let revision = revision_of(&server, "book.md").await;
    let before = fs::read_to_string(tmp.path().join("vault/book.md")).unwrap();

    for body in [
        serde_json::json!({
            "set": {
                "encryption": {
                    "format": "age",
                    "version": 1,
                    "key_id": "019fd000-0000-7000-8000-000000000002"
                }
            },
            "expected_revision": revision,
        }),
        serde_json::json!({
            "clear": ["encryption"],
            "expected_revision": revision,
        }),
    ] {
        let res = server
            .patch(&format!("/api/vault/pages/by-id/{PAGE_ID}/properties"))
            .json(&body)
            .await;
        res.assert_status(axum::http::StatusCode::BAD_REQUEST);
    }

    assert_eq!(
        fs::read_to_string(tmp.path().join("vault/book.md")).unwrap(),
        before
    );
}

#[tokio::test]
async fn unknown_page_is_404() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    server
        .patch("/api/vault/pages/by-id/0190f8a0-dead-7000-8000-000000000000/properties")
        .json(&serde_json::json!({
            "set": { "x": 1 },
            "expected_revision": "irrelevant",
        }))
        .await
        .assert_status_not_found();
}

const EMPTY_DECLARATIONS_ID: &str = "0190f8a0-0000-7000-8000-0000000000f2";
const ENCRYPTED_PAGE_ID: &str = "0190f8a0-0000-7000-8000-0000000000f3";
const PREVIEW_PAGE_ID: &str = "0190f8a0-0000-7000-8000-0000000000f4";
const SHADOW_PAGE_ID: &str = "0190f8a0-0000-7000-8000-0000000000f5";

fn projection_property<'a>(response: &'a serde_json::Value, key: &str) -> &'a serde_json::Value {
    response["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|property| property["key"] == key)
        .unwrap_or_else(|| panic!("missing projected property `{key}` in {response}"))
}

fn preview_field<'a>(response: &'a serde_json::Value, key: &str) -> &'a serde_json::Value {
    response["preview"]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|field| field["key"] == key)
        .unwrap_or_else(|| panic!("missing preview field `{key}` in {response}"))
}

fn seed_projection(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(
        root.join("book.md"),
        r#"+++
id = "0190f8a0-0000-7000-8000-0000000000f1"
title = "Book of the New Sun"
type = "BOOK"
status = "reading"
rating = 0
featured = false
empty_values = []
started = 2026-08-01
seen_at = 2026-08-01T12:30:00Z
series = ["[[Solar Cycle]]"]
non_finite = nan
choice_order = "first"
conflict_type = 42
conflict_relation = ["[[Solar Cycle]]"]
kind = "shadow value"
conversation = { provider = "private-provider", ledger_hash = "private-ledger-hash" }
+++
PRIVATE BODY SENTINEL
"#,
    )
    .unwrap();
    fs::write(
        root.join("solar-cycle.md"),
        "+++\nid = \"0190f8a0-0000-7000-8000-0000000000aa\"\ntitle = \"Solar Cycle\"\n+++\n",
    )
    .unwrap();
    fs::write(
        root.join("preview-note.md"),
        format!(
            "+++\nid = \"{PREVIEW_PAGE_ID}\"\ntitle = \"Preview Note\"\ntype = \"PROJECT\"\n+++\n# Heading\n\nA [link](https://example.com) and **bold** body.\n"
        ),
    )
    .unwrap();
    fs::write(
        root.join("shadow-title.md"),
        format!(
            "+++\nid = \"{SHADOW_PAGE_ID}\"\ntitle = \"System title\"\ntype = \"CODE\"\n+++\n"
        ),
    )
    .unwrap();
    fs::write(
        root.join("bases/a-reader.base.toml"),
        r#"name = "Alpha Reader"
filter = { field = "kind", op = "eq", value = "BOOK" }
preview = [
    { field = "rating", label = "" },
    { field = "featured", label = "Featured" },
    { field = "conflict_relation", label = "Series" },
    { field = "non_finite", label = "Non-finite" },
    { field = "body", label = "Summary" },
    { field = "note", label = "Note" },
]


[properties]
status = { type = "select", options = ["queued", "reading"] }
note = { type = "text" }
rating = { type = "number" }
featured = { type = "bool" }
empty_values = { type = "multi_select" }
started = { type = "date" }
seen_at = { type = "datetime" }
series = { type = "relation" }
non_finite = { type = "number" }
choice_order = { type = "select", options = ["first", "second"] }
conflict_type = { type = "text" }
conflict_relation = { type = "relation", many = false }
kind = { type = "text" }
title = { type = "text" }
conversation = { type = "text" }
"#,
    )
    .unwrap();
    fs::write(
        root.join("bases/b-linked.base.toml"),
        r#"name = "Linked Reader"
filter = { field = "series", op = "links_to", value = "Solar Cycle" }
preview = [
    { field = "featured", label = "Spotlight" },
    { field = "prop.rating", label = "rating" },
    { field = "conflict_relation", label = "Series" },
    { field = "sys.title", label = "Title" },
    { field = "body", label = "Summary" },
]


[properties]
status = { type = "select", options = ["queued", "reading"] }
series = { type = "relation", many = true }
choice_order = { type = "select", options = ["second", "first"] }
conflict_type = { type = "number" }
conflict_relation = { type = "relation", many = true }
"#,
    )
    .unwrap();
    fs::write(
        root.join("bases/c-excluded.base.toml"),
        r#"name = "Excluded"
filter = { field = "kind", op = "eq", value = "NOTE" }

[properties]
excluded = { type = "text" }
"#,
    )
    .unwrap();
    fs::write(
        root.join("bases/d-preview-note.base.toml"),
        r#"name = "Project Preview"
filter = { field = "kind", op = "eq", value = "PROJECT" }
preview = [
    { field = "body", label = "Summary" },
    { field = "note", label = "Note" },
]

[properties]
note = { type = "text" }
"#,
    )
    .unwrap();
    fs::write(
        root.join("bases/e-shadow-alpha.base.toml"),
        r#"name = "Shadow Alpha"
filter = { field = "kind", op = "eq", value = "CODE" }
preview = [
    { field = "title", label = "" },
    { field = "prop.title", label = "" },
]

[properties]
title = { type = "text" }
"#,
    )
    .unwrap();
    fs::write(
        root.join("bases/f-shadow-beta.base.toml"),
        r#"name = "Shadow Beta"
filter = { field = "kind", op = "eq", value = "CODE" }
preview = [
    { field = "sys.title", label = "title" },
    { field = "prop.title", label = "prop.title" },
]

[properties]
title = { type = "text" }
"#,
    )
    .unwrap();
}

#[tokio::test]
async fn get_projects_authoritative_membership_values_provenance_and_privacy() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_projection)
        .build()
        .into_server_and_temp();

    let response = server
        .get(&format!("/api/vault/pages/by-id/{PAGE_ID}/properties"))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert_eq!(body["id"], PAGE_ID);
    assert_eq!(body["path"], "book.md");
    assert!(
        body["revision"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert_eq!(body["encrypted"], false);
    assert_eq!(
        body["matching_bases"],
        serde_json::json!([
            { "slug": "a-reader", "name": "Alpha Reader" },
            { "slug": "b-linked", "name": "Linked Reader" }
        ])
    );
    assert_eq!(body["preview"]["remaining_count"], 3);
    assert_eq!(
        body["preview"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|field| field["key"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["rating", "featured", "conflict_relation", "non_finite"]
    );
    assert_eq!(
        preview_field(&body, "rating"),
        &serde_json::json!({
            "key": "rating",
            "label": "rating",
            "present": true,
            "value": 0,
            "schema_conflict": false,
            "label_conflict": false,
            "sources": [
                {
                    "base": { "slug": "a-reader", "name": "Alpha Reader" }
                },
                {
                    "base": { "slug": "b-linked", "name": "Linked Reader" },
                    "label": "rating"
                }
            ]
        })
    );
    let featured_preview = preview_field(&body, "featured");
    assert_eq!(featured_preview["label"], "featured");
    assert_eq!(featured_preview["present"], true);
    assert_eq!(featured_preview["value"], false);
    assert_eq!(featured_preview["schema_conflict"], false);
    assert_eq!(featured_preview["label_conflict"], true);
    assert_eq!(
        featured_preview["sources"],
        serde_json::json!([
            {
                "base": { "slug": "a-reader", "name": "Alpha Reader" },
                "label": "Featured"
            },
            {
                "base": { "slug": "b-linked", "name": "Linked Reader" },
                "label": "Spotlight"
            }
        ])
    );
    let conflicted_preview = preview_field(&body, "conflict_relation");
    assert_eq!(conflicted_preview["label"], "Series");
    assert_eq!(conflicted_preview["present"], true);
    assert_eq!(
        conflicted_preview["value"],
        serde_json::json!(["[[Solar Cycle]]"])
    );
    assert_eq!(conflicted_preview["schema_conflict"], true);
    assert_eq!(conflicted_preview["label_conflict"], false);
    let non_finite_preview = preview_field(&body, "non_finite");
    assert_eq!(non_finite_preview["present"], true);
    assert_eq!(non_finite_preview["value"], serde_json::Value::Null);
    assert_eq!(non_finite_preview["schema_conflict"], false);
    assert_eq!(non_finite_preview["label_conflict"], false);
    let keys = body["properties"]
        .as_array()
        .unwrap()
        .iter()
        .map(|property| property["key"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        keys,
        vec![
            "choice_order",
            "conflict_relation",
            "conflict_type",
            "conversation",
            "empty_values",
            "featured",
            "kind",
            "non_finite",
            "note",
            "rating",
            "seen_at",
            "series",
            "started",
            "status",
            "title",
        ]
    );

    let status = projection_property(&body, "status");
    assert_eq!(status["present"], true);
    assert_eq!(status["value"], "reading");
    assert_eq!(status["compatibility"], "compatible");
    assert_eq!(
        status["definition"],
        serde_json::json!({
            "type": "select",
            "options": ["queued", "reading"]
        })
    );
    assert_eq!(status["patchable"], true);
    assert_eq!(status["blockers"], serde_json::json!([]));
    assert_eq!(
        status["declarations"],
        serde_json::json!([
            {
                "base": { "slug": "a-reader", "name": "Alpha Reader" },
                "definition": {
                    "type": "select",
                    "options": ["queued", "reading"]
                }
            },
            {
                "base": { "slug": "b-linked", "name": "Linked Reader" },
                "definition": {
                    "type": "select",
                    "options": ["queued", "reading"]
                }
            }
        ])
    );

    let relation = projection_property(&body, "series");
    assert_eq!(relation["compatibility"], "compatible");
    assert_eq!(
        relation["definition"],
        serde_json::json!({ "type": "relation", "many": true })
    );
    assert_eq!(
        relation["declarations"],
        serde_json::json!([
            {
                "base": { "slug": "a-reader", "name": "Alpha Reader" },
                "definition": { "type": "relation" }
            },
            {
                "base": { "slug": "b-linked", "name": "Linked Reader" },
                "definition": { "type": "relation", "many": true }
            }
        ])
    );

    assert_eq!(projection_property(&body, "note")["present"], false);
    assert_eq!(
        projection_property(&body, "note")["value"],
        serde_json::Value::Null
    );
    let featured = projection_property(&body, "featured");
    assert_eq!(featured["present"], true);
    assert_eq!(featured["value"], false);
    let rating = projection_property(&body, "rating");
    assert_eq!(rating["present"], true);
    assert_eq!(rating["value"], 0);
    let empty_values = projection_property(&body, "empty_values");
    assert_eq!(empty_values["present"], true);
    assert_eq!(empty_values["value"], serde_json::json!([]));
    let non_finite = projection_property(&body, "non_finite");
    assert_eq!(non_finite["present"], true);
    assert_eq!(non_finite["value"], serde_json::Value::Null);
    assert_eq!(projection_property(&body, "started")["value"], "2026-08-01");
    assert_eq!(
        projection_property(&body, "seen_at")["value"],
        "2026-08-01T12:30:00Z"
    );

    for key in ["choice_order", "conflict_relation", "conflict_type"] {
        let property = projection_property(&body, key);
        assert_eq!(property["compatibility"], "conflict", "{key}: {property}");
        assert_eq!(property["definition"], serde_json::Value::Null);
        assert_eq!(property["patchable"], false);
        assert_eq!(property["blockers"], serde_json::json!(["schema_conflict"]));
    }
    assert_eq!(projection_property(&body, "choice_order")["value"], "first");
    assert_eq!(projection_property(&body, "conflict_type")["value"], 42);
    assert_eq!(
        projection_property(&body, "conflict_relation")["value"],
        serde_json::json!(["[[Solar Cycle]]"])
    );

    for key in ["conversation", "kind", "title"] {
        let property = projection_property(&body, key);
        assert_eq!(property["present"], false, "{key}: {property}");
        assert_eq!(property["value"], serde_json::Value::Null);
        assert_eq!(property["patchable"], false);
        assert_eq!(property["blockers"], serde_json::json!(["reserved_key"]));
        assert_eq!(property["declarations"].as_array().unwrap().len(), 1);
    }
    let serialized = serde_json::to_string(&body).unwrap();
    assert!(!serialized.contains("private-provider"), "{serialized}");
    assert!(!serialized.contains("private-ledger-hash"), "{serialized}");
    assert!(
        !serialized.contains("PRIVATE BODY SENTINEL"),
        "{serialized}"
    );
}

#[tokio::test]
async fn get_projects_body_excerpt_and_missing_custom_value() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_projection)
        .build()
        .into_server_and_temp();

    let response = server
        .get(&format!(
            "/api/vault/pages/by-id/{PREVIEW_PAGE_ID}/properties"
        ))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert_eq!(
        body["matching_bases"],
        serde_json::json!([
            { "slug": "d-preview-note", "name": "Project Preview" }
        ])
    );
    assert_eq!(body["preview"]["remaining_count"], 0);
    assert_eq!(
        preview_field(&body, "body"),
        &serde_json::json!({
            "key": "body",
            "label": "Summary",
            "present": true,
            "value": "Heading A link and bold body.",
            "schema_conflict": false,
            "label_conflict": false,
            "sources": [{
                "base": { "slug": "d-preview-note", "name": "Project Preview" },
                "label": "Summary"
            }]
        })
    );
    assert_eq!(
        preview_field(&body, "note"),
        &serde_json::json!({
            "key": "note",
            "label": "Note",
            "present": false,
            "value": null,
            "schema_conflict": false,
            "label_conflict": false,
            "sources": [{
                "base": { "slug": "d-preview-note", "name": "Project Preview" },
                "label": "Note"
            }]
        })
    );
}

#[tokio::test]
async fn get_keeps_shadowed_system_and_property_preview_identities_distinct() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_projection)
        .build()
        .into_server_and_temp();

    let response = server
        .get(&format!(
            "/api/vault/pages/by-id/{SHADOW_PAGE_ID}/properties"
        ))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    let fields = body["preview"]["fields"].as_array().unwrap();

    assert_eq!(body["preview"]["remaining_count"], 0);
    assert_eq!(
        fields
            .iter()
            .map(|field| field["key"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["title", "prop.title"]
    );
    assert_eq!(
        fields[0],
        serde_json::json!({
            "key": "title",
            "label": "title",
            "present": true,
            "value": "System title",
            "schema_conflict": false,
            "label_conflict": false,
            "sources": [
                {
                    "base": { "slug": "e-shadow-alpha", "name": "Shadow Alpha" }
                },
                {
                    "base": { "slug": "f-shadow-beta", "name": "Shadow Beta" },
                    "label": "title"
                }
            ]
        })
    );
    assert_eq!(
        fields[1],
        serde_json::json!({
            "key": "prop.title",
            "label": "prop.title",
            "present": false,
            "value": null,
            "schema_conflict": false,
            "label_conflict": false,
            "sources": [
                {
                    "base": { "slug": "e-shadow-alpha", "name": "Shadow Alpha" }
                },
                {
                    "base": { "slug": "f-shadow-beta", "name": "Shadow Beta" },
                    "label": "prop.title"
                }
            ]
        })
    );
}

#[tokio::test]
async fn get_distinguishes_no_matching_bases_from_bases_without_properties() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::create_dir_all(root.join("bases")).unwrap();
            fs::write(root.join("book.md"), TOML_PAGE).unwrap();
            fs::write(
                root.join("empty.md"),
                format!(
                    "+++\nid = \"{EMPTY_DECLARATIONS_ID}\"\ntitle = \"Empty Declarations\"\ntype = \"NOTE\"\n+++\n"
                ),
            )
            .unwrap();
            fs::write(
                root.join("bases/empty.base.toml"),
                "name = \"Empty Base\"\nfilter = { field = \"kind\", op = \"eq\", value = \"NOTE\" }\n",
            )
            .unwrap();
        })
        .build()
        .into_server_and_temp();

    let no_matches: serde_json::Value = server
        .get(&format!("/api/vault/pages/by-id/{PAGE_ID}/properties"))
        .await
        .json();
    assert_eq!(no_matches["matching_bases"], serde_json::json!([]));
    assert_eq!(no_matches["properties"], serde_json::json!([]));
    assert_eq!(
        no_matches["preview"],
        serde_json::json!({ "fields": [], "remaining_count": 0 })
    );

    let no_declarations: serde_json::Value = server
        .get(&format!(
            "/api/vault/pages/by-id/{EMPTY_DECLARATIONS_ID}/properties"
        ))
        .await
        .json();
    assert_eq!(
        no_declarations["matching_bases"],
        serde_json::json!([{ "slug": "empty", "name": "Empty Base" }])
    );
    assert_eq!(no_declarations["properties"], serde_json::json!([]));
    assert_eq!(
        no_declarations["preview"],
        serde_json::json!({ "fields": [], "remaining_count": 0 })
    );
}

#[tokio::test]
async fn get_reports_encryption_without_exposing_the_page_body() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::create_dir_all(root.join("bases")).unwrap();
            fs::write(
                root.join("protected.md"),
                format!(
                    "+++\nid = \"{ENCRYPTED_PAGE_ID}\"\ntitle = \"Protected\"\nencryption = {{ format = \"age\", version = 1, key_id = \"019fd000-0000-7000-8000-000000000002\" }}\nstatus = \"private\"\n+++\n{}",
                    include_str!("support/fixtures/private-note.age")
                ),
            )
            .unwrap();
            fs::write(
                root.join("bases/protected.base.toml"),
                "name = \"Protected Metadata\"\nfilter = { field = \"kind\", op = \"eq\", value = \"NOTE\" }\npreview = [\n    { field = \"status\", label = \"Status\" },\n    { field = \"body\", label = \"Summary\" },\n]\n\n[properties]\nstatus = { type = \"text\" }\n",
            )
            .unwrap();
        })
        .build()
        .into_server_and_temp();

    let response = server
        .get(&format!(
            "/api/vault/pages/by-id/{ENCRYPTED_PAGE_ID}/properties"
        ))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    assert_eq!(body["encrypted"], true);
    assert_eq!(projection_property(&body, "status")["value"], "private");
    assert_eq!(
        body["preview"],
        serde_json::json!({ "fields": [], "remaining_count": 0 })
    );
    let serialized = serde_json::to_string(&body).unwrap();
    assert!(
        !serialized.contains("BEGIN AGE ENCRYPTED FILE"),
        "{serialized}"
    );
    assert!(!serialized.contains("YWdlLWVuY3J5cHRpb24"), "{serialized}");
}

#[tokio::test]
async fn patch_then_get_refreshes_authoritative_membership_entry_and_exit() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::create_dir_all(root.join("bases")).unwrap();
            fs::write(root.join("book.md"), TOML_PAGE).unwrap();
            fs::write(
                root.join("bases/reading.base.toml"),
                r#"name = "Reading"
filter = { field = "status", op = "eq", value = "reading" }

[properties]
status = { type = "select", options = ["queued", "reading"] }
"#,
            )
            .unwrap();
        })
        .build()
        .into_server_and_temp();

    let before: serde_json::Value = server
        .get(&format!("/api/vault/pages/by-id/{PAGE_ID}/properties"))
        .await
        .json();
    assert_eq!(before["matching_bases"], serde_json::json!([]));

    let enter: serde_json::Value = server
        .patch(&format!("/api/vault/pages/by-id/{PAGE_ID}/properties"))
        .json(&serde_json::json!({
            "set": { "status": "reading" },
            "expected_revision": before["revision"],
        }))
        .await
        .json();
    let entered: serde_json::Value = server
        .get(&format!("/api/vault/pages/by-id/{PAGE_ID}/properties"))
        .await
        .json();
    assert_eq!(
        entered["matching_bases"],
        serde_json::json!([{ "slug": "reading", "name": "Reading" }])
    );

    server
        .patch(&format!("/api/vault/pages/by-id/{PAGE_ID}/properties"))
        .json(&serde_json::json!({
            "set": { "status": "queued" },
            "expected_revision": enter["revision"],
        }))
        .await
        .assert_status_ok();
    let exited: serde_json::Value = server
        .get(&format!("/api/vault/pages/by-id/{PAGE_ID}/properties"))
        .await
        .json();
    assert_eq!(exited["matching_bases"], serde_json::json!([]));
    assert_eq!(exited["properties"], serde_json::json!([]));
}

#[tokio::test]
async fn get_rejects_malformed_or_unknown_ids_and_surfaces_evaluator_failures() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::create_dir_all(root.join("bases")).unwrap();
            fs::write(root.join("book.md"), TOML_PAGE).unwrap();
            fs::write(
                root.join("bases/invalid.base.toml"),
                r#"name = "Invalid evaluator"
filter = { field = "rating", op = "contains", value = "3" }

[properties]
rating = { type = "number" }
"#,
            )
            .unwrap();
        })
        .build()
        .into_server_and_temp();

    server
        .get("/api/vault/pages/by-id/not-a-uuid/properties")
        .await
        .assert_status_bad_request();
    server
        .get("/api/vault/pages/by-id/0190f8a0-dead-7000-8000-000000000000/properties")
        .await
        .assert_status_not_found();
    server
        .get(&format!("/api/vault/pages/by-id/{PAGE_ID}/properties"))
        .await
        .assert_status_internal_server_error();
}
