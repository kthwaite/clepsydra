//! Pure diagnostic computation for document links.
use std::collections::HashMap;
use std::path::Path;

use tower_lsp::lsp_types::{
    Diagnostic, DiagnosticRelatedInformation, DiagnosticSeverity, Location, NumberOrString, Range,
    Url,
};

use crate::lsp::document::Document;

/// Compute LSP diagnostics for a document's links given a snapshot of the
/// canonical-name → paths map and the vault root. Pure: no I/O, no `self`.
pub fn compute_link_diagnostics(
    doc: &Document,
    canonical_names: &HashMap<String, Vec<String>>,
    vault_root: &Path,
) -> Vec<Diagnostic> {
    if doc.encrypted {
        let position = doc.byte_offset_to_position(0);
        return vec![Diagnostic {
            range: Range {
                start: position,
                end: position,
            },
            severity: Some(DiagnosticSeverity::INFORMATION),
            code: Some(NumberOrString::String("encrypted-body-unavailable".into())),
            source: Some("clepsydra".into()),
            message: "Encrypted note body is unavailable to the LSP".into(),
            ..Default::default()
        }];
    }

    let mut diagnostics = Vec::new();

    for link in &doc.links {
        if link.span.start == 0 && link.span.end == 0 {
            continue; // skip property ref links
        }
        let canonical = crate::vault::canonical::CanonicalName::from_title(&link.target_raw);
        let cn_str = canonical.as_str();

        match canonical_names.get(cn_str) {
            None => {
                // Unresolved link
                diagnostics.push(Diagnostic {
                    range: doc.link_to_range(link),
                    severity: Some(DiagnosticSeverity::WARNING),
                    code: Some(NumberOrString::String("unresolved-link".into())),
                    source: Some("clepsydra".into()),
                    message: format!("Unresolved link: \"{}\"", link.target_raw),
                    ..Default::default()
                });
            }
            Some(paths) if paths.len() > 1 => {
                // Ambiguous link — multiple pages share this canonical name
                let related: Vec<DiagnosticRelatedInformation> = paths
                    .iter()
                    .filter_map(|p| {
                        let vp = crate::vault::path::VaultPath::new(p).ok()?;
                        let abs = vault_root.join(vp.as_str());
                        let file_uri = Url::from_file_path(&abs).ok()?;
                        Some(DiagnosticRelatedInformation {
                            location: Location {
                                uri: file_uri,
                                range: Range::default(),
                            },
                            message: p.clone(),
                        })
                    })
                    .collect();

                diagnostics.push(Diagnostic {
                    range: doc.link_to_range(link),
                    severity: Some(DiagnosticSeverity::INFORMATION),
                    code: Some(NumberOrString::String("ambiguous-link".into())),
                    source: Some("clepsydra".into()),
                    message: format!(
                        "Ambiguous link: \"{}\" matches {} pages",
                        link.target_raw,
                        paths.len()
                    ),
                    related_information: if related.is_empty() {
                        None
                    } else {
                        Some(related)
                    },
                    ..Default::default()
                });
            }
            Some(_) => {
                // Single match — resolved, no diagnostic
            }
        }
    }

    diagnostics
}

// ---------------------------------------------------------------------------
// Frontmatter property diagnostics
// ---------------------------------------------------------------------------

use crate::vault::base::{BaseRegistry, PropertyType, base_matches_meta};

