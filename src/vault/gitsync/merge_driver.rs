//! `clep merge-driver`: the git merge driver for `*.md` (spec §5, D17/D18).
//!
//! Frontmatter merges structurally — `updated_at` max, `created_at` min,
//! tags/aliases as 3-way sets, every other field and extra key field-wise —
//! and the body as an ordinary 3-way text merge (`git merge-file`). Anything
//! irreconcilable exits 1 with a predictable `%A`: the engine then resolves
//! the path with a Conflict Copy (ADR 0004), and hand-run git leaves the
//! user a file the conflict-marker guard understands.

use std::path::Path;
use std::process::Command;

use chrono::{DateTime, Utc};

use crate::vault::page::{ExtraMap, PageMeta, parse_frontmatter, write_page_content};

/// What the driver leaves in `%A` and how it exits (D17).
#[derive(Debug)]
pub struct DriverOutcome {
    pub content: Vec<u8>,
    /// `true` -> exit 0 (merged clean); `false` -> exit 1 (residual conflict).
    pub clean: bool,
}

/// Merge one path's three sides (D18).
pub fn merge(base: &[u8], ours: &[u8], theirs: &[u8]) -> DriverOutcome {
    let conflict = || DriverOutcome {
        content: ours.to_vec(),
        clean: false,
    };
    let parse = |bytes: &[u8]| -> Option<(PageMeta, String)> {
        let text = std::str::from_utf8(bytes).ok()?;
        parse_frontmatter(text).ok()
    };
    let (Some((ours_meta, ours_body)), Some((theirs_meta, theirs_body))) =
        (parse(ours), parse(theirs))
    else {
        // Not two structured pages: a plain whole-file 3-way text merge.
        return match text_merge(base, ours, theirs) {
            Some((content, clean)) => DriverOutcome { content, clean },
            None => conflict(),
        };
    };
    if ours_meta.id != theirs_meta.id {
        // Two different pages at one path — nothing structural to say.
        return conflict();
    }
    if (ours_meta.encryption.is_some() || theirs_meta.encryption.is_some())
        && ours_body != theirs_body
    {
        // Marker-mangled age payloads are unrecoverable; always Conflict Copy.
        return conflict();
    }
    let base_page = parse(base);
    let Some(meta) = merge_meta(base_page.as_ref().map(|(m, _)| m), &ours_meta, &theirs_meta)
    else {
        return conflict();
    };
    let base_body = base_page.as_ref().map(|(_, b)| b.as_str()).unwrap_or("");
    let Some((body, clean)) = text_merge(
        base_body.as_bytes(),
        ours_body.as_bytes(),
        theirs_body.as_bytes(),
    ) else {
        return conflict();
    };
    let body = String::from_utf8_lossy(&body);
    DriverOutcome {
        content: write_page_content(&meta, &body).into_bytes(),
        clean,
    }
}

/// The CLI entry (D17): read the three files git hands a merge driver, leave
/// the result in `%A`, exit 0 clean / 1 conflict. Internal failures leave
/// `%A` untouched and exit 1 — git then treats the path as conflicted.
pub fn run_cli(base: &Path, ours: &Path, theirs: &Path) -> i32 {
    let (Ok(b), Ok(o), Ok(t)) = (
        std::fs::read(base),
        std::fs::read(ours),
        std::fs::read(theirs),
    ) else {
        return 1;
    };
    let outcome = merge(&b, &o, &t);
    if std::fs::write(ours, &outcome.content).is_err() {
        return 1;
    }
    if outcome.clean { 0 } else { 1 }
}

