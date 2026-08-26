//! Consolidated Agenda and cycle-burndown endpoints.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Query, State};
use axum::routing::get;
use chrono::{Duration, NaiveDate};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::AppState;
use super::error::ApiError;
use super::tasks::TaskItem;
use crate::vault::task_history::{effective_indexed_history, matches_project_scope};
use crate::vault::board_vocab::{DEFAULT_PRIORITY, DEFAULT_STATUS};

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct AgendaQuery {
    pub today: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgendaResponse {
    pub overdue: Vec<AgendaItem>,
    pub today: Vec<AgendaItem>,
    pub upcoming: Vec<AgendaDay>,
    pub undated: Vec<AgendaItem>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgendaDay {
    pub date: String,
    pub items: Vec<AgendaItem>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgendaItem {
    Todo {
        block_id: Option<String>,
        content: String,
        status: String,
        properties: HashMap<String, String>,
        page_path: String,
        page_title: Option<String>,
        span_start: i64,
        span_end: i64,
    },
    Task {
        id: uuid::Uuid,
        code: String,
        title: String,
        status: String,
        priority: String,
        project: Option<String>,
        due: String,
        hold: Option<String>,
        path: String,
    },
}

fn parse_today(value: &str) -> Result<NaiveDate, ApiError> {
    let bytes = value.as_bytes();
    let has_exact_shape = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit());
    if !has_exact_shape {
        return Err(ApiError::bad_request(
            "today must be a real date in YYYY-MM-DD format",
        ));
    }

    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| ApiError::bad_request("today must be a real date in YYYY-MM-DD format"))
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
        .route("/", get(get_agenda))
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
// GET /agenda
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/agenda",
    context_path = "/api/vault",
    tag = "Agenda",
    params(AgendaQuery),
    responses(
        (status = 200, description = "Classified agenda", body = AgendaResponse),
        (status = 400, description = "Invalid local date", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn get_agenda(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AgendaQuery>,
) -> Result<Json<AgendaResponse>, ApiError> {
    let today = parse_today(&query.today)?;
    let tomorrow = today.checked_add_signed(Duration::days(1)).ok_or_else(|| {
        ApiError::bad_request("today must allow a seven-day Agenda window")
    })?;
    let end = today.checked_add_signed(Duration::days(7)).ok_or_else(|| {
        ApiError::bad_request("today must allow a seven-day Agenda window")
    })?;
    let today_key = today.format("%Y-%m-%d").to_string();
    let tomorrow_key = tomorrow.format("%Y-%m-%d").to_string();
    let end_key = end.format("%Y-%m-%d").to_string();

    let (todos, tasks) = state
        .index
        .with_index({
            let today_key = today_key.clone();
            let tomorrow_key = tomorrow_key.clone();
            let end_key = end_key.clone();
            move |index, _vault| {
                let conn = index.connection();
                let sql = "\
                    SELECT b.page_id, b.block_id, b.content, b.span_start, b.span_end, \
                           status_prop.value AS status, p.path, p.title, p.journal_date \
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
                    WHERE status_prop.value IN ('todo', 'doing') \
                      AND ( \
                        bp_due.value < ?2 \
                        OR (bp_due.value >= ?2 AND bp_due.value <= ?3) \
                        OR bp_sched.value = ?1 \
                        OR p.journal_date = ?1 \
                        OR bp_due.value IS NULL \
                      )";

                let mut stmt = conn.prepare(sql)?;
                let rows =
                    stmt.query_map(params![today_key, tomorrow_key, end_key], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, Option<String>>(7)?,
                            row.get::<_, Option<String>>(8)?,
                        ))
                    })?;

                let mut todo_items = Vec::new();
                let mut todo_keys = Vec::new();
                let mut journal_dates = Vec::new();
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
                        journal_date,
                    ) = row?;
                    todo_keys.push((page_id, span_start));
                    todo_items.push(TaskItem {
                        block_id,
                        content,
                        status,
                        properties: HashMap::new(),
                        page_path,
                        page_title,
                        span_start,
                        span_end,
                    });
                    journal_dates.push(journal_date);
                }

                fill_properties(conn, &mut todo_items, &todo_keys)?;

                let todos = todo_items
                    .into_iter()
                    .zip(journal_dates)
                    .collect::<Vec<_>>();

                let mut task_stmt = conn.prepare(
                    "SELECT p.id, p.path, p.title, p.meta_json, p.project \
                     FROM pages p \
                     WHERE p.kind = 'TASK' \
                     ORDER BY p.path",
                )?;
                let task_rows = task_stmt
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, Option<String>>(4)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                let mut tasks = Vec::new();
                for (id, path, title, meta_json, project) in task_rows {
                    let Ok(id) = uuid::Uuid::parse_str(&id) else {
                        continue;
                    };
                    let metadata: serde_json::Value =
                        serde_json::from_str(&meta_json).unwrap_or(serde_json::Value::Null);
                    let status = agenda_meta_string(&metadata, "status")
                        .unwrap_or_else(|| DEFAULT_STATUS.to_string());
                    if status == "SEALED" {
                        continue;
                    }
                    let Some(due) = agenda_meta_string(&metadata, "due") else {
                        continue;
                    };
                    let code = agenda_path_stem(&path).to_ascii_uppercase();
                    tasks.push(AgendaItem::Task {
                        id,
                        title: title.unwrap_or_else(|| code.clone()),
                        code,
                        status,
                        priority: agenda_meta_string(&metadata, "priority")
                            .unwrap_or_else(|| DEFAULT_PRIORITY.to_string()),
                        project,
                        due,
                        hold: agenda_meta_string(&metadata, "hold"),
                        path,
                    });
                }

                Ok::<_, rusqlite::Error>((todos, tasks))
            }
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;

    let mut overdue = Vec::new();
    let mut today_items = Vec::new();
    let mut upcoming_by_date: BTreeMap<String, Vec<AgendaItem>> = BTreeMap::new();
    let mut undated = Vec::new();

    for (todo, journal_date) in todos {
        let due = todo.properties.get("due").map(String::as_str);
        let scheduled = todo.properties.get("scheduled").map(String::as_str);
        let bucket = classify_agenda_item(
            due,
            scheduled == Some(today_key.as_str())
                || journal_date.as_deref() == Some(today_key.as_str()),
            true,
            &today_key,
            &tomorrow_key,
            &end_key,
        );
        push_agenda_item(
            bucket,
            todo_item(todo),
            &mut overdue,
            &mut today_items,
            &mut upcoming_by_date,
            &mut undated,
        );
    }

    for task in tasks {
        let bucket = classify_agenda_item(
            item_due(&task),
            false,
            false,
            &today_key,
            &tomorrow_key,
            &end_key,
        );
        push_agenda_item(
            bucket,
            task,
            &mut overdue,
            &mut today_items,
            &mut upcoming_by_date,
            &mut undated,
        );
    }

    sort_agenda_items(&mut overdue);
    sort_agenda_items(&mut today_items);
    sort_agenda_items(&mut undated);
    let upcoming = upcoming_by_date
        .into_iter()
        .map(|(date, mut items)| {
            sort_agenda_items(&mut items);
            AgendaDay { date, items }
        })
        .collect();

    Ok(Json(AgendaResponse {
        overdue,
        today: today_items,
        upcoming,
        undated,
    }))
}

fn todo_item(todo: TaskItem) -> AgendaItem {
    AgendaItem::Todo {
        block_id: todo.block_id,
        content: todo.content,
        status: todo.status,
        properties: todo.properties,
        page_path: todo.page_path,
        page_title: todo.page_title,
        span_start: todo.span_start,
        span_end: todo.span_end,
    }
}

fn agenda_path_stem(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".md").unwrap_or(name)
}

