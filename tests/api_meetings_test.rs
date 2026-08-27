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

async fn meta_key(server: &TestServer, path: &str, key: &str) -> serde_json::Value {
    let response = server.get(&format!("/api/vault/pages/{path}")).await;
    response.assert_status_ok();
    let page: serde_json::Value = response.json();
    page["meta"][key].clone()
}

async fn attendees_of(server: &TestServer, path: &str) -> serde_json::Value {
    meta_key(server, path, "attendees").await
}

/// The frontmatter line for `key` as it sits on disk, so a native TOML
/// date-time can be told apart from a quoted string — a distinction the JSON
/// response erases.
fn frontmatter_line(tmp: &TempDir, path: &str, key: &str) -> String {
    let raw = std::fs::read_to_string(tmp.path().join("vault").join(path))
        .unwrap_or_else(|error| panic!("page {path} should be readable: {error}"));
    raw.lines()
        .find(|line| line.trim_start().starts_with(key))
        .unwrap_or_else(|| panic!("no `{key}` line in:\n{raw}"))
        .to_string()
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

#[tokio::test]
async fn a_meeting_records_when_it_took_place() {
    let (server, _tmp) = setup_server();

    let (status, created) = create(
        &server,
        "meetings/kickoff.md",
        serde_json::json!({
            "title": "Kickoff",
            "kind": "MEETING",
            "occurred_at": "2026-08-27T14:00:00Z",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let path = created["path"].as_str().unwrap().to_string();

    assert_eq!(
        meta_key(&server, &path, "occurred_at").await,
        serde_json::json!("2026-08-27T14:00:00Z")
    );
}

#[tokio::test]
async fn an_occurrence_is_stored_as_a_native_toml_date_time() {
    // Quoted, it would be inert text the index never projects as a date.
    let (server, tmp) = setup_server();

    let (status, created) = create(
        &server,
        "meetings/kickoff.md",
        serde_json::json!({
            "title": "Kickoff",
            "kind": "MEETING",
            "occurred_at": "2026-08-27T14:00:00Z",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let path = created["path"].as_str().unwrap().to_string();

    let line = frontmatter_line(&tmp, &path, "occurred_at");
    assert!(
        line.contains("2026-08-27T14:00:00Z") && !line.contains('"'),
        "occurred_at should be an unquoted TOML date-time, got: {line:?}"
    );
}

#[tokio::test]
async fn a_day_without_an_hour_is_accepted_and_nonsense_is_not() {
    let (server, _tmp) = setup_server();

    let (status, _) = create(
        &server,
        "meetings/dayonly.md",
        serde_json::json!({
            "title": "Day Only",
            "kind": "MEETING",
            "occurred_at": "2026-08-27",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, error) = create(
        &server,
        "meetings/nonsense.md",
        serde_json::json!({
            "title": "Nonsense",
            "kind": "MEETING",
            "occurred_at": "last tuesday",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        error["error"].as_str().unwrap().contains("occurred_at"),
        "unhelpful error: {error}"
    );

    // A time of day names no day, so it cannot say when a meeting happened.
    let (status, _) = create(
        &server,
        "meetings/timeonly.md",
        serde_json::json!({
            "title": "Time Only",
            "kind": "MEETING",
            "occurred_at": "14:00:00",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn patching_the_occurrence_keeps_it_a_date_time() {
    let (server, tmp) = setup_server();

    let (status, created) = create(
        &server,
        "meetings/kickoff.md",
        serde_json::json!({ "title": "Kickoff", "kind": "MEETING" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = created["meta"]["id"].as_str().unwrap().to_string();
    let path = created["path"].as_str().unwrap().to_string();
    let revision = created["revision"].as_str().unwrap().to_string();

    // The `datetime` hint is what turns the JSON string into a TOML date-time.
    let patched = server
        .patch(&format!("/api/vault/pages/by-id/{id}/properties"))
        .json(&serde_json::json!({
            "set": { "occurred_at": "2026-08-27T14:00:00Z" },
            "types": { "occurred_at": "datetime" },
            "expected_revision": revision,
        }))
        .await;
    patched.assert_status_ok();

    let line = frontmatter_line(&tmp, &path, "occurred_at");
    assert!(
        !line.contains('"'),
        "patched occurred_at should stay unquoted, got: {line:?}"
    );
}

#[tokio::test]
async fn patching_an_unhinted_occurrence_is_refused() {
    // Without the type hint the splice would store a string, which reads back
    // as a date to nobody. Better a 400 than a silently inert value.
    let (server, _tmp) = setup_server();

    let (status, created) = create(
        &server,
        "meetings/kickoff.md",
        serde_json::json!({ "title": "Kickoff", "kind": "MEETING" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = created["meta"]["id"].as_str().unwrap().to_string();
    let revision = created["revision"].as_str().unwrap().to_string();

    let refused = server
        .patch(&format!("/api/vault/pages/by-id/{id}/properties"))
        .json(&serde_json::json!({
            "set": { "occurred_at": "2026-08-27T14:00:00Z" },
            "expected_revision": revision,
        }))
        .await;
    refused.assert_status(StatusCode::BAD_REQUEST);
}
