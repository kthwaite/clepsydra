# Tasks + Journals + Agenda & Block/Outliner Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add block-level indexing, task management, journal pages, agenda queries, and outliner editing to Clepsydra.

**Architecture:** Markdown files remain the source of truth. A new `blocks` + `block_properties` derived index (same pattern as `links` table) enables structured queries over blocks. Tasks are blocks with checkbox status. Journals are pages at conventional paths. The Slate editor gains outliner keybindings and round-trips block IDs, inline properties, and checkbox state.

**Tech Stack:** Rust (pulldown-cmark, rusqlite, axum), TypeScript (Slate, React, TanStack Router/Query), Vitest

**Design doc:** `docs/plans/2026-02-17-tasks-journals-outliner-design.md`

---

## Phase 1: Block Parser + Indexer (Backend Foundation)

### Task 1: Randflake ID generator

**Files:**
- Create: `src/vault/block_id.rs`
- Test: `tests/block_id_test.rs`

**Step 1: Write the failing test**

```rust
// tests/block_id_test.rs
use clepsydra::vault::block_id::BlockId;

#[test]
fn generates_valid_block_id() {
    let id = BlockId::generate();
    let s = id.to_string();
    // 10-12 chars, base62 (alphanumeric only)
    assert!(s.len() >= 10 && s.len() <= 12, "length was {}: {}", s.len(), s);
    assert!(s.chars().all(|c| c.is_ascii_alphanumeric()), "non-alphanumeric: {}", s);
}

#[test]
fn ids_are_time_sorted() {
    let a = BlockId::generate();
    std::thread::sleep(std::time::Duration::from_millis(2));
    let b = BlockId::generate();
    assert!(b.to_string() > a.to_string(), "b should sort after a");
}

#[test]
fn parse_round_trips() {
    let id = BlockId::generate();
    let s = id.to_string();
    let parsed = BlockId::parse(&s).expect("should parse");
    assert_eq!(parsed.to_string(), s);
}

#[test]
fn parse_rejects_invalid() {
    assert!(BlockId::parse("").is_none());
    assert!(BlockId::parse("abc").is_none()); // too short
    assert!(BlockId::parse("hello world!").is_none()); // spaces/special chars
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --test block_id_test 2>&1 | head -20`
Expected: compilation error — module `block_id` doesn't exist

**Step 3: Write minimal implementation**

```rust
// src/vault/block_id.rs

use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

const BASE62: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// A compact, time-sorted block identifier.
///
/// Format: 7 chars timestamp (ms since epoch, base62) + 4 chars random = 11 chars.
/// Sorts lexicographically by creation time. Unique within a single vault.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BlockId(String);

impl BlockId {
    /// Generate a new block ID with current timestamp + random suffix.
    pub fn generate() -> Self {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock went backwards")
            .as_millis() as u64;

        let mut buf = String::with_capacity(11);
        encode_base62(ms, 7, &mut buf);
        encode_base62_random(4, &mut buf);
        Self(buf)
    }

    /// Parse a block ID string. Returns None if invalid.
    pub fn parse(s: &str) -> Option<Self> {
        if s.len() < 10 || s.len() > 12 {
            return None;
        }
        if !s.chars().all(|c| c.is_ascii_alphanumeric()) {
            return None;
        }
        Some(Self(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for BlockId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

fn encode_base62(mut value: u64, width: usize, buf: &mut String) {
    let mut digits = Vec::with_capacity(width);
    for _ in 0..width {
        digits.push(BASE62[(value % 62) as usize] as char);
        value /= 62;
    }
    digits.reverse();
    buf.extend(digits);
}

fn encode_base62_random(count: usize, buf: &mut String) {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let state = RandomState::new();
    let mut hasher = state.build_hasher();
    hasher.write_u64(std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64);
    let mut rand = hasher.finish();
    for _ in 0..count {
        buf.push(BASE62[(rand % 62) as usize] as char);
        rand /= 62;
    }
}
```

Register the module in `src/vault/mod.rs` — add `pub mod block_id;` alongside existing module declarations.

**Step 4: Run test to verify it passes**

Run: `cargo test --test block_id_test -v`
Expected: all 4 tests pass

**Step 5: Commit**

```bash
git add src/vault/block_id.rs tests/block_id_test.rs src/vault/mod.rs
git commit -m "feat(vault): add randflake block ID generator"
```

---

### Task 2: Block parser — extract block tree from markdown

**Files:**
- Create: `src/vault/block.rs`
- Test: `tests/block_parser_test.rs`

**Context:** This is the core parser that extracts a block tree from markdown. It must handle:
- List items (nested = parent/child), paragraphs, headings, code blocks, blockquotes
- `^id` markers at end of block text
- `[key:: value]` inline properties (Dataview syntax)
- `- [ ]` / `- [x]` / `- [-]` checkbox detection

**Step 1: Write the failing tests**

