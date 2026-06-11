use std::fs;
use std::io::Write;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Deserializer, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::AppState;
use super::error::ApiError;
use crate::api::events::SyncNotification;
use crate::vault::kind::Kind;
use crate::vault::page::{Page, PageMeta, write_page_content};
use crate::vault::path::VaultPath;

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
        .route("/", get(get_board))
        .route("/tasks", post(create_task))
        .route("/tasks/{id}", patch(patch_task))
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

// ---------------------------------------------------------------------------
// POST /board/tasks
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_lines)]
async fn create_task(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateTaskRequest>,
) -> Result<Response, ApiError> {
    // 1. Validate inputs
    let status = body.status.as_deref().unwrap_or("INTAKE");
    validate_status(status)?;

    let priority = body.priority.as_deref().unwrap_or("P2");
    validate_priority(priority)?;

    // Normalize cycle: "BACKLOG" is treated the same as absent (no stored value)
    let cycle_opt: Option<String> = match body.cycle.as_deref() {
        None | Some("BACKLOG") => None,
        Some(c) => Some(c.to_string()),
    };

    // 2. Validate cycle exists (if specified)
    if let Some(ref cycle_code) = cycle_opt {
        ensure_cycle_exists(&state, cycle_code).await?;
    }

    // 3. Allocate code: scan TASK paths for TSK-NNNN stems, take max+1
    let next_num = state
        .index
        .with_index(|index, _vault| {
            let conn = index.connection();
            let mut stmt = conn
                .prepare("SELECT path FROM pages WHERE kind = 'TASK'")
                .unwrap();
            let paths: Vec<String> = stmt
                .query_map([], |row| row.get(0))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect();

            let max_num = paths
                .iter()
                .filter_map(|p| {
                    let stem = path_stem(p);
                    // Expect "TSK-NNNN" (case-insensitive)
                    let upper = stem.to_ascii_uppercase();
                    upper.strip_prefix("TSK-").and_then(|n| n.parse::<u32>().ok())
                })
                .max()
                .unwrap_or(0);
            max_num + 1
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let code = format!("TSK-{next_num:04}");

    // 4. Determine vault path
    let vault_path_str = match &body.project {
        Some(p) => format!("tasks/{p}/{code}.md"),
        None => format!("tasks/{code}.md"),
    };

    let vault_path = VaultPath::new(&vault_path_str)
        .map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);

    // Create parent directories
    if let Some(parent) = abs_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| ApiError::internal(format!("failed to create directories: {e}")))?;
    }

    // 5. Build PageMeta
    let mut meta = PageMeta::new();
    meta.title = Some(body.title.clone());
    meta.kind = Some(Kind::Task);
    meta.project = body.project.clone();
    if let Some(tags) = body.tags {
        meta.tags = tags;
    }

    // Board fields into extra (only set keys that have values)
    meta.extra
        .insert("status".to_string(), serde_yaml::Value::String(status.to_string()));
    meta.extra
        .insert("priority".to_string(), serde_yaml::Value::String(priority.to_string()));
    if let Some(ref c) = cycle_opt {
        meta.extra
            .insert("cycle".to_string(), serde_yaml::Value::String(c.clone()));
    }
    if let Some(ref a) = body.assignee {
        meta.extra
            .insert("assignee".to_string(), serde_yaml::Value::String(a.clone()));
    }
    if let Some(ref e) = body.estimate {
        meta.extra
            .insert("estimate".to_string(), serde_yaml::Value::String(e.clone()));
    }
    if let Some(ref d) = body.due {
        // Always write as a quoted YAML string to prevent serde_yaml emitting
        // bare dates that re-parse as non-strings
        meta.extra
            .insert("due".to_string(), serde_yaml::Value::String(d.clone()));
    }
    if let Some(ref l) = body.link {
        meta.extra
            .insert("link".to_string(), serde_yaml::Value::String(l.clone()));
    }

    // 6. Build checklist body
    let page_body = if let Some(items) = body.checklist {
        if items.is_empty() {
            String::new()
        } else {
            items
                .iter()
                .map(|item| format!("- [ ] {item}\n"))
                .collect::<String>()
        }
    } else {
        String::new()
    };

    // 7. Atomic write with create_new=true
    let content = write_page_content(&meta, &page_body);
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&abs_path)
    {
        Ok(mut file) => {
            file.write_all(content.as_bytes())
                .map_err(|e| ApiError::internal(format!("failed to write file: {e}")))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // Paranoia path: bump by one and retry once
            let vault_path_str2 = match &body.project {
                Some(p) => format!("tasks/{p}/TSK-{:04}.md", next_num + 1),
                None => format!("tasks/TSK-{:04}.md", next_num + 1),
            };
            let vault_path2 = VaultPath::new(&vault_path_str2)
                .map_err(|e| ApiError::internal(format!("invalid retry path: {e}")))?;
            let abs_path2 = state.vault.resolve(&vault_path2);
            let code2 = format!("TSK-{:04}", next_num + 1);
            // Plain (non-atomic) write by design: at single-user scale a second
            // consecutive collision is not worth guarding against.
            let content2 = write_page_content(&meta, &page_body);
            fs::write(&abs_path2, &content2)
                .map_err(|e| ApiError::internal(format!("failed to write retry file: {e}")))?;
            // Re-index the retry file and return
            let vp2 = vault_path2.clone();
            state
                .index
                .with_index(move |index, vault| {
                    index.index_page(vault, &vp2)?;
                    index.resolve_links_for_page(&vp2)?;
                    Ok::<_, crate::vault::index::IndexError>(())
                })
                .await
                .map_err(|e| ApiError::internal(e.to_string()))?
                .map_err(|e| ApiError::internal(e.to_string()))?;
            let _ = state.change_tx.send(SyncNotification::IndexChanged {
                upserted: vec![vault_path_str2.clone()],
                removed: vec![],
            });
            let task_dto = build_board_task_dto(&state, &vault_path2, &code2).await?;
            return Ok((StatusCode::CREATED, Json(task_dto)).into_response());
        }
        Err(e) => {
            return Err(ApiError::internal(format!("failed to create file: {e}")));
        }
    }

    // 8. Re-index + resolve links + broadcast
    {
        let vp = vault_path.clone();
        state
            .index
            .with_index(move |index, vault| {
                index.index_page(vault, &vp)?;
                index.resolve_links_for_page(&vp)?;
                Ok::<_, crate::vault::index::IndexError>(())
            })
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?
            .map_err(|e| ApiError::internal(e.to_string()))?;
    }

    let _ = state.change_tx.send(SyncNotification::IndexChanged {
        upserted: vec![vault_path_str.clone()],
        removed: vec![],
    });

    // 9. Build and return BoardTask DTO
    let task_dto = build_board_task_dto(&state, &vault_path, &code).await?;
    Ok((StatusCode::CREATED, Json(task_dto)).into_response())
}

