//! Metadata-only MCP usage. Query work stays in SQLite on the index thread;
//! neither endpoint reads page bodies or materializes all historical calls.

use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Datelike, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::AppState;
use super::error::{ApiError, parse_request_path};

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct McpTelemetryRequest {
    pub session_id: String,
    #[serde(default)]
    pub client_name: String,
    #[serde(default)]
    pub client_version: String,
    pub agent_label: Option<String>,
    #[serde(default)]
    pub tools: Vec<McpToolDefinition>,
    pub call: Option<McpCallRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct McpToolDefinition {
    pub name: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct McpCallRecord {
    pub call_id: String,
    pub tool: String,
    pub started_at: String,
    pub duration_ms: u64,
    pub outcome: String,
    pub error_code: Option<i32>,
    pub pages: Vec<McpPageReference>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct McpPageReference {
    pub page_id: Option<String>,
    pub path: Option<String>,
    pub source: String,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct McpStatsResponse {
    pub days: u32,
    /// UTC date of the inclusive upper bound of this report.
    pub through_date: String,
    pub tracking_since: Option<String>,
    pub total_calls: u64,
    pub successful_calls: u64,
    pub failed_calls: u64,
    pub sessions: u64,
    pub agents: u64,
    pub pages: u64,
    pub average_duration_ms: f64,
    pub tools: Vec<McpToolStats>,
    pub clients: Vec<McpClientStats>,
    pub page_activity: Vec<McpPageStats>,
    pub daily: Vec<McpDailyStats>,
    pub daily_agents: Vec<McpDailyAgentStats>,
    pub recent_calls: Vec<McpRecentCall>,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct McpToolStats {
    pub name: String,
    pub read_only: bool,
    pub calls: u64,
    pub failures: u64,
    pub average_duration_ms: f64,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct McpClientStats {
    pub name: String,
    pub client_name: String,
    pub client_version: String,
    pub calls: u64,
    pub failures: u64,
    pub sessions: u64,
    pub average_duration_ms: f64,
    pub last_used_at: String,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct McpPageStats {
    pub page_id: Option<String>,
    pub path: Option<String>,
    /// Current indexed title (or path for an untitled page); null only if unresolved.
    pub title: Option<String>,
    pub calls: u64,
    pub target_calls: u64,
    pub result_calls: u64,
    pub last_used_at: String,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct McpDailyStats {
    pub date: String,
    pub calls: u64,
    pub failures: u64,
    pub average_duration_ms: f64,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct McpDailyAgentStats {
    pub date: String,
    pub name: String,
    pub calls: u64,
    pub average_duration_ms: f64,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct McpRecentCall {
    pub call_id: String,
    pub tool: String,
    pub client_name: String,
    pub agent_label: Option<String>,
    pub started_at: String,
    pub duration_ms: u64,
    pub outcome: String,
    pub error_code: Option<i32>,
    pub pages: Vec<McpPageReference>,
}

#[derive(Debug, Deserialize)]
pub struct McpStatsQuery {
    #[serde(default = "default_days")]
    pub days: u32,
}

fn default_days() -> u32 {
    30
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/telemetry", post(record_telemetry))
        .route("/stats", get(get_stats))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
}

fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Nanos, true)
}

fn bounded(value: &str, field: &str, max: usize, allow_empty: bool) -> Result<(), ApiError> {
    if value.len() > max
        || (!allow_empty && value.trim().is_empty())
        || value.chars().any(char::is_control)
    {
        return Err(ApiError::bad_request(format!(
            "Invalid {field}: expected {}..={max} bytes without control characters",
            usize::from(!allow_empty)
        )));
    }
    Ok(())
}

fn canonical_uuid(value: &mut String, field: &str) -> Result<(), ApiError> {
    *value = Uuid::parse_str(value)
        .map_err(|_| ApiError::bad_request(format!("Invalid {field}: expected UUID")))?
        .to_string();
    Ok(())
}

fn validate(request: &mut McpTelemetryRequest) -> Result<(), ApiError> {
    canonical_uuid(&mut request.session_id, "session_id")?;
    bounded(&request.client_name, "client_name", 256, true)?;
    bounded(&request.client_version, "client_version", 256, true)?;
    if request.client_name.trim().is_empty() {
        request.client_name = "Unknown client".into();
    }
    if let Some(label) = &request.agent_label {
        bounded(label, "agent_label", 256, true)?;
        if label.trim().is_empty() {
            request.agent_label = None;
        }
    }
    if request.tools.len() > 512 {
        return Err(ApiError::bad_request(
            "At most 512 tool definitions are allowed",
        ));
    }
    for tool in &request.tools {
        bounded(&tool.name, "tool name", 128, false)?;
    }
    if let Some(call) = &mut request.call {
        canonical_uuid(&mut call.call_id, "call_id")?;
        bounded(&call.tool, "tool", 128, false)?;
        let started = DateTime::parse_from_rfc3339(&call.started_at)
            .map_err(|_| ApiError::bad_request("started_at must be RFC3339 UTC"))?;
        if started.offset().local_minus_utc() != 0 || !(1..=9999).contains(&started.year()) {
            return Err(ApiError::bad_request(
                "started_at must be RFC3339 UTC in years 0001..9999",
            ));
        }
        call.started_at = timestamp(started.with_timezone(&Utc));
        if call.duration_ms > i64::MAX as u64 {
            return Err(ApiError::bad_request(
                "duration_ms exceeds SQLite integer range",
            ));
        }
        if !matches!(
            call.outcome.as_str(),
            "success" | "tool_error" | "protocol_error" | "cancelled"
        ) {
            return Err(ApiError::bad_request("Invalid outcome"));
        }
        if call.error_code.is_some() && call.outcome != "protocol_error" {
            return Err(ApiError::bad_request(
                "error_code is only allowed for protocol_error",
            ));
        }
        if call.pages.len() > 1000 {
            return Err(ApiError::bad_request(
                "At most 1000 page references are allowed",
            ));
        }
        for page in &mut call.pages {
            if !matches!(page.source.as_str(), "target" | "result") {
                return Err(ApiError::bad_request("Invalid page reference source"));
            }
            if page.page_id.is_none() && page.path.is_none() {
                return Err(ApiError::bad_request(
                    "Page reference requires page_id or path",
                ));
            }
            if let Some(id) = &mut page.page_id {
                canonical_uuid(id, "page_id")?;
            }
            if let Some(path) = &mut page.path {
                bounded(path, "page path", 4096, false)?;
                *path = parse_request_path(path, "Invalid page path")?
                    .as_str()
                    .to_owned();
            }
        }
    }
    Ok(())
}

/// Record a bounded metadata envelope atomically. Repeated call IDs are ignored.
/// No arguments, bodies, results, search text or error messages are accepted.
#[utoipa::path(
    post, path = "/api/vault/mcp/telemetry", tag = "MCP",
    request_body = McpTelemetryRequest,
    responses((status = 204, description = "Metadata recorded (duplicate calls are idempotent)"),
              (status = 400, description = "Invalid metadata", body = ApiError),
              (status = 413, description = "Metadata exceeds 2 MiB"),
              (status = 422, description = "Invalid JSON shape"))
)]
pub async fn record_telemetry(
    State(state): State<Arc<AppState>>,
    Json(mut request): Json<McpTelemetryRequest>,
) -> Result<StatusCode, ApiError> {
    validate(&mut request)?;
    let received_at = timestamp(state.clock.now());
    state
        .index
        .with_index(move |index, _| ingest(index.connection(), &request, &received_at))
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

fn ingest(
    conn: &Connection,
    request: &McpTelemetryRequest,
    received_at: &str,
) -> rusqlite::Result<()> {
    // IndexHandle serializes access; no transaction can interleave this closure.
    let tx = conn.unchecked_transaction()?;
    // A duplicate must not rewrite identity/catalog metadata either.
    if let Some(call) = &request.call
        && tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM mcp_calls WHERE call_id = ?1)",
            [&call.call_id],
            |row| row.get::<_, bool>(0),
        )?
    {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO mcp_sessions(session_id, client_name, client_version, agent_label, first_seen)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(session_id) DO UPDATE SET client_name=excluded.client_name,
             client_version=excluded.client_version, agent_label=excluded.agent_label",
        params![
            request.session_id,
            request.client_name,
            request.client_version,
            request.agent_label,
            received_at
        ],
    )?;
    if !request.tools.is_empty() {
        let mut upsert = tx.prepare(
            "INSERT INTO mcp_tools(name, read_only) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET read_only=excluded.read_only",
        )?;
        for tool in &request.tools {
            upsert.execute(params![tool.name, tool.read_only])?;
        }
    }
    if let Some(call) = &request.call {
        tx.execute(
            "INSERT INTO mcp_calls(call_id, session_id, tool, client_name, client_version, agent_label,
                                   started_at, duration_ms, outcome, error_code)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![call.call_id, request.session_id, call.tool, request.client_name,
                    request.client_version, request.agent_label, call.started_at,
                    call.duration_ms, call.outcome, call.error_code],
        )?;
        if !call.pages.is_empty() {
            let mut by_id = tx.prepare("SELECT id, path FROM pages WHERE id = ?1")?;
            let mut by_path = tx.prepare("SELECT id, path FROM pages WHERE path = ?1")?;
            let mut insert = tx.prepare(
                "INSERT OR IGNORE INTO mcp_call_pages(call_id, identity, page_id, path, source)
                 VALUES (?1, COALESCE('id:' || ?2, 'path:' || ?3), ?2, ?3, ?4)",
            )?;
            for page in &call.pages {
                let resolved: Option<(String, String)> = if let Some(id) = &page.page_id {
                    by_id
                        .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))
                        .optional()?
                } else {
                    by_path
                        .query_row([&page.path], |row| Ok((row.get(0)?, row.get(1)?)))
                        .optional()?
                };
                let (id, path) = match &resolved {
                    Some((id, path)) => (Some(id.as_str()), Some(path.as_str())),
                    None => (page.page_id.as_deref(), page.path.as_deref()),
                };
                insert.execute(params![call.call_id, id, path, page.source])?;
            }
        }
    }
    tx.commit()
}

/// Rolling UTC window, inclusive at both ends; 0 means all history through now.
/// Catalog tools remain visible with zero usage. Page and recent lists cap at 50;
/// daily totals include every active date in the requested window.
#[utoipa::path(
    get, path = "/api/vault/mcp/stats", tag = "MCP",
    params(("days" = Option<u32>, Query, description = "Rolling UTC days: 7, 30 (default), 90, or 0 for all history")),
    responses((status = 200, description = "MCP usage metadata", body = McpStatsResponse),
              (status = 400, description = "Unsupported window", body = ApiError))
)]
pub async fn get_stats(
    State(state): State<Arc<AppState>>,
    Query(query): Query<McpStatsQuery>,
) -> Result<Json<McpStatsResponse>, ApiError> {
    if !matches!(query.days, 0 | 7 | 30 | 90) {
        return Err(ApiError::bad_request("days must be 0, 7, 30 or 90"));
    }
    let now = state.clock.now();
    let since = if query.days == 0 {
        String::new()
    } else {
        timestamp(now - chrono::Duration::days(i64::from(query.days)))
    };
    let until = timestamp(now);
    let response = state
        .index
        .with_index(move |index, _| aggregate(index.connection(), query.days, &since, &until))
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(response))
}

