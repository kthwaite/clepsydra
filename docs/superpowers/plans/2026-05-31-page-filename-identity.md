# Page Filename Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every authored page filename globally unique by construction — `<yyyymmdd>.<title-slug>.<shortid>.md` — so the folder projection (Plan 3) can move files freely without collisions, and migrate the existing vault to the new scheme.

**Architecture:** A new base62 short-id (mirroring `BlockId`), a lowercased/truncated title slug, and a filename builder combining them with the page's `created_at` date. New-note creation adopts the builder. A one-off, idempotent `clepsydra relabel` CLI subcommand renames existing pages via the existing `MutationOp::MovePage` planner (which rewrites inbound links).

**Tech Stack:** Rust 2024, chrono (date formatting), rusqlite, Clap (CLI). Reuses `src/vault/mutation.rs` (`MovePage`).

**Reference docs:** `docs/adr/0002-page-filename-identity.md`, `docs/affordances.md` (Authored pages section).

**Depends on:** Plan 1 is *not* a hard prerequisite (filename identity is orthogonal to the kind columns), but this plan **must land before Plan 3**, whose collision-free moves rely on unique basenames.

---

## File Structure

- `src/vault/block_id.rs` — **modify.** Expose an 8-char base62 `generate_short_id()` reusing the existing base62 alphabet + random fill (DRY — no second alphabet).
- `src/vault/path.rs` — **modify.** Add `slugify_title(title, max_len)` (lowercased, hyphenated, truncated) and `is_canonical_page_filename(name)` (idempotency detector). Both live with the existing `from_title` slug logic.
- `src/vault/new_note.rs` — **modify.** `build_note_path` adopts the new filename builder.
- `src/vault/page_filename.rs` — **new.** `page_filename(created, title, short_id)` — the single source of truth for the filename shape.
- `src/vault/mod.rs` — **modify.** Register `page_filename`.
- `src/bin/cli.rs` — **modify.** Add the `Relabel { dry_run }` subcommand + dispatch.
- `src/vault/relabel.rs` — **new.** The migration: iterate pages, compute target filenames, skip already-canonical, move via `MutationPlanner`.

---

## Task 1: Base62 short-id generator

**Files:**
- Modify: `src/vault/block_id.rs`
- Test: inline `#[cfg(test)]` in `src/vault/block_id.rs`

- [ ] **Step 1: Write the failing test**

Add to the test module in `src/vault/block_id.rs`:

```rust
#[test]
fn short_id_is_eight_base62_chars() {
    let id = generate_short_id();
    assert_eq!(id.len(), 8);
    assert!(id.chars().all(|c| c.is_ascii_alphanumeric()));
}

#[test]
fn short_ids_vary() {
    // Not a strong randomness test — just that two draws differ.
    assert_ne!(generate_short_id(), generate_short_id());
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --lib vault::block_id::tests::short_id_is_eight_base62_chars`
Expected: FAIL — `generate_short_id` not found.

- [ ] **Step 3: Implement, reusing the existing random base62 fill**

In `src/vault/block_id.rs`, add a public function near `BlockId::generate`. Reuse the existing private `fill_random_base62` helper (already in this file):

```rust
/// A standalone 8-character random base62 token, for globally-unique page
/// filenames (see docs/adr/0002-page-filename-identity.md). Not time-sorted —
/// the filename's `yyyymmdd` prefix carries ordering.
pub fn generate_short_id() -> String {
    let mut buf = [0u8; 8];
    fill_random_base62(&mut buf);
    String::from_utf8(buf.to_vec()).expect("base62 is always valid UTF-8")
}
```

> If `fill_random_base62` takes `&mut [u8]`, this compiles as-is. Confirm its signature in the file and match it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --lib vault::block_id`
Expected: all pass (new + existing block-id tests).

- [ ] **Step 5: Commit**

```bash
git add src/vault/block_id.rs
git commit -m "feat(vault): 8-char base62 generate_short_id for page filenames"
```

---

## Task 2: Title slug + canonical-filename detector

**Files:**
- Modify: `src/vault/path.rs` (add two free functions near `from_title`)
- Test: inline `#[cfg(test)]` in `src/vault/path.rs`

- [ ] **Step 1: Write the failing tests**

Add to the test module in `src/vault/path.rs`:

```rust
#[test]
fn slugify_lowercases_hyphenates_and_truncates() {
    assert_eq!(slugify_title("Redesign Retro!", 40), "redesign-retro");
    assert_eq!(slugify_title("  Multiple   Spaces  ", 40), "multiple-spaces");
    // truncation does not leave a trailing dash
    assert_eq!(slugify_title("abcdefghij", 5), "abcde");
    assert_eq!(slugify_title("ab cd ef", 5), "ab-cd");
    // empty / punctuation-only title -> stable fallback
    assert_eq!(slugify_title("", 40), "untitled");
    assert_eq!(slugify_title("!!!", 40), "untitled");
}

#[test]
fn detects_canonical_page_filename() {
    assert!(is_canonical_page_filename("20260531.redesign-retro.3kF9a2bQ.md"));
    assert!(is_canonical_page_filename("20260531.a.0000aaaa.md"));
    // old-style names are not canonical
    assert!(!is_canonical_page_filename("My Note.md"));
    assert!(!is_canonical_page_filename("2026-wang.pdf"));
    // wrong token length / missing parts
    assert!(!is_canonical_page_filename("20260531.x.short.md"));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --lib vault::path::tests::slugify_lowercases_hyphenates_and_truncates`
Expected: FAIL — functions not found.

- [ ] **Step 3: Implement both functions**

In `src/vault/path.rs` (free functions, e.g. just below `from_title`):

```rust
/// Lowercased, hyphen-joined, length-capped slug for the human-readable middle
/// segment of a page filename. ASCII-folds spaces and punctuation to `-`,
/// collapses runs, trims, and truncates to at most `max_len` bytes on a `-`
/// boundary. Empty/punctuation-only input yields "untitled".
pub fn slugify_title(title: &str, max_len: usize) -> String {
    let lower = title.nfc().collect::<String>().to_lowercase();
    let mut slug = String::with_capacity(lower.len());
    let mut prev_dash = false;
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-');
    let mut out: String = trimmed.chars().take(max_len).collect();
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "untitled".to_string() } else { out }
}

/// True if `name` already matches the canonical page filename shape
/// `<yyyymmdd>.<slug>.<8 base62>.md`. Used to make relabel idempotent.
pub fn is_canonical_page_filename(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".md") else { return false };
    let parts: Vec<&str> = stem.split('.').collect();
    if parts.len() < 3 { return false; }
    let date = parts[0];
    let token = parts[parts.len() - 1];
    let date_ok = date.len() == 8 && date.chars().all(|c| c.is_ascii_digit());
    let token_ok = token.len() == 8 && token.chars().all(|c| c.is_ascii_alphanumeric());
    date_ok && token_ok
}
```

