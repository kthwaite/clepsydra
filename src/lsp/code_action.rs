//! Pure builders for code actions on link diagnostics.
use std::path::Path;

use tower_lsp::lsp_types::{
    AnnotatedTextEdit, CodeAction, CodeActionKind, CodeActionOrCommand, CreateFile,
    CreateFileOptions, Diagnostic, DocumentChangeOperation, DocumentChanges, OneOf,
    OptionalVersionedTextDocumentIdentifier, Range, ResourceOp, TextDocumentEdit, TextEdit, Url,
    WorkspaceEdit,
};

/// Build a "create page" action for an unresolved-link diagnostic.
///
/// `target` is the raw wikilink target string (e.g. `"Ghost"`).
/// `vault_root` is the absolute path to the vault root.
/// `diag` is the diagnostic this action resolves.
/// `_uri` is unused but kept for API symmetry with the disambiguate builder.
///
/// Returns `None` if the new page path is not representable as a URL.
pub fn build_create_page_action(
    target: &str,
    vault_root: &Path,
    diag: &Diagnostic,
    _uri: &Url,
) -> Option<CodeActionOrCommand> {
    let new_vp = crate::vault::path::VaultPath::from_title(target);
    // Resolve against vault_root by replicating what Vault::resolve does:
    // the VaultPath's slug is a relative path string.
    let new_abs = vault_root.join(new_vp.as_str());
    let new_uri = Url::from_file_path(&new_abs).ok()?;

    // Build frontmatter scaffold
    let mut meta = crate::vault::page::PageMeta::new();
    meta.title = Some(target.to_string());
    let content = crate::vault::page::write_page_content(&meta, "\n");

    let ops: Vec<DocumentChangeOperation> = vec![
        DocumentChangeOperation::Op(ResourceOp::Create(CreateFile {
            uri: new_uri.clone(),
            options: Some(CreateFileOptions {
                overwrite: Some(false),
                ignore_if_exists: Some(false),
            }),
            annotation_id: None,
        })),
        DocumentChangeOperation::Edit(TextDocumentEdit {
            text_document: OptionalVersionedTextDocumentIdentifier {
                uri: new_uri,
                version: None,
            },
            edits: vec![OneOf::<TextEdit, AnnotatedTextEdit>::Left(TextEdit {
                range: Range::default(),
                new_text: content,
            })],
        }),
    ];

    Some(CodeActionOrCommand::CodeAction(CodeAction {
        title: format!("Create page: {target}"),
        kind: Some(CodeActionKind::QUICKFIX),
        diagnostics: Some(vec![diag.clone()]),
        edit: Some(WorkspaceEdit {
            changes: None,
            document_changes: Some(DocumentChanges::Operations(ops)),
            change_annotations: None,
        }),
        is_preferred: Some(true),
        ..Default::default()
    }))
}