```rust
// tests/block_parser_test.rs
use clepsydra::vault::block::{parse_blocks, Block, BlockType, CheckboxState};

#[test]
fn parses_simple_list() {
    let md = "- Item one\n- Item two\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0].block_type, BlockType::ListItem);
    assert_eq!(blocks[0].content, "Item one");
    assert_eq!(blocks[0].depth, 0);
    assert!(blocks[0].parent_index.is_none());
    assert_eq!(blocks[1].content, "Item two");
}

#[test]
fn parses_nested_list() {
    let md = "- Parent\n  - Child one\n  - Child two\n- Sibling\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks.len(), 4);
    assert_eq!(blocks[0].content, "Parent");
    assert_eq!(blocks[0].depth, 0);
    assert_eq!(blocks[1].content, "Child one");
    assert_eq!(blocks[1].depth, 1);
    assert_eq!(blocks[1].parent_index, Some(0));
    assert_eq!(blocks[2].content, "Child two");
    assert_eq!(blocks[2].depth, 1);
    assert_eq!(blocks[2].parent_index, Some(0));
    assert_eq!(blocks[3].content, "Sibling");
    assert_eq!(blocks[3].depth, 0);
    assert!(blocks[3].parent_index.is_none());
}

#[test]
fn parses_block_id() {
    let md = "- Item with id ^abc123DEF0\n- No id\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks[0].block_id.as_deref(), Some("abc123DEF0"));
    assert_eq!(blocks[0].content, "Item with id");
    assert!(blocks[1].block_id.is_none());
}

#[test]
fn parses_inline_properties() {
    let md = "- Buy milk [due:: 2026-03-01] [priority:: A]\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks[0].content, "Buy milk");
    assert_eq!(blocks[0].properties.get("due").map(String::as_str), Some("2026-03-01"));
    assert_eq!(blocks[0].properties.get("priority").map(String::as_str), Some("A"));
}

#[test]
fn parses_checkboxes() {
    let md = "- [ ] Todo\n- [x] Done\n- [-] Cancelled\n- Regular\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks[0].checkbox, Some(CheckboxState::Todo));
    assert_eq!(blocks[1].checkbox, Some(CheckboxState::Done));
    assert_eq!(blocks[2].checkbox, Some(CheckboxState::Cancelled));
    assert_eq!(blocks[3].checkbox, None);
}

#[test]
fn parses_headings() {
    let md = "# Title\n\nSome text.\n\n## Section\n";
    let blocks = parse_blocks(md);
    assert!(blocks.iter().any(|b| b.block_type == BlockType::Heading && b.content == "Title"));
    assert!(blocks.iter().any(|b| b.block_type == BlockType::Paragraph && b.content == "Some text."));
    assert!(blocks.iter().any(|b| b.block_type == BlockType::Heading && b.content == "Section"));
}

#[test]
fn parses_code_block() {
    let md = "```rust\nfn main() {}\n```\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].block_type, BlockType::Code);
    assert_eq!(blocks[0].content, "fn main() {}");
}

#[test]
fn records_byte_spans() {
    let md = "- First\n- Second\n";
    let blocks = parse_blocks(md);
    assert_eq!(&md[blocks[0].span.clone()], "- First\n");
    assert_eq!(&md[blocks[1].span.clone()], "- Second\n");
}

#[test]
fn checkbox_sets_status_property() {
    let md = "- [ ] Todo task [due:: 2026-03-01]\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks[0].checkbox, Some(CheckboxState::Todo));
    assert_eq!(blocks[0].properties.get("status").map(String::as_str), Some("todo"));
    assert_eq!(blocks[0].properties.get("due").map(String::as_str), Some("2026-03-01"));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --test block_parser_test 2>&1 | head -20`
Expected: compilation error — module doesn't exist

**Step 3: Write implementation**

```rust
// src/vault/block.rs

use std::collections::HashMap;
use std::ops::Range;

use regex::Regex;

use super::block_id::BlockId;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockType {
    Paragraph,
    ListItem,
    Heading,
    Code,
    Blockquote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckboxState {
    Todo,
    Done,
    Cancelled,
}

#[derive(Debug, Clone)]
pub struct Block {
    pub block_type: BlockType,
    pub content: String,
    pub block_id: Option<String>,
    pub properties: HashMap<String, String>,
    pub checkbox: Option<CheckboxState>,
    pub depth: usize,
    pub parent_index: Option<usize>,
    pub order_index: usize,
    pub span: Range<usize>,
}

/// Parse markdown into a flat list of blocks with tree structure encoded
/// via `parent_index` and `depth`.
pub fn parse_blocks(markdown: &str) -> Vec<Block> {
    // Implementation uses pulldown-cmark to walk events and build blocks.
    // Key logic:
    // 1. Track list nesting depth via Start(List)/End(List) events
    // 2. For each Item, create a Block with current depth
    // 3. For top-level paragraphs/headings/code, create blocks at depth 0
    // 4. After building raw blocks, post-process:
    //    a. Extract ^id from end of content (regex: \s+\^([A-Za-z0-9]{10,12})$)
    //    b. Extract [key:: value] pairs (regex: \[(\w[\w-]*)::\ ([^\]]+)\])
    //    c. Detect checkboxes from content prefix ([ ], [x], [-])
    //    d. Compute parent_index from depth changes
    //
    // See design doc for full block model specification.
    todo!()
}
```

**Note to implementor:** The actual `parse_blocks` implementation should use `pulldown_cmark::Parser` with `Options::all()`, tracking `Event::Start(Tag::List)` / `Event::End(TagEnd::List)` for depth, `Event::Start(Tag::Item)` for list items, and `Event::Start(Tag::Heading)` / `Event::Start(Tag::Paragraph)` / `Event::Start(Tag::CodeBlock)` for other block types. Use `pulldown_cmark::TextMergeWithOffset` (same pattern as `link.rs:extract_links`). The regex patterns:
- Block ID: `\s+\^([A-Za-z0-9]{10,12})\s*$`
- Inline property: `\[([A-Za-z_][\w-]*)::\s+([^\]]+)\]`
- Checkbox: `^\s*\[([ xX-])\]\s+`

Register `pub mod block;` in `src/vault/mod.rs`.

**Step 4: Run tests to verify they pass**

Run: `cargo test --test block_parser_test -v`
Expected: all 9 tests pass

**Step 5: Commit**

```bash
git add src/vault/block.rs tests/block_parser_test.rs src/vault/mod.rs
git commit -m "feat(vault): add block parser with tree extraction, properties, and checkboxes"
```

---

### Task 3: BlockDeriver — populate blocks + block_properties tables

