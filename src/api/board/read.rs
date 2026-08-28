//! Board read side: `GET /board` aggregation and the DTO read-back helpers
//! used by the mutation handlers (read from the index after a write so
//! responses always match what a subsequent GET would return).

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use rusqlite::params;
use uuid::Uuid;

use crate::api::AppState;
use crate::api::error::ApiError;
use crate::vault::board_vocab::{DEFAULT_PRIORITY, DEFAULT_STATUS};
use crate::vault::canonical::CanonicalName;
use crate::vault::kind::Kind;
use crate::vault::path::VaultPath;
use crate::vault::query::body_excerpt;

use super::{
    BoardColumn, BoardCycle, BoardOperation, BoardResponse, BoardTask, COLUMNS, extra_str,
    path_stem,
};

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
pub(crate) async fn get_board(
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

            // --- Operations (PROJECT pages) ------------------------------------
            let mut op_stmt = conn.prepare(
                "SELECT id, path, title, canonical_name, meta_json, project \
                   FROM pages \
                  WHERE kind = ?1 \
                  ORDER BY path",
            )?;

            let op_rows: Vec<OperationRow> = op_stmt
                .query_map(params![Kind::Project.as_str()], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                })?
                .collect::<Result<_, _>>()?;

            // One operation per slug key (the `project` slug, or the page code
            // for a slug-less page admitted by `board: true`). Rows arrive in
            // path order, so a rank tie keeps the earlier path.
            let mut best: HashMap<String, (u8, BoardOperation)> = HashMap::new();
            for (id_str, path, title, canonical_name, meta_json, project) in op_rows {
                let meta: serde_json::Value =
                    serde_json::from_str(&meta_json).unwrap_or(serde_json::Value::Null);

                // `board:` is opt-out, not opt-in: every PROJECT page is an
                // operation unless its frontmatter says `board: false`. An
                // absent key (the common case — onboarding never sets one)
                // and `board: true` both list the page, slug or not.
                let board_flag = meta.get("board").and_then(serde_json::Value::as_bool);
                if board_flag == Some(false) {
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

                // Preference within a slug: `board: true`, then the page whose
                // canonical name equals the slug, then path order.
                let rank = operation_rank(board_flag, project.as_deref(), &canonical_name);
                let key = project.clone().unwrap_or_else(|| code.clone());
                if best.get(&key).is_some_and(|(held, _)| *held <= rank) {
                    continue;
                }

                best.insert(
                    key,
                    (
                        rank,
                        BoardOperation {
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
                        },
                    ),
                );
            }
            let mut operations: Vec<BoardOperation> =
                best.into_values().map(|(_, op)| op).collect();
            operations.sort_by(|a, b| a.code.cmp(&b.code).then_with(|| a.path.cmp(&b.path)));

            // --- Cycles (CYCLE pages) ------------------------------------------
            let mut cy_stmt = conn.prepare(
                "SELECT id, path, title, meta_json \
                   FROM pages \
                  WHERE kind = ?1 \
                  ORDER BY path",
            )?;

            let cy_rows: Vec<(String, String, Option<String>, String)> = cy_stmt
                .query_map(params![Kind::Cycle.as_str()], |row| {
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
            let tasks = load_tasks(conn)?;

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

/// Row tuple for the operation query:
/// `(id, path, title, canonical_name, meta_json, project)`.
type OperationRow = (
    String,
    String,
    Option<String>,
    String,
    String,
    Option<String>,
);

/// Rank a PROJECT page among the pages sharing its slug key: lower wins.
/// `board: true` (0) beats a canonical name equal to the slug (1), which
/// beats everything else (2). Ties fall back to path order at the call site.
fn operation_rank(board_flag: Option<bool>, project: Option<&str>, canonical_name: &str) -> u8 {
    if board_flag == Some(true) {
        0
    } else if project.is_some_and(|slug| CanonicalName::new(slug).as_str() == canonical_name) {
        1
    } else {
        2
    }
}

// ---------------------------------------------------------------------------
// DTO read-back helpers (used by the mutation handlers)
// ---------------------------------------------------------------------------

/// Row tuple for a single-task DTO query:
/// `(id, title, meta_json, project, updated_at, tags_raw, body)`.
type TaskDtoRow = (
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);

/// Row tuple for the task-list query:
/// `(id, path, title, meta_json, project, updated_at, tags_raw, body)`.
type TaskListRow = (
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);

/// Build a `BoardTask` DTO from the index for a given vault path + code.
/// Reads from the index to ensure consistency with the GET /board response.
pub(super) async fn build_board_task_dto(
    state: &AppState,
    vault_path: &VaultPath,
    code: &str,
) -> Result<BoardTask, ApiError> {
    let vp_str = vault_path.as_str().to_string();
    let code_str = code.to_string();
    state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();
            let row: Option<TaskDtoRow> = conn
                .query_row(
                    "SELECT p.id, p.title, p.meta_json, p.project, p.updated_at, \
                             COALESCE((SELECT group_concat(t.tag, char(31)) \
                                         FROM tags t WHERE t.page_id = p.id), ''), \
                             CASE WHEN p.encrypted = 1 THEN NULL ELSE body_index.body END \
                        FROM pages p \
                        LEFT JOIN page_bodies body_index ON body_index.page_id = p.id \
                       WHERE p.path = ?1",
                    params![vp_str],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<String>>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, Option<String>>(6)?,
                        ))
                    },
                )
                .ok();

            let (id_str, title, meta_json, project, updated_at, tags_raw, body) =
                row.ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            let id = Uuid::parse_str(&id_str).map_err(|_| rusqlite::Error::QueryReturnedNoRows)?;

            let meta: serde_json::Value =
                serde_json::from_str(&meta_json).unwrap_or(serde_json::Value::Null);

            let task_title = title.unwrap_or_else(|| code_str.clone());
            let status = extra_str(&meta, "status").unwrap_or_else(|| DEFAULT_STATUS.to_string());
            let priority =
                extra_str(&meta, "priority").unwrap_or_else(|| DEFAULT_PRIORITY.to_string());
            let cycle = extra_str(&meta, "cycle");
            let assignee = extra_str(&meta, "assignee");
            let estimate = extra_str(&meta, "estimate");
            let due = extra_str(&meta, "due");
            let task_start = extra_str(&meta, "start");
            let hold = extra_str(&meta, "hold");
            let link = extract_link_or_str(&meta, "link");

            let tags: Vec<String> = if tags_raw.is_empty() {
                Vec::new()
            } else {
                tags_raw
                    .split('\x1f')
                    .map(|s| s.to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            };

            let checks = count_checks(conn, &id_str)?;
            let updated_at_str = updated_at.unwrap_or_default();

            Ok::<_, rusqlite::Error>(BoardTask {
                id,
                path: vp_str,
                code: code_str,
                title: task_title,
                body_excerpt: body.as_deref().map(body_excerpt),
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
            })
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))
}

