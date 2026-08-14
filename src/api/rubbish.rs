use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use utoipa::ToSchema;
use uuid::Uuid;

use super::AppState;
use super::error::ApiError;
use super::pages::EncryptionMetaResponse;
use crate::vault::mutation::{MutationOp, MutationPlanner, PurgeRubbishOutcome};
use crate::vault::page::parse_frontmatter;
use crate::vault::rubbish::{
    RubbishItemValidationError, RubbishListEntry as DomainRubbishListEntry, RubbishManifest,
    RubbishStoreError,
};

pub const RUBBISH_PREVIEW_MAX_BYTES: usize = 4096;

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct RubbishItemSummary {
    pub item_id: String,
    pub page_id: String,
    pub original_path: String,
    pub title: String,
    pub kind: String,
    pub deleted_at: String,
    pub archive_url: Option<String>,
}

impl From<&RubbishManifest> for RubbishItemSummary {
    fn from(manifest: &RubbishManifest) -> Self {
        Self {
            item_id: manifest.item_id.to_string(),
            page_id: manifest.page_id.to_string(),
            original_path: manifest.original_path.clone(),
            title: manifest.title.clone(),
            kind: manifest.kind.clone(),
            deleted_at: manifest
                .deleted_at
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            archive_url: manifest.archive_url.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RubbishListEntryDto {
    Valid { item: RubbishItemSummary },
    Invalid { item_id: String, error: String },
}

impl From<DomainRubbishListEntry> for RubbishListEntryDto {
    fn from(entry: DomainRubbishListEntry) -> Self {
        match entry {
            DomainRubbishListEntry::Valid(manifest) => Self::Valid {
                item: RubbishItemSummary::from(&manifest),
            },
            DomainRubbishListEntry::Invalid { item_id, error } => Self::Invalid { item_id, error },
        }
    }
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct RubbishItemPreview {
    pub body: String,
    pub truncated: bool,
    pub read_only: bool,
    pub encrypted: bool,
    pub encryption: Option<EncryptionMetaResponse>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct RubbishItemDetail {
    pub item: RubbishItemSummary,
    pub preview: RubbishItemPreview,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct RubbishRestoreResponse {
    pub item_id: String,
    pub page_id: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct RubbishPurgeResponse {
    pub item_id: String,
    pub page_id: String,
    pub original_path: String,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum EmptyRubbishItemOutcome {
    Purged { item: RubbishPurgeResponse },
    Failed { item_id: String, error: String },
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct EmptyRubbishResponse {
    pub outcomes: Vec<EmptyRubbishItemOutcome>,
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_rubbish).delete(empty_rubbish))
        .route("/{item_id}/restore", post(restore_rubbish_item))
        .route(
            "/{item_id}",
            get(get_rubbish_item).delete(purge_rubbish_item),
        )
}

fn parse_item_id(item_id: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(item_id).map_err(|error| {
        ApiError::bad_request(format!("invalid rubbish item ID {item_id:?}: {error}"))
    })
}

fn store_read_error(item_id: &str, error: RubbishStoreError) -> ApiError {
    match &error {
        RubbishStoreError::InvalidItem {
            source: RubbishItemValidationError::MalformedItemId { .. },
            ..
        } => ApiError::bad_request(error.to_string()),
        RubbishStoreError::Filesystem {
            operation, source, ..
        } if matches!(
            *operation,
            "inspect rubbish root" | "inspect rubbish item directory"
        ) && source.kind() == std::io::ErrorKind::NotFound =>
        {
            ApiError::not_found(format!("rubbish item not found: {item_id}"))
        }
        _ => ApiError::internal(error.to_string()),
    }
}

fn truncate_preview(body: &str) -> (String, bool) {
    if body.len() <= RUBBISH_PREVIEW_MAX_BYTES {
        return (body.to_owned(), false);
    }
    let mut end = RUBBISH_PREVIEW_MAX_BYTES;
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    (body[..end].to_owned(), true)
}

#[utoipa::path(
    get,
    path = "/rubbish",
    context_path = "/api/vault",
    tag = "Rubbish",
    responses(
        (status = 200, description = "Newest-first valid rubbish items followed by invalid item rows", body = [RubbishListEntryDto]),
        (status = 500, description = "Rubbish catalog could not be read", body = ApiError)
    )
)]
pub async fn list_rubbish(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<RubbishListEntryDto>>, ApiError> {
    let entries = state
        .index
        .with_index(|index, _| index.rubbish_entries())
        .await
        .map_err(|error| ApiError::internal(format!("rubbish catalog read failed: {error}")))?
        .map_err(|error| ApiError::internal(format!("rubbish catalog read failed: {error}")))?;
    Ok(Json(entries.into_iter().map(Into::into).collect()))
}

#[utoipa::path(
    get,
    path = "/rubbish/{item_id}",
    context_path = "/api/vault",
    tag = "Rubbish",
    params(("item_id" = String, Path, description = "Opaque rubbish lifecycle UUID")),
    responses(
        (status = 200, description = "Rubbish lifecycle metadata and bounded read-only preview", body = RubbishItemDetail),
        (status = 400, description = "Malformed rubbish item UUID", body = ApiError),
        (status = 404, description = "Rubbish item not found", body = ApiError),
        (status = 500, description = "Rubbish item is invalid or unreadable", body = ApiError)
    )
)]
pub async fn get_rubbish_item(
    State(state): State<Arc<AppState>>,
    Path(item_id): Path<String>,
) -> Result<Json<RubbishItemDetail>, ApiError> {
    parse_item_id(&item_id)?;
    let store = state.rubbish.clone();
    let read_item_id = item_id.clone();
    let item = tokio::task::spawn_blocking(move || store.read_item(&read_item_id))
        .await
        .map_err(|error| ApiError::internal(format!("rubbish detail task failed: {error}")))?
        .map_err(|error| store_read_error(&item_id, error))?;
    let content = std::str::from_utf8(&item.bytes).map_err(|error| {
        ApiError::internal(format!("rubbish item {item_id} page is not UTF-8: {error}"))
    })?;
    let (meta, body) = parse_frontmatter(content).map_err(|error| {
        ApiError::internal(format!(
            "rubbish item {item_id} page metadata is invalid: {error}"
        ))
    })?;
    if meta.id != item.manifest.page_id {
        return Err(ApiError::internal(format!(
            "rubbish item {item_id} page ID {} does not match manifest page ID {}",
            meta.id, item.manifest.page_id
        )));
    }
    let encrypted = meta.encryption.is_some();
    let encryption = meta.encryption.as_ref().map(EncryptionMetaResponse::from);
    let (body, truncated) = truncate_preview(&body);
    Ok(Json(RubbishItemDetail {
        item: RubbishItemSummary::from(&item.manifest),
        preview: RubbishItemPreview {
            body,
            truncated,
            read_only: true,
            encrypted,
            encryption,
        },
    }))
}

#[utoipa::path(
    post,
    path = "/rubbish/{item_id}/restore",
    context_path = "/api/vault",
    tag = "Rubbish",
    params(("item_id" = String, Path, description = "Opaque rubbish lifecycle UUID")),
    responses(
        (status = 200, description = "Rubbish item restored to its original page path", body = RubbishRestoreResponse),
        (status = 400, description = "Malformed rubbish item UUID", body = ApiError),
        (status = 404, description = "Rubbish item not found", body = ApiError),
        (status = 409, description = "Original page path is occupied or item state drifted", body = ApiError),
        (status = 500, description = "Rubbish item could not be restored", body = ApiError)
    )
)]
pub async fn restore_rubbish_item(
    State(state): State<Arc<AppState>>,
    Path(item_id): Path<String>,
) -> Result<Json<RubbishRestoreResponse>, ApiError> {
    parse_item_id(&item_id)?;
    let store = state.rubbish.clone();
    let read_item_id = item_id.clone();
    let item = tokio::task::spawn_blocking(move || store.read_item(&read_item_id))
        .await
        .map_err(|error| ApiError::internal(format!("rubbish restore read task failed: {error}")))?
        .map_err(|error| store_read_error(&item_id, error))?;
    let response = RubbishRestoreResponse {
        item_id: item.manifest.item_id.to_string(),
        page_id: item.manifest.page_id.to_string(),
        path: item.manifest.original_path.clone(),
    };
    let operation = MutationOp::RestorePage { item };
    let command = state
        .index
        .with_index(move |index, vault| {
            MutationPlanner::new(vault, index)
                .plan(&operation)?
                .into_batch_command(vault)
        })
        .await
        .map_err(|error| ApiError::internal(format!("restore planning failed: {error}")))?
        .map_err(|error| ApiError::internal(format!("restore planning failed: {error}")))?;
    state
        .mutation_coordinator
        .execute_batch(
            &state.vault,
            &state.index,
            Arc::clone(&state.hooks),
            command,
            super::mutation_notifier(&state),
        )
        .await
        .map_err(super::mutation_error)?;
    Ok(Json(response))
}

#[utoipa::path(
    delete,
    path = "/rubbish/{item_id}",
    context_path = "/api/vault",
    tag = "Rubbish",
    params(("item_id" = String, Path, description = "Opaque rubbish lifecycle UUID")),
    responses(
        (status = 200, description = "Rubbish item permanently purged", body = RubbishPurgeResponse),
        (status = 400, description = "Malformed rubbish item UUID", body = ApiError),
        (status = 404, description = "Rubbish item not found", body = ApiError),
        (status = 500, description = "Rubbish item cleanup or removal failed", body = ApiError)
    )
)]
pub async fn purge_rubbish_item(
    State(state): State<Arc<AppState>>,
    Path(item_id): Path<String>,
) -> Result<Json<RubbishPurgeResponse>, ApiError> {
    let result = state
        .mutation_coordinator
        .purge_rubbish(&state.vault, &state.index, Arc::clone(&state.cas), &item_id)
        .await
        .map_err(super::mutation_error)?;
    Ok(Json(RubbishPurgeResponse {
        item_id: result.item_id.to_string(),
        page_id: result.page_id.to_string(),
        original_path: result.original_path,
    }))
}

