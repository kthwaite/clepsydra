//! Task mutations: `POST /board/tasks` and `PATCH /board/tasks/{id}`.

use std::fs;
use std::io::Write;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use rusqlite::params;

use crate::api::AppState;
use crate::api::error::ApiError;
use crate::api::events::SyncNotification;
use crate::vault::kind::Kind;
use crate::vault::page::{Page, PageMeta, write_page_content};
use crate::vault::path::VaultPath;

use super::read::build_board_task_dto;
use super::{
    BoardTask, CreateTaskRequest, PatchTaskRequest, ensure_cycle_exists, path_stem,
    reserve_next_code_number, validate_priority, validate_status,
};

// ---------------------------------------------------------------------------
// POST /board/tasks
// ---------------------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/board/tasks",
    context_path = "/api/vault",
    tag = "Board",
    request_body = CreateTaskRequest,
    responses(
        (status = 201, description = "Task created", body = BoardTask),
        (status = 400, description = "Invalid input", body = crate::api::error::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::error::ApiError)
    )
)]
#[allow(clippy::too_many_lines)]
pub(crate) async fn create_task(
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

    // 3. Reserve the next TASK code through the index transaction.
    let next_num = reserve_next_code_number(&state, "TASK", "TSK-").await?;
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
    meta.extra.insert(
        "status".to_string(),
        serde_yaml::Value::String(status.to_string()),
    );
    meta.extra.insert(
        "priority".to_string(),
        serde_yaml::Value::String(priority.to_string()),
    );
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
            return Err(ApiError::conflict(format!(
                "task file already exists: {vault_path_str}"
            )));
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

#[utoipa::path(
    patch,
    path = "/board/tasks/{id}",
    context_path = "/api/vault",
    tag = "Board",
    params(("id" = String, Path, description = "Task UUID")),
    request_body = PatchTaskRequest,
    responses(
        (status = 200, description = "Task updated", body = BoardTask),
        (status = 400, description = "Invalid input", body = crate::api::error::ApiError),
        (status = 404, description = "Task not found", body = crate::api::error::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::error::ApiError)
    )
)]
pub(crate) async fn patch_task(
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
        return Err(ApiError::not_found(format!(
            "task file missing: {page_path}"
        )));
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
        meta.extra.insert(
            "status".to_string(),
            serde_yaml::Value::String(status.clone()),
        );
    }

    // priority (validate)
    if let Some(ref priority) = body.priority {
        validate_priority(priority)?;
        meta.extra.insert(
            "priority".to_string(),
            serde_yaml::Value::String(priority.clone()),
        );
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
                crate::vault::reconcile::reconcile_page(vault, index, &path_for_index, &hooks)?
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
// Helpers
// ---------------------------------------------------------------------------

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
