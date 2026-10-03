//! Calendar entries: the pages placed inside a time window.
//!
//! This module is timezone-agnostic. The caller passes the window as
//! normalised UTC RFC 3339 strings plus the padded journal date range; the
//! client buckets entries into local days.

use chrono::NaiveDate;
use rusqlite::params_from_iter;
use rusqlite::types::Value;

use crate::index::{IndexError, VaultIndex};
use clep_vault::birthday;
use clep_vault::board_vocab::{DEFAULT_PRIORITY, DEFAULT_STATUS};
use clep_vault::kind::Kind;

/// Checkbox todo statuses the calendar shows, done ones included.
const TODO_STATUSES: [&str; 4] = ["todo", "doing", "done", "cancelled"];
/// TASK statuses the calendar shows; unknown values are skipped.
const TASK_STATUSES: [&str; 5] = ["INTAKE", "TRIAGE", "FIELD", "REVIEW", "SEALED"];
/// TASK priorities; unknown values are skipped.
const TASK_PRIORITIES: [&str; 4] = ["P0", "P1", "P2", "P3"];

/// A calendar window and its filters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarQuery {
    /// Window start, inclusive, as `DateTime<Utc>::to_rfc3339()`.
    pub from_utc: String,
    /// Window end, exclusive, as `DateTime<Utc>::to_rfc3339()`.
    pub to_utc: String,
    /// First journal date, inclusive.
    pub journal_from: NaiveDate,
    /// Last journal date, inclusive (padded by design; the client trims).
    pub journal_to: NaiveDate,
    /// Canonical kind tokens. Empty means every kind.
    pub kinds: Vec<String>,
    pub tag: Option<String>,
    pub project: Option<String>,
    pub limit: usize,
}

/// One page in the calendar window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarEntry {
    pub path: String,
    pub title: Option<String>,
    pub kind: String,
    pub created_at: Option<String>,
    pub journal_date: Option<String>,
}

/// The entries in a window, capped at the query limit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarPage {
    pub entries: Vec<CalendarEntry>,
    pub truncated: bool,
}

/// A PERSON page's birthday. `year` is `None` when the year is unknown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BirthdayEntry {
    pub path: String,
    pub title: Option<String>,
    pub year: Option<i32>,
    pub month: u32,
    pub day: u32,
}

/// A checkbox todo with a due date in the window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarTodoEntry {
    pub content: String,
    /// `todo`, `doing`, `done` or `cancelled`.
    pub status: String,
    /// `YYYY-MM-DD`.
    pub due: String,
    pub priority: Option<String>,
    pub page_path: String,
    pub page_title: Option<String>,
    /// The host page's kind.
    pub page_kind: String,
    pub span_start: i64,
}

/// A TASK page with a frontmatter `due` in the window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarTaskEntry {
    /// The page id (a UUID string).
    pub id: String,
    pub path: String,
    pub title: Option<String>,
    /// `INTAKE`, `TRIAGE`, `FIELD`, `REVIEW` or `SEALED`.
    pub status: String,
    /// `P0`..`P3`.
    pub priority: String,
    pub project: Option<String>,
    /// `YYYY-MM-DD`.
    pub due: String,
}

/// One dated todo: a checkbox block or a TASK page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CalendarDueItem {
    Todo(CalendarTodoEntry),
    Task(CalendarTaskEntry),
}

impl CalendarDueItem {
    /// Sort key: due, host path (case-insensitive), span. A TASK sorts
    /// before its own page's checkbox todos.
    fn sort_key(&self) -> (String, String, i64) {
        match self {
            Self::Todo(todo) => (
                todo.due.clone(),
                todo.page_path.to_lowercase(),
                todo.span_start,
            ),
            Self::Task(task) => (task.due.clone(), task.path.to_lowercase(), -1),
        }
    }
}

/// The dated todos in a window, capped at the query limit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarTodoPage {
    pub items: Vec<CalendarDueItem>,
    pub truncated: bool,
}

