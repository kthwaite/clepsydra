//! One-time migration to petname codes (docs/adr/0003): rename every
//! TASK/CYCLE page whose filename stem is not a valid code, rewriting
//! wikilinks through the move planner, then rewrite plain-text legacy
//! tokens (`TSK-0072`, `S-3`) across every page. Dry run by default.
//! This module is the ONLY place that recognizes the legacy format.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use regex::Regex;

use super::Vault;
use super::atomic_file::atomic_replace;
use super::code::{self, CodeFamily};
use super::conflict::has_conflict_markers;
use super::index::{IndexError, VaultIndex};
use super::kind::Kind;
use super::page::parse_or_repair_frontmatter;
use super::path::VaultPath;
use super::reconcile::move_page_to;

/// Matches a bare legacy code anywhere in prose or frontmatter text:
/// `TSK-0072` (exactly 4 digits) or `S-3` (one or more digits).
static LEGACY_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(TSK-\d{4}|S-\d+)\b").expect("static regex"));

/// Outcome of a [`recode`] run.
#[derive(Debug, Default)]
pub struct RecodeReport {
    /// Pages renamed to a petname code: `(old path, new path)`.
    pub renamed: Vec<(String, String)>,
    /// Pages whose text held rewritten legacy tokens: `(path, tokens replaced)`.
    pub rewritten: Vec<(String, usize)>,
    pub warnings: Vec<String>,
    pub dry_run: bool,
}

/// Migrate the vault from sequential TASK/CYCLE codes to petname codes.
///
/// Two passes:
/// 1. Rename every TASK/CYCLE page whose filename stem is not already a
///    valid code (`code::is_valid_code`), routed through
///    [`move_page_to`] so inbound `[[wikilinks]]` are rewritten by the move
///    planner.
/// 2. Rewrite every plain-text legacy token (`TSK-0072`, `S-3`) vault-wide —
///    including inside frontmatter values such as `cycle = "S-3"`, which the
///    move planner does not touch — using the map of legacy stem to newly
///    minted code built in pass 1. A legacy token with no corresponding
///    renamed page is left alone and reported as a warning.
///
/// Dry run by default (`write = false`): plans and reports fully (codes are
/// minted so the report is realistic) but touches nothing on disk. A second
/// dry run mints different codes for the same plan; that's expected. Pages
/// already on the code scheme are left alone. A page with merge-conflict
/// markers, or one that is encrypted, is skipped with a warning rather than
/// rewritten.
pub fn recode(
    vault: &Vault,
    index: &mut VaultIndex,
    write: bool,
) -> Result<RecodeReport, IndexError> {
    let mut report = RecodeReport {
        dry_run: !write,
        ..Default::default()
    };

    // 1. Plan renames: every TASK/CYCLE page whose stem is not already a code.
    let rows: Vec<(String, String)> = {
        let mut stmt = index.connection().prepare(
            "SELECT path, kind FROM pages WHERE kind IN ('TASK', 'CYCLE') ORDER BY path",
        )?;
        stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<_, _>>()?
    };

    // Codes already in use (valid or legacy) so freshly minted codes never
    // collide with an existing TASK/CYCLE stem.
    let mut taken: BTreeSet<String> = BTreeSet::new();
    for (path, _) in &rows {
        let vp = VaultPath::new(path).map_err(|e| IndexError::Other(e.to_string()))?;
        taken.insert(vp.stem().to_string());
    }

    let mut mapping: BTreeMap<String, String> = BTreeMap::new(); // legacy stem -> new code
    let mut planned: Vec<(String, String)> = Vec::new(); // (old path, new path)
    for (path, kind) in rows {
        let vp = VaultPath::new(&path).map_err(|e| IndexError::Other(e.to_string()))?;
        let stem = vp.stem();
        if code::is_valid_code(stem) {
            continue;
        }
        let kind =
            Kind::from_token(&kind).expect("pages.kind column always holds a valid Kind token");
        let family = CodeFamily::from_kind(kind).expect("query filtered to TASK/CYCLE");
        let new_code = loop {
            let candidate = code::mint(family);
            if taken.insert(candidate.clone()) {
                break candidate;
            }
        };
        let new_path = match vp.parent() {
            Some(parent) => format!("{parent}/{new_code}.md"),
            None => format!("{new_code}.md"),
        };
        if is_legacy_stem(stem) {
            mapping.insert(stem.to_string(), new_code.clone());
        }
        planned.push((path, new_path));
    }

    // 2. Execute renames (wikilinks rewritten by the move planner).
    for (old, new) in &planned {
        if write {
            match move_page_to(vault, index, old, new, &[])? {
                Some(_) => report.renamed.push((old.clone(), new.clone())),
                None => report.warnings.push(format!(
                    "{old}: destination {new} already exists; not renamed"
                )),
            }
        } else {
            report.renamed.push((old.clone(), new.clone()));
        }
    }

    // 3. Rewrite plain-text legacy tokens everywhere (frontmatter included —
    //    `cycle = "S-1"` is exactly such a token). Re-queried AFTER the
    //    renames so rewritten pages are read at their new paths.
    let all_paths: Vec<String> = {
        let mut stmt = index
            .connection()
            .prepare("SELECT path FROM pages ORDER BY path")?;
        stmt.query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<_, _>>()?
    };

    for path in all_paths {
        let vp = VaultPath::new(&path).map_err(|e| IndexError::Other(e.to_string()))?;
        let abs = vault.resolve(&vp);
        let Ok(content) = std::fs::read_to_string(&abs) else {
            report.warnings.push(format!("{path}: cannot read"));
            continue;
        };
        if !LEGACY_TOKEN.is_match(&content) {
            continue;
        }
        if has_conflict_markers(&content) {
            report
                .warnings
                .push(format!("{path}: contains merge conflict markers; skipped"));
            continue;
        }
        let (meta, _, _, _) = parse_or_repair_frontmatter(&content);
        if meta.encryption.is_some() {
            report.warnings.push(format!("{path}: encrypted; skipped"));
            continue;
        }

        let mut count = 0usize;
        let mut unknown: BTreeSet<String> = BTreeSet::new();
        let rewritten = LEGACY_TOKEN.replace_all(&content, |caps: &regex::Captures| {
            let tok = &caps[0];
            match mapping.get(tok) {
                Some(new) => {
                    count += 1;
                    new.clone()
                }
                None => {
                    unknown.insert(tok.to_string());
                    tok.to_string()
                }
            }
        });
        for tok in unknown {
            report.warnings.push(format!(
                "{path}: legacy token {tok} has no recoded page; left as is"
            ));
        }
        if count == 0 {
            continue;
        }
        if write {
            atomic_replace(&abs, rewritten.as_bytes())
                .map_err(|e| IndexError::Other(e.to_string()))?;
        }
        report.rewritten.push((path, count));
    }

    // 4. Reindex so bodies, links and canonical names reflect the rewrites.
    if write {
        index.build(vault)?;
        index.resolve_links()?;
    }

    Ok(report)
}