/// Build a `BoardCycle` DTO from the index for a given vault path. The code
/// is derived from the path stem (uppercased) — the same canonical derivation
/// the GET /board aggregation uses.
pub(super) async fn build_board_cycle_dto(
    state: &AppState,
    vault_path: &VaultPath,
) -> Result<BoardCycle, ApiError> {
    let vp_str = vault_path.as_str().to_string();
    let code_str = path_stem(&vp_str).to_ascii_uppercase();
    state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();
            let row: Option<(String, Option<String>, String)> = conn
                .query_row(
                    "SELECT id, title, meta_json FROM pages WHERE path = ?1",
                    params![vp_str],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .ok();

            let (id_str, title, meta_json) =
                row.ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            let id = Uuid::parse_str(&id_str).map_err(|_| rusqlite::Error::QueryReturnedNoRows)?;

            let meta: serde_json::Value =
                serde_json::from_str(&meta_json).unwrap_or(serde_json::Value::Null);

            let label = title.unwrap_or_else(|| code_str.clone());
            let state_str = extra_str(&meta, "state").unwrap_or_else(|| "PLANNED".to_string());
            let start = extra_str(&meta, "start");
            let end = extra_str(&meta, "end");
            let goal = extra_str(&meta, "goal");

            Ok::<_, rusqlite::Error>(BoardCycle {
                id,
                path: vp_str,
                code: code_str,
                label,
                state: state_str,
                start,
                end,
                goal,
            })
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))
}

