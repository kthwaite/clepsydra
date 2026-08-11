//! FTS search for the `clepsydra grep` CLI subcommand.

use std::io::{self, Write};

use owo_colors::OwoColorize;
use serde::Serialize;

use crate::VESSEL_ACCENT as ACCENT;
use crate::vault::index::{IndexError, SearchResult, VaultIndex};

/// Run an FTS search. When `raw` is false the query is quoted as a literal
/// phrase via [`fts_quote`]; when true it is passed straight to FTS5 `MATCH`,
/// exposing the full operator syntax.
pub fn run(
    index: &VaultIndex,
    query: &str,
    limit: usize,
    raw: bool,
) -> Result<Vec<SearchResult>, IndexError> {
    let prepared = if raw {
        query.to_string()
    } else {
        fts_quote(query)
    };
    index.search_fts(&prepared, limit)
}

/// Quote a raw user query as a single FTS5 phrase: surround in double quotes
/// and double any embedded `"`. This makes arbitrary input safe to pass to
/// `MATCH` — stray quotes or bare operators become literal tokens instead of
/// FTS5 syntax errors.
pub(crate) fn fts_quote(query: &str) -> String {
    let escaped = query.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

/// Render results as styled human-readable text, in rank order. `<mark>` spans
/// in the snippet are painted with the accent colour; the surrounding text is
/// left plain and the ellipsis is dimmed. Callers wishing to honour `NO_COLOR`
/// / non-TTY should wrap `w` in `anstream::AutoStream`.
pub fn render_human(results: &[SearchResult], w: &mut impl Write) -> io::Result<()> {
    if results.is_empty() {
        return writeln!(w, "{}", "no matches".dimmed());
    }
    for r in results {
        let title = match &r.title {
            Some(t) => format!(" {}", t.bold()),
            None => String::new(),
        };
        writeln!(
            w,
            "{}{}",
            r.path.truecolor(ACCENT.0, ACCENT.1, ACCENT.2),
            title
        )?;
        writeln!(w, "  {}", paint_snippet(&r.snippet))?;
    }
    Ok(())
}

/// Replace `<mark>…</mark>` with accent-coloured segments and dim the FTS5
/// ellipsis. Operates on whole tokens so anstream can strip colour cleanly.
fn paint_snippet(snippet: &str) -> String {
    let mut out = String::with_capacity(snippet.len());
    let mut rest = snippet;
    while let Some(open) = rest.find("<mark>") {
        out.push_str(&rest[..open]);
        rest = &rest[open + "<mark>".len()..];
        if let Some(close) = rest.find("</mark>") {
            let marked = &rest[..close];
            out.push_str(
                &marked
                    .truecolor(ACCENT.0, ACCENT.1, ACCENT.2)
                    .bold()
                    .to_string(),
            );
            rest = &rest[close + "</mark>".len()..];
        } else {
            out.push_str(rest);
            rest = "";
        }
    }
    out.push_str(rest);
    out.replace('…', &"…".dimmed().to_string())
}

/// A serializable view of a search result for `--json` output.
#[derive(Serialize)]
struct JsonResult<'a> {
    page_id: &'a str,
    path: &'a str,
    title: Option<&'a str>,
    snippet: &'a str,
    rank: f64,
}

