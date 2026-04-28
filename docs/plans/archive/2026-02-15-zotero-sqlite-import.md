# Zotero SQLite Import Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Import bibliographic metadata from Zotero's local SQLite database into Clepsydra work pages, with citation key derivation, dedup, and PDF attachment references.

**Architecture:** A new `import_zotero` module opens `zotero.sqlite` read-only, joins the EAV tables to reconstruct items, derives cite_keys (preferring BBT's `Citation Key:` from the extra field), and feeds results through the existing `create_work_internal()` pipeline. A post-creation patch adds Zotero provenance (`import.source`, `import.zotero_key`) and attachment references to frontmatter. All dedup runs through `find_existing_by_zotero_key()` first, then falls back to the existing DOI/ISBN/cite_key checks.

**Tech Stack:** Rust, rusqlite (bundled — no new deps), Axum 0.8, existing `BibImportEntry` + `create_work_internal()` from `src/api/academic.rs`.

---

### Task 1: Zotero config section

**Files:**
- Modify: `src/vault/config.rs` (add `ZoteroSection` to `AcademicSection`)
- Test: `src/vault/config.rs` (inline `#[cfg(test)]` module)

**Context:** `AcademicSection` is at `src/vault/config.rs:81-90`. It currently has `library_folder`, `papers_folder`, `books_folder`, `annotations_folder`. We add an optional `zotero` subsection with a single `database_path` field.

**Step 1: Write the failing test**

Add to the existing `#[cfg(test)] mod tests` block in `src/vault/config.rs`:

```rust
#[test]
fn zotero_config_defaults() {
    let config = VaultConfig::default();
    assert!(config.academic.zotero.database_path.is_none());
}

#[test]
fn zotero_config_from_toml() {
    let tmp = TempDir::new().unwrap();
    let vault_root = tmp.path();
    fs::create_dir_all(vault_root.join(".clepsydra")).unwrap();
    fs::write(
        vault_root.join(".clepsydra/config.toml"),
        r#"
[academic.zotero]
database_path = "/custom/path/zotero.sqlite"
"#,
    )
    .unwrap();

    let config = VaultConfig::load(vault_root).unwrap();
    assert_eq!(
        config.academic.zotero.database_path.as_deref(),
        Some("/custom/path/zotero.sqlite")
    );
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --lib config::tests::zotero_config`
Expected: FAIL — no field `zotero` on `AcademicSection`

**Step 3: Add `ZoteroSection` to config**

In `src/vault/config.rs`, add after the `AcademicSection` impl:

```rust
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ZoteroSection {
    /// Path to zotero.sqlite. If `None`, auto-detect from platform default.
    #[serde(default)]
    pub database_path: Option<String>,
}
```

Add to `AcademicSection`:

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct AcademicSection {
    #[serde(default = "default_library_folder")]
    pub library_folder: String,
    #[serde(default = "default_papers_folder")]
    pub papers_folder: String,
    #[serde(default = "default_books_folder")]
    pub books_folder: String,
    #[serde(default = "default_annotations_folder")]
    pub annotations_folder: String,
    #[serde(default)]
    pub zotero: ZoteroSection,
}
```

Update the `Default` impl for `AcademicSection` to include `zotero: ZoteroSection::default()`.

**Step 4: Run test to verify it passes**

Run: `cargo test --lib config::tests::zotero_config`
Expected: PASS

**Step 5: Run full suite + clippy**

Run: `cargo test && cargo clippy`
Expected: All pass

**Step 6: Commit**

```bash
git add src/vault/config.rs
git commit -m "feat(config): add optional zotero section to academic config"
```

---

### Task 2: Cite key derivation with BBT extra-field priority

**Files:**
- Create: `src/vault/import_zotero.rs`
- Modify: `src/vault/mod.rs` (add `pub mod import_zotero;`)
- Test: `tests/import_test.rs`

**Context:** The existing `generate_cite_key` in `src/vault/import_doi.rs:131-154` is basic — no Unicode normalization, no article-word skipping, no BBT extra-field check. We write an improved version in the new module. The existing function is used by DOI/ISBN importers and stays unchanged.

**Step 1: Write the failing test**

Add to `tests/import_test.rs`:

```rust
use clepsydra::vault::import_zotero::derive_cite_key;

#[test]
fn cite_key_from_bbt_extra_field() {
    let key = derive_cite_key(
        Some("Citation Key: vaswani2017\nsome other stuff"),
        &["Ashish Vaswani".to_string()],
        Some(2017),
        "Attention Is All You Need",
        &std::collections::HashSet::new(),
    );
    assert_eq!(key, "vaswani2017");
}

#[test]
fn cite_key_derived_from_metadata() {
    let key = derive_cite_key(
        None,
        &["Ashish Vaswani".to_string()],
        Some(2017),
        "Attention Is All You Need",
        &std::collections::HashSet::new(),
    );
    assert_eq!(key, "vaswani2017attention");
}

#[test]
fn cite_key_skips_articles() {
    let key = derive_cite_key(
        None,
        &["Hans Muller".to_string()],
        Some(2023),
        "The Grand Unified Theory",
        &std::collections::HashSet::new(),
    );
    assert_eq!(key, "muller2023grand");
}

#[test]
fn cite_key_no_author() {
    let key = derive_cite_key(
        None,
        &[],
        Some(2020),
        "Some Report",
        &std::collections::HashSet::new(),
    );
    assert_eq!(key, "anon2020some");
}

#[test]
fn cite_key_no_year() {
    let key = derive_cite_key(
        None,
        &["Smith".to_string()],
        None,
        "Title",
        &std::collections::HashSet::new(),
    );
    assert_eq!(key, "smithtitle");
}

#[test]
fn cite_key_unicode_normalization() {
    let key = derive_cite_key(
        None,
        &["Hans Müller".to_string()],
        Some(2023),
        "Results",
        &std::collections::HashSet::new(),
    );
    assert_eq!(key, "muller2023results");
}

#[test]
fn cite_key_collision_suffix() {
    let mut existing = std::collections::HashSet::new();
    existing.insert("vaswani2017attention".to_string());

    let key = derive_cite_key(
        None,
        &["Ashish Vaswani".to_string()],
        Some(2017),
        "Attention Is All You Need",
        &existing,
    );
    assert_eq!(key, "vaswani2017attention-b");
}

#[test]
fn cite_key_multiple_collisions() {
    let mut existing = std::collections::HashSet::new();
    existing.insert("vaswani2017attention".to_string());
    existing.insert("vaswani2017attention-b".to_string());

    let key = derive_cite_key(
        None,
        &["Ashish Vaswani".to_string()],
        Some(2017),
        "Attention Is All You Need",
        &existing,
    );
    assert_eq!(key, "vaswani2017attention-c");
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --test import_test cite_key_from_bbt`
Expected: FAIL — module does not exist

**Step 3: Create `src/vault/import_zotero.rs` with derive_cite_key**

```rust
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use regex::Regex;

/// Skip these words when picking the first significant title word.
const SKIP_WORDS: &[&str] = &["a", "an", "the", "on"];

/// Derive a citation key for a Zotero item.
///
/// 1. If `extra_field` contains `Citation Key: <value>` (set by Better BibTeX),
///    use that value directly.
/// 2. Otherwise, derive from `{last_name}{year}{first_significant_title_word}`.
/// 3. If the result collides with `existing_keys`, append `-b`, `-c`, etc.
pub fn derive_cite_key(
    extra_field: Option<&str>,
    authors: &[String],
    year: Option<i32>,
    title: &str,
    existing_keys: &HashSet<String>,
) -> String {
    // 1. Check BBT extra field
    if let Some(extra) = extra_field {
        let re = Regex::new(r"(?m)^Citation Key:\s*(.+)$").unwrap();
        if let Some(caps) = re.captures(extra) {
            let bbt_key = caps[1].trim().to_string();
            if !bbt_key.is_empty() {
                return bbt_key;
            }
        }
    }

    // 2. Derive from metadata
    let author_part = authors
        .first()
        .map(|a| {
            let last = a.split_whitespace().last().unwrap_or("anon");
            strip_diacritics(&last.to_lowercase())
        })
        .unwrap_or_else(|| "anon".to_string());

    let year_part = year.map(|y| y.to_string()).unwrap_or_default();

    let title_part = title
        .split_whitespace()
        .map(|w| w.to_lowercase())
        .map(|w| w.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>())
        .find(|w| !w.is_empty() && !SKIP_WORDS.contains(&w.as_str()))
        .unwrap_or_else(|| "untitled".to_string());

    let base = format!("{author_part}{year_part}{title_part}");

    // 3. Handle collisions
    if !existing_keys.contains(&base) {
        return base;
    }

    for suffix in b'b'..=b'z' {
        let candidate = format!("{base}-{}", suffix as char);
        if !existing_keys.contains(&candidate) {
            return candidate;
        }
    }

    // Extremely unlikely: more than 25 collisions. Fall back to -aa, -ab, etc.
    for first in b'a'..=b'z' {
        for second in b'a'..=b'z' {
            let candidate = format!("{base}-{}{}", first as char, second as char);
            if !existing_keys.contains(&candidate) {
                return candidate;
            }
        }
    }

    // Should never reach here with realistic data
    format!("{base}-overflow")
}

/// Strip Unicode diacritics by NFKD decomposition + removing combining marks.
///
/// "Müller" → "Muller" → (lowercased upstream) "muller"
/// "García" → "Garcia" → "garcia"
fn strip_diacritics(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;

    s.nfkd()
        .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
        .collect()
}
```

**Step 4: Add `pub mod import_zotero;` to `src/vault/mod.rs`**

Insert after `pub mod import_isbn;`:

```rust
pub mod import_zotero;
```

**Step 5: Add `unicode-normalization` crate if not already present**

Check `Cargo.toml` for `unicode-normalization`. If absent:

Run: `cargo add unicode-normalization`

Also check for `regex` — it's likely already a dependency (used by rewriter). If not:

Run: `cargo add regex`

**Step 6: Run test to verify it passes**

Run: `cargo test --test import_test cite_key`
Expected: All 8 cite_key tests PASS

**Step 7: Run full suite + clippy**

Run: `cargo test && cargo clippy`
Expected: All pass

**Step 8: Commit**

```bash
git add src/vault/import_zotero.rs src/vault/mod.rs Cargo.toml Cargo.lock tests/import_test.rs
git commit -m "feat(import): add cite key derivation with BBT extra-field priority"
```

---

### Task 3: Zotero DB discovery and EAV query

**Files:**
- Modify: `src/vault/import_zotero.rs`
- Test: `tests/import_test.rs`

**Context:** We need `detect_zotero_db()`, `open_zotero_db()`, and `query_items()`. Testing against a real Zotero DB isn't practical in CI, so we create a **mock Zotero database** in tests — a temporary SQLite file with the minimal EAV schema and a few rows.

**Step 1: Write the failing test**

Add to `tests/import_test.rs`:

```rust
use clepsydra::vault::import_zotero::{
    open_zotero_db, query_items, detect_zotero_db, ZoteroItem,
};
use rusqlite::Connection;
use tempfile::TempDir;
use std::path::Path;

/// Create a minimal Zotero-schema SQLite DB for testing.
fn create_mock_zotero_db(path: &Path) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        "
        CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
        INSERT INTO itemTypes VALUES (2, 'book');
        INSERT INTO itemTypes VALUES (3, 'bookSection');
        INSERT INTO itemTypes VALUES (4, 'journalArticle');
        INSERT INTO itemTypes VALUES (26, 'conferencePaper');
        INSERT INTO itemTypes VALUES (7, 'thesis');
        INSERT INTO itemTypes VALUES (27, 'report');

        CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
        INSERT INTO fields VALUES (1, 'url');
        INSERT INTO fields VALUES (4, 'volume');
        INSERT INTO fields VALUES (6, 'pages');
        INSERT INTO fields VALUES (12, 'publisher');
        INSERT INTO fields VALUES (14, 'date');
        INSERT INTO fields VALUES (26, 'DOI');
        INSERT INTO fields VALUES (62, 'extra');
        INSERT INTO fields VALUES (110, 'title');
        INSERT INTO fields VALUES (11, 'ISBN');
        INSERT INTO fields VALUES (12, 'publisher');
        INSERT INTO fields VALUES (37, 'publicationTitle');

        CREATE TABLE libraries (libraryID INTEGER PRIMARY KEY, type TEXT);
        INSERT INTO libraries VALUES (1, 'user');

        CREATE TABLE items (
            itemID INTEGER PRIMARY KEY, itemTypeID INT, dateAdded TEXT,
            dateModified TEXT, clientDateModified TEXT, libraryID INT,
            key TEXT, version INT DEFAULT 0, synced INT DEFAULT 0
        );
        CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT, PRIMARY KEY(itemID, fieldID));
        CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT UNIQUE);
        CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY);

        CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INT);
        CREATE TABLE creatorTypes (creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
        INSERT INTO creatorTypes VALUES (1, 'author');
        INSERT INTO creatorTypes VALUES (2, 'editor');
        CREATE TABLE itemCreators (itemID INT, creatorID INT, creatorTypeID INT, orderIndex INT);

        CREATE TABLE tags (tagID INTEGER PRIMARY KEY, name TEXT UNIQUE);
        CREATE TABLE itemTags (itemID INT, tagID INT, type INT);

        CREATE TABLE collections (
            collectionID INTEGER PRIMARY KEY, collectionName TEXT,
            parentCollectionID INT, libraryID INT, key TEXT, version INT DEFAULT 0, synced INT DEFAULT 0,
            clientDateModified TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE collectionItems (collectionID INT, itemID INT, orderIndex INT);

        CREATE TABLE itemAttachments (
            itemID INTEGER PRIMARY KEY, parentItemID INT, linkMode INT,
            contentType TEXT, charsetID INT, path TEXT,
            syncState INT DEFAULT 0, storageModTime INT, storageHash TEXT
        );

        -- Insert a journal article
        INSERT INTO items VALUES (1, 4, '2024-01-01', '2024-06-15', '2024-06-15', 1, 'ABC12345', 1, 0);
        INSERT INTO itemDataValues VALUES (1, 'Attention Is All You Need');
        INSERT INTO itemDataValues VALUES (2, '2017');
        INSERT INTO itemDataValues VALUES (3, '10.48550/arXiv.1706.03762');
        INSERT INTO itemDataValues VALUES (4, 'NeurIPS');
        INSERT INTO itemData VALUES (1, 110, 1);  -- title
        INSERT INTO itemData VALUES (1, 14, 2);   -- date
        INSERT INTO itemData VALUES (1, 26, 3);   -- DOI
        INSERT INTO itemData VALUES (1, 37, 4);   -- publicationTitle (venue)

        INSERT INTO creators VALUES (1, 'Ashish', 'Vaswani', 0);
        INSERT INTO creators VALUES (2, 'Noam', 'Shazeer', 0);
        INSERT INTO itemCreators VALUES (1, 1, 1, 0);  -- author, order 0
        INSERT INTO itemCreators VALUES (1, 2, 1, 1);  -- author, order 1

        INSERT INTO tags VALUES (1, 'machine-learning');
        INSERT INTO tags VALUES (2, 'transformers');
        INSERT INTO itemTags VALUES (1, 1, 0);
        INSERT INTO itemTags VALUES (1, 2, 0);

        -- Insert a book
        INSERT INTO items VALUES (2, 2, '2024-01-01', '2024-03-01', '2024-03-01', 1, 'DEF67890', 1, 0);
        INSERT INTO itemDataValues VALUES (5, 'Pattern Recognition and Machine Learning');
        INSERT INTO itemDataValues VALUES (6, '2006');
        INSERT INTO itemDataValues VALUES (7, '978-0-387-31073-2');
        INSERT INTO itemDataValues VALUES (8, 'Springer');
        INSERT INTO itemData VALUES (2, 110, 5);  -- title
        INSERT INTO itemData VALUES (2, 14, 6);   -- date
        INSERT INTO itemData VALUES (2, 11, 7);   -- ISBN
        INSERT INTO itemData VALUES (2, 12, 8);   -- publisher

        INSERT INTO creators VALUES (3, 'Christopher M.', 'Bishop', 0);
        INSERT INTO itemCreators VALUES (2, 3, 1, 0);

        -- Insert a PDF attachment for item 1
        INSERT INTO items VALUES (100, 4, '2024-01-01', '2024-01-01', '2024-01-01', 1, 'PDFKEY01', 1, 0);
        INSERT INTO itemAttachments VALUES (100, 1, 0, 'application/pdf', NULL, 'storage:attention.pdf', 0, NULL, NULL);

        -- Insert an item with BBT citation key in extra
        INSERT INTO items VALUES (3, 4, '2024-01-01', '2024-07-01', '2024-07-01', 1, 'GHI11111', 1, 0);
        INSERT INTO itemDataValues VALUES (9, 'Some Paper Title');
        INSERT INTO itemDataValues VALUES (10, '2023');
        INSERT INTO itemDataValues VALUES (11, 'Citation Key: custombbt2023\nSome other extra');
        INSERT INTO itemData VALUES (3, 110, 9);  -- title
        INSERT INTO itemData VALUES (3, 14, 10);  -- date
        INSERT INTO itemData VALUES (3, 62, 11);  -- extra

        INSERT INTO creators VALUES (4, 'Jane', 'Doe', 0);
        INSERT INTO itemCreators VALUES (3, 4, 1, 0);

        -- A collection
        INSERT INTO collections VALUES (1, 'ML Papers', NULL, 1, 'COL00001', 1, 0, '2024-01-01');
        INSERT INTO collectionItems VALUES (1, 1, 0);
        INSERT INTO collectionItems VALUES (1, 3, 1);
        "
    ).unwrap();
}

