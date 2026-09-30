//! Calendar entries: the pages placed inside a time window.
//!
//! This module is timezone-agnostic. The caller passes the window as
//! normalised UTC RFC 3339 strings plus the padded journal date range; the
//! client buckets entries into local days.

use chrono::NaiveDate;
use rusqlite::params_from_iter;
use rusqlite::types::Value;

use crate::index::{IndexError, VaultIndex};
use clep_vault::kind::Kind;

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

impl VaultIndex {
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
}
