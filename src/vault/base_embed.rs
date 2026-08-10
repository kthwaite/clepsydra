use super::base::{BaseDefinition, Filter, Op, PropertyType, SortKey};
use super::query::{QueryContext, ResolvedField, SysField, resolve_field};

const MAX_FILTER_DEPTH: usize = 8;
const MAX_FILTER_NODES: usize = 64;
const MAX_LOGICAL_CHILDREN: usize = 32;
const MAX_IN_VALUES: usize = 100;
const MAX_SORT_KEYS: usize = 8;
const MAX_FIELD_BYTES: usize = 256;
const MAX_SCALAR_STRING_BYTES: usize = 4 * 1024;
const MIN_LIMIT: u32 = 1;
const MAX_LIMIT: u32 = 200;

#[derive(Debug, Clone, Copy)]
pub struct EmbedOverrides<'a> {
    pub filter: Option<&'a Filter>,
    pub sort: Option<&'a [SortKey]>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbedValidationDiagnostic {
    pub field: Option<String>,
    pub filter_path: Option<String>,
    pub message: String,
}

/// Validate request-owned additions to a saved Base view.
///
/// Complexity and byte-size limits are checked iteratively before semantic
/// recursion or query compilation. Field identity and type resolution are
/// delegated to the query engine's canonical resolver.
pub fn validate_embed_overrides(
    base: &BaseDefinition,
    overrides: EmbedOverrides<'_>,
) -> Result<(), Vec<EmbedValidationDiagnostic>> {
    let complexity = validate_complexity(overrides);
    if !complexity.is_empty() {
        return Err(complexity);
    }

    let mut diagnostics = Vec::new();
    if let Some(filter) = overrides.filter {
        validate_filter_semantics(base, filter, "filter", &mut diagnostics);
    }
    if let Some(sort) = overrides.sort {
        validate_sort_semantics(base, sort, &mut diagnostics);
    }

    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(diagnostics)
    }
}

fn validate_complexity(overrides: EmbedOverrides<'_>) -> Vec<EmbedValidationDiagnostic> {
    let mut diagnostics = Vec::new();

    if let Some(limit) = overrides.limit
        && !(MIN_LIMIT..=MAX_LIMIT).contains(&limit)
    {
        diagnostics.push(diagnostic(
            Some("limit"),
            None,
            "limit must be between 1 and 200",
        ));
    }

    if let Some(sort) = overrides.sort {
        if sort.len() > MAX_SORT_KEYS {
            diagnostics.push(diagnostic(
                Some("sort"),
                None,
                format!(
                    "sort has {} keys; maximum is {MAX_SORT_KEYS}",
                    sort.len()
                ),
            ));
        }
        for key in sort {
            validate_field_size(&key.field, None, &mut diagnostics);
        }
    }

    let Some(root) = overrides.filter else {
        return diagnostics;
    };

    let mut node_count = 0;
    let mut stack = vec![(root, 1_usize, "filter".to_string())];
    while let Some((filter, depth, path)) = stack.pop() {
        node_count += 1;
        if node_count > MAX_FILTER_NODES {
            diagnostics.push(diagnostic(
                None,
                Some("filter"),
                format!("filter has {node_count} nodes; maximum is {MAX_FILTER_NODES}"),
            ));
            break;
        }
        if depth > MAX_FILTER_DEPTH {
            diagnostics.push(diagnostic(
                None,
                Some(&path),
                format!("filter depth {depth} exceeds maximum of {MAX_FILTER_DEPTH}"),
            ));
            continue;
        }

        match filter {
            Filter::All(children) | Filter::Any(children) => {
                if children.len() > MAX_LOGICAL_CHILDREN {
                    diagnostics.push(diagnostic(
                        None,
                        Some(&path),
                        format!(
                            "filter group has {} children; maximum is {MAX_LOGICAL_CHILDREN}",
                            children.len()
                        ),
                    ));
                    continue;
                }
                let segment = if matches!(filter, Filter::All(_)) {
                    "all"
                } else {
                    "any"
                };
                for (index, child) in children.iter().enumerate().rev() {
                    stack.push((child, depth + 1, format!("{path}.{segment}[{index}]")));
                }
            }
            Filter::Not(child) => {
                stack.push((child, depth + 1, format!("{path}.not")));
            }
            Filter::Cmp { field, op, value } => {
                validate_field_size(field, Some(&format!("{path}.field")), &mut diagnostics);
                if *op == Op::In
                    && let Some(values) = value.as_array()
                    && values.len() > MAX_IN_VALUES
                {
                    diagnostics.push(diagnostic(
                        Some(canonical_field_hint(field)),
                        Some(&format!("{path}.value")),
                        format!(
                            "`in` value has {} items; maximum is {MAX_IN_VALUES}",
                            values.len()
                        ),
                    ));
                }
                validate_string_sizes(
                    value,
                    canonical_field_hint(field),
                    &format!("{path}.value"),
                    &mut diagnostics,
                );
            }
        }
    }

    diagnostics
}

