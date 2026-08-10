//! Cycle mutations: `POST /board/cycles` and `PATCH /board/cycles/{id}`,
//! including the seal-with-carryover flow.

use std::fs;
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
use crate::vault::mutation_coordinator::{
    CreatePageCommand, MutationNotification, ProjectAssignment, UpdatePageCommand,
};
use crate::vault::page::{Page, PageMeta};

use super::read::build_board_cycle_dto;
use super::{
    BoardCycle, CreateCycleRequest, CycleState, PatchCycleRequest, ensure_cycle_exists, extra_str,
    fetch_cycle_codes, path_stem, reserve_next_code_number,
};

// ---------------------------------------------------------------------------
// POST /board/cycles
// ---------------------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/board/cycles",
    context_path = "/api/vault",
    tag = "Board",
    request_body = CreateCycleRequest,
    responses(
        (status = 201, description = "Cycle created", body = BoardCycle),
        (status = 400, description = "Invalid input", body = crate::api::error::ApiError),
        (status = 409, description = "Cycle already exists", body = crate::api::error::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::error::ApiError)
    )
)]
pub(crate) async fn create_cycle(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateCycleRequest>,
) -> Result<Response, ApiError> {
    // 1. Parse the state independently from creation-time policy.
    let cycle_state = body
        .state
        .as_deref()
        .unwrap_or("PLANNED")
        .parse::<CycleState>()
        .map_err(|error| {
            ApiError::bad_request(format!(
                "{error}; valid values at creation: PLANNED, ACTIVE"
            ))
        })?;
    if cycle_state == CycleState::Closed {
        return Err(ApiError::bad_request(
            "state 'CLOSED' is not valid at cycle creation time",
        ));
    }

    // 2. Determine code: explicit (must not collide) or auto-generated
    let code: String = match body.code {
        Some(explicit) => {
            let codes = fetch_cycle_codes(&state).await?;
            if codes.iter().any(|c| c == &explicit) {
                return Err(ApiError::conflict(format!(
                    "cycle already exists with code: '{explicit}'"
                )));
            }
            explicit
        }
        None => {
            // Auto-generate from a transactional CYCLE-family reservation.
            let next_num = reserve_next_code_number(&state, "CYCLE", "S-").await?;
            format!("S-{next_num}")
        }
    };

    // 3. Build vault path: cycles/<CODE>.md
    let vault_path_str = format!("cycles/{code}.md");
    let vault_path = crate::api::error::parse_internal_path(&vault_path_str, "invalid path")?;

    // 4. Build PageMeta
    let mut meta = PageMeta::new();
    meta.title = Some(body.label.clone());
    meta.kind = Some(Kind::Cycle);

    meta.extra.insert(
        "state".to_string(),
        toml::Value::String(cycle_state.as_str().to_string()),
    );
    meta.extra
        .insert("start".to_string(), toml::Value::String(body.start.clone()));
    meta.extra
        .insert("end".to_string(), toml::Value::String(body.end.clone()));
    if let Some(ref g) = body.goal {
        meta.extra
            .insert("goal".to_string(), toml::Value::String(g.clone()));
    }

    let notify = crate::api::mutation_notifier(state.as_ref());
    state
        .mutation_coordinator
        .create_page(
            &state.vault,
            &state.index,
            CreatePageCommand {
                path: vault_path.clone(),
                meta,
                body: String::new(),
            },
            notify,
        )
        .await
        .map_err(crate::api::mutation_error)?;

    // 7. Build and return BoardCycle DTO
    let cycle_dto = build_board_cycle_dto(&state, &vault_path).await?;
    Ok((StatusCode::CREATED, Json(cycle_dto)).into_response())
}

// ---------------------------------------------------------------------------
// PATCH /board/cycles/{id}
// ---------------------------------------------------------------------------

