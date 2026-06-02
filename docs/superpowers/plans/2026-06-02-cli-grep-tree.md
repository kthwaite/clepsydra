# CLI `grep` and `tree` Subcommands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two read-only CLI subcommands — `grep <QUERY>` (ranked FTS search) and `tree` (vault tree with per-note metadata) — to the `clepsydra` binary.

**Architecture:** Each command is a thin dispatch arm in `src/bin/cli.rs` that opens the vault + read-only index via the existing `open_vault_and_index()` helper. The substantive logic lives in two new testable library modules, `src/vault/grep.rs` and `src/vault/tree.rs`, following the `relabel.rs` / `new_note.rs` convention. Output is styled human-readable text by default (via `owo-colors` + `anstream::AutoStream`, exactly as `diagnostics::Report` does) and structured JSON under `--json` (via `serde_json`).

**Tech Stack:** Rust 2024, clap (derive), rusqlite (FTS5), walkdir, owo-colors, anstream, serde / serde_json. All already in `Cargo.toml`.

---

## Reference facts (verified against the codebase)

- `clepsydra::open_vault_and_index() -> Result<(Vault, VaultIndex), Box<dyn Error>>` (src/lib.rs:466). Builds and link-resolves a fresh index. Used by the `relabel` arm.
- `VaultIndex::search(query: &str, limit: usize) -> Result<Vec<SearchResult>, IndexError>` (src/vault/index.rs:1001). Runs `pages_fts MATCH ?1 ORDER BY rank LIMIT ?2`, snippet built with `snippet(pages_fts, 3, '<mark>', '</mark>', '…', 32)`.
- `SearchResult { page_id: String, path: String, title: Option<String>, snippet: String, rank: f64 }` (src/vault/index.rs:99) — derives `Debug` only (no `Serialize`).
- `VaultIndex::connection(&self) -> &Connection` (src/vault/index.rs:288) is public.
- `pages` table columns: `id, path, title, canonical_name, created_at, updated_at, meta_json, content_hash, journal_date, kind, kind_inferred, project` (src/vault/index.rs:125).
- `tags` table: `(page_id, tag)` (src/vault/index.rs:161).
- `Vault::root(&self) -> &Path` (src/vault/mod.rs:88); `Vault::resolve(&self, vp: &VaultPath) -> PathBuf` is `root.join(vp.as_str())` (src/vault/mod.rs:76).
- `VaultPath::new(raw: &str) -> Result<Self, PathError>` (src/vault/path.rs:45); `VaultPath::as_str(&self) -> &str` (src/vault/path.rs:155). The `path` column equals the file's vault-relative path with `/` separators, so a walked file's relative path matches the column directly.
- `Page::from_file(abs_path: &Path, vault_path: VaultPath) -> Result<Page, FrontmatterError>` (src/vault/page.rs:303); `Page { meta: PageMeta, body: String, .. }`; `PageMeta { title: Option<String>, created_at: Option<DateTime<Utc>>, updated_at: Option<DateTime<Utc>>, .. }`. Word count in `content_index` is `page.body.split_whitespace().count()`.
- `diagnostics::Report::render_human` uses `owo_colors::OwoColorize` and the accent `truecolor(...)`; the CLI wraps stdout in `anstream::AutoStream::auto(std::io::stdout().lock())` (src/bin/cli.rs:127).
- Test helper `vault_in_tempdir()` and `run_cli_in()` exist in `cli_tests` (src/bin/cli.rs:181, 217).

---

## File structure

- **Create** `src/vault/grep.rs` — FTS query quoting + search invocation + human/JSON rendering of results.
- **Create** `src/vault/tree.rs` — vault tree model (`TreeNode`), filesystem walk + index-metadata join, human/JSON rendering.
- **Modify** `src/vault/mod.rs` — register the two new modules.
- **Modify** `src/bin/cli.rs` — add `Grep` and `Tree` subcommand variants, their dispatch arms, and smoke tests.

---

## Task 1: Register the new modules

**Files:**
- Modify: `src/vault/mod.rs:1-34`

- [ ] **Step 1: Add module declarations**

In `src/vault/mod.rs`, add two `pub mod` lines in alphabetical position. After line `pub mod derivers;` the file lists `hooks`, `import`… — insert `grep` between `derivers` and `hooks`, and `tree` between `sync` and the end (after `pub mod sync;`).

Add after `pub mod derivers;` (line 13):

```rust
pub mod grep;
```

