mod support;

use std::collections::BTreeSet;
use std::fs;

use axum::http::StatusCode;
use axum_test::TestServer;
use serde_json::{Value, json};
use support::ApiFixture;

const SOURCE_ID: &str = "019fd000-0000-7000-8000-000000000701";
const TWIN_A_ID: &str = "019fd000-0000-7000-8000-000000000702";
const TWIN_B_ID: &str = "019fd000-0000-7000-8000-000000000703";
const DELIMITER_CANDIDATE_PATH: &str = "notes/twin|selected].md";

fn repair_fixture() -> ApiFixture {
    ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::create_dir_all(root.join("notes")).unwrap();
            for (path, content) in [
                (
                    "source.md",
                    format!(
                        "---\nid: {SOURCE_ID}\ntitle: Repair Workflow Source\n---\nSee [[Twin|the selected twin]] and [[Missing Page]].\n"
                    ),
                ),
                (
                    "twin-a.md",
                    format!("---\nid: {TWIN_A_ID}\ntitle: Twin\n---\nFirst twin.\n"),
                ),
                (
                    "twin|selected].md",
                    format!("---\nid: {TWIN_B_ID}\ntitle: Twin\n---\nSelected twin.\n"),
                ),
                (
                    "alias-decoy.md",
                    format!(
                        "---\nid: 019fd000-0000-7000-8000-000000000704\ntitle: Alias Decoy\naliases:\n  - {DELIMITER_CANDIDATE_PATH}\n---\nMust never win explicit selection.\n"
                    ),
                ),
            ] {
                fs::write(root.join("notes").join(path), content).unwrap();
            }
        })
        .build()
}

