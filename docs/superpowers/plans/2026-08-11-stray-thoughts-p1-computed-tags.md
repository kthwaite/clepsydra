# Stray Thoughts P1 Computed Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kind-derived tags visible, queryable, and non-editable while stopping redundant writes and remaining compatible with legacy frontmatter.

**Architecture:** `Kind` owns the canonical computed-tag rule. The index stores the effective tag union with row provenance, while page frontmatter retains editable tags only. API responses expose computed provenance explicitly; UI reuses existing read-only tag chips. Metadata rewrites strip only the redundant tag for the page's resolved Kind, with no eager vault migration.

**Tech Stack:** Rust 2024, Rusqlite, Axum/Utoipa, Serde/TOML, React 19, TypeScript, TanStack Query, Slate, React Aria Components, Vitest, Bun, Cargo.

## Global Constraints

- Every resolved Kind computes its canonical lowercase tag; Kind is the sole semantic source.
- `PageMeta.tags` remains editable frontmatter storage and never becomes an effective/computed union.
- Stored and computed values are deduplicated case-insensitively after trimming; computed spelling is canonical lowercase.
- A same-spelling tag on a page whose Kind does not derive it remains ordinary editable metadata.
- No eager file migration. Redundant legacy tags disappear only when that page is next rewritten through a normal mutation.
- Tag filters, counts, similarity, Bases, page listings, content index, API, MCP, and Folio must agree on effective tags.
- Encrypted pages expose only existing metadata/Kind classification, never body-derived data.
- Changing Kind updates computed index/API projection atomically with the existing mutation/index notification.
- Every production behavior follows a failing behavioral test.
- Existing unstaged primary-checkout files remain untouched.

## Wire contract

The plan uses these additive response fields:

```rust
pub struct PageSummary {
    // existing fields
    pub tags: Vec<String>,          // effective union for read/filter surfaces
    pub computed_tags: Vec<String>, // provenance subset
}

pub struct PageDetail {
    pub meta: PageMeta,             // editable tags only in response copy
    pub computed_tags: Vec<String>,
    // existing fields
}

pub struct ContentEntry {
    pub tags: Vec<String>,
    pub computed_tags: Vec<String>,
    // existing fields
}

pub struct TagCount {
    pub tag: String,
    pub count: i64,          // distinct pages carrying the effective tag
    pub computed_count: i64, // pages deriving it from Kind
}
```

Existing clients that only read `tags` continue seeing an effective flat list. Editing clients use `meta.tags` plus `computed_tags`; they never infer immutability from spelling.

---

### Task 1: Define the Kind-derived tag domain contract

**Files:**
- Modify: `src/vault/kind.rs`
- Test: inline tests in `src/vault/kind.rs`

**Interfaces:**

```rust
impl Kind {
    pub const fn computed_tag(self) -> &'static str;
}

pub fn is_computed_tag(kind: Kind, tag: &str) -> bool;
pub fn editable_tags<'a>(kind: Kind, stored: &'a [String]) -> Vec<&'a str>;
pub fn effective_tags(kind: Kind, stored: &[String]) -> Vec<String>;
```

- `editable_tags` removes only stored values equal to `kind.computed_tag()` after trim/case folding and case-insensitive duplicates; other Kind names remain editable.
- `effective_tags` preserves first-seen editable order and appends the canonical computed value once.

- [ ] **Step 1: Add failing mapping and dedupe tests**

```rust
assert_eq!(Kind::Journal.computed_tag(), "journal");
assert_eq!(Kind::Project.computed_tag(), "project");
assert_eq!(
    effective_tags(Kind::Journal, &["Research".into(), "JOURNAL".into()]),
    ["Research", "journal"],
);
assert_eq!(
    editable_tags(Kind::Note, &["journal".into()]),
    ["journal"],
);
```

Cover every Kind token, whitespace, case variants, duplicates, and stable order.

- [ ] **Step 2: Run tests RED**

```bash
cargo test vault::kind::tests --lib
```

- [ ] **Step 3: Implement pure helpers without allocation in predicates**

Use `trim().eq_ignore_ascii_case(kind.computed_tag())` for computed matching. Allocate only the returned vectors; do not lowercase/copy every tag merely to compare it.

- [ ] **Step 4: Run tests GREEN and commit**

```bash
cargo test vault::kind::tests --lib
git add src/vault/kind.rs
git commit -m "feat(tags): define kind-derived tags"
```

---

### Task 2: Index effective tags with provenance