**Files:**
- Create: `src/vault/derivers/blocks.rs`
- Modify: `src/vault/derivers/mod.rs` — add `pub mod blocks;`
- Modify: `src/vault/derivation.rs` — add `blocks: Vec<Block>` field to `IndexedPage`
- Modify: `src/vault/index.rs` — add schema, register deriver, populate `blocks` field during parse
- Test: `tests/block_index_test.rs`

**Step 1: Write the failing test**

```rust
// tests/block_index_test.rs
use std::fs;
use tempfile::TempDir;
use clepsydra::vault::{Vault, init_vault};
use clepsydra::vault::index::VaultIndex;

fn setup_vault(files: &[(&str, &str)]) -> (TempDir, Vault) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    for (rel_path, content) in files {
        let abs = root.join(rel_path);
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&abs, content).unwrap();
    }
    let vault = Vault::open(&root).unwrap();
    (tmp, vault)
}

#[test]
fn indexes_blocks_from_task_list() {
    let page = r#"---
id: 00000000-0000-0000-0000-000000000001
title: Tasks
---
- [ ] Buy milk [due:: 2026-03-01] [priority:: A] ^abc123DEF0
- [x] Done task
- Regular item
"#;
    let (_tmp, vault) = setup_vault(&[("tasks.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    let conn = index.connection();

    // Should have 3 blocks
    let block_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(block_count, 3);

    // First block should have block_id and properties
    let (block_id, content): (Option<String>, String) = conn
        .query_row(
            "SELECT block_id, content FROM blocks WHERE page_id = ?1 ORDER BY order_index LIMIT 1",
            ["00000000-0000-0000-0000-000000000001"],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(block_id.as_deref(), Some("abc123DEF0"));
    assert_eq!(content, "Buy milk");

    // Check block_properties
    let prop_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM block_properties", [], |r| r.get(0))
        .unwrap();
    // status + due + priority for block 1, status for block 2
    assert_eq!(prop_count, 4);

    let due: String = conn
        .query_row(
            "SELECT bp.value FROM block_properties bp
             JOIN blocks b ON bp.page_id = b.page_id AND bp.span_start = b.span_start
             WHERE bp.key = 'due'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(due, "2026-03-01");
}

#[test]
fn indexes_nested_blocks_with_depth() {
    let page = r#"---
id: 00000000-0000-0000-0000-000000000002
title: Nested
---
- Parent
  - Child one
  - Child two
"#;
    let (_tmp, vault) = setup_vault(&[("nested.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    let conn = index.connection();

    let rows: Vec<(String, i64)> = {
        let mut stmt = conn
            .prepare("SELECT content, depth FROM blocks ORDER BY order_index")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    assert_eq!(rows, vec![
        ("Parent".into(), 0),
        ("Child one".into(), 1),
        ("Child two".into(), 1),
    ]);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --test block_index_test 2>&1 | head -20`
Expected: error — `blocks` table doesn't exist

**Step 3: Implement BlockDeriver and integrate**

**3a. Add schema** — In `src/vault/index.rs`, append to the `SCHEMA` constant:

```sql
CREATE TABLE IF NOT EXISTS blocks (
    block_id    TEXT,
    page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    block_type  TEXT NOT NULL,
    parent_id   TEXT,
    order_index INTEGER NOT NULL,
    content     TEXT NOT NULL,
    depth       INTEGER NOT NULL,
    span_start  INTEGER NOT NULL,
    span_end    INTEGER NOT NULL,
    PRIMARY KEY (page_id, span_start)
);

CREATE INDEX IF NOT EXISTS idx_blocks_block_id ON blocks(block_id) WHERE block_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS block_properties (
    page_id     TEXT NOT NULL,
    span_start  INTEGER NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    FOREIGN KEY (page_id, span_start) REFERENCES blocks(page_id, span_start) ON DELETE CASCADE,
    PRIMARY KEY (page_id, span_start, key)
);

CREATE INDEX IF NOT EXISTS idx_block_props_key_value ON block_properties(key, value);
```

**3b. Add `blocks` field to `IndexedPage`** — In `src/vault/derivation.rs`:

```rust
use super::block::Block;

pub struct IndexedPage {
    // ... existing fields ...
    /// Blocks extracted from the markdown body.
    pub blocks: Vec<Block>,
}
```

**3c. Populate blocks during parse** — In `src/vault/index.rs`, in the parse phase of `build()` and `index_page()`, after extracting links, add:

```rust
let blocks = crate::vault::block::parse_blocks(&body);
```

And include `blocks` in the `IndexedPage` construction.

**3d. Write BlockDeriver** — `src/vault/derivers/blocks.rs`:

```rust
use rusqlite::{Transaction, params};
use crate::vault::block::CheckboxState;
use crate::vault::derivation::{Deriver, IndexedPage};
use crate::vault::index::IndexError;

pub struct BlockDeriver;

impl Deriver for BlockDeriver {
    fn name(&self) -> &str { "blocks" }

    fn derive(&self, page: &IndexedPage, page_id: &str, tx: &Transaction) -> Result<(), IndexError> {
        for block in &page.blocks {
            // Resolve parent_id: if this block has a parent_index, look up that parent's block_id
            let parent_id = block.parent_index
                .and_then(|pi| page.blocks.get(pi))
                .and_then(|parent| parent.block_id.as_deref());

            tx.execute(
                "INSERT INTO blocks (block_id, page_id, block_type, parent_id, order_index, content, depth, span_start, span_end)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    block.block_id,
                    page_id,
                    format!("{:?}", block.block_type).to_lowercase(),
                    parent_id,
                    block.order_index as i64,
                    block.content,
                    block.depth as i64,
                    block.span.start as i64,
                    block.span.end as i64,
                ],
            )?;

            // Insert properties
            for (key, value) in &block.properties {
                tx.execute(
                    "INSERT INTO block_properties (page_id, span_start, key, value)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![page_id, block.span.start as i64, key, value],
                )?;
            }
        }
        Ok(())
    }
}
```

