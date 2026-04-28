# Reference Intelligence UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enrich unresolved/ambiguous link handling with candidates, context snippets, disambiguation strategies, and a "create page from unresolved link" action — making broken references first-class navigable objects rather than opaque nulls.

**Architecture:** Extend `VaultIndex` with query methods that return candidates for unresolved links and context snippets for backlinks. Add a disambiguation strategy system (configurable per-vault) that ranks candidates. Add an API endpoint to create a page from an unresolved link and trigger re-resolution. Enrich existing endpoints (`/index/unresolved`, `/index/backlinks`) with richer response shapes.

**Tech Stack:** Rust (rusqlite, pulldown-cmark for context extraction), Axum API

---

## Context

### What Already Exists

The codebase has a working link resolution pipeline:

- **`resolve_links()`** (`src/vault/index.rs:433`): Iterates all unresolved links, matches `target_canonical` against `canonical_names` table. Resolves when exactly 1 match; leaves NULL when 0 or 2+.
- **`resolve_links_for_page()`** (`src/vault/index.rs:640`): Same logic scoped to a single page's outgoing + incoming links.
- **`/index/unresolved`** (`src/api/index_routes.rs:180`): Returns flat list of `{source_id, source_path, target_raw, target_canonical, kind}` — no distinction between 0-match and 2+-match, no candidate info.
- **`/index/ambiguous`** (`src/api/index_routes.rs:214`): Returns canonical names with 2+ pages, but doesn't connect them to the links that are affected.
- **`/index/backlinks/{*path}`** (`src/api/index_routes.rs:90`): Returns `Vec<PageSummary>` — no context snippet showing *how* the page is referenced.
- **`/index/outlinks/{*path}`** (`src/api/index_routes.rs:133`): Returns `Vec<OutlinkEntry>` with target_raw, target_path, target_id, kind.

### What This Plan Adds

1. **Enriched unresolved link response** — each unresolved link includes a `reason` ("no_match" vs "ambiguous") and a `candidates` list of matching pages with paths/titles.
2. **Backlinks with context** — each backlink includes a text snippet showing the surrounding sentence/paragraph where the link appears.
3. **Disambiguation strategies** — configurable ranking of candidates: `shortest_path`, `most_recent`, `closest_directory`. Stored in `.clepsydra/config.toml`.
4. **"Create from link" endpoint** — `POST /index/create-from-link` takes a source_id + span_start to identify an unresolved link, creates a page with that name, and re-resolves.

### Files Overview

| File | Action |
|------|--------|
| `src/vault/index.rs` | Add `unresolved_with_candidates()`, `backlinks_with_context()` query methods |
| `src/vault/context.rs` | New: extract surrounding text context for a link span |
| `src/vault/config.rs` | Add `disambiguation_strategy` to vault config |
| `src/vault/mod.rs` | Export `context` module |
| `src/api/index_routes.rs` | Enrich `/unresolved`, `/backlinks`, add `/create-from-link` |
| `tests/index_test.rs` | Tests for new index query methods |
| `tests/context_test.rs` | New: tests for context extraction |
| `tests/api_test.rs` | API integration tests for enriched endpoints |

---

### Task 1: Enriched Unresolved Links — Index Method

Add a method to `VaultIndex` that returns unresolved links with their resolution reason and candidate list.

**Files:**
- Modify: `src/vault/index.rs`
- Test: `tests/index_test.rs`

**Step 1: Write the failing test**

Add to `tests/index_test.rs`:

```rust
#[test]
fn unresolved_with_candidates_distinguishes_no_match_from_ambiguous() {
    // Setup: three pages
    // - alpha links to [[Beta]] (resolvable, 1 match)
    // - alpha links to [[Ghost]] (0 matches)
    // - alpha links to [[Design]] (ambiguous, 2 matches: delta and epsilon both have "Design" canonical)

    let alpha = r#"---
id: 00000000-0000-0000-0000-000000000060
title: Alpha
---
See [[Beta]], [[Ghost]], and [[Design]].
"#;
    let beta = r#"---
id: 00000000-0000-0000-0000-000000000061
title: Beta
---
Content.
"#;
    let delta = r#"---
id: 00000000-0000-0000-0000-000000000062
title: Design
---
First design page.
"#;
    let epsilon = r#"---
id: 00000000-0000-0000-0000-000000000063
title: Design
aliases: []
---
Second design page.
"#;

    let (_tmp, vault) = setup_vault(&[
        ("alpha.md", alpha),
        ("beta.md", beta),
        ("delta.md", delta),
        ("subdir/epsilon.md", epsilon),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let unresolved = index.unresolved_with_candidates().unwrap();

    // Should have 2 unresolved links: Ghost (no_match) and Design (ambiguous)
    assert_eq!(unresolved.len(), 2);

    let ghost_link = unresolved.iter().find(|u| u.target_raw == "Ghost").unwrap();
    assert_eq!(ghost_link.reason, UnresolvedReason::NoMatch);
    assert!(ghost_link.candidates.is_empty());

    let design_link = unresolved.iter().find(|u| u.target_raw == "Design").unwrap();
    assert_eq!(design_link.reason, UnresolvedReason::Ambiguous);
    assert_eq!(design_link.candidates.len(), 2);

    // Candidates should include both delta and epsilon
    let candidate_paths: Vec<&str> = design_link.candidates.iter().map(|c| c.path.as_str()).collect();
    assert!(candidate_paths.contains(&"delta.md"));
    assert!(candidate_paths.contains(&"subdir/epsilon.md"));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test unresolved_with_candidates_distinguishes -- --nocapture`