#[test]
fn query_items_returns_all_bibliographic_items() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db(&db_path);

    let conn = open_zotero_db(&db_path).unwrap();
    let items = query_items(&conn, None, None).unwrap();

    assert_eq!(items.len(), 3, "should find 3 items (article, book, article w/ BBT key)");

    // Check article
    let article = items.iter().find(|i| i.zotero_key == "ABC12345").unwrap();
    assert_eq!(article.title, "Attention Is All You Need");
    assert_eq!(article.item_type, "journalArticle");
    assert_eq!(article.doi.as_deref(), Some("10.48550/arXiv.1706.03762"));
    assert_eq!(article.venue.as_deref(), Some("NeurIPS"));
    assert_eq!(article.authors.len(), 2);
    assert_eq!(article.authors[0].last_name, "Vaswani");
    assert_eq!(article.tags, vec!["machine-learning", "transformers"]);
    assert_eq!(article.pdf_attachments.len(), 1);

    // Check book
    let book = items.iter().find(|i| i.zotero_key == "DEF67890").unwrap();
    assert_eq!(book.title, "Pattern Recognition and Machine Learning");
    assert_eq!(book.item_type, "book");
    assert_eq!(book.isbn.as_deref(), Some("978-0-387-31073-2"));
    assert_eq!(book.publisher.as_deref(), Some("Springer"));
}

