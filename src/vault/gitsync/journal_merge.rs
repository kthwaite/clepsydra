//! The post-sync journal merger (spec §8 as amended by D20/D21).
//!
//! Sync makes duplicate journal pages routine: each device mints its own
//! filename for the same date (different random suffix), and a conflicted
//! journal leaves a Conflict Copy. Both cases fold into one page here —
//! filesystem-only, so it can run inside the sync window before any index
//! rebuild.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::path::Path;

use chrono::{DateTime, Utc};

use super::conflict_copy::is_conflict_copy_name;
use crate::vault::index::extract_journal_date;
use crate::vault::page::{PageMeta, parse_frontmatter, write_page_content};
use crate::vault::rewriter::rewrite_links_in_content;

/// The two top-level folders whose pages carry a path-derived journal date.
pub(crate) const JOURNAL_FOLDERS: [&str; 2] = ["journals", "ai-journals"];

#[derive(Debug, Clone)]
pub struct JournalGroup {
    pub folder: String,
    pub date: String,
    /// Vault-relative paths, sorted; more than one by construction.
    pub paths: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct JournalMerge {
    pub folder: String,
    pub date: String,
    pub winner: String,
    pub merged: Vec<String>,
}

/// Every `(folder, date)` that more than one page claims.
///
/// A Conflict Copy has no journal date of its own — its name is deliberately
/// not canonical (D5) — so it joins the group of the page its `conflict_of`
/// extra names. A copy whose original is not a journal, or which cannot be
/// read, is ignored.
pub fn duplicate_journal_groups(root: &Path) -> Vec<JournalGroup> {
    let mut groups: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    for folder in JOURNAL_FOLDERS {
        for entry in walkdir::WalkDir::new(root.join(folder))
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "md"))
        {
            let Ok(relative) = entry.path().strip_prefix(root) else {
                continue;
            };
            let rel = relative.to_string_lossy().replace('\\', "/");
            let name = entry.file_name().to_string_lossy().into_owned();
            let date = if is_conflict_copy_name(&name) {
                conflict_of(entry.path())
                    .as_deref()
                    .and_then(extract_journal_date)
            } else {
                extract_journal_date(&rel)
            };
            if let Some(date) = date {
                groups
                    .entry((folder.to_string(), date))
                    .or_default()
                    .push(rel);
            }
        }
    }
    groups
        .into_iter()
        .filter(|(_, paths)| paths.len() > 1)
        .map(|((folder, date), mut paths)| {
            paths.sort();
            JournalGroup {
                folder,
                date,
                paths,
            }
        })
        .collect()
}

/// Fold every duplicate journal group into one page, returning what was
/// folded and any problem worth surfacing.
///
/// Infallible by design: it runs inside the sync window, where a page it
/// cannot read is a reason to leave that page alone, never to fail the sync.
pub fn merge_duplicate_journals(root: &Path) -> (Vec<JournalMerge>, Vec<String>) {
    let mut merges = Vec::new();
    let mut warnings = Vec::new();
    for group in duplicate_journal_groups(root) {
        if let Some(merge) = merge_group(root, &group, &mut warnings) {
            merges.push(merge);
        }
    }
    (merges, warnings)
}

/// One member of a group, parsed.
struct Member {
    /// Vault-relative path.
    path: String,
    meta: PageMeta,
    body: String,
}

