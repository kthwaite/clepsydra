mod support;

use std::fs;
use std::path::Path;

use serde_json::{Value, json};
use support::ApiFixture;

const ROOT: &str = "/api/vault/index/tags/rename";
const SOURCE: &str = "+++\nid = \"0190f8a0-0000-7000-8000-0000000000f1\"\ntitle = \"Tagged page\"\ncreated_at = 2026-01-01T00:00:00Z\nupdated_at = 2026-01-01T00:00:00Z # timestamp comment\ntags = [\"old\", \"old/child\", \"existing\"] # keep tag comment\n# hand-tended metadata\ncustom = \"untouched\"\n+++\nBody mentioning #old and [[old]].\n";

fn seed(root: &Path) {
    fs::write(root.join("tagged.md"), SOURCE).unwrap();
    fs::write(root.join("descendant.md"), "+++\nid = \"0190f8a0-0000-7000-8000-0000000000f2\"\ntags = [\"old/child\"]\n+++\nDescendant only.\n").unwrap();
}

async fn preview(server: &axum_test::TestServer, source: &str, target: &str) -> Value {
    let response = server
        .post(&format!("{ROOT}/preview"))
        .json(&json!({"source": source, "target": target}))
        .await;
    response.assert_status_ok();
    response.json()
}

fn apply_request(preview: &Value, acknowledge_merge: bool) -> Value {
    json!({
        "source": preview["source"], "target": preview["target"],
        "expected_fingerprint": preview["fingerprint"], "acknowledge_merge": acknowledge_merge,
    })
}

#[tokio::test]
async fn preview_is_read_only_and_exact_merge_is_lossless_and_acknowledged() {
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    let root = tmp.path().join("vault");
    let child = fs::read(root.join("descendant.md")).unwrap();
    let plan = preview(&server, "old", "existing").await;
    assert_eq!(plan["affected_count"], 1);
    assert_eq!(plan["target_exists"], true);
    assert_eq!(plan["conflicts"], json!([]));
    assert_eq!(plan["pages"][0]["path"], "tagged.md");
    assert_eq!(fs::read_to_string(root.join("tagged.md")).unwrap(), SOURCE);
    server
        .post(&format!("{ROOT}/apply"))
        .json(&apply_request(&plan, false))
        .await
        .assert_status(axum::http::StatusCode::CONFLICT);
    let response = server
        .post(&format!("{ROOT}/apply"))
        .json(&apply_request(&plan, true))
        .await;
    response.assert_status_ok();
    assert_eq!(response.json::<Value>()["updated_count"], 1);
    let detail = server
        .get("/api/vault/pages/tagged.md")
        .await
        .json::<Value>();
    assert_eq!(detail["meta"]["tags"], json!(["existing", "old/child"]));
    let after = fs::read_to_string(root.join("tagged.md")).unwrap();
    assert!(after.contains("# keep tag comment"));
    assert!(after.contains("# timestamp comment"));
    assert!(after.contains("# hand-tended metadata\ncustom = \"untouched\""));
    assert!(after.ends_with("+++\nBody mentioning #old and [[old]].\n"));
    assert_eq!(fs::read(root.join("descendant.md")).unwrap(), child);
    let tags = server.get("/api/vault/index/tags").await.json::<Value>();
    assert!(
        !tags
            .as_array()
            .unwrap()
            .iter()
            .any(|tag| tag["tag"] == "old")
    );
}