#[test]
fn query_items_filters_by_collection() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db(&db_path);

    let conn = open_zotero_db(&db_path).unwrap();
    let items = query_items(&conn, Some("ML Papers"), None).unwrap();

    assert_eq!(items.len(), 2, "ML Papers collection has 2 items");
    assert!(items.iter().any(|i| i.zotero_key == "ABC12345"));
    assert!(items.iter().any(|i| i.zotero_key == "GHI11111"));
}

#[test]
fn query_items_filters_by_since() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db(&db_path);

    let conn = open_zotero_db(&db_path).unwrap();
    // Only items modified after 2024-05-01
    let items = query_items(&conn, None, Some("2024-05-01")).unwrap();

    assert_eq!(items.len(), 2, "2 items modified after 2024-05-01");
    assert!(items.iter().all(|i| i.zotero_key != "DEF67890"), "book was modified 2024-03-01, should be excluded");
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --test import_test query_items`
Expected: FAIL — functions don't exist

**Step 3: Implement types and query functions**

Add to `src/vault/import_zotero.rs`:

```rust
use rusqlite::{Connection, OpenFlags, params};

/// Raw query result from Zotero's EAV tables.
#[derive(Debug, Clone)]
pub struct ZoteroItem {
    pub item_id: i64,
    pub zotero_key: String,
    pub item_type: String,
    pub title: String,
    pub date_raw: Option<String>,
    pub doi: Option<String>,
    pub isbn: Option<String>,
    pub url: Option<String>,
    pub venue: Option<String>,
    pub publisher: Option<String>,
    pub extra_field: Option<String>,
    pub authors: Vec<ZoteroAuthor>,
    pub tags: Vec<String>,
    pub pdf_attachments: Vec<ZoteroPdf>,
}

#[derive(Debug, Clone)]
pub struct ZoteroAuthor {
    pub first_name: String,
    pub last_name: String,
    pub field_mode: i32,
}

#[derive(Debug, Clone)]
pub struct ZoteroPdf {
    pub link_mode: i32,
    pub path: Option<String>,
    pub attachment_key: String,
}

/// Auto-detect the default Zotero database path.
pub fn detect_zotero_db() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let path = home.join("Zotero/zotero.sqlite");
    if path.exists() { Some(path) } else { None }
}

