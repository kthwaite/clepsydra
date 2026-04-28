# Academic Importers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add BibTeX batch import and single DOI/ISBN lookup endpoints that create work pages with deduplication.

**Architecture:** A new `src/vault/import.rs` module handles BibTeX parsing (via the `biblatex` crate) and external API calls (Crossref for DOI, Open Library for ISBN) using `reqwest`. Each importer converts external data into `CreateWorkRequest`-equivalent structures and delegates page creation to shared logic extracted from `api/academic.rs`. Deduplication checks DOI → ISBN → cite_key against existing works before creating.

**Tech Stack:** `biblatex` (BibTeX parsing, by Typst team), `reqwest` (HTTP client for DOI/ISBN APIs), existing `serde_json` for API response parsing.

---

## Task 1: Add `biblatex` and `reqwest` dependencies

**Files:**
- Modify: `Cargo.toml`

**Step 1: Add dependencies to Cargo.toml**

Add under `[dependencies]`:
```toml
biblatex = "0.11"
reqwest = { version = "0.12", features = ["json"] }
```

Note: `reqwest` needs `json` feature for `.json()` deserialization. Tokio is already enabled with `full`.

**Step 2: Verify build**

Run: `cargo check`
Expected: Compiles with no errors.

**Step 3: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "chore: add biblatex and reqwest dependencies for importers"
```

---

## Task 2: Extract shared work-creation logic from `api/academic.rs`

The `create_work` handler in `api/academic.rs` does validation, slug generation, file writing, and indexing. Import endpoints need the same logic. Extract the core into a reusable function.

**Files:**
- Modify: `src/api/academic.rs`

**Step 1: Write a test for the extracted function**

Add to `tests/api_test.rs`:

```rust
#[tokio::test]
async fn import_creates_work_via_shared_logic() {
    // Setup vault + index (same as existing create_work_page test)
    // Call the new internal create function directly via the API:
    // POST /academic/works with same payload
    // Verify the response is 201 CREATED
    // This test already exists — we just need to confirm the refactor doesn't break it.
}
```

Actually, the existing `create_work_page` test already covers this. The refactor is internal — we validate by running the full test suite.

**Step 2: Extract `create_work_internal` function**

In `src/api/academic.rs`, extract the body of `create_work` (steps 1-9) into:

```rust
/// Internal work creation logic shared by the create_work endpoint and importers.
/// Returns (vault_path, page_meta, page_body) on success.
pub(crate) fn create_work_internal(
    state: &AppState,
    title: String,
    work_type: WorkType,
    authors: Vec<String>,
    year: Option<i32>,
    venue: Option<String>,
    publisher: Option<String>,
    status: Option<ReadingStatus>,
    rating: Option<u8>,
    external_ids: Option<ExternalIds>,
    urls: Option<WorkUrls>,
    cite_key: Option<String>,
    tags: Vec<String>,
    aliases: Vec<String>,
    body: Option<String>,
) -> Result<WorkDetail, ApiError> {
```

This performs: rating validation, cite_key uniqueness check, folder selection, slug generation, path construction, PageMeta building, file write, index + resolve, sync notification, WorkDetail construction.

The existing `create_work` handler becomes a thin wrapper that deserializes `CreateWorkRequest` and calls `create_work_internal`.

**Step 3: Run tests to verify refactor**

Run: `cargo test`
Expected: All 162+ tests pass unchanged.

**Step 4: Commit**

```bash
git add src/api/academic.rs
git commit -m "refactor(api): extract create_work_internal for reuse by importers"
```

---

## Task 3: BibTeX parsing module (`vault/import.rs`)

Pure parsing logic — converts a BibTeX string into a vec of normalized work descriptors. No API state, no file I/O.

**Files:**
- Create: `src/vault/import.rs`
- Modify: `src/vault/mod.rs` (add `pub mod import;`)
- Create test in: `tests/import_test.rs`

**Step 1: Write the failing tests**

Create `tests/import_test.rs`:

```rust
use clepsydra::vault::import::{BibImportEntry, parse_bibtex};

#[test]
fn parse_single_article() {
    let bib = r#"
@article{vaswani2017attention,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam},
  journal = {NeurIPS},
  year = {2017},
  doi = {10.48550/arXiv.1706.03762}
}
"#;
    let entries = parse_bibtex(bib).unwrap();
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    assert_eq!(e.cite_key, "vaswani2017attention");
    assert_eq!(e.title, "Attention Is All You Need");
    assert_eq!(e.authors, vec!["Ashish Vaswani", "Noam Shazeer"]);
    assert_eq!(e.year, Some(2017));
    assert_eq!(e.venue, Some("NeurIPS".to_string()));
    assert_eq!(e.doi, Some("10.48550/arXiv.1706.03762".to_string()));
    assert!(matches!(e.work_type, clepsydra::vault::academic::WorkType::Paper));
}

#[test]
fn parse_book_entry() {
    let bib = r#"
@book{bishop2006pattern,
  title = {Pattern Recognition and Machine Learning},
  author = {Bishop, Christopher M.},
  year = {2006},
  publisher = {Springer},
  isbn = {978-0-387-31073-2}
}
"#;
    let entries = parse_bibtex(bib).unwrap();
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    assert!(matches!(e.work_type, clepsydra::vault::academic::WorkType::Book));
    assert_eq!(e.authors, vec!["Christopher M. Bishop"]);
    assert_eq!(e.publisher, Some("Springer".to_string()));
    assert_eq!(e.isbn, Some("978-0-387-31073-2".to_string()));
}

