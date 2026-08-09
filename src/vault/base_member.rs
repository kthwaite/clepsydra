use crate::vault::base::{
    BaseDefinition, Filter, MetaFilterContext, Op, ViewDefinition, derived_comparison_matches,
    filter_matches_meta,
};
use crate::vault::page::PageMeta;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum BaseMemberScope {
    Membership,
    View,
    Field,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct BaseMemberFieldRequirement {
    pub field: String,
    pub membership: bool,
    pub view: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct BaseMemberDiagnostic {
    pub scope: BaseMemberScope,
    pub field: Option<String>,
    pub filter_path: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
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
) -> Result<(), Vec<BaseMemberDiagnostic>> {
    let context = MetaFilterContext {
        meta,
        path,
        word_count: Some(derived.word_count),
        journal_date: derived.journal_date,
    };
    let mut diagnostics = Vec::new();

    if let Some(filter) = &base.file.filter
        && !filter_matches_meta(filter, &context)
    {
        diagnostics.push(candidate_diagnostic(
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
            BaseMemberScope::View,
            filter,
            &format!("views.{}.filter", view.name),
            "candidate does not match the selected view filter",
        ));
    }

    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(diagnostics)
    }
}

pub fn creation_capabilities(base: &BaseDefinition) -> Vec<BaseMemberCapability> {
    base.file
        .views
        .iter()
        .map(|view| {
            let mut fields = Vec::new();
            let membership = base
                .file
                .filter
                .as_ref()
                .map_or(Possibility::AlwaysTrue, filter_possibility);
            let view_possibility = view
                .filter
                .as_ref()
                .map_or(Possibility::AlwaysTrue, filter_possibility);

            if let Some(filter) = &base.file.filter {
                collect_fields(filter, true, false, &mut fields);
            }
            if let Some(filter) = &view.filter {
                collect_fields(filter, false, true, &mut fields);
            }

            let enabled =
                all([membership, view_possibility].into_iter()) != Possibility::AlwaysFalse;
            let mut blockers = Vec::new();
            if !enabled {
                if membership == Possibility::AlwaysFalse {
                    collect_contributors(
                        base.file
                            .filter
                            .as_ref()
                            .expect("analysed membership filter"),
                        "filter",
                        Possibility::AlwaysFalse,
                        BaseMemberScope::Membership,
                        &mut blockers,
                    );
                }
                if view_possibility == Possibility::AlwaysFalse {
                    collect_contributors(
                        view.filter.as_ref().expect("analysed view filter"),
                        &format!("views.{}.filter", view.name),
                        Possibility::AlwaysFalse,
                        BaseMemberScope::View,
                        &mut blockers,
                    );
                }
            }

            BaseMemberCapability {
                view: view.name.clone(),
                enabled,
                fields,
                blockers,
            }
        })
        .collect()
}

fn collect_fields(
    filter: &Filter,
    membership: bool,
    view: bool,
    fields: &mut Vec<BaseMemberFieldRequirement>,
) {
    match filter {
        Filter::All(children) | Filter::Any(children) => {
            for child in children {
                collect_fields(child, membership, view, fields);
            }
        }
        Filter::Not(child) => collect_fields(child, membership, view, fields),
        Filter::Cmp { field, .. } => {
            let bare = bare_field(field);
            if let Some(existing) = fields.iter_mut().find(|item| item.field == bare) {
                existing.membership |= membership;
                existing.view |= view;
            } else {
                fields.push(BaseMemberFieldRequirement {
                    field: bare.to_owned(),
                    membership,
                    view,
                });
            }
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
    scope: BaseMemberScope,
    filter: &Filter,
    root: &str,
    message: &str,
) -> BaseMemberDiagnostic {
    let field = match filter {
        Filter::Cmp { field, .. } => Some(bare_field(field).to_owned()),
        _ => None,
    };
    BaseMemberDiagnostic {
        scope,
        field,
        filter_path: Some(root.to_owned()),
        message: message.to_owned(),
    }
}

fn filter_possibility(filter: &Filter) -> Possibility {
    match filter {
        Filter::All(children) => all(children.iter().map(filter_possibility)),
        Filter::Any(children) => any(children.iter().map(filter_possibility)),
        Filter::Not(child) => match filter_possibility(child) {
            Possibility::AlwaysTrue => Possibility::AlwaysFalse,
            Possibility::Maybe => Possibility::Maybe,
            Possibility::AlwaysFalse => Possibility::AlwaysTrue,
        },
        Filter::Cmp { field, op, value } => comparison_possibility(field, *op, value),
    }
}

fn comparison_possibility(field: &str, op: Op, value: &serde_json::Value) -> Possibility {
    match derived_comparison_matches(field, op, value, Some(0), None) {
        Some(true) => Possibility::AlwaysTrue,
        Some(false) => Possibility::AlwaysFalse,
        None => Possibility::Maybe,
    }
}

fn collect_contributors(
    filter: &Filter,
    path: &str,
    desired: Possibility,
    scope: BaseMemberScope,
    blockers: &mut Vec<BaseMemberDiagnostic>,
) {
    match filter {
        Filter::All(children) => {
            for (index, child) in children.iter().enumerate() {
                if filter_possibility(child) == desired {
                    collect_contributors(
                        child,
                        &format!("{path}.all[{index}]"),
                        desired,
                        scope,
                        blockers,
                    );
                }
            }
        }
        Filter::Any(children) => {
            for (index, child) in children.iter().enumerate() {
                if filter_possibility(child) == desired {
                    collect_contributors(
                        child,
                        &format!("{path}.any[{index}]"),
                        desired,
                        scope,
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
            collect_contributors(child, &format!("{path}.not"), opposite, scope, blockers);
        }
        Filter::Cmp { field, .. } => {
            if filter_possibility(filter) == desired {
                blockers.push(BaseMemberDiagnostic {
                    scope,
                    field: Some(bare_field(field).to_owned()),
                    filter_path: Some(path.to_owned()),
                    message: "fixed derived-field comparison prevents blank member creation"
                        .to_owned(),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::base::{BaseDefinition, parse_base};
    use crate::vault::kind::Kind;
    use crate::vault::page::PageMeta;
    use std::path::Path;

    fn base(source: &str) -> BaseDefinition {
        parse_base(Path::new("bases/reading.base.toml"), source)
            .0
            .expect("valid base")
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

        let capability = creation_capabilities(&base).remove(0);
        assert!(capability.enabled);
        assert_eq!(
            capability.fields,
            vec![
                BaseMemberFieldRequirement {
                    field: "kind".into(),
                    membership: true,
                    view: false,
                },
                BaseMemberFieldRequirement {
                    field: "status".into(),
                    membership: true,
                    view: true,
                },
            ]
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
        let capability = creation_capabilities(&base).remove(0);
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
            let capability = creation_capabilities(&base).remove(0);
            let candidate = candidate_matches(
                &base,
                view,
                &PageMeta::new(),
                "notes/20260809.fixed.Ab3xYz90.md",
                &CandidateDerived {
                    word_count: 0,
                    journal_date: None,
                },
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
        let capability = creation_capabilities(&base).remove(0);
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
            )
            .is_ok()
        );
    }
}