#[utoipa::path(
    patch,
    path = "/board/cycles/{id}",
    context_path = "/api/vault",
    tag = "Board",
    params(("id" = String, Path, description = "Cycle UUID")),
    request_body = PatchCycleRequest,
    responses(
        (status = 200, description = "Cycle updated", body = BoardCycle),
        (status = 400, description = "Invalid input", body = crate::api::error::ApiError),
        (status = 404, description = "Cycle not found", body = crate::api::error::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::error::ApiError)
    )
)]
#[allow(clippy::too_many_lines)]
pub(crate) async fn patch_cycle(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<PatchCycleRequest>,
) -> Result<Json<BoardCycle>, ApiError> {
    // 1. Parse state if present. Patching permits every valid lifecycle state.
    let new_state = body
        .state
        .as_deref()
        .map(|value| {
            value.parse::<CycleState>().map_err(|error| {
                ApiError::bad_request(format!("{error}; valid values: PLANNED, ACTIVE, CLOSED"))
            })
        })
        .transpose()?;

    let is_closing = new_state == Some(CycleState::Closed);

    // 2. Validate carry_to: only meaningful when closing; must be "BACKLOG"
    // or an existing CYCLE stem (self-reference is rejected below once this
    // cycle's own code is known).
    if let Some(ref carry) = body.carry_to {
        if !is_closing {
            return Err(ApiError::bad_request(
                "carry_to is only valid when state is CLOSED",
            ));
        }
        if carry != "BACKLOG" {
            ensure_cycle_exists(&state, carry).await?;
        }
    }

    // 3. Resolve cycle by UUID — must be CYCLE kind
    let id_clone = id.clone();
    let page_path = state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();
            conn.query_row(
                "SELECT path FROM pages WHERE id = ?1 AND kind = 'CYCLE'",
                params![id_clone],
                |row| row.get::<_, String>(0),
            )
            .ok()
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .ok_or_else(|| ApiError::not_found(format!("cycle not found with id: {id}")))?;

    let vault_path = crate::api::error::parse_internal_path(&page_path, "invalid stored path")?;
    let abs_path = state.vault.resolve(&vault_path);
    if !abs_path.exists() {
        return Err(ApiError::not_found(format!(
            "cycle file missing: {page_path}"
        )));
    }

    // 4. Load the cycle file
    let expected_content = fs::read_to_string(&abs_path)
        .map_err(|e| ApiError::internal(format!("failed to read cycle page: {e}")))?;
    let page = Page::from_file(&abs_path, vault_path.clone())
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;
    let mut meta = page.meta;
    let page_body = page.body;

    // Derive this cycle's code from its path stem (same canonical derivation
    // as build_board_cycle_dto and the GET /board aggregation).
    let cycle_code = path_stem(&page_path).to_string();

    // Extra guard: carry_to must not be the same cycle (self-reference)
    if matches!(&body.carry_to, Some(carry) if carry != "BACKLOG" && carry == &cycle_code) {
        return Err(ApiError::bad_request(
            "carry_to cannot reference the cycle being closed",
        ));
    }

    // 5. Apply cycle field mutations
    if let Some(cycle_state) = new_state {
        meta.extra.insert(
            "state".to_string(),
            toml::Value::String(cycle_state.as_str().to_string()),
        );
    }
    if let Some(ref g) = body.goal {
        meta.extra
            .insert("goal".to_string(), toml::Value::String(g.clone()));
    }
    if let Some(ref s) = body.start {
        meta.extra
            .insert("start".to_string(), toml::Value::String(s.clone()));
    }
    if let Some(ref e) = body.end {
        meta.extra
            .insert("end".to_string(), toml::Value::String(e.clone()));
    }

    // 6. Bump updated_at and update the cycle through the mutation policy.
    meta.updated_at = Some(Utc::now());
    let notify = |notification: MutationNotification| {
        let _ = state.change_tx.send(SyncNotification::IndexChanged {
            upserted: notification.upserted,
            removed: notification.removed,
        });
    };
    state
        .mutation_coordinator
        .update_page(
            &state.vault,
            &state.index,
            Arc::clone(&state.hooks),
            UpdatePageCommand {
                path: vault_path.clone(),
                expected_content,
                meta,
                body: page_body,
                project: ProjectAssignment::Unchanged,
                reconcile: false,
            },
            &notify,
        )
        .await
        .map_err(crate::api::mutation_error)?;

    // 7. Carryover: only when closing AND carry_to is set
    //
    // Find all TASK pages with extra.cycle == this cycle's code AND status != "SEALED".
    // For each, rewrite frontmatter (cycle removed for BACKLOG, or set to target code),
    // bump updated_at, write, and reindex.
    //
    // No cross-file transaction — acceptable by design per ADR 0001 reconcile posture.
    // Failure of an individual rewrite is surfaced as 500 (first error wins) but the
    // cycle page itself has already been updated.

    if is_closing && let Some(ref carry) = body.carry_to {
        // Collect task paths to rewrite. One statement fetches path +
        // meta_json for all TASK pages; the cycle/status filter runs in Rust.
        let cycle_code_for_query = cycle_code.clone();
        let task_paths: Vec<String> = state
            .index
            .with_index(move |index, _vault| {
                let conn = index.connection();
                let mut stmt = conn.prepare(
                    "SELECT path, meta_json FROM pages WHERE kind = 'TASK' ORDER BY path",
                )?;
                let rows: Vec<(String, String)> = stmt
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<Result<_, _>>()?;

                let matched = rows
                    .into_iter()
                    .filter(|(_, meta_json)| {
                        let v: serde_json::Value =
                            serde_json::from_str(meta_json).unwrap_or(serde_json::Value::Null);
                        extra_str(&v, "cycle").as_deref() == Some(cycle_code_for_query.as_str())
                            && extra_str(&v, "status").unwrap_or_default() != "SEALED"
                    })
                    .map(|(path, _)| path)
                    .collect();
                Ok::<_, rusqlite::Error>(matched)
            })
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?
            .map_err(|e| ApiError::internal(e.to_string()))?;

        // Rewrite each matched task
        for task_path in task_paths {
            let tvp = crate::api::error::parse_internal_path(&task_path, "invalid task path")?;
            let tabs_path = state.vault.resolve(&tvp);
            if !tabs_path.exists() {
                continue; // stale index entry — skip
            }
            let expected_task_content = fs::read_to_string(&tabs_path)
                .map_err(|e| ApiError::internal(format!("failed to read task: {e}")))?;
            let task_page = Page::from_file(&tabs_path, tvp.clone())
                .map_err(|e| ApiError::internal(format!("failed to read task: {e}")))?;
            let mut task_meta = task_page.meta;
            let task_body = task_page.body;

            if carry == "BACKLOG" {
                task_meta.extra.remove("cycle");
            } else {
                task_meta
                    .extra
                    .insert("cycle".to_string(), toml::Value::String(carry.clone()));
            }
            let now = Utc::now();
            task_meta.updated_at = Some(now);

            state
                .mutation_coordinator
                .update_page(
                    &state.vault,
                    &state.index,
                    Arc::clone(&state.hooks),
                    UpdatePageCommand {
                        path: tvp,
                        expected_content: expected_task_content,
                        meta: task_meta,
                        body: task_body,
                        project: ProjectAssignment::Unchanged,
                        reconcile: false,
                    },
                    &notify,
                )
                .await
                .map_err(crate::api::mutation_error)?;
        }
    }

    // 9. Return updated BoardCycle DTO
    let cycle_dto = build_board_cycle_dto(&state, &vault_path).await?;
    Ok(Json(cycle_dto))
}