fn agenda_meta_string(metadata: &serde_json::Value, key: &str) -> Option<String> {
    match metadata.get(key) {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(value)) => {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        }
        Some(serde_json::Value::Number(value)) => Some(value.to_string()),
        Some(serde_json::Value::Bool(value)) => Some(value.to_string()),
        Some(value) => {
            let value = value.to_string();
            (!value.is_empty()).then_some(value)
        }
    }
}

enum AgendaBucket {
    Overdue,
    Today,
    Upcoming(String),
    Undated,
    OutsideWindow,
}

fn classify_agenda_item(
    due: Option<&str>,
    is_today: bool,
    include_undated: bool,
    today: &str,
    tomorrow: &str,
    end: &str,
) -> AgendaBucket {
    if due.is_some_and(|due| due < today) {
        AgendaBucket::Overdue
    } else if due == Some(today) || is_today {
        AgendaBucket::Today
    } else if let Some(due) = due.filter(|due| *due >= tomorrow && *due <= end) {
        AgendaBucket::Upcoming(due.to_owned())
    } else if due.is_none() && include_undated {
        AgendaBucket::Undated
    } else {
        AgendaBucket::OutsideWindow
    }
}

fn push_agenda_item(
    bucket: AgendaBucket,
    item: AgendaItem,
    overdue: &mut Vec<AgendaItem>,
    today: &mut Vec<AgendaItem>,
    upcoming: &mut BTreeMap<String, Vec<AgendaItem>>,
    undated: &mut Vec<AgendaItem>,
) {
    match bucket {
        AgendaBucket::Overdue => overdue.push(item),
        AgendaBucket::Today => today.push(item),
        AgendaBucket::Upcoming(date) => upcoming.entry(date).or_default().push(item),
        AgendaBucket::Undated => undated.push(item),
        AgendaBucket::OutsideWindow => {}
    }
}

