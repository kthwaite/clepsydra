use rusqlite::{Transaction, params};

use crate::vault::derivation::{Deriver, IndexedPage};
use crate::vault::index::IndexError;
use crate::vault::toml_json::toml_value_to_json;

/// One `page_properties` row for a single property value (or array element).
#[derive(Debug, Clone, PartialEq)]
pub struct Projection {
    pub ord: i64,
    /// Canonical JSON (date-times as ISO strings). Always present.
    pub value_json: String,
    pub value_text: Option<String>,
    pub value_num: Option<f64>,
    pub value_date: Option<String>,
    pub value_bool: Option<bool>,
}

/// Project a TOML value into `page_properties` rows.
///
/// Projections come from **native types only** — a string never gains
/// `value_num` or `value_date`; that was YAML-era compensation. TOML has no
/// null, so the empty string and the empty array project to no rows at all:
/// absence is the only empty state (`is_empty` relies on this).
pub fn project(value: &toml::Value) -> Vec<Projection> {
    match value {
        toml::Value::Array(items) => items
            .iter()
            .enumerate()
            .filter_map(|(i, item)| scalar_projection(item, i as i64))
            .collect(),
        _ => scalar_projection(value, 0).into_iter().collect(),
    }
}

/// Project a single non-array value at the given `ord`. Returns `None` for
/// values that represent emptiness (empty string, nested empty array).
fn scalar_projection(value: &toml::Value, ord: i64) -> Option<Projection> {
    let value_json =
        serde_json::to_string(&toml_value_to_json(value)).expect("JSON value always serializes");
    let mut row = Projection {
        ord,
        value_json,
        value_text: None,
        value_num: None,
        value_date: None,
        value_bool: None,
    };
    match value {
        toml::Value::String(s) => {
            if s.is_empty() {
                return None;
            }
            // Wiki-link strings stay raw; resolution is the links table's job.
            row.value_text = Some(s.clone());
        }
        toml::Value::Integer(i) => {
            row.value_num = Some(*i as f64);
            row.value_text = Some(i.to_string());
        }
        toml::Value::Float(f) => {
            row.value_num = Some(*f);
            row.value_text = Some(f.to_string());
        }
        toml::Value::Boolean(b) => {
            row.value_bool = Some(*b);
            row.value_text = Some(b.to_string());
        }
        toml::Value::Datetime(dt) => {
            let text = dt.to_string();
            // A local time without a date is not a date.
            if dt.date.is_some() {
                row.value_date = Some(text.clone());
            }
            row.value_text = Some(text);
        }
        // Nested arrays and tables are opaque: value_json only.
        toml::Value::Array(items) => {
            if items.is_empty() {
                return None;
            }
        }
        toml::Value::Table(_) => {}
    }
    Some(row)
}

/// Derives `page_properties` rows from every key in a page's frontmatter
/// extras. Schema-blind: all keys are indexed regardless of any base schema.
pub struct PropertyDeriver;

impl Deriver for PropertyDeriver {
    fn name(&self) -> &str {
        "properties"
    }

    fn derive(
        &self,
        page: &IndexedPage,
        page_id: &str,
        tx: &Transaction,
    ) -> Result<(), IndexError> {
        for (key, value) in &page.meta.extra {
            for p in project(value) {
                tx.execute(
                    "INSERT INTO page_properties (page_id, key, ord, value_json, value_text, value_num, value_date, value_bool)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        page_id,
                        key,
                        p.ord,
                        p.value_json,
                        p.value_text,
                        p.value_num,
                        p.value_date,
                        p.value_bool.map(|b| b as i64),
                    ],
                )?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_value(toml: &str) -> toml::Value {
        let table: toml::Table = toml.parse().unwrap();
        table.into_iter().next().unwrap().1
    }

    #[test]
    fn string_projects_text_only() {
        let rows = project(&parse_value("v = \"Gene Wolfe\""));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].value_text.as_deref(), Some("Gene Wolfe"));
        assert_eq!(rows[0].value_num, None);
        assert_eq!(rows[0].value_date, None);
        assert_eq!(rows[0].value_bool, None);
    }

