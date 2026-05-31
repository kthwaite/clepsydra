# Kind & Project Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote `kind` and `project` to first-class, index-derived fields on every page and expose them (plus tags) through the page API, so the frontend trusts backend kind instead of path-deriving it.

**Architecture:** `kind` is a closed Rust enum resolved per page as *declared* (frontmatter `type:`) → *inferred* (top-level folder) → `NOTE`. The resolved kind, an `inferred` flag, and an optional `project` slug are computed at index time and stored as columns on the `pages` table — exactly mirroring the existing derived `journal_date` column — re-derived on every index build. The API surfaces them on `PageSummary`/`PageDetail`. This is the backend foundation; filename identity (Plan 2), projection/reconcile (Plan 3), and the frontend UX (Plan 4) build on it.

**Tech Stack:** Rust 2024, rusqlite (bundled SQLite), serde / serde_yaml, Axum, utoipa (OpenAPI). Frontend: TypeScript, React 19.

**Reference docs:** `docs/adr/0001-metadata-projected-folder-layout.md`, `CONTEXT.md` (Kind/Project/Todo/Capture glossary).

---

## File Structure

- `src/vault/kind.rs` — **new.** The `Kind` enum, the canonical `kind → folder` map, the synonym `folder → kind` inference map, and the `resolve(path, declared) -> (Kind, inferred)` function. One responsibility: the kind vocabulary and its folder relationships.
- `src/vault/page.rs` — **modify.** Promote `kind` (from frontmatter `type:`/`kind:`) and `project` out of the `extra` flatten-bucket into typed `PageMeta` fields.
- `src/vault/index.rs` — **modify.** Add `kind`/`kind_inferred`/`project` columns to the `pages` table + migration + indexes; compute and bind them at the two `INSERT INTO pages` sites.
- `src/vault/mod.rs` — **modify.** Register the new `kind` module.
- `src/api/pages.rs` — **modify.** Add `kind`/`inferred`/`project`/`tags` to `PageSummary` and `PageMetaResponse`/`PageDetail`; extend the list query.
- `ui/src/api/types.ts` (and generated schema) — **modify.** Add the new fields to the page summary/detail types.
- `ui/src/lib/kind.ts` — **modify.** Make `resolveKindFromPath`/`parseFrontmatterKind` vestigial fallbacks; prefer the backend `kind`.

---

## Task 1: Kind enum + folder maps module

**Files:**
- Create: `src/vault/kind.rs`
- Modify: `src/vault/mod.rs` (register module)
- Test: inline `#[cfg(test)]` in `src/vault/kind.rs`

- [ ] **Step 1: Write the failing tests**

Create `src/vault/kind.rs`:

