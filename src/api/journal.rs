use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Router, http::StatusCode};
use chrono::{NaiveDate, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::AppState;
use super::error::ApiError;
use super::pages::PageDetail;
use super::tasks::TaskItem;
use crate::api::events::SyncNotification;
use crate::vault::canonical::CanonicalName;
use crate::vault::page::{Page, PageMeta, write_page_content};
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
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|_| ApiError::bad_request(format!("invalid date format (expected YYYY-MM-DD): {s}")))
}

/// Build a VaultPath for a journal date.
fn journal_path(date: &str) -> Result<VaultPath, ApiError> {
    VaultPath::new(&format!("journals/{date}.md"))
        .map_err(|e| ApiError::internal(format!("invalid journal path: {e}")))
}

/// Build a PageDetail from a Page + VaultPath.
fn page_detail(page: &Page, vault_path: &VaultPath) -> PageDetail {
    let canonical = if let Some(ref title) = page.meta.title {
        CanonicalName::from_title(title)
    } else {
        CanonicalName::from_filename(vault_path.filename())
    };

    PageDetail {
        path: vault_path.as_str().to_string(),
        canonical_name: canonical.as_str().to_string(),
        meta: page.meta.clone(),
        body: page.body.clone(),
    }
}

/// Ensure a journal page exists for the given date. Returns the VaultPath and
/// whether the page was newly created.
async fn ensure_journal(
    state: &Arc<AppState>,
    date: &str,
) -> Result<(VaultPath, bool), ApiError> {
    let vault_path = journal_path(date)?;
    let abs_path = state.vault.resolve(&vault_path);

    if abs_path.exists() {
        return Ok((vault_path, false));
    }

    // Create parent directory
    if let Some(parent) = abs_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| ApiError::internal(format!("failed to create directories: {e}")))?;
    }

    // Build template
    let mut meta = PageMeta::new();
    meta.title = Some(date.to_string());
    meta.tags = vec!["journal".to_string()];

    let body = String::new();
    let content = write_page_content(&meta, &body);

    // Write atomically
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
            // Another request created it concurrently; that's fine.
            return Ok((vault_path, false));
        }
        Err(e) => {
            return Err(ApiError::internal(format!("failed to create file: {e}")));
        }
    }

    // Index the new page
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
        upserted: vec![vault_path.as_str().to_string()],
        removed: vec![],
    });

    Ok((vault_path, true))
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
    let date = Utc::now().format("%Y-%m-%d").to_string();
    let (vault_path, _created) = ensure_journal(&state, &date).await?;

    let abs_path = state.vault.resolve(&vault_path);
    let page = Page::from_file(&abs_path, vault_path.clone())
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    let detail = page_detail(&page, &vault_path);

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
                    row.get::<_, String>(0)?,        // page_id
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
                let prop_rows =
                    prop_stmt.query_map(params![page_id, span_start], |row| {
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

    Ok(Json(page_detail(&page, &vault_path)))
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
    let today = Utc::now().date_naive();
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
    let date = Utc::now().format("%Y-%m-%d").to_string();
    let (vault_path, _created) = ensure_journal(&state, &date).await?;

    let abs_path = state.vault.resolve(&vault_path);

    // Read current page
    let page = Page::from_file(&abs_path, vault_path.clone())
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    // Append content
    let mut new_body = page.body.clone();
    if !new_body.is_empty() && !new_body.ends_with('\n') {
        new_body.push('\n');
    }
    new_body.push_str(&req.content);
    new_body.push('\n');

    // Write back
    let mut meta = page.meta;
    meta.updated_at = Some(Utc::now());
    let content = write_page_content(&meta, &new_body);
    fs::write(&abs_path, &content)
        .map_err(|e| ApiError::internal(format!("failed to write file: {e}")))?;

    // Re-index
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
        upserted: vec![vault_path.as_str().to_string()],
        removed: vec![],
    });

    let canonical = if let Some(ref title) = meta.title {
        CanonicalName::from_title(title)
    } else {
        CanonicalName::from_filename(vault_path.filename())
    };

    Ok((
        StatusCode::OK,
        Json(PageDetail {
            path: vault_path.as_str().to_string(),
            canonical_name: canonical.as_str().to_string(),
            meta,
            body: new_body,
        }),
    )
        .into_response())
}
