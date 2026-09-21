mod support;

use std::fs;

use serde_json::{Value, json};
use support::ApiFixture;

fn fixture() -> ApiFixture {
    ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::create_dir_all(root.join("bases")).unwrap();
            fs::create_dir_all(root.join(".clepsydra/templates")).unwrap();
            fs::write(
                root.join("bases/notes.base.toml"),
                "name = \"Notes\"\nfilter = { field = \"path\", op = \"eq\", value = \"source.md\" }\n",
            )
            .unwrap();
            fs::write(
                root.join(".clepsydra/templates/notes.md.jinja"),
                "{% for row in rows %}{{ row.body }}{% endfor %}",
            )
            .unwrap();
            fs::write(
                root.join("source.md"),
                "+++\nid = \"0190f8a0-0000-7000-8000-0000000000a1\"\ntitle = \"Source\"\n+++\nReviewed source.\n",
            )
            .unwrap();
            fs::write(
                root.join("destination.md"),
                "+++\nid = \"0190f8a0-0000-7000-8000-0000000000a2\"\ntitle = \"Destination\"\n+++\nHandwritten introduction.\n\n",
            )
            .unwrap();
        })
        .build()
}

async fn page(fixture: &ApiFixture, path: &str) -> Value {
    let response = fixture
        .server
        .get(&format!("/api/vault/pages/{path}"))
        .await;
    response.assert_status_ok();
    response.json()
}

#[tokio::test]
async fn stale_destination_cannot_be_overwritten_by_a_preview_token() {
    let fixture = fixture();
    let destination = page(&fixture, "destination.md").await;
    let preview = fixture
        .server
        .post("/api/vault/base-render/preview")
        .json(&json!({
            "page_path": "destination.md",
            "expected_revision": destination["revision"],
            "selection": { "base": "notes", "template": "notes" },
            "insert_offset": destination["body"].as_str().unwrap().len(),
        }))
        .await;
    preview.assert_status_ok();
    let preview: Value = preview.json();

    let changed = fixture
        .server
        .put("/api/vault/pages/destination.md")
        .json(&json!({
            "expected_revision": destination["revision"],
            "body": "New handwritten content must survive.\n",
        }))
        .await;
    changed.assert_status_ok();
    let changed: Value = changed.json();

    let apply = fixture
        .server
        .post("/api/vault/base-render/apply")
        .json(&json!({ "token": preview["token"], "overwrite_modified": true }))
        .await;
    apply.assert_status_conflict();
    let current = page(&fixture, "destination.md").await;
    assert_eq!(current["body"], "New handwritten content must survive.\n");
    assert_eq!(current["revision"], changed["revision"]);
}

async fn insertion_preview(fixture: &ApiFixture, destination: &Value, offset: usize) -> Value {
    let response = fixture
        .server
        .post("/api/vault/base-render/preview")
        .json(&json!({
            "page_path": "destination.md",
            "expected_revision": destination["revision"],
            "selection": { "base": "notes", "template": "notes" },
            "insert_offset": offset,
        }))
        .await;
    response.assert_status_ok();
    response.json()
}

async fn apply_preview(fixture: &ApiFixture, preview: &Value, overwrite: bool) -> Value {
    let response = fixture
        .server
        .post("/api/vault/base-render/apply")
        .json(&json!({ "token": preview["token"], "overwrite_modified": overwrite }))
        .await;
    response.assert_status_ok();
    response.json()
}