#[test]
fn parse_multiple_entries() {
    let bib = r#"
@article{paper1, title={First}, author={One, Author}, year={2020}}
@article{paper2, title={Second}, author={Two, Author}, year={2021}}
@book{book1, title={Third}, author={Three, Author}, year={2022}}
"#;
    let entries = parse_bibtex(bib).unwrap();
    assert_eq!(entries.len(), 3);
}

#[test]
fn author_name_normalization() {
    // BibTeX convention: "Family, Given" → stored as "Given Family"
    let bib = r#"
@article{test2024,
  title = {Test},
  author = {von Neumann, John and De Morgan, Augustus},
  year = {2024}
}
"#;
    let entries = parse_bibtex(bib).unwrap();
    let e = &entries[0];
    // biblatex crate parses prefix ("von") separately from family name
    // We normalize to "Given Prefix Family" format
    assert_eq!(e.authors, vec!["John von Neumann", "Augustus De Morgan"]);
}

#[test]
fn parse_thesis_and_report() {
    let bib = r#"
@phdthesis{smith2020,
  title = {My Dissertation},
  author = {Smith, Jane},
  year = {2020},
  school = {MIT}
}
@techreport{jones2021,
  title = {Technical Report},
  author = {Jones, Bob},
  year = {2021},
  institution = {NIST}
}
"#;
    let entries = parse_bibtex(bib).unwrap();
    assert_eq!(entries.len(), 2);
    assert!(matches!(entries[0].work_type, clepsydra::vault::academic::WorkType::Thesis));
    assert!(matches!(entries[1].work_type, clepsydra::vault::academic::WorkType::Report));
}

#[test]
fn parse_invalid_bibtex_returns_error() {
    let bib = "this is not valid bibtex at all {{{";
    let result = parse_bibtex(bib);
    assert!(result.is_err());
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test import_test`
Expected: FAIL — module `import` not found.

**Step 3: Implement `vault/import.rs`**

```rust
// src/vault/import.rs

use crate::vault::academic::WorkType;

/// A parsed BibTeX entry normalized for import into the vault.
#[derive(Debug, Clone)]
pub struct BibImportEntry {
    pub cite_key: String,
    pub title: String,
    pub work_type: WorkType,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub venue: Option<String>,
    pub publisher: Option<String>,
    pub doi: Option<String>,
    pub isbn: Option<String>,
    pub arxiv: Option<String>,
    pub url: Option<String>,
}

/// Parse a BibTeX string into a vec of normalized import entries.
pub fn parse_bibtex(input: &str) -> Result<Vec<BibImportEntry>, String> {
    let bibliography = biblatex::Bibliography::parse(input)
        .map_err(|e| format!("BibTeX parse error: {e}"))?;

    let mut entries = Vec::new();
    for entry in bibliography.iter() {
        let cite_key = entry.key.clone();

        let title = entry.title()
            .map(|chunks| chunks.format_verbatim())
            .unwrap_or_default();

        let work_type = match entry.entry_type {
            biblatex::EntryType::Book
            | biblatex::EntryType::MvBook => WorkType::Book,
            biblatex::EntryType::Thesis
            | biblatex::EntryType::PhdThesis
            | biblatex::EntryType::MastersThesis => WorkType::Thesis,
            biblatex::EntryType::Report
            | biblatex::EntryType::TechReport => WorkType::Report,
            _ => WorkType::Paper,
        };

        let authors = entry.author()
            .map(|persons| {
                persons.iter().map(|p| format_person(p)).collect()
            })
            .unwrap_or_default();

        let year = entry.date()
            .ok()
            .and_then(|d| d.value.and_then(|date| {
                // Date can be a single date or a range
                Some(date.year as i32)
            }))
            .or_else(|| {
                // Fallback: try the raw "year" field
                entry.get("year")
                    .and_then(|chunks| chunks.format_verbatim().parse::<i32>().ok())
            });

        let venue = entry.journal()
            .ok()
            .map(|chunks| chunks.format_verbatim());

        let publisher = entry.publisher()
            .ok()
            .and_then(|chunks_vec| chunks_vec.first().map(|c| c.format_verbatim()));

        let doi = entry.doi().ok();

        let isbn = entry.isbn()
            .ok()
            .map(|chunks| chunks.format_verbatim());

        let arxiv = entry.get("eprint")
            .map(|chunks| chunks.format_verbatim())
            .or_else(|| entry.get("arxiv").map(|c| c.format_verbatim()));

        let url = entry.url().ok().map(|u| u.value.to_string());

        entries.push(BibImportEntry {
            cite_key,
            title,
            work_type,
            authors,
            year,
            venue,
            publisher,
            doi,
            isbn,
            arxiv,
            url,
        });
    }

    Ok(entries)
}

/// Format a `biblatex::Person` into "Given Prefix Family Suffix" (given-first).
fn format_person(person: &biblatex::Person) -> String {
    let mut parts = Vec::new();
    if !person.given_name.is_empty() {
        parts.push(person.given_name.as_str());
    }
    if !person.prefix.is_empty() {
        parts.push(person.prefix.as_str());
    }
    parts.push(person.name.as_str());
    if !person.suffix.is_empty() {
        parts.push(person.suffix.as_str());
    }
    parts.join(" ")
}
```

Note: The exact `biblatex` API may differ slightly from what's documented — the implementer should check `docs.rs/biblatex` for the precise method signatures on `Entry` (e.g., `title()` returns `Result<ChunksRef, _>`, use `.format_verbatim()` to get a plain string). The `date()` accessor returns `PermissiveType<Date>` — extract year from the `Date` struct's `.year` field. If the API for `date()` proves awkward, fall back to reading the raw `year` field via `entry.get("year")`.

**Step 4: Add module declaration**

In `src/vault/mod.rs`, add: `pub mod import;`

**Step 5: Run tests**

Run: `cargo test --test import_test`
Expected: All 6 tests pass.

**Step 6: Commit**

```bash
git add src/vault/import.rs src/vault/mod.rs tests/import_test.rs
git commit -m "feat(vault): add BibTeX parsing module with author name normalization"
```

---

## Task 4: Deduplication logic

Before creating a work during import, check if a matching work already exists by DOI → ISBN → cite_key (in that priority order).

**Files:**
- Modify: `src/vault/import.rs` (add dedup functions)
- Modify: `tests/import_test.rs` (add dedup tests — these need a vault + index)

**Step 1: Write failing tests**

Add to `tests/import_test.rs`:

```rust
use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;
use clepsydra::vault::import::find_existing_work;
use tempfile::TempDir;
use std::fs;

#[test]
fn dedup_by_doi_finds_existing() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    fs::create_dir_all(root.join("library/papers")).unwrap();

    let work_content = "\
---
id: 00000000-0000-0000-0000-000000000500
kind: work
work_type: paper
title: Existing Paper
cite_key: existing2024
tags: []
external_ids:
  doi: \"10.1234/existing\"
---
Content.
";
    fs::write(root.join("library/papers/existing.md"), work_content).unwrap();

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    // Should find by DOI
    let found = find_existing_work(
        index.connection(),
        Some("10.1234/existing"),  // doi
        None,                       // isbn
        None,                       // cite_key
    );
    assert!(found.is_some(), "should find existing work by DOI");

    // Should NOT find with different DOI
    let not_found = find_existing_work(
        index.connection(),
        Some("10.1234/different"),
        None,
        None,
    );
    assert!(not_found.is_none());
}

