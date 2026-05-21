# Slice 06 — Core Vault (parser + index) CRAP Remediation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Read `00-overview.md` first — §3, §5, and especially §6 (these are behavior-sensitive) are assumed.

**Goal:** Clear the three core-vault mandatory refactors — `parse_blocks` (CC 41), `VaultIndex::build` (CC 43), `resolve_links_for_page` (CC 39) — by **behavior-preserving extraction** into named helpers, each guarded by the existing extensive test suite. No behavior change; only relocation of contiguous logic.

**Architecture:** These functions already sit at 86–96% coverage, so coverage is not the problem — CC is. The discipline here is inverted from the other slices: **the existing tests are the spec.** Each extraction must keep the named guard suite green before and after; the new helpers inherit coverage from those same tests. A few focused unit tests are added for the densest pure helpers as extra insurance.

**Tech Stack:** rusqlite, pulldown-cmark, the existing `tests/` integration suite.

**Targets:** #19 VaultIndex::build, #21 parse_blocks, #25 resolve_links_for_page.

> **Rule for every task in this slice:** run the cited guard suite immediately *before* the extraction (confirm green), perform the extraction, then run it *again* (confirm still green). A red guard at any point means the extraction changed behavior — revert and redo.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/vault/block.rs` | `start_block_builder`, `handle_paragraph_start/end`, `resolve_checkbox`; thin `parse_blocks`/`emit_block` | Modify |
| `src/vault/index.rs` | `extract_prop_links`, `collect_indexed_pages`, `resolve_duplicate_uuids`, `upsert_indexed_page`; thin `build`; four `resolve_*` pass helpers; thin `resolve_links_for_page` | Modify |

Guard suites (do not modify): `tests/block_parser_test.rs` (20 tests), `tests/block_index_test.rs`, `tests/index_test.rs`, `tests/block_ref_resolution_test.rs`, `tests/e2e_block_refs_test.rs`, `tests/link_extraction_test.rs`, `tests/index_handle_test.rs`.

---

## Task 1: `parse_blocks` — extract paragraph handlers + builder

**Files:** Modify `src/vault/block.rs`

- [ ] **Step 1: Confirm the guard is green**

Run: `cargo test --test block_parser_test --test block_index_test`
Expected: PASS (20 + N tests). This is the baseline.

- [ ] **Step 2: Extract `start_block_builder`**

The pattern `if let Some(builder) = current.take() { emit_block(&mut blocks, builder); } current = Some(BlockBuilder { ... })` recurs in 5 match arms (Item, Heading, CodeBlock, Paragraph-else). Add:

```rust
/// Finish the in-progress builder (if any) and start a new one of `block_type`.
fn start_block_builder(
    blocks: &mut Vec<Block>,
    current: &mut Option<BlockBuilder>,
    block_type: BlockType,
    list_depth: usize,
    span_start: usize,
    span_end: usize,
) {
    if let Some(builder) = current.take() {
        emit_block(blocks, builder);
    }
    *current = Some(BlockBuilder {
        block_type,
        text_parts: Vec::new(),
        checkbox: None,
        list_depth,
        span_start,
        span_end,
    });
}
```

Replace each of the 5 occurrences with a call. Keep arm-specific fields identical (e.g. heading levels) — if an arm sets extra builder fields, set them on the returned `current` after the call, or pass them in. Mirror the source exactly.

- [ ] **Step 3: Extract paragraph handlers**

```rust
fn handle_paragraph_start(
    blocks: &mut Vec<Block>,
    current: &mut Option<BlockBuilder>,
    in_blockquote: bool,
    blockquote_span_start: usize,
    range_start: usize,
    range_end: usize,
) {
    // Port lines ~229-253: if in_blockquote -> Blockquote builder using
    // blockquote_span_start; else start_block_builder(Paragraph, ...).
    todo!("port paragraph-start")
}

