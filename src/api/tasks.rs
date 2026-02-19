use std::collections::HashMap;
use std::fs;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use axum::routing::{get, put};
use axum::Router;
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::AppState;
use super::error::ApiError;
use crate::api::events::SyncNotification;
use crate::vault::index::find_body_start;
use crate::vault::path::VaultPath;

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct TaskQueryParams {
    pub status: Option<String>,
    pub due_before: Option<String>,
    pub due_after: Option<String>,
    pub scheduled_before: Option<String>,
    pub scheduled_after: Option<String>,
    pub priority: Option<String>,
    pub tag: Option<String>,
    pub page: Option<String>,
    pub has_no_date: Option<bool>,
    pub sort: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct TaskItem {
    pub block_id: Option<String>,
    pub content: String,
    pub status: String,
    pub properties: HashMap<String, String>,
    pub page_path: String,
    pub page_title: Option<String>,
    pub span_start: i64,
    pub span_end: i64,
}

#[derive(Debug, Serialize)]
pub struct TaskListResponse {
    pub tasks: Vec<TaskItem>,
    pub total: i64,
}

/// Request body for `PUT /tasks/status`.
#[derive(Debug, Deserialize)]
pub struct UpdateStatusRequest {
    pub page_path: String,
    pub span_start: i64,
    pub status: String,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_tasks))
        .route("/status", put(update_task_status))
}

// ---------------------------------------------------------------------------
// GET /tasks — list_tasks
// ---------------------------------------------------------------------------

