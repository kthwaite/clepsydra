# LSP Block-Reference Depth Implementation Plan (Phase A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach `clep lsp` block-reference intelligence (completion, hover, goto-definition, references), add a backlinks line to page hover, and add date-word wikilink completion.

**Architecture:** All features are read-only projections of the LSP's private in-memory SQLite index — standard LSP methods only, no custom protocol. Handlers in `src/lsp/mod.rs` dispatch on `LinkKind` under the cursor; pure text/format helpers live in `completion.rs` and `hover.rs`; shared SQL lives in `queries.rs`.

**Tech Stack:** Rust 2024, tower-lsp, rusqlite (in-memory index), ropey, chrono.

**Spec:** `docs/superpowers/specs/2026-08-26-neovim-plugin-design.md` (Component 1).

## Global Constraints

- ADR 0001: the LSP process never writes vault files. Every new handler path is read-only.
- Position encoding is UTF-8 (`PositionEncodingKind::UTF8`); all `character` offsets are byte offsets within the line.
- Block IDs are 10–12 ASCII alphanumeric chars, authored as a trailing ` ^<id>` on a block, referenced as `((<id>))` (`src/vault/block.rs`, `src/vault/link.rs`).
- Encrypted bodies expose nothing: completion/hover/definition/references must keep returning `None` for encrypted documents (existing guards; do not remove them).
- Do NOT run repo-wide `cargo fmt` — develop is not fmt-clean. Run `cargo fmt -- <touched files>` only.
- Work on branch `feature/lsp-block-refs` off `develop`. If using a fresh worktree, `cargo test` needs `ui/dist` to exist (rust-embed); copy it from the main checkout or run `cd ui && bun run build` once.
- Run a task's tests with `cargo test --lib lsp:: -- <test_name>`; the full gate at the end is `cargo test && cargo clippy`.

---

### Task 1: `block_ref_prefix` detection

