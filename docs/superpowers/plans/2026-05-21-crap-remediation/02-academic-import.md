# Slice 02 — Academic Import CRAP Remediation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Read `00-overview.md` first — §3 (test conventions, especially **3.1 No network**) and §5 (validation loop) are assumed here.

**Goal:** Clear the five academic-import functions from the CRAP list: split `import_zotero_handler` (CC 63, the highest in the codebase) into a pure decision kernel plus thin I/O steps, extract `apply_source_wins`'s mutation into a pure function, and make the network functions (`fetch_doi`, `fetch_isbn`) testable via injected base URLs + `wiremock`.

**Architecture:** All HTTP becomes injectable: `fetch_doi`/`fetch_isbn` take a `base_url` parameter (default constants for production) so tests drive them against a local `wiremock::MockServer`. The Zotero handler's per-item conflict logic — currently a 20+-branch block duplicated across two dedup paths — collapses into a single pure `decide_item_action` kernel returning a `ConflictDecision` enum. The handler retains only orchestration + I/O.

**Tech Stack:** Axum 0.8, rusqlite, reqwest 0.12, serde_yaml; **new dev-dependency: `wiremock = "0.6"`**.

**Targets:** #3 import_zotero_handler, #9 apply_source_wins, #13 fetch_isbn, #23 import_doi, #24 import_isbn_handler.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `Cargo.toml` | add `wiremock` dev-dependency | Modify |
| `src/vault/import_doi.rs` | `fetch_doi(doi, base_url)`; `DEFAULT_CROSSREF_BASE` | Modify |
| `src/vault/import_isbn.rs` | `fetch_isbn(isbn, base_url)`; `DEFAULT_OPENLIBRARY_BASE` | Modify |
| `src/vault/import_zotero.rs` | `ConflictDecision`, `decide_item_action`, `resolve_db_path`, `build_provenance_extra`, `build_attachment_lists`, `should_save_checkpoint`, `apply_source_wins_to_meta` | Modify |
| `src/api/academic.rs` | thin `import_zotero_handler`/`apply_source_wins`/`import_doi`/`import_isbn_handler` | Modify |
| `tests/academic_http_test.rs` | wiremock-backed `fetch_*` + handler dedup tests | Create |
| `tests/import_test.rs` | reuse `create_mock_zotero_db` for the zotero integration test | Modify |

---

## Task 1: Add `wiremock` dev-dependency

**Files:** Modify `Cargo.toml`

- [ ] **Step 1: Add the dependency**

Under `[dev-dependencies]` in `Cargo.toml`, add:

```toml
wiremock = "0.6"
```

- [ ] **Step 2: Verify it resolves**

Run: `cargo fetch && cargo build --tests`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "chore(test): add wiremock dev-dependency for HTTP fixtures"
```

---

## Task 2: `apply_source_wins_to_meta` (#9)

`apply_source_wins` (academic.rs:702) loads a page, mutates its `PageMeta` from a `BibImportEntry`, and writes it back. Extract the mutation as pure.

**Files:**
- Modify: `src/vault/import_zotero.rs` (add pure fn + tests), `src/api/academic.rs` (apply_source_wins:702)

- [ ] **Step 1: Write the failing test**

In `src/vault/import_zotero.rs`:

```rust
/// Apply "source wins" field overwrites from a bibliographic entry onto an
/// already-loaded page's metadata, in place. Pure: no filesystem I/O.
pub fn apply_source_wins_to_meta(
    meta: &mut crate::vault::page::PageMeta,
    entry: &crate::vault::import::BibImportEntry,
) {
    // Port the field-mapping branches from src/api/academic.rs:709-761
    // (year, venue, publisher, doi, isbn, arxiv -> external_ids, imported_at),
    // operating on `meta.extra` instead of a freshly-loaded Page.
    todo!("port field mapping from apply_source_wins")
}

#[cfg(test)]
mod source_wins_tests {
    use super::*;
    use crate::vault::import::BibImportEntry;
    use crate::vault::page::PageMeta;

    fn entry() -> BibImportEntry {
        // Construct a BibImportEntry with year=Some(2020), venue=Some("Nature"),
        // doi=Some("10.x/y"). Fill other fields with Default/None as the struct
        // requires (mirror an existing constructor in tests/import_test.rs).
        BibImportEntry { ..Default::default() }
    }

