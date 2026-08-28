# CAS in the Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the content-addressed store live inside the vault by default (`<vault>/.clepsydra/cas`) and ship `clep cas migrate`, which copies only the blobs this vault references from the old external store and rebuilds `cas.db`.

**Architecture:** One resolver (`resolve_cas_path` / `Vault::cas_root`) replaces the five ad-hoc `expand_tilde(cas_path)` sites, so a relative `archive.cas_path` means "relative to the vault root" and the default becomes `.clepsydra/cas`. A new `src/vault/cas_migrate.rs` module reuses the phase-1 pieces — `cas_scan::scan_archive_refs` for the referenced set and `ContentStore::rebuild_metadata` for `cas.db` — and adds only the copy step. The CLI, doctor, and `serve` startup point users at the migration when a vault's store is empty but the legacy store exists.

**Tech Stack:** Rust 2024 (rusqlite, sha2, walkdir, clap), existing `vault::cas`, `vault::cas_scan`, `vault::atomic_file`; docs in `ui/src/docs/content/*.mdx`.

**Spec:** `docs/superpowers/specs/2026-08-27-clep-sync-design.md` §7; ADR `docs/adr/0005-cas-in-vault-frontmatter-metadata.md`. Phase 3 of 4 (predecessors merged: sync-prereqs `0f76f04a`, petname-codes `475a958b`).

## Global Constraints

