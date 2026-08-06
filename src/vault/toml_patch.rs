//! Surgical TOML frontmatter edits.
//!
//! The property patch path rewrites only the touched keys, preserving
//! comments, whitespace, and key order everywhere else. This is the marquee
//! property of the TOML migration: a cell edit shows up in `git diff` as the
//! changed lines and nothing else.

use std::str::FromStr;

use chrono::{DateTime, Utc};
use thiserror::Error;

use super::page::split_fenced;

/// Type hint for mapping a JSON patch value into a TOML value.
///
/// JSON has no date type, so an ISO string hinted `date`/`datetime` is written
/// as a native TOML date-time; everything else maps structurally.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueHint {
    Date,
    DateTime,
}

/// A single frontmatter edit batch: keys to set, keys to remove, and the
/// `updated_at` bump that accompanies every patch.
#[derive(Debug, Default)]
pub struct FrontmatterEdits {
    pub set: Vec<(String, serde_json::Value, Option<ValueHint>)>,
    pub remove: Vec<String>,
    /// When `Some`, `updated_at` is rewritten to this timestamp.
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Error)]
pub enum SpliceError {
    /// The page still carries legacy `---` YAML frontmatter. Callers must
    /// heal it to TOML first (full serialization), then splice.
    #[error("page has legacy YAML frontmatter; heal to TOML before splicing")]
    LegacyFrontmatter,
    #[error("page has no TOML frontmatter to splice")]
    NoFrontmatter,
    #[error("frontmatter TOML is unparseable: {0}")]
    Toml(#[from] toml_edit::TomlError),
    #[error("value for key {key} cannot be represented in TOML: {reason}")]
    UnrepresentableValue { key: String, reason: String },
}

/// Apply `edits` to the `+++` frontmatter region of `raw`, returning the full
/// new page content. Untouched frontmatter lines and the body are preserved
/// byte-for-byte.
pub fn splice_frontmatter(raw: &str, edits: &FrontmatterEdits) -> Result<String, SpliceError> {
    if raw.starts_with("---") {
        return Err(SpliceError::LegacyFrontmatter);
    }
    if !raw.starts_with("+++") {
        return Err(SpliceError::NoFrontmatter);
    }
    let (toml_str, body) = split_fenced(raw, "+++").map_err(|_| SpliceError::NoFrontmatter)?;

    let mut doc = toml_edit::DocumentMut::from_str(toml_str)?;

    for key in &edits.remove {
        doc.remove(key);
    }
    for (key, value, hint) in &edits.set {
        if value.is_null() {
            doc.remove(key);
            continue;
        }
        let item = toml_edit::Item::Value(json_to_toml_value(key, value, *hint)?);
        doc[key.as_str()] = item;
    }
    if let Some(updated_at) = &edits.updated_at {
        let text = updated_at.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true);
        let dt = toml_edit::Datetime::from_str(&text).map_err(|e| {
            SpliceError::UnrepresentableValue {
                key: "updated_at".into(),
                reason: e.to_string(),
            }
        })?;
        doc["updated_at"] = toml_edit::value(dt);
    }

    Ok(format!("+++\n{doc}+++\n{body}"))
}