Expected: FAIL — `unresolved_with_candidates` method and types don't exist yet.

**Step 3: Write minimal implementation**

Add types and method to `src/vault/index.rs`:

```rust
/// Reason a link is unresolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnresolvedReason {
    /// No canonical name matched.
    NoMatch,
    /// Two or more pages share the canonical name.
    Ambiguous,
}

/// A candidate page for an ambiguous link.
#[derive(Debug, Clone)]
pub struct LinkCandidate {
    pub page_id: String,
    pub path: String,
    pub title: Option<String>,
}

/// An unresolved link with diagnostic info.
#[derive(Debug, Clone)]
pub struct UnresolvedLinkDetail {
    pub source_id: String,
    pub source_path: String,
    pub target_raw: String,
    pub target_canonical: Option<String>,
    pub kind: String,
    pub span_start: i64,
    pub reason: UnresolvedReason,
    pub candidates: Vec<LinkCandidate>,
}
```

Implement `unresolved_with_candidates()` on `VaultIndex`:

```rust
/// Query all unresolved links, enriched with reason and candidates.
///
/// For each link with `target_id IS NULL`:
/// - If `target_canonical` matches 0 rows in `canonical_names` → `NoMatch`
/// - If `target_canonical` matches 2+ rows → `Ambiguous` with candidate list
pub fn unresolved_with_candidates(&self) -> Result<Vec<UnresolvedLinkDetail>, IndexError> {
    let mut stmt = self.conn.prepare(
        "SELECT l.source_id, p.path, l.target_raw, l.target_canonical, l.kind, l.span_start
         FROM links l
         JOIN pages p ON l.source_id = p.id
         WHERE l.target_id IS NULL",
    )?;

    let rows: Vec<(String, String, String, Option<String>, String, i64)> = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .collect();

    let mut results = Vec::new();

    for (source_id, source_path, target_raw, target_canonical, kind, span_start) in rows {
        let (reason, candidates) = if let Some(ref tc) = target_canonical {
            let mut lookup = self.conn.prepare(
                "SELECT cn.page_id, p.path, p.title
                 FROM canonical_names cn
                 JOIN pages p ON p.id = cn.page_id
                 WHERE cn.canonical_name = ?1",
            )?;
            let matches: Vec<LinkCandidate> = lookup
                .query_map(params![tc], |row| {
                    Ok(LinkCandidate {
                        page_id: row.get(0)?,
                        path: row.get(1)?,
                        title: row.get(2)?,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();

            if matches.is_empty() {
                (UnresolvedReason::NoMatch, Vec::new())
            } else {
                // 2+ matches (1 match would have been resolved already)
                (UnresolvedReason::Ambiguous, matches)
            }
        } else {
            (UnresolvedReason::NoMatch, Vec::new())
        };

        results.push(UnresolvedLinkDetail {
            source_id,
            source_path,
            target_raw,
            target_canonical,
            kind,
            span_start,
            reason,
            candidates,
        });
    }

    Ok(results)
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test unresolved_with_candidates_distinguishes -- --nocapture`
Expected: PASS

**Step 5: Commit**

```bash
git add src/vault/index.rs tests/index_test.rs
git commit -m "feat(vault): add unresolved_with_candidates() with reason and candidate list"
```

---

### Task 2: Backlink Context Extraction

Add a module that extracts a surrounding text snippet for a link at a given byte span within a Markdown body.

**Files:**
- Create: `src/vault/context.rs`
- Modify: `src/vault/mod.rs`
- Test: `tests/context_test.rs`

**Step 1: Write the failing tests**

Create `tests/context_test.rs`:

```rust
use clepsydra::vault::context::extract_context;

#[test]
fn extracts_sentence_around_link() {
    let body = "Some preamble.\n\nThis paragraph mentions [[Alpha]] in the middle of a sentence. More text follows.\n\nAnother paragraph.";
    // [[Alpha]] starts at byte offset of the '[[' characters
    let link_start = body.find("[[Alpha]]").unwrap();
    let link_end = link_start + "[[Alpha]]".len();

    let snippet = extract_context(body, link_start..link_end, 100);

    assert!(snippet.contains("[[Alpha]]"));
    assert!(snippet.contains("mentions"));
    assert!(!snippet.contains("preamble"), "should not include other paragraphs");
}

#[test]
fn truncates_long_context_with_ellipsis() {
    let body = "A very long paragraph that goes on and on before mentioning [[Target]] and then continues with more and more text that extends well past the context window limit we set.";
    let link_start = body.find("[[Target]]").unwrap();
    let link_end = link_start + "[[Target]]".len();

    let snippet = extract_context(body, link_start..link_end, 60);

    assert!(snippet.len() <= 70); // some slack for ellipsis
    assert!(snippet.contains("[[Target]]"));
}

#[test]
fn handles_link_at_start_of_body() {
    let body = "[[Alpha]] starts this paragraph.";
    let snippet = extract_context(body, 0.."[[Alpha]]".len(), 100);
    assert!(snippet.starts_with("[[Alpha]]"));
}

#[test]
fn handles_link_at_end_of_body() {
    let body = "Paragraph ending with [[Alpha]]";
    let link_start = body.find("[[Alpha]]").unwrap();
    let link_end = link_start + "[[Alpha]]".len();
    let snippet = extract_context(body, link_start..link_end, 100);
    assert!(snippet.ends_with("[[Alpha]]"));
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test context_test`
Expected: FAIL — module doesn't exist.

**Step 3: Write minimal implementation**

Create `src/vault/context.rs`:

```rust
use std::ops::Range;

/// Extract a text snippet surrounding a link at `span` in `body`.
///
/// Strategy:
/// 1. Find the paragraph containing the span (split on `\n\n`).
/// 2. If the paragraph fits within `max_chars`, return it.
/// 3. Otherwise, center a window of `max_chars` on the span, trimming
///    to word boundaries and adding `…` at truncation points.
pub fn extract_context(body: &str, span: Range<usize>, max_chars: usize) -> String {
    // Find paragraph boundaries: look for \n\n before and after the span
    let para_start = body[..span.start]
        .rfind("\n\n")
        .map(|i| i + 2)
        .unwrap_or(0);

    let para_end = body[span.end..]
        .find("\n\n")
        .map(|i| span.end + i)
        .unwrap_or(body.len());

    let paragraph = &body[para_start..para_end];

    if paragraph.len() <= max_chars {
        return paragraph.to_string();
    }

    // The span's position relative to the paragraph
    let rel_start = span.start - para_start;
    let rel_end = span.end - para_start;

    // Center a window around the link
    let link_len = rel_end - rel_start;
    let budget = max_chars.saturating_sub(link_len);
    let before_budget = budget / 2;
    let after_budget = budget - before_budget;

    let window_start = rel_start.saturating_sub(before_budget);
    let window_end = (rel_end + after_budget).min(paragraph.len());

    // Snap to word boundaries (don't cut mid-word)
    let snapped_start = if window_start > 0 {
        paragraph[window_start..]
            .find(' ')
            .map(|i| window_start + i + 1)
            .unwrap_or(window_start)
    } else {
        0
    };

    let snapped_end = if window_end < paragraph.len() {
        paragraph[..window_end]
            .rfind(' ')
            .unwrap_or(window_end)
    } else {
        paragraph.len()
    };

    let mut result = String::new();
    if snapped_start > 0 {
        result.push_str("…");
    }
    result.push_str(&paragraph[snapped_start..snapped_end]);
    if snapped_end < paragraph.len() {
        result.push_str("…");
    }

    result
}
```

Add to `src/vault/mod.rs`:

```rust
pub mod context;
```

**Step 4: Run tests to verify they pass**

Run: `cargo test --test context_test`
Expected: PASS

**Step 5: Commit**

```bash
git add src/vault/context.rs src/vault/mod.rs tests/context_test.rs
git commit -m "feat(vault): add context extraction for link snippets"
```

---

### Task 3: Backlinks with Context — Index Method

Add a method to `VaultIndex` that returns backlinks enriched with the text context where the link appears.

**Files:**
- Modify: `src/vault/index.rs`
- Test: `tests/index_test.rs`

**Step 1: Write the failing test**

Add to `tests/index_test.rs`:

```rust
#[test]
fn backlinks_with_context_returns_snippets() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000070
title: Alpha
---
First paragraph.

This paragraph links to [[Beta]] in context.

Last paragraph.
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000071
title: Beta
---
Content here.
"#;

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let backlinks = index
        .backlinks_with_context(&vault, &VaultPath::new("beta.md").unwrap(), 200)
        .unwrap();

    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0].source_path, "alpha.md");
    assert!(
        backlinks[0].context.contains("[[Beta]]"),
        "context should contain the link text, got: {}",
        backlinks[0].context
    );
    assert!(
        backlinks[0].context.contains("links to"),
        "context should contain surrounding words"
    );
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test backlinks_with_context_returns_snippets -- --nocapture`
Expected: FAIL — method and types don't exist.

