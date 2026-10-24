//! Typed MCP property inputs translated to the existing HTTP patch contract.

use std::collections::BTreeMap;

use clep_client::client::{ApiClient, encode_vault_path};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Number, Value};

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GetPropertiesParams {
    /// Vault-relative path. Provide exactly one of path or id.
    pub path: Option<String>,
    /// Page UUID. Provide exactly one of path or id.
    pub id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PatchPropertiesParams {
    /// Vault-relative path. Provide exactly one of path or id.
    pub path: Option<String>,
    /// Page UUID. Provide exactly one of path or id.
    pub id: Option<String>,
    /// Exact revision returned by the last read. Required; conflicts are never retried.
    pub expected_revision: String,
    /// Custom frontmatter keys to set. Base declarations are not required.
    #[serde(default)]
    pub set: BTreeMap<String, TypedPropertyValue>,
    /// Custom keys to remove. Must not overlap set; null is not a property value.
    #[serde(default)]
    pub clear: Vec<String>,
}

/// Every value has an explicit type; dates and datetimes become native TOML values.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum TypedPropertyValue {
    Text(String),
    Number(Number),
    Bool(bool),
    Date(String),
    Datetime(String),
    Select(String),
    MultiSelect(Vec<String>),
    Url(String),
    Relation(RelationValue),
    Array(Vec<NestedPropertyValue>),
    Object(BTreeMap<String, NestedPropertyValue>),
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum RelationValue {
    One(String),
    Many(Vec<String>),
}

/// Untagged nested JSON-compatible TOML values. Null is not representable.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum NestedPropertyValue {
    Text(String),
    Number(Number),
    Bool(bool),
    Array(Vec<NestedPropertyValue>),
    Object(BTreeMap<String, NestedPropertyValue>),
}

fn selector_url(path: Option<&str>, id: Option<&str>) -> Result<String, String> {
    match (path, id) {
        (Some(path), None) => Ok(format!("/api/vault/pages/{}", encode_vault_path(path))),
        (None, Some(id)) => Ok(format!("/api/vault/pages/by-id/{}", parse_id(id)?)),
        _ => Err("provide exactly one of 'path' or 'id' to identify the page".into()),
    }
}

fn parse_id(id: &str) -> Result<uuid::Uuid, String> {
    uuid::Uuid::parse_str(id).map_err(|error| format!("invalid page UUID: {error}"))
}

fn page_id(page: &Value) -> Result<&str, String> {
    page["meta"]["id"]
        .as_str()
        .ok_or_else(|| "page response is missing its metadata id".into())
}

pub(crate) async fn get_properties(
    client: &ApiClient,
    params: GetPropertiesParams,
) -> Result<Value, String> {
    let url = selector_url(params.path.as_deref(), params.id.as_deref())?;
    let mut page = client
        .get_json(&url, &[])
        .await
        .map_err(|e| e.to_string())?;
    let id = parse_id(page_id(&page)?)?;
    let mut properties = client
        .get_json(&format!("/api/vault/pages/by-id/{id}/properties"), &[])
        .await
        .map_err(|e| e.to_string())?;
    if page["revision"].as_str().is_none()
        || properties["revision"] != page["revision"]
        || properties["id"] != page["meta"]["id"]
        || properties["path"] != page["path"]
    {
        return Err(
            "API error 409: page changed while reading properties; re-read with vault_get_properties"
                .into(),
        );
    }
    properties["values"] = page["meta"].take();
    Ok(properties)
}