#[tokio::test]
async fn preview_does_not_write_and_apply_keeps_reviewed_output_after_inputs_change() {
    let fixture = fixture();
    let destination = page(&fixture, "destination.md").await;
    let updated = fixture
        .server
        .put("/api/vault/pages/destination.md")
        .json(&json!({
            "expected_revision": destination["revision"],
            "body": "Before.\n\nAfter.\n",
        }))
        .await;
    updated.assert_status_ok();
    let destination: Value = updated.json();
    let original = fs::read_to_string(fixture.state.vault.root().join("destination.md")).unwrap();
    let preview = insertion_preview(&fixture, &destination, "Before.\n\n".len()).await;
    assert_eq!(preview["markdown"], "\n\nReviewed source.\n\n");
    assert_eq!(
        page(&fixture, "destination.md").await["revision"],
        destination["revision"]
    );
    assert_eq!(
        fs::read_to_string(fixture.state.vault.root().join("destination.md")).unwrap(),
        original
    );

    let source = page(&fixture, "source.md").await;
    fixture
        .server
        .put("/api/vault/pages/source.md")
        .json(&json!({
            "expected_revision": source["revision"], "body": "New source, not reviewed.\n",
        }))
        .await
        .assert_status_ok();
    let template: Value = fixture
        .server
        .get("/api/vault/base-templates/notes")
        .await
        .json();
    fixture
        .server
        .put("/api/vault/base-templates/notes")
        .json(&json!({
            "expected_revision": template["revision"], "source": "New template, not reviewed.",
        }))
        .await
        .assert_status_ok();

    let applied = apply_preview(&fixture, &preview, false).await;
    let saved = page(&fixture, "destination.md").await;
    assert_eq!(applied["body"], saved["body"]);
    assert_eq!(applied["revision"], saved["revision"]);
    let body = saved["body"].as_str().unwrap();
    assert!(body.starts_with("Before.\n\n<!-- clep:generated\n"));
    assert!(body.ends_with("<!-- /clep:generated -->\n\nAfter.\n"));
    assert!(body.contains("-->\n\nReviewed source.\n\n<!-- /clep:generated -->"));
    assert!(!body.contains("not reviewed"));
    let saved_raw = fs::read_to_string(fixture.state.vault.root().join("destination.md")).unwrap();
    let prefix = original.strip_suffix("Before.\n\nAfter.\n").unwrap();
    assert!(saved_raw.starts_with(prefix));
}

#[tokio::test]
async fn modified_generated_payload_requires_explicit_acknowledgement() {
    let fixture = fixture();
    let destination = page(&fixture, "destination.md").await;
    let inserted = insertion_preview(
        &fixture,
        &destination,
        destination["body"].as_str().unwrap().len(),
    )
    .await;
    apply_preview(&fixture, &inserted, false).await;
    let destination_path = fixture.state.vault.root().join("destination.md");
    let external = fs::read_to_string(&destination_path)
        .unwrap()
        .replace("Reviewed source.", "Externally edited.");
    fs::write(&destination_path, &external).unwrap();
    let destination = page(&fixture, "destination.md").await;
    let response = fixture
        .server
        .post("/api/vault/base-render/preview")
        .json(&json!({
            "page_path": "destination.md", "expected_revision": destination["revision"],
            "selection": { "base": "notes", "template": "notes" },
            "region_id": inserted["region_id"],
        }))
        .await;
    response.assert_status_ok();
    let preview: Value = response.json();
    assert_eq!(preview["modified"], true);
    assert_eq!(preview["current_markdown"], "\n\nExternally edited.\n\n");
    let refused = fixture
        .server
        .post("/api/vault/base-render/apply")
        .json(&json!({
            "token": preview["token"], "overwrite_modified": false,
        }))
        .await;
    refused.assert_status_conflict();
    assert_eq!(refused.json::<Value>()["detail"]["code"], "modified_output");
    assert_eq!(fs::read_to_string(&destination_path).unwrap(), external);
    let applied = apply_preview(&fixture, &preview, true).await;
    assert!(
        applied["body"]
            .as_str()
            .unwrap()
            .contains("\n\nReviewed source.\n\n")
    );
    assert!(
        !applied["body"]
            .as_str()
            .unwrap()
            .contains("Externally edited.")
    );
}

#[tokio::test]
async fn external_destination_change_is_checked_on_disk_without_index_refresh() {
    let fixture = fixture();
    let destination = page(&fixture, "destination.md").await;
    let preview = insertion_preview(
        &fixture,
        &destination,
        destination["body"].as_str().unwrap().len(),
    )
    .await;
    let path = fixture.state.vault.root().join("destination.md");
    let changed = fs::read_to_string(&path)
        .unwrap()
        .replace("Handwritten introduction.", "Changed externally.");
    fs::write(&path, &changed).unwrap();
    fixture
        .server
        .post("/api/vault/base-render/apply")
        .json(&json!({
            "token": preview["token"], "overwrite_modified": true,
        }))
        .await
        .assert_status_conflict();
    assert_eq!(fs::read_to_string(&path).unwrap(), changed);
}