fn validate_field_size(
    field: &str,
    filter_path: Option<&str>,
    diagnostics: &mut Vec<EmbedValidationDiagnostic>,
) {
    if field.len() > MAX_FIELD_BYTES {
        diagnostics.push(diagnostic(
            Some(canonical_field_hint(field)),
            filter_path,
            format!(
                "field identifier is {} UTF-8 bytes; maximum is {MAX_FIELD_BYTES}",
                field.len()
            ),
        ));
    }
}

fn validate_string_sizes(
    value: &serde_json::Value,
    field: &str,
    filter_path: &str,
    diagnostics: &mut Vec<EmbedValidationDiagnostic>,
) {
    let mut stack = vec![value];
    while let Some(value) = stack.pop() {
        match value {
            serde_json::Value::String(value) if value.len() > MAX_SCALAR_STRING_BYTES => {
                diagnostics.push(diagnostic(
                    Some(field),
                    Some(filter_path),
                    format!(
                        "string value is {} UTF-8 bytes; maximum is {MAX_SCALAR_STRING_BYTES}",
                        value.len()
                    ),
                ));
            }
            serde_json::Value::Array(values) => stack.extend(values),
            serde_json::Value::Object(values) => stack.extend(values.values()),
            _ => {}
        }
    }
}

fn validate_filter_semantics(
    base: &BaseDefinition,
    filter: &Filter,
    path: &str,
    diagnostics: &mut Vec<EmbedValidationDiagnostic>,
) {
    match filter {
        Filter::All(children) => {
            for (index, child) in children.iter().enumerate() {
                validate_filter_semantics(
                    base,
                    child,
                    &format!("{path}.all[{index}]"),
                    diagnostics,
                );
            }
        }
        Filter::Any(children) => {
            for (index, child) in children.iter().enumerate() {
                validate_filter_semantics(
                    base,
                    child,
                    &format!("{path}.any[{index}]"),
                    diagnostics,
                );
            }
        }
        Filter::Not(child) => {
            validate_filter_semantics(base, child, &format!("{path}.not"), diagnostics);
        }
        Filter::Cmp { field, op, value } => {
            validate_comparison(base, field, *op, value, path, diagnostics);
        }
    }
}

fn validate_comparison(
    base: &BaseDefinition,
    field: &str,
    op: Op,
    value: &serde_json::Value,
    path: &str,
    diagnostics: &mut Vec<EmbedValidationDiagnostic>,
) {
    let resolved = match resolve_declared_field(base, field) {
        Ok(resolved) => resolved,
        Err(message) => {
            diagnostics.push(diagnostic(
                Some(canonical_field_hint(field)),
                Some(&format!("{path}.field")),
                message,
            ));
            return;
        }
    };
    let canonical = resolved_name(&resolved);

    if !supports_operator(&resolved, op) {
        diagnostics.push(diagnostic(
            Some(&canonical),
            Some(&format!("{path}.op")),
            format!(
                "op `{}` is not valid for field `{canonical}`",
                op_name(op)
            ),
        ));
        return;
    }

    match op {
        Op::IsEmpty | Op::NotEmpty => {
            if !value.is_null() {
                diagnostics.push(diagnostic(
                    Some(&canonical),
                    Some(&format!("{path}.value")),
                    format!("op `{}` does not accept a value", op_name(op)),
                ));
            }
        }
        Op::LinksTo => {
            if !value.is_string() {
                diagnostics.push(diagnostic(
                    Some(&canonical),
                    Some(&format!("{path}.value")),
                    "op `links_to` expects a string target",
                ));
            }
        }
        Op::In => {
            let Some(values) = value.as_array() else {
                diagnostics.push(diagnostic(
                    Some(&canonical),
                    Some(&format!("{path}.value")),
                    "op `in` expects an array",
                ));
                return;
            };
            let property_type = resolved_property_type(&resolved);
            for item in values {
                if let Some(reason) = scalar_type_error(property_type, item) {
                    diagnostics.push(diagnostic(
                        Some(&canonical),
                        Some(&format!("{path}.value")),
                        format!("invalid value for field `{canonical}`: {reason}"),
                    ));
                }
            }
        }
        _ => {
            if let Some(reason) = scalar_type_error(resolved_property_type(&resolved), value) {
                diagnostics.push(diagnostic(
                    Some(&canonical),
                    Some(&format!("{path}.value")),
                    format!("invalid value for field `{canonical}`: {reason}"),
                ));
            }
        }
    }
}