**Step 3: Write minimal implementation**

Add types and method to `src/vault/index.rs`:

```rust
use super::context::extract_context;

/// A backlink entry with surrounding text context.
#[derive(Debug, Clone)]
pub struct BacklinkWithContext {
    pub source_id: String,
    pub source_path: String,
    pub source_title: Option<String>,
    pub target_raw: String,
    pub kind: String,
    pub context: String,
}

impl VaultIndex {
    /// Find all pages that link to `vault_path`, returning each link with a
    /// text snippet showing the surrounding context.
    ///
    /// `max_context_chars` controls the maximum length of each snippet.
    /// Only body links (wiki, markdown) get context; property_ref links get
    /// the source field name as context instead.
    pub fn backlinks_with_context(
        &self,
        vault: &Vault,
        vault_path: &VaultPath,
        max_context_chars: usize,
    ) -> Result<Vec<BacklinkWithContext>, IndexError> {
        let stem = vault_path.stem();
        let target_canonical = CanonicalName::new(stem);

        // Find the page_id for resolved-link matching
        let page_id: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM pages WHERE path = ?1",
                params![vault_path.as_str()],
                |row| row.get(0),
            )
            .ok();

        // Query links that point to this page (by resolved target_id or unresolved target_canonical)
        let mut stmt = self.conn.prepare(
            "SELECT l.source_id, p.path, p.title, l.target_raw, l.kind, l.source_field, l.span_start, l.span_end
             FROM links l
             JOIN pages p ON l.source_id = p.id
             WHERE l.target_path = ?1 OR l.target_canonical = ?2
                   OR (?3 IS NOT NULL AND l.target_id = ?3)",
        )?;

        let page_id_param = page_id.as_deref();

        let rows: Vec<(String, String, Option<String>, String, String, Option<String>, i64, i64)> = stmt
            .query_map(
                params![vault_path.as_str(), target_canonical.as_str(), page_id_param],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )?
            .filter_map(|r| r.ok())
            .collect();

        let mut results = Vec::new();

        for (source_id, source_path, source_title, target_raw, kind, source_field, span_start, span_end) in rows {
            let context = if kind == "property_ref" {
                // For property refs, show the field name
                format!("frontmatter field: {}", source_field.as_deref().unwrap_or("unknown"))
            } else if span_start >= 0 {
                // Read the source page body and extract context
                let source_vp = VaultPath::new(&source_path);
                if let Ok(ref vp) = source_vp {
                    let abs_path = vault.resolve(vp);
                    if let Ok(content) = std::fs::read_to_string(&abs_path) {
                        // Body starts after frontmatter; find the body offset
                        let body_start = find_body_start(&content);
                        let abs_span_start = body_start + span_start as usize;
                        let abs_span_end = body_start + span_end as usize;
                        if abs_span_end <= content.len() {
                            extract_context(&content[body_start..], span_start as usize..span_end as usize, max_context_chars)
                        } else {
                            target_raw.clone()
                        }
                    } else {
                        target_raw.clone()
                    }
                } else {
                    target_raw.clone()
                }
            } else {
                // Negative span_start = property ref (shouldn't reach here due to kind check)
                target_raw.clone()
            };

            results.push(BacklinkWithContext {
                source_id,
                source_path,
                source_title,
                target_raw,
                kind,
                context,
            });
        }

        Ok(results)
    }
}

/// Find the byte offset where the body starts (after the frontmatter `---` fences).
fn find_body_start(content: &str) -> usize {
    if !content.starts_with("---") {
        return 0;
    }
    // Find the closing `---`
    if let Some(end_fence) = content[3..].find("\n---") {
        let fence_end = 3 + end_fence + 4; // skip past "\n---"
        // Skip the newline after the closing fence
        if fence_end < content.len() && content.as_bytes()[fence_end] == b'\n' {
            fence_end + 1
        } else {
            fence_end
        }
    } else {
        0
    }
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test backlinks_with_context_returns_snippets -- --nocapture`
Expected: PASS

**Step 5: Commit**

```bash
git add src/vault/index.rs tests/index_test.rs
git commit -m "feat(vault): add backlinks_with_context() returning link snippets"
```

---

### Task 4: Disambiguation Strategy Configuration

Add a configurable disambiguation strategy to vault config that ranks candidates for ambiguous links.

**Files:**
- Modify: `src/vault/config.rs`
- Modify: `src/vault/index.rs`
- Test: `tests/index_test.rs`

**Step 1: Write the failing test**

