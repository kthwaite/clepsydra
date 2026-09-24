//! Conflict Copies: the whole-file conflict resolution of ADR 0004.
//!
//! When both sides of a merge changed one path, the local ("ours") version
//! stays in the tree and the remote ("theirs") version is written beside it
//! as `<stem>.conflict.<shortid><ext>` — never a merge-marker file, so the
//! vault always parses and always indexes.
//!
//! `shortid` is the first 7 lowercase hex characters of `sha256(theirs)`:
//! deterministic, so re-running the same merge produces the same name (and
//! [`write_conflict_copy`] then keeps the copy already on disk), and 7
//! characters so [`clep_vault::path::is_canonical_page_filename`] can never
//! match the result — a dated journal copy is never mistaken for a journal
//! (D5).

use std::path::Path;

use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::SyncError;
use clep_vault::atomic_file::atomic_create;
use clep_vault::page::{ExtraMap, FrontmatterError, parse_frontmatter, write_page_content};

/// Length of the `sha256(theirs)` prefix in a Conflict Copy's name. Seven,
/// not eight, so the copy of a dated journal file is never a canonical page
/// filename (D5).
pub const SHORT_ID_LEN: usize = 7;

/// The vault-relative path pair a Conflict Copy records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictCopy {
    /// The path that conflicted; "ours" still lives there.
    pub original: String,
    /// The path "theirs" was written to.
    pub copy: String,
}

/// The first [`SHORT_ID_LEN`] lowercase hex characters of `sha256(theirs)`.
pub fn short_id(theirs: &[u8]) -> String {
    let digest = Sha256::digest(theirs);
    let hex = format!("{digest:x}");
    hex[..SHORT_ID_LEN].to_string()
}

/// `notes/foo.md` + `abc1234` -> `notes/foo.conflict.abc1234.md`. A name
/// without an extension (`Makefile`) gets the segment appended instead.
pub fn conflict_copy_path(original_rel: &str, short: &str) -> String {
    let (dir, name) = match original_rel.rsplit_once('/') {
        Some((dir, name)) => (Some(dir), name),
        None => (None, original_rel),
    };
    let renamed = match name.rsplit_once('.') {
        // A leading dot is part of the name (`.gitignore`), not an extension.
        Some((stem, ext)) if !stem.is_empty() => format!("{stem}.conflict.{short}.{ext}"),
        _ => format!("{name}.conflict.{short}"),
    };
    match dir {
        Some(dir) => format!("{dir}/{renamed}"),
        None => renamed,
    }
}

/// True when `file_name` carries a `.conflict.<7 hex>` segment — the inverse
/// of [`conflict_copy_path`], used by [`find_conflict_copies`].
pub fn is_conflict_copy_name(file_name: &str) -> bool {
    let parts: Vec<&str> = file_name.split('.').collect();
    parts.windows(2).any(|pair| {
        pair[0] == "conflict"
            && pair[1].len() == SHORT_ID_LEN
            && pair[1]
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    })
}

/// The bytes to write for a Conflict Copy of `original_rel` (D5).
///
/// A markdown file whose frontmatter parses gets a fresh `id`, its title
/// suffixed with `(conflict <shortid>)` — a verbatim title would make every
/// `[[Original Title]]` link ambiguous — and a `conflict_of` extra naming the
/// original. Everything else (type, project, tags, aliases, timestamps, other
/// extras) is copied. Anything else — unparseable markdown, binary — is
/// copied byte for byte.
pub fn conflict_copy_content(original_rel: &str, theirs: &[u8], short: &str) -> Vec<u8> {
    if !original_rel.ends_with(".md") {
        return theirs.to_vec();
    }
    let Ok(text) = std::str::from_utf8(theirs) else {
        return theirs.to_vec();
    };
    // `parse_frontmatter` (crates/clep-vault/src/page.rs) returns `(PageMeta, body)` and
    // is strict: no frontmatter, a missing id or a mistyped system field all
    // mean "copy it raw".
    let Ok((mut meta, body)) = parse_frontmatter(text) else {
        return theirs.to_vec();
    };
    meta.id = Uuid::now_v7();
    let base = meta
        .title
        .clone()
        .unwrap_or_else(|| file_stem(original_rel).to_string());
    meta.title = Some(format!("{base} (conflict {short})"));
    // `conflict_of` leads the extras: `write_page_content` emits them in
    // insertion order, and a TOML table has to follow every bare key.
    let mut extra = ExtraMap::new();
    extra.insert(
        "conflict_of".to_string(),
        toml::Value::String(original_rel.to_string()),
    );
    for (key, value) in std::mem::take(&mut meta.extra) {
        if key != "conflict_of" {
            extra.insert(key, value);
        }
    }
    meta.extra = extra;
    write_page_content(&meta, &body).into_bytes()
}

