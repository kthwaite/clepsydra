# Sync Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the vault safe for external git merges and make the CAS metadata DB fully derivable — the prerequisites for `clep sync` (phase 1 of 4).

**Architecture:** Three independent strands. (1) A conflict-marker guard: `parse_or_repair_frontmatter` never rewrites a file containing git merge markers, and doctor reports such files. (2) `[archive] blobs` frontmatter entries become `{hash, type}` tables (readers accept both shapes), with a `clep cas backfill` sweep for existing pages. (3) A vault scan that recounts CAS references + types, powering `clep cas rebuild` (recreate `cas.db` rows) and a doctor `--full` CAS verify.

**Tech Stack:** Rust 2024, rusqlite, walkdir, toml, clap 4 derive. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-clep-sync-design.md` (§6 conflict guard, §7 CAS). ADRs: `docs/adr/0004`, `docs/adr/0005`.

## Global Constraints

- Branch `feature/sync-prereqs` off `develop`, worktree under `.worktrees/sync-prereqs`.
- Fresh worktree: `cargo test` needs `ui/dist` (rust-embed). Run `cd ui && bun i && bun run build` once before the first cargo command. Never pipe cargo output through anything that hides failures.
- develop is NOT fmt/lint clean. Never run repo-wide `cargo fmt` or `biome check --write`. Format only files you created/edited (`rustfmt <file>`).
- Doctor checks are read-only and never open `cas.db` via `ContentStore` (raw rusqlite `SQLITE_OPEN_READ_ONLY` only, see `check_cas` `src/doctor.rs:1114`).
- New CLI subcommands must be documented in `ui/src/docs/content/cli.mdx` with a `## \`clep cas\`` heading per command level — `tests/docs_cli_coverage_test.rs` enforces exact headings.
- Single test file: `cargo test --test <name>`. Unit tests: `cargo test --lib <module>::`.
- Conservative direction everywhere: over-count CAS refs rather than under-count; never rewrite a file the parser could not fully read.

---

### Task 1: Conflict-marker detection module

**Files:**
- Create: `src/vault/conflict.rs`
- Modify: `src/vault/mod.rs` (add `pub mod conflict;` beside the existing `pub mod` list)

**Interfaces:**
- Produces: `pub fn has_conflict_markers(content: &str) -> bool`; `pub fn conflicted_pages(vault: &Vault) -> Vec<VaultPath>` (sorted). Tasks 2 and 3 consume both.

- [ ] **Step 1: Write the failing tests** (in-module `#[cfg(test)]`, model: `src/vault/migrate.rs:116`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_three_markers_detected() {
        let content = "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> theirs\n";
        assert!(has_conflict_markers(content));
    }

    #[test]
    fn two_markers_not_enough() {
        assert!(!has_conflict_markers("<<<<<<< HEAD\na\n=======\nb\n"));
        assert!(!has_conflict_markers("=======\n>>>>>>> theirs\n"));
    }

    #[test]
    fn plain_page_clean() {
        assert!(!has_conflict_markers("+++\ntitle = \"x\"\n+++\nSeven = signs ==== here\n"));
    }

    #[test]
    fn markers_inside_code_block_still_flag() {
        // Documented benign false positive (ADR 0004): flagging costs only
        // "no auto-repair + diagnostic".
        let content = "+++\ntitle = \"git notes\"\n+++\n```\n<<<<<<< HEAD\n=======\n>>>>>>> x\n```\n";
        assert!(has_conflict_markers(content));
    }

    #[test]
    fn conflicted_pages_sweeps_and_sorts() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/b.md"), "<<<<<<< HEAD\n=======\n>>>>>>> x\n").unwrap();
        std::fs::write(root.join("notes/a.md"), "<<<<<<< HEAD\n=======\n>>>>>>> x\n").unwrap();
        std::fs::write(root.join("notes/clean.md"), "+++\ntitle = \"ok\"\n+++\nfine\n").unwrap();
        std::fs::write(root.join(".clepsydra/skip.md"), "<<<<<<< HEAD\n=======\n>>>>>>> x\n").unwrap();
        let vault = Vault::open(&root).unwrap();
        let paths: Vec<String> = conflicted_pages(&vault).iter().map(|p| p.as_str().to_string()).collect();
        assert_eq!(paths, vec!["notes/a.md", "notes/b.md"]);
    }
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test --lib conflict::` → FAIL (module unresolved).

- [ ] **Step 3: Implement**

```rust
//! Merge-conflict detection for vault files.
//!
//! A file containing all three git conflict-marker lines is *conflicted*:
//! the indexer must never repair or rewrite it (docs/adr/0004).

use super::{Vault, path::VaultPath};
use walkdir::WalkDir;

/// True when `content` holds all three git merge-conflict marker lines:
/// a line starting `<<<<<<< `, a bare `=======` line, and a line starting
/// `>>>>>>> `.
pub fn has_conflict_markers(content: &str) -> bool {
    let (mut ours, mut sep, mut theirs) = (false, false, false);
    for line in content.lines() {
        ours |= line.starts_with("<<<<<<< ");
        sep |= line == "=======";
        theirs |= line.starts_with(">>>>>>> ");
        if ours && sep && theirs {
            return true;
        }
    }
    false
}