Add after `pub mod sync;` (line 34):

```rust
pub mod tree;
```

- [ ] **Step 2: Create empty module files so the crate compiles**

Create `src/vault/grep.rs`:

```rust
//! FTS search for the `clepsydra grep` CLI subcommand.
```

Create `src/vault/tree.rs`:

```rust
//! Vault tree listing for the `clepsydra tree` CLI subcommand.
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo build`
Expected: builds successfully (two new empty modules, no warnings about them).

- [ ] **Step 4: Commit**

```bash
git add src/vault/mod.rs src/vault/grep.rs src/vault/tree.rs
git commit -m "chore(vault): register empty grep and tree modules"
```

---

## Task 2: `grep` — FTS query quoting

**Files:**
- Modify: `src/vault/grep.rs`
- Test: `src/vault/grep.rs` (`#[cfg(test)]` module)

- [ ] **Step 1: Write the failing test**

Append to `src/vault/grep.rs`:

```rust
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
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib vault::grep::tests::fts_quote`
Expected: FAIL — `cannot find function fts_quote in this scope`.

- [ ] **Step 3: Write minimal implementation**

Insert above the test module in `src/vault/grep.rs`:

```rust
/// Quote a raw user query as a single FTS5 phrase: surround in double quotes
/// and double any embedded `"`. This makes arbitrary input safe to pass to
/// `MATCH` — stray quotes or bare operators become literal tokens instead of
/// FTS5 syntax errors.
pub fn fts_quote(query: &str) -> String {
    let escaped = query.replace('"', "\"\"");
    format!("\"{escaped}\"")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --lib vault::grep::tests::fts_quote`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/vault/grep.rs
git commit -m "feat(grep): add fts_quote literal-phrase escaping"
```

---

## Task 3: `grep` — search invocation

**Files:**
- Modify: `src/vault/grep.rs`
- Test: `src/vault/grep.rs` tests

- [ ] **Step 1: Write the failing test**

Add these tests inside the existing `tests` module in `src/vault/grep.rs`:

```rust
    use crate::vault::index::VaultIndex;
    use crate::vault::Vault;

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
        let (_dir, _vault, index) = vault_with_note(
            "Quote.md",
            "---\ntitle: Quote\n---\nbody text\n",
        );
        // Without --raw, an embedded quote must not produce an FTS5 error.
        let results = run(&index, "stray \" quote", 20, false).unwrap();
        assert!(results.is_empty());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib vault::grep::tests::run_`
Expected: FAIL — `cannot find function run in this scope`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/vault/grep.rs` (top of file, after the doc comment):

```rust
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
    let prepared = if raw { query.to_string() } else { fts_quote(query) };
    index.search(&prepared, limit)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --lib vault::grep::tests::run_`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/vault/grep.rs
git commit -m "feat(grep): add run() wrapping VaultIndex::search"
```

---

## Task 4: `grep` — rendering (human + JSON)

**Files:**
- Modify: `src/vault/grep.rs`
- Test: `src/vault/grep.rs` tests

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `src/vault/grep.rs`:

```rust
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
    fn render_json_emits_array_with_fields() {
        let mut buf: Vec<u8> = Vec::new();
        render_json(&sample(), &mut buf).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&buf).unwrap();
        assert_eq!(v[0]["path"], "Notes/Photosynthesis.md");
        assert_eq!(v[0]["title"], "Photosynthesis");
        assert!(v[0]["snippet"].as_str().unwrap().contains("<mark>"));
        assert!(v[0]["rank"].is_number());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib vault::grep::tests::render`
Expected: FAIL — `render_human` / `render_json` not found.

- [ ] **Step 3: Write minimal implementation**

Add to `src/vault/grep.rs`. Extend the top `use` line and add the renderers:

```rust
use std::io::{self, Write};

use owo_colors::OwoColorize;
use serde::Serialize;
```

```rust
/// Barbican orange — the Vessel primary accent (matches diagnostics).
const ACCENT: (u8, u8, u8) = (0xee, 0x77, 0x33);

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
        writeln!(w, "{}{}", r.path.truecolor(ACCENT.0, ACCENT.1, ACCENT.2), title)?;
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
            out.push_str(&marked.truecolor(ACCENT.0, ACCENT.1, ACCENT.2).bold().to_string());
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --lib vault::grep::tests::render`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full grep module + clippy**

Run: `cargo test --lib vault::grep && cargo clippy`
Expected: all grep tests pass; no clippy warnings in `grep.rs`.

- [ ] **Step 6: Commit**

```bash
git add src/vault/grep.rs
git commit -m "feat(grep): add human and json renderers"
```

---

## Task 5: `grep` — CLI subcommand wiring

**Files:**
- Modify: `src/bin/cli.rs:24-93` (add variant), `src/bin/cli.rs:97-155` (add arm)
- Test: `src/bin/cli.rs` `cli_tests`

- [ ] **Step 1: Write the failing dispatch smoke test**

Add to the `cli_tests` module in `src/bin/cli.rs`:

```rust
    #[tokio::test]
    #[serial_test::serial]
    async fn grep_returns_zero() {
        let (_dir, root) = vault_in_tempdir();
        std::fs::write(
            root.join("Searchme.md"),
            "---\ntitle: Searchme\n---\nuniquetoken here\n",
        )
        .unwrap();
        let cli = Cli::try_parse_from(["clepsydra", "grep", "uniquetoken"]).unwrap();
        let result = run_cli_in(&root, cli).await;
        assert_eq!(result.unwrap(), 0);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn grep_json_returns_zero() {
        let (_dir, root) = vault_in_tempdir();
        let cli = Cli::try_parse_from(["clepsydra", "grep", "anything", "--json"]).unwrap();
        let result = run_cli_in(&root, cli).await;
        assert_eq!(result.unwrap(), 0);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --bin clepsydra grep_`
Expected: FAIL — clap rejects the unknown `grep` subcommand (parse error / `unwrap` panic).

- [ ] **Step 3: Add the subcommand variant**

In `src/bin/cli.rs`, inside `enum Commands`, add before `Version`:

```rust
    #[command(
        about = "Full-text search the vault index",
        long_about = "Search the vault's full-text index and print matches ranked by relevance.\n\nThe query is treated as a literal phrase by default; pass --raw to use FTS5 operator syntax (phrases, AND/OR, NEAR, prefix *).",
        after_help = "Examples:\n  clepsydra grep \"spaced repetition\"\n  clepsydra grep chloroplast --limit 5\n  clepsydra grep \"foo OR bar\" --raw"
    )]
    Grep {
        #[arg(value_name = "QUERY", help = "Text to search for")]
        query: String,
        #[arg(
            short = 'n',
            long,
            value_name = "N",
            default_value_t = 20,
            help = "Maximum number of results"
        )]
        limit: usize,
        #[arg(long, help = "Pass QUERY straight to FTS5 (enables operator syntax)")]
        raw: bool,
        #[arg(long, help = "Emit results as JSON instead of styled text")]
        json: bool,
    },
```

- [ ] **Step 4: Add the dispatch arm**

In `run_cli`, add before `Commands::Version`:

```rust
        Commands::Grep {
            query,
            limit,
            raw,
            json,
        } => {
            let (_vault, index) = open_vault_and_index()?;
            let results = clepsydra::vault::grep::run(&index, &query, limit, raw)?;
            if json {
                clepsydra::vault::grep::render_json(&results, &mut std::io::stdout().lock())?;
            } else {
                let mut stdout = anstream::AutoStream::auto(std::io::stdout().lock());
                clepsydra::vault::grep::render_human(&results, &mut stdout)?;
            }
            Ok(0)
        }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test --bin clepsydra grep_`
Expected: PASS (2 tests).

- [ ] **Step 6: Manual smoke check**

Run: `cargo run -- grep --help`
Expected: help text shows `QUERY`, `--limit`, `--raw`, `--json`.

- [ ] **Step 7: Commit**

```bash
git add src/bin/cli.rs
git commit -m "feat(cli): add grep subcommand"
```

---

## Task 6: `tree` — node model and metadata loader

**Files:**
- Modify: `src/vault/tree.rs`
- Test: `src/vault/tree.rs` tests

- [ ] **Step 1: Write the failing test**

Append to `src/vault/tree.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;
    use crate::vault::index::VaultIndex;

    /// Temp vault with a note and an attachment; returns (TempDir, Vault, VaultIndex).
    fn fixture() -> (tempfile::TempDir, Vault, VaultIndex) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        crate::vault::init::init_vault(&root).unwrap();
        std::fs::write(
            root.join("Alpha.md"),
            "---\ntitle: Alpha\ntags: [physics]\n---\nword one two three\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("_attachments")).unwrap();
        std::fs::write(root.join("_attachments/diagram.png"), b"\x89PNG fake").unwrap();
        let vault = Vault::open(&root).unwrap();
        let mut index = VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
        index.build(&vault).unwrap();
        index.resolve_links().unwrap();
        (dir, vault, index)
    }

    #[test]
    fn load_note_meta_carries_kind_and_tags() {
        let (_dir, vault, index) = fixture();
        let meta = load_note_meta(&vault, &index).unwrap();
        let alpha = meta.get("Alpha.md").expect("Alpha.md indexed");
        assert_eq!(alpha.kind, "NOTE");
        assert!(alpha.tags.contains(&"physics".to_string()));
        assert_eq!(alpha.word_count, Some(4));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib vault::tree::tests::load_note_meta`
Expected: FAIL — `NoteMeta` / `load_note_meta` not found.

- [ ] **Step 3: Write minimal implementation**

Add to the top of `src/vault/tree.rs`:

```rust
use std::collections::HashMap;

use serde::Serialize;

use crate::vault::Vault;
use crate::vault::index::VaultIndex;
use crate::vault::page::Page;
use crate::vault::path::VaultPath;

/// Metadata attached to an indexed note in the tree.
#[derive(Debug, Clone, Serialize, Default)]
pub struct NoteMeta {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub word_count: Option<i64>,
}

/// Bulk-load note metadata keyed by the vault-relative path (the `pages.path`
/// column, which equals each note's path under the vault root). Kind/title come
/// from `pages`, tags from `tags`; dates and word count require reading each
/// file (as the HTTP content index does).
pub fn load_note_meta(
    vault: &Vault,
    index: &VaultIndex,
) -> Result<HashMap<String, NoteMeta>, rusqlite::Error> {
    let conn = index.connection();

    // Tags grouped by page_id.
    let mut tags_by_page: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT page_id, tag FROM tags")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for (pid, tag) in rows.flatten() {
            tags_by_page.entry(pid).or_default().push(tag);
        }
    }

    let mut stmt = conn.prepare("SELECT id, path, title, kind FROM pages")?;
    type Row = (String, String, Option<String>, String);
    let rows: Vec<Row> = stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .filter_map(|r| r.ok())
        .collect();

    let mut out = HashMap::with_capacity(rows.len());
    for (page_id, path, title, kind) in rows {
        let tags = tags_by_page.remove(&page_id).unwrap_or_default();
        let (created_at, updated_at, word_count) = match VaultPath::new(&path) {
            Ok(vp) => {
                let abs = vault.resolve(&vp);
                match Page::from_file(&abs, vp) {
                    Ok(page) => (
                        page.meta.created_at.map(|d| d.to_rfc3339()),
                        page.meta.updated_at.map(|d| d.to_rfc3339()),
                        Some(page.body.split_whitespace().count() as i64),
                    ),
                    Err(_) => (None, None, None),
                }
            }
            Err(_) => (None, None, None),
        };
        out.insert(
            path,
            NoteMeta {
                kind,
                title,
                tags,
                created_at,
                updated_at,
                word_count,
            },
        );
    }
    Ok(out)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --lib vault::tree::tests::load_note_meta`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/tree.rs
git commit -m "feat(tree): add NoteMeta and load_note_meta"
```

---

## Task 7: `tree` — filesystem walk into a node tree

**Files:**
- Modify: `src/vault/tree.rs`
- Test: `src/vault/tree.rs` tests

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `src/vault/tree.rs`:

```rust
    /// Collect every node name in the tree (depth-first) for assertions.
    fn names(node: &TreeNode, acc: &mut Vec<String>) {
        acc.push(node.name.clone());
        for c in &node.children {
            names(c, acc);
        }
    }

    #[test]
    fn build_excludes_dotfiles_and_clepsydra() {
        let (_dir, vault, index) = fixture();
        let meta = load_note_meta(&vault, &index).unwrap();
        let root = build(&vault, &meta);
        let mut all = Vec::new();
        names(&root, &mut all);
        assert!(!all.iter().any(|n| n == ".clepsydra"));
        assert!(!all.iter().any(|n| n.starts_with('.')));
        assert!(all.iter().any(|n| n == "Alpha.md"));
        assert!(all.iter().any(|n| n == "_attachments"));
        assert!(all.iter().any(|n| n == "diagram.png"));
    }

    #[test]
    fn build_classifies_note_and_file() {
        let (_dir, vault, index) = fixture();
        let meta = load_note_meta(&vault, &index).unwrap();
        let root = build(&vault, &meta);

        fn find<'a>(node: &'a TreeNode, name: &str) -> Option<&'a TreeNode> {
            if node.name == name {
                return Some(node);
            }
            node.children.iter().find_map(|c| find(c, name))
        }

        let alpha = find(&root, "Alpha.md").unwrap();
        assert!(matches!(alpha.entry, NodeEntry::Note(_)));
        let png = find(&root, "diagram.png").unwrap();
        assert!(matches!(png.entry, NodeEntry::File { .. }));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib vault::tree::tests::build_`
Expected: FAIL — `TreeNode`, `NodeEntry`, `build` not found.

- [ ] **Step 3: Write minimal implementation**

Add to `src/vault/tree.rs` (after the imports / `NoteMeta`):

```rust
/// What a tree node represents.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum NodeEntry {
    /// A directory.
    Dir,
    /// A file matching an indexed page, with its metadata.
    Note(NoteMeta),
    /// Any other regular file, with its size in bytes.
    File { size: u64 },
}

