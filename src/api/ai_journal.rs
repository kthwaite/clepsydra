//! The AI-assistant journal stream: a daily journal for agent-initiated
//! notes, kept apart from the user's own journal. Same machinery, different
//! `JournalStream`; no carried-forward todos, optional per-entry attribution.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Router, http::StatusCode};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;
use super::journal::{
    AI_JOURNAL, JournalSummary, RangeQuery, RecentQuery, capture_into, ensure_journal,
    find_journal_path, is_block_construct, journal_summaries, parse_date,
};
use super::pages::{PageDetail, page_detail};
use crate::vault::page::Page;

#[derive(Debug, Deserialize, ToSchema)]
pub struct AiCaptureRequest {
    pub content: String,
    /// Short label naming the writing agent (e.g. `claude-code`), rendered
    /// as an entry prefix. Single line, 1-64 characters.
    pub author: Option<String>,
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/today", get(get_today).post(ensure_today))
        .route("/today/capture", post(capture_today))
        .route("/range", get(get_range))
        .route("/recent", get(get_recent))
        .route("/{date}", get(get_by_date))
}

/// Trimmed author label, or a 400 when present but not a single line of
/// 1-64 Unicode scalars.
fn validate_author(author: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(raw) = author else { return Ok(None) };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 64 || trimmed.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "author must be a single line of 1-64 characters",
        ));
    }
    Ok(Some(trimmed.to_string()))
}

/// `- HH:MM — [author] content` for plain prose; block constructs pass
/// through verbatim and unattributed, exactly as human captures do.
fn format_ai_capture_entry(now: DateTime<Utc>, content: &str, author: Option<&str>) -> String {
    let first_line = content.lines().next().unwrap_or("").trim_start();
    if is_block_construct(first_line) {
        return content.to_string();
    }
    match author {
        Some(author) => format!("- {} — [{author}] {content}", now.format("%H:%M")),
        None => format!("- {} — {}", now.format("%H:%M"), content),
    }
}

/// GET /ai-journal/today — read today's AI journal page (404 when absent).
#[utoipa::path(
    get,
    operation_id = "ai_journal_get_today",
    path = "/ai-journal/today",
    context_path = "/api/vault",
    tag = "AI Journal",
    responses(
        (status = 200, description = "Today's AI journal", body = crate::api::pages::PageDetailResponse),
        (status = 404, description = "AI journal not found", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn get_today(State(state): State<Arc<AppState>>) -> Result<Json<PageDetail>, ApiError> {
    let date = state.clock.now().format("%Y-%m-%d").to_string();
    let vault_path = find_journal_path(&state, AI_JOURNAL, &date)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("AI journal not found: {date}")))?;
    let abs_path = state.vault.resolve(&vault_path);

    let page = Page::from_file(&abs_path, vault_path)
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    Ok(Json(page_detail(page)))
}

/// POST /ai-journal/today — create today's AI journal if missing (get-or-create).
#[utoipa::path(
    post,
    operation_id = "ai_journal_ensure_today",
    path = "/ai-journal/today",
    context_path = "/api/vault",
    tag = "AI Journal",
    responses(
        (status = 200, description = "Existing AI journal", body = crate::api::pages::PageDetailResponse),
        (status = 201, description = "Created AI journal", body = crate::api::pages::PageDetailResponse),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn ensure_today(State(state): State<Arc<AppState>>) -> Result<Response, ApiError> {
    let date = state.clock.now().format("%Y-%m-%d").to_string();
    let (vault_path, created) = ensure_journal(&state, AI_JOURNAL, &date).await?;

    let abs_path = state.vault.resolve(&vault_path);
    let page = Page::from_file(&abs_path, vault_path)
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(page_detail(page))).into_response())
}

/// GET /ai-journal/:date — get an AI journal page by date.
#[utoipa::path(
    get,
    operation_id = "ai_journal_get_by_date",
    path = "/ai-journal/{date}",
    context_path = "/api/vault",
    tag = "AI Journal",
    params(("date" = String, Path, description = "Journal date in YYYY-MM-DD format")),
    responses(
        (status = 200, description = "AI journal page", body = crate::api::pages::PageDetailResponse),
        (status = 400, description = "Invalid date", body = ApiError),
        (status = 404, description = "AI journal not found", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn get_by_date(
    State(state): State<Arc<AppState>>,
    Path(date): Path<String>,
) -> Result<Json<PageDetail>, ApiError> {
    let _ = parse_date(&date)?;

    let vault_path = find_journal_path(&state, AI_JOURNAL, &date)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("AI journal not found: {date}")))?;
    let abs_path = state.vault.resolve(&vault_path);

    let page = Page::from_file(&abs_path, vault_path)
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    Ok(Json(page_detail(page)))
}

/// GET /ai-journal/range?from=YYYY-MM-DD&to=YYYY-MM-DD — list AI journals in range.
#[utoipa::path(
    get,
    operation_id = "ai_journal_get_range",
    path = "/ai-journal/range",
    context_path = "/api/vault",
    tag = "AI Journal",
    params(RangeQuery),
    responses(
        (status = 200, description = "AI journals in date range", body = [JournalSummary]),
        (status = 400, description = "Invalid date range", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub(crate) async fn get_range(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RangeQuery>,
) -> Result<Json<Vec<JournalSummary>>, ApiError> {
    let _ = parse_date(&query.from)?;
    let _ = parse_date(&query.to)?;

    let journals = journal_summaries(&state, AI_JOURNAL, &query.from, &query.to).await?;

    Ok(Json(journals))
}

/// GET /ai-journal/recent?days=7 — list recent AI journal pages.
#[utoipa::path(
    get,
    operation_id = "ai_journal_get_recent",
    path = "/ai-journal/recent",
    context_path = "/api/vault",
    tag = "AI Journal",
    params(RecentQuery),
    responses(
        (status = 200, description = "Recent AI journals", body = [JournalSummary]),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub(crate) async fn get_recent(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RecentQuery>,
) -> Result<Json<Vec<JournalSummary>>, ApiError> {
    let today = state.clock.now().date_naive();
    let from = today - chrono::Duration::days(i64::from(query.days));

    let from_str = from.format("%Y-%m-%d").to_string();
    let to_str = today.format("%Y-%m-%d").to_string();

    let journals = journal_summaries(&state, AI_JOURNAL, &from_str, &to_str).await?;

    Ok(Json(journals))
}

/// POST /ai-journal/today/capture — append content to today's AI journal.
#[utoipa::path(
    post,
    operation_id = "ai_journal_capture_today",
    path = "/ai-journal/today/capture",
    context_path = "/api/vault",
    tag = "AI Journal",
    request_body = AiCaptureRequest,
    responses(
        (status = 200, description = "Updated AI journal", body = crate::api::pages::PageDetailResponse),
        (status = 400, description = "Invalid author", body = ApiError),
        (status = 409, description = "Protected AI journal", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn capture_today(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AiCaptureRequest>,
) -> Result<Response, ApiError> {
    let author = validate_author(req.author.as_deref())?;
    let entry = format_ai_capture_entry(state.clock.now(), &req.content, author.as_deref());
    let detail = capture_into(&state, AI_JOURNAL, &entry).await?;
    Ok((StatusCode::OK, Json(detail)).into_response())
}
