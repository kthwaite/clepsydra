use std::sync::Arc;
use std::time::Duration;

use clep_client::client::ApiClient;
use clep_mcp::server::VaultMcpServer;
use rmcp::ServiceExt;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const PAGE_ID: &str = "0190f8a0-0000-7000-8000-0000000000a1";
const TELEMETRY: &str = "/api/vault/mcp/telemetry";

struct McpConnection {
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
    serving: tokio::task::JoinHandle<()>,
    next_id: u32,
}

impl McpConnection {
    async fn connect(http: &MockServer) -> Self {
        let server = VaultMcpServer::new(Arc::new(ApiClient::new(http.uri(), None).unwrap()));
        let (client_io, server_io) = tokio::io::duplex(1024 * 1024);
        let serving = tokio::spawn(async move {
            server
                .serve(server_io)
                .await
                .unwrap()
                .waiting()
                .await
                .unwrap();
        });
        let (reader, writer) = tokio::io::split(client_io);
        let mut connection = Self {
            reader: BufReader::new(reader),
            writer,
            serving,
            next_id: 1,
        };
        let result = connection
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": {"name": "analytics-test-client", "version": "2.4"}
                }),
            )
            .await;
        assert!(result.get("error").is_none(), "{result}");
        connection
            .send(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
            .await;
        connection
    }

    async fn send(&mut self, message: Value) {
        self.writer
            .write_all(format!("{message}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await;
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(10), self.reader.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["id"], id);
        response
    }

    async fn call(&mut self, name: &str, arguments: Value) -> Value {
        self.request("tools/call", json!({"name": name, "arguments": arguments}))
            .await
    }
}

impl Drop for McpConnection {
    fn drop(&mut self) {
        self.serving.abort();
    }
}

async fn telemetry(http: &MockServer) -> Vec<Value> {
    http.received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|request| request.url.path() == TELEMETRY)
        .map(|request| serde_json::from_slice(&request.body).unwrap())
        .collect()
}

