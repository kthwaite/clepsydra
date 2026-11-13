//! Metadata-only observation at the MCP tool-dispatch boundary.
//!
//! Deliberately never serialize arguments, tool output, or error messages. The
//! SDK rejects malformed transport envelopes before this boundary. A killed
//! process cannot flush telemetry; normal future cancellation gets a best-effort
//! bounded send from the drop guard.

use std::cell::RefCell;
use std::sync::Arc;
use std::time::{Duration, Instant};

use clep_api::api::mcp_analytics::{
    McpCallRecord, McpPageReference, McpTelemetryRequest, McpToolDefinition,
};
use clep_client::client::ApiClient;
use rmcp::model::{CallToolRequestParams, CallToolResponse, Implementation, Tool};
use serde::Deserialize;
use uuid::Uuid;

const TELEMETRY_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_PAGES: usize = 1000;
// Keep even heavily escaped, long valid paths below the HTTP body limit.
const MAX_PAGE_BYTES: usize = 512 * 1024;

tokio::task_local! {
    static RESOLVED_TARGET: RefCell<Option<String>>;
}

/// Record the primary code-addressed target, not incidental internal lookups.
pub(crate) fn resolved_target(id: &str) {
    let _ = RESOLVED_TARGET.try_with(|target| *target.borrow_mut() = Some(id.to_string()));
}

pub(crate) struct Telemetry {
    client: Arc<ApiClient>,
    session_id: String,
    agent_label: Option<String>,
}

impl Telemetry {
    pub(crate) fn new(client: Arc<ApiClient>) -> Self {
        Self {
            client,
            session_id: Uuid::now_v7().to_string(),
            agent_label: std::env::var("CLEP_MCP_AGENT")
                .ok()
                .map(|label| bounded_label(&label, 256))
                .filter(|label| !label.trim().is_empty()),
        }
    }

    fn envelope(&self, identity: Option<&Implementation>) -> McpTelemetryRequest {
        McpTelemetryRequest {
            session_id: self.session_id.clone(),
            client_name: identity
                .map(|info| bounded_label(&info.name, 256))
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| "Unknown client".to_string()),
            client_version: identity
                .map(|info| bounded_label(&info.version, 256))
                .unwrap_or_default(),
            agent_label: self.agent_label.clone(),
            tools: Vec::new(),
            call: None,
        }
    }

    pub(crate) async fn register(&self, identity: Option<&Implementation>, tools: Vec<Tool>) {
        let mut event = self.envelope(identity);
        event.tools = tools
            .into_iter()
            .map(|tool| McpToolDefinition {
                name: tool.name.into_owned(),
                read_only: tool
                    .annotations
                    .and_then(|annotations| annotations.read_only_hint)
                    .unwrap_or(false),
            })
            .collect();
        send(&self.client, event).await;
    }

    pub(crate) fn start(
        self: &Arc<Self>,
        request: &CallToolRequestParams,
        identity: Option<&Implementation>,
    ) -> CallObservation {
        let mut event = self.envelope(identity);
        let mut pages = PageReferences::default();
        if let Some(arguments) = &request.arguments {
            match request.name.as_ref() {
                "vault_get_page" | "vault_get_properties" | "vault_patch_properties" => {
                    pages.push(
                        arguments.get("id").and_then(serde_json::Value::as_str),
                        arguments.get("path").and_then(serde_json::Value::as_str),
                        "target",
                    );
                }
                "vault_update_page" | "vault_edit_page" | "vault_append_page"
                | "vault_archive_page" | "vault_links" | "vault_move_page" => {
                    pages.push(
                        None,
                        arguments.get("path").and_then(serde_json::Value::as_str),
                        "target",
                    );
                }
                "vault_assign" => {
                    if let Some(paths) =
                        arguments.get("paths").and_then(serde_json::Value::as_array)
                    {
                        for path in paths {
                            pages.push(None, path.as_str(), "target");
                        }
                    }
                }
                "vault_task_update" | "vault_cycle_update" => {
                    let key = if request.name == "vault_task_update" {
                        "task"
                    } else {
                        "cycle"
                    };
                    if let Some(reference) = arguments.get(key).and_then(serde_json::Value::as_str)
                    {
                        match crate::tasking::classify_ref(reference) {
                            crate::tasking::TaskRef::Id(id) => {
                                pages.push(Some(&id.to_string()), None, "target")
                            }
                            crate::tasking::TaskRef::Path(path) => {
                                pages.push(None, Some(&path), "target")
                            }
                            crate::tasking::TaskRef::Code(_) => {}
                        }
                    }
                }
                "vault_preview_mutation"
                    if arguments
                        .get("operation")
                        .and_then(serde_json::Value::as_str)
                        == Some("move_page") =>
                {
                    pages.push(
                        None,
                        arguments.get("source").and_then(serde_json::Value::as_str),
                        "target",
                    );
                }
                _ => {}
            }
        }
        event.call = Some(McpCallRecord {
            call_id: Uuid::now_v7().to_string(),
            tool: {
                let name = bounded_label(&request.name, 128);
                if name.trim().is_empty() {
                    "(empty tool name)".to_string()
                } else {
                    name
                }
            },
            started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            duration_ms: 0,
            outcome: "cancelled".to_string(),
            error_code: None,
            pages: pages.finish(),
        });
        CallObservation {
            telemetry: Arc::clone(self),
            event: Some(event),
            started: Instant::now(),
        }
    }
}

