//! Cycle mutations: `POST /board/cycles` and `PATCH /board/cycles/{id}`,
//! including the seal-with-carryover flow.

use std::fs;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use rusqlite::params;

use crate::api::AppState;
use crate::api::error::ApiError;
use crate::vault::batch_mutation::{
    BatchMutationCommand, BatchPathIntent, ExpectedPathState,
};
use crate::vault::kind::Kind;
use crate::vault::mutation_coordinator::CreatePageCommand;
use crate::vault::page::{PageMeta, parse_frontmatter, write_page_content};
use crate::vault::path::VaultPath;
use crate::vault::sync::ChangeEvent;
use crate::vault::task_history::heal_task_update;

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

fn read_indexed_page_once(
    state: &AppState,
    path: &VaultPath,
) -> Result<(String, PageMeta, String), ApiError> {
    let expected = fs::read(state.vault.resolve(path)).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::conflict(format!("page changed during mutation: {}", path.as_str()))
        } else {
            ApiError::internal(format!("failed to read page {}: {error}", path.as_str()))
        }
    })?;
    let expected = String::from_utf8(expected).map_err(|error| {
        ApiError::internal(format!(
            "failed to read page {} as UTF-8: {error}",
            path.as_str()
        ))
    })?;
    let (meta, body) = parse_frontmatter(&expected).map_err(|error| {
        ApiError::internal(format!("failed to parse page {}: {error}", path.as_str()))
    })?;
    Ok((expected, meta, body))
}

fn plan_cycle_patch_and_carryover(
    state: &AppState,
    cycle_path: VaultPath,
    body: &PatchCycleRequest,
    new_state: Option<CycleState>,
    task_paths: &[String],
    now: DateTime<Utc>,
) -> Result<BatchMutationCommand, ApiError> {
    let (expected_cycle, mut cycle_meta, cycle_body) =
        read_indexed_page_once(state, &cycle_path)?;
    if let Some(cycle_state) = new_state {
        cycle_meta.extra.insert(
            "state".to_string(),
            toml::Value::String(cycle_state.as_str().to_string()),
        );
    }
    if let Some(goal) = &body.goal {
        cycle_meta
            .extra
            .insert("goal".to_string(), toml::Value::String(goal.clone()));
    }
    if let Some(start) = &body.start {
        cycle_meta
            .extra
            .insert("start".to_string(), toml::Value::String(start.clone()));
    }
    if let Some(end) = &body.end {
        cycle_meta
            .extra
            .insert("end".to_string(), toml::Value::String(end.clone()));
    }
    cycle_meta.updated_at = Some(now);

    let mut intents = Vec::with_capacity(task_paths.len() + 1);
    let mut upserted = Vec::with_capacity(task_paths.len() + 1);
    upserted.push(cycle_path.clone());
    intents.push(BatchPathIntent::Write {
        path: cycle_path,
        expected: ExpectedPathState::Bytes(expected_cycle.into_bytes()),
        content: write_page_content(&cycle_meta, &cycle_body).into_bytes(),
    });

    if let Some(carry_to) = &body.carry_to {
        for task_path in task_paths {
            let path =
                crate::api::error::parse_internal_path(task_path, "invalid indexed task path")?;
            let (expected, mut meta, page_body) = read_indexed_page_once(state, &path)?;
            if carry_to == "BACKLOG" {
                meta.extra.remove("cycle");
            } else {
                meta.extra.insert(
                    "cycle".to_string(),
                    toml::Value::String(carry_to.clone()),
                );
            }
            meta.updated_at = Some(now);
            heal_task_update(&path, &expected, &mut meta).map_err(ApiError::bad_request)?;
            upserted.push(path.clone());
            intents.push(BatchPathIntent::Write {
                path,
                expected: ExpectedPathState::Bytes(expected.into_bytes()),
                content: write_page_content(&meta, &page_body).into_bytes(),
            });
        }
    }

    upserted.sort_by(|left, right| left.as_str().cmp(right.as_str()));
    Ok(BatchMutationCommand {
        intents,
        create_directories: Vec::new(),
        remove_directories: Vec::new(),
        index_events: upserted.into_iter().map(ChangeEvent::Upsert).collect(),
        moved_pages: Vec::new(),
    })
}

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

    if let Some(carry) = &body.carry_to {
        if !is_closing {
            return Err(ApiError::bad_request(
                "carry_to is only valid when state is CLOSED",
            ));
        }
        if carry != "BACKLOG" {
            ensure_cycle_exists(&state, carry).await?;
        }
    }

    let id_clone = id.clone();
    let page_path = state
        .index
        .with_index(move |index, _vault| {
            index
                .connection()
                .query_row(
                    "SELECT path FROM pages WHERE id = ?1 AND kind = 'CYCLE'",
                    params![id_clone],
                    |row| row.get::<_, String>(0),
                )
                .ok()
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::not_found(format!("cycle not found with id: {id}")))?;
    let cycle_path =
        crate::api::error::parse_internal_path(&page_path, "invalid stored cycle path")?;
    let cycle_code = path_stem(&page_path).to_string();

    if matches!(&body.carry_to, Some(carry) if carry != "BACKLOG" && carry == &cycle_code) {
        return Err(ApiError::bad_request(
            "carry_to cannot reference the cycle being closed",
        ));
    }

    let task_paths = if is_closing && body.carry_to.is_some() {
        let cycle_code_for_query = cycle_code;
        state
            .index
            .with_index(move |index, _vault| {
                let mut statement = index
                    .connection()
                    .prepare("SELECT path, meta_json FROM pages WHERE kind = 'TASK' ORDER BY path")?;
                let rows = statement
                    .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok::<_, rusqlite::Error>(
                    rows.into_iter()
                        .filter(|(_, meta_json)| {
                            let metadata: serde_json::Value = serde_json::from_str(meta_json)
                                .unwrap_or(serde_json::Value::Null);
                            extra_str(&metadata, "cycle").as_deref()
                                == Some(cycle_code_for_query.as_str())
                                && extra_str(&metadata, "status").unwrap_or_default() != "SEALED"
                        })
                        .map(|(path, _)| path)
                        .collect(),
                )
            })
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?
            .map_err(|error| ApiError::internal(error.to_string()))?
    } else {
        Vec::new()
    };

    let command = plan_cycle_patch_and_carryover(
        &state,
        cycle_path.clone(),
        &body,
        new_state,
        &task_paths,
        state.clock.now(),
    )?;
    state
        .mutation_coordinator
        .execute_batch(
            &state.vault,
            &state.index,
            Arc::clone(&state.hooks),
            command,
            crate::api::mutation_notifier(state.as_ref()),
        )
        .await
        .map_err(crate::api::mutation_error)?;

    Ok(Json(build_board_cycle_dto(&state, &cycle_path).await?))
}