```rust
//! The page `kind` vocabulary and its folder relationships.
//!
//! Resolution precedence: declared (frontmatter `type:`) -> inferred
//! (top-level folder) -> NOTE. See docs/adr/0001-metadata-projected-folder-layout.md.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// The single type discriminator of a page. Closed enum; expand by editing here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Note,
    Project,
    Journal,
    Todo,
    Quote,
    Book,
    Capture,
    Code,
    Person,
}

impl Kind {
    /// The one canonical folder a page of this kind is filed under (lowercase
    /// plural). Distinct from the many-to-one inference map.
    pub fn canonical_folder(self) -> &'static str {
        match self {
            Kind::Note => "notes",
            Kind::Project => "projects",
            Kind::Journal => "journals",
            Kind::Todo => "todos",
            Kind::Quote => "quotes",
            Kind::Book => "books",
            Kind::Capture => "captures",
            Kind::Code => "code",
            Kind::Person => "people",
        }
    }

    /// The UPPERCASE wire/storage token.
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Note => "NOTE",
            Kind::Project => "PROJECT",
            Kind::Journal => "JOURNAL",
            Kind::Todo => "TODO",
            Kind::Quote => "QUOTE",
            Kind::Book => "BOOK",
            Kind::Capture => "CAPTURE",
            Kind::Code => "CODE",
            Kind::Person => "PERSON",
        }
    }

    /// Parse a kind token case-insensitively. Unknown -> None.
    pub fn from_token(s: &str) -> Option<Kind> {
        match s.trim().to_ascii_uppercase().as_str() {
            "NOTE" => Some(Kind::Note),
            "PROJECT" => Some(Kind::Project),
            "JOURNAL" => Some(Kind::Journal),
            "TODO" => Some(Kind::Todo),
            "QUOTE" => Some(Kind::Quote),
            "BOOK" => Some(Kind::Book),
            "CAPTURE" => Some(Kind::Capture),
            "CODE" => Some(Kind::Code),
            "PERSON" => Some(Kind::Person),
            _ => None,
        }
    }

    /// Map a top-level folder name (lowercased) to a kind, accepting synonyms.
    /// Unknown folder -> None (caller falls back to NOTE).
    pub fn from_folder(folder: &str) -> Option<Kind> {
        match folder {
            "notes" | "note" => Some(Kind::Note),
            "projects" | "project" => Some(Kind::Project),
            "journals" | "journal" | "daily" | "dailies" | "diary" => Some(Kind::Journal),
            "todos" | "todo" | "tasks" | "task" => Some(Kind::Todo),
            "quotes" | "quote" => Some(Kind::Quote),
            "books" | "book" | "reading" | "library" => Some(Kind::Book),
            "captures" | "capture" | "inbox" | "clippings" => Some(Kind::Capture),
            "code" | "snippets" => Some(Kind::Code),
            "people" | "persons" | "person" | "contacts" => Some(Kind::Person),
            _ => None,
        }
    }
}

impl fmt::Display for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for Kind {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Kind {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        Kind::from_token(&raw)
            .ok_or_else(|| serde::de::Error::custom(format!("unknown kind: {raw}")))
    }
}

/// Resolve a page's kind from its path and any declared kind.
/// Returns the resolved kind and whether it was inferred (declared absent).
pub fn resolve(path: &str, declared: Option<Kind>) -> (Kind, bool) {
    if let Some(k) = declared {
        return (k, false);
    }
    let top = path.trim_start_matches('/').split('/').next().unwrap_or("");
    let inferred = Kind::from_folder(&top.to_ascii_lowercase()).unwrap_or(Kind::Note);
    (inferred, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_token_is_case_insensitive() {
        assert_eq!(Kind::from_token("quote"), Some(Kind::Quote));
        assert_eq!(Kind::from_token("  QUOTE "), Some(Kind::Quote));
        assert_eq!(Kind::from_token("recipe"), None);
    }

    #[test]
    fn canonical_folder_is_lowercase_plural() {
        assert_eq!(Kind::Journal.canonical_folder(), "journals");
        assert_eq!(Kind::Todo.canonical_folder(), "todos");
        assert_eq!(Kind::Person.canonical_folder(), "people");
    }

    #[test]
    fn declared_kind_wins_and_is_not_inferred() {
        let (k, inferred) = resolve("projects/x.md", Some(Kind::Quote));
        assert_eq!(k, Kind::Quote);
        assert!(!inferred);
    }

    #[test]
    fn folder_is_inferred_with_synonyms() {
        assert_eq!(resolve("journals/2026-05-31.md", None), (Kind::Journal, true));
        assert_eq!(resolve("diary/x.md", None), (Kind::Journal, true));
        assert_eq!(resolve("tasks/x.md", None), (Kind::Todo, true));
    }

    #[test]
    fn unknown_or_rootless_folder_infers_note() {
        assert_eq!(resolve("misc/x.md", None), (Kind::Note, true));
        assert_eq!(resolve("toplevel.md", None), (Kind::Note, true));
    }
}
```

- [ ] **Step 2: Register the module**