    #[test]
    fn overwrites_year_and_venue() {
        let mut meta = PageMeta::new();
        apply_source_wins_to_meta(&mut meta, &entry());
        // Assert the YAML extra now carries the source year/venue.
        assert!(meta.extra.contains_key("import") || !meta.extra.is_empty());
    }
}
```

> Note: `BibImportEntry` may not derive `Default`; if not, build the fixture field-by-field mirroring `map_to_import_entry` output. Confirm the exact `extra` keys the source writes (e.g. `"year"`, `"venue"`, nested `"external_ids"`) and assert on those.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib import_zotero::source_wins_tests`
Expected: FAIL — `todo!`.

- [ ] **Step 3: Port the mapping and thin `apply_source_wins`**

Fill the `todo!` with the field-mapping logic. Then rewrite `apply_source_wins` (academic.rs:702) to:

```rust
fn apply_source_wins(
    state: &AppState,
    page_path: &str,
    entry: &crate::vault::import::BibImportEntry,
) -> Result<(), ApiError> {
    let vp = crate::vault::path::VaultPath::new(page_path)
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    let abs_path = state.vault.resolve(&vp);
    let mut page = crate::vault::page::Page::from_file(&abs_path, &vp)
        .map_err(|e| ApiError::internal(e.to_string()))?;
    crate::vault::import_zotero::apply_source_wins_to_meta(&mut page.meta, entry);
    let content = crate::vault::page::write_page_content(&page.meta, &page.body);
    std::fs::write(&abs_path, content).map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(())
}
```

> Note: match `Page::from_file`'s real signature/return; mirror the original error mapping.

- [ ] **Step 4: Run**

Run: `cargo test --lib import_zotero::source_wins_tests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/vault/import_zotero.rs src/api/academic.rs
git commit -m "refactor(academic): extract apply_source_wins_to_meta (pure)"
```

---

## Task 3: `fetch_doi(doi, base_url)` + wiremock test

**Files:**
- Modify: `src/vault/import_doi.rs`, `src/api/academic.rs` (import_doi:527)
- Create: `tests/academic_http_test.rs`

- [ ] **Step 1: Add the base-URL parameter**

In `src/vault/import_doi.rs`, change `fetch_doi`:

```rust
pub const DEFAULT_CROSSREF_BASE: &str = "https://api.crossref.org";

pub async fn fetch_doi(doi: &str, base_url: &str) -> Result<serde_json::Value, String> {
    let url = format!("{base_url}/works/{doi}");
    let client = reqwest::Client::new();
    // ... rest unchanged (GET url, check status, parse json) ...
}
```

Update the call site in `import_doi` (academic.rs:527) to `fetch_doi(&req.doi, crate::vault::import_doi::DEFAULT_CROSSREF_BASE).await`.

- [ ] **Step 2: Write the failing wiremock test**

Create `tests/academic_http_test.rs`:

```rust
use clepsydra::vault::import_doi::{fetch_doi, parse_crossref_response};
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn fetch_doi_parses_a_crossref_fixture() {
    let server = MockServer::start().await;
    let body = serde_json::json!({
        "message": {
            "title": ["A Study of Things"],
            "DOI": "10.1234/abcd",
            "issued": { "date-parts": [[2021]] },
            "author": [{ "given": "Ada", "family": "Lovelace" }]
        }
    });
    Mock::given(method("GET"))
        .and(path_regex(r"/works/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(&body))
        .mount(&server)
        .await;

    let json = fetch_doi("10.1234/abcd", &server.uri()).await.unwrap();
    let entry = parse_crossref_response(&json).unwrap();
    assert_eq!(entry.title, "A Study of Things");
}

#[tokio::test]
async fn fetch_doi_errors_on_500() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"/works/.*"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    assert!(fetch_doi("10.1/x", &server.uri()).await.is_err());
}
```

> Note: align `entry.title` access + the fixture shape with `parse_crossref_response`'s actual field handling.

- [ ] **Step 3: Run**

Run: `cargo test --test academic_http_test fetch_doi`
Expected: PASS (no real network — wiremock binds localhost).

- [ ] **Step 4: Commit**

```bash
git add src/vault/import_doi.rs src/api/academic.rs tests/academic_http_test.rs
git commit -m "test(academic): inject base_url into fetch_doi; cover via wiremock"
```

---

## Task 4: `fetch_isbn(isbn, base_url)` + wiremock test (#13)

`fetch_isbn` makes two calls: an edition fetch then per-author fetches. Both must hit the mock.