// ---------------------------------------------------------------------------
// PATCH /board/tasks/{id}
// ---------------------------------------------------------------------------

async fn patch_task(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<PatchTaskRequest>,
) -> Result<Json<BoardTask>, ApiError> {
    // 0. Normalize + validate the tri-state cycle field up front, while the
    // index is reachable via `state` (the later tri-state application runs on
    // an already-loaded PageMeta). "BACKLOG" is the no-cycle sentinel: setting
    // it behaves exactly like null (clear the key). Any other set value must
    // match an existing CYCLE page stem, same rule as POST.
    let cycle_field: Option<Option<String>> = match body.cycle {
        Some(Some(ref c)) if c == "BACKLOG" => Some(None),
        Some(Some(ref c)) => {
            ensure_cycle_exists(&state, c).await?;
            Some(Some(c.clone()))
        }
        ref other => other.clone(),
    };

    // 1. Resolve path by UUID
    let id_clone = id.clone();
    let page_path = state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();
            // Must be a TASK page
            conn.query_row(
                "SELECT path FROM pages WHERE id = ?1 AND kind = 'TASK'",
                params![id_clone],
                |row| row.get::<_, String>(0),
            )
            .ok()
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .ok_or_else(|| ApiError::not_found(format!("task not found with id: {id}")))?;

    let vault_path = VaultPath::new(&page_path)
        .map_err(|e| ApiError::internal(format!("invalid stored path: {e}")))?;
    let abs_path = state.vault.resolve(&vault_path);
    if !abs_path.exists() {
        return Err(ApiError::not_found(format!("task file missing: {page_path}")));
    }

    // 2. Load file
    let page = Page::from_file(&abs_path, vault_path.clone())
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    let mut meta = page.meta;
    let page_body = page.body;

    // 3. Apply mutations
    if let Some(title) = body.title {
        meta.title = Some(title);
    }
    if let Some(tags) = body.tags {
        meta.tags = tags;
    }

    // status (validate)
    if let Some(ref status) = body.status {
        validate_status(status)?;
        meta.extra
            .insert("status".to_string(), serde_yaml::Value::String(status.clone()));
    }

    // priority (validate)
    if let Some(ref priority) = body.priority {
        validate_priority(priority)?;
        meta.extra
            .insert("priority".to_string(), serde_yaml::Value::String(priority.clone()));
    }

    // tri-state fields (cycle already validated/normalized above)
    apply_tri_state(&mut meta, "cycle", &cycle_field);
    apply_tri_state(&mut meta, "assignee", &body.assignee);
    apply_tri_state(&mut meta, "estimate", &body.estimate);
    apply_tri_state(&mut meta, "due", &body.due);
    apply_tri_state(&mut meta, "hold", &body.hold);
    apply_tri_state(&mut meta, "link", &body.link);

    // project change: update meta.project. An empty string is an explicit
    // clear (mirrors pages-assign's clear_project). The refile route differs:
    // a set project goes through the conservative reconcile_page, but a clear
    // must use project_path_cleared + move_page_to — the conservative
    // projection never strips a subfolder when project is absent, so
    // reconcile_page alone would leave the file orphaned in the old folder.
    let project_cleared = matches!(body.project.as_deref(), Some(""));
    let project_changed = body.project.is_some() && !project_cleared;
    if project_cleared {
        meta.project = None;
    } else if let Some(ref p) = body.project {
        meta.project = Some(p.clone());
    }

    // 4. Bump updated_at
    meta.updated_at = Some(Utc::now());

    // 5. Write file
    let content = write_page_content(&meta, &page_body);
    fs::write(&abs_path, &content)
        .map_err(|e| ApiError::internal(format!("failed to write file: {e}")))?;

    // 6. Invalidate + reindex + resolve + refile (handles project change/clear)
    let path_for_index = page_path.clone();
    let hooks = Arc::clone(&state.hooks);
    let declared_kind = meta.kind;
    let final_path = state
        .index
        .with_index(move |index, vault| {
            let vp = VaultPath::new(&path_for_index)
                .map_err(|e| crate::vault::index::IndexError::Other(e.to_string()))?;
            index.invalidate_links_to(&vp)?;
            index.index_page(vault, &vp)?;
            index.resolve_links_for_page(&vp)?;
            let deps = index.reverse_deps(&vp)?;
            for dep_path in &deps {
                index.resolve_links_for_page(dep_path)?;
            }
            // Refile on project change. An explicit clear strips the subfolder
            // via project_path_cleared + move_page_to (same as pages-assign's
            // clear_project branch); a set project uses the conservative
            // reconcile_page.
            let moved = if project_cleared {
                match crate::vault::projection::project_path_cleared(&path_for_index, declared_kind)
                {
                    Some(dest) => crate::vault::reconcile::move_page_to(
                        vault,
                        index,
                        &path_for_index,
                        &dest,
                        &hooks,
                    )?,
                    None => None,
                }
            } else if project_changed {
                crate::vault::reconcile::reconcile_page(
                    vault,
                    index,
                    &path_for_index,
                    &hooks,
                )?
            } else {
                None
            };
            Ok::<_, crate::vault::index::IndexError>(moved.unwrap_or(path_for_index))
        })
        .await
        .map_err(|e| ApiError::internal(format!("patch task failed: {e}")))?
        .map_err(|e| ApiError::internal(format!("patch task failed: {e}")))?;

    // 7. Broadcast
    let _ = state.change_tx.send(SyncNotification::IndexChanged {
        upserted: vec![final_path.clone()],
        removed: if final_path != page_path {
            vec![page_path.clone()]
        } else {
            vec![]
        },
    });

    // 8. Return BoardTask at final path
    let final_vp = VaultPath::new(&final_path)
        .map_err(|e| ApiError::internal(format!("invalid final path: {e}")))?;
    let code = path_stem(&final_path).to_ascii_uppercase();
    let task_dto = build_board_task_dto(&state, &final_vp, &code).await?;
    Ok(Json(task_dto))
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Row tuple for a single-task DTO query:
/// `(id, title, meta_json, project, updated_at, tags_raw)`.
type TaskDtoRow = (
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
);

/// Row tuple for the task-list query:
/// `(id, path, title, meta_json, project, updated_at, tags_raw)`.
type TaskListRow = (
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
);

/// Build a `BoardTask` DTO from the index for a given vault path + code.
/// Reads from the index to ensure consistency with the GET /board response.
async fn build_board_task_dto(
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
                                         FROM tags t WHERE t.page_id = p.id), '') \
                        FROM pages p \
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
                        ))
                    },
                )
                .ok();

            let (id_str, title, meta_json, project, updated_at, tags_raw) =
                row.ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

            let id = Uuid::parse_str(&id_str)
                .map_err(|_| rusqlite::Error::QueryReturnedNoRows)?;

            let meta: serde_json::Value =
                serde_json::from_str(&meta_json).unwrap_or(serde_json::Value::Null);

            let task_title = title.unwrap_or_else(|| code_str.clone());
            let status = extra_str(&meta, "status").unwrap_or_else(|| "INTAKE".to_string());
            let priority = extra_str(&meta, "priority").unwrap_or_else(|| "P2".to_string());
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

