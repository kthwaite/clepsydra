mod support;

use std::sync::Arc;

use chrono::{DateTime, Utc};
use clep_api::api::Clock;
use serde_json::{Value, json};
use support::ApiFixture;

struct FixedClock;

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        "2026-11-13T12:00:00Z".parse().unwrap()
    }
}

fn fixture() -> ApiFixture {
    ApiFixture::builder().clock(Arc::new(FixedClock)).build()
}

fn telemetry(call_id: &str, started_at: &str, outcome: &str) -> Value {
    json!({
        "session_id": "00000000-0000-4000-8000-000000000001",
        "client_name": "Test client", "client_version": "1.0", "agent_label": "Research",
        "tools": [{"name": "vault_get_page", "read_only": true},
                  {"name": "vault_create_page", "read_only": false}],
        "call": {"call_id": call_id, "tool": "vault_get_page", "started_at": started_at,
                 "duration_ms": 20, "outcome": outcome, "error_code": null, "pages": []}
    })
}

async fn stats(f: &ApiFixture, days: u32) -> Value {
    let response = f
        .server
        .get(&format!("/api/vault/mcp/stats?days={days}"))
        .await;
    response.assert_status_ok();
    response.json()
}

#[tokio::test]
async fn telemetry_is_idempotent_and_catalog_includes_unused_tools() {
    let f = fixture();
    let empty = stats(&f, 30).await;
    assert_eq!(empty["total_calls"], 0);
    assert_eq!(empty["tracking_since"], Value::Null);
    assert_eq!(empty["tools"], json!([]));

    let event = telemetry(
        "00000000-0000-4000-8000-000000000002",
        "2026-11-13T11:00:00Z",
        "success",
    );
    for _ in 0..2 {
        f.server
            .post("/api/vault/mcp/telemetry")
            .json(&event)
            .await
            .assert_status_no_content();
    }
    let report = stats(&f, 30).await;
    assert_eq!(report["total_calls"], 1);
    assert_eq!(report["successful_calls"], 1);
    assert_eq!(report["failed_calls"], 0);
    assert_eq!(report["sessions"], 1);
    assert_eq!(report["agents"], 1);
    assert_eq!(report["average_duration_ms"], 20.0);
    assert_eq!(report["tools"].as_array().unwrap().len(), 2);
    let unused = report["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "vault_create_page")
        .unwrap();
    assert_eq!(unused["calls"], 0);
    assert_eq!(unused["read_only"], false);
    assert_eq!(unused["last_used_at"], Value::Null);
    assert_eq!(report["clients"][0]["name"], "Research");
    assert_eq!(report["clients"][0]["client_version"], "1.0");
    assert_eq!(
        report["daily"],
        json!([{"date": "2026-11-13", "calls": 1, "failures": 0}])
    );
    assert_eq!(report["recent_calls"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn windows_include_exact_boundaries_and_exclude_future_calls() {
    let f = fixture();
    for (id, date, outcome) in [
        (2, "2026-11-06T11:59:59.999999999Z", "success"),
        (3, "2026-11-06T12:00:00Z", "tool_error"),
        (4, "2026-11-13T12:00:00.000000000Z", "cancelled"),
        (5, "2026-11-13T12:00:00.000000001Z", "success"),
    ] {
        let event = telemetry(&format!("00000000-0000-4000-8000-{id:012}"), date, outcome);
        f.server
            .post("/api/vault/mcp/telemetry")
            .json(&event)
            .await
            .assert_status_no_content();
    }
    let report = stats(&f, 7).await;
    assert_eq!(report["total_calls"], 2);
    assert_eq!(report["failed_calls"], 2);
    assert_eq!(report["tracking_since"], "2026-11-06T11:59:59.999999999Z");
    assert_eq!(stats(&f, 0).await["total_calls"], 3);
    assert_eq!(stats(&f, 90).await["total_calls"], 3);
    let default: Value = f.server.get("/api/vault/mcp/stats").await.json();
    assert_eq!(default["days"], 30);
    f.server
        .get("/api/vault/mcp/stats?days=8")
        .await
        .assert_status_bad_request();
}

#[tokio::test]
async fn resolved_references_deduplicate_and_survive_move_rebuild_and_deletion() {
    let f = fixture();
    let created = f
        .server
        .post("/api/vault/pages/example.md")
        .json(&json!({"title": "Example", "body": "Never persisted as telemetry"}))
        .await;
    created.assert_status(axum::http::StatusCode::CREATED);
    let page: Value = created.json();
    let id = page["meta"]["id"].as_str().unwrap();
    let mut event = telemetry(
        "00000000-0000-4000-8000-000000000002",
        "2026-11-13T11:00:00Z",
        "success",
    );
    event["call"]["pages"] = json!([
        {"page_id": id, "source": "target"},
        {"path": "example.md", "source": "target"},
        {"path": "example.md", "source": "result"},
        {"path": "missing.md", "source": "target"}
    ]);
    f.server
        .post("/api/vault/mcp/telemetry")
        .json(&event)
        .await
        .assert_status_no_content();
    let report = stats(&f, 30).await;
    assert_eq!(report["pages"], 2);
    assert_eq!(
        report["recent_calls"][0]["pages"].as_array().unwrap().len(),
        3
    );
    let resolved = report["page_activity"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["page_id"] == id)
        .unwrap();
    assert_eq!(resolved["calls"], 1);
    assert_eq!(resolved["target_calls"], 1);
    assert_eq!(resolved["result_calls"], 1);
    assert_eq!(resolved["title"], "Example");

    f.server
        .post("/api/vault/pages-move/example.md")
        .json(&json!({"destination": "renamed.md"}))
        .await
        .assert_status_ok();
    f.server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();
    let report = stats(&f, 30).await;
    assert_eq!(report["total_calls"], 1);
    let resolved = report["page_activity"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["page_id"] == id)
        .unwrap();
    assert_eq!(resolved["path"], "renamed.md");
    assert_eq!(resolved["title"], "Example");

    f.server
        .delete("/api/vault/pages/renamed.md")
        .await
        .assert_status(axum::http::StatusCode::CREATED);
    f.server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();
    let report = stats(&f, 30).await;
    assert_eq!(report["total_calls"], 1);
    assert_eq!(report["pages"], 2);
    let deleted = report["page_activity"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["page_id"] == id)
        .unwrap();
    assert_eq!(deleted["title"], Value::Null);
    assert_eq!(deleted["path"], "example.md");
}

#[tokio::test]
async fn invalid_envelopes_are_rejected_without_registering_any_metadata() {
    let f = fixture();
    let valid = telemetry(
        "00000000-0000-4000-8000-000000000002",
        "2026-11-13T11:00:00Z",
        "success",
    );
    for (pointer, invalid) in [
        ("/session_id", json!("not-a-uuid")),
        ("/call/call_id", json!("not-a-uuid")),
        ("/call/started_at", json!("2026-11-13T11:00:00+01:00")),
        ("/call/started_at", json!("not-a-date")),
        ("/call/outcome", json!("failed")),
        ("/call/error_code", json!(-32602)),
        ("/client_name", json!("x".repeat(257))),
        ("/call/duration_ms", json!(u64::MAX)),
        (
            "/call/pages",
            json!([{"path": "../secret", "source": "target"}]),
        ),
        (
            "/call/pages",
            json!([{"path": "example.md", "source": "unknown"}]),
        ),
        ("/call/pages", json!([{"source": "target"}])),
        (
            "/call/pages",
            json!(vec![
                json!({"path": "example.md", "source": "result"});
                1001
            ]),
        ),
        (
            "/tools",
            json!(vec![json!({"name": "tool", "read_only": true}); 513]),
        ),
    ] {
        let mut event = valid.clone();
        *event.pointer_mut(pointer).unwrap() = invalid;
        f.server
            .post("/api/vault/mcp/telemetry")
            .json(&event)
            .await
            .assert_status_bad_request();
    }
    let mut with_secret = valid;
    with_secret["call"]["arguments"] = json!({"secret": "not telemetry"});
    f.server
        .post("/api/vault/mcp/telemetry")
        .json(&with_secret)
        .await
        .assert_status(axum::http::StatusCode::UNPROCESSABLE_ENTITY);
    let report = stats(&f, 0).await;
    assert_eq!(report["total_calls"], 0);
    assert_eq!(report["tracking_since"], Value::Null);
    assert_eq!(report["tools"], json!([]));
}

#[tokio::test]
async fn catalog_only_registration_and_unknown_tools_keep_truthful_identity() {
    let f = fixture();
    let mut event = telemetry(
        "00000000-0000-4000-8000-000000000002",
        "2026-11-13T11:00:00Z",
        "protocol_error",
    );
    let mut catalog = event.clone();
    catalog["call"] = Value::Null;
    f.server
        .post("/api/vault/mcp/telemetry")
        .json(&catalog)
        .await
        .assert_status_no_content();
    let empty = stats(&f, 30).await;
    assert_eq!(empty["total_calls"], 0);
    assert_eq!(empty["sessions"], 0);
    assert_eq!(empty["agents"], 0);
    assert_eq!(empty["tracking_since"], "2026-11-13T12:00:00.000000000Z");
    assert_eq!(empty["tools"].as_array().unwrap().len(), 2);

    event["tools"] = json!([]);
    event["client_name"] = json!("");
    event["agent_label"] = json!("");
    event["call"]["tool"] = json!("unknown_tool");
    event["call"]["error_code"] = json!(-32601);
    f.server
        .post("/api/vault/mcp/telemetry")
        .json(&event)
        .await
        .assert_status_no_content();
    let report = stats(&f, 30).await;
    assert_eq!(report["tools"].as_array().unwrap().len(), 3);
    assert_eq!(report["tools"][0]["name"], "unknown_tool");
    assert_eq!(report["failed_calls"], 1);
    assert_eq!(report["clients"][0]["name"], "Unknown client");
    assert_eq!(report["recent_calls"][0]["error_code"], -32601);

    // A replay under a different identity cannot change either the catalog or history.
    event["client_name"] = json!("Spoofed replay");
    event["tools"] = json!([{"name": "replay_only", "read_only": false}]);
    f.server
        .post("/api/vault/mcp/telemetry")
        .json(&event)
        .await
        .assert_status_no_content();
    assert_eq!(stats(&f, 30).await, report);
}

#[tokio::test]
async fn history_survives_reopening_the_index_database() {
    let f = fixture();
    let event = telemetry(
        "00000000-0000-4000-8000-000000000002",
        "2026-11-13T11:00:00Z",
        "success",
    );
    f.server
        .post("/api/vault/mcp/telemetry")
        .json(&event)
        .await
        .assert_status_no_content();
    let before = stats(&f, 30).await;
    let ApiFixture {
        app,
        server,
        state,
        temp_dir: _temp_dir,
    } = f;
    drop(server);
    drop(app);
    let mut state = Arc::try_unwrap(state).unwrap_or_else(|_| panic!("fixture must own its state"));
    let index =
        clep_index::index::VaultIndex::open(&state.vault.root().join(".clepsydra/cache.db"))
            .unwrap();
    state.index = clep_index::index_handle::IndexHandle::spawn(index, state.vault.clone());
    let server = axum_test::TestServer::new(
        axum::Router::new()
            .nest("/api/vault", clep_api::api::api_router())
            .with_state(Arc::new(state)),
    )
    .unwrap();
    server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();
    let after: Value = server.get("/api/vault/mcp/stats?days=30").await.json();
    assert_eq!(after, before);
}

#[tokio::test]
async fn references_resolve_later_without_splitting_page_identity() {
    let f = fixture();
    let mut event = telemetry(
        "00000000-0000-4000-8000-000000000002",
        "2026-11-13T10:00:00Z",
        "tool_error",
    );
    event["call"]["pages"] = json!([{"path": "later.md", "source": "target"}]);
    f.server
        .post("/api/vault/mcp/telemetry")
        .json(&event)
        .await
        .assert_status_no_content();
    let before = stats(&f, 30).await;
    assert_eq!(before["page_activity"][0]["title"], Value::Null);

    let created: Value = f
        .server
        .post("/api/vault/pages/later.md")
        .json(&json!({"title": "Later"}))
        .await
        .json();
    event["call"]["call_id"] = json!("00000000-0000-4000-8000-000000000003");
    event["call"]["started_at"] = json!("2026-11-13T11:00:00Z");
    event["call"]["outcome"] = json!("success");
    event["call"]["pages"] = json!([{"page_id": created["meta"]["id"], "source": "result"}]);
    f.server
        .post("/api/vault/mcp/telemetry")
        .json(&event)
        .await
        .assert_status_no_content();
    let after = stats(&f, 30).await;
    assert_eq!(after["pages"], 1);
    assert_eq!(after["page_activity"][0]["calls"], 2);
    assert_eq!(after["page_activity"][0]["target_calls"], 1);
    assert_eq!(after["page_activity"][0]["result_calls"], 1);
    assert_eq!(after["page_activity"][0]["title"], "Later");
    assert_eq!(after["page_activity"][0]["page_id"], created["meta"]["id"]);
}

#[tokio::test]
async fn identity_grouping_counts_effective_labels_not_client_versions() {
    let f = fixture();
    for (number, label, version, duration) in [
        (2, Some("Research"), "1.0", 10),
        (3, Some("Research"), "2.0", 30),
        (4, None, "1.0", 50),
    ] {
        let mut event = telemetry(
            &format!("00000000-0000-4000-8000-{number:012}"),
            "2026-11-13T11:00:00Z",
            "success",
        );
        event["session_id"] = json!(format!("00000000-0000-4000-8000-{:012}", number + 10));
        event["agent_label"] = json!(label);
        event["client_version"] = json!(version);
        event["call"]["duration_ms"] = json!(duration);
        f.server
            .post("/api/vault/mcp/telemetry")
            .json(&event)
            .await
            .assert_status_no_content();
    }
    let report = stats(&f, 30).await;
    assert_eq!(report["sessions"], 3);
    assert_eq!(report["agents"], 2);
    assert_eq!(report["clients"].as_array().unwrap().len(), 3);
    assert_eq!(report["average_duration_ms"], 30.0);
}

#[tokio::test]
async fn untitled_indexed_pages_are_distinguishable_from_missing_pages() {
    let f = ApiFixture::builder()
        .clock(Arc::new(FixedClock))
        .pre_index_seed(|root| {
            std::fs::write(
                root.join("untitled.md"),
                "---\nid: 00000000-0000-4000-8000-000000000099\n---\nBody without a title\n",
            )
            .unwrap();
        })
        .build();
    let mut event = telemetry(
        "00000000-0000-4000-8000-000000000002",
        "2026-11-13T11:00:00Z",
        "success",
    );
    event["call"]["pages"] = json!([{"path": "untitled.md", "source": "result"}]);
    f.server
        .post("/api/vault/mcp/telemetry")
        .json(&event)
        .await
        .assert_status_no_content();
    let report = stats(&f, 30).await;
    assert!(report["page_activity"][0]["title"].is_string());
    assert_eq!(report["page_activity"][0]["path"], "untitled.md");
}

#[tokio::test]
async fn omitted_client_identity_uses_an_explicit_unknown_label() {
    let f = fixture();
    let mut event = telemetry(
        "00000000-0000-4000-8000-000000000002",
        "2026-11-13T11:00:00Z",
        "success",
    );
    let envelope = event.as_object_mut().unwrap();
    envelope.remove("client_name");
    envelope.remove("client_version");
    envelope.remove("agent_label");
    f.server
        .post("/api/vault/mcp/telemetry")
        .json(&event)
        .await
        .assert_status_no_content();
    let report = stats(&f, 30).await;
    assert_eq!(report["clients"][0]["name"], "Unknown client");
    assert_eq!(report["clients"][0]["client_name"], "Unknown client");
    assert_eq!(report["clients"][0]["client_version"], "");
    assert_eq!(report["recent_calls"][0]["agent_label"], Value::Null);
}

#[tokio::test]
async fn bounded_detail_lists_do_not_truncate_summary_totals() {
    let f = fixture();
    for number in 0..55 {
        let mut event = telemetry(
            &format!("00000000-0000-4000-8000-{:012}", number + 2),
            &format!("2026-11-13T10:{number:02}:00Z"),
            "success",
        );
        event["tools"] = json!([]);
        event["call"]["pages"] =
            json!([{"path": format!("missing-{number}.md"), "source": "target"}]);
        f.server
            .post("/api/vault/mcp/telemetry")
            .json(&event)
            .await
            .assert_status_no_content();
    }
    let report = stats(&f, 30).await;
    assert_eq!(report["total_calls"], 55);
    assert_eq!(report["pages"], 55);
    assert_eq!(report["daily"][0]["calls"], 55);
    assert_eq!(report["page_activity"].as_array().unwrap().len(), 50);
    assert_eq!(report["recent_calls"].as_array().unwrap().len(), 50);
    assert_eq!(
        report["recent_calls"][0]["started_at"],
        "2026-11-13T10:54:00.000000000Z"
    );
    assert_eq!(
        report["recent_calls"][49]["started_at"],
        "2026-11-13T10:05:00.000000000Z"
    );
}

#[tokio::test]
async fn telemetry_body_limit_rejects_oversized_json() {
    let f = fixture();
    let mut event = telemetry(
        "00000000-0000-4000-8000-000000000002",
        "2026-11-13T11:00:00Z",
        "success",
    );
    event["client_name"] = json!("x".repeat(2 * 1024 * 1024));
    f.server
        .post("/api/vault/mcp/telemetry")
        .json(&event)
        .await
        .assert_status(axum::http::StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(stats(&f, 30).await["tracking_since"], Value::Null);
}