> `nfc()` comes from the `unicode_normalization` trait already imported in this file (it's used by `from_title`). If the import is scoped, add `use unicode_normalization::UnicodeNormalization;` at the top.
> Note `out` is rebound (the first `let mut out` then shadowed) — drop the `mut` if clippy warns; it's only there to allow the truncating collect. Simplify to a single `let out` if preferred.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --lib vault::path`
Expected: all path tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/vault/path.rs
git commit -m "feat(vault): slugify_title + is_canonical_page_filename"
```

---

## Task 3: Filename builder

**Files:**
- Create: `src/vault/page_filename.rs`
- Modify: `src/vault/mod.rs` (register module)
- Test: inline `#[cfg(test)]` in `src/vault/page_filename.rs`

- [ ] **Step 1: Write the failing test**

Create `src/vault/page_filename.rs`:

```rust
//! The single source of truth for an authored page's filename shape:
//! `<yyyymmdd>.<title-slug>.<shortid>.md`. See docs/adr/0002.

use chrono::{DateTime, Utc};

use super::path::slugify_title;

/// Maximum bytes of title kept in the slug segment.
const SLUG_MAX: usize = 40;

/// Build a canonical page filename (no folder) from a creation timestamp,
/// title, and pre-generated short id.
pub fn page_filename(created: DateTime<Utc>, title: &str, short_id: &str) -> String {
    let date = created.format("%Y%m%d");
    let slug = slugify_title(title, SLUG_MAX);
    format!("{date}.{slug}.{short_id}.md")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn builds_dotted_filename() {
        let created = Utc.with_ymd_and_hms(2026, 5, 31, 12, 0, 0).unwrap();
        let name = page_filename(created, "Redesign Retro", "3kF9a2bQ");
        assert_eq!(name, "20260531.redesign-retro.3kF9a2bQ.md");
    }

    #[test]
    fn empty_title_uses_untitled() {
        let created = Utc.with_ymd_and_hms(2026, 1, 2, 0, 0, 0).unwrap();
        let name = page_filename(created, "", "aaaa0000");
        assert_eq!(name, "20260102.untitled.aaaa0000.md");
    }
}
```

- [ ] **Step 2: Register the module**

In `src/vault/mod.rs` add:

```rust
pub mod page_filename;
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cargo test --lib vault::page_filename`
Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/vault/page_filename.rs src/vault/mod.rs
git commit -m "feat(vault): page_filename builder (yyyymmdd.slug.shortid.md)"
```

---

## Task 4: New notes adopt the canonical filename

**Files:**
- Modify: `src/vault/new_note.rs:157-172` (`build_note_path`)
- Test: `src/vault/new_note.rs` test module

- [ ] **Step 1: Write the failing test**

Add to the test module in `src/vault/new_note.rs` (reuse the existing temp-vault setup the other `new_note` tests use):

```rust
#[test]
fn new_note_filename_is_canonical() {
    // ... arrange the same temp vault + config the sibling tests build ...
    let created = create_new_note(/* same args the sibling tests pass */, "My Note", None).unwrap();
    let fname = created.vault_path.filename();
    assert!(
        crate::vault::path::is_canonical_page_filename(fname),
        "filename was: {fname}"
    );
    assert!(created.vault_path.as_str().starts_with("notes/"));
}
```

> Mirror the exact `create_new_note` signature and setup from the adjacent passing test `new_creates_a_note`-style cases in this module.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --lib vault::new_note`
Expected: FAIL — current `from_title` yields `My Note.md`, not canonical.

- [ ] **Step 3: Rewrite `build_note_path` to use the builder**

In `src/vault/new_note.rs`, change `build_note_path` (lines ~157-172) so the filename comes from the builder. Replace the body:

```rust
fn build_note_path(vault: &Vault, title: &str) -> Result<VaultPath, NewNoteError> {
    let created = chrono::Utc::now();
    let short_id = crate::vault::block_id::generate_short_id();
    let filename = crate::vault::page_filename::page_filename(created, title, &short_id);

    let folder = default_note_folder(vault); // existing logic that yields e.g. "notes"
    let combined = format!("{folder}/{filename}");
    VaultPath::new(&combined).map_err(|e| NewNoteError::InvalidPath(e.to_string()))
}
```

> Preserve whatever the current code uses to derive `folder` (the existing function reads a folder before `format!("{folder}/{}", generated.as_str())`). Keep that exact folder-resolution; only the filename portion changes. If the `created_at` written into the note's frontmatter is generated elsewhere, pass that same timestamp in rather than a second `Utc::now()` so the filename date and frontmatter `created_at` agree.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --lib vault::new_note`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/vault/new_note.rs
git commit -m "feat(vault): new notes use canonical date.slug.shortid filenames"
```

---

## Task 5: Stem interior-dot regression lock

**Files:**
- Test only: `src/vault/path.rs` test module

- [ ] **Step 1: Write the test (locks existing correct behaviour)**

`stem()` already uses `rfind('.')`, so this should pass immediately — the test prevents a future regression that would break the dotted scheme:

```rust
#[test]
fn stem_strips_only_trailing_md_for_dotted_filenames() {
    let vp = VaultPath::new("notes/20260531.redesign-retro.3kF9a2bQ.md").unwrap();
    assert_eq!(vp.stem(), "20260531.redesign-retro.3kF9a2bQ");
    assert_eq!(vp.filename(), "20260531.redesign-retro.3kF9a2bQ.md");
}
```

- [ ] **Step 2: Run it**

Run: `cargo test --lib vault::path::tests::stem_strips_only_trailing_md_for_dotted_filenames`
Expected: PASS (no source change needed).

- [ ] **Step 3: Commit**

```bash
git add src/vault/path.rs
git commit -m "test(vault): lock stem() interior-dot safety for page filenames"
```

---

## Task 6: `relabel` migration logic

**Files:**
- Create: `src/vault/relabel.rs`
- Modify: `src/vault/mod.rs` (register module)
- Test: inline `#[cfg(test)]` in `src/vault/relabel.rs`

- [ ] **Step 1: Write the failing test**

Create `src/vault/relabel.rs` with the function and an integration-style test over a temp vault + index (reuse the index/vault test helpers used elsewhere in `src/vault`):

```rust
//! One-off migration: rename authored pages to the canonical filename scheme
//! (docs/adr/0002), rewriting inbound links via the move planner. Idempotent:
//! pages already in canonical form are skipped.

use chrono::{DateTime, Utc};

use super::block_id::generate_short_id;
use super::index::VaultIndex;
use super::mutation::{MutationOp, MutationPlanner};
use super::page::Page;
use super::page_filename::page_filename;
use super::path::{is_canonical_page_filename, VaultPath};
use super::Vault;

/// Outcome of a relabel run.
#[derive(Debug, Default, PartialEq)]
pub struct RelabelReport {
    pub renamed: usize,
    pub skipped: usize,
}

/// Compute the canonical target path for a page, preserving its folder.
fn target_path(folder: Option<&str>, created: DateTime<Utc>, title: &str) -> String {
    let filename = page_filename(created, title, &generate_short_id());
    match folder {
        Some(f) => format!("{f}/{filename}"),
        None => filename,
    }
}

/// Relabel every page in the index. With `dry_run`, plans but does not execute.
pub fn relabel(
    vault: &Vault,
    index: &VaultIndex,
    dry_run: bool,
) -> Result<RelabelReport, super::index::IndexError> {
    let conn = index.connection();
    let rows: Vec<(String, String)> = conn
        .prepare("SELECT id, path FROM pages ORDER BY path")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;

    let mut report = RelabelReport::default();
    for (_id, path) in rows {
        let vp = VaultPath::new(&path).map_err(|e| super::index::IndexError::from_msg(e.to_string()))?;
        if is_canonical_page_filename(vp.filename()) {
            report.skipped += 1;
            continue;
        }
        let abs = vault.resolve(&vp);
        let page = Page::from_file(&abs, vp.clone())
            .map_err(|e| super::index::IndexError::from_msg(e.to_string()))?;
        let created = page.meta.created_at.or(page.meta.updated_at);
        let Some(created) = created else {
            // No timestamp to derive the date prefix from: leave it, warn.
            eprintln!("relabel: skipping {path} (no created_at/updated_at)");
            report.skipped += 1;
            continue;
        };
        let title = page.meta.title.clone().unwrap_or_default();
        let dest = target_path(vp.parent(), created, &title);

        if dry_run {
            println!("relabel: {path} -> {dest}");
            report.renamed += 1;
            continue;
        }
        let planner = MutationPlanner::new(vault, index);
        let plan = planner.plan(&MutationOp::MovePage {
            source: path.clone(),
            destination: dest.clone(),
        })?;
        plan.execute(vault, index, &[])?;
        report.renamed += 1;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relabels_old_names_and_skips_canonical() {
        // Arrange a temp vault + index with two pages:
        //   notes/My Note.md            (old style, has created_at)
        //   notes/20260101.x.aaaa0000.md (already canonical)
        // ... reuse the vault+index test fixture helper from this crate ...
        let (vault, index) = fixture_with_pages(&[
            ("notes/My Note.md", "---\nid: 0190f8a0-0000-7000-8000-00000000000a\ntitle: My Note\ncreated_at: 2026-05-31T12:00:00Z\n---\nbody"),
            ("notes/20260101.x.aaaa0000.md", "---\nid: 0190f8a0-0000-7000-8000-00000000000b\ncreated_at: 2026-01-01T00:00:00Z\n---\nbody"),
        ]);

        let report = relabel(&vault, &index, false).unwrap();
        assert_eq!(report.renamed, 1);
        assert_eq!(report.skipped, 1);

        // The old-style file is gone; a canonical one exists in notes/.
        let names = list_filenames(&vault, "notes");
        assert!(names.iter().all(|n| is_canonical_page_filename(n)));
        assert!(names.iter().any(|n| n.starts_with("20260531.my-note.")));
    }
}
```

> `fixture_with_pages` / `list_filenames` stand for the crate's existing temp-vault+index test helpers — match the real ones used in `src/vault` tests (grep for how `mutation.rs` / `index.rs` tests build a vault). `IndexError::from_msg` stands for the crate's existing error-construction idiom; if `IndexError` has a different constructor or a `From<String>`, use that. `Page::from_file`, `MutationPlanner::new`, `plan.execute`, and `vault.resolve` are confirmed to exist (`mutation.rs:163,246,250`, `page.rs`).

- [ ] **Step 2: Register the module**

In `src/vault/mod.rs` add `pub mod relabel;`.

- [ ] **Step 3: Run the test to verify it fails, then passes**

Run: `cargo test --lib vault::relabel`
Expected: iterate until PASS — fix helper names/imports to match the crate. Verify the renamed file's date prefix is `20260531` (from `created_at`) and the canonical page is skipped.

- [ ] **Step 4: Commit**

```bash
git add src/vault/relabel.rs src/vault/mod.rs
git commit -m "feat(vault): idempotent relabel migration to canonical filenames"
```

---

## Task 7: `clepsydra relabel` CLI subcommand

**Files:**
- Modify: `src/bin/cli.rs` (the `Commands` enum ~line 24, dispatch ~line 91)
- Test: `src/bin/cli.rs` test module (mirror `new_creates_a_note`)

- [ ] **Step 1: Write the failing test**

Add to the CLI test module in `src/bin/cli.rs`:

```rust
#[tokio::test]
async fn relabel_dry_run_returns_zero() {
    // Build a temp vault with one old-style note, like new_creates_a_note does,
    // then run the Relabel command in dry-run mode.
    let code = run_cli_in(Cli {
        command: Commands::Relabel { dry_run: true },
    }, /* same cwd/env args the sibling tests pass */).await.unwrap();
    assert_eq!(code, 0);
}
```

> Match the real `run_cli_in` signature used by `new_creates_a_note` (it sets up a temp cwd/config). If `run_cli` (not `run_cli_in`) is the testable entry, use that.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --bin clepsydra relabel`
Expected: FAIL — no `Relabel` variant.

- [ ] **Step 3: Add the subcommand variant**

In the `Commands` enum (`cli.rs:24`), add:

```rust
    /// Rename authored pages to the canonical `yyyymmdd.slug.shortid.md` scheme.
    #[command(about = "Relabel page filenames to the canonical identity scheme")]
    Relabel {
        /// Plan and print renames without touching the filesystem.
        #[arg(long)]
        dry_run: bool,
    },
```

- [ ] **Step 4: Add the dispatch arm**

In `run_cli`'s `match cli.command` (`cli.rs:91`), add an arm that opens the vault+index the same way `Serve`/`Doctor` do and calls `relabel`:

```rust
        Commands::Relabel { dry_run } => {
            // Open vault + index using the same path the serve/doctor commands use.
            let (vault, index) = open_vault_and_index().await?;
            let report = clepsydra::vault::relabel::relabel(&vault, &index, dry_run)?;
            println!(
                "relabel: {} renamed, {} skipped{}",
                report.renamed,
                report.skipped,
                if dry_run { " (dry run)" } else { "" }
            );
            Ok(0)
        }
```

> `open_vault_and_index()` stands for whatever the existing commands use to construct a `Vault` + `VaultIndex` from config (grep how `Serve`/`Doctor` build `build_app_state`/the index). Reuse it; do not invent a new config-loading path. If it's only available behind `build_app_state`, extract the vault+index from that, or factor a small helper.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test --bin clepsydra relabel`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/bin/cli.rs
git commit -m "feat(cli): clepsydra relabel subcommand (dry-run + execute)"
```

---

## Final verification

- [ ] **Backend:** `cargo test` — all pass.
- [ ] **Lint:** `cargo clippy --all-targets` — no new warnings.
- [ ] **Manual, on a throwaway copy of a real vault:**
  - `cargo run -- relabel --dry-run` prints `old -> new` for every non-canonical page, nothing for already-canonical ones.
  - `cargo run -- relabel` performs the renames; re-running it reports `0 renamed` (idempotent).
  - Spot-check a page that had inbound `[[wikilinks]]`: the links still resolve after the rename (the `MovePage` planner rewrote them).

---

## Notes for the executor

- **Run `relabel` on a backup/throwaway vault first.** It rewrites real files and links. The dry-run exists for exactly this.
- The migration derives the date prefix from `created_at` (then `updated_at`); pages with neither are skipped with a warning rather than given a fabricated date — deterministic and safe.
- Short-id collisions are astronomically unlikely (62^8 ≈ 2.18e14). If you want belt-and-braces, after computing `dest`, check `vault.resolve(&dest).exists()` and regenerate the token on the rare hit — but do not add this unless a real collision occurs.
- This plan records identity only; it does **not** project folders by kind/project. A relabelled page keeps its current folder. Folder projection is Plan 3.