pub(crate) async fn patch_properties(
    client: &ApiClient,
    params: PatchPropertiesParams,
) -> Result<Value, String> {
    if params.expected_revision.trim().is_empty() {
        return Err("expected_revision must be a non-empty revision from a page read".into());
    }
    if params.set.is_empty() && params.clear.is_empty() {
        return Err("provide at least one property to set or clear".into());
    }
    if let Some(key) = params
        .clear
        .iter()
        .find(|key| params.set.contains_key(*key))
    {
        return Err(format!(
            "property {key:?} cannot appear in both set and clear"
        ));
    }
    let mut set = Map::new();
    let mut types = Map::new();
    for (key, value) in params.set {
        let (value, hint) = value
            .into_wire()
            .map_err(|error| format!("{key}: {error}"))?;
        if let Some(hint) = hint {
            types.insert(key.clone(), Value::String(hint.into()));
        }
        set.insert(key, value);
    }
    let id = match (params.path, params.id) {
        (None, Some(id)) => parse_id(&id)?,
        (Some(path), None) => {
            let url = selector_url(Some(&path), None)?;
            let page = client
                .get_json(&url, &[])
                .await
                .map_err(|e| e.to_string())?;
            parse_id(page_id(&page)?)?
        }
        _ => return Err("provide exactly one of 'path' or 'id' to identify the page".into()),
    };
    client
        .patch_json(
            &format!("/api/vault/pages/by-id/{id}/properties"),
            &serde_json::json!({
                "expected_revision": params.expected_revision,
                "set": set,
                "clear": params.clear,
                "types": types,
            }),
        )
        .await
        .map_err(|e| e.to_string())
}

impl TypedPropertyValue {
    fn into_wire(self) -> Result<(Value, Option<&'static str>), String> {
        let (value, hint) = match self {
            Self::Text(value) => (Value::String(value), Some("text")),
            Self::Number(value) => (number_value(value)?, Some("number")),
            Self::Bool(value) => (Value::Bool(value), Some("bool")),
            Self::Date(value) => {
                validate_date(&value, false)?;
                (Value::String(value), Some("date"))
            }
            Self::Datetime(value) => {
                validate_date(&value, true)?;
                (Value::String(value), Some("datetime"))
            }
            Self::Select(value) => (Value::String(value), Some("select")),
            Self::MultiSelect(values) => (
                Value::Array(values.into_iter().map(Value::String).collect()),
                Some("multi_select"),
            ),
            Self::Url(value) => (Value::String(value), Some("url")),
            Self::Relation(RelationValue::One(value)) => (Value::String(value), Some("relation")),
            Self::Relation(RelationValue::Many(values)) => (
                Value::Array(values.into_iter().map(Value::String).collect()),
                Some("relation"),
            ),
            Self::Array(values) => (NestedPropertyValue::Array(values).into_json()?, None),
            Self::Object(values) => (NestedPropertyValue::Object(values).into_json()?, None),
        };
        Ok((value, hint))
    }
}

impl NestedPropertyValue {
    fn into_json(self) -> Result<Value, String> {
        match self {
            Self::Text(value) => Ok(Value::String(value)),
            Self::Number(value) => number_value(value),
            Self::Bool(value) => Ok(Value::Bool(value)),
            Self::Array(values) => values
                .into_iter()
                .map(Self::into_json)
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array),
            Self::Object(values) => values
                .into_iter()
                .map(|(key, value)| value.into_json().map(|value| (key, value)))
                .collect::<Result<Map<_, _>, _>>()
                .map(Value::Object),
        }
    }
}

fn number_value(value: Number) -> Result<Value, String> {
    if value.is_u64() && value.as_i64().is_none() {
        return Err("integer is outside TOML's signed 64-bit range".into());
    }
    Ok(Value::Number(value))
}

fn validate_date(value: &str, with_time: bool) -> Result<(), String> {
    let parsed = value.parse::<toml::value::Datetime>();
    if parsed.is_ok_and(|date| {
        date.date.is_some()
            && date.time.is_some() == with_time
            && (with_time || date.offset.is_none())
    }) {
        Ok(())
    } else if with_time {
        Err("datetime must be a valid TOML date and time, optionally with a UTC offset".into())
    } else {
        Err("date must be a valid ISO date (YYYY-MM-DD)".into())
    }
}