/// Remains armed until the tool finishes. Logging runs in its own task so a
/// cancellation during the bounded HTTP send cannot erase a completed outcome.
pub(crate) struct CallObservation {
    telemetry: Arc<Telemetry>,
    event: Option<McpTelemetryRequest>,
    started: Instant,
}

impl CallObservation {
    pub(crate) async fn observe(
        &mut self,
        cancelled: impl Future<Output = ()>,
        future: impl Future<Output = Result<CallToolResponse, rmcp::ErrorData>>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        RESOLVED_TARGET
            .scope(RefCell::new(None), async {
                tokio::pin!(future);
                let result = tokio::select! {
                    biased;
                    result = &mut future => result,
                    () = cancelled => {
                        self.capture_resolved_target();
                        self.record_cancelled();
                        // Preserve existing execution semantics: caller cancellation
                        // does not roll back or interrupt an in-flight HTTP mutation.
                        future.await
                    }
                };
                self.capture_resolved_target();
                result
            })
            .await
    }

    fn capture_resolved_target(&mut self) {
        if let Some(id) = RESOLVED_TARGET.with(|target| target.borrow_mut().take())
            && let Some(call) = self.event.as_mut().and_then(|event| event.call.as_mut())
        {
            let mut pages = PageReferences::from_pages(std::mem::take(&mut call.pages));
            pages.primary_target_id(&id);
            call.pages = pages.finish();
        }
    }

    fn record_cancelled(&mut self) {
        if let Some(mut event) = self.event.take() {
            if let Some(call) = &mut event.call {
                call.duration_ms = self.started.elapsed().as_millis().min(i64::MAX as u128) as u64;
            }
            let telemetry = Arc::clone(&self.telemetry);
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move { send(&telemetry.client, event).await });
            } else {
                eprintln!("clep mcp: telemetry unavailable during shutdown");
            }
        }
    }

    pub(crate) async fn finish(mut self, outcome: &Result<CallToolResponse, rmcp::ErrorData>) {
        let Some(mut event) = self.event.take() else {
            return; // The caller already cancelled and its outcome was recorded.
        };
        let call = event.call.as_mut().expect("call observation");
        call.duration_ms = self.started.elapsed().as_millis().min(i64::MAX as u128) as u64;
        match outcome {
            Ok(CallToolResponse::Complete(result)) => {
                call.outcome = if result.is_error == Some(true) {
                    "tool_error"
                } else {
                    "success"
                }
                .to_string();
                if result.is_error != Some(true) {
                    let mut pages = PageReferences::from_pages(std::mem::take(&mut call.pages));
                    for content in &result.content {
                        if let Some(text) = content.as_text() {
                            collect_result(&call.tool, &text.text, &mut pages);
                        }
                    }
                    call.pages = pages.finish();
                }
            }
            Ok(_) => call.outcome = "success".to_string(),
            Err(error) => {
                call.outcome = "protocol_error".to_string();
                call.error_code = Some(error.code.0);
            }
        }
        let telemetry = Arc::clone(&self.telemetry);
        if tokio::spawn(async move { send(&telemetry.client, event).await })
            .await
            .is_err()
        {
            eprintln!("clep mcp: telemetry task unavailable; tool outcome unchanged");
        }
    }
}