/// Type-check declared properties against a document's native TOML values,
/// per base whose filter matches the page. Native types make every finding a
/// hard fact about the file rather than a coercion opinion; severity is
/// warning, never error, and nothing here blocks indexing.
///
/// Legacy `---` pages get no property diagnostics.
pub fn compute_property_diagnostics(
    doc: &Document,
    registry: &BaseRegistry,
    path: &str,
    canonical_names: &HashMap<String, Vec<String>>,
) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    if doc.rope.len_bytes() < 3 || doc.rope.byte_slice(0..3) != "+++" {
        return diagnostics;
    }

    for base in &registry.bases {
        if !base_matches_meta(base, &doc.meta, path) {
            continue;
        }
        for (key, def) in &base.file.properties {
            let Some(value) = doc.meta.extra.get(key) else {
                continue;
            };
            let Some(range) = key_line_range(doc, key) else {
                continue;
            };
            let warn = |code: &str, message: String| Diagnostic {
                range,
                severity: Some(DiagnosticSeverity::WARNING),
                code: Some(NumberOrString::String(code.into())),
                source: Some("clepsydra".into()),
                message,
                ..Default::default()
            };

            let elements: Vec<&toml::Value> = match value {
                toml::Value::Array(items) => items.iter().collect(),
                other => vec![other],
            };

            match def.property_type {
                PropertyType::Number => {
                    for el in &elements {
                        if !matches!(el, toml::Value::Integer(_) | toml::Value::Float(_)) {
                            diagnostics.push(warn(
                                "property-type",
                                format!(
                                    "`{key}` is a {} but base `{}` declares number",
                                    toml_type_name(el),
                                    base.slug
                                ),
                            ));
                            break;
                        }
                    }
                }
                PropertyType::Date | PropertyType::Datetime => {
                    for el in &elements {
                        if !matches!(el, toml::Value::Datetime(_)) {
                            diagnostics.push(warn(
                                "property-type",
                                format!(
                                    "`{key}` is a {} but base `{}` declares {} — write it unquoted",
                                    toml_type_name(el),
                                    base.slug,
                                    if def.property_type == PropertyType::Date {
                                        "date"
                                    } else {
                                        "datetime"
                                    },
                                ),
                            ));
                            break;
                        }
                    }
                }
                PropertyType::Bool => {
                    for el in &elements {
                        if !matches!(el, toml::Value::Boolean(_)) {
                            diagnostics.push(warn(
                                "property-type",
                                format!(
                                    "`{key}` is a {} but base `{}` declares bool",
                                    toml_type_name(el),
                                    base.slug
                                ),
                            ));
                            break;
                        }
                    }
                }
                PropertyType::Select | PropertyType::MultiSelect => {
                    // Empty options = open vocabulary: novel values are fine.
                    if !def.options.is_empty() {
                        for el in &elements {
                            if let toml::Value::String(s) = el
                                && !def.options.iter().any(|o| o == s)
                            {
                                diagnostics.push(warn(
                                    "select-violation",
                                    format!(
                                        "`{s}` is not an option of `{key}` in base `{}` ({})",
                                        base.slug,
                                        def.options.join(", ")
                                    ),
                                ));
                                break;
                            }
                        }
                    }
                }
                PropertyType::Relation => {
                    if def.many == Some(false) && elements.len() > 1 {
                        diagnostics.push(warn(
                            "relation-many",
                            format!(
                                "`{key}` carries {} values but base `{}` advises a single relation",
                                elements.len(),
                                base.slug
                            ),
                        ));
                    }
                    for el in &elements {
                        let toml::Value::String(raw) = el else {
                            continue;
                        };
                        let target = raw
                            .trim()
                            .strip_prefix("[[")
                            .and_then(|s| s.strip_suffix("]]"))
                            .map(|inner| inner.split_once('|').map(|(t, _)| t).unwrap_or(inner))
                            .unwrap_or(raw.trim());
                        let canonical = crate::vault::canonical::CanonicalName::from_title(target);
                        if !canonical_names.contains_key(canonical.as_str()) {
                            // Same shape as body-link diagnostics.
                            diagnostics.push(warn(
                                "unresolved-link",
                                format!("Unresolved link: \"{target}\""),
                            ));
                        }
                    }
                }
                PropertyType::Text | PropertyType::Url => {}
            }
        }
    }

    diagnostics
}

