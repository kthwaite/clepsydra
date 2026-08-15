//! Base definitions: TOML files under `bases/` declaring a membership filter,
//! a property schema, and saved views over pages.
//!
//! Bases are views over pages; they never own pages. A page may match many
//! bases; deleting a base deletes nothing else. Parse failures never poison
//! the registry — a broken base is listed with its diagnostics and excluded
//! from evaluation.

use std::{
    borrow::Cow,
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
};

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// System fields addressable in filters/sorts/columns without declaration.
/// Bare references resolve system-first; a declared property with the same
/// name remains addressable through `prop.<name>`.
pub const SYSTEM_FIELDS: &[&str] = &[
    "id",
    "path",
    "title",
    "kind",
    "project",
    "tags",
    "aliases",
    "created_at",
    "updated_at",
    "encryption",
    "journal_date",
    "word_count",
];

/// View-only system column projected from the indexed Markdown body.
pub const BODY_COLUMN: &str = "body";

pub(crate) fn is_body_field_reference(field: &str) -> bool {
    field == BODY_COLUMN
        || field.strip_prefix("sys.") == Some(BODY_COLUMN)
        || field.strip_prefix("prop.") == Some(BODY_COLUMN)
}

/// Closed set of declarable property types (v1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PropertyType {
    Text,
    Number,
    Bool,
    Date,
    Datetime,
    Select,
    MultiSelect,
    Url,
    Relation,
}

impl PropertyType {
    /// Whether an ordering comparison (`lt`/`gt`/…) makes sense for values of
    /// this type. `select` options are categories, not an ordered domain.
    pub fn is_ordered(self) -> bool {
        matches!(
            self,
            PropertyType::Number | PropertyType::Date | PropertyType::Datetime
        )
    }

    /// Whether `contains` is defined for the type. Text-like values use
    /// literal substring matching; categorical values use exact membership.
    pub fn supports_contains(self) -> bool {
        !matches!(self, PropertyType::Number | PropertyType::Bool)
    }

    /// Whether `links_to` can be evaluated through the links index.
    pub fn supports_links_to(self) -> bool {
        self == PropertyType::Relation
    }

    /// Whether saved-view evaluation can order this property as one scalar
    /// value per page.
    pub fn is_scalar_sortable(self) -> bool {
        !matches!(self, PropertyType::MultiSelect | PropertyType::Relation)
    }
}

/// A declared property in a base's schema.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PropertyDefinition {
    #[serde(rename = "type")]
    pub property_type: PropertyType,
    /// Options for `select` / `multi_select`. An empty list means open
    /// vocabulary: completion offers observed values, no diagnostics for
    /// novel ones.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    /// Advisory single-value constraint for `relation` (diagnostic, never
    /// enforcement).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub many: Option<bool>,
}

/// Comparison operators for filter predicates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
    /// Substring on text; membership on multi-valued.
    Contains,
    /// Value is an array of candidates.
    In,
    /// Relation → links table, canonical-name (or UUID) match.
    LinksTo,
    IsEmpty,
    NotEmpty,
}

impl Op {
    pub fn is_ordering(self) -> bool {
        matches!(self, Op::Lt | Op::Lte | Op::Gt | Op::Gte)
    }
}

/// The filter AST. Deserializes identically from base files (TOML — inline
/// tables or array-of-tables) and the generic query endpoint (JSON).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Filter {
    All(Vec<Filter>),
    Any(Vec<Filter>),
    Not(Box<Filter>),
    #[serde(untagged)]
    Cmp {
        field: String,
        op: Op,
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        value: serde_json::Value,
    },
}

// The AST is recursive; utoipa's derived schema generation recurses without
// terminating on it, so the OpenAPI surface describes it as an opaque object.
impl utoipa::PartialSchema for Filter {
    fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
        utoipa::openapi::ObjectBuilder::new()
            .description(Some(
                "Recursive filter AST: {\"all\": [Filter]}, {\"any\": [Filter]}, \
                 {\"not\": Filter}, or {\"field\", \"op\", \"value\"}",
            ))
            .into()
    }
}

impl ToSchema for Filter {}

/// One sort key in a view.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SortKey {
    pub field: String,
    #[serde(default)]
    pub dir: SortDir,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SortDir {
    #[default]
    Asc,
    Desc,
}

/// An aggregate over a group (or the whole result set).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Aggregate {
    #[serde(rename = "fn")]
    pub function: AggregateFn,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AggregateFn {
    Count,
    Sum,
    Avg,
    Min,
    Max,
}

/// One field shown in a Base's default preview, in configured order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct PreviewFieldDefinition {
    pub field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// A saved view: layout, optional extra filter, sort, grouping, columns.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ViewDefinition {
    pub name: String,
    /// Per-field display labels. A sorted map makes wire serialization stable.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: BTreeMap<String, String>,
    #[serde(default = "default_layout")]
    pub layout: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Filter>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sort: Vec<SortKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_by: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aggregates: Vec<Aggregate>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub columns: Vec<String>,
}

fn default_layout() -> String {
    "table".to_string()
}

/// The parsed model of a `.base.toml` file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaseFile {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Filter>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub preview: Vec<PreviewFieldDefinition>,
    /// Declared properties in file order (serialized as a key → definition map).
    #[serde(default, with = "property_map")]
    pub properties: Vec<(String, PropertyDefinition)>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub views: Vec<ViewDefinition>,
}

/// Loose first-stage model: properties stay raw TOML so a single bad
/// declaration (e.g. an unknown type token) becomes a per-property
/// diagnostic instead of failing the whole file.
#[derive(Debug, Deserialize)]
struct RawBaseFile {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    filter: Option<Filter>,
    #[serde(default)]
    preview: Vec<PreviewFieldDefinition>,
    #[serde(default)]
    properties: toml::Table,
    #[serde(default)]
    views: Vec<ViewDefinition>,
}

/// Serialize and deserialize declared properties as a map, keeping input order.
mod property_map {
    use std::fmt;

    use super::PropertyDefinition;
    use serde::de::{Deserializer, MapAccess, Visitor};
    use serde::ser::{SerializeMap, Serializer};

    pub fn serialize<S: Serializer>(
        props: &[(String, PropertyDefinition)],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(props.len()))?;
        for (k, v) in props {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Vec<(String, PropertyDefinition)>, D::Error> {
        struct PropertyMapVisitor;

        impl<'de> Visitor<'de> for PropertyMapVisitor {
            type Value = Vec<(String, PropertyDefinition)>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a map of property names to property definitions")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut properties = Vec::with_capacity(map.size_hint().unwrap_or(0));
                while let Some(entry) = map.next_entry()? {
                    properties.push(entry);
                }
                Ok(properties)
            }
        }

        deserializer.deserialize_map(PropertyMapVisitor)
    }
}

/// A parsed, validated base.
#[derive(Debug, Clone, Serialize)]
pub struct BaseDefinition {
    /// Filename stem; the API identity.
    pub slug: String,
    #[serde(flatten)]
    pub file: BaseFile,
}

impl BaseDefinition {
    pub fn property(&self, key: &str) -> Option<&PropertyDefinition> {
        self.file
            .properties
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, def)| def)
    }

    /// Resolve a saved view using the API's ASCII case-insensitive naming
    /// contract.
    pub fn view(&self, name: &str) -> Option<&ViewDefinition> {
        self.file
            .views
            .iter()
            .find(|view| view.name.eq_ignore_ascii_case(name))
    }
}

/// Severity assigned to a base diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum BaseDiagnosticSeverity {
    Error,
    Warning,
}

/// A validation diagnostic for a base file. Never fatal to the registry.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BaseDiagnostic {
    /// Slug of the base (filename stem), even when parsing failed.
    pub slug: String,
    pub severity: BaseDiagnosticSeverity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub message: String,
}

pub struct ValidationResult {
    pub definition: BaseDefinition,
    pub diagnostics: Vec<BaseDiagnostic>,
}

pub fn validate_definition(slug: &str, file: BaseFile) -> ValidationResult {
    let definition = BaseDefinition {
        slug: slug.to_owned(),
        file,
    };
    let mut diagnostics = Vec::new();
    validate(&definition, &mut diagnostics);
    ValidationResult {
        definition,
        diagnostics,
    }
}

// ---------------------------------------------------------------------------
// In-memory filter matching (LSP path: cheap, no SQL)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CandidateLinkTarget {
    target_canonical: String,
    target_id: Option<String>,
}

pub(crate) type CandidateLinkTargets = HashMap<String, Vec<CandidateLinkTarget>>;