impl Drop for CallObservation {
    fn drop(&mut self) {
        self.record_cancelled();
    }
}

async fn send(client: &ApiClient, event: McpTelemetryRequest) {
    let Ok(body) = serde_json::to_value(event) else {
        eprintln!("clep mcp: telemetry serialization failed; tool outcome unchanged");
        return;
    };
    if client
        .post_json_timeout("/api/vault/mcp/telemetry", &body, TELEMETRY_TIMEOUT)
        .await
        .is_err()
    {
        // Do not echo remote error bodies: they may include private data.
        eprintln!("clep mcp: telemetry unavailable or rejected; tool outcome unchanged");
    }
}

fn bounded_label(value: &str, limit: usize) -> String {
    let mut result = String::with_capacity(value.len().min(limit));
    for ch in value.chars().filter(|ch| !ch.is_control()) {
        if result.len() + ch.len_utf8() > limit {
            break;
        }
        result.push(ch);
    }
    if result != value {
        eprintln!("clep mcp: telemetry label sanitized or truncated");
    }
    result
}

#[derive(Default)]
struct PageReferences {
    pages: Vec<McpPageReference>,
    bytes: usize,
    omitted: bool,
}

impl PageReferences {
    fn from_pages(pages: Vec<McpPageReference>) -> Self {
        let bytes = pages
            .iter()
            .map(|page| page.path.as_ref().map_or(0, String::len) + 128)
            .sum();
        Self {
            pages,
            bytes,
            omitted: false,
        }
    }

    fn primary_target_id(&mut self, id: &str) {
        let mut targets = self.pages.iter_mut().filter(|page| page.source == "target");
        match (targets.next(), targets.next()) {
            (Some(page), None) if page.page_id.is_none() => {
                page.page_id = Uuid::parse_str(id).ok().map(|id| id.to_string());
            }
            (None, _) => self.push(Some(id), None, "target"),
            _ => {}
        }
    }

    fn push(&mut self, id: Option<&str>, path: Option<&str>, source: &str) {
        let page_id = id
            .and_then(|id| Uuid::parse_str(id).ok())
            .map(|id| id.to_string());
        let path = path.filter(|path| {
            !path.is_empty()
                && path.len() <= 4096
                && !path.chars().any(char::is_control)
                && !path.starts_with('/')
                && !path.contains('\\')
                && !path.split('/').any(|part| part == "..")
                && path.split('/').any(|part| part != "." && !part.is_empty())
        });
        if page_id.is_none() && path.is_none() {
            return;
        }
        if let Some(page) = self.pages.iter_mut().find(|page| {
            page.source == source
                && ((page_id.is_some() && page.page_id == page_id)
                    || (path.is_some() && page.path.as_deref() == path))
        }) {
            if page.page_id.is_none() {
                page.page_id = page_id;
            }
            if page.path.is_none() {
                let additional = path.map_or(0, str::len);
                if self.bytes + additional <= MAX_PAGE_BYTES {
                    page.path = path.map(str::to_owned);
                    self.bytes += additional;
                } else {
                    self.omitted = true;
                }
            }
            return;
        }
        let bytes = path.map_or(0, str::len) + 128;
        if self.pages.len() == MAX_PAGES || self.bytes + bytes > MAX_PAGE_BYTES {
            self.omitted = true;
            return;
        }
        self.bytes += bytes;
        self.pages.push(McpPageReference {
            page_id,
            path: path.map(str::to_owned),
            source: source.to_string(),
        });
    }

    fn finish(self) -> Vec<McpPageReference> {
        if self.omitted {
            eprintln!(
                "clep mcp: telemetry page references capped at {MAX_PAGES} or {MAX_PAGE_BYTES} bytes; call still recorded"
            );
        }
        self.pages
    }
}

/// A projection of page response metadata, never arbitrary frontmatter values.
#[derive(Default, Deserialize)]
struct PageMetadata {
    #[serde(alias = "page_id", alias = "source_id", alias = "target_id")]
    id: Option<String>,
    #[serde(
        alias = "page_path",
        alias = "original_path",
        alias = "vault_path",
        alias = "source_path",
        alias = "target_path"
    )]
    path: Option<String>,
    meta: Option<PageId>,
}

