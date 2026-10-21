//! Params and helpers for the read-only Bases, agenda/calendar and feed tools.

use chrono::{Duration, Local, NaiveDate, TimeZone};
use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BaseQueryParams {
    /// Base slug, as listed by `vault_bases`.
    pub slug: String,
    /// View name within the Base (matched ASCII case-insensitively).
    pub view: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AgendaParams {
    /// Local date `YYYY-MM-DD` the agenda is classified against. Defaults to
    /// local today.
    pub today: Option<String>,
    /// Calendar window start, local date `YYYY-MM-DD` (inclusive). The
    /// calendar is returned only when both `from` and `to` are given.
    pub from: Option<String>,
    /// Calendar window end, local date `YYYY-MM-DD` (inclusive).
    pub to: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FeedEntriesParams {
    /// Only entries of these feed ids.
    pub feed: Option<Vec<i64>>,
    /// true: only unread entries. Default: all entries.
    pub unread: Option<bool>,
    /// Maximum entries to return.
    pub limit: Option<u32>,
}

/// Local today as `YYYY-MM-DD`.
pub fn local_today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn parse_date(label: &str, value: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| format!("`{label}` must be a YYYY-MM-DD date, got `{value}`"))
}

fn local_midnight_rfc3339(date: NaiveDate) -> Result<String, String> {
    let midnight = date.and_hms_opt(0, 0, 0).expect("midnight is valid");
    Local
        .from_local_datetime(&midnight)
        .earliest()
        .map(|dt| dt.to_rfc3339())
        .ok_or_else(|| format!("no local midnight on {date}"))
}

/// Calendar window for inclusive local dates `from..=to`: local-midnight
/// RFC3339 timestamps with `to` pushed one day on (the API's `to` is exclusive).
pub fn calendar_bounds(from: &str, to: &str) -> Result<(String, String), String> {
    let from_date = parse_date("from", from)?;
    let to_date = parse_date("to", to)?;
    if from_date > to_date {
        return Err(format!("`from` ({from}) must not be after `to` ({to})"));
    }
    Ok((
        local_midnight_rfc3339(from_date)?,
        local_midnight_rfc3339(to_date + Duration::days(1))?,
    ))
}

/// `GET /feeds/entries` query for `vault_feed_entries`.
pub fn feed_entries_query(params: &FeedEntriesParams) -> Vec<(&'static str, String)> {
    let mut query = Vec::new();
    if params.unread == Some(true) {
        query.push(("view", "unread".to_string()));
    }
    for id in params.feed.iter().flatten() {
        query.push(("feed", id.to_string()));
    }
    if let Some(limit) = params.limit {
        query.push(("limit", limit.to_string()));
    }
    query
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calendar_bounds_rejects_bad_dates() {
        assert!(calendar_bounds("2026-13-01", "2026-10-02").is_err());
        assert!(calendar_bounds("2026-10-03", "2026-10-02").is_err());
        assert!(calendar_bounds("2026-10-01", "nope").is_err());
    }

    #[test]
    fn calendar_bounds_makes_to_exclusive() {
        let (from, to) = calendar_bounds("2026-10-01", "2026-10-01").unwrap();
        let from = chrono::DateTime::parse_from_rfc3339(&from).unwrap();
        let to = chrono::DateTime::parse_from_rfc3339(&to).unwrap();
        assert!(to > from);
        assert!(to - from <= Duration::hours(25));
    }

    #[test]
    fn feed_entries_query_maps_params() {
        let query = feed_entries_query(&FeedEntriesParams {
            feed: Some(vec![1, 2]),
            unread: Some(true),
            limit: Some(5),
        });
        assert_eq!(
            query,
            vec![
                ("view", "unread".to_string()),
                ("feed", "1".to_string()),
                ("feed", "2".to_string()),
                ("limit", "5".to_string()),
            ]
        );
        assert!(
            feed_entries_query(&FeedEntriesParams {
                feed: None,
                unread: Some(false),
                limit: None
            })
            .is_empty()
        );
    }
}