**Files:**
- Modify: `src/vault/import_isbn.rs`, `src/api/academic.rs` (import_isbn_handler:617)
- Modify: `tests/academic_http_test.rs`

- [ ] **Step 1: Add the base-URL parameter**

In `src/vault/import_isbn.rs`:

```rust
pub const DEFAULT_OPENLIBRARY_BASE: &str = "https://openlibrary.org";

pub async fn fetch_isbn(
    isbn: &str,
    base_url: &str,
) -> Result<(serde_json::Value, Vec<String>), String> {
    let client = reqwest::Client::new();
    let edition_url = format!("{base_url}/isbn/{isbn}.json");
    // ... edition fetch unchanged ...
    // per-author: replace the hardcoded host with `format!("{base_url}{author_key}.json")`
    // (author_key is the OpenLibrary "/authors/OLxxxA" path).
}
```

Update the call site in `import_isbn_handler` to `fetch_isbn(&req.isbn, crate::vault::import_isbn::DEFAULT_OPENLIBRARY_BASE).await`.

- [ ] **Step 2: Write the failing test**

Add to `tests/academic_http_test.rs`:

```rust
use clepsydra::vault::import_isbn::fetch_isbn;
use wiremock::matchers::path;

#[tokio::test]
async fn fetch_isbn_resolves_edition_and_authors() {
    let server = MockServer::start().await;
    let edition = serde_json::json!({
        "title": "Structure and Interpretation",
        "authors": [{ "key": "/authors/OL1A" }],
        "isbn_13": ["9780262011532"]
    });
    Mock::given(method("GET")).and(path("/isbn/9780262011532.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(&edition))
        .mount(&server).await;
    let author = serde_json::json!({ "name": "Harold Abelson" });
    Mock::given(method("GET")).and(path("/authors/OL1A.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(&author))
        .mount(&server).await;

    let (json, authors) = fetch_isbn("9780262011532", &server.uri()).await.unwrap();
    assert!(json.get("title").is_some());
    assert!(authors.iter().any(|a| a.contains("Abelson")));
}

#[tokio::test]
async fn fetch_isbn_errors_on_missing_edition() {
    let server = MockServer::start().await;
    Mock::given(method("GET")).and(path_regex(r"/isbn/.*"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server).await;
    assert!(fetch_isbn("0000000000000", &server.uri()).await.is_err());
}
```

> Note: confirm the author-key → URL shape (`{base}/authors/OL1A.json`) matches the source's loop and that `fetch_isbn` appends `.json`. Adjust the mock `path` accordingly.

- [ ] **Step 3: Run**

Run: `cargo test --test academic_http_test fetch_isbn`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/vault/import_isbn.rs src/api/academic.rs tests/academic_http_test.rs
git commit -m "test(academic): inject base_url into fetch_isbn; cover via wiremock"
```

---

## Task 5: Handler dedup-path coverage (#23, #24)

`import_doi`/`import_isbn_handler` have an early-return "already exists" path that needs **no network**. Covering it clears both (CC 6, need ~13%).

**Files:** Modify `tests/academic_http_test.rs` (reuse `setup_server`-style fixture)

- [ ] **Step 1: Write the failing tests**

Add to `tests/academic_http_test.rs` a local `setup_server()` (copy the pattern from `tests/api_test.rs:24-60`, or `use` it if exported), then:

```rust
#[tokio::test]
async fn import_doi_skips_when_work_already_exists() {
    let (server, _tmp) = setup_server_with_files(&[
        ("Existing.md", "---\ntitle: Existing\ndoi: 10.1234/abcd\n---\nbody\n"),
    ]);
    let resp = server
        .post("/api/vault/academic/import-doi")
        .json(&serde_json::json!({ "doi": "10.1234/abcd" }))
        .await;
    resp.assert_status(StatusCode::OK);
    // Body should indicate "skipped"/already-exists, not a 201 create.
}