Add to `tests/index_test.rs`:

```rust
use clepsydra::vault::config::DisambiguationStrategy;

#[test]
fn candidates_ranked_by_shortest_path() {
    // Two pages with the same canonical name "design"
    // One at root, one nested — shortest_path should rank root first
    let alpha = r#"---
id: 00000000-0000-0000-0000-000000000080
title: Alpha
---
Link to [[Design]].
"#;
    let design_root = r#"---
id: 00000000-0000-0000-0000-000000000081
title: Design
---
Root design.
"#;
    let design_nested = r#"---
id: 00000000-0000-0000-0000-000000000082
title: Design
---
Nested design.
"#;

    let (_tmp, vault) = setup_vault(&[
        ("alpha.md", alpha),
        ("design.md", design_root),
        ("projects/deep/design.md", design_nested),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let unresolved = index.unresolved_with_candidates().unwrap();
    let design_link = unresolved.iter().find(|u| u.target_raw == "Design").unwrap();

    let ranked = index.rank_candidates(
        &design_link.candidates,
        "alpha.md",
        DisambiguationStrategy::ShortestPath,
    );

    assert_eq!(ranked[0].path, "design.md", "shortest path should rank first");
}

#[test]
fn candidates_ranked_by_closest_directory() {
    let alpha = r#"---
id: 00000000-0000-0000-0000-000000000083
title: Alpha
---
Link to [[Design]].
"#;
    let design_root = r#"---
id: 00000000-0000-0000-0000-000000000084
title: Design
---
Root design.
"#;
    let design_same_dir = r#"---
id: 00000000-0000-0000-0000-000000000085
title: Design
---
Same dir design.
"#;

    let (_tmp, vault) = setup_vault(&[
        ("notes/alpha.md", alpha),
        ("design.md", design_root),
        ("notes/design.md", design_same_dir),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let unresolved = index.unresolved_with_candidates().unwrap();
    let design_link = unresolved.iter().find(|u| u.target_raw == "Design").unwrap();

    let ranked = index.rank_candidates(
        &design_link.candidates,
        "notes/alpha.md",
        DisambiguationStrategy::ClosestDirectory,
    );

    assert_eq!(ranked[0].path, "notes/design.md", "same directory should rank first");
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test candidates_ranked_by -- --nocapture`
Expected: FAIL — `DisambiguationStrategy` and `rank_candidates` don't exist.

**Step 3: Write minimal implementation**

Add to `src/vault/config.rs` (alongside existing config types):

```rust
/// Strategy for ranking candidates when a link is ambiguous.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisambiguationStrategy {
    /// Prefer the page with the shortest vault-relative path.
    #[default]
    ShortestPath,
    /// Prefer the page closest in directory hierarchy to the source page.
    ClosestDirectory,
    /// Prefer the most recently updated page.
    MostRecent,
}
```

Add `disambiguation_strategy` field to the vault config struct (wherever `VaultConfig` is defined — check the existing struct in `config.rs`):

```rust
// In the VaultConfig struct:
#[serde(default)]
pub disambiguation_strategy: DisambiguationStrategy,
```

Add `rank_candidates` to `VaultIndex` in `src/vault/index.rs`:

```rust
use super::config::DisambiguationStrategy;

impl VaultIndex {
    /// Rank a list of candidates according to the given disambiguation strategy.
    ///
    /// `source_path` is the vault-relative path of the page containing the
    /// unresolved link (used by ClosestDirectory strategy).
    ///
    /// Returns a new Vec sorted by preference (best match first).
    pub fn rank_candidates(
        &self,
        candidates: &[LinkCandidate],
        source_path: &str,
        strategy: DisambiguationStrategy,
    ) -> Vec<LinkCandidate> {
        let mut ranked = candidates.to_vec();

        match strategy {
            DisambiguationStrategy::ShortestPath => {
                ranked.sort_by_key(|c| c.path.len());
            }
            DisambiguationStrategy::ClosestDirectory => {
                let source_dir = source_path
                    .rfind('/')
                    .map(|i| &source_path[..i])
                    .unwrap_or("");
                ranked.sort_by_key(|c| {
                    let cand_dir = c.path.rfind('/').map(|i| &c.path[..i]).unwrap_or("");
                    common_prefix_len(source_dir, cand_dir)
                });
                ranked.reverse(); // Highest common prefix first
            }
            DisambiguationStrategy::MostRecent => {
                // Query updated_at from pages table for each candidate
                ranked.sort_by(|a, b| {
                    let ts_a: Option<String> = self
                        .conn
                        .query_row(
                            "SELECT updated_at FROM pages WHERE id = ?1",
                            params![a.page_id],
                            |row| row.get(0),
                        )
                        .ok()
                        .flatten();
                    let ts_b: Option<String> = self
                        .conn
                        .query_row(
                            "SELECT updated_at FROM pages WHERE id = ?1",
                            params![b.page_id],
                            |row| row.get(0),
                        )
                        .ok()
                        .flatten();
                    ts_b.cmp(&ts_a) // Descending — most recent first
                });
            }
        }

        ranked
    }
}

/// Count the length of the common directory prefix between two paths.
fn common_prefix_len(a: &str, b: &str) -> usize {
    a.split('/')
        .zip(b.split('/'))
        .take_while(|(x, y)| x == y)
        .count()
}
```