#[tokio::test]
async fn readonly_destination_cannot_be_previewed_or_changed_by_an_older_token() {
    let fixture = fixture();
    let destination = page(&fixture, "destination.md").await;
    let preview = insertion_preview(
        &fixture,
        &destination,
        destination["body"].as_str().unwrap().len(),
    )
    .await;
    let protected = fixture
        .server
        .put("/api/vault/pages/destination.md")
        .json(&json!({
            "expected_revision": destination["revision"], "readonly": true,
        }))
        .await;
    protected.assert_status_ok();
    let protected: Value = protected.json();
    fixture
        .server
        .post("/api/vault/base-render/preview")
        .json(&json!({
            "page_path": "destination.md", "expected_revision": protected["revision"],
            "selection": { "base": "notes", "template": "notes" }, "insert_offset": 0,
        }))
        .await
        .assert_status_forbidden();
    fixture
        .server
        .post("/api/vault/base-render/apply")
        .json(&json!({
            "token": preview["token"], "overwrite_modified": true,
        }))
        .await
        .assert_status_conflict();
    assert_eq!(
        page(&fixture, "destination.md").await["body"],
        destination["body"]
    );
}

#[tokio::test]
async fn encrypted_source_and_destination_are_not_rendered() {
    let fixture = fixture();
    let source = page(&fixture, "source.md").await;
    let protected = fixture.server.post("/api/vault/pages/by-id/0190f8a0-0000-7000-8000-0000000000a1/protect")
        .json(&json!({
            "expected_revision": source["revision"],
            "encryption": { "format": "age", "version": 1, "key_id": "019fd000-0000-7000-8000-000000000002" },
            "body": clep_test_support::PRIVATE_NOTE_AGE,
        })).await;
    protected.assert_status_ok();
    let response = fixture
        .server
        .post("/api/vault/base-render/render")
        .json(&json!({
            "page_path": "destination.md", "selection": { "base": "notes", "template": "notes" },
        }))
        .await;
    response.assert_status_forbidden();
    assert!(!response.text().contains("BEGIN AGE"));
    fixture
        .server
        .post("/api/vault/base-render/render")
        .json(&json!({
            "page_path": "source.md", "selection": { "base": "notes", "template": "notes" },
            "template_source": "{{ page.title }}",
        }))
        .await
        .assert_status_forbidden();
}

#[tokio::test]
async fn template_writes_preserve_external_edits_and_create_cannot_overwrite() {
    let fixture = fixture();
    let created = fixture
        .server
        .post("/api/vault/base-templates/custom")
        .json(&json!({
            "source": "Authored source.\r\n",
        }))
        .await;
    created.assert_status(axum::http::StatusCode::CREATED);
    let created: Value = created.json();
    let read = fixture.server.get("/api/vault/base-templates/custom").await;
    read.assert_status_ok();
    assert_eq!(read.json::<Value>()["source"], "Authored source.\r\n");
    fixture
        .server
        .post("/api/vault/base-templates/custom")
        .json(&json!({
            "source": "Accidental overwrite.",
        }))
        .await
        .assert_status_conflict();
    fs::write(
        fixture
            .state
            .vault
            .root()
            .join(".clepsydra/templates/custom.md.jinja"),
        "Externally authored.\r\n",
    )
    .unwrap();
    fixture
        .server
        .put("/api/vault/base-templates/custom")
        .json(&json!({
            "expected_revision": created["revision"], "source": "Stale editor.",
        }))
        .await
        .assert_status_conflict();
    assert_eq!(
        fixture
            .server
            .get("/api/vault/base-templates/custom")
            .await
            .json::<Value>()["source"],
        "Externally authored.\r\n"
    );
    let list = fixture.server.get("/api/vault/base-templates").await;
    list.assert_status_ok();
    assert_eq!(
        list.json::<Value>()["templates"],
        json!(["custom", "notes"])
    );
}