#[tokio::test]
async fn import_isbn_skips_when_work_already_exists() {
    let (server, _tmp) = setup_server_with_files(&[
        ("Book.md", "---\ntitle: Book\nisbn: 9780262011532\n---\nbody\n"),
    ]);
    let resp = server
        .post("/api/vault/academic/import-isbn")
        .json(&serde_json::json!({ "isbn": "9780262011532" }))
        .await;
    resp.assert_status(StatusCode::OK);
}
```

> Note: confirm the route paths (`/academic/import-doi`, `/academic/import-isbn`) against `academic::router()` and the request JSON field names against `ImportDoiRequest`/`ImportIsbnRequest`. Confirm `find_existing_work` keys on frontmatter `doi`/`isbn` as written in the fixtures (it queries the index; the fixtures must be indexed by `setup_server_with_files`, which builds the index).

- [ ] **Step 2: Run**

Run: `cargo test --test academic_http_test import_doi_skips import_isbn_skips`
Expected: PASS — exercises the handlers' dedup branch with zero network.

- [ ] **Step 3: Commit**

```bash
git add tests/academic_http_test.rs
git commit -m "test(academic): cover import_doi/import_isbn dedup early-return"
```

---

## Task 6: `decide_item_action` kernel

The CC-63 driver in `import_zotero_handler` is two near-identical `match conflict_policy` blocks (zotero-key dedup path and DOI/ISBN/cite-key dedup path), each with `dry_run` sub-branches. Collapse into one pure kernel.

**Files:** Modify `src/vault/import_zotero.rs` (add enum + fn + tests)

- [ ] **Step 1: Write the failing test**

In `src/vault/import_zotero.rs`:

```rust
/// The action the importer should take for a single item, decided purely from
/// its dedup state, the conflict policy, and dry-run flag.
#[derive(Debug, PartialEq)]
pub enum ConflictDecision {
    Skip { path: String },
    WouldSkip { path: String },
    WouldUpdate { path: String },
    ApplySourceWins { path: String },
    ReportConflict { path: String },
    WouldCreate,
    Create,
}

/// Decide the action for one item. `existing` is the path of an already-present
/// page found by zotero-key OR by doi/isbn/cite-key (caller resolves which);
/// `has_diffs` is whether the source differs from the local copy (for Manual).
pub fn decide_item_action(
    existing: Option<&str>,
    conflict_policy: ConflictPolicy,
    dry_run: bool,
    has_diffs: bool,
) -> ConflictDecision {
    match existing {
        Some(path) => match conflict_policy {
            ConflictPolicy::Skip => {
                if dry_run {
                    ConflictDecision::WouldSkip { path: path.to_string() }
                } else {
                    ConflictDecision::Skip { path: path.to_string() }
                }
            }
            ConflictPolicy::SourceWins => {
                if dry_run {
                    ConflictDecision::WouldUpdate { path: path.to_string() }
                } else {
                    ConflictDecision::ApplySourceWins { path: path.to_string() }
                }
            }
            ConflictPolicy::Manual => {
                if has_diffs {
                    ConflictDecision::ReportConflict { path: path.to_string() }
                } else if dry_run {
                    ConflictDecision::WouldSkip { path: path.to_string() }
                } else {
                    ConflictDecision::Skip { path: path.to_string() }
                }
            }
        },
        None => {
            if dry_run {
                ConflictDecision::WouldCreate
            } else {
                ConflictDecision::Create
            }
        }
    }
}

#[cfg(test)]
mod decide_tests {
    use super::*;

    #[test]
    fn missing_creates() {
        assert_eq!(decide_item_action(None, ConflictPolicy::Skip, false, false), ConflictDecision::Create);
        assert_eq!(decide_item_action(None, ConflictPolicy::Skip, true, false), ConflictDecision::WouldCreate);
    }

    #[test]
    fn existing_skip_policy() {
        assert_eq!(
            decide_item_action(Some("A.md"), ConflictPolicy::Skip, false, false),
            ConflictDecision::Skip { path: "A.md".into() }
        );
    }

    #[test]
    fn existing_source_wins_live_vs_dry() {
        assert_eq!(
            decide_item_action(Some("A.md"), ConflictPolicy::SourceWins, false, false),
            ConflictDecision::ApplySourceWins { path: "A.md".into() }
        );
        assert_eq!(
            decide_item_action(Some("A.md"), ConflictPolicy::SourceWins, true, false),
            ConflictDecision::WouldUpdate { path: "A.md".into() }
        );
    }