/// Fold one group, or `None` when fewer than two of its members could be
/// read (nothing to merge) or the winner could not be written.
fn merge_group(
    root: &Path,
    group: &JournalGroup,
    warnings: &mut Vec<String>,
) -> Option<JournalMerge> {
    let mut members: Vec<Member> = Vec::new();
    for path in &group.paths {
        match read_member(root, path) {
            Ok(member) => members.push(member),
            Err(e) => warnings.push(format!("journal merge: skipping unreadable {path}: {e}")),
        }
    }
    if members.len() < 2 {
        return None;
    }
    members.sort_by(|a, b| {
        let copy_a = is_conflict_copy_name(file_name(&a.path));
        let copy_b = is_conflict_copy_name(file_name(&b.path));
        copy_a
            .cmp(&copy_b) // copies always lose
            .then_with(|| cmp_created(a.meta.created_at, b.meta.created_at)) // None sorts last
            .then_with(|| a.path.cmp(&b.path))
    });
    // Across every member, the winner included, so this only ever moves the
    // stamp forwards.
    let latest = members
        .iter()
        .filter_map(|member| member.meta.updated_at)
        .max();
    let mut winner = members.remove(0);
    let losers = members;

    winner.meta.updated_at = latest;
    // A winner cannot carry `conflict_of` by D21, but a copy that lost its
    // original would keep pointing at a page that is no longer there.
    winner.meta.extra.remove("conflict_of");
    let bodies: Vec<&str> = losers.iter().map(|loser| loser.body.as_str()).collect();
    let content = write_page_content(&winner.meta, &interleave(&winner.body, &bodies));

    // Written before anything is deleted: a failure here must leave every
    // member exactly as it was.
    let winner_path = root.join(&winner.path);
    if let Err(e) = crate::vault::atomic_file::atomic_replace(&winner_path, content.as_bytes()) {
        warnings.push(format!(
            "journal merge: could not write {}: {e}",
            winner.path
        ));
        return None;
    }

    let mut merged = Vec::new();
    for loser in &losers {
        if let Err(e) = std::fs::remove_file(root.join(&loser.path)) {
            // The fold is already in the winner, so the content is safe; the
            // duplicate simply survives to be folded again next time. Its
            // links still resolve, so they are left pointing at it.
            warnings.push(format!(
                "journal merge: folded {} into {} but could not delete it: {e}",
                loser.path, winner.path
            ));
            continue;
        }
        repoint_links(root, &loser.path, &winner.path, warnings);
        merged.push(loser.path.clone());
    }
    Some(JournalMerge {
        folder: group.folder.clone(),
        date: group.date.clone(),
        winner: winner.path,
        merged,
    })
}

fn read_member(root: &Path, rel: &str) -> Result<Member, String> {
    let text = std::fs::read_to_string(root.join(rel)).map_err(|e| e.to_string())?;
    let (meta, body) = parse_frontmatter(&text).map_err(|e| e.to_string())?;
    Ok(Member {
        path: rel.to_string(),
        meta,
        body,
    })
}

/// The `conflict_of` extra of the page at `path`, when it has one.
fn conflict_of(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let (meta, _) = parse_frontmatter(&text).ok()?;
    meta.extra.get("conflict_of")?.as_str().map(str::to_string)
}

/// `journals/plan.md` -> `plan.md`.
fn file_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// Oldest first, with a page that declares no `created_at` sorting last.
fn cmp_created(a: Option<DateTime<Utc>>, b: Option<DateTime<Utc>>) -> Ordering {
    match (a, b) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

#[derive(Debug)]
struct Block {
    time: Option<String>,
    text: String,
}

/// A block is a `- HH:MM — ` entry plus everything up to the next entry
/// (multi-line captures land at column 0 — D20), or a headless run of lines
/// before the first entry.
fn split_blocks(body: &str) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    for line in body.lines() {
        match entry_time(line) {
            Some(time) => blocks.push(Block {
                time: Some(time),
                text: format!("{line}\n"),
            }),
            None => match blocks.last_mut() {
                Some(last) => {
                    last.text.push_str(line);
                    last.text.push('\n');
                }
                None => blocks.push(Block {
                    time: None,
                    text: format!("{line}\n"),
                }),
            },
        }
    }
    blocks
}

/// `- 09:41 — text` -> `Some("09:41")`.
fn entry_time(line: &str) -> Option<String> {
    let rest = line.strip_prefix("- ")?;
    let (time, tail) = rest.split_at_checked(5)?;
    let b = time.as_bytes();
    let shaped = b[0].is_ascii_digit()
        && b[1].is_ascii_digit()
        && b[2] == b':'
        && b[3].is_ascii_digit()
        && b[4].is_ascii_digit();
    (shaped && tail.starts_with(" — ")).then(|| time.to_string())
}

/// Fold each loser's blocks into the winner's: byte-identical blocks
/// (trailing whitespace ignored) dedupe; timed blocks insert after the last
/// block with a time <= theirs; untimed blocks append in source order.
fn interleave(winner: &str, losers: &[&str]) -> String {
    let mut blocks = split_blocks(winner);
    for loser in losers {
        for block in split_blocks(loser) {
            if blocks
                .iter()
                .any(|b| b.text.trim_end() == block.text.trim_end())
            {
                continue;
            }
            match &block.time {
                Some(time) => {
                    let at = blocks
                        .iter()
                        .rposition(|b| b.time.as_deref().is_some_and(|t| t <= time.as_str()))
                        .map(|found| found + 1)
                        .unwrap_or_else(|| {
                            blocks
                                .iter()
                                .position(|b| b.time.is_some())
                                .unwrap_or(blocks.len())
                        });
                    blocks.insert(at, block);
                }
                None => blocks.push(block),
            }
        }
    }
    blocks.into_iter().map(|b| b.text).collect()
}