**Step 4: Run tests to verify they pass**

Run: `cargo test candidates_ranked_by -- --nocapture`
Expected: PASS

**Step 5: Commit**

```bash
git add src/vault/config.rs src/vault/index.rs tests/index_test.rs
git commit -m "feat(vault): add disambiguation strategies for ranking ambiguous link candidates"
```

---

### Task 5: Enriched Unresolved Links API Endpoint

Update the `/index/unresolved` endpoint to return the enriched response with reasons, candidates, and rankings.

**Files:**
- Modify: `src/api/index_routes.rs`
- Test: `tests/api_test.rs`

**Step 1: Write the failing test**

Add to `tests/api_test.rs`:

```rust
#[tokio::test]
async fn unresolved_endpoint_includes_candidates() {
    // Create two pages with same title (ambiguous) and one link to them
    let linker = r#"---
id: 00000000-0000-0000-0000-000000000090
title: Linker
---
See [[Ambig]].
"#;
    let ambig_a = r#"---
id: 00000000-0000-0000-0000-000000000091
title: Ambig
---
First.
"#;
    let ambig_b = r#"---
id: 00000000-0000-0000-0000-000000000092
title: Ambig
---
Second.
"#;

    let app = setup_test_app(&[
        ("linker.md", linker),
        ("ambig-a.md", ambig_a),
        ("subdir/ambig-b.md", ambig_b),
    ]);

    let resp = app.get("/api/vault/index/unresolved").await;
    resp.assert_status_ok();

    let body: serde_json::Value = resp.json();
    let items = body.as_array().unwrap();

    // Find the link to "Ambig"
    let ambig_item = items
        .iter()
        .find(|item| item["target_raw"].as_str() == Some("Ambig"))
        .expect("should find unresolved link to Ambig");

    assert_eq!(ambig_item["reason"], "ambiguous");

    let candidates = ambig_item["candidates"].as_array().unwrap();
    assert_eq!(candidates.len(), 2);

    // Candidates should have path and title
    assert!(candidates.iter().any(|c| c["path"].as_str() == Some("ambig-a.md")));
    assert!(candidates.iter().any(|c| c["path"].as_str() == Some("subdir/ambig-b.md")));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test unresolved_endpoint_includes_candidates -- --nocapture`
Expected: FAIL — the current `/index/unresolved` endpoint returns the old flat shape.

**Step 3: Write minimal implementation**

In `src/api/index_routes.rs`, update the response type and handler:

```rust
#[derive(Debug, Serialize)]
struct UnresolvedLink {
    source_id: String,
    source_path: String,
    target_raw: String,
    target_canonical: Option<String>,
    kind: String,
    span_start: i64,
    reason: String,              // "no_match" or "ambiguous"
    candidates: Vec<CandidateEntry>,
}

#[derive(Debug, Serialize)]
struct CandidateEntry {
    page_id: String,
    path: String,
    title: Option<String>,
}
```

Replace the `unresolved()` handler to use the new index method:

```rust
async fn unresolved(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<UnresolvedLink>>, ApiError> {
    let index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    let details = index
        .unresolved_with_candidates()
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let strategy = state.vault.config().vault.disambiguation_strategy;

    let links: Vec<UnresolvedLink> = details
        .into_iter()
        .map(|d| {
            let ranked_candidates = if !d.candidates.is_empty() {
                index.rank_candidates(&d.candidates, &d.source_path, strategy)
            } else {
                Vec::new()
            };

            UnresolvedLink {
                source_id: d.source_id,
                source_path: d.source_path,
                target_raw: d.target_raw,
                target_canonical: d.target_canonical,
                kind: d.kind,
                span_start: d.span_start,
                reason: match d.reason {
                    crate::vault::index::UnresolvedReason::NoMatch => "no_match".to_string(),
                    crate::vault::index::UnresolvedReason::Ambiguous => "ambiguous".to_string(),
                },
                candidates: ranked_candidates
                    .into_iter()
                    .map(|c| CandidateEntry {
                        page_id: c.page_id,
                        path: c.path,
                        title: c.title,
                    })
                    .collect(),
            }
        })
        .collect();

    Ok(Json(links))
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test unresolved_endpoint_includes_candidates -- --nocapture`
Expected: PASS

