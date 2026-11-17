use tower_lsp::lsp_types::{
    AnnotatedTextEdit, OneOf, Position, PrepareRenameResponse, Range, TextEdit,
};

use crate::document::Document;
use clep_vault::canonical::CanonicalName;
use clep_vault::link::LinkKind;
use clep_vault::page::{parse_or_repair_frontmatter, write_page_content};
use clep_vault::path::VaultPath;

/// Rewrite a wikilink span text with a new target, preserving display text.
///
/// Input: raw text like `[[Old Name]]` or `[[Old|Display]]`
/// Output: `[[New Name]]` or `[[New Name|Display]]`
pub fn rewrite_wikilink(raw_span_text: &str, new_target: &str) -> String {
    // Strip the `[[` prefix and `]]` suffix
    let inner = raw_span_text
        .strip_prefix("[[")
        .and_then(|s| s.strip_suffix("]]"))
        .unwrap_or(raw_span_text);

    if let Some((_old_target, display)) = inner.split_once('|') {
        format!("[[{new_target}|{display}]]")
    } else {
        format!("[[{new_target}]]")
    }
}

/// Check if a link target matches any of the given canonical names.
///
/// Canonicalizes `target_raw` and checks membership in the provided list.
pub fn link_matches_target(target_raw: &str, target_canonical_names: &[String]) -> bool {
    let canonical = CanonicalName::from_title(target_raw);
    target_canonical_names
        .iter()
        .any(|cn| cn == canonical.as_str())
}

/// Update frontmatter title in full document text. Returns new full text.
///
/// Uses `parse_or_repair_frontmatter` which always succeeds, even on
/// malformed YAML (it falls back to defaults).
pub fn update_frontmatter_title(full_text: &str, new_title: &str) -> String {
    let (mut meta, body, _, _) = parse_or_repair_frontmatter(full_text);
    meta.title = Some(new_title.to_string());
    write_page_content(&meta, &body)
}

