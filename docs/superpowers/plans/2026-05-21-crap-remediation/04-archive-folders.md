# Slice 04 — Archive Ingest & Folder Listing CRAP Remediation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Read `00-overview.md` first — §3 and §5 are assumed.

**Goal:** Clear `ingest_archive` (CC 32, a mandatory refactor) and `list_folder_contents` (CC 12) by extracting their pure sub-computations — blob validation/decoding, page-meta construction, path-collision resolution, directory classification, sort/fallback — into unit-testable functions, leaving thin handlers covered by the existing integration suite.

**Architecture:** `ingest_archive` is JSON-bodied (blobs arrive base64-encoded in `ArchiveRequest`, **not** multipart), so its complexity is pure logic reachable only behind the full stack today. Extracting that logic makes it directly unit-testable in-memory; the handler keeps only the lock/DB/FS/broadcast effects. `list_folder_contents`'s directory walk becomes a pure classifier over already-read entries plus a pure sort.

**Tech Stack:** Axum 0.8, base64, rusqlite, `tempfile`/`axum-test` (dev-deps, present).

**Targets:** #20 ingest_archive, #10 list_folder_contents.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/api/archive.rs` | `validate_blob_sizes`, `decode_and_verify_blobs`, `build_archive_meta`, `resolve_page_path`, `store_decoded_blobs`; thin `ingest_archive` | Modify |
| `src/api/folders.rs` | `classify_dir_entries`, `sort_folder_listing`, `build_page_summary_fallback`; thin `list_folder_contents` | Modify |
| `tests/archive_test.rs` | existing integration coverage (reference; add a couple of edge cases) | Modify |

---

## Task 1: `validate_blob_sizes` (pure)

**Files:** Modify `src/api/archive.rs`

- [ ] **Step 1: Write the failing test**

In `src/api/archive.rs`:

```rust
/// Validate per-blob and total request sizes against configured limits.
pub(crate) fn validate_blob_sizes(
    blobs: &[BlobUpload],
    max_blob_bytes: u64,
    max_request_bytes: u64,
) -> Result<(), ApiError> {
    // Port the size loop from ingest_archive (lines ~159-178):
    // for each blob, estimate decoded size; reject if > max_blob_bytes;
    // accumulate; reject total > max_request_bytes.
    todo!("port size validation")
}

#[cfg(test)]
mod size_tests {
    use super::*;

    fn blob(data_len_b64: usize) -> BlobUpload {
        // Construct a BlobUpload whose `data` is a base64 string of the given
        // length (content irrelevant to size checks). Mirror BlobUpload fields.
        BlobUpload { data: "A".repeat(data_len_b64), ..Default::default() }
    }

    #[test]
    fn accepts_within_limits() {
        assert!(validate_blob_sizes(&[blob(100)], 1_000, 10_000).is_ok());
    }

    #[test]
    fn rejects_oversized_single_blob() {
        assert!(validate_blob_sizes(&[blob(10_000)], 1_000, 1_000_000).is_err());
    }

    #[test]
    fn rejects_oversized_request_total() {
        assert!(validate_blob_sizes(&[blob(800), blob(800)], 1_000, 1_000).is_err());
    }
}
```

> Note: confirm `BlobUpload`'s fields and whether it derives `Default`; if not, construct it explicitly. Confirm the size-estimation formula the source uses (base64 decoded length ≈ `len * 3 / 4`).

- [ ] **Step 2: Run to verify it fails** → **Step 3: Port** → **Step 4: Run passes**

Run: `cargo test --lib api::archive::size_tests`
Expected: FAIL (todo!), then PASS after porting and replacing the inline loop in `ingest_archive` with `validate_blob_sizes(&req.blobs, max_blob, max_req)?;`.

- [ ] **Step 5: Commit**

```bash
git add src/api/archive.rs
git commit -m "refactor(archive): extract validate_blob_sizes"
```

---

## Task 2: `decode_and_verify_blobs` (pure)

**Files:** Modify `src/api/archive.rs`

- [ ] **Step 1: Write the failing test**