/// Open a Zotero SQLite database read-only.
pub fn open_zotero_db(path: &Path) -> Result<Connection, String> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    Connection::open_with_flags(path, flags)
        .map_err(|e| format!("failed to open Zotero database at {}: {e}", path.display()))
}

/// Query bibliographic items from the Zotero database.
///
/// Optionally filter by collection name and/or modification date.
pub fn query_items(
    conn: &Connection,
    collection: Option<&str>,
    since: Option<&str>,
) -> Result<Vec<ZoteroItem>, String> {
    // 1. Core EAV pivot query
    let mut sql = String::from(
        "SELECT
            i.itemID,
            i.key AS zotero_key,
            i.dateModified,
            it.typeName AS item_type,
            MAX(CASE WHEN f.fieldName = 'title' THEN idv.value END) AS title,
            MAX(CASE WHEN f.fieldName = 'date' THEN idv.value END) AS date_raw,
            MAX(CASE WHEN f.fieldName = 'DOI' THEN idv.value END) AS doi,
            MAX(CASE WHEN f.fieldName = 'ISBN' THEN idv.value END) AS isbn,
            MAX(CASE WHEN f.fieldName = 'url' THEN idv.value END) AS url,
            MAX(CASE WHEN f.fieldName = 'publicationTitle' THEN idv.value END) AS venue,
            MAX(CASE WHEN f.fieldName = 'publisher' THEN idv.value END) AS publisher,
            MAX(CASE WHEN f.fieldName = 'extra' THEN idv.value END) AS extra_field
        FROM items i
        JOIN itemTypes it ON it.itemTypeID = i.itemTypeID
        LEFT JOIN itemData id ON id.itemID = i.itemID
        LEFT JOIN itemDataValues idv ON idv.valueID = id.valueID
        LEFT JOIN fields f ON f.fieldID = id.fieldID
        WHERE it.typeName IN ('journalArticle','conferencePaper','book','bookSection','thesis','report','preprint')
        AND i.itemID NOT IN (SELECT itemID FROM deletedItems)"
    );

    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut param_idx = 1u32;

    if let Some(coll) = collection {
        sql.push_str(&format!(
            " AND i.itemID IN (
                SELECT ci.itemID FROM collectionItems ci
                JOIN collections c ON c.collectionID = ci.collectionID
                WHERE c.collectionName = ?{param_idx}
            )"
        ));
        param_values.push(Box::new(coll.to_string()));
        param_idx += 1;
    }

    if let Some(since_ts) = since {
        sql.push_str(&format!(" AND i.dateModified > ?{param_idx}"));
        param_values.push(Box::new(since_ts.to_string()));
        param_idx += 1;
    }

    let _ = param_idx;
    sql.push_str(" GROUP BY i.itemID ORDER BY i.itemID");

    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|b| b.as_ref()).collect();

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<(i64, String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>)> = stmt
        .query_map(param_refs.as_slice(), |row| {
            Ok((
                row.get(0)?, row.get(1)?, row.get(3)?,
                row.get(4)?, row.get(5)?, row.get(6)?,
                row.get(7)?, row.get(8)?, row.get(9)?,
                row.get(10)?, row.get(11)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    // 2. Batch-load creators
    let mut creators_stmt = conn.prepare(
        "SELECT ic.itemID, c.firstName, c.lastName, c.fieldMode
         FROM itemCreators ic
         JOIN creators c ON c.creatorID = ic.creatorID
         JOIN creatorTypes ct ON ct.creatorTypeID = ic.creatorTypeID
         WHERE ct.creatorType = 'author'
         ORDER BY ic.itemID, ic.orderIndex"
    ).map_err(|e| e.to_string())?;
    let all_creators: Vec<(i64, String, String, i32)> = creators_stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    // 3. Batch-load tags
    let mut tags_stmt = conn.prepare(
        "SELECT it.itemID, t.name FROM itemTags it JOIN tags t ON t.tagID = it.tagID ORDER BY it.itemID"
    ).map_err(|e| e.to_string())?;
    let all_tags: Vec<(i64, String)> = tags_stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    // 4. Batch-load PDF attachments
    let mut att_stmt = conn.prepare(
        "SELECT ia.parentItemID, ia.linkMode, ia.path, i.key
         FROM itemAttachments ia
         JOIN items i ON i.itemID = ia.itemID
         WHERE ia.contentType = 'application/pdf' AND ia.parentItemID IS NOT NULL"
    ).map_err(|e| e.to_string())?;
    let all_attachments: Vec<(i64, i32, Option<String>, String)> = att_stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    // 5. Assemble ZoteroItems
    let mut items = Vec::with_capacity(rows.len());
    for (item_id, zotero_key, item_type, title, date_raw, doi, isbn, url, venue, publisher, extra_field) in rows {
        let authors: Vec<ZoteroAuthor> = all_creators.iter()
            .filter(|(id, _, _, _)| *id == item_id)
            .map(|(_, f, l, m)| ZoteroAuthor {
                first_name: f.clone(),
                last_name: l.clone(),
                field_mode: *m,
            })
            .collect();

        let tags: Vec<String> = all_tags.iter()
            .filter(|(id, _)| *id == item_id)
            .map(|(_, name)| name.clone())
            .collect();

        let pdf_attachments: Vec<ZoteroPdf> = all_attachments.iter()
            .filter(|(parent_id, _, _, _)| *parent_id == item_id)
            .map(|(_, lm, p, k)| ZoteroPdf {
                link_mode: *lm,
                path: p.clone(),
                attachment_key: k.clone(),
            })
            .collect();

        items.push(ZoteroItem {
            item_id,
            zotero_key,
            item_type,
            title: title.unwrap_or_default(),
            date_raw,
            doi,
            isbn,
            url,
            venue,
            publisher,
            extra_field,
            authors,
            tags,
            pdf_attachments,
        });
    }

    Ok(items)
}
```

**Step 4: Add `dirs` dependency if not already present**

Check `Cargo.toml` for `dirs`. If absent:

Run: `cargo add dirs`

**Step 5: Run test to verify it passes**

Run: `cargo test --test import_test query_items`
Expected: All 3 tests PASS

**Step 6: Run full suite + clippy**

Run: `cargo test && cargo clippy`
Expected: All pass

**Step 7: Commit**

```bash
git add src/vault/import_zotero.rs Cargo.toml Cargo.lock tests/import_test.rs
git commit -m "feat(import): add Zotero SQLite EAV query with collection/since filtering"
```

---

### Task 4: ZoteroItem → BibImportEntry mapping + attachment resolution

**Files:**
- Modify: `src/vault/import_zotero.rs`
- Test: `tests/import_test.rs`

**Context:** We need `map_to_import_entry()` (type mapping, year extraction, author formatting) and `resolve_attachment_path()` (linkMode dispatch). These reuse `BibImportEntry` from `src/vault/import.rs`.

**Step 1: Write the failing test**

Add to `tests/import_test.rs`:

```rust
use clepsydra::vault::import::BibImportEntry;
use clepsydra::vault::import_zotero::{
    map_to_import_entry, resolve_attachment_path, ZoteroAuthor, ZoteroPdf, ZoteroItem,
};

fn make_article_item() -> ZoteroItem {
    ZoteroItem {
        item_id: 1,
        zotero_key: "ABC12345".to_string(),
        item_type: "journalArticle".to_string(),
        title: "Attention Is All You Need".to_string(),
        date_raw: Some("2017".to_string()),
        doi: Some("10.48550/arXiv.1706.03762".to_string()),
        isbn: None,
        url: None,
        venue: Some("NeurIPS".to_string()),
        publisher: None,
        extra_field: Some("arXiv: 1706.03762".to_string()),
        authors: vec![
            ZoteroAuthor { first_name: "Ashish".to_string(), last_name: "Vaswani".to_string(), field_mode: 0 },
            ZoteroAuthor { first_name: "Noam".to_string(), last_name: "Shazeer".to_string(), field_mode: 0 },
        ],
        tags: vec!["ml".to_string()],
        pdf_attachments: vec![],
    }
}

#[test]
fn map_journal_article_to_import_entry() {
    let item = make_article_item();
    let entry = map_to_import_entry(&item);
    assert_eq!(entry.title, "Attention Is All You Need");
    assert!(matches!(entry.work_type, clepsydra::vault::academic::WorkType::Paper));
    assert_eq!(entry.authors, vec!["Ashish Vaswani", "Noam Shazeer"]);
    assert_eq!(entry.year, Some(2017));
    assert_eq!(entry.doi.as_deref(), Some("10.48550/arXiv.1706.03762"));
    assert_eq!(entry.venue.as_deref(), Some("NeurIPS"));
    assert_eq!(entry.arxiv.as_deref(), Some("1706.03762"));
}

#[test]
fn map_institutional_author() {
    let item = ZoteroItem {
        item_id: 2,
        zotero_key: "X".to_string(),
        item_type: "report".to_string(),
        title: "Report".to_string(),
        date_raw: None,
        doi: None, isbn: None, url: None, venue: None, publisher: None,
        extra_field: None,
        authors: vec![
            ZoteroAuthor { first_name: String::new(), last_name: "World Health Organization".to_string(), field_mode: 1 },
        ],
        tags: vec![],
        pdf_attachments: vec![],
    };
    let entry = map_to_import_entry(&item);
    assert_eq!(entry.authors, vec!["World Health Organization"]);
}

#[test]
fn map_year_extraction_from_full_date() {
    let mut item = make_article_item();
    item.date_raw = Some("June 12, 2017".to_string());
    let entry = map_to_import_entry(&item);
    assert_eq!(entry.year, Some(2017));
}

#[test]
fn resolve_imported_file_attachment() {
    let pdf = ZoteroPdf {
        link_mode: 0,
        path: Some("storage:attention.pdf".to_string()),
        attachment_key: "PDFKEY01".to_string(),
    };
    let zotero_data_dir = Path::new("/Users/kit/Zotero");
    let result = resolve_attachment_path(zotero_data_dir, &pdf);
    assert_eq!(result, Some("/Users/kit/Zotero/storage/PDFKEY01/attention.pdf".to_string()));
}

#[test]
fn resolve_linked_file_attachment() {
    let pdf = ZoteroPdf {
        link_mode: 2,
        path: Some("/absolute/path/to/paper.pdf".to_string()),
        attachment_key: "X".to_string(),
    };
    let result = resolve_attachment_path(Path::new("/unused"), &pdf);
    assert_eq!(result, Some("/absolute/path/to/paper.pdf".to_string()));
}

#[test]
fn resolve_url_attachment() {
    let pdf = ZoteroPdf {
        link_mode: 1,
        path: Some("https://arxiv.org/pdf/1706.03762.pdf".to_string()),
        attachment_key: "X".to_string(),
    };
    let result = resolve_attachment_path(Path::new("/unused"), &pdf);
    // URL attachments return the URL as-is
    assert_eq!(result, Some("https://arxiv.org/pdf/1706.03762.pdf".to_string()));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --test import_test map_journal`
Expected: FAIL — functions not found

**Step 3: Implement mapping and attachment resolution**

Add to `src/vault/import_zotero.rs`:

```rust
use crate::vault::academic::WorkType;
use crate::vault::import::BibImportEntry;

/// Extract a 4-digit year from Zotero's free-text date field.
fn extract_year(date_raw: Option<&str>) -> Option<i32> {
    let re = Regex::new(r"\b(\d{4})\b").unwrap();
    date_raw
        .and_then(|s| re.captures(s))
        .and_then(|caps| caps[1].parse::<i32>().ok())
        .filter(|y| *y > 1000 && *y < 3000)
}

/// Extract arXiv ID from Zotero's `extra` field.
/// Looks for patterns like "arXiv: 1706.03762" or "arXiv:1706.03762".
fn extract_arxiv(extra: Option<&str>) -> Option<String> {
    let re = Regex::new(r"(?im)^arXiv:\s*(.+)$").unwrap();
    extra
        .and_then(|s| re.captures(s))
        .map(|caps| caps[1].trim().to_string())
}

/// Map a Zotero item type name to a Clepsydra WorkType.
fn map_item_type(type_name: &str) -> WorkType {
    match type_name {
        "journalArticle" | "conferencePaper" | "preprint" => WorkType::Paper,
        "book" | "bookSection" => WorkType::Book,
        "thesis" => WorkType::Thesis,
        "report" => WorkType::Report,
        _ => WorkType::Other,
    }
}

/// Format a ZoteroAuthor into a display string.
fn format_author(author: &ZoteroAuthor) -> String {
    if author.field_mode == 1 || author.first_name.is_empty() {
        // Single-field / institutional author
        author.last_name.clone()
    } else {
        format!("{} {}", author.first_name, author.last_name)
    }
}

/// Convert a ZoteroItem into a BibImportEntry for the existing import pipeline.
///
/// Does NOT set cite_key — that's handled separately by derive_cite_key().
pub fn map_to_import_entry(item: &ZoteroItem) -> BibImportEntry {
    BibImportEntry {
        cite_key: String::new(), // set by caller via derive_cite_key()
        title: item.title.clone(),
        work_type: map_item_type(&item.item_type),
        authors: item.authors.iter().map(format_author).collect(),
        year: extract_year(item.date_raw.as_deref()),
        venue: item.venue.clone(),
        publisher: item.publisher.clone(),
        doi: item.doi.clone(),
        isbn: item.isbn.clone(),
        arxiv: extract_arxiv(item.extra_field.as_deref()),
        url: item.url.clone(),
    }
}

/// Resolve a Zotero PDF attachment to a filesystem path or URL.
///
/// - `linkMode 0` (imported file): `storage:<filename>` → `<data_dir>/storage/<key>/<filename>`
/// - `linkMode 1` (imported URL): return URL as-is
/// - `linkMode 2` (linked file): return absolute path as-is
/// - `linkMode 3` (linked URL): return URL as-is
pub fn resolve_attachment_path(zotero_data_dir: &Path, pdf: &ZoteroPdf) -> Option<String> {
    match pdf.link_mode {
        0 => {
            // Imported file: path is "storage:<filename>"
            let filename = pdf.path.as_deref()?.strip_prefix("storage:")?;
            let resolved = zotero_data_dir
                .join("storage")
                .join(&pdf.attachment_key)
                .join(filename);
            Some(resolved.to_string_lossy().to_string())
        }
        1 | 3 => {
            // URL attachment: path is the URL
            pdf.path.clone()
        }
        2 => {
            // Linked file: path is absolute
            pdf.path.clone()
        }
        _ => None,
    }
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test --test import_test map_ && cargo test --test import_test resolve_`
Expected: All 6 tests PASS

**Step 5: Run full suite + clippy**

Run: `cargo test && cargo clippy`
Expected: All pass

**Step 6: Commit**

```bash
git add src/vault/import_zotero.rs tests/import_test.rs
git commit -m "feat(import): add Zotero item mapping and attachment path resolution"
```

---

### Task 5: Zotero dedup by zotero_key

**Files:**
- Modify: `src/vault/import_zotero.rs`
- Test: `tests/import_test.rs`

**Context:** We need `find_existing_by_zotero_key()` that queries the vault index for pages with `import.zotero_key` matching a given key. This is the first dedup check, before DOI/ISBN/cite_key.

**Step 1: Write the failing test**

Add to `tests/import_test.rs`:

```rust
use clepsydra::vault::import_zotero::find_existing_by_zotero_key;

#[test]
fn find_existing_by_zotero_key_returns_path() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    fs::create_dir_all(root.join("library/papers")).unwrap();

    let content = "\
---
id: 00000000-0000-0000-0000-000000000600
kind: work
work_type: paper
title: Previously Imported
cite_key: prev2024
tags: []
import:
  source: zotero
  zotero_key: ABC12345
  imported_at: 2024-01-01T00:00:00Z
---
Content.
";
    fs::write(root.join("library/papers/previously-imported.md"), content).unwrap();

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    let found = find_existing_by_zotero_key(index.connection(), "ABC12345");
    assert_eq!(found, Some("library/papers/previously-imported.md".to_string()));

    let not_found = find_existing_by_zotero_key(index.connection(), "UNKNOWN");
    assert!(not_found.is_none());
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --test import_test find_existing_by_zotero`
Expected: FAIL — function not found

**Step 3: Implement**

Add to `src/vault/import_zotero.rs`:

```rust
/// Check if a work was previously imported from Zotero by its item key.
/// Returns Some(vault_path) if found, None otherwise.
pub fn find_existing_by_zotero_key(conn: &rusqlite::Connection, zotero_key: &str) -> Option<String> {
    conn.query_row(
        "SELECT path FROM pages WHERE json_extract(meta_json, '$.import.source') = 'zotero' AND json_extract(meta_json, '$.import.zotero_key') = ?1",
        params![zotero_key],
        |row| row.get(0),
    )
    .ok()
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test --test import_test find_existing_by_zotero`
Expected: PASS

**Step 5: Run full suite + clippy**

Run: `cargo test && cargo clippy`
Expected: All pass

**Step 6: Commit**

```bash
git add src/vault/import_zotero.rs tests/import_test.rs
git commit -m "feat(import): add zotero_key dedup lookup for idempotent re-import"
```

---

### Task 6: Import orchestrator + API endpoint

**Files:**
- Modify: `src/vault/import_zotero.rs` (add `import_zotero()` orchestrator)
- Modify: `src/api/academic.rs` (add handler + route)
- Test: `tests/api_test.rs`

**Context:** This is the final wiring task. The `import_zotero` handler in `src/api/academic.rs` accepts the request, calls into the orchestrator in `import_zotero.rs`, which opens the Zotero DB, queries items, dedup-checks each, creates works via `create_work_internal()`, then patches provenance and attachments into the frontmatter. The route is added to the academic router at `/import/zotero`.

**Step 1: Write the failing test**

Add to `tests/api_test.rs`:

```rust
#[tokio::test]
async fn import_zotero_creates_works() {
    let (server, tmp) = setup_server();

    // Create a mock Zotero DB in the temp dir
    let zotero_dir = tmp.path().join("zotero");
    fs::create_dir_all(&zotero_dir).unwrap();
    let db_path = zotero_dir.join("zotero.sqlite");
    create_mock_zotero_db_for_api(&db_path);

    let res = server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": db_path.to_str().unwrap(),
            "dry_run": false
        }))
        .await;

    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let results = body["results"].as_array().unwrap();
    assert!(results.len() >= 2, "should import at least 2 items");

    let created: Vec<_> = results.iter().filter(|r| r["status"] == "created").collect();
    assert!(created.len() >= 2);

    // Verify a created work exists
    let first_path = created[0]["page_path"].as_str().unwrap();
    let res = server.get(&format!("/api/vault/pages/{first_path}")).await;
    res.assert_status_ok();
    let page: serde_json::Value = res.json();

    // Verify provenance in frontmatter
    let meta = &page["meta"];
    assert_eq!(meta["import"]["source"], "zotero");
    assert!(meta["import"]["zotero_key"].as_str().is_some());
}

#[tokio::test]
async fn import_zotero_dry_run() {
    let (server, tmp) = setup_server();

    let zotero_dir = tmp.path().join("zotero");
    fs::create_dir_all(&zotero_dir).unwrap();
    let db_path = zotero_dir.join("zotero.sqlite");
    create_mock_zotero_db_for_api(&db_path);

    let res = server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": db_path.to_str().unwrap(),
            "dry_run": true
        }))
        .await;

    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let results = body["results"].as_array().unwrap();
    assert!(results.iter().all(|r| r["status"] == "would_create" || r["status"] == "would_skip"));

    // Verify no works were actually created
    let list_res = server.get("/api/vault/academic/works").await;
    list_res.assert_status_ok();
    let list: serde_json::Value = list_res.json();
    assert_eq!(list["items"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn import_zotero_is_idempotent() {
    let (server, tmp) = setup_server();

    let zotero_dir = tmp.path().join("zotero");
    fs::create_dir_all(&zotero_dir).unwrap();
    let db_path = zotero_dir.join("zotero.sqlite");
    create_mock_zotero_db_for_api(&db_path);

    // First import
    let res = server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": db_path.to_str().unwrap(),
        }))
        .await;
    res.assert_status_ok();
    let body1: serde_json::Value = res.json();
    let created1: Vec<_> = body1["results"].as_array().unwrap()
        .iter().filter(|r| r["status"] == "created").collect();

    // Second import — should skip everything
    let res = server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": db_path.to_str().unwrap(),
        }))
        .await;
    res.assert_status_ok();
    let body2: serde_json::Value = res.json();
    let created2: Vec<_> = body2["results"].as_array().unwrap()
        .iter().filter(|r| r["status"] == "created").collect();
    let skipped2: Vec<_> = body2["results"].as_array().unwrap()
        .iter().filter(|r| r["status"] == "skipped").collect();

    assert_eq!(created2.len(), 0, "second import should create nothing");
    assert_eq!(skipped2.len(), created1.len(), "second import should skip all previously created");
}

