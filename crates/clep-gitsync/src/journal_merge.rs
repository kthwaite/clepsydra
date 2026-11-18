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

use super::conflict_copy::{file_stem, is_conflict_copy_name, strip_conflict_suffix};
use clep_vault::page::{PageMeta, parse_frontmatter, write_page_content};
use clep_vault::page_filename::extract_journal_date;
use clep_vault::rewriter::rewrite_links_in_content;

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
    // Every group's rewrites are collected first and applied in one pass, so
    // the vault is read once however many pages were folded.
    let mut repoints: Vec<Repoint> = Vec::new();
    for group in duplicate_journal_groups(root) {
        if let Some(merge) = merge_group(root, &group, &mut repoints, &mut warnings) {
            merges.push(merge);
        }
    }
    repoint_links(root, &repoints, &mut warnings);
    (merges, warnings)
}

/// A loser that was folded away, for the link rewrites its deletion implies.
struct Repoint {
    /// Vault-relative paths.
    loser: String,
    winner: String,
    date: String,
}

/// One member of a group, parsed.
struct Member {
    /// Vault-relative path.
    path: String,
    meta: PageMeta,
    body: String,
}

/// Fold one group, or `None` when fewer than two of its members could be
/// read (nothing to merge), any member is encrypted, every member is a
/// Conflict Copy, the winner could not be written, or not one loser could be
/// deleted (nothing was actually folded away).
///
/// The link rewrites the fold implies are appended to `repoints` rather than
/// applied here, so one vault pass serves every group.
fn merge_group(
    root: &Path,
    group: &JournalGroup,
    repoints: &mut Vec<Repoint>,
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
    // An encrypted body is one age armor block: `split_blocks` sees no entry
    // lines in it, so a fold would concatenate two armors into a body that no
    // longer parses (`validate_encrypted_body`) — or leak plaintext entries
    // into a page marked encrypted — and then delete the losers. The driver
    // refuses encrypted pages for the same reason (D18); the merger refuses
    // the whole group, `duplicate_journal_groups` still reports it, and
    // doctor's `journals.duplicates` is the backstop.
    if members
        .iter()
        .any(|member| member.meta.encryption.is_some())
    {
        warnings.push(format!(
            "journal merge: {}/{} has an encrypted page; left for hand resolution",
            group.folder, group.date
        ));
        return None;
    }
    // Copies always lose, so a group of nothing but Conflict Copies has no
    // winner: electing one would strip its `conflict_of` and leave a
    // copy-named page that neither `/sync/conflicts` nor the journal view can
    // see.
    if members
        .iter()
        .all(|member| is_conflict_copy_name(file_name(&member.path)))
    {
        warnings.push(format!(
            "journal merge: {}/{} is only conflict copies, with no original to fold into; left for hand resolution",
            group.folder, group.date
        ));
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
    for loser in &losers {
        fold_meta(&mut winner, loser, warnings);
    }
    let bodies: Vec<&str> = losers.iter().map(|loser| loser.body.as_str()).collect();
    let content = write_page_content(&winner.meta, &interleave(&winner.body, &bodies));

    // Written before anything is deleted: a failure here must leave every
    // member exactly as it was.
    let winner_path = root.join(&winner.path);
    if let Err(e) = clep_vault::atomic_file::atomic_replace(&winner_path, content.as_bytes()) {
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
        repoints.push(Repoint {
            loser: loser.path.clone(),
            winner: winner.path.clone(),
            date: group.date.clone(),
        });
        merged.push(loser.path.clone());
    }
    if merged.is_empty() {
        // Nothing left the tree, so there is no fold to report and — with the
        // winner's rewrite the only change, if it changed at all — possibly
        // nothing for the caller to commit either.
        return None;
    }
    Some(JournalMerge {
        folder: group.folder.clone(),
        date: group.date.clone(),
        winner: winner.path,
        merged,
    })
}

/// The link rewrites a deleted loser implies, oldest form first.
///
/// Three forms reach a page: the directory-qualified path stem a
/// `[[journals/…]]` link carries, the `.md` path a markdown link carries, and
/// the bare filename stem. The filename stem is dropped when it *is* the
/// group's date — a legacy-named `journals/2026-08-29.md` would otherwise
/// turn every `[[2026-08-29]]` in the vault into a filename link, and D21
/// leaves date links alone. It does not need them: a date link resolves
/// through the winner's title, which deleting the loser makes unambiguous by
/// itself. The path stem is kept even for a legacy name, because
/// `[[journals/2026-08-29]]` resolves through the loser's own path and would
/// dangle once the loser is gone.
fn repoint_pairs(loser_rel: &str, winner_rel: &str, date: &str) -> Vec<(String, String)> {
    let path_stem = |rel: &str| rel.strip_suffix(".md").unwrap_or(rel).to_string();
    let stem = |rel: &str| path_stem(file_name(rel));
    let mut pairs = vec![
        (path_stem(loser_rel), path_stem(winner_rel)),
        (loser_rel.to_string(), winner_rel.to_string()),
    ];
    let (old_stem, new_stem) = (stem(loser_rel), stem(winner_rel));
    if old_stem != date {
        pairs.push((old_stem, new_stem));
    }
    pairs
}

/// The Markdown-link rewrites a deleted loser implies in the page at
/// `from_rel`. A Markdown destination names a page two ways, and both are
/// repointed:
///
/// - by name, as a wikilink does — the index resolves `[x](journals/a.md)`
///   and `[x](a.md)` through the page's path stem and filename stem from any
///   folder. These are the [`repoint_pairs`] forms, plus the filename with
///   its `.md`.
/// - by a path relative to the linking page (`../journals/a.md`), which is
///   what CommonMark means and what a page move writes.
///
/// `<date>.md` is the Markdown spelling of a bare date link and is left
/// alone like `[[<date>]]`.
fn markdown_repoint_pairs(repoint: &Repoint, from_rel: &str) -> Vec<(String, String)> {
    let Repoint {
        loser,
        winner,
        date,
    } = repoint;
    let mut pairs = repoint_pairs(loser, winner, date);
    let forms = [
        (file_name(loser).to_string(), file_name(winner).to_string()),
        (
            relative_url(from_rel, loser),
            relative_url(from_rel, winner),
        ),
    ];
    for (old, new) in forms {
        let is_date_link = old.strip_suffix(".md") == Some(date.as_str());
        if !is_date_link && !pairs.iter().any(|(seen, _)| *seen == old) {
            pairs.push((old, new));
        }
    }
    pairs
}

/// The path of `to_rel` relative to the folder of `from_rel` (both
/// vault-relative): `notes/a.md` -> `journals/b.md` is `../journals/b.md`.
fn relative_url(from_rel: &str, to_rel: &str) -> String {
    let folder = |rel: &str| -> Vec<String> {
        let mut parts: Vec<String> = rel.split('/').map(str::to_string).collect();
        parts.pop();
        parts
    };
    let (from, to) = (folder(from_rel), folder(to_rel));
    let shared = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<&str> = vec![".."; from.len() - shared];
    parts.extend(to[shared..].iter().map(String::as_str));
    parts.push(file_name(to_rel));
    parts.join("/")
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

/// Fold a loser's frontmatter into the winner's, so deleting the loser loses
/// none of it. There is no common base to merge against, so the fold only
/// ever adds: list fields union (the winner's order first), a field or
/// custom key only the loser sets is taken, and `created_at` is the earlier
/// of the two, as in the merge driver. Where both pages set a field
/// differently the winner keeps its own and a warning names what was not
/// folded in.
///
/// A Conflict Copy's own residue — its fresh `id`, `conflict_of`, and the
/// ` (conflict <shortid>)` title — is not frontmatter anyone wrote.
fn fold_meta(winner: &mut Member, loser: &Member, warnings: &mut Vec<String>) {
    let copy = is_conflict_copy_name(file_name(&loser.path));
    let (meta, theirs) = (&mut winner.meta, &loser.meta);
    let mut unfolded: Vec<(&str, String)> = Vec::new();

    let title = theirs.title.as_deref().filter(|_| !copy).or_else(|| {
        // A copy of an untitled page is titled after its original's file.
        let original = theirs.extra.get("conflict_of")?.as_str().map(file_stem);
        let title = strip_conflict_suffix(theirs.title.as_deref()?);
        (Some(title) != original).then_some(title)
    });
    if let Some(title) = fill(&mut meta.title, title.map(str::to_string)) {
        unfolded.push(("title", format!("{title:?}")));
    }
    if let Some(kind) = fill(&mut meta.kind, theirs.kind) {
        unfolded.push(("type", format!("{:?}", kind.as_str())));
    }
    if let Some(project) = fill(&mut meta.project, theirs.project.clone()) {
        unfolded.push(("project", format!("{project:?}")));
    }
    if let Some(readonly) = fill(&mut meta.readonly, theirs.readonly) {
        unfolded.push(("readonly", readonly.to_string()));
    }
    for (mine, theirs) in [
        (&mut meta.tags, &theirs.tags),
        (&mut meta.aliases, &theirs.aliases),
        (&mut meta.attachments, &theirs.attachments),
    ] {
        for value in theirs {
            if !mine.contains(value) {
                mine.push(value.clone());
            }
        }
    }
    meta.created_at = match (meta.created_at, theirs.created_at) {
        (Some(mine), Some(theirs)) => Some(mine.min(theirs)),
        (mine, theirs) => mine.or(theirs),
    };
    for (key, value) in &theirs.extra {
        if key == "conflict_of" {
            continue;
        }
        match meta.extra.get(key) {
            None => {
                meta.extra.insert(key.clone(), value.clone());
            }
            // Compared as written, so a `nan` equals itself.
            Some(mine) if mine.to_string() != value.to_string() => {
                unfolded.push((key, value.to_string()));
            }
            Some(_) => {}
        }
    }
    for (field, value) in unfolded {
        warnings.push(format!(
            "journal merge: {} keeps its own `{field}`; the value in {} ({value}) was not folded in",
            winner.path, loser.path
        ));
    }
}

/// Take `theirs` where `mine` is unset. Returns `theirs` when both are set
/// and differ — the value that was not folded in.
fn fill<T: PartialEq>(mine: &mut Option<T>, theirs: Option<T>) -> Option<T> {
    match (&*mine, theirs) {
        (None, theirs) => {
            *mine = theirs;
            None
        }
        (Some(mine), Some(theirs)) if *mine != theirs => Some(theirs),
        _ => None,
    }
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
/// before the first entry. A line inside a fenced code block is never an
/// entry, however it is shaped: a capture that quotes a log or another
/// journal stays one block.
fn split_blocks(body: &str) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    let mut fence = Fence::default();
    for line in body.lines() {
        let fenced = fence.is_open();
        fence.feed(line);
        match entry_time(line).filter(|_| !fenced) {
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

/// The fenced code block (CommonMark) open at the current line, if any: its
/// fence character and the length of its opening run.
///
/// Only a fence indented less than an entry's content (two columns) is
/// tracked. One indented further belongs to the entry's list item, which the
/// next column-0 line ends, fence and all — so that line is a real entry.
#[derive(Default)]
struct Fence(Option<(u8, usize)>);

impl Fence {
    fn is_open(&self) -> bool {
        self.0.is_some()
    }

    fn feed(&mut self, line: &str) {
        let rest = line.trim_start_matches(' ');
        let indent = line.len() - rest.len();
        let Some(ch) = rest.bytes().next().filter(|b| matches!(b, b'`' | b'~')) else {
            return;
        };
        let run = rest.bytes().take_while(|b| *b == ch).count();
        let tail = &rest[run..];
        match self.0 {
            // A backtick fence's info string cannot hold a backtick.
            None if indent < 2 && run >= 3 && !(ch == b'`' && tail.contains('`')) => {
                self.0 = Some((ch, run));
            }
            Some((open, len))
                if indent <= 3 && ch == open && run >= len && tail.trim().is_empty() =>
            {
                self.0 = None;
            }
            _ => {}
        }
    }
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

/// Rewrite every deleted loser's links to its winner in one vault pass — a
/// filesystem walk, because the merger runs before any index exists.
/// Date links (`[[2026-08-29]]`) are deliberately not among the pairs; see
/// [`repoint_pairs`].
fn repoint_links(root: &Path, repoints: &[Repoint], warnings: &mut Vec<String>) {
    if repoints.is_empty() {
        return;
    }
    let wikilinks: Vec<(String, String)> = repoints
        .iter()
        .flat_map(|r| repoint_pairs(&r.loser, &r.winner, &r.date))
        .collect();
    let wikilinks: Vec<(&str, &str)> = wikilinks
        .iter()
        .map(|(old, new)| (old.as_str(), new.as_str()))
        .collect();
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
        // Every form of a link to a loser, Markdown ones included, contains
        // one of the wikilink forms.
        if !wikilinks.iter().any(|(old, _)| content.contains(old)) {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        let from_rel = relative.to_string_lossy().replace('\\', "/");
        let markdown: Vec<(String, String)> = repoints
            .iter()
            .flat_map(|r| markdown_repoint_pairs(r, &from_rel))
            .collect();
        let markdown: Vec<(&str, &str)> = markdown
            .iter()
            .map(|(old, new)| (old.as_str(), new.as_str()))
            .collect();
        let rewritten = rewrite_links_in_content(&content, &wikilinks, &markdown);
        if rewritten != content
            && let Err(e) =
                clep_vault::atomic_file::atomic_replace(entry.path(), rewritten.as_bytes())
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
        journal_in(dir, "journals", name, id_tail, created, body);
    }

    fn journal_in(
        dir: &std::path::Path,
        folder: &str,
        name: &str,
        id_tail: &str,
        created: &str,
        body: &str,
    ) {
        let path = dir.join(folder).join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            format!(
                "+++\nid = \"0192b6c0-0000-7000-8000-0000000000{id_tail}\"\ntitle = \"2026-08-29\"\ncreated_at = {created}\nupdated_at = {created}\n+++\n{body}"
            ),
        )
        .unwrap();
    }

    /// Two distinct, canonically-armored age bodies. Real armor is required:
    /// `parse_frontmatter` validates it on every parse. Same fixture shape as
    /// `merge_driver.rs`'s `encrypted_bodies_never_text_merge`.
    const ARMOR_A: &str = "-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSB0ZXN0LUEKLS0tCloK\n-----END AGE ENCRYPTED FILE-----\n";
    const ARMOR_B: &str = "-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSB0ZXN0LUIKLS0tCloK\n-----END AGE ENCRYPTED FILE-----\n";

    /// A journal page carrying real `[encryption]` meta and an age armor body.
    fn encrypted_journal(
        dir: &std::path::Path,
        name: &str,
        id_tail: &str,
        created: &str,
        armor: &str,
    ) {
        let path = dir.join("journals").join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            format!(
                "+++\nid = \"0192b6c0-0000-7000-8000-0000000000{id_tail}\"\ntitle = \"2026-08-29\"\ncreated_at = {created}\nupdated_at = {created}\n\n[encryption]\nformat = \"age\"\nversion = 1\nkey_id = \"test-key\"\n+++\n{armor}"
            ),
        )
        .unwrap();
    }

    /// A page under `notes/` whose body is exactly `body`.
    fn note(dir: &std::path::Path, name: &str, id_tail: &str, body: &str) -> std::path::PathBuf {
        let path = dir.join("notes").join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            format!(
                "+++\nid = \"0192b6c0-0000-7000-8000-0000000000{id_tail}\"\ntitle = \"Ref\"\n+++\n{body}"
            ),
        )
        .unwrap();
        path
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
    fn split_blocks_never_starts_an_entry_inside_a_fenced_code_block() {
        let blocks =
            split_blocks("- 09:00 — log excerpt\n```\n- 07:00 — quoted\n```\n- 10:00 — next\n");
        assert_eq!(blocks.len(), 2);
        assert_eq!(
            blocks[0].text,
            "- 09:00 — log excerpt\n```\n- 07:00 — quoted\n```\n"
        );
        assert_eq!(blocks[1].time.as_deref(), Some("10:00"));

        // A fence closes only on its own character, at least as long as the
        // opener, with nothing after it.
        let blocks = split_blocks(
            "~~~~ text\n```\n- 07:00 — a\n~~~\n- 06:00 — b\n~~~~ x\n- 05:00 — c\n~~~~~\n- 11:00 — after\n",
        );
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].time, None);
        assert_eq!(blocks[1].text, "- 11:00 — after\n");
    }

    #[test]
    fn split_blocks_ends_a_fence_nested_in_an_entry_at_the_next_entry() {
        // Indented under the entry, the fence belongs to its list item, and
        // the next column-0 line ends the item and the fence with it.
        let blocks = split_blocks("- 09:00 — a\n  ```\n  code\n- 10:00 — b\n");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[1].text, "- 10:00 — b\n");
    }

    #[test]
    fn a_fenced_capture_folds_as_one_block() {
        let tmp = TempDir::new().unwrap();
        journal(
            tmp.path(),
            "20260829.2026-08-29.aaaaaaaa.md",
            "01",
            "2026-08-29T08:00:00Z",
            "- 08:00 — first\n",
        );
        let capture = "- 09:00 — log excerpt\n```\n- 07:00 — quoted\n```\n";
        journal(
            tmp.path(),
            "20260829.2026-08-29.bbbbbbbb.md",
            "02",
            "2026-08-29T09:00:00Z",
            capture,
        );
        let (merges, warnings) = merge_duplicate_journals(tmp.path());
        assert_eq!(warnings, Vec::<String>::new());
        assert_eq!(merges.len(), 1);
        let text =
            std::fs::read_to_string(tmp.path().join("journals/20260829.2026-08-29.aaaaaaaa.md"))
                .unwrap();
        let (_, body) = clep_vault::page::parse_frontmatter(&text).unwrap();
        assert_eq!(body, format!("- 08:00 — first\n{capture}"));
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
        let (meta, body) = clep_vault::page::parse_frontmatter(&text).unwrap();
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

    /// D21: a date link is the vault's own name for the day and must survive
    /// a fold untouched. A legacy-named loser makes that load-bearing — its
    /// filename stem IS the date, so an unguarded stem rewrite would turn
    /// every `[[2026-08-29]]` in the vault into a filename link.
    #[test]
    fn a_legacy_named_loser_leaves_date_links_alone() {
        let tmp = TempDir::new().unwrap();
        journal(
            tmp.path(),
            "20260829.2026-08-29.aaaaaaaa.md",
            "01",
            "2026-08-29T08:00:00Z",
            "- 08:00 — canonical\n",
        );
        journal(
            tmp.path(),
            "2026-08-29.md",
            "02",
            "2026-08-29T09:00:00Z",
            "- 09:00 — legacy\n",
        );
        let dated = note(
            tmp.path(),
            "dated.md",
            "09",
            "see [[2026-08-29]] and nothing else\n",
        );
        let before = std::fs::read_to_string(&dated).unwrap();

        let (merges, warnings) = merge_duplicate_journals(tmp.path());

        assert_eq!(warnings, Vec::<String>::new());
        assert_eq!(merges[0].merged, vec!["journals/2026-08-29.md"]);
        assert_eq!(
            std::fs::read_to_string(&dated).unwrap(),
            before,
            "the date link is untouched"
        );
    }

    /// The path form resolves through the loser's own path, so it would
    /// dangle once the loser is deleted: it is repointed even though the
    /// bare date inside it is not.
    #[test]
    fn a_path_form_link_to_a_legacy_loser_is_repointed() {
        let tmp = TempDir::new().unwrap();
        journal(
            tmp.path(),
            "20260829.2026-08-29.aaaaaaaa.md",
            "01",
            "2026-08-29T08:00:00Z",
            "- 08:00 — canonical\n",
        );
        journal(
            tmp.path(),
            "2026-08-29.md",
            "02",
            "2026-08-29T09:00:00Z",
            "- 09:00 — legacy\n",
        );
        let pathy = note(
            tmp.path(),
            "pathy.md",
            "09",
            "see [[journals/2026-08-29]]\n",
        );

        merge_duplicate_journals(tmp.path());

        let text = std::fs::read_to_string(&pathy).unwrap();
        assert!(
            text.contains("[[journals/20260829.2026-08-29.aaaaaaaa]]"),
            "{text}"
        );
    }

    /// A Markdown link names a page two ways: by name, like a wikilink but
    /// with `.md` (how the index resolves it), or by a path relative to the
    /// page it is written in (CommonMark, and what a page move writes).
    #[test]
    fn markdown_links_to_a_loser_are_repointed_in_every_form() {
        const A: &str = "20260829.2026-08-29.aaaaaaaa";
        const B: &str = "20260829.2026-08-29.bbbbbbbb";
        let tmp = TempDir::new().unwrap();
        journal(
            tmp.path(),
            &format!("{A}.md"),
            "01",
            "2026-08-29T08:00:00Z",
            "- 08:00 — a\n",
        );
        journal(
            tmp.path(),
            &format!("{B}.md"),
            "02",
            "2026-08-29T09:00:00Z",
            "- 09:00 — b\n",
        );
        // A sibling journal of another day, linking by relative path.
        journal(
            tmp.path(),
            "20260830.2026-08-30.cccccccc.md",
            "03",
            "2026-08-30T08:00:00Z",
            &format!("- 08:00 — see [yesterday]({B}.md)\n"),
        );
        let links = |stem: &str| {
            format!(
                "[relative](../journals/{stem}.md) [path](journals/{stem}.md) [name]({stem}.md) [other](../journals/else.md)\n"
            )
        };
        let referer = note(tmp.path(), "ref.md", "09", &links(B));

        let (merges, warnings) = merge_duplicate_journals(tmp.path());

        assert_eq!(warnings, Vec::<String>::new());
        assert_eq!(merges[0].merged, vec![format!("journals/{B}.md")]);
        let text = std::fs::read_to_string(&referer).unwrap();
        assert!(text.ends_with(&links(A)), "{text}");
        let sibling =
            std::fs::read_to_string(tmp.path().join("journals/20260830.2026-08-30.cccccccc.md"))
                .unwrap();
        assert!(
            sibling.ends_with(&format!("- 08:00 — see [yesterday]({A}.md)\n")),
            "{sibling}"
        );
    }

    /// The Markdown spelling of a bare date link is left alone like the
    /// wikilink one (D21); the path forms still name the deleted file.
    #[test]
    fn a_legacy_named_loser_leaves_markdown_date_links_alone() {
        let tmp = TempDir::new().unwrap();
        journal(
            tmp.path(),
            "20260829.2026-08-29.aaaaaaaa.md",
            "01",
            "2026-08-29T08:00:00Z",
            "- 08:00 — canonical\n",
        );
        journal(
            tmp.path(),
            "2026-08-29.md",
            "02",
            "2026-08-29T09:00:00Z",
            "- 09:00 — legacy\n",
        );
        journal(
            tmp.path(),
            "20260830.2026-08-30.cccccccc.md",
            "03",
            "2026-08-30T08:00:00Z",
            "- 08:00 — see [yesterday](2026-08-29.md)\n",
        );
        let referer = note(
            tmp.path(),
            "ref.md",
            "09",
            "[date](2026-08-29.md) [relative](../journals/2026-08-29.md)\n",
        );

        merge_duplicate_journals(tmp.path());

        let text = std::fs::read_to_string(&referer).unwrap();
        assert!(
            text.ends_with(
                "[date](2026-08-29.md) [relative](../journals/20260829.2026-08-29.aaaaaaaa.md)\n"
            ),
            "{text}"
        );
        let sibling =
            std::fs::read_to_string(tmp.path().join("journals/20260830.2026-08-30.cccccccc.md"))
                .unwrap();
        assert!(
            sibling.ends_with("- 08:00 — see [yesterday](2026-08-29.md)\n"),
            "{sibling}"
        );
    }

    #[test]
    fn ai_journals_fold_on_their_own() {
        let tmp = TempDir::new().unwrap();
        journal_in(
            tmp.path(),
            "ai-journals",
            "20260829.2026-08-29.aaaaaaaa.md",
            "01",
            "2026-08-29T08:00:00Z",
            "- 08:00 — a\n",
        );
        journal_in(
            tmp.path(),
            "ai-journals",
            "20260829.2026-08-29.bbbbbbbb.md",
            "02",
            "2026-08-29T09:00:00Z",
            "- 09:00 — b\n",
        );

        let (merges, warnings) = merge_duplicate_journals(tmp.path());

        assert_eq!(warnings, Vec::<String>::new());
        assert_eq!(merges.len(), 1);
        assert_eq!(merges[0].folder, "ai-journals");
        assert_eq!(
            merges[0].winner,
            "ai-journals/20260829.2026-08-29.aaaaaaaa.md"
        );
        let body = std::fs::read_to_string(tmp.path().join(&merges[0].winner)).unwrap();
        assert!(
            body.contains("- 08:00 — a") && body.contains("- 09:00 — b"),
            "{body}"
        );
    }

    /// The two folders are separate journals that happen to share a calendar.
    /// A user's day and an agent's log of it must never fold together.
    /// A journal page with the given frontmatter lines after `id`.
    fn journal_with(dir: &std::path::Path, name: &str, id_tail: &str, fm: &str, body: &str) {
        let path = dir.join("journals").join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            format!("+++\nid = \"0192b6c0-0000-7000-8000-0000000000{id_tail}\"\n{fm}+++\n{body}"),
        )
        .unwrap();
    }

    fn winner_meta(dir: &std::path::Path) -> PageMeta {
        let text =
            std::fs::read_to_string(dir.join("journals/20260829.2026-08-29.aaaaaaaa.md")).unwrap();
        parse_frontmatter(&text).unwrap().0
    }

    #[test]
    fn a_fold_keeps_the_losers_tags_and_properties() {
        let tmp = TempDir::new().unwrap();
        journal_with(
            tmp.path(),
            "20260829.2026-08-29.aaaaaaaa.md",
            "01",
            "title = \"2026-08-29\"\ntags = [\"a\", \"shared\"]\ncreated_at = 2026-08-29T08:00:00Z\nweather = \"rain\"\n",
            "- 08:00 — a\n",
        );
        journal_with(
            tmp.path(),
            "20260829.2026-08-29.bbbbbbbb.md",
            "02",
            "title = \"2026-08-29\"\ntags = [\"shared\", \"trip\"]\naliases = [\"the trip\"]\nattachments = [\"map.png\"]\nproject = \"alps\"\ncreated_at = 2026-08-29T09:00:00Z\nweather = \"rain\"\nmood = \"great\"\n",
            "- 09:00 — b\n",
        );

        let (merges, warnings) = merge_duplicate_journals(tmp.path());

        assert_eq!(warnings, Vec::<String>::new());
        assert_eq!(merges.len(), 1);
        let meta = winner_meta(tmp.path());
        assert_eq!(meta.tags, vec!["a", "shared", "trip"]);
        assert_eq!(meta.aliases, vec!["the trip"]);
        assert_eq!(meta.attachments, vec!["map.png"]);
        assert_eq!(meta.project.as_deref(), Some("alps"));
        assert_eq!(
            meta.extra.keys().collect::<Vec<_>>(),
            vec!["weather", "mood"]
        );
        assert_eq!(meta.extra["mood"].as_str(), Some("great"));
        assert_eq!(
            meta.created_at.unwrap().to_rfc3339(),
            "2026-08-29T08:00:00+00:00"
        );
    }

    #[test]
    fn a_fold_warns_about_a_property_the_pages_disagree_on() {
        let tmp = TempDir::new().unwrap();
        journal_with(
            tmp.path(),
            "20260829.2026-08-29.aaaaaaaa.md",
            "01",
            "created_at = 2026-08-29T08:00:00Z\nproject = \"alps\"\nmood = \"fine\"\n",
            "- 08:00 — a\n",
        );
        journal_with(
            tmp.path(),
            "20260829.2026-08-29.bbbbbbbb.md",
            "02",
            "created_at = 2026-08-29T09:00:00Z\nproject = \"andes\"\nmood = \"great\"\n",
            "- 09:00 — b\n",
        );

        let (merges, warnings) = merge_duplicate_journals(tmp.path());

        assert_eq!(merges.len(), 1);
        let meta = winner_meta(tmp.path());
        assert_eq!(meta.project.as_deref(), Some("alps"));
        assert_eq!(meta.extra["mood"].as_str(), Some("fine"));
        assert_eq!(
            warnings,
            vec![
                "journal merge: journals/20260829.2026-08-29.aaaaaaaa.md keeps its own `project`; the value in journals/20260829.2026-08-29.bbbbbbbb.md (\"andes\") was not folded in",
                "journal merge: journals/20260829.2026-08-29.aaaaaaaa.md keeps its own `mood`; the value in journals/20260829.2026-08-29.bbbbbbbb.md (\"great\") was not folded in",
            ]
        );
    }

    /// A Conflict Copy's `conflict_of`, suffixed title and fresh id are its
    /// own residue, not a disagreement; the rest of its frontmatter is the
    /// other device's and folds in.
    #[test]
    fn a_conflict_copys_frontmatter_folds_in_without_its_residue() {
        let tmp = TempDir::new().unwrap();
        journal_with(
            tmp.path(),
            "20260829.2026-08-29.aaaaaaaa.md",
            "01",
            "title = \"2026-08-29\"\ntags = [\"a\"]\ncreated_at = 2026-08-29T08:00:00Z\n",
            "- 08:00 — a\n",
        );
        journal_with(
            tmp.path(),
            "20260829.2026-08-29.aaaaaaaa.conflict.abc1234.md",
            "03",
            "title = \"2026-08-29 (conflict abc1234)\"\ntags = [\"a\", \"theirs\"]\ncreated_at = 2026-08-29T08:00:00Z\nconflict_of = \"journals/20260829.2026-08-29.aaaaaaaa.md\"\n",
            "- 10:00 — theirs\n",
        );

        let (merges, warnings) = merge_duplicate_journals(tmp.path());

        assert_eq!(warnings, Vec::<String>::new());
        assert_eq!(merges.len(), 1);
        let meta = winner_meta(tmp.path());
        assert_eq!(meta.title.as_deref(), Some("2026-08-29"));
        assert_eq!(meta.tags, vec!["a", "theirs"]);
        assert!(meta.extra.is_empty(), "{:?}", meta.extra);
    }

    #[test]
    fn a_journal_and_an_ai_journal_of_one_date_do_not_group() {
        let tmp = TempDir::new().unwrap();
        journal(
            tmp.path(),
            "20260829.2026-08-29.aaaaaaaa.md",
            "01",
            "2026-08-29T08:00:00Z",
            "- 08:00 — mine\n",
        );
        journal_in(
            tmp.path(),
            "ai-journals",
            "20260829.2026-08-29.bbbbbbbb.md",
            "02",
            "2026-08-29T09:00:00Z",
            "- 09:00 — the agent's\n",
        );

        assert!(duplicate_journal_groups(tmp.path()).is_empty());
        assert_eq!(merge_duplicate_journals(tmp.path()).0.len(), 0);
        assert!(
            tmp.path()
                .join("ai-journals/20260829.2026-08-29.bbbbbbbb.md")
                .exists()
        );
    }

    /// D22: a merger problem is a warning. When not one loser can be deleted
    /// nothing was folded away, so no fold is reported — and the caller is
    /// left with nothing to commit rather than an empty commit that fails.
    #[cfg(unix)]
    #[test]
    fn a_group_whose_deletes_all_fail_reports_no_fold() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        journal(
            tmp.path(),
            "20260829.2026-08-29.aaaaaaaa.md",
            "01",
            "2026-08-29T08:00:00Z",
            "- 08:00 — winner\n",
        );
        // A conflict copy in a subdirectory: it joins the top-level group
        // through `conflict_of`, and its own directory can be made read-only
        // without stopping the winner from being rewritten.
        let locked = tmp.path().join("journals/locked");
        std::fs::create_dir_all(&locked).unwrap();
        let loser = locked.join("20260829.2026-08-29.aaaaaaaa.conflict.abc1234.md");
        std::fs::write(
            &loser,
            "+++\nid = \"0192b6c0-0000-7000-8000-000000000002\"\ntitle = \"2026-08-29 (conflict abc1234)\"\nconflict_of = \"journals/20260829.2026-08-29.aaaaaaaa.md\"\n+++\n- 09:00 — theirs\n",
        )
        .unwrap();
        // Unlinking needs write permission on the parent directory.
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();

        let (merges, warnings) = merge_duplicate_journals(tmp.path());

        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(merges.is_empty(), "{merges:?}");
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(warnings[0].contains("could not delete it"), "{warnings:?}");
        assert!(loser.exists(), "the loser survives");
        let winner =
            std::fs::read_to_string(tmp.path().join("journals/20260829.2026-08-29.aaaaaaaa.md"))
                .unwrap();
        assert!(
            winner.contains("- 09:00 — theirs"),
            "the content was still folded in, so nothing is lost: {winner}"
        );
    }

    /// An encrypted body is a single age armor: folding two of them would
    /// concatenate the armors under one page's `[encryption]` meta and delete
    /// the other, leaving a page that no longer parses. The whole group is
    /// left for hand resolution.
    #[test]
    fn a_group_with_an_encrypted_member_is_left_alone() {
        let tmp = TempDir::new().unwrap();
        encrypted_journal(
            tmp.path(),
            "20260829.2026-08-29.aaaaaaaa.md",
            "01",
            "2026-08-29T08:00:00Z",
            ARMOR_A,
        );
        encrypted_journal(
            tmp.path(),
            "20260829.2026-08-29.bbbbbbbb.md",
            "02",
            "2026-08-29T09:00:00Z",
            ARMOR_B,
        );
        let paths = [
            tmp.path().join("journals/20260829.2026-08-29.aaaaaaaa.md"),
            tmp.path().join("journals/20260829.2026-08-29.bbbbbbbb.md"),
        ];
        let before: Vec<Vec<u8>> = paths.iter().map(|p| std::fs::read(p).unwrap()).collect();

        let (merges, warnings) = merge_duplicate_journals(tmp.path());

        assert!(merges.is_empty(), "{merges:?}");
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(
            warnings[0].contains("journals/2026-08-29 has an encrypted page"),
            "{warnings:?}"
        );
        for (path, bytes) in paths.iter().zip(&before) {
            assert_eq!(
                &std::fs::read(path).unwrap(),
                bytes,
                "{} changed",
                path.display()
            );
        }
        // The group is still reported, so doctor's `journals.duplicates` sees it.
        assert_eq!(duplicate_journal_groups(tmp.path()).len(), 1);
    }

    /// The mixed case is no safer: a plaintext loser's entries would land
    /// inside a page marked encrypted, or an armor would land as body text in
    /// a plaintext winner.
    #[test]
    fn a_mixed_encrypted_and_plaintext_group_is_left_alone() {
        let tmp = TempDir::new().unwrap();
        encrypted_journal(
            tmp.path(),
            "20260829.2026-08-29.aaaaaaaa.md",
            "01",
            "2026-08-29T08:00:00Z",
            ARMOR_A,
        );
        journal(
            tmp.path(),
            "20260829.2026-08-29.bbbbbbbb.md",
            "02",
            "2026-08-29T09:00:00Z",
            "- 09:00 — plaintext\n",
        );
        let plain = tmp.path().join("journals/20260829.2026-08-29.bbbbbbbb.md");
        let encrypted = tmp.path().join("journals/20260829.2026-08-29.aaaaaaaa.md");
        let (plain_before, encrypted_before) = (
            std::fs::read(&plain).unwrap(),
            std::fs::read(&encrypted).unwrap(),
        );

        let (merges, warnings) = merge_duplicate_journals(tmp.path());

        assert!(merges.is_empty(), "{merges:?}");
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(
            warnings[0].contains("has an encrypted page"),
            "{warnings:?}"
        );
        assert_eq!(std::fs::read(&plain).unwrap(), plain_before);
        assert_eq!(std::fs::read(&encrypted).unwrap(), encrypted_before);
    }

    /// Copies always lose, so a group of nothing but Conflict Copies has no
    /// winner at all — electing one would strand a copy-named page.
    #[test]
    fn a_group_of_only_conflict_copies_is_left_alone() {
        let tmp = TempDir::new().unwrap();
        // The original was deleted after the merge; two copies of it survive.
        let copy = |name: &str, id_tail: &str, body: &str| {
            let path = tmp.path().join("journals").join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(
                &path,
                format!(
                    "+++\nid = \"0192b6c0-0000-7000-8000-0000000000{id_tail}\"\ntitle = \"2026-08-29 (conflict {id_tail})\"\nconflict_of = \"journals/20260829.2026-08-29.aaaaaaaa.md\"\n+++\n{body}"
                ),
            )
            .unwrap();
            path
        };
        let first = copy(
            "20260829.2026-08-29.aaaaaaaa.conflict.abc1234.md",
            "01",
            "- 08:00 — one\n",
        );
        let second = copy(
            "20260829.2026-08-29.aaaaaaaa.conflict.def5678.md",
            "02",
            "- 09:00 — two\n",
        );
        let before = (
            std::fs::read(&first).unwrap(),
            std::fs::read(&second).unwrap(),
        );

        let (merges, warnings) = merge_duplicate_journals(tmp.path());

        assert!(merges.is_empty(), "{merges:?}");
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(
            warnings[0].contains("is only conflict copies"),
            "{warnings:?}"
        );
        assert_eq!(std::fs::read(&first).unwrap(), before.0);
        assert_eq!(std::fs::read(&second).unwrap(), before.1);
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
