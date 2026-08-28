use crate::vault::base::{
    BaseDefinition, CandidateLinkTargets, Filter, MetaFilterContext, Op, ViewDefinition,
    candidate_link_targets, filter_matches_meta, fixed_candidate_comparison_matches,
};
use crate::vault::page::PageMeta;
use crate::vault::query::{QueryContext, ResolvedField, SysField, resolve_field};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum BaseMemberScope {
    Membership,
    View,
    Field,
    Embed,
}

/// What a Base's predicates force on a member created through it. Only
/// conjunctive equality and membership tests force anything: `kind eq "BOOK"`
/// fixes a value, `status in [..]` and an any-group over one field narrow it to
/// a set, and everything else — ranges, negations, emptiness — leaves the field
/// to the author.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BaseMemberImplication {
    Fixed { value: serde_json::Value },
    Choice { values: Vec<serde_json::Value> },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct BaseMemberFieldRequirement {
    pub field: String,
    pub membership: bool,
    pub view: bool,
    pub embed: bool,
    /// The value this field is forced to, when the predicates force one.
    pub implied: Option<BaseMemberImplication>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct BaseMemberDiagnostic {
    pub scope: BaseMemberScope,
    pub field: Option<String>,
    pub filter_path: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct BaseMemberCapability {
    pub view: String,
    pub enabled: bool,
    pub fields: Vec<BaseMemberFieldRequirement>,
    pub blockers: Vec<BaseMemberDiagnostic>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CandidateDerived {
    pub word_count: u32,
    pub journal_date: Option<chrono::NaiveDate>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Possibility {
    AlwaysTrue,
    Maybe,
    AlwaysFalse,
}

fn all(values: impl Iterator<Item = Possibility>) -> Possibility {
    values.fold(Possibility::AlwaysTrue, |acc, value| match (acc, value) {
        (Possibility::AlwaysFalse, _) | (_, Possibility::AlwaysFalse) => Possibility::AlwaysFalse,
        (Possibility::AlwaysTrue, Possibility::AlwaysTrue) => Possibility::AlwaysTrue,
        _ => Possibility::Maybe,
    })
}

fn any(values: impl Iterator<Item = Possibility>) -> Possibility {
    values.fold(Possibility::AlwaysFalse, |acc, value| match (acc, value) {
        (Possibility::AlwaysTrue, _) | (_, Possibility::AlwaysTrue) => Possibility::AlwaysTrue,
        (Possibility::AlwaysFalse, Possibility::AlwaysFalse) => Possibility::AlwaysFalse,
        _ => Possibility::Maybe,
    })
}

pub fn candidate_matches(
    base: &BaseDefinition,
    view: &ViewDefinition,
    meta: &PageMeta,
    path: &str,
    derived: &CandidateDerived,
    today: chrono::NaiveDate,
) -> Result<(), Vec<BaseMemberDiagnostic>> {
    composed_candidate_matches(base, view, None, meta, path, derived, today)
}

pub fn composed_candidate_matches(
    base: &BaseDefinition,
    view: &ViewDefinition,
    embed_filter: Option<&Filter>,
    meta: &PageMeta,
    path: &str,
    derived: &CandidateDerived,
    today: chrono::NaiveDate,
) -> Result<(), Vec<BaseMemberDiagnostic>> {
    let link_targets = candidate_link_targets(base, meta, |_| {
        Ok::<Option<String>, std::convert::Infallible>(None)
    })
    .expect("infallible unresolved link collection");
    composed_candidate_matches_with_link_targets(
        base,
        view,
        embed_filter,
        meta,
        path,
        derived,
        &link_targets,
        today,
    )
}

// Every argument is one field of the `MetaFilterContext` this builds; bundling
// them into a struct would only move the same list one call earlier.
#[allow(clippy::too_many_arguments)]
pub(crate) fn composed_candidate_matches_with_link_targets(
    base: &BaseDefinition,
    view: &ViewDefinition,
    embed_filter: Option<&Filter>,
    meta: &PageMeta,
    path: &str,
    derived: &CandidateDerived,
    link_targets: &CandidateLinkTargets,
    today: chrono::NaiveDate,
) -> Result<(), Vec<BaseMemberDiagnostic>> {
    let context = MetaFilterContext {
        base,
        meta,
        path,
        word_count: Some(derived.word_count),
        journal_date: derived.journal_date,
        link_targets: Some(link_targets),
        today,
    };
    let mut diagnostics = Vec::new();

    if let Some(filter) = &base.file.filter
        && !filter_matches_meta(filter, &context)
    {
        diagnostics.push(candidate_diagnostic(
            base,
            BaseMemberScope::Membership,
            filter,
            "filter",
            "candidate does not match the base membership filter",
        ));
    }
    if let Some(filter) = &view.filter
        && !filter_matches_meta(filter, &context)
    {
        diagnostics.push(candidate_diagnostic(
            base,
            BaseMemberScope::View,
            filter,
            &format!("views.{}.filter", view.name),
            "candidate does not match the selected view filter",
        ));
    }
    if let Some(filter) = embed_filter
        && !filter_matches_meta(filter, &context)
    {
        diagnostics.push(candidate_diagnostic(
            base,
            BaseMemberScope::Embed,
            filter,
            "embed_filter",
            "candidate does not match the embed filter",
        ));
    }

    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(diagnostics)
    }
}

pub fn creation_capabilities(
    base: &BaseDefinition,
    today: chrono::NaiveDate,
) -> Vec<BaseMemberCapability> {
    base.file
        .views
        .iter()
        .map(|view| composed_member_capability(base, view, None, today))
        .collect()
}

pub fn composed_member_capability(
    base: &BaseDefinition,
    view: &ViewDefinition,
    embed_filter: Option<&Filter>,
    today: chrono::NaiveDate,
) -> BaseMemberCapability {
    let mut fields = Vec::new();
    let membership = base
        .file
        .filter
        .as_ref()
        .map_or(Possibility::AlwaysTrue, |filter| {
            filter_possibility(base, filter, today)
        });
    let view_possibility = view
        .filter
        .as_ref()
        .map_or(Possibility::AlwaysTrue, |filter| {
            filter_possibility(base, filter, today)
        });
    let embed_possibility = embed_filter.map_or(Possibility::AlwaysTrue, |filter| {
        filter_possibility(base, filter, today)
    });

    if let Some(filter) = &base.file.filter {
        collect_fields(base, filter, true, false, false, &mut fields);
    }
    if let Some(filter) = &view.filter {
        collect_fields(base, filter, false, true, false, &mut fields);
    }
    if let Some(filter) = embed_filter {
        collect_fields(base, filter, false, false, true, &mut fields);
    }

    let enabled = all([membership, view_possibility, embed_possibility].into_iter())
        != Possibility::AlwaysFalse;
    let mut blockers = Vec::new();
    if !enabled {
        if membership == Possibility::AlwaysFalse {
            collect_contributors(
                base,
                base.file
                    .filter
                    .as_ref()
                    .expect("analysed membership filter"),
                "filter",
                Possibility::AlwaysFalse,
                BaseMemberScope::Membership,
                today,
                &mut blockers,
            );
        }
        if view_possibility == Possibility::AlwaysFalse {
            collect_contributors(
                base,
                view.filter.as_ref().expect("analysed view filter"),
                &format!("views.{}.filter", view.name),
                Possibility::AlwaysFalse,
                BaseMemberScope::View,
                today,
                &mut blockers,
            );
        }
        if embed_possibility == Possibility::AlwaysFalse {
            collect_contributors(
                base,
                embed_filter.expect("analysed embed filter"),
                "embed_filter",
                Possibility::AlwaysFalse,
                BaseMemberScope::Embed,
                today,
                &mut blockers,
            );
        }
    }

    BaseMemberCapability {
        view: view.name.clone(),
        enabled,
        fields: fields
            .into_iter()
            .map(|(_, requirement)| requirement)
            .collect(),
        blockers,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum FieldIdentity {
    System(SysField),
    Property(String),
}

fn collect_fields(
    base: &BaseDefinition,
    filter: &Filter,
    membership: bool,
    view: bool,
    embed: bool,
    fields: &mut Vec<(FieldIdentity, BaseMemberFieldRequirement)>,
) {
    collect_fields_in(base, filter, membership, view, embed, true, fields);
}

/// `forcing` marks a conjunctive positive position: only there does a predicate
/// force a value on a new member. Under a negation, or inside a disjunction the
/// branches do not agree on, a predicate still names its field but implies
/// nothing about it.
fn collect_fields_in(
    base: &BaseDefinition,
    filter: &Filter,
    membership: bool,
    view: bool,
    embed: bool,
    forcing: bool,
    fields: &mut Vec<(FieldIdentity, BaseMemberFieldRequirement)>,
) {
    match filter {
        Filter::Any(children) => {
            // A disjunction forces a value only when every branch tests the
            // same field for equality: then it is a choice among those values.
            let alternatives = if forcing {
                single_field_alternatives(base, children)
            } else {
                None
            };
            for child in children {
                collect_fields_in(base, child, membership, view, embed, false, fields);
            }
            if let Some((identity, values)) = alternatives
                && let Some((_, requirement)) = fields
                    .iter_mut()
                    .find(|(candidate, _)| *candidate == identity)
            {
                requirement.implied = merge_implications(
                    requirement.implied.take(),
                    Some(BaseMemberImplication::Choice { values }),
                );
            }
        }
        Filter::All(children) => {
            for child in children {
                collect_fields_in(base, child, membership, view, embed, forcing, fields);
            }
        }
        Filter::Not(child) => {
            collect_fields_in(base, child, membership, view, embed, false, fields)
        }
        Filter::Cmp { field, .. } => {
            let Some((identity, request_key)) = resolved_requirement(base, field) else {
                return;
            };
            let implied = if forcing {
                implication_of(filter)
            } else {
                None
            };
            if let Some((_, existing)) = fields
                .iter_mut()
                .find(|(candidate, _)| *candidate == identity)
            {
                existing.membership |= membership;
                existing.view |= view;
                existing.embed |= embed;
                existing.implied = merge_implications(existing.implied.take(), implied);
            } else {
                fields.push((
                    identity,
                    BaseMemberFieldRequirement {
                        field: request_key,
                        membership,
                        view,
                        embed,
                        implied,
                    },
                ));
            }
        }
    }
}

/// The value one comparison forces, if any.
fn implication_of(filter: &Filter) -> Option<BaseMemberImplication> {
    let Filter::Cmp { op, value, .. } = filter else {
        return None;
    };
    if value.is_null() {
        return None;
    }
    match op {
        Op::Eq | Op::Contains => Some(BaseMemberImplication::Fixed {
            value: value.clone(),
        }),
        Op::In => {
            let values = value.as_array()?;
            if values.is_empty() {
                return None;
            }
            Some(BaseMemberImplication::Choice {
                values: values.clone(),
            })
        }
        _ => None,
    }
}

/// The values an any-group forces when every branch tests the same field for
/// equality; anything else makes the group unforceable.
fn single_field_alternatives(
    base: &BaseDefinition,
    children: &[Filter],
) -> Option<(FieldIdentity, Vec<serde_json::Value>)> {
    if children.is_empty() {
        return None;
    }
    let mut identity: Option<FieldIdentity> = None;
    let mut values = Vec::new();
    for child in children {
        let Filter::Cmp { field, op, value } = child else {
            return None;
        };
        if !matches!(op, Op::Eq | Op::Contains) {
            return None;
        }
        let (child_identity, _) = resolved_requirement(base, field)?;
        match &identity {
            Some(current) if *current != child_identity => return None,
            Some(_) => {}
            None => identity = Some(child_identity),
        }
        if value.is_null() {
            return None;
        }
        values.push(value.clone());
    }
    identity.map(|identity| (identity, values))
}

/// Predicates on one field intersect: each narrows what a new member may hold,
/// a predicate that forces nothing leaves the others standing, and a
/// contradiction prefills nothing rather than guessing.
fn merge_implications(
    existing: Option<BaseMemberImplication>,
    incoming: Option<BaseMemberImplication>,
) -> Option<BaseMemberImplication> {
    use BaseMemberImplication::{Choice, Fixed};
    match (existing, incoming) {
        (None, other) => other,
        (some, None) => some,
        (Some(Fixed { value: left }), Some(Fixed { value: right })) => {
            (left == right).then_some(Fixed { value: left })
        }
        (Some(Fixed { value }), Some(Choice { values }))
        | (Some(Choice { values }), Some(Fixed { value })) => {
            values.contains(&value).then_some(Fixed { value })
        }
        (Some(Choice { values: left }), Some(Choice { values: right })) => {
            let mut both: Vec<_> = left
                .into_iter()
                .filter(|value| right.contains(value))
                .collect();
            match both.len() {
                0 => None,
                1 => Some(Fixed {
                    value: both.remove(0),
                }),
                _ => Some(Choice { values: both }),
            }
        }
    }
}

fn resolved_requirement(base: &BaseDefinition, field: &str) -> Option<(FieldIdentity, String)> {
    let context = QueryContext::for_base(base);
    match resolve_field(field, &context).ok()? {
        ResolvedField::Sys(sys) => Some((FieldIdentity::System(sys), sys.as_str().to_owned())),
        ResolvedField::Prop { key, .. } => {
            let bare_context = QueryContext::for_base(base);
            let shadows_system = matches!(
                resolve_field(&key, &bare_context),
                Ok(ResolvedField::Sys(_))
            );
            let request_key = if shadows_system {
                format!("prop.{key}")
            } else {
                key.clone()
            };
            Some((FieldIdentity::Property(key), request_key))
        }
    }
}

fn bare_field(field: &str) -> &str {
    field
        .strip_prefix("sys.")
        .or_else(|| field.strip_prefix("prop."))
        .unwrap_or(field)
}

fn candidate_diagnostic(
    base: &BaseDefinition,
    scope: BaseMemberScope,
    filter: &Filter,
    root: &str,
    message: &str,
) -> BaseMemberDiagnostic {
    let field = match filter {
        Filter::Cmp { field, .. } => Some(
            resolved_requirement(base, field)
                .map(|(_, request_key)| request_key)
                .unwrap_or_else(|| bare_field(field).to_owned()),
        ),
        _ => None,
    };
    BaseMemberDiagnostic {
        scope,
        field,
        filter_path: Some(root.to_owned()),
        message: message.to_owned(),
    }
}

fn filter_possibility(
    base: &BaseDefinition,
    filter: &Filter,
    today: chrono::NaiveDate,
) -> Possibility {
    match filter {
        Filter::All(children) => all(children
            .iter()
            .map(|child| filter_possibility(base, child, today))),
        Filter::Any(children) => any(children
            .iter()
            .map(|child| filter_possibility(base, child, today))),
        Filter::Not(child) => match filter_possibility(base, child, today) {
            Possibility::AlwaysTrue => Possibility::AlwaysFalse,
            Possibility::Maybe => Possibility::Maybe,
            Possibility::AlwaysFalse => Possibility::AlwaysTrue,
        },
        Filter::Cmp { field, op, value } => comparison_possibility(base, field, *op, value, today),
    }
}

fn comparison_possibility(
    base: &BaseDefinition,
    field: &str,
    op: Op,
    value: &serde_json::Value,
    today: chrono::NaiveDate,
) -> Possibility {
    match fixed_candidate_comparison_matches(base, field, op, value, today) {
        Some(true) => Possibility::AlwaysTrue,
        Some(false) => Possibility::AlwaysFalse,
        None => Possibility::Maybe,
    }
}

fn collect_contributors(
    base: &BaseDefinition,
    filter: &Filter,
    path: &str,
    desired: Possibility,
    scope: BaseMemberScope,
    today: chrono::NaiveDate,
    blockers: &mut Vec<BaseMemberDiagnostic>,
) {
    match filter {
        Filter::All(children) => {
            for (index, child) in children.iter().enumerate() {
                if filter_possibility(base, child, today) == desired {
                    collect_contributors(
                        base,
                        child,
                        &format!("{path}.all[{index}]"),
                        desired,
                        scope,
                        today,
                        blockers,
                    );
                }
            }
        }
        Filter::Any(children) => {
            for (index, child) in children.iter().enumerate() {
                if filter_possibility(base, child, today) == desired {
                    collect_contributors(
                        base,
                        child,
                        &format!("{path}.any[{index}]"),
                        desired,
                        scope,
                        today,
                        blockers,
                    );
                }
            }
        }
        Filter::Not(child) => {
            let opposite = match desired {
                Possibility::AlwaysTrue => Possibility::AlwaysFalse,
                Possibility::AlwaysFalse => Possibility::AlwaysTrue,
                Possibility::Maybe => return,
            };
            collect_contributors(
                base,
                child,
                &format!("{path}.not"),
                opposite,
                scope,
                today,
                blockers,
            );
        }
        Filter::Cmp { field, .. } => {
            if filter_possibility(base, filter, today) == desired {
                blockers.push(BaseMemberDiagnostic {
                    scope,
                    field: Some(
                        resolved_requirement(base, field)
                            .map(|(_, request_key)| request_key)
                            .unwrap_or_else(|| bare_field(field).to_owned()),
                    ),
                    filter_path: Some(path.to_owned()),
                    message: "fixed candidate state prevents blank member creation".to_owned(),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;
    use crate::vault::base::{BaseDefinition, Op, parse_base};
    use crate::vault::base_embed::{EmbedOverrides, validate_embed_overrides};
    use crate::vault::index::VaultIndex;
    use crate::vault::kind::Kind;
    use crate::vault::page::PageMeta;
    use crate::vault::query::{QueryContext, QueryOutput, QuerySpec, evaluate};
    use std::path::Path;

    fn base(source: &str) -> BaseDefinition {
        parse_base(Path::new("bases/reading.base.toml"), source)
            .0
            .expect("valid base")
    }

    /// Sunday; Monday of its ISO week is 2026-08-03.
    fn fixed_today() -> chrono::NaiveDate {
        chrono::NaiveDate::from_ymd_opt(2026, 8, 9).unwrap()
    }

    const READING_SOURCE: &str = r#"
name = "Reading"
filter = { field = "kind", op = "eq", value = "BOOK" }
[properties]
status = { type = "select", options = ["queued", "reading", "finished"] }
[[views]]
name = "Unread"
layout = "table"
filter = { field = "status", op = "eq", value = "reading" }
"#;

    fn comparison(field: &str, op: Op, value: serde_json::Value) -> Filter {
        Filter::Cmp {
            field: field.to_owned(),
            op,
            value,
        }
    }

    fn derived() -> CandidateDerived {
        CandidateDerived {
            word_count: 0,
            journal_date: None,
        }
    }

    #[test]
    fn composed_capability_deduplicates_all_predicates_with_embed_provenance() {
        let base = base(
            r#"
name = "Composed"
[filter]
all = [
  { field = "kind", op = "eq", value = "BOOK" },
  { field = "prop.kind", op = "eq", value = "genre" },
  { field = "status", op = "ne", value = "finished" }
]
[properties]
kind = { type = "text" }
status = { type = "select", options = ["reading", "finished"] }
rating = { type = "number" }
[[views]]
name = "Reading"
layout = "table"
filter = { field = "status", op = "eq", value = "reading" }
"#,
        );
        let embed_filter = Filter::All(vec![
            comparison("sys.kind", Op::Eq, serde_json::json!("BOOK")),
            comparison("prop.kind", Op::Eq, serde_json::json!("genre")),
            Filter::Any(vec![
                comparison("status", Op::Eq, serde_json::json!("reading")),
                comparison("rating", Op::Gte, serde_json::json!(4)),
            ]),
        ]);

        let capability = composed_member_capability(
            &base,
            &base.file.views[0],
            Some(&embed_filter),
            fixed_today(),
        );

        assert!(capability.enabled);
        assert_eq!(
            capability.fields,
            vec![
                BaseMemberFieldRequirement {
                    field: "kind".into(),
                    membership: true,
                    view: false,
                    embed: true,
                    // Membership and the embed agree on the same value.
                    implied: Some(BaseMemberImplication::Fixed {
                        value: serde_json::json!("BOOK"),
                    }),
                },
                BaseMemberFieldRequirement {
                    field: "prop.kind".into(),
                    membership: true,
                    view: false,
                    embed: true,
                    implied: Some(BaseMemberImplication::Fixed {
                        value: serde_json::json!("genre"),
                    }),
                },
                BaseMemberFieldRequirement {
                    field: "status".into(),
                    membership: true,
                    view: true,
                    embed: true,
                    // `ne finished` forces nothing and the embed's disjunction
                    // spans two fields, but the view still pins the value.
                    implied: Some(BaseMemberImplication::Fixed {
                        value: serde_json::json!("reading"),
                    }),
                },
                BaseMemberFieldRequirement {
                    field: "rating".into(),
                    membership: false,
                    view: false,
                    embed: true,
                    implied: None,
                },
            ]
        );
    }

    #[test]
    fn composed_capability_reports_nested_embed_blocker_with_exact_identity() {
        let base = base(
            r#"
name = "Nested blocker"
[properties]
word_count = { type = "number" }
[[views]]
name = "All"
layout = "table"
"#,
        );
        let embed_filter = Filter::All(vec![Filter::Not(Box::new(comparison(
            "sys.word_count",
            Op::Eq,
            serde_json::json!(0),
        )))]);

        let capability = composed_member_capability(
            &base,
            &base.file.views[0],
            Some(&embed_filter),
            fixed_today(),
        );

        assert!(!capability.enabled);
        assert_eq!(capability.blockers.len(), 1);
        assert_eq!(capability.blockers[0].scope, BaseMemberScope::Embed);
        assert_eq!(capability.blockers[0].field.as_deref(), Some("word_count"));
        assert_eq!(
            capability.blockers[0].filter_path.as_deref(),
            Some("embed_filter.all[0].not")
        );
    }

    #[test]
    fn composed_candidate_matches_nested_embed_and_reports_exact_embed_diagnostic() {
        let base = base(
            r#"
name = "Typed embed"
[properties]
kind = { type = "text" }
status = { type = "select", options = ["reading", "queued"] }
rating = { type = "number" }
done = { type = "bool" }
[[views]]
name = "All"
layout = "table"
"#,
        );
        let nested = Filter::All(vec![
            comparison("rating", Op::Gte, serde_json::json!(4.5)),
            Filter::Any(vec![
                comparison("status", Op::Eq, serde_json::json!("reading")),
                comparison("status", Op::Eq, serde_json::json!("queued")),
            ]),
            Filter::Not(Box::new(comparison(
                "done",
                Op::Eq,
                serde_json::json!(false),
            ))),
        ]);
        let mut meta = PageMeta::new();
        meta.extra.insert("rating".into(), toml::Value::Float(4.5));
        meta.extra
            .insert("status".into(), toml::Value::String("reading".into()));
        meta.extra.insert("done".into(), toml::Value::Boolean(true));

        assert!(
            composed_candidate_matches(
                &base,
                &base.file.views[0],
                Some(&nested),
                &meta,
                "notes/typed.md",
                &derived(),
                fixed_today(),
            )
            .is_ok()
        );

        let shadowed = comparison("prop.kind", Op::Eq, serde_json::json!("genre"));
        let errors = composed_candidate_matches(
            &base,
            &base.file.views[0],
            Some(&shadowed),
            &meta,
            "notes/typed.md",
            &derived(),
            fixed_today(),
        )
        .unwrap_err();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].scope, BaseMemberScope::Embed);
        assert_eq!(errors[0].field.as_deref(), Some("prop.kind"));
        assert_eq!(errors[0].filter_path.as_deref(), Some("embed_filter"));
    }

    #[test]
    fn composed_candidate_has_query_parity_for_every_supported_property_operator_pair() {
        const TARGET_ID: &str = "0190f8a0-0000-7000-8000-0000000000aa";
        const TARGET_MIXED_ID: &str = "0190F8A0-0000-7000-8000-0000000000AA";
        const SOURCE: &str = r#"
name = "Parity"
[properties]
text_value = { type = "text" }
number_value = { type = "number" }
bool_value = { type = "bool" }
date_value = { type = "date" }
datetime_value = { type = "datetime" }
select_value = { type = "select" }
multi_value = { type = "multi_select" }
url_value = { type = "url" }
relation_value = { type = "relation" }
[[views]]
name = "All"
layout = "table"
"#;
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("bases")).unwrap();
        std::fs::write(temp.path().join("bases/parity.base.toml"), SOURCE).unwrap();
        std::fs::write(
            temp.path().join("a.md"),
            "+++\nid = \"0190f8a0-0000-7000-8000-000000000001\"\ntitle = \"Candidate\"\ntext_value = \"Alphabet\"\nnumber_value = 7\nbool_value = true\ndate_value = 2026-08-09\ndatetime_value = 2026-08-09T12:34:56Z\nselect_value = \"reading\"\nmulti_value = [\"memory\"]\nurl_value = \"https://example.test/path\"\nrelation_value = [\"[[Solar Cycle]]\", \"[[Science Fiction]]\"]\n+++\n",
        )
        .unwrap();
        std::fs::write(
            temp.path().join("solar-cycle.md"),
            format!(
                "+++\nid = \"{TARGET_ID}\"\ntitle = \"Solar Cycle\"\naliases = [\"Science Fiction\"]\n+++\n"
            ),
        )
        .unwrap();
        let vault = Vault::open(temp.path()).unwrap();
        let mut index = VaultIndex::open(&temp.path().join(".clepsydra/index.db")).unwrap();
        index.build(&vault).unwrap();
        index.resolve_links().unwrap();
        let base = base(SOURCE);
        let mut meta = PageMeta::new();
        meta.title = Some("Candidate".into());
        meta.extra
            .insert("text_value".into(), toml::Value::String("Alphabet".into()));
        meta.extra
            .insert("number_value".into(), toml::Value::Integer(7));
        meta.extra
            .insert("bool_value".into(), toml::Value::Boolean(true));
        meta.extra.insert(
            "date_value".into(),
            toml::Value::Datetime("2026-08-09".parse().unwrap()),
        );
        meta.extra.insert(
            "datetime_value".into(),
            toml::Value::Datetime("2026-08-09T12:34:56Z".parse().unwrap()),
        );
        meta.extra
            .insert("select_value".into(), toml::Value::String("reading".into()));
        meta.extra.insert(
            "multi_value".into(),
            toml::Value::Array(vec![toml::Value::String("memory".into())]),
        );
        meta.extra.insert(
            "url_value".into(),
            toml::Value::String("https://example.test/path".into()),
        );
        meta.extra.insert(
            "relation_value".into(),
            toml::Value::Array(vec![
                toml::Value::String("[[Solar Cycle]]".into()),
                toml::Value::String("[[Science Fiction]]".into()),
            ]),
        );
        let link_targets = candidate_link_targets(&base, &meta, |canonical| {
            index.resolve_link_target_id(canonical)
        })
        .unwrap();

        let properties = vec![
            (
                "text_value",
                serde_json::json!("Alphabet"),
                serde_json::json!("Other"),
            ),
            ("number_value", serde_json::json!(7), serde_json::json!(8)),
            (
                "bool_value",
                serde_json::json!(true),
                serde_json::json!(false),
            ),
            (
                "date_value",
                serde_json::json!("2026-08-09"),
                serde_json::json!("2026-08-10"),
            ),
            (
                "datetime_value",
                serde_json::json!("2026-08-09T12:34:56Z"),
                serde_json::json!("2026-08-10T12:34:56Z"),
            ),
            (
                "select_value",
                serde_json::json!("reading"),
                serde_json::json!("queued"),
            ),
            (
                "multi_value",
                serde_json::json!("memory"),
                serde_json::json!("identity"),
            ),
            (
                "url_value",
                serde_json::json!("https://example.test/path"),
                serde_json::json!("https://other.test"),
            ),
            (
                "relation_value",
                serde_json::json!("[[Solar Cycle]]"),
                serde_json::json!("[[Other]]"),
            ),
        ];
        let mut cases = Vec::new();
        for (field, current, other) in &properties {
            cases.push((
                format!("{field} eq"),
                comparison(field, Op::Eq, current.clone()),
                true,
            ));
            cases.push((
                format!("{field} ne"),
                comparison(field, Op::Ne, other.clone()),
                true,
            ));
            cases.push((
                format!("{field} in"),
                comparison(
                    field,
                    Op::In,
                    serde_json::json!([other.clone(), current.clone()]),
                ),
                true,
            ));
            cases.push((
                format!("{field} is_empty"),
                comparison(field, Op::IsEmpty, serde_json::Value::Null),
                false,
            ));
            cases.push((
                format!("{field} not_empty"),
                comparison(field, Op::NotEmpty, serde_json::Value::Null),
                true,
            ));
        }
        for (field, op, value) in [
            ("number_value", Op::Lt, serde_json::json!(8)),
            ("number_value", Op::Lte, serde_json::json!(7)),
            ("number_value", Op::Gt, serde_json::json!(6)),
            ("number_value", Op::Gte, serde_json::json!(7)),
            ("date_value", Op::Lt, serde_json::json!("2026-08-10")),
            ("date_value", Op::Lte, serde_json::json!("2026-08-09")),
            ("date_value", Op::Gt, serde_json::json!("2026-08-08")),
            ("date_value", Op::Gte, serde_json::json!("2026-08-09")),
            (
                "datetime_value",
                Op::Lt,
                serde_json::json!("2026-08-10T12:34:56Z"),
            ),
            (
                "datetime_value",
                Op::Lte,
                serde_json::json!("2026-08-09T12:34:56Z"),
            ),
            (
                "datetime_value",
                Op::Gt,
                serde_json::json!("2026-08-08T12:34:56Z"),
            ),
            (
                "datetime_value",
                Op::Gte,
                serde_json::json!("2026-08-09T12:34:56Z"),
            ),
        ] {
            cases.push((
                format!("{field} {op:?}"),
                comparison(field, op, value),
                true,
            ));
        }
        for (field, value) in [
            ("text_value", serde_json::json!("PHA")),
            ("date_value", serde_json::json!("2026-08")),
            ("datetime_value", serde_json::json!("12:34")),
            ("select_value", serde_json::json!("reading")),
            ("multi_value", serde_json::json!("memory")),
            ("url_value", serde_json::json!("EXAMPLE")),
            ("relation_value", serde_json::json!("[[Solar Cycle]]")),
        ] {
            cases.push((
                format!("{field} contains"),
                comparison(field, Op::Contains, value),
                true,
            ));
        }
        // Relative dates anchored on `fixed_today()` (Sunday 2026-08-09; the
        // candidate's `date_value` is that same day).
        for (op, expected) in [
            (Op::IsToday, true),
            (Op::IsThisWeek, true),
            (Op::IsPastWeek, true),
            (Op::IsNextWeek, false),
            (Op::IsThisMonth, true),
        ] {
            cases.push((
                format!("date_value {op:?}"),
                comparison("date_value", op, serde_json::Value::Null),
                expected,
            ));
        }
        for (field, op, value, expected) in [
            (
                "text_value",
                Op::NotContains,
                serde_json::json!("Alph"),
                false,
            ),
            (
                "text_value",
                Op::StartsWith,
                serde_json::json!("Alph"),
                true,
            ),
            ("text_value", Op::EndsWith, serde_json::json!("Alph"), false),
            (
                "select_value",
                Op::NotContains,
                serde_json::json!("reading"),
                false,
            ),
            (
                "select_value",
                Op::NotContains,
                serde_json::json!("queued"),
                true,
            ),
            (
                "multi_value",
                Op::NotContains,
                serde_json::json!("memory"),
                false,
            ),
            (
                "multi_value",
                Op::NotContains,
                serde_json::json!("identity"),
                true,
            ),
        ] {
            cases.push((
                format!("{field} {op:?} {value}"),
                comparison(field, op, value),
                expected,
            ));
        }
        for target in ["Solar Cycle", "Science Fiction", TARGET_ID, TARGET_MIXED_ID] {
            cases.push((
                format!("relation_value links_to {target}"),
                comparison("relation_value", Op::LinksTo, serde_json::json!(target)),
                true,
            ));
        }
        cases.push((
            "nested all/any/not".to_owned(),
            Filter::All(vec![
                Filter::Any(vec![
                    comparison("text_value", Op::Eq, serde_json::json!("Alphabet")),
                    comparison("text_value", Op::Eq, serde_json::json!("Other")),
                ]),
                Filter::Not(Box::new(comparison(
                    "bool_value",
                    Op::Eq,
                    serde_json::json!(false),
                ))),
            ]),
            true,
        ));
        assert_eq!(cases.len(), 81);

        for (label, filter, expected) in cases {
            validate_embed_overrides(
                &base,
                EmbedOverrides {
                    filter: Some(&filter),
                    sort: None,
                    limit: None,
                    group_by: None,
                },
            )
            .unwrap_or_else(|diagnostics| panic!("{label} should validate: {diagnostics:?}"));
            let output = evaluate(
                index.connection(),
                &QuerySpec {
                    filter: Some(filter.clone()),
                    ..Default::default()
                },
                &QueryContext::for_base(&base).with_today(fixed_today()),
            )
            .unwrap_or_else(|error| panic!("{label} query failed: {error}"));
            let query_matches = match output {
                QueryOutput::Flat { rows, .. } => rows.iter().any(|row| row.path == "a.md"),
                QueryOutput::Grouped { .. } => panic!("{label} unexpectedly grouped"),
            };
            let candidate_matches = composed_candidate_matches_with_link_targets(
                &base,
                &base.file.views[0],
                Some(&filter),
                &meta,
                "a.md",
                &derived(),
                &link_targets,
                fixed_today(),
            )
            .is_ok();

            assert_eq!(
                query_matches, expected,
                "unexpected query result for {label}"
            );
            assert_eq!(
                candidate_matches, query_matches,
                "candidate/query mismatch for {label}"
            );
        }
    }

    #[test]
    fn unsupported_embed_operator_type_pairs_fail_validation_before_matching() {
        let base = base(
            r#"
name = "Unsupported"
[properties]
text_value = { type = "text" }
number_value = { type = "number" }
bool_value = { type = "bool" }
date_value = { type = "date" }
datetime_value = { type = "datetime" }
select_value = { type = "select" }
multi_value = { type = "multi_select" }
url_value = { type = "url" }
relation_value = { type = "relation" }
[[views]]
name = "All"
layout = "table"
"#,
        );
        let mut filters = vec![
            comparison("number_value", Op::Contains, serde_json::json!(7)),
            comparison("bool_value", Op::Contains, serde_json::json!(true)),
        ];
        for field in [
            "text_value",
            "number_value",
            "bool_value",
            "date_value",
            "datetime_value",
            "select_value",
            "multi_value",
            "url_value",
        ] {
            filters.push(comparison(
                field,
                Op::LinksTo,
                serde_json::json!("Solar Cycle"),
            ));
        }
        for field in [
            "text_value",
            "bool_value",
            "select_value",
            "multi_value",
            "url_value",
            "relation_value",
        ] {
            for op in [Op::Lt, Op::Lte, Op::Gt, Op::Gte] {
                filters.push(comparison(field, op, serde_json::json!("value")));
            }
        }
        filters.push(comparison(
            "number_value",
            Op::NotContains,
            serde_json::json!(7),
        ));
        // Relative dates need a date field; affixes need a substring field.
        for field in [
            "text_value",
            "number_value",
            "bool_value",
            "select_value",
            "multi_value",
            "url_value",
            "relation_value",
        ] {
            for op in [
                Op::IsToday,
                Op::IsThisWeek,
                Op::IsPastWeek,
                Op::IsNextWeek,
                Op::IsThisMonth,
            ] {
                filters.push(comparison(field, op, serde_json::Value::Null));
            }
        }
        for field in [
            "number_value",
            "bool_value",
            "date_value",
            "datetime_value",
            "select_value",
            "multi_value",
            "relation_value",
        ] {
            for op in [Op::StartsWith, Op::EndsWith] {
                filters.push(comparison(field, op, serde_json::json!("value")));
            }
        }

        for filter in filters {
            let Filter::Cmp { field, op, .. } = &filter else {
                unreachable!()
            };
            let diagnostics = validate_embed_overrides(
                &base,
                EmbedOverrides {
                    filter: Some(&filter),
                    sort: None,
                    limit: None,
                    group_by: None,
                },
            )
            .expect_err("unsupported predicate must fail validation");
            assert_eq!(diagnostics.len(), 1, "{field} {op:?}: {diagnostics:?}");
            assert_eq!(diagnostics[0].field.as_deref(), Some(field.as_str()));
            assert_eq!(diagnostics[0].filter_path.as_deref(), Some("filter.op"));
        }
    }

    #[test]
    fn capability_orders_membership_and_view_fields_without_duplicates() {
        let base = base(
            r#"
name = "Reading"
[filter]
all = [
  { field = "kind", op = "eq", value = "BOOK" },
  { field = "status", op = "ne", value = "finished" }
]
[properties]
status = { type = "select", options = ["queued", "reading", "finished"] }
rating = { type = "number" }
[[views]]
name = "Unread"
layout = "table"
filter = { field = "status", op = "eq", value = "reading" }
columns = ["title", "rating"]
"#,
        );

        let capability = creation_capabilities(&base, fixed_today()).remove(0);
        assert!(capability.enabled);
        assert_eq!(
            capability.fields,
            vec![
                BaseMemberFieldRequirement {
                    field: "kind".into(),
                    membership: true,
                    view: false,
                    embed: false,
                    implied: Some(BaseMemberImplication::Fixed {
                        value: serde_json::json!("BOOK"),
                    }),
                },
                BaseMemberFieldRequirement {
                    field: "status".into(),
                    membership: true,
                    view: true,
                    embed: false,
                    implied: Some(BaseMemberImplication::Fixed {
                        value: serde_json::json!("reading"),
                    }),
                },
            ]
        );
    }

    #[test]
    fn membership_equality_implies_a_fixed_value() {
        let base = base(
            r#"
name = "Reading"
[filter]
all = [
  { field = "kind", op = "eq", value = "BOOK" },
  { field = "tags", op = "contains", value = "reading" }
]
[[views]]
name = "All"
layout = "table"
"#,
        );

        let capability = creation_capabilities(&base, fixed_today()).remove(0);
        let implied: Vec<_> = capability
            .fields
            .iter()
            .map(|field| (field.field.as_str(), field.implied.clone()))
            .collect();
        assert_eq!(
            implied,
            vec![
                (
                    "kind",
                    Some(BaseMemberImplication::Fixed {
                        value: serde_json::json!("BOOK")
                    })
                ),
                (
                    "tags",
                    Some(BaseMemberImplication::Fixed {
                        value: serde_json::json!("reading")
                    })
                ),
            ]
        );
    }

    #[test]
    fn an_in_predicate_implies_a_choice() {
        let base = base(
            r#"
name = "Queue"
filter = { field = "status", op = "in", value = ["queued", "reading"] }
[properties]
status = { type = "select", options = ["queued", "reading", "finished"] }
[[views]]
name = "All"
layout = "table"
"#,
        );

        let capability = creation_capabilities(&base, fixed_today()).remove(0);
        assert_eq!(
            capability.fields[0].implied,
            Some(BaseMemberImplication::Choice {
                values: vec![serde_json::json!("queued"), serde_json::json!("reading")],
            })
        );
    }

    #[test]
    fn an_any_group_over_one_field_implies_a_choice() {
        let base = base(
            r#"
name = "Either"
[filter]
any = [
  { field = "kind", op = "eq", value = "BOOK" },
  { field = "kind", op = "eq", value = "QUOTE" }
]
[[views]]
name = "All"
layout = "table"
"#,
        );

        let capability = creation_capabilities(&base, fixed_today()).remove(0);
        assert_eq!(
            capability.fields[0].implied,
            Some(BaseMemberImplication::Choice {
                values: vec![serde_json::json!("BOOK"), serde_json::json!("QUOTE")],
            })
        );
    }

    #[test]
    fn a_view_predicate_implies_its_own_value() {
        let base = base(
            r#"
name = "Reading"
filter = { field = "kind", op = "eq", value = "BOOK" }
[properties]
status = { type = "select", options = ["queued", "reading"] }
[[views]]
name = "Unread"
layout = "table"
filter = { field = "status", op = "eq", value = "reading" }
"#,
        );

        let capability = creation_capabilities(&base, fixed_today()).remove(0);
        let status = capability
            .fields
            .iter()
            .find(|field| field.field == "status")
            .expect("status requirement");
        assert_eq!(
            status.implied,
            Some(BaseMemberImplication::Fixed {
                value: serde_json::json!("reading")
            })
        );
    }

    #[test]
    fn predicates_without_a_forced_value_imply_nothing() {
        let base = base(
            r#"
name = "Loose"
[filter]
all = [
  { field = "word_count", op = "gte", value = 1 },
  { field = "project", op = "not_empty" },
  { not = { field = "kind", op = "eq", value = "QUOTE" } }
]
[[views]]
name = "All"
layout = "table"
"#,
        );

        let capability = creation_capabilities(&base, fixed_today()).remove(0);
        assert!(
            capability
                .fields
                .iter()
                .all(|field| field.implied.is_none()),
            "no predicate here forces a value: {:?}",
            capability.fields
        );
    }

    #[test]
    fn conflicting_implications_for_one_field_force_nothing() {
        let base = base(
            r#"
name = "Impossible"
[filter]
all = [
  { field = "kind", op = "eq", value = "BOOK" },
  { field = "kind", op = "eq", value = "QUOTE" }
]
[[views]]
name = "All"
layout = "table"
"#,
        );

        let capability = creation_capabilities(&base, fixed_today()).remove(0);
        assert_eq!(
            capability.fields[0].implied, None,
            "a contradiction must not prefill either value"
        );
    }

    #[test]
    fn positive_word_count_disables_blank_member_creation() {
        let base = base(
            r#"
name = "Longform"
filter = { field = "word_count", op = "gt", value = 0 }
[[views]]
name = "All"
layout = "table"
"#,
        );
        let capability = creation_capabilities(&base, fixed_today()).remove(0);
        assert!(!capability.enabled);
        assert_eq!(capability.blockers[0].field.as_deref(), Some("word_count"));
        assert_eq!(
            capability.blockers[0].filter_path.as_deref(),
            Some("filter")
        );
    }

    #[test]
    fn candidate_must_match_membership_and_view() {
        let base = base(READING_SOURCE);
        let view = &base.file.views[0];
        let mut meta = PageMeta::new();
        meta.title = Some("New Book".into());
        meta.kind = Some(Kind::Book);
        meta.extra
            .insert("status".into(), toml::Value::String("queued".into()));

        let errors = candidate_matches(
            &base,
            view,
            &meta,
            "books/20260809.new-book.Ab3xYz90.md",
            &CandidateDerived {
                word_count: 0,
                journal_date: None,
            },
            fixed_today(),
        )
        .unwrap_err();

        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].scope, BaseMemberScope::View);
        assert_eq!(errors[0].field.as_deref(), Some("status"));
    }
    #[test]
    fn candidate_matches_fixed_zero_word_count() {
        let base = base(
            r#"
name = "Blank"
filter = { field = "word_count", op = "eq", value = 0 }
[[views]]
name = "All"
layout = "table"
"#,
        );
        let view = &base.file.views[0];

        assert!(
            candidate_matches(
                &base,
                view,
                &PageMeta::new(),
                "notes/20260809.blank.Ab3xYz90.md",
                &CandidateDerived {
                    word_count: 0,
                    journal_date: None,
                },
                fixed_today(),
            )
            .is_ok()
        );
    }

    #[test]
    fn capability_and_candidate_match_for_every_fixed_derived_operator() {
        let cases = [
            ("word_count", "eq", ", value = 0", true),
            ("word_count", "ne", ", value = 1", true),
            ("word_count", "lt", ", value = 1", true),
            ("word_count", "lte", ", value = 0", true),
            ("word_count", "gt", ", value = -1", true),
            ("word_count", "gte", ", value = 0", true),
            ("word_count", "contains", ", value = \"0\"", false),
            ("word_count", "in", ", value = [0, 1]", true),
            ("word_count", "links_to", ", value = \"0\"", false),
            ("word_count", "is_empty", "", false),
            ("word_count", "not_empty", "", true),
            ("journal_date", "eq", ", value = \"2026-08-09\"", false),
            ("journal_date", "ne", ", value = \"2026-08-09\"", true),
            ("journal_date", "lt", ", value = \"2026-08-09\"", false),
            ("journal_date", "lte", ", value = \"2026-08-09\"", false),
            ("journal_date", "gt", ", value = \"2026-08-09\"", false),
            ("journal_date", "gte", ", value = \"2026-08-09\"", false),
            ("journal_date", "contains", ", value = \"2026\"", false),
            ("journal_date", "in", ", value = [\"2026-08-09\"]", false),
            (
                "journal_date",
                "links_to",
                ", value = \"2026-08-09\"",
                false,
            ),
            ("journal_date", "is_empty", "", true),
            ("journal_date", "not_empty", "", false),
        ];

        for (field, op, value, expected) in cases {
            let source = format!(
                r#"
name = "Fixed"
filter = {{ field = "{field}", op = "{op}"{value} }}
[[views]]
name = "All"
layout = "table"
"#
            );
            let base = base(&source);
            let view = &base.file.views[0];
            let capability = creation_capabilities(&base, fixed_today()).remove(0);
            let candidate = candidate_matches(
                &base,
                view,
                &PageMeta::new(),
                "notes/20260809.fixed.Ab3xYz90.md",
                &CandidateDerived {
                    word_count: 0,
                    journal_date: None,
                },
                fixed_today(),
            );

            assert_eq!(
                capability.enabled, expected,
                "unexpected capability for {field} {op}"
            );
            assert_eq!(
                candidate.is_ok(),
                expected,
                "unexpected candidate result for {field} {op}"
            );
        }
    }

    #[test]
    fn relative_dates_on_creation_timestamps_are_decided_not_deferred() {
        // A blank member is stamped "now", so `created_at`/`updated_at`
        // relative-date predicates settle before anything is written.
        let cases = [
            ("created_at", "is_today", true),
            ("created_at", "is_this_week", true),
            ("created_at", "is_past_week", true),
            ("created_at", "is_next_week", false),
            ("created_at", "is_this_month", true),
            ("updated_at", "is_today", true),
            ("updated_at", "is_next_week", false),
            // A blank member has no journal date at all.
            ("journal_date", "is_today", false),
        ];
        let mut meta = PageMeta::new();
        let stamp = fixed_today().and_hms_opt(12, 34, 56).unwrap().and_utc();
        meta.created_at = Some(stamp);
        meta.updated_at = Some(stamp);

        for (field, op, expected) in cases {
            let source = format!(
                r#"
name = "Fresh"
filter = {{ field = "{field}", op = "{op}" }}
[[views]]
name = "All"
layout = "table"
"#
            );
            let base = base(&source);
            let capability = creation_capabilities(&base, fixed_today()).remove(0);
            let candidate = candidate_matches(
                &base,
                &base.file.views[0],
                &meta,
                "notes/20260809.fresh.Ab3xYz90.md",
                &CandidateDerived {
                    word_count: 0,
                    journal_date: None,
                },
                fixed_today(),
            );

            assert_eq!(
                capability.enabled, expected,
                "unexpected capability for {field} {op}"
            );
            assert_eq!(
                candidate.is_ok(),
                expected,
                "unexpected candidate result for {field} {op}"
            );
        }
    }

    #[test]
    fn explicit_derived_property_names_remain_user_properties() {
        let base = base(
            r#"
name = "Properties"
[properties]
word_count = { type = "number" }
journal_date = { type = "text" }
[filter]
all = [
  { field = "prop.word_count", op = "eq", value = 7 },
  { field = "prop.journal_date", op = "eq", value = "manual" }
]
[[views]]
name = "All"
layout = "table"
"#,
        );
        let view = &base.file.views[0];
        let capability = creation_capabilities(&base, fixed_today()).remove(0);
        let mut meta = PageMeta::new();
        meta.extra
            .insert("word_count".into(), toml::Value::Integer(7));
        meta.extra
            .insert("journal_date".into(), toml::Value::String("manual".into()));

        assert!(capability.enabled);
        assert!(
            candidate_matches(
                &base,
                view,
                &meta,
                "notes/20260809.properties.Ab3xYz90.md",
                &CandidateDerived {
                    word_count: 0,
                    journal_date: None,
                },
                fixed_today(),
            )
            .is_ok()
        );
    }

    #[test]
    fn capability_fields_preserve_resolved_request_keys() {
        let base = base(
            r#"
name = "Resolved fields"
[properties]
kind = { type = "text" }
word_count = { type = "number" }
journal_date = { type = "date" }
status = { type = "select", options = ["reading"] }
[filter]
all = [
  { field = "kind", op = "eq", value = "BOOK" },
  { field = "sys.kind", op = "eq", value = "BOOK" },
  { field = "prop.kind", op = "eq", value = "genre" },
  { field = "word_count", op = "eq", value = 0 },
  { field = "prop.word_count", op = "eq", value = 7 },
  { field = "prop.journal_date", op = "is_empty" },
  { field = "status", op = "eq", value = "reading" },
  { field = "prop.status", op = "eq", value = "reading" }
]
[[views]]
name = "All"
layout = "table"
"#,
        );

        let fields = creation_capabilities(&base, fixed_today()).remove(0).fields;
        assert_eq!(
            fields
                .iter()
                .map(|requirement| requirement.field.as_str())
                .collect::<Vec<_>>(),
            vec![
                "kind",
                "prop.kind",
                "word_count",
                "prop.word_count",
                "prop.journal_date",
                "status",
            ]
        );
    }

    #[test]
    fn undeclared_properties_are_fixed_absent_for_capability_analysis() {
        let cases = [
            ("is_empty", "", true),
            ("ne", ", value = \"value\"", true),
            ("not_empty", "", false),
            ("eq", ", value = \"value\"", false),
            ("contains", ", value = \"value\"", false),
            ("gt", ", value = \"value\"", false),
            ("in", ", value = [\"value\"]", false),
            ("links_to", ", value = \"value\"", false),
        ];

        for (op, value, expected) in cases {
            let base = base(&format!(
                r#"
name = "Absent property"
filter = {{ field = "missing", op = "{op}"{value} }}
[[views]]
name = "All"
layout = "table"
"#
            ));
            let capability = creation_capabilities(&base, fixed_today()).remove(0);

            assert_eq!(
                capability.enabled, expected,
                "unexpected capability for undeclared property op {op}"
            );
            if expected {
                assert!(capability.blockers.is_empty());
            } else {
                assert_eq!(capability.blockers.len(), 1);
                assert_eq!(capability.blockers[0].field.as_deref(), Some("missing"));
                assert_eq!(
                    capability.blockers[0].filter_path.as_deref(),
                    Some("filter")
                );
            }
        }
    }

    #[test]
    fn candidate_property_contains_matches_query_type_semantics() {
        let cases = [
            ("text", toml::Value::String("Alphabet".into()), "PHA", true),
            (
                "select",
                toml::Value::String("reading".into()),
                "read",
                false,
            ),
            (
                "select",
                toml::Value::String("reading".into()),
                "reading",
                true,
            ),
            (
                "multi_select",
                toml::Value::Array(vec![toml::Value::String("memory".into())]),
                "mem",
                false,
            ),
            (
                "multi_select",
                toml::Value::Array(vec![toml::Value::String("memory".into())]),
                "memory",
                true,
            ),
            (
                "relation",
                toml::Value::String("[[Solar Cycle]]".into()),
                "Solar",
                false,
            ),
            (
                "relation",
                toml::Value::String("[[Solar Cycle]]".into()),
                "[[Solar Cycle]]",
                true,
            ),
        ];

        for (property_type, current, expected_value, expected) in cases {
            let base = base(&format!(
                r#"
name = "Typed contains"
filter = {{ field = "value", op = "contains", value = "{expected_value}" }}
[properties]
value = {{ type = "{property_type}" }}
[[views]]
name = "All"
layout = "table"
"#
            ));
            let mut meta = PageMeta::new();
            meta.extra.insert("value".into(), current);
            let result = candidate_matches(
                &base,
                &base.file.views[0],
                &meta,
                "notes/20260809.typed.Ab3xYz90.md",
                &CandidateDerived {
                    word_count: 0,
                    journal_date: None,
                },
                fixed_today(),
            );

            assert_eq!(
                result.is_ok(),
                expected,
                "unexpected contains result for {property_type}"
            );
        }
    }

    #[test]
    fn candidate_alias_membership_uses_canonical_names() {
        let cases = [
            ("eq", ", value = \"science fiction\"", true),
            ("contains", ", value = \"SCIENCE FICTION\"", true),
            ("in", ", value = [\"Science Fiction\"]", true),
            ("ne", ", value = \"science fiction\"", false),
        ];

        for (op, value, expected) in cases {
            let base = base(&format!(
                r#"
name = "Aliases"
filter = {{ field = "aliases", op = "{op}"{value} }}
[[views]]
name = "All"
layout = "table"
"#
            ));
            let mut meta = PageMeta::new();
            meta.aliases.push("Science Fiction".into());
            let result = candidate_matches(
                &base,
                &base.file.views[0],
                &meta,
                "notes/20260809.aliases.Ab3xYz90.md",
                &CandidateDerived {
                    word_count: 0,
                    journal_date: None,
                },
                fixed_today(),
            );

            assert_eq!(result.is_ok(), expected, "unexpected alias result for {op}");
        }
    }

    #[test]
    fn candidate_contains_rejects_non_text_scalars_and_supports_dates() {
        let cases = [
            ("number", ", value = 7", toml::Value::Integer(7), false),
            ("number", ", value = 1.5", toml::Value::Float(1.5), false),
            ("bool", ", value = true", toml::Value::Boolean(true), false),
            (
                "date",
                ", value = \"2026-08\"",
                toml::Value::Datetime("2026-08-09".parse().unwrap()),
                true,
            ),
            (
                "datetime",
                ", value = \"12:34\"",
                toml::Value::Datetime("2026-08-09T12:34:56Z".parse().unwrap()),
                true,
            ),
        ];

        for (property_type, value, current, expected) in cases {
            let base = base(&format!(
                r#"
name = "Scalar contains"
filter = {{ field = "value", op = "contains"{value} }}
[properties]
value = {{ type = "{property_type}" }}
[[views]]
name = "All"
layout = "table"
"#
            ));
            let mut meta = PageMeta::new();
            meta.extra.insert("value".into(), current);
            assert_eq!(
                creation_capabilities(&base, fixed_today())
                    .remove(0)
                    .enabled,
                expected,
                "unexpected capability for {property_type} contains"
            );

            assert_eq!(
                candidate_matches(
                    &base,
                    &base.file.views[0],
                    &meta,
                    "notes/20260809.scalar.Ab3xYz90.md",
                    &CandidateDerived {
                        word_count: 0,
                        journal_date: None,
                    },
                    fixed_today(),
                )
                .is_ok(),
                expected,
                "unexpected contains result for {property_type}"
            );
        }

        let base = base(
            r#"
name = "Derived contains"
filter = { field = "word_count", op = "contains", value = 0 }
[[views]]
name = "All"
layout = "table"
"#,
        );
        assert!(
            !creation_capabilities(&base, fixed_today())
                .remove(0)
                .enabled
        );
        assert!(
            candidate_matches(
                &base,
                &base.file.views[0],
                &PageMeta::new(),
                "notes/20260809.derived.Ab3xYz90.md",
                &CandidateDerived {
                    word_count: 0,
                    journal_date: None,
                },
                fixed_today(),
            )
            .is_err()
        );
    }

    #[test]
    fn candidate_diagnostics_use_resolved_request_keys() {
        let kind_base = base(
            r#"
name = "Diagnostic keys"
filter = { field = "kind", op = "eq", value = "BOOK" }
[properties]
kind = { type = "text" }
[[views]]
name = "Property"
layout = "table"
filter = { field = "prop.kind", op = "eq", value = "genre" }
"#,
        );
        let mut meta = PageMeta::new();
        meta.kind = Some(Kind::Note);
        meta.extra
            .insert("kind".into(), toml::Value::String("wrong".into()));

        let errors = candidate_matches(
            &kind_base,
            &kind_base.file.views[0],
            &meta,
            "notes/20260809.keys.Ab3xYz90.md",
            &CandidateDerived {
                word_count: 0,
                journal_date: None,
            },
            fixed_today(),
        )
        .unwrap_err();

        assert_eq!(
            errors
                .iter()
                .map(|diagnostic| diagnostic.field.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("kind"), Some("prop.kind")]
        );

        let word_count_base = base(
            r#"
name = "Derived property diagnostic"
filter = { field = "prop.word_count", op = "eq", value = 7 }
[properties]
word_count = { type = "number" }
[[views]]
name = "All"
layout = "table"
"#,
        );
        let mut meta = PageMeta::new();
        meta.extra
            .insert("word_count".into(), toml::Value::Integer(8));
        let errors = candidate_matches(
            &word_count_base,
            &word_count_base.file.views[0],
            &meta,
            "notes/20260809.word-count.Ab3xYz90.md",
            &CandidateDerived {
                word_count: 0,
                journal_date: None,
            },
            fixed_today(),
        )
        .unwrap_err();
        assert_eq!(errors[0].field.as_deref(), Some("prop.word_count"));
    }

    #[test]
    fn capability_blockers_preserve_fixed_field_request_identity() {
        let base = base(
            r#"
name = "Blocker keys"
[filter]
all = [
  { field = "word_count", op = "gt", value = 0 },
  { field = "prop.word_count", op = "eq", value = 7 }
]
[[views]]
name = "All"
layout = "table"
"#,
        );

        let capability = creation_capabilities(&base, fixed_today()).remove(0);
        assert!(!capability.enabled);
        assert_eq!(
            capability
                .blockers
                .iter()
                .map(|diagnostic| {
                    (
                        diagnostic.field.as_deref(),
                        diagnostic.filter_path.as_deref(),
                    )
                })
                .collect::<Vec<_>>(),
            vec![
                (Some("word_count"), Some("filter.all[0]")),
                (Some("prop.word_count"), Some("filter.all[1]")),
            ]
        );
    }

    #[test]
    fn text_properties_cannot_satisfy_links_to_or_enable_creation() {
        let base = base(
            r#"
name = "Text links"
filter = { field = "author", op = "links_to", value = "Wolfe" }
[properties]
author = { type = "text" }
[[views]]
name = "All"
layout = "table"
"#,
        );
        let mut meta = PageMeta::new();
        meta.extra
            .insert("author".into(), toml::Value::String("Wolfe".into()));

        assert!(
            !creation_capabilities(&base, fixed_today())
                .remove(0)
                .enabled
        );
        assert!(
            candidate_matches(
                &base,
                &base.file.views[0],
                &meta,
                "notes/20260809.text-link.Ab3xYz90.md",
                &CandidateDerived {
                    word_count: 0,
                    journal_date: None,
                },
                fixed_today(),
            )
            .is_err()
        );
    }

    #[test]
    fn relation_links_to_requires_a_string_target_for_creation() {
        let base = base(
            r#"
name = "Invalid relation target"
filter = { field = "series", op = "links_to", value = 42 }
[properties]
series = { type = "relation" }
[[views]]
name = "All"
layout = "table"
"#,
        );

        assert!(
            !creation_capabilities(&base, fixed_today())
                .remove(0)
                .enabled
        );
    }
}