#[test]
fn dedup_by_cite_key_finds_existing() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    fs::create_dir_all(root.join("library/papers")).unwrap();

    let work_content = "\
---
id: 00000000-0000-0000-0000-000000000501
kind: work
work_type: paper
title: Another Paper
cite_key: another2024
tags: []
---
Content.
";
    fs::write(root.join("library/papers/another.md"), work_content).unwrap();

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    // Should find by cite_key (via canonical_names table)
    let found = find_existing_work(
        index.connection(),
        None,
        None,
        Some("another2024"),
    );
    assert!(found.is_some(), "should find existing work by cite_key");
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test dedup`
Expected: FAIL — `find_existing_work` not found.

**Step 3: Implement dedup function**

Add to `src/vault/import.rs`:

```rust
use rusqlite::{Connection, params};

/// Check if a work already exists by DOI → ISBN → cite_key (priority order).
/// Returns Some(page_path) if found, None otherwise.
pub fn find_existing_work(
    conn: &Connection,
    doi: Option<&str>,
    isbn: Option<&str>,
    cite_key: Option<&str>,
) -> Option<String> {
    // 1. Check by DOI
    if let Some(doi) = doi {
        let path: Option<String> = conn
            .query_row(
                "SELECT path FROM pages WHERE json_extract(meta_json, '$.kind') = 'work'
                 AND json_extract(meta_json, '$.external_ids.doi') = ?1",
                params![doi],
                |row| row.get(0),
            )
            .ok();
        if path.is_some() {
            return path;
        }
    }

    // 2. Check by ISBN
    if let Some(isbn) = isbn {
        let path: Option<String> = conn
            .query_row(
                "SELECT path FROM pages WHERE json_extract(meta_json, '$.kind') = 'work'
                 AND json_extract(meta_json, '$.external_ids.isbn') = ?1",
                params![isbn],
                |row| row.get(0),
            )
            .ok();
        if path.is_some() {
            return path;
        }
    }

    // 3. Check by cite_key (via canonical_names table)
    if let Some(cite_key) = cite_key {
        use crate::vault::canonical::CanonicalName;
        let cn = CanonicalName::new(cite_key);
        let path: Option<String> = conn
            .query_row(
                "SELECT p.path FROM canonical_names cn
                 JOIN pages p ON p.id = cn.page_id
                 WHERE cn.canonical_name = ?1 AND cn.source = 'cite_key'",
                params![cn.as_str()],
                |row| row.get(0),
            )
            .ok();
        if path.is_some() {
            return path;
        }
    }

    None
}
```

**Step 4: Run tests**

Run: `cargo test dedup`
Expected: Both tests pass.

**Step 5: Commit**

```bash
git add src/vault/import.rs tests/import_test.rs
git commit -m "feat(vault): add dedup logic for import (DOI → ISBN → cite_key)"
```

---

## Task 5: BibTeX import API endpoint

Wire the BibTeX parser + dedup + work creation into `POST /api/vault/academic/import/bibtex`.

**Files:**
- Modify: `src/api/academic.rs` (add import route + handler)
- Modify: `tests/api_test.rs` (add import tests)

**Step 1: Write failing tests**

Add to `tests/api_test.rs`:

```rust
#[tokio::test]
async fn import_bibtex_creates_works() {
    let (server, _tmp) = setup_vault().await;

    let bibtex = r#"
@article{vaswani2017attention,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam},
  journal = {NeurIPS},
  year = {2017},
  doi = {10.48550/arXiv.1706.03762}
}
@book{bishop2006pattern,
  title = {Pattern Recognition and Machine Learning},
  author = {Bishop, Christopher M.},
  year = {2006},
  publisher = {Springer},
  isbn = {978-0-387-31073-2}
}
"#;

    let response = server
        .post("/api/vault/academic/import/bibtex")
        .content_type("text/plain")
        .text(bibtex)
        .await;
    response.assert_status(StatusCode::OK);

    let body: serde_json::Value = response.json();
    let results = body["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0]["status"], "created");
    assert_eq!(results[0]["cite_key"], "vaswani2017attention");
    assert_eq!(results[1]["status"], "created");
    assert_eq!(results[1]["cite_key"], "bishop2006pattern");

    // Verify works exist via list endpoint
    let list = server.get("/api/vault/academic/works").await;
    let works: Vec<serde_json::Value> = list.json();
    assert_eq!(works.len(), 2);
}

