use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::error::ApiError;
use super::{AppState, mutation_error, mutation_notifier};
use crate::vault::block_id::generate_short_id;
use crate::vault::conversation::{
    AppendDecision, ConversationError, ConversationLedger, ConversationRole, ConversationTurn,
    append_rendered_turns, host_identity_hash, prepare_transcript, read_ledger, render_turns,
    verify_append, write_ledger,
};
use crate::vault::kind::Kind;
use crate::vault::mutation_coordinator::{CreatePageCommand, ProjectAssignment, UpdatePageCommand};
use crate::vault::new_note::build_projected_note_path;
use crate::vault::page::{Page, PageMeta};
use crate::vault::path::VaultPath;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
#[schema(rename_all = "lowercase")]
pub enum ConversationRoleRequest {
    User,
    Assistant,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CaptureConversationTurnRequest {
    pub role: ConversationRoleRequest,
    pub content: String,
    pub source_turn_id: Option<String>,
    pub timestamp: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CaptureConversationRequest {
    pub title: String,
    pub provider: Option<String>,
    pub host_conversation_id: Option<String>,
    pub turns: Vec<CaptureConversationTurnRequest>,
}

#[derive(Debug, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[schema(rename_all = "lowercase")]
pub enum CaptureConversationOperation {
    Created,
    Appended,
    Unchanged,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CaptureConversationResponse {
    pub path: String,
    pub page_id: String,
    pub operation: CaptureConversationOperation,
    pub appended_turns: usize,
    pub skipped_turns: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ConversationSummaryResponse {
    pub provider: Option<String>,
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/capture", post(capture_conversation))
}

/// Serializes identified captures across lookup and mutation. The guard is
/// deliberately independent of coordinator path locks, avoiding lock-order
/// deadlocks while making identity lookup/create atomic in this process.
static CONVERSATION_CAPTURE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[utoipa::path(
    post,
    path = "/conversations/capture",
    context_path = "/api/vault",
    tag = "Conversations",
    request_body = CaptureConversationRequest,
    responses(
        (status = 200, description = "Conversation appended or unchanged", body = CaptureConversationResponse),
        (status = 201, description = "Conversation created", body = CaptureConversationResponse),
        (status = 400, description = "Invalid capture request", body = ApiError),
        (status = 409, description = "Conversation identity or content conflict", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn capture_conversation(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CaptureConversationRequest>,
) -> Result<Response, ApiError> {
    let prepared = prepare_request(&request)?;
    if prepared.prepared.ledger.host_id_hash.is_some() {
        let _guard = CONVERSATION_CAPTURE_LOCK.lock().await;
        capture_identified(&state, request.title.trim(), prepared).await
    } else {
        capture_new(&state, request.title.trim(), prepared).await
    }
}

struct PreparedRequest {
    prepared: crate::vault::conversation::PreparedTranscript,
}

fn prepare_request(request: &CaptureConversationRequest) -> Result<PreparedRequest, ApiError> {
    if request.title.trim().is_empty() {
        return Err(ApiError::bad_request("title must not be blank"));
    }
    if request.turns.is_empty() {
        return Err(ApiError::bad_request("turns must not be empty"));
    }
    if request.host_conversation_id.is_some() && request.provider.is_none() {
        return Err(ApiError::bad_request(
            "provider is required when host_conversation_id is supplied",
        ));
    }

    let provider = request.provider.as_deref();
    let host_id_hash = match (provider, request.host_conversation_id.as_deref()) {
        (Some(provider), Some(host_id)) => Some(
            host_identity_hash(provider, host_id)
                .map_err(|error| ApiError::bad_request(error.to_string()))?,
        ),
        (None, Some(_)) => unreachable!("validated above"),
        (_, None) => None,
    };
    let turns = request
        .turns
        .iter()
        .map(|turn| ConversationTurn {
            role: match turn.role {
                ConversationRoleRequest::User => ConversationRole::User,
                ConversationRoleRequest::Assistant => ConversationRole::Assistant,
            },
            content: turn.content.clone(),
            source_turn_id: turn.source_turn_id.clone(),
            timestamp: turn.timestamp,
        })
        .collect::<Vec<_>>();
    let prepared = prepare_transcript(provider, host_id_hash, &turns)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok(PreparedRequest { prepared })
}

async fn capture_new(
    state: &Arc<AppState>,
    title: &str,
    request: PreparedRequest,
) -> Result<Response, ApiError> {
    let created = state.clock.now();
    let path = build_projected_note_path(
        title,
        created,
        Kind::AiConversation,
        None,
        &generate_short_id(),
    )
    .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let mut meta = PageMeta::new();
    meta.title = Some(title.to_owned());
    meta.created_at = Some(created);
    meta.updated_at = Some(created);
    meta.kind = Some(Kind::AiConversation);
    write_ledger(&mut meta, &request.prepared.ledger)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let page = state
        .mutation_coordinator
        .create_page(
            &state.vault,
            &state.index,
            CreatePageCommand {
                path: path.clone(),
                meta,
                body: render_turns(&request.prepared.turns),
            },
            mutation_notifier(state),
        )
        .await
        .map_err(mutation_error)?;
    Ok((
        StatusCode::CREATED,
        Json(capture_response(
            &page,
            CaptureConversationOperation::Created,
            request.prepared.turns.len(),
            0,
        )),
    )
        .into_response())
}

async fn capture_identified(
    state: &Arc<AppState>,
    title: &str,
    request: PreparedRequest,
) -> Result<Response, ApiError> {
    let paths = find_identity_paths(state, &request.prepared.ledger).await?;
    match paths.as_slice() {
        [] => capture_new(state, title, request).await,
        [_] => capture_existing(state, paths[0].clone(), request).await,
        _ => Err(ApiError::conflict(
            "multiple conversation pages match the supplied identity",
        )),
    }
}

async fn find_identity_paths(
    state: &Arc<AppState>,
    ledger: &ConversationLedger,
) -> Result<Vec<VaultPath>, ApiError> {
    let provider = ledger
        .provider
        .as_deref()
        .ok_or_else(|| ApiError::internal("identified conversation is missing provider"))?
        .to_owned();
    let hash = ledger
        .host_id_hash
        .as_deref()
        .ok_or_else(|| ApiError::internal("identified conversation is missing host hash"))?
        .to_owned();
    let rows = state
        .index
        .with_index(move |index, _vault| {
            let mut statement = index.connection().prepare(
                "SELECT p.path FROM pages p
                 JOIN page_properties pp ON pp.page_id = p.id
                 WHERE p.kind = 'AI_CONVERSATION'
                   AND pp.key = 'conversation'
                   AND json_extract(pp.value_json, '$.provider') = ?1
                   AND json_extract(pp.value_json, '$.host_id_hash') = ?2
                 ORDER BY p.path",
            )?;
            let rows =
                statement.query_map(params![provider, hash], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
    rows.into_iter()
        .map(|path| {
            VaultPath::new(&path).map_err(|error| {
                ApiError::internal(format!("invalid indexed conversation path: {error}"))
            })
        })
        .collect()
}

async fn capture_existing(
    state: &Arc<AppState>,
    path: VaultPath,
    request: PreparedRequest,
) -> Result<Response, ApiError> {
    let absolute = state.vault.resolve(&path);
    let page = Page::from_file(&absolute, path.clone()).map_err(|error| {
        ApiError::internal(format!("failed to read conversation page: {error}"))
    })?;
    if page.is_encrypted() {
        return Err(ApiError::conflict(
            "matching conversation page is protected",
        ));
    }
    let existing = read_ledger(&page.meta)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| {
            ApiError::internal("matching conversation page has no conversation ledger")
        })?;
    let decision =
        verify_append(&existing, &request.prepared).map_err(conversation_decision_error)?;
    let existing_count = usize::try_from(existing.captured_turn_count)
        .map_err(|_| ApiError::internal("conversation turn count exceeds platform limits"))?;
    match decision {
        AppendDecision::Unchanged => Ok(Json(capture_response(
            &page,
            CaptureConversationOperation::Unchanged,
            0,
            request.prepared.turns.len(),
        ))
        .into_response()),
        AppendDecision::AppendFrom(index) => {
            let mut meta = page.meta;
            write_ledger(&mut meta, &request.prepared.ledger)
                .map_err(|error| ApiError::internal(error.to_string()))?;
            meta.updated_at = Some(state.clock.now());
            let body = append_rendered_turns(&page.body, &request.prepared.turns[index..]);
            let updated = state
                .mutation_coordinator
                .update_page(
                    &state.vault,
                    &state.index,
                    state.hooks.clone(),
                    UpdatePageCommand {
                        path,
                        expected_content: page.raw_content,
                        meta,
                        body,
                        project: ProjectAssignment::Unchanged,
                        reconcile: false,
                    },
                    &*mutation_notifier(state),
                )
                .await
                .map_err(mutation_error)?;
            Ok(Json(capture_response(
                &updated,
                CaptureConversationOperation::Appended,
                request.prepared.turns.len() - existing_count,
                existing_count,
            ))
            .into_response())
        }
    }
}

fn conversation_decision_error(error: ConversationError) -> ApiError {
    match error {
        ConversationError::ProviderConflict
        | ConversationError::HostIdentityConflict
        | ConversationError::TruncatedTranscript { .. }
        | ConversationError::DivergentTranscript { .. } => ApiError::conflict(error.to_string()),
        _ => ApiError::internal(error.to_string()),
    }
}

fn capture_response(
    page: &Page,
    operation: CaptureConversationOperation,
    appended_turns: usize,
    skipped_turns: usize,
) -> CaptureConversationResponse {
    CaptureConversationResponse {
        path: page.path.as_str().to_owned(),
        page_id: page.meta.id.to_string(),
        operation,
        appended_turns,
        skipped_turns,
        warnings: Vec::new(),
    }
}

pub(crate) fn conversation_summary(meta: &PageMeta) -> Option<ConversationSummaryResponse> {
    let value = meta.extra.get("conversation")?;
    let table = value.as_table()?;
    let provider = match table.get("provider") {
        None => None,
        Some(value) => Some(value.as_str()?.to_owned()),
    };
    Some(ConversationSummaryResponse { provider })
}