**Files:**
- Modify: `src/vault/index.rs` (schema, migration, derivation-version invalidation, tests)
- Modify: `src/vault/derivers/tags.rs`
- Modify: `src/vault/query.rs`
- Modify: `src/vault/base.rs`
- Test: `tests/index_test.rs`
- Test: focused inline tests in the modified modules

**Interfaces:**
- Extend SQLite `tags` with `computed INTEGER NOT NULL DEFAULT 0` while retaining `PRIMARY KEY(page_id, tag)`.
- Add a derivation schema version in `derivation_meta`; a version change forces one complete re-derivation so unchanged pages receive computed rows.
- `TagDeriver` inserts editable tags with `computed=0` and exactly one canonical Kind tag with `computed=1`.

- [ ] **Step 1: Add failing index projection tests**

Index a JOURNAL with stored `research`, a NOTE with stored `journal`, and a legacy JOURNAL with stored `JOURNAL`. Assert rows:

```text
journal-page: research/0, journal/1
note-page: journal/0, note/1
legacy-journal: journal/1 only
```

Assert a no-file-change reopen/build performs the derivation-version migration and creates computed rows. Assert a second build skips unchanged pages again.

- [ ] **Step 2: Run index tests RED**

```bash
cargo test --test index_test computed_tags
```

- [ ] **Step 3: Add idempotent schema migration**

Before executing schema/index definitions, detect `tags.computed` with `PRAGMA table_info(tags)` and `ALTER TABLE` only when absent. Add a `tag_derivation_version` key or shared derivation schema key. In `build`, force rederive when the stored version differs, then store the current constant after a successful transaction.

- [ ] **Step 4: Implement complete TagDeriver output**

Resolve Kind once from `page.vault_path` and `page.meta.kind`. Insert `editable_tags(kind, &page.meta.tags)` with false provenance and insert `kind.computed_tag()` with true provenance. Since redundant legacy storage must be represented as computed, never let the stored duplicate win the primary-key conflict.

- [ ] **Step 5: Align query and Base semantics**

SQL tag comparisons continue using the effective `tags` table. When a query returns the `tags` property, aggregate effective rows rather than reading `meta_json.tags`. In-memory Base comparison must call `effective_tags(resolved_kind, &meta.tags)` using the page path/declared Kind in its evaluation context. Add parity tests that the SQL and in-memory paths match computed and ordinary same-spelling cases.

- [ ] **Step 6: Verify index/query/base GREEN**

```bash
cargo test --test index_test computed_tags
cargo test vault::query::tests --lib
cargo test vault::base::tests --lib
```

- [ ] **Step 7: Commit**

```bash
git add src/vault/index.rs src/vault/derivers/tags.rs src/vault/query.rs src/vault/base.rs tests/index_test.rs
git commit -m "feat(index): project computed tags"
```

---

### Task 3: Expose computed provenance through page and index APIs

**Files:**
- Modify: `src/api/pages.rs`
- Modify: `src/api/folders.rs` if it uses `page_summary_from_row`
- Modify: `src/api/index_routes.rs`
- Modify: `src/api/openapi.rs`
- Modify: `tests/api_pages.rs`
- Modify: `tests/openapi_contract.rs`
- Modify: `src/mcp/server.rs` MCP tags/page tests
- Regenerate: `ui/src/api/schema.d.ts`
- Modify: `ui/src/api/types.ts` only if aliases require it

**Interfaces:**
- Implement the additive wire fields in **Wire contract** above.
- `PageDetail.meta.tags` is a response-owned editable copy with the page's redundant computed tag removed; the disk page is not changed by a GET.
- Page tag filtering and `/index/tags` operate on effective rows.

- [ ] **Step 1: Add failing page detail/list tests**

For a legacy JOURNAL with frontmatter tags `["journal", "research"]`, assert GET does not change file bytes and returns:

```json
{
  "meta": { "tags": ["research"] },
  "computed_tags": ["journal"]
}
```

List pages and content index must return `tags: ["research", "journal"]` and `computed_tags: ["journal"]`. A NOTE with stored `journal` returns it in editable/effective tags and not computed tags.

- [ ] **Step 2: Add failing counts/filter/MCP tests**

Assert `GET /index/tags` counts each page once despite legacy duplication and reports `computed_count`. Assert `GET /pages?tag=journal`, content-index filters, Bases, and MCP `vault_tags` include computed matches. Assert encrypted JOURNAL projection contains no body data beyond existing behavior.

- [ ] **Step 3: Run API tests RED**

