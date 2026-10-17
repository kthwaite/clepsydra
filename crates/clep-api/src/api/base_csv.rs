//! Read-only CSV planning and full-result export. Actual imports deliberately use
//! the revision-guarded definition and member endpoints after user approval.
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use super::AppState;
use super::base_members::{BaseMemberCreateRequest, check_base_revision, prepare_member_candidate};
use super::bases::{BasePropertyEntry, ViewParams};
use super::error::ApiError;
use crate::vault::base::{
    BaseDefinition, Filter, PropertyDefinition, PropertyType, SYSTEM_FIELDS, validate_definition,
};
use crate::vault::base_document;
use crate::vault::property_value::coerce_property_value;
use crate::vault::query::{QueryOutput, QueryRow, resolve_projection_field};

#[derive(Debug, Deserialize, ToSchema)]
pub struct BaseCsvMappingOverride {
    pub column: usize,
    pub field: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BaseCsvMapping {
    pub column: usize,
    pub header: String,
    pub field: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct BaseCsvPreviewRequest {
    pub base_revision: String,
    pub csv: String,
    #[serde(default)]
    pub mappings: Vec<BaseCsvMappingOverride>,
    pub embed_filter: Option<Filter>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BaseCsvDiagnostic {
    pub row: Option<usize>,
    pub column: Option<usize>,
    pub field: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BaseCsvPreviewRow {
    /// CSV record number, including the header record (first data record is 2).
    pub row: usize,
    pub title: String,
    pub fields: HashMap<String, Value>,
    pub diagnostics: Vec<BaseCsvDiagnostic>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BaseCsvPreviewResponse {
    pub base_revision: String,
    pub mappings: Vec<BaseCsvMapping>,
    pub declarations: Vec<BasePropertyEntry>,
    pub rows: Vec<BaseCsvPreviewRow>,
    pub diagnostics: Vec<BaseCsvDiagnostic>,
    pub valid: bool,
}

fn diagnostic(
    row: Option<usize>,
    column: Option<usize>,
    field: Option<&str>,
    message: impl Into<String>,
) -> BaseCsvDiagnostic {
    BaseCsvDiagnostic {
        row,
        column,
        field: field.map(str::to_owned),
        message: message.into(),
    }
}

fn bare_field(field: &str) -> &str {
    field
        .strip_prefix("prop.")
        .or_else(|| field.strip_prefix("sys."))
        .unwrap_or(field)
}

fn writable_system(field: &str) -> bool {
    matches!(field, "title" | "kind" | "project" | "tags" | "aliases")
}

fn forbidden_field(field: &str) -> bool {
    let bare = bare_field(field);
    matches!(
        bare,
        "body" | "conversation" | "encryption" | "type" | "readonly"
    ) || (field.starts_with("sys.") && !writable_system(bare))
        || if field.starts_with("prop.") {
            matches!(
                bare,
                "id" | "path"
                    | "title"
                    | "project"
                    | "tags"
                    | "aliases"
                    | "created_at"
                    | "updated_at"
            )
        } else {
            SYSTEM_FIELDS.contains(&bare) && !writable_system(bare)
        }
}

fn mapping_key(field: &str) -> String {
    let bare = bare_field(field);
    if writable_system(bare) && !field.starts_with("prop.") {
        bare.to_owned()
    } else {
        format!("prop.{bare}")
    }
}

fn automatic_field(header: &str, base: &BaseDefinition, view: &str) -> Option<String> {
    let header = header.trim().trim_start_matches('\u{feff}');
    if header.is_empty() {
        return None;
    }
    let label_matches = base
        .view(view)
        .into_iter()
        .flat_map(|view| view.labels.iter())
        .filter(|(_, label)| label.eq_ignore_ascii_case(header))
        .collect::<Vec<_>>();
    let field = if label_matches.len() == 1 {
        label_matches[0].0.clone()
    } else if SYSTEM_FIELDS
        .iter()
        .any(|field| field.eq_ignore_ascii_case(header))
    {
        header.to_ascii_lowercase()
    } else if let Some((key, _)) = base
        .effective_properties()
        .find(|(key, _)| key.eq_ignore_ascii_case(header))
    {
        if SYSTEM_FIELDS.contains(&key) {
            format!("prop.{key}")
        } else {
            key.to_owned()
        }
    } else {
        header
            .to_lowercase()
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || matches!(c, '_' | '-' | '.') {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    };
    (!forbidden_field(&field)).then_some(field)
}

fn checkbox(value: &str) -> Option<bool> {
    match value.to_ascii_lowercase().as_str() {
        "true" | "yes" => Some(true),
        "false" | "no" => Some(false),
        _ => None,
    }
}

fn infer_definition(values: &[&str]) -> PropertyDefinition {
    let present = values
        .iter()
        .copied()
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
    let all = |predicate: &dyn Fn(&str) -> bool| {
        !present.is_empty() && present.iter().all(|value| predicate(value))
    };
    let unique = present.iter().copied().collect::<HashSet<_>>();
    let property_type = if all(&|value| checkbox(value).is_some()) {
        PropertyType::Bool
    } else if all(&|value| value.parse::<f64>().is_ok_and(f64::is_finite)) {
        PropertyType::Number
    } else if all(&|value| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()) {
        PropertyType::Date
    } else if all(&|value| {
        url::Url::parse(value).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
    }) {
        PropertyType::Url
    } else if all(&|value| value.contains('@') && !value.contains(char::is_whitespace)) {
        PropertyType::Text
    } else if present.iter().any(|value| value.contains(';')) {
        PropertyType::MultiSelect
    } else if unique.len() <= 20 && unique.len() < present.len() {
        PropertyType::Select
    } else {
        PropertyType::Text
    };
    let options = if matches!(
        property_type,
        PropertyType::Select | PropertyType::MultiSelect
    ) {
        let mut seen = HashSet::new();
        present
            .iter()
            .flat_map(|value| value.split(';'))
            .map(str::trim)
            .filter(|value| !value.is_empty() && seen.insert((*value).to_owned()))
            .map(str::to_owned)
            .collect()
    } else {
        Vec::new()
    };
    PropertyDefinition {
        property_type,
        options,
        many: None,
        description: None,
        default: None,
        format: None,
        currency: None,
        display: None,
        target: None,
    }
}

fn typed_cell(raw: &str, field: &str, base: &BaseDefinition) -> Result<Value, String> {
    let bare = bare_field(field);
    // A blank CSV cell explicitly clears the value, rather than silently taking
    // a default. Omitted/skipped columns remain absent and can take defaults.
    if raw.trim().is_empty() {
        return Ok(Value::Null);
    }
    let system = !field.starts_with("prop.") && writable_system(bare);
    if system {
        return Ok(if matches!(bare, "tags" | "aliases") {
            Value::Array(
                raw.split(';')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| Value::String(value.to_owned()))
                    .collect(),
            )
        } else {
            Value::String(raw.to_owned())
        });
    }
    let definition = base
        .property(bare)
        .ok_or_else(|| format!("no declared property `{bare}`"))?;
    let value = match definition.property_type {
        PropertyType::Bool => Value::Bool(
            checkbox(raw.trim())
                .ok_or_else(|| format!("{bare} must be a boolean (true/false or yes/no)"))?,
        ),
        PropertyType::Number => {
            let raw = raw.trim();
            let number = if let Ok(integer) = raw.parse::<i64>() {
                serde_json::Number::from(integer)
            } else {
                raw.parse::<f64>()
                    .ok()
                    .and_then(serde_json::Number::from_f64)
                    .ok_or_else(|| format!("{bare} must be a finite number"))?
            };
            Value::Number(number)
        }
        PropertyType::MultiSelect | PropertyType::Relation => Value::Array(
            raw.split(';')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| Value::String(value.to_owned()))
                .collect(),
        ),
        _ => Value::String(raw.to_owned()),
    };
    coerce_property_value(bare, &value, definition).map_err(|error| error.to_string())?;
    Ok(value)
}

#[utoipa::path(
    post, path = "/api/vault/bases/{slug}/views/{view}/import/preview",
    params(("slug" = String, Path), ("view" = String, Path)),
    request_body = BaseCsvPreviewRequest,
    responses((status = 200, body = BaseCsvPreviewResponse), (status = 400, body = ApiError), (status = 409, body = ApiError)),
    tag = "Bases"
)]
pub async fn preview_import(
    State(state): State<Arc<AppState>>,
    Path((slug, view)): Path<(String, String)>,
    Json(request): Json<BaseCsvPreviewRequest>,
) -> Result<Json<BaseCsvPreviewResponse>, ApiError> {
    let stored =
        base_document::load(state.vault.root(), &slug).map_err(super::bases::document_error)?;
    check_base_revision(&stored.revision, &request.base_revision)?;
    if stored.definition.view(&view).is_none() {
        return Err(ApiError::not_found(format!(
            "base `{slug}` has no view named `{view}`"
        )));
    }
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(request.csv.as_bytes());
    let headers = reader
        .headers()
        .map_err(|error| ApiError::bad_request(format!("invalid CSV header: {error}")))?
        .clone();
    let mut diagnostics = Vec::new();
    if headers.is_empty() {
        diagnostics.push(diagnostic(None, None, None, "CSV requires a header row"));
    }
    let mut records = Vec::new();
    for (index, record) in reader.records().enumerate() {
        match record {
            Ok(record) => records.push((index + 2, record)),
            Err(error) => diagnostics.push(diagnostic(
                Some(index + 2),
                None,
                None,
                format!("invalid CSV record: {error}"),
            )),
        }
    }
    if records.is_empty() {
        diagnostics.push(diagnostic(None, None, None, "CSV has no data rows"));
    }
    let mut mappings = headers
        .iter()
        .enumerate()
        .map(|(column, header)| BaseCsvMapping {
            column,
            header: header.to_owned(),
            field: automatic_field(header, &stored.definition, &view),
        })
        .collect::<Vec<_>>();
    let mut overridden = HashSet::new();
    for mapping in request.mappings {
        if mapping.column >= mappings.len() || !overridden.insert(mapping.column) {
            diagnostics.push(diagnostic(
                None,
                Some(mapping.column),
                mapping.field.as_deref(),
                "mapping column is out of range or repeated",
            ));
            continue;
        }
        mappings[mapping.column].field = mapping.field.map(|field| field.trim().to_owned());
    }
    let mut targets = HashSet::new();
    for mapping in &mappings {
        if let Some(field) = &mapping.field {
            if field.is_empty() || bare_field(field).is_empty() || forbidden_field(field) {
                diagnostics.push(diagnostic(
                    None,
                    Some(mapping.column),
                    Some(field),
                    "field is read-only, reserved, or empty",
                ));
            } else if !targets.insert(mapping_key(field)) {
                diagnostics.push(diagnostic(
                    None,
                    Some(mapping.column),
                    Some(field),
                    "multiple CSV columns map to the same field",
                ));
            }
        }
    }
    let mut base = stored.definition;
    let mut declarations = Vec::new();
    for mapping in &mappings {
        let Some(field) = &mapping.field else {
            continue;
        };
        let bare = bare_field(field);
        if field.is_empty()
            || forbidden_field(field)
            || (!field.starts_with("prop.") && writable_system(bare))
            || base.property(bare).is_some()
        {
            continue;
        }
        let values = records
            .iter()
            .filter_map(|(_, row)| row.get(mapping.column))
            .collect::<Vec<_>>();
        let definition = infer_definition(&values);
        base.file
            .properties
            .push((bare.to_owned(), definition.clone()));
        declarations.push(BasePropertyEntry {
            key: bare.to_owned(),
            definition,
        });
    }
    let validation = validate_definition(&slug, base.file.clone());
    for issue in validation.diagnostics {
        if matches!(
            issue.severity,
            crate::vault::base::BaseDiagnosticSeverity::Error
        ) {
            diagnostics.push(diagnostic(None, None, issue.path.as_deref(), issue.message));
        }
    }
    let mut rows = Vec::with_capacity(records.len());
    for (row_number, record) in records {
        let mut row = BaseCsvPreviewRow {
            row: row_number,
            title: String::new(),
            fields: HashMap::new(),
            diagnostics: Vec::new(),
        };
        let mut title = None;
        if record.len() != headers.len() {
            row.diagnostics.push(diagnostic(
                Some(row_number),
                None,
                None,
                format!("expected {} columns, found {}", headers.len(), record.len()),
            ));
        }
        for mapping in &mappings {
            let Some(field) = &mapping.field else {
                continue;
            };
            if forbidden_field(field) || field.is_empty() {
                continue;
            }
            let Some(raw) = record.get(mapping.column) else {
                continue;
            };
            match typed_cell(raw, field, &base) {
                Ok(value) if mapping_key(field) == "title" => {
                    title = Some(value.as_str().unwrap_or_default().to_owned());
                    row.title = title.clone().unwrap_or_default();
                }
                Ok(value) => {
                    row.fields.insert(field.clone(), value);
                }
                Err(message) => row.diagnostics.push(diagnostic(
                    Some(row_number),
                    Some(mapping.column),
                    Some(field),
                    message,
                )),
            }
        }
        let candidate = BaseMemberCreateRequest {
            base_revision: stored.revision.clone(),
            view: view.clone(),
            title,
            fields: row.fields.clone(),
            embed_filter: request.embed_filter.clone(),
            template: None,
            body: None,
        };
        match prepare_member_candidate(&state, &base, &candidate, None, "csv-preview").await {
            Ok((meta, _, _)) => row.title = meta.title.unwrap_or_default(),
            Err(error) => {
                // Infrastructure errors are not mislabeled as bad user rows.
                if error.status >= 500 {
                    return Err(error);
                }
                if let Some(items) = error
                    .detail
                    .as_ref()
                    .and_then(|detail| detail.get("diagnostics"))
                    .and_then(Value::as_array)
                {
                    for item in items {
                        row.diagnostics.push(diagnostic(
                            Some(row_number),
                            None,
                            item.get("field").and_then(Value::as_str),
                            item.get("message")
                                .and_then(Value::as_str)
                                .unwrap_or(&error.error),
                        ));
                    }
                } else {
                    row.diagnostics
                        .push(diagnostic(Some(row_number), None, None, error.error));
                }
            }
        }
        rows.push(row);
    }
    let valid = diagnostics.is_empty() && rows.iter().all(|row| row.diagnostics.is_empty());
    Ok(Json(BaseCsvPreviewResponse {
        base_revision: stored.revision,
        mappings,
        declarations,
        rows,
        diagnostics,
        valid,
    }))
}

fn csv_value(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values.iter().map(csv_value).collect::<Vec<_>>().join(";"),
        _ => value.to_string(),
    }
}

fn export_cell(row: &QueryRow, column: &str) -> String {
    // Conversation ledgers are system-owned even when a caller explicitly uses
    // the property-qualified spelling. Never fetch page files as a fallback.
    if bare_field(column) == "conversation" {
        return String::new();
    }
    row.columns.get(column).map(csv_value).unwrap_or_default()
}

#[utoipa::path(
    get, path = "/api/vault/bases/{slug}/views/{view}/export.csv",
    params(
        ("slug" = String, Path), ("view" = String, Path),
        ("columns" = Option<String>, Query, description = "JSON visible field array"),
        ("filter" = Option<String>, Query, description = "JSON request filter"),
        ("sort" = Option<String>, Query), ("dir" = Option<String>, Query),
        ("sort_keys" = Option<String>, Query, description = "JSON sort key array"),
        ("q" = Option<String>, Query),
        ("search_columns" = Option<String>, Query, description = "JSON visible search field array")
    ),
    responses((status = 200, body = String, content_type = "text/csv"), (status = 400, body = ApiError)),
    tag = "Bases"
)]
pub async fn export_csv(
    State(state): State<Arc<AppState>>,
    Path((slug, view_name)): Path<(String, String)>,
    Query(mut params): Query<ViewParams>,
) -> Result<Response, ApiError> {
    let stored =
        base_document::load(state.vault.root(), &slug).map_err(super::bases::document_error)?;
    let view = stored.definition.view(&view_name).ok_or_else(|| {
        ApiError::not_found(format!("base `{slug}` has no view named `{view_name}`"))
    })?;
    let columns: Vec<String> = match params.columns.as_deref() {
        Some(raw) => serde_json::from_str(raw)
            .map_err(|_| ApiError::bad_request("columns must be a JSON string array"))?,
        None if view.columns.is_empty() => vec!["title".to_owned()],
        None => view.columns.clone(),
    };
    params.columns = Some(serde_json::to_string(&columns).expect("columns serialize"));
    if params.search_columns.is_none() {
        params.search_columns = params.columns.clone();
    }
    params.group_by = Some(String::new());
    let output = super::bases::evaluate_saved_view(&state, &slug, &view_name, params, true).await?;
    let QueryOutput::Flat { rows, .. } = output else {
        return Err(ApiError::internal("CSV export expected flat rows"));
    };
    let mut writer = csv::WriterBuilder::new().from_writer(Vec::new());
    let labels: HashMap<_, _> = view
        .labels
        .iter()
        .filter_map(|(field, label)| {
            resolve_projection_field(field)
                .ok()
                .map(|identity| (identity, label.as_str()))
        })
        .collect();
    writer
        .write_record(columns.iter().map(|column| {
            resolve_projection_field(column)
                .ok()
                .and_then(|identity| labels.get(&identity).copied())
                .unwrap_or(column.as_str())
        }))
        .map_err(|error| ApiError::internal(format!("CSV encoding failed: {error}")))?;
    for row in rows {
        writer
            .write_record(columns.iter().map(|column| export_cell(&row, column)))
            .map_err(|error| ApiError::internal(format!("CSV encoding failed: {error}")))?;
    }
    let bytes = writer
        .into_inner()
        .map_err(|error| ApiError::internal(format!("CSV encoding failed: {error}")))?;
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=base-export.csv",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        bytes,
    )
        .into_response())
}