/// Load all TASK pages from the index as BoardTask DTOs.
/// Extracted so both GET /board and the mutation responses can use the same mapping.
fn load_tasks(conn: &rusqlite::Connection) -> Result<Vec<BoardTask>, rusqlite::Error> {
    let mut task_stmt = conn.prepare(
        "SELECT p.id, p.path, p.title, p.meta_json, p.project, p.updated_at, \
                COALESCE((SELECT group_concat(t.tag, char(31)) \
                            FROM tags t WHERE t.page_id = p.id), ''), \
                CASE WHEN p.encrypted = 1 THEN NULL ELSE body_index.body END \
           FROM pages p \
           LEFT JOIN page_bodies body_index ON body_index.page_id = p.id \
          WHERE p.kind = ?1 \
          ORDER BY p.path",
    )?;

    let task_rows: Vec<TaskListRow> = task_stmt
        .query_map(params![Kind::Task.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?
        .collect::<Result<_, _>>()?;

    let checks_by_page = count_checks_by_page(conn)?;

    let mut tasks: Vec<BoardTask> = Vec::new();
    for (id_str, path, title, meta_json, project, updated_at, tags_raw, body) in task_rows {
        let id = match Uuid::parse_str(&id_str) {
            Ok(u) => u,
            Err(_) => continue,
        };

        let meta: serde_json::Value =
            serde_json::from_str(&meta_json).unwrap_or(serde_json::Value::Null);

        let stem = path_stem(&path);
        let code = stem.to_ascii_uppercase();
        let task_title = title.unwrap_or_else(|| code.clone());

        let status = extra_str(&meta, "status").unwrap_or_else(|| DEFAULT_STATUS.to_string());
        let priority = extra_str(&meta, "priority").unwrap_or_else(|| DEFAULT_PRIORITY.to_string());
        let cycle = extra_str(&meta, "cycle");
        let assignee = extra_str(&meta, "assignee");
        let estimate = extra_str(&meta, "estimate");
        let due = extra_str(&meta, "due");
        let task_start = extra_str(&meta, "start");
        let hold = extra_str(&meta, "hold");
        let link = extract_link_or_str(&meta, "link");

        let tags: Vec<String> = if tags_raw.is_empty() {
            Vec::new()
        } else {
            tags_raw
                .split('\x1f')
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
                .collect()
        };

        let checks = checks_by_page.get(&id_str).copied().unwrap_or([0, 0]);
        let updated_at_str = updated_at.unwrap_or_default();

        tasks.push(BoardTask {
            id,
            path,
            code,
            title: task_title,
            body_excerpt: body.as_deref().map(body_excerpt),
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
    Ok(tasks)
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

/// Count checkbox blocks for every TASK page in one grouped query.
///
/// TASK pages without checkbox blocks are absent and callers default them to `[0, 0]`.
fn count_checks_by_page(
    conn: &rusqlite::Connection,
) -> Result<HashMap<String, [u32; 2]>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT bp.page_id, COUNT(*), COALESCE(SUM(bp.value = 'done'), 0) \
           FROM block_properties bp \
           JOIN pages p ON p.id = bp.page_id AND p.kind = ?1 \
          WHERE bp.key = 'status' \
          GROUP BY bp.page_id",
    )?;
    stmt.query_map(params![Kind::Task.as_str()], |row| {
        let page_id = row.get::<_, String>(0)?;
        let total = row.get::<_, u32>(1)?;
        let done = row.get::<_, u32>(2)?;
        Ok((page_id, [done, total]))
    })?
    .collect()
}

/// Count checkbox blocks for a page: returns [done, total].
/// "done" = status = 'done'; total = all blocks with a 'status' property
/// (i.e. all checkbox items — todo, done, cancelled).
/// Cancelled counts toward total but not done.
fn count_checks(conn: &rusqlite::Connection, page_id: &str) -> Result<[u32; 2], rusqlite::Error> {
    let (total, done): (u32, u32) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(value = 'done'), 0) \
           FROM block_properties \
          WHERE page_id = ?1 AND key = 'status'",
        params![page_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok([done, total])
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::{count_checks_by_page, operation_rank};

    #[test]
    fn operation_rank_prefers_board_flag_then_canonical_name() {
        assert_eq!(operation_rank(Some(true), None, "anything"), 0);
        assert_eq!(operation_rank(Some(true), Some("atlas"), "other"), 0);
        assert_eq!(operation_rank(None, Some("atlas"), "atlas"), 1);
        assert_eq!(operation_rank(None, Some("Atlas"), "atlas"), 1);
        assert_eq!(operation_rank(None, Some("atlas"), "atlas hub"), 2);
        assert_eq!(operation_rank(None, None, "atlas"), 2);
    }

    #[test]
    fn checklist_counts_are_aggregated_for_multiple_pages() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE pages (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL
            );
            CREATE TABLE block_properties (
                page_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL
            );
            INSERT INTO pages (id, kind) VALUES
                ('todo-page', 'TASK'),
                ('done-page', 'TASK'),
                ('cancelled-page', 'TASK'),
                ('non-task-page', 'NOTE');
            INSERT INTO block_properties (page_id, key, value) VALUES
                ('todo-page', 'status', 'todo'),
                ('done-page', 'status', 'done'),
                ('cancelled-page', 'status', 'cancelled'),
                ('non-task-page', 'status', 'done'),
                ('done-page', 'other', 'done');",
        )
        .unwrap();

        let counts = count_checks_by_page(&conn).unwrap();

        assert_eq!(counts.get("todo-page"), Some(&[0, 1]));
        assert_eq!(counts.get("done-page"), Some(&[1, 1]));
        assert_eq!(counts.get("cancelled-page"), Some(&[0, 1]));
        assert_eq!(counts.get("empty-page"), None);
        assert_eq!(counts.get("non-task-page"), None);
    }
}