    #[test]
    fn manual_reports_only_when_diffs() {
        assert_eq!(
            decide_item_action(Some("A.md"), ConflictPolicy::Manual, false, true),
            ConflictDecision::ReportConflict { path: "A.md".into() }
        );
        assert_eq!(
            decide_item_action(Some("A.md"), ConflictPolicy::Manual, false, false),
            ConflictDecision::Skip { path: "A.md".into() }
        );
    }
}
```

> Note: this kernel encodes the **intended** policy matrix. Before wiring it in (Task 7), diff its outputs against the current handler arms (academic.rs:880-1075) to confirm it is behavior-identical, especially the Manual + dry_run interaction. Adjust the kernel to match observed behavior, then update tests.

- [ ] **Step 2: Run**

Run: `cargo test --lib import_zotero::decide_tests`
Expected: PASS (`ConflictPolicy` must derive `Clone, Copy` — add `#[derive(Clone, Copy)]` if absent).

- [ ] **Step 3: Commit**

```bash
git add src/vault/import_zotero.rs
git commit -m "feat(academic): add pure decide_item_action conflict kernel"
```

---

## Task 7: Decompose `import_zotero_handler` (#3)

**Files:** Modify `src/vault/import_zotero.rs` (helpers + tests), `src/api/academic.rs` (import_zotero_handler:788), `tests/import_test.rs` (integration test)

- [ ] **Step 1: Add the remaining pure helpers with tests**

In `src/vault/import_zotero.rs`:

```rust
use std::path::{Path, PathBuf};

/// Resolve the Zotero DB path from request/config, tilde-expanding `~/`,
/// falling back to auto-detection. Errors if nothing is found.
pub fn resolve_db_path(
    request_path: Option<&str>,
    config_path: Option<&str>,
    home: &Path,
) -> Result<PathBuf, String> {
    let expand = |p: &str| -> PathBuf {
        if let Some(rest) = p.strip_prefix("~/") { home.join(rest) } else { PathBuf::from(p) }
    };
    if let Some(p) = request_path { return Ok(expand(p)); }
    if let Some(p) = config_path { return Ok(expand(p)); }
    detect_zotero_db().ok_or_else(|| "no Zotero database found".to_string())
}

/// Whether a checkpoint should be saved after a (non-dry) import run.
pub fn should_save_checkpoint(results: &[crate::api::academic::ImportResult]) -> bool {
    results.iter().any(|r| r.status == "created" || r.status == "skipped")
}
```

(Also add `build_provenance_extra` and `build_attachment_lists` per the structural analysis, porting academic.rs:1128-1165; give each a unit test asserting the shape of the produced `serde_yaml::Mapping` / the `(assets, pdf_url)` split.)

Tests:

```rust
#[cfg(test)]
mod helper_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn resolve_db_path_expands_tilde_from_request() {
        let p = resolve_db_path(Some("~/Zotero/zotero.sqlite"), None, Path::new("/home/me")).unwrap();
        assert_eq!(p, Path::new("/home/me/Zotero/zotero.sqlite"));
    }

    #[test]
    fn resolve_db_path_prefers_request_over_config() {
        let p = resolve_db_path(Some("/explicit.sqlite"), Some("/configured.sqlite"), Path::new("/h")).unwrap();
        assert_eq!(p, Path::new("/explicit.sqlite"));
    }
}
```

> Note: `should_save_checkpoint` references `ImportResult`; if it lives in `api::academic`, either move `ImportResult` to a shared module or accept a `&[&str]` of statuses to keep `import_zotero.rs` independent of the `api` layer. Prefer the `&[&str]` form to avoid a layering cycle.

- [ ] **Step 2: Run the helper tests**

Run: `cargo test --lib import_zotero::helper_tests`
Expected: PASS

- [ ] **Step 3: Rewrite the handler to orchestrate**

Rewrite `import_zotero_handler` (academic.rs:788) to:

1. `let db_path = resolve_db_path(req.database_path.as_deref(), config_db.as_deref(), &home)?;`
2. `let conn = open_zotero_db(&db_path)?;`
3. resolve `effective_since` (request `since` ?? checkpoint).
4. `let items = query_items(&conn, req.collection.as_deref(), effective_since.as_deref())?;`
5. For each item: resolve `existing` (zotero-key lookup, else doi/isbn/cite-key via `find_existing_work`), compute `has_diffs` (via `compute_field_diffs` only when policy is `Manual`), then `match decide_item_action(existing, req.conflict_policy, req.dry_run, has_diffs)` and dispatch:
   - `ApplySourceWins { path }` → `apply_source_wins(...)` + reindex
   - `Create` → `create_work_internal(...)` then `patch_provenance(...)`
   - the `Would*`/`Skip`/`ReportConflict` arms → push the corresponding `ImportResult`