#[tokio::test]
async fn dispatch_registers_catalog_and_records_identity_outcomes_and_only_page_metadata() {
    let http = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(TELEMETRY))
        .respond_with(ResponseTemplate::new(204))
        .mount(&http)
        .await;
    Mock::given(method("GET"))
        .and(path(
            "/api/vault/pages/by-id/0190f8a0-0000-7000-8000-0000000000a1",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "path": "notes/alpha.md", "meta": {"id": PAGE_ID, "title": "PRIVATE TITLE"},
            "body": "PRIVATE BODY", "properties": {"id": "not-a-page", "path": "secret.md"}
        })))
        .mount(&http)
        .await;
    let mut mcp = McpConnection::connect(&http).await;
    let tools = mcp.request("tools/list", json!({})).await;
    let success = mcp.call("vault_get_page", json!({"id": PAGE_ID})).await;
    assert_ne!(success["result"]["isError"], true);
    assert!(
        success["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("PRIVATE BODY")
    );
    let tool_error = mcp
        .call("vault_update_page", json!({"path": "notes/alpha.md"}))
        .await;
    assert_eq!(tool_error["result"]["isError"], true);
    let invalid = mcp
        .call(
            "vault_get_page",
            json!({"id": 42, "body": "PRIVATE ARGUMENT"}),
        )
        .await;
    assert_eq!(invalid["result"]["isError"], true);
    let unknown = mcp
        .call("no_such_tool", json!({"prompt": "PRIVATE PROMPT"}))
        .await;
    assert!(unknown.get("error").is_some());

    let events = telemetry(&http).await;
    let catalog = events
        .iter()
        .find(|event| event["call"].is_null())
        .expect("initialization catalog");
    assert_eq!(
        catalog["tools"].as_array().unwrap().len(),
        tools["result"]["tools"].as_array().unwrap().len()
    );
    assert!(
        catalog["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool == &json!({"name": "vault_search", "read_only": true}))
    );
    assert!(
        catalog["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool == &json!({"name": "vault_create_page", "read_only": false}))
    );
    let calls: Vec<_> = events
        .iter()
        .filter(|event| event["call"].is_object())
        .collect();
    assert_eq!(calls.len(), 4, "tools/list must not count as usage");
    for event in &events {
        assert_eq!(event["client_name"], "analytics-test-client");
        assert_eq!(event["client_version"], "2.4");
        assert_eq!(event["session_id"], catalog["session_id"]);
        uuid::Uuid::parse_str(event["session_id"].as_str().unwrap()).unwrap();
    }
    let call = &calls[0]["call"];
    assert_eq!(call["outcome"], "success");
    assert_eq!(
        call["pages"],
        json!([
            {"page_id": PAGE_ID, "path": null, "source": "target"},
            {"page_id": PAGE_ID, "path": "notes/alpha.md", "source": "result"}
        ])
    );
    assert!(call["duration_ms"].as_u64().is_some());
    chrono::DateTime::parse_from_rfc3339(call["started_at"].as_str().unwrap()).unwrap();
    assert_eq!(calls[1]["call"]["outcome"], "tool_error");
    assert_eq!(calls[2]["call"]["outcome"], "tool_error");
    assert!(calls[2]["call"]["error_code"].is_null());
    assert_eq!(calls[3]["call"]["outcome"], "protocol_error");
    assert_eq!(calls[3]["call"]["error_code"], -32602);
    let serialized = serde_json::to_string(&events).unwrap();
    for private in [
        "PRIVATE",
        "secret.md",
        "not-a-page",
        "nothing to update",
        "Unknown tool",
    ] {
        assert!(!serialized.contains(private), "telemetry leaked {private}");
    }
}

#[tokio::test]
async fn dispatch_projects_page_metadata_from_each_result_family_without_reading_content() {
    let page = json!({"id": PAGE_ID, "path": "notes/alpha.md",
        "properties": {"path": "PRIVATE.md", "id": PAGE_ID},
        "columns": {"path": "PRIVATE.md"}, "body": "PRIVATE BODY"});
    let cases = vec![
        (
            "vault_search",
            json!({"query": "PRIVATE QUERY"}),
            "GET",
            "/api/vault/index/search",
            json!([{"page_id": PAGE_ID, "path": "notes/alpha.md", "snippet": "PRIVATE SNIPPET"}]),
        ),
        (
            "vault_list_pages",
            json!({}),
            "GET",
            "/api/vault/pages",
            json!({"items": [page.clone()]}),
        ),
        (
            "vault_tree",
            json!({"path": "notes"}),
            "GET",
            "/api/vault/folders/notes",
            json!({"path": "notes", "folders": [{"path": "PRIVATE"}], "pages": [page.clone()]}),
        ),
        (
            "vault_links",
            json!({"path": "notes/source.md", "direction": "backlinks"}),
            "GET",
            "/api/vault/index/backlinks/notes/source.md",
            json!([{"source_id": PAGE_ID, "source_path": "notes/alpha.md", "context": "PRIVATE CONTEXT"}]),
        ),
        (
            "vault_links",
            json!({"path": "notes/source.md", "direction": "outlinks"}),
            "GET",
            "/api/vault/index/outlinks/notes/source.md",
            json!([{"target_id": PAGE_ID, "target_path": "notes/alpha.md", "target_raw": "PRIVATE LINK"}]),
        ),
        (
            "vault_links",
            json!({"path": "notes/source.md", "direction": "similar"}),
            "GET",
            "/api/vault/index/similar/notes/source.md",
            json!({"items": [{"path": "notes/alpha.md", "title": "PRIVATE TITLE"}]}),
        ),
        (
            "vault_board",
            json!({}),
            "GET",
            "/api/vault/board",
            json!({"tasks": [page.clone()], "operations": [page.clone()], "cycles": [page.clone()], "columns": [{"id": "INTAKE"}]}),
        ),
        (
            "vault_base_query",
            json!({"slug": "example", "view": "All"}),
            "POST",
            "/api/vault/bases/example/views/All/evaluate",
            json!({"output": {"shape": "flat", "rows": [page.clone()], "aggregates": [{"path": "PRIVATE.md"}]}}),
        ),
        (
            "vault_base_query",
            json!({"slug": "example", "view": "All"}),
            "POST",
            "/api/vault/bases/example/views/All/evaluate",
            json!({"output": {"shape": "grouped", "groups": [{"key": {"path": "PRIVATE.md"}, "rows": [page.clone()]}]}}),
        ),
        (
            "vault_agenda",
            json!({"today": "2026-11-13"}),
            "GET",
            "/api/vault/agenda",
            json!({"overdue": [page.clone()], "today": [{"page_path": "notes/alpha.md", "content": "PRIVATE TODO"}],
                "upcoming": [{"items": [page.clone()]}], "undated": []}),
        ),
        (
            "vault_journal_capture",
            json!({"content": "PRIVATE JOURNAL"}),
            "POST",
            "/api/vault/journal/today/capture",
            json!({"path": "notes/alpha.md", "meta": {"id": PAGE_ID}, "body": "PRIVATE JOURNAL"}),
        ),
        (
            "vault_ai_journal_capture",
            json!({"content": "PRIVATE JOURNAL"}),
            "POST",
            "/api/vault/ai-journal/today/capture",
            json!({"path": "notes/alpha.md", "meta": {"id": PAGE_ID}, "body": "PRIVATE JOURNAL"}),
        ),
        (
            "vault_capture_conversation",
            json!({"title": "PRIVATE TITLE", "turns": [{"role": "user", "content": "PRIVATE PROMPT"}]}),
            "POST",
            "/api/vault/conversations/capture",
            json!({"page_id": PAGE_ID, "path": "notes/alpha.md"}),
        ),
        (
            "vault_archive_url",
            json!({"url": "https://private.example"}),
            "POST",
            "/api/vault/archive/url",
            json!({"page_id": PAGE_ID, "vault_path": "notes/alpha.md"}),
        ),
        (
            "vault_import_work",
            json!({"doi": "10.1234/private"}),
            "POST",
            "/api/vault/academic/import/doi",
            json!({"results": [{"page_path": "notes/alpha.md", "status": "created", "error": "PRIVATE ERROR"}]}),
        ),
        (
            "vault_archive_page",
            json!({"path": "notes/alpha.md"}),
            "DELETE",
            "/api/vault/pages/notes/alpha.md",
            json!({"page_id": PAGE_ID, "original_path": "notes/alpha.md", "item_id": "not-a-page"}),
        ),
        (
            "vault_list_rubbish",
            json!({}),
            "GET",
            "/api/vault/rubbish",
            json!([{"status": "valid", "item": {"page_id": PAGE_ID, "original_path": "notes/alpha.md"}}]),
        ),
        (
            "vault_get_rubbish_item",
            json!({"item_id": PAGE_ID}),
            "GET",
            "/api/vault/rubbish/0190f8a0-0000-7000-8000-0000000000a1",
            json!({"item": {"page_id": PAGE_ID, "original_path": "notes/alpha.md"}, "preview": {"body": "PRIVATE BODY"}}),
        ),
        (
            "vault_restore_page",
            json!({"item_id": PAGE_ID}),
            "POST",
            "/api/vault/rubbish/0190f8a0-0000-7000-8000-0000000000a1/restore",
            json!({"page_id": PAGE_ID, "path": "notes/alpha.md"}),
        ),
        (
            "vault_purge_page",
            json!({"item_id": PAGE_ID}),
            "DELETE",
            "/api/vault/rubbish/0190f8a0-0000-7000-8000-0000000000a1",
            json!({"page_id": PAGE_ID, "original_path": "notes/alpha.md"}),
        ),
        (
            "vault_empty_rubbish",
            json!({}),
            "DELETE",
            "/api/vault/rubbish",
            json!({"outcomes": [{"status": "purged", "item": {"page_id": PAGE_ID, "original_path": "notes/alpha.md"}}]}),
        ),
        (
            "vault_move_page",
            json!({"path": "notes/before.md", "destination": "notes/alpha.md"}),
            "POST",
            "/api/vault/pages-move/notes/before.md",
            page.clone(),
        ),
        (
            "vault_assign",
            json!({"paths": ["notes/before.md", "notes/alpha.md"], "kind": "NOTE"}),
            "POST",
            "/api/vault/pages-assign-bulk",
            json!({"moved": [["notes/before.md", "notes/alpha.md"]], "unchanged": ["notes/alpha.md"]}),
        ),
        (
            "vault_task_create",
            json!({"title": "PRIVATE TITLE"}),
            "POST",
            "/api/vault/board/tasks",
            page.clone(),
        ),
        (
            "vault_cycle_create",
            json!({"label": "PRIVATE TITLE", "start": "2026-11-01", "end": "2026-11-30"}),
            "POST",
            "/api/vault/board/cycles",
            page.clone(),
        ),
        (
            "vault_task_update",
            json!({"task": PAGE_ID, "title": "PRIVATE TITLE"}),
            "PATCH",
            "/api/vault/board/tasks/0190f8a0-0000-7000-8000-0000000000a1",
            page.clone(),
        ),
        (
            "vault_cycle_update",
            json!({"cycle": PAGE_ID, "goal": "PRIVATE GOAL"}),
            "PATCH",
            "/api/vault/board/cycles/0190f8a0-0000-7000-8000-0000000000a1",
            page,
        ),
    ];
    for (tool, arguments, verb, route, response) in cases {
        let http = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(TELEMETRY))
            .respond_with(ResponseTemplate::new(204))
            .mount(&http)
            .await;
        Mock::given(method(verb))
            .and(path(route))
            .respond_with(ResponseTemplate::new(200).set_body_json(response))
            .mount(&http)
            .await;
        let mut mcp = McpConnection::connect(&http).await;
        let result = mcp.call(tool, arguments).await;
        assert!(result.get("error").is_none(), "{tool}: {result}");
        assert_ne!(result["result"]["isError"], true, "{tool}: {result}");
        let events = telemetry(&http).await;
        let event = events
            .iter()
            .find(|event| event["call"].is_object())
            .unwrap();
        let returned: Vec<_> = event["call"]["pages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|page| page["source"] == "result")
            .collect();
        assert!(
            !returned.is_empty(),
            "{tool}: expected page metadata in {event}"
        );
        assert!(
            returned.iter().all(|page| page["path"] == "notes/alpha.md"),
            "{tool}: {event}"
        );
        if tool == "vault_move_page" {
            assert!(event["call"]["pages"].as_array().unwrap().iter().any(|page|
                page == &json!({"page_id": PAGE_ID, "path": "notes/before.md", "source": "target"})
            ), "a move must preserve identity across its old and new paths");
        }
        assert!(
            !serde_json::to_string(&events).unwrap().contains("PRIVATE"),
            "{tool}: {events:?}"
        );
    }
}

#[tokio::test]
async fn unavailable_or_slow_logging_preserves_success_and_failure_results() {
    for response in [
        ResponseTemplate::new(503).set_body_string("PRIVATE LOGGER ERROR"),
        ResponseTemplate::new(204).set_delay(Duration::from_secs(5)),
    ] {
        let http = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(TELEMETRY))
            .respond_with(response)
            .mount(&http)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/vault/index/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([{"tag": "example"}])))
            .mount(&http)
            .await;
        let mut mcp = McpConnection::connect(&http).await;
        let started = std::time::Instant::now();
        let result = mcp.call("vault_tags", json!({})).await;
        assert_ne!(result["result"]["isError"], true);
        assert!(
            result["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("example")
        );
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "telemetry must use its own bounded timeout"
        );
        let failure = mcp
            .call("vault_update_page", json!({"path": "notes/alpha.md"}))
            .await;
        assert_eq!(failure["result"]["isError"], true);
    }
}