/// `value` as a date when it has the strict `YYYY-MM-DD` shape and is real.
fn strict_date(value: &str) -> Option<NaiveDate> {
    let bytes = value.as_bytes();
    let shaped = bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            _ => b.is_ascii_digit(),
        });
    shaped
        .then(|| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
        .flatten()
}

/// A frontmatter scalar as a trimmed string; mirrors the agenda's reading.
fn meta_string(metadata: &serde_json::Value, key: &str) -> Option<String> {
    match metadata.get(key) {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(value)) => {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        }
        Some(value) => Some(value.to_string()),
    }
}

/// Host-page filters shared by both todo sources. Appends to `conditions`
/// and `values`; `p` is the host page alias.
fn push_host_filters(q: &CalendarQuery, conditions: &mut Vec<String>, values: &mut Vec<Value>) {
    if let Some(project) = &q.project {
        conditions.push("p.project = ?".to_string());
        values.push(Value::Text(project.clone()));
    }
    if let Some(tag) = &q.tag {
        conditions
            .push("EXISTS (SELECT 1 FROM tags t WHERE t.page_id = p.id AND t.tag = ?)".into());
        values.push(Value::Text(tag.clone()));
    }
}

impl VaultIndex {
    /// PERSON pages whose frontmatter `birthday` parses (see
    /// [`clep_vault::birthday::parse`]); invalid values are skipped. Ordered
    /// by month, day, then title (case-insensitive). Not windowed: the client
    /// expands yearly occurrences.
    pub fn calendar_birthdays(
        &self,
        tag: Option<&str>,
        project: Option<&str>,
    ) -> Result<Vec<BirthdayEntry>, IndexError> {
        let mut conditions = vec![
            "p.kind = ?".to_string(),
            "json_type(p.meta_json, '$.birthday') = 'text'".to_string(),
        ];
        let mut values = vec![Value::Text(Kind::Person.as_str().to_string())];
        if let Some(project) = project {
            conditions.push("p.project = ?".to_string());
            values.push(Value::Text(project.to_string()));
        }
        if let Some(tag) = tag {
            conditions
                .push("EXISTS (SELECT 1 FROM tags t WHERE t.page_id = p.id AND t.tag = ?)".into());
            values.push(Value::Text(tag.to_string()));
        }
        let sql = format!(
            "SELECT p.path, p.title, json_extract(p.meta_json, '$.birthday') \
             FROM pages p WHERE {}",
            conditions.join(" AND ")
        );

        let conn = self.connection();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(values), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut entries: Vec<BirthdayEntry> = rows
            .into_iter()
            .filter_map(|(path, title, raw)| {
                let parsed = birthday::parse(&serde_json::Value::String(raw))?;
                Some(BirthdayEntry {
                    path,
                    title,
                    year: parsed.year,
                    month: parsed.month,
                    day: parsed.day,
                })
            })
            .collect();
        entries.sort_by_cached_key(|e| {
            (
                e.month,
                e.day,
                e.title.as_deref().unwrap_or_default().to_lowercase(),
                e.path.to_lowercase(),
            )
        });
        Ok(entries)
    }