/// A single node in the rendered vault tree.
#[derive(Debug, Serialize)]
pub struct TreeNode {
    pub name: String,
    /// Vault-relative path (`/`-separated). Empty for the root node.
    pub path: String,
    #[serde(flatten)]
    pub entry: NodeEntry,
    pub children: Vec<TreeNode>,
}

/// Build the vault tree rooted at `vault.root()`. Skips dotfiles/dot-dirs and
/// `.clepsydra`. Files whose vault path is a key in `meta` become `Note`
/// nodes; other regular files become `File` nodes carrying their size.
pub fn build(vault: &Vault, meta: &HashMap<String, NoteMeta>) -> TreeNode {
    let root_path = vault.root().to_path_buf();
    let children = read_dir_sorted(&root_path, "", meta);
    TreeNode {
        name: vault
            .root()
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".to_string()),
        path: String::new(),
        entry: NodeEntry::Dir,
        children,
    }
}

/// Recursively read `abs_dir`, returning its child nodes. `rel_prefix` is the
/// vault-relative path of `abs_dir` (`""` at the root, else trailing-slash-free).
fn read_dir_sorted(
    abs_dir: &std::path::Path,
    rel_prefix: &str,
    meta: &HashMap<String, NoteMeta>,
) -> Vec<TreeNode> {
    let Ok(entries) = std::fs::read_dir(abs_dir) else {
        return Vec::new();
    };

    let mut dirs: Vec<TreeNode> = Vec::new();
    let mut files: Vec<TreeNode> = Vec::new();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Skip dotfiles/dot-dirs (covers .git, .clepsydra, .DS_Store, ...).
        if name.starts_with('.') {
            continue;
        }
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if file_type.is_dir() {
            let children = read_dir_sorted(&entry.path(), &rel, meta);
            dirs.push(TreeNode {
                name,
                path: rel,
                entry: NodeEntry::Dir,
                children,
            });
        } else if file_type.is_file() {
            let entry_kind = if let Some(m) = meta.get(&rel) {
                NodeEntry::Note(m.clone())
            } else {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                NodeEntry::File { size }
            };
            files.push(TreeNode {
                name,
                path: rel,
                entry: entry_kind,
                children: Vec::new(),
            });
        }
    }

    dirs.sort_by(|a, b| a.name.cmp(&b.name));
    files.sort_by(|a, b| a.name.cmp(&b.name));
    dirs.extend(files);
    dirs
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --lib vault::tree::tests::build_`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/vault/tree.rs
git commit -m "feat(tree): build node tree from filesystem walk"
```