In `src/vault/mod.rs`, add alongside the other `pub mod` declarations:

```rust
pub mod kind;
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cargo test --lib vault::kind`
Expected: 5 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/vault/kind.rs src/vault/mod.rs
git commit -m "feat(vault): Kind enum + canonical/inference folder maps"
```

---

## Task 2: Promote `kind` and `project` onto PageMeta

**Files:**
- Modify: `src/vault/page.rs:18-32` (the `PageMeta` struct)
- Test: inline `#[cfg(test)]` in `src/vault/page.rs`

- [ ] **Step 1: Write the failing test**

Add to the test module in `src/vault/page.rs` (create one if absent):

```rust
#[cfg(test)]
mod kind_field_tests {
    use super::*;
    use crate::vault::kind::Kind;

    #[test]
    fn parses_declared_type_into_kind_field() {
        let yaml = "id: 0190f8a0-0000-7000-8000-000000000000\ntype: quote\nproject: clepsydra\n";
        let meta: PageMeta = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(meta.kind, Some(Kind::Quote));
        assert_eq!(meta.project.as_deref(), Some("clepsydra"));
        // type/project must NOT leak into the extra bucket
        assert!(!meta.extra.contains_key("type"));
        assert!(!meta.extra.contains_key("project"));
    }

    #[test]
    fn kind_round_trips_back_to_type_key() {
        let yaml = "id: 0190f8a0-0000-7000-8000-000000000000\ntype: BOOK\n";
        let meta: PageMeta = serde_yaml::from_str(yaml).unwrap();
        let out = serde_yaml::to_string(&meta).unwrap();
        assert!(out.contains("type: BOOK"), "serialized as: {out}");
    }

    #[test]
    fn absent_type_is_none() {
        let yaml = "id: 0190f8a0-0000-7000-8000-000000000000\n";
        let meta: PageMeta = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(meta.kind, None);
        assert_eq!(meta.project, None);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --lib page::kind_field_tests`
Expected: FAIL — `PageMeta` has no field `kind`/`project`.

- [ ] **Step 3: Add the typed fields**

In `src/vault/page.rs`, add `use crate::vault::kind::Kind;` near the top imports, then add two fields to `PageMeta` immediately after `aliases` (before `created_at`):

```rust
    /// Declared kind, from frontmatter `type:` (alias `kind:`). `None` => inferred.
    #[serde(
        default,
        rename = "type",
        alias = "kind",
        skip_serializing_if = "Option::is_none"
    )]
    pub kind: Option<Kind>,
    /// Optional project slug; forms a subfolder beneath the kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
```

Then update `PageMeta::new()` to initialise both to `None` (add `kind: None,` and `project: None,` alongside the other field initialisers).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --lib page::kind_field_tests`
Expected: 3 tests pass.

- [ ] **Step 5: Run the full page test module to check for regressions**

Run: `cargo test --lib page`
Expected: all pass (the new fields are `#[serde(default)]`, so existing frontmatter parses unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/vault/page.rs
git commit -m "feat(vault): promote kind (type:) and project onto PageMeta"
```

---

## Task 3: Add `kind`/`kind_inferred`/`project` columns to the index schema

**Files:**
- Modify: `src/vault/index.rs:124-135` (the `pages` CREATE TABLE), the schema-migration block (~`index.rs:243-271`), and the index-creation block (~`index.rs:164-168`)
- Test: inline `#[cfg(test)]` in `src/vault/index.rs`

- [ ] **Step 1: Write the failing test**

Add to the test module in `src/vault/index.rs`:

```rust
#[test]
fn pages_table_has_kind_columns() {
    let index = VaultIndex::open_in_memory().unwrap();
    let conn = index.connection();
    let cols: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('pages')")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(cols.contains(&"kind".to_string()));
    assert!(cols.contains(&"kind_inferred".to_string()));
    assert!(cols.contains(&"project".to_string()));
}
```

