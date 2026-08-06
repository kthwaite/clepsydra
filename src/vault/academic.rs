use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::page::ExtraMap;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/// The type of academic work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkType {
    Paper,
    Book,
    Thesis,
    Report,
    Other,
}

/// Reading progress status for an academic work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReadingStatus {
    Unread,
    Reading,
    Done,
}

/// The kind of annotation attached to a work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationType {
    Highlight,
    Note,
}

// ---------------------------------------------------------------------------
// Nested types
// ---------------------------------------------------------------------------

/// External identifiers for an academic work (DOI, ISBN, arXiv).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ExternalIds {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isbn: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arxiv: Option<String>,
}

/// URLs associated with an academic work.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct WorkUrls {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub landing: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf: Option<String>,
}

/// Location within a source document (page, quote, bounding rect).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct SourceLocation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rect: Option<[f32; 4]>,
}

// ---------------------------------------------------------------------------
// Main types
// ---------------------------------------------------------------------------

/// Frontmatter metadata for an academic work page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkMeta {
    pub work_type: WorkType,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ReadingStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rating: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_ids: Option<ExternalIds>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub urls: Option<WorkUrls>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assets: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cite_key: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, toml::Value>,
}

/// Frontmatter metadata for an annotation page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotationMeta {
    pub work_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_asset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_location: Option<SourceLocation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotation_type: Option<AnnotationType>,
    #[serde(flatten)]
    pub extra: HashMap<String, toml::Value>,
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/// Serialize a [`WorkMeta`] into a flat map suitable for embedding
/// in `PageMeta::extra`, injecting `kind: "work"`.
pub fn work_meta_to_extra(work: &WorkMeta) -> ExtraMap {
    let value = toml::Value::try_from(work).expect("WorkMeta should always serialize");
    let mut map = match value {
        toml::Value::Table(t) => t,
        _ => ExtraMap::new(),
    };
    map.insert("kind".to_string(), toml::Value::String("work".to_string()));
    map
}

/// Attempt to reconstruct a [`WorkMeta`] from `PageMeta::extra`.
///
/// Returns `None` if `kind` is not `"work"` or deserialization fails.
pub fn extra_to_work_meta(extra: &ExtraMap) -> Option<WorkMeta> {
    let kind = extra.get("kind")?.as_str()?;
    if kind != "work" {
        return None;
    }

    let mut table = ExtraMap::new();
    for (k, v) in extra {
        if k == "kind" {
            continue;
        }
        table.insert(k.clone(), v.clone());
    }

    toml::Value::Table(table).try_into().ok()
}

/// Serialize an [`AnnotationMeta`] into a flat map suitable for
/// embedding in `PageMeta::extra`, injecting `kind: "annotation"`.
pub fn annotation_meta_to_extra(ann: &AnnotationMeta) -> ExtraMap {
    let value = toml::Value::try_from(ann).expect("AnnotationMeta should always serialize");
    let mut map = match value {
        toml::Value::Table(t) => t,
        _ => ExtraMap::new(),
    };
    map.insert(
        "kind".to_string(),
        toml::Value::String("annotation".to_string()),
    );
    map
}

/// Attempt to reconstruct an [`AnnotationMeta`] from `PageMeta::extra`.
///
/// Returns `None` if `kind` is not `"annotation"` or deserialization fails.
pub fn extra_to_annotation_meta(extra: &ExtraMap) -> Option<AnnotationMeta> {
    let kind = extra.get("kind")?.as_str()?;
    if kind != "annotation" {
        return None;
    }

    let mut table = ExtraMap::new();
    for (k, v) in extra {
        if k == "kind" {
            continue;
        }
        table.insert(k.clone(), v.clone());
    }

    toml::Value::Table(table).try_into().ok()
}
