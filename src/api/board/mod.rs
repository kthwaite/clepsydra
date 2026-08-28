//! TASKING board API: read model + task/cycle mutations.
//!
//! Submodules:
//! - [`read`] — `GET /board` aggregation + DTO read-back helpers
//! - [`tasks`] — `POST/PATCH /board/tasks` handlers
//! - [`cycles`] — `POST/PATCH /board/cycles` handlers + seal carryover
//!
//! This file owns the router, the (de)serialization DTOs, and the helpers
//! shared across submodules (validation, code allocation, cycle-code scans).

pub(crate) mod cycles;
pub(crate) mod read;
pub(crate) mod tasks;

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::Router;
use axum::routing::{get, patch, post};
use rusqlite::params;
use serde::{Deserialize, Deserializer, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::AppState;
use super::error::ApiError;
use crate::vault::board_vocab::{DEFAULT_PRIORITY, DEFAULT_STATUS};
use crate::vault::code::{self, CodeFamily};
use crate::vault::kind::Kind;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// The five board columns in order.
const COLUMNS: &[(&str, &str, &str)] = &[
    (DEFAULT_STATUS, DEFAULT_STATUS, "unfiled"),
    ("TRIAGE", "TRIAGE", "staged"),
    ("FIELD", "IN-FIELD", "active"),
    ("REVIEW", "REVIEW", "qa / seal"),
    ("SEALED", "SEALED", "closed"),
];

/// Valid priority tokens.
const PRIORITIES: &[&str] = &["P0", "P1", DEFAULT_PRIORITY, "P3"];

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
    #[schema(required = true)]
    pub body_excerpt: Option<String>,
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

/// A syntactically valid cycle lifecycle state.
///
/// Parsing deliberately does not decide whether an operation permits the
/// state. Creation and patching apply their own policy after parsing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CycleState {
    Planned,
    Active,
    Closed,
}

impl CycleState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "PLANNED",
            Self::Active => "ACTIVE",
            Self::Closed => "CLOSED",
        }
    }
}

impl std::str::FromStr for CycleState {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "PLANNED" => Ok(Self::Planned),
            "ACTIVE" => Ok(Self::Active),
            "CLOSED" => Ok(Self::Closed),
            other => Err(format!("unknown state: '{other}'")),
        }
    }
}

/// POST /board/cycles request body.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateCycleRequest {
    /// Optional explicit code (e.g. "S-calm-heron-2xm9p"); must match the
    /// petname format (docs/adr/0003) and not collide with an existing
    /// CYCLE page stem. If absent, a fresh code is minted.
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
    pub start: Option<String>,
    pub tags: Option<Vec<String>>,
    pub link: Option<String>,
    /// Prose brief. Becomes the opening paragraphs of the page body, above any
    /// checklist. Whitespace-only input is treated as absent.
    pub body: Option<String>,
    /// Checklist items. Each becomes a `- [ ] item` line in the page body.
    pub checklist: Option<Vec<String>>,
}

