# Block References Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `((block-id))` transclusion — parse block refs from markdown, store them as links, resolve them to blocks, expose API endpoints for block lookup/search/ID assignment, and render them in the Slate editor with autocomplete.

**Architecture:** Extends the existing link extraction pipeline (`extract_links` → `LinkDeriver` → `resolve_links`) with a new `LinkKind::BlockRef` variant. Adds a `target_block_id` column to `links`. Three new API endpoints under `/blocks`. Frontend adds a `BlockRefElement` inline void type with `((` autocomplete, following the identical pattern used for `WikilinkElement` + `[[` autocomplete.

**Tech Stack:** Rust (pulldown-cmark, rusqlite, axum), TypeScript (Slate, TanStack Query, floating-ui)

**Design doc:** `docs/plans/2026-03-02-block-references-design.md`

---

## Task 1: Add `BlockRef` variant to `LinkKind` and extraction regex

**Files:**
- Modify: `src/vault/link.rs`
- Test: `tests/link_extraction_test.rs`

**Step 1: Write the failing tests**

Add to `tests/link_extraction_test.rs`:

```rust
#[test]
fn extract_block_ref() {
    let body = "See ((abc123DEF0a)) for details.";
    let links = extract_links(body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "abc123DEF0a");
    assert_eq!(links[0].kind, LinkKind::BlockRef);
    // Span covers the full `((abc123DEF0a))` text
    assert_eq!(links[0].span.start, 4);
    assert_eq!(links[0].span.end, 19);
}

#[test]
fn extract_block_ref_10_char() {
    let body = "((abcDEF1234))";
    let links = extract_links(body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "abcDEF1234");
    assert_eq!(links[0].kind, LinkKind::BlockRef);
}

#[test]
fn extract_block_ref_12_char() {
    let body = "((abcDEF12345X))";
    let links = extract_links(body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "abcDEF12345X");
    assert_eq!(links[0].kind, LinkKind::BlockRef);
}

#[test]
fn skip_block_ref_in_code_block() {
    let body = "```\n((abc123DEF0a))\n```";
    let links = extract_links(body);
    assert_eq!(links.len(), 0, "block refs inside fenced code blocks must be ignored");
}

#[test]
fn skip_block_ref_in_inline_code() {
    let body = "`((abc123DEF0a))`";
    let links = extract_links(body);
    assert_eq!(links.len(), 0, "block refs inside inline code must be ignored");
}

#[test]
fn block_ref_and_wikilink_in_same_paragraph() {
    let body = "[[Page A]] mentions ((abc123DEF0a))";
    let links = extract_links(body);
    assert_eq!(links.len(), 2);
    let wiki = links.iter().find(|l| l.kind == LinkKind::Wiki).unwrap();
    let bref = links.iter().find(|l| l.kind == LinkKind::BlockRef).unwrap();
    assert_eq!(wiki.target_raw, "Page A");
    assert_eq!(bref.target_raw, "abc123DEF0a");
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test link_extraction_test 2>&1 | head -30`
Expected: compilation error — `LinkKind::BlockRef` does not exist

**Step 3: Implement `BlockRef` variant and extraction regex**

In `src/vault/link.rs`:

1. Add `BlockRef` to the `LinkKind` enum (after `PropertyRef`):

```rust
/// `((block-id))` block reference (transclusion).
BlockRef,
```

2. Add a lazily compiled regex for block refs (after `wikilink_regex`):

```rust
/// Return a lazily compiled regex for block references: `((10-12 alphanumeric chars))`.
fn block_ref_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\(\(([A-Za-z0-9]{10,12})\)\)").unwrap())
}
```

3. In `extract_links`, inside the `Event::Text(_) if !in_code_block && !in_html_block` arm, add block ref extraction after the wikilink loop (still using the same `source_slice`):

```rust
let block_ref_re = block_ref_regex();
for cap in block_ref_re.captures_iter(source_slice) {
    let m = cap.get(0).unwrap();
    let id = &cap[1];
    let start = range.start + m.start();
    let end = range.start + m.end();
    links.push(Link {
        target_raw: id.to_string(),
        span: start..end,
        kind: LinkKind::BlockRef,
    });
}
```

**Step 4: Run tests to verify they pass**

Run: `cargo test --test link_extraction_test -v`
Expected: all tests PASS (existing + new)

**Step 5: Commit**

