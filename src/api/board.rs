use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::routing::get;
use rusqlite::params;
use serde::Serialize;
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
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/", get(get_board))
}

// ---------------------------------------------------------------------------
// GET /board
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/board",
    context_path = "/api/vault",
    tag = "Board",
    responses(
        (status = 200, description = "Board read model", body = BoardResponse),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
#[allow(clippy::type_complexity)]
async fn get_board(
    State(state): State<Arc<AppState>>,
) -> Result<Json<BoardResponse>, ApiError> {
    let result = state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();

            // --- Columns -------------------------------------------------------
            let columns: Vec<BoardColumn> = COLUMNS
                .iter()
                .map(|&(id, label, sub, wip)| BoardColumn {
                    id: id.to_string(),
                    label: label.to_string(),
                    sub: sub.to_string(),
                    wip,
                })
                .collect();

            // --- Operations (PROJECT pages with board: true) -------------------
            let mut op_stmt = conn.prepare(
                "SELECT id, path, title, meta_json, project \
                   FROM pages \
                  WHERE kind = 'PROJECT' \
                  ORDER BY path",
            )?;

            let op_rows: Vec<(String, String, Option<String>, String, Option<String>)> = op_stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })?
                .collect::<Result<_, _>>()?;

            let mut operations: Vec<BoardOperation> = Vec::new();
            for (id_str, path, title, meta_json, project) in op_rows {
                // Parse meta_json to check board: true
                let meta: serde_json::Value =
                    serde_json::from_str(&meta_json).unwrap_or(serde_json::Value::Null);

                // Filter: board: true must be present in extra
                let board_flag = meta.get("board");
                if board_flag != Some(&serde_json::Value::Bool(true)) {
                    continue;
                }

                let id = match Uuid::parse_str(&id_str) {
                    Ok(u) => u,
                    Err(_) => continue,
                };

                // code = filename stem, uppercased
                let stem = path_stem(&path);
                let code = stem.to_ascii_uppercase();

                // name = title or stem
                let name = title.unwrap_or_else(|| stem.to_ascii_uppercase());

                // Absent `health:` frontmatter normalizes to "GREEN" by design —
                // the UI treats health as always-present decoration.
                let health = meta
                    .get("health")
                    .and_then(|v| v.as_str())
                    .unwrap_or("GREEN")
                    .to_string();

                let lead = extra_str(&meta, "lead");
                let target = extra_str(&meta, "target");
                let note = extra_str(&meta, "note");
                let dossier = extract_link_or_str(&meta, "link");

                operations.push(BoardOperation {
                    id,
                    path,
                    code,
                    name,
                    health,
                    lead,
                    target,
                    note,
                    dossier,
                    project,
                });
            }
            operations.sort_by(|a, b| a.code.cmp(&b.code));

            // --- Cycles (CYCLE pages) ------------------------------------------
            let mut cy_stmt = conn.prepare(
                "SELECT id, path, title, meta_json \
                   FROM pages \
                  WHERE kind = 'CYCLE' \
                  ORDER BY path",
            )?;

            let cy_rows: Vec<(String, String, Option<String>, String)> = cy_stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<Result<_, _>>()?;

            let mut cycles: Vec<BoardCycle> = Vec::new();
            for (id_str, path, title, meta_json) in cy_rows {
                let id = match Uuid::parse_str(&id_str) {
                    Ok(u) => u,
                    Err(_) => continue,
                };

                let meta: serde_json::Value =
                    serde_json::from_str(&meta_json).unwrap_or(serde_json::Value::Null);

                let stem = path_stem(&path);
                let code = stem.to_ascii_uppercase();
                let label = title.unwrap_or_else(|| code.clone());

                let state_str = extra_str(&meta, "state").unwrap_or_else(|| "PLANNED".to_string());
                let start = extra_str(&meta, "start");
                let end = extra_str(&meta, "end");
                let goal = extra_str(&meta, "goal");

                cycles.push(BoardCycle {
                    id,
                    path,
                    code,
                    label,
                    state: state_str,
                    start,
                    end,
                    goal,
                });
            }
            // Sort by start date (then code)
            cycles.sort_by(|a, b| {
                let sa = a.start.as_deref().unwrap_or("");
                let sb = b.start.as_deref().unwrap_or("");
                sa.cmp(sb).then_with(|| a.code.cmp(&b.code))
            });

            // --- Tasks (all TASK pages) ----------------------------------------
            let mut task_stmt = conn.prepare(
                "SELECT p.id, p.path, p.title, p.meta_json, p.project, p.updated_at, \
                        COALESCE((SELECT group_concat(t.tag, char(31)) \
                                    FROM tags t WHERE t.page_id = p.id), '') \
                   FROM pages p \
                  WHERE p.kind = 'TASK' \
                  ORDER BY p.path",
            )?;

            let task_rows: Vec<(
                String,
                String,
                Option<String>,
                String,
                Option<String>,
                Option<String>,
                String,
            )> = task_stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                })?
                .collect::<Result<_, _>>()?;

            let mut tasks: Vec<BoardTask> = Vec::new();
            for (id_str, path, title, meta_json, project, updated_at, tags_raw) in task_rows {
                let id = match Uuid::parse_str(&id_str) {
                    Ok(u) => u,
                    Err(_) => continue,
                };

                let meta: serde_json::Value =
                    serde_json::from_str(&meta_json).unwrap_or(serde_json::Value::Null);

                let stem = path_stem(&path);
                let code = stem.to_ascii_uppercase();
                let task_title = title.unwrap_or_else(|| code.clone());

                let status = extra_str(&meta, "status").unwrap_or_else(|| "INTAKE".to_string());
                let priority = extra_str(&meta, "priority").unwrap_or_else(|| "P2".to_string());
                let cycle = extra_str(&meta, "cycle");
                let assignee = extra_str(&meta, "assignee");
                let estimate = extra_str(&meta, "estimate");
                let due = extra_str(&meta, "due");
                let task_start = extra_str(&meta, "start");
                let hold = extra_str(&meta, "hold");
                let link = extract_link_or_str(&meta, "link");

                // tags: from the group_concat of the tags table
                let tags: Vec<String> = if tags_raw.is_empty() {
                    Vec::new()
                } else {
                    tags_raw
                        .split('\x1f')
                        .map(|s| s.to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                };

                // checks: [done, total] from checkbox blocks in this page
                let checks = count_checks(conn, &id_str)?;

                let updated_at_str = updated_at.unwrap_or_default();

                tasks.push(BoardTask {
                    id,
                    path,
                    code,
                    title: task_title,
                    project,
                    status,
                    priority,
                    cycle,
                    assignee,
                    estimate,
                    due,
                    start: task_start,
                    hold,
                    tags,
                    checks,
                    link,
                    updated_at: updated_at_str,
                });
            }
            tasks.sort_by(|a, b| a.code.cmp(&b.code));

            Ok::<_, rusqlite::Error>(BoardResponse {
                columns,
                operations,
                cycles,
                tasks,
            })
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Helpers
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

/// Extract `link` field: if value looks like a wikilink (`[[target]]` or
/// `[[target|display]]`), strip the brackets and return only the target
/// (the part before `|`, mirroring `extract_links` in vault/link.rs);
/// otherwise return the raw string value.
fn extract_link_or_str(meta: &serde_json::Value, key: &str) -> Option<String> {
    let raw = extra_str(meta, key)?;
    // Strip wikilink brackets if present
    if raw.starts_with("[[") && raw.ends_with("]]") {
        let inner = &raw[2..raw.len() - 2];
        // If `[[target|display]]`, keep only the target (before `|`).
        let target = match inner.split_once('|') {
            Some((t, _)) => t,
            None => inner,
        };
        Some(target.to_string())
    } else {
        Some(raw)
    }
}

/// Count checkbox blocks for a page: returns [done, total].
/// "done" = status = 'done'; total = all blocks with a 'status' property
/// (i.e. all checkbox items — todo, done, cancelled).
/// Cancelled counts toward total but not done.
fn count_checks(
    conn: &rusqlite::Connection,
    page_id: &str,
) -> Result<[u32; 2], rusqlite::Error> {
    let (total, done): (u32, u32) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(value = 'done'), 0) \
           FROM block_properties \
          WHERE page_id = ?1 AND key = 'status'",
        params![page_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok([done, total])
}