/// 3-way text merge via `git merge-file -p`. `Some((output, clean))`, or
/// `None` when git itself could not run (treated as a conflict upstream).
fn text_merge(base: &[u8], ours: &[u8], theirs: &[u8]) -> Option<(Vec<u8>, bool)> {
    let dir = tempfile::tempdir().ok()?;
    let write = |name: &str, bytes: &[u8]| {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).ok().map(|_| path)
    };
    let (b, o, t) = (
        write("base", base)?,
        write("ours", ours)?,
        write("theirs", theirs)?,
    );
    let out = Command::new("git")
        .args([
            "merge-file",
            "-p",
            "-L",
            "ours",
            "-L",
            "base",
            "-L",
            "theirs",
        ])
        .arg(&o)
        .arg(&b)
        .arg(&t)
        .output()
        .ok()?;
    match out.status.code() {
        Some(0) => Some((out.stdout, true)),
        // Positive exit = number of conflict hunks; negative/None = error.
        Some(code) if code > 0 && code < 128 => Some((out.stdout, false)),
        _ => None,
    }
}

/// Field-wise 3-way frontmatter merge; `None` means a field both sides
/// changed to different values — the whole file is a residual conflict.
fn merge_meta(base: Option<&PageMeta>, ours: &PageMeta, theirs: &PageMeta) -> Option<PageMeta> {
    let mut meta = ours.clone();
    meta.title = scalar3(base.map(|b| &b.title), &ours.title, &theirs.title)?;
    meta.kind = scalar3(base.map(|b| &b.kind), &ours.kind, &theirs.kind)?;
    meta.project = scalar3(base.map(|b| &b.project), &ours.project, &theirs.project)?;
    meta.readonly = scalar3(base.map(|b| &b.readonly), &ours.readonly, &theirs.readonly)?;
    meta.encryption = scalar3(
        base.map(|b| &b.encryption),
        &ours.encryption,
        &theirs.encryption,
    )?;
    meta.tags = set3(
        base.map(|b| b.tags.as_slice()).unwrap_or(&[]),
        &ours.tags,
        &theirs.tags,
    );
    meta.aliases = set3(
        base.map(|b| b.aliases.as_slice()).unwrap_or(&[]),
        &ours.aliases,
        &theirs.aliases,
    );
    meta.created_at = min_time(ours.created_at, theirs.created_at);
    meta.updated_at = max_time(ours.updated_at, theirs.updated_at);
    meta.extra = merge_extras(base.map(|b| &b.extra), &ours.extra, &theirs.extra)?;
    Some(meta)
}

fn scalar3<T: PartialEq + Clone>(base: Option<&T>, ours: &T, theirs: &T) -> Option<T> {
    if ours == theirs {
        return Some(ours.clone());
    }
    match base {
        Some(b) if b == ours => Some(theirs.clone()),
        Some(b) if b == theirs => Some(ours.clone()),
        // No usable base (add/add, unparseable) or both changed.
        _ => None,
    }
}

/// 3-way set merge: start from base, honour both sides' removals, keep both
/// sides' additions; survivors keep ours' order, then theirs' additions.
fn set3(base: &[String], ours: &[String], theirs: &[String]) -> Vec<String> {
    let removed: Vec<&String> = base
        .iter()
        .filter(|v| !ours.contains(v) || !theirs.contains(v))
        .collect();
    let keep = |v: &String| !removed.contains(&v);
    let mut out: Vec<String> = ours.iter().filter(|v| keep(v)).cloned().collect();
    for value in theirs {
        if keep(value) && !out.contains(value) {
            out.push(value.clone());
        }
    }
    out
}

fn merge_extras(base: Option<&ExtraMap>, ours: &ExtraMap, theirs: &ExtraMap) -> Option<ExtraMap> {
    let empty = ExtraMap::new();
    let base = base.unwrap_or(&empty);
    let mut keys: Vec<&String> = ours.keys().collect();
    keys.extend(theirs.keys().filter(|k| !ours.contains_key(*k)));
    let mut out = ExtraMap::new();
    for key in keys {
        // A key absent on a side is `None`: an addition merges in, a
        // deletion sticks, and add-vs-edit disagreement conflicts.
        let merged = scalar3(
            Some(&base.get(key).cloned()),
            &ours.get(key).cloned(),
            &theirs.get(key).cloned(),
        )?;
        if let Some(value) = merged {
            out.insert(key.clone(), value);
        }
    }
    Some(out)
}

