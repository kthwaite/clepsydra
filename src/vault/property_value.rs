use std::collections::HashSet;

use thiserror::Error;

use super::base::{PropertyDefinition, PropertyType};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PropertyValueError {
    #[error("{key} must be {expected}")]
    InvalidShape { key: String, expected: &'static str },
    #[error("{key} must be one of: {options}")]
    UnknownOption { key: String, options: String },
    #[error("{key} must contain unique values")]
    DuplicateValue { key: String },
    #[error("{key} must be a TOML-representable number")]
    NumberOutOfRange { key: String },
}

impl PropertyValueError {
    fn shape(key: &str, expected: &'static str) -> Self {
        Self::InvalidShape {
            key: key.to_string(),
            expected,
        }
    }

    fn unknown_option(key: &str, definition: &PropertyDefinition) -> Self {
        Self::UnknownOption {
            key: key.to_string(),
            options: definition.options.join(", "),
        }
    }
}

pub fn coerce_property_value(
    key: &str,
    value: &serde_json::Value,
    definition: &PropertyDefinition,
) -> Result<toml::Value, PropertyValueError> {
    match definition.property_type {
        PropertyType::Text | PropertyType::Url => string_value(key, value).map(toml::Value::String),
        PropertyType::Relation => relation_value(key, value),
        PropertyType::Select => select_value(key, value, definition),
        PropertyType::MultiSelect => multi_select_value(key, value, definition),
        PropertyType::Number => number_value(key, value),
        PropertyType::Bool => value
            .as_bool()
            .map(toml::Value::Boolean)
            .ok_or_else(|| PropertyValueError::shape(key, "a boolean")),
        PropertyType::Date => datetime_value(key, value, DateShape::Date),
        PropertyType::Datetime => datetime_value(key, value, DateShape::DateTime),
    }
}

fn string_value(key: &str, value: &serde_json::Value) -> Result<String, PropertyValueError> {
    value
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| PropertyValueError::shape(key, "a string"))
}

fn relation_value(key: &str, value: &serde_json::Value) -> Result<toml::Value, PropertyValueError> {
    match value {
        serde_json::Value::String(value) => Ok(toml::Value::String(value.clone())),
        serde_json::Value::Array(values) => {
            let mut coerced = Vec::with_capacity(values.len());
            for value in values {
                let value = value.as_str().ok_or_else(|| {
                    PropertyValueError::shape(key, "a string or an array of strings")
                })?;
                coerced.push(toml::Value::String(value.to_owned()));
            }
            Ok(toml::Value::Array(coerced))
        }
        _ => Err(PropertyValueError::shape(
            key,
            "a string or an array of strings",
        )),
    }
}

fn select_value(
    key: &str,
    value: &serde_json::Value,
    definition: &PropertyDefinition,
) -> Result<toml::Value, PropertyValueError> {
    let value = value
        .as_str()
        .ok_or_else(|| PropertyValueError::shape(key, "a string"))?;
    validate_option(key, value, definition)?;
    Ok(toml::Value::String(value.to_string()))
}

fn multi_select_value(
    key: &str,
    value: &serde_json::Value,
    definition: &PropertyDefinition,
) -> Result<toml::Value, PropertyValueError> {
    let values = value
        .as_array()
        .ok_or_else(|| PropertyValueError::shape(key, "an array of strings"))?;
    let mut seen = HashSet::with_capacity(values.len());
    let mut coerced = Vec::with_capacity(values.len());

    for value in values {
        let value = value
            .as_str()
            .ok_or_else(|| PropertyValueError::shape(key, "an array of strings"))?;
        if !seen.insert(value) {
            return Err(PropertyValueError::DuplicateValue {
                key: key.to_string(),
            });
        }
        validate_option(key, value, definition)?;
        coerced.push(toml::Value::String(value.to_owned()));
    }

    Ok(toml::Value::Array(coerced))
}

fn validate_option(
    key: &str,
    value: &str,
    definition: &PropertyDefinition,
) -> Result<(), PropertyValueError> {
    if definition.options.is_empty() || definition.options.iter().any(|option| option == value) {
        Ok(())
    } else {
        Err(PropertyValueError::unknown_option(key, definition))
    }
}