---

## Task 8: `tree` — rendering (human + JSON)

**Files:**
- Modify: `src/vault/tree.rs`
- Test: `src/vault/tree.rs` tests

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `src/vault/tree.rs`:

```rust
    #[test]
    fn render_human_draws_branches_and_metadata() {
        let (_dir, vault, index) = fixture();
        let meta = load_note_meta(&vault, &index).unwrap();
        let root = build(&vault, &meta);
        let mut buf: Vec<u8> = Vec::new();
        render_human(&root, &mut buf).unwrap();
        let out = String::from_utf8(buf).unwrap();
        assert!(out.contains("Alpha.md"));
        assert!(out.contains("NOTE")); // kind tag
        assert!(out.contains("diagram.png"));
        assert!(out.contains("├──") || out.contains("└──")); // branch glyphs
    }

    #[test]
    fn render_json_round_trips() {
        let (_dir, vault, index) = fixture();
        let meta = load_note_meta(&vault, &index).unwrap();
        let root = build(&vault, &meta);
        let mut buf: Vec<u8> = Vec::new();
        render_json(&root, &mut buf).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&buf).unwrap();
        assert_eq!(v["type"], "dir");
        assert!(v["children"].is_array());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib vault::tree::tests::render`
Expected: FAIL — `render_human` / `render_json` not found.