fn max_time(a: Option<DateTime<Utc>>, b: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

fn min_time(a: Option<DateTime<Utc>>, b: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(id_tail: &str, extra_fm: &str, body: &str) -> Vec<u8> {
        format!("+++\nid = \"0192b6c0-0000-7000-8000-0000000000{id_tail}\"\n{extra_fm}+++\n{body}")
            .into_bytes()
    }

    #[test]
    fn disjoint_field_and_body_edits_merge_clean() {
        let base = page("01", "title = \"T\"\ntags = [\"a\"]\n", "one\ntwo\nthree\n");
        let ours = page(
            "01",
            "title = \"T\"\ntags = [\"a\", \"b\"]\n",
            "ONE\ntwo\nthree\n",
        );
        let theirs = page(
            "01",
            "title = \"Renamed\"\ntags = [\"a\", \"c\"]\n",
            "one\ntwo\nTHREE\n",
        );
        let out = merge(&base, &ours, &theirs);
        assert!(out.clean);
        let text = String::from_utf8(out.content).unwrap();
        let (meta, body) = crate::vault::page::parse_frontmatter(&text).unwrap();
        assert_eq!(meta.title.as_deref(), Some("Renamed"));
        assert_eq!(meta.tags, vec!["a", "b", "c"]);
        assert_eq!(body, "ONE\ntwo\nTHREE\n");
    }

    #[test]
    fn tag_removals_are_honoured() {
        let base = page("02", "tags = [\"keep\", \"drop\"]\n", "b\n");
        let ours = page("02", "tags = [\"keep\"]\n", "b\n");
        let theirs = page("02", "tags = [\"keep\", \"drop\", \"new\"]\n", "b\n");
        let out = merge(&base, &ours, &theirs);
        assert!(out.clean);
        let (meta, _) =
            crate::vault::page::parse_frontmatter(std::str::from_utf8(&out.content).unwrap())
                .unwrap();
        assert_eq!(meta.tags, vec!["keep", "new"]);
    }

    #[test]
    fn updated_at_takes_the_max_created_at_the_min() {
        let base = page(
            "03",
            "created_at = 2026-01-01T00:00:00Z\nupdated_at = 2026-01-01T00:00:00Z\n",
            "b\n",
        );
        let ours = page(
            "03",
            "created_at = 2026-01-01T00:00:00Z\nupdated_at = 2026-02-01T00:00:00Z\n",
            "b\n",
        );
        let theirs = page(
            "03",
            "created_at = 2025-12-01T00:00:00Z\nupdated_at = 2026-03-01T00:00:00Z\n",
            "b\n",
        );
        let out = merge(&base, &ours, &theirs);
        assert!(out.clean);
        let (meta, _) =
            crate::vault::page::parse_frontmatter(std::str::from_utf8(&out.content).unwrap())
                .unwrap();
        assert_eq!(
            meta.updated_at.unwrap().to_rfc3339(),
            "2026-03-01T00:00:00+00:00"
        );
        assert_eq!(
            meta.created_at.unwrap().to_rfc3339(),
            "2025-12-01T00:00:00+00:00"
        );
    }

    #[test]
    fn both_changed_scalar_is_a_conflict_with_ours_verbatim() {
        let base = page("04", "title = \"T\"\n", "b\n");
        let ours = page("04", "title = \"Ours\"\n", "b\n");
        let theirs = page("04", "title = \"Theirs\"\n", "b\n");
        let out = merge(&base, &ours, &theirs);
        assert!(!out.clean);
        assert_eq!(out.content, ours);
    }

    #[test]
    fn body_conflict_outputs_markers_and_exit_one() {
        let base = page("05", "", "line\n");
        let ours = page("05", "", "ours line\n");
        let theirs = page("05", "", "theirs line\n");
        let out = merge(&base, &ours, &theirs);
        assert!(!out.clean);
        let text = String::from_utf8(out.content).unwrap();
        assert!(text.starts_with("+++\n"), "frontmatter survives: {text}");
        assert!(crate::vault::conflict::has_conflict_markers(&text));
    }

    #[test]
    fn different_ids_are_a_conflict() {
        let ours = page("06", "", "b\n");
        let theirs = page("07", "", "b\n");
        let out = merge(b"", &ours, &theirs);
        assert!(!out.clean);
        assert_eq!(out.content, ours);
    }

    #[test]
    fn encrypted_bodies_never_text_merge() {
        // Two distinct, canonically-armored age bodies: real armor is
        // required because `parse_frontmatter` validates it on every parse
        // (see `validate_encrypted_body` in src/vault/page.rs). Each payload
        // decodes to a valid `age-encryption.org/v1` header — the only
        // thing `validate_age_armor` checks beyond canonical shape — and is
        // a single base64 line, well under the 64-char wrap width, so no
        // multi-line rewrapping is needed for canonicalization to be a
        // no-op. Pattern mirrors the existing fixture in
        // src/vault/query.rs's `encryption_fixture`.
        const ARMOR_A: &str = "-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSB0ZXN0LUEKLS0tCloK\n-----END AGE ENCRYPTED FILE-----\n";
        const ARMOR_B: &str = "-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSB0ZXN0LUIKLS0tCloK\n-----END AGE ENCRYPTED FILE-----\n";
        let fm = "[encryption]\nformat = \"age\"\nversion = 1\nkey_id = \"test-key\"\n";
        let base = page("08", fm, ARMOR_A);
        let ours = page("08", fm, ARMOR_A);
        let theirs = page("08", fm, ARMOR_B);
        let out = merge(&base, &ours, &theirs);
        assert!(!out.clean);
        assert_eq!(out.content, ours);
    }

    #[test]
    fn non_page_files_fall_back_to_plain_text_merge() {
        // A context line separates the two edits: `git merge-file` treats
        // adjacent changed lines with no unchanged line between them as one
        // conflicting region (verified against real git 2.55), so the
        // fixture needs a shared middle line to exercise a clean 3-way
        // text merge, same as every frontmatter-body fixture above.
        let out = merge(b"a\nx\nb\n", b"A\nx\nb\n", b"a\nx\nB\n");
        assert!(out.clean);
        assert_eq!(out.content, b"A\nx\nB\n");
    }

    #[test]
    fn extras_merge_per_key() {
        let base = page("09", "custom = \"x\"\n", "b\n");
        let ours = page("09", "custom = \"x\"\nmine = 1\n", "b\n");
        let theirs = page("09", "custom = \"y\"\n", "b\n");
        let out = merge(&base, &ours, &theirs);
        assert!(out.clean);
        let (meta, _) =
            crate::vault::page::parse_frontmatter(std::str::from_utf8(&out.content).unwrap())
                .unwrap();
        assert_eq!(meta.extra.get("custom").and_then(|v| v.as_str()), Some("y"));
        assert_eq!(meta.extra.get("mine").and_then(|v| v.as_integer()), Some(1));
    }

    #[test]
    fn run_cli_writes_result_over_ours_and_exits_by_cleanliness() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, bytes: &[u8]| {
            let p = dir.path().join(name);
            std::fs::write(&p, bytes).unwrap();
            p
        };
        let b = write("base", &page("0a", "tags = [\"a\"]\n", "x\n"));
        let o = write("ours", &page("0a", "tags = [\"a\", \"b\"]\n", "x\n"));
        let t = write("theirs", &page("0a", "tags = [\"a\", \"c\"]\n", "x\n"));
        assert_eq!(run_cli(&b, &o, &t), 0);
        let merged = std::fs::read_to_string(&o).unwrap();
        assert!(merged.contains("\"b\"") && merged.contains("\"c\""));
        // Missing file -> exit 1, ours untouched.
        assert_eq!(run_cli(&dir.path().join("nope"), &o, &t), 1);
    }
}