    /// Pages placed inside the window, at most `q.limit`.
    ///
    /// Placement rule: a `JOURNAL` or `AI_JOURNAL` page with a
    /// `journal_date` is placed on that date, and is returned when the date
    /// lies in `[journal_from, journal_to]`. Every other page, including a
    /// journal-kind page without a `journal_date`, is placed on `created_at`
    /// and is returned when `from_utc <= created_at < to_utc`. A page with no
    /// `created_at` is left out. Entries are ordered by placement date, then
    /// path (case-insensitive). `truncated` is true when more pages matched.
    pub fn calendar_entries(&self, q: &CalendarQuery) -> Result<CalendarPage, IndexError> {
        // Binds two journal-kind parameters each time it appears.
        let is_placed_by_journal_date = "(p.kind IN (?, ?) AND p.journal_date IS NOT NULL)";
        let journal_kinds = |values: &mut Vec<Value>| {
            values.push(Value::Text(Kind::Journal.as_str().to_string()));
            values.push(Value::Text(Kind::AiJournal.as_str().to_string()));
        };

        let mut values: Vec<Value> = Vec::new();

        let mut conditions = Vec::new();
        conditions.push(format!(
            "(({is_placed_by_journal_date} AND p.journal_date BETWEEN ? AND ?) \
             OR (NOT {is_placed_by_journal_date} \
                 AND p.created_at IS NOT NULL AND p.created_at >= ? AND p.created_at < ?))"
        ));
        journal_kinds(&mut values);
        values.push(Value::Text(q.journal_from.to_string()));
        values.push(Value::Text(q.journal_to.to_string()));
        journal_kinds(&mut values);
        values.push(Value::Text(q.from_utc.clone()));
        values.push(Value::Text(q.to_utc.clone()));

        if !q.kinds.is_empty() {
            let marks = vec!["?"; q.kinds.len()].join(", ");
            conditions.push(format!("p.kind IN ({marks})"));
            values.extend(q.kinds.iter().cloned().map(Value::Text));
        }
        if let Some(project) = &q.project {
            conditions.push("p.project = ?".to_string());
            values.push(Value::Text(project.clone()));
        }
        if let Some(tag) = &q.tag {
            conditions
                .push("EXISTS (SELECT 1 FROM tags t WHERE t.page_id = p.id AND t.tag = ?)".into());
            values.push(Value::Text(tag.clone()));
        }

        let sql = format!(
            "SELECT p.path, p.title, p.kind, p.created_at, p.journal_date \
             FROM pages p WHERE {} \
             ORDER BY CASE WHEN {is_placed_by_journal_date} THEN p.journal_date \
                           ELSE p.created_at END, \
                      p.path COLLATE NOCASE \
             LIMIT ?",
            conditions.join(" AND ")
        );
        journal_kinds(&mut values);
        values.push(Value::Integer(
            i64::try_from(q.limit.saturating_add(1)).unwrap_or(i64::MAX),
        ));

        let conn = self.connection();
        let mut stmt = conn.prepare(&sql)?;
        let mut entries = stmt
            .query_map(params_from_iter(values), |r| {
                Ok(CalendarEntry {
                    path: r.get(0)?,
                    title: r.get(1)?,
                    kind: r.get(2)?,
                    created_at: r.get(3)?,
                    journal_date: r.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let truncated = entries.len() > q.limit;
        entries.truncate(q.limit);
        Ok(CalendarPage { entries, truncated })
    }

    /// Dated todos in the window, at most `q.limit`.
    ///
    /// Two sources. Checkbox todos (any status) whose `due` block property
    /// is a strict `YYYY-MM-DD` date in `[journal_from, journal_to]`; their
    /// host page may not be `AI_JOURNAL`. TASK pages whose frontmatter `due`
    /// is such a date; `status` defaults to `INTAKE` and `priority` to `P2`,
    /// and unknown values skip the task. Kind, tag and project filters apply
    /// to the host page (a TASK page is its own host). Ordered by due, host
    /// path (case-insensitive), then span. `truncated` is true when more
    /// items matched.
    pub fn calendar_todos(&self, q: &CalendarQuery) -> Result<CalendarTodoPage, IndexError> {
        let in_window = |due: &str| {
            strict_date(due).is_some_and(|date| date >= q.journal_from && date <= q.journal_to)
        };
        let mut items: Vec<CalendarDueItem> = self
            .calendar_checkbox_todos(q)?
            .into_iter()
            .filter(|todo| in_window(&todo.due))
            .map(CalendarDueItem::Todo)
            .collect();
        let wants_tasks = q.kinds.is_empty() || q.kinds.iter().any(|k| k == Kind::Task.as_str());
        if wants_tasks {
            items.extend(
                self.calendar_tasks(q)?
                    .into_iter()
                    .filter(|task| in_window(&task.due))
                    .map(CalendarDueItem::Task),
            );
        }
        items.sort_by_cached_key(CalendarDueItem::sort_key);
        let truncated = items.len() > q.limit;
        items.truncate(q.limit);
        Ok(CalendarTodoPage { items, truncated })
    }

    /// Checkbox todos whose `due` lies textually in the window. The caller
    /// applies the strict date check.
    fn calendar_checkbox_todos(
        &self,
        q: &CalendarQuery,
    ) -> Result<Vec<CalendarTodoEntry>, IndexError> {
        let status_marks = vec!["?"; TODO_STATUSES.len()].join(", ");
        let mut conditions = vec![
            format!("status_prop.value IN ({status_marks})"),
            "due_prop.value BETWEEN ? AND ?".to_string(),
            "p.kind != ?".to_string(),
        ];
        let mut values: Vec<Value> = TODO_STATUSES
            .iter()
            .map(|status| Value::Text((*status).to_string()))
            .collect();
        values.push(Value::Text(q.journal_from.to_string()));
        values.push(Value::Text(q.journal_to.to_string()));
        values.push(Value::Text(Kind::AiJournal.as_str().to_string()));
        if !q.kinds.is_empty() {
            let marks = vec!["?"; q.kinds.len()].join(", ");
            conditions.push(format!("p.kind IN ({marks})"));
            values.extend(q.kinds.iter().cloned().map(Value::Text));
        }
        push_host_filters(q, &mut conditions, &mut values);

        let sql = format!(
            "SELECT b.content, status_prop.value, due_prop.value, priority_prop.value, \
                    p.path, p.title, p.kind, b.span_start \
             FROM blocks b \
             JOIN pages p ON p.id = b.page_id \
             JOIN block_properties status_prop \
               ON status_prop.page_id = b.page_id \
              AND status_prop.span_start = b.span_start \
              AND status_prop.key = 'status' \
             JOIN block_properties due_prop \
               ON due_prop.page_id = b.page_id \
              AND due_prop.span_start = b.span_start \
              AND due_prop.key = 'due' \
             LEFT JOIN block_properties priority_prop \
               ON priority_prop.page_id = b.page_id \
              AND priority_prop.span_start = b.span_start \
              AND priority_prop.key = 'priority' \
             WHERE {}",
            conditions.join(" AND ")
        );
        let conn = self.connection();
        let mut stmt = conn.prepare(&sql)?;
        let todos = stmt
            .query_map(params_from_iter(values), |r| {
                Ok(CalendarTodoEntry {
                    content: r.get(0)?,
                    status: r.get(1)?,
                    due: r.get(2)?,
                    priority: r.get(3)?,
                    page_path: r.get(4)?,
                    page_title: r.get(5)?,
                    page_kind: r.get(6)?,
                    span_start: r.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(todos)
    }

    /// TASK pages with a `due`, defaults applied and unknown status or
    /// priority skipped. The caller applies the window.
    fn calendar_tasks(&self, q: &CalendarQuery) -> Result<Vec<CalendarTaskEntry>, IndexError> {
        let mut conditions = vec!["p.kind = ?".to_string()];
        let mut values = vec![Value::Text(Kind::Task.as_str().to_string())];
        push_host_filters(q, &mut conditions, &mut values);
        let sql = format!(
            "SELECT p.id, p.path, p.title, p.meta_json, p.project FROM pages p WHERE {}",
            conditions.join(" AND ")
        );
        let conn = self.connection();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(values), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rows
            .into_iter()
            .filter_map(|(id, path, title, meta_json, project)| {
                let metadata: serde_json::Value = meta_json
                    .and_then(|json| serde_json::from_str(&json).ok())
                    .unwrap_or(serde_json::Value::Null);
                let due = meta_string(&metadata, "due")?;
                let status =
                    meta_string(&metadata, "status").unwrap_or_else(|| DEFAULT_STATUS.to_string());
                let priority = meta_string(&metadata, "priority")
                    .unwrap_or_else(|| DEFAULT_PRIORITY.to_string());
                if !TASK_STATUSES.contains(&status.as_str())
                    || !TASK_PRIORITIES.contains(&priority.as_str())
                {
                    return None;
                }
                Some(CalendarTaskEntry {
                    id,
                    path,
                    title,
                    status,
                    priority,
                    project,
                    due,
                })
            })
            .collect())
    }
}
