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
use crate::vault::code::CodeFamily;
use crate::vault::kind::Kind;
use crate::vault::mutation_coordinator::{CreatePageCommand, MutationNotification};
use crate::vault::page::Page;
use crate::vault::path::VaultPath;

use super::read::build_board_task_dto;
use super::task_patch::{BoardLookups, FieldChange, TaskPatch, new_task_meta, plan_task_patch};
use super::{BoardTask, CreateTaskRequest, PatchTaskRequest, mint_unique_code, path_stem};

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
pub(crate) async fn create_task(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateTaskRequest>,
) -> Result<Response, ApiError> {
    // 1. Validate and build the meta: defaults, then the request on top.
    let lookups = BoardLookups::load(&state).await?;
    let patch = TaskPatch::from(&body);
    let meta = new_task_meta(&patch, &lookups, state.clock.now())?;

    // 2. Mint a fresh TASK Code (re-rolls on collision) and file the page
    //    under its Project, if any.
    let code = mint_unique_code(&state, CodeFamily::Task).await?;
    let vault_path_str = match &patch.project {
        FieldChange::Set(project) => {
            format!("{}/{project}/{code}.md", Kind::Task.canonical_folder())
        }
        _ => format!("{}/{code}.md", Kind::Task.canonical_folder()),
    };
    let vault_path = VaultPath::new(&vault_path_str)
        .map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    // 3. The page body: the brief first, then the checklist, separated by a
    // blank line so the two read as distinct blocks.
    let page_body = task_body(body.body.as_deref(), body.checklist.as_deref());

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

    // 4. Build and return BoardTask DTO
    let task_dto = build_board_task_dto(&state, &vault_path, &code).await?;
    Ok((StatusCode::CREATED, Json(task_dto)).into_response())
}

/// The brief first, then the checklist, separated by a blank line.
fn task_body(brief: Option<&str>, checklist: Option<&[String]>) -> String {
    let brief = brief.map(str::trim).filter(|brief| !brief.is_empty());
    let checklist = checklist
        .into_iter()
        .flatten()
        .map(|item| format!("- [ ] {item}\n"))
        .collect::<String>();
    match (brief, checklist.as_str()) {
        (None, list) => list.to_string(),
        (Some(brief), "") => format!("{brief}\n"),
        (Some(brief), list) => format!("{brief}\n\n{list}"),
    }
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
