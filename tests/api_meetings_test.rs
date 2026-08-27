//! MEETING and ONE_ON_ONE pages and the `attendees` relation they share.

mod support;

use axum::http::StatusCode;
use axum_test::TestServer;
use support::ApiFixture;
use tempfile::TempDir;

fn setup_server() -> (TestServer, TempDir) {
    ApiFixture::builder().build().into_server_and_temp()
}

/// Create a page and return its JSON detail.
async fn create(
    server: &TestServer,
    path: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let response = server
        .post(&format!("/api/vault/pages/{path}"))
        .json(&body)
        .await;
    let status = StatusCode::from_u16(response.status_code().as_u16()).unwrap();
    (status, response.json())
}

async fn attendees_of(server: &TestServer, path: &str) -> serde_json::Value {
    let response = server.get(&format!("/api/vault/pages/{path}")).await;
    response.assert_status_ok();
    let page: serde_json::Value = response.json();
    page["meta"]["attendees"].clone()
}

#[tokio::test]
async fn a_meeting_is_created_with_any_number_of_attendees() {
    let (server, _tmp) = setup_server();

    let (status, created) = create(
        &server,
        "meetings/kickoff.md",
        serde_json::json!({
            "title": "Kickoff",
            "kind": "MEETING",
            "attendees": ["Ada Lovelace", "[[Grace Hopper]]", "Alan Turing"],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["kind"], "MEETING");
    let path = created["path"].as_str().unwrap().to_string();

    // Bare names are wrapped; an already-linked name is left as written.
    assert_eq!(
        attendees_of(&server, &path).await,
        serde_json::json!(["[[Ada Lovelace]]", "[[Grace Hopper]]", "[[Alan Turing]]"])
    );

    // A meeting nobody has been added to yet is still a meeting, and an empty
    // list writes no key at all rather than an empty array.
    let (status, empty) = create(
        &server,
        "meetings/empty.md",
        serde_json::json!({ "title": "Empty", "kind": "MEETING", "attendees": [] }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        attendees_of(&server, empty["path"].as_str().unwrap()).await,
        serde_json::Value::Null
    );
}

#[tokio::test]
async fn a_one_on_one_takes_one_attendee_and_refuses_a_second() {
    let (server, _tmp) = setup_server();

    let (status, created) = create(
        &server,
        "one-on-ones/ada.md",
        serde_json::json!({
            "title": "Ada — August",
            "kind": "ONE_ON_ONE",
            "attendees": ["Ada Lovelace"],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["kind"], "ONE_ON_ONE");
    assert!(
        created["path"]
            .as_str()
            .unwrap()
            .starts_with("one-on-ones/"),
        "1:1 should file under its canonical folder: {created}"
    );

    let (status, error) = create(
        &server,
        "one-on-ones/crowd.md",
        serde_json::json!({
            "title": "Not A 1:1",
            "kind": "ONE_ON_ONE",
            "attendees": ["Ada Lovelace", "Grace Hopper"],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        error["error"]
            .as_str()
            .unwrap()
            .contains("names one attendee"),
        "unhelpful error: {error}"
    );
}

#[tokio::test]
async fn an_inferred_one_on_one_is_bound_by_the_same_rule() {
    // No declared kind: the folder makes it a ONE_ON_ONE, and the attendee
    // ceiling has to travel with the inference.
    let (server, _tmp) = setup_server();

    let (status, _) = create(
        &server,
        "one-on-ones/inferred.md",
        serde_json::json!({
            "title": "Inferred",
            "attendees": ["Ada Lovelace", "Grace Hopper"],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn meeting_pages_open_with_a_scaffold_body() {
    let (server, _tmp) = setup_server();

    for (path, kind) in [
        ("meetings/scaffold.md", "MEETING"),
        ("one-on-ones/scaffold.md", "ONE_ON_ONE"),
    ] {
        let (status, created) = create(
            &server,
            path,
            serde_json::json!({ "title": "Scaffold", "kind": kind }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let body = created["body"].as_str().unwrap();
        assert!(body.contains("## Agenda"), "no scaffold for {kind}: {body}");
        assert!(body.contains("## Notes"), "no scaffold for {kind}: {body}");
        assert!(
            body.contains("## Actions"),
            "no scaffold for {kind}: {body}"
        );
    }

    // A supplied body is never overwritten.
    let (_, created) = create(
        &server,
        "meetings/authored.md",
        serde_json::json!({ "title": "Authored", "kind": "MEETING", "body": "just this\n" }),
    )
    .await;
    assert_eq!(created["body"], "just this\n");
}

#[tokio::test]
async fn attendees_become_backlinks_on_the_person_page() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/people/ada.md")
        .json(&serde_json::json!({ "title": "Ada Lovelace", "kind": "PERSON" }))
        .await
        .assert_status(StatusCode::CREATED);

    let (status, meeting) = create(
        &server,
        "meetings/kickoff.md",
        serde_json::json!({
            "title": "Kickoff",
            "kind": "MEETING",
            "attendees": ["Ada Lovelace"],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let meeting_path = meeting["path"].as_str().unwrap().to_string();

    let response = server.get("/api/vault/index/backlinks/people/ada.md").await;
    response.assert_status_ok();
    let backlinks: serde_json::Value = response.json();
    let entry = backlinks
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["source_path"] == meeting_path.as_str())
        .unwrap_or_else(|| panic!("meeting missing from Ada's backlinks: {backlinks}"));
    assert_eq!(entry["kind"], "property_ref");
}

#[tokio::test]
async fn assigning_one_on_one_to_a_crowded_page_is_refused() {
    let (server, _tmp) = setup_server();

    let (status, meeting) = create(
        &server,
        "meetings/kickoff.md",
        serde_json::json!({
            "title": "Kickoff",
            "kind": "MEETING",
            "attendees": ["Ada Lovelace", "Grace Hopper"],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let path = meeting["path"].as_str().unwrap().to_string();

    let refused = server
        .post(&format!("/api/vault/pages-assign/{path}"))
        .json(&serde_json::json!({ "kind": "ONE_ON_ONE" }))
        .await;
    refused.assert_status(StatusCode::BAD_REQUEST);

    // The same page reassigned to MEETING is fine — only the 1:1 has a ceiling.
    let allowed = server
        .post(&format!("/api/vault/pages-assign/{path}"))
        .json(&serde_json::json!({ "kind": "MEETING" }))
        .await;
    allowed.assert_status_ok();
}

#[tokio::test]
async fn patching_attendees_is_held_to_the_kind_ceiling() {
    let (server, _tmp) = setup_server();

    let (status, created) = create(
        &server,
        "one-on-ones/ada.md",
        serde_json::json!({
            "title": "Ada — August",
            "kind": "ONE_ON_ONE",
            "attendees": ["Ada Lovelace"],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = created["meta"]["id"].as_str().unwrap().to_string();
    let revision = created["revision"].as_str().unwrap().to_string();

    let refused = server
        .patch(&format!("/api/vault/pages/by-id/{id}/properties"))
        .json(&serde_json::json!({
            "set": { "attendees": ["[[Ada Lovelace]]", "[[Grace Hopper]]"] },
            "expected_revision": revision,
        }))
        .await;
    refused.assert_status(StatusCode::BAD_REQUEST);

    // The refusal left the page alone, so the original revision still applies.
    let swapped = server
        .patch(&format!("/api/vault/pages/by-id/{id}/properties"))
        .json(&serde_json::json!({
            "set": { "attendees": ["[[Grace Hopper]]"] },
            "expected_revision": revision,
        }))
        .await;
    swapped.assert_status_ok();
    let patched: serde_json::Value = swapped.json();
    assert_eq!(patched["properties"]["attendees"], "[[Grace Hopper]]");
}