Also run: `cargo test` to make sure no existing tests broke (the response shape changed).

**Step 5: Commit**

```bash
git add src/api/index_routes.rs tests/api_test.rs
git commit -m "feat(api): enrich /index/unresolved with reason and ranked candidates"
```

---

### Task 6: Backlinks with Context API Endpoint

Update the `/index/backlinks/{*path}` endpoint to return context snippets.

**Files:**
- Modify: `src/api/index_routes.rs`
- Test: `tests/api_test.rs`

**Step 1: Write the failing test**

Add to `tests/api_test.rs`:

```rust
#[tokio::test]
async fn backlinks_endpoint_includes_context() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000095
title: Alpha
---
First paragraph here.

This line references [[Beta]] explicitly.

Final paragraph.
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000096
title: Beta
---
Just content.
"#;

    let app = setup_test_app(&[("alpha.md", page_a), ("beta.md", page_b)]);

    let resp = app.get("/api/vault/index/backlinks/beta.md").await;
    resp.assert_status_ok();

    let body: serde_json::Value = resp.json();
    let items = body.as_array().unwrap();
    assert_eq!(items.len(), 1);

    let item = &items[0];
    assert_eq!(item["source_path"], "alpha.md");
    assert!(item["context"].as_str().unwrap().contains("[[Beta]]"));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test backlinks_endpoint_includes_context -- --nocapture`
Expected: FAIL — current backlinks endpoint returns `PageSummary` (no context field).

**Step 3: Write minimal implementation**

In `src/api/index_routes.rs`, add a new response type and update the handler:

```rust
#[derive(Debug, Serialize)]
struct BacklinkEntry {
    source_id: String,
    source_path: String,
    source_title: Option<String>,
    target_raw: String,
    kind: String,
    context: String,
}
```

Replace the `backlinks()` handler:

```rust
async fn backlinks(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
) -> Result<Json<Vec<BacklinkEntry>>, ApiError> {
    let vault_path =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    let backlinks = index
        .backlinks_with_context(&state.vault, &vault_path, 200)
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let entries: Vec<BacklinkEntry> = backlinks
        .into_iter()
        .map(|bl| BacklinkEntry {
            source_id: bl.source_id,
            source_path: bl.source_path,
            source_title: bl.source_title,
            target_raw: bl.target_raw,
            kind: bl.kind,
            context: bl.context,
        })
        .collect();

    Ok(Json(entries))
}
```

Note: the `backlinks()` handler now returns `Vec<BacklinkEntry>` instead of `Vec<PageSummary>`. The `PageSummary` import from `super::pages` may still be needed for other handlers — don't remove it unless unused elsewhere. The `delete_page` handler in `pages.rs` uses `find_backlink_pages()` directly, not this endpoint, so the response change is safe.

**Step 4: Run test to verify it passes**

Run: `cargo test backlinks_endpoint_includes_context -- --nocapture`
Expected: PASS

Also run: `cargo test` to ensure no existing tests broke. The `index_backlinks` test in `api_test.rs` will need updating to match the new shape (it currently expects `PageSummary` fields like `id`, `path`, `title`, `canonical_name` — update it to expect the new `BacklinkEntry` shape).

**Step 5: Commit**

```bash
git add src/api/index_routes.rs tests/api_test.rs
git commit -m "feat(api): enrich /index/backlinks with context snippets"
```

---

### Task 7: Create Page from Unresolved Link

Add a `POST /index/create-from-link` endpoint that creates a page from an unresolved link, then re-resolves affected links.

**Files:**
- Modify: `src/api/index_routes.rs`
- Test: `tests/api_test.rs`

**Step 1: Write the failing test**

Add to `tests/api_test.rs`:

```rust
#[tokio::test]
async fn create_from_link_creates_page_and_resolves() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000097
title: Alpha
---
See [[Nonexistent]].
"#;

    let app = setup_test_app(&[("alpha.md", page_a)]);

    // Verify the link is unresolved
    let resp = app.get("/api/vault/index/unresolved").await;
    let body: serde_json::Value = resp.json();
    let items = body.as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["target_raw"], "Nonexistent");
    assert_eq!(items[0]["reason"], "no_match");

    // Create page from the unresolved link
    let create_body = serde_json::json!({
        "target_raw": "Nonexistent",
        "folder": ""
    });
    let resp = app
        .post("/api/vault/index/create-from-link")
        .json(&create_body)
        .await;
    resp.assert_status(axum::http::StatusCode::CREATED);

    let created: serde_json::Value = resp.json();
    assert_eq!(created["title"], "Nonexistent");
    assert!(created["path"].as_str().unwrap().ends_with(".md"));

    // Verify the link is now resolved
    let resp = app.get("/api/vault/index/unresolved").await;
    let body: serde_json::Value = resp.json();
    let items = body.as_array().unwrap();
    assert!(
        items.is_empty() || !items.iter().any(|i| i["target_raw"] == "Nonexistent"),
        "link should be resolved after page creation"
    );
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test create_from_link_creates_page_and_resolves -- --nocapture`
Expected: FAIL — endpoint doesn't exist.