/// Minimal mock Zotero DB used by API tests.
/// Same schema as the unit test version but accessible from api_test.rs.
fn create_mock_zotero_db_for_api(path: &std::path::Path) {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(
        "
        CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
        INSERT INTO itemTypes VALUES (4, 'journalArticle');
        INSERT INTO itemTypes VALUES (2, 'book');

        CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
        INSERT INTO fields VALUES (110, 'title');
        INSERT INTO fields VALUES (14, 'date');
        INSERT INTO fields VALUES (26, 'DOI');
        INSERT INTO fields VALUES (11, 'ISBN');
        INSERT INTO fields VALUES (37, 'publicationTitle');
        INSERT INTO fields VALUES (12, 'publisher');
        INSERT INTO fields VALUES (62, 'extra');
        INSERT INTO fields VALUES (1, 'url');

        CREATE TABLE libraries (libraryID INTEGER PRIMARY KEY, type TEXT);
        INSERT INTO libraries VALUES (1, 'user');

        CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INT, dateAdded TEXT, dateModified TEXT, clientDateModified TEXT, libraryID INT, key TEXT, version INT DEFAULT 0, synced INT DEFAULT 0);
        CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT, PRIMARY KEY(itemID, fieldID));
        CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT UNIQUE);
        CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY);
        CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INT);
        CREATE TABLE creatorTypes (creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
        INSERT INTO creatorTypes VALUES (1, 'author');
        CREATE TABLE itemCreators (itemID INT, creatorID INT, creatorTypeID INT, orderIndex INT);
        CREATE TABLE tags (tagID INTEGER PRIMARY KEY, name TEXT UNIQUE);
        CREATE TABLE itemTags (itemID INT, tagID INT, type INT);
        CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT, parentCollectionID INT, libraryID INT, key TEXT, version INT DEFAULT 0, synced INT DEFAULT 0, clientDateModified TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE collectionItems (collectionID INT, itemID INT, orderIndex INT);
        CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INT, linkMode INT, contentType TEXT, charsetID INT, path TEXT, syncState INT DEFAULT 0, storageModTime INT, storageHash TEXT);

        -- Article
        INSERT INTO items VALUES (1, 4, '2024-01-01', '2024-06-15', '2024-06-15', 1, 'APITEST1', 1, 0);
        INSERT INTO itemDataValues VALUES (1, 'Test Article');
        INSERT INTO itemDataValues VALUES (2, '2024');
        INSERT INTO itemDataValues VALUES (3, '10.1234/test');
        INSERT INTO itemData VALUES (1, 110, 1);
        INSERT INTO itemData VALUES (1, 14, 2);
        INSERT INTO itemData VALUES (1, 26, 3);
        INSERT INTO creators VALUES (1, 'Jane', 'Smith', 0);
        INSERT INTO itemCreators VALUES (1, 1, 1, 0);

        -- Book
        INSERT INTO items VALUES (2, 2, '2024-01-01', '2024-03-01', '2024-03-01', 1, 'APITEST2', 1, 0);
        INSERT INTO itemDataValues VALUES (4, 'Test Book');
        INSERT INTO itemDataValues VALUES (5, '2020');
        INSERT INTO itemDataValues VALUES (6, '978-0-123-45678-9');
        INSERT INTO itemDataValues VALUES (7, 'Test Publisher');
        INSERT INTO itemData VALUES (2, 110, 4);
        INSERT INTO itemData VALUES (2, 14, 5);
        INSERT INTO itemData VALUES (2, 11, 6);
        INSERT INTO itemData VALUES (2, 12, 7);
        INSERT INTO creators VALUES (2, 'Bob', 'Jones', 0);
        INSERT INTO itemCreators VALUES (2, 2, 1, 0);
        "
    ).unwrap();
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --test api_test import_zotero`
Expected: FAIL — 404 / no route

**Step 3: Add orchestrator to `src/vault/import_zotero.rs`**

```rust
use std::collections::HashMap;

