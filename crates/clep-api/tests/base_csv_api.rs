mod support;

use serde_json::{Value, json};
use std::fs;
use support::ApiFixture;

const BASE: &str = r#"name = "CSV"
[properties]
score = { type = "number", default = 7 }
topics = { type = "multi_select" }
[[templates]]
name = "Draft"
fields = { score = 9 }
body = "Template body survives."
[[views]]
name = "All"
columns = ["title", "score", "topics"]
[views.labels]
title = "Name"
"#;

fn fixture() -> ApiFixture {
    ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::create_dir_all(root.join("bases")).unwrap();
            fs::write(root.join("bases/csv.base.toml"), BASE).unwrap();
        })
        .build()
}

async fn revision(f: &ApiFixture) -> String {
    let detail: Value = f.server.get("/api/vault/bases/csv").await.json();
    detail["revision"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn preview_types_inferred_fields_reports_every_bad_row_and_never_writes() {
    let f = fixture();
    let before = fs::read_to_string(f.state.vault.root().join("bases/csv.base.toml")).unwrap();
    let response = f.server.post("/api/vault/bases/csv/views/All/import/preview")
        .json(&json!({"base_revision": revision(&f).await, "csv": "title,score,approved,topics\nFirst,no,true,a;b\nSecond,also-no,false,b;c\n"})).await;
    response.assert_status_ok();
    let preview: Value = response.json();
    assert_eq!(preview["valid"], false);
    assert_eq!(preview["declarations"][0]["key"], "approved");
    assert_eq!(preview["declarations"][0]["definition"]["type"], "bool");
    assert!(
        !preview["rows"][0]["diagnostics"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        !preview["rows"][1]["diagnostics"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fs::read_to_string(f.state.vault.root().join("bases/csv.base.toml")).unwrap(),
        before
    );
    let rows: Value = f.server.get("/api/vault/bases/csv/views/All").await.json();
    assert_eq!(rows["total"], 0);
}

#[tokio::test]
async fn members_preserve_template_body_defaults_and_explicit_clears() {
    let f = fixture();
    let revision = revision(&f).await;
    let created = f.server.post("/api/vault/bases/csv/members").json(&json!({
        "base_revision": revision, "view": "All", "title": "Template", "template": "Draft", "fields": {"score": null}
    })).await;
    created.assert_status(axum::http::StatusCode::CREATED);
    let created: Value = created.json();
    let source =
        fs::read_to_string(f.state.vault.root().join(created["path"].as_str().unwrap())).unwrap();
    assert!(source.contains("Template body survives."));
    assert!(!source.contains("score ="));
    let overridden = f.server.post("/api/vault/bases/csv/members").json(&json!({
        "base_revision": revision, "view": "All", "title": "Explicit", "template": "Draft", "body": "Edited body", "fields": {"score": 3}
    })).await;
    overridden.assert_status(axum::http::StatusCode::CREATED);
    let overridden: Value = overridden.json();
    let source = fs::read_to_string(
        f.state
            .vault
            .root()
            .join(overridden["path"].as_str().unwrap()),
    )
    .unwrap();
    assert!(source.contains("Edited body"));
    assert!(!source.contains("Template body survives."));
}

#[tokio::test]
async fn export_quotes_values_and_exports_beyond_saved_window_and_preview_rejects_stale_revision() {
    let f = fixture();
    let revision = revision(&f).await;
    for title in ["A, quoted \"title\"", "B\nsecond line"] {
        f.server.post("/api/vault/bases/csv/members").json(&json!({
            "base_revision": revision, "view": "All", "title": title, "fields": {"topics": ["alpha", "beta"]}
        })).await.assert_status(axum::http::StatusCode::CREATED);
    }
    let response = f
        .server
        .get("/api/vault/bases/csv/views/All/export.csv")
        .add_query_param("limit", 1)
        .add_query_param("offset", 1)
        .add_query_param("columns", "[\"sys.title\",\"topics\"]")
        .await;
    response.assert_status_ok();
    let csv = response.text();
    assert!(csv.starts_with("Name,topics\n"));
    assert!(csv.contains("\"A, quoted \"\"title\"\"\""));
    assert!(csv.contains("\"B\nsecond line\""));
    assert_eq!(csv.matches("alpha;beta").count(), 2);
    f.server
        .post("/api/vault/bases/csv/views/All/import/preview")
        .json(&json!({
            "base_revision": "stale", "csv": "title\nNo write\n"
        }))
        .await
        .assert_status_conflict();
}

#[tokio::test]
async fn approved_preview_declarations_can_be_saved_then_all_typed_rows_created() {
    let f = fixture();
    let old_revision = revision(&f).await;
    let response = f.server.post("/api/vault/bases/csv/views/All/import/preview").json(&json!({
        "base_revision": old_revision,
        "csv": "Name,score,approved,website,started,email,topics\nAlpha,12,true,https://example.com,2026-10-17,a@example.com,one;two\nBeta,13,false,https://example.org,2026-10-18,b@example.com,two\n"
    })).await;
    response.assert_status_ok();
    let preview: Value = response.json();
    assert_eq!(preview["valid"], true, "{preview}");
    assert_eq!(preview["rows"][0]["fields"]["score"], 12);
    assert_eq!(preview["rows"][0]["fields"]["approved"], true);
    assert_eq!(
        preview["rows"][0]["fields"]["topics"],
        json!(["one", "two"])
    );
    let inferred: Vec<_> = preview["declarations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["key"].as_str().unwrap(),
                entry["definition"]["type"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        inferred,
        vec![
            ("approved", "bool"),
            ("website", "url"),
            ("started", "date"),
            ("email", "text")
        ]
    );
    let mut definition: Value = f.server.get("/api/vault/bases/csv").await.json();
    definition["properties"]
        .as_array_mut()
        .unwrap()
        .extend(preview["declarations"].as_array().unwrap().iter().cloned());
    let saved = f
        .server
        .put("/api/vault/bases/csv")
        .json(&json!({
            "expected_revision": old_revision, "definition": definition,
            "view_origins": [{"kind": "existing", "name": "All"}]
        }))
        .await;
    saved.assert_status_ok();
    let saved: Value = saved.json();
    for row in preview["rows"].as_array().unwrap() {
        f.server.post("/api/vault/bases/csv/members").json(&json!({
            "base_revision": saved["revision"], "view": "All", "title": row["title"], "fields": row["fields"]
        })).await.assert_status(axum::http::StatusCode::CREATED);
    }
    let rows: Value = f.server.get("/api/vault/bases/csv/views/All").await.json();
    assert_eq!(rows["total"], 2);
    f.server
        .post("/api/vault/bases/csv/members")
        .json(&json!({
            "base_revision": old_revision, "view": "All", "title": "Stale import"
        }))
        .await
        .assert_status_conflict();
}

#[tokio::test]
async fn preview_mapping_overrides_skip_columns_and_validate_composed_membership() {
    let f = fixture();
    let request = json!({
        "base_revision": revision(&f).await, "csv": "Name,Points,Ignore\nGood,4,anything\nBad,3,anything\n",
        "mappings": [{"column": 1, "field": "score"}, {"column": 2, "field": null}],
        "embed_filter": {"field": "score", "op": "gte", "value": 4}
    });
    let response = f
        .server
        .post("/api/vault/bases/csv/views/All/import/preview")
        .json(&request)
        .await;
    response.assert_status_ok();
    let preview: Value = response.json();
    assert_eq!(preview["valid"], false);
    assert_eq!(preview["declarations"], json!([]));
    assert_eq!(preview["rows"][0]["diagnostics"], json!([]));
    assert!(
        !preview["rows"][1]["diagnostics"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(preview["rows"][1]["diagnostics"][0]["row"], 3);
    let rows: Value = f.server.get("/api/vault/bases/csv/views/All").await.json();
    assert_eq!(rows["total"], 0);
}

#[tokio::test]
async fn csv_exports_never_materialize_protected_body_or_conversation_ledger() {
    let f = ApiFixture::builder().pre_index_seed(|root| {
        fs::create_dir_all(root.join("bases")).unwrap();
        fs::write(root.join("bases/privacy.base.toml"), r#"name = "Privacy"
[properties]
conversation = { type = "text" }
[[views]]
name = "All"
columns = ["title", "body", "conversation", "prop.conversation"]
"#).unwrap();
        fs::write(root.join("protected.md"), format!(
            "+++\nid = \"019fd000-0000-7000-8000-000000000601\"\ntitle = \"Protected\"\nencryption = {{ format = \"age\", version = 1, key_id = \"019fd000-0000-7000-8000-000000000002\" }}\nconversation = \"PRIVATE_LEDGER\"\n+++\n{}",
            clep_test_support::PRIVATE_NOTE_AGE
        )).unwrap();
        fs::write(root.join("ordinary.md"), "+++\nid = \"019fd000-0000-7000-8000-000000000602\"\ntitle = \"Ordinary\"\nconversation = \"PRIVATE_UNENCRYPTED_LEDGER\"\n+++\nPublic body.").unwrap();
    }).build();
    let response = f
        .server
        .get("/api/vault/bases/privacy/views/All/export.csv")
        .await;
    response.assert_status_ok();
    let exported = response.text();
    assert!(exported.contains("Public body."));
    assert!(exported.contains("Protected"));
    assert!(!exported.contains("PRIVATE_"));
    assert!(!exported.contains("BEGIN AGE ENCRYPTED FILE"));
    let revision = f
        .server
        .get("/api/vault/bases/privacy")
        .await
        .json::<Value>()["revision"]
        .clone();
    let response = f
        .server
        .post("/api/vault/bases/privacy/views/All/import/preview")
        .json(&json!({
            "base_revision": revision, "csv": "title,conversation\nAttempt,PRIVATE_LEDGER\n",
            "mappings": [{"column": 1, "field": "prop.conversation"}]
        }))
        .await;
    response.assert_status_ok();
    assert_eq!(response.json::<Value>()["valid"], false);
}

#[tokio::test]
async fn missing_titles_use_template_but_explicit_blank_or_null_titles_are_rejected() {
    let f = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::create_dir_all(root.join("bases")).unwrap();
            fs::write(
                root.join("bases/csv.base.toml"),
                r#"name = "Titles"
title_template = "{author}: {work}"
[properties]
author = { type = "text", default = "Default author" }
work = { type = "text" }
[[views]]
name = "All"
"#,
            )
            .unwrap();
        })
        .build();
    let revision = revision(&f).await;
    let response = f
        .server
        .post("/api/vault/bases/csv/views/All/import/preview")
        .json(&json!({
            "base_revision": revision, "csv": "work\nBook\n"
        }))
        .await;
    response.assert_status_ok();
    let preview: Value = response.json();
    assert_eq!(preview["valid"], true, "{preview}");
    assert_eq!(preview["rows"][0]["title"], "Default author: Book");
    for title in [json!(""), Value::Null] {
        f.server
            .post("/api/vault/bases/csv/members")
            .json(&json!({
                "base_revision": revision, "view": "All", "title": title, "fields": {"work": "Book"}
            }))
            .await
            .assert_status_bad_request();
    }
}

#[tokio::test]
async fn body_templates_satisfy_word_count_membership_and_explicit_empty_body_does_not() {
    let f = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::create_dir_all(root.join("bases")).unwrap();
            fs::write(
                root.join("bases/csv.base.toml"),
                r#"name = "Longform"
filter = { field = "word_count", op = "gt", value = 0 }
[[templates]]
name = "Seed"
fields = {}
body = "Starting content."
[[views]]
name = "All"
"#,
            )
            .unwrap();
        })
        .build();
    let detail: Value = f.server.get("/api/vault/bases/csv").await.json();
    assert_eq!(detail["member_creation"][0]["enabled"], true);
    let revision = &detail["revision"];
    for (title, body) in [
        ("Explicit body", Some("Written content.")),
        ("Template body", None),
    ] {
        let mut request =
            json!({"base_revision": revision, "view": "All", "title": title, "template": "Seed"});
        if let Some(body) = body {
            request["body"] = json!(body);
        }
        f.server
            .post("/api/vault/bases/csv/members")
            .json(&request)
            .await
            .assert_status(axum::http::StatusCode::CREATED);
    }
    f.server.post("/api/vault/bases/csv/members").json(&json!({
        "base_revision": revision, "view": "All", "title": "Explicitly cleared", "template": "Seed", "body": ""
    })).await.assert_status(axum::http::StatusCode::UNPROCESSABLE_ENTITY);
    let rows: Value = f.server.get("/api/vault/bases/csv/views/All").await.json();
    assert_eq!(rows["total"], 2);
}

#[tokio::test]
async fn export_honors_filters_multisort_search_visible_columns_and_labels() {
    let f = fixture();
    let revision = revision(&f).await;
    for (title, score) in [("Match Alpha", 1), ("Match Beta", 2), ("Match Gamma", 3)] {
        f.server
            .post("/api/vault/bases/csv/members")
            .json(&json!({
                "base_revision": revision, "view": "All", "title": title,
                "fields": {"score": score, "topics": ["hiddenneedle"]}
            }))
            .await
            .assert_status(axum::http::StatusCode::CREATED);
    }
    let response = f
        .server
        .get("/api/vault/bases/csv/views/All/export.csv")
        .add_query_param("columns", json!(["score", "title"]).to_string())
        .add_query_param(
            "filter",
            json!({"field":"score","op":"gte","value":2}).to_string(),
        )
        .add_query_param(
            "sort_keys",
            json!([{"field":"score","dir":"desc"},{"field":"title","dir":"asc"}]).to_string(),
        )
        .add_query_param("q", "Match")
        .await;
    response.assert_status_ok();
    let text = response.text();
    let mut reader = csv::Reader::from_reader(text.as_bytes());
    assert_eq!(
        reader.headers().unwrap().iter().collect::<Vec<_>>(),
        vec!["score", "Name"]
    );
    let records = reader
        .records()
        .map(|row| row.unwrap().iter().map(str::to_owned).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    assert_eq!(
        records,
        vec![vec!["3", "Match Gamma"], vec!["2", "Match Beta"]]
    );
    let response = f
        .server
        .get("/api/vault/bases/csv/views/All/export.csv")
        .add_query_param("columns", json!(["title"]).to_string())
        .add_query_param("q", "hiddenneedle")
        .await;
    response.assert_status_ok();
    assert_eq!(response.text().trim(), "Name");
}

#[tokio::test]
async fn collection_membership_prefills_create_valid_members_and_csv_candidates() {
    let f = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::create_dir_all(root.join("bases")).unwrap();
            fs::write(
                root.join("bases/csv.base.toml"),
                r#"
name = "Collections"
filter = { all = [
  { field = "tags", op = "contains", value = "reading" },
  { field = "topics", op = "contains", value = "fiction" },
] }
[properties.topics]
type = "multi_select"
default = ["other"]
[[templates]]
name = "Draft"
fields = { tags = ["other"], topics = ["other"] }
[[views]]
name = "All"
columns = ["title", "tags", "topics"]
"#,
            )
            .unwrap();
        })
        .build();
    let revision = revision(&f).await;
    let preview = f
        .server
        .post("/api/vault/bases/csv/views/All/import/preview")
        .json(&json!({"base_revision": revision, "csv": "title\nImported\n"}))
        .await;
    preview.assert_status_ok();
    let preview: Value = preview.json();
    assert_eq!(preview["valid"], true, "{preview}");
    f.server
        .post("/api/vault/bases/csv/members")
        .json(&json!({
            "base_revision": revision, "view": "All", "title": "Created", "template": "Draft"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);
    let output: Value = f.server.get("/api/vault/bases/csv/views/All").await.json();
    let tags = output["rows"][0]["columns"]["tags"].as_array().unwrap();
    assert!(tags.contains(&json!("reading")));
    assert!(!tags.contains(&json!("other")));
    assert_eq!(output["rows"][0]["columns"]["topics"], json!(["fiction"]));
    f.server
        .post("/api/vault/bases/csv/members")
        .json(&json!({
            "base_revision": revision, "view": "All", "title": "Contradiction",
            "fields": { "topics": ["other"] }
        }))
        .await
        .assert_status(axum::http::StatusCode::UNPROCESSABLE_ENTITY);
}
