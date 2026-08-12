mod support;

use std::collections::BTreeSet;
use std::fs;

use axum_test::TestServer;
use serde_json::{Value, json};
use support::ApiFixture;

const SOURCE_ID: &str = "019fd000-0000-7000-8000-000000000701";
const TWIN_A_ID: &str = "019fd000-0000-7000-8000-000000000702";
const TWIN_B_ID: &str = "019fd000-0000-7000-8000-000000000703";

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
                    "twin-b.md",
                    format!("---\nid: {TWIN_B_ID}\ntitle: Twin\n---\nSecond twin.\n"),
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
    response
        .json::<Value>()["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["target_raw"] == target)
        .unwrap_or_else(|| panic!("missing {kind} issue for {target}"))
        .clone()
}

async fn preview_and_apply(server: &TestServer, request: &Value) -> Value {
    let preview = server
        .post("/api/vault/index/issues/preview")
        .json(request)
        .await;
    preview.assert_status_ok();
    let preview = preview.json::<Value>();
    assert_eq!(preview["fingerprint"], request["fingerprint"]);

    let apply = server
        .post("/api/vault/index/issues/apply")
        .json(request)
        .await;
    apply.assert_status_ok();
    let apply = apply.json::<Value>();
    assert_eq!(apply["fingerprint"], request["fingerprint"]);
    apply
}

#[tokio::test]
async fn repairs_unresolved_and_ambiguous_links_through_the_public_workflow() {
    let fixture = repair_fixture();
    let unresolved = issue(
        &fixture.server,
        "unresolved_page_link",
        "Missing Page",
    )
    .await;
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
    let create_apply = preview_and_apply(&fixture.server, &create_request).await;
    assert_eq!(
        create_apply["notification"]["upserted"],
        json!(["notes/Missing Page.md", "notes/source.md"])
    );

    let chosen = ambiguous["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|candidate| candidate["page_id"] == TWIN_B_ID)
        .unwrap();
    let replace_request = json!({
        "fingerprint": ambiguous["fingerprint"],
        "source_revision": ambiguous["source_revision"],
        "action": {
            "type": "replace",
            "candidate_page_id": chosen["page_id"],
        },
    });
    let replace_apply = preview_and_apply(&fixture.server, &replace_request).await;
    assert_eq!(
        replace_apply["notification"]["upserted"],
        json!(["notes/source.md"])
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
    assert!(
        outlinks.iter().all(|link| link["target_id"].is_string()),
        "both repaired links must resolve to indexed targets: {outlinks:#?}"
    );
    assert_eq!(
        outlinks
            .iter()
            .map(|link| link["target_path"].as_str().unwrap())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["notes/Missing Page.md", "notes/twin-b.md"])
    );
}