```rust
use base64::Engine;

/// Decode base64 blobs, verify each against its declared content hash, and
/// de-duplicate by hash. Returns `(hash, bytes, content_type)` per unique blob.
pub(crate) fn decode_and_verify_blobs(
    blobs: &[BlobUpload],
) -> Result<Vec<(String, Vec<u8>, String)>, ApiError> {
    // Port lines ~252-272 of ingest_archive: HashSet dedup, base64 decode
    // (error -> 400), hash verify (mismatch -> 400).
    todo!("port decode + verify")
}

#[cfg(test)]
mod decode_tests {
    use super::*;
    use base64::Engine;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn blob_with(bytes: &[u8], content_type: &str) -> BlobUpload {
        let hash = ContentStore::hash_bytes(bytes);
        BlobUpload {
            data: b64(bytes),
            content_hash: hash,
            content_type: content_type.into(),
            ..Default::default()
        }
    }

    #[test]
    fn decodes_and_verifies_valid_blob() {
        let out = decode_and_verify_blobs(&[blob_with(b"hello", "text/plain")]).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].1, b"hello");
    }

    #[test]
    fn dedups_identical_hashes() {
        let b = blob_with(b"dup", "text/plain");
        let out = decode_and_verify_blobs(&[b.clone(), b]).unwrap();
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn rejects_hash_mismatch() {
        let mut b = blob_with(b"hello", "text/plain");
        b.content_hash = "deadbeef".into();
        assert!(decode_and_verify_blobs(&[b]).is_err());
    }

    #[test]
    fn rejects_invalid_base64() {
        let mut b = blob_with(b"x", "text/plain");
        b.data = "!!!not base64!!!".into();
        assert!(decode_and_verify_blobs(&[b]).is_err());
    }
}
```

> Note: confirm `BlobUpload`'s hash/content-type field names (`content_hash`, `content_type`) and the base64 engine the source uses (`STANDARD` vs `URL_SAFE`). `BlobUpload` must be `Clone` for the dedup test (add `#[derive(Clone)]` if absent — it's a DTO).

- [ ] **Step 2–4: Fail → port → pass**

Run: `cargo test --lib api::archive::decode_tests`
Then replace the inline decode loop in `ingest_archive` with `let decoded = decode_and_verify_blobs(&req.blobs)?;`.

- [ ] **Step 5: Commit**

```bash
git add src/api/archive.rs
git commit -m "refactor(archive): extract decode_and_verify_blobs"
```

---

## Task 3: `build_archive_meta` + `resolve_page_path` (pure)

**Files:** Modify `src/api/archive.rs`

- [ ] **Step 1: Write the failing tests**

```rust
/// Build the PageMeta (with the `archive` YAML mapping) for an ingest request.
pub(crate) fn build_archive_meta(req: &ArchiveRequest) -> crate::vault::page::PageMeta {
    // Port lines ~313-368: PageMeta::new + archive map + conditional
    // canonical_url / description / non-snapshot blob list inserts.
    todo!("port meta construction")
}

/// Resolve a non-colliding page path. `path_exists` lets tests inject collisions.
pub(crate) fn resolve_page_path(
    prefix: &str,
    domain: &str,
    slug: &str,
    path_exists: impl Fn(&str) -> bool,
) -> Result<String, ApiError> {
    // Port lines ~225-244: slug "" -> "untitled"; collision counter 1..1000;
    // > 1000 -> 500 error.
    todo!("port path resolution")
}

#[cfg(test)]
mod meta_path_tests {
    use super::*;

    #[test]
    fn empty_slug_falls_back_to_untitled() {
        let p = resolve_page_path("archive", "example.com", "", |_| false).unwrap();
        assert!(p.contains("untitled"));
    }

    #[test]
    fn collision_appends_counter() {
        let taken = ["archive/example.com/note.md"];
        let p = resolve_page_path("archive", "example.com", "note", |c| taken.contains(&c)).unwrap();
        assert_ne!(p, "archive/example.com/note.md");
    }

    #[test]
    fn build_archive_meta_sets_archive_block() {
        // Construct a minimal ArchiveRequest and assert meta.extra has "archive".
        let req = ArchiveRequest { ..Default::default() };
        let meta = build_archive_meta(&req);
        assert!(meta.extra.contains_key("archive"));
    }
}
```

> Note: confirm the real path template (`{prefix}/{domain}/{slug}.md` and the collision suffix format) and `ArchiveRequest`'s fields/`Default`-ability. Mirror the source's exact path construction so generated paths are identical.

- [ ] **Step 2–4: Fail → port → pass**, then in `ingest_archive` replace the inline path loop with `resolve_page_path(prefix, &domain, &slug, |c| state.vault.resolve(&VaultPath::new(c).unwrap()).exists())?` and the inline meta block with `let meta = build_archive_meta(&req);`.

Run: `cargo test --lib api::archive::meta_path_tests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/api/archive.rs
git commit -m "refactor(archive): extract build_archive_meta + resolve_page_path"
```

---

## Task 4: `store_decoded_blobs` + thin `ingest_archive` (#20)

**Files:** Modify `src/api/archive.rs`, `tests/archive_test.rs`