async fn issue(server: &TestServer, kind: &str, target: &str) -> Value {
    let response = server
        .get(&format!("/api/vault/index/issues?kind={kind}&limit=200"))
        .await;
    response.assert_status_ok();
    response.json::<Value>()["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["target_raw"] == target)
        .unwrap_or_else(|| panic!("missing {kind} issue for {target}"))
        .clone()
}

#[tokio::test]
async fn repairs_unresolved_and_ambiguous_links_through_the_public_workflow() {
    let fixture = repair_fixture();
    let unresolved = issue(&fixture.server, "unresolved_page_link", "Missing Page").await;
    let ambiguous = issue(&fixture.server, "ambiguous_page_link", "Twin").await;
    let unresolved_fingerprint = unresolved["fingerprint"].as_str().unwrap().to_owned();
    let ambiguous_fingerprint = ambiguous["fingerprint"].as_str().unwrap().to_owned();

    assert_eq!(unresolved["actions"], json!(["create", "open_source"]));
    assert_eq!(ambiguous["actions"], json!(["replace", "open_source"]));
    assert_eq!(ambiguous["candidates"].as_array().unwrap().len(), 2);

    let create_request = json!({
        "fingerprint": unresolved["fingerprint"],
        "source_revision": unresolved["source_revision"],
        "action": {
            "type": "create",
            "folder": "notes",
            "body": "Created through the reference repair workflow.\n",
        },
    });
    let create_preview = fixture
        .server
        .post("/api/vault/index/issues/preview")
        .json(&create_request)
        .await;
    create_preview.assert_status_ok();
    let create_preview = create_preview.json::<Value>();
    let content_hash = create_preview["plan"]["file_ops"][0]["content_hash"]
        .as_str()
        .unwrap();
    assert_eq!(create_preview["before"], "[[Missing Page]]");
    assert_eq!(create_preview["after"], "[[Missing Page]]");
    assert_eq!(
        create_preview["plan"],
        json!({
            "file_ops": [{
                "kind": "create_file",
                "path": "notes/Missing Page.md",
                "destination": null,
                "content_hash": content_hash,
            }],
            "text_edits": [],
        })
    );
    let create_apply = fixture
        .server
        .post("/api/vault/index/issues/apply")
        .json(&create_request)
        .await;
    create_apply.assert_status_ok();
    let create_apply = create_apply.json::<Value>();
    assert_eq!(
        create_apply["notification"]["upserted"],
        json!(["notes/Missing Page.md", "notes/source.md"])
    );
    let created = fs::read(fixture.temp_dir.path().join("vault/notes/Missing Page.md")).unwrap();
    assert_eq!(blake3::hash(&created).to_hex().as_str(), content_hash);

    let chosen = ambiguous["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|candidate| candidate["page_id"] == TWIN_B_ID)
        .unwrap();
    assert_eq!(chosen["path"], DELIMITER_CANDIDATE_PATH);
    let replace_request = json!({
        "fingerprint": ambiguous["fingerprint"],
        "source_revision": ambiguous["source_revision"],
        "action": {
            "type": "replace",
            "candidate_page_id": chosen["page_id"],
        },
    });
    let replace_preview = fixture
        .server
        .post("/api/vault/index/issues/preview")
        .json(&replace_request)
        .await;
    replace_preview.assert_status_ok();
    let replace_preview = replace_preview.json::<Value>();
    let expected_after = format!("[[{TWIN_B_ID}|the selected twin]]");
    assert_eq!(replace_preview["before"], "[[Twin|the selected twin]]");
    assert_eq!(replace_preview["after"], expected_after);
    assert_eq!(
        replace_preview["plan"],
        json!({
            "file_ops": [],
            "text_edits": [{
                "path": "notes/source.md",
                "old_text": "[[Twin|the selected twin]]",
                "new_text": expected_after,
            }],
        })
    );
    let replace_apply = fixture
        .server
        .post("/api/vault/index/issues/apply")
        .json(&replace_request)
        .await;
    replace_apply.assert_status_ok();
    let replace_apply = replace_apply.json::<Value>();
    assert_eq!(
        replace_apply["notification"]["upserted"],
        json!(["notes/source.md"])
    );
    let source_bytes = fs::read(fixture.temp_dir.path().join("vault/notes/source.md")).unwrap();
    assert!(
        source_bytes
            .windows(expected_after.len())
            .any(|bytes| bytes == expected_after.as_bytes())
    );

    let issues = fixture
        .server
        .get("/api/vault/index/issues?limit=200")
        .await;
    issues.assert_status_ok();
    let issues = issues.json::<Value>();
    let remaining_fingerprints = issues["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|item| item["fingerprint"].as_str())
        .collect::<BTreeSet<_>>();
    assert!(!remaining_fingerprints.contains(unresolved_fingerprint.as_str()));
    assert!(!remaining_fingerprints.contains(ambiguous_fingerprint.as_str()));

    let outlinks = fixture
        .server
        .get("/api/vault/index/outlinks/notes/source.md")
        .await;
    outlinks.assert_status_ok();
    let outlinks = outlinks.json::<Vec<Value>>();
    assert_eq!(outlinks.len(), 2);
    let selected = outlinks
        .iter()
        .find(|link| link["target_raw"] == TWIN_B_ID)
        .unwrap();
    assert_eq!(selected["target_id"], TWIN_B_ID);
    assert_eq!(selected["target_path"], DELIMITER_CANDIDATE_PATH);
    assert_eq!(
        outlinks
            .iter()
            .map(|link| link["target_path"].as_str().unwrap())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["notes/Missing Page.md", DELIMITER_CANDIDATE_PATH])
    );
}

fn complete_projection_fixture() -> ApiFixture {
    ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::create_dir_all(root.join("notes")).unwrap();
            for (path, content) in [
                ("source.md", "---\nid: 019fd000-0000-7000-8000-000000000730\ntitle: Source\n---\n[[Missing]] [[Twin]] ((abc123DEF0)) [[Connector]].\n"),
                ("twin-a.md", "---\nid: 019fd000-0000-7000-8000-000000000731\ntitle: Twin\n---\nA.\n"),
                ("twin-b.md", "---\nid: 019fd000-0000-7000-8000-000000000732\ntitle: Twin\n---\nB.\n"),
                ("relation.md", "+++\nid = \"019fd000-0000-7000-8000-000000000733\"\ntitle = \"Relation\"\nlink = [\"[[Twin]]\"]\n+++\nRelation.\n"),
                ("private.md", "---\nid: 019fd000-0000-7000-8000-000000000734\ntitle: Private\n---\nNever reveal [[Private Missing]].\n"),
                ("connector.md", "---\nid: 019fd000-0000-7000-8000-000000000735\ntitle: Connector\n---\n[[notes/source]] [[notes/twin-a]] [[notes/twin-b]] [[notes/relation]] [[notes/private]].\n"),
                ("orphan.md", "---\nid: 019fd000-0000-7000-8000-000000000736\ntitle: Orphan\n---\n[[notes/source]].\n"),
                ("isolated.md", "---\nid: 019fd000-0000-7000-8000-000000000737\ntitle: Isolated\n---\nAlone.\n"),
            ] {
                fs::write(root.join("notes").join(path), content).unwrap();
            }
        })
        .post_index_mutation(|state| {
            let connection =
                rusqlite::Connection::open(state.vault.root().join(".clepsydra/cache.db")).unwrap();
            connection
                .execute(
                    "UPDATE pages SET encrypted = 1 WHERE id = ?1",
                    ["019fd000-0000-7000-8000-000000000734"],
                )
                .unwrap();
        })
        .build()
}