#[tokio::test]
async fn large_results_keep_the_call_and_bound_only_page_attribution() {
    let http = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(TELEMETRY))
        .respond_with(ResponseTemplate::new(204))
        .mount(&http)
        .await;
    let items: Vec<_> = (0..1200)
        .map(|index| json!({"path": format!("notes/{index}.md")}))
        .collect();
    Mock::given(method("GET"))
        .and(path("/api/vault/pages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"items": items})))
        .mount(&http)
        .await;
    let mut mcp = McpConnection::connect(&http).await;
    let result = mcp.call("vault_list_pages", json!({"limit": 1200})).await;
    assert_ne!(result["result"]["isError"], true);
    let events = telemetry(&http).await;
    let event = events
        .iter()
        .find(|event| event["call"].is_object())
        .unwrap();
    assert_eq!(event["call"]["outcome"], "success");
    assert_eq!(event["call"]["pages"].as_array().unwrap().len(), 1000);
}

#[tokio::test]
async fn cancellation_records_once_without_exposing_reason_or_cancelling_the_http_operation() {
    let http = MockServer::start().await;
    let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel();
    Mock::given(method("POST"))
        .and(path(TELEMETRY))
        .respond_with(move |request: &wiremock::Request| {
            events_tx
                .send(serde_json::from_slice::<Value>(&request.body).unwrap())
                .unwrap();
            ResponseTemplate::new(204)
        })
        .mount(&http)
        .await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let signal = Arc::clone(&entered);
    Mock::given(method("POST"))
        .and(path("/api/vault/conversations/capture"))
        .respond_with(move |_: &wiremock::Request| {
            signal.notify_one();
            ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(300))
                .set_body_json(json!({"page_id": PAGE_ID, "path": "notes/alpha.md"}))
        })
        .expect(1)
        .mount(&http)
        .await;
    let mut mcp = McpConnection::connect(&http).await;
    let catalog = events_rx.recv().await.unwrap();
    assert!(catalog["call"].is_null());
    let id = mcp.next_id;
    mcp.next_id += 1;
    mcp.send(
        json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {
            "name": "vault_capture_conversation", "arguments": {
                "title": "PRIVATE", "turns": [{"role": "user", "content": "PRIVATE"}]
            }
        }}),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(3), entered.notified())
        .await
        .unwrap();
    mcp.send(
        json!({"jsonrpc": "2.0", "method": "notifications/cancelled",
        "params": {"requestId": id, "reason": "PRIVATE REASON"}}),
    )
    .await;
    let event = tokio::time::timeout(Duration::from_secs(3), events_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event["call"]["outcome"], "cancelled");
    assert_eq!(event["call"]["tool"], "vault_capture_conversation");
    assert!(!event.to_string().contains("PRIVATE"));
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        events_rx.try_recv().is_err(),
        "finishing a cancelled call must not emit a second outcome"
    );
}