pub(crate) fn candidate_link_targets<E>(
    base: &BaseDefinition,
    meta: &crate::vault::page::PageMeta,
    mut resolve_target_id: impl FnMut(&str) -> Result<Option<String>, E>,
) -> Result<CandidateLinkTargets, E> {
    let mut targets = CandidateLinkTargets::new();
    for (field, definition) in &base.file.properties {
        if !definition.property_type.supports_links_to() {
            continue;
        }
        let Some(value) = meta.extra.get(field) else {
            continue;
        };
        let values = match value {
            toml::Value::String(value) => vec![value.clone()],
            toml::Value::Array(values) => values
                .iter()
                .filter_map(toml::Value::as_str)
                .map(str::to_owned)
                .collect(),
            _ => Vec::new(),
        };
        let links = crate::vault::link::extract_property_refs(field, &values)
            .into_iter()
            .map(|link| {
                let target_canonical =
                    crate::vault::canonical::CanonicalName::new(&link.target_raw)
                        .as_str()
                        .to_owned();
                let target_id = resolve_target_id(&target_canonical)?;
                Ok(CandidateLinkTarget {
                    target_canonical,
                    target_id,
                })
            })
            .collect::<Result<Vec<_>, E>>()?;
        targets.insert(field.clone(), links);
    }
    Ok(targets)
}

pub(crate) struct MetaFilterContext<'a> {
    pub base: &'a BaseDefinition,
    pub meta: &'a crate::vault::page::PageMeta,
    pub path: &'a str,
    pub word_count: Option<u32>,
    pub journal_date: Option<chrono::NaiveDate>,
    pub link_targets: Option<&'a CandidateLinkTargets>,
}

/// Evaluate a base's membership filter against a parsed page's metadata —
/// the completion/diagnostics path, where hitting SQLite per keystroke is
/// not warranted. Semantics mirror the SQL compilation for the common ops;
/// anything unresolvable is conservatively `false`.
pub fn base_matches_meta(
    base: &BaseDefinition,
    meta: &crate::vault::page::PageMeta,
    path: &str,
) -> bool {
    let context = MetaFilterContext {
        base,
        meta,
        path,
        word_count: None,
        journal_date: None,
        link_targets: None,
    };
    match &base.file.filter {
        Some(filter) => filter_matches_meta(filter, &context),
        None => true,
    }
}

pub(crate) fn filter_matches_meta(filter: &Filter, context: &MetaFilterContext<'_>) -> bool {
    match filter {
        Filter::All(children) => children
            .iter()
            .all(|child| filter_matches_meta(child, context)),
        Filter::Any(children) => children
            .iter()
            .any(|child| filter_matches_meta(child, context)),
        Filter::Not(child) => !filter_matches_meta(child, context),
        Filter::Cmp { field, op, value } => cmp_matches_meta(field, *op, value, context),
    }
}

pub(crate) fn fixed_candidate_comparison_matches(
    base: &BaseDefinition,
    field: &str,
    op: Op,
    value: &serde_json::Value,
) -> Option<bool> {
    use crate::vault::query::{QueryContext, ResolvedField, SysField, resolve_field};

    let context = QueryContext::for_base(base);
    let resolved = resolve_field(field, &context).ok()?;
    if op == Op::LinksTo
        && (!matches!(
            &resolved,
            ResolvedField::Prop { ty, .. } if ty.supports_links_to()
        ) || !value.is_string())
    {
        return Some(false);
    }
    match resolved {
        ResolvedField::Sys(SysField::WordCount) => Some(scalar_matches(
            Some(Comparable::Number(0.0)),
            PropertyType::Number,
            op,
            value,
            false,
        )),
        ResolvedField::Sys(SysField::JournalDate) => {
            Some(scalar_matches(None, PropertyType::Date, op, value, false))
        }
        ResolvedField::Prop { ty, .. } if op == Op::Contains && !ty.supports_contains() => {
            Some(false)
        }
        ResolvedField::Prop { key, ty } if base.property(&key).is_none() => {
            Some(property_matches(None, ty, op, value, None))
        }
        _ => None,
    }
}

fn cmp_matches_meta(
    field: &str,
    op: Op,
    value: &serde_json::Value,
    context: &MetaFilterContext<'_>,
) -> bool {
    use crate::vault::query::{QueryContext, ResolvedField, SysField, resolve_field};

    let query_context = QueryContext::for_base(context.base);
    let Ok(resolved) = resolve_field(field, &query_context) else {
        return false;
    };
    match resolved {
        ResolvedField::Sys(SysField::Tags) => {
            let kind = crate::vault::kind::resolve(context.path, context.meta.kind).0;
            let effective = crate::vault::kind::effective_tags(kind, &context.meta.tags);
            membership_matches(&effective, op, value, false)
        }
        ResolvedField::Sys(SysField::Aliases) => {
            membership_matches(&context.meta.aliases, op, value, true)
        }
        ResolvedField::Sys(sys) => scalar_matches(
            system_scalar(sys, context),
            system_property_type(sys),
            op,
            value,
            false,
        ),
        ResolvedField::Prop { key, ty } => property_matches(
            context.meta.extra.get(&key),
            ty,
            op,
            value,
            context
                .link_targets
                .and_then(|targets| targets.get(&key).map(Vec::as_slice)),
        ),
    }
}

fn system_property_type(sys: crate::vault::query::SysField) -> PropertyType {
    sys.property_type()
}

fn system_scalar<'a>(
    sys: crate::vault::query::SysField,
    context: &'a MetaFilterContext<'_>,
) -> Option<Comparable<'a>> {
    use crate::vault::query::SysField;

    match sys {
        SysField::Id => Some(Comparable::Text(Cow::Owned(context.meta.id.to_string()))),
        SysField::Path => Some(Comparable::Text(Cow::Borrowed(context.path))),
        SysField::Title => context
            .meta
            .title
            .as_deref()
            .map(|value| Comparable::Text(Cow::Borrowed(value))),
        SysField::Kind => Some(Comparable::Text(Cow::Owned(
            crate::vault::kind::resolve(context.path, context.meta.kind)
                .0
                .as_str()
                .to_string(),
        ))),
        SysField::Project => context
            .meta
            .project
            .as_deref()
            .map(|value| Comparable::Text(Cow::Borrowed(value))),
        SysField::CreatedAt => context
            .meta
            .created_at
            .map(|value| Comparable::Text(Cow::Owned(value.to_rfc3339()))),
        SysField::UpdatedAt => context
            .meta
            .updated_at
            .map(|value| Comparable::Text(Cow::Owned(value.to_rfc3339()))),
        SysField::Encryption => Some(Comparable::Bool(context.meta.encryption.is_some())),
        SysField::JournalDate => context
            .journal_date
            .map(|value| Comparable::Text(Cow::Owned(value.to_string()))),
        SysField::WordCount => context
            .word_count
            .map(|value| Comparable::Number(f64::from(value))),
        SysField::Tags | SysField::Aliases => None,
    }
}

fn membership_matches(
    current: &[String],
    op: Op,
    value: &serde_json::Value,
    canonicalize: bool,
) -> bool {
    let contains = |expected: &str| membership_contains(current, expected, canonicalize);
    match op {
        Op::Eq | Op::Contains => value.as_str().is_some_and(contains),
        Op::Ne => value.as_str().is_some_and(|expected| !contains(expected)),
        Op::In => value.as_array().is_some_and(|values| {
            values.iter().all(serde_json::Value::is_string)
                && values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .any(contains)
        }),
        Op::IsEmpty => current.is_empty(),
        Op::NotEmpty => !current.is_empty(),
        _ => false,
    }
}

fn membership_contains(current: &[String], expected: &str, canonicalize: bool) -> bool {
    if !canonicalize {
        return current.iter().any(|item| item == expected);
    }
    let expected = crate::vault::canonical::CanonicalName::from_title(expected);
    current.iter().any(|item| {
        crate::vault::canonical::CanonicalName::from_title(item).as_str() == expected.as_str()
    })
}

#[derive(Debug)]
enum Comparable<'a> {
    Text(Cow<'a, str>),
    Number(f64),
    Bool(bool),
}