fn resolve_declared_field(
    base: &BaseDefinition,
    field: &str,
) -> Result<ResolvedField, String> {
    let resolved =
        resolve_field(field, &QueryContext::for_base(base)).map_err(|error| error.to_string())?;
    if let ResolvedField::Prop { key, .. } = &resolved
        && base.property(key).is_none()
    {
        if field.starts_with("prop.") {
            return Err(format!("unknown property field `{key}`"));
        }
        return Err(format!("unknown field `{key}`"));
    }
    Ok(resolved)
}

fn validate_sort_semantics(
    base: &BaseDefinition,
    sort: &[SortKey],
    diagnostics: &mut Vec<EmbedValidationDiagnostic>,
) {
    let mut seen = Vec::with_capacity(sort.len());
    for sort_key in sort {
        let resolved = match resolve_declared_field(base, &sort_key.field) {
            Ok(resolved) => resolved,
            Err(message) => {
                diagnostics.push(diagnostic(
                    Some(canonical_field_hint(&sort_key.field)),
                    None,
                    message,
                ));
                continue;
            }
        };
        let canonical = resolved_name(&resolved);

        if seen.contains(&resolved) {
            diagnostics.push(diagnostic(
                Some(&canonical),
                None,
                format!("duplicate canonical sort field `{canonical}`"),
            ));
            continue;
        }
        seen.push(resolved.clone());

        match resolved {
            ResolvedField::Sys(sys) if !sys.is_scalar_sortable() => {
                diagnostics.push(diagnostic(
                    Some(&canonical),
                    None,
                    format!("system field `{canonical}` is not scalar-sortable"),
                ));
            }
            ResolvedField::Prop { ty, .. } if !ty.is_scalar_sortable() => {
                diagnostics.push(diagnostic(
                    Some(&canonical),
                    None,
                    format!("property `{canonical}` ({ty:?}) is not scalar-sortable"),
                ));
            }
            _ => {}
        }
    }
}

fn supports_operator(field: &ResolvedField, op: Op) -> bool {
    match field {
        ResolvedField::Sys(SysField::Tags | SysField::Aliases) => matches!(
            op,
            Op::Eq | Op::Ne | Op::Contains | Op::In | Op::IsEmpty | Op::NotEmpty
        ),
        ResolvedField::Sys(sys) => match op {
            Op::LinksTo => false,
            Op::Contains => sys.supports_contains(),
            op if op.is_ordering() => sys.property_type() != PropertyType::Bool,
            _ => true,
        },
        ResolvedField::Prop { ty, .. } => match op {
            Op::LinksTo => ty.supports_links_to(),
            Op::Contains => ty.supports_contains(),
            op if op.is_ordering() => ty.is_ordered(),
            _ => true,
        },
    }
}

fn resolved_property_type(field: &ResolvedField) -> PropertyType {
    match field {
        ResolvedField::Sys(sys) => sys.property_type(),
        ResolvedField::Prop { ty, .. } => *ty,
    }
}

fn scalar_type_error(property_type: PropertyType, value: &serde_json::Value) -> Option<&'static str> {
    match property_type {
        PropertyType::Number if !value.is_number() => Some("expected a number"),
        PropertyType::Bool if !value.is_boolean() => Some("expected a boolean"),
        PropertyType::Text
        | PropertyType::Date
        | PropertyType::Datetime
        | PropertyType::Select
        | PropertyType::MultiSelect
        | PropertyType::Url
        | PropertyType::Relation
            if !value.is_string() =>
        {
            Some("expected a string")
        }
        _ => None,
    }
}

fn resolved_name(field: &ResolvedField) -> String {
    match field {
        ResolvedField::Sys(sys) => sys.as_str().to_string(),
        ResolvedField::Prop { key, .. } => key.clone(),
    }
}

fn canonical_field_hint(field: &str) -> &str {
    field
        .strip_prefix("sys.")
        .or_else(|| field.strip_prefix("prop."))
        .unwrap_or(field)
}

