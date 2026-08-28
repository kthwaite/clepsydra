mod support;

use axum::http::StatusCode;
use support::ApiFixture;

async fn create_page(
    server: &axum_test::TestServer,
    path: &str,
    tags: &[&str],
    project: Option<&str>,
) {
    server
        .post(&format!("/api/vault/pages/{path}"))
        .json(&serde_json::json!({
            "title": path.trim_end_matches(".md"),
            "tags": tags,
            "project": project,
        }))
        .await
        .assert_status(StatusCode::CREATED);
}

fn item_paths(body: &serde_json::Value) -> Vec<&str> {
    body["items"]
        .as_array()
        .expect("items should be an array")
        .iter()
        .map(|item| item["path"].as_str().expect("page path should be a string"))
        .collect()
}

#[tokio::test]
async fn page_query_stops_at_the_sql_page_boundary_but_keeps_the_full_total() {
    let fixture = ApiFixture::builder().build();
    for path in [
        "alpha.md",
        "bravo.md",
        "charlie.md",
        "delta.md",
        "zz-corrupt.md",
    ] {
        create_page(&fixture.server, path, &[], None).await;
    }

    fixture
        .state
        .index
        .with_index(|index, _vault| {
            index.connection().execute(
                "UPDATE pages SET kind_inferred = 'not-an-integer' WHERE path = 'zz-corrupt.md'",
                [],
            )
        })
        .await
        .expect("index thread should remain available")
        .expect("fixture corruption should succeed");

    let first_response = fixture
        .server
        .get("/api/vault/pages?limit=2&offset=0")
        .await;
    first_response.assert_status_ok();
    let first: serde_json::Value = first_response.json();
    assert_eq!(first["total"], 5);
    assert_eq!(item_paths(&first), ["alpha.md", "bravo.md"]);

    let second_response = fixture
        .server
        .get("/api/vault/pages?limit=2&offset=2")
        .await;
    second_response.assert_status_ok();
    let second: serde_json::Value = second_response.json();
    assert_eq!(second["total"], 5);
    assert_eq!(item_paths(&second), ["charlie.md", "delta.md"]);
}

#[tokio::test]
async fn filtered_page_total_is_stable_across_ordered_page_boundaries() {
    let fixture = ApiFixture::builder().build();
    support::seed_project(&fixture.server, "atlas").await;
    support::seed_project(&fixture.server, "other").await;
    for (path, tags, project) in [
        ("alpha.md", &["focus"][..], Some("atlas")),
        ("bravo.md", &["other"][..], Some("atlas")),
        ("charlie.md", &["focus"][..], Some("atlas")),
        ("delta.md", &["focus"][..], Some("other")),
        ("echo.md", &["focus"][..], Some("atlas")),
    ] {
        create_page(&fixture.server, path, tags, project).await;
    }

    let mut seen = Vec::new();
    for offset in 0..3 {
        let body: serde_json::Value = fixture
            .server
            .get(&format!(
                "/api/vault/pages?tag=focus&project=atlas&limit=1&offset={offset}"
            ))
            .await
            .json();
        assert_eq!(body["total"], 3);
        assert_eq!(body["limit"], 1);
        assert_eq!(body["offset"], offset);
        seen.extend(item_paths(&body).into_iter().map(str::to_owned));
    }

    assert_eq!(seen, ["alpha.md", "charlie.md", "echo.md"]);

    let beyond: serde_json::Value = fixture
        .server
        .get("/api/vault/pages?tag=focus&project=atlas&limit=1&offset=3")
        .await
        .json();
    assert_eq!(beyond["total"], 3);
    assert!(item_paths(&beyond).is_empty());
}