**3e. Register deriver** — In `src/vault/index.rs`, in `VaultIndex::open()` where derivers are initialized (look for the vec containing `CanonicalNameDeriver`, `LinkDeriver`, `TagDeriver`), add `BlockDeriver`.

**3f. Add cleanup** — In `src/vault/index.rs`, where stale derived data is deleted before calling derivers (look for `DELETE FROM links WHERE source_id` and `DELETE FROM tags WHERE page_id`), add:

```sql
DELETE FROM block_properties WHERE page_id = ?1;
DELETE FROM blocks WHERE page_id = ?1;
```

Note: delete `block_properties` first (FK dependency).

**3g. Register module** — In `src/vault/derivers/mod.rs`, add `pub mod blocks;`.

**Step 4: Run tests**

Run: `cargo test --test block_index_test -v`
Expected: both tests pass

Run: `cargo test --test index_test -v`
Expected: existing index tests still pass (no regression)

**Step 5: Commit**

```bash
git add src/vault/block.rs src/vault/derivers/blocks.rs src/vault/derivers/mod.rs \
        src/vault/derivation.rs src/vault/index.rs tests/block_index_test.rs
git commit -m "feat(vault): add block deriver to index block tree and properties"
```

---

### Task 4: Journal date indexing

**Files:**
- Modify: `src/vault/index.rs` — add `journal_date` column, populate from path pattern
- Test: `tests/journal_index_test.rs`

**Step 1: Write the failing test**

```rust
// tests/journal_index_test.rs
use std::fs;
use tempfile::TempDir;
use clepsydra::vault::{Vault, init_vault};
use clepsydra::vault::index::VaultIndex;

fn setup_vault(files: &[(&str, &str)]) -> (TempDir, Vault) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    for (rel_path, content) in files {
        let abs = root.join(rel_path);
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&abs, content).unwrap();
    }
    let vault = Vault::open(&root).unwrap();
    (tmp, vault)
}

#[test]
fn indexes_journal_date_from_path() {
    let page = "---\nid: 00000000-0000-0000-0000-000000000001\ntitle: \"2026-02-17\"\n---\n- Notes\n";
    let (_tmp, vault) = setup_vault(&[("journals/2026-02-17.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    let date: Option<String> = index
        .connection()
        .query_row(
            "SELECT journal_date FROM pages WHERE id = ?1",
            ["00000000-0000-0000-0000-000000000001"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(date, Some("2026-02-17".to_string()));
}

#[test]
fn non_journal_page_has_null_journal_date() {
    let page = "---\nid: 00000000-0000-0000-0000-000000000002\ntitle: Regular\n---\nHello\n";
    let (_tmp, vault) = setup_vault(&[("notes/regular.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    let date: Option<String> = index
        .connection()
        .query_row(
            "SELECT journal_date FROM pages WHERE id = ?1",
            ["00000000-0000-0000-0000-000000000002"],
            |r| r.get(0),
        )
        .unwrap();
    assert!(date.is_none());
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --test journal_index_test 2>&1 | head -20`
Expected: error — `journal_date` column doesn't exist

**Step 3: Implement**

**3a. Add column to schema** — In `src/vault/index.rs`, add to the `pages` CREATE TABLE:

```sql
journal_date    TEXT
```

**3b. Populate during upsert** — In `src/vault/index.rs`, in the page upsert logic, extract the journal date from the vault path:

```rust
fn extract_journal_date(path: &str) -> Option<String> {
    // Match "journals/YYYY-MM-DD" (with or without extension)
    let re = regex::Regex::new(r"^journals/(\d{4}-\d{2}-\d{2})(?:\.md)?$").unwrap();
    re.captures(path).map(|c| c[1].to_string())
}
```

Add `journal_date` to the INSERT/UPDATE statement for pages.

**Step 4: Run tests**

Run: `cargo test --test journal_index_test -v`
Expected: both tests pass

Run: `cargo test --test index_test -v`
Expected: existing tests pass

**Step 5: Commit**

```bash
git add src/vault/index.rs tests/journal_index_test.rs
git commit -m "feat(vault): index journal_date from path convention"
```

---

## Phase 2: Backend API Endpoints

### Task 5: Task query endpoint

**Files:**
- Create: `src/api/tasks.rs`
- Modify: `src/api/mod.rs` — register router
- Test: `tests/api_tasks_test.rs`

**Step 1: Write the failing test**

```rust
// tests/api_tasks_test.rs
//
// Uses axum-test (already in Cargo.toml dev-dependencies) to test the API.
// Follow the same pattern used in any existing API tests (check tests/ for examples).
//
// Key test cases:
// 1. GET /api/vault/tasks returns all tasks (blocks with status property)
// 2. GET /api/vault/tasks?status=todo filters by status
// 3. GET /api/vault/tasks?due_before=2026-03-01 filters by due date
// 4. GET /api/vault/tasks?priority=A filters by priority
// 5. PUT /api/vault/tasks/{page_path}/{span_start}/status updates checkbox in markdown
```

**Note to implementor:** Check `tests/` for existing API test patterns. If no API test helpers exist, create one following the integration test pattern from `tests/index_test.rs` — set up a vault, build index, construct the axum app with `api_router_with_archive_limit()`, and use `axum_test::TestServer`.

**Step 2: Implement task query handler**

Create `src/api/tasks.rs` with:

```rust
// Key types:
#[derive(Deserialize)]
pub struct TaskQueryParams {
    pub status: Option<String>,        // comma-separated: "todo,doing"
    pub due_before: Option<String>,    // ISO date
    pub due_after: Option<String>,
    pub scheduled_before: Option<String>,
    pub scheduled_after: Option<String>,
    pub priority: Option<String>,
    pub tag: Option<String>,
    pub page: Option<String>,          // path prefix
    pub has_no_date: Option<bool>,
    pub sort: Option<String>,          // "due", "priority", "scheduled", "page"
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Serialize)]
pub struct TaskItem {
    pub block_id: Option<String>,
    pub content: String,
    pub status: String,
    pub properties: HashMap<String, String>,
    pub page_path: String,
    pub page_title: Option<String>,
    pub span_start: i64,
    pub span_end: i64,
}

#[derive(Serialize)]
pub struct TaskListResponse {
    pub tasks: Vec<TaskItem>,
    pub total: i64,
}
```

The query handler builds a SQL query dynamically:
- Base: JOIN `blocks` + `block_properties` (status) + `pages`
- WHERE: `block_properties.key = 'status'` (required — only blocks with status are tasks)
- Filter clauses added based on query params, using subqueries on `block_properties` for `due`, `priority`, etc.
- Sort maps to ORDER BY on the appropriate property subquery
- Pagination via LIMIT/OFFSET

**Router:**

```rust
pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_tasks))
        .route("/{page_path}/{span_start}/status", put(update_task_status))
}
```

Register in `src/api/mod.rs`: `.nest("/tasks", tasks::router())`

**Task status mutation handler** (`update_task_status`):
1. Decode `page_path` (percent-encoded), read the markdown file
2. Find the checkbox at byte offset `span_start`
3. Rewrite `[ ]` → `[x]` (done), `[x]` → `[ ]` (todo), etc. based on request body
4. Write file back, re-index the page
5. Emit `SyncNotification::IndexChanged`

**Step 3: Run tests, verify pass**

Run: `cargo test --test api_tasks_test -v`

**Step 4: Commit**

```bash
git add src/api/tasks.rs src/api/mod.rs tests/api_tasks_test.rs
git commit -m "feat(api): add task query and status mutation endpoints"
```

---

### Task 6: Journal API endpoints

**Files:**
- Create: `src/api/journal.rs`
- Modify: `src/api/mod.rs` — register router
- Test: `tests/api_journal_test.rs`

**Step 1: Write the failing test**

```rust
// tests/api_journal_test.rs
// Key test cases:
// 1. GET /api/vault/journal/today creates page if missing, returns it
// 2. GET /api/vault/journal/today returns existing page if present
// 3. GET /api/vault/journal/2026-02-17 returns specific date's journal
// 4. GET /api/vault/journal/2026-02-17 returns 404 if not found
// 5. GET /api/vault/journal/range?from=2026-02-10&to=2026-02-17 returns date range
// 6. GET /api/vault/journal/recent?days=3 returns last 3 days
// 7. POST /api/vault/journal/today/capture appends content to today's journal
// 8. POST /api/vault/journal/today/capture creates journal first if missing
```

**Step 2: Implement journal handlers**

Create `src/api/journal.rs`:

```rust
pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/today", get(get_today).post(capture_today))  // POST for /today/capture see below
        .route("/today/capture", post(capture_today))
        .route("/range", get(get_range))
        .route("/recent", get(get_recent))
        .route("/{date}", get(get_by_date))
}
```

**`get_today` handler:**
1. Compute today's date (`chrono::Utc::now().format("%Y-%m-%d")`)
2. Build path `journals/{date}.md`
3. Check if file exists via vault
4. If not: create with template (UUID, title=date, tags=[journal]), index it
5. Return `PageDetail` (reuse existing response type from pages.rs)

**`capture_today` handler:**
1. Ensure today's journal exists (same as get_today)
2. Read current file content
3. Append request body content with trailing newline
4. Write file, re-index
5. Return 200 with updated page

**`get_by_date` handler:**
1. Parse date from path param, validate format
2. Build path `journals/{date}.md`
3. If exists: return page detail. If not: 404.

**`get_range` / `get_recent` handlers:**
1. Query `pages` table: `WHERE journal_date IS NOT NULL AND journal_date BETWEEN ?1 AND ?2`
2. Return list of page summaries ordered by `journal_date DESC`

Register in `src/api/mod.rs`: `.nest("/journal", journal::router())`

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git add src/api/journal.rs src/api/mod.rs tests/api_journal_test.rs
git commit -m "feat(api): add journal endpoints with auto-creation and quick capture"
```

---

### Task 7: Agenda convenience endpoints

**Files:**
- Create: `src/api/agenda.rs`
- Modify: `src/api/mod.rs` — register router
- Test: `tests/api_agenda_test.rs`

**Step 1: Write the failing test**

```rust
// tests/api_agenda_test.rs
// Key test cases:
// 1. GET /api/vault/agenda/today returns due-today + overdue + scheduled-today tasks
// 2. GET /api/vault/agenda/week returns tasks grouped by date for next 7 days
// 3. GET /api/vault/agenda/overdue returns only overdue incomplete tasks
// 4. Agenda endpoints return empty arrays when no matching tasks exist
```

**Step 2: Implement agenda handlers**

Create `src/api/agenda.rs`. These are thin wrappers that construct `TaskQueryParams` and delegate to the task query logic (extract the query function from `tasks.rs` into a shared `query_tasks(conn, params)` function).

```rust
pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/today", get(agenda_today))
        .route("/week", get(agenda_week))
        .route("/overdue", get(agenda_overdue))
}
```

**`agenda_today`:**
- Queries tasks where `due = today OR scheduled = today OR (due < today AND status = todo)`
- Also includes incomplete tasks from today's journal page (join on `pages.journal_date = today`)

**`agenda_week`:**
- Queries tasks where `due BETWEEN today AND today+7`
- Groups response by date

**`agenda_overdue`:**
- Queries tasks where `due < today AND status IN ('todo', 'doing')`

Register in `src/api/mod.rs`: `.nest("/agenda", agenda::router())`

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git add src/api/agenda.rs src/api/mod.rs tests/api_agenda_test.rs
git commit -m "feat(api): add agenda convenience endpoints (today, week, overdue)"
```