/// Both sides of a Conflict Copy in a form a line diff can compare: the
/// original's text and the copy's text, with the copy-only noise
/// [`conflict_copy_content`] added taken back out.
///
/// Each side is parsed and re-serialised with `write_page_content`, so
/// frontmatter formatting never shows as a difference. On both sides `id` is
/// the original's and `updated_at` is dropped. On the copy, `conflict_of` is
/// dropped and a trailing ` (conflict <shortid>)` title suffix is removed; a
/// title that was only the file-stem fallback becomes absent again when the
/// original has none. Fails when either side's frontmatter does not parse.
pub fn comparable_pair(original: &str, copy: &str) -> Result<(String, String), FrontmatterError> {
    let (mut local, local_body) = parse_frontmatter(original)?;
    let (mut other, other_body) = parse_frontmatter(copy)?;
    local.updated_at = None;
    other.updated_at = None;
    other.id = local.id;
    let original_rel = other
        .extra
        .remove("conflict_of")
        .and_then(|value| value.as_str().map(str::to_owned));
    other.title = other
        .title
        .map(|title| strip_conflict_suffix(&title).to_owned());
    if local.title.is_none()
        && let (Some(title), Some(rel)) = (other.title.as_deref(), original_rel.as_deref())
        && title == file_stem(rel)
    {
        other.title = None;
    }
    Ok((
        write_page_content(&local, &local_body),
        write_page_content(&other, &other_body),
    ))
}

/// `Plan (conflict abc1234)` -> `Plan`; any other title is returned as is.
fn strip_conflict_suffix(title: &str) -> &str {
    let Some(rest) = title.strip_suffix(')') else {
        return title;
    };
    let Some((base, short)) = rest.rsplit_once(" (conflict ") else {
        return title;
    };
    let is_short_id = short.len() == SHORT_ID_LEN
        && short
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
    if is_short_id { base } else { title }
}

/// Write the Conflict Copy of `original_rel` under `root`, returning the
/// pair of vault-relative paths.
///
/// The copy is published with [`atomic_create`], so a copy already at that
/// path is kept as it is: the name is derived from `theirs`, so an existing
/// copy holds the same remote version (possibly already edited by the user)
/// and re-running a merge never clobbers it.
pub fn write_conflict_copy(
    root: &Path,
    original_rel: &str,
    theirs: &[u8],
) -> Result<ConflictCopy, SyncError> {
    let short = short_id(theirs);
    let rel = conflict_copy_path(original_rel, &short);
    let path = root.join(&rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| SyncError::io(parent, e))?;
    }
    let content = conflict_copy_content(original_rel, theirs, &short);
    match atomic_create(&path, &content) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            tracing::debug!("conflict copy {rel} already exists; keeping it");
        }
        Err(e) => return Err(SyncError::io(&path, e.into_inner())),
    }
    Ok(ConflictCopy {
        original: original_rel.to_string(),
        copy: rel,
    })
}