```bash
cargo test --test api_pages computed_tags
cargo test api::index_routes::tests::computed_tag_counts --lib -- --exact
cargo test mcp::server::tests::tags_include_computed_classifications --lib -- --exact
```

- [ ] **Step 4: Implement canonical row mappers**

Extend every SELECT feeding `page_summary_from_row` with a computed-tags aggregate in the documented column order. Use `COUNT(DISTINCT page_id)` and `SUM(computed)`/distinct conditional counting for tag counts. In `page_detail`, resolve Kind before moving metadata, replace the response copy's tags with `editable_tags`, and populate `computed_tags` from the resolved Kind.

Do not mutate files during GET. Do not duplicate Kind spelling logic in API modules.

- [ ] **Step 5: Lock OpenAPI and regenerate UI types**

Add schema assertions for `computed_tags` and `computed_count`, then run the repository OpenAPI generation workflow. Generated `ui/src/api/schema.d.ts` must describe the fields; do not hand-edit generated definitions except through generation.

- [ ] **Step 6: Run API contract GREEN**

```bash
cargo test --test api_pages computed_tags
cargo test api::index_routes::tests --lib
cargo test mcp::server::tests --lib
cargo test --test openapi_contract
```

- [ ] **Step 7: Commit**

```bash
git add src/api/pages.rs src/api/folders.rs src/api/index_routes.rs src/api/openapi.rs src/mcp/server.rs tests/api_pages.rs tests/openapi_contract.rs ui/src/api/schema.d.ts ui/src/api/types.ts
git commit -m "feat(api): expose computed tag provenance"
```

Stage only changed files.

---

### Task 4: Apply read-compatible metadata cutover at mutation boundaries

**Files:**
- Modify: `src/vault/mutation_coordinator.rs`
- Modify: `src/api/journal.rs`
- Test: focused inline tests in `src/vault/mutation_coordinator.rs`
- Modify: `tests/api_journal_test.rs`
- Modify: `tests/api_pages.rs`
- Audit without duplicating cleanup: `src/api/tasks.rs`, `src/api/board/tasks.rs`, `src/api/board/cycles.rs`, `src/api/conversations.rs`, `src/api/academic.rs`, `src/api/archive.rs`, `src/api/index_routes.rs`, `src/api/base_members.rs`

**Interfaces:**
- Add a private mutation-boundary helper:

```rust
fn strip_redundant_computed_tag(path: &VaultPath, meta: &mut PageMeta) {
    let (kind, _) = kind::resolve(path.as_str(), meta.kind);
    meta.tags.retain(|tag| !kind::is_computed_tag(kind, tag));
}
```

Use the actual helper signature from Task 1; do not recreate comparison logic.

- [ ] **Step 1: Add failing create/update cutover tests**

Assert creating/updating a JOURNAL with `journal` in requested tags writes no redundant value but returns computed `journal`. Assert updating only the body of a legacy JOURNAL also removes redundant stored `journal` on that normal rewrite. Assert untouched legacy files remain byte-identical.

Add a Kind transition test: NOTE with editable `journal` changes to JOURNAL, so the next atomic write removes stored `journal` and the response/index exposes computed `journal`; changing back to NOTE removes computed `journal` and does not invent a stored one.

- [ ] **Step 2: Run mutation tests RED**

```bash
cargo test vault::mutation_coordinator::tests::rewrites_strip_redundant_computed_tags --lib -- --exact
cargo test --test api_pages computed_tag_cutover
```

- [ ] **Step 3: Centralize cleanup in create/update coordinator paths**

Call the helper after final path/Kind are known and before rendering candidate bytes in both `create_page` and `update_page`. This covers every API/MCP subsystem using the coordinator; audited adapters must not each add their own stripping code.

- [ ] **Step 4: Stop journal creation from persisting `journal`**

Remove `meta.tags = vec!["journal".to_string()]` from `src/api/journal.rs`. Keep Kind/path classification, returned computed tag, and queryability tests.

- [ ] **Step 5: Run cutover tests GREEN**

```bash
cargo test vault::mutation_coordinator::tests --lib
cargo test --test api_pages computed_tag_cutover
cargo test --test api_journal_test
```

- [ ] **Step 6: Commit**

```bash
git add src/vault/mutation_coordinator.rs src/api/journal.rs tests/api_pages.rs tests/api_journal_test.rs
git commit -m "refactor(tags): stop storing kind-derived tags"
```

---

### Task 5: Consume computed tags in Folio and filtering UI