#[tokio::test]
async fn computed_tag_cutover_create_omits_redundant_stored_tag() {
    let fixture = ApiFixture::builder().build();

    let response = fixture
        .server
        .post("/api/vault/pages/journals/created.md")
        .json(&serde_json::json!({
            "title": "Created journal",
            "kind": "JOURNAL",
            "tags": ["journal", "research"],
            "body": "created body"
        }))
        .await;
    response.assert_status(StatusCode::CREATED);
    let created: serde_json::Value = response.json();

    let stored =
        std::fs::read_to_string(fixture.state.vault.root().join("journals/created.md")).unwrap();
    let (stored_meta, _) = clepsydra::vault::page::parse_frontmatter(&stored).unwrap();
    assert_eq!(stored_meta.tags, ["research"]);
    assert_eq!(created["meta"]["tags"], serde_json::json!(["research"]));
    assert_eq!(
        created["computed_tags"],
        serde_json::json!(["journal"]),
        "the mutation response must retain the computed journal classification"
    );
}

#[tokio::test]
async fn computed_tag_cutover_update_strips_legacy_tag_without_rewriting_unrelated_pages() {
    const LEGACY: &str = "---\n\
id: 01951234-0000-7000-8000-000000000401\n\
title: Legacy journal\n\
type: JOURNAL\n\
tags:\n\
  - journal\n\
  - research\n\
---\n\
legacy body\n";
    const UNTOUCHED: &str = "---\n\
id: 01951234-0000-7000-8000-000000000402\n\
title: Untouched journal\n\
type: JOURNAL\n\
tags:\n\
  - journal\n\
---\n\
untouched body\n";
    let fixture = ApiFixture::builder()
        .pre_index_seed(|root| {
            std::fs::create_dir_all(root.join("journals")).unwrap();
            std::fs::write(root.join("journals/legacy.md"), LEGACY).unwrap();
            std::fs::write(root.join("journals/untouched.md"), UNTOUCHED).unwrap();
        })
        .build();
    let untouched_path = fixture.state.vault.root().join("journals/untouched.md");
    let untouched_before = std::fs::read(&untouched_path).unwrap();

    let legacy_response = fixture
        .server
        .get("/api/vault/pages/journals/legacy.md")
        .await;
    legacy_response.assert_status_ok();
    let legacy_before: serde_json::Value = legacy_response.json();
    let revision = legacy_before["revision"].as_str().unwrap();
    let updated_response = fixture
        .server
        .put("/api/vault/pages/journals/legacy.md")
        .json(&serde_json::json!({
            "expected_revision": revision,
            "body": "rewritten body"
        }))
        .await;
    updated_response.assert_status_ok();
    let updated: serde_json::Value = updated_response.json();

    assert_eq!(
        std::fs::read(&untouched_path).unwrap(),
        untouched_before,
        "rewriting one legacy page must not mass-rewrite another page"
    );
    let rewritten =
        std::fs::read_to_string(fixture.state.vault.root().join("journals/legacy.md")).unwrap();
    let (rewritten_meta, rewritten_body) =
        clepsydra::vault::page::parse_frontmatter(&rewritten).unwrap();
    assert_eq!(rewritten_meta.tags, ["research"]);
    assert_eq!(rewritten_body, "rewritten body");
    assert_eq!(
        legacy_before["meta"]["tags"],
        serde_json::json!(["research"]),
        "legacy computed metadata must not be exposed as editable"
    );
    assert_eq!(
        legacy_before["computed_tags"],
        serde_json::json!(["journal"]),
        "legacy stored metadata must remain readable through the computed projection"
    );
    assert_eq!(updated["meta"]["tags"], serde_json::json!(["research"]));
    assert_eq!(
        updated["computed_tags"],
        serde_json::json!(["journal"]),
        "the rewritten page must still expose its computed journal tag"
    );
}