#[derive(Deserialize)]
struct PageId {
    id: Option<String>,
}

impl PageMetadata {
    fn collect(&self, pages: &mut PageReferences) {
        pages.push(
            self.id
                .as_deref()
                .or_else(|| self.meta.as_ref().and_then(|meta| meta.id.as_deref())),
            self.path.as_deref(),
            "result",
        );
    }
}

#[derive(Default, Deserialize)]
struct PageCollection {
    #[serde(default, alias = "pages", alias = "results", alias = "rows")]
    items: Vec<PageMetadata>,
}

impl PageCollection {
    fn collect(&self, pages: &mut PageReferences) {
        for page in &self.items {
            page.collect(pages);
        }
    }
}

#[derive(Deserialize)]
struct BoardMetadata {
    tasks: Vec<PageMetadata>,
    operations: Vec<PageMetadata>,
    cycles: Vec<PageMetadata>,
}

#[derive(Deserialize)]
struct BaseMetadata {
    output: BaseOutput,
}

#[derive(Deserialize)]
#[serde(tag = "shape", rename_all = "snake_case")]
enum BaseOutput {
    Flat { rows: Vec<PageMetadata> },
    Grouped { groups: Vec<BaseGroup> },
}

#[derive(Deserialize)]
struct BaseGroup {
    rows: Vec<PageMetadata>,
    key_path: Option<String>,
}

#[derive(Deserialize)]
struct AgendaMetadata {
    agenda: AgendaLists,
    calendar: Option<CalendarMetadata>,
}

#[derive(Deserialize)]
struct AgendaLists {
    overdue: Vec<PageMetadata>,
    today: Vec<PageMetadata>,
    upcoming: Vec<PageCollection>,
    undated: Vec<PageMetadata>,
}

#[derive(Deserialize)]
struct CalendarMetadata {
    entries: Vec<PageMetadata>,
    birthdays: Vec<PageMetadata>,
    todos: Vec<PageMetadata>,
}

#[derive(Deserialize)]
struct RubbishMetadata {
    item: Option<PageMetadata>,
}

#[derive(Deserialize)]
struct EmptyRubbishMetadata {
    outcomes: Vec<RubbishMetadata>,
}

#[derive(Deserialize)]
struct AssignMetadata {
    moved: Vec<(String, String)>,
    unchanged: Vec<String>,
}

#[derive(Deserialize)]
struct PreviewMetadata {
    file_ops: Vec<FileOperation>,
    text_edits: Vec<PageMetadata>,
}

#[derive(Deserialize)]
struct FileOperation {
    path: String,
    destination: Option<String>,
}

