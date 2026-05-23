use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::routing::get;
use chrono::{Duration, Utc};
use rusqlite::params;
use serde::Serialize;

use super::AppState;
use super::error::ApiError;
use super::tasks::TaskItem;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct AgendaTodayResponse {
    pub tasks: Vec<TaskItem>,
}

#[derive(Debug, Serialize)]
pub struct AgendaWeekResponse {
    pub days: Vec<AgendaDay>,
}

#[derive(Debug, Serialize)]
pub struct AgendaDay {
    pub date: String,
    pub tasks: Vec<TaskItem>,
}

#[derive(Debug, Serialize)]
pub struct AgendaOverdueResponse {
    pub tasks: Vec<TaskItem>,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/today", get(agenda_today))
        .route("/week", get(agenda_week))
        .route("/overdue", get(agenda_overdue))
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

async fn agenda_today(
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

async fn agenda_week(
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

async fn agenda_overdue(
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