/// Sweep the vault for markdown files containing conflict markers.
/// Mirrors `migrate::legacy_pages` (src/vault/migrate.rs:27): skips
/// `.clepsydra/` and excluded paths, sorts by path. Read-only.
pub fn conflicted_pages(vault: &Vault) -> Vec<VaultPath> {
    let mut out = Vec::new();
    for entry in WalkDir::new(vault.root()).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "md") {
            continue;
        }
        let Ok(rel) = path.strip_prefix(vault.root()) else { continue };
        let rel_str = rel.to_string_lossy();
        if rel_str.starts_with(".clepsydra/") {
            continue;
        }
        let Ok(vault_path) = VaultPath::new(&rel_str) else { continue };
        if vault.is_excluded(&vault_path) {
            continue;
        }
        if std::fs::read_to_string(path).is_ok_and(|c| has_conflict_markers(&c)) {
            out.push(vault_path);
        }
    }
    out.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    out
}
```

Copy `legacy_pages`'s exact exclusion idioms if they differ (`src/vault/migrate.rs:27-56`) — behavior must match it.

- [ ] **Step 4: Run to verify pass** — `cargo test --lib conflict::` → all PASS.
- [ ] **Step 5: Commit** — `git add src/vault/conflict.rs src/vault/mod.rs && git commit -m "feat(vault): conflict-marker detection module"`

---

### Task 2: Indexer conflict guard in `parse_or_repair_frontmatter`

**Files:**
- Modify: `src/vault/page.rs:426-481` (wrap the existing function)
- Test: `tests/frontmatter_test.rs` (unit-level), `tests/index_test.rs` (integration)

**Interfaces:**
- Consumes: `conflict::has_conflict_markers` (Task 1).
- Produces: unchanged signature `pub fn parse_or_repair_frontmatter(&str) -> (PageMeta, String, bool, Option<String>)`, with the new invariant: conflicted content always returns `rewrote = false` and `Some(warning)` containing `"merge conflict markers"`. Both index paths (`index.rs:905`, `index.rs:2281`) and `resolve_duplicate_uuids` are already gated on the `rewrote` flag / `repair_frontmatter`, so no index.rs change is needed.

- [ ] **Step 1: Write the failing tests** (append to `tests/frontmatter_test.rs`, matching its existing imports)

```rust
#[test]
fn conflicted_add_add_file_is_never_rewritten() {
    // The empirically destructive case: markers before the opening fence.
    let content = "<<<<<<< HEAD\n+++\nid = \"01900000-0000-7000-8000-00000000cccc\"\ntitle = \"Ours\"\n+++\nours body\n=======\n+++\nid = \"01900000-0000-7000-8000-00000000dddd\"\ntitle = \"Theirs\"\n+++\ntheirs body\n>>>>>>> theirs\n";
    let (_meta, body, rewrote, warning) = parse_or_repair_frontmatter(content);
    assert!(!rewrote, "conflicted file must never be marked for rewrite");
    assert!(warning.unwrap().contains("merge conflict markers"));
    assert_eq!(body, content, "whole conflicted file indexed as body");
}

#[test]
fn conflicted_valid_frontmatter_keeps_metadata_without_rewrite() {
    let content = "+++\nid = \"01900000-0000-7000-8000-0000000000aa\"\ntitle = \"Fine\"\ncreated_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\n+++\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> x\n";
    let (meta, _body, rewrote, warning) = parse_or_repair_frontmatter(content);
    assert_eq!(meta.title.as_deref(), Some("Fine"));
    assert!(!rewrote);
    assert!(warning.unwrap().contains("merge conflict markers"));
}

#[test]
fn conflicted_missing_id_is_not_repaired_on_disk() {
    let content = "+++\ntitle = \"No id\"\n+++\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n";
    let (_meta, _body, rewrote, _warning) = parse_or_repair_frontmatter(content);
    assert!(!rewrote, "id minting must stay in memory for conflicted files");
}
```

Integration (append to `tests/index_test.rs`, using its `setup_vault` helper at `tests/index_test.rs:17`):

```rust
#[test]
fn conflicted_file_survives_index_build_byte_identical() {
    let conflicted = "<<<<<<< HEAD\n+++\ntitle = \"Ours\"\n+++\nours\n=======\n+++\ntitle = \"Theirs\"\n+++\ntheirs\n>>>>>>> theirs\n";
    let (tmp, vault) = setup_vault(&[("notes/clash.md", conflicted)]);
    let mut index = VaultIndex::open(&tmp.path().join("cache.db")).unwrap();
    index.build(&vault).unwrap();
    let on_disk = std::fs::read_to_string(vault.root().join("notes/clash.md")).unwrap();
    assert_eq!(on_disk, conflicted, "index build must not rewrite a conflicted file");
}
```

- [ ] **Step 2: Verify failure** — `cargo test --test frontmatter_test conflicted` → the add/add and missing-id tests FAIL (today `rewrote = true`). `cargo test --test index_test conflicted_file_survives` → FAIL (file rewritten with fresh frontmatter).

- [ ] **Step 3: Implement** — in `src/vault/page.rs`: rename the existing `parse_or_repair_frontmatter` to `fn parse_or_repair_frontmatter_inner` (private), add the wrapper:

```rust
pub fn parse_or_repair_frontmatter(content: &str) -> (PageMeta, String, bool, Option<String>) {
    if crate::vault::conflict::has_conflict_markers(content) {
        let (meta, body, _rewrote, inner) = parse_or_repair_frontmatter_inner(content);
        const NOTE: &str =
            "contains merge conflict markers; indexing read-only (file not modified)";
        let warning = match inner {
            Some(w) => format!("{NOTE}; {w}"),
            None => NOTE.to_string(),
        };
        return (meta, body, false, Some(warning));
    }
    parse_or_repair_frontmatter_inner(content)
}
```

Keep the doc comment on the public wrapper; extend it with one line: "Content containing git merge conflict markers is never marked for rewrite (docs/adr/0004)."

- [ ] **Step 4: Verify pass** — `cargo test --test frontmatter_test && cargo test --test index_test` → PASS (whole files: guard must not break existing repair tests).
- [ ] **Step 5: Commit** — `git commit -am "feat(vault): never repair files containing merge conflict markers"`

---

### Task 3: Doctor check for conflicted files

**Files:**
- Modify: `src/doctor.rs` (new `fn check_conflicts` + one registration call in `run_with_cwd`, `src/doctor.rs:202-270`, after `check_frontmatter`)

**Interfaces:**
- Consumes: `conflict::conflicted_pages` (Task 1); doctor helpers `ok/warn` (`src/doctor.rs:297-311`), `CheckResult::with_hint`, `Report::push`.
- Produces: report section `"conflicts"`, check name `"markers"`.

- [ ] **Step 1: Write the failing test** — doctor tests follow the vault-in-tempdir style; add to `src/doctor.rs`'s `#[cfg(test)]` module (create one if absent, using `tempfile::TempDir` — fine in tests, the runtime-only `TempDirGuard` rule does not apply):