---

## Phase 3: Frontend — Editor Changes

### Task 8: Slate type extensions + converter updates

**Files:**
- Modify: `ui/src/editor/types.ts` — add `block_id`, `properties`, `collapsed`, `checked` fields
- Modify: `ui/src/editor/convert/mdast-to-slate.ts` — parse `^id`, `[key:: value]`, checkboxes
- Modify: `ui/src/editor/convert/slate-to-mdast.ts` — serialize them back
- Test: `ui/src/editor/convert/__tests__/mdast-to-slate.test.ts` — new test cases
- Test: `ui/src/editor/convert/__tests__/slate-to-mdast.test.ts` — new test cases

**Step 1: Write the failing tests**

Add to `ui/src/editor/convert/__tests__/mdast-to-slate.test.ts`:

```typescript
describe("task lists", () => {
  it("converts checkbox list items with checked state", () => {
    const result = markdownToSlate("- [ ] Todo item\n- [x] Done item\n");
    expect(result).toEqual([
      {
        type: "bulleted-list",
        children: [
          { type: "list-item", checked: false, children: [{ text: "Todo item" }] },
          { type: "list-item", checked: true, children: [{ text: "Done item" }] },
        ],
      },
    ]);
  });
});

describe("block IDs", () => {
  it("extracts ^id from end of block text", () => {
    const result = markdownToSlate("- Item ^abc123DEF0\n");
    expect(result[0].children[0]).toMatchObject({
      type: "list-item",
      blockId: "abc123DEF0",
      children: [{ text: "Item" }],
    });
  });
});

describe("inline properties", () => {
  it("extracts [key:: value] pairs", () => {
    const result = markdownToSlate("- Buy milk [due:: 2026-03-01] [priority:: A]\n");
    expect(result[0].children[0]).toMatchObject({
      type: "list-item",
      properties: { due: "2026-03-01", priority: "A" },
      children: [{ text: "Buy milk" }],
    });
  });
});
```

Add to `ui/src/editor/convert/__tests__/slate-to-mdast.test.ts`:

```typescript
describe("task lists round-trip", () => {
  it("serializes checked state back to markdown checkboxes", () => {
    const slate = [{
      type: "bulleted-list" as const,
      children: [
        { type: "list-item" as const, checked: false, children: [{ text: "Todo" }] },
        { type: "list-item" as const, checked: true, children: [{ text: "Done" }] },
      ],
    }];
    const md = slateToMarkdown(slate);
    expect(md).toContain("- [ ] Todo");
    expect(md).toContain("- [x] Done");
  });
});

describe("block ID round-trip", () => {
  it("serializes blockId back to ^id suffix", () => {
    const slate = [{
      type: "bulleted-list" as const,
      children: [
        { type: "list-item" as const, blockId: "abc123DEF0", children: [{ text: "Item" }] },
      ],
    }];
    const md = slateToMarkdown(slate);
    expect(md).toContain("Item ^abc123DEF0");
  });
});

describe("inline properties round-trip", () => {
  it("serializes properties back to [key:: value]", () => {
    const slate = [{
      type: "bulleted-list" as const,
      children: [
        {
          type: "list-item" as const,
          properties: { due: "2026-03-01", priority: "A" },
          children: [{ text: "Buy milk" }],
        },
      ],
    }];
    const md = slateToMarkdown(slate);
    expect(md).toContain("[due:: 2026-03-01]");
    expect(md).toContain("[priority:: A]");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd ui && bun run test -- --run 2>&1 | tail -20`
Expected: type errors and assertion failures

**Step 3: Implement**

**3a. Type extensions** — In `ui/src/editor/types.ts`, add to `ListItemElement`:

```typescript
interface ListItemElement {
  type: "list-item";
  checked?: boolean | null;  // null/undefined = not a task, false = [ ], true = [x]
  blockId?: string;
  properties?: Record<string, string>;
  collapsed?: boolean;
  children: Descendant[];
}
```

Add `blockId`, `properties`, `collapsed` to other block element types too (ParagraphElement, HeadingElement, etc.).

**3b. mdast-to-slate** — In the list item conversion:
- Check `node.checked` (remark-gfm already parses `- [ ]` into `checked: false/true`)
- After converting text content, scan final text node for `\s+\^([A-Za-z0-9]{10,12})$` — extract as `blockId`, trim from text
- Scan text for `\[(\w[\w-]*)::\ ([^\]]+)\]` — extract as `properties`, remove from text

**3c. slate-to-mdast** — In list item serialization:
- If `checked !== undefined && checked !== null`, set `node.checked` on the mdast ListItem (remark-gfm will render `[ ]`/`[x]`)
- If `blockId` present, append ` ^{blockId}` to last text node
- If `properties` present, append ` [key:: value]` for each entry to last text node

**Step 4: Run tests, verify pass**

Run: `cd ui && bun run test -- --run`
Expected: all tests pass including new ones

**Step 5: Commit**

```bash
git add ui/src/editor/types.ts ui/src/editor/convert/ ui/src/editor/convert/__tests__/
git commit -m "feat(editor): round-trip block IDs, inline properties, and checkbox state"
```

---

### Task 9: Outliner keybindings

**Files:**
- Create: `ui/src/editor/plugins/withOutliner.ts`
- Modify: `ui/src/editor/SlateEditor.tsx` — register plugin and key handlers
- Test: `ui/src/editor/plugins/__tests__/withOutliner.test.ts`

**Step 1: Write the failing tests**

