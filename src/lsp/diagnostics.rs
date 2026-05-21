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