/// Map a JSON value into a `toml_edit::Value`, honoring the optional hint.
///
/// Unhinted mapping: string → string, integral number → integer, other
/// number → float, bool → bool, array → array (hint applies per element),
/// object → inline table. A hinted `date`/`datetime` string parses as a
/// native TOML date-time; a hinted value that does not parse falls back to
/// its natural mapping (typing is advisory, never blocking).
fn json_to_toml_value(
    key: &str,
    value: &serde_json::Value,
    hint: Option<ValueHint>,
) -> Result<toml_edit::Value, SpliceError> {
    match value {
        serde_json::Value::Null => Err(SpliceError::UnrepresentableValue {
            key: key.to_string(),
            reason: "TOML has no null".into(),
        }),
        serde_json::Value::Bool(b) => Ok((*b).into()),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(i.into())
            } else if let Some(f) = n.as_f64() {
                Ok(f.into())
            } else {
                Err(SpliceError::UnrepresentableValue {
                    key: key.to_string(),
                    reason: format!("number {n} out of range"),
                })
            }
        }
        serde_json::Value::String(s) => {
            if matches!(hint, Some(ValueHint::Date | ValueHint::DateTime))
                && let Ok(dt) = toml_edit::Datetime::from_str(s)
            {
                return Ok(dt.into());
            }
            Ok(s.as_str().into())
        }
        serde_json::Value::Array(items) => {
            let mut array = toml_edit::Array::new();
            for item in items {
                array.push(json_to_toml_value(key, item, hint)?);
            }
            Ok(array.into())
        }
        serde_json::Value::Object(map) => {
            let mut table = toml_edit::InlineTable::new();
            for (k, v) in map {
                table.insert(k, json_to_toml_value(k, v, None)?);
            }
            Ok(table.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = "+++\n\
id = \"01900000-0000-7000-8000-000000000001\"\n\
# reading state, hand-tended\n\
status = \"queued\"\n\
rating = 3\n\
author = \"Gene Wolfe\"\n\
updated_at = 2026-08-01T09:00:00Z\n\
+++\n\
Body line one.\n\
Body line two.\n";

    fn edits(
        set: Vec<(&str, serde_json::Value, Option<ValueHint>)>,
        remove: Vec<&str>,
    ) -> FrontmatterEdits {
        FrontmatterEdits {
            set: set
                .into_iter()
                .map(|(k, v, h)| (k.to_string(), v, h))
                .collect(),
            remove: remove.into_iter().map(String::from).collect(),
            updated_at: None,
        }
    }

    #[test]
    fn only_touched_lines_differ() {
        let bump: DateTime<Utc> = "2026-08-06T10:00:00Z".parse().unwrap();
        let mut e = edits(
            vec![("status", serde_json::json!("reading"), None)],
            vec!["rating"],
        );
        e.updated_at = Some(bump);

        let out = splice_frontmatter(DOC, &e).unwrap();

        let before: Vec<&str> = DOC.lines().collect();
        let after: Vec<&str> = out.lines().collect();
        // One line removed (rating), status and updated_at rewritten in place.
        assert_eq!(after.len(), before.len() - 1);
        // Comment and untouched keys byte-identical, order preserved.
        assert!(out.contains("# reading state, hand-tended\n"));
        assert!(out.contains("id = \"01900000-0000-7000-8000-000000000001\"\n"));
        assert!(out.contains("author = \"Gene Wolfe\"\n"));
        assert!(out.contains("status = \"reading\"\n"));
        assert!(out.contains("updated_at = 2026-08-06T10:00:00Z\n"));
        assert!(!out.contains("rating"));
        // The comment still sits directly above status.
        let comment_pos = out.find("# reading state").unwrap();
        let status_pos = out.find("status = ").unwrap();
        assert!(comment_pos < status_pos);
        let between = &out[comment_pos..status_pos];
        assert_eq!(between.lines().count(), 1, "comment must stay adjacent");
        // Body byte-identical.
        assert!(out.ends_with("+++\nBody line one.\nBody line two.\n"));
        // Every unchanged input line survives verbatim.
        for line in before {
            if line.starts_with("status")
                || line.starts_with("rating")
                || line.starts_with("updated_at")
            {
                continue;
            }
            assert!(after.contains(&line), "line lost in splice: {line}");
        }
    }

    #[test]
    fn absent_key_appends_before_closing_fence() {
        let e = edits(vec![("progress", serde_json::json!(120), None)], vec![]);
        let out = splice_frontmatter(DOC, &e).unwrap();
        let fm_end = out.rfind("+++").unwrap();
        let progress_pos = out.find("progress = 120").unwrap();
        assert!(progress_pos < fm_end, "new key must be inside the fences");
        // Existing keys keep their order ahead of the new one.
        assert!(out.find("author = ").unwrap() < progress_pos);
    }

    #[test]
    fn hints_control_value_mapping() {
        let e = edits(
            vec![
                (
                    "started",
                    serde_json::json!("2026-08-06"),
                    Some(ValueHint::Date),
                ),
                ("noted", serde_json::json!("2026-08-06"), None),
                ("pages", serde_json::json!(371), None),
                ("rating", serde_json::json!(4.5), None),
            ],
            vec![],
        );
        let out = splice_frontmatter(DOC, &e).unwrap();
        assert!(
            out.contains("started = 2026-08-06\n"),
            "hinted date must be native: {out}"
        );
        assert!(
            out.contains("noted = \"2026-08-06\"\n"),
            "unhinted stays a string"
        );
        assert!(out.contains("pages = 371\n"));
        assert!(out.contains("rating = 4.5\n"));
    }

    #[test]
    fn array_values_map_per_element() {
        let e = edits(
            vec![("themes", serde_json::json!(["memory", "identity"]), None)],
            vec![],
        );
        let out = splice_frontmatter(DOC, &e).unwrap();
        assert!(out.contains("themes = [\"memory\", \"identity\"]\n"));
    }

    #[test]
    fn null_set_value_removes_the_key() {
        let e = edits(vec![("rating", serde_json::Value::Null, None)], vec![]);
        let out = splice_frontmatter(DOC, &e).unwrap();
        assert!(!out.contains("rating"));
    }

    #[test]
    fn legacy_page_returns_heal_first_sentinel() {
        let legacy = "---\nid: 01900000-0000-7000-8000-000000000001\n---\nBody\n";
        let err = splice_frontmatter(legacy, &FrontmatterEdits::default()).unwrap_err();
        assert!(matches!(err, SpliceError::LegacyFrontmatter));
    }

    #[test]
    fn no_frontmatter_is_an_error() {
        let err = splice_frontmatter("Just a body.\n", &FrontmatterEdits::default()).unwrap_err();
        assert!(matches!(err, SpliceError::NoFrontmatter));
    }
}