#[tokio::test]
async fn stale_revision_deleted_page_and_changed_source_set_never_partially_apply() {
    for change in ["edit", "delete", "add", "protection"] {
        let (server, tmp) = ApiFixture::builder()
            .pre_index_seed(seed)
            .build()
            .into_server_and_temp();
        let root = tmp.path().join("vault");
        let plan = preview(&server, "old", "renamed").await;
        match change {
            "edit" => fs::write(
                root.join("tagged.md"),
                SOURCE.replace("Body mentioning", "New body mentioning"),
            )
            .unwrap(),
            "delete" => fs::remove_file(root.join("tagged.md")).unwrap(),
            "add" => fs::write(
                root.join("new.md"),
                SOURCE.replace("0000000000f1", "0000000000f3"),
            )
            .unwrap(),
            "protection" => fs::write(
                root.join("tagged.md"),
                SOURCE.replace("custom =", "readonly = true\ncustom ="),
            )
            .unwrap(),
            _ => unreachable!(),
        }
        let before = fs::read(root.join("tagged.md")).ok();
        let response = server
            .post(&format!("{ROOT}/apply"))
            .json(&apply_request(&plan, false))
            .await;
        response.assert_status(axum::http::StatusCode::CONFLICT);
        assert_eq!(fs::read(root.join("tagged.md")).ok(), before);
        assert!(
            response.json::<Value>()["error"]
                .as_str()
                .unwrap()
                .contains("stale")
        );
        if change == "add" {
            assert!(
                fs::read_to_string(root.join("new.md"))
                    .unwrap()
                    .contains("\"old\"")
            );
        }
    }
}

#[tokio::test]
async fn readonly_body_does_not_prevent_lossless_tag_metadata_edits() {
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::write(
                root.join("tagged.md"),
                SOURCE.replace("custom =", "readonly = true\ntype = \"ARCHIVE\"\ncustom ="),
            )
            .unwrap();
        })
        .build()
        .into_server_and_temp();
    let plan = preview(&server, "old", "renamed").await;
    assert_eq!(plan["conflicts"], json!([]));
    server
        .post(&format!("{ROOT}/apply"))
        .json(&apply_request(&plan, false))
        .await
        .assert_status_ok();
    let after = fs::read_to_string(tmp.path().join("vault/tagged.md")).unwrap();
    assert!(after.contains("readonly = true\ntype = \"ARCHIVE\""));
    assert!(after.ends_with("+++\nBody mentioning #old and [[old]].\n"));
}

#[tokio::test]
async fn computed_kind_tags_and_target_collisions_are_not_renamed() {
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    let plan = preview(&server, "old", "note").await;
    assert_eq!(plan["affected_count"], 1);
    assert!(!plan["conflicts"].as_array().unwrap().is_empty());
    server
        .post(&format!("{ROOT}/apply"))
        .json(&apply_request(&plan, true))
        .await
        .assert_status(axum::http::StatusCode::CONFLICT);
    assert_eq!(
        fs::read_to_string(tmp.path().join("vault/tagged.md")).unwrap(),
        SOURCE
    );
    let computed = preview(&server, "note", "renamed").await;
    assert_eq!(computed["affected_count"], 0);
    assert_eq!(computed["computed_count"], 2);
    server
        .post(&format!("{ROOT}/apply"))
        .json(&apply_request(&computed, false))
        .await
        .assert_status(axum::http::StatusCode::CONFLICT);
}

#[tokio::test]
async fn invalid_tag_names_are_rejected_without_writes() {
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    for target in [
        "",
        "old",
        "OLD",
        "#new",
        " new",
        "new/",
        "new//child",
        "new\nline",
    ] {
        server
            .post(&format!("{ROOT}/preview"))
            .json(&json!({"source": "old", "target": target}))
            .await
            .assert_status_bad_request();
    }
    assert_eq!(
        fs::read_to_string(tmp.path().join("vault/tagged.md")).unwrap(),
        SOURCE
    );
}

#[tokio::test]
async fn legacy_frontmatter_is_an_actionable_conflict_not_a_lossy_rewrite() {
    let legacy = "---\nid: 0190f8a0-0000-7000-8000-0000000000f4\n# preserve my comment\ntags: [old]\n---\nLegacy body.\n";
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .post_index_mutation(move |state| {
            fs::write(state.vault.root().join("legacy.md"), legacy).unwrap();
        })
        .build()
        .into_server_and_temp();
    let plan = preview(&server, "old", "renamed").await;
    assert_eq!(plan["affected_count"], 2);
    assert_eq!(plan["conflicts"][0]["path"], "legacy.md");
    server
        .post(&format!("{ROOT}/apply"))
        .json(&apply_request(&plan, false))
        .await
        .assert_status(axum::http::StatusCode::CONFLICT);
    assert_eq!(
        fs::read_to_string(tmp.path().join("vault/tagged.md")).unwrap(),
        SOURCE
    );
    assert_eq!(
        fs::read_to_string(tmp.path().join("vault/legacy.md")).unwrap(),
        legacy
    );
}

