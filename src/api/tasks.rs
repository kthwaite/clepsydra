use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Query, State};
use axum::routing::{get, put};
use chrono::Duration;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::AppState;
use super::error::ApiError;
use crate::api::events::SyncNotification;
use crate::vault::index::find_body_start;
use crate::vault::mutation_coordinator::{MutationNotification, ReplacePageContentCommand};
use crate::vault::page::parse_frontmatter;
use crate::vault::path::VaultPath;
use crate::vault::task_history::{effective_indexed_history, matches_project_scope};

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
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

#[derive(Debug, Serialize, Deserialize, ToSchema)]
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

#[derive(Debug, Serialize, ToSchema)]
pub struct TaskListResponse {
    pub tasks: Vec<TaskItem>,
    pub total: i64,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct TaskHistoryQueryParams {
    /// Number of calendar days to return. Defaults to 14 and is capped at 90.
    pub days: Option<u32>,
    /// Optional project slug used by the tasking board's operation filter.
    pub project: Option<String>,
    /// Restrict telemetry to tasks without a known board project.
    pub unfiled: Option<bool>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TaskCompletionDay {
    pub date: String,
    pub count: u32,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TaskCompletionHistoryResponse {
    pub days: Vec<TaskCompletionDay>,
}

/// Request body for `PUT /tasks/status`.
#[derive(Debug, Deserialize, ToSchema)]
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
        .route("/history", get(get_task_completion_history))
        .route("/status", put(update_task_status))
}

// ---------------------------------------------------------------------------
// GET /tasks/history — daily task-page seal counts
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/tasks/history",
    context_path = "/api/vault",
    tag = "Tasks",
    params(TaskHistoryQueryParams),
    responses(
        (status = 200, description = "Daily sealed task counts", body = TaskCompletionHistoryResponse),
        (status = 400, description = "Invalid telemetry scope", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn get_task_completion_history(
    State(state): State<Arc<AppState>>,
    Query(params): Query<TaskHistoryQueryParams>,
) -> Result<Json<TaskCompletionHistoryResponse>, ApiError> {
    let day_count = params.days.unwrap_or(14).clamp(1, 90);
    let today = state.clock.now().date_naive();
    let start = today - Duration::days(i64::from(day_count - 1));
    let project = params.project;
    let unfiled = params.unfiled.unwrap_or(false);
    if unfiled && project.is_some() {
        return Err(ApiError::bad_request(
            "project and unfiled cannot be requested together",
        ));
    }

    let (task_metadata, known_projects) = state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();
            let mut task_stmt =
                conn.prepare("SELECT meta_json FROM pages WHERE kind = 'TASK' ORDER BY path")?;
            let task_metadata = task_stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .filter_map(Result::ok)
                .filter_map(|value| serde_json::from_str(&value).ok())
                .collect::<Vec<serde_json::Value>>();

            let mut project_stmt = conn.prepare(
                "SELECT DISTINCT project FROM pages \
                 WHERE kind = 'PROJECT' AND project IS NOT NULL \
                   AND json_extract(meta_json, '$.board') = 1",
            )?;
            let known_projects = project_stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<HashSet<_>, _>>()?;
            Ok::<_, rusqlite::Error>((task_metadata, known_projects))
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;

    let mut counts = HashMap::<String, u32>::new();
    for meta in &task_metadata {
        let mut was_sealed = false;
        for event in effective_indexed_history(meta) {
            let is_sealed = event.status == "SEALED";
            if is_sealed
                && !was_sealed
                && matches_project_scope(
                    event.project.as_deref(),
                    project.as_deref(),
                    unfiled,
                    &known_projects,
                )
                && let Some(date) = event.timestamp().map(|value| value.date_naive())
                && date >= start
                && date <= today
            {
                let date = date.format("%Y-%m-%d").to_string();
                *counts.entry(date).or_default() += 1;
            }
            was_sealed = is_sealed;
        }
    }

    let days = (0..day_count)
        .map(|offset| {
            let date = start + Duration::days(i64::from(offset));
            let date = date.format("%Y-%m-%d").to_string();
            TaskCompletionDay {
                count: counts.get(&date).copied().unwrap_or(0),
                date,
            }
        })
        .collect();

    Ok(Json(TaskCompletionHistoryResponse { days }))
}

// ---------------------------------------------------------------------------
// GET /tasks — list_tasks
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/tasks",
    context_path = "/api/vault",
    tag = "Tasks",
    params(TaskQueryParams),
    responses(
        (status = 200, description = "Task list", body = TaskListResponse),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn list_tasks(
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
                Some("agenda") => {
                    "ORDER BY \
                     CASE WHEN EXISTS ( \
                       SELECT 1 FROM block_properties bp_due \
                       WHERE bp_due.page_id = b.page_id \
                         AND bp_due.span_start = b.span_start \
                         AND bp_due.key = 'due' \
                     ) THEN 0 ELSE 1 END, \
                     COALESCE(( \
                       SELECT bp_due.value FROM block_properties bp_due \
                       WHERE bp_due.page_id = b.page_id \
                         AND bp_due.span_start = b.span_start \
                         AND bp_due.key = 'due' \
                     ), '') ASC, \
                     CASE COALESCE(( \
                       SELECT bp_pri.value FROM block_properties bp_pri \
                       WHERE bp_pri.page_id = b.page_id \
                         AND bp_pri.span_start = b.span_start \
                         AND bp_pri.key = 'priority' \
                     ), '') \
                       WHEN 'A' THEN 0 \
                       WHEN 'B' THEN 1 \
                       WHEN 'C' THEN 2 \
                       ELSE 3 \
                     END, \
                     p.path ASC, \
                     b.span_start ASC"
                }
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

#[utoipa::path(
    put,
    path = "/tasks/status",
    context_path = "/api/vault",
    tag = "Tasks",
    request_body = UpdateStatusRequest,
    responses(
        (status = 200, description = "Updated task", body = TaskItem),
        (status = 400, description = "Invalid task update", body = ApiError),
        (status = 404, description = "Page not found", body = ApiError),
        (status = 409, description = "Task target is stale or protected", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn update_task_status(
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

    let abs_path = state.vault.resolve(&vault_path);
    let content = tokio::fs::read_to_string(&abs_path)
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ApiError::not_found(format!("page not found: {}", body.page_path))
            } else {
                ApiError::internal(format!("failed to read file: {error}"))
            }
        })?;

    if parse_frontmatter(&content).is_ok_and(|(meta, _)| meta.encryption.is_some()) {
        return Err(ApiError::conflict(
            "cannot update a task inside a protected page",
        ));
    }

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
            ApiError::bad_request(format!("no checkbox found near span_start {span_start}"))
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

    let notify = |notification: MutationNotification| {
        let _ = state.change_tx.send(SyncNotification::IndexChanged {
            upserted: notification.upserted,
            removed: notification.removed,
        });
    };
    state
        .mutation_coordinator
        .replace_page_content(
            &state.vault,
            &state.index,
            ReplacePageContentCommand {
                path: vault_path.clone(),
                expected_content: content,
                content: new_content,
            },
            &notify,
        )
        .await
        .map_err(super::mutation_error)?;
    let page_path_str = body.page_path.clone();
    let span_start_i64 = body.span_start;

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