#[tokio::test]
async fn computed_tags_are_effective_in_detail_summary_content_and_tag_queries() {
    const JOURNAL: &str = "---\n\
id: 01951234-0000-7000-8000-000000000301\n\
title: Legacy journal\n\
type: JOURNAL\n\
tags:\n\
  - journal\n\
  - research\n\
---\n\
legacy body\n";
    const NOTE: &str = "---\n\
id: 01951234-0000-7000-8000-000000000302\n\
title: Ordinary note\n\
type: NOTE\n\
tags:\n\
  - journal\n\
---\n\
note body\n";
    let fixture = ApiFixture::builder()
        .pre_index_seed(|root| {
            std::fs::create_dir_all(root.join("journals")).unwrap();
            std::fs::create_dir_all(root.join("notes")).unwrap();
            std::fs::write(root.join("journals/legacy.md"), JOURNAL).unwrap();
            std::fs::write(root.join("notes/ordinary.md"), NOTE).unwrap();
        })
        .build();
    let journal_path = fixture.state.vault.root().join("journals/legacy.md");
    let before = std::fs::read(&journal_path).unwrap();

    let detail: serde_json::Value = fixture
        .server
        .get("/api/vault/pages/journals/legacy.md")
        .await
        .json();
    assert_eq!(detail["meta"]["tags"], serde_json::json!(["research"]));
    assert_eq!(detail["computed_tags"], serde_json::json!(["journal"]));
    assert_eq!(std::fs::read(journal_path).unwrap(), before);

    let listed: serde_json::Value = fixture
        .server
        .get("/api/vault/pages?tag=journal")
        .await
        .json();
    let items = listed["items"].as_array().unwrap();
    let journal = items
        .iter()
        .find(|item| item["path"] == "journals/legacy.md")
        .unwrap();
    assert_eq!(journal["tags"], serde_json::json!(["research", "journal"]));
    assert_eq!(journal["computed_tags"], serde_json::json!(["journal"]));
    assert_eq!(
        journal["tags"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|tag| tag.as_str() == Some("journal"))
            .count(),
        1
    );
    let note = items
        .iter()
        .find(|item| item["path"] == "notes/ordinary.md")
        .unwrap();
    assert!(
        note["tags"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("journal"))
    );
    assert!(
        !note["computed_tags"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("journal"))
    );

    let content: serde_json::Value = fixture
        .server
        .get("/api/vault/index/content-index")
        .await
        .json();
    let journal = content["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["path"] == "journals/legacy.md")
        .unwrap();
    assert_eq!(journal["tags"], serde_json::json!(["research", "journal"]));
    assert_eq!(journal["computed_tags"], serde_json::json!(["journal"]));

    let counts: serde_json::Value = fixture.server.get("/api/vault/index/tags").await.json();
    let journal = counts
        .as_array()
        .unwrap()
        .iter()
        .find(|tag| tag["tag"] == "journal")
        .unwrap();
    assert_eq!(journal["count"], 2);
    assert_eq!(journal["computed_count"], 1);
}

#[tokio::test]
async fn computed_tags_cannot_be_removed_by_replacing_editable_tags() {
    let fixture = ApiFixture::builder().build();
    let created: serde_json::Value = fixture
        .server
        .post("/api/vault/pages/journals/removal.md")
        .json(&serde_json::json!({
            "title": "Removal",
            "kind": "JOURNAL",
            "tags": ["research"]
        }))
        .await
        .json();
    assert_eq!(created["meta"]["tags"], serde_json::json!(["research"]));
    assert_eq!(created["computed_tags"], serde_json::json!(["journal"]));

    let updated: serde_json::Value = fixture
        .server
        .put("/api/vault/pages/journals/removal.md")
        .json(&serde_json::json!({
            "expected_revision": created["revision"],
            "tags": []
        }))
        .await
        .json();
    assert!(
        updated["meta"]
            .get("tags")
            .is_none_or(|tags| tags == &serde_json::json!([])),
        "empty editable tags may be omitted by PageMeta serialization"
    );
    assert_eq!(updated["computed_tags"], serde_json::json!(["journal"]));

    let stored =
        std::fs::read_to_string(fixture.state.vault.root().join("journals/removal.md")).unwrap();
    let (meta, _) = clepsydra::vault::page::parse_frontmatter(&stored).unwrap();
    assert!(meta.tags.is_empty(), "only editable tags may be persisted");
}

#[tokio::test]
async fn ai_journal_kind_cannot_be_changed() {
    let fixture = ApiFixture::builder().build();
    create_page(&fixture.server, "ai-journals/2026-08-27.md", &[], None).await;

    let response = fixture
        .server
        .post("/api/vault/pages-assign/ai-journals/2026-08-27.md")
        .json(&serde_json::json!({ "kind": "NOTE" }))
        .await;

    response.assert_status_bad_request();
    let error: serde_json::Value = response.json();
    assert!(
        error["error"]
            .as_str()
            .is_some_and(|message| message.contains("AI journal kind cannot be changed")),
        "unexpected error payload: {error}"
    );
    assert!(
        fixture
            .state
            .vault
            .root()
            .join("ai-journals/2026-08-27.md")
            .exists(),
        "a rejected assignment must not relocate the AI journal"
    );
}

#[tokio::test]
async fn journal_pages_reject_project_assignment() {
    let fixture = ApiFixture::builder().build();
    create_page(&fixture.server, "journals/2026-08-27.md", &[], None).await;
    create_page(&fixture.server, "ai-journals/2026-08-27.md", &[], None).await;

    for path in ["journals/2026-08-27.md", "ai-journals/2026-08-27.md"] {
        let response = fixture
            .server
            .post(&format!("/api/vault/pages-assign/{path}"))
            .json(&serde_json::json!({ "project": "clepsydra" }))
            .await;

        response.assert_status_bad_request();
        let error: serde_json::Value = response.json();
        assert!(
            error["error"]
                .as_str()
                .is_some_and(|message| message.contains("journal pages cannot join a project")),
            "unexpected error payload for {path}: {error}"
        );
        assert!(
            fixture.state.vault.root().join(path).exists(),
            "a rejected project assignment must not relocate {path}"
        );
    }
}

#[tokio::test]
async fn journal_pages_accept_clear_project() {
    let fixture = ApiFixture::builder().build();
    create_page(&fixture.server, "journals/2026-08-27.md", &[], None).await;
    create_page(&fixture.server, "ai-journals/2026-08-27.md", &[], None).await;

    for path in ["journals/2026-08-27.md", "ai-journals/2026-08-27.md"] {
        let response = fixture
            .server
            .post(&format!("/api/vault/pages-assign/{path}"))
            .json(&serde_json::json!({ "clear_project": true }))
            .await;

        response.assert_status_ok();
    }
}

#[tokio::test]
async fn bulk_assign_rejects_project_on_journal_pages() {
    let fixture = ApiFixture::builder().build();
    support::seed_project(&fixture.server, "clepsydra").await;
    create_page(&fixture.server, "notes/note.md", &[], None).await;
    create_page(&fixture.server, "journals/2026-08-27.md", &[], None).await;

    let note_before = std::fs::read(fixture.state.vault.root().join("notes/note.md")).unwrap();
    let journal_before =
        std::fs::read(fixture.state.vault.root().join("journals/2026-08-27.md")).unwrap();

    let response = fixture
        .server
        .post("/api/vault/pages-assign-bulk")
        .json(&serde_json::json!({
            "paths": ["notes/note.md", "journals/2026-08-27.md"],
            "project": "clepsydra"
        }))
        .await;

    response.assert_status_bad_request();
    let error: serde_json::Value = response.json();
    assert!(
        error["error"]
            .as_str()
            .is_some_and(|message| message.contains("journal pages cannot join a project")),
        "unexpected error payload: {error}"
    );
    assert_eq!(
        std::fs::read(fixture.state.vault.root().join("notes/note.md")).unwrap(),
        note_before,
        "a rejected bulk assignment must not modify the note"
    );
    assert_eq!(
        std::fs::read(fixture.state.vault.root().join("journals/2026-08-27.md")).unwrap(),
        journal_before,
        "a rejected bulk assignment must not modify the journal"
    );
    assert!(
        !fixture
            .state
            .vault
            .root()
            .join("notes/clepsydra/note.md")
            .exists(),
        "a rejected bulk assignment must not publish the note's project destination"
    );
}