/// Load all TASK pages from the index as BoardTask DTOs.
/// Extracted so both GET /board and the mutation responses can use the same mapping.
fn load_tasks(conn: &rusqlite::Connection) -> Result<Vec<BoardTask>, rusqlite::Error> {
    let mut task_stmt = conn.prepare(
        "SELECT p.id, p.path, p.title, p.meta_json, p.project, p.updated_at, \
                COALESCE((SELECT group_concat(t.tag, char(31)) \
                            FROM tags t WHERE t.page_id = p.id), '') \
           FROM pages p \
          WHERE p.kind = 'TASK' \
          ORDER BY p.path",
    )?;

    let task_rows: Vec<TaskListRow> = task_stmt
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
    Ok(tasks)
}

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

/// Check that `cycle_code` matches the filename stem of an existing CYCLE
/// page (case-sensitive). Returns 400 with a hint otherwise. Shared by the
/// POST and PATCH handlers.
async fn ensure_cycle_exists(state: &AppState, cycle_code: &str) -> Result<(), ApiError> {
    let cycle_clone = cycle_code.to_string();
    let exists = state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();
            // Cycle codes are case-sensitive stems from filenames
            let mut stmt = conn.prepare("SELECT path FROM pages WHERE kind = 'CYCLE'")?;
            let paths: Vec<String> = stmt
                .query_map([], |row| row.get(0))?
                .filter_map(|r| r.ok())
                .collect();
            Ok::<_, rusqlite::Error>(
                paths.iter().any(|p| path_stem(p) == cycle_clone.as_str()),
            )
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    if !exists {
        return Err(ApiError::bad_request(format!(
            "unknown cycle: '{cycle_code}'; must match the stem of an existing CYCLE page (e.g. 'S-13')"
        )));
    }
    Ok(())
}

/// Apply a tri-state field to PageMeta.extra:
///   - `None` (key absent): no-op
///   - `Some(None)` (key present, null): remove the key
///   - `Some(Some(v))` (key present, value): set the key
///
/// Values requiring validation (status/priority/cycle) are validated by the
/// caller before this is applied.
fn apply_tri_state(meta: &mut PageMeta, key: &str, field: &Option<Option<String>>) {
    match field {
        None => {
            // absent — no change
        }
        Some(None) => {
            // null — clear the field
            meta.extra.remove(key);
        }
        Some(Some(v)) => {
            meta.extra
                .insert(key.to_string(), serde_yaml::Value::String(v.clone()));
        }
    }
}

// ---------------------------------------------------------------------------
// Read-side helpers (used by GET /board and mutation DTOs)
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