#[tokio::test]
async fn encrypted_tag_metadata_edits_preserve_ciphertext_and_encryption_metadata() {
    let (server, tmp) = ApiFixture::builder().pre_index_seed(|root| {
        fs::write(root.join("protected.md"), format!(
            "+++\nid = \"0190f8a0-0000-7000-8000-0000000000f5\"\ncreated_at = 2026-01-01T00:00:00Z\nupdated_at = 2026-01-01T00:00:00Z\ntags = [\"old\"]\nencryption = {{ format = \"age\", version = 1, key_id = \"019fd000-0000-7000-8000-000000000002\" }}\n+++\n{}",
            clep_test_support::PRIVATE_NOTE_AGE
        )).unwrap();
    }).build().into_server_and_temp();
    let before = fs::read_to_string(tmp.path().join("vault/protected.md")).unwrap();
    let plan = preview(&server, "old", "renamed").await;
    assert_eq!(plan["conflicts"], json!([]));
    server
        .post(&format!("{ROOT}/apply"))
        .json(&apply_request(&plan, false))
        .await
        .assert_status_ok();
    let after = fs::read_to_string(tmp.path().join("vault/protected.md")).unwrap();
    assert_eq!(
        clep_api::vault::page::body_of(&after),
        clep_api::vault::page::body_of(&before)
    );
    assert!(after.contains("encryption = { format = \"age\", version = 1, key_id = \"019fd000-0000-7000-8000-000000000002\" }"));
    let detail = server
        .get("/api/vault/pages/protected.md")
        .await
        .json::<Value>();
    assert_eq!(detail["meta"]["tags"], json!(["renamed"]));
}

#[tokio::test]
async fn same_spelling_can_be_computed_on_one_page_and_editable_on_another() {
    let (server, tmp) = ApiFixture::builder().pre_index_seed(|root| {
        seed(root);
        fs::write(root.join("task.md"), "+++\nid = \"0190f8a0-0000-7000-8000-0000000000f6\"\ntype = \"TASK\"\ntags = [\"note\", \"Note/child\", \"other\"]\n+++\nTask body.\n").unwrap();
    }).build().into_server_and_temp();
    let plan = preview(&server, "note", "renamed").await;
    assert_eq!(plan["affected_count"], 1);
    assert_eq!(plan["computed_count"], 2);
    assert_eq!(plan["conflicts"], json!([]));
    server
        .post(&format!("{ROOT}/apply"))
        .json(&apply_request(&plan, false))
        .await
        .assert_status_ok();
    assert_eq!(
        fs::read_to_string(tmp.path().join("vault/tagged.md")).unwrap(),
        SOURCE
    );
    let detail = server.get("/api/vault/pages/task.md").await.json::<Value>();
    assert_eq!(
        detail["meta"]["tags"],
        json!(["renamed", "Note/child", "other"])
    );
    let tags = server.get("/api/vault/index/tags").await.json::<Value>();
    let note = tags
        .as_array()
        .unwrap()
        .iter()
        .find(|tag| tag["tag"] == "note")
        .unwrap();
    assert_eq!(note["count"], 2);
    assert_eq!(note["computed_count"], 2);
}