fn property_matches(
    current: Option<&toml::Value>,
    property_type: PropertyType,
    op: Op,
    value: &serde_json::Value,
    link_targets: Option<&[CandidateLinkTarget]>,
) -> bool {
    let present = current.is_some_and(|current| !toml_value_is_empty(current));
    match op {
        Op::IsEmpty => return !present,
        Op::NotEmpty => return present,
        _ => {}
    }
    if op == Op::LinksTo {
        if !property_type.supports_links_to() {
            return false;
        }
        let Some(expected) = value.as_str() else {
            return false;
        };
        let expected = crate::vault::link::normalize_links_to_target(expected);
        return link_targets.is_some_and(|targets| {
            targets.iter().any(|target| {
                target.target_id.as_deref() == Some(expected.target_id.as_str())
                    || target.target_canonical == expected.target_canonical
            })
        });
    }
    let Some(current) = current.filter(|current| !toml_value_is_empty(current)) else {
        return op == Op::Ne && expected_scalar(property_type, value).is_some();
    };
    if let toml::Value::Array(items) = current {
        return match op {
            Op::Ne => items
                .iter()
                .all(|item| !property_scalar_matches(item, property_type, Op::Eq, value)),
            _ => items
                .iter()
                .any(|item| property_scalar_matches(item, property_type, op, value)),
        };
    }
    property_scalar_matches(current, property_type, op, value)
}

fn property_scalar_matches(
    current: &toml::Value,
    property_type: PropertyType,
    op: Op,
    value: &serde_json::Value,
) -> bool {
    if op == Op::LinksTo {
        return false;
    }
    scalar_matches(
        current_scalar(current, property_type),
        property_type,
        op,
        value,
        matches!(
            property_type,
            PropertyType::Select | PropertyType::MultiSelect | PropertyType::Relation
        ),
    )
}

fn toml_value_is_empty(value: &toml::Value) -> bool {
    match value {
        toml::Value::String(value) => value.is_empty(),
        toml::Value::Array(values) => values.is_empty(),
        _ => false,
    }
}

fn current_scalar(current: &toml::Value, property_type: PropertyType) -> Option<Comparable<'_>> {
    match property_type {
        PropertyType::Number => match current {
            toml::Value::Integer(value) => Some(Comparable::Number(*value as f64)),
            toml::Value::Float(value) => Some(Comparable::Number(*value)),
            _ => None,
        },
        PropertyType::Bool => current.as_bool().map(Comparable::Bool),
        PropertyType::Date | PropertyType::Datetime => match current {
            toml::Value::Datetime(value) => Some(Comparable::Text(Cow::Owned(value.to_string()))),
            _ => None,
        },
        _ => current
            .as_str()
            .map(|value| Comparable::Text(Cow::Borrowed(value))),
    }
}

fn expected_scalar(
    property_type: PropertyType,
    value: &serde_json::Value,
) -> Option<Comparable<'_>> {
    match property_type {
        PropertyType::Number => value.as_f64().map(Comparable::Number),
        PropertyType::Bool => value.as_bool().map(Comparable::Bool),
        _ => match value {
            serde_json::Value::String(value) => Some(Comparable::Text(Cow::Borrowed(value))),
            serde_json::Value::Number(value) => {
                Some(Comparable::Text(Cow::Owned(value.to_string())))
            }
            serde_json::Value::Bool(value) => Some(Comparable::Text(Cow::Owned(value.to_string()))),
            _ => None,
        },
    }
}

fn scalar_matches(
    current: Option<Comparable<'_>>,
    property_type: PropertyType,
    op: Op,
    value: &serde_json::Value,
    contains_is_membership: bool,
) -> bool {
    match op {
        Op::IsEmpty => return current.is_none(),
        Op::NotEmpty => return current.is_some(),
        _ => {}
    }
    let Some(current) = current else {
        return op == Op::Ne && expected_scalar(property_type, value).is_some();
    };
    match op {
        Op::In => value
            .as_array()
            .and_then(|values| {
                values.iter().try_fold(false, |matched, value| {
                    expected_scalar(property_type, value)
                        .map(|expected| matched || scalar_equal(&current, &expected))
                })
            })
            .unwrap_or(false),
        Op::Contains if !property_type.supports_contains() => false,
        Op::Contains => expected_scalar(property_type, value).is_some_and(|expected| {
            if contains_is_membership {
                scalar_equal(&current, &expected)
            } else {
                sql_contains(&current, &expected)
            }
        }),
        Op::LinksTo => false,
        _ => expected_scalar(property_type, value).is_some_and(|expected| {
            let ordering = scalar_ordering(&current, &expected);
            match (op, ordering) {
                (Op::Eq, Some(std::cmp::Ordering::Equal)) => true,
                (Op::Ne, Some(ordering)) => ordering != std::cmp::Ordering::Equal,
                (Op::Ne, None) => true,
                (Op::Lt, Some(std::cmp::Ordering::Less)) => true,
                (Op::Lte, Some(ordering)) => ordering != std::cmp::Ordering::Greater,
                (Op::Gt, Some(std::cmp::Ordering::Greater)) => true,
                (Op::Gte, Some(ordering)) => ordering != std::cmp::Ordering::Less,
                _ => false,
            }
        }),
    }
}

fn scalar_equal(left: &Comparable<'_>, right: &Comparable<'_>) -> bool {
    scalar_ordering(left, right) == Some(std::cmp::Ordering::Equal)
}

fn scalar_ordering(left: &Comparable<'_>, right: &Comparable<'_>) -> Option<std::cmp::Ordering> {
    match (left, right) {
        (Comparable::Text(left), Comparable::Text(right)) => Some(left.cmp(right)),
        (Comparable::Number(left), Comparable::Number(right)) => left.partial_cmp(right),
        (Comparable::Bool(left), Comparable::Bool(right)) => Some(left.cmp(right)),
        _ => None,
    }
}

fn sql_contains(current: &Comparable<'_>, expected: &Comparable<'_>) -> bool {
    let current = comparable_sql_text(current);
    let expected = comparable_sql_text(expected);
    if expected.is_empty() {
        return true;
    }
    current
        .as_bytes()
        .windows(expected.len())
        .any(|window| window.eq_ignore_ascii_case(expected.as_bytes()))
}

fn comparable_sql_text<'a>(value: &'a Comparable<'_>) -> Cow<'a, str> {
    match value {
        Comparable::Text(value) => Cow::Borrowed(value.as_ref()),
        Comparable::Number(value) => Cow::Owned(value.to_string()),
        Comparable::Bool(value) => Cow::Borrowed(if *value { "1" } else { "0" }),
    }
}

/// The in-process collection of parsed bases plus per-file diagnostics.
///
/// Loaded from `<vault>/bases/*.base.toml` before the first index build (the
/// linkable-set epoch depends on it). Broken files contribute diagnostics but
/// never poison the rest of the registry.
#[derive(Debug, Default, Clone)]
pub struct BaseRegistry {
    pub bases: Vec<BaseDefinition>,
    pub diagnostics: Vec<BaseDiagnostic>,
}

impl BaseRegistry {
    /// Parse every `bases/*.base.toml` under the vault root, in filename
    /// order. A missing `bases/` directory yields an empty registry.
    pub fn load(vault_root: &Path) -> Self {
        let mut registry = BaseRegistry::default();
        let dir = vault_root.join("bases");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return registry;
        };
        let mut paths: Vec<_> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.is_file()
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.ends_with(".base.toml"))
            })
            .collect();
        paths.sort();

        for path in paths {
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(e) => {
                    registry.diagnostics.push(BaseDiagnostic {
                        slug: slug_from_path(&path),
                        severity: BaseDiagnosticSeverity::Error,
                        path: None,
                        message: format!("cannot read base file: {e}"),
                    });
                    continue;
                }
            };
            let (base, mut diagnostics) = parse_base(&path, &content);
            registry.diagnostics.append(&mut diagnostics);
            if let Some(base) = base {
                if registry.bases.iter().any(|b| b.slug == base.slug) {
                    registry.diagnostics.push(BaseDiagnostic {
                        slug: base.slug.clone(),
                        severity: BaseDiagnosticSeverity::Error,
                        path: None,
                        message: format!("duplicate base slug `{}`", base.slug),
                    });
                } else {
                    registry.bases.push(base);
                }
            }
        }
        registry
    }

    pub fn get(&self, slug: &str) -> Option<&BaseDefinition> {
        self.bases.iter().find(|b| b.slug == slug)
    }

    /// Keys of every relation-typed property declared by any base.
    pub fn relation_property_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self
            .bases
            .iter()
            .flat_map(|b| b.file.properties.iter())
            .filter(|(_, def)| def.property_type == PropertyType::Relation)
            .map(|(k, _)| k.clone())
            .collect();
        keys.sort();
        keys.dedup();
        keys
    }
}