fn number_value(key: &str, value: &serde_json::Value) -> Result<toml::Value, PropertyValueError> {
    let number = value
        .as_number()
        .ok_or_else(|| PropertyValueError::shape(key, "a number"))?;

    if let Some(integer) = number.as_i64() {
        return Ok(toml::Value::Integer(integer));
    }
    if number.as_u64().is_some() {
        return Err(PropertyValueError::NumberOutOfRange {
            key: key.to_string(),
        });
    }
    match number.as_f64() {
        Some(float) if float.is_finite() => Ok(toml::Value::Float(float)),
        _ => Err(PropertyValueError::NumberOutOfRange {
            key: key.to_string(),
        }),
    }
}

#[derive(Clone, Copy)]
enum DateShape {
    Date,
    DateTime,
}

fn datetime_value(
    key: &str,
    value: &serde_json::Value,
    shape: DateShape,
) -> Result<toml::Value, PropertyValueError> {
    let expected = match shape {
        DateShape::Date => "a valid date",
        DateShape::DateTime => "a valid datetime",
    };
    let parsed = value
        .as_str()
        .and_then(|value| value.parse::<toml::value::Datetime>().ok())
        .filter(|datetime| match shape {
            DateShape::Date => {
                datetime.date.is_some() && datetime.time.is_none() && datetime.offset.is_none()
            }
            DateShape::DateTime => datetime.date.is_some() && datetime.time.is_some(),
        })
        .ok_or_else(|| PropertyValueError::shape(key, expected))?;
    Ok(toml::Value::Datetime(parsed))
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::vault::base::{PropertyDefinition, PropertyType};

    use super::coerce_property_value;

    fn property(property_type: PropertyType) -> PropertyDefinition {
        PropertyDefinition {
            property_type,
            options: Vec::new(),
            many: None,
        }
    }

    fn select(options: &[&str]) -> PropertyDefinition {
        PropertyDefinition {
            property_type: PropertyType::Select,
            options: options.iter().map(|option| (*option).to_string()).collect(),
            many: None,
        }
    }

    fn multi_select(options: &[&str]) -> PropertyDefinition {
        PropertyDefinition {
            property_type: PropertyType::MultiSelect,
            options: options.iter().map(|option| (*option).to_string()).collect(),
            many: None,
        }
    }

    fn relation(many: Option<bool>) -> PropertyDefinition {
        PropertyDefinition {
            property_type: PropertyType::Relation,
            options: Vec::new(),
            many,
        }
    }

    fn coerce(
        key: &str,
        value: Value,
        definition: PropertyDefinition,
    ) -> Result<toml::Value, super::PropertyValueError> {
        coerce_property_value(key, &value, &definition)
    }

    #[test]
    fn coercion_preserves_native_types() {
        assert_eq!(
            coerce("count", json!(3), property(PropertyType::Number)).unwrap(),
            toml::Value::Integer(3)
        );
        assert_eq!(
            coerce("score", json!(3.5), property(PropertyType::Number)).unwrap(),
            toml::Value::Float(3.5)
        );
        assert_eq!(
            coerce("done", json!(true), property(PropertyType::Bool)).unwrap(),
            toml::Value::Boolean(true)
        );
        assert!(matches!(
            coerce("started", json!("2026-08-09"), property(PropertyType::Date)).unwrap(),
            toml::Value::Datetime(_)
        ));
        assert!(matches!(
            coerce(
                "seen",
                json!("2026-08-09T12:30:00Z"),
                property(PropertyType::Datetime)
            )
            .unwrap(),
            toml::Value::Datetime(_)
        ));
        assert_eq!(
            coerce(
                "genres",
                json!(["sf", "essay"]),
                multi_select(&["sf", "essay"])
            )
            .unwrap(),
            toml::Value::Array(vec![
                toml::Value::String("sf".into()),
                toml::Value::String("essay".into()),
            ]),
        );
    }

    #[test]
    fn coercion_accepts_scalar_string_property_types() {
        for (key, property_type) in [
            ("summary", PropertyType::Text),
            ("source", PropertyType::Url),
        ] {
            assert_eq!(
                coerce(key, json!("value"), property(property_type)).unwrap(),
                toml::Value::String("value".into())
            );
        }
        assert_eq!(
            coerce("status", json!("reading"), select(&[])).unwrap(),
            toml::Value::String("reading".into())
        );
        assert_eq!(
            coerce(
                "status",
                json!("finished"),
                select(&["reading", "finished"])
            )
            .unwrap(),
            toml::Value::String("finished".into())
        );
    }

    #[test]
    fn relation_preserves_scalar_and_array_shapes() {
        assert_eq!(
            coerce("series", json!("Solar Cycle"), relation(None)).unwrap(),
            toml::Value::String("Solar Cycle".into())
        );
        assert_eq!(
            coerce(
                "influences",
                json!(["Earthsea", "Hainish Cycle"]),
                relation(Some(true))
            )
            .unwrap(),
            toml::Value::Array(vec![
                toml::Value::String("Earthsea".into()),
                toml::Value::String("Hainish Cycle".into()),
            ])
        );
    }

    #[test]
    fn relation_many_false_is_advisory_for_array_input() {
        assert_eq!(
            coerce(
                "series",
                json!(["Solar Cycle", "Long Sun"]),
                relation(Some(false))
            )
            .unwrap(),
            toml::Value::Array(vec![
                toml::Value::String("Solar Cycle".into()),
                toml::Value::String("Long Sun".into()),
            ])
        );
    }

    #[test]
    fn relation_rejects_malformed_shapes_and_non_string_array_entries() {
        let error = coerce("series", json!({ "page": "Solar Cycle" }), relation(None)).unwrap_err();
        assert_eq!(
            error.to_string(),
            "series must be a string or an array of strings"
        );

        let error = coerce("series", json!(["Solar Cycle", 4]), relation(None)).unwrap_err();
        assert_eq!(
            error.to_string(),
            "series must be a string or an array of strings"
        );
    }

    #[test]
    fn coercion_rejects_wrong_shapes_and_unknown_select_options() {
        let error = coerce("rating", json!("five"), property(PropertyType::Number)).unwrap_err();
        assert_eq!(error.to_string(), "rating must be a number");

        let error =
            coerce("status", json!("paused"), select(&["reading", "finished"])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "status must be one of: reading, finished"
        );

        let error = coerce(
            "genres",
            json!(["sf", "poetry"]),
            multi_select(&["sf", "essay"]),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "genres must be one of: sf, essay");
    }

    #[test]
    fn multi_select_requires_a_unique_string_array() {
        let error = coerce("genres", json!("sf"), multi_select(&[])).unwrap_err();
        assert_eq!(error.to_string(), "genres must be an array of strings");

        let error = coerce("genres", json!(["sf", 4]), multi_select(&[])).unwrap_err();
        assert_eq!(error.to_string(), "genres must be an array of strings");

        let error = coerce("genres", json!(["sf", "sf"]), multi_select(&[])).unwrap_err();
        assert_eq!(error.to_string(), "genres must contain unique values");
    }

    #[test]
    fn date_and_datetime_require_the_declared_temporal_shape() {
        for value in [json!("2026-02-30"), json!("2026-08-09T12:30:00Z")] {
            let error = coerce("started", value, property(PropertyType::Date)).unwrap_err();
            assert_eq!(error.to_string(), "started must be a valid date");
        }

        for value in [json!("2026-08-09"), json!("not-a-datetime")] {
            let error = coerce("seen", value, property(PropertyType::Datetime)).unwrap_err();
            assert_eq!(error.to_string(), "seen must be a valid datetime");
        }
    }

    #[test]
    fn null_and_nested_objects_are_rejected_for_every_property_type() {
        for property_type in [
            PropertyType::Text,
            PropertyType::Number,
            PropertyType::Bool,
            PropertyType::Date,
            PropertyType::Datetime,
            PropertyType::Select,
            PropertyType::MultiSelect,
            PropertyType::Url,
            PropertyType::Relation,
        ] {
            assert!(coerce("field", Value::Null, property(property_type)).is_err());
            assert!(coerce("field", json!({ "nested": true }), property(property_type)).is_err());
        }
    }

    #[test]
    fn integers_outside_toml_range_are_rejected() {
        let error = coerce(
            "count",
            Value::Number(serde_json::Number::from(u64::MAX)),
            property(PropertyType::Number),
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "count must be a TOML-representable number"
        );
    }
}