/// Whether `stem` matches the legacy `TSK-0072` / `S-3` filename shape
/// exactly (as opposed to merely containing one, which `LEGACY_TOKEN` tests).
fn is_legacy_stem(stem: &str) -> bool {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(TSK-\d{4}|S-\d+)$").expect("static regex"));
    RE.is_match(stem)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::code::is_valid_code;

    const TASK_A: &str = "+++\nid = \"01900000-0000-7000-8000-00000000000a\"\ntitle = \"A\"\ntype = \"TASK\"\ncreated_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\nstatus = \"INTAKE\"\ncycle = \"S-1\"\n+++\nSee TSK-0002 and [[TSK-0002]].\n";
    const TASK_B: &str = "+++\nid = \"01900000-0000-7000-8000-00000000000b\"\ntitle = \"B\"\ntype = \"TASK\"\ncreated_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\nstatus = \"INTAKE\"\n+++\nbody\n";
    const CYCLE_1: &str = "+++\nid = \"01900000-0000-7000-8000-00000000000c\"\ntitle = \"One\"\ntype = \"CYCLE\"\ncreated_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\n+++\ncycle body\n";
    const NOTE: &str = "+++\nid = \"01900000-0000-7000-8000-00000000000d\"\ntitle = \"Snags\"\ncreated_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\n+++\nTSK-0001 blocks TSK-0002; TSK-9999 never existed; S-1 is the cycle.\n";

    fn fixture() -> (tempfile::TempDir, Vault, VaultIndex) {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        for (rel, content) in [
            ("tasks/proj/TSK-0001.md", TASK_A),
            ("tasks/proj/TSK-0002.md", TASK_B),
            ("cycles/S-1.md", CYCLE_1),
            ("notes/snags.md", NOTE),
        ] {
            let abs = root.join(rel);
            std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
            std::fs::write(abs, content).unwrap();
        }
        let vault = Vault::open(&root).unwrap();
        let mut index = VaultIndex::open(&tmp.path().join("cache.db")).unwrap();
        index.build(&vault).unwrap();
        index.resolve_links().unwrap();
        (tmp, vault, index)
    }

    fn read(vault: &Vault, rel: &str) -> String {
        std::fs::read_to_string(vault.root().join(rel)).unwrap()
    }

    #[test]
    fn dry_run_plans_everything_and_touches_nothing() {
        let (_tmp, vault, mut index) = fixture();
        let before = read(&vault, "notes/snags.md");
        let report = recode(&vault, &mut index, false).unwrap();
        assert!(report.dry_run);
        assert_eq!(report.renamed.len(), 3, "two tasks + one cycle");
        assert!(
            report
                .rewritten
                .iter()
                .any(|(p, n)| p == "notes/snags.md" && *n == 3)
        );
        assert!(vault.root().join("tasks/proj/TSK-0001.md").exists());
        assert_eq!(read(&vault, "notes/snags.md"), before);
    }

    #[test]
    fn write_renames_rewrites_links_prose_and_cycle_frontmatter() {
        let (_tmp, vault, mut index) = fixture();
        let report = recode(&vault, &mut index, true).unwrap();
        assert_eq!(report.renamed.len(), 3);
        let new_for = |old: &str| -> String {
            let (_, new_path) = report.renamed.iter().find(|(o, _)| o == old).unwrap();
            new_path
                .rsplit('/')
                .next()
                .unwrap()
                .trim_end_matches(".md")
                .to_string()
        };
        let a = new_for("tasks/proj/TSK-0001.md");
        let b = new_for("tasks/proj/TSK-0002.md");
        let s = new_for("cycles/S-1.md");
        assert!(is_valid_code(&a) && is_valid_code(&b) && is_valid_code(&s));
        assert!(!vault.root().join("tasks/proj/TSK-0001.md").exists());
        let a_body = read(&vault, &format!("tasks/proj/{a}.md"));
        assert!(
            a_body.contains(&format!("cycle = \"{s}\"")),
            "frontmatter cycle token rewritten: {a_body}"
        );
        assert!(
            a_body.contains(&format!("[[{b}]]")),
            "wikilink rewritten by the move planner: {a_body}"
        );
        assert!(
            a_body.contains(&format!("See {b} ")),
            "prose token rewritten: {a_body}"
        );
        let note = read(&vault, "notes/snags.md");
        assert!(
            note.contains(&a) && note.contains(&b) && note.contains(&s),
            "{note}"
        );
        assert!(note.contains("TSK-9999"), "unknown legacy token left alone");
        assert!(
            report.warnings.iter().any(|w| w.contains("TSK-9999")),
            "and warned about"
        );
        // second run is a no-op
        let again = recode(&vault, &mut index, true).unwrap();
        assert!(
            again.renamed.is_empty() && again.rewritten.is_empty(),
            "{again:?}"
        );
    }

    #[test]
    fn conflicted_page_is_skipped_with_warning() {
        let (_tmp, vault, mut index) = fixture();
        let clash = vault.root().join("notes/clash.md");
        std::fs::write(
            &clash,
            "+++\ntitle = \"c\"\n+++\n<<<<<<< HEAD\nTSK-0001\n=======\nx\n>>>>>>> theirs\n",
        )
        .unwrap();
        index.build(&vault).unwrap();
        let before = std::fs::read_to_string(&clash).unwrap();
        let report = recode(&vault, &mut index, true).unwrap();
        assert_eq!(std::fs::read_to_string(&clash).unwrap(), before);
        assert!(report.warnings.iter().any(|w| w.contains("notes/clash.md")));
    }

    #[test]
    fn canonical_scheme_task_without_code_gets_one() {
        let (_tmp, vault, mut index) = fixture();
        let rel = "tasks/proj/20260817.some-task.RZ6amN7D.md";
        std::fs::write(vault.root().join(rel), TASK_B).unwrap();
        index.build(&vault).unwrap();
        let report = recode(&vault, &mut index, true).unwrap();
        assert!(report.renamed.iter().any(|(o, n)| o == rel
            && is_valid_code(n.rsplit('/').next().unwrap().trim_end_matches(".md"))));
    }
}