/// The effective linkable-property set: `config ∪ relation-typed keys across
/// all bases`, deduped with config order first.
pub fn effective_linkable_properties(
    config_linkable: &[String],
    registry: &BaseRegistry,
) -> Vec<String> {
    let mut effective = config_linkable.to_vec();
    for key in registry.relation_property_keys() {
        if !effective.contains(&key) {
            effective.push(key);
        }
    }
    effective
}

/// Stable fingerprint of the effective linkable set. Persisted in
/// `derivation_meta`; a mismatch disables skip-unchanged for one build so
/// existing pages get their links re-derived under the new set.
pub fn linkable_epoch(effective: &[String]) -> String {
    let mut sorted = effective.to_vec();
    sorted.sort();
    sorted.dedup();
    blake3::hash(sorted.join("\n").as_bytes())
        .to_hex()
        .to_string()
}

/// Derive the base slug from its file path (`bases/reading.base.toml` →
/// `reading`).
pub fn slug_from_path(path: &Path) -> String {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    name.strip_suffix(".base.toml")
        .unwrap_or_else(|| name.strip_suffix(".toml").unwrap_or(name))
        .to_string()
}

/// Parse and validate one base file.
///
/// Returns the definition (if the TOML parses) plus any diagnostics.
/// Validation problems are advisory: an invalid declaration is reported but
/// the base is still listed. Broken TOML yields `(None, [file-level diag])`.
pub fn parse_base(path: &Path, content: &str) -> (Option<BaseDefinition>, Vec<BaseDiagnostic>) {
    let slug = slug_from_path(path);
    let mut diagnostics = Vec::new();

    let raw: RawBaseFile = match toml::from_str(content) {
        Ok(f) => f,
        Err(e) => {
            diagnostics.push(BaseDiagnostic {
                slug: slug.clone(),
                severity: BaseDiagnosticSeverity::Error,
                path: None,
                message: format!("invalid base file: {e}"),
            });
            return (None, diagnostics);
        }
    };

    // Convert properties one at a time: a bad declaration is dropped with a
    // diagnostic; the base itself stays listed.
    let mut properties = Vec::with_capacity(raw.properties.len());
    for (key, value) in raw.properties {
        match value.try_into::<PropertyDefinition>() {
            Ok(def) => properties.push((key, def)),
            Err(e) => diagnostics.push(BaseDiagnostic {
                slug: slug.clone(),
                severity: BaseDiagnosticSeverity::Error,
                path: None,
                message: format!("property `{key}`: invalid declaration ({e})"),
            }),
        }
    }

    let file = BaseFile {
        name: raw.name,
        description: raw.description,
        filter: raw.filter,
        preview: raw.preview,
        properties,
        views: raw.views,
    };
    let result = validate_definition(&slug, file);
    diagnostics.extend(result.diagnostics);
    (Some(result.definition), diagnostics)
}

fn validate(base: &BaseDefinition, diagnostics: &mut Vec<BaseDiagnostic>) {
    let mut push = |severity: BaseDiagnosticSeverity, path: Option<String>, message: String| {
        diagnostics.push(BaseDiagnostic {
            slug: base.slug.clone(),
            severity,
            path,
            message,
        })
    };

    if base.file.name.trim().is_empty() {
        push(
            BaseDiagnosticSeverity::Error,
            Some("name".to_string()),
            "base name must not be empty".to_string(),
        );
    }

    let mut property_keys = HashSet::new();
    for (property_index, (key, _)) in base.file.properties.iter().enumerate() {
        if !property_keys.insert(key.as_str()) {
            push(
                BaseDiagnosticSeverity::Error,
                Some(format!("properties[{property_index}].key")),
                format!("duplicate property key `{key}`"),
            );
        }
        if key == BODY_COLUMN {
            push(
                BaseDiagnosticSeverity::Error,
                Some(format!("properties.{key}")),
                format!("property name `{BODY_COLUMN}` is reserved"),
            );
        }
    }

    let mut preview_fields = HashSet::new();
    for (preview_index, definition) in base.file.preview.iter().enumerate() {
        if definition
            .label
            .as_deref()
            .is_some_and(|label| label.trim().is_empty())
        {
            push(
                BaseDiagnosticSeverity::Error,
                Some(format!("preview[{preview_index}].label")),
                "preview label must not be empty".to_string(),
            );
        }
        let path = format!("preview[{preview_index}].field");
        if let Some(identity) =
            validate_projection_field(base, &definition.field, &path, "preview", &mut push)
            && !preview_fields.insert(identity)
        {
            push(
                BaseDiagnosticSeverity::Error,
                Some(path),
                format!("duplicate preview field `{}`", definition.field),
            );
        }
    }

    // Filter fields referencing undeclared properties are a warning (the
    // vault may legitimately carry keys the base doesn't declare); op/type
    // mismatches are hard facts.
    if let Some(filter) = &base.file.filter {
        validate_filter(base, filter, "filter", "filter", &mut push);
    }

    for (view_index, view) in base.file.views.iter().enumerate() {
        if view.name.trim().is_empty() {
            push(
                BaseDiagnosticSeverity::Error,
                Some(format!("views[{view_index}].name")),
                "view name must not be empty".to_string(),
            );
        }
        if base.file.views[..view_index]
            .iter()
            .any(|seen| seen.name.eq_ignore_ascii_case(&view.name))
        {
            push(
                BaseDiagnosticSeverity::Error,
                Some(format!("views[{view_index}].name")),
                format!("duplicate view name `{}`", view.name),
            );
        }
        if view.layout != "table" {
            push(
                BaseDiagnosticSeverity::Error,
                Some(format!("views[{view_index}].layout")),
                format!(
                    "view `{}` uses unsupported layout `{}` (v1 supports `table`)",
                    view.name, view.layout
                ),
            );
        }
        for (field, label) in &view.labels {
            let path = format!("views[{view_index}].labels.{field}");
            if label.trim().is_empty() {
                push(
                    BaseDiagnosticSeverity::Error,
                    Some(path.clone()),
                    format!("view `{}` label for `{field}` must not be empty", view.name),
                );
            }
            validate_projection_field(
                base,
                field,
                &path,
                &format!("view `{}` label", view.name),
                &mut push,
            );
        }
        let mut body_seen = false;
        for (column_index, column) in view.columns.iter().enumerate() {
            if !is_body_field_reference(column) {
                continue;
            }
            let path = Some(format!("views[{view_index}].columns[{column_index}]"));
            if column != BODY_COLUMN {
                push(
                    BaseDiagnosticSeverity::Error,
                    path.clone(),
                    format!("noncanonical body column `{column}`; use `{BODY_COLUMN}`"),
                );
            }
            if std::mem::replace(&mut body_seen, true) {
                push(
                    BaseDiagnosticSeverity::Error,
                    path,
                    format!("duplicate `{BODY_COLUMN}` column in view `{}`", view.name),
                );
            }
        }
        if let Some(filter) = &view.filter {
            validate_filter(
                base,
                filter,
                &format!("views[{view_index}].filter"),
                &format!("view `{}` filter", view.name),
                &mut push,
            );
        }
        for (sort_index, sort) in view.sort.iter().enumerate() {
            validate_sort_field(
                base,
                &sort.field,
                &format!("views[{view_index}].sort[{sort_index}].field"),
                &format!("view `{}` sort", view.name),
                &mut push,
            );
        }
        if let Some(group_by) = &view.group_by
            && matches!(
                crate::vault::query::resolve_field(
                    group_by,
                    &crate::vault::query::QueryContext::for_base(base)
                ),
                Err(crate::vault::query::QueryError::ProjectionOnlyBody)
            )
        {
            push(
                BaseDiagnosticSeverity::Error,
                Some(format!("views[{view_index}].group_by")),
                format!(
                    "view `{}` group: {}",
                    view.name,
                    crate::vault::query::QueryError::ProjectionOnlyBody
                ),
            );
        }
        if let Some(group_by) = &view.group_by
            && let Some(def) = base.property(group_by)
            && matches!(
                def.property_type,
                PropertyType::Number | PropertyType::Relation | PropertyType::MultiSelect
            )
        {
            push(
                BaseDiagnosticSeverity::Warning,
                Some(format!("views[{view_index}].group_by")),
                format!(
                    "view `{}` groups by `{group_by}` ({:?}), which is not a groupable type",
                    view.name, def.property_type
                ),
            );
        }
        for (aggregate_index, aggregate) in view.aggregates.iter().enumerate() {
            if aggregate.field.as_deref().is_some_and(|field| {
                matches!(
                    crate::vault::query::resolve_field(
                        field,
                        &crate::vault::query::QueryContext::for_base(base)
                    ),
                    Err(crate::vault::query::QueryError::ProjectionOnlyBody)
                )
            }) {
                push(
                    BaseDiagnosticSeverity::Error,
                    Some(format!(
                        "views[{view_index}].aggregates[{aggregate_index}].field"
                    )),
                    format!(
                        "view `{}` aggregate: {}",
                        view.name,
                        crate::vault::query::QueryError::ProjectionOnlyBody
                    ),
                );
            }
            if !matches!(aggregate.function, AggregateFn::Count) && aggregate.field.is_none() {
                push(
                    BaseDiagnosticSeverity::Warning,
                    Some(format!(
                        "views[{view_index}].aggregates[{aggregate_index}].field"
                    )),
                    format!(
                        "view `{}`: aggregate `{:?}` requires a field",
                        view.name, aggregate.function
                    ),
                );
            }
        }
    }
}