use chrono::Utc;

use crate::api::AppState;
use crate::api::academic::{ImportResponse, ImportResult, create_work_internal};
use crate::vault::academic::{ExternalIds, WorkUrls};
use crate::vault::import::find_existing_work;
use crate::vault::page::{Page, write_page_content};

/// Request body for Zotero import.
#[derive(Debug, serde::Deserialize)]
pub struct ImportZoteroRequest {
    pub database_path: Option<String>,
    pub collection: Option<String>,
    pub since: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
}

/// Run the full Zotero import pipeline.
pub fn import_zotero(state: &AppState, req: &ImportZoteroRequest) -> Result<ImportResponse, String> {
    // 1. Resolve DB path
    let db_path = match &req.database_path {
        Some(p) => {
            let expanded = if p.starts_with("~/") {
                dirs::home_dir()
                    .unwrap_or_default()
                    .join(&p[2..])
            } else {
                PathBuf::from(p)
            };
            if !expanded.exists() {
                return Err(format!("Zotero database not found: {}", expanded.display()));
            }
            expanded
        }
        None => {
            let configured = &state.vault.config().academic.zotero.database_path;
            match configured {
                Some(p) => {
                    let expanded = if p.starts_with("~/") {
                        dirs::home_dir().unwrap_or_default().join(&p[2..])
                    } else {
                        PathBuf::from(p)
                    };
                    if !expanded.exists() {
                        return Err(format!("configured Zotero database not found: {}", expanded.display()));
                    }
                    expanded
                }
                None => detect_zotero_db()
                    .ok_or_else(|| "Zotero database not found at default location (~/Zotero/zotero.sqlite). Provide database_path or configure academic.zotero.database_path.".to_string())?,
            }
        }
    };

    let zotero_data_dir = db_path.parent().unwrap_or(Path::new("/"));

    // 2. Open Zotero DB and query items
    let conn = open_zotero_db(&db_path)?;
    let items = query_items(&conn, req.collection.as_deref(), req.since.as_deref())?;

    // 3. Build set of existing cite_keys for collision detection
    let mut used_cite_keys: HashSet<String> = {
        let index = state.index.lock();
        let mut stmt = index.connection()
            .prepare("SELECT canonical_name FROM canonical_names WHERE source = 'cite_key'")
            .map_err(|e| e.to_string())?;
        stmt.query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect()
    };

    // 4. Process each item
    let mut results = Vec::with_capacity(items.len());

    for item in &items {
        // 4a. Check dedup by zotero_key
        let existing_path = {
            let index = state.index.lock();
            find_existing_by_zotero_key(index.connection(), &item.zotero_key)
        };

        if let Some(path) = existing_path {
            results.push(ImportResult {
                cite_key: String::new(),
                status: if req.dry_run { "would_skip".to_string() } else { "skipped".to_string() },
                page_path: Some(path),
                error: None,
            });
            continue;
        }

        // 4b. Map to BibImportEntry
        let mut entry = map_to_import_entry(item);

        // 4c. Derive cite_key
        let author_strings: Vec<String> = item.authors.iter().map(format_author).collect();
        entry.cite_key = derive_cite_key(
            item.extra_field.as_deref(),
            &author_strings,
            entry.year,
            &entry.title,
            &used_cite_keys,
        );
        used_cite_keys.insert(entry.cite_key.clone());

        // 4d. Check dedup by DOI/ISBN/cite_key
        let existing_path = {
            let index = state.index.lock();
            find_existing_work(
                index.connection(),
                entry.doi.as_deref(),
                entry.isbn.as_deref(),
                Some(&entry.cite_key),
            )
        };

        if let Some(path) = existing_path {
            results.push(ImportResult {
                cite_key: entry.cite_key.clone(),
                status: if req.dry_run { "would_skip".to_string() } else { "skipped".to_string() },
                page_path: Some(path),
                error: None,
            });
            continue;
        }

        // 4e. Dry run: record without creating
        if req.dry_run {
            results.push(ImportResult {
                cite_key: entry.cite_key.clone(),
                status: "would_create".to_string(),
                page_path: None,
                error: None,
            });
            continue;
        }

        // 4f. Create work via shared pipeline
        match create_work_internal(
            state,
            entry.title.clone(),
            entry.work_type.clone(),
            entry.authors.clone(),
            entry.year,
            entry.venue.clone(),
            entry.publisher.clone(),
            None, // status
            None, // rating
            Some(ExternalIds {
                doi: entry.doi.clone(),
                isbn: entry.isbn.clone(),
                arxiv: entry.arxiv.clone(),
            }),
            entry.url.as_ref().map(|u| WorkUrls {
                landing: Some(u.clone()),
                pdf: None,
            }),
            Some(entry.cite_key.clone()),
            item.tags.clone(),
            vec![], // aliases
            None,   // body
        ) {
            Ok(detail) => {
                // 4g. Patch provenance + attachments into frontmatter
                if let Err(e) = patch_provenance_and_attachments(
                    state,
                    &detail.path,
                    &item.zotero_key,
                    item.item_id,
                    zotero_data_dir,
                    &item.pdf_attachments,
                ) {
                    // Log but don't fail — the work was created successfully
                    eprintln!("warning: failed to patch provenance for {}: {e}", detail.path);
                }

                results.push(ImportResult {
                    cite_key: entry.cite_key.clone(),
                    status: "created".to_string(),
                    page_path: Some(detail.path),
                    error: None,
                });
            }
            Err(e) => {
                results.push(ImportResult {
                    cite_key: entry.cite_key.clone(),
                    status: "error".to_string(),
                    page_path: None,
                    error: Some(e.error),
                });
            }
        }
    }

    Ok(ImportResponse { results })
}

