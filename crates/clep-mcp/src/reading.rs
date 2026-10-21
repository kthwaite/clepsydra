//! Params and helpers for the read-only Bases, agenda/calendar and feed tools.

use chrono::{Duration, Local, NaiveDate, TimeZone};
use clep_client::client::encode_path_segment;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

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

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ImportWorkParams {
    /// DOI to import (e.g. `10.1000/xyz123`).
    pub doi: Option<String>,
    /// ISBN to import (10 or 13 digits, hyphens allowed).
    pub isbn: Option<String>,
    /// BibTeX source with one or more entries.
    pub bibtex: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MarkReadParams {
    /// Entry ids, as returned in the `id` field of `vault_feed_entries`
    /// results. Each listed entry is marked read.
    pub ids: Vec<i64>,
}

/// Validate one opaque URL path segment (slug, view name) and encode it so
/// it cannot change the route.
pub fn path_segment(label: &str, value: &str) -> Result<String, String> {
    if value.trim().is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
    {
        return Err(format!(
            "`{label}` must be a single name without `/` or `\\`, and not empty, `.` or `..`; got `{value}`"
        ));
    }
    Ok(encode_path_segment(value))
}

/// `POST` path evaluating one Base view.
pub fn base_evaluate_path(slug: &str, view: &str) -> Result<String, String> {
    Ok(format!(
        "/api/vault/bases/{}/views/{}/evaluate",
        path_segment("slug", slug)?,
        path_segment("view", view)?
    ))
}

/// Request body for `vault_import_work`: the DOI and ISBN endpoints take
/// JSON, the BibTeX endpoint takes the source as a raw `text/plain` body.
#[derive(Debug, PartialEq)]
pub enum ImportBody {
    Json(Value),
    Text(String),
}

/// Route and body for `vault_import_work`.
pub fn import_route(params: &ImportWorkParams) -> Result<(&'static str, ImportBody), String> {
    fn given(v: &Option<String>) -> Option<&str> {
        v.as_deref().map(str::trim).filter(|v| !v.is_empty())
    }
    match (
        given(&params.doi),
        given(&params.isbn),
        given(&params.bibtex),
    ) {
        (Some(doi), None, None) => Ok((
            "/api/vault/academic/import/doi",
            ImportBody::Json(json!({ "doi": doi })),
        )),
        (None, Some(isbn), None) => Ok((
            "/api/vault/academic/import/isbn",
            ImportBody::Json(json!({ "isbn": isbn })),
        )),
        (None, None, Some(bibtex)) => Ok((
            "/api/vault/academic/import/bibtex",
            ImportBody::Text(bibtex.to_string()),
        )),
        (None, None, None) => Err("provide exactly one of `doi`, `isbn` or `bibtex`".to_string()),
        _ => Err("provide only one of `doi`, `isbn` or `bibtex`, not several".to_string()),
    }
}

/// Validate `vault_feed_mark_read` input before any request.
pub fn check_mark_read(params: &MarkReadParams) -> Result<(), String> {
    if params.ids.is_empty() {
        return Err("`ids` must list at least one entry id".to_string());
    }
    Ok(())
}

/// `PATCH` path and body marking one feed entry read.
pub fn mark_entry_read_request(id: i64) -> (String, Value) {
    (
        format!("/api/vault/feeds/entries/{id}"),
        json!({ "read": true }),
    )
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

    #[test]
    fn segment_rejects_unsafe_values() {
        for bad in ["", "  ", ".", "..", "../x", "a/b", "a\\b"] {
            assert!(path_segment("slug", bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn segment_encodes_and_keeps_normal_slugs() {
        assert_eq!(
            path_segment("slug", "reading-list_2").unwrap(),
            "reading-list_2"
        );
        assert_eq!(path_segment("slug", "a%2Fb").unwrap(), "a%252Fb");
        assert_eq!(
            path_segment("view", "My View?#.x").unwrap(),
            "My%20View%3F%23%2Ex"
        );
    }

    #[test]
    fn base_evaluate_path_keeps_four_segments() {
        let path = base_evaluate_path("a%2Fb", "v w").unwrap();
        assert_eq!(path, "/api/vault/bases/a%252Fb/views/v%20w/evaluate");
        assert!(base_evaluate_path("../x", "v").is_err());
    }

    fn import(doi: Option<&str>, isbn: Option<&str>, bibtex: Option<&str>) -> ImportWorkParams {
        ImportWorkParams {
            doi: doi.map(str::to_string),
            isbn: isbn.map(str::to_string),
            bibtex: bibtex.map(str::to_string),
        }
    }

    #[test]
    fn import_route_requires_exactly_one() {
        let none = import_route(&import(None, Some("   "), Some(""))).unwrap_err();
        for name in ["doi", "isbn", "bibtex"] {
            assert!(none.contains(name), "{none}");
        }
        assert!(import_route(&import(Some("10.1/x"), Some("978"), None)).is_err());
    }

    #[test]
    fn import_route_maps_each_field() {
        let (route, body) = import_route(&import(Some(" 10.1/x "), None, None)).unwrap();
        assert_eq!(route, "/api/vault/academic/import/doi");
        assert_eq!(body, ImportBody::Json(json!({"doi": "10.1/x"})));
        let (route, body) = import_route(&import(None, Some("978-0"), None)).unwrap();
        assert_eq!(route, "/api/vault/academic/import/isbn");
        assert_eq!(body, ImportBody::Json(json!({"isbn": "978-0"})));
        let (route, body) = import_route(&import(None, None, Some("@book{a}"))).unwrap();
        assert_eq!(route, "/api/vault/academic/import/bibtex");
        assert_eq!(body, ImportBody::Text("@book{a}".to_string()));
    }

    #[test]
    fn mark_read_rejects_empty_ids() {
        assert!(check_mark_read(&MarkReadParams { ids: vec![] }).is_err());
        assert!(check_mark_read(&MarkReadParams { ids: vec![1] }).is_ok());
    }

    #[test]
    fn mark_entry_read_request_patches_the_entry() {
        let (path, body) = mark_entry_read_request(42);
        assert_eq!(path, "/api/vault/feeds/entries/42");
        assert_eq!(body, serde_json::json!({"read": true}));
    }
}
