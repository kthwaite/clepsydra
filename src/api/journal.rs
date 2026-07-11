use std::collections::HashMap;
use std::fs;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Router, http::StatusCode};
use chrono::NaiveDate;
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::AppState;
use super::error::ApiError;
use super::pages::{PageDetail, page_detail};
use super::tasks::TaskItem;
use crate::api::events::SyncNotification;
use crate::vault::mutation_coordinator::{
    CreatePageCommand, MutationError, MutationNotification, ProjectAssignment, UpdatePageCommand,
};
use crate::vault::page::{Page, PageMeta};
use crate::vault::path::VaultPath;

// ---------------------------------------------------------------------------
// Request / query types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CaptureRequest {
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct RangeQuery {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Deserialize)]
pub struct RecentQuery {
    #[serde(default = "default_days")]
    pub days: u32,
}

fn default_days() -> u32 {
    7
}

#[derive(Debug, Serialize)]
pub struct JournalSummary {
    pub id: String,
    pub path: String,
    pub title: Option<String>,
    pub journal_date: String,
}

#[derive(Debug, Serialize)]
pub struct JournalTodayResponse {
    #[serde(flatten)]
    pub page: PageDetail,
    pub carried_forward: Vec<TaskItem>,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/today", get(get_today))
        .route("/today/capture", post(capture_today))
        .route("/range", get(get_range))
        .route("/recent", get(get_recent))
        .route("/{date}", get(get_by_date))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Validate a date string as YYYY-MM-DD and return it parsed.
fn parse_date(s: &str) -> Result<NaiveDate, ApiError> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| {
        ApiError::bad_request(format!("invalid date format (expected YYYY-MM-DD): {s}"))
    })
}

/// Build a VaultPath for a journal date.
fn journal_path(date: &str) -> Result<VaultPath, ApiError> {
    VaultPath::new(&format!("journals/{date}.md"))
        .map_err(|e| ApiError::internal(format!("invalid journal path: {e}")))
}