#[tokio::test]
async fn import_bibtex_skips_duplicates() {
    let (server, _tmp) = setup_vault().await;

    let bibtex = r#"
@article{test2024,
  title = {Test Paper},
  author = {Test, Author},
  year = {2024}
}
"#;

    // First import
    let r1 = server
        .post("/api/vault/academic/import/bibtex")
        .content_type("text/plain")
        .text(bibtex)
        .await;
    r1.assert_status(StatusCode::OK);
    let body1: serde_json::Value = r1.json();
    assert_eq!(body1["results"][0]["status"], "created");

    // Second import — same cite_key → skipped
    let r2 = server
        .post("/api/vault/academic/import/bibtex")
        .content_type("text/plain")
        .text(bibtex)
        .await;
    r2.assert_status(StatusCode::OK);
    let body2: serde_json::Value = r2.json();
    assert_eq!(body2["results"][0]["status"], "skipped");
}

#[tokio::test]
async fn import_bibtex_invalid_returns_400() {
    let (server, _tmp) = setup_vault().await;

    let response = server
        .post("/api/vault/academic/import/bibtex")
        .content_type("text/plain")
        .text("not valid bibtex {{{")
        .await;
    response.assert_status(StatusCode::BAD_REQUEST);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test import_bibtex`
Expected: FAIL — route not found (404).

**Step 3: Implement the endpoint**

In `src/api/academic.rs`:

1. Add route: `.route("/import/bibtex", post(import_bibtex))`

2. Add response type:
```rust
#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub cite_key: String,
    pub status: String,  // "created" | "skipped" | "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ImportResponse {
    pub results: Vec<ImportResult>,
}
```

3. Add handler:
```rust
async fn import_bibtex(
    State(state): State<Arc<AppState>>,
    body: String,
) -> Result<Json<ImportResponse>, ApiError> {
    let entries = crate::vault::import::parse_bibtex(&body)
        .map_err(|e| ApiError::bad_request(e))?;

    let mut results = Vec::with_capacity(entries.len());

    for entry in &entries {
        // Check dedup
        let existing = {
            let index = state.index.lock();
            crate::vault::import::find_existing_work(
                index.connection(),
                entry.doi.as_deref(),
                entry.isbn.as_deref(),
                Some(&entry.cite_key),
            )
        };

        if let Some(path) = existing {
            results.push(ImportResult {
                cite_key: entry.cite_key.clone(),
                status: "skipped".to_string(),
                page_path: Some(path),
                error: None,
            });
            continue;
        }

        // Create work via shared logic
        match create_work_internal(
            &state,
            entry.title.clone(),
            entry.work_type.clone(),
            entry.authors.clone(),
            entry.year,
            entry.venue.clone(),
            entry.publisher.clone(),
            None,  // status — unset for imports
            None,  // rating
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
            vec![],  // tags
            vec![],  // aliases
            None,    // body
        ) {
            Ok(detail) => {
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

    Ok(Json(ImportResponse { results }))
}
```

**Step 4: Run tests**

Run: `cargo test import_bibtex`
Expected: All 3 tests pass.

**Step 5: Run full suite**

Run: `cargo test`
Expected: All tests pass, no regressions.

**Step 6: Commit**

```bash
git add src/api/academic.rs tests/api_test.rs
git commit -m "feat(api): add POST /academic/import/bibtex endpoint with dedup"
```

---

## Task 6: DOI lookup endpoint (`POST /import/doi`)

Calls the Crossref API (`https://api.crossref.org/works/{doi}`) to fetch metadata for a single DOI and creates a work page.

**Files:**
- Create: `src/vault/import_doi.rs` (Crossref API client)
- Modify: `src/vault/mod.rs` (add `pub mod import_doi;`)
- Modify: `src/api/academic.rs` (add endpoint)
- Add tests: `tests/import_test.rs` (unit test for response parsing), `tests/api_test.rs` (API test)

**Step 1: Write the Crossref response parsing test**

Add to `tests/import_test.rs`:

```rust
use clepsydra::vault::import_doi::parse_crossref_response;

#[test]
fn parse_crossref_json_into_import_entry() {
    let json = serde_json::json!({
        "status": "ok",
        "message": {
            "type": "journal-article",
            "title": ["Nanometre-scale thermometry in a living cell"],
            "author": [
                {"given": "G.", "family": "Kucsko", "sequence": "first"},
                {"given": "P. C.", "family": "Maurer", "sequence": "additional"}
            ],
            "published-print": {"date-parts": [[2013, 8]]},
            "container-title": ["Nature"],
            "publisher": "Springer Science and Business Media LLC",
            "DOI": "10.1038/nature12373",
            "ISBN": null
        }
    });

    let entry = parse_crossref_response(&json).unwrap();
    assert_eq!(entry.title, "Nanometre-scale thermometry in a living cell");
    assert_eq!(entry.authors, vec!["G. Kucsko", "P. C. Maurer"]);
    assert_eq!(entry.year, Some(2013));
    assert_eq!(entry.venue, Some("Nature".to_string()));
    assert_eq!(entry.doi, Some("10.1038/nature12373".to_string()));
    assert!(matches!(entry.work_type, clepsydra::vault::academic::WorkType::Paper));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test parse_crossref`
Expected: FAIL — module not found.

**Step 3: Implement Crossref response parser**

Create `src/vault/import_doi.rs`:

```rust
use crate::vault::academic::WorkType;
use crate::vault::import::BibImportEntry;

/// Parse a Crossref API JSON response into a `BibImportEntry`.
pub fn parse_crossref_response(json: &serde_json::Value) -> Result<BibImportEntry, String> {
    let msg = json.get("message")
        .ok_or("missing 'message' field")?;

    let title = msg.get("title")
        .and_then(|t| t.as_array())
        .and_then(|a| a.first())
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();

    let work_type = match msg.get("type").and_then(|t| t.as_str()) {
        Some("book" | "monograph" | "edited-book") => WorkType::Book,
        Some("dissertation") => WorkType::Thesis,
        Some("report" | "report-component") => WorkType::Report,
        _ => WorkType::Paper,
    };

    let authors = msg.get("author")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter().filter_map(|a| {
                let given = a.get("given").and_then(|g| g.as_str()).unwrap_or("");
                let family = a.get("family").and_then(|f| f.as_str()).unwrap_or("");
                if family.is_empty() { None }
                else if given.is_empty() { Some(family.to_string()) }
                else { Some(format!("{given} {family}")) }
            }).collect()
        })
        .unwrap_or_default();

    let year = msg.get("published-print")
        .or_else(|| msg.get("published-online"))
        .and_then(|p| p.get("date-parts"))
        .and_then(|d| d.as_array())
        .and_then(|a| a.first())
        .and_then(|inner| inner.as_array())
        .and_then(|parts| parts.first())
        .and_then(|y| y.as_i64())
        .map(|y| y as i32);

    let venue = msg.get("container-title")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());

    let publisher = msg.get("publisher")
        .and_then(|p| p.as_str())
        .map(|s| s.to_string());

    let doi = msg.get("DOI")
        .and_then(|d| d.as_str())
        .map(|s| s.to_string());

    let isbn = msg.get("ISBN")
        .and_then(|i| i.as_array())
        .and_then(|a| a.first())
        .and_then(|i| i.as_str())
        .map(|s| s.to_string());

    // Generate a cite_key from first author + year + first word of title
    let cite_key = generate_cite_key(&authors, year, &title);

    Ok(BibImportEntry {
        cite_key,
        title,
        work_type,
        authors,
        year,
        venue,
        publisher,
        doi,
        isbn,
        arxiv: None,
        url: None,
    })
}

/// Fetch metadata for a DOI from the Crossref API.
pub async fn fetch_doi(doi: &str) -> Result<serde_json::Value, String> {
    let url = format!("https://api.crossref.org/works/{doi}");
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "Clepsydra/0.0.0 (https://github.com/clepsydra)")
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Crossref API returned {}", resp.status()));
    }

    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse Crossref response: {e}"))
}

/// Generate a cite_key from author, year, title (e.g., "kucsko2013nanometre").
fn generate_cite_key(authors: &[String], year: Option<i32>, title: &str) -> String {
    let author_part = authors.first()
        .map(|a| {
            // Take last word (family name) and lowercase
            a.split_whitespace().last().unwrap_or("unknown").to_lowercase()
        })
        .unwrap_or_else(|| "unknown".to_string());

    let year_part = year
        .map(|y| y.to_string())
        .unwrap_or_default();

    let title_part = title.split_whitespace()
        .next()
        .unwrap_or("untitled")
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>();

    format!("{author_part}{year_part}{title_part}")
}
```

**Step 4: Add module declaration**

In `src/vault/mod.rs`, add: `pub mod import_doi;`

**Step 5: Run parser test**

Run: `cargo test parse_crossref`
Expected: PASS.

**Step 6: Add DOI import API endpoint**

In `src/api/academic.rs`:

1. Add route: `.route("/import/doi", post(import_doi))`

2. Add request type:
```rust
#[derive(Debug, Deserialize)]
pub struct ImportDoiRequest {
    pub doi: String,
}
```

3. Add handler:
```rust
async fn import_doi(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ImportDoiRequest>,
) -> Result<Response, ApiError> {
    // 1. Check dedup by DOI
    {
        let index = state.index.lock();
        if let Some(path) = crate::vault::import::find_existing_work(
            index.connection(),
            Some(&req.doi),
            None,
            None,
        ) {
            return Ok((
                StatusCode::OK,
                Json(ImportResult {
                    cite_key: String::new(),
                    status: "skipped".to_string(),
                    page_path: Some(path),
                    error: None,
                }),
            ).into_response());
        }
    }

    // 2. Fetch from Crossref
    let json = crate::vault::import_doi::fetch_doi(&req.doi)
        .await
        .map_err(|e| ApiError::bad_request(format!("DOI lookup failed: {e}")))?;

    let entry = crate::vault::import_doi::parse_crossref_response(&json)
        .map_err(|e| ApiError::bad_request(format!("Failed to parse Crossref data: {e}")))?;

    // 3. Create work
    let detail = create_work_internal(
        &state,
        entry.title,
        entry.work_type,
        entry.authors,
        entry.year,
        entry.venue,
        entry.publisher,
        None,
        None,
        Some(ExternalIds {
            doi: entry.doi.clone(),
            isbn: entry.isbn,
            arxiv: entry.arxiv,
        }),
        entry.url.map(|u| WorkUrls { landing: Some(u), pdf: None }),
        Some(entry.cite_key.clone()),
        vec![],
        vec![],
        None,
    )?;

    Ok((
        StatusCode::CREATED,
        Json(ImportResult {
            cite_key: entry.cite_key,
            status: "created".to_string(),
            page_path: Some(detail.path),
            error: None,
        }),
    ).into_response())
}
```

**Step 7: Add API test (no live network call — mock test)**

Add to `tests/api_test.rs`:

```rust
// Note: A full DOI import integration test would require network access.
// For CI, we test the parsing layer only. The endpoint wiring is covered
// by the BibTeX import tests which share the same create_work_internal path.
```

The DOI endpoint's correctness relies on:
- `parse_crossref_response` (tested in Task 6 Step 1)
- `create_work_internal` (tested via BibTeX import tests)
- `find_existing_work` (tested in Task 4)

A manual integration test can be run against a real Crossref API.

**Step 8: Run full suite**

Run: `cargo test`
Expected: All tests pass.

**Step 9: Commit**

```bash
git add src/vault/import_doi.rs src/vault/mod.rs src/api/academic.rs tests/import_test.rs
git commit -m "feat(api): add POST /academic/import/doi endpoint with Crossref lookup"
```

---

## Task 7: ISBN lookup endpoint (`POST /import/isbn`)

Calls the Open Library API (`https://openlibrary.org/isbn/{isbn}.json`) to fetch book metadata for a single ISBN and creates a work page.

**Files:**
- Create: `src/vault/import_isbn.rs` (Open Library API client + response parser)
- Modify: `src/vault/mod.rs` (add `pub mod import_isbn;`)
- Modify: `src/api/academic.rs` (add endpoint)
- Modify: `tests/import_test.rs` (unit test for response parsing)

**Step 1: Write the Open Library response parsing test**

Add to `tests/import_test.rs`:

```rust
use clepsydra::vault::import_isbn::parse_openlibrary_response;

#[test]
fn parse_openlibrary_json_into_import_entry() {
    // Open Library /isbn/{isbn}.json returns the book edition directly
    let json = serde_json::json!({
        "title": "Pattern Recognition and Machine Learning",
        "authors": [{"key": "/authors/OL1394865A"}],
        "publish_date": "2006",
        "publishers": ["Springer"],
        "isbn_13": ["9780387310732"],
        "isbn_10": ["0387310738"],
        "key": "/books/OL7941839M"
    });

    // We also need author names from a separate call, but for the parser test
    // we pass pre-resolved author names
    let authors = vec!["Christopher M. Bishop".to_string()];

    let entry = parse_openlibrary_response(&json, &authors, "978-0-387-31073-2").unwrap();
    assert_eq!(entry.title, "Pattern Recognition and Machine Learning");
    assert_eq!(entry.authors, vec!["Christopher M. Bishop"]);
    assert_eq!(entry.year, Some(2006));
    assert_eq!(entry.publisher, Some("Springer".to_string()));
    assert!(matches!(entry.work_type, clepsydra::vault::academic::WorkType::Book));
    assert_eq!(entry.isbn, Some("978-0-387-31073-2".to_string()));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test parse_openlibrary`
Expected: FAIL — module not found.

**Step 3: Implement Open Library response parser**

Create `src/vault/import_isbn.rs`:

```rust
use crate::vault::academic::WorkType;
use crate::vault::import::BibImportEntry;
use crate::vault::import_doi::generate_cite_key;

/// Parse an Open Library edition JSON response into a `BibImportEntry`.
/// `authors` should be pre-resolved author names (Open Library stores
/// author references as keys, requiring a second API call).
pub fn parse_openlibrary_response(
    json: &serde_json::Value,
    authors: &[String],
    isbn: &str,
) -> Result<BibImportEntry, String> {
    let title = json.get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();

    let year = json.get("publish_date")
        .and_then(|d| d.as_str())
        .and_then(|s| {
            // Try to extract a 4-digit year from the publish_date string
            s.chars()
                .collect::<String>()
                .split_whitespace()
                .filter_map(|w| w.parse::<i32>().ok())
                .find(|y| *y > 1000 && *y < 3000)
        });

    let publisher = json.get("publishers")
        .and_then(|p| p.as_array())
        .and_then(|a| a.first())
        .and_then(|p| p.as_str())
        .map(|s| s.to_string());

    let cite_key = generate_cite_key(authors, year, &title);

    Ok(BibImportEntry {
        cite_key,
        title,
        work_type: WorkType::Book,  // ISBN lookup is always a book
        authors: authors.to_vec(),
        year,
        venue: None,
        publisher,
        doi: None,
        isbn: Some(isbn.to_string()),
        arxiv: None,
        url: None,
    })
}

/// Fetch book metadata from the Open Library API by ISBN.
/// Returns (edition_json, author_names).
pub async fn fetch_isbn(isbn: &str) -> Result<(serde_json::Value, Vec<String>), String> {
    let client = reqwest::Client::new();

    // 1. Fetch edition data
    let edition_url = format!("https://openlibrary.org/isbn/{isbn}.json");
    let edition_resp = client
        .get(&edition_url)
        .header("User-Agent", "Clepsydra/0.0.0 (https://github.com/clepsydra)")
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {e}"))?;

    if !edition_resp.status().is_success() {
        return Err(format!("Open Library returned {}", edition_resp.status()));
    }

    let edition: serde_json::Value = edition_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Open Library response: {e}"))?;

    // 2. Resolve author names
    let mut author_names = Vec::new();
    if let Some(authors) = edition.get("authors").and_then(|a| a.as_array()) {
        for author_ref in authors {
            if let Some(key) = author_ref.get("key").and_then(|k| k.as_str()) {
                let author_url = format!("https://openlibrary.org{key}.json");
                if let Ok(resp) = client
                    .get(&author_url)
                    .header("User-Agent", "Clepsydra/0.0.0")
                    .send()
                    .await
                {
                    if let Ok(author_json) = resp.json::<serde_json::Value>().await {
                        if let Some(name) = author_json.get("name").and_then(|n| n.as_str()) {
                            author_names.push(name.to_string());
                        }
                    }
                }
            }
        }
    }

    Ok((edition, author_names))
}
```

Note: `generate_cite_key` needs to be made `pub` in `import_doi.rs` so `import_isbn.rs` can reuse it. Alternatively, move it to `import.rs` as shared utility.

**Step 4: Add module declaration and make `generate_cite_key` pub**

In `src/vault/mod.rs`, add: `pub mod import_isbn;`
In `src/vault/import_doi.rs`, change `fn generate_cite_key` to `pub fn generate_cite_key`.

**Step 5: Run parser test**

Run: `cargo test parse_openlibrary`
Expected: PASS.

**Step 6: Add ISBN import API endpoint**

In `src/api/academic.rs`:

1. Add route: `.route("/import/isbn", post(import_isbn))`

2. Add request type:
```rust
#[derive(Debug, Deserialize)]
pub struct ImportIsbnRequest {
    pub isbn: String,
}
```

3. Add handler (same pattern as DOI — dedup check → fetch → parse → create):
```rust
async fn import_isbn(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ImportIsbnRequest>,
) -> Result<Response, ApiError> {
    // 1. Check dedup by ISBN
    {
        let index = state.index.lock();
        if let Some(path) = crate::vault::import::find_existing_work(
            index.connection(),
            None,
            Some(&req.isbn),
            None,
        ) {
            return Ok((
                StatusCode::OK,
                Json(ImportResult {
                    cite_key: String::new(),
                    status: "skipped".to_string(),
                    page_path: Some(path),
                    error: None,
                }),
            ).into_response());
        }
    }

    // 2. Fetch from Open Library
    let (edition_json, author_names) = crate::vault::import_isbn::fetch_isbn(&req.isbn)
        .await
        .map_err(|e| ApiError::bad_request(format!("ISBN lookup failed: {e}")))?;

    let entry = crate::vault::import_isbn::parse_openlibrary_response(
        &edition_json, &author_names, &req.isbn,
    ).map_err(|e| ApiError::bad_request(format!("Failed to parse Open Library data: {e}")))?;

    // 3. Create work
    let detail = create_work_internal(
        &state,
        entry.title,
        entry.work_type,
        entry.authors,
        entry.year,
        entry.venue,
        entry.publisher,
        None,
        None,
        Some(ExternalIds {
            doi: None,
            isbn: entry.isbn,
            arxiv: None,
        }),
        None,
        Some(entry.cite_key.clone()),
        vec![],
        vec![],
        None,
    )?;

    Ok((
        StatusCode::CREATED,
        Json(ImportResult {
            cite_key: entry.cite_key,
            status: "created".to_string(),
            page_path: Some(detail.path),
            error: None,
        }),
    ).into_response())
}
```

**Step 7: Run full suite**

Run: `cargo test`
Expected: All tests pass.

**Step 8: Commit**

```bash
git add src/vault/import_isbn.rs src/vault/import_doi.rs src/vault/mod.rs src/api/academic.rs tests/import_test.rs
git commit -m "feat(api): add POST /academic/import/isbn endpoint with Open Library lookup"
```

---

## Task 8: Integration test — full import lifecycle

End-to-end test covering: BibTeX import → dedup skip → list works → verify metadata.

**Files:**
- Modify: `tests/api_test.rs`

**Step 1: Write integration test**

```rust
#[tokio::test]
async fn import_lifecycle_bibtex_dedup_and_verify() {
    let (server, _tmp) = setup_vault().await;

    // 1. Import two entries via BibTeX
    let bibtex = r#"
@article{alpha2020first,
  title = {First Paper},
  author = {Alpha, Ann},
  year = {2020},
  journal = {Journal A},
  doi = {10.1234/first}
}
@book{beta2021second,
  title = {Second Book},
  author = {Beta, Bob},
  year = {2021},
  publisher = {Publisher B},
  isbn = {978-1-234-56789-0}
}
"#;

    let r = server
        .post("/api/vault/academic/import/bibtex")
        .content_type("text/plain")
        .text(bibtex)
        .await;
    r.assert_status(StatusCode::OK);
    let body: serde_json::Value = r.json();
    assert_eq!(body["results"][0]["status"], "created");
    assert_eq!(body["results"][1]["status"], "created");

    // 2. Re-import same BibTeX — both should be skipped
    let r2 = server
        .post("/api/vault/academic/import/bibtex")
        .content_type("text/plain")
        .text(bibtex)
        .await;
    let body2: serde_json::Value = r2.json();
    assert_eq!(body2["results"][0]["status"], "skipped");
    assert_eq!(body2["results"][1]["status"], "skipped");

    // 3. Import different entry with same DOI — should be skipped
    let bibtex_dup_doi = r#"
@article{different_key,
  title = {Different Title},
  author = {Gamma, Charlie},
  year = {2020},
  doi = {10.1234/first}
}
"#;
    let r3 = server
        .post("/api/vault/academic/import/bibtex")
        .content_type("text/plain")
        .text(bibtex_dup_doi)
        .await;
    let body3: serde_json::Value = r3.json();
    assert_eq!(body3["results"][0]["status"], "skipped");

    // 4. Verify works list shows exactly 2
    let list = server.get("/api/vault/academic/works").await;
    let works: Vec<serde_json::Value> = list.json();
    assert_eq!(works.len(), 2);

    // 5. Verify cite_key resolution: both cite_keys should be resolvable via wikilinks
    // (This is handled by CiteKeyDeriver during indexing — the fact that works
    // show up in the list confirms they were indexed successfully.)

    // 6. Verify metadata on the paper
    let paper = works.iter().find(|w| w["cite_key"] == "alpha2020first").unwrap();
    assert_eq!(paper["work_type"], "paper");
    assert_eq!(paper["year"], 2020);

    // 7. Verify metadata on the book
    let book = works.iter().find(|w| w["cite_key"] == "beta2021second").unwrap();
    assert_eq!(book["work_type"], "book");
    assert_eq!(book["year"], 2021);
}
```

**Step 2: Run the test**

Run: `cargo test import_lifecycle`
Expected: PASS.

**Step 3: Run full suite + clippy**

Run: `cargo test && cargo clippy`
Expected: All tests pass, no clippy warnings.

**Step 4: Commit**

```bash
git add tests/api_test.rs
git commit -m "test(api): add import lifecycle integration test with dedup verification"
```

---

## Dependency Graph

```
Task 1 (deps)
  └─→ Task 2 (extract shared logic)
       └─→ Task 3 (BibTeX parser) ──→ Task 5 (BibTeX endpoint)
       └─→ Task 4 (dedup logic)   ──→ Task 5
                                    ──→ Task 6 (DOI endpoint)
                                    ──→ Task 7 (ISBN endpoint)
                                         └─→ Task 8 (integration test)
```

Tasks 3 and 4 can run in parallel after Task 2 completes.
Tasks 6 and 7 can run in parallel after Tasks 4 and 5 complete.

---

## Notes for Implementer

1. **`biblatex` crate API**: The exact method signatures may differ from what's sketched above. Check `docs.rs/biblatex/0.11` for the precise API. Key things to verify:
   - How `title()` returns text (it's `ChunksRef` — call `.format_verbatim()`)
   - How `date()` works (returns `PermissiveType<Date>` — extract `.value.year`)
   - How `doi()` returns the DOI string
   - The `isbn()` method returns `ChunksRef`

2. **`reqwest` in tests**: The DOI and ISBN endpoints make real HTTP calls. The parsing logic is tested with synthetic JSON (no network). If you need to test the full endpoint in CI, consider using `wiremock` or skip-marking network tests.

3. **Author name edge cases**: The `biblatex` crate's `Person` struct has `given_name`, `prefix`, `name` (family), `suffix`. Some entries have empty given names (e.g., corporate authors like `{World Health Organization}`). Handle gracefully.

4. **Error handling in batch import**: Each BibTeX entry is processed independently. If one entry fails (e.g., slug collision), the error is captured in the result array and processing continues. The endpoint never returns 500 for individual entry failures.

5. **`generate_cite_key` shared utility**: Move to `import.rs` rather than `import_doi.rs` since both DOI and ISBN modules need it.