```typescript
// ui/src/editor/plugins/__tests__/withOutliner.test.ts
import { describe, expect, it } from "vitest";
import { createEditor, Transforms, Editor, Element } from "slate";
import { withHistory } from "slate-history";
import { withOutliner } from "../withOutliner";

function makeEditor(nodes: any[]) {
  const editor = withOutliner(withHistory(createEditor()));
  editor.children = nodes;
  return editor;
}

describe("withOutliner", () => {
  describe("indent (Tab)", () => {
    it("indents a list item to become child of previous sibling", () => {
      // Create editor with two sibling list items
      // Select second item
      // Call indent operation
      // Assert second item is now nested inside first
    });

    it("does nothing when item has no previous sibling", () => {
      // First item in list cannot indent
    });
  });

  describe("outdent (Shift+Tab)", () => {
    it("outdents a nested list item to become sibling of parent", () => {
      // Create editor with nested list item
      // Select child item
      // Call outdent operation
      // Assert item is now a sibling after the parent
    });

    it("does nothing for top-level items", () => {
      // Already at top level
    });
  });

  describe("toggle done (Cmd+Enter)", () => {
    it("toggles unchecked to checked", () => {
      // Create list item with checked: false
      // Call toggle
      // Assert checked: true
    });

    it("toggles checked to unchecked", () => {
      // Reverse direction
    });
  });
});
```

**Note to implementor:** Slate editor tests require careful node/selection setup. Consult Slate's test utilities. The key operations:

- **Indent:** `Transforms.wrapNodes` to nest the current list item inside a new list under the previous sibling, then `Transforms.moveNodes` to position it.
- **Outdent:** `Transforms.liftNodes` to move the item up one level, then `Transforms.moveNodes` to position after the former parent.
- **Move up/down:** `Transforms.moveNodes` to swap with adjacent sibling. Must move the entire subtree (item + its nested list).
- **Toggle done:** `Transforms.setNodes` to flip `checked` on the list item element.

**Step 2: Implement the plugin**

```typescript
// ui/src/editor/plugins/withOutliner.ts
import { Editor, Transforms, Element, Path, Node } from "slate";

export function withOutliner(editor: Editor): Editor {
  // Override onKeyDown via a custom handler (registered in SlateEditor.tsx)
  // The plugin itself just adds the outliner operations as methods.
  return editor;
}

export function indentListItem(editor: Editor): void { /* ... */ }
export function outdentListItem(editor: Editor): void { /* ... */ }
export function moveBlockUp(editor: Editor): void { /* ... */ }
export function moveBlockDown(editor: Editor): void { /* ... */ }
export function toggleCheckbox(editor: Editor): void { /* ... */ }
```

**In `SlateEditor.tsx`, add to the `onKeyDown` handler:**

```typescript
if (event.key === "Tab" && !event.shiftKey) {
  event.preventDefault();
  indentListItem(editor);
} else if (event.key === "Tab" && event.shiftKey) {
  event.preventDefault();
  outdentListItem(editor);
} else if (event.key === "ArrowUp" && event.altKey) {
  event.preventDefault();
  moveBlockUp(editor);
} else if (event.key === "ArrowDown" && event.altKey) {
  event.preventDefault();
  moveBlockDown(editor);
} else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
  event.preventDefault();
  toggleCheckbox(editor);
}
```

**Step 3: Run tests, verify pass**

Run: `cd ui && bun run test -- --run`

**Step 4: Commit**

```bash
git add ui/src/editor/plugins/withOutliner.ts ui/src/editor/SlateEditor.tsx \
        ui/src/editor/plugins/__tests__/withOutliner.test.ts
git commit -m "feat(editor): add outliner keybindings (indent, outdent, move, toggle)"
```

---

## Phase 4: Frontend — UI Routes + Components

### Task 10: Journal route + page

**Files:**
- Create: `ui/src/routes/journal/$date.tsx` (or `journal.tsx` with date param)
- Create: `ui/src/lib/api/journal.ts` — TanStack Query hooks for journal API
- Modify: `ui/src/routes/__root.tsx` — add journal nav link

**Step 1: Implement API hooks**

```typescript
// ui/src/lib/api/journal.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export function useJournalToday() {
  return useQuery({
    queryKey: ["journal", "today"],
    queryFn: () => fetch("/api/vault/journal/today").then(r => r.json()),
  });
}

export function useJournalByDate(date: string) {
  return useQuery({
    queryKey: ["journal", date],
    queryFn: () => fetch(`/api/vault/journal/${date}`).then(r => r.json()),
    enabled: !!date,
  });
}

export function useQuickCapture() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      fetch("/api/vault/journal/today/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["journal"] }),
  });
}
```

**Step 2: Create route**

The journal route should render:
- Date picker / navigation (prev/next day arrows)
- The Slate editor for that day's journal page (reuse existing `SlateEditor` component)
- Quick capture input at the bottom

**Step 3: Test manually**

Start dev servers: `cargo run -- serve` and `cd ui && bun run dev`
Navigate to `/journal/today` — should auto-create and display today's journal.

**Step 4: Commit**

```bash
git add ui/src/routes/journal/ ui/src/lib/api/journal.ts ui/src/routes/__root.tsx
git commit -m "feat(ui): add journal route with date navigation and quick capture"
```

---

### Task 11: Agenda/Today route + task views

**Files:**
- Create: `ui/src/routes/agenda.tsx`
- Create: `ui/src/lib/api/tasks.ts` — TanStack Query hooks for task/agenda API
- Create: `ui/src/components/TaskList.tsx` — reusable task list component
- Modify: `ui/src/routes/__root.tsx` — add agenda nav link

**Step 1: Implement API hooks**