> If `open_in_memory` is not the existing constructor, use the same helper the surrounding tests use to obtain a `VaultIndex` (grep the test module for the setup helper and match it).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --lib vault::index::tests::pages_table_has_kind_columns`
Expected: FAIL — columns absent.

- [ ] **Step 3: Add the columns to CREATE TABLE**

In the `pages` CREATE TABLE (`index.rs:124`), change the final lines from:

```sql
    content_hash    TEXT NOT NULL,
    journal_date    TEXT
);
```

to:

```sql
    content_hash    TEXT NOT NULL,
    journal_date    TEXT,
    kind            TEXT NOT NULL DEFAULT 'NOTE',
    kind_inferred   INTEGER NOT NULL DEFAULT 1,
    project         TEXT
);
```

- [ ] **Step 4: Add migration for existing databases**

In the migration block (near `index.rs:243`, where `journal_date`/`target_id` migrations live), add idempotent `ALTER TABLE` statements that ignore the "duplicate column" error, mirroring the existing migration style there:

```rust
// Migration: kind/project columns (added with the metadata-projection work).
for stmt in [
    "ALTER TABLE pages ADD COLUMN kind TEXT NOT NULL DEFAULT 'NOTE'",
    "ALTER TABLE pages ADD COLUMN kind_inferred INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE pages ADD COLUMN project TEXT",
] {
    // duplicate column => already migrated; ignore.
    let _ = conn.execute(stmt, []);
}
```

> Match the exact error-handling idiom already used by the neighbouring migrations (some use `let _ =`, some match on the error string). Follow the local convention.

- [ ] **Step 5: Add indexes**

In the index-creation block (near `index.rs:164`), add:

```sql
CREATE INDEX IF NOT EXISTS idx_pages_kind ON pages(kind);
CREATE INDEX IF NOT EXISTS idx_pages_project ON pages(project) WHERE project IS NOT NULL;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cargo test --lib vault::index::tests::pages_table_has_kind_columns`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/vault/index.rs
git commit -m "feat(index): add kind/kind_inferred/project columns to pages"
```

---

## Task 4: Compute and persist kind/project at index time

**Files:**
- Modify: `src/vault/index.rs` — both `INSERT INTO pages` sites (~`index.rs:495-520` and ~`index.rs:1683-1700`)
- Test: inline `#[cfg(test)]` in `src/vault/index.rs`

- [ ] **Step 1: Write the failing test**

Add to the test module in `src/vault/index.rs` (use the same page-indexing setup helper the surrounding tests use; the assertion is what matters):

```rust
#[test]
fn index_persists_resolved_kind_and_inferred_flag() {
    let index = VaultIndex::open_in_memory().unwrap();
    // A page in journals/ with no declared type -> inferred JOURNAL.
    index_test_page(&index, "journals/2026-05-31.md", "---\nid: 0190f8a0-0000-7000-8000-000000000001\n---\nbody");
    // A page in notes/ with declared type: quote -> declared QUOTE, project set.
    index_test_page(&index, "notes/q.md", "---\nid: 0190f8a0-0000-7000-8000-000000000002\ntype: quote\nproject: clepsydra\n---\nbody");

    let conn = index.connection();
    let (k1, inf1): (String, i64) = conn
        .query_row("SELECT kind, kind_inferred FROM pages WHERE path = 'journals/2026-05-31.md'", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!(k1, "JOURNAL");
    assert_eq!(inf1, 1);

    let (k2, inf2, proj): (String, i64, Option<String>) = conn
        .query_row("SELECT kind, kind_inferred, project FROM pages WHERE path = 'notes/q.md'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap();
    assert_eq!(k2, "QUOTE");
    assert_eq!(inf2, 0);
    assert_eq!(proj.as_deref(), Some("clepsydra"));
}
```