/// PATCH request for updating a task. All fields are optional.
///
/// For tri-state fields (`cycle`, `assignee`, `estimate`, `due`, `start`,
/// `hold`, `link`): absent = leave unchanged; `null` = clear the field; string value =
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
    pub start: Option<Option<String>>,
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
    let valid = COLUMNS.iter().any(|&(id, _, _)| id == status);
    if !valid {
        let valid_ids: Vec<&str> = COLUMNS.iter().map(|&(id, _, _)| id).collect();
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
// Code stems + code allocation (shared by tasks + cycles handlers)
// ---------------------------------------------------------------------------

/// Filename stems of every page of `kind` — these ARE the codes.
pub(crate) fn code_stems(
    conn: &rusqlite::Connection,
    kind: Kind,
) -> Result<BTreeSet<String>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT path FROM pages WHERE kind = ?1")?;
    let stems = stmt
        .query_map(params![kind.as_str()], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .map(|p| path_stem(&p).to_string())
        .collect();
    Ok(stems)
}

/// Collect the filename stems of all CYCLE pages. Stems are the cycle codes
/// (case-sensitive, e.g. "S-13"). Thin wrapper over [`code_stems`] kept so
/// existing callers (task cycle-membership checks, seal carryover) don't need
/// to touch the `BTreeSet`/`Vec` distinction.
fn cycle_stems(conn: &rusqlite::Connection) -> Result<Vec<String>, rusqlite::Error> {
    Ok(code_stems(conn, Kind::Cycle)?.into_iter().collect())
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

/// The result of resolving user input to a canonical code stem via
/// [`resolve_code`].
pub(crate) enum CodeLookup {
    Found(String),
    NotFound,
    Ambiguous(Vec<String>),
}

/// Check that `slug` is declared as the `project` of at least one PROJECT
/// page. Returns 400 otherwise. Shared by the task POST/PATCH handlers, which
/// only call it for a non-empty slug (the empty string clears on PATCH).
async fn ensure_project_exists(state: &AppState, slug: &str) -> Result<(), ApiError> {
    let slug_owned = slug.to_string();
    let exists = state
        .index
        .with_index(move |index, _vault| {
            index
                .connection()
                .prepare("SELECT 1 FROM pages WHERE kind = ?1 AND project = ?2 LIMIT 1")?
                .exists(params![Kind::Project.as_str(), slug_owned])
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if !exists {
        return Err(ApiError::bad_request(format!(
            "unknown project: {slug}; must match the project slug declared by an existing PROJECT page"
        )));
    }
    Ok(())
}

/// Resolve user input to a canonical stem of `kind`: an exact case-insensitive
/// match wins; otherwise a unique case-insensitive prefix match; otherwise
/// `NotFound` (no match) or `Ambiguous` (multiple prefix matches, listed).
/// Codes are never uppercased or otherwise normalized here — whichever stem
/// is stored on disk is what comes back.
pub(crate) fn resolve_code(
    conn: &rusqlite::Connection,
    kind: Kind,
    input: &str,
) -> Result<CodeLookup, rusqlite::Error> {
    let needle = input.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return Ok(CodeLookup::NotFound);
    }
    let stems = code_stems(conn, kind)?;
    if let Some(exact) = stems.iter().find(|s| s.to_ascii_lowercase() == needle) {
        return Ok(CodeLookup::Found(exact.clone()));
    }
    let matches: Vec<String> = stems
        .iter()
        .filter(|s| s.to_ascii_lowercase().starts_with(&needle))
        .cloned()
        .collect();
    Ok(match matches.len() {
        0 => CodeLookup::NotFound,
        1 => CodeLookup::Found(matches.into_iter().next().expect("one")),
        _ => CodeLookup::Ambiguous(matches),
    })
}

/// Resolve `cycle_code` (exact match or unique case-insensitive prefix)
/// against existing CYCLE page stems. Returns the canonical stem on success,
/// or 400 (unknown / ambiguous, candidates listed) otherwise. Shared by the
/// task POST/PATCH handlers and the cycle-seal carry_to validation.
async fn ensure_cycle_exists(state: &AppState, cycle_code: &str) -> Result<String, ApiError> {
    let input = cycle_code.to_string();
    let lookup = state
        .index
        .with_index(move |index, _vault| resolve_code(index.connection(), Kind::Cycle, &input))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;
    match lookup {
        CodeLookup::Found(code) => Ok(code),
        CodeLookup::NotFound => Err(ApiError::bad_request(format!(
            "unknown cycle '{cycle_code}'; must match an existing cycle code or a unique prefix of one"
        ))),
        CodeLookup::Ambiguous(c) => Err(ApiError::bad_request(format!(
            "ambiguous cycle prefix '{cycle_code}': candidates {}",
            c.join(", ")
        ))),
    }
}

/// Mint a code no existing page of the family's kind uses. With 43 bits of
/// entropy a collision is astronomically unlikely; the re-roll loop only
/// checks against a snapshot of the index, so it is not what guarantees
/// uniqueness — the page create downstream is an atomic filesystem create
/// that maps `AlreadyExists` to a 409, so two pages can never share a code.
pub(crate) async fn mint_unique_code(
    state: &AppState,
    family: CodeFamily,
) -> Result<String, ApiError> {
    const ATTEMPTS: usize = 8;
    let kind = family.kind();
    let stems = state
        .index
        .with_index(move |index, _vault| code_stems(index.connection(), kind))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;
    for _ in 0..ATTEMPTS {
        let candidate = code::mint(family);
        if !stems.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err(ApiError::internal(format!(
        "could not mint a unique {} code after {ATTEMPTS} attempts",
        family.prefix()
    )))
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