#[tokio::test]
async fn failed_page_reads_keep_requested_targets_and_code_updates_keep_resolved_uuid() {
    let http = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(TELEMETRY))
        .respond_with(ResponseTemplate::new(204))
        .mount(&http)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/vault/pages/notes/missing.md"))
        .respond_with(
            ResponseTemplate::new(404).set_body_json(json!({"error": "PRIVATE missing page"})),
        )
        .mount(&http)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/vault/board"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "tasks": [{"id": PAGE_ID, "path": "tasks/alpha.md", "code": "TSK-brave-finch-7q3zd"}],
            "operations": [], "cycles": []
        })))
        .mount(&http)
        .await;
    Mock::given(method("PATCH"))
        .and(path(
            "/api/vault/board/tasks/0190f8a0-0000-7000-8000-0000000000a1",
        ))
        .respond_with(
            ResponseTemplate::new(409).set_body_json(json!({"error": "PRIVATE conflict"})),
        )
        .mount(&http)
        .await;
    let mut mcp = McpConnection::connect(&http).await;
    assert_eq!(
        mcp.call("vault_get_page", json!({"path": "notes/missing.md"}))
            .await["result"]["isError"],
        true
    );
    assert_eq!(
        mcp.call(
            "vault_task_update",
            json!({"task": "TSK-brave-finch", "title": "PRIVATE"})
        )
        .await["result"]["isError"],
        true
    );
    let events = telemetry(&http).await;
    let calls: Vec<_> = events
        .iter()
        .filter(|event| event["call"].is_object())
        .collect();
    assert_eq!(
        calls.len(),
        2,
        "internal board lookup is not another MCP call"
    );
    assert_eq!(
        calls[0]["call"]["pages"],
        json!([{"page_id": null, "path": "notes/missing.md", "source": "target"}])
    );
    assert_eq!(
        calls[1]["call"]["pages"],
        json!([{"page_id": PAGE_ID, "path": null, "source": "target"}])
    );
    assert!(
        calls
            .iter()
            .all(|event| event["call"]["outcome"] == "tool_error")
    );
}