- [ ] **Step 1: Extract the CAS write loop**

```rust
/// Store decoded blobs in the CAS, returning (stored, deduped, stored_hashes).
fn store_decoded_blobs(
    cas: &ContentStore,
    decoded: &[(String, Vec<u8>, String)],
) -> Result<(u32, u32, Vec<String>), ApiError> {
    let (mut stored, mut deduped, mut hashes) = (0u32, 0u32, Vec::new());
    for (_hash, bytes, content_type) in decoded {
        let result = cas.store(bytes, content_type).map_err(|e| ApiError::internal(e.to_string()))?;
        if result.already_existed { deduped += 1; } else { stored += 1; }
        hashes.push(result.hash);
    }
    Ok((stored, deduped, hashes))
}
```

- [ ] **Step 2: Write a unit test (real CAS over tempdir)**

```rust
#[cfg(test)]
mod store_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn stores_then_dedups_same_bytes() {
        let tmp = TempDir::new().unwrap();
        let cas = ContentStore::open(&tmp.path().join("cas")).unwrap();
        let decoded = vec![("h".into(), b"abc".to_vec(), "text/plain".into())];
        let (stored, deduped, _) = store_decoded_blobs(&cas, &decoded).unwrap();
        assert_eq!((stored, deduped), (1, 0));
        let (stored2, deduped2, _) = store_decoded_blobs(&cas, &decoded).unwrap();
        assert_eq!((stored2, deduped2), (0, 1));
    }
}
```

- [ ] **Step 3: Thin the handler**

Rewrite `ingest_archive` (137) to call, in order: feature-flag guard → `validate_blob_sizes` → content-hash check → acquire lock → `find_by_archive_url` dedup branches → `resolve_page_path` → `decode_and_verify_blobs` → `store_decoded_blobs` → `build_archive_meta` → `write_page_content` + file create → index → broadcast → 201. Keep the rollback closure. Target handler CC ≤ 14.

- [ ] **Step 4: Run unit + existing integration tests**

Run: `cargo test --lib api::archive && cargo test --test archive_test`
Expected: PASS — the existing 8 integration tests are the behavior guard; they must stay green.

- [ ] **Step 5: Commit**

```bash
git add src/api/archive.rs tests/archive_test.rs
git commit -m "refactor(archive): extract CAS store loop; thin ingest_archive"
```

---

## Task 5: `classify_dir_entries` + `build_page_summary_fallback` (folders)

**Files:** Modify `src/api/folders.rs`

- [ ] **Step 1: Write the failing test**

```rust
/// Classify directory entries into (folders, md_children), skipping hidden dirs
/// and vault-excluded paths. Pure given an exclusion predicate.
pub(crate) fn classify_dir_entries(
    parent_path: &str,
    entries: impl IntoIterator<Item = std::fs::DirEntry>,
    is_excluded: impl Fn(&VaultPath) -> bool,
) -> (Vec<FolderInfo>, Vec<(String, VaultPath)>) {
    // Port lines ~207-229 of list_folder_contents.
    todo!("port classification")
}

/// Synthetic page summary for an md file with no index row yet.
pub(crate) fn build_page_summary_fallback(name: &str, vp: &VaultPath) -> PageSummary {
    PageSummary {
        id: String::new(),
        path: vp.as_str().to_string(),
        title: None,
        canonical_name: name.trim_end_matches(".md").to_string(),
    }
}

#[cfg(test)]
mod classify_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn separates_dirs_md_and_skips_hidden() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir(tmp.path().join("sub")).unwrap();
        std::fs::create_dir(tmp.path().join(".hidden")).unwrap();
        std::fs::write(tmp.path().join("note.md"), "x").unwrap();
        std::fs::write(tmp.path().join("data.bin"), "x").unwrap();
        let entries = std::fs::read_dir(tmp.path()).unwrap().flatten();
        let (folders, md) = classify_dir_entries("root", entries, |_| false);
        assert!(folders.iter().any(|f| f.name == "sub"));
        assert!(!folders.iter().any(|f| f.name == ".hidden"));
        assert!(md.iter().any(|(n, _)| n == "note.md"));
    }

    #[test]
    fn excluded_dirs_are_dropped() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir(tmp.path().join("skip")).unwrap();
        let entries = std::fs::read_dir(tmp.path()).unwrap().flatten();
        let (folders, _) = classify_dir_entries("root", entries, |vp| vp.as_str().ends_with("skip"));
        assert!(folders.is_empty());
    }

    #[test]
    fn fallback_strips_md_extension() {
        let vp = VaultPath::new("a/Note.md").unwrap();
        let s = build_page_summary_fallback("Note.md", &vp);
        assert_eq!(s.canonical_name, "Note");
    }
}
```