fn sort_agenda_items(items: &mut [AgendaItem]) {
    items.sort_by(|left, right| {
        match (item_due(left), item_due(right)) {
            (Some(left), Some(right)) => {
                let ordering = left.cmp(right);
                if !ordering.is_eq() {
                    return ordering;
                }
            }
            (Some(_), None) => return std::cmp::Ordering::Less,
            (None, Some(_)) => return std::cmp::Ordering::Greater,
            (None, None) => {}
        }

        agenda_priority_key(left)
            .cmp(agenda_priority_key(right))
            .then_with(|| item_path(left).cmp(item_path(right)))
            .then_with(|| match (left, right) {
                (
                    AgendaItem::Todo {
                        span_start: left, ..
                    },
                    AgendaItem::Todo {
                        span_start: right, ..
                    },
                ) => left.cmp(right),
                (AgendaItem::Task { code: left, .. }, AgendaItem::Task { code: right, .. }) => {
                    left.cmp(right)
                }
                (AgendaItem::Todo { .. }, AgendaItem::Task { .. }) => std::cmp::Ordering::Less,
                (AgendaItem::Task { .. }, AgendaItem::Todo { .. }) => std::cmp::Ordering::Greater,
            })
    });
}

fn item_due(item: &AgendaItem) -> Option<&str> {
    match item {
        AgendaItem::Todo { properties, .. } => properties.get("due").map(String::as_str),
        AgendaItem::Task { due, .. } => Some(due),
    }
}

fn agenda_priority_key(item: &AgendaItem) -> &str {
    match item {
        AgendaItem::Todo { properties, .. } => properties
            .get("priority")
            .map(String::as_str)
            .unwrap_or("Z"),
        AgendaItem::Task { priority, .. } => priority.as_str(),
    }
}

fn item_path(item: &AgendaItem) -> &str {
    match item {
        AgendaItem::Todo { page_path, .. } => page_path,
        AgendaItem::Task { path, .. } => path,
    }
}
