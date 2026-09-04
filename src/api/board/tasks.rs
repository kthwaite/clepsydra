//! Task mutations: `POST /board/tasks` and `PATCH /board/tasks/{id}`.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use rusqlite::params;

use crate::api::AppState;
use crate::api::error::ApiError;
use crate::api::events::SyncNotification;
use crate::vault::board_vocab::{DEFAULT_PRIORITY, DEFAULT_STATUS};
use crate::vault::code::CodeFamily;
use crate::vault::kind::Kind;
use crate::vault::mutation_coordinator::{CreatePageCommand, MutationNotification};
use crate::vault::page::{Page, PageMeta};
use crate::vault::path::VaultPath;

use super::read::build_board_task_dto;
use super::task_patch::{BoardLookups, TaskPatch, plan_task_patch};
use super::{
    BoardTask, CreateTaskRequest, PatchTaskRequest, ensure_cycle_exists, mint_unique_code,
    path_stem, validate_priority, validate_status,
};
use crate::api::projects::ensure_project_exists;

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
    let status = body.status.as_deref().unwrap_or(DEFAULT_STATUS);
    validate_status(status)?;

    let priority = body.priority.as_deref().unwrap_or(DEFAULT_PRIORITY);
    validate_priority(priority)?;

    // Normalize cycle: "BACKLOG" is treated the same as absent (no stored value)
    let cycle_opt: Option<String> = match body.cycle.as_deref() {
        None | Some("BACKLOG") => None,
        Some(c) => Some(c.to_string()),
    };

    // 2. Validate cycle exists (if specified); resolve to its canonical code
    // (exact match or unique prefix) so what gets stored is always the stem.
    let cycle_opt: Option<String> = match cycle_opt {
        Some(cycle_code) => Some(ensure_cycle_exists(&state, &cycle_code).await?),
        None => None,
    };

    // 2b. Validate the project exists (if specified): the slug must be
    // declared by a PROJECT page, so a typo cannot file the task under a
    // folder no project backs.
    if let Some(project) = body.project.as_deref().filter(|p| !p.is_empty()) {
        ensure_project_exists(&state, project).await?;
    }

    // 3. Mint a fresh TASK code (re-rolls on collision).
    let code = mint_unique_code(&state, CodeFamily::Task).await?;

    // 4. Determine vault path
    let vault_path_str = match &body.project {
        Some(p) => format!("{}/{p}/{code}.md", Kind::Task.canonical_folder()),
        None => format!("{}/{code}.md", Kind::Task.canonical_folder()),
    };

    let vault_path = VaultPath::new(&vault_path_str)
        .map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

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
        toml::Value::String(status.to_string()),
    );
    meta.extra.insert(
        "priority".to_string(),
        toml::Value::String(priority.to_string()),
    );
    if let Some(ref c) = cycle_opt {
        meta.extra
            .insert("cycle".to_string(), toml::Value::String(c.clone()));
    }
    if let Some(ref a) = body.assignee {
        meta.extra
            .insert("assignee".to_string(), toml::Value::String(a.clone()));
    }
    if let Some(ref e) = body.estimate {
        meta.extra
            .insert("estimate".to_string(), toml::Value::String(e.clone()));
    }
    if let Some(ref d) = body.due {
        // Always write as a quoted YAML string to prevent serde_yaml emitting
        // bare dates that re-parse as non-strings
        meta.extra
            .insert("due".to_string(), toml::Value::String(d.clone()));
    }
    if let Some(ref s) = body.start {
        meta.extra
            .insert("start".to_string(), toml::Value::String(s.clone()));
    }
    if let Some(ref l) = body.link {
        meta.extra
            .insert("link".to_string(), toml::Value::String(l.clone()));
    }
    // 6. Build the page body: the brief first, then the checklist, separated
    // by a blank line so the two read as distinct blocks.
    let brief = body
        .body
        .as_deref()
        .map(str::trim)
        .filter(|brief| !brief.is_empty());
    let checklist = body
        .checklist
        .iter()
        .flatten()
        .map(|item| format!("- [ ] {item}\n"))
        .collect::<String>();
    let page_body = match (brief, checklist.as_str()) {
        (None, list) => list.to_string(),
        (Some(brief), "") => format!("{brief}\n"),
        (Some(brief), list) => format!("{brief}\n\n{list}"),
    };

    let notify = crate::api::mutation_notifier(state.as_ref());
    state
        .mutation_coordinator
        .create_page(
            &state.vault,
            &state.index,
            CreatePageCommand {
                path: vault_path.clone(),
                meta,
                body: page_body,
            },
            notify,
        )
        .await
        .map_err(crate::api::mutation_error)?;

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
        (status = 409, description = "Destination or stale mutation conflict", body = crate::api::error::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::error::ApiError)
    )
)]
pub(crate) async fn patch_task(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<PatchTaskRequest>,
) -> Result<Json<BoardTask>, ApiError> {
    // 1. Resolve the TASK page by UUID.
    let id_clone = id.clone();
    let page_path = state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();
            // Must be a TASK page
            conn.query_row(
                "SELECT path FROM pages WHERE id = ?1 AND kind = ?2",
                params![id_clone, Kind::Task.as_str()],
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

    // 2. Read once: `raw_content` doubles as the stale-write guard.
    let page = Page::from_file(&abs_path, vault_path)
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    // 3. Plan the Task Patch.
    let lookups = BoardLookups::load(&state).await?;
    let patch = TaskPatch::from(body);
    let command = plan_task_patch(page, &patch, &lookups, state.clock.now())?;

    // 4. Execute.
    let notify = |notification: MutationNotification| {
        let _ = state.change_tx.send(SyncNotification::IndexChanged {
            upserted: notification.upserted,
            removed: notification.removed,
        });
    };
    let result = state
        .mutation_coordinator
        .update_page(
            &state.vault,
            &state.index,
            Arc::clone(&state.hooks),
            command,
            &notify,
        )
        .await
        .map_err(crate::api::mutation_error)?;

    let code = path_stem(result.path.as_str()).to_string();
    let task_dto = build_board_task_dto(&state, &result.path, &code).await?;
    Ok(Json(task_dto))
}