/// Every Conflict Copy under `root`, vault-relative and sorted. Skips
/// `.git`, which holds no vault content.
pub fn find_conflict_copies(root: &Path) -> Vec<String> {
    let mut found: Vec<String> = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|entry| entry.depth() == 0 || entry.file_name() != ".git")
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| is_conflict_copy_name(&entry.file_name().to_string_lossy()))
        .filter_map(|entry| {
            entry
                .path()
                .strip_prefix(root)
                .ok()
                .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        })
        .collect();
    found.sort();
    found
}

/// `notes/plan.md` -> `plan`.
pub(crate) fn file_stem(rel: &str) -> &str {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.strip_suffix(".md").unwrap_or(name)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn short_id_is_seven_hex_and_deterministic() {
        let a = short_id(b"theirs");
        assert_eq!(a.len(), 7);
        assert!(
            a.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        assert_eq!(a, short_id(b"theirs"));
        assert_ne!(a, short_id(b"other"));
    }

    #[test]
    fn copy_paths_keep_dir_and_extension() {
        assert_eq!(
            conflict_copy_path("notes/foo.md", "abc1234"),
            "notes/foo.conflict.abc1234.md"
        );
        assert_eq!(
            conflict_copy_path("_attachments/x.png", "abc1234"),
            "_attachments/x.conflict.abc1234.png"
        );
        assert_eq!(
            conflict_copy_path("Makefile", "abc1234"),
            "Makefile.conflict.abc1234"
        );
        assert!(is_conflict_copy_name("foo.conflict.abc1234.md"));
        assert!(!is_conflict_copy_name("foo.conflict.md"));
        assert!(!is_conflict_copy_name("20260827.2026-08-27.ab12cd34.md"));
    }

    #[test]
    fn dated_journal_copy_is_not_a_canonical_filename() {
        let copy = conflict_copy_path("journals/20260827.2026-08-27.ab12cd34.md", "abc1234");
        let stem = copy.rsplit('/').next().unwrap();
        assert!(!clep_vault::path::is_canonical_page_filename(stem));
    }

    #[test]
    fn markdown_copy_gets_fresh_id_suffixed_title_and_conflict_of() {
        let theirs = "+++\nid = \"0192b6c0-0000-7000-8000-0000000000aa\"\ntitle = \"Plan\"\ntype = \"NOTE\"\ntags = [\"x\"]\nproject = \"p\"\n+++\ntheirs body\n";
        let out = conflict_copy_content("notes/plan.md", theirs.as_bytes(), "abc1234");
        let page = clep_vault::page::parse_frontmatter(std::str::from_utf8(&out).unwrap()).unwrap();
        assert_ne!(
            page.0.id.to_string(),
            "0192b6c0-0000-7000-8000-0000000000aa"
        );
        assert_eq!(page.0.title.as_deref(), Some("Plan (conflict abc1234)"));
        assert_eq!(page.0.tags, vec!["x".to_string()]);
        assert_eq!(page.0.project.as_deref(), Some("p"));
        assert_eq!(
            page.0.extra.get("conflict_of").and_then(|v| v.as_str()),
            Some("notes/plan.md")
        );
        assert_eq!(page.1.trim(), "theirs body");
    }

    #[test]
    fn unparseable_markdown_and_binary_files_are_copied_raw() {
        assert_eq!(
            conflict_copy_content("n.md", b"no frontmatter here", "abc1234"),
            b"no frontmatter here"
        );
        assert_eq!(
            conflict_copy_content("a.png", &[0, 1, 2], "abc1234"),
            vec![0, 1, 2]
        );
    }

    const ORIGINAL: &str = "+++\nid = \"0192b6c0-0000-7000-8000-0000000000aa\"\ntitle = \"Plan\"\ntype = \"NOTE\"\ntags = [\"x\"]\ncreated_at = 2026-09-01T10:00:00Z\nupdated_at = 2026-09-02T10:00:00Z\nstatus = \"draft\"\n+++\nline one\nline two\n";

    fn copy_of(theirs: &str) -> String {
        String::from_utf8(conflict_copy_content(
            "notes/plan.md",
            theirs.as_bytes(),
            "abc1234",
        ))
        .unwrap()
    }

    #[test]
    fn comparable_pair_of_an_unchanged_copy_is_identical() {
        let (local, other) = comparable_pair(ORIGINAL, &copy_of(ORIGINAL)).unwrap();
        assert_eq!(local, other);
        assert!(local.contains("title = \"Plan\""), "{local}");
        assert!(
            local.contains("0192b6c0-0000-7000-8000-0000000000aa"),
            "{local}"
        );
        assert!(!local.contains("conflict_of"), "{local}");
        assert!(!local.contains("updated_at"), "{local}");
        assert!(local.contains("status = \"draft\""), "{local}");
    }

    #[test]
    fn comparable_pair_shows_a_body_edit_only_in_the_body() {
        let theirs = ORIGINAL.replace("line two", "line 2");
        let (local, other) = comparable_pair(ORIGINAL, &copy_of(&theirs)).unwrap();
        let fm = |text: &str| text[..text.rfind("+++").unwrap()].to_string();
        assert_eq!(fm(&local), fm(&other));
        assert!(local.ends_with("line one\nline two\n"), "{local}");
        assert!(other.ends_with("line one\nline 2\n"), "{other}");
    }

    #[test]
    fn comparable_pair_drops_updated_at_differences() {
        let theirs = ORIGINAL.replace("2026-09-02T10:00:00Z", "2026-09-20T08:30:00Z");
        let (local, other) = comparable_pair(ORIGINAL, &copy_of(&theirs)).unwrap();
        assert_eq!(local, other);
    }

    #[test]
    fn comparable_pair_keeps_a_title_that_only_mentions_conflict() {
        let original = ORIGINAL.replace("title = \"Plan\"", "title = \"Plan (conflict notes)\"");
        let (local, other) = comparable_pair(&original, &copy_of(&original)).unwrap();
        assert_eq!(local, other);
        assert!(
            other.contains("title = \"Plan (conflict notes)\""),
            "{other}"
        );
    }

    #[test]
    fn comparable_pair_restores_an_absent_title() {
        let original = ORIGINAL.replace("title = \"Plan\"\n", "");
        let copy = copy_of(&original);
        assert!(
            copy.contains("title = \"plan (conflict abc1234)\""),
            "{copy}"
        );
        let (local, other) = comparable_pair(&original, &copy).unwrap();
        assert_eq!(local, other);
        assert!(!other.contains("title"), "{other}");
    }

    #[test]
    fn comparable_pair_rejects_unparseable_sides() {
        assert!(comparable_pair("no frontmatter", &copy_of(ORIGINAL)).is_err());
        assert!(comparable_pair(ORIGINAL, "no frontmatter").is_err());
    }

    #[test]
    fn write_is_idempotent_and_find_lists_copies() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("notes")).unwrap();
        fs::write(tmp.path().join("notes/plan.md"), "ours").unwrap();
        let first = write_conflict_copy(
            tmp.path(),
            "notes/plan.md",
            b"+++\nid = \"0192b6c0-0000-7000-8000-0000000000aa\"\ntitle = \"Plan\"\n+++\nt\n",
        )
        .unwrap();
        let before = fs::read(tmp.path().join(&first.copy)).unwrap();
        let second = write_conflict_copy(
            tmp.path(),
            "notes/plan.md",
            b"+++\nid = \"0192b6c0-0000-7000-8000-0000000000aa\"\ntitle = \"Plan\"\n+++\nt\n",
        )
        .unwrap();
        assert_eq!(first.copy, second.copy);
        assert_eq!(
            fs::read(tmp.path().join(&second.copy)).unwrap(),
            before,
            "existing copy is kept (same id)"
        );
        assert_eq!(find_conflict_copies(tmp.path()), vec![first.copy.clone()]);
    }
}
