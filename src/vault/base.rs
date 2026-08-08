//! Base definitions: TOML files under `bases/` declaring a membership filter,
//! a property schema, and saved views over pages.
//!
//! Bases are views over pages; they never own pages. A page may match many
//! bases; deleting a base deletes nothing else. Parse failures never poison
//! the registry — a broken base is listed with its diagnostics and excluded
//! from evaluation.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// System fields addressable in filters/sorts/columns without declaration.
/// Bases may not declare properties with these names; resolution is
/// system-first for bare names (escape with `prop.<name>` / `sys.<name>`).
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

/// A saved view: layout, optional extra filter, sort, grouping, columns.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ViewDefinition {
    pub name: String,
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
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct BaseFile {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Filter>,
    /// Declared properties in file order (serialized as a key → definition map).
    #[serde(default, with = "property_map")]
    #[schema(value_type = std::collections::HashMap<String, PropertyDefinition>)]
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
#[derive(Debug, Clone, Serialize, ToSchema)]
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

/// Evaluate a base's membership filter against a parsed page's metadata —
/// the completion/diagnostics path, where hitting SQLite per keystroke is
/// not warranted. Semantics mirror the SQL compilation for the common ops;
/// anything unresolvable is conservatively `false`.
pub fn base_matches_meta(
    base: &BaseDefinition,
    meta: &crate::vault::page::PageMeta,
    path: &str,
) -> bool {
    match &base.file.filter {
        Some(filter) => filter_matches_meta(filter, meta, path),
        None => true,
    }
}

fn filter_matches_meta(filter: &Filter, meta: &crate::vault::page::PageMeta, path: &str) -> bool {
    match filter {
        Filter::All(children) => children.iter().all(|c| filter_matches_meta(c, meta, path)),
        Filter::Any(children) => children.iter().any(|c| filter_matches_meta(c, meta, path)),
        Filter::Not(child) => !filter_matches_meta(child, meta, path),
        Filter::Cmp { field, op, value } => cmp_matches_meta(field, *op, value, meta, path),
    }
}

fn cmp_matches_meta(
    field: &str,
    op: Op,
    value: &serde_json::Value,
    meta: &crate::vault::page::PageMeta,
    path: &str,
) -> bool {
    let bare = field
        .strip_prefix("sys.")
        .or_else(|| field.strip_prefix("prop."))
        .unwrap_or(field);
    let is_system = !field.starts_with("prop.") && SYSTEM_FIELDS.contains(&bare);

    if is_system {
        // Multi-valued system fields: membership semantics.
        let list: Option<Vec<String>> = match bare {
            "tags" => Some(meta.tags.clone()),
            "aliases" => Some(meta.aliases.clone()),
            _ => None,
        };
        if let Some(items) = list {
            return match op {
                Op::Eq | Op::Contains => {
                    value.as_str().is_some_and(|v| items.iter().any(|i| i == v))
                }
                Op::Ne => value.as_str().is_none_or(|v| !items.iter().any(|i| i == v)),
                Op::In => value.as_array().is_some_and(|vs| {
                    vs.iter()
                        .filter_map(|v| v.as_str())
                        .any(|v| items.iter().any(|i| i == v))
                }),
                Op::IsEmpty => items.is_empty(),
                Op::NotEmpty => !items.is_empty(),
                _ => false,
            };
        }

        let scalar: Option<String> = match bare {
            "id" => Some(meta.id.to_string()),
            "path" => Some(path.to_string()),
            "title" => meta.title.clone(),
            "kind" => Some(
                crate::vault::kind::resolve(path, meta.kind)
                    .0
                    .as_str()
                    .to_string(),
            ),
            "project" => meta.project.clone(),
            "created_at" => meta.created_at.map(|dt| dt.to_rfc3339()),
            "updated_at" => meta.updated_at.map(|dt| dt.to_rfc3339()),
            // journal_date / word_count are index-derived; unknowable here.
            _ => None,
        };
        return scalar_matches(scalar.as_deref(), op, value);
    }

    // Property: native TOML value from extras.
    let current = meta.extra.get(bare);
    match op {
        Op::IsEmpty => current.is_none_or(toml_value_is_empty),
        Op::NotEmpty => current.is_some_and(|v| !toml_value_is_empty(v)),
        _ => current.is_some_and(|v| toml_value_matches(v, op, value)),
    }
}

fn toml_value_is_empty(value: &toml::Value) -> bool {
    match value {
        toml::Value::String(s) => s.is_empty(),
        toml::Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

fn scalar_matches(current: Option<&str>, op: Op, value: &serde_json::Value) -> bool {
    match op {
        Op::IsEmpty => current.is_none(),
        Op::NotEmpty => current.is_some(),
        Op::In => match (current, value.as_array()) {
            (Some(c), Some(items)) => items.iter().filter_map(|v| v.as_str()).any(|v| v == c),
            _ => false,
        },
        Op::Contains => match (current, value.as_str()) {
            (Some(c), Some(v)) => c.contains(v),
            _ => false,
        },
        Op::Ne => match (current, value.as_str()) {
            (Some(c), Some(v)) => c != v,
            (None, _) => true,
            _ => false,
        },
        _ => match (current, value.as_str()) {
            (Some(c), Some(v)) => match op {
                Op::Eq => c == v,
                Op::Lt => c < v,
                Op::Lte => c <= v,
                Op::Gt => c > v,
                Op::Gte => c >= v,
                _ => false,
            },
            _ => false,
        },
    }
}

/// Compare a native TOML value (any element for arrays) against a JSON
/// literal under `op`.
fn toml_value_matches(current: &toml::Value, op: Op, value: &serde_json::Value) -> bool {
    if let toml::Value::Array(items) = current {
        return match op {
            // "No element equals" for ne.
            Op::Ne => !items
                .iter()
                .any(|item| toml_value_matches(item, Op::Eq, value)),
            _ => items.iter().any(|item| toml_value_matches(item, op, value)),
        };
    }
    match op {
        Op::In => value
            .as_array()
            .is_some_and(|vs| vs.iter().any(|v| toml_value_matches(current, Op::Eq, v))),
        Op::Contains => match (current, value.as_str()) {
            (toml::Value::String(s), Some(v)) => s.contains(v),
            _ => false,
        },
        Op::LinksTo => match (current, value.as_str()) {
            (toml::Value::String(s), Some(target)) => {
                let bare = s
                    .trim()
                    .strip_prefix("[[")
                    .and_then(|x| x.strip_suffix("]]"))
                    .map(|inner| inner.split_once('|').map(|(t, _)| t).unwrap_or(inner))
                    .unwrap_or(s.trim());
                crate::vault::canonical::CanonicalName::from_title(bare).as_str()
                    == crate::vault::canonical::CanonicalName::from_title(target).as_str()
            }
            _ => false,
        },
        _ => {
            let ordering = toml_json_ordering(current, value);
            match (op, ordering) {
                (Op::Eq, Some(std::cmp::Ordering::Equal)) => true,
                (Op::Ne, Some(o)) => o != std::cmp::Ordering::Equal,
                (Op::Ne, None) => true,
                (Op::Lt, Some(std::cmp::Ordering::Less)) => true,
                (Op::Lte, Some(o)) => o != std::cmp::Ordering::Greater,
                (Op::Gt, Some(std::cmp::Ordering::Greater)) => true,
                (Op::Gte, Some(o)) => o != std::cmp::Ordering::Less,
                _ => false,
            }
        }
    }
}

fn toml_json_ordering(
    current: &toml::Value,
    value: &serde_json::Value,
) -> Option<std::cmp::Ordering> {
    match (current, value) {
        (toml::Value::Integer(i), serde_json::Value::Number(n)) => {
            (*i as f64).partial_cmp(&n.as_f64()?)
        }
        (toml::Value::Float(f), serde_json::Value::Number(n)) => f.partial_cmp(&n.as_f64()?),
        (toml::Value::Boolean(b), serde_json::Value::Bool(v)) => Some(b.cmp(v)),
        (toml::Value::String(s), serde_json::Value::String(v)) => Some(s.as_str().cmp(v.as_str())),
        // ISO 8601 collates correctly as text.
        (toml::Value::Datetime(dt), serde_json::Value::String(v)) => {
            Some(dt.to_string().as_str().cmp(v.as_str()))
        }
        _ => None,
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
        properties,
        views: raw.views,
    };
    let result = validate_definition(&slug, file);
    diagnostics.extend(result.diagnostics);
    (Some(result.definition), diagnostics)
}

fn validate(base: &BaseDefinition, diagnostics: &mut Vec<BaseDiagnostic>) {
    let mut push =
        |severity: BaseDiagnosticSeverity, path: Option<String>, message: String| {
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

    // Properties may not shadow system fields.
    for (key, _) in &base.file.properties {
        if SYSTEM_FIELDS.contains(&key.as_str()) {
            push(
                BaseDiagnosticSeverity::Warning,
                Some(format!("properties.{key}")),
                format!("property `{key}` shadows a system field and cannot be declared"),
            );
        }
    }

    // Filter fields referencing undeclared properties are a warning (the
    // vault may legitimately carry keys the base doesn't declare); op/type
    // mismatches are hard facts.
    if let Some(filter) = &base.file.filter {
        validate_filter(base, filter, "filter", "filter", &mut push);
    }

    let mut seen_views = HashSet::new();
    for (view_index, view) in base.file.views.iter().enumerate() {
        if view.name.trim().is_empty() {
            push(
                BaseDiagnosticSeverity::Error,
                Some(format!("views[{view_index}].name")),
                "view name must not be empty".to_string(),
            );
        }
        if !seen_views.insert(view.name.as_str()) {
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
        if let Some(filter) = &view.filter {
            validate_filter(
                base,
                filter,
                &format!("views[{view_index}].filter"),
                &format!("view `{}` filter", view.name),
                &mut push,
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
                validate_filter(
                    base,
                    child,
                    &format!("{path}.all[{index}]"),
                    context,
                    push,
                );
            }
        }
        Filter::Any(children) => {
            for (index, child) in children.iter().enumerate() {
                validate_filter(
                    base,
                    child,
                    &format!("{path}.any[{index}]"),
                    context,
                    push,
                );
            }
        }
        Filter::Not(child) => {
            validate_filter(base, child, &format!("{path}.not"), context, push);
        }
        Filter::Cmp { field, op, .. } => {
            let bare = field
                .strip_prefix("prop.")
                .or_else(|| field.strip_prefix("sys."))
                .unwrap_or(field);
            let is_system = !field.starts_with("prop.") && SYSTEM_FIELDS.contains(&bare);
            if !is_system {
                match base.property(bare) {
                    Some(def) => {
                        if op.is_ordering() && !def.property_type.is_ordered() {
                            push(
                                BaseDiagnosticSeverity::Warning,
                                Some(format!("{path}.op")),
                                format!(
                                    "{context}: `{op:?}` cannot order `{bare}` ({:?})",
                                    def.property_type
                                ),
                            );
                        }
                    }
                    None => push(
                        BaseDiagnosticSeverity::Warning,
                        Some(format!("{path}.field")),
                        format!(
                            "{context}: field `{bare}` is not declared in [properties] (matching against raw vault values)"
                        ),
                    ),
                }
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
            views: names
                .into_iter()
                .map(|name| ViewDefinition {
                    name: name.to_string(),
                    layout: default_layout(),
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
    fn structured_validation_addresses_duplicate_view() {
        let file = base_file_with_views(["All", "All"]);
        let result = validate_definition("reading", file);
        assert!(result.diagnostics.iter().any(|diagnostic| {
            diagnostic.severity == BaseDiagnosticSeverity::Error
                && diagnostic.path.as_deref() == Some("views[1].name")
        }));
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
    fn system_field_property_declaration_is_rejected() {
        let content = "name = \"X\"\n\n[properties]\ntitle = { type = \"text\" }\nkind = { type = \"text\" }\nencryption = { type = \"text\" }\n";
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        assert!(base.is_some());
        assert!(diagnostics
            .iter()
            .all(|diagnostic| diagnostic.severity == BaseDiagnosticSeverity::Warning));
        assert_eq!(
            diagnostics
                .iter()
                .filter_map(|diagnostic| diagnostic.path.as_deref())
                .collect::<Vec<_>>(),
            vec![
                "properties.title",
                "properties.kind",
                "properties.encryption"
            ]
        );
        assert!(diagnostics[0].message.contains("shadows a system field"));
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
}