/// Render results as a JSON array. The snippet keeps its `<mark>` markers so a
/// consumer can locate highlights.
pub fn render_json(results: &[SearchResult], w: &mut impl Write) -> io::Result<()> {
    let view: Vec<JsonResult> = results
        .iter()
        .map(|r| JsonResult {
            page_id: &r.page_id,
            path: &r.path,
            title: r.title.as_deref(),
            snippet: &r.snippet,
            rank: r.rank,
        })
        .collect();
    serde_json::to_writer_pretty(&mut *w, &view)?;
    writeln!(w)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts_quote_wraps_plain_phrase() {
        assert_eq!(fts_quote("hello world"), "\"hello world\"");
    }

    #[test]
    fn fts_quote_doubles_embedded_quotes() {
        // he said "hi" -> "he said ""hi"""
        assert_eq!(fts_quote("he said \"hi\""), "\"he said \"\"hi\"\"\"");
    }

    #[test]
    fn fts_quote_neutralizes_operators() {
        // A bare FTS5 operator becomes a literal token inside the phrase.
        assert_eq!(fts_quote("foo OR bar"), "\"foo OR bar\"");
    }

    use crate::vault::Vault;
    use crate::vault::index::VaultIndex;

    /// Build a temp vault with one note, return (TempDir, Vault, VaultIndex).
    fn vault_with_note(filename: &str, body: &str) -> (tempfile::TempDir, Vault, VaultIndex) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        crate::vault::init::init_vault(&root).unwrap();
        std::fs::write(root.join(filename), body).unwrap();
        let vault = Vault::open(&root).unwrap();
        let mut index = VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
        index.build(&vault).unwrap();
        index.resolve_links().unwrap();
        (dir, vault, index)
    }

    #[test]
    fn run_finds_a_seeded_note() {
        let (_dir, _vault, index) = vault_with_note(
            "Photosynthesis.md",
            "---\ntitle: Photosynthesis\n---\nChloroplasts capture sunlight.\n",
        );
        let results = run(&index, "chloroplasts", 20, false).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "Photosynthesis.md");
        assert!(results[0].snippet.contains("<mark>"));
    }

    #[test]
    fn run_literal_query_with_quotes_does_not_error() {
        let (_dir, _vault, index) =
            vault_with_note("Quote.md", "---\ntitle: Quote\n---\nbody text\n");
        // Without --raw, an embedded quote must not produce an FTS5 error.
        let results = run(&index, "stray \" quote", 20, false).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn encrypted_note_matches_title_only_without_ciphertext_or_prior_plaintext_snippet() {
        const ID: &str = "019fd000-0000-7000-8000-000000000601";
        const ARMOR: &str = "-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSAuLi4K\n-----END AGE ENCRYPTED FILE-----\n";
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        crate::vault::init::init_vault(&root).unwrap();
        std::fs::write(
            root.join("Secret.md"),
            format!("+++\nid = \"{ID}\"\ntitle = \"Secret title\"\n+++\nprior plaintext marker\n"),
        )
        .unwrap();
        let vault = Vault::open(&root).unwrap();
        let mut index = VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
        index.build(&vault).unwrap();
        assert_eq!(run(&index, "prior plaintext", 20, false).unwrap().len(), 1);

        std::fs::write(
            root.join("Secret.md"),
            format!(
                "+++\nid = \"{ID}\"\ntitle = \"Secret title\"\nencryption = {{ format = \"age\", version = 1, key_id = \"key-1\" }}\n+++\n{ARMOR}"
            ),
        )
        .unwrap();
        index
            .index_page(
                &vault,
                &crate::vault::path::VaultPath::new("Secret.md").unwrap(),
            )
            .unwrap();

        assert!(
            run(&index, "prior plaintext", 20, false)
                .unwrap()
                .is_empty()
        );
        assert!(run(&index, "encrypted file", 20, false).unwrap().is_empty());
        let title_match = run(&index, "secret title", 20, false).unwrap();
        assert_eq!(title_match.len(), 1);
        assert_eq!(title_match[0].path, "Secret.md");
        assert_eq!(title_match[0].snippet, "");
    }

    use crate::vault::index::SearchResult as SR;

    fn sample() -> Vec<SR> {
        vec![SR {
            page_id: "p1".into(),
            path: "Notes/Photosynthesis.md".into(),
            title: Some("Photosynthesis".into()),
            snippet: "…capture <mark>sunlight</mark> in…".into(),
            rank: -1.5,
        }]
    }

    #[test]
    fn render_human_includes_path_and_snippet_text() {
        let mut buf: Vec<u8> = Vec::new();
        render_human(&sample(), &mut buf).unwrap();
        let out = String::from_utf8(buf).unwrap();
        assert!(out.contains("Notes/Photosynthesis.md"));
        assert!(out.contains("sunlight"));
    }

    #[test]
    fn render_human_empty_says_no_matches() {
        let mut buf: Vec<u8> = Vec::new();
        render_human(&[], &mut buf).unwrap();
        let out = String::from_utf8(buf).unwrap();
        assert!(out.to_lowercase().contains("no matches"));
    }

    #[test]
    fn run_non_raw_preserves_exact_phrase_semantics() {
        let (_dir, _vault, index) = vault_with_note(
            "Phrase.md",
            "---\ntitle: Phrase\n---\nalpha beta appears in this order.\n",
        );

        assert_eq!(run(&index, "alpha beta", 20, false).unwrap().len(), 1);
        assert!(run(&index, "beta alpha", 20, false).unwrap().is_empty());
    }

    #[test]
    fn run_raw_true_passes_operators_to_fts5() {
        // Body contains "alpha" but not "zzzznotpresent".
        let (_dir, _vault, index) = vault_with_note(
            "Alpha.md",
            "---\ntitle: Alpha\n---\nThe word alpha appears here.\n",
        );
        // raw=true: FTS5 interprets OR as an operator — should match via "alpha".
        let raw_results = run(&index, "alpha OR zzzznotpresent", 20, true).unwrap();
        assert_eq!(raw_results.len(), 1, "raw OR query should match the note");
        assert_eq!(raw_results[0].path, "Alpha.md");

        // raw=false: the whole string is quoted as a literal phrase — no match.
        let quoted_results = run(&index, "alpha OR zzzznotpresent", 20, false).unwrap();
        assert!(
            quoted_results.is_empty(),
            "quoted literal phrase should not match"
        );
    }

    #[test]
    fn render_json_emits_array_with_fields() {
        let mut buf: Vec<u8> = Vec::new();
        render_json(&sample(), &mut buf).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&buf).unwrap();
        assert_eq!(v[0]["path"], "Notes/Photosynthesis.md");
        assert_eq!(v[0]["title"], "Photosynthesis");
        assert!(v[0]["snippet"].as_str().unwrap().contains("<mark>"));
        assert!(v[0]["rank"].is_number());
    }
}