**Step 3: Write minimal implementation**

Add route to the router in `src/api/index_routes.rs`:

```rust
.route("/create-from-link", post(create_from_link))
```

Add request type and handler:

```rust
#[derive(Debug, Deserialize)]
struct CreateFromLinkRequest {
    /// The raw target text of the unresolved link (e.g. "Nonexistent").
    target_raw: String,
    /// Optional folder to place the new page in (default: vault root).
    #[serde(default)]
    folder: String,
    /// Optional body content for the new page.
    body: Option<String>,
}

async fn create_from_link(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateFromLinkRequest>,
) -> Result<Response, ApiError> {
    // 1. Generate a vault path from the target_raw text
    let filename = VaultPath::from_title(&req.target_raw)
        .map_err(|e| ApiError::bad_request(format!("invalid title: {e}")))?;

    let vault_path = if req.folder.is_empty() {
        filename
    } else {
        let folder_prefix = req.folder.trim_end_matches('/');
        VaultPath::new(&format!("{}/{}", folder_prefix, filename.as_str()))
            .map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?
    };

    let abs_path = state.vault.resolve(&vault_path);
    if abs_path.exists() {
        return Err(ApiError::conflict(format!(
            "page already exists: {}",
            vault_path.as_str()
        )));
    }

    // 2. Create parent directories
    if let Some(parent) = abs_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| ApiError::internal(format!("failed to create directories: {e}")))?;
    }

    // 3. Build page with title = target_raw
    let mut meta = PageMeta::new();
    meta.title = Some(req.target_raw.clone());

    let page_body = req.body.unwrap_or_default();
    let content = write_page_content(&meta, &page_body);
    std::fs::write(&abs_path, &content)
        .map_err(|e| ApiError::internal(format!("failed to write file: {e}")))?;

    // 4. Index the new page and re-resolve links
    {
        let mut index = state
            .index
            .lock()
            .map_err(|_| ApiError::internal("index lock poisoned"))?;

        index
            .index_page(&state.vault, &vault_path)
            .map_err(|e| ApiError::internal(format!("index failed: {e}")))?;

        index
            .resolve_links_for_page(&vault_path)
            .map_err(|e| ApiError::internal(format!("link resolution failed: {e}")))?;
    }

    // 5. Return the created page detail
    let canonical = CanonicalName::from_title(&req.target_raw);

    Ok((
        StatusCode::CREATED,
        Json(PageDetail {
            path: vault_path.as_str().to_string(),
            canonical_name: canonical.as_str().to_string(),
            meta,
            body: page_body,
        }),
    )
        .into_response())
}
```

Note: this handler uses `PageMeta::new()`, `write_page_content`, `VaultPath::from_title()`, and the page detail response type. These are imported from the pages module. Add any necessary imports:

```rust
use crate::vault::page::{PageMeta, write_page_content};
use super::pages::PageDetail;
```

**Step 4: Run test to verify it passes**

Run: `cargo test create_from_link_creates_page_and_resolves -- --nocapture`
Expected: PASS

**Step 5: Commit**

```bash
git add src/api/index_routes.rs tests/api_test.rs
git commit -m "feat(api): add POST /index/create-from-link to create pages from unresolved links"
```

---

### Task 8: Full Test Suite & Clippy Pass

Ensure all tests pass, no clippy warnings, and the response shape changes don't break existing tests.

**Files:**
- Modify: `tests/api_test.rs` (fix any broken tests from response shape changes)
- Potentially modify: `tests/e2e_test.rs`

**Step 1: Run the full test suite**

Run: `cargo test`
Identify any tests broken by the response shape changes in Tasks 5-6.

**Step 2: Fix broken tests**

The `index_backlinks` test in `api_test.rs` likely expects the old `PageSummary` shape. Update it to expect the new `BacklinkEntry` shape:

```rust
// Old assertion (example):
//   assert_eq!(items[0]["id"], "...");
//   assert_eq!(items[0]["canonical_name"], "...");
// New assertion:
//   assert_eq!(items[0]["source_path"], "...");
//   assert!(items[0]["context"].as_str().is_some());
```

Similarly, any test that calls `/index/unresolved` and checks the response shape needs updating for the new fields (`reason`, `candidates`, `span_start`).

**Step 3: Run clippy**

Run: `cargo clippy -- -W clippy::all`
Fix any warnings.

**Step 4: Run full test suite one more time**

Run: `cargo test`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "fix: update tests for enriched unresolved/backlinks response shapes"
```
