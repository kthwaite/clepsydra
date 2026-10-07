//! Cycle mutations: `POST /board/cycles` and `PATCH /board/cycles/{id}`,
//! including the seal-with-carryover flow.

use std::fs;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};

use crate::api::AppState;
use crate::api::error::ApiError;
use crate::api::page_identity::{AttemptError, PathLock, resolve_stable_by_id};
use crate::vault::batch_mutation::{BatchMutationCommand, BatchPathIntent, ExpectedPathState};
use crate::vault::code::{self, CodeFamily};
use crate::vault::kind::Kind;
use crate::vault::mutation_coordinator::CreatePageCommand;
use crate::vault::page::{PageMeta, parse_frontmatter, write_page_content};
use crate::vault::path::VaultPath;
use crate::vault::sync::ChangeEvent;
use crate::vault::task_history::heal_task_update;

use super::cycle_patch::{CyclePatch, CyclePlan, carry_task, plan_cycle_patch};
use super::read::build_board_cycle_dto;
use super::task_patch::BoardLookups;
use super::{
    BoardCycle, CreateCycleRequest, CycleState, PatchCycleRequest, fetch_cycle_codes,
    mint_unique_code, path_stem,
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

    // 2. Determine code: explicit (must be valid format, must not collide)
    // or minted fresh.
    let code: String = match body.code {
        Some(explicit) => {
            if !code::is_valid_code(&explicit) {
                return Err(ApiError::bad_request(format!(
                    "invalid cycle code '{explicit}': expected S-<adjective>-<noun>-<tail> (see docs/adr/0003)"
                )));
            }
            let codes = fetch_cycle_codes(&state).await?;
            if codes.iter().any(|c| c == &explicit) {
                return Err(ApiError::conflict(format!(
                    "cycle already exists with code: '{explicit}'"
                )));
            }
            explicit
        }
        None => mint_unique_code(&state, CodeFamily::Cycle).await?,
    };

    // 3. Build vault path: cycles/<CODE>.md
    let vault_path_str = format!("{}/{code}.md", Kind::Cycle.canonical_folder());
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

/// The batch that executes a Cycle plan: the Cycle's own write, then one
/// write per carried-over Task. Each Task is read once here; its bytes are
/// the stale-write guard.
fn cycle_batch(
    state: &AppState,
    cycle_path: VaultPath,
    expected_cycle: String,
    cycle_body: &str,
    plan: CyclePlan,
    now: DateTime<Utc>,
) -> Result<BatchMutationCommand, ApiError> {
    let task_count = plan
        .carry_over
        .as_ref()
        .map_or(0, |carry| carry.task_paths.len());
    let mut intents = Vec::with_capacity(task_count + 1);
    let mut upserted = Vec::with_capacity(task_count + 1);
    upserted.push(cycle_path.clone());
    intents.push(BatchPathIntent::Write {
        path: cycle_path,
        expected: ExpectedPathState::Bytes(expected_cycle.into_bytes()),
        content: write_page_content(&plan.meta, cycle_body).into_bytes(),
    });

    if let Some(carry) = &plan.carry_over {
        for task_path in &carry.task_paths {
            let path =
                crate::api::error::parse_internal_path(task_path, "invalid indexed task path")?;
            let (expected, mut meta, page_body) = read_indexed_page_once(state, &path)?;
            carry_task(&mut meta, carry.to.as_deref(), now);
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
    let patch = CyclePatch::try_from(body).map_err(ApiError::from)?;
    let cycle_path = resolve_stable_by_id(
        &state,
        &id,
        Some(Kind::Cycle),
        PathLock::Release,
        || ApiError::not_found(format!("cycle not found with id: {id}")),
        |cycle_path| patch_cycle_at(&state, cycle_path, &patch),
    )
    .await?;

    Ok(Json(build_board_cycle_dto(&state, &cycle_path).await?))
}

/// One attempt at a Cycle patch on the CYCLE page at `cycle_path`: read,
/// plan, execute. Returns the Cycle's path.
async fn patch_cycle_at(
    state: &AppState,
    cycle_path: VaultPath,
    patch: &CyclePatch,
) -> Result<VaultPath, AttemptError> {
    // 1. Read once: the bytes double as the stale-write guard.
    if !state.vault.resolve(&cycle_path).exists() {
        return Err(AttemptError::Vanished(ApiError::conflict(format!(
            "page changed during mutation: {}",
            cycle_path.as_str()
        ))));
    }
    let (expected, meta, body) = read_indexed_page_once(state, &cycle_path)?;

    // 2. Plan.
    let lookups = BoardLookups::load(state).await?;
    let now = state.clock.now();
    let plan = plan_cycle_patch(path_stem(cycle_path.as_str()), meta, patch, &lookups, now)
        .map_err(ApiError::from)?;

    // 3. Execute.
    let command = cycle_batch(state, cycle_path.clone(), expected, &body, plan, now)?;
    state
        .mutation_coordinator
        .execute_batch(
            &state.vault,
            &state.index,
            Arc::clone(&state.hooks),
            command,
            crate::api::mutation_notifier(state),
        )
        .await
        .map_err(|error| AttemptError::vanished_if_not_found(crate::api::mutation_error(error)))?;
    Ok(cycle_path)
}