> Note: confirm `FolderInfo`/`PageSummary` field names and that `read_dir().flatten()` ordering doesn't matter (assertions use `any`). Confirm `VaultPath::new` accepts the `parent_path/name` form built inside the classifier.

- [ ] **Step 2–4: Fail → port → pass**

Run: `cargo test --lib api::folders::classify_tests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/api/folders.rs
git commit -m "refactor(folders): extract classify_dir_entries + page-summary fallback"
```

---

## Task 6: `sort_folder_listing` + thin `list_folder_contents` (#10)

**Files:** Modify `src/api/folders.rs`

- [ ] **Step 1: Write the failing test**

```rust
/// Sort folders by name and pages by path (stable, in place).
pub(crate) fn sort_folder_listing(folders: &mut [FolderInfo], pages: &mut [PageSummary]) {
    folders.sort_by(|a, b| a.name.cmp(&b.name));
    pages.sort_by(|a, b| a.path.cmp(&b.path));
}

#[cfg(test)]
mod sort_tests {
    use super::*;

    #[test]
    fn sorts_folders_by_name() {
        let mut folders = vec![
            FolderInfo { name: "b".into(), path: "x/b".into() },
            FolderInfo { name: "a".into(), path: "x/a".into() },
        ];
        let mut pages: Vec<PageSummary> = vec![];
        sort_folder_listing(&mut folders, &mut pages);
        assert_eq!(folders[0].name, "a");
    }
}
```

> Note: confirm the page sort key the source uses (`path` vs `title`); mirror it exactly.

- [ ] **Step 2: Run, then thin the handler**

In `list_folder_contents` (190): replace the inline directory loop with `classify_dir_entries`, the `None`-arm summary with `build_page_summary_fallback`, and the two `sort_by` calls with `sort_folder_listing(&mut folders, &mut pages)`. Target handler CC ≤ 8.

Run: `cargo test --lib api::folders::sort_tests`
Expected: PASS

- [ ] **Step 3: Add/confirm an integration test**

Confirm an existing folder-listing integration test exists; if not, add one using `setup_server_with_files` exercising a directory with subfolders + md files + a hidden dir.

```rust
#[tokio::test]
async fn lists_folder_contents_sorted() {
    let (server, _tmp) = setup_server_with_files(&[
        ("topic/Beta.md", "# Beta\n"),
        ("topic/Alpha.md", "# Alpha\n"),
        ("topic/sub/Child.md", "# Child\n"),
    ]);
    let resp = server.get("/api/vault/folders/topic").await;
    resp.assert_status_ok();
    // Assert pages Alpha before Beta; folder "sub" present.
}
```

> Note: confirm the GET route shape for folder listing in `folders::router()`.

- [ ] **Step 4: Run & commit**

Run: `cargo test --lib api::folders && cargo test --test api_test lists_folder`
Expected: PASS

```bash
git add src/api/folders.rs tests/api_test.rs
git commit -m "refactor(folders): extract sort; thin list_folder_contents; cover listing"
```

---

## Task 7: Slice gate

- [ ] **Step 1: Full suite green**

Run: `cargo test`
Expected: PASS.

- [ ] **Step 2: CRAP gate**

Run: `./scripts/crap-check.sh`
Expected: count strictly below slice-03 result; neither `ingest_archive` nor `list_folder_contents` in `✗`.

```bash
cargo crap --lcov lcov.info 2>&1 | rg '✗' | rg 'archive\.rs|folders\.rs' || echo "archive/folders cleared"
```
Expected: `archive/folders cleared`

- [ ] **Step 3: New-helper check + top-up commit**

```bash
git add -A && git commit -m "test(archive,folders): close coverage gaps for slice 04"
```

---

## Self-Review

- **Spec coverage:** ingest_archive (T1–T4), list_folder_contents (T5–T6). ✓
- **In-memory testability:** blob validation/decoding/meta/path are pure and tested without Axum or multipart; CAS-write tested with a real `ContentStore` over a tempdir. ✓
- **Behavior guard:** the 8 existing `tests/archive_test.rs` tests must stay green through the `ingest_archive` refactor (T4 step 4). ✓
- **Type consistency:** `decode_and_verify_blobs -> Vec<(String, Vec<u8>, String)>` is consumed by `store_decoded_blobs(&[(String, Vec<u8>, String)])`; `classify_dir_entries -> (Vec<FolderInfo>, Vec<(String, VaultPath)>)` matches the handler's `md_children` shape. ✓