6. `if req.auto_checkpoint && !req.dry_run && should_save_checkpoint(&results) { cp.save(...) }`

Target handler CC ≤ 15.

- [ ] **Step 4: Add the integration test**

In `tests/import_test.rs`, using the existing `create_mock_zotero_db` helper (line 360) and a `setup_server`-style fixture:

```rust
#[tokio::test]
async fn zotero_import_creates_pages_from_mock_db() {
    let (server, tmp) = setup_server();
    let zotero_db = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db(&zotero_db);
    let resp = server
        .post("/api/vault/academic/import-zotero")
        .json(&serde_json::json!({
            "database_path": zotero_db.to_str().unwrap(),
            "conflict_policy": "skip",
            "dry_run": false
        }))
        .await;
    resp.assert_status_ok();
    // Assert at least one ImportResult with status "created".
}

#[tokio::test]
async fn zotero_import_dry_run_creates_nothing() {
    let (server, tmp) = setup_server();
    let zotero_db = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db(&zotero_db);
    let resp = server
        .post("/api/vault/academic/import-zotero")
        .json(&serde_json::json!({
            "database_path": zotero_db.to_str().unwrap(),
            "conflict_policy": "skip",
            "dry_run": true
        }))
        .await;
    resp.assert_status_ok();
    // Assert results carry "would-create" status and no files were written.
}

#[tokio::test]
async fn zotero_import_missing_db_errors() {
    let (server, _tmp) = setup_server();
    let resp = server
        .post("/api/vault/academic/import-zotero")
        .json(&serde_json::json!({ "database_path": "/no/such.sqlite", "conflict_policy": "skip" }))
        .await;
    assert!(resp.status_code().is_client_error() || resp.status_code().is_server_error());
}
```

> Note: confirm `create_mock_zotero_db` is reachable from the test module (same file) and the request field names/route. Mirror the status strings the handler emits ("created"/"would-create"/"skipped").

- [ ] **Step 5: Run and commit**

Run: `cargo test --test import_test zotero_import && cargo test --lib import_zotero`
Expected: PASS

```bash
git add src/vault/import_zotero.rs src/api/academic.rs tests/import_test.rs
git commit -m "refactor(academic): decompose import_zotero_handler into pure kernel + thin I/O"
```

---

## Task 8: Slice gate

- [ ] **Step 1: Full suite green, no network**

Run: `cargo test`
Expected: PASS. Verify no test added in this slice performs real network I/O:
`rg -n 'crossref\.org|openlibrary\.org' tests/` — Expected: no matches in test bodies (only the `DEFAULT_*` constants in `src/`).

- [ ] **Step 2: CRAP gate**

Run: `./scripts/crap-check.sh`
Expected: count strictly below the slice-01 result; none of `import_zotero_handler`, `apply_source_wins`, `import_doi`, `import_isbn_handler`, `fetch_isbn` in the `✗` rows.

```bash
cargo crap --lcov lcov.info 2>&1 | rg '✗' | rg 'academic\.rs|import_isbn|import_doi' || echo "academic import cleared"
```
Expected: `academic import cleared`

- [ ] **Step 3: Check for new over-threshold helpers**

If `decide_item_action`, `resolve_db_path`, or `build_provenance_extra` appear in `✗`, add the missing branch tests and re-run.

- [ ] **Step 4: Commit any top-ups**

```bash
git add -A && git commit -m "test(academic): close remaining coverage gaps for slice 02"
```

---

## Self-Review

- **Spec coverage:** import_zotero_handler (T6 kernel + T7), apply_source_wins (T2), fetch_isbn (T4), import_doi (T3 fetch + T5 handler), import_isbn_handler (T4 fetch + T5 handler). ✓
- **No network:** all HTTP routed through `base_url` + wiremock; handler-dedup and zotero tests use local SQLite/index only. ✓
- **Type consistency:** `decide_item_action(Option<&str>, ConflictPolicy, bool, bool) -> ConflictDecision` is the single dispatch point used by both former dedup paths; `fetch_doi(&str,&str)`/`fetch_isbn(&str,&str)` signatures match their call sites. ✓
- **Layering risk:** `should_save_checkpoint` must not pull `api::academic` types into `vault` — use `&[&str]` statuses (noted in T7).
- **Behavior risk:** the conflict-policy matrix is the one place a refactor could change behavior; T6 mandates diffing the kernel against the live arms before wiring.