```bash
git add src/vault/link.rs tests/link_extraction_test.rs
git commit -m "feat(link): add BlockRef variant and ((id)) extraction regex"
```

---

## Task 2: Add `target_block_id` column to schema and update link deriver

**Files:**
- Modify: `src/vault/index.rs` (schema string)
- Modify: `src/vault/derivers/links.rs`
- Test: existing tests via `cargo test`

**Step 1: Write the failing test**

No new test file needed — the link deriver is exercised by `cargo test` integration tests. The schema change must be backward-compatible (new nullable column). We verify the whole suite still passes.

**Step 2: Add `target_block_id` column to schema**

In `src/vault/index.rs`, in the `SCHEMA` string, modify the `links` table definition. Add `target_block_id TEXT` after `target_path TEXT`:

```sql
CREATE TABLE IF NOT EXISTS links (
    source_id       TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    target_raw      TEXT NOT NULL,
    target_canonical TEXT,
    target_id       TEXT REFERENCES pages(id) ON DELETE SET NULL,
    target_path     TEXT,
    target_block_id TEXT,
    kind            TEXT NOT NULL,
    source_field    TEXT,
    span_start      INTEGER NOT NULL,
    span_end        INTEGER NOT NULL,
    PRIMARY KEY (source_id, span_start)
);
```

Also add an index for block ID lookups:

```sql
CREATE INDEX IF NOT EXISTS idx_links_target_block_id ON links(target_block_id) WHERE target_block_id IS NOT NULL;
```

**Step 3: Update `LinkDeriver` to handle `BlockRef` links**

In `src/vault/derivers/links.rs`, update the body links loop. The match arm for `LinkKind` needs a new case:

```rust
LinkKind::BlockRef => ("block_ref", None),
```