/// Patch Zotero provenance and attachment references into an already-created work page.
fn patch_provenance_and_attachments(
    state: &AppState,
    vault_path_str: &str,
    zotero_key: &str,
    zotero_item_id: i64,
    zotero_data_dir: &Path,
    attachments: &[ZoteroPdf],
) -> Result<(), String> {
    let vault_path = crate::vault::path::VaultPath::new(vault_path_str)
        .map_err(|e| format!("invalid path: {e}"))?;
    let abs_path = state.vault.resolve(&vault_path);

    let page = Page::from_file(&abs_path, vault_path.clone())
        .map_err(|e| format!("failed to read page: {e}"))?;

    let mut meta = page.meta;

    // Add import provenance
    let import_map = serde_yaml::Mapping::from_iter([
        (serde_yaml::Value::String("source".into()), serde_yaml::Value::String("zotero".into())),
        (serde_yaml::Value::String("zotero_key".into()), serde_yaml::Value::String(zotero_key.into())),
        (serde_yaml::Value::String("zotero_item_id".into()), serde_yaml::Value::Number(serde_yaml::Number::from(zotero_item_id))),
        (serde_yaml::Value::String("imported_at".into()), serde_yaml::Value::String(Utc::now().to_rfc3339())),
    ]);
    meta.extra.insert("import".to_string(), serde_yaml::Value::Mapping(import_map));

    // Resolve and add attachment references
    let mut assets: Vec<String> = meta.extra
        .get("assets")
        .and_then(|v| serde_yaml::from_value::<Vec<String>>(v.clone()).ok())
        .unwrap_or_default();
    let mut pdf_url: Option<String> = None;

    for att in attachments {
        if let Some(resolved) = resolve_attachment_path(zotero_data_dir, att) {
            match att.link_mode {
                0 | 2 => assets.push(resolved),
                1 | 3 => { pdf_url = Some(resolved); }
                _ => {}
            }
        }
    }

    if !assets.is_empty() {
        meta.extra.insert("assets".to_string(), serde_yaml::to_value(&assets).unwrap());
    }
    if let Some(url) = pdf_url {
        if let Some(urls_val) = meta.extra.get_mut("urls") {
            if let serde_yaml::Value::Mapping(ref mut m) = urls_val {
                m.insert(
                    serde_yaml::Value::String("pdf".into()),
                    serde_yaml::Value::String(url),
                );
            }
        } else {
            let mut urls_map = serde_yaml::Mapping::new();
            urls_map.insert(
                serde_yaml::Value::String("pdf".into()),
                serde_yaml::Value::String(url),
            );
            meta.extra.insert("urls".to_string(), serde_yaml::Value::Mapping(urls_map));
        }
    }

    // Write back
    let content = write_page_content(&meta, &page.body);
    std::fs::write(&abs_path, &content).map_err(|e| format!("failed to write: {e}"))?;

    // Re-index
    let mut index = state.index.lock();
    index.index_page(&state.vault, &vault_path).map_err(|e| e.to_string())?;

    Ok(())
}
```

**Step 4: Add handler and route to `src/api/academic.rs`**

Add the handler:

```rust
#[utoipa::path(
    post,
    path = "/academic/import/zotero",
    context_path = "/api/vault",
    tag = "Academic",
    request_body = crate::vault::import_zotero::ImportZoteroRequest,
    responses(
        (status = 200, description = "Zotero import results", body = ImportResponse),
        (status = 400, description = "Invalid request", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn import_zotero_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<crate::vault::import_zotero::ImportZoteroRequest>,
) -> Result<Json<ImportResponse>, ApiError> {
    let response = crate::vault::import_zotero::import_zotero(&state, &req)
        .map_err(|e| ApiError::bad_request(e))?;
    Ok(Json(response))
}
```

Add route to `router()`:

```rust
.route("/import/zotero", post(import_zotero_handler))
```

Add `utoipa::ToSchema` derive to `ImportZoteroRequest` in `import_zotero.rs`.

**Step 5: Run test to verify it passes**

Run: `cargo test --test api_test import_zotero`
Expected: All 3 tests PASS

**Step 6: Run full suite + clippy**

Run: `cargo test && cargo clippy`
Expected: All pass

**Step 7: Commit**

```bash
git add src/vault/import_zotero.rs src/api/academic.rs tests/api_test.rs
git commit -m "feat(api): add POST /academic/import/zotero endpoint with full pipeline"
```

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | Zotero config section | `config.rs` |
| 2 | Cite key derivation with BBT priority | `import_zotero.rs`, `import_test.rs` |
| 3 | Zotero DB discovery + EAV query | `import_zotero.rs`, `import_test.rs` |
| 4 | ZoteroItem → BibImportEntry mapping + attachments | `import_zotero.rs`, `import_test.rs` |
| 5 | Zotero-key dedup lookup | `import_zotero.rs`, `import_test.rs` |
| 6 | Import orchestrator + API endpoint + integration tests | `import_zotero.rs`, `academic.rs`, `api_test.rs` |

Dependencies: 1 is independent. 2→3→4→5→6 are sequential (each builds on the prior). Task 6 integrates everything.

**Out of scope (deferred):** Collection listing endpoint, nested collection traversal, BBT JSON-RPC alternative adapter, continuous sync, bidirectional updates.