/// If `line_text` is a frontmatter `title:` line, return the rename range and
/// placeholder for the (possibly quoted) title value on `line_number`.
///
/// Columns are UTF-8 byte offsets within `line_text`.
pub fn frontmatter_title_rename_range(
    line_text: &str,
    line_number: u32,
) -> Option<PrepareRenameResponse> {
    let trimmed = line_text.trim_start();
    let rest = trimmed.strip_prefix("title:")?;
    let value = rest.trim();

    // Whether the value is wrapped in a pair of single or double quotes. One
    // quote character alone both starts and ends the value but is not a pair
    // (the line while a quoted title is being typed): it is an unquoted value.
    let is_quoted = value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')));

    // Strip the surrounding quotes if present.
    let title_value = if is_quoted {
        &value[1..value.len() - 1]
    } else {
        value
    };

    // Column of the value within `line_text`, measured from the stripped
    // prefixes. Searching the line for the value text would find an earlier
    // occurrence inside the `title` key (`title: title`, `title: t`).
    let rest_start = line_text.len() - rest.len();
    let value_start = if value.is_empty() {
        // No value: the empty range sits at the end of the line's content.
        rest_start + rest.trim_end_matches(['\r', '\n']).len()
    } else {
        rest_start + (rest.len() - rest.trim_start().len())
    };
    // For a quoted value, skip past the opening quote.
    let value_start_in_line = if is_quoted {
        value_start + 1
    } else {
        value_start
    };
    let value_end_in_line = value_start_in_line + title_value.len();

    let range = Range {
        start: Position {
            line: line_number,
            character: value_start_in_line as u32,
        },
        end: Position {
            line: line_number,
            character: value_end_in_line as u32,
        },
    };

    Some(PrepareRenameResponse::RangeWithPlaceholder {
        range,
        placeholder: title_value.to_string(),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Extracted helpers (pure / SQL)
// ─────────────────────────────────────────────────────────────────────────────

/// Compute the new `VaultPath` for a rename operation.
///
/// The new filename is derived from `new_name` via `VaultPath::from_title`.
/// If the old path has a parent directory the new filename is placed inside
/// that same directory; otherwise it lives at the vault root.
///
/// Returns `None` only if the resulting path string fails validation (in
/// practice this cannot happen for a well-formed slug, but the caller
/// handles it as an internal error).
pub fn compute_new_vault_path(old_vp: &VaultPath, new_name: &str) -> Option<VaultPath> {
    let new_filename_vp = VaultPath::from_title(new_name);
    let new_vp_str = match old_vp.parent() {
        Some(parent) => format!("{}/{}", parent, new_filename_vp.as_str()),
        None => new_filename_vp.as_str().to_string(),
    };
    VaultPath::new(&new_vp_str).ok()
}

/// Compute the full-document LSP `Range` for a given text.
///
/// Used as the replacement range for the frontmatter-title edit so that
/// the entire document is replaced in one `TextEdit`.
pub fn full_document_range(text: &str) -> Range {
    let line_count = text.lines().count();
    let last_line = text.lines().last().unwrap_or("");
    Range {
        start: Position {
            line: 0,
            character: 0,
        },
        end: Position {
            line: line_count.saturating_sub(1) as u32,
            character: last_line.len() as u32,
        },
    }
}

/// Fetch all canonical names for the page at `old_path`.
///
/// Executes two inline SQL queries (page id lookup, then canonical_names
/// SELECT) and returns the names in the order the database yields them.
/// Returns a `rusqlite::Error` if the page is not found.
pub fn fetch_canonical_names_for_path(
    conn: &rusqlite::Connection,
    old_path: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let page_id: String = conn.query_row(
        "SELECT id FROM pages WHERE path = ?1",
        rusqlite::params![old_path],
        |row| row.get(0),
    )?;
    let mut stmt = conn.prepare("SELECT canonical_name FROM canonical_names WHERE page_id = ?1")?;
    let names = stmt
        .query_map(rusqlite::params![page_id], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(names)
}

/// Find all vault-relative paths that link to the page at `old_path`.
///
/// Runs two queries:
/// 1. Resolved links (target_id matches page id)
/// 2. Unresolved links (target_canonical matches any of `old_canonical_names`
///    and target_id IS NULL)
///
/// The results are de-duplicated via a `HashSet` and the old page itself is
/// excluded (matching the original `remove(&sp)` call).  The returned `Vec`
/// is in unspecified (HashSet iteration) order — matching the original.
pub fn find_referring_paths(
    conn: &rusqlite::Connection,
    old_path: &str,
    old_canonical_names: &[String],
) -> Result<Vec<String>, rusqlite::Error> {
    let page_id: Option<String> = conn
        .query_row(
            "SELECT id FROM pages WHERE path = ?1",
            rusqlite::params![old_path],
            |row| row.get(0),
        )
        .ok();

    let mut source_paths = std::collections::HashSet::<String>::new();

    if let Some(ref pid) = page_id {
        // Resolved links targeting this page
        let mut stmt = conn.prepare(
            "SELECT DISTINCT p.path FROM links l \
             JOIN pages p ON l.source_id = p.id \
             WHERE l.target_id = ?1",
        )?;
        let paths: Vec<String> = stmt
            .query_map(rusqlite::params![pid], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        source_paths.extend(paths);
    }

    // Unresolved links matching canonical names
    for cn in old_canonical_names {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT p.path FROM links l \
             JOIN pages p ON l.source_id = p.id \
             WHERE l.target_canonical = ?1 AND l.target_id IS NULL",
        )?;
        let paths: Vec<String> = stmt
            .query_map(rusqlite::params![cn], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        source_paths.extend(paths);
    }

    // Remove self: `old_path` is, by definition, the path that resolved to
    // `page_id`, so there is no need to re-query it from the id.
    source_paths.remove(old_path);

    Ok(source_paths.into_iter().collect())
}

/// Build the `TextEdit` list for rewriting wikilinks in a referring document.
///
/// Iterates over all links in `ref_doc`, skipping:
/// - Zero-span links (span 0..0 — property ref links)
/// - Non-Wiki links
/// - Links whose target does not match any of `old_canonical_names`
///
/// For each matching link, rewrites the raw span text via `rewrite_wikilink`
/// and records the edit range via `ref_doc.link_to_range`.
pub fn build_wikilink_text_edits(
    ref_doc: &Document,
    old_canonical_names: &[String],
    new_name: &str,
) -> Vec<OneOf<TextEdit, AnnotatedTextEdit>> {
    let mut text_edits: Vec<OneOf<TextEdit, AnnotatedTextEdit>> = Vec::new();
    for link in &ref_doc.links {
        // Skip property ref links (span 0..0)
        if link.span.start == 0 && link.span.end == 0 {
            continue;
        }
        if link.kind != LinkKind::Wiki {
            continue;
        }
        if !link_matches_target(&link.target_raw, old_canonical_names) {
            continue;
        }

        let raw_span_text = &ref_doc.body[link.span.clone()];
        let new_link_text = rewrite_wikilink(raw_span_text, new_name);
        let range = ref_doc.link_to_range(link);

        text_edits.push(OneOf::Left(TextEdit {
            range,
            new_text: new_link_text,
        }));
    }
    text_edits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_simple_wikilink() {
        let result = rewrite_wikilink("[[Old Name]]", "New Name");
        assert_eq!(result, "[[New Name]]");
    }

    #[test]
    fn rewrite_wikilink_with_display_text() {
        let result = rewrite_wikilink("[[Old|Display Text]]", "New Name");
        assert_eq!(result, "[[New Name|Display Text]]");
    }

    #[test]
    fn link_matches_by_canonical_name() {
        let names = vec!["design notes".to_string(), "design-notes".to_string()];
        assert!(link_matches_target("Design Notes", &names));
    }

    #[test]
    fn link_matches_case_insensitive() {
        let names = vec!["hello world".to_string()];
        assert!(link_matches_target("HELLO WORLD", &names));
        assert!(link_matches_target("Hello World", &names));
        assert!(!link_matches_target("goodbye world", &names));
    }

    #[test]
    fn update_title_in_frontmatter() {
        let content = "---\nid: 00000000-0000-0000-0000-000000000001\ntitle: Old Title\n---\nBody text here.\n";
        let new_text = update_frontmatter_title(content, "New Title");
        // The rewrite serializes back out as TOML (heal-on-touch).
        assert!(new_text.contains("title = \"New Title\""));
        assert!(new_text.contains("Body text here."));
        assert!(!new_text.contains("Old Title"));
    }

    #[test]
    fn frontmatter_title_unquoted() {
        let r = frontmatter_title_rename_range("title: My Note", 0).unwrap();
        match r {
            PrepareRenameResponse::RangeWithPlaceholder { placeholder, range } => {
                assert_eq!(placeholder, "My Note");
                assert_eq!(range.start.line, 0);
                assert_eq!(range.start.character, 7); // "title: " is 7 chars
                assert_eq!(range.end.character, 7 + 7); // "My Note" is 7 chars
            }
            _ => panic!("expected RangeWithPlaceholder"),
        }
    }

    #[test]
    fn frontmatter_title_double_quoted() {
        let r = frontmatter_title_rename_range("title: \"My Note\"", 3).unwrap();
        match r {
            PrepareRenameResponse::RangeWithPlaceholder { placeholder, range } => {
                assert_eq!(placeholder, "My Note");
                assert_eq!(range.start.line, 3);
                // "title: \"" is 8 chars; value starts at char 8
                assert_eq!(range.start.character, 8);
                assert_eq!(range.end.character, 8 + 7); // "My Note" is 7 chars
            }
            _ => panic!("expected RangeWithPlaceholder"),
        }
    }

    #[test]
    fn frontmatter_title_single_quoted() {
        let r = frontmatter_title_rename_range("title: 'My Note'", 2).unwrap();
        match r {
            PrepareRenameResponse::RangeWithPlaceholder { placeholder, range } => {
                assert_eq!(placeholder, "My Note");
                assert_eq!(range.start.line, 2);
                // "title: '" is 8 chars; value starts at char 8
                assert_eq!(range.start.character, 8);
                assert_eq!(range.end.character, 8 + 7); // "My Note" is 7 chars
            }
            _ => panic!("expected RangeWithPlaceholder"),
        }
    }

    /// Unwrap the range and placeholder of a title line on line 0.
    fn title_range(line: &str) -> (u32, u32, String) {
        match frontmatter_title_rename_range(line, 0) {
            Some(PrepareRenameResponse::RangeWithPlaceholder { range, placeholder }) => {
                (range.start.character, range.end.character, placeholder)
            }
            other => panic!("expected RangeWithPlaceholder, got {other:?}"),
        }
    }

    #[test]
    fn lone_quote_title_is_an_unquoted_value() {
        // A half-typed quoted title: one quote character both starts and
        // ends the value, but there is nothing between a pair to strip.
        assert_eq!(title_range("title: \"\n"), (7, 8, "\"".to_string()));
        assert_eq!(title_range("title: '"), (7, 8, "'".to_string()));
    }

    #[test]
    fn empty_quoted_title_has_an_empty_range_between_the_quotes() {
        assert_eq!(title_range("title: \"\"\n"), (8, 8, String::new()));
    }

    #[test]
    fn title_range_is_the_value_when_the_value_occurs_in_the_key() {
        assert_eq!(title_range("title: title"), (7, 12, "title".to_string()));
        assert_eq!(title_range("title: t\n"), (7, 8, "t".to_string()));
        assert_eq!(title_range("  title:   it\n"), (11, 13, "it".to_string()));
        assert_eq!(title_range("title: \"e\"\n"), (8, 9, "e".to_string()));
    }

    #[test]
    fn empty_title_range_sits_after_the_key() {
        assert_eq!(title_range("title:\n"), (6, 6, String::new()));
        assert_eq!(title_range("title: \r\n"), (7, 7, String::new()));
    }

    #[test]
    fn non_title_line_returns_none() {
        assert!(frontmatter_title_rename_range("tags: [a]", 0).is_none());
    }

    // ──────────────────────────────────────────────
    // compute_new_vault_path
    // ──────────────────────────────────────────────

    #[test]
    fn compute_new_vault_path_root_level() {
        let old = VaultPath::new("Old.md").unwrap();
        let new_vp = compute_new_vault_path(&old, "New Name").unwrap();
        // VaultPath::from_title("New Name") → "New Name.md"
        assert_eq!(new_vp.as_str(), "New Name.md");
    }

    #[test]
    fn compute_new_vault_path_preserves_parent() {
        let old = VaultPath::new("notes/Old.md").unwrap();
        let new_vp = compute_new_vault_path(&old, "New Name").unwrap();
        assert_eq!(new_vp.as_str(), "notes/New Name.md");
    }

    #[test]
    fn compute_new_vault_path_deep_nesting() {
        let old = VaultPath::new("a/b/c/Old.md").unwrap();
        let new_vp = compute_new_vault_path(&old, "New").unwrap();
        assert_eq!(new_vp.as_str(), "a/b/c/New.md");
    }

    // ──────────────────────────────────────────────
    // full_document_range
    // ──────────────────────────────────────────────

    #[test]
    fn full_document_range_single_line() {
        let r = full_document_range("hello");
        assert_eq!(r.start.line, 0);
        assert_eq!(r.start.character, 0);
        assert_eq!(r.end.line, 0);
        assert_eq!(r.end.character, 5);
    }

    #[test]
    fn full_document_range_multi_line() {
        let text = "line one\nline two\nthird";
        let r = full_document_range(text);
        assert_eq!(r.start.line, 0);
        assert_eq!(r.start.character, 0);
        assert_eq!(r.end.line, 2);
        assert_eq!(r.end.character, 5); // "third" is 5 chars
    }

    #[test]
    fn full_document_range_trailing_newline() {
        // str::lines() strips the trailing newline: "line one\n" yields a
        // single line "line one" (count = 1, last = "line one", 8 chars).
        let text = "line one\n";
        let r = full_document_range(text);
        assert_eq!(r.end.line, 0);
        assert_eq!(r.end.character, 8);
    }

    // ──────────────────────────────────────────────
    // fetch_canonical_names_for_path (needs DB)
    // ──────────────────────────────────────────────

    #[tokio::test]
    async fn fetch_canonical_names_returns_page_names() {
        use crate::test_support::make_backend;
        let (backend, _tmp) =
            make_backend(&[("Target.md", "---\ntitle: Target Page\n---\nbody\n")]);
        let names = backend
            .state()
            .unwrap()
            .index
            .with_index(|idx, _| fetch_canonical_names_for_path(idx.connection(), "Target.md"))
            .await
            .expect("with_index ok")
            .expect("rusqlite ok");
        // "Target Page" → canonical "target page"; slug "Target" → "target"
        assert!(!names.is_empty(), "should have at least one canonical name");
        // At least one of the canonical names should be derived from "Target Page"
        assert!(
            names.iter().any(|n| n == "target page"),
            "expected 'target page' in {names:?}"
        );
    }

    #[tokio::test]
    async fn fetch_canonical_names_missing_page_errors() {
        use crate::test_support::make_backend;
        let (backend, _tmp) = make_backend(&[("A.md", "# A\n")]);
        let result = backend
            .state()
            .unwrap()
            .index
            .with_index(|idx, _| fetch_canonical_names_for_path(idx.connection(), "Nonexistent.md"))
            .await
            .expect("with_index ok");
        assert!(result.is_err(), "should error when page not found");
    }

    // ──────────────────────────────────────────────
    // find_referring_paths (needs DB)
    // ──────────────────────────────────────────────

    #[tokio::test]
    async fn find_referring_paths_finds_referrer() {
        use crate::test_support::make_backend;
        let (backend, _tmp) = make_backend(&[
            ("Target.md", "---\ntitle: Target\n---\nbody\n"),
            ("A.md", "# A\n\n[[Target]]\n"),
        ]);
        let old_cns = backend
            .state()
            .unwrap()
            .index
            .with_index(|idx, _| fetch_canonical_names_for_path(idx.connection(), "Target.md"))
            .await
            .unwrap()
            .unwrap();
        let referring = backend
            .state()
            .unwrap()
            .index
            .with_index(move |idx, _| find_referring_paths(idx.connection(), "Target.md", &old_cns))
            .await
            .unwrap()
            .unwrap();
        assert!(
            referring.contains(&"A.md".to_string()),
            "A.md should be a referrer; got {referring:?}"
        );
        assert!(
            !referring.contains(&"Target.md".to_string()),
            "Target.md should be excluded from referrers"
        );
    }

    #[tokio::test]
    async fn find_referring_paths_excludes_self() {
        use crate::test_support::make_backend;
        // Self-referential link: Target links to itself
        let (backend, _tmp) =
            make_backend(&[("Target.md", "---\ntitle: Target\n---\n[[Target]]\n")]);
        let old_cns = backend
            .state()
            .unwrap()
            .index
            .with_index(|idx, _| fetch_canonical_names_for_path(idx.connection(), "Target.md"))
            .await
            .unwrap()
            .unwrap();
        let referring = backend
            .state()
            .unwrap()
            .index
            .with_index(move |idx, _| find_referring_paths(idx.connection(), "Target.md", &old_cns))
            .await
            .unwrap()
            .unwrap();
        assert!(
            !referring.contains(&"Target.md".to_string()),
            "self should be excluded; got {referring:?}"
        );
    }

    // ──────────────────────────────────────────────
    // build_wikilink_text_edits
    // ──────────────────────────────────────────────

    #[test]
    fn build_wikilink_text_edits_rewrites_matching_link() {
        use crate::document::Document;
        let doc = Document::from_text("# A\n\n[[Old]] and [[Other]]\n", 0);
        let old_cns = vec!["old".to_string()];
        let edits = build_wikilink_text_edits(&doc, &old_cns, "New");
        assert_eq!(
            edits.len(),
            1,
            "exactly one edit for [[Old]]; got {edits:?}"
        );
        let OneOf::Left(te) = &edits[0] else {
            panic!("expected Left(TextEdit)");
        };
        assert_eq!(te.new_text, "[[New]]");
    }

    #[test]
    fn build_wikilink_text_edits_skips_non_matching() {
        use crate::document::Document;
        let doc = Document::from_text("# A\n\n[[Other]]\n", 0);
        let old_cns = vec!["old".to_string()];
        let edits = build_wikilink_text_edits(&doc, &old_cns, "New");
        assert!(edits.is_empty(), "no edits for non-matching link");
    }

    #[test]
    fn build_wikilink_text_edits_preserves_display_text() {
        use crate::document::Document;
        let doc = Document::from_text("# A\n\n[[Old|shown]]\n", 0);
        let old_cns = vec!["old".to_string()];
        let edits = build_wikilink_text_edits(&doc, &old_cns, "New Name");
        assert_eq!(edits.len(), 1);
        let OneOf::Left(te) = &edits[0] else {
            panic!("expected Left(TextEdit)");
        };
        assert_eq!(te.new_text, "[[New Name|shown]]");
    }
}