```typescript
// ui/src/lib/api/tasks.ts
export function useAgendaToday() {
  return useQuery({
    queryKey: ["agenda", "today"],
    queryFn: () => fetch("/api/vault/agenda/today").then(r => r.json()),
  });
}

export function useAgendaWeek() {
  return useQuery({
    queryKey: ["agenda", "week"],
    queryFn: () => fetch("/api/vault/agenda/week").then(r => r.json()),
  });
}

export function useTasks(params: Record<string, string>) {
  const search = new URLSearchParams(params).toString();
  return useQuery({
    queryKey: ["tasks", params],
    queryFn: () => fetch(`/api/vault/tasks?${search}`).then(r => r.json()),
  });
}

export function useToggleTaskStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pagePath, spanStart, status }: { pagePath: string; spanStart: number; status: string }) =>
      fetch(`/api/vault/tasks/${encodeURIComponent(pagePath)}/${spanStart}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["agenda"] });
    },
  });
}
```

**Step 2: Create TaskList component**

`ui/src/components/TaskList.tsx` — renders a list of TaskItem objects with:
- Checkbox (clickable, calls `useToggleTaskStatus`)
- Task content text
- Property badges (due date, priority)
- Link to source page

**Step 3: Create agenda route**

`ui/src/routes/agenda.tsx` with three tabs/sections:
- **Today** — `useAgendaToday()` results + link to today's journal
- **Upcoming** — `useAgendaWeek()` results grouped by date
- **Inbox** — `useTasks({ has_no_date: "true", status: "todo" })` results

**Step 4: Test manually, commit**

```bash
git add ui/src/routes/agenda.tsx ui/src/lib/api/tasks.ts ui/src/components/TaskList.tsx \
        ui/src/routes/__root.tsx
git commit -m "feat(ui): add agenda view with today/upcoming/inbox tabs"
```

---

### Task 12: Checkbox rendering in editor

**Files:**
- Modify: `ui/src/editor/elements/renderElement.tsx` — render checkboxes on list items
- Modify: `ui/src/editor/SlateEditor.tsx` — handle checkbox click

**Step 1: Implement checkbox rendering**

In `renderElement.tsx`, update the list-item case to check for `element.checked !== undefined`:

```tsx
case "list-item": {
  const checked = (element as ListItemElement).checked;
  return (
    <li {...attributes}>
      {checked !== undefined && checked !== null && (
        <span contentEditable={false} className="mr-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={checked}
            onChange={() => toggleCheckbox(editor)}
            className="accent-foreground"
          />
        </span>
      )}
      {children}
    </li>
  );
}
```

**Step 2: Test manually**

Create a page with `- [ ] Test task` and `- [x] Done task`. Verify checkboxes render and toggle.

**Step 3: Commit**

```bash
git add ui/src/editor/elements/renderElement.tsx ui/src/editor/SlateEditor.tsx
git commit -m "feat(editor): render interactive checkboxes on task list items"
```

---

## Phase 5: Integration + Polish

### Task 13: Carry-forward incomplete tasks in journal

**Files:**
- Modify: `src/api/journal.rs` — add carry-forward logic to `get_today` response

**Step 1: Write the failing test**

```rust
// Add to tests/api_journal_test.rs
#[test]
fn today_journal_includes_carried_forward_tasks() {
    // Set up vault with yesterday's journal containing incomplete tasks
    // GET /api/vault/journal/today
    // Assert response includes a "carried_forward" array with yesterday's incomplete tasks
}
```

**Step 2: Implement**

In the `get_today` handler, after returning/creating today's journal, query:

```sql
SELECT b.content, b.block_id, bp_due.value as due, bp_pri.value as priority,
       p.path as page_path
FROM blocks b
JOIN pages p ON b.page_id = p.id
JOIN block_properties bp ON bp.page_id = b.page_id AND bp.span_start = b.span_start
    AND bp.key = 'status' AND bp.value = 'todo'
WHERE p.journal_date IS NOT NULL
    AND p.journal_date < ?1  -- today
    AND p.journal_date >= ?2 -- today minus 7 days (lookback window)
LEFT JOIN block_properties bp_due ON bp_due.page_id = b.page_id
    AND bp_due.span_start = b.span_start AND bp_due.key = 'due'
LEFT JOIN block_properties bp_pri ON bp_pri.page_id = b.page_id
    AND bp_pri.span_start = b.span_start AND bp_pri.key = 'priority'
ORDER BY p.journal_date DESC, b.order_index
```

Include results in the response as a `carried_forward` field.

**Step 3: Run tests, commit**

```bash
git add src/api/journal.rs tests/api_journal_test.rs
git commit -m "feat(api): include carried-forward tasks in today's journal response"
```

---

### Task 14: End-to-end smoke test

**Files:**
- Create: `tests/e2e_tasks_journal_test.rs`

**Step 1: Write integration test**

```rust
// tests/e2e_tasks_journal_test.rs
// Full workflow:
// 1. Create a vault with a journal page containing tasks
// 2. Build index
// 3. Query tasks via API — verify they appear
// 4. Mark a task done via API — verify markdown updated
// 5. Query agenda — verify overdue/today logic
// 6. Create today's journal — verify carry-forward
// 7. Quick capture — verify append
```

This test exercises the full loop: markdown → index → query → mutation → re-index.

**Step 2: Run, verify pass, commit**

```bash
git add tests/e2e_tasks_journal_test.rs
git commit -m "test: add end-to-end smoke test for tasks/journal workflow"
```

---

## Summary

| Phase | Tasks | Focus |
|-------|-------|-------|
| 1: Backend Foundation | 1-4 | Block ID generator, block parser, block deriver, journal date indexing |
| 2: Backend API | 5-7 | Task queries, journal endpoints, agenda endpoints |
| 3: Frontend Editor | 8-9 | Slate type extensions, converters, outliner keybindings |
| 4: Frontend UI | 10-12 | Journal route, agenda route, checkbox rendering |
| 5: Integration | 13-14 | Carry-forward, end-to-end test |

**Parallelism:** Phase 3 (frontend editor) can run in parallel with Phase 2 (backend API) since they don't share files. Phase 4 depends on both Phase 2 (API exists) and Phase 3 (editor changes).