fn toml_type_name(value: &toml::Value) -> &'static str {
    match value {
        toml::Value::String(_) => "string",
        toml::Value::Integer(_) => "integer",
        toml::Value::Float(_) => "float",
        toml::Value::Boolean(_) => "boolean",
        toml::Value::Datetime(_) => "date-time",
        toml::Value::Array(_) => "array",
        toml::Value::Table(_) => "table",
    }
}

/// Absolute range of the `key = …` line inside the frontmatter fences.
fn key_line_range(doc: &Document, key: &str) -> Option<Range> {
    use tower_lsp::lsp_types::Position;
    for (idx, line) in doc.rope.lines().enumerate().skip(1) {
        let text = line.to_string();
        let trimmed = text.trim_end();
        if trimmed == "+++" {
            break; // closing fence
        }
        if let Some(rest) = trimmed.strip_prefix(key)
            && rest.trim_start().starts_with('=')
        {
            return Some(Range {
                start: Position {
                    line: idx as u32,
                    character: 0,
                },
                end: Position {
                    line: idx as u32,
                    character: trimmed.len() as u32,
                },
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::document::Document;

    #[test]
    fn unresolved_link_yields_a_diagnostic() {
        let doc = Document::from_text("# A\n\n[[Ghost]]\n", 1);
        let names: HashMap<String, Vec<String>> = HashMap::new();
        let diags = compute_link_diagnostics(&doc, &names, Path::new("/v"));
        assert_eq!(diags.len(), 1);
        assert_eq!(
            diags[0].code,
            Some(NumberOrString::String("unresolved-link".into()))
        );
        assert_eq!(diags[0].severity, Some(DiagnosticSeverity::WARNING));
    }

    #[test]
    fn resolved_link_yields_no_diagnostic() {
        let doc = Document::from_text("# A\n\n[[Target]]\n", 1);
        let mut names = HashMap::new();
        names.insert("target".to_string(), vec!["Target.md".to_string()]);
        let diags = compute_link_diagnostics(&doc, &names, Path::new("/v"));
        assert!(diags.is_empty());
    }

    fn registry_with(base_toml: &str) -> BaseRegistry {
        let (base, _) = crate::vault::base::parse_base(
            std::path::Path::new("bases/reading.base.toml"),
            base_toml,
        );
        BaseRegistry {
            bases: vec![base.unwrap()],
            diagnostics: Vec::new(),
        }
    }

    const TYPED_BASE: &str = "name = \"Reading\"\n\n[filter]\nfield = \"kind\"\nop = \"eq\"\nvalue = \"BOOK\"\n\n[properties]\nrating = { type = \"number\" }\nstarted = { type = \"date\" }\nthemes = { type = \"multi_select\", options = [] }\nstatus = { type = \"select\", options = [\"queued\", \"reading\"] }\nseries = { type = \"relation\" }\n";

    fn prop_diags(text: &str, names: &HashMap<String, Vec<String>>) -> Vec<Diagnostic> {
        let doc = Document::from_text(text, 1);
        let registry = registry_with(TYPED_BASE);
        compute_property_diagnostics(&doc, &registry, "book.md", names)
    }

    #[test]
    fn string_where_number_warns_with_base_and_type() {
        let text = "+++\nid = \"0190f8a0-0000-7000-8000-000000000081\"\ntype = \"BOOK\"\nrating = \"4\"\n+++\nbody\n";
        let diags = prop_diags(text, &HashMap::new());
        let d = diags
            .iter()
            .find(|d| d.code == Some(NumberOrString::String("property-type".into())))
            .expect("property-type diagnostic");
        assert_eq!(d.severity, Some(DiagnosticSeverity::WARNING));
        assert!(d.message.contains("rating"), "{}", d.message);
        assert!(d.message.contains("number"), "{}", d.message);
        assert!(
            d.message.contains("reading"),
            "names the base: {}",
            d.message
        );
        // Anchored to the rating line.
        assert_eq!(d.range.start.line, 3);
    }

    #[test]
    fn string_where_date_warns() {
        let text = "+++\nid = \"0190f8a0-0000-7000-8000-000000000082\"\ntype = \"BOOK\"\nstarted = \"2026-07-30\"\n+++\n";
        let diags = prop_diags(text, &HashMap::new());
        let d = diags
            .iter()
            .find(|d| d.code == Some(NumberOrString::String("property-type".into())))
            .expect("property-type diagnostic");
        assert!(d.message.contains("started"));
        assert!(d.message.contains("date"));
    }

    #[test]
    fn open_vocabulary_multi_select_never_warns_and_native_types_pass() {
        let text = "+++\nid = \"0190f8a0-0000-7000-8000-000000000083\"\ntype = \"BOOK\"\nrating = 4.5\nstarted = 2026-07-30\nthemes = [\"novel-value\"]\nstatus = \"reading\"\n+++\n";
        let diags = prop_diags(text, &HashMap::new());
        assert!(diags.is_empty(), "{diags:?}");
    }

    #[test]
    fn closed_select_violation_warns() {
        let text = "+++\nid = \"0190f8a0-0000-7000-8000-000000000084\"\ntype = \"BOOK\"\nstatus = \"paused\"\n+++\n";
        let diags = prop_diags(text, &HashMap::new());
        let d = diags
            .iter()
            .find(|d| d.code == Some(NumberOrString::String("select-violation".into())))
            .expect("select-violation diagnostic");
        assert!(d.message.contains("paused"));
        assert!(d.message.contains("queued, reading"));
    }

    #[test]
    fn unresolvable_relation_target_reuses_unresolved_link_shape() {
        let text = "+++\nid = \"0190f8a0-0000-7000-8000-000000000085\"\ntype = \"BOOK\"\nseries = [\"[[Ghost Cycle]]\"]\n+++\n";
        let diags = prop_diags(text, &HashMap::new());
        let d = diags
            .iter()
            .find(|d| d.code == Some(NumberOrString::String("unresolved-link".into())))
            .expect("unresolved-link diagnostic");
        assert_eq!(d.severity, Some(DiagnosticSeverity::WARNING));
        assert!(d.message.contains("Ghost Cycle"));

        // A resolvable target is silent.
        let mut names = HashMap::new();
        names.insert(
            "ghost cycle".to_string(),
            vec!["Ghost Cycle.md".to_string()],
        );
        assert!(prop_diags(text, &names).is_empty());
    }

    #[test]
    fn non_matching_base_and_legacy_pages_get_no_property_diagnostics() {
        // kind = NOTE: the base filter (kind = BOOK) does not match.
        let note = "+++\nid = \"0190f8a0-0000-7000-8000-000000000086\"\nrating = \"4\"\n+++\n";
        assert!(prop_diags(note, &HashMap::new()).is_empty());

        // Legacy fences: no property intelligence at all.
        let legacy =
            "---\nid: 0190f8a0-0000-7000-8000-000000000087\ntype: BOOK\nrating: \"4\"\n---\n";
        assert!(prop_diags(legacy, &HashMap::new()).is_empty());
    }

    #[test]
    fn ambiguous_link_yields_a_diagnostic() {
        let doc = Document::from_text("# A\n\n[[Dup]]\n", 1);
        let mut names = HashMap::new();
        names.insert(
            "dup".to_string(),
            vec!["a/Dup.md".to_string(), "b/Dup.md".to_string()],
        );
        let diags = compute_link_diagnostics(&doc, &names, Path::new("/v"));
        assert_eq!(diags.len(), 1);
        assert_eq!(
            diags[0].code,
            Some(NumberOrString::String("ambiguous-link".into()))
        );
        assert_eq!(diags[0].severity, Some(DiagnosticSeverity::INFORMATION));
        assert!(
            diags[0]
                .related_information
                .as_ref()
                .is_some_and(|r| r.len() == 2)
        );
    }
}