**Files:**
- Modify: `src/lsp/completion.rs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `pub fn block_ref_prefix(line_text: &str, character: usize) -> Option<String>` — the text between the last unclosed `((` and the cursor. Task 2 calls it from the completion handler.

- [ ] **Step 1: Create the branch**

```bash
git checkout develop && git checkout -b feature/lsp-block-refs
```

- [ ] **Step 2: Write the failing tests**

Append to the `tests` module in `src/lsp/completion.rs`:

```rust
    // ---- block_ref_prefix tests ----

    #[test]
    fn block_ref_empty_prefix() {
        assert_eq!(block_ref_prefix("see ((", 6), Some("".to_string()));
    }

    #[test]
    fn block_ref_partial_prefix() {
        assert_eq!(block_ref_prefix("see ((meet", 10), Some("meet".to_string()));
    }

    #[test]
    fn block_ref_no_context() {
        assert_eq!(block_ref_prefix("plain text", 10), None);
    }

    #[test]
    fn block_ref_closed() {
        assert_eq!(block_ref_prefix("((abc123XYZ99)) more", 20), None);
    }

    #[test]
    fn block_ref_single_paren() {
        assert_eq!(block_ref_prefix("call (arg", 9), None);
    }

    #[test]
    fn block_ref_mid_codepoint_offset_is_safe() {
        // Offset 1 is mid-codepoint of 你 (3 bytes) — must not panic.
        assert!(block_ref_prefix("你((x", 1).is_none());
    }
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test --lib lsp::completion -- block_ref`
Expected: FAIL — `block_ref_prefix` not found.

- [ ] **Step 4: Implement**

Add to `src/lsp/completion.rs` after `wikilink_prefix` (mirror its shape):

```rust
/// Detect if the cursor is in a block-reference context.
/// Returns the filter prefix (text between `((` and cursor) if found.
pub fn block_ref_prefix(line_text: &str, character: usize) -> Option<String> {
    let end = clamp_to_char_boundary(line_text, character);
    let before = &line_text[..end];
    let paren_pos = before.rfind("((")?;
    let after_paren = &before[paren_pos + 2..];
    if after_paren.contains("))") {
        return None;
    }
    Some(after_paren.to_string())
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --lib lsp::completion`
Expected: all PASS (new and pre-existing).

- [ ] **Step 6: Commit**

```bash
cargo fmt -- src/lsp/completion.rs
git add src/lsp/completion.rs
git commit -m "feat(lsp): detect block-reference completion context"
```

---

### Task 2: block-reference completion

**Files:**
- Modify: `src/lsp/mod.rs` (initialize capabilities, `completion` handler, new `complete_block_refs` method, tests module)

**Interfaces:**
- Consumes: `completion::block_ref_prefix` (Task 1); `blocks` table (`block_id`, `page_id`, `content`), `pages` table (`id`, `path`).
- Produces: `async fn complete_block_refs(&self, prefix: &str) -> Result<Vec<CompletionItem>>` on `LspBackend`. Items: label = first line of block content (≤60 chars), `detail` = source page path, `insert_text` = `"{block_id}))"` (closes the reference; the client replaces only the word after `((`).

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `src/lsp/mod.rs` (fixture note: ` ^blk123XYZ99` is a trailing block-ID marker; the index strips it into `blocks.block_id`):

```rust
    #[tokio::test]
    async fn completion_suggests_block_refs_by_content() {
        let (backend, _tmp) = make_backend(&[
            ("Ref.md", "# Ref\n\nA fact worth citing ^blk123XYZ99\n"),
            ("Src.md", "# Src\n\n((fact\n"),
        ]);
        let uri = uri_for(&backend, "Src.md");
        open_doc(&backend, &uri, "# Src\n\n((fact\n").await;
        let params = CompletionParams {
            text_document_position: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position { line: 2, character: 6 },
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
            context: None,
        };
        let resp = backend.completion(params).await.unwrap();
        let items = match resp {
            Some(CompletionResponse::Array(v)) => v,
            other => panic!("expected completions, got {other:?}"),
        };
        let item = items
            .iter()
            .find(|i| i.label.contains("A fact worth citing"))
            .expect("block content offered");
        assert_eq!(item.insert_text.as_deref(), Some("blk123XYZ99))"));
        assert_eq!(item.detail.as_deref(), Some("Ref.md"));
    }

    #[tokio::test]
    async fn completion_block_refs_no_match_returns_empty() {
        let (backend, _tmp) = make_backend(&[
            ("Ref.md", "# Ref\n\nA fact worth citing ^blk123XYZ99\n"),
            ("Src.md", "# Src\n\n((zzzz\n"),
        ]);
        let uri = uri_for(&backend, "Src.md");
        open_doc(&backend, &uri, "# Src\n\n((zzzz\n").await;
        let params = CompletionParams {
            text_document_position: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position { line: 2, character: 6 },
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
            context: None,
        };
        let resp = backend.completion(params).await.unwrap();
        let items = match resp {
            Some(CompletionResponse::Array(v)) => v,
            other => panic!("expected an (empty) array, got {other:?}"),
        };
        assert!(items.is_empty());
    }

    #[tokio::test]
    async fn initialize_advertises_paren_trigger() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let backend = make_uninitialized_backend();
        #[allow(deprecated)]
        let params = InitializeParams {
            root_uri: Some(Url::from_file_path(&root).unwrap()),
            ..Default::default()
        };
        let result = backend.initialize(params).await.unwrap();
        let triggers = result
            .capabilities
            .completion_provider
            .unwrap()
            .trigger_characters
            .unwrap();
        assert!(triggers.contains(&"(".to_string()));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib lsp::tests -- block_ref paren_trigger`
Expected: the two completion tests FAIL (no items / wrong response); the trigger test FAILS on the `contains` assert.

- [ ] **Step 3: Implement**

In `src/lsp/mod.rs`:

a. In `initialize`, extend the trigger characters:

```rust
                completion_provider: Some(CompletionOptions {
                    trigger_characters: Some(vec![
                        "[".to_string(),
                        "#".to_string(),
                        "(".to_string(),
                    ]),
                    ..Default::default()
                }),
```

b. In the `completion` handler, after the wikilink branch (`if let Some(prefix) = completion::wikilink_prefix(...)`) and before the `frontmatter_meta` branch, add:

```rust
        if let Some(prefix) = completion::block_ref_prefix(&line_text, character) {
            let items = self.complete_block_refs(&prefix).await?;
            return Ok(Some(CompletionResponse::Array(items)));
        }
```

c. Add the method to `impl LspBackend` (next to `complete_wikilinks`):

```rust
    /// Complete block references by substring-matching block content.
    /// Newest blocks first (block IDs are time-sorted base62).
    async fn complete_block_refs(&self, prefix: &str) -> Result<Vec<CompletionItem>> {
        let prefix = prefix.to_string();
        let results: Vec<(String, String, String)> = self
            .state()?
            .index
            .with_index({
                let prefix = prefix.clone();
                move |index, _| -> std::result::Result<Vec<_>, rusqlite::Error> {
                    let mut stmt = index.connection().prepare(
                        "SELECT b.block_id, b.content, p.path \
                         FROM blocks b JOIN pages p ON p.id = b.page_id \
                         WHERE b.block_id IS NOT NULL \
                           AND b.content LIKE '%' || ?1 || '%' \
                         ORDER BY b.block_id DESC LIMIT 50",
                    )?;
                    let rows = stmt
                        .query_map(rusqlite::params![prefix], |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                            ))
                        })?
                        .filter_map(|r| r.ok())
                        .collect();
                    Ok(rows)
                }
            })
            .await
            .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?
            .unwrap_or_default();

        Ok(results
            .into_iter()
            .map(|(block_id, content, path)| {
                let first_line = content.lines().next().unwrap_or("");
                let label: String = first_line.chars().take(60).collect();
                CompletionItem {
                    label,
                    kind: Some(CompletionItemKind::REFERENCE),
                    detail: Some(path),
                    insert_text: Some(format!("{block_id}))")),
                    ..Default::default()
                }
            })
            .collect())
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib lsp::`
Expected: all PASS. If `completion_suggests_block_refs_by_content` finds no items, first suspect the fixture: the marker line must be `content ^blk123XYZ99` (space before `^`, id 10–12 alphanumerics) — verify against `block_id_regex` in `src/vault/block.rs`.

- [ ] **Step 5: Commit**

```bash
cargo fmt -- src/lsp/mod.rs
git add src/lsp/mod.rs
git commit -m "feat(lsp): complete block references by content"
```

---

### Task 3: block index queries

**Files:**
- Modify: `src/lsp/queries.rs`

**Interfaces:**
- Consumes: `blocks` and `links` tables; `IndexHandle::with_index`.
- Produces (used by Tasks 4, 5, 6):

```rust
pub struct BlockLookup {
    pub path: String,       // vault-relative path of the defining page
    pub content: String,    // block content (marker stripped)
    pub span_start: usize,  // body byte offsets of the block in that page
    pub span_end: usize,
}
pub async fn block_by_id(index: &IndexHandle, block_id: &str) -> Option<BlockLookup>;

pub struct BlockRefSource {
    pub source_path: String, // vault-relative path of a page containing ((id))
    pub span_start: i64,     // body byte offsets of the ((id)) link
    pub span_end: i64,
}
pub async fn block_ref_sources(index: &IndexHandle, block_id: &str) -> Vec<BlockRefSource>;
```

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `src/lsp/queries.rs`:

```rust
    #[tokio::test]
    async fn block_by_id_resolves_defining_page() {
        let (backend, _tmp) = make_backend(&[(
            "Ref.md",
            "# Ref\n\nA fact worth citing ^blk123XYZ99\n",
        )]);
        let hit = block_by_id(&backend.state().unwrap().index, "blk123XYZ99")
            .await
            .expect("block found");
        assert_eq!(hit.path, "Ref.md");
        assert!(hit.content.contains("A fact worth citing"));
        assert!(hit.span_end > hit.span_start);
    }

    #[tokio::test]
    async fn block_by_id_unknown_returns_none() {
        let (backend, _tmp) = make_backend(&[("Ref.md", "# Ref\nplain\n")]);
        assert!(
            block_by_id(&backend.state().unwrap().index, "nope123456")
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn block_ref_sources_lists_referrers() {
        let (backend, _tmp) = make_backend(&[
            ("Ref.md", "# Ref\n\nA fact worth citing ^blk123XYZ99\n"),
            ("Src.md", "# Src\n\nsee ((blk123XYZ99))\n"),
        ]);
        let sources = block_ref_sources(&backend.state().unwrap().index, "blk123XYZ99").await;
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].source_path, "Src.md");
        assert!(sources[0].span_end > sources[0].span_start);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib lsp::queries`
Expected: FAIL — `block_by_id` / `block_ref_sources` not found.

- [ ] **Step 3: Implement**

Add to `src/lsp/queries.rs`:

```rust
/// A block resolved by its ID: defining page and body span.
pub struct BlockLookup {
    pub path: String,
    pub content: String,
    pub span_start: usize,
    pub span_end: usize,
}

/// Resolve a block ID to its defining page and span. `None` when the ID is
/// unknown or the query fails.
pub async fn block_by_id(index: &IndexHandle, block_id: &str) -> Option<BlockLookup> {
    let block_id = block_id.to_string();
    index
        .with_index(move |idx, _vault| {
            idx.connection()
                .query_row(
                    "SELECT p.path, b.content, b.span_start, b.span_end \
                     FROM blocks b JOIN pages p ON p.id = b.page_id \
                     WHERE b.block_id = ?1 LIMIT 1",
                    rusqlite::params![block_id],
                    |row| {
                        Ok(BlockLookup {
                            path: row.get(0)?,
                            content: row.get(1)?,
                            span_start: row.get::<_, i64>(2)? as usize,
                            span_end: row.get::<_, i64>(3)? as usize,
                        })
                    },
                )
                .ok()
        })
        .await
        .ok()
        .flatten()
}

/// A page location containing a `((block_id))` reference.
pub struct BlockRefSource {
    pub source_path: String,
    pub span_start: i64,
    pub span_end: i64,
}

/// Every indexed `((block_id))` reference, ordered by page then position.
/// Empty on unknown ID or query failure.
pub async fn block_ref_sources(index: &IndexHandle, block_id: &str) -> Vec<BlockRefSource> {
    let block_id = block_id.to_string();
    index
        .with_index(move |idx, _vault| -> std::result::Result<Vec<_>, rusqlite::Error> {
            let mut stmt = idx.connection().prepare(
                "SELECT p.path, l.span_start, l.span_end \
                 FROM links l JOIN pages p ON p.id = l.source_id \
                 WHERE l.target_block_id = ?1 \
                 ORDER BY p.path, l.span_start",
            )?;
            let rows = stmt
                .query_map(rusqlite::params![block_id], |row| {
                    Ok(BlockRefSource {
                        source_path: row.get(0)?,
                        span_start: row.get(1)?,
                        span_end: row.get(2)?,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        })
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib lsp::queries`
Expected: all PASS. If `block_ref_sources_lists_referrers` returns empty, inspect the `links` rows in a debugger/`dbg!` — the `target_block_id` column is populated by link resolution (`resolve_links_for_page`), which `make_backend` runs; do not work around by matching `target_raw`.

- [ ] **Step 5: Commit**

```bash
cargo fmt -- src/lsp/queries.rs
git add src/lsp/queries.rs
git commit -m "feat(lsp): add block-id index queries"
```

---

### Task 4: block-reference hover

**Files:**
- Modify: `src/lsp/hover.rs`, `src/lsp/mod.rs`

**Interfaces:**
- Consumes: `queries::block_by_id` (Task 3); `LinkKind::BlockRef` on `Link.kind`; `Link.target_raw` holds the bare block ID for block refs.
- Produces: `pub fn format_hover_block(block_id: &str, path: &str, content: &str) -> String` and `pub fn format_hover_block_unresolved(block_id: &str) -> String` in `hover.rs`; the `hover` handler dispatches on link kind.

- [ ] **Step 1: Write the failing formatter tests**

Append to the `tests` module in `src/lsp/hover.rs`:

```rust
    #[test]
    fn block_hover_format_exact() {
        let s = format_hover_block("blk123XYZ99", "Ref.md", "A fact");
        assert_eq!(s, "**Block `((blk123XYZ99))`**\n`Ref.md`\n\n---\n\nA fact");
    }

    #[test]
    fn block_hover_unresolved_format_exact() {
        let s = format_hover_block_unresolved("nope123456");
        assert_eq!(s, "*Unresolved block reference:* `((nope123456))`");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib lsp::hover`
Expected: FAIL — functions not found.

- [ ] **Step 3: Implement the formatters**

Add to `src/lsp/hover.rs`:

```rust
/// Markdown shown when hovering a `((block-id))` that resolves.
pub fn format_hover_block(block_id: &str, path: &str, content: &str) -> String {
    format!("**Block `(({block_id}))`**\n`{path}`\n\n---\n\n{content}")
}

/// Markdown shown when hovering a `((block-id))` with no indexed block.
pub fn format_hover_block_unresolved(block_id: &str) -> String {
    format!("*Unresolved block reference:* `(({block_id}))`")
}
```

Run: `cargo test --lib lsp::hover` — PASS.

- [ ] **Step 4: Write the failing handler tests**

Append to the `tests` module in `src/lsp/mod.rs`:

```rust
    #[tokio::test]
    async fn hover_on_block_ref_shows_block_content() {
        let (backend, _tmp) = make_backend(&[
            ("Ref.md", "# Ref\n\nA fact worth citing ^blk123XYZ99\n"),
            ("Src.md", "# Src\n\nsee ((blk123XYZ99))\n"),
        ]);
        let uri = uri_for(&backend, "Src.md");
        open_doc(&backend, &uri, "# Src\n\nsee ((blk123XYZ99))\n").await;
        let params = HoverParams {
            text_document_position_params: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position { line: 2, character: 8 },
            },
            work_done_progress_params: Default::default(),
        };
        let hover = backend.hover(params).await.unwrap().expect("hover content");
        let HoverContents::Markup(m) = hover.contents else {
            panic!("expected markup");
        };
        assert!(m.value.contains("A fact worth citing"));
        assert!(m.value.contains("Ref.md"));
    }

    #[tokio::test]
    async fn hover_on_unknown_block_ref_reports_unresolved() {
        let (backend, _tmp) = make_backend(&[("Src.md", "# Src\n\nsee ((nope1234567))\n")]);
        let uri = uri_for(&backend, "Src.md");
        open_doc(&backend, &uri, "# Src\n\nsee ((nope1234567))\n").await;
        let params = HoverParams {
            text_document_position_params: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position { line: 2, character: 8 },
            },
            work_done_progress_params: Default::default(),
        };
        let hover = backend.hover(params).await.unwrap().expect("hover content");
        let HoverContents::Markup(m) = hover.contents else {
            panic!("expected markup");
        };
        assert!(m.value.contains("Unresolved block reference"));
    }
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `cargo test --lib lsp::tests -- hover_on`
Expected: FAIL — current handler treats the block ID as a canonical page name and reports an unresolved *link* (first test) — assert message shows the wrong hover text.

- [ ] **Step 6: Implement the dispatch**

In `src/lsp/mod.rs` `hover`, after `(link, range)` is extracted and before the canonical-name resolution, add:

```rust
        if link.kind == crate::vault::link::LinkKind::BlockRef {
            let state = self.state()?;
            let content = match crate::lsp::queries::block_by_id(&state.index, &link.target_raw)
                .await
            {
                Some(hit) => {
                    crate::lsp::hover::format_hover_block(&link.target_raw, &hit.path, &hit.content)
                }
                None => crate::lsp::hover::format_hover_block_unresolved(&link.target_raw),
            };
            return Ok(Some(Hover {
                contents: HoverContents::Markup(MarkupContent {
                    kind: MarkupKind::Markdown,
                    value: content,
                }),
                range: Some(range),
            }));
        }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cargo test --lib lsp::`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
cargo fmt -- src/lsp/hover.rs src/lsp/mod.rs
git add src/lsp/hover.rs src/lsp/mod.rs
git commit -m "feat(lsp): hover preview for block references"
```

---

### Task 5: block-reference goto definition

**Files:**
- Modify: `src/lsp/mod.rs`

**Interfaces:**
- Consumes: `queries::block_by_id` (Task 3); `Document::body_span_to_range` (existing).
- Produces: `goto_definition` returns the block's actual span inside its defining page (not `Range::default()`).

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `src/lsp/mod.rs`. The target page deliberately has TOML frontmatter so the body byte offset is non-zero — this pins that `blocks.span_*` are *body* offsets and must be converted with `body_span_to_range`:

```rust
    #[tokio::test]
    async fn goto_definition_jumps_to_block_span() {
        let ref_text = "+++\ntitle = \"Ref\"\n+++\nintro line\nA fact worth citing ^blk123XYZ99\n";
        let (backend, _tmp) = make_backend(&[
            ("Ref.md", ref_text),
            ("Src.md", "# Src\n\nsee ((blk123XYZ99))\n"),
        ]);
        let uri = uri_for(&backend, "Src.md");
        open_doc(&backend, &uri, "# Src\n\nsee ((blk123XYZ99))\n").await;
        let params = GotoDefinitionParams {
            text_document_position_params: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position { line: 2, character: 8 },
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };
        let resp = backend.goto_definition(params).await.unwrap();
        let Some(GotoDefinitionResponse::Scalar(loc)) = resp else {
            panic!("expected a scalar location, got {resp:?}");
        };
        assert!(loc.uri.path().ends_with("Ref.md"));
        // "A fact worth citing" is line 4 of the file (0-indexed), after the
        // three frontmatter lines and "intro line".
        assert_eq!(loc.range.start.line, 4);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib lsp::tests -- jumps_to_block_span`
Expected: FAIL — the handler resolves the ID as a canonical page name, finds nothing, returns `None`.

- [ ] **Step 3: Implement**

In `src/lsp/mod.rs` `goto_definition`, after `let link = match link {...}` and before the canonical resolution, add:

```rust
        if link.kind == crate::vault::link::LinkKind::BlockRef {
            let state = self.state()?;
            let Some(hit) =
                crate::lsp::queries::block_by_id(&state.index, &link.target_raw).await
            else {
                return Ok(None);
            };
            let vp = crate::vault::path::VaultPath::new(&hit.path)
                .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;
            let abs_path = state.vault.resolve(&vp);
            let target_uri = Url::from_file_path(&abs_path)
                .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;
            let range = match tokio::fs::read_to_string(&abs_path).await {
                Ok(text) => document::Document::from_text(&text, 0)
                    .body_span_to_range(hit.span_start, hit.span_end),
                Err(_) => Range::default(),
            };
            return Ok(Some(GotoDefinitionResponse::Scalar(Location {
                uri: target_uri,
                range,
            })));
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --lib lsp::`
Expected: all PASS. If the line assertion fails and the reported line is off by exactly the frontmatter height (3 lines), then `blocks.span_*` are file-absolute rather than body-relative: confirm by printing `hit.span_start` against the fixture text, then subtract `doc.body_byte_offset` from both span values before passing them to `body_span_to_range`. Do not guess — verify with the printed offset first.

- [ ] **Step 5: Commit**

```bash
cargo fmt -- src/lsp/mod.rs
git add src/lsp/mod.rs
git commit -m "feat(lsp): goto definition for block references"
```

---

### Task 6: block-reference references

**Files:**
- Modify: `src/lsp/mod.rs`

**Interfaces:**
- Consumes: `queries::block_ref_sources` (Task 3); existing open-doc-or-disk range conversion pattern (`backlink_to_range` is the model — do not modify it).
- Produces: `async fn span_to_location(&self, source_path: &str, span_start: i64, span_end: i64) -> Option<Location>` on `LspBackend`; `references` handles a cursor on `((id))`.

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `src/lsp/mod.rs`:

```rust
    #[tokio::test]
    async fn references_on_block_ref_lists_all_referrers() {
        let (backend, _tmp) = make_backend(&[
            ("Ref.md", "# Ref\n\nA fact worth citing ^blk123XYZ99\n"),
            ("SrcA.md", "# A\n\nsee ((blk123XYZ99))\n"),
            ("SrcB.md", "# B\n\nalso ((blk123XYZ99))\n"),
        ]);
        let uri = uri_for(&backend, "SrcA.md");
        open_doc(&backend, &uri, "# A\n\nsee ((blk123XYZ99))\n").await;
        let params = ReferenceParams {
            text_document_position: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position { line: 2, character: 8 },
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
            context: ReferenceContext {
                include_declaration: false,
            },
        };
        let locs = backend
            .references(params)
            .await
            .unwrap()
            .expect("locations");
        assert_eq!(locs.len(), 2);
        let mut paths: Vec<String> = locs
            .iter()
            .map(|l| l.uri.path().rsplit('/').next().unwrap().to_string())
            .collect();
        paths.sort();
        assert_eq!(paths, vec!["SrcA.md".to_string(), "SrcB.md".to_string()]);
        // Spans are real (converted from indexed offsets), not defaults.
        assert!(locs.iter().any(|l| l.range.start.line > 0));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib lsp::tests -- references_on_block_ref`
Expected: FAIL — the current handler canonical-resolves the ID, finds no page, returns `None`.

- [ ] **Step 3: Implement**

In `src/lsp/mod.rs`:

a. In `references`, the inner block currently captures only `doc.link_at_position(pos).map(|l| l.target_raw.clone())`. Change it to capture the kind too, and branch before the canonical path:

```rust
            let link_info = {
                let docs = self.documents.lock().await;
                let doc = match docs.get(&uri) {
                    Some(d) => d,
                    None => return Ok(None),
                };
                if doc.encrypted {
                    return Ok(None);
                }
                doc.link_at_position(pos)
                    .map(|l| (l.target_raw.clone(), l.kind.clone()))
            };

            if let Some((target_raw, crate::vault::link::LinkKind::BlockRef)) = &link_info {
                let sources =
                    crate::lsp::queries::block_ref_sources(&state.index, target_raw).await;
                let mut locations = Vec::new();
                for s in &sources {
                    if let Some(loc) = self
                        .span_to_location(&s.source_path, s.span_start, s.span_end)
                        .await
                    {
                        locations.push(loc);
                    }
                }
                return Ok(if locations.is_empty() {
                    None
                } else {
                    Some(locations)
                });
            }

            let link_target = link_info.map(|(raw, _)| raw);
```

(The pre-existing code after this point continues to use `link_target` exactly as before.)

b. Add the helper to `impl LspBackend` (near `backlink_to_range`, same open-doc-or-disk pattern):

```rust
    /// Convert an indexed body span in `source_path` to a `Location`, using
    /// the open document if present, else a throwaway parse from disk.
    async fn span_to_location(
        &self,
        source_path: &str,
        span_start: i64,
        span_end: i64,
    ) -> Option<Location> {
        if span_start < 0 || span_end < 0 {
            return None;
        }
        let state = self.state_opt()?;
        let vp = crate::vault::path::VaultPath::new(source_path).ok()?;
        let abs = state.vault.resolve(&vp);
        let uri = Url::from_file_path(&abs).ok()?;
        let (start, end) = (span_start as usize, span_end as usize);
        {
            let docs = self.documents.lock().await;
            if let Some(doc) = docs.get(&uri) {
                return Some(Location {
                    range: doc.body_span_to_range(start, end),
                    uri,
                });
            }
        }
        let content = tokio::fs::read_to_string(&abs).await.ok()?;
        let doc = document::Document::from_text(&content, 0);
        Some(Location {
            range: doc.body_span_to_range(start, end),
            uri,
        })
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib lsp::`
Expected: all PASS — including every pre-existing `references` test (the wiki path must be untouched).

- [ ] **Step 5: Commit**

```bash
cargo fmt -- src/lsp/mod.rs
git add src/lsp/mod.rs
git commit -m "feat(lsp): find references for block references"
```

---

### Task 7: page-hover backlinks line

**Files:**
- Modify: `src/lsp/hover.rs`, `src/lsp/mod.rs`

**Interfaces:**
- Consumes: `IndexHandle::backlinks(vp: VaultPath, max_context_chars: usize) -> Result<Vec<BacklinkWithContext>, IndexError>` (existing).
- Produces: **changed signature** `pub fn format_hover_resolved(path: &str, title: Option<&str>, preview: &str, backlink_count: usize) -> String`. The count line sits between the path line and the `---` rule: `*N backlink*` / `*N backlinks*`.

- [ ] **Step 1: Update the formatter tests (they become the failing tests)**

In `src/lsp/hover.rs` tests, update the three `format_hover_resolved` tests to the new signature and format:

```rust
    #[test]
    fn resolved_uses_title_when_present() {
        let s = format_hover_resolved("A.md", Some("Alpha"), "preview", 2);
        assert!(s.contains("**Alpha**"));
        assert!(s.contains("A.md"));
        assert!(s.contains("preview"));
        assert!(s.contains("*2 backlinks*"));
    }

    #[test]
    fn resolved_falls_back_to_path() {
        let s = format_hover_resolved("A.md", None, "p", 0);
        assert!(s.contains("**A.md**"));
        assert!(s.contains("*0 backlinks*"));
    }

    #[test]
    fn resolved_format_exact() {
        let s = format_hover_resolved("A.md", Some("Alpha"), "hello", 1);
        assert_eq!(s, "**Alpha**\n`A.md`\n*1 backlink*\n\n---\n\nhello");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib lsp::hover`
Expected: compile FAIL (arity), plus `src/lsp/mod.rs` call site fails to compile — that is the point; fix both in the next step.

- [ ] **Step 3: Implement**

In `src/lsp/hover.rs`:

```rust
/// Markdown shown when hovering a link that resolves to a page.
///
/// Bold title, code-span path, an italic backlink count, a `---` rule, then
/// the preview (see the `resolved_format_exact` test for the exact layout).
pub fn format_hover_resolved(
    path: &str,
    title: Option<&str>,
    preview: &str,
    backlink_count: usize,
) -> String {
    let display_title = title.unwrap_or(path);
    let noun = if backlink_count == 1 {
        "backlink"
    } else {
        "backlinks"
    };
    format!("**{display_title}**\n`{path}`\n*{backlink_count} {noun}*\n\n---\n\n{preview}")
}
```

In `src/lsp/mod.rs` `hover`, in the `Some(path)` arm, count backlinks before formatting:

```rust
            Some(path) => {
                let vault_path = crate::vault::path::VaultPath::new(&path)
                    .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;
                let abs_path = state.vault.resolve(&vault_path);
                let backlink_count = state
                    .index
                    .backlinks(vault_path, 0)
                    .await
                    .map(|bl| bl.len())
                    .unwrap_or(0);
                let (title, preview) = match tokio::fs::read_to_string(&abs_path).await {
                    Ok(file_content) => {
                        let target = document::Document::from_text(&file_content, 0);
                        let preview = crate::lsp::hover::extract_preview(&target.body, 10);
                        (target.meta.title, preview)
                    }
                    Err(_) => (None, String::new()),
                };
                crate::lsp::hover::format_hover_resolved(
                    &path,
                    title.as_deref(),
                    &preview,
                    backlink_count,
                )
            }
```

(Note: `vault_path` is consumed by `backlinks` — resolve `abs_path` first, as shown.)

- [ ] **Step 4: Write the handler-level test**

Append to the `tests` module in `src/lsp/mod.rs`:

```rust
    #[tokio::test]
    async fn hover_shows_backlink_count() {
        let (backend, _tmp) = make_backend(&[
            ("Target.md", "# Target\n\nbody\n"),
            ("SrcA.md", "# A\n\nsee [[Target]]\n"),
            ("SrcB.md", "# B\n\nalso [[Target]]\n"),
        ]);
        let uri = uri_for(&backend, "SrcA.md");
        open_doc(&backend, &uri, "# A\n\nsee [[Target]]\n").await;
        let params = HoverParams {
            text_document_position_params: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position { line: 2, character: 8 },
            },
            work_done_progress_params: Default::default(),
        };
        let hover = backend.hover(params).await.unwrap().expect("hover content");
        let HoverContents::Markup(m) = hover.contents else {
            panic!("expected markup");
        };
        assert!(m.value.contains("*2 backlinks*"), "got: {}", m.value);
    }
```

- [ ] **Step 5: Run tests to verify everything passes**

Run: `cargo test --lib lsp::`
Expected: all PASS, including the updated formatter tests.

- [ ] **Step 6: Commit**

```bash
cargo fmt -- src/lsp/hover.rs src/lsp/mod.rs
git add src/lsp/hover.rs src/lsp/mod.rs
git commit -m "feat(lsp): show backlink count in page hover"
```

---

### Task 8: date-word wikilink completion

**Files:**
- Modify: `src/lsp/completion.rs`, `src/lsp/mod.rs`

**Interfaces:**
- Consumes: `completion::wikilink_prefix` (existing); `chrono` (already a dependency).
- Produces: `pub fn date_word_candidates(prefix: &str, today: chrono::NaiveDate) -> Vec<(&'static str, chrono::NaiveDate)>` in `completion.rs`. The handler appends the resulting items to wikilink completions: label `"{word} → {date}"`, `insert_text` = `"{date}"` (`%Y-%m-%d`, the journal page title convention), `filter_text` = word, kind `EVENT`, detail `"journal"`.

- [ ] **Step 1: Write the failing pure-function tests**

Append to the `tests` module in `src/lsp/completion.rs`:

```rust
    // ---- date_word_candidates tests ----
    // 2026-08-26 is a Wednesday.

    fn wed() -> chrono::NaiveDate {
        chrono::NaiveDate::from_ymd_opt(2026, 8, 26).unwrap()
    }

    #[test]
    fn date_words_today_tomorrow_yesterday() {
        let c = date_word_candidates("tod", wed());
        assert_eq!(c, vec![("today", wed())]);
        let c = date_word_candidates("tomorrow", wed());
        assert_eq!(
            c,
            vec![("tomorrow", chrono::NaiveDate::from_ymd_opt(2026, 8, 27).unwrap())]
        );
        let c = date_word_candidates("yes", wed());
        assert_eq!(
            c,
            vec![("yesterday", chrono::NaiveDate::from_ymd_opt(2026, 8, 25).unwrap())]
        );
    }

    #[test]
    fn date_words_weekday_is_next_occurrence() {
        // "friday" from Wednesday 2026-08-26 → 2026-08-28.
        let c = date_word_candidates("fri", wed());
        assert_eq!(
            c,
            vec![("friday", chrono::NaiveDate::from_ymd_opt(2026, 8, 28).unwrap())]
        );
        // Same weekday resolves a full week ahead, never today.
        let c = date_word_candidates("wednesday", wed());
        assert_eq!(
            c,
            vec![("wednesday", chrono::NaiveDate::from_ymd_opt(2026, 9, 2).unwrap())]
        );
    }

    #[test]
    fn date_words_case_insensitive_and_multi_match() {
        let c = date_word_candidates("T", wed());
        let words: Vec<&str> = c.iter().map(|(w, _)| *w).collect();
        assert_eq!(words, vec!["today", "tomorrow", "tuesday", "thursday"]);
    }

    #[test]
    fn date_words_no_match_for_page_titles() {
        assert!(date_word_candidates("Design", wed()).is_empty());
        // Empty prefix offers nothing — plain [[ completion stays page-only.
        assert!(date_word_candidates("", wed()).is_empty());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib lsp::completion -- date_word`
Expected: FAIL — `date_word_candidates` not found.

- [ ] **Step 3: Implement the pure function**

Add to `src/lsp/completion.rs`:

```rust
/// Date words offered inside `[[` completion, in fixed presentation order.
const DATE_WORDS: [&str; 10] = [
    "today", "tomorrow", "yesterday", "monday", "tuesday", "wednesday", "thursday", "friday",
    "saturday", "sunday",
];

/// Match a typed wikilink prefix against the date vocabulary and resolve each
/// matching word to a concrete date. Weekdays resolve to the next occurrence
/// strictly after `today`. An empty prefix matches nothing.
pub fn date_word_candidates(
    prefix: &str,
    today: chrono::NaiveDate,
) -> Vec<(&'static str, chrono::NaiveDate)> {
    if prefix.is_empty() {
        return Vec::new();
    }
    let needle = prefix.to_ascii_lowercase();
    DATE_WORDS
        .iter()
        .filter(|w| w.starts_with(&needle))
        .map(|&word| {
            let date = match word {
                "today" => today,
                "tomorrow" => today + chrono::Duration::days(1),
                "yesterday" => today - chrono::Duration::days(1),
                weekday => {
                    let target: chrono::Weekday = weekday.parse().expect("valid weekday word");
                    let mut d = today + chrono::Duration::days(1);
                    while d.weekday() != target {
                        d += chrono::Duration::days(1);
                    }
                    d
                }
            };
            (word, date)
        })
        .collect()
}
```

Run: `cargo test --lib lsp::completion` — PASS.

- [ ] **Step 4: Write the failing handler test**

Append to the `tests` module in `src/lsp/mod.rs`:

```rust
    #[tokio::test]
    async fn completion_offers_date_words_in_wikilinks() {
        let (backend, _tmp) = make_backend(&[("Src.md", "# Src\n\n[[tod\n")]);
        let uri = uri_for(&backend, "Src.md");
        open_doc(&backend, &uri, "# Src\n\n[[tod\n").await;
        let params = CompletionParams {
            text_document_position: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position { line: 2, character: 5 },
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
            context: None,
        };
        let resp = backend.completion(params).await.unwrap();
        let items = match resp {
            Some(CompletionResponse::Array(v)) => v,
            other => panic!("expected completions, got {other:?}"),
        };
        let item = items
            .iter()
            .find(|i| i.label.starts_with("today"))
            .expect("date word offered");
        let expected = chrono::Local::now().date_naive().format("%Y-%m-%d").to_string();
        assert_eq!(item.insert_text.as_deref(), Some(expected.as_str()));
        assert_eq!(item.filter_text.as_deref(), Some("today"));
        assert_eq!(item.detail.as_deref(), Some("journal"));
    }
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cargo test --lib lsp::tests -- date_words_in_wikilinks`
Expected: FAIL — no date items offered.

- [ ] **Step 6: Implement the handler wiring**

In `src/lsp/mod.rs`, change the wikilink branch of `completion` to append date items:

```rust
        if let Some(prefix) = completion::wikilink_prefix(&line_text, character) {
            let mut items = self.complete_wikilinks(&prefix).await?;
            let today = chrono::Local::now().date_naive();
            items.extend(completion::date_word_candidates(&prefix, today).into_iter().map(
                |(word, date)| {
                    let date_str = date.format("%Y-%m-%d").to_string();
                    CompletionItem {
                        label: format!("{word} → {date_str}"),
                        kind: Some(CompletionItemKind::EVENT),
                        detail: Some("journal".to_string()),
                        insert_text: Some(date_str),
                        filter_text: Some(word.to_string()),
                        ..Default::default()
                    }
                },
            ));
            return Ok(Some(CompletionResponse::Array(items)));
        }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cargo test --lib lsp::`
Expected: all PASS (the relation-value completion path in frontmatter reuses `complete_wikilinks` — confirm no pre-existing frontmatter completion test regressed).

- [ ] **Step 8: Commit**

```bash
cargo fmt -- src/lsp/completion.rs src/lsp/mod.rs
git add src/lsp/completion.rs src/lsp/mod.rs
git commit -m "feat(lsp): date-word wikilink completion for journal pages"
```

---

### Task 9: docs, port-comment fix, full gates

**Files:**
- Modify: `ui/src/docs/content/lsp.mdx` (capability table)
- Modify: `src/lib.rs:134` (stale doc comment)

**Interfaces:**
- Consumes: everything shipped in Tasks 1–8.
- Produces: documentation matching shipped behavior; a clean full-gate run.

- [ ] **Step 1: Update the LSP capability table**

In `ui/src/docs/content/lsp.mdx`, update these rows of the "Use the shipped capabilities" table:

- **Completion** row — replace with:
  `| Completion | `[[` completes canonical page names and date words (`today`, `tomorrow`, `yesterday`, weekday names) that insert journal-date links; `((` completes block references by content; `#` completes indexed tags. Inside `+++` TOML frontmatter, declared Base property keys and quoted values complete; relation values use wikilink completion. |`
- **Hover** row — replace with:
  `| Hover | Shows the linked Folio's title, path, backlink count, and leading body lines, or reports an unresolved link. On a `((block-id))`, shows the block's content and source page. |`
- **Go to definition** row — replace with:
  `| Go to definition | Opens the resolved wikilink target. On a `((block-id))`, jumps to the defining block's exact span. |`
- **References** row — replace with:
  `| References | Returns every indexed wikilink to the page under the cursor. On a `((block-id))`, returns every page referencing that block. |`

- [ ] **Step 2: Fix the stale port doc comment**

In `src/lib.rs` line 134, the `ServerSettings::port` doc comment claims a default of 16667; the authoritative default is `set_default("server.port", 3000)` (`src/lib.rs:312`). Change the comment to:

```rust
    /// The port to listen on. (Default: 3000.)
    pub port: u16,
```

- [ ] **Step 3: Run the full verification gates**

```bash
cargo test
cargo clippy
```

Expected: all tests pass; clippy clean on the touched files (pre-existing warnings elsewhere are out of scope). Report the actual output.

- [ ] **Step 4: Commit**

```bash
git add ui/src/docs/content/lsp.mdx src/lib.rs
git commit -m "docs(lsp): document block-ref and date completion; fix port comment"
```

- [ ] **Step 5: Hand off for merge**

Do not merge to develop inside a task. The finishing flow (superpowers:finishing-a-development-branch) decides merge/PR with the user.