fn handle_paragraph_end(
    blocks: &mut Vec<Block>,
    current: &mut Option<BlockBuilder>,
    in_blockquote: bool,
    blockquote_span_end: usize,
    range_end: usize,
) {
    // Port lines ~255-266.
    todo!("port paragraph-end")
}
```

Replace the `Start(Paragraph)`/`End(Paragraph)` arm bodies with calls.

- [ ] **Step 4: Run the guard**

Run: `cargo test --test block_parser_test --test block_index_test`
Expected: PASS — identical results to Step 1. If any test fails, the port diverged; fix to match.

- [ ] **Step 5: Commit**

```bash
git add src/vault/block.rs
git commit -m "refactor(block): extract block-builder + paragraph handlers from parse_blocks"
```

---

## Task 2: `emit_block` — extract `resolve_checkbox`

**Files:** Modify `src/vault/block.rs`

- [ ] **Step 1: Write a focused unit test (new insurance)**

Add to `block.rs` test module:

```rust
#[cfg(test)]
mod checkbox_tests {
    use super::*;

    #[test]
    fn cancelled_marker_resolves_to_cancelled() {
        let mut content = String::from("[-] do later");
        let cb = resolve_checkbox(&BlockType::ListItem, None, &mut content);
        assert_eq!(cb, Some(CheckboxState::Cancelled));
    }