fn validate_projection_field(
    base: &BaseDefinition,
    field: &str,
    path: &str,
    context: &str,
    push: &mut impl FnMut(BaseDiagnosticSeverity, Option<String>, String),
) -> Option<crate::vault::query::ProjectionFieldIdentity> {
    use crate::vault::query::{ProjectionFieldIdentity, resolve_projection_field};

    match resolve_projection_field(field) {
        Ok(identity) => {
            if let ProjectionFieldIdentity::Property(key) = &identity
                && base.property(key).is_none()
            {
                push(
                    BaseDiagnosticSeverity::Warning,
                    Some(path.to_string()),
                    format!(
                        "{context}: property `{key}` is not declared in [properties] and is unavailable"
                    ),
                );
            }
            Some(identity)
        }
        Err(error) => {
            push(
                BaseDiagnosticSeverity::Warning,
                Some(path.to_string()),
                format!("{context}: {error}"),
            );
            None
        }
    }
}

fn validate_sort_field(
    base: &BaseDefinition,
    field: &str,
    path: &str,
    context: &str,
    push: &mut impl FnMut(BaseDiagnosticSeverity, Option<String>, String),
) {
    use crate::vault::query::{QueryContext, ResolvedField, resolve_field};

    match resolve_field(field, &QueryContext::for_base(base)) {
        Ok(ResolvedField::Sys(sys)) if !sys.is_scalar_sortable() => push(
            BaseDiagnosticSeverity::Error,
            Some(path.to_string()),
            format!(
                "{context}: system field `{}` is not scalar-sortable",
                sys.as_str()
            ),
        ),
        Ok(ResolvedField::Prop { key, ty })
            if base.property(&key).is_some() && !ty.is_scalar_sortable() =>
        {
            push(
                BaseDiagnosticSeverity::Error,
                Some(path.to_string()),
                format!("{context}: property `{key}` ({ty:?}) is not scalar-sortable"),
            );
        }
        Err(error) => push(
            BaseDiagnosticSeverity::Error,
            Some(path.to_string()),
            format!("{context}: {error}"),
        ),
        _ => {}
    }
}