- [ ] **Step 3: Write minimal implementation**

Add to `src/vault/tree.rs`. Extend the imports and add the renderers:

```rust
use std::io::{self, Write};

use owo_colors::OwoColorize;
```

```rust
/// Barbican orange — the Vessel primary accent (matches diagnostics).
const ACCENT: (u8, u8, u8) = (0xee, 0x77, 0x33);

/// Render the tree as styled, box-drawing text. The root line is the vault
/// directory name; children are drawn with `├──`/`└──` connectors. Wrap `w` in
/// `anstream::AutoStream` to honour `NO_COLOR` / non-TTY.
pub fn render_human(root: &TreeNode, w: &mut impl Write) -> io::Result<()> {
    writeln!(w, "{}", root.name.truecolor(ACCENT.0, ACCENT.1, ACCENT.2).bold())?;
    let count = root.children.len();
    for (i, child) in root.children.iter().enumerate() {
        render_node(child, "", i + 1 == count, w)?;
    }
    Ok(())
}

fn render_node(
    node: &TreeNode,
    prefix: &str,
    last: bool,
    w: &mut impl Write,
) -> io::Result<()> {
    let connector = if last { "└── " } else { "├── " };
    writeln!(w, "{prefix}{}{}", connector.dimmed(), node_label(node))?;
    let child_prefix = format!("{prefix}{}", if last { "    " } else { "│   " });
    let count = node.children.len();
    for (i, child) in node.children.iter().enumerate() {
        render_node(child, &child_prefix, i + 1 == count, w)?;
    }
    Ok(())
}

/// The styled label for a single node, excluding the tree connector.
fn node_label(node: &TreeNode) -> String {
    match &node.entry {
        NodeEntry::Dir => node
            .name
            .truecolor(ACCENT.0, ACCENT.1, ACCENT.2)
            .bold()
            .to_string(),
        NodeEntry::File { size } => {
            format!("{}  {}", node.name, human_size(*size).dimmed())
        }
        NodeEntry::Note(m) => {
            let mut s = node.name.clone();
            s.push(' ');
            s.push_str(&format!("[{}]", m.kind).dimmed().to_string());
            if let Some(t) = &m.title {
                if Some(t.as_str()) != node.name.strip_suffix(".md") {
                    s.push_str(&format!(" {t}"));
                }
            }
            if !m.tags.is_empty() {
                let tags = m.tags.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" ");
                s.push(' ');
                s.push_str(&tags.truecolor(ACCENT.0, ACCENT.1, ACCENT.2).to_string());
            }
            if let Some(wc) = m.word_count {
                s.push(' ');
                s.push_str(&format!("({wc}w)").dimmed().to_string());
            }
            s
        }
    }
}

/// Format a byte count as a short human-readable size (e.g. `1.2K`, `3.4M`).
fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "K", "M", "G", "T"];
    let mut size = bytes as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes}{}", UNITS[0])
    } else {
        format!("{size:.1}{}", UNITS[unit])
    }
}

/// Render the tree as pretty-printed JSON.
pub fn render_json(root: &TreeNode, w: &mut impl Write) -> io::Result<()> {
    serde_json::to_writer_pretty(&mut *w, root)?;
    writeln!(w)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --lib vault::tree::tests::render`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full tree module + clippy**

