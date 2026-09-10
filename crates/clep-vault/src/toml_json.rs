//! Explicit TOML → JSON value conversion.
//!
//! `toml::value::Datetime` carries a private serde representation; serializing
//! a `toml::Value` straight into JSON leaks a `$__toml_private_datetime`
//! artifact instead of a date string. Every JSON boundary that touches
//! `PageMeta::extra` therefore goes through this conversion, which maps
//! date-times to their ISO 8601 text form and everything else structurally.

/// Convert a TOML value into a JSON value.
///
/// Date-times become ISO 8601 strings (local dates as `2026-07-30`, offset
/// date-times in RFC 3339 form). Non-finite floats, which JSON cannot
/// represent, become `null`.
pub fn toml_value_to_json(value: &toml::Value) -> serde_json::Value {
    match value {
        toml::Value::String(s) => serde_json::Value::String(s.clone()),
        toml::Value::Integer(i) => serde_json::Value::Number((*i).into()),
        toml::Value::Float(f) => serde_json::Number::from_f64(*f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        toml::Value::Boolean(b) => serde_json::Value::Bool(*b),
        toml::Value::Datetime(dt) => serde_json::Value::String(dt.to_string()),
        toml::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(toml_value_to_json).collect())
        }
        toml::Value::Table(table) => serde_json::Value::Object(
            table
                .iter()
                .map(|(k, v)| (k.clone(), toml_value_to_json(v)))
                .collect(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_date_becomes_plain_iso_string() {
        let value: toml::Value = "d = 2026-07-30".parse::<toml::Table>().unwrap()["d"].clone();
        assert_eq!(
            toml_value_to_json(&value),
            serde_json::Value::String("2026-07-30".into())
        );
    }

    #[test]
    fn offset_datetime_becomes_rfc3339_string() {
        let value: toml::Value =
            "d = 2026-08-06T09:00:00Z".parse::<toml::Table>().unwrap()["d"].clone();
        assert_eq!(
            toml_value_to_json(&value),
            serde_json::Value::String("2026-08-06T09:00:00Z".into())
        );
    }

    #[test]
    fn no_private_datetime_artifact_in_output() {
        let table: toml::Table = "nested = { when = 2026-07-30, list = [2026-01-01] }"
            .parse()
            .unwrap();
        let json = serde_json::to_string(&toml_value_to_json(&toml::Value::Table(table))).unwrap();
        assert!(
            !json.contains("$__toml_private_datetime"),
            "artifact leaked: {json}"
        );
        assert!(json.contains("2026-07-30"));
    }

    #[test]
    fn scalars_map_structurally() {
        assert_eq!(
            toml_value_to_json(&toml::Value::Integer(4)),
            serde_json::json!(4)
        );
        assert_eq!(
            toml_value_to_json(&toml::Value::Float(4.5)),
            serde_json::json!(4.5)
        );
        assert_eq!(
            toml_value_to_json(&toml::Value::Boolean(true)),
            serde_json::json!(true)
        );
        assert_eq!(
            toml_value_to_json(&toml::Value::String("x".into())),
            serde_json::json!("x")
        );
        assert_eq!(
            toml_value_to_json(&toml::Value::Float(f64::NAN)),
            serde_json::Value::Null
        );
    }
}