    #[test]
    fn numeric_looking_string_gains_no_value_num() {
        // The anti-sniffing assertion: YAML-era coercion is gone.
        let rows = project(&parse_value("v = \"4\""));
        assert_eq!(rows[0].value_num, None);
        assert_eq!(rows[0].value_text.as_deref(), Some("4"));

        let datey = project(&parse_value("v = \"2026-07-30\""));
        assert_eq!(datey[0].value_date, None, "string dates are not dates");
    }

    #[test]
    fn integer_and_float_project_num_and_text() {
        let int_rows = project(&parse_value("v = 371"));
        assert_eq!(int_rows[0].value_num, Some(371.0));
        assert_eq!(int_rows[0].value_text.as_deref(), Some("371"));

        let float_rows = project(&parse_value("v = 4.5"));
        assert_eq!(float_rows[0].value_num, Some(4.5));
        assert_eq!(float_rows[0].value_text.as_deref(), Some("4.5"));
    }

    #[test]
    fn boolean_projects_bool_and_text() {
        let rows = project(&parse_value("v = true"));
        assert_eq!(rows[0].value_bool, Some(true));
        assert_eq!(rows[0].value_text.as_deref(), Some("true"));
        assert_eq!(rows[0].value_num, None);
    }

    #[test]
    fn date_types_project_normalized_iso_date() {
        let local_date = project(&parse_value("v = 2026-07-30"));
        assert_eq!(local_date[0].value_date.as_deref(), Some("2026-07-30"));

        let local_dt = project(&parse_value("v = 2026-07-30T09:00:00"));
        assert_eq!(
            local_dt[0].value_date.as_deref(),
            Some("2026-07-30T09:00:00")
        );

        let offset_dt = project(&parse_value("v = 2026-07-30T09:00:00Z"));
        assert_eq!(
            offset_dt[0].value_date.as_deref(),
            Some("2026-07-30T09:00:00Z")
        );
    }

    #[test]
    fn local_time_is_text_only() {
        let rows = project(&parse_value("v = 09:00:00"));
        assert_eq!(rows[0].value_date, None, "a bare time is not a date");
        assert_eq!(rows[0].value_text.as_deref(), Some("09:00:00"));
    }

    #[test]
    fn array_projects_one_row_per_element() {
        let rows = project(&parse_value("v = [\"memory\", \"identity\"]"));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].ord, 0);
        assert_eq!(rows[0].value_text.as_deref(), Some("memory"));
        assert_eq!(rows[1].ord, 1);
        assert_eq!(rows[1].value_text.as_deref(), Some("identity"));
    }

    #[test]
    fn table_projects_single_opaque_json_row() {
        let rows = project(&parse_value("v = { url = \"https://x\", n = 4 }"));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].value_text, None);
        assert_eq!(rows[0].value_num, None);
        assert_eq!(rows[0].value_date, None);
        assert_eq!(rows[0].value_bool, None);
        let json: serde_json::Value = serde_json::from_str(&rows[0].value_json).unwrap();
        assert_eq!(json["url"], "https://x");
        assert_eq!(json["n"], 4);
    }

    #[test]
    fn wiki_link_string_keeps_raw_text() {
        let rows = project(&parse_value("v = [\"[[Solar Cycle]]\"]"));
        assert_eq!(rows[0].value_text.as_deref(), Some("[[Solar Cycle]]"));
    }

    #[test]
    fn empty_string_and_empty_array_project_no_rows() {
        assert!(project(&parse_value("v = \"\"")).is_empty());
        assert!(project(&parse_value("v = []")).is_empty());
    }

    #[test]
    fn datetime_json_has_no_private_artifact() {
        let rows = project(&parse_value("v = 2026-07-30"));
        assert!(!rows[0].value_json.contains("$__toml_private_datetime"));
        assert_eq!(rows[0].value_json, "\"2026-07-30\"");
    }
}