Run: `cargo test --lib vault::tree && cargo clippy`
Expected: all tree tests pass; no clippy warnings in `tree.rs`.

- [ ] **Step 6: Commit**

```bash
git add src/vault/tree.rs
git commit -m "feat(tree): add human and json renderers"
```

---

## Task 9: `tree` — CLI subcommand wiring

**Files:**
- Modify: `src/bin/cli.rs` (add variant + arm)
- Test: `src/bin/cli.rs` `cli_tests`

- [ ] **Step 1: Write the failing dispatch smoke test**

Add to the `cli_tests` module in `src/bin/cli.rs`:

```rust
    #[tokio::test]
    #[serial_test::serial]
    async fn tree_returns_zero() {
        let (_dir, root) = vault_in_tempdir();
        std::fs::write(root.join("Note.md"), "---\ntitle: Note\n---\nbody\n").unwrap();
        let cli = Cli::try_parse_from(["clepsydra", "tree"]).unwrap();
        let result = run_cli_in(&root, cli).await;
        assert_eq!(result.unwrap(), 0);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn tree_json_returns_zero() {
        let (_dir, root) = vault_in_tempdir();
        let cli = Cli::try_parse_from(["clepsydra", "tree", "--json"]).unwrap();
        let result = run_cli_in(&root, cli).await;
        assert_eq!(result.unwrap(), 0);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --bin clepsydra tree_`