> `index_test_page` is shorthand for whatever the test module already uses to index a single page from path+content. If no such helper exists, write the page to a temp vault and call the existing single-page index entry point the other tests call.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --lib vault::index::tests::index_persists_resolved_kind_and_inferred_flag`
Expected: FAIL — columns are still the schema defaults (`NOTE`/`1`/`NULL`), not the resolved values.

- [ ] **Step 3: Compute kind/project and bind at the first insert site**

At `index.rs:495`, just after `let journal_date = extract_journal_date(page.vault_path.as_str());`, add:

```rust
let (kind, kind_inferred) =
    crate::vault::kind::resolve(page.vault_path.as_str(), page.meta.kind);
let kind_str = kind.as_str();
let project = page.meta.project.clone();
```

Then change the INSERT (lines ~498-518) to include the three new columns. The statement becomes:

```rust
"INSERT INTO pages (id, path, title, canonical_name, created_at, updated_at, meta_json, content_hash, journal_date, kind, kind_inferred, project)
 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
 ON CONFLICT(id) DO UPDATE SET
   path = excluded.path,
   title = excluded.title,
   canonical_name = excluded.canonical_name,
   created_at = excluded.created_at,
   updated_at = excluded.updated_at,
   meta_json = excluded.meta_json,
   content_hash = excluded.content_hash,
   journal_date = excluded.journal_date,
   kind = excluded.kind,
   kind_inferred = excluded.kind_inferred,
   project = excluded.project"
```

and extend the bound params tuple, after `journal_date,`, with:

```rust
                kind_str,
                kind_inferred as i64,
                project,
```

> Keep the exact `ON CONFLICT` target and the existing `excluded.*` lines as they are in the file; only append the three new assignments and params. Confirm the page value here is named `page` with `page.meta` and `page.vault_path` (it is at this site).

- [ ] **Step 4: Apply the identical change at the second insert site**

Repeat Step 3 at the second `INSERT INTO pages` site (~`index.rs:1683`). The local variable there is `pf` (e.g. `pf.vault_path`); confirm its meta accessor (grep the surrounding lines for `pf.meta` or equivalent) and compute:

```rust
let (kind, kind_inferred) =
    crate::vault::kind::resolve(pf.vault_path.as_str(), pf.meta.kind);
let kind_str = kind.as_str();
let project = pf.meta.project.clone();
```

Apply the same SQL column/param additions as Step 3.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test --lib vault::index::tests::index_persists_resolved_kind_and_inferred_flag`
Expected: PASS.

- [ ] **Step 6: Run the full index + vault suite for regressions**

Run: `cargo test --lib vault`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/vault/index.rs
git commit -m "feat(index): resolve and persist kind/inferred/project per page"
```

---

## Task 5: Expose kind/inferred/project/tags on `PageSummary` and the list query

**Files:**
- Modify: `src/api/pages.rs:29-35` (`PageSummary`), `src/api/pages.rs:163-172` (list query + row mapping)
- Test: `src/api/pages.rs` inline tests, or the existing API test module

- [ ] **Step 1: Write the failing test**

Add to the API test module (mirror how existing list-endpoint tests construct state; assertion is the point):

```rust
#[tokio::test]
async fn list_returns_kind_inferred_project_and_tags() {
    let state = test_state_with_pages(&[
        ("notes/q.md", "---\nid: 0190f8a0-0000-7000-8000-000000000002\ntype: quote\nproject: clepsydra\ntags: [a, b]\n---\nbody"),
    ]).await;

    let resp = list_pages(State(state), Query(PaginationParams::default()))
        .await
        .unwrap();
    let item = &resp.0.items[0];
    assert_eq!(item.kind, "QUOTE");
    assert_eq!(item.inferred, false);
    assert_eq!(item.project.as_deref(), Some("clepsydra"));
    assert_eq!(item.tags, vec!["a".to_string(), "b".to_string()]);
}
```

> `test_state_with_pages` stands for the existing helper that builds an `AppState` over a temp vault with the given pages indexed. Match the real helper name/signature used by neighbouring `list_pages` tests.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --lib api::pages`
Expected: FAIL — `PageSummary` has no `kind`/`inferred`/`project`/`tags`.