/// Ensure a journal page exists for the given date. Returns the VaultPath and
/// whether the page was newly created.
async fn ensure_journal(state: &Arc<AppState>, date: &str) -> Result<(VaultPath, bool), ApiError> {
    let vault_path = journal_path(date)?;
    let abs_path = state.vault.resolve(&vault_path);

    if abs_path.exists() {
        return Ok((vault_path, false));
    }

    // Build template
    let mut meta = PageMeta::new();
    let now = state.clock.now();
    meta.created_at = Some(now);
    meta.updated_at = Some(now);
    meta.title = Some(date.to_string());
    meta.tags = vec!["journal".to_string()];

    let notify = |notification: MutationNotification| {
        let _ = state.change_tx.send(SyncNotification::IndexChanged {
            upserted: notification.upserted,
            removed: notification.removed,
        });
    };
    match state
        .mutation_coordinator
        .create_page(
            &state.vault,
            &state.index,
            CreatePageCommand {
                path: vault_path.clone(),
                meta,
                body: String::new(),
            },
            &notify,
        )
        .await
    {
        Ok(_) => Ok((vault_path, true)),
        Err(MutationError::Conflict(_)) if abs_path.exists() => Ok((vault_path, false)),
        Err(error) => Err(crate::api::mutation_error(error)),
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// GET /journal/today — get or auto-create today's journal page.
///
/// The response includes a `carried_forward` array of incomplete tasks from
/// journal pages in the past 7 days (excluding today). These tasks are not
/// copied into today's file — they are surfaced in the API response for the
/// UI to render.
async fn get_today(
    State(state): State<Arc<AppState>>,
) -> Result<Json<JournalTodayResponse>, ApiError> {
    let date = state.clock.now().format("%Y-%m-%d").to_string();
    let (vault_path, _created) = ensure_journal(&state, &date).await?;

    let abs_path = state.vault.resolve(&vault_path);
    let page = Page::from_file(&abs_path, vault_path.clone())
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    let detail = page_detail(page.path, page.meta, page.body);

    // Query for carried-forward tasks: incomplete tasks from recent journals
    // (past 7 days, excluding today).
    let today_clone = date.clone();
    let lookback_date = {
        let today_date = NaiveDate::parse_from_str(&date, "%Y-%m-%d").unwrap();
        (today_date - chrono::Duration::days(7))
            .format("%Y-%m-%d")
            .to_string()
    };

    let carried = state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();

            let sql = "\
                SELECT b.page_id, b.block_id, b.content, b.span_start, b.span_end, \
                       status_prop.value AS status, p.path, p.title \
                FROM blocks b \
                JOIN block_properties status_prop \
                  ON status_prop.page_id = b.page_id \
                 AND status_prop.span_start = b.span_start \
                 AND status_prop.key = 'status' \
                JOIN pages p ON b.page_id = p.id \
                WHERE p.journal_date IS NOT NULL \
                  AND p.journal_date < ?1 \
                  AND p.journal_date >= ?2 \
                  AND status_prop.value IN ('todo', 'doing') \
                ORDER BY p.journal_date DESC, b.order_index ASC";

            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map(params![today_clone, lookback_date], |row| {
                Ok((
                    row.get::<_, String>(0)?,         // page_id
                    row.get::<_, Option<String>>(1)?, // block_id
                    row.get::<_, String>(2)?,         // content
                    row.get::<_, i64>(3)?,            // span_start
                    row.get::<_, i64>(4)?,            // span_end
                    row.get::<_, String>(5)?,         // status
                    row.get::<_, String>(6)?,         // path
                    row.get::<_, Option<String>>(7)?, // title
                ))
            })?;

            let mut tasks: Vec<TaskItem> = Vec::new();
            let mut task_keys: Vec<(String, i64)> = Vec::new();

            for row in rows {
                let (
                    page_id,
                    block_id,
                    content,
                    span_start,
                    span_end,
                    status,
                    page_path,
                    page_title,
                ) = row?;
                task_keys.push((page_id, span_start));
                tasks.push(TaskItem {
                    block_id,
                    content,
                    status,
                    properties: HashMap::new(),
                    page_path,
                    page_title,
                    span_start,
                    span_end,
                });
            }

            // Fill properties for each task
            for (i, (page_id, span_start)) in task_keys.iter().enumerate() {
                let mut prop_stmt = conn.prepare(
                    "SELECT bp.key, bp.value FROM block_properties bp \
                     WHERE bp.page_id = ?1 AND bp.span_start = ?2",
                )?;
                let prop_rows = prop_stmt.query_map(params![page_id, span_start], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                for prop_row in prop_rows {
                    let (key, value) = prop_row?;
                    tasks[i].properties.insert(key, value);
                }
            }

            Ok::<_, rusqlite::Error>(tasks)
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(Json(JournalTodayResponse {
        page: detail,
        carried_forward: carried,
    }))
}

/// GET /journal/:date — get a journal page by date.
async fn get_by_date(
    State(state): State<Arc<AppState>>,
    Path(date): Path<String>,
) -> Result<Json<PageDetail>, ApiError> {
    // Validate date format
    let _ = parse_date(&date)?;

    let vault_path = journal_path(&date)?;
    let abs_path = state.vault.resolve(&vault_path);

    if !abs_path.exists() {
        return Err(ApiError::not_found(format!("journal not found: {date}")));
    }

    let page = Page::from_file(&abs_path, vault_path.clone())
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    Ok(Json(page_detail(page.path, page.meta, page.body)))
}

/// GET /journal/range?from=YYYY-MM-DD&to=YYYY-MM-DD — list journals in range.
async fn get_range(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RangeQuery>,
) -> Result<Json<Vec<JournalSummary>>, ApiError> {
    let _ = parse_date(&query.from)?;
    let _ = parse_date(&query.to)?;

    let from = query.from.clone();
    let to = query.to.clone();

    let journals = state
        .index
        .with_index(move |index, _vault| {
            let mut stmt = index.connection().prepare(
                "SELECT id, path, title, journal_date FROM pages \
                 WHERE journal_date IS NOT NULL \
                   AND journal_date >= ?1 AND journal_date <= ?2 \
                 ORDER BY journal_date DESC",
            )?;

            let rows: Vec<JournalSummary> = stmt
                .query_map(params![from, to], |row| {
                    Ok(JournalSummary {
                        id: row.get(0)?,
                        path: row.get(1)?,
                        title: row.get(2)?,
                        journal_date: row.get(3)?,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();

            Ok::<_, rusqlite::Error>(rows)
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(Json(journals))
}

/// GET /journal/recent?days=7 — list recent journal pages.
async fn get_recent(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RecentQuery>,
) -> Result<Json<Vec<JournalSummary>>, ApiError> {
    let today = state.clock.now().date_naive();
    let from = today - chrono::Duration::days(i64::from(query.days));

    let from_str = from.format("%Y-%m-%d").to_string();
    let to_str = today.format("%Y-%m-%d").to_string();

    let journals = state
        .index
        .with_index(move |index, _vault| {
            let mut stmt = index.connection().prepare(
                "SELECT id, path, title, journal_date FROM pages \
                 WHERE journal_date IS NOT NULL \
                   AND journal_date >= ?1 AND journal_date <= ?2 \
                 ORDER BY journal_date DESC",
            )?;

            let rows: Vec<JournalSummary> = stmt
                .query_map(params![from_str, to_str], |row| {
                    Ok(JournalSummary {
                        id: row.get(0)?,
                        path: row.get(1)?,
                        title: row.get(2)?,
                        journal_date: row.get(3)?,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();

            Ok::<_, rusqlite::Error>(rows)
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(Json(journals))
}

/// POST /journal/today/capture — append content to today's journal.
async fn capture_today(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CaptureRequest>,
) -> Result<Response, ApiError> {
    let now = state.clock.now();
    let date = now.format("%Y-%m-%d").to_string();
    let (vault_path, _created) = ensure_journal(&state, &date).await?;

    let abs_path = state.vault.resolve(&vault_path);

    // Read current page
    let expected_content = fs::read_to_string(&abs_path)
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;
    let page = Page::from_file(&abs_path, vault_path.clone())
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    // Append content
    let mut new_body = page.body.clone();
    if !new_body.is_empty() && !new_body.ends_with('\n') {
        new_body.push('\n');
    }
    new_body.push_str(&req.content);
    new_body.push('\n');

    let mut meta = page.meta;
    meta.updated_at = Some(now);
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
            UpdatePageCommand {
                path: vault_path,
                expected_content,
                meta,
                body: new_body,
                project: ProjectAssignment::Unchanged,
                reconcile: false,
            },
            &notify,
        )
        .await
        .map_err(crate::api::mutation_error)?;

    Ok((
        StatusCode::OK,
        Json(page_detail(result.path, result.meta, result.body)),
    )
        .into_response())
}