fn diagnostic(
    field: Option<&str>,
    filter_path: Option<&str>,
    message: impl Into<String>,
) -> EmbedValidationDiagnostic {
    EmbedValidationDiagnostic {
        field: field.map(str::to_string),
        filter_path: filter_path.map(str::to_string),
        message: message.into(),
    }
}

fn op_name(op: Op) -> &'static str {
    match op {
        Op::Eq => "eq",
        Op::Ne => "ne",
        Op::Lt => "lt",
        Op::Lte => "lte",
        Op::Gt => "gt",
        Op::Gte => "gte",
        Op::Contains => "contains",
        Op::In => "in",
        Op::LinksTo => "links_to",
        Op::IsEmpty => "is_empty",
        Op::NotEmpty => "not_empty",
    }
}

#[cfg(test)]
mod tests {
    use super::{EmbedOverrides, validate_embed_overrides};
    use crate::vault::base::{
        BaseDefinition, BaseFile, Filter, Op, PropertyDefinition, PropertyType, SortDir, SortKey,
    };
    use serde_json::{Value, json};

    fn property(property_type: PropertyType) -> PropertyDefinition {
        PropertyDefinition {
            property_type,
            options: Vec::new(),
            many: None,
        }
    }

    fn base_with_properties(properties: Vec<(String, PropertyDefinition)>) -> BaseDefinition {
        BaseDefinition {
            slug: "reading".to_string(),
            file: BaseFile {
                name: "Reading".to_string(),
                description: None,
                filter: None,
                properties,
                views: Vec::new(),
            },
        }
    }

    fn base() -> BaseDefinition {
        base_with_properties(vec![
            ("text".into(), property(PropertyType::Text)),
            ("rating".into(), property(PropertyType::Number)),
            ("done".into(), property(PropertyType::Bool)),
            ("due".into(), property(PropertyType::Date)),
            ("moment".into(), property(PropertyType::Datetime)),
            ("status".into(), property(PropertyType::Select)),
            ("themes".into(), property(PropertyType::MultiSelect)),
            ("url".into(), property(PropertyType::Url)),
            ("series".into(), property(PropertyType::Relation)),
            ("title".into(), property(PropertyType::Text)),
        ])
    }

    fn cmp(field: impl Into<String>, op: Op, value: Value) -> Filter {
        Filter::Cmp {
            field: field.into(),
            op,
            value,
        }
    }

    fn validate_filter(base: &BaseDefinition, filter: &Filter) -> Result<(), Vec<super::EmbedValidationDiagnostic>> {
        validate_embed_overrides(
            base,
            EmbedOverrides {
                filter: Some(filter),
                sort: None,
                limit: None,
            },
        )
    }

    fn assert_one_error(
        result: Result<(), Vec<super::EmbedValidationDiagnostic>>,
        field: Option<&str>,
        filter_path: Option<&str>,
        message: &str,
    ) {
        let diagnostics = result.expect_err("validation should fail");
        assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
        assert_eq!(diagnostics[0].field.as_deref(), field);
        assert_eq!(diagnostics[0].filter_path.as_deref(), filter_path);
        assert_eq!(diagnostics[0].message, message);
    }

    #[test]
    fn accepts_typed_scalar_filters() {
        let base = base();
        let cases = [
            cmp("rating", Op::Gt, json!(4.5)),
            cmp("done", Op::Eq, json!(true)),
            cmp("due", Op::Lte, json!("2026-08-10")),
            cmp("moment", Op::Gt, json!("2026-08-10T12:00:00Z")),
            cmp("status", Op::Eq, json!("reading")),
            cmp("text", Op::Contains, json!("folio")),
        ];

        for filter in &cases {
            assert!(validate_filter(&base, filter).is_ok(), "{filter:?}");
        }
    }

    #[test]
    fn accepts_relation_links_to_filter() {
        let base = base();
        assert!(
            validate_filter(&base, &cmp("series", Op::LinksTo, json!("Reading List"))).is_ok()
        );
    }

    #[test]
    fn reports_nested_logical_filter_path() {
        let base = base();
        let filter = Filter::All(vec![Filter::Any(vec![Filter::Not(Box::new(cmp(
            "missing",
            Op::Eq,
            json!("x"),
        )))])]);

        assert_one_error(
            validate_filter(&base, &filter),
            Some("missing"),
            Some("filter.all[0].any[0].not.field"),
            "unknown field `missing`",
        );
    }