For `BlockRef` links, `target_canonical` should be `NULL` (they don't resolve by page name). The INSERT needs to also set `target_block_id`. Modify the SQL to:

```sql
INSERT OR IGNORE INTO links (source_id, target_raw, target_canonical, target_block_id, kind, source_field, span_start, span_end)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
```

For `BlockRef` links: `target_canonical = None`, `target_block_id = Some(link.target_raw.clone())`.
For other links: `target_block_id = None`, `target_canonical = Some(canonical)`.

Restructure the body links loop:

```rust
for link in &page.body_links {
    let (kind_str, source_field, target_canonical, target_block_id) = match &link.kind {
        LinkKind::Wiki => ("wiki", None, Some(CanonicalName::new(&link.target_raw).as_str().to_owned()), None),
        LinkKind::Markdown => ("markdown", None, Some(CanonicalName::new(&link.target_raw).as_str().to_owned()), None),
        LinkKind::PropertyRef { source_field } => (
            "property_ref",
            Some(source_field.clone()),
            Some(CanonicalName::new(&link.target_raw).as_str().to_owned()),
            None,
        ),
        LinkKind::BlockRef => ("block_ref", None, None, Some(link.target_raw.clone())),
    };
    tx.execute(
        "INSERT OR IGNORE INTO links (source_id, target_raw, target_canonical, target_block_id, kind, source_field, span_start, span_end)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            page_id,
            link.target_raw,
            target_canonical,
            target_block_id,
            kind_str,
            source_field,
            link.span.start as i64,
            link.span.end as i64,
        ],
    )?;
}
```

Also update the property ref links INSERT to include the `target_block_id` column (always NULL for prop refs):

```sql
INSERT OR IGNORE INTO links (source_id, target_raw, target_canonical, target_block_id, kind, source_field, span_start, span_end)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
```

With `None::<String>` for `target_block_id` in the params.

**Step 4: Run tests**

Run: `cargo test`
Expected: all tests PASS

**Step 5: Commit**

```bash
git add src/vault/index.rs src/vault/derivers/links.rs
git commit -m "feat(index): add target_block_id column and BlockRef link derivation"
```

---

## Task 3: Block ref link resolution in `resolve_links`

**Files:**
- Modify: `src/vault/index.rs` (`resolve_links` method)
- Test: new integration test

**Step 1: Write the failing test**

Add a new integration test file `tests/block_ref_resolution_test.rs`. Use the same test helper pattern as `tests/e2e_tasks_journal_test.rs` (check that file for the actual helper imports and setup function signature):

```rust
/// Verify that block refs stored as links get resolved against the blocks table.
#[tokio::test]
async fn block_ref_link_resolves_to_page() {
    // Create a page with a block that has ^id, and another page that references it.
    let files = vec![
        ("source.md", "---\ntitle: Source\n---\n- Buy milk ^abc123DEF0a\n"),
        ("referrer.md", "---\ntitle: Referrer\n---\nSee ((abc123DEF0a))\n"),
    ];
    let (app, _dir) = setup_server_with_files(&files).await;

    // Check backlinks for source page — referrer should appear
    let resp = Request::builder()
        .uri("/api/vault/pages/source.md/backlinks")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(resp).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()
    ).unwrap();
    let backlinks = body.as_array().unwrap();
    assert!(
        backlinks.iter().any(|bl| bl["source_path"].as_str() == Some("referrer.md")),
        "block ref should create a backlink from referrer to source"
    );
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test block_ref_link_resolves 2>&1 | head -20`
Expected: FAIL — block ref links are not resolved (target_id stays NULL), so no backlinks appear.

**Step 3: Add block ref resolution to `resolve_links`**

In `src/vault/index.rs`, in the `resolve_links` method, after the existing canonical name resolution loop and before `tx.commit()`, add a second phase for block refs:

```rust
// Phase 2: Resolve block_ref links by matching target_block_id against blocks table
let mut block_ref_stmt = tx.prepare(
    "SELECT source_id, span_start, target_block_id
     FROM links
     WHERE target_id IS NULL AND kind = 'block_ref' AND target_block_id IS NOT NULL",
)?;

let unresolved_block_refs: Vec<(String, i64, String)> = block_ref_stmt
    .query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?
    .filter_map(|r| r.ok())
    .collect();
drop(block_ref_stmt);

for (source_id, span_start, block_id) in &unresolved_block_refs {
    let mut lookup = tx.prepare(
        "SELECT b.page_id, p.path
         FROM blocks b
         JOIN pages p ON p.id = b.page_id
         WHERE b.block_id = ?1",
    )?;

    let matches: Vec<(String, String)> = lookup
        .query_map(params![block_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .filter_map(|r| r.ok())
        .collect();
    drop(lookup);

    if matches.len() == 1 {
        let (target_id, target_path) = &matches[0];
        tx.execute(
            "UPDATE links SET target_id = ?1, target_path = ?2
             WHERE source_id = ?3 AND span_start = ?4",
            params![target_id, target_path, source_id, span_start],
        )?;
    }
}
```

**Step 4: Run tests**

Run: `cargo test`
Expected: all tests PASS including the new resolution test

**Step 5: Commit**

```bash
git add src/vault/index.rs tests/block_ref_resolution_test.rs
git commit -m "feat(index): resolve block_ref links against blocks table"
```

---

## Task 4: `GET /blocks/{block_id}` API endpoint

**Files:**
- Create: `src/api/blocks.rs`
- Modify: `src/api/mod.rs`
- Test: `tests/api_blocks_test.rs`

**Step 1: Write the failing test**

Create `tests/api_blocks_test.rs` — use the same test helper pattern as other API test files in the codebase:

```rust
#[tokio::test]
async fn get_block_by_id_found() {
    let files = vec![
        ("page.md", "---\ntitle: Test\n---\n- Buy milk ^abc123DEF0a\n"),
    ];
    let (app, _dir) = setup_server_with_files(&files).await;

    let resp = Request::builder()
        .uri("/api/vault/blocks/abc123DEF0a")
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(resp).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()
    ).unwrap();
    assert_eq!(body["block_id"], "abc123DEF0a");
    assert!(body["content"].as_str().unwrap().contains("Buy milk"));
    assert_eq!(body["page_path"], "page.md");
}

#[tokio::test]
async fn get_block_by_id_not_found() {
    let files = vec![
        ("page.md", "---\ntitle: Test\n---\nNo blocks here\n"),
    ];
    let (app, _dir) = setup_server_with_files(&files).await;

    let resp = Request::builder()
        .uri("/api/vault/blocks/nonexistent1")
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(resp).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --test api_blocks_test 2>&1 | head -20`
Expected: compilation error or 404 — no `/blocks` route exists

**Step 3: Implement the endpoint**

Create `src/api/blocks.rs`. Check how other API modules (e.g. `src/api/tasks.rs`) access the index to match the real pattern for `IndexHandle::with_read` or similar. The response struct:

```rust
#[derive(Serialize)]
pub struct BlockResponse {
    pub block_id: String,
    pub content: String,
    pub block_type: String,
    pub properties: std::collections::HashMap<String, String>,
    pub page_path: String,
    pub page_title: Option<String>,
    pub span_start: i64,
    pub span_end: i64,
}
```

Handler queries:
```sql
SELECT b.block_id, b.content, b.block_type, b.span_start, b.span_end, p.path, p.title
FROM blocks b JOIN pages p ON p.id = b.page_id
WHERE b.block_id = ?1
```

Then fetch properties:
```sql
SELECT key, value FROM block_properties
WHERE page_id = (SELECT page_id FROM blocks WHERE block_id = ?1 LIMIT 1)
  AND span_start = ?2
```

Returns 404 if block ID not found.

In `src/api/mod.rs`:
- Add `pub mod blocks;`
- Add `.nest("/blocks", blocks::router())` to `api_router_with_archive_limit`

**Step 4: Run tests**

Run: `cargo test --test api_blocks_test -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/api/blocks.rs src/api/mod.rs tests/api_blocks_test.rs
git commit -m "feat(api): add GET /blocks/{block_id} endpoint"
```

---

## Task 5: `GET /blocks/search` API endpoint

**Files:**
- Modify: `src/api/blocks.rs`
- Test: `tests/api_blocks_test.rs`

**Step 1: Write the failing test**

Add to `tests/api_blocks_test.rs`:

```rust
#[tokio::test]
async fn search_blocks_by_content() {
    let files = vec![
        ("page.md", "---\ntitle: Test\n---\n- Buy milk ^abc123DEF0a\n- Walk the dog\n"),
    ];
    let (app, _dir) = setup_server_with_files(&files).await;

    let resp = Request::builder()
        .uri("/api/vault/blocks/search?q=milk&limit=8")
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(resp).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body: Vec<serde_json::Value> = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()
    ).unwrap();
    assert_eq!(body.len(), 1);
    assert!(body[0]["content"].as_str().unwrap().contains("milk"));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test search_blocks_by_content 2>&1 | head -20`
Expected: FAIL — route does not exist

**Step 3: Implement search endpoint**

In `src/api/blocks.rs`:

```rust
#[derive(Deserialize)]
pub struct BlockSearchQuery {
    pub q: String,
    #[serde(default = "default_limit")]
    pub limit: u32,
}

fn default_limit() -> u32 { 8 }
```

Handler queries:
```sql
SELECT b.block_id, b.content, b.block_type, b.span_start, b.span_end, p.path, p.title
FROM blocks b JOIN pages p ON p.id = b.page_id
WHERE b.content LIKE ?1 COLLATE NOCASE
  AND b.block_type IN ('listitem', 'paragraph', 'heading')
LIMIT ?2
```

Where `?1` is `%{query}%`. Returns `Vec<BlockResponse>`.

Update router: `.route("/search", get(search_blocks))` — must come before `/{block_id}`.

**Step 4: Run tests**

Run: `cargo test --test api_blocks_test -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/api/blocks.rs tests/api_blocks_test.rs
git commit -m "feat(api): add GET /blocks/search endpoint for autocomplete"
```

---

## Task 6: `POST /blocks/assign-id` API endpoint

**Files:**
- Modify: `src/api/blocks.rs`
- Test: `tests/api_blocks_test.rs`

**Step 1: Write the failing test**

Add to `tests/api_blocks_test.rs`:

```rust
#[tokio::test]
async fn assign_block_id() {
    let files = vec![
        ("page.md", "---\ntitle: Test\n---\n- Untagged item\n"),
    ];
    let (app, _dir) = setup_server_with_files(&files).await;

    // First, find the block's span_start by searching
    let search_resp = Request::builder()
        .uri("/api/vault/blocks/search?q=Untagged")
        .body(Body::empty())
        .unwrap();
    let search_response = app.clone().oneshot(search_resp).await.unwrap();
    let blocks: Vec<serde_json::Value> = serde_json::from_slice(
        &axum::body::to_bytes(search_response.into_body(), usize::MAX).await.unwrap()
    ).unwrap();
    assert_eq!(blocks.len(), 1);
    let span_start = blocks[0]["span_start"].as_i64().unwrap();

    // Assign an ID
    let assign_resp = Request::builder()
        .method("POST")
        .uri("/api/vault/blocks/assign-id")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({
                "page_path": "page.md",
                "span_start": span_start
            }).to_string()
        ))
        .unwrap();
    let assign_response = app.clone().oneshot(assign_resp).await.unwrap();
    assert_eq!(assign_response.status(), StatusCode::OK);

    let result: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(assign_response.into_body(), usize::MAX).await.unwrap()
    ).unwrap();
    let block_id = result["block_id"].as_str().unwrap();
    assert!(block_id.len() >= 10 && block_id.len() <= 12);

    // Verify the block is now fetchable by ID
    let get_resp = Request::builder()
        .uri(&format!("/api/vault/blocks/{block_id}"))
        .body(Body::empty())
        .unwrap();
    let get_response = app.oneshot(get_resp).await.unwrap();
    assert_eq!(get_response.status(), StatusCode::OK);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test assign_block_id 2>&1 | head -20`
Expected: FAIL — route does not exist

**Step 3: Implement assign-id endpoint**

In `src/api/blocks.rs`:

```rust
#[derive(Deserialize)]
pub struct AssignIdRequest {
    pub page_path: String,
    pub span_start: i64,
}

#[derive(Serialize)]
pub struct AssignIdResponse {
    pub block_id: String,
}
```

Handler behavior:
1. Resolve `page_path` to absolute path via `state.vault.resolve()`
2. Read file content
3. Look up `span_end` from `blocks` table for the given `(page_path, span_start)`
4. Generate new `BlockId` via `BlockId::generate()`
5. Insert ` ^{id}` at `span_end - 1` (before trailing newline)
6. Write file back to disk
7. Re-index the page and resolve links
8. Return `{ "block_id": "..." }`

Update router: `.route("/assign-id", post(assign_block_id))` — must come before `/{block_id}`.

**Step 4: Run tests**

Run: `cargo test --test api_blocks_test -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/api/blocks.rs tests/api_blocks_test.rs
git commit -m "feat(api): add POST /blocks/assign-id endpoint"
```

---

## Task 7: Frontend — `BlockRefElement` type, Slate plugin, and serialization

**Files:**
- Modify: `ui/src/editor/types.ts`
- Modify: `ui/src/editor/plugins/withWikilinks.ts`
- Modify: `ui/src/editor/convert/mdast-to-slate.ts`
- Modify: `ui/src/editor/convert/slate-to-mdast.ts`
- Modify: `ui/src/editor/elements/renderElement.tsx`
- Create: `ui/src/editor/elements/BlockRefElement.tsx`
- Create: `ui/src/api/blocks.ts`

**Step 1: Add the `BlockRefElement` type**

In `ui/src/editor/types.ts`, add after `WikilinkElement`:

```typescript
export interface BlockRefElement {
  type: "block-ref";
  blockId: string;
  children: CustomText[];
}
```

Add `BlockRefElement` to the `CustomElement` union.

**Step 2: Register as inline void in Slate plugin**

In `ui/src/editor/plugins/withWikilinks.ts`, update both `isInline` and `isVoid` to also handle `"block-ref"`:

`isInline`: return true for `element.type === "wikilink" || element.type === "block-ref"`
`isVoid`: add `element.type === "block-ref"` to the if-check alongside `"wikilink"` and `"thematic-break"`

**Step 3: Add mdast-to-slate parsing for `((id))`**

In `ui/src/editor/convert/mdast-to-slate.ts`, in `convertPhrasingNode` case `"text"`:
- Split text on `\(\(([A-Za-z0-9]{10,12})\)\)` regex
- For each match, insert a `BlockRefElement` inline node
- For non-match segments, emit normal text nodes
- Import `BlockRefElement` type

**Step 4: Add slate-to-mdast serialization**

In `ui/src/editor/convert/slate-to-mdast.ts`:
- In `convertInlineChildren` switch, add `case "block-ref"`: emit `{ type: "text", value: "((blockId))" }`
- In `convertElement` switch, add `case "block-ref"`: wrap in paragraph with text `((blockId))`

**Step 5: Create API hooks**

Create `ui/src/api/blocks.ts` with:
- `BlockDetail` interface (block_id, content, block_type, properties, page_path, page_title, span_start, span_end)
- `useBlockById(blockId)` — TanStack Query hook calling `GET /api/vault/blocks/{blockId}`
- `useBlockSearch(query, limit)` — TanStack Query hook calling `GET /api/vault/blocks/search?q=...&limit=...`
- `assignBlockId(pagePath, spanStart)` — fetch wrapper for `POST /api/vault/blocks/assign-id`

**Step 6: Create `BlockRefElement.tsx` renderer**

Create `ui/src/editor/elements/BlockRefElement.tsx`:
- Non-editable inline span
- Uses `useBlockById(element.blockId)` to fetch content
- Shows loading state, error state ("block not found"), or block content text
- Click navigates to source page via `useOpenTab`
- Styled with `border border-border bg-muted/50` (normal) or `border-destructive` (error)

**Step 7: Register in `renderElement`**

In `ui/src/editor/elements/renderElement.tsx`:
- Import `BlockRefElement` component
- Add `case "block-ref"` that delegates to `<BlockRefElement />`

**Step 8: Run typecheck and lint**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: no errors

**Step 9: Commit**

```bash
git add ui/src/editor/types.ts ui/src/editor/plugins/withWikilinks.ts \
  ui/src/editor/convert/mdast-to-slate.ts ui/src/editor/convert/slate-to-mdast.ts \
  ui/src/editor/elements/renderElement.tsx ui/src/editor/elements/BlockRefElement.tsx \
  ui/src/api/blocks.ts
git commit -m "feat(editor): add BlockRefElement type, plugin, parsing, and rendering"
```

---

## Task 8: Frontend — `((` autocomplete (`BlockRefCombobox`)

**Files:**
- Create: `ui/src/editor/BlockRefCombobox.tsx`
- Modify: `ui/src/editor/SlateEditor.tsx`

**Step 1: Create `BlockRefCombobox.tsx`**

Follow the exact pattern of `WikilinkCombobox.tsx` (same floating-ui setup, keyboard navigation, selection handling) but:
- Backed by `useBlockSearch(query)` instead of page filtering
- On select: if block has `block_id`, insert `((id))` directly; if not, call `assignBlockId()` first, then insert
- Show "Assigning block ID..." state during assignment
- Results show block content as primary text and `page_title` + `^blockId` as secondary

**Step 2: Integrate into `SlateEditor.tsx`**

1. Add `BlockRefTrigger` state (same shape as `WikilinkTrigger`)
2. In `handleChange`, after wikilink trigger detection, add `((` detection:
   - `textBefore.lastIndexOf("((")`
   - Check no `))` after the trigger
   - Set `blockRefTrigger` with anchor and query
3. Add `insertBlockRef(blockId)` function — same pattern as `insertWikilink`:
   - Delete from anchor to cursor
   - Insert `BlockRefElement` node
   - Clear trigger
4. In `handleKeyDown`, capture arrow/enter/escape when `blockRefTrigger` is active
5. Render `<BlockRefCombobox>` when trigger is active

**Step 3: Run typecheck and lint**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: no errors

**Step 4: Commit**

```bash
git add ui/src/editor/BlockRefCombobox.tsx ui/src/editor/SlateEditor.tsx
git commit -m "feat(editor): add (( autocomplete with BlockRefCombobox"
```

---

## Task 9: End-to-end integration test

**Files:**
- Create: `tests/e2e_block_refs_test.rs`

**Step 1: Write the test**

Use the same test helper pattern as `tests/e2e_tasks_journal_test.rs`:

```rust
/// End-to-end: create pages with blocks and block refs, verify parsing,
/// resolution, API endpoints, and backlinks all work together.
#[tokio::test]
async fn e2e_block_refs_workflow() {
    // 1. Setup: source page with ^id, referrer page with ((id))
    // 2. GET /blocks/{block_id} — verify block fetchable
    // 3. GET /blocks/search?q=... — verify search works
    // 4. GET /pages/source.md/backlinks — verify block ref creates backlink
    // 5. POST /blocks/assign-id — assign ID to block without one
    // 6. GET /blocks/{new_id} — verify newly-assigned block fetchable
}
```

**Step 2: Run test**

Run: `cargo test e2e_block_refs_workflow -v`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/e2e_block_refs_test.rs
git commit -m "test: add end-to-end block references integration test"
```

---

## Task 10: Final verification

**Step 1: Run full backend test suite**

Run: `cargo test`
Expected: all tests PASS

**Step 2: Run frontend typecheck and lint**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: no errors

**Step 3: Run clippy**

Run: `cargo clippy -- -D warnings`
Expected: no warnings

**Step 4: Commit any fixes**

If any lint or clippy issues, fix and commit.