#[tokio::test]
async fn projects_all_six_issue_classes_in_exact_paginated_order_with_privacy() {
    let fixture = complete_projection_fixture();
    let mut items = Vec::new();
    for offset in [0, 3, 6] {
        let response = fixture
            .server
            .get(&format!("/api/vault/index/issues?limit=3&offset={offset}"))
            .await;
        response.assert_status_ok();
        let response = response.json::<Value>();
        assert_eq!(response["total"], 7);
        assert_eq!(response["limit"], 3);
        assert_eq!(response["offset"], offset);
        items.extend(response["items"].as_array().unwrap().iter().cloned());
    }
    assert_eq!(items.len(), 7);
    assert_eq!(
        items
            .iter()
            .map(|item| (
                item["kind"].as_str().unwrap(),
                item["source_path"].as_str().unwrap()
            ))
            .collect::<Vec<_>>(),
        vec![
            ("broken_block_ref", "notes/source.md"),
            ("invalid_relation_target", "notes/relation.md"),
            ("unresolved_page_link", "notes/private.md"),
            ("unresolved_page_link", "notes/source.md"),
            ("ambiguous_page_link", "notes/source.md"),
            ("orphan_page", "notes/orphan.md"),
            ("isolated_page", "notes/isolated.md"),
        ]
    );
    assert_eq!(
        items
            .iter()
            .map(|item| item["kind"].as_str().unwrap())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            "ambiguous_page_link",
            "broken_block_ref",
            "invalid_relation_target",
            "isolated_page",
            "orphan_page",
            "unresolved_page_link",
        ])
    );
    let protected = items
        .iter()
        .find(|item| {
            item["source_path"] == "notes/private.md" && item["kind"] == "unresolved_page_link"
        })
        .unwrap();
    assert_eq!(protected["snippet"], Value::Null);
    assert_eq!(protected["target_raw"], Value::Null);
    assert_eq!(protected["source_field"], Value::Null);
    assert_eq!(protected["span_start"], Value::Null);
    assert_eq!(protected["span_end"], Value::Null);
    assert_eq!(protected["candidates"], json!([]));
    assert_eq!(protected["actions"], json!(["open_source"]));
}

#[tokio::test]
async fn stale_apply_returns_conflict_without_mutating_source_or_index() {
    let fixture = repair_fixture();
    let ambiguous = issue(&fixture.server, "ambiguous_page_link", "Twin").await;
    let request = json!({
        "fingerprint": ambiguous["fingerprint"],
        "source_revision": ambiguous["source_revision"],
        "action": { "type": "replace", "candidate_page_id": TWIN_B_ID },
    });
    fixture
        .server
        .post("/api/vault/index/issues/preview")
        .json(&request)
        .await
        .assert_status_ok();
    let source_path = fixture.temp_dir.path().join("vault/notes/source.md");
    let changed = "---\nid: 019fd000-0000-7000-8000-000000000701\ntitle: Repair Workflow Source\n---\nChanged after preview.\n";
    fs::write(&source_path, changed).unwrap();
    let mut notifications = fixture.state.change_tx.subscribe();

    let response = fixture
        .server
        .post("/api/vault/index/issues/apply")
        .json(&request)
        .await;

    response.assert_status(StatusCode::CONFLICT);
    assert_eq!(fs::read_to_string(source_path).unwrap(), changed);
    assert!(notifications.try_recv().is_err());
    let projected = issue(&fixture.server, "ambiguous_page_link", "Twin").await;
    assert_eq!(projected["fingerprint"], ambiguous["fingerprint"]);
}