Expected: FAIL — clap rejects the unknown `tree` subcommand.

- [ ] **Step 3: Add the subcommand variant**

In `src/bin/cli.rs`, inside `enum Commands`, add before `Version`:

```rust
    #[command(
        about = "List the vault tree with per-note metadata",
        long_about = "Walk the vault directory and print a tree. Indexed notes are annotated with their kind, title, tags, and word count; other files show their size. Dotfiles and the .clepsydra directory are hidden."
    )]
    Tree {
        #[arg(long, help = "Emit the tree as JSON instead of styled text")]
        json: bool,
    },
```

- [ ] **Step 4: Add the dispatch arm**

In `run_cli`, add before `Commands::Version`:

```rust
        Commands::Tree { json } => {
            let (vault, index) = open_vault_and_index()?;
            let meta = clepsydra::vault::tree::load_note_meta(&vault, &index)?;
            let root = clepsydra::vault::tree::build(&vault, &meta);
            if json {
                clepsydra::vault::tree::render_json(&root, &mut std::io::stdout().lock())?;
            } else {
                let mut stdout = anstream::AutoStream::auto(std::io::stdout().lock());
                clepsydra::vault::tree::render_human(&root, &mut stdout)?;
            }
            Ok(0)
        }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test --bin clepsydra tree_`
Expected: PASS (2 tests).

- [ ] **Step 6: Manual smoke check**

Run: `cargo run -- tree --help`
Expected: help text shows `--json`.

- [ ] **Step 7: Commit**

```bash
git add src/bin/cli.rs
git commit -m "feat(cli): add tree subcommand"
```

---

## Task 10: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `cargo test`
Expected: PASS — all tests including the new grep/tree module tests and CLI smoke tests.

- [ ] **Step 2: Lint + format**

Run: `cargo clippy --all-targets && cargo fmt --check`
Expected: no clippy warnings; formatting clean. If `cargo fmt --check` reports diffs, run `cargo fmt` and amend.

- [ ] **Step 3: End-to-end manual check against a real vault**

Run (from a directory with a `config.toml` pointing at a populated vault, or inside one):
```bash
cargo run -- grep "some phrase"
cargo run -- grep "some phrase" --json
cargo run -- tree
cargo run -- tree --json
```
Expected: `grep` prints ranked matches with highlighted snippets (or "no matches"); `--json` prints a valid JSON array. `tree` prints a box-drawing tree with note kinds/tags/word-counts and file sizes, no `.clepsydra` or dotfiles; `--json` prints a nested JSON tree.

- [ ] **Step 4: Commit any formatting fixes**

```bash
git add -A
git commit -m "chore: fmt/clippy cleanup for grep and tree"
```
(Skip if nothing changed.)
```

---

## Self-review notes

- **Spec coverage:** grep literal-quoting + `--raw` (Tasks 2–3, 5), grep limit default 20 (Task 5), grep human/JSON with `<mark>` accent + retained markers in JSON (Task 4); tree filesystem walk excluding dotfiles/`.clepsydra` (Task 7), note metadata kind/title/tags/dates/word-count (Task 6), other-file size (Tasks 7–8), tree human box-drawing + JSON nested (Task 8), both `--json` (Tasks 5, 9). All spec sections map to a task.
- **Types consistent:** `NoteMeta`, `NodeEntry`, `TreeNode`, `load_note_meta`, `build`, `render_human`, `render_json`, `run`, `fts_quote` used with identical signatures across tasks.
- **Index DB path:** test fixtures open `.clepsydra/cache.db` directly, matching `INDEX_DB_RELATIVE` in `src/lib.rs:30`.
