//! TASKING board API: read model + task/cycle mutations.
//!
//! Submodules:
//! - [`read`] — `GET /board` aggregation + DTO read-back helpers
//! - [`tasks`] — `POST/PATCH /board/tasks` handlers
//! - [`cycles`] — `POST/PATCH /board/cycles` handlers + seal carryover
//!
//! This file owns the router, the (de)serialization DTOs, and the helpers
//! shared across submodules (validation, code allocation, cycle-code scans).

mod cycles;
mod read;
mod tasks;

use std::sync::Arc;

use axum::Router;
use axum::routing::{get, patch, post};
use rusqlite::params;
use serde::{Deserialize, Deserializer, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::AppState;
use super::error::ApiError;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// The five board columns in order.
const COLUMNS: &[(&str, &str, &str, u32)] = &[
    ("INTAKE", "INTAKE", "unfiled", 0),
    ("TRIAGE", "TRIAGE", "staged", 6),
    ("FIELD", "IN-FIELD", "active", 4),
    ("REVIEW", "REVIEW", "qa / seal", 4),
    ("SEALED", "SEALED", "closed", 0),
];

/// Valid priority tokens.
const PRIORITIES: &[&str] = &["P0", "P1", "P2", "P3"];

// ---------------------------------------------------------------------------
// Tri-state deserialization helper
//
// `serde_with` is not a project dependency. Instead we implement a small
// custom deserializer that distinguishes three states:
//   - key absent → `None`              (leave the field untouched)
//   - key present with JSON null → `Some(None)`  (clear the field)
//   - key present with a value → `Some(Some(v))` (set the field)
//
// Used for the PATCH DTO's clearable fields.
// ---------------------------------------------------------------------------

fn deserialize_tri_state<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    // Deserialize as `Option<T>`: serde maps JSON null → None, value → Some(v).
    // The outer `Option` is handled by `#[serde(default)]`: if the key is absent
    // the whole function is never called and the field stays `None`.
    let inner: Option<T> = Option::deserialize(deserializer)?;
    Ok(Some(inner))
}

