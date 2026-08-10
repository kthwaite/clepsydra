//! Agenda-related endpoints: /agenda/today, /agenda/week, /agenda/overdue.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Query, State};
use axum::routing::get;
use chrono::{Duration, NaiveDate, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::AppState;
use super::error::ApiError;
use super::tasks::TaskItem;
use crate::vault::task_history::{effective_indexed_history, matches_project_scope};

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
pub struct AgendaTodayResponse {
    pub tasks: Vec<TaskItem>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgendaWeekResponse {
    pub days: Vec<AgendaDay>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgendaDay {
    pub date: String,
    pub tasks: Vec<TaskItem>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgendaOverdueResponse {
    pub tasks: Vec<TaskItem>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct CycleBurndownQueryParams {
    pub cycle: String,
    /// Optional project slug used by the tasking board's operation filter.
    pub project: Option<String>,
    /// Restrict telemetry to tasks without a known board project.
    pub unfiled: Option<bool>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CycleBurndownPoint {
    pub date: String,
    pub remaining: u32,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CycleBurndownResponse {
    pub cycle: String,
    pub points: Vec<CycleBurndownPoint>,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/today", get(agenda_today))
        .route("/week", get(agenda_week))
        .route("/overdue", get(agenda_overdue))
        .route("/cycle-burndown", get(get_cycle_burndown))
}

// ---------------------------------------------------------------------------
// GET /agenda/cycle-burndown
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/agenda/cycle-burndown",
    context_path = "/api/vault",
    tag = "Agenda",
    params(CycleBurndownQueryParams),
    responses(
        (status = 200, description = "Historical cycle burndown", body = CycleBurndownResponse),
        (status = 400, description = "Invalid cycle dates or telemetry scope", body = ApiError),
        (status = 404, description = "Cycle not found", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn get_cycle_burndown(
    State(state): State<Arc<AppState>>,
    Query(params): Query<CycleBurndownQueryParams>,
) -> Result<Json<CycleBurndownResponse>, ApiError> {
    let cycle = params.cycle;
    let project = params.project;
    let unfiled = params.unfiled.unwrap_or(false);
    if unfiled && project.is_some() {
        return Err(ApiError::bad_request(
            "project and unfiled cannot be requested together",
        ));
    }
    let today = state.clock.now().date_naive();
    let cycle_for_query = cycle.clone();

    let history = state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();
            let cycle_dates = conn.query_row(
                "SELECT json_extract(meta_json, '$.start'), json_extract(meta_json, '$.end') \
                 FROM pages \
                 WHERE kind = 'CYCLE' AND upper(path) = upper('cycles/' || ?1 || '.md')",
                params![cycle_for_query],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            );

            let cycle_dates = match cycle_dates {
                Ok(dates) => Some(dates),
                Err(rusqlite::Error::QueryReturnedNoRows) => None,
                Err(error) => return Err(error),
            };

            let Some((start, end)) = cycle_dates else {
                return Ok(None);
            };

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
            Ok(Some((start, end, task_metadata, known_projects)))
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::not_found(format!("cycle not found: {cycle}")))?;

    let (start, end, task_metadata, known_projects) = history;
    let start = start
        .ok_or_else(|| ApiError::bad_request("cycle start date is required"))
        .and_then(|date| {
            NaiveDate::parse_from_str(&date, "%Y-%m-%d")
                .map_err(|_| ApiError::bad_request("cycle start date must use YYYY-MM-DD"))
        })?;
    let declared_end = end
        .map(|date| {
            NaiveDate::parse_from_str(&date, "%Y-%m-%d")
                .map_err(|_| ApiError::bad_request("cycle end date must use YYYY-MM-DD"))
        })
        .transpose()?
        .unwrap_or(today);
    if declared_end < start {
        return Err(ApiError::bad_request(
            "cycle end date must not precede its start date",
        ));
    }
    let end = declared_end.min(today);
    if start > end {
        return Ok(Json(CycleBurndownResponse {
            cycle,
            points: Vec::new(),
        }));
    }
    const MAX_BURNDOWN_DAYS: i64 = 366;
    let day_span = (end - start).num_days() + 1;
    if day_span > MAX_BURNDOWN_DAYS {
        return Err(ApiError::bad_request(format!(
            "cycle burndown is limited to {MAX_BURNDOWN_DAYS} days"
        )));
    }

    let mut baseline = 0_i64;
    let mut deltas = BTreeMap::<NaiveDate, i64>::new();
    let mut has_cycle_history = false;
    for meta in &task_metadata {
        let history = effective_indexed_history(meta);
        let mut included = false;
        for event in &history {
            let Some(date) = event.timestamp().map(|value| value.date_naive()) else {
                continue;
            };
            let in_scope = matches_project_scope(
                event.project.as_deref(),
                project.as_deref(),
                unfiled,
                &known_projects,
            );
            if event.cycle.as_deref() == Some(cycle.as_str()) && in_scope {
                has_cycle_history = true;
            }
            let next = event.cycle.as_deref() == Some(cycle.as_str())
                && event.status != "SEALED"
                && in_scope;
            if date < start {
                included = next;
            }
        }
        if included {
            baseline += 1;
        }
        for event in history {
            let Some(date) = event.timestamp().map(|value| value.date_naive()) else {
                continue;
            };
            if date < start {
                continue;
            }
            if date > end {
                break;
            }
            let in_scope = matches_project_scope(
                event.project.as_deref(),
                project.as_deref(),
                unfiled,
                &known_projects,
            );
            let next = event.cycle.as_deref() == Some(cycle.as_str())
                && event.status != "SEALED"
                && in_scope;
            if next != included {
                *deltas.entry(date).or_default() += if next { 1 } else { -1 };
                included = next;
            }
        }
    }
    if !has_cycle_history {
        return Ok(Json(CycleBurndownResponse {
            cycle,
            points: Vec::new(),
        }));
    }

    let mut remaining = baseline;
    let points = (0..day_span)
        .map(|offset| {
            let date = start + Duration::days(offset);
            remaining += deltas.get(&date).copied().unwrap_or_default();
            CycleBurndownPoint {
                date: date.format("%Y-%m-%d").to_string(),
                remaining: u32::try_from(remaining.max(0)).unwrap_or(u32::MAX),
            }
        })
        .collect();

    Ok(Json(CycleBurndownResponse { cycle, points }))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Fetch all properties for the returned tasks (batched to avoid N+1).
fn fill_properties(
    conn: &rusqlite::Connection,
    tasks: &mut [TaskItem],
    page_ids: &[(String, i64)], // (page_id, span_start)
) -> Result<(), rusqlite::Error> {
    for (i, (page_id, span_start)) in page_ids.iter().enumerate() {
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
    Ok(())
}

// ---------------------------------------------------------------------------
// GET /agenda/today
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/agenda/today",
    context_path = "/api/vault",
    tag = "Agenda",
    responses(
        (status = 200, description = "Today's agenda", body = AgendaTodayResponse),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn agenda_today(
    State(state): State<Arc<AppState>>,
) -> Result<Json<AgendaTodayResponse>, ApiError> {
    let today = Utc::now().format("%Y-%m-%d").to_string();

    let tasks = state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();

            // Union of:
            //   1. Tasks with due = today
            //   2. Tasks with scheduled = today
            //   3. Tasks with due < today AND status IN ('todo', 'doing')  (overdue)
            //   4. Incomplete tasks from today's journal page (journal_date = today)
            let sql = "\
                SELECT DISTINCT b.page_id, b.block_id, b.content, b.span_start, b.span_end, \
                       status_prop.value AS status, p.path, p.title \
                FROM blocks b \
                JOIN block_properties status_prop \
                  ON status_prop.page_id = b.page_id \
                 AND status_prop.span_start = b.span_start \
                 AND status_prop.key = 'status' \
                JOIN pages p ON b.page_id = p.id \
                LEFT JOIN block_properties bp_due \
                  ON bp_due.page_id = b.page_id \
                 AND bp_due.span_start = b.span_start \
                 AND bp_due.key = 'due' \
                LEFT JOIN block_properties bp_sched \
                  ON bp_sched.page_id = b.page_id \
                 AND bp_sched.span_start = b.span_start \
                 AND bp_sched.key = 'scheduled' \
                WHERE \
                  (bp_due.value = ?1) \
                  OR (bp_sched.value = ?1) \
                  OR (bp_due.value < ?1 AND status_prop.value IN ('todo', 'doing')) \
                  OR (p.journal_date = ?1 AND status_prop.value IN ('todo', 'doing')) \
                ORDER BY p.path ASC, b.span_start ASC";

            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map(params![today], |row| {
                Ok((
                    row.get::<_, String>(0)?,         // page_id (TEXT)
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

            fill_properties(conn, &mut tasks, &task_keys)?;

            Ok::<_, rusqlite::Error>(tasks)
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(Json(AgendaTodayResponse { tasks }))
}

// ---------------------------------------------------------------------------
// GET /agenda/week
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/agenda/week",
    context_path = "/api/vault",
    tag = "Agenda",
    responses(
        (status = 200, description = "Seven-day agenda", body = AgendaWeekResponse),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn agenda_week(
    State(state): State<Arc<AppState>>,
) -> Result<Json<AgendaWeekResponse>, ApiError> {
    let today_date = Utc::now().date_naive();
    let end_date = today_date + Duration::days(7);
    let today = today_date.format("%Y-%m-%d").to_string();
    let end = end_date.format("%Y-%m-%d").to_string();

    let tasks = state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();

            let sql = "\
                SELECT b.page_id, b.block_id, b.content, b.span_start, b.span_end, \
                       status_prop.value AS status, p.path, p.title, \
                       bp_due.value AS due_date \
                FROM blocks b \
                JOIN block_properties status_prop \
                  ON status_prop.page_id = b.page_id \
                 AND status_prop.span_start = b.span_start \
                 AND status_prop.key = 'status' \
                JOIN pages p ON b.page_id = p.id \
                JOIN block_properties bp_due \
                  ON bp_due.page_id = b.page_id \
                 AND bp_due.span_start = b.span_start \
                 AND bp_due.key = 'due' \
                WHERE bp_due.value >= ?1 AND bp_due.value <= ?2 \
                ORDER BY bp_due.value ASC, p.path ASC, b.span_start ASC";

            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map(params![today, end], |row| {
                Ok((
                    row.get::<_, String>(0)?,         // page_id (TEXT)
                    row.get::<_, Option<String>>(1)?, // block_id
                    row.get::<_, String>(2)?,         // content
                    row.get::<_, i64>(3)?,            // span_start
                    row.get::<_, i64>(4)?,            // span_end
                    row.get::<_, String>(5)?,         // status
                    row.get::<_, String>(6)?,         // path
                    row.get::<_, Option<String>>(7)?, // title
                    row.get::<_, String>(8)?,         // due_date
                ))
            })?;

            let mut tasks: Vec<(TaskItem, String)> = Vec::new();
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
                    due_date,
                ) = row?;
                task_keys.push((page_id, span_start));
                tasks.push((
                    TaskItem {
                        block_id,
                        content,
                        status,
                        properties: HashMap::new(),
                        page_path,
                        page_title,
                        span_start,
                        span_end,
                    },
                    due_date,
                ));
            }

            // Fill properties — extract TaskItems temporarily
            let mut task_items: Vec<TaskItem> = tasks
                .iter()
                .map(|(t, _)| TaskItem {
                    block_id: t.block_id.clone(),
                    content: t.content.clone(),
                    status: t.status.clone(),
                    properties: HashMap::new(),
                    page_path: t.page_path.clone(),
                    page_title: t.page_title.clone(),
                    span_start: t.span_start,
                    span_end: t.span_end,
                })
                .collect();

            fill_properties(conn, &mut task_items, &task_keys)?;

            // Re-pair with due dates
            let paired: Vec<(TaskItem, String)> = task_items
                .into_iter()
                .zip(tasks.into_iter().map(|(_, d)| d))
                .collect();

            Ok::<_, rusqlite::Error>(paired)
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    // Group by due_date in Rust (rows are already sorted by due_date)
    let mut day_map: Vec<(String, Vec<TaskItem>)> = Vec::new();
    for (task, due_date) in tasks {
        if let Some(last) = day_map.last_mut()
            && last.0 == due_date
        {
            last.1.push(task);
            continue;
        }
        day_map.push((due_date, vec![task]));
    }

    let days = day_map
        .into_iter()
        .map(|(date, tasks)| AgendaDay { date, tasks })
        .collect();

    Ok(Json(AgendaWeekResponse { days }))
}

// ---------------------------------------------------------------------------
// GET /agenda/overdue
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/agenda/overdue",
    context_path = "/api/vault",
    tag = "Agenda",
    responses(
        (status = 200, description = "Overdue tasks", body = AgendaOverdueResponse),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn agenda_overdue(
    State(state): State<Arc<AppState>>,
) -> Result<Json<AgendaOverdueResponse>, ApiError> {
    let today = Utc::now().format("%Y-%m-%d").to_string();

    let tasks = state
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
                JOIN block_properties bp_due \
                  ON bp_due.page_id = b.page_id \
                 AND bp_due.span_start = b.span_start \
                 AND bp_due.key = 'due' \
                WHERE bp_due.value < ?1 \
                  AND status_prop.value IN ('todo', 'doing') \
                ORDER BY bp_due.value ASC, p.path ASC, b.span_start ASC";

            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map(params![today], |row| {
                Ok((
                    row.get::<_, String>(0)?,         // page_id (TEXT)
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

            fill_properties(conn, &mut tasks, &task_keys)?;

            Ok::<_, rusqlite::Error>(tasks)
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(Json(AgendaOverdueResponse { tasks }))
}