```rust
#[test]
fn conflicts_check_warns_and_lists_files() {
    let tmp = tempfile::TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    crate::vault::init::init_vault(&root).unwrap();
    std::fs::create_dir_all(root.join("notes")).unwrap();
    std::fs::write(root.join("notes/clash.md"), "<<<<<<< HEAD\n=======\n>>>>>>> x\n").unwrap();
    let vault = crate::vault::Vault::open(&root).unwrap();
    let mut report = Report::default();
    check_conflicts(&vault, &mut report);
    let result = report.results.iter().find(|r| r.section == "conflicts").unwrap();
    assert!(matches!(result.status, Status::Warn));
    assert!(result.detail.contains("notes/clash.md"));
}

#[test]
fn conflicts_check_ok_when_clean() {
    let tmp = tempfile::TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    crate::vault::init::init_vault(&root).unwrap();
    let vault = crate::vault::Vault::open(&root).unwrap();
    let mut report = Report::default();
    check_conflicts(&vault, &mut report);
    assert!(matches!(report.results[0].status, Status::Ok));
}
```

(If `Report` lacks `Default`, construct it the way existing doctor tests do — mirror the file's own test idiom.)

- [ ] **Step 2: Verify failure** — `cargo test --lib doctor::` (or the module path the file uses) → FAIL: `check_conflicts` not found.

- [ ] **Step 3: Implement** (model: `check_frontmatter`, `src/doctor.rs:1458-1484`)

```rust
/// Report vault files containing git merge conflict markers. Such files are
/// indexed read-only and never repaired (docs/adr/0004).
fn check_conflicts(vault: &Vault, report: &mut Report) {
    const SECTION: &str = "conflicts";
    const LISTED: usize = 10;
    let conflicted = crate::vault::conflict::conflicted_pages(vault);
    if conflicted.is_empty() {
        report.push(ok(SECTION, "markers", "no files contain merge conflict markers"));
        return;
    }
    let mut detail = format!("{} file(s) contain merge conflict markers", conflicted.len());
    for path in conflicted.iter().take(LISTED) {
        detail.push_str(&format!("\n  {}", path.as_str()));
    }
    if conflicted.len() > LISTED {
        detail.push_str(&format!("\n  … and {} more", conflicted.len() - LISTED));
    }
    report.push(
        warn(SECTION, "markers", detail).with_hint(
            "resolve the merge conflicts by hand; conflicted files are indexed read-only and never auto-repaired",
        ),
    );
}
```

Register in `run_with_cwd` inside the `if let Some(v) = vault.as_ref()` block, directly after `check_frontmatter(v, &mut report);`: `check_conflicts(v, &mut report);`

Then extend the same function with the spec §6 unparseable-frontmatter surfacing (currently a tracing-only warning, `index.rs:897-899`): after the markers check, sweep the same file list source — add `pub fn unparseable_pages(vault: &Vault) -> Vec<(VaultPath, String)>` to `src/vault/conflict.rs` (same walk as `conflicted_pages`; for each file run `parse_or_repair_frontmatter` and collect `(path, warning)` when the warning is `Some` and the file is NOT already in the conflicted set — conflicted files are reported by the markers check). Emit `warn("conflicts", "unparseable", <count + ≤10 listed "path: warning" lines>)` with hint `"these pages are indexed with default metadata; fix the frontmatter by hand"`, or `ok("conflicts", "unparseable", "all frontmatter parseable")`. Add one test: a page with `+++` fences holding invalid TOML (no conflict markers) yields the `unparseable` Warn naming the file; the clean-vault test asserts both checks are `Ok`.

- [ ] **Step 4: Verify pass** — the two new tests PASS; `cargo test --lib` stays green.
- [ ] **Step 5: Commit** — `git commit -am "feat(doctor): conflicts section reporting merge-marker files"`

---

### Task 4: Typed `[archive] blobs` entries (`{hash, type}`)

**Files:**
- Modify: `src/api/archive.rs` (`ArchiveHashes` `:753-761`, `build_archive_meta` `:763-816`, hash collection `:1367-1394`, unit test `:1920-1934`)
- Modify: `src/vault/archive_hook.rs:14-33` (`captured_archive_hashes` accepts both shapes; new `captured_blob_types`)
- Modify: `src/api/pages.rs:87-113` (`ArchiveMetaResponse`), `src/api/openapi.rs:607,671-677` (contract tests)
- Test: `tests/archive_test.rs` (mixed-shape hook coverage)

**Interfaces:**
- Produces: TOML shape `blobs = [{ hash = "sha256:…", type = "image/png" }, …]` for new captures; readers tolerate legacy plain-string entries indefinitely. `pub(crate) fn captured_blob_types(meta: &PageMeta) -> BTreeMap<String, String>` in `archive_hook.rs` (hash → type from table-shaped entries only; snapshot_hash is NOT included). Tasks 5 and 6 consume both readers.

- [ ] **Step 1: Write the failing tests.** Replace the body expectations of `build_archive_meta_lists_only_resource_blobs` (`src/api/archive.rs:1920`) to require table entries:

```rust
    let archive = meta.extra.get("archive").and_then(|v| v.as_table()).unwrap();
    let blobs = archive.get("blobs").and_then(|v| v.as_array()).unwrap();
    let entry = blobs[0].as_table().unwrap();
    assert_eq!(entry.get("hash").and_then(|v| v.as_str()), Some("sha256:aaaa…full-hex…"));
    assert_eq!(entry.get("type").and_then(|v| v.as_str()), Some("image/png"));
```

Add to `src/vault/archive_hook.rs` tests (or `tests/archive_test.rs` if hook tests live there — follow where `captured_archive_hashes` is currently tested):

```rust
#[test]
fn captured_archive_hashes_accepts_string_and_table_blobs() {
    let mut meta = PageMeta::new();
    let mut archive = toml::Table::new();
    archive.insert("snapshot_hash".into(), toml::Value::String("sha256:1111".into()));
    let mut typed = toml::Table::new();
    typed.insert("hash".into(), toml::Value::String("sha256:2222".into()));
    typed.insert("type".into(), toml::Value::String("image/png".into()));
    archive.insert("blobs".into(), toml::Value::Array(vec![
        toml::Value::String("sha256:3333".into()),
        toml::Value::Table(typed),
    ]));
    meta.extra.insert("archive".into(), toml::Value::Table(archive));
    let hashes = captured_archive_hashes(&meta);
    assert!(hashes.contains("sha256:1111") && hashes.contains("sha256:2222") && hashes.contains("sha256:3333"));
    let types = captured_blob_types(&meta);
    assert_eq!(types.get("sha256:2222").map(String::as_str), Some("image/png"));
    assert!(!types.contains_key("sha256:3333"));
}
```

- [ ] **Step 2: Verify failure** — `cargo test --lib` + `cargo test --test archive_test` → new/changed tests FAIL.

- [ ] **Step 3: Implement.**

`src/api/archive.rs`: change `ArchiveHashes.resource_hashes: Vec<String>` → `resources: Vec<(String, String)>` (hash, content type). At the collection site (`:1367-1382`) capture `(hash, resource.content_type.clone())` before bytes are moved into `to_store`. `resource_count` uses `hashes.resources.len()`. In `build_archive_meta` (`:805-811`):

```rust
    if !hashes.resources.is_empty() {
        let blobs: Vec<toml::Value> = hashes
            .resources
            .iter()
            .map(|(hash, content_type)| {
                let mut entry = toml::Table::new();
                entry.insert("hash".into(), toml::Value::String(hash.clone()));
                entry.insert("type".into(), toml::Value::String(content_type.clone()));
                toml::Value::Table(entry)
            })
            .collect();
        archive_map.insert("blobs".into(), toml::Value::Array(blobs));
    }
```

`src/vault/archive_hook.rs` — extend the blobs loop and add the types reader:

```rust
    if let Some(toml::Value::Array(blob_entries)) = archive.get("blobs") {
        for value in blob_entries {
            match value {
                toml::Value::String(hash) => {
                    hashes.insert(hash.clone());
                }
                toml::Value::Table(entry) => {
                    if let Some(toml::Value::String(hash)) = entry.get("hash") {
                        hashes.insert(hash.clone());
                    }
                }
                _ => {}
            }
        }
    }
```

```rust
/// Hash → declared content type, from table-shaped `[archive] blobs` entries.
/// Legacy string entries carry no type and are absent from the map.
pub(crate) fn captured_blob_types(meta: &PageMeta) -> BTreeMap<String, String> {
    let Some(toml::Value::Table(archive)) = meta.extra.get("archive") else {
        return BTreeMap::new();
    };
    let mut types = BTreeMap::new();
    if let Some(toml::Value::Array(blob_entries)) = archive.get("blobs") {
        for value in blob_entries {
            if let toml::Value::Table(entry) = value
                && let (Some(toml::Value::String(hash)), Some(toml::Value::String(ct))) =
                    (entry.get("hash"), entry.get("type"))
            {
                types.insert(hash.clone(), ct.clone());
            }
        }
    }
    types
}
```

`src/api/pages.rs`: replace `pub blobs: Option<Vec<String>>` with a doc struct:

```rust
/// One captured archive resource: CAS hash plus its declared content type.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ArchiveBlobResponse {
    pub hash: String,
    #[serde(rename = "type")]
    pub content_type: String,
}
```
and `pub blobs: Option<Vec<ArchiveBlobResponse>>`. Register `ArchiveBlobResponse` wherever `ArchiveMetaResponse` is registered in the utoipa components list (search `openapi.rs` for `ArchiveMetaResponse` and add the new type beside it). Update `src/api/openapi.rs:607,671-677` contract assertions to the object shape (legacy string entries persist in un-backfilled pages until Task 5's sweep runs — acceptable interim per spec §7). Update `tests/archive_test.rs:92,139,198`: convert ONE fixture to table shape, deliberately KEEP one string-shape fixture as legacy-reader regression coverage, with a comment saying so.

- [ ] **Step 4: Verify pass** — `cargo test --test archive_test && cargo test --test openapi_contract && cargo test --lib` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(archive): typed blobs entries {hash, type} in [archive] frontmatter"`

---

### Task 5: `clep cas backfill` — type existing pages' blobs from cas.db

**Files:**
- Create: `src/vault/archive_backfill.rs`
- Modify: `src/vault/mod.rs` (`pub mod archive_backfill;`)
- Modify: `src/bin/cli.rs` (new `Cas { command: CasCommands }` variant + `CasCommands::Backfill { write: bool }` + dispatch arm; model: `Config`/`Migrate` arms, `src/bin/cli.rs:313,422-455`)
- Modify: `ui/src/docs/content/cli.mdx` (add `## \`clep cas\``, `## \`clep cas backfill\`` sections)

**Interfaces:**
- Consumes: `captured_blob_types` / mixed-shape reading (Task 4); `parse_or_repair_frontmatter` (known 4-tuple); `write_page_content` (`page.rs:499`); `atomic_replace` (`atomic_file.rs:350`); read-only rusqlite over `cas.db`.
- Produces: `pub struct BackfillReport { pub updated: Vec<String>, pub warnings: Vec<String>, pub dry_run: bool }`; `pub fn backfill(vault: &Vault, cas_db: &Path, write: bool) -> BackfillReport`. CLI resolves the CAS path exactly like `src/lib.rs:702` (config `archive.cas_path`, tilde-expanded).

- [ ] **Step 1: Write the failing tests** (in-module, model `migrate.rs:116` `make_vault`; build a real `cas.db` fixture with raw rusqlite):

```rust
    fn make_cas_db(dir: &std::path::Path, rows: &[(&str, &str)]) -> std::path::PathBuf {
        let db = dir.join("cas.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, \
             content_type TEXT NOT NULL, created_at TEXT NOT NULL, ref_count INTEGER NOT NULL DEFAULT 1);",
        ).unwrap();
        for (hash, ct) in rows {
            conn.execute(
                "INSERT INTO blobs (hash, size, content_type, created_at) VALUES (?1, 1, ?2, '2026-01-01T00:00:00Z')",
                rusqlite::params![hash, ct],
            ).unwrap();
        }
        db
    }

    const H1: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const H2: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn legacy_archive_page(blob_lines: &str) -> String {
        format!(
            "+++\nid = \"01900000-0000-7000-8000-000000000001\"\ntitle = \"A\"\n\
             created_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\n\
             [archive]\nurl = \"https://x\"\ndomain = \"x\"\ncaptured_at = \"2026-01-01T00:00:00Z\"\n\
             snapshot_hash = \"{H1}\"\nblobs = [{blob_lines}]\n+++\nbody\n"
        )
    }

    #[test]
    fn dry_run_reports_and_writes_nothing() {
        let (tmp, vault) = make_vault(&[("archive/x/a.md", &legacy_archive_page(&format!("\"{H2}\"")))]);
        let db = make_cas_db(tmp.path(), &[(H2, "image/png")]);
        let before = std::fs::read_to_string(vault.root().join("archive/x/a.md")).unwrap();
        let report = backfill(&vault, &db, false);
        assert!(report.dry_run);
        assert_eq!(report.updated, vec!["archive/x/a.md"]);
        assert_eq!(std::fs::read_to_string(vault.root().join("archive/x/a.md")).unwrap(), before);
    }

    #[test]
    fn write_replaces_string_entries_with_typed_tables() {
        let (_tmp, vault) = make_vault(&[("archive/x/a.md", &legacy_archive_page(&format!("\"{H2}\"")))]);
        let db = make_cas_db(_tmp.path(), &[(H2, "image/png")]);
        let report = backfill(&vault, &db, true);
        assert_eq!(report.updated, vec!["archive/x/a.md"]);
        let after = std::fs::read_to_string(vault.root().join("archive/x/a.md")).unwrap();
        let (meta, _, _, w) = crate::vault::page::parse_or_repair_frontmatter(&after);
        assert!(w.is_none());
        let types = crate::vault::archive_hook::captured_blob_types(&meta);
        assert_eq!(types.get(H2).map(String::as_str), Some("image/png"));
    }

    #[test]
    fn unknown_hash_kept_as_string_with_warning() {
        let (_tmp, vault) = make_vault(&[("archive/x/a.md", &legacy_archive_page(&format!("\"{H2}\"")))]);
        let db = make_cas_db(_tmp.path(), &[]); // H2 absent
        let report = backfill(&vault, &db, true);
        assert!(report.updated.is_empty());
        assert_eq!(report.warnings.len(), 1);
    }

    #[test]
    fn already_typed_page_skipped() {
        let typed = format!("{{ hash = \"{H2}\", type = \"image/png\" }}");
        let (_tmp, vault) = make_vault(&[("archive/x/a.md", &legacy_archive_page(&typed))]);
        let db = make_cas_db(_tmp.path(), &[(H2, "image/png")]);
        let report = backfill(&vault, &db, true);
        assert!(report.updated.is_empty() && report.warnings.is_empty());
    }
```

- [ ] **Step 2: Verify failure** — `cargo test --lib archive_backfill::` → FAIL (module unresolved).

- [ ] **Step 3: Implement.** Sweep shape copied from `migrate::migrate` (`migrate.rs:64-113`) including the injected-publication seam:

```rust
//! One-time backfill: replace legacy string entries in `[archive] blobs`
//! with `{hash, type}` tables, types looked up in the CAS metadata DB
//! (docs/adr/0005). Dry run by default.

pub fn backfill(vault: &Vault, cas_db: &Path, write: bool) -> BackfillReport {
    backfill_with_publication(vault, cas_db, write, crate::vault::atomic_file::atomic_replace)
}
```

Inner fn: open `cas_db` with `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_URI` (doctor idiom, `doctor.rs:1160`); on open failure return a report with one warning. Walk pages like `conflicted_pages` (Task 1). Per page: read; skip silently unless the content contains `[archive]`; `parse_or_repair_frontmatter`; on `Some(warning)` push warning and `continue` (never rewrite what wasn't fully read); get `archive` table from `meta.extra`; get `blobs` array; partition entries — for each `toml::Value::String(hash)`: `SELECT content_type FROM blobs WHERE hash = ?1` — found → build `{hash, type}` table entry; missing → keep the string entry and push warning `"{path}: no content_type in cas.db for {hash}"`. If no entry changed → skip (not listed). Else replace the array in a cloned meta, `write_page_content`, publish when `write`, push path to `updated`. Never touch `.clepsydra/rubbish/` (readers tolerate legacy shape there forever — spec §7).

CLI: add to `Commands`:

```rust
    #[command(about = "CAS maintenance", long_about = "Maintain the content-addressed store: backfill typed blob metadata into archive pages, or rebuild the derived cas.db from the vault.")]
    Cas {
        #[command(subcommand)]
        command: CasCommands,
    },
```

```rust
#[derive(Debug, Subcommand)]
enum CasCommands {
    #[command(about = "Fill {hash, type} blob entries in archive pages from cas.db")]
    Backfill {
        /// Apply changes (default is a dry run).
        #[arg(long)]
        write: bool,
    },
}
```

Dispatch arm mirrors `Commands::Migrate` (`cli.rs:422-455`): `Settings::load` → `resolve_vault_root` → `Vault::open` → resolve CAS path from `vault.config().archive.cas_path` with the same tilde expansion `lib.rs:702` uses → print per-page lines and the summary; exit 0, or 1 when warnings exist. Add a `Cli::try_parse_from` unit test in `cli_tests` asserting the parsed variant (idiom at `cli.rs:572`). Document in `ui/src/docs/content/cli.mdx` with exact headings `## \`clep cas\`` and `## \`clep cas backfill\`` (coverage test `tests/docs_cli_coverage_test.rs:90` enforces).

- [ ] **Step 4: Verify pass** — `cargo test --lib archive_backfill:: && cargo test --test docs_cli_coverage_test && cargo test --lib cli_tests::` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(cas): clep cas backfill types archive blobs from cas.db"`

---

### Task 6: Vault-wide CAS reference scan

**Files:**
- Create: `src/vault/cas_scan.rs`
- Modify: `src/vault/mod.rs` (`pub mod cas_scan;`)

**Interfaces:**
- Consumes: `captured_archive_hashes`, `captured_blob_types` (Task 4) — make both `pub(crate)` if not already; `parse_or_repair_frontmatter`.
- Produces:

```rust
#[derive(Debug, Default)]
pub struct ArchiveRefScan {
    /// hash → reference count (live pages + rubbish items; one per page per unique hash).
    pub refs: std::collections::BTreeMap<String, u32>,
    /// hash → content type (from typed blob entries; snapshot hashes map to "text/html").
    pub types: std::collections::BTreeMap<String, String>,
    pub warnings: Vec<String>,
}
pub fn scan_archive_refs(vault: &Vault) -> ArchiveRefScan
```

(`Default` is required — Task 7's tests construct `ArchiveRefScan::default()`.)

Tasks 7 and 8 consume this. Counting rule (verified against `ArchiveDeleteHook` semantics): each live page contributes +1 per unique captured hash; each rubbish item directory `.clepsydra/rubbish/<uuid>/page.md` contributes +1 per unique hash — ALL rubbish items count, including any with a pending purge (over-count is the safe direction; a purge retry decrements exactly once).

- [ ] **Step 1: Write the failing tests** (in-module; `make_vault` idiom):

```rust
    const H1: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const H2: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn archive_page(blob_entry: &str) -> String {
        format!(
            "+++\nid = \"01900000-0000-7000-8000-000000000001\"\ntitle = \"A\"\n\
             created_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\n\
             [archive]\nurl = \"https://x\"\ndomain = \"x\"\ncaptured_at = \"2026-01-01T00:00:00Z\"\n\
             snapshot_hash = \"{H1}\"\nblobs = [{blob_entry}]\n+++\nbody\n"
        )
    }

    #[test]
    fn counts_live_pages_rubbish_and_snapshot_types() {
        let page_a = archive_page(&format!("{{ hash = \"{H2}\", type = \"image/png\" }}"));
        let page_b = archive_page(&format!("\"{H2}\"")); // legacy string entry
        let (tmp, vault) = make_vault(&[("archive/x/a.md", &page_a)]);
        // rubbish item holding page_b:
        let item = vault.root().join(".clepsydra/rubbish/0190aaaa-0000-7000-8000-000000000001");
        std::fs::create_dir_all(&item).unwrap();
        std::fs::write(item.join("page.md"), &page_b).unwrap();
        std::fs::write(item.join("manifest.json"), "{}").unwrap();
        let scan = scan_archive_refs(&vault);
        assert_eq!(scan.refs.get(H1), Some(&2));            // both pages capture the snapshot
        assert_eq!(scan.refs.get(H2), Some(&2));
        assert_eq!(scan.types.get(H1).map(String::as_str), Some("text/html")); // snapshot
        assert_eq!(scan.types.get(H2).map(String::as_str), Some("image/png")); // typed entry wins
        assert!(scan.warnings.is_empty());
    }

    #[test]
    fn purge_tombstone_dirs_are_ignored() {
        let (_tmp, vault) = make_vault(&[]);
        let tomb = vault.root().join(".clepsydra/rubbish/.purge-0190aaaa-0000-7000-8000-000000000002");
        std::fs::create_dir_all(&tomb).unwrap();
        let scan = scan_archive_refs(&vault);
        assert!(scan.refs.is_empty());
    }

    #[test]
    fn unreadable_rubbish_page_warns_not_panics() {
        let (_tmp, vault) = make_vault(&[]);
        let item = vault.root().join(".clepsydra/rubbish/0190aaaa-0000-7000-8000-000000000003");
        std::fs::create_dir_all(&item).unwrap(); // no page.md
        let scan = scan_archive_refs(&vault);
        assert_eq!(scan.warnings.len(), 1);
    }
```

(The `tmp` binding in the first test is used: rubbish paths derive from `vault.root()`, but keep `tmp` alive for the test duration — name it `_tmp` only where genuinely unused.)

- [ ] **Step 2: Verify failure** — `cargo test --lib cas_scan::` → FAIL.

- [ ] **Step 3: Implement.** Live pages: walk like Task 1's sweep; cheap pre-filter `content.contains("[archive]")`; parse with `parse_or_repair_frontmatter`, USE the meta even when a warning was returned (an unparseable page yields default meta and contributes nothing — record the warning; never skip silently: under-counting is the unsafe direction). Per page: `let hashes = captured_archive_hashes(&meta);` → `*refs.entry(h).or_insert(0) += 1` each; merge `captured_blob_types(&meta)` into `types` (first writer wins); if `snapshot_hash` present, `types.entry(snapshot).or_insert_with(|| "text/html".into())`. Rubbish: `read_dir(root/.clepsydra/rubbish)`, skip names starting `.` (covers `.purge-*`), read `<dir>/page.md` (missing → warning), same per-page logic. No index, no `ContentStore` — pure filesystem reads.

- [ ] **Step 4: Verify pass** — `cargo test --lib cas_scan::` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(cas): vault-wide archive reference scan (refs + types)"`

---

### Task 7: `clep cas rebuild` — recreate cas.db rows from disk truth

**Files:**
- Modify: `src/vault/cas.rs` (new `rebuild_metadata` + a fan-out walker; both live here for access to the private `blob_path`/`validate_hash`/lock)
- Modify: `src/bin/cli.rs` (`CasCommands::Rebuild { write: bool }` + dispatch)
- Modify: `ui/src/docs/content/cli.mdx` (`## \`clep cas rebuild\``)

**Interfaces:**
- Consumes: `ArchiveRefScan` (Task 6); `ContentStore::open` (`cas.rs:694`), exclusive lock (`cas.rs:843`).
- Produces:

```rust
pub struct RebuildReport {
    pub rows_written: u64,
    pub unreferenced_blobs: u64,      // ref_count 0 rows written (GC-eligible later)
    pub untyped_blobs: Vec<String>,   // fell back to application/octet-stream
    pub missing_files: Vec<String>,   // referenced hash with no blob file
    pub dry_run: bool,
}
impl ContentStore {
    pub fn rebuild_metadata(&self, scan: &ArchiveRefScan, write: bool) -> Result<RebuildReport, Box<dyn std::error::Error>>
}
```

- [ ] **Step 1: Write the failing tests** (in `cas.rs`'s existing `#[cfg(test)]` module, which already uses `tempfile::TempDir` — `cas.rs:1538+`):

```rust
    #[test]
    fn rebuild_recreates_rows_from_files_and_scan() {
        let tmp = TempDir::new().unwrap();
        let store = ContentStore::open(tmp.path()).unwrap();
        let stored = store.store(b"png-bytes", "image/png").unwrap();
        let snap = store.store(b"<html>", "text/html").unwrap();
        // Corrupt the derived state: wrong types, wrong refs.
        store.database().execute("UPDATE blobs SET content_type = 'wrong/type', ref_count = 9", []).unwrap();
        let mut scan = ArchiveRefScan::default();
        scan.refs.insert(stored.hash.clone(), 2);
        scan.refs.insert(snap.hash.clone(), 1);
        scan.types.insert(stored.hash.clone(), "image/png".into());
        scan.types.insert(snap.hash.clone(), "text/html".into());
        let report = store.rebuild_metadata(&scan, true).unwrap();
        assert_eq!(report.rows_written, 2);
        let (_, ct) = store.retrieve(&stored.hash).unwrap();
        assert_eq!(ct, "image/png");
        assert_eq!(store.ref_count(&stored.hash).unwrap(), 2);
        assert_eq!(store.ref_count(&snap.hash).unwrap(), 1);
    }

    #[test]
    fn rebuild_flags_unreferenced_untyped_and_missing() {
        let tmp = TempDir::new().unwrap();
        let store = ContentStore::open(tmp.path()).unwrap();
        let orphan = store.store(b"orphan", "application/pdf").unwrap();
        let mut scan = ArchiveRefScan::default();
        let ghost = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        scan.refs.insert(ghost.into(), 1);
        let report = store.rebuild_metadata(&scan, true).unwrap();
        assert_eq!(report.unreferenced_blobs, 1);              // orphan file kept, ref_count 0
        assert_eq!(report.untyped_blobs, vec![orphan.hash.clone()]);
        assert_eq!(report.missing_files, vec![ghost.to_string()]);
        assert_eq!(store.ref_count(&orphan.hash).unwrap(), 0);
    }

    #[test]
    fn rebuild_dry_run_changes_nothing() {
        let tmp = TempDir::new().unwrap();
        let store = ContentStore::open(tmp.path()).unwrap();
        let stored = store.store(b"x", "image/png").unwrap();
        let report = store.rebuild_metadata(&ArchiveRefScan::default(), false).unwrap();
        assert!(report.dry_run);
        assert_eq!(store.ref_count(&stored.hash).unwrap(), 1);
    }
```

(`ArchiveRefScan` needs `#[derive(Default)]` — add it in Task 6's struct if forgotten. `store.database()` is private but tests are in-module. `ref_count` is `#[cfg(test)]` — already available.)

- [ ] **Step 2: Verify failure** — `cargo test --lib cas::rebuild` → FAIL.

- [ ] **Step 3: Implement.** Inside `impl ContentStore`. Take `acquire_exclusive_lock`. Walk the fan-out: `read_dir(&self.root)`, keep dirs whose name is 2 lowercase-hex chars; within, keep files whose name is 64 lowercase-hex chars starting with the dir prefix; hash = `format!("sha256:{name}")`, size from `metadata().len()`. Sizes come from files; types: `scan.types.get(hash)` else `"application/octet-stream"` + push to `untyped_blobs`; ref_count: `scan.refs.get(hash).copied().unwrap_or(0)` (0 → count `unreferenced_blobs`). `missing_files` = scan.refs keys with no file. When `write`: one transaction — `DELETE FROM blobs; DELETE FROM rubbish_archive_releases;` then INSERT every row with `created_at = now (RFC3339)`. Clearing the releases ledger is deliberate and must carry this comment: recount already treats every present rubbish item as holding refs, so a later purge decrements exactly once (spec §7; over-count-safe). Dry run: compute the same report, skip the transaction.

CLI `CasCommands::Rebuild { write }`: resolve vault + CAS path as in Task 5; `let scan = cas_scan::scan_archive_refs(&vault);` print scan warnings; `ContentStore::open(&cas_path)?` → `rebuild_metadata(&scan, write)`; print report summary lines (`rows_written`, `unreferenced`, `untyped`, `missing`), dry-run note; exit 1 if `missing_files` or scan warnings non-empty else 0. Document in `cli.mdx` (`## \`clep cas rebuild\``). Add the `try_parse_from` test.

- [ ] **Step 4: Verify pass** — `cargo test --lib cas:: && cargo test --test docs_cli_coverage_test` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(cas): clep cas rebuild recreates derived cas.db from vault + blobs"`

---

### Task 8: Doctor `--full` CAS verify (recount vs stored)

**Files:**
- Modify: `src/doctor.rs` — extend `check_cas` (`:1114-1218`) inside its existing `if full` block

**Interfaces:**
- Consumes: `cas_scan::scan_archive_refs` (Task 6). Read-only raw rusqlite ONLY (doctor constraint). The recount must subtract already-released rubbish refs: for each row of `rubbish_archive_releases`, re-read `.clepsydra/rubbish/<item_id>/page.md` if it still exists and subtract its unique hashes from the expected counts (a released-but-unremoved item is counted by the scan but already decremented in the DB).
- Produces: checks `("cas", "refcounts")`, `("cas", "orphans")`, `("cas", "missing")`.

- [ ] **Step 1: Write the failing tests** (doctor `#[cfg(test)]`; build vault via `init_vault`, CAS via `ContentStore::open` — allowed in tests):

```rust
    fn archive_page_with_snapshot(hash: &str) -> String {
        format!(
            "+++\nid = \"01900000-0000-7000-8000-000000000009\"\ntitle = \"A\"\n\
             created_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\n\
             [archive]\nurl = \"https://x\"\ndomain = \"x\"\ncaptured_at = \"2026-01-01T00:00:00Z\"\n\
             snapshot_hash = \"{hash}\"\n+++\nbody\n"
        )
    }

    /// Vault + separate CAS dir wired through `.clepsydra/config.toml`.
    /// Returns (tempdir, cas_dir, stored snapshot hash) with one archive page
    /// referencing the stored blob. Config fields absent from the file fall
    /// back to serde defaults, so overwriting init's config is safe in tests.
    fn cas_fixture() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf, String) {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let cas_dir = tmp.path().join("cas");
        let store = crate::vault::cas::ContentStore::open(&cas_dir).unwrap();
        let stored = store.store(b"<html>", "text/html").unwrap();
        drop(store); // release the flock before doctor / direct sqlite access
        std::fs::write(
            root.join(".clepsydra/config.toml"),
            format!("[archive]\ncas_path = \"{}\"\n", cas_dir.display()),
        )
        .unwrap();
        std::fs::create_dir_all(root.join("archive/x")).unwrap();
        std::fs::write(root.join("archive/x/a.md"), archive_page_with_snapshot(&stored.hash)).unwrap();
        (tmp, root, cas_dir, stored.hash)
    }

    #[test]
    fn full_cas_verify_reports_refcount_drift() {
        let (_tmp, root, cas_dir, hash) = cas_fixture();
        rusqlite::Connection::open(cas_dir.join("cas.db"))
            .unwrap()
            .execute("UPDATE blobs SET ref_count = 5", [])
            .unwrap();
        let vault = crate::vault::Vault::open(&root).unwrap();
        let mut report = Report::default();
        check_cas(&vault, true, &mut report);
        let r = report.results.iter().find(|r| r.section == "cas" && r.name == "refcounts").unwrap();
        assert!(matches!(r.status, Status::Warn));
        assert!(r.detail.contains(&hash));
    }

    #[test]
    fn full_cas_verify_ok_when_consistent() {
        let (_tmp, root, _cas_dir, _hash) = cas_fixture();
        let vault = crate::vault::Vault::open(&root).unwrap();
        let mut report = Report::default();
        check_cas(&vault, true, &mut report);
        for name in ["refcounts", "orphans", "missing"] {
            let r = report.results.iter().find(|r| r.section == "cas" && r.name == name).unwrap();
            assert!(matches!(r.status, Status::Ok | Status::Info), "check {name} not clean");
        }
    }

    #[test]
    fn full_cas_verify_reports_missing_blob_file() {
        let (_tmp, root, cas_dir, hash) = cas_fixture();
        let hex = &hash["sha256:".len()..];
        std::fs::remove_file(cas_dir.join(&hex[..2]).join(hex)).unwrap();
        let vault = crate::vault::Vault::open(&root).unwrap();
        let mut report = Report::default();
        check_cas(&vault, true, &mut report);
        let r = report.results.iter().find(|r| r.section == "cas" && r.name == "missing").unwrap();
        assert!(matches!(r.status, Status::Warn));
        assert!(r.detail.contains(hex));
    }
```

(If `Report` lacks `Default`, mirror the construction idiom of the file's existing tests — same note as Task 3.)

- [ ] **Step 2: Verify failure** — the drift/missing tests FAIL (checks don't exist).

- [ ] **Step 3: Implement.** In `check_cas`'s `if full` block, after the existing stats: `let scan = crate::vault::cas_scan::scan_archive_refs(vault);` → surface `scan.warnings` as one `warn("cas", "scan", …)` if non-empty. Build `expected: BTreeMap<String, i64>` from `scan.refs`, apply the releases subtraction (query `SELECT item_id FROM rubbish_archive_releases`; for rows whose rubbish dir still exists, parse its `page.md` and subtract each unique hash, floor 0). Then `SELECT hash, ref_count FROM blobs` → compare: mismatches listed (≤10) under `warn("cas", "refcounts", …)` with hint `"run \`clep cas rebuild --write\` to recount"`; rows whose fan-out file is absent (`<cas>/<hex[..2]>/<hex>` — re-derive the path; doctor cannot call the private `blob_path`) → `("cas", "missing")`; fan-out files without a row or expected ref → `("cas", "orphans")` as `Info` (GC-eligible, not an error). All three emit `Ok` when clean. No writes anywhere.

- [ ] **Step 4: Verify pass** — new doctor tests PASS; `cargo test --lib` green.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(doctor): --full CAS verify recounts refs, orphans, missing blobs"`

---

## Final verification gates (after Task 8)

- [ ] `cargo test` (full suite)
- [ ] `cargo clippy` (no new warnings in touched files)
- [ ] `cd ui && bun run typecheck && bun run lint` (only if `schema.d.ts` regenerated: start `cargo run -- serve`, run `bun run openapi`, stop server — required because Task 4 changed `ArchiveMetaResponse`)
- [ ] Report results explicitly, then merge `feature/sync-prereqs` → `develop` per `superpowers:finishing-a-development-branch`, clean up the worktree.