// ---------------------------------------------------------------------------
// DTO types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
pub struct BoardColumn {
    pub id: String,
    pub label: String,
    pub sub: String,
    pub wip: u32,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BoardOperation {
    pub id: Uuid,
    pub path: String,
    pub code: String,
    pub name: String,
    pub health: String,
    pub lead: Option<String>,
    pub target: Option<String>,
    pub note: Option<String>,
    pub dossier: Option<String>,
    pub project: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BoardCycle {
    pub id: Uuid,
    pub path: String,
    pub code: String,
    pub label: String,
    pub state: String,
    pub start: Option<String>,
    pub end: Option<String>,
    pub goal: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BoardTask {
    pub id: Uuid,
    pub path: String,
    pub code: String,
    pub title: String,
    pub project: Option<String>,
    pub status: String,
    pub priority: String,
    pub cycle: Option<String>,
    pub assignee: Option<String>,
    pub estimate: Option<String>,
    pub due: Option<String>,
    pub start: Option<String>,
    pub hold: Option<String>,
    pub tags: Vec<String>,
    pub checks: [u32; 2],
    pub link: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BoardResponse {
    pub columns: Vec<BoardColumn>,
    pub operations: Vec<BoardOperation>,
    pub cycles: Vec<BoardCycle>,
    pub tasks: Vec<BoardTask>,
}

// ---------------------------------------------------------------------------
// Request DTOs for mutations
// ---------------------------------------------------------------------------

/// POST /board/cycles request body.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateCycleRequest {
    /// Optional explicit code (e.g. "S-20"). If absent, auto-generated as
    /// "S-{max+1}" from existing CYCLE page stems.
    pub code: Option<String>,
    /// Human-readable label — stored as the page title.
    pub label: String,
    /// Start date (YYYY-MM-DD string).
    pub start: String,
    /// End date (YYYY-MM-DD string).
    pub end: String,
    /// Optional sprint goal.
    pub goal: Option<String>,
    /// Initial state. Defaults to "PLANNED". Must be PLANNED or ACTIVE.
    /// CLOSED is rejected at creation time.
    pub state: Option<String>,
}

/// PATCH /board/cycles/{id} request body. All fields optional.
#[derive(Debug, Deserialize, ToSchema)]
pub struct PatchCycleRequest {
    /// New state. Must be PLANNED, ACTIVE, or CLOSED.
    pub state: Option<String>,
    /// New sprint goal. Absent = keep current.
    pub goal: Option<String>,
    /// New start date. Absent = keep current.
    pub start: Option<String>,
    /// New end date. Absent = keep current.
    pub end: Option<String>,
    /// Carryover target for non-SEALED tasks when sealing (state=="CLOSED").
    /// "BACKLOG" removes the cycle key; a cycle stem (e.g. "S-14") re-assigns.
    /// Only valid when state=="CLOSED". Absent = leave tasks untouched.
    pub carry_to: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateTaskRequest {
    pub title: String,
    pub project: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub cycle: Option<String>,
    pub assignee: Option<String>,
    pub estimate: Option<String>,
    pub due: Option<String>,
    pub tags: Option<Vec<String>>,
    pub link: Option<String>,
    /// Checklist items. Each becomes a `- [ ] item` line in the page body.
    pub checklist: Option<Vec<String>>,
}

/// PATCH request for updating a task. All fields are optional.
///
/// For tri-state fields (`cycle`, `assignee`, `estimate`, `due`, `hold`,
/// `link`): absent = leave unchanged; `null` = clear the field; string value =
/// set to that value. Implemented via `#[serde(default, deserialize_with)]`
/// which maps the outer `Option` to "present or absent" and the inner `Option`
/// to "null or value".
#[derive(Debug, Deserialize, ToSchema)]
pub struct PatchTaskRequest {
    /// Leave absent to keep current title.
    pub title: Option<String>,
    /// Leave absent to keep current project.
    pub project: Option<String>,
    /// Leave absent to keep current status.
    pub status: Option<String>,
    /// Leave absent to keep current priority.
    pub priority: Option<String>,
    /// Tri-state: absent = keep, null = clear (→ backlog), value = set.
    #[serde(default, deserialize_with = "deserialize_tri_state")]
    pub cycle: Option<Option<String>>,
    /// Tri-state: absent = keep, null = clear, value = set.
    #[serde(default, deserialize_with = "deserialize_tri_state")]
    pub assignee: Option<Option<String>>,
    /// Tri-state: absent = keep, null = clear, value = set.
    #[serde(default, deserialize_with = "deserialize_tri_state")]
    pub estimate: Option<Option<String>>,
    /// Tri-state: absent = keep, null = clear, value = set.
    #[serde(default, deserialize_with = "deserialize_tri_state")]
    pub due: Option<Option<String>>,
    /// Tri-state: absent = keep, null = clear, value = set.
    #[serde(default, deserialize_with = "deserialize_tri_state")]
    pub hold: Option<Option<String>>,
    /// Tri-state: absent = keep, null = clear, value = set.
    #[serde(default, deserialize_with = "deserialize_tri_state")]
    pub link: Option<Option<String>>,
    /// Leave absent to keep current tags.
    pub tags: Option<Vec<String>>,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(read::get_board))
        .route("/tasks", post(tasks::create_task))
        .route("/tasks/{id}", patch(tasks::patch_task))
        .route("/cycles", post(cycles::create_cycle))
        .route("/cycles/{id}", patch(cycles::patch_cycle))
}

// ---------------------------------------------------------------------------
// Shared validation helpers
// ---------------------------------------------------------------------------

/// Validate a status string against the known columns.
fn validate_status(status: &str) -> Result<(), ApiError> {
    let valid = COLUMNS.iter().any(|&(id, _, _, _)| id == status);
    if !valid {
        let valid_ids: Vec<&str> = COLUMNS.iter().map(|&(id, _, _, _)| id).collect();
        return Err(ApiError::bad_request(format!(
            "unknown status: '{status}'; valid values: {}",
            valid_ids.join(", ")
        )));
    }
    Ok(())
}

/// Validate a priority string.
fn validate_priority(priority: &str) -> Result<(), ApiError> {
    if !PRIORITIES.contains(&priority) {
        return Err(ApiError::bad_request(format!(
            "unknown priority: '{priority}'; valid values: {}",
            PRIORITIES.join(", ")
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Cycle-code scan + code allocation (shared by tasks + cycles handlers)
// ---------------------------------------------------------------------------

/// Collect the filename stems of all CYCLE pages. Stems are the cycle codes
/// (case-sensitive, e.g. "S-13"). Single source of truth for every
/// cycle-existence check.
fn cycle_stems(conn: &rusqlite::Connection) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT path FROM pages WHERE kind = 'CYCLE'")?;
    let stems = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .map(|p| path_stem(&p).to_string())
        .collect();
    Ok(stems)
}

/// Fetch all cycle codes through the index handle.
async fn fetch_cycle_codes(state: &AppState) -> Result<Vec<String>, ApiError> {
    state
        .index
        .with_index(|index, _vault| cycle_stems(index.connection()))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))
}

/// Check that `cycle_code` matches the filename stem of an existing CYCLE
/// page (case-sensitive). Returns 400 with a hint otherwise. Shared by the
/// task POST/PATCH handlers and the cycle-seal carry_to validation.
async fn ensure_cycle_exists(state: &AppState, cycle_code: &str) -> Result<(), ApiError> {
    let codes = fetch_cycle_codes(state).await?;
    if !codes.iter().any(|c| c == cycle_code) {
        return Err(ApiError::bad_request(format!(
            "unknown cycle: '{cycle_code}'; must match the stem of an existing CYCLE page (e.g. 'S-13')"
        )));
    }
    Ok(())
}

/// Highest numeric suffix among the stems of `kind` pages whose uppercased
/// stem starts with `prefix` (e.g. kind "TASK" + prefix "TSK-" → 481 for
/// `tasks/TSK-0481.md`). Returns 0 when no stem matches.
fn max_code_number(
    conn: &rusqlite::Connection,
    kind: &str,
    prefix: &str,
) -> Result<u32, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT path FROM pages WHERE kind = ?1")?;
    let max = stmt
        .query_map(params![kind], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .filter_map(|p| {
            path_stem(&p)
                .to_ascii_uppercase()
                .strip_prefix(prefix)
                .and_then(|n| n.parse::<u32>().ok())
        })
        .max()
        .unwrap_or(0);
    Ok(max)
}

/// Allocate the next sequential code number (max existing + 1, min 1) for a
/// page kind via the index. Shared by the TSK-NNNN and S-NN allocators.
async fn next_code_number(
    state: &AppState,
    kind: &'static str,
    prefix: &'static str,
) -> Result<u32, ApiError> {
    state
        .index
        .with_index(move |index, _vault| max_code_number(index.connection(), kind, prefix))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))
        .map(|max| max + 1)
}

// ---------------------------------------------------------------------------
// Path / frontmatter helpers
// ---------------------------------------------------------------------------

/// Extract the filename stem from a vault path (without `.md` extension).
fn path_stem(path: &str) -> &str {
    // e.g. "projects/op-sig3.md" -> "op-sig3"
    // e.g. "cycles/S-13.md" -> "S-13"
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".md").unwrap_or(name)
}

/// Read a scalar value from parsed meta JSON as a String, coercing
/// strings, numbers, and booleans. Returns None if absent or null.
fn extra_str(meta: &serde_json::Value, key: &str) -> Option<String> {
    match meta.get(key) {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
        Some(serde_json::Value::Bool(b)) => Some(b.to_string()),
        Some(other) => {
            // Arrays, objects: convert to compact JSON string
            let s = other.to_string();
            if s.is_empty() { None } else { Some(s) }
        }
    }
}