#[tokio::test]
async fn missing_inputs_and_template_errors_are_distinct_and_drafts_cannot_be_applied() {
    let fixture = fixture();
    let missing_template = fixture
        .server
        .post("/api/vault/base-render/render")
        .json(&json!({
            "page_path": "destination.md", "selection": { "base": "notes", "template": "missing" },
        }))
        .await;
    missing_template.assert_status_not_found();
    assert_eq!(
        missing_template.json::<Value>()["detail"]["code"],
        "missing_template"
    );
    let missing_base = fixture
        .server
        .post("/api/vault/base-render/render")
        .json(&json!({
            "page_path": "destination.md", "selection": { "base": "missing", "template": "notes" },
        }))
        .await;
    missing_base.assert_status_not_found();
    assert_eq!(
        missing_base.json::<Value>()["detail"]["code"],
        "missing_base"
    );
    let broken = fixture
        .server
        .post("/api/vault/base-render/render")
        .json(&json!({
            "page_path": "destination.md", "selection": { "base": "notes", "template": "notes" },
            "template_source": "{{ missing.field }}",
        }))
        .await;
    broken.assert_status_unprocessable_entity();
    assert_eq!(broken.json::<Value>()["detail"]["code"], "template_error");
    let draft = fixture
        .server
        .post("/api/vault/base-render/render")
        .json(&json!({
            "page_path": "destination.md", "selection": { "base": "notes", "template": "unsaved" },
            "template_source": "Draft preview only.",
        }))
        .await;
    draft.assert_status_ok();
    assert_eq!(draft.json::<Value>()["markdown"], "Draft preview only.");
    let destination = page(&fixture, "destination.md").await;
    fixture
        .server
        .post("/api/vault/base-render/preview")
        .json(&json!({
            "page_path": "destination.md", "expected_revision": destination["revision"],
            "selection": { "base": "notes", "template": "unsaved" }, "insert_offset": 0,
            "template_source": "Must not be applied.",
        }))
        .await
        .assert_status_unprocessable_entity();
    assert_eq!(
        page(&fixture, "destination.md").await["revision"],
        destination["revision"]
    );
}

#[tokio::test]
async fn regenerating_one_region_keeps_the_other_region_byte_exact() {
    let fixture = fixture();
    let destination = page(&fixture, "destination.md").await;
    let first = insertion_preview(
        &fixture,
        &destination,
        destination["body"].as_str().unwrap().len(),
    )
    .await;
    let applied = apply_preview(&fixture, &first, false).await;
    let second =
        insertion_preview(&fixture, &applied, applied["body"].as_str().unwrap().len()).await;
    let applied = apply_preview(&fixture, &second, false).await;
    let before = applied["body"].as_str().unwrap();
    let second_start = before.rfind("<!-- clep:generated").unwrap();
    let second_bytes = before[second_start..].to_owned();
    fixture
        .server
        .post("/api/vault/base-templates/replacement")
        .json(&json!({
            "source": "Only the first region changes.",
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);
    let regenerated = fixture.server.post("/api/vault/base-render/preview").json(&json!({
        "page_path": "destination.md", "expected_revision": applied["revision"],
        "selection": { "base": "notes", "template": "replacement" }, "region_id": first["region_id"],
    })).await;
    regenerated.assert_status_ok();
    let applied = apply_preview(&fixture, &regenerated.json::<Value>(), false).await;
    let after = applied["body"].as_str().unwrap();
    assert!(after.contains("-->\n\nOnly the first region changes.\n\n<!-- /clep:generated -->"));
    assert!(after.ends_with(&second_bytes));
}

#[tokio::test]
async fn oldest_preview_is_evicted_at_the_bound_without_discarding_the_latest_review() {
    let fixture = fixture();
    let destination = page(&fixture, "destination.md").await;
    let first = insertion_preview(&fixture, &destination, 0).await;
    for _ in 0..31 {
        insertion_preview(&fixture, &destination, 0).await;
    }
    let latest = insertion_preview(&fixture, &destination, 0).await;
    let expired = fixture
        .server
        .post("/api/vault/base-render/apply")
        .json(&json!({
            "token": first["token"], "overwrite_modified": true,
        }))
        .await;
    expired.assert_status_conflict();
    assert_eq!(expired.json::<Value>()["detail"]["code"], "preview_expired");
    let applied = apply_preview(&fixture, &latest, false).await;
    assert!(
        applied["body"]
            .as_str()
            .unwrap()
            .contains("\n\nReviewed source.\n\n")
    );
    assert_eq!(
        page(&fixture, "destination.md").await["revision"],
        applied["revision"]
    );
}