**Files:**
- Modify: `ui/src/editor/usePageEditor.ts`
- Modify: `ui/src/components/codex/Folio.tsx`
- Modify: `ui/src/editor/PageEditorHeader.tsx` only if existing `derivedTags` typing needs widening
- Modify: `ui/src/components/codex/LockedFolio.tsx` only if wiring requires it
- Modify: `ui/src/components/codex/Gazetteer.tsx`
- Modify: `ui/src/components/codex/MobileGazetteer.tsx`
- Modify: `ui/src/components/codex/constellation-filters.ts`
- Modify: `ui/src/components/codex/__tests__/Folio.test.tsx`
- Modify: `ui/src/editor/PageEditorHeader.test.tsx`
- Modify: `ui/src/components/ui/__tests__/tag-input.test.tsx`
- Modify: `ui/src/components/codex/Gazetteer.test.ts`
- Modify: `ui/src/components/codex/__tests__/MobileGazetteer.test.tsx`

**Interfaces:**
- `PageEditorState` gains `computedTags: string[]`; `tags` remains editable only.
- `Folio` passes `computedTags` as existing `derivedTags/readOnlyValues` to editable, read-only, and locked headers.
- Gazetteer/content filters consume API `tags` effective union and `computed_tags` only for provenance styling/non-editability.

- [ ] **Step 1: Add failing editor-state and Folio tests**

Mock a JOURNAL response with `meta.tags: ["research"]` and `computed_tags: ["journal"]`. Assert both chips render, only research has a removal action, keyboard removal cannot target journal, and save payload sends only `research`.

Mock a NOTE with editable `meta.tags: ["journal"]` and empty computed tags; assert journal is removable. Repeat for locked/read-only Folio rendering.

- [ ] **Step 2: Run Folio/header tests RED**

```bash
bun run test src/components/codex/__tests__/Folio.test.tsx src/editor/PageEditorHeader.test.tsx src/components/ui/__tests__/tag-input.test.tsx
```

- [ ] **Step 3: Replace Journal hardcoding with API provenance**

Initialize `computedTags` from page detail in `usePageEditor`. In Folio remove `isJournal` tag filtering, the effect that writes filtered legacy tags, and every `isJournal ? ["journal"] : []` branch. Pass `editor.computedTags` to all existing derived/read-only tag props. Keep Kind presentation logic for non-tag behavior.

- [ ] **Step 4: Verify Gazetteer and Constellation effective filtering**

Add fixtures whose only matching value is computed. Assert desktop/mobile Gazetteer and constellation filters include them because API `ContentEntry.tags` is the effective union. Do not recompute Kind tags in React.

- [ ] **Step 5: Run focused UI GREEN**

```bash
bun run test src/components/codex/__tests__/Folio.test.tsx src/editor/PageEditorHeader.test.tsx src/components/ui/__tests__/tag-input.test.tsx src/components/codex/Gazetteer.test.ts src/components/codex/__tests__/MobileGazetteer.test.tsx
```

- [ ] **Step 6: Commit**

```bash
git add ui/src/editor/usePageEditor.ts ui/src/components/codex/Folio.tsx ui/src/editor/PageEditorHeader.tsx ui/src/components/codex/LockedFolio.tsx ui/src/components/codex/Gazetteer.tsx ui/src/components/codex/MobileGazetteer.tsx ui/src/components/codex/constellation-filters.ts ui/src/components/codex/__tests__/Folio.test.tsx ui/src/editor/PageEditorHeader.test.tsx ui/src/components/ui/__tests__/tag-input.test.tsx ui/src/components/codex/Gazetteer.test.ts ui/src/components/codex/__tests__/MobileGazetteer.test.tsx
git commit -m "feat(ui): render computed tags as read only"
```

Stage only changed files.

---

### Task 6: Review and computed-tag smoke verification

- [ ] **Step 1: Audit all tag readers and writers**

Use symbol references for exported DTOs and tag helpers. Every read surface must intentionally consume editable or effective tags; every writer must pass through coordinator cleanup. Remove obsolete Journal-only UI filtering and comments.

- [ ] **Step 2: Verify no eager migration**

Start with an untouched legacy JOURNAL and confirm startup/indexing leaves file bytes unchanged. Read/filter it successfully, then perform a normal metadata/body write and confirm only then that redundant frontmatter disappears.

- [ ] **Step 3: Smoke Kind transitions and same-spelling tags**

Exercise JOURNAL computed `journal`, NOTE editable `journal`, Kind transitions, Folio removal attempts, Gazetteer/tag filters, MCP `vault_tags`, and encrypted metadata projection.

- [ ] **Step 4: Commit review corrections**

Commit only if the audit or smoke test required changes.