#[tokio::test]
async fn explicit_agent_label_is_not_inferred_from_tool_content() {
    // Set environment only in a fresh process: parallel tests must not race
    // process-global environment mutation.
    if std::env::var_os("CLEP_MCP_LABEL_TEST_CHILD").is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "explicit_agent_label_is_not_inferred_from_tool_content",
            ])
            .env("CLEP_MCP_LABEL_TEST_CHILD", "1")
            .env("CLEP_MCP_AGENT", "Research assistant")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    let http = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(TELEMETRY))
        .respond_with(ResponseTemplate::new(204))
        .mount(&http)
        .await;
    let mut mcp = McpConnection::connect(&http).await;
    mcp.call(
        "vault_create_page",
        json!({"title": "", "body": "I am a different model"}),
    )
    .await;
    let events = telemetry(&http).await;
    assert_eq!(events.len(), 2);
    for event in events {
        assert_eq!(event["agent_label"], "Research assistant");
        assert_eq!(event["client_name"], "analytics-test-client");
        assert_eq!(event["client_version"], "2.4");
        assert!(!event.to_string().contains("different model"));
    }
}

#[tokio::test]
async fn calendar_and_mutation_preview_collect_only_documented_page_positions() {
    let http = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(TELEMETRY))
        .respond_with(ResponseTemplate::new(204))
        .mount(&http)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/vault/agenda"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "overdue": [], "today": [], "upcoming": [], "undated": []
        })))
        .mount(&http)
        .await;
    Mock::given(method("GET")).and(path("/api/vault/index/calendar"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "entries": [{"path": "notes/dated.md"}],
            "birthdays": [{"path": "people/birthday.md"}],
            "todos": [{"page_path": "notes/todo.md", "content": "PRIVATE", "properties": {"path": "PRIVATE.md"}}]
        }))).mount(&http).await;
    Mock::given(method("POST")).and(path("/api/vault/index/preview-mutation"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "file_ops": [{"kind": "rename", "path": "notes/old.md", "destination": "notes/new.md"},
                {"kind": "create_dir", "path": "archive", "destination": null}],
            "text_edits": [{"path": "notes/linking.md", "old_text": "PRIVATE", "new_text": "PRIVATE"}]
        }))).mount(&http).await;
    let mut mcp = McpConnection::connect(&http).await;
    let agenda = mcp
        .call(
            "vault_agenda",
            json!({"today": "2026-11-13", "from": "2026-11-01", "to": "2026-11-30"}),
        )
        .await;
    assert_ne!(agenda["result"]["isError"], true);
    let preview = mcp.call("vault_preview_mutation", json!({"operation": "move_page", "source": "notes/old.md", "destination": "notes/new.md"})).await;
    assert_ne!(preview["result"]["isError"], true);
    let events = telemetry(&http).await;
    let calls: Vec<_> = events
        .iter()
        .filter(|event| event["call"].is_object())
        .collect();
    assert_eq!(calls[0]["call"]["pages"].as_array().unwrap().len(), 3);
    let paths: Vec<_> = calls[1]["call"]["pages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|page| page["source"] == "result")
        .map(|page| page["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["notes/old.md", "notes/new.md", "notes/linking.md"]);
    assert!(!serde_json::to_string(&events).unwrap().contains("PRIVATE"));
}

#[tokio::test]
async fn non_page_tool_families_do_not_misinterpret_names_or_numeric_ids_as_pages() {
    for (tool, route, response) in [
        (
            "vault_tags",
            "/api/vault/index/tags",
            json!([{"tag": "notes/alpha.md", "count": 2}]),
        ),
        (
            "vault_bases",
            "/api/vault/bases",
            json!({"bases": [{"path": "views/example.base", "name": "notes/alpha.md"}]}),
        ),
        (
            "vault_tree",
            "/api/vault/folders/tree",
            json!({"paths": ["notes", "projects"]}),
        ),
        (
            "vault_feed_entries",
            "/api/vault/feeds/entries",
            json!({"entries": [{"id": 42, "content_html": "notes/alpha.md"}]}),
        ),
    ] {
        let http = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(TELEMETRY))
            .respond_with(ResponseTemplate::new(204))
            .mount(&http)
            .await;
        Mock::given(method("GET"))
            .and(path(route))
            .respond_with(ResponseTemplate::new(200).set_body_json(response))
            .mount(&http)
            .await;
        let mut mcp = McpConnection::connect(&http).await;
        let result = mcp.call(tool, json!({})).await;
        assert_ne!(result["result"]["isError"], true, "{result}");
        let events = telemetry(&http).await;
        let event = events
            .iter()
            .find(|event| event["call"].is_object())
            .unwrap();
        assert_eq!(event["call"]["pages"], json!([]), "{tool}");
    }
}

#[tokio::test]
async fn inline_discovery_registers_catalog_and_missing_client_identity_stays_unknown() {
    for identity in [Some(json!({"name": "inline-client", "version": "3"})), None] {
        let http = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(TELEMETRY))
            .respond_with(ResponseTemplate::new(204))
            .mount(&http)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/vault/index/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(&http)
            .await;
        let server = VaultMcpServer::new(Arc::new(ApiClient::new(http.uri(), None).unwrap()));
        let (client_io, server_io) = tokio::io::duplex(1024 * 1024);
        let serving = tokio::spawn(async move {
            server
                .serve(server_io)
                .await
                .unwrap()
                .waiting()
                .await
                .unwrap();
        });
        let (reader, writer) = tokio::io::split(client_io);
        let mut mcp = McpConnection {
            reader: BufReader::new(reader),
            writer,
            serving,
            next_id: 1,
        };
        let mut metadata = json!({
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {}
        });
        if let Some(identity) = &identity {
            metadata["io.modelcontextprotocol/clientInfo"] = identity.clone();
        }
        let discovery = mcp
            .request("server/discover", json!({"_meta": metadata.clone()}))
            .await;
        assert!(discovery.get("error").is_none(), "{discovery}");
        let result = mcp
            .request(
                "tools/call",
                json!({
                    "_meta": metadata, "name": "vault_tags", "arguments": {}
                }),
            )
            .await;
        assert!(result.get("error").is_none(), "{result}");
        let events = telemetry(&http).await;
        assert_eq!(events.len(), 2);
        assert!(!events[0]["tools"].as_array().unwrap().is_empty());
        for event in events {
            assert_eq!(
                event["client_name"],
                if identity.is_some() {
                    "inline-client"
                } else {
                    "Unknown client"
                }
            );
            assert_eq!(
                event["client_version"],
                if identity.is_some() { "3" } else { "" }
            );
        }
    }
}