fn validate_filter(
    base: &BaseDefinition,
    filter: &Filter,
    path: &str,
    context: &str,
    push: &mut impl FnMut(BaseDiagnosticSeverity, Option<String>, String),
) {
    match filter {
        Filter::All(children) => {
            for (index, child) in children.iter().enumerate() {
                validate_filter(base, child, &format!("{path}.all[{index}]"), context, push);
            }
        }
        Filter::Any(children) => {
            for (index, child) in children.iter().enumerate() {
                validate_filter(base, child, &format!("{path}.any[{index}]"), context, push);
            }
        }
        Filter::Not(child) => {
            validate_filter(base, child, &format!("{path}.not"), context, push);
        }
        Filter::Cmp { field, op, value } => {
            if matches!(
                resolve_field(field, &QueryContext::for_base(base)),
                Err(QueryError::ProjectionOnlyBody)
            ) {
                push(
                    BaseDiagnosticSeverity::Error,
                    Some(format!("{path}.field")),
                    format!("{context}: {}", QueryError::ProjectionOnlyBody),
                );
                return;
            }
            if *op == Op::Contains {
                use crate::vault::query::{QueryContext, ResolvedField, resolve_field};

                let query_context = QueryContext::for_base(base);
                let supported = match resolve_field(field, &query_context) {
                    Ok(ResolvedField::Sys(sys)) => sys.supports_contains(),
                    Ok(ResolvedField::Prop { ty, .. }) => ty.supports_contains(),
                    Err(_) => false,
                };
                if !supported {
                    push(
                        BaseDiagnosticSeverity::Error,
                        Some(format!("{path}.op")),
                        format!(
                            "{context}: op `contains` is not valid for non-text field `{field}`"
                        ),
                    );
                    return;
                }
            }
            if *op == Op::LinksTo {
                use crate::vault::query::{QueryContext, ResolvedField, resolve_field};

                let query_context = QueryContext::for_base(base);
                let supported = matches!(
                    resolve_field(field, &query_context),
                    Ok(ResolvedField::Prop { ty, .. }) if ty.supports_links_to()
                );
                if !supported {
                    push(
                        BaseDiagnosticSeverity::Error,
                        Some(format!("{path}.op")),
                        format!(
                            "{context}: op `links_to` is only valid for relation field `{field}`"
                        ),
                    );
                    return;
                }
                if !value.is_string() {
                    push(
                        BaseDiagnosticSeverity::Error,
                        Some(format!("{path}.value")),
                        format!("{context}: op `links_to` expects a string target"),
                    );
                    return;
                }
            }
            use crate::vault::query::{QueryContext, QueryError, ResolvedField, resolve_field};

            match resolve_field(field, &QueryContext::for_base(base)) {
                Ok(ResolvedField::Sys(_)) => {}
                Ok(ResolvedField::Prop { key, ty }) => {
                    if base.property(&key).is_some() {
                        if op.is_ordering() && !ty.is_ordered() {
                            push(
                                BaseDiagnosticSeverity::Warning,
                                Some(format!("{path}.op")),
                                format!("{context}: `{op:?}` cannot order `{key}` ({ty:?})"),
                            );
                        }
                    } else {
                        push(
                            BaseDiagnosticSeverity::Warning,
                            Some(format!("{path}.field")),
                            format!(
                                "{context}: field `{key}` is not declared in [properties] (matching against raw vault values)"
                            ),
                        );
                    }
                }
                Err(error) => push(
                    BaseDiagnosticSeverity::Error,
                    Some(format!("{path}.field")),
                    format!("{context}: {error}"),
                ),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const READING_BASE: &str = r#"
# bases/reading.base.toml
name = "Reading Log"
description = "Books in flight and their wake."

[filter]
all = [ { field = "kind", op = "eq", value = "BOOK" } ]

[properties]
author   = { type = "text" }
status   = { type = "select", options = ["queued", "reading", "finished", "abandoned"] }
rating   = { type = "number" }
pages    = { type = "number" }
progress = { type = "number" }
started  = { type = "date" }
finished = { type = "date" }
series   = { type = "relation" }
themes   = { type = "multi_select", options = [] }   # empty options = open vocabulary

[[views]]
name = "Continues"
layout = "table"
filter = { field = "status", op = "eq", value = "reading" }
sort = [ { field = "started", dir = "desc" } ]
columns = ["title", "author", "progress", "pages"]

[[views]]
name = "Shelf"
layout = "table"
group_by = "status"
aggregates = [ { fn = "count" }, { fn = "avg", field = "rating" } ]
sort = [ { field = "finished", dir = "desc" } ]
columns = ["title", "author", "rating", "finished"]
"#;

    fn path(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    fn base_file_with_views<const N: usize>(names: [&str; N]) -> BaseFile {
        BaseFile {
            name: "Reading".to_string(),
            description: None,
            filter: None,
            properties: Vec::new(),
            preview: Vec::new(),
            views: names
                .into_iter()
                .map(|name| ViewDefinition {
                    name: name.to_string(),
                    layout: default_layout(),
                    labels: BTreeMap::new(),
                    filter: None,
                    sort: Vec::new(),
                    group_by: None,
                    aggregates: Vec::new(),
                    columns: Vec::new(),
                })
                .collect(),
        }
    }

    #[test]
    fn structured_base_preserves_property_order() {
        let file: BaseFile = serde_json::from_str(
            r#"{
                "name": "Reading",
                "properties": {
                    "status": { "type": "select", "options": ["queued", "reading"] },
                    "rating": { "type": "number" }
                },
                "views": [{ "name": "All", "layout": "table" }]
            }"#,
        )
        .unwrap();
        assert_eq!(
            file.properties
                .iter()
                .map(|(key, _)| key.as_str())
                .collect::<Vec<_>>(),
            vec!["status", "rating"]
        );
    }

    #[test]
    fn duplicate_property_keys_are_blocking_at_every_later_declaration() {
        let property = PropertyDefinition {
            property_type: PropertyType::Text,
            options: Vec::new(),
            many: None,
        };
        let mut file = base_file_with_views(["All"]);
        file.properties = vec![
            ("status".to_string(), property.clone()),
            ("status".to_string(), property.clone()),
            ("rating".to_string(), property.clone()),
            ("status".to_string(), property),
        ];

        let result = validate_definition("reading", file);
        let duplicate_paths = result
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.message == "duplicate property key `status`")
            .filter_map(|diagnostic| diagnostic.path.as_deref())
            .collect::<Vec<_>>();

        assert_eq!(
            duplicate_paths,
            vec!["properties[1].key", "properties[3].key"]
        );
        assert!(
            result
                .diagnostics
                .iter()
                .all(|diagnostic| { diagnostic.message != "duplicate property key `rating`" })
        );
    }

    #[test]
    fn structured_toml_base_preserves_property_order() {
        let file: BaseFile = toml::from_str(
            r#"
name = "Reading"

[properties]
status = { type = "select", options = ["queued", "reading"] }
rating = { type = "number" }

[[views]]
name = "All"
layout = "table"
"#,
        )
        .unwrap();
        assert_eq!(
            file.properties
                .iter()
                .map(|(key, _)| key.as_str())
                .collect::<Vec<_>>(),
            vec!["status", "rating"]
        );
    }

    #[test]
    fn structured_base_defaults_omitted_properties() {
        let file: BaseFile = toml::from_str("name = \"Reading\"\n").unwrap();
        assert!(file.properties.is_empty());
    }

    #[test]
    fn legacy_toml_defaults_presentation_fields_to_empty() {
        let file: BaseFile =
            toml::from_str("name = \"Reading\"\n\n[[views]]\nname = \"All\"\n").unwrap();

        assert!(file.preview.is_empty());
        assert!(file.views[0].labels.is_empty());
    }

    #[test]
    fn presentation_fields_round_trip_references_without_reordering_preview() {
        let source = r#"
name = "Reading"
preview = [
    { field = "body", label = "Excerpt" },
    { field = "title", label = "Title" },
    { field = "sys.kind", label = "Kind" },
    { field = "prop.kind", label = "Custom kind" },
    { field = "rating" },
]

[[views]]
name = "All"
labels = { body = "Excerpt", title = "Title", "sys.kind" = "Kind", "prop.kind" = "Custom kind" }
"#;

        let file: BaseFile = toml::from_str(source).unwrap();
        assert_eq!(
            file.preview
                .iter()
                .map(|definition| (definition.field.as_str(), definition.label.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                ("body", Some("Excerpt")),
                ("title", Some("Title")),
                ("sys.kind", Some("Kind")),
                ("prop.kind", Some("Custom kind")),
                ("rating", None),
            ]
        );
        assert_eq!(file.views[0].labels["body"], "Excerpt");
        assert_eq!(file.views[0].labels["title"], "Title");
        assert_eq!(file.views[0].labels["sys.kind"], "Kind");
        assert_eq!(file.views[0].labels["prop.kind"], "Custom kind");

        let serialized = toml::to_string(&file).unwrap();
        let round_tripped: BaseFile = toml::from_str(&serialized).unwrap();
        assert_eq!(
            round_tripped
                .preview
                .iter()
                .map(|definition| definition.field.as_str())
                .collect::<Vec<_>>(),
            vec!["body", "title", "sys.kind", "prop.kind", "rating"]
        );
        assert!(round_tripped.preview[4].label.is_none());
        assert!(!serialized.contains("field = \"rating\", label"));
        assert_eq!(round_tripped.views[0].labels, file.views[0].labels);
    }

    #[test]
    fn empty_presentation_collections_are_omitted_on_serialization() {
        let file: BaseFile =
            toml::from_str("name = \"Reading\"\n\n[[views]]\nname = \"All\"\n").unwrap();

        let serialized = toml::to_string(&file).unwrap();
        assert!(!serialized.contains("preview"));
        assert!(!serialized.contains("labels"));
    }

    #[test]
    fn presentation_labels_reject_whitespace_only_values_at_addressed_paths() {
        let content = r#"
name = "Reading"
preview = [
    { field = "title", label = "   " },
    { field = "rating" },
]

[[views]]
name = "All"
labels = { title = "\t" }
"#;

        let (_, diagnostics) = parse_base(&path("bases/reading.base.toml"), content);

        for expected_path in ["preview[0].label", "views[0].labels.title"] {
            assert!(diagnostics.iter().any(|diagnostic| {
                diagnostic.severity == BaseDiagnosticSeverity::Error
                    && diagnostic.path.as_deref() == Some(expected_path)
            }));
        }
        assert!(
            !diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.path.as_deref() == Some("preview[1].label") })
        );
    }

    #[test]
    fn duplicate_preview_canonical_identities_are_errors_at_later_rows() {
        let content = r#"
name = "Reading"
preview = [
    { field = "title", label = "Title" },
    { field = "sys.title", label = "System title" },
    { field = "prop.title", label = "Custom title" },
    { field = "body", label = "Excerpt" },
    { field = "sys.body", label = "Duplicate excerpt" },
]

[properties]
title = { type = "text" }
"#;

        let (_, diagnostics) = parse_base(&path("bases/reading.base.toml"), content);
        let duplicate_paths = diagnostics
            .iter()
            .filter(|diagnostic| {
                diagnostic.severity == BaseDiagnosticSeverity::Error
                    && diagnostic.message.contains("duplicate preview field")
            })
            .filter_map(|diagnostic| diagnostic.path.as_deref())
            .collect::<Vec<_>>();

        assert_eq!(
            duplicate_paths,
            vec!["preview[1].field", "preview[4].field"]
        );
        assert!(!duplicate_paths.contains(&"preview[2].field"));
    }

    #[test]
    fn unknown_presentation_references_are_addressed_warnings() {
        let content = r#"
name = "Reading"
preview = [
    { field = "sys.missing", label = "Unknown system" },
    { field = "prop.missing", label = "Unknown property" },
]

[[views]]
name = "All"
labels = { "sys.also_missing" = "Unknown system", missing = "Unknown property" }
"#;

        let (_, diagnostics) = parse_base(&path("bases/reading.base.toml"), content);

        for expected_path in [
            "preview[0].field",
            "preview[1].field",
            "views[0].labels.missing",
            "views[0].labels.sys.also_missing",
        ] {
            assert!(diagnostics.iter().any(|diagnostic| {
                diagnostic.severity == BaseDiagnosticSeverity::Warning
                    && diagnostic.path.as_deref() == Some(expected_path)
            }));
        }
    }

    #[test]
    fn body_is_valid_for_presentation_but_reserved_for_properties() {
        let content = r#"
name = "Reading"
preview = [{ field = "body", label = "Excerpt" }]

[properties]
body = { type = "text" }

[[views]]
name = "All"
labels = { body = "Excerpt" }
"#;

        let (_, diagnostics) = parse_base(&path("bases/reading.base.toml"), content);

        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.severity == BaseDiagnosticSeverity::Error
                && diagnostic.path.as_deref() == Some("properties.body")
        }));
        assert!(!diagnostics.iter().any(|diagnostic| {
            diagnostic
                .path
                .as_deref()
                .is_some_and(|path| path.starts_with("preview") || path.contains(".labels."))
        }));
    }

    #[test]
    fn qualified_shadowed_system_and_property_fields_are_distinct() {
        let content = r#"
name = "Reading"
preview = [
    { field = "sys.title", label = "System title" },
    { field = "prop.title", label = "Custom title" },
]

[properties]
title = { type = "text" }

[[views]]
name = "All"
labels = { "sys.title" = "System title", "prop.title" = "Custom title" }
"#;

        let (_, diagnostics) = parse_base(&path("bases/reading.base.toml"), content);

        assert!(diagnostics.is_empty(), "{diagnostics:?}");
    }

    #[test]
    fn structured_validation_addresses_duplicate_view() {
        let file = base_file_with_views(["All", "All"]);
        let result = validate_definition("reading", file);
        assert!(result.diagnostics.iter().any(|diagnostic| {
            diagnostic.severity == BaseDiagnosticSeverity::Error
                && diagnostic.path.as_deref() == Some("views[1].name")
        }));
    }

    #[test]
    fn structured_validation_rejects_case_only_duplicate_view() {
        let file = base_file_with_views(["All", "aLL"]);
        let result = validate_definition("reading", file);
        assert!(result.diagnostics.iter().any(|diagnostic| {
            diagnostic.severity == BaseDiagnosticSeverity::Error
                && diagnostic.path.as_deref() == Some("views[1].name")
                && diagnostic.message.contains("duplicate view name")
        }));
    }

    #[test]
    fn accepted_view_names_are_ascii_case_insensitively_addressable() {
        let result = validate_definition("reading", base_file_with_views(["All", "Rated"]));
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
        assert_eq!(result.definition.view("aLL").unwrap().name, "All");
        assert_eq!(result.definition.view("RATED").unwrap().name, "Rated");
    }

    #[test]
    fn parses_spec_reading_base_verbatim() {
        let (base, diagnostics) = parse_base(&path("bases/reading.base.toml"), READING_BASE);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let base = base.unwrap();
        assert_eq!(base.slug, "reading");
        assert_eq!(base.file.name, "Reading Log");
        assert_eq!(base.file.properties.len(), 9);
        // Declared order preserved.
        assert_eq!(base.file.properties[0].0, "author");
        assert_eq!(base.file.properties[8].0, "themes");
        assert_eq!(
            base.property("status").unwrap().property_type,
            PropertyType::Select
        );
        assert_eq!(base.property("status").unwrap().options.len(), 4);
        assert_eq!(
            base.property("series").unwrap().property_type,
            PropertyType::Relation
        );
        assert_eq!(base.file.views.len(), 2);
        assert_eq!(base.file.views[0].name, "Continues");
        assert_eq!(base.file.views[0].sort[0].dir, SortDir::Desc);
        assert_eq!(base.file.views[1].group_by.as_deref(), Some("status"));
        assert_eq!(base.file.views[1].aggregates.len(), 2);

        let Some(Filter::All(children)) = &base.file.filter else {
            panic!("expected all-filter");
        };
        assert_eq!(children.len(), 1);
        let Filter::Cmp { field, op, value } = &children[0] else {
            panic!("expected cmp");
        };
        assert_eq!(field, "kind");
        assert_eq!(*op, Op::Eq);
        assert_eq!(value, &serde_json::json!("BOOK"));
    }

    #[test]
    fn deep_filter_array_of_tables_equals_inline_spelling() {
        let inline = r#"
name = "X"
filter = { all = [ { field = "kind", op = "eq", value = "BOOK" }, { any = [ { field = "status", op = "eq", value = "reading" }, { field = "status", op = "eq", value = "queued" } ] } ] }
"#;
        let array_of_tables = r#"
name = "X"

[[filter.all]]
field = "kind"
op = "eq"
value = "BOOK"

[[filter.all]]
  [[filter.all.any]]
  field = "status"
  op = "eq"
  value = "reading"

  [[filter.all.any]]
  field = "status"
  op = "eq"
  value = "queued"
"#;
        let (a, _) = parse_base(&path("bases/x.base.toml"), inline);
        let (b, _) = parse_base(&path("bases/x.base.toml"), array_of_tables);
        let a_json = serde_json::to_value(&a.unwrap().file.filter).unwrap();
        let b_json = serde_json::to_value(&b.unwrap().file.filter).unwrap();
        assert_eq!(a_json, b_json, "the two spellings must parse identically");
    }

    #[test]
    fn slug_comes_from_filename_stem() {
        assert_eq!(slug_from_path(&path("bases/reading.base.toml")), "reading");
        assert_eq!(
            slug_from_path(&path("bases/deep-work.base.toml")),
            "deep-work"
        );
    }

    #[test]
    fn unknown_type_token_is_a_diagnostic_but_base_still_listed() {
        let content = "name = \"X\"\n\n[properties]\nrating = { type = \"stars\" }\nauthor = { type = \"text\" }\n";
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        let base = base.expect("base must still be listed");
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].slug, "x");
        assert!(diagnostics[0].message.contains("property `rating`"));
        assert_eq!(diagnostics[0].severity, BaseDiagnosticSeverity::Error);
        assert_eq!(diagnostics[0].path, None);
        // The bad declaration is dropped; the good one survives.
        assert!(base.property("rating").is_none());
        assert!(base.property("author").is_some());
    }

    #[test]
    fn system_field_property_declaration_is_allowed_with_prop_escape() {
        let content = "name = \"X\"\n\n[properties]\ntitle = { type = \"text\" }\nkind = { type = \"text\" }\nencryption = { type = \"text\" }\n";
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        let base = base.expect("valid base");

        assert!(diagnostics.is_empty());
        assert!(base.property("title").is_some());
        assert!(base.property("kind").is_some());
        assert!(base.property("encryption").is_some());
    }

    #[test]
    fn contains_validation_rejects_non_text_system_and_property_fields() {
        let content = r#"
name = "Invalid contains"
[filter]
all = [
  { field = "word_count", op = "contains", value = 0 },
  { field = "rating", op = "contains", value = 1.5 },
  { field = "done", op = "contains", value = true }
]
[properties]
rating = { type = "number" }
done = { type = "bool" }
"#;
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        assert!(base.is_some());
        let diagnostics = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == BaseDiagnosticSeverity::Error)
            .collect::<Vec<_>>();

        assert_eq!(diagnostics.len(), 3);
        assert_eq!(
            diagnostics
                .iter()
                .map(|diagnostic| diagnostic.path.as_deref())
                .collect::<Vec<_>>(),
            vec![
                Some("filter.all[0].op"),
                Some("filter.all[1].op"),
                Some("filter.all[2].op"),
            ]
        );
        assert!(diagnostics.iter().all(|diagnostic| {
            diagnostic
                .message
                .contains("op `contains` is not valid for non-text field")
        }));
    }

    #[test]
    fn links_to_validation_rejects_unsupported_field_and_value_pairs() {
        let content = r#"
name = "Invalid links"
[filter]
all = [
  { field = "author", op = "links_to", value = "Target" },
  { field = "rating", op = "links_to", value = "Target" },
  { field = "series", op = "links_to", value = 42 }
]
[properties]
author = { type = "text" }
rating = { type = "number" }
series = { type = "relation" }
"#;
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        assert!(base.is_some());
        let diagnostics = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == BaseDiagnosticSeverity::Error)
            .collect::<Vec<_>>();

        assert_eq!(diagnostics.len(), 3);
        assert_eq!(
            diagnostics
                .iter()
                .map(|diagnostic| diagnostic.path.as_deref())
                .collect::<Vec<_>>(),
            vec![
                Some("filter.all[0].op"),
                Some("filter.all[1].op"),
                Some("filter.all[2].value"),
            ]
        );
    }

    #[test]
    fn contains_validation_accepts_text_like_and_membership_fields() {
        let content = r#"
name = "Valid contains"
[filter]
all = [
  { field = "text", op = "contains", value = "x" },
  { field = "url", op = "contains", value = "x" },
  { field = "date", op = "contains", value = "2026" },
  { field = "datetime", op = "contains", value = "2026" },
  { field = "select", op = "contains", value = "x" },
  { field = "multi", op = "contains", value = "x" },
  { field = "relation", op = "contains", value = "[[X]]" }
]
[properties]
text = { type = "text" }
url = { type = "url" }
date = { type = "date" }
datetime = { type = "datetime" }
select = { type = "select", options = ["x"] }
multi = { type = "multi_select", options = ["x"] }
relation = { type = "relation" }
"#;
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), content);

        assert!(base.is_some());
        assert!(
            diagnostics
                .iter()
                .all(|diagnostic| diagnostic.severity != BaseDiagnosticSeverity::Error)
        );
    }

    #[test]
    fn links_to_validation_rejects_non_relation_properties() {
        let content = r#"
name = "Invalid links"
[filter]
all = [
  { field = "author", op = "links_to", value = "Target" },
  { field = "rating", op = "links_to", value = "Target" }
]
[properties]
author = { type = "text" }
rating = { type = "number" }
"#;
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        assert!(base.is_some());
        let diagnostics = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == BaseDiagnosticSeverity::Error)
            .collect::<Vec<_>>();

        assert_eq!(diagnostics.len(), 2);
        assert_eq!(
            diagnostics
                .iter()
                .map(|diagnostic| diagnostic.path.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("filter.all[0].op"), Some("filter.all[1].op")]
        );
    }

    #[test]
    fn ordering_op_against_select_is_a_diagnostic() {
        let content = r#"
name = "X"

[filter]
field = "status"
op = "gt"
value = "reading"

[properties]
status = { type = "select", options = ["queued", "reading"] }
"#;
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        assert!(base.is_some());
        let diagnostic = diagnostics
            .iter()
            .find(|diagnostic| diagnostic.message.contains("cannot order"))
            .unwrap();
        assert_eq!(diagnostic.severity, BaseDiagnosticSeverity::Warning);
        assert_eq!(diagnostic.path.as_deref(), Some("filter.op"));
    }

    #[test]
    fn duplicate_view_names_are_a_diagnostic() {
        let content = "name = \"X\"\n\n[[views]]\nname = \"V\"\n\n[[views]]\nname = \"V\"\n";
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        assert!(base.is_some());
        let diagnostic = diagnostics
            .iter()
            .find(|diagnostic| diagnostic.message.contains("duplicate view name"))
            .unwrap();
        assert_eq!(diagnostic.severity, BaseDiagnosticSeverity::Error);
        assert_eq!(diagnostic.path.as_deref(), Some("views[1].name"));
    }

    #[test]
    fn non_scalar_saved_view_sorts_are_blocking_diagnostics() {
        let content = r#"
name = "X"

[properties]
themes = { type = "multi_select" }
series = { type = "relation" }
status = { type = "select" }

[[views]]
name = "All"
sort = [
    { field = "tags" },
    { field = "sys.aliases" },
    { field = "encryption" },
    { field = "themes" },
    { field = "prop.series" },
    { field = "status" },
    { field = "title" },
]
"#;
        let (_, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        let error_paths = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == BaseDiagnosticSeverity::Error)
            .filter_map(|diagnostic| diagnostic.path.as_deref())
            .collect::<Vec<_>>();
        assert_eq!(
            error_paths,
            vec![
                "views[0].sort[0].field",
                "views[0].sort[1].field",
                "views[0].sort[2].field",
                "views[0].sort[3].field",
                "views[0].sort[4].field",
            ]
        );
    }

    #[test]
    fn unknown_explicit_system_saved_view_sort_is_an_error() {
        let content =
            "name = \"X\"\n\n[[views]]\nname = \"All\"\nsort = [{ field = \"sys.missing\" }]\n";
        let (_, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        let diagnostic = diagnostics
            .iter()
            .find(|diagnostic| diagnostic.message.contains("unknown system field"))
            .unwrap();
        assert_eq!(diagnostic.severity, BaseDiagnosticSeverity::Error);
        assert_eq!(diagnostic.path.as_deref(), Some("views[0].sort[0].field"));
    }

    #[test]
    fn broken_toml_yields_file_level_diagnostic_only() {
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), "name = = nope");
        assert!(base.is_none());
        assert_eq!(diagnostics.len(), 1);
        assert!(diagnostics[0].message.contains("invalid base file"));
        assert_eq!(diagnostics[0].severity, BaseDiagnosticSeverity::Error);
        assert_eq!(diagnostics[0].path, None);
    }

    #[test]
    fn undeclared_filter_field_is_a_warning_not_fatal() {
        let content = r#"
name = "X"

[filter]
field = "mystery"
op = "eq"
value = "y"
"#;
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        assert!(base.is_some());
        let diagnostic = diagnostics
            .iter()
            .find(|diagnostic| diagnostic.message.contains("not declared"))
            .unwrap();
        assert_eq!(diagnostic.severity, BaseDiagnosticSeverity::Warning);
        assert_eq!(diagnostic.path.as_deref(), Some("filter.field"));
    }

    #[test]
    fn prop_escape_skips_system_resolution() {
        // `prop.kind` refers to the vault property, not the system field —
        // undeclared here, so it warns rather than silently binding to system.
        let content = r#"
name = "X"

[filter]
field = "prop.kind"
op = "eq"
value = "work"
"#;
        let (_, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        let diagnostic = diagnostics
            .iter()
            .find(|diagnostic| diagnostic.message.contains("`kind` is not declared"))
            .unwrap();
        assert_eq!(diagnostic.severity, BaseDiagnosticSeverity::Warning);
        assert_eq!(diagnostic.path.as_deref(), Some("filter.field"));

        // Bare `kind` binds to the system field: no warning.
        let bare = r#"
name = "X"

[filter]
field = "kind"
op = "eq"
value = "BOOK"
"#;
        let (_, diagnostics) = parse_base(&path("bases/x.base.toml"), bare);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
    }
    #[test]
    fn saved_definition_rejects_contains_for_bare_and_explicit_non_text_property() {
        let content = r#"
name = "Invalid contains aliases"
[filter]
all = [
  { field = "rating", op = "contains", value = 4 },
  { field = "prop.rating", op = "contains", value = 4 }
]
[properties]
rating = { type = "number" }
"#;
        let (_, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        let errors = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == BaseDiagnosticSeverity::Error)
            .collect::<Vec<_>>();

        assert_eq!(errors.len(), 2, "{errors:?}");
        assert_eq!(errors[0].path.as_deref(), Some("filter.all[0].op"));
        assert_eq!(errors[1].path.as_deref(), Some("filter.all[1].op"));
        assert_eq!(
            errors[0].message,
            "filter: op `contains` is not valid for non-text field `rating`"
        );
        assert_eq!(
            errors[1].message,
            "filter: op `contains` is not valid for non-text field `prop.rating`"
        );
    }
    #[test]
    fn body_is_reserved_against_property_declarations() {
        let content = r#"
name = "X"

[properties]
body = { type = "text" }
"#;
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), content);

        assert!(base.is_some());
        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.severity == BaseDiagnosticSeverity::Error
                && diagnostic.path.as_deref() == Some("properties.body")
                && diagnostic.message == "property name `body` is reserved"
        }));
    }

    #[test]
    fn body_column_may_appear_once_in_each_view() {
        let content = r#"
name = "X"

[[views]]
name = "First"
columns = ["title", "body"]

[[views]]
name = "Second"
columns = ["body", "updated_at"]
"#;
        let (_, diagnostics) = parse_base(&path("bases/x.base.toml"), content);

        assert!(
            diagnostics.is_empty(),
            "one body column per view is valid: {diagnostics:?}"
        );
    }

    #[test]
    fn duplicate_body_columns_in_one_view_are_a_diagnostic() {
        let content = r#"
name = "X"

[[views]]
name = "All"
columns = ["body", "title", "body"]
"#;
        let (_, diagnostics) = parse_base(&path("bases/x.base.toml"), content);

        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.severity == BaseDiagnosticSeverity::Error
                && diagnostic.path.as_deref() == Some("views[0].columns[2]")
                && diagnostic.message == "duplicate `body` column in view `All`"
        }));
    }

    #[test]
    fn noncanonical_body_column_aliases_are_blocking_diagnostics() {
        for alias in ["sys.body", "prop.body"] {
            let content = format!(
                r#"
name = "X"

[[views]]
name = "All"
columns = ["{alias}"]
"#
            );
            let (_, diagnostics) = parse_base(&path("bases/x.base.toml"), &content);

            assert!(diagnostics.iter().any(|diagnostic| {
                diagnostic.severity == BaseDiagnosticSeverity::Error
                    && diagnostic.path.as_deref() == Some("views[0].columns[0]")
                    && diagnostic.message
                        == format!("noncanonical body column `{alias}`; use `body`")
            }));
        }
    }

    #[test]
    fn body_aliases_participate_in_duplicate_detection() {
        let content = r#"
name = "X"

[[views]]
name = "All"
columns = ["body", "sys.body", "prop.body"]
"#;
        let (_, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        let duplicate_paths = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.message == "duplicate `body` column in view `All`")
            .filter_map(|diagnostic| diagnostic.path.as_deref())
            .collect::<Vec<_>>();

        assert_eq!(
            duplicate_paths,
            vec!["views[0].columns[1]", "views[0].columns[2]"]
        );
    }

    #[test]
    fn body_is_rejected_as_a_saved_view_query_capability() {
        let content = r#"
name = "X"

[filter]
field = "body"
op = "contains"
value = "secret"

[[views]]
name = "All"
filter = { field = "body", op = "contains", value = "secret" }
sort = [{ field = "body" }]
group_by = "body"
aggregates = [{ fn = "count", field = "body" }]
columns = ["body"]
"#;
        let (_, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        let paths = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == BaseDiagnosticSeverity::Error)
            .filter_map(|diagnostic| diagnostic.path.as_deref())
            .collect::<Vec<_>>();

        assert_eq!(
            paths,
            vec![
                "filter.field",
                "views[0].filter.field",
                "views[0].sort[0].field",
                "views[0].group_by",
                "views[0].aggregates[0].field",
            ]
        );
    }
}