/// Build disambiguation actions for an ambiguous-link diagnostic (one per candidate).
///
/// `target_raw` is the raw wikilink target (used only for display; the caller
/// has already resolved `candidate_paths`).
/// `candidate_paths` are the vault-relative paths (e.g. `"a/Dup.md"`).
/// `link_range` is the LSP range of the wikilink in the document.
/// `body_text` is the full document body (used to extract the raw wikilink span).
/// `link_span` is the byte range of the raw wikilink inside `body_text`.
/// `diag` is the diagnostic this action resolves.
/// `uri` is the document URI (used as the key in the workspace edit).
pub fn build_disambiguate_actions(
    candidate_paths: &[String],
    link_range: Range,
    body_text: &str,
    link_span: std::ops::Range<usize>,
    diag: &Diagnostic,
    uri: &Url,
) -> Vec<CodeActionOrCommand> {
    let mut actions = Vec::new();

    // Extract raw wikilink text once
    let raw_text = if link_span.end <= body_text.len() {
        &body_text[link_span.clone()]
    } else {
        return actions;
    };

    for path in candidate_paths {
        let path_stem = path.strip_suffix(".md").unwrap_or(path);
        let new_text = crate::lsp::rename::rewrite_wikilink(raw_text, path_stem);

        let edit = TextEdit {
            range: link_range,
            new_text,
        };

        let title_display = path.strip_suffix(".md").unwrap_or(path);

        actions.push(CodeActionOrCommand::CodeAction(CodeAction {
            title: format!("Resolve to: {title_display}"),
            kind: Some(CodeActionKind::QUICKFIX),
            diagnostics: Some(vec![diag.clone()]),
            edit: Some(WorkspaceEdit {
                changes: Some([(uri.clone(), vec![edit])].into_iter().collect()),
                document_changes: None,
                change_annotations: None,
            }),
            ..Default::default()
        }));
    }

    actions
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower_lsp::lsp_types::NumberOrString;

    fn diag(code: &str) -> Diagnostic {
        Diagnostic {
            range: Range::default(),
            code: Some(NumberOrString::String(code.into())),
            ..Default::default()
        }
    }

    #[test]
    fn create_page_action_is_built_for_unresolved() {
        let uri = Url::from_file_path("/vault/A.md").unwrap();
        let action = build_create_page_action(
            "Ghost",
            Path::new("/vault"),
            &diag("unresolved-link"),
            &uri,
        );
        assert!(action.is_some());
    }

    #[test]
    fn create_page_action_title_matches() {
        let uri = Url::from_file_path("/vault/A.md").unwrap();
        let action = build_create_page_action(
            "Ghost",
            Path::new("/vault"),
            &diag("unresolved-link"),
            &uri,
        )
        .unwrap();
        let CodeActionOrCommand::CodeAction(ca) = action else {
            panic!("expected CodeAction");
        };
        assert_eq!(ca.title, "Create page: Ghost");
        assert_eq!(ca.kind, Some(CodeActionKind::QUICKFIX));
        assert_eq!(ca.is_preferred, Some(true));
    }

    #[test]
    fn disambiguate_builds_one_action_per_candidate() {
        let uri = Url::from_file_path("/vault/A.md").unwrap();
        let body = "# A\n\n[[Dup]]\n";
        // span of "[[Dup]]" in the body
        let span_start = body.find("[[Dup]]").unwrap();
        let span = span_start..span_start + "[[Dup]]".len();
        let actions = build_disambiguate_actions(
            &["a/Dup.md".into(), "b/Dup.md".into()],
            Range::default(),
            body,
            span,
            &diag("ambiguous-link"),
            &uri,
        );
        assert_eq!(actions.len(), 2);
    }

    #[test]
    fn disambiguate_action_titles_use_path_stem() {
        let uri = Url::from_file_path("/vault/A.md").unwrap();
        let body = "# A\n\n[[Dup]]\n";
        let span_start = body.find("[[Dup]]").unwrap();
        let span = span_start..span_start + "[[Dup]]".len();
        let actions = build_disambiguate_actions(
            &["a/Dup.md".into(), "b/Dup.md".into()],
            Range::default(),
            body,
            span,
            &diag("ambiguous-link"),
            &uri,
        );
        let titles: Vec<_> = actions
            .iter()
            .map(|a| {
                let CodeActionOrCommand::CodeAction(ca) = a else {
                    panic!("expected CodeAction");
                };
                ca.title.clone()
            })
            .collect();
        assert!(titles.contains(&"Resolve to: a/Dup".to_string()));
        assert!(titles.contains(&"Resolve to: b/Dup".to_string()));
    }

    #[test]
    fn disambiguate_returns_empty_on_out_of_bounds_span() {
        let uri = Url::from_file_path("/vault/A.md").unwrap();
        let body = "short";
        // span beyond end of body
        let actions = build_disambiguate_actions(
            &["a/Dup.md".into()],
            Range::default(),
            body,
            100..200,
            &diag("ambiguous-link"),
            &uri,
        );
        assert!(actions.is_empty());
    }
}