/// Rewrite stem- and path-form links from a deleted loser to the winner —
/// a filesystem pass, because the merger runs before any index exists.
/// Title links (`[[2026-08-29]]`) already resolve to the winner.
fn repoint_links(root: &Path, loser_rel: &str, winner_rel: &str, warnings: &mut Vec<String>) {
    let stem = |rel: &str| {
        rel.rsplit('/')
            .next()
            .unwrap_or(rel)
            .strip_suffix(".md")
            .unwrap_or(rel)
            .to_string()
    };
    let (old_stem, new_stem) = (stem(loser_rel), stem(winner_rel));
    let pairs = [
        (old_stem.as_str(), new_stem.as_str()),
        (loser_rel, winner_rel),
    ];
    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0 || (e.file_name() != ".git" && e.file_name() != ".clepsydra")
        })
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
    {
        let Ok(content) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        if !content.contains(&old_stem) {
            continue;
        }
        let rewritten = rewrite_links_in_content(&content, &pairs);
        if rewritten != content
            && let Err(e) = std::fs::write(entry.path(), rewritten)
        {
            warnings.push(format!(
                "journal merge: could not rewrite links in {}: {e}",
                entry.path().display()
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn journal(dir: &std::path::Path, name: &str, id_tail: &str, created: &str, body: &str) {
        let path = dir.join("journals").join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            format!(
                "+++\nid = \"0192b6c0-0000-7000-8000-0000000000{id_tail}\"\ntitle = \"2026-08-29\"\ncreated_at = {created}\nupdated_at = {created}\n+++\n{body}"
            ),
        )
        .unwrap();
    }

    #[test]
    fn split_blocks_absorbs_continuation_lines() {
        let blocks = split_blocks("- 09:00 — first\ncontinued\n- 10:30 — second\n\nfree text\n");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].time.as_deref(), Some("09:00"));
        assert_eq!(blocks[0].text, "- 09:00 — first\ncontinued\n");
        assert_eq!(blocks[1].text, "- 10:30 — second\n\nfree text\n");
    }

    #[test]
    fn duplicate_groups_pair_same_folder_and_date_and_fold_conflict_copies() {
        let tmp = TempDir::new().unwrap();
        journal(
            tmp.path(),
            "20260829.2026-08-29.aaaaaaaa.md",
            "01",
            "2026-08-29T08:00:00Z",
            "- 08:00 — a\n",
        );
        journal(
            tmp.path(),
            "20260829.2026-08-29.bbbbbbbb.md",
            "02",
            "2026-08-29T09:00:00Z",
            "- 09:00 — b\n",
        );
        // A conflict copy of the first journal: no journal_date of its own,
        // joined to the group through conflict_of.
        std::fs::write(
            tmp.path()
                .join("journals/20260829.2026-08-29.aaaaaaaa.conflict.abc1234.md"),
            "+++\nid = \"0192b6c0-0000-7000-8000-000000000003\"\ntitle = \"2026-08-29 (conflict abc1234)\"\nconflict_of = \"journals/20260829.2026-08-29.aaaaaaaa.md\"\n+++\n- 08:30 — c\n",
        )
        .unwrap();
        // A different date does not group.
        journal(
            tmp.path(),
            "20260830.2026-08-30.cccccccc.md",
            "04",
            "2026-08-30T08:00:00Z",
            "- 08:00 — d\n",
        );
        let groups = duplicate_journal_groups(tmp.path());
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].date, "2026-08-29");
        assert_eq!(groups[0].paths.len(), 3);
    }

    #[test]
    fn merge_interleaves_dedupes_and_deletes_losers() {
        let tmp = TempDir::new().unwrap();
        journal(
            tmp.path(),
            "20260829.2026-08-29.aaaaaaaa.md",
            "01",
            "2026-08-29T08:00:00Z",
            "- 08:00 — morning\n- 12:00 — noon\n",
        );
        journal(
            tmp.path(),
            "20260829.2026-08-29.bbbbbbbb.md",
            "02",
            "2026-08-29T09:00:00Z",
            "- 08:00 — morning\n- 10:00 — from B\nan appendix line\n",
        );
        let (merges, warnings) = merge_duplicate_journals(tmp.path());
        assert_eq!(warnings, Vec::<String>::new());
        assert_eq!(merges.len(), 1);
        assert_eq!(merges[0].winner, "journals/20260829.2026-08-29.aaaaaaaa.md");
        assert_eq!(
            merges[0].merged,
            vec!["journals/20260829.2026-08-29.bbbbbbbb.md"]
        );
        assert!(
            !tmp.path()
                .join("journals/20260829.2026-08-29.bbbbbbbb.md")
                .exists()
        );
        let text =
            std::fs::read_to_string(tmp.path().join("journals/20260829.2026-08-29.aaaaaaaa.md"))
                .unwrap();
        let (meta, body) = crate::vault::page::parse_frontmatter(&text).unwrap();
        assert_eq!(
            body, "- 08:00 — morning\n- 10:00 — from B\nan appendix line\n- 12:00 — noon\n",
            "deduped, interleaved by time, continuation stays attached"
        );
        assert_eq!(
            meta.updated_at.unwrap().to_rfc3339(),
            "2026-08-29T09:00:00+00:00",
            "max updated_at"
        );
        // Idempotent: nothing left to merge.
        assert!(merge_duplicate_journals(tmp.path()).0.is_empty());
    }

    #[test]
    fn conflict_copies_always_lose_and_stem_links_are_repointed() {
        let tmp = TempDir::new().unwrap();
        journal(
            tmp.path(),
            "20260829.2026-08-29.aaaaaaaa.md",
            "01",
            "2026-08-29T08:00:00Z",
            "- 08:00 — a\n",
        );
        std::fs::write(
            tmp.path()
                .join("journals/20260829.2026-08-29.aaaaaaaa.conflict.abc1234.md"),
            "+++\nid = \"0192b6c0-0000-7000-8000-000000000002\"\ntitle = \"2026-08-29 (conflict abc1234)\"\nconflict_of = \"journals/20260829.2026-08-29.aaaaaaaa.md\"\ncreated_at = 2026-08-29T07:00:00Z\n+++\n- 07:30 — theirs\n",
        )
        .unwrap();
        std::fs::create_dir_all(tmp.path().join("notes")).unwrap();
        std::fs::write(
            tmp.path().join("notes/ref.md"),
            "+++\nid = \"0192b6c0-0000-7000-8000-000000000009\"\ntitle = \"Ref\"\n+++\nsee [[20260829.2026-08-29.aaaaaaaa.conflict.abc1234]]\n",
        )
        .unwrap();
        let (merges, _) = merge_duplicate_journals(tmp.path());
        // The copy is older by created_at but still loses (D21).
        assert_eq!(merges[0].winner, "journals/20260829.2026-08-29.aaaaaaaa.md");
        let winner =
            std::fs::read_to_string(tmp.path().join("journals/20260829.2026-08-29.aaaaaaaa.md"))
                .unwrap();
        assert!(winner.contains("- 07:30 — theirs"), "{winner}");
        let referer = std::fs::read_to_string(tmp.path().join("notes/ref.md")).unwrap();
        assert!(
            referer.contains("[[20260829.2026-08-29.aaaaaaaa]]"),
            "{referer}"
        );
    }

    #[test]
    fn unparseable_member_is_skipped_with_a_warning() {
        let tmp = TempDir::new().unwrap();
        journal(
            tmp.path(),
            "20260829.2026-08-29.aaaaaaaa.md",
            "01",
            "2026-08-29T08:00:00Z",
            "- 08:00 — a\n",
        );
        std::fs::write(tmp.path().join("journals/2026-08-29.md"), "no frontmatter").unwrap();
        let (merges, warnings) = merge_duplicate_journals(tmp.path());
        assert!(
            merges.is_empty(),
            "one parseable member left: nothing to merge"
        );
        assert_eq!(warnings.len(), 1);
        assert!(
            tmp.path().join("journals/2026-08-29.md").exists(),
            "never deletes what it cannot read"
        );
    }
}