    #[test]
    fn explicit_state_passes_through() {
        let mut content = String::from("task");
        let cb = resolve_checkbox(&BlockType::ListItem, Some(CheckboxState::Done), &mut content);
        assert_eq!(cb, Some(CheckboxState::Done));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib block::checkbox_tests`
Expected: FAIL — `resolve_checkbox` not defined.

- [ ] **Step 3: Extract `resolve_checkbox`**

```rust
/// Resolve a list-item's checkbox: detect the cancelled `[-]` marker in the
/// content (stripping it) and otherwise keep the parser-provided state.
fn resolve_checkbox(
    block_type: &BlockType,
    checkbox: Option<CheckboxState>,
    content: &mut String,
) -> Option<CheckboxState> {
    // Port lines ~344-366 of emit_block (cancelled-checkbox detection + state).
    todo!("port checkbox resolution")
}
```

Replace the corresponding block in `emit_block` with a call.

- [ ] **Step 4: Run unit + guard**

Run: `cargo test --lib block::checkbox_tests && cargo test --test block_parser_test`
Expected: PASS (including the existing `parses_cancelled_checkbox` / `checkbox_sets_status_property`).

- [ ] **Step 5: Commit**

```bash
git add src/vault/block.rs
git commit -m "refactor(block): extract resolve_checkbox from emit_block"
```

---

## Task 3: `extract_prop_links` (de-dup with `index_page`)

The property-ref extraction (`match prop.as_str() { "tags"|"aliases"|_ }`) is duplicated verbatim in `build` (index.rs:~397-414) and `index_page` (~743-758). Extract once.

**Files:** Modify `src/vault/index.rs`

- [ ] **Step 1: Write the failing test**

```rust
/// Extract property-reference links from a page's metadata for the configured
/// linkable properties (e.g. "tags", "aliases", and arbitrary extra fields).
fn extract_prop_links(meta: &PageMeta, linkable_properties: &[String]) -> Vec<Link> {
    // Port the shared loop body. Use negative span_start (-(i+1)) for property
    // refs as the existing code does (see CLAUDE.md "Property ref links").
    todo!("port prop-link extraction")
}

#[cfg(test)]
mod prop_link_tests {
    use super::*;

    #[test]
    fn extracts_tag_and_alias_refs() {
        let mut meta = PageMeta::new();
        meta.tags = vec!["rust".into()];
        meta.aliases = vec!["Alias One".into()];
        let links = extract_prop_links(&meta, &["tags".to_string(), "aliases".to_string()]);
        assert!(!links.is_empty());
    }

    #[test]
    fn no_linkable_props_yields_nothing() {
        let meta = PageMeta::new();
        assert!(extract_prop_links(&meta, &[]).is_empty());
    }
}
```

> Note: confirm `Link`'s constructor/fields and the exact negative-`span_start` convention so the produced links are byte-identical to the inline version (the `links` table primary key depends on it).

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib index::prop_link_tests`
Expected: FAIL — `todo!`.

- [ ] **Step 3: Port and replace both call sites**

Fill `extract_prop_links`; replace the duplicated loop in both `build` and `index_page` with `extract_prop_links(&meta, linkable_properties)`.

- [ ] **Step 4: Run unit + guard**

Run: `cargo test --lib index::prop_link_tests && cargo test --test index_test --test link_extraction_test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/vault/index.rs
git commit -m "refactor(index): extract extract_prop_links; de-dup build/index_page"
```

---

## Task 4: `VaultIndex::build` — extract phases (#19)

**Files:** Modify `src/vault/index.rs`

- [ ] **Step 1: Confirm guard green**

Run: `cargo test --test index_test --test block_index_test`
Expected: PASS — baseline.

- [ ] **Step 2: Extract `collect_indexed_pages` (Phase 1)**

```rust
/// Phase 1: walk the vault, parse/repair frontmatter, build IndexedPage records.
/// Returns the parsed pages and the set of seen paths (for stale pruning).
fn collect_indexed_pages(
    vault: &Vault,
    tx: &rusqlite::Transaction,
    linkable_properties: &[String],
    stats: &mut BuildStats,
) -> Result<(Vec<IndexedPage>, std::collections::HashSet<String>), IndexError> {
    // Port lines 311-427 of build verbatim (now calling extract_prop_links).
    todo!("port phase 1")
}
```

Replace lines 311–427 in `build` with `let (parsed_files, seen_paths) = collect_indexed_pages(vault, &tx, &linkable_properties, &mut stats)?;`.

- [ ] **Step 3: Extract `resolve_duplicate_uuids` (Phase 2) and `upsert_indexed_page` (Phase 3 body)**

```rust
/// Phase 2: when two pages share a UUID, keep the oldest and clear the rest.
fn resolve_duplicate_uuids(
    parsed_files: &mut Vec<IndexedPage>,
    stats: &mut BuildStats,
) -> Result<(), IndexError> {
    // Port lines 432-487.
    todo!("port phase 2")
}

/// Phase 3 (per page): upsert the page row, refresh FTS, re-derive links/blocks.
fn upsert_indexed_page(
    pf: &IndexedPage,
    tx: &rusqlite::Transaction,
    derivers: &[Box<dyn Deriver>],
) -> Result<(), IndexError> {
    // Port the per-page body of lines 492-557.
    todo!("port phase 3 body")
}
```

In `build`, replace Phase 2 with `resolve_duplicate_uuids(&mut parsed_files, &mut stats)?;` and the Phase 3 loop body with `for pf in &parsed_files { upsert_indexed_page(pf, &tx, &self.derivers)?; }`.

- [ ] **Step 4: Run guard**

Run: `cargo test --test index_test --test block_index_test --test index_handle_test`
Expected: PASS — identical to Step 1, including `duplicate_uuid_resolved_by_created_at`, `incremental_index_skips_unchanged`, `removed_pages_are_pruned`, `build_with_derivers_produces_same_results`.

- [ ] **Step 5: Commit**

```bash
git add src/vault/index.rs
git commit -m "refactor(index): split VaultIndex::build into phase helpers"
```

---

## Task 5: `resolve_links_for_page` — extract four passes (#25)

**Files:** Modify `src/vault/index.rs`

- [ ] **Step 1: Confirm guard green**

Run: `cargo test --test index_test --test block_ref_resolution_test --test e2e_block_refs_test`
Expected: PASS — baseline.

- [ ] **Step 2: Extract the four pass helpers**

```rust
fn resolve_outgoing_wikilinks(tx: &rusqlite::Transaction, page_id: &str, count: &mut usize) -> Result<(), IndexError> {
    // Port Pass 1 (lines 891-929).
    todo!()
}
fn resolve_outgoing_block_refs(tx: &rusqlite::Transaction, page_id: &str, count: &mut usize) -> Result<(), IndexError> {
    // Port Pass 2 (lines 932-969).
    todo!()
}
fn resolve_incoming_wikilinks(tx: &rusqlite::Transaction, page_id: &str, count: &mut usize) -> Result<(), IndexError> {
    // Port Pass 3 (lines 971-1011) — two-level loop, count-query resolution.
    todo!()
}
fn resolve_incoming_block_refs(tx: &rusqlite::Transaction, page_id: &str, page_path: &str, count: &mut usize) -> Result<(), IndexError> {
    // Port Pass 4 (lines 1013-1048) — page_path pre-fetched by caller.
    todo!()
}
```

- [ ] **Step 3: Thin `resolve_links_for_page`**

Rewrite the body (870) to:

```rust
pub fn resolve_links_for_page(&mut self, vault_path: &VaultPath) -> Result<usize, IndexError> {
    let tx = self.conn.transaction()?;
    let mut resolved_count = 0usize;
    let page_id = match /* existing page_id lookup */ {
        Some(id) => id,
        None => { tx.commit()?; return Ok(0); }
    };
    resolve_outgoing_wikilinks(&tx, &page_id, &mut resolved_count)?;
    resolve_outgoing_block_refs(&tx, &page_id, &mut resolved_count)?;
    resolve_incoming_wikilinks(&tx, &page_id, &mut resolved_count)?;
    // page_path pre-fetched for Pass 4:
    let page_path = vault_path.as_str();
    resolve_incoming_block_refs(&tx, &page_id, page_path, &mut resolved_count)?;
    tx.commit()?;
    Ok(resolved_count)
}
```

> Note: the original may fetch `page_path` from the DB rather than from `vault_path`; mirror whichever the source uses inside Pass 4 (the explorer flagged a pre-fetch at lines 1023-1027).

- [ ] **Step 4: Run guard**

Run: `cargo test --test index_test --test block_ref_resolution_test --test e2e_block_refs_test --test index_handle_test`
Expected: PASS — including `resolve_links_for_page_resolves_only_affected`, `resolves_links_via_canonical_names`, `ambiguous_links_stay_unresolved`, `invalidate_links_to_clears_resolved_links`.

- [ ] **Step 5: Commit**

```bash
git add src/vault/index.rs
git commit -m "refactor(index): split resolve_links_for_page into four pass helpers"
```

---

## Task 6: Slice gate + final acceptance

- [ ] **Step 1: Full suite green**

Run: `cargo test`
Expected: PASS — entire suite, no network.

- [ ] **Step 2: CRAP gate — final acceptance**

Run: `./scripts/crap-check.sh`
Expected tail: `✓ 0/570 function(s) exceed CRAP threshold 30.`

```bash
cargo crap --lcov lcov.info 2>&1 | rg 'exceed CRAP'
```
Expected: `✓ 0/570 function(s) exceed CRAP threshold 30.`

- [ ] **Step 3: Verify the three targets cleared and no new offenders**

```bash
cargo crap --lcov lcov.info 2>&1 | rg '✗' || echo "no functions exceed threshold"
```
Expected: `no functions exceed threshold`. If any extracted helper (`collect_indexed_pages`, `resolve_incoming_wikilinks`, etc.) appears, it inherited too much CC — split it further or add targeted unit tests for its uncovered branches, keeping the guard suite green.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "refactor(vault): complete CRAP remediation — 0/570 over threshold"
```

---

## Self-Review

- **Spec coverage:** parse_blocks (T1–T2), VaultIndex::build (T3–T4), resolve_links_for_page (T5). ✓
- **Behavior preservation:** every task runs its named guard suite before and after; the existing tests are the spec. No new behavior introduced. ✓
- **Type consistency:** `collect_indexed_pages -> (Vec<IndexedPage>, HashSet<String>)` matches `build`'s downstream use of `parsed_files` + `seen_paths`; the four `resolve_*` helpers share the `(&Transaction, &str page_id, &mut usize count)` shape (Pass 4 adds `page_path`). ✓
- **Risk (highest in the project):** these are core paths. The mitigation is strict: a red guard = revert. The added focused unit tests (`checkbox_tests`, `prop_link_tests`) are extra insurance, not the primary guard.
- **Done:** this is the last slice — Step 2 is the project-level acceptance gate (`0/570`).