    #[test]
    fn accepts_documented_system_field_allowlist() {
        let base = base();
        let fields = [
            "id",
            "path",
            "title",
            "kind",
            "project",
            "tags",
            "aliases",
            "created_at",
            "updated_at",
            "journal_date",
        ];
        for field in fields {
            assert!(
                validate_filter(&base, &cmp(field, Op::Eq, json!("value"))).is_ok(),
                "{field}"
            );
        }
        assert!(validate_filter(&base, &cmp("encryption", Op::Eq, json!(true))).is_ok());
        assert!(validate_filter(&base, &cmp("word_count", Op::Eq, json!(42))).is_ok());
    }

    #[test]
    fn resolves_bare_and_explicit_declared_properties() {
        let base = base();
        let filter = Filter::All(vec![
            cmp("rating", Op::Gte, json!(4)),
            cmp("prop.rating", Op::Lte, json!(5)),
            cmp("prop.title", Op::Contains, json!("property title")),
        ]);
        assert!(validate_filter(&base, &filter).is_ok());
    }

    #[test]
    fn rejects_unknown_bare_field() {
        let base = base();
        assert_one_error(
            validate_filter(&base, &cmp("missing", Op::Eq, json!("x"))),
            Some("missing"),
            Some("filter.field"),
            "unknown field `missing`",
        );
    }

    #[test]
    fn rejects_unknown_explicit_property_field() {
        let base = base();
        assert_one_error(
            validate_filter(&base, &cmp("prop.missing", Op::Eq, json!("x"))),
            Some("missing"),
            Some("filter.field"),
            "unknown property field `missing`",
        );
    }

    #[test]
    fn canonical_sort_aliases_cannot_bypass_duplicate_or_reserved_rules() {
        let base = base();
        let duplicate_system = [
            SortKey { field: "title".into(), dir: SortDir::Asc },
            SortKey { field: "sys.title".into(), dir: SortDir::Desc },
        ];
        assert_one_error(
            validate_embed_overrides(
                &base,
                EmbedOverrides { filter: None, sort: Some(&duplicate_system), limit: None },
            ),
            Some("title"),
            None,
            "duplicate canonical sort field `title`",
        );

        let duplicate_property = [
            SortKey { field: "rating".into(), dir: SortDir::Asc },
            SortKey { field: "prop.rating".into(), dir: SortDir::Desc },
        ];
        assert_one_error(
            validate_embed_overrides(
                &base,
                EmbedOverrides { filter: None, sort: Some(&duplicate_property), limit: None },
            ),
            Some("rating"),
            None,
            "duplicate canonical sort field `rating`",
        );

        for (field, canonical) in [
            ("tags", "tags"),
            ("sys.tags", "tags"),
            ("encryption", "encryption"),
            ("sys.encryption", "encryption"),
        ] {
            let sort = [SortKey { field: field.into(), dir: SortDir::Asc }];
            assert_one_error(
                validate_embed_overrides(
                    &base,
                    EmbedOverrides { filter: None, sort: Some(&sort), limit: None },
                ),
                Some(canonical),
                None,
                &format!("system field `{canonical}` is not scalar-sortable"),
            );
        }
    }

    #[test]
    fn rejects_contains_for_number_bool_and_word_count() {
        let base = base();
        let filter = Filter::All(vec![
            cmp("rating", Op::Contains, json!(4)),
            cmp("done", Op::Contains, json!(true)),
            cmp("word_count", Op::Contains, json!(42)),
        ]);
        let diagnostics = validate_filter(&base, &filter).expect_err("validation should fail");
        assert_eq!(diagnostics.len(), 3, "{diagnostics:?}");
        for (index, field) in ["rating", "done", "word_count"].iter().enumerate() {
            assert_eq!(diagnostics[index].field.as_deref(), Some(*field));
            assert_eq!(
                diagnostics[index].filter_path.as_deref(),
                Some(format!("filter.all[{index}].op").as_str())
            );
            assert_eq!(
                diagnostics[index].message,
                format!("op `contains` is not valid for field `{field}`")
            );
        }
    }

    fn nested_not(depth: usize) -> Filter {
        let mut filter = cmp("title", Op::Eq, json!("x"));
        for _ in 1..depth {
            filter = Filter::Not(Box::new(filter));
        }
        filter
    }

    #[test]
    fn enforces_filter_depth_with_root_counted_as_one() {
        let base = base();
        assert!(validate_filter(&base, &nested_not(8)).is_ok());
        assert_one_error(
            validate_filter(&base, &nested_not(9)),
            None,
            Some("filter.not.not.not.not.not.not.not.not"),
            "filter depth 9 exceeds maximum of 8",
        );
    }