fn aggregate(
    conn: &Connection,
    days: u32,
    since: &str,
    until: &str,
) -> rusqlite::Result<McpStatsResponse> {
    let mut response = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(outcome = 'success'), 0),
                COALESCE(SUM(outcome != 'success'), 0), COUNT(DISTINCT session_id),
                COUNT(DISTINCT COALESCE(agent_label, client_name)), COALESCE(AVG(duration_ms), 0.0)
         FROM mcp_calls WHERE started_at >= ?1 AND started_at <= ?2",
        params![since, until],
        |row| {
            Ok(McpStatsResponse {
                days,
                through_date: until.split_once('T').unwrap().0.to_owned(),
                tracking_since: None,
                total_calls: row.get(0)?,
                successful_calls: row.get(1)?,
                failed_calls: row.get(2)?,
                sessions: row.get(3)?,
                agents: row.get(4)?,
                pages: 0,
                average_duration_ms: row.get(5)?,
                tools: Vec::new(),
                clients: Vec::new(),
                page_activity: Vec::new(),
                daily: Vec::new(),
                daily_agents: Vec::new(),
                recent_calls: Vec::new(),
            })
        },
    )?;
    response.tracking_since = conn.query_row(
        "SELECT MIN(first_seen) FROM (SELECT MIN(first_seen) AS first_seen FROM mcp_sessions
          UNION ALL SELECT MIN(started_at) FROM mcp_calls)",
        [],
        |row| row.get(0),
    )?;
    response.tools = conn.prepare(
        "WITH usage AS (
            SELECT tool, COUNT(*) AS calls, SUM(outcome != 'success') AS failures,
                   AVG(duration_ms) AS average_duration_ms, MAX(started_at) AS last_used_at
            FROM mcp_calls WHERE started_at >= ?1 AND started_at <= ?2 GROUP BY tool
         ), names AS (SELECT name FROM mcp_tools UNION SELECT tool FROM usage)
         SELECT names.name, COALESCE(t.read_only, 0), COALESCE(u.calls, 0), COALESCE(u.failures, 0),
                COALESCE(u.average_duration_ms, 0.0), u.last_used_at
         FROM names LEFT JOIN mcp_tools t ON t.name = names.name LEFT JOIN usage u ON u.tool = names.name
         ORDER BY COALESCE(u.calls, 0) DESC, names.name",
    )?.query_map(params![since, until], |row| Ok(McpToolStats {
        name: row.get(0)?, read_only: row.get(1)?, calls: row.get(2)?, failures: row.get(3)?,
        average_duration_ms: row.get(4)?, last_used_at: row.get(5)?,
    }))?.collect::<rusqlite::Result<_>>()?;
    response.clients = conn.prepare(
        "SELECT COALESCE(agent_label, client_name) AS name, client_name, client_version,
                COUNT(*) AS calls, SUM(outcome != 'success'), COUNT(DISTINCT session_id),
                AVG(duration_ms), MAX(started_at)
         FROM mcp_calls WHERE started_at >= ?1 AND started_at <= ?2
         GROUP BY name, client_name, client_version ORDER BY calls DESC, name, client_name, client_version",
    )?.query_map(params![since, until], |row| Ok(McpClientStats {
        name: row.get(0)?, client_name: row.get(1)?, client_version: row.get(2)?, calls: row.get(3)?,
        failures: row.get(4)?, sessions: row.get(5)?, average_duration_ms: row.get(6)?, last_used_at: row.get(7)?,
    }))?.collect::<rusqlite::Result<_>>()?;
    response.daily = conn
        .prepare(
            "SELECT substr(started_at, 1, 10) AS date, COUNT(*), SUM(outcome != 'success'), AVG(duration_ms)
         FROM mcp_calls WHERE started_at >= ?1 AND started_at <= ?2 GROUP BY date ORDER BY date",
        )?
        .query_map(params![since, until], |row| {
            Ok(McpDailyStats {
                date: row.get(0)?,
                calls: row.get(1)?,
                failures: row.get(2)?,
                average_duration_ms: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    response.daily_agents = conn
        .prepare(
            "SELECT substr(started_at, 1, 10) AS date, COALESCE(agent_label, client_name) AS name,
                    COUNT(*), AVG(duration_ms)
             FROM mcp_calls WHERE started_at >= ?1 AND started_at <= ?2
             GROUP BY date, name ORDER BY date, name",
        )?
        .query_map(params![since, until], |row| {
            Ok(McpDailyAgentStats {
                date: row.get(0)?,
                name: row.get(1)?,
                calls: row.get(2)?,
                average_duration_ms: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    response.recent_calls = conn.prepare(
        "SELECT call_id, tool, client_name, agent_label, started_at, duration_ms, outcome, error_code
         FROM mcp_calls WHERE started_at >= ?1 AND started_at <= ?2
         ORDER BY started_at DESC, call_id LIMIT 50",
    )?.query_map(params![since, until], |row| Ok(McpRecentCall {
        call_id: row.get(0)?, tool: row.get(1)?, client_name: row.get(2)?, agent_label: row.get(3)?,
        started_at: row.get(4)?, duration_ms: row.get(5)?, outcome: row.get(6)?, error_code: row.get(7)?, pages: Vec::new(),
    }))?.collect::<rusqlite::Result<_>>()?;
    let mut refs = conn.prepare("SELECT page_id, path, source FROM mcp_call_pages WHERE call_id = ?1 ORDER BY identity, source")?;
    for call in &mut response.recent_calls {
        call.pages = refs
            .query_map([&call.call_id], |row| {
                Ok(McpPageReference {
                    page_id: row.get(0)?,
                    path: row.get(1)?,
                    source: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
    }
    response.pages = conn.query_row(
        "SELECT COUNT(DISTINCT COALESCE('id:' || p.id, 'id:' || q.id, 'id:' || r.page_id, 'path:' || r.path))
         FROM mcp_calls c JOIN mcp_call_pages r ON r.call_id = c.call_id
         LEFT JOIN pages p ON p.id = r.page_id
         LEFT JOIN pages q ON r.page_id IS NULL AND q.path = r.path
         WHERE c.started_at >= ?1 AND c.started_at <= ?2",
        params![since, until], |row| row.get(0),
    )?;
    response.page_activity = conn.prepare(
        "WITH resolved AS (
            SELECT COALESCE('id:' || p.id, 'id:' || q.id, 'id:' || r.page_id, 'path:' || r.path) AS identity,
                   COALESCE(p.id, q.id, r.page_id) AS page_id,
                   COALESCE(p.path, q.path, r.path) AS path,
                   COALESCE(p.title, q.title, p.path, q.path) AS title,
                   c.call_id, c.started_at, r.source
            FROM mcp_calls c JOIN mcp_call_pages r ON r.call_id = c.call_id
            LEFT JOIN pages p ON p.id = r.page_id
            LEFT JOIN pages q ON r.page_id IS NULL AND q.path = r.path
            WHERE c.started_at >= ?1 AND c.started_at <= ?2
         ), activity AS (
            SELECT identity, COUNT(DISTINCT call_id) AS calls,
                   COUNT(DISTINCT CASE WHEN source = 'target' THEN call_id END) AS target_calls,
                   COUNT(DISTINCT CASE WHEN source = 'result' THEN call_id END) AS result_calls,
                   MAX(started_at) AS last_used_at
            FROM resolved GROUP BY identity
         ), latest AS (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY identity ORDER BY started_at DESC, call_id, source) AS position
            FROM resolved
         )
         SELECT l.page_id, l.path, l.title, a.calls, a.target_calls, a.result_calls, a.last_used_at
         FROM activity a JOIN latest l ON l.identity = a.identity AND l.position = 1
         ORDER BY a.calls DESC, a.last_used_at DESC, a.identity LIMIT 50",
    )?.query_map(params![since, until], |row| Ok(McpPageStats {
        page_id: row.get(0)?, path: row.get(1)?, title: row.get(2)?, calls: row.get(3)?,
        target_calls: row.get(4)?, result_calls: row.get(5)?, last_used_at: row.get(6)?,
    }))?.collect::<rusqlite::Result<_>>()?;
    Ok(response)
}
