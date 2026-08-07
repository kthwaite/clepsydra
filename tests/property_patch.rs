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