- [ ] **Step 3: Extend `PageSummary`**

In `src/api/pages.rs`, change `PageSummary` (line 29) to:

```rust
#[derive(Debug, Serialize, ToSchema)]
pub struct PageSummary {
    pub id: String,
    pub path: String,
    pub title: Option<String>,
    pub canonical_name: String,
    pub kind: String,
    pub inferred: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub tags: Vec<String>,
}
```

- [ ] **Step 4: Extend the list query + row mapping**

In `list_pages` (the `with_index` closure around `index.rs`-backed query at `pages.rs:163`), change the SELECT to read the new columns and aggregate tags. Replace the prepare+map block with:

```rust
let mut stmt = conn.prepare(
    "SELECT p.id, p.path, p.title, p.canonical_name, p.kind, p.kind_inferred, p.project,
            COALESCE((SELECT group_concat(t.tag, '\x1f') FROM tags t WHERE t.page_id = p.id), '')
       FROM pages p
      ORDER BY p.path",
)?;
let pages: Vec<PageSummary> = stmt
    .query_map([], |row| {
        let tags_raw: String = row.get(7)?;
        let tags = if tags_raw.is_empty() {
            Vec::new()
        } else {
            tags_raw.split('\x1f').map(str::to_string).collect()
        };
        Ok(PageSummary {
            id: row.get(0)?,
            path: row.get(1)?,
            title: row.get(2)?,
            canonical_name: row.get(3)?,
            kind: row.get(4)?,
            inferred: row.get::<_, i64>(5)? != 0,
            project: row.get(6)?,
            tags,
        })
    })?
    .collect::<Result<_, _>>()?;
```

> Confirm the `tags` table column names (`page_id`, `tag`) by grepping the schema in `index.rs` (it defines `CREATE TABLE ... tags`); adjust the subquery if they differ. `\x1f` (unit separator) avoids collisions with commas in tag text.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test --lib api::pages`
Expected: the new test passes; existing list tests pass (they now also see the extra fields).

- [ ] **Step 6: Commit**

```bash
git add src/api/pages.rs
git commit -m "feat(api): expose kind/inferred/project/tags on PageSummary"
```

---

## Task 6: Expose kind/inferred/project on `PageDetail`

**Files:**
- Modify: `src/api/pages.rs:46-59` (`PageMetaResponse`) and the detail handler that builds it
- Test: `src/api/pages.rs` inline test

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn detail_returns_kind_and_project() {
    let state = test_state_with_pages(&[
        ("notes/q.md", "---\nid: 0190f8a0-0000-7000-8000-000000000002\ntype: quote\nproject: clepsydra\n---\nbody"),
    ]).await;
    let resp = get_page(State(state), Path("notes/q.md".to_string()))
        .await
        .unwrap();
    assert_eq!(resp.0.meta.kind.as_deref(), Some("QUOTE"));
    assert_eq!(resp.0.meta.inferred, false); // type was declared
    assert_eq!(resp.0.meta.project.as_deref(), Some("clepsydra"));
}
```

> Use the real `get_page` handler name/signature (grep `pages.rs` for the `#[utoipa::path(get, ...)]` page-detail handler).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --lib api::pages::detail_returns_kind_and_project`
Expected: FAIL — `PageMetaResponse` has no `kind`/`project`/`inferred`.

- [ ] **Step 3: Extend `PageMetaResponse`**

Add to `PageMetaResponse` (after `aliases`):

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub inferred: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
```

- [ ] **Step 4: Populate them in the detail handler**

In the handler that builds `PageDetailResponse`/`PageMetaResponse` from a `Page`, compute the resolved kind from the page path + declared kind (reuse `crate::vault::kind::resolve`) and set the fields:

```rust
let (resolved_kind, inferred) =
    crate::vault::kind::resolve(&path_string, page.meta.kind);
// ... when constructing PageMetaResponse:
kind: Some(resolved_kind.as_str().to_string()),
inferred,
project: page.meta.project.clone(),
```

> Use the actual path variable in scope in that handler (grep for where `PageMetaResponse` is constructed).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test --lib api::pages::detail_returns_kind_and_project`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/api/pages.rs
git commit -m "feat(api): expose kind/inferred/project on PageDetail"
```

---

## Task 7: Frontend consumes backend kind

**Files:**
- Modify: `ui/src/api/types.ts` (page summary/detail types — add `kind`, `inferred`, `project`, `tags`)
- Modify: `ui/src/lib/kind.ts` (prefer backend kind; demote path-derivation to fallback)
- Test: `ui/src/lib/kind.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `ui/src/lib/kind.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveKind } from "#/lib/kind";

describe("resolveKind prefers backend kind", () => {
  it("uses an explicit backend kind verbatim, ignoring path", () => {
    expect(resolveKind({ path: "projects/x.md", kind: "QUOTE" })).toBe("QUOTE");
  });
  it("falls back to path inference only when kind is absent", () => {
    expect(resolveKind({ path: "journals/2026-05-31.md", kind: null })).toBe("JOURNAL");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails or passes**

Run: `cd ui && bun run test kind`
Expected: PASS if `resolveKind` already honours `kind` first (it does per `kind.ts:120`). If so, this test documents/locks the contract — keep it. If the imports differ, fix the import path and re-run.

- [ ] **Step 3: Add fields to the API types**

In `ui/src/api/types.ts`, add to the page summary type (and detail meta type) — match the existing type names in that file:

```ts
  kind: string;
  inferred: boolean;
  project?: string | null;
  tags: string[];
```

- [ ] **Step 4: Make GAZETTEER use backend kind**

In `ui/src/components/codex/Gazetteer.tsx`, where rows currently call `resolveKindFromPath(path)`, switch to `resolveKind({ path: row.path, kind: row.kind })` (backend kind wins; path stays as the fallback inside `resolveKind`). Do the same anywhere else `resolveKindFromPath` is called directly on list data (grep `ui/src` for `resolveKindFromPath`).

- [ ] **Step 5: Typecheck + test**

Run: `cd ui && bun run typecheck && bun run test kind`
Expected: typecheck passes; kind tests pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/api/types.ts ui/src/lib/kind.ts ui/src/components/codex/Gazetteer.tsx
git commit -m "feat(ui): consume backend kind/project; path-derivation now fallback"
```

---

## Final verification

- [ ] **Backend:** `cargo test` (full suite) — all pass.
- [ ] **Backend lint:** `cargo clippy --all-targets` — no new warnings.
- [ ] **Frontend:** `cd ui && bun run typecheck && bun run lint && bun run test` — all pass.
- [ ] **Manual smoke:** `cargo run -- serve`, then `GET /api/vault/pages` returns items carrying `kind`, `inferred`, `project`, `tags`; `GET` a single page returns the same on `meta`.

---

## Notes for the executor

- This plan adds **no file moves** — kind/project are merely *recorded and exposed*. Acting on them (projecting folders, reconciling, the assign UI) is Plans 2–4. Resist implementing moves here.
- `kind`/`project` are **derived-only**: never write a separate authoritative store. Frontmatter `type:`/`project:` is the source; the columns are re-derived every index build, exactly like `journal_date`.
- Unknown frontmatter `type:` values (e.g. `type: recipe`) currently deserialize-error on `Kind`. If that proves too strict for hand-edited files, soften `PageMeta`'s deserialize to treat an unknown `type:` as `None` (inferred) rather than failing the whole page parse — but only if a real file triggers it; do not pre-build that.