#[tokio::test]
async fn new_target_after_preview_requires_a_new_acknowledged_preview() {
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    let plan = preview(&server, "old", "new-target").await;
    assert_eq!(plan["target_exists"], false);
    fs::write(
        tmp.path().join("vault/new.md"),
        SOURCE
            .replace("0000000000f1", "0000000000f7")
            .replace("\"old\"", "\"new-target\""),
    )
    .unwrap();
    server
        .post(&format!("{ROOT}/apply"))
        .json(&apply_request(&plan, false))
        .await
        .assert_status(axum::http::StatusCode::CONFLICT);
    assert_eq!(
        fs::read_to_string(tmp.path().join("vault/tagged.md")).unwrap(),
        SOURCE
    );
    let next = preview(&server, "old", "new-target").await;
    assert_eq!(next["target_exists"], true);
    server
        .post(&format!("{ROOT}/apply"))
        .json(&apply_request(&next, false))
        .await
        .assert_status(axum::http::StatusCode::CONFLICT);
    server
        .post(&format!("{ROOT}/apply"))
        .json(&apply_request(&next, true))
        .await
        .assert_status_ok();
}

#[tokio::test]
async fn commented_tag_array_is_refused_rather_than_losing_comments() {
    let page = "+++\nid = \"0190f8a0-0000-7000-8000-0000000000f8\"\ncreated_at = 2026-01-01T00:00:00Z\nupdated_at = 2026-01-01T00:00:00Z\ntags = [\n  \"old\", # why this tag matters\n  \"other\", # unrelated tag note\n]\n+++\nBody.\n";
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(move |root| {
            fs::write(root.join("commented.md"), page).unwrap();
        })
        .build()
        .into_server_and_temp();
    let plan = preview(&server, "old", "renamed").await;
    assert_eq!(plan["affected_count"], 1);
    assert_eq!(plan["conflicts"][0]["path"], "commented.md");
    assert!(
        plan["conflicts"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("comment")
    );
    server
        .post(&format!("{ROOT}/apply"))
        .json(&apply_request(&plan, false))
        .await
        .assert_status(axum::http::StatusCode::CONFLICT);
    assert_eq!(
        fs::read_to_string(tmp.path().join("vault/commented.md")).unwrap(),
        page
    );
}

#[tokio::test]
async fn incomplete_frontmatter_is_not_healed_as_a_rename_side_effect() {
    let page = "+++\nid = \"0190f8a0-0000-7000-8000-0000000000f9\"\n# hand-tended, not yet indexed\ntags = [\"old\"]\n+++\nBody.\n";
    let (server, tmp) = ApiFixture::builder()
        .post_index_mutation(move |state| {
            fs::write(state.vault.root().join("unindexed.md"), page).unwrap();
        })
        .build()
        .into_server_and_temp();
    let plan = preview(&server, "old", "renamed").await;
    assert_eq!(plan["affected_count"], 1);
    assert_eq!(plan["conflicts"][0]["path"], "unindexed.md");
    server
        .post(&format!("{ROOT}/apply"))
        .json(&apply_request(&plan, false))
        .await
        .assert_status(axum::http::StatusCode::CONFLICT);
    assert_eq!(
        fs::read_to_string(tmp.path().join("vault/unindexed.md")).unwrap(),
        page
    );
}

#[tokio::test]
async fn invalid_protected_page_is_counted_and_blocks_the_whole_rename() {
    let protected = "+++\nid = \"0190f8a0-0000-7000-8000-0000000000fa\"\ncreated_at = 2026-01-01T00:00:00Z\nupdated_at = 2026-01-01T00:00:00Z\ntags = [\"old\"]\nencryption = { format = \"age\", version = 1, key_id = \"019fd000-0000-7000-8000-000000000002\" }\n+++\nInvalid ciphertext.\n";
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(move |root| {
            seed(root);
            fs::write(root.join("protected.md"), protected).unwrap();
        })
        .build()
        .into_server_and_temp();
    let plan = preview(&server, "old", "renamed").await;
    assert_eq!(plan["affected_count"], 2);
    assert_eq!(plan["conflicts"][0]["path"], "protected.md");
    server
        .post(&format!("{ROOT}/apply"))
        .json(&apply_request(&plan, false))
        .await
        .assert_status(axum::http::StatusCode::CONFLICT);
    assert_eq!(
        fs::read_to_string(tmp.path().join("vault/protected.md")).unwrap(),
        protected
    );
    assert_eq!(
        fs::read_to_string(tmp.path().join("vault/tagged.md")).unwrap(),
        SOURCE
    );
}