- Branch `feature/cas-in-vault` off develop `cd50b2f9`; worktree `.worktrees/cas-in-vault` (already set up: `ui/dist` built, `cargo build` green).
- Rust is fmt-clean and CI-gated: run `cargo fmt` freely; every commit must pass `cargo fmt --check`. UI biome is NOT clean repo-wide: never run `biome check --write` across `ui/src`.
- Never pipe cargo through `tail`/`grep` when the exit code matters; run bare and read the end.
- Default `archive.cas_path` is exactly `".clepsydra/cas"`. Resolution rule, exact: `~` / `~/…` expands to the home directory; an absolute path is used as-is; any other (relative) path is joined onto the vault root. Explicit config always wins over the default.
- The old default `~/.clepsydra/cas` appears in code ONLY as `cas_migrate::LEGACY_DEFAULT_CAS_PATH`, used as the migration's default `--from` and by the doctor/serve hints. No other module hard-codes it.
- `cas.db` stays derived (ADR 0005): the migration never copies the source `cas.db`; it rebuilds the destination's via `ContentStore::rebuild_metadata` from blob files + the frontmatter scan.
- The migration copies ONLY blobs referenced by this vault's live pages and rubbish items (`scan_archive_refs`), verifies each copied blob's sha256 against its name, never deletes or modifies the source store, and is a dry run by default.
- `clep doctor` stays read-only: it never opens a `ContentStore` (that takes the store's flock) — filesystem and read-only SQLite checks only.
- New CLI subcommands need the exact heading `## \`clep cas migrate\`` in `ui/src/docs/content/cli.mdx` (`tests/docs_cli_coverage_test.rs` enforces).
- Running the migration against the user's live vault is NOT part of this branch (post-merge: stop `clep serve`, dry run, `--write` on explicit confirmation, restart).
- Line numbers below were verified on develop `cd50b2f9` in the worktree.

---

## File structure

- `src/vault/config.rs` — owns the `[archive]` setting and its resolution rule (`resolve_cas_path`).
- `src/vault/mod.rs` — `Vault::cas_root()` convenience over the resolver.
- `src/vault/cas.rs` — gains two `pub(crate)` layout helpers (`blob_relative_path`, `list_blob_hashes`) so doctor and the migration stop re-implementing the fan-out layout.
- `src/vault/cas_migrate.rs` (new) — the migration: referenced-blob copy + verify + rebuild; `LEGACY_DEFAULT_CAS_PATH`; `legacy_store_with_blobs()`.
- `src/doctor.rs` — uses the resolver and the layout helpers; adds the legacy-store hint.
- `src/lib.rs`, `src/bin/cli.rs`, `src/vault/backup.rs` — call sites switched to the resolver; CLI gains `clep cas migrate`.
- Docs: `ui/src/docs/content/{configuration,capture-feeds-and-archives,cli}.mdx`; `docs/design-notes/multi-file-mutation-audit.md`.

---

### Task 1: One CAS path resolver; default flips to `.clepsydra/cas`

**Files:**
- Modify: `src/vault/config.rs:178-180` (`default_cas_path`), add `resolve_cas_path`, tests `:222-231`
- Modify: `src/vault/mod.rs` (add `Vault::cas_root`, near `pub fn config` :134)
- Modify: `src/lib.rs:702-704`, `src/bin/cli.rs:509-512` and `:548-555` (Backfill/Rebuild arms), `src/doctor.rs:1128-1129`, `src/vault/backup.rs:130-133`
- Modify: `ui/src/docs/content/configuration.mdx:330,338,441`, `ui/src/docs/content/capture-feeds-and-archives.mdx:32-33,192-198`
- Test: `src/vault/config.rs` (`mod tests`), `src/doctor.rs` (`mod tests`, model `cas_check_does_not_create_missing_db` at `:2261`)

**Interfaces:**
- Produces:

```rust
// src/vault/config.rs
/// Resolve `[archive].cas_path` to an absolute directory: `~`/`~/…` expands to
/// the home directory, an absolute path is used as-is, anything else is
/// relative to `vault_root`.
pub fn resolve_cas_path(raw: &str, vault_root: &Path) -> PathBuf;

// src/vault/mod.rs
impl Vault { pub fn cas_root(&self) -> PathBuf } // resolve_cas_path(&self.config().archive.cas_path, self.root())
```

- [ ] **Step 1: Write the failing tests.** In `src/vault/config.rs` `mod tests`, change `archive_config_defaults` to assert `config.archive.cas_path == ".clepsydra/cas"` and add:

```rust
#[test]
fn resolve_cas_path_rules() {
    let root = Path::new("/vaults/main");
    assert_eq!(resolve_cas_path(".clepsydra/cas", root), PathBuf::from("/vaults/main/.clepsydra/cas"));
    assert_eq!(resolve_cas_path("cas-here", root), PathBuf::from("/vaults/main/cas-here"));
    assert_eq!(resolve_cas_path("/abs/cas", root), PathBuf::from("/abs/cas"));
    let home = dirs::home_dir().expect("home dir in tests");
    assert_eq!(resolve_cas_path("~/.clepsydra/cas", root), home.join(".clepsydra/cas"));
    assert_eq!(resolve_cas_path("~", root), home);
}
```

In `src/doctor.rs` `mod tests` (copy the shape of `cas_check_does_not_create_missing_db`, including `#[serial_test::serial]` and `write_top_level_config`):

```rust
#[tokio::test]
#[serial_test::serial]
async fn cas_relative_path_resolves_against_vault_root() {
    let tmp = TempDir::new().unwrap();
    let cwd = tmp.path();
    let vault_root = tmp.path().join("vault");
    crate::vault::init::init_vault(&vault_root).unwrap();
    fs::write(
        vault_root.join(".clepsydra/config.toml"),
        "[vault]\nattachment_folder = \"_attachments\"\n\n[archive]\nenabled = true\ncas_path = \"cas-here\"\n",
    )
    .unwrap();
    write_top_level_config(cwd, &vault_root);

    let report = run_with_cwd(cwd, DoctorOpts::default()).await;

    let expected = vault_root.join("cas-here").display().to_string();
    assert!(
        report.results.iter().any(|r| r.section == "cas" && r.name == "path" && r.detail == expected),
        "{:?}", report.results.iter().filter(|r| r.section == "cas").collect::<Vec<_>>()
    );
}
```

(If `CheckResult`'s detail field has another name, use that — read the struct at `src/doctor.rs:40-64`.)

- [ ] **Step 2: Verify failure** — `cargo test --lib config::tests` (compile error: `resolve_cas_path` undefined) and `cargo test --lib doctor::tests::cas_relative` → FAIL (doctor reports `<cwd>/cas-here`).

- [ ] **Step 3: Implement.**

`src/vault/config.rs`:

```rust
fn default_cas_path() -> String {
    ".clepsydra/cas".to_string()
}

/// Resolve `[archive].cas_path` to an absolute directory. `~` and `~/…`
/// expand to the home directory, an absolute path is used as-is, and any
/// other path is relative to the vault root — so the default
/// `.clepsydra/cas` lands inside the vault (ADR 0005).
pub fn resolve_cas_path(raw: &str, vault_root: &Path) -> PathBuf {
    if let Some(expanded) = crate::expand_tilde(raw) {
        return expanded;
    }
    let path = Path::new(raw);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        vault_root.join(path)
    }
}
```

`src/vault/mod.rs` (next to `config()`):

```rust
/// Absolute CAS root for this vault (see `config::resolve_cas_path`).
pub fn cas_root(&self) -> PathBuf {
    crate::vault::config::resolve_cas_path(&self.config.archive.cas_path, &self.root)
}
```

Call sites: `src/lib.rs:702-704` → `let cas = vault::cas::ContentStore::open(&vault.cas_root())?;` (delete the two `cas_path` lines). `src/bin/cli.rs` Backfill and Rebuild arms → `let cas_path = vault.cas_root();` (delete `cas_path_raw` + `expand_tilde` lines; keep everything else). `src/doctor.rs:1128-1129` → `let path = vault.cas_root();`. `src/vault/backup.rs:130-132` → `let unresolved_cas_path = crate::vault::config::resolve_cas_path(&vault_config.archive.cas_path, &vault_root);` (the `configured_cas_path` binding goes away; check `expand_tilde` is still imported elsewhere in the file or drop the import).

Docs: `configuration.mdx:330` default cell → `` `.clepsydra/cas` `` ; `:338` note → "`cas_path` is resolved against the vault root when relative (the default keeps the store inside the vault at `.clepsydra/cas`); `~/...` expands to your home directory; absolute paths are used as-is."; `:441` example → `cas_path = ".clepsydra/cas"`. `capture-feeds-and-archives.mdx:32-33` → "The default CAS is `.clepsydra/cas`, inside the vault (ADR 0005); a vault created before 2026-08-28 keeps its blobs in the old external store until `clep cas migrate` moves them."; `:192-198` → the backup paragraph now says the default in-vault CAS IS included (walked via the CAS snapshot), and only a `cas_path` pointing outside the vault needs a separate backup.

- [ ] **Step 4: Verify pass** — `cargo test --lib config::`, `cargo test --lib doctor::`, `cargo test --test archive_test`, `cargo test --test e2e_test`, `cargo test --lib backup::` → PASS; `grep -rn "expand_tilde(cas_path_raw)\|expand_tilde(&configured_cas_path)" src` → no hits; `cargo fmt --check`; `cd ui && bun run typecheck` (mdx compiles).
- [ ] **Step 5: Commit** — `git add src/vault/config.rs src/vault/mod.rs src/lib.rs src/bin/cli.rs src/doctor.rs src/vault/backup.rs ui/src/docs/content/configuration.mdx ui/src/docs/content/capture-feeds-and-archives.mdx && git commit -m "feat(cas): resolve archive.cas_path against the vault; default moves to .clepsydra/cas"`

---

### Task 2: `cas_migrate::migrate` — copy referenced blobs, verify, rebuild `cas.db`

**Files:**
- Create: `src/vault/cas_migrate.rs`
- Modify: `src/vault/mod.rs` (`pub mod cas_migrate;` alphabetical, after `cas`)
- Modify: `src/vault/cas.rs:878-884` (`blob_path` delegates to a new `pub(crate) fn blob_relative_path`), add `pub(crate) fn list_blob_hashes(root: &Path) -> Vec<String>` (move the body of doctor's `list_cas_blob_files` :1450-1480 here)
- Modify: `src/doctor.rs:1434-1480` (`cas_blob_path` and `list_cas_blob_files` become one-line delegations to the `cas` helpers; keep their names so callers don't change)
- Test: `src/vault/cas_migrate.rs` `mod tests`; `src/vault/cas.rs` `mod tests` (one test for `blob_relative_path`)

**Interfaces:**
- Consumes: `Vault::cas_root` (Task 1); `cas_scan::scan_archive_refs(&Vault) -> ArchiveRefScan { refs: BTreeMap<String,u32>, types, warnings }`; `ContentStore::{open, hash_bytes, rebuild_metadata(&ArchiveRefScan, write) -> RebuildReport}`; `atomic_file::atomic_replace(&Path, &[u8])`.
- Produces:

```rust
// src/vault/cas.rs
/// `"sha256:<64 hex>"` → `<hex[..2]>/<hex>` (relative to a CAS root); None for a malformed hash.
pub(crate) fn blob_relative_path(hash: &str) -> Option<PathBuf>;
/// Every blob file under `root`'s two-level fan-out, as `"sha256:<hex>"` hashes (sorted).
pub(crate) fn list_blob_hashes(root: &Path) -> Vec<String>;

// src/vault/cas_migrate.rs
pub const LEGACY_DEFAULT_CAS_PATH: &str = "~/.clepsydra/cas";

#[derive(Debug, Default)]
pub struct MigrateReport {
    pub copied: Vec<String>,          // hashes copied (or that would be, in a dry run)
    pub already_present: Vec<String>, // referenced hashes the destination already had
    pub missing: Vec<String>,         // referenced hashes absent from the source
    pub corrupt: Vec<String>,         // source files whose sha256 != name; not copied
    pub bytes_copied: u64,
    pub orphans_left: u64,            // source blobs no live page/rubbish item references
    pub rebuild: Option<cas::RebuildReport>, // Some only when write
    pub warnings: Vec<String>,        // scan warnings + one line per missing/corrupt
    pub dry_run: bool,
}

/// Copy every blob this vault references from `source` into `vault.cas_root()`,
/// then rebuild the destination `cas.db`. Never touches `source`.
pub fn migrate(vault: &Vault, source: &Path, write: bool) -> Result<MigrateReport, Box<dyn std::error::Error>>;

/// The legacy default store, if it exists and holds a `cas.db` (a hint target for doctor/serve).
pub fn legacy_store_with_blobs() -> Option<PathBuf>;
```

- [ ] **Step 1: Write the failing tests.** `src/vault/cas.rs` tests:

```rust
#[test]
fn blob_relative_path_fans_out_by_two_hex_chars() {
    let hash = ContentStore::hash_bytes(b"abc");
    let hex = hash.strip_prefix("sha256:").unwrap();
    assert_eq!(blob_relative_path(&hash).unwrap(), Path::new(&hex[..2]).join(hex));
    assert!(blob_relative_path("md5:00").is_none());
    assert!(blob_relative_path("sha256:zz").is_none());
}
```

`src/vault/cas_migrate.rs` tests (fixture helpers are part of the test module):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;
    use crate::vault::cas::{ContentStore, blob_relative_path};
    use std::fs;

    /// Bytes → (hash, bytes). Distinct inputs give distinct blobs.
    fn blob(bytes: &[u8]) -> (String, Vec<u8>) { (ContentStore::hash_bytes(bytes), bytes.to_vec()) }

    fn write_blob(root: &std::path::Path, hash: &str, bytes: &[u8]) {
        let p = root.join(blob_relative_path(hash).unwrap());
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }

    /// Vault with one archive page referencing `snap` (snapshot, text/html) and
    /// `img` (typed image/png), and a second page referencing `gone` (never in
    /// the source). Source store holds snap, img, and an orphan.
    fn fixture() -> (tempfile::TempDir, Vault, std::path::PathBuf, [String; 4]) {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let (snap, snap_b) = blob(b"<html>snap</html>");
        let (img, img_b) = blob(b"\x89PNG img");
        let (orphan, orphan_b) = blob(b"orphan");
        let (gone, _) = blob(b"gone");
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/a.md"), format!(
            "+++\nid = \"01900000-0000-7000-8000-00000000000a\"\ntitle = \"A\"\ncreated_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\n\n[archive]\nsnapshot_hash = \"{snap}\"\nblobs = [{{ hash = \"{img}\", type = \"image/png\" }}]\n+++\nbody\n")).unwrap();
        fs::write(root.join("notes/b.md"), format!(
            "+++\nid = \"01900000-0000-7000-8000-00000000000b\"\ntitle = \"B\"\ncreated_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\n\n[archive]\nsnapshot_hash = \"{gone}\"\n+++\nbody\n")).unwrap();
        let source = tmp.path().join("old-cas");
        write_blob(&source, &snap, &snap_b);
        write_blob(&source, &img, &img_b);
        write_blob(&source, &orphan, &orphan_b);
        fs::write(source.join("cas.db"), b"not copied").unwrap();
        let vault = Vault::open(&root).unwrap(); // default cas_path → <root>/.clepsydra/cas
        (tmp, vault, source, [snap, img, orphan, gone])
    }

    #[test]
    fn dry_run_reports_the_plan_and_creates_nothing() {
        let (_tmp, vault, source, [snap, img, _orphan, gone]) = fixture();
        let report = migrate(&vault, &source, false).unwrap();
        assert!(report.dry_run);
        assert_eq!(report.copied, vec![img.clone(), snap.clone()].into_iter().collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>());
        assert_eq!(report.missing, vec![gone]);
        assert_eq!(report.orphans_left, 1);
        assert!(report.rebuild.is_none());
        assert!(!vault.cas_root().exists(), "dry run must not create the store");
    }

    #[test]
    fn write_copies_referenced_blobs_verifies_them_and_rebuilds_cas_db() {
        let (_tmp, vault, source, [snap, img, orphan, gone]) = fixture();
        let report = migrate(&vault, &source, true).unwrap();
        let dest = vault.cas_root();
        assert!(dest.join(blob_relative_path(&snap).unwrap()).exists());
        assert!(dest.join(blob_relative_path(&img).unwrap()).exists());
        assert!(!dest.join(blob_relative_path(&orphan).unwrap()).exists(), "orphans stay behind");
        assert_eq!(report.missing, vec![gone.clone()]);
        assert!(report.warnings.iter().any(|w| w.contains(&gone)));
        assert_eq!(fs::read(source.join("cas.db")).unwrap(), b"not copied", "source untouched");
        let rebuild = report.rebuild.expect("write rebuilds cas.db");
        assert_eq!(rebuild.rows_written, 2);
        let conn = rusqlite::Connection::open(dest.join("cas.db")).unwrap();
        let ty: String = conn.query_row("SELECT content_type FROM blobs WHERE hash = ?1", [&img], |r| r.get(0)).unwrap();
        assert_eq!(ty, "image/png");
        let ty: String = conn.query_row("SELECT content_type FROM blobs WHERE hash = ?1", [&snap], |r| r.get(0)).unwrap();
        assert_eq!(ty, "text/html");
        drop(conn);
        // second run: nothing left to copy
        let again = migrate(&vault, &source, true).unwrap();
        assert!(again.copied.is_empty());
        assert_eq!(again.already_present.len(), 2);
    }

    #[test]
    fn corrupt_source_blob_is_skipped_with_warning() {
        let (_tmp, vault, source, [_snap, img, _orphan, _gone]) = fixture();
        fs::write(source.join(blob_relative_path(&img).unwrap()), b"tampered").unwrap();
        let report = migrate(&vault, &source, true).unwrap();
        assert_eq!(report.corrupt, vec![img.clone()]);
        assert!(!vault.cas_root().join(blob_relative_path(&img).unwrap()).exists());
        assert!(report.warnings.iter().any(|w| w.contains(&img) && w.contains("sha256")));
    }

    #[test]
    fn same_store_and_missing_source_are_errors() {
        let (_tmp, vault, source, _) = fixture();
        assert!(migrate(&vault, &vault.cas_root(), false).is_err());
        assert!(migrate(&vault, &source.join("nope"), false).is_err());
    }
}
```

- [ ] **Step 2: Verify failure** — `cargo test --lib cas_migrate::` → FAIL (unresolved module); `cargo test --lib cas::tests::blob_relative_path` → FAIL.

- [ ] **Step 3: Implement.**

`src/vault/cas.rs` — add near `validate_hash`:

```rust
/// `"sha256:<64 hex>"` → `<hex[..2]>/<hex>`, the store's two-level fan-out,
/// relative to a CAS root. `None` for a malformed hash.
pub(crate) fn blob_relative_path(hash: &str) -> Option<PathBuf> {
    let hex = ContentStore::validate_hash(hash).ok()?;
    Some(Path::new(&hex[..2]).join(hex))
}
```

and make `blob_path` call it: `Ok(self.root.join(blob_relative_path(hash).ok_or("invalid hash")?))` — keep the original error text by validating first if a test asserts on it. Move doctor's `list_cas_blob_files` body into `pub(crate) fn list_blob_hashes(root: &Path) -> Vec<String>` (sorted output). In `src/doctor.rs`, `cas_blob_path` becomes `crate::vault::cas::blob_relative_path(hash).map(|rel| cas_root.join(rel))` and `list_cas_blob_files` becomes `crate::vault::cas::list_blob_hashes(cas_root)`; update the doc comments (they currently say "reimplemented because private").

`src/vault/cas_migrate.rs`:

```rust
//! One-time move of the CAS into the vault (ADR 0005 / spec §7): copy the
//! blobs this vault references from an old store into `vault.cas_root()`,
//! verify each by hash, and rebuild the destination `cas.db` from blob files
//! plus the frontmatter scan. The source store is never modified; blobs it
//! holds that no page references stay behind.

use std::path::{Path, PathBuf};
use crate::vault::Vault;
use crate::vault::cas::{self, ContentStore, blob_relative_path, list_blob_hashes};
use crate::vault::cas_scan::scan_archive_refs;

/// Where the store lived before 2026-08-28; the migration's default source.
pub const LEGACY_DEFAULT_CAS_PATH: &str = "~/.clepsydra/cas";

pub fn legacy_store_with_blobs() -> Option<PathBuf> {
    let path = crate::expand_tilde(LEGACY_DEFAULT_CAS_PATH)?;
    (path.join("cas.db").is_file()).then_some(path)
}

pub fn migrate(vault: &Vault, source: &Path, write: bool) -> Result<MigrateReport, Box<dyn std::error::Error>> {
    if !source.is_dir() {
        return Err(format!("source CAS {} is not a directory", source.display()).into());
    }
    let dest = vault.cas_root();
    let source = std::fs::canonicalize(source)?;
    if dest.exists() && std::fs::canonicalize(&dest)? == source {
        return Err(format!("source and destination are the same store ({})", source.display()).into());
    }
    let mut report = MigrateReport { dry_run: !write, ..Default::default() };
    let scan = scan_archive_refs(vault);
    report.warnings.extend(scan.warnings.iter().cloned());

    for hash in scan.refs.keys() {
        let Some(rel) = blob_relative_path(hash) else {
            report.warnings.push(format!("{hash}: malformed hash in frontmatter; skipped"));
            continue;
        };
        let to = dest.join(&rel);
        if to.is_file() { report.already_present.push(hash.clone()); continue; }
        let from = source.join(&rel);
        if !from.is_file() {
            report.missing.push(hash.clone());
            report.warnings.push(format!("{hash}: not found in {}", source.display()));
            continue;
        }
        let bytes = std::fs::read(&from)?;
        if ContentStore::hash_bytes(&bytes) != *hash {
            report.corrupt.push(hash.clone());
            report.warnings.push(format!("{hash}: sha256 of {} does not match its name; not copied", from.display()));
            continue;
        }
        if write {
            std::fs::create_dir_all(to.parent().expect("fan-out parent"))?;
            crate::vault::atomic_file::atomic_replace(&to, &bytes)?;
        }
        report.bytes_copied += bytes.len() as u64;
        report.copied.push(hash.clone());
    }

    report.orphans_left = list_blob_hashes(&source).iter().filter(|h| !scan.refs.contains_key(*h)).count() as u64;

    if write {
        let store = ContentStore::open(&dest)?;
        report.rebuild = Some(store.rebuild_metadata(&scan, true)?);
    }
    Ok(report)
}
```

`atomic_replace` returns `AtomicPublicationError` — map with `?` if it implements `std::error::Error` (it does; check `atomic_file.rs`). `refs` keys iterate in `BTreeMap` order, so `copied` is sorted by hash — the dry-run test builds its expectation the same way.

- [ ] **Step 4: Verify pass** — `cargo test --lib cas_migrate::`, `cargo test --lib cas::`, `cargo test --lib doctor::` → PASS; `cargo clippy --all-targets` clean; `cargo fmt --check`.
- [ ] **Step 5: Commit** — `git add src/vault/cas_migrate.rs src/vault/mod.rs src/vault/cas.rs src/doctor.rs && git commit -m "feat(cas): cas_migrate copies referenced blobs into the vault store and rebuilds cas.db"`

---

### Task 3: `clep cas migrate`, doctor/serve legacy-store hints, docs

**Files:**
- Modify: `src/bin/cli.rs:29-42` (`CasCommands::Migrate { from: Option<PathBuf>, write: bool }`), dispatch beside `CasCommands::Rebuild` (:542), parse tests beside `:1272`
- Modify: `src/doctor.rs` `check_cas` (:1116-1160: after the `path` info line, before the `!path.exists()` early return) + a pure helper with unit tests
- Modify: `src/lib.rs:702` (startup warning after `ContentStore::open`)
- Modify: `ui/src/docs/content/cli.mdx:355-362` (`## \`clep cas\`` intro gains the operational-ordering paragraph) and add `## \`clep cas migrate\`` before `## \`clep cas backfill\``; `docs/design-notes/multi-file-mutation-audit.md` (one row beside the relabel/recode rows)
- Test: `src/bin/cli.rs` `mod tests`, `src/doctor.rs` `mod tests`, `tests/docs_cli_coverage_test.rs` (existing, enforces the heading)

**Interfaces:**
- Consumes: `cas_migrate::{migrate, MigrateReport, LEGACY_DEFAULT_CAS_PATH, legacy_store_with_blobs}` (Task 2); `Vault::cas_root` (Task 1).
- Produces in `src/doctor.rs`:

```rust
/// WARN when this vault's store has no `cas.db` yet but a legacy store does —
/// the user has not run `clep cas migrate`. Pure: takes the candidate legacy
/// path so tests need no HOME override.
fn legacy_store_hint(store: &Path, legacy: Option<&Path>) -> Option<CheckResult>;
```

- [ ] **Step 1: Write the failing tests.** `src/bin/cli.rs` tests (model `codes_migrate_*` / `cas_rebuild_*` parse tests):

```rust
#[test]
fn cas_migrate_defaults_to_dry_run_and_legacy_source() {
    let cli = Cli::try_parse_from(["clep", "cas", "migrate"]).unwrap();
    match cli.command {
        Commands::Cas { command: CasCommands::Migrate { from, write } } => { assert!(from.is_none()); assert!(!write); }
        other => panic!("expected cas migrate, got {other:?}"),
    }
}

#[test]
fn cas_migrate_accepts_from_and_write() {
    let cli = Cli::try_parse_from(["clep", "cas", "migrate", "--from", "/old/cas", "--write"]).unwrap();
    match cli.command {
        Commands::Cas { command: CasCommands::Migrate { from, write } } => { assert_eq!(from.unwrap(), PathBuf::from("/old/cas")); assert!(write); }
        other => panic!("expected cas migrate, got {other:?}"),
    }
}
```

`src/doctor.rs` tests:

```rust
#[test]
fn legacy_store_hint_only_when_store_uninitialised_and_legacy_present() {
    let tmp = TempDir::new().unwrap();
    let store = tmp.path().join("vault/.clepsydra/cas");
    let legacy = tmp.path().join("legacy");
    fs::create_dir_all(&legacy).unwrap();
    fs::write(legacy.join("cas.db"), b"x").unwrap();
    let hint = legacy_store_hint(&store, Some(&legacy)).expect("hint");
    assert_eq!((hint.section, hint.name, hint.status), ("cas", "legacy", Status::Warn));
    assert!(hint.hint.as_deref().unwrap_or("").contains("clep cas migrate"));
    assert!(legacy_store_hint(&store, None).is_none());
    fs::create_dir_all(&store).unwrap();
    fs::write(store.join("cas.db"), b"x").unwrap();
    assert!(legacy_store_hint(&store, Some(&legacy)).is_none(), "initialised store: no hint");
    assert!(legacy_store_hint(&legacy, Some(&legacy)).is_none(), "store IS the legacy path: no hint");
}
```

(Field names `section`/`name`/`status`/`hint` — confirm against `CheckResult` at `src/doctor.rs:40-64`.)

- [ ] **Step 2: Verify failure** — `cargo test --bin clep cas_migrate` → compile error (no `Migrate` variant); `cargo test --lib doctor::tests::legacy_store_hint` → compile error; `cargo test --test docs_cli_coverage_test` passes until the variant exists, then FAILS until the heading is added — run it after Step 3's CLI change to see the failure once.

- [ ] **Step 3: Implement.**

`src/bin/cli.rs` — variant:

```rust
#[command(
    about = "Copy this vault's referenced blobs from an old CAS into the vault's store and rebuild cas.db",
    long_about = "Moves the content-addressed store into the vault (ADR 0005). Copies only the blobs referenced by this vault's live pages and rubbish items from --from (default: the pre-2026-08-28 store at ~/.clepsydra/cas) into [archive].cas_path (default .clepsydra/cas inside the vault), verifies each blob's sha256, then rebuilds the destination cas.db from blob files plus a vault-wide frontmatter scan. The source store is never modified; blobs no page references stay behind. Stop `clep serve` first: the rebuild takes the store's lock. Dry run by default; --write applies."
)]
Migrate {
    /// Source CAS root to copy from (default: ~/.clepsydra/cas).
    #[arg(long)]
    from: Option<PathBuf>,
    /// Apply changes (default is a dry run).
    #[arg(long)]
    write: bool,
},
```

Arm (model the Rebuild arm for the vault open): `let source = from.unwrap_or_else(|| clepsydra::expand_tilde(LEGACY_DEFAULT_CAS_PATH).unwrap_or_else(|| PathBuf::from(LEGACY_DEFAULT_CAS_PATH)));` → print `Migrating referenced blobs from {source} into {vault.cas_root()}.` → `let report = migrate(&vault, &source, write)?;` → print each `copied` as `{verb} {hash}` (`would copy`/`copied`), each `already_present` count as one line, each warning as `  warning …`, then if `Some(rebuild)`: `cas.db: {rows_written} row(s), {untyped} untyped, {missing} missing` → summary `cas migrate: {n} blob(s) {verb} ({bytes} bytes), {present} already present, {missing} missing, {corrupt} corrupt, {orphans} orphan(s) left in source, {warnings} warning(s){dry-run hint}` → `Ok(if report.warnings.is_empty() { 0 } else { 1 })`.

`src/doctor.rs` — helper + call:

```rust
fn legacy_store_hint(store: &Path, legacy: Option<&Path>) -> Option<CheckResult> {
    let legacy = legacy?;
    if store.join("cas.db").is_file() || !legacy.join("cas.db").is_file() || legacy == store {
        return None;
    }
    Some(
        warn("cas", "legacy", format!("this vault's store {} has no cas.db yet, but a legacy store exists at {}", store.display(), legacy.display()))
            .with_hint("run `clep cas migrate` (dry run), then `clep cas migrate --write` with `clep serve` stopped"),
    )
}
```

In `check_cas`, right after `report.push(info(SECTION, "path", …))`: `if let Some(hint) = legacy_store_hint(&path, crate::vault::cas_migrate::legacy_store_with_blobs().as_deref()) { report.push(hint); }`. (Canonicalize both sides when they exist before the `legacy == store` comparison so a symlinked home doesn't defeat it.)

`src/lib.rs` after `let cas = …open(&vault.cas_root())?;`:

```rust
if cas.stats().map(|s| s.blob_count == 0).unwrap_or(false) {
    if let Some(legacy) = vault::cas_migrate::legacy_store_with_blobs() {
        tracing::warn!(
            "CAS at {} is empty but a legacy store exists at {}; archived pages will 404 until `clep cas migrate --write` runs",
            vault.cas_root().display(), legacy.display()
        );
    }
}
```

Docs — `cli.mdx` `## \`clep cas\`` intro gains: "Operational order for an existing vault: `clep cas migrate` (bring blobs into the vault) → `clep cas backfill` (type legacy string blob entries from the migrated `cas.db`; skips legacy-YAML archive pages by design) → `clep cas rebuild` (recount after any manual repair). `clep doctor --full` verifies the result." New section `## \`clep cas migrate\`` with usage `clep cas migrate [--from <path>] [--write]`, what is copied (referenced only), verification, what is left behind, `cas.db` rebuilt not copied, stop-the-server requirement, exit codes (0 no warnings; 1 otherwise), examples. Audit-doc row: `clep cas migrate` — one atomic file write per copied blob (`atomic_replace`), then one `rebuild_metadata` transaction; per-blob independence; `src/vault/cas_migrate.rs::tests::dry_run_reports_the_plan_and_creates_nothing` proves dry-run non-mutation.

- [ ] **Step 4: Verify pass** — `cargo test --bin clep`, `cargo test --lib doctor::`, `cargo test --test docs_cli_coverage_test`, `cargo test --lib cas_migrate::` → PASS; `cargo clippy --all-targets` clean; `cargo fmt --check`; `cd ui && bun run typecheck`.
- [ ] **Step 5: Commit** — `git add src/bin/cli.rs src/doctor.rs src/lib.rs ui/src/docs/content/cli.mdx docs/design-notes/multi-file-mutation-audit.md && git commit -m "feat(cli): clep cas migrate; doctor and serve point at the legacy store"`

---

## Final verification gates (after Task 3)

- [ ] `cargo test` (bare, read the end), `cargo clippy --all-targets` (zero warnings), `cargo fmt --check`
- [ ] `cd ui && bun run typecheck` (mdx); no ui code changes expected
- [ ] Whole-branch review, then merge to `develop` (temp `develop-merge` worktree; if `develop` is checked out in the main checkout, merge `develop` into the branch first, gate, then a guarded `git -C <main> merge --no-ff`).
- [ ] Post-merge, separately and only on explicit confirmation: stop `clep serve`; `clep cas migrate` (dry run) → `--write`; `clep doctor --full`; restart. Until then the running server keeps using `~/.clepsydra/cas` (old binary) — do not restart it on the new binary before migrating, or archived pages 404 (blobs are not lost).