fn collect_result(tool: &str, text: &str, pages: &mut PageReferences) {
    // Only documented response containers are deserialized. Serde skips
    // bodies/properties/snippets without allocating a second JSON tree.
    let parsed = match tool {
        "vault_get_page"
        | "vault_create_page"
        | "vault_update_page"
        | "vault_get_properties"
        | "vault_patch_properties"
        | "vault_move_page"
        | "vault_edit_page"
        | "vault_append_page"
        | "vault_journal_capture"
        | "vault_ai_journal_capture"
        | "vault_capture_conversation"
        | "vault_archive_url"
        | "vault_archive_page"
        | "vault_restore_page"
        | "vault_purge_page"
        | "vault_task_create"
        | "vault_task_update"
        | "vault_cycle_create"
        | "vault_cycle_update" => serde_json::from_str::<PageMetadata>(text).map(|page| {
            if matches!(
                tool,
                "vault_get_page"
                    | "vault_update_page"
                    | "vault_get_properties"
                    | "vault_patch_properties"
                    | "vault_move_page"
                    | "vault_archive_page"
                    | "vault_task_update"
                    | "vault_cycle_update"
                    | "vault_restore_page"
                    | "vault_purge_page"
            ) && let Some(id) = page
                .id
                .as_deref()
                .or_else(|| page.meta.as_ref().and_then(|meta| meta.id.as_deref()))
            {
                pages.primary_target_id(id);
            }
            page.collect(pages);
        }),
        "vault_search" => serde_json::from_str::<Vec<PageMetadata>>(text).map(|results| {
            for page in results {
                page.collect(pages);
            }
        }),
        "vault_list_pages" | "vault_import_work" | "vault_tree" => {
            // The root tree lists folders only; a folder listing has pages.
            serde_json::from_str::<PageCollection>(text).map(|list| list.collect(pages))
        }
        "vault_links" => {
            if text.trim_start().starts_with('[') {
                serde_json::from_str::<Vec<PageMetadata>>(text).map(|results| {
                    for page in results {
                        page.collect(pages);
                    }
                })
            } else {
                serde_json::from_str::<PageCollection>(text).map(|list| list.collect(pages))
            }
        }
        "vault_board" => serde_json::from_str::<BoardMetadata>(text).map(|board| {
            for page in board
                .tasks
                .iter()
                .chain(&board.operations)
                .chain(&board.cycles)
            {
                page.collect(pages);
            }
        }),
        "vault_base_query" => {
            serde_json::from_str::<BaseMetadata>(text).map(|base| match base.output {
                BaseOutput::Flat { rows } => {
                    for page in rows {
                        page.collect(pages);
                    }
                }
                BaseOutput::Grouped { groups } => {
                    for group in groups {
                        pages.push(None, group.key_path.as_deref(), "result");
                        for page in group.rows {
                            page.collect(pages);
                        }
                    }
                }
            })
        }
        "vault_agenda" => serde_json::from_str::<AgendaMetadata>(text).map(|result| {
            for page in result
                .agenda
                .overdue
                .iter()
                .chain(&result.agenda.today)
                .chain(&result.agenda.undated)
            {
                page.collect(pages);
            }
            for day in result.agenda.upcoming {
                day.collect(pages);
            }
            if let Some(calendar) = result.calendar {
                for page in calendar
                    .entries
                    .iter()
                    .chain(&calendar.birthdays)
                    .chain(&calendar.todos)
                {
                    page.collect(pages);
                }
            }
        }),
        "vault_list_rubbish" => serde_json::from_str::<Vec<RubbishMetadata>>(text).map(|items| {
            for entry in items {
                if let Some(page) = entry.item {
                    page.collect(pages);
                }
            }
        }),
        "vault_get_rubbish_item" => serde_json::from_str::<RubbishMetadata>(text).map(|entry| {
            if let Some(page) = entry.item {
                if let Some(id) = page.id.as_deref() {
                    pages.primary_target_id(id);
                }
                page.collect(pages);
            }
        }),
        "vault_empty_rubbish" => serde_json::from_str::<EmptyRubbishMetadata>(text).map(|result| {
            for entry in result.outcomes {
                if let Some(page) = entry.item {
                    page.collect(pages);
                }
            }
        }),
        "vault_assign" => {
            if let Ok(bulk) = serde_json::from_str::<AssignMetadata>(text) {
                for (_, destination) in bulk.moved {
                    pages.push(None, Some(&destination), "result");
                }
                for path in bulk.unchanged {
                    pages.push(None, Some(&path), "result");
                }
                Ok(())
            } else {
                serde_json::from_str::<PageMetadata>(text).map(|page| {
                    if let Some(id) = page
                        .id
                        .as_deref()
                        .or_else(|| page.meta.as_ref().and_then(|meta| meta.id.as_deref()))
                    {
                        pages.primary_target_id(id);
                    }
                    page.collect(pages);
                })
            }
        }
        "vault_preview_mutation" => serde_json::from_str::<PreviewMetadata>(text).map(|preview| {
            for operation in preview.file_ops {
                for path in std::iter::once(&operation.path).chain(operation.destination.as_ref()) {
                    if path.ends_with(".md") {
                        pages.push(None, Some(path), "result");
                    }
                }
            }
            for page in preview.text_edits {
                page.collect(pages);
            }
        }),
        // Folder/base definitions, tags and feed entries are not vault pages.
        // In particular numeric feed IDs must never become page UUIDs.
        "vault_folder"
        | "vault_bases"
        | "vault_tags"
        | "vault_feed_entries"
        | "vault_feed_mark_read" => Ok(()),
        _ => {
            eprintln!("clep mcp: tool has no telemetry page projection; call still recorded");
            Ok(())
        }
    };
    if parsed.is_err() {
        eprintln!("clep mcp: returned page metadata could not be projected; call still recorded");
    }
}