async fn list_tasks(
    State(state): State<Arc<AppState>>,
    Query(params): Query<TaskQueryParams>,
) -> Result<Json<TaskListResponse>, ApiError> {
    let result = state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();

            // Build the query dynamically.
            //
            // Base: blocks that have a block_properties row with key='status'
            // (i.e. they are task items — checkbox list items).
            let mut conditions: Vec<String> = Vec::new();
            let mut sql_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

            // Status filter
            if let Some(ref status_csv) = params.status {
                let statuses: Vec<&str> = status_csv.split(',').map(|s| s.trim()).collect();
                let placeholders: Vec<String> =
                    statuses.iter().enumerate().map(|(i, _)| format!("?{}", sql_params.len() + i + 1)).collect();
                conditions.push(format!(
                    "status_prop.value IN ({})",
                    placeholders.join(", ")
                ));
                for s in &statuses {
                    sql_params.push(Box::new(s.to_string()));
                }
            }

            // Due date filters
            if let Some(ref due_before) = params.due_before {
                conditions.push(format!(
                    "EXISTS (SELECT 1 FROM block_properties bp_due WHERE bp_due.page_id = b.page_id AND bp_due.span_start = b.span_start AND bp_due.key = 'due' AND bp_due.value <= ?{})",
                    sql_params.len() + 1
                ));
                sql_params.push(Box::new(due_before.clone()));
            }
            if let Some(ref due_after) = params.due_after {
                conditions.push(format!(
                    "EXISTS (SELECT 1 FROM block_properties bp_due WHERE bp_due.page_id = b.page_id AND bp_due.span_start = b.span_start AND bp_due.key = 'due' AND bp_due.value >= ?{})",
                    sql_params.len() + 1
                ));
                sql_params.push(Box::new(due_after.clone()));
            }

            // Scheduled date filters
            if let Some(ref scheduled_before) = params.scheduled_before {
                conditions.push(format!(
                    "EXISTS (SELECT 1 FROM block_properties bp_sched WHERE bp_sched.page_id = b.page_id AND bp_sched.span_start = b.span_start AND bp_sched.key = 'scheduled' AND bp_sched.value <= ?{})",
                    sql_params.len() + 1
                ));
                sql_params.push(Box::new(scheduled_before.clone()));
            }
            if let Some(ref scheduled_after) = params.scheduled_after {
                conditions.push(format!(
                    "EXISTS (SELECT 1 FROM block_properties bp_sched WHERE bp_sched.page_id = b.page_id AND bp_sched.span_start = b.span_start AND bp_sched.key = 'scheduled' AND bp_sched.value >= ?{})",
                    sql_params.len() + 1
                ));
                sql_params.push(Box::new(scheduled_after.clone()));
            }

            // Priority filter
            if let Some(ref priority) = params.priority {
                conditions.push(format!(
                    "EXISTS (SELECT 1 FROM block_properties bp_pri WHERE bp_pri.page_id = b.page_id AND bp_pri.span_start = b.span_start AND bp_pri.key = 'priority' AND bp_pri.value = ?{})",
                    sql_params.len() + 1
                ));
                sql_params.push(Box::new(priority.clone()));
            }

            // Tag filter (page-level tags)
            if let Some(ref tag) = params.tag {
                conditions.push(format!(
                    "EXISTS (SELECT 1 FROM tags t WHERE t.page_id = p.id AND t.tag = ?{})",
                    sql_params.len() + 1
                ));
                sql_params.push(Box::new(tag.clone()));
            }

            // Page path prefix filter
            if let Some(ref page_prefix) = params.page {
                conditions.push(format!("p.path LIKE ?{}", sql_params.len() + 1));
                sql_params.push(Box::new(format!("{page_prefix}%")));
            }

            // has_no_date: blocks that do NOT have a 'due' property
            if params.has_no_date == Some(true) {
                conditions.push(
                    "NOT EXISTS (SELECT 1 FROM block_properties bp_nd WHERE bp_nd.page_id = b.page_id AND bp_nd.span_start = b.span_start AND bp_nd.key = 'due')".to_string(),
                );
            }

            let where_clause = if conditions.is_empty() {
                String::new()
            } else {
                format!(" AND {}", conditions.join(" AND "))
            };

            // Sort clause
            let order_clause = match params.sort.as_deref() {
                Some("due") => {
                    "ORDER BY COALESCE((SELECT bp_s.value FROM block_properties bp_s WHERE bp_s.page_id = b.page_id AND bp_s.span_start = b.span_start AND bp_s.key = 'due'), 'zzzz') ASC, p.path ASC"
                }
                Some("priority") => {
                    "ORDER BY COALESCE((SELECT bp_s.value FROM block_properties bp_s WHERE bp_s.page_id = b.page_id AND bp_s.span_start = b.span_start AND bp_s.key = 'priority'), 'Z') ASC, p.path ASC"
                }
                Some("scheduled") => {
                    "ORDER BY COALESCE((SELECT bp_s.value FROM block_properties bp_s WHERE bp_s.page_id = b.page_id AND bp_s.span_start = b.span_start AND bp_s.key = 'scheduled'), 'zzzz') ASC, p.path ASC"
                }
                Some("page") => "ORDER BY p.path ASC, b.span_start ASC",
                _ => "ORDER BY p.path ASC, b.span_start ASC",
            };

            // Count query
            let count_sql = format!(
                "SELECT COUNT(*) FROM blocks b \
                 JOIN pages p ON b.page_id = p.id \
                 JOIN block_properties status_prop ON status_prop.page_id = b.page_id \
                   AND status_prop.span_start = b.span_start AND status_prop.key = 'status' \
                 WHERE 1=1{where_clause}"
            );

            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                sql_params.iter().map(|p| p.as_ref()).collect();

            let total: i64 = conn
                .query_row(&count_sql, param_refs.as_slice(), |row| row.get(0))
                .unwrap_or(0);

            // Pagination
            let limit = params.limit.unwrap_or(100).min(1000);
            let offset = params.offset.unwrap_or(0).max(0);

            // Data query
            let data_sql = format!(
                "SELECT b.block_id, b.content, status_prop.value AS status, \
                 p.path, p.title, b.span_start, b.span_end \
                 FROM blocks b \
                 JOIN pages p ON b.page_id = p.id \
                 JOIN block_properties status_prop ON status_prop.page_id = b.page_id \
                   AND status_prop.span_start = b.span_start AND status_prop.key = 'status' \
                 WHERE 1=1{where_clause} \
                 {order_clause} \
                 LIMIT ?{} OFFSET ?{}",
                sql_params.len() + 1,
                sql_params.len() + 2,
            );

            let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            for p in sql_params {
                all_params.push(p);
            }
            all_params.push(Box::new(limit));
            all_params.push(Box::new(offset));

            let all_param_refs: Vec<&dyn rusqlite::types::ToSql> =
                all_params.iter().map(|p| p.as_ref()).collect();

            let mut stmt = conn.prepare(&data_sql)?;
            let rows = stmt.query_map(all_param_refs.as_slice(), |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })?;

            let mut tasks: Vec<TaskItem> = Vec::new();
            let mut task_keys: Vec<(String, i64)> = Vec::new(); // (page_id, span_start) for property lookup

            for row in rows {
                let (block_id, content, status, page_path, page_title, span_start, span_end) =
                    row?;
                task_keys.push((page_path.clone(), span_start));
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

            // Fetch all properties for the returned tasks.
            // We do a batched lookup to avoid N+1.
            for (i, (page_path, span_start)) in task_keys.iter().enumerate() {
                let mut prop_stmt = conn.prepare(
                    "SELECT bp.key, bp.value FROM block_properties bp \
                     JOIN pages p ON bp.page_id = p.id \
                     WHERE p.path = ?1 AND bp.span_start = ?2",
                )?;
                let prop_rows = prop_stmt.query_map(params![page_path, span_start], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                for prop_row in prop_rows {
                    let (key, value) = prop_row?;
                    tasks[i].properties.insert(key, value);
                }
            }

            Ok::<_, rusqlite::Error>(TaskListResponse { tasks, total })
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// PUT /tasks/status — update_task_status
// ---------------------------------------------------------------------------

async fn update_task_status(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UpdateStatusRequest>,
) -> Result<Json<TaskItem>, ApiError> {
    let vault_path = VaultPath::new(&body.page_path)
        .map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    // Validate status value
    let new_status = match body.status.as_str() {
        "todo" | "done" | "cancelled" => body.status.as_str(),
        other => {
            return Err(ApiError::bad_request(format!(
                "invalid status: {other}; expected todo, done, or cancelled"
            )));
        }
    };

    // Read the file from disk
    let abs_path = state.vault.resolve(&vault_path);
    if !abs_path.exists() {
        return Err(ApiError::not_found(format!(
            "page not found: {}",
            body.page_path
        )));
    }

    let content = fs::read_to_string(&abs_path)
        .map_err(|e| ApiError::internal(format!("failed to read file: {e}")))?;

    let body_start = find_body_start(&content);
    let body_text = &content[body_start..];

    // Find the checkbox at the byte offset span_start in the body
    let span_start = body.span_start as usize;
    if span_start > body_text.len() {
        return Err(ApiError::bad_request(format!(
            "span_start {} is beyond body length {}",
            span_start,
            body_text.len()
        )));
    }

    // Search for the checkbox pattern near span_start.
    // The span_start points to the beginning of the list item, which looks like
    // "- [ ] ...", "- [x] ...", or "- [-] ...".
    // We need to find the `[ ]` / `[x]` / `[-]` within the first few characters.
    let search_region = &body_text[span_start..body_text.len().min(span_start + 20)];

    let checkbox_offset = search_region
        .find("[ ]")
        .or_else(|| search_region.find("[x]"))
        .or_else(|| search_region.find("[X]"))
        .or_else(|| search_region.find("[-]"))
        .ok_or_else(|| {
            ApiError::bad_request(format!(
                "no checkbox found near span_start {span_start}"
            ))
        })?;

    let replacement = match new_status {
        "done" => "[x]",
        "todo" => "[ ]",
        "cancelled" => "[-]",
        _ => unreachable!(),
    };

    // Build the new content by replacing the 3 checkbox chars
    let absolute_offset = body_start + span_start + checkbox_offset;
    let mut new_content = String::with_capacity(content.len());
    new_content.push_str(&content[..absolute_offset]);
    new_content.push_str(replacement);
    new_content.push_str(&content[absolute_offset + 3..]);

    // Write file back to disk
    fs::write(&abs_path, &new_content)
        .map_err(|e| ApiError::internal(format!("failed to write file: {e}")))?;

    // Re-index the page
    let vp = vault_path.clone();
    let page_path_str = body.page_path.clone();
    let span_start_i64 = body.span_start;

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

    // Emit change notification
    let _ = state.change_tx.send(SyncNotification::IndexChanged {
        upserted: vec![vault_path.as_str().to_string()],
        removed: vec![],
    });

    // Fetch the updated task from the index
    let vp2 = vault_path.clone();
    let task = state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();

            let mut stmt = conn.prepare(
                "SELECT b.block_id, b.content, status_prop.value, p.path, p.title, b.span_start, b.span_end \
                 FROM blocks b \
                 JOIN pages p ON b.page_id = p.id \
                 JOIN block_properties status_prop ON status_prop.page_id = b.page_id \
                   AND status_prop.span_start = b.span_start AND status_prop.key = 'status' \
                 WHERE p.path = ?1 AND b.span_start = ?2",
            )?;

            let result = stmt.query_row(params![page_path_str, span_start_i64], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            });

            match result {
                Ok((block_id, content, status, page_path, page_title, span_start, span_end)) => {
                    // Fetch properties
                    let mut prop_stmt = conn.prepare(
                        "SELECT bp.key, bp.value FROM block_properties bp \
                         JOIN pages p ON bp.page_id = p.id \
                         WHERE p.path = ?1 AND bp.span_start = ?2",
                    )?;
                    let mut properties = HashMap::new();
                    let prop_rows = prop_stmt.query_map(params![page_path, span_start], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?;
                    for prop_row in prop_rows {
                        let (key, value) = prop_row?;
                        properties.insert(key, value);
                    }

                    Ok(Some(TaskItem {
                        block_id,
                        content,
                        status,
                        properties,
                        page_path,
                        page_title,
                        span_start,
                        span_end,
                    }))
                }
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e),
            }
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "task not found after update at {}:{}",
                vp2.as_str(),
                body.span_start
            ))
        })?;

    Ok(Json(task))
}