    fn filter_with_nodes(leaf_count: usize) -> Filter {
        let left = leaf_count / 2;
        Filter::All(vec![
            Filter::All((0..left).map(|_| cmp("title", Op::Eq, json!("x"))).collect()),
            Filter::Any(
                (left..leaf_count)
                    .map(|_| cmp("title", Op::Eq, json!("x")))
                    .collect(),
            ),
        ])
    }

    #[test]
    fn enforces_total_filter_node_limit() {
        let base = base();
        assert!(validate_filter(&base, &filter_with_nodes(61)).is_ok());
        assert_one_error(
            validate_filter(&base, &filter_with_nodes(62)),
            None,
            Some("filter"),
            "filter has 65 nodes; maximum is 64",
        );
    }

    #[test]
    fn enforces_logical_group_child_limit() {
        let base = base();
        for group in [
            Filter::All as fn(Vec<Filter>) -> Filter,
            Filter::Any as fn(Vec<Filter>) -> Filter,
        ] {
            let with_children = |count| {
                group(
                    (0..count)
                        .map(|_| cmp("title", Op::Eq, json!("x")))
                        .collect(),
                )
            };
            assert!(validate_filter(&base, &with_children(32)).is_ok());
            assert_one_error(
                validate_filter(&base, &with_children(33)),
                None,
                Some("filter"),
                "filter group has 33 children; maximum is 32",
            );
        }
    }

    #[test]
    fn enforces_in_value_limit() {
        let base = base();
        let filter = |count| cmp("status", Op::In, Value::Array(vec![json!("x"); count]));
        assert!(validate_filter(&base, &filter(100)).is_ok());
        assert_one_error(
            validate_filter(&base, &filter(101)),
            Some("status"),
            Some("filter.value"),
            "`in` value has 101 items; maximum is 100",
        );
    }

    #[test]
    fn enforces_sort_key_limit() {
        let base = base();
        let fields = [
            "id", "path", "title", "kind", "project", "created_at", "updated_at",
            "journal_date", "word_count",
        ];
        let sort = fields
            .iter()
            .map(|field| SortKey { field: (*field).into(), dir: SortDir::Asc })
            .collect::<Vec<_>>();
        assert!(
            validate_embed_overrides(
                &base,
                EmbedOverrides { filter: None, sort: Some(&sort[..8]), limit: None },
            )
            .is_ok()
        );
        assert_one_error(
            validate_embed_overrides(
                &base,
                EmbedOverrides { filter: None, sort: Some(&sort), limit: None },
            ),
            Some("sort"),
            None,
            "sort has 9 keys; maximum is 8",
        );
    }

    #[test]
    fn measures_field_identifiers_in_utf8_bytes() {
        let field_256 = "é".repeat(128);
        let field_257 = format!("{field_256}a");
        let base = base_with_properties(vec![(
            field_256.clone(),
            property(PropertyType::Text),
        )]);
        assert!(
            validate_filter(&base, &cmp(&field_256, Op::Eq, json!("x"))).is_ok()
        );
        assert_one_error(
            validate_filter(&base, &cmp(&field_257, Op::Eq, json!("x"))),
            Some(&field_257),
            Some("filter.field"),
            "field identifier is 257 UTF-8 bytes; maximum is 256",
        );
    }

    #[test]
    fn measures_scalar_strings_in_utf8_bytes() {
        let base = base();
        let value_4096 = "é".repeat(2048);
        let value_4097 = format!("{value_4096}a");
        assert!(
            validate_filter(&base, &cmp("text", Op::Eq, json!(value_4096))).is_ok()
        );
        assert_one_error(
            validate_filter(&base, &cmp("text", Op::Eq, json!(value_4097))),
            Some("text"),
            Some("filter.value"),
            "string value is 4097 UTF-8 bytes; maximum is 4096",
        );
    }

    #[test]
    fn enforces_embed_limit_range() {
        let base = base();
        for limit in [1, 200] {
            assert!(
                validate_embed_overrides(
                    &base,
                    EmbedOverrides { filter: None, sort: None, limit: Some(limit) },
                )
                .is_ok()
            );
        }
        for limit in [0, 201] {
            assert_one_error(
                validate_embed_overrides(
                    &base,
                    EmbedOverrides { filter: None, sort: None, limit: Some(limit) },
                ),
                Some("limit"),
                None,
                "limit must be between 1 and 200",
            );
        }
    }
}
