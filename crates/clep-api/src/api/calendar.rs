//! `GET /api/vault/index/calendar`: the pages placed on calendar days in a
//! time window.
//!
//! The server stays timezone-agnostic. The client sends its local-midnight
//! window bounds as RFC 3339 strings with offsets and buckets the flat
//! entries into local days itself.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use chrono::{DateTime, FixedOffset, Utc};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::AppState;
use super::error::ApiError;
use crate::vault::index::{CalendarPage, CalendarQuery};
use crate::vault::kind::Kind;

/// Most entries one response carries; `truncated` flags the rest.
pub const CALENDAR_ENTRY_LIMIT: usize = 5000;
/// Widest accepted window. A 12-month running grid spans about 386 days.
pub const CALENDAR_MAX_SPAN_DAYS: i64 = 450;

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct CalendarQueryParams {
    /// Inclusive window start, RFC3339 with offset (client local midnight).
    pub from: String,
    /// Exclusive window end, RFC3339 with offset.
    pub to: String,
    /// Comma-separated canonical Kind tokens; omitted = all kinds.
    pub kind: Option<String>,
    /// Exact tag.
    pub tag: Option<String>,
    /// Exact project slug.
    pub project: Option<String>,
}

/// One page placed in the window.
#[derive(Debug, Serialize, ToSchema)]
pub struct CalendarEntry {
    pub path: String,
    pub title: Option<String>,
    #[schema(value_type = crate::vault::kind::Kind)]
    pub kind: String,
    /// RFC3339 UTC creation time; the placement date for non-journal pages.
    pub created_at: Option<String>,
    /// `YYYY-MM-DD`; the placement date for journal-kind pages.
    pub journal_date: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CalendarResponse {
    pub entries: Vec<CalendarEntry>,
    /// True when more pages matched than `entries` carries.
    pub truncated: bool,
}

impl From<CalendarPage> for CalendarResponse {
    fn from(page: CalendarPage) -> Self {
        Self {
            entries: page
                .entries
                .into_iter()
                .map(|entry| CalendarEntry {
                    path: entry.path,
                    title: entry.title,
                    kind: entry.kind,
                    created_at: entry.created_at,
                    journal_date: entry.journal_date,
                })
                .collect(),
            truncated: page.truncated,
        }
    }
}

fn parse_bound(value: &str, name: &str) -> Result<DateTime<FixedOffset>, ApiError> {
    DateTime::parse_from_rfc3339(value.trim())
        .map_err(|_| ApiError::bad_request(format!("invalid {name}")))
}

fn parse_kinds(kind: Option<&str>) -> Result<Vec<String>, ApiError> {
    let mut kinds: Vec<String> = Vec::new();
    for token in kind.unwrap_or_default().split(',').map(str::trim) {
        if token.is_empty() {
            continue;
        }
        let canonical = Kind::from_token(token)
            .ok_or_else(|| ApiError::bad_request(format!("unknown kind: {token}")))?
            .as_str()
            .to_string();
        if !kinds.contains(&canonical) {
            kinds.push(canonical);
        }
    }
    Ok(kinds)
}

fn non_blank(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

impl CalendarQueryParams {
    fn into_query(self) -> Result<CalendarQuery, ApiError> {
        let from = parse_bound(&self.from, "from")?;
        let to = parse_bound(&self.to, "to")?;
        if to <= from {
            return Err(ApiError::bad_request("to must be after from"));
        }
        if to.signed_duration_since(from) > chrono::Duration::days(CALENDAR_MAX_SPAN_DAYS) {
            return Err(ApiError::bad_request(format!(
                "window spans more than {CALENDAR_MAX_SPAN_DAYS} days"
            )));
        }
        Ok(CalendarQuery {
            from_utc: from.with_timezone(&Utc).to_rfc3339(),
            to_utc: to.with_timezone(&Utc).to_rfc3339(),
            journal_from: from.date_naive(),
            journal_to: to.date_naive(),
            kinds: parse_kinds(self.kind.as_deref())?,
            tag: non_blank(self.tag),
            project: non_blank(self.project),
            limit: CALENDAR_ENTRY_LIMIT,
        })
    }
}

/// Pages placed on calendar days in a window.
///
/// Journal-kind pages with a `journal_date` are placed on that date and are
/// returned when it lies in `[date(from), date(to)]` (each date in its own
/// offset; padded on purpose, the client trims). Every other page is placed
/// on `created_at` and is returned when `from <= created_at < to`.
#[utoipa::path(
    get,
    path = "/index/calendar",
    context_path = "/api/vault",
    tag = "Index",
    params(CalendarQueryParams),
    responses(
        (status = 200, description = "Calendar entries", body = CalendarResponse),
        (status = 400, description = "Invalid window or kind", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn calendar_entries(
    State(state): State<Arc<AppState>>,
    Query(params): Query<CalendarQueryParams>,
) -> Result<Json<CalendarResponse>, ApiError> {
    let query = params.into_query()?;
    let page = state
        .index
        .calendar_entries(query)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(page.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(from: &str, to: &str) -> CalendarQueryParams {
        CalendarQueryParams {
            from: from.to_string(),
            to: to.to_string(),
            kind: None,
            tag: None,
            project: None,
        }
    }

    #[test]
    fn normalises_bounds_to_utc_and_keeps_local_journal_dates() {
        let query = params("2026-09-01T00:00:00+01:00", "2026-10-01T00:00:00+01:00")
            .into_query()
            .unwrap();
        assert_eq!(query.from_utc, "2026-08-31T23:00:00+00:00");
        assert_eq!(query.to_utc, "2026-09-30T23:00:00+00:00");
        assert_eq!(query.journal_from.to_string(), "2026-09-01");
        assert_eq!(query.journal_to.to_string(), "2026-10-01");
        assert_eq!(query.limit, CALENDAR_ENTRY_LIMIT);
    }

    #[test]
    fn kinds_are_canonicalised_and_deduplicated() {
        assert_eq!(
            parse_kinds(Some("note, NOTE,,recipe")).unwrap(),
            vec!["NOTE".to_string(), "RECIPE".to_string()]
        );
        assert!(parse_kinds(None).unwrap().is_empty());
    }
}