#[utoipa::path(
    delete,
    path = "/rubbish",
    context_path = "/api/vault",
    tag = "Rubbish",
    responses(
        (status = 200, description = "Ordered per-item outcomes for the initial valid-item snapshot", body = EmptyRubbishResponse),
        (status = 500, description = "Rubbish Bin could not be enumerated", body = ApiError)
    )
)]
pub async fn empty_rubbish(
    State(state): State<Arc<AppState>>,
) -> Result<Json<EmptyRubbishResponse>, ApiError> {
    let result = state
        .mutation_coordinator
        .empty_rubbish(&state.vault, &state.index, Arc::clone(&state.cas))
        .await
        .map_err(super::mutation_error)?;
    let outcomes = result
        .outcomes
        .into_iter()
        .map(|outcome| match outcome {
            PurgeRubbishOutcome::Purged(item) => EmptyRubbishItemOutcome::Purged {
                item: RubbishPurgeResponse {
                    item_id: item.item_id.to_string(),
                    page_id: item.page_id.to_string(),
                    original_path: item.original_path,
                },
            },
            PurgeRubbishOutcome::Failed { item_id, error } => EmptyRubbishItemOutcome::Failed {
                item_id: item_id.to_string(),
                error,
            },
        })
        .collect();
    Ok(Json(EmptyRubbishResponse { outcomes }))
}
