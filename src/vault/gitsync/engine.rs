//! The sync algorithm: commit local -> fetch -> merge -> resolve -> commit
//! -> push (D4, D6, D7).
//!
//! [`SyncEngine`] is synchronous and knows nothing about the server; the
//! runtime wraps it in `spawn_blocking` and a quiesce window. It operates
//! only on the [`Vault`] it is handed — never on the ambient app config.
//!
//! The tree is never left conflicted: every unmerged path is resolved in
//! favour of "ours", with "theirs" written beside it as a Conflict Copy
//! (ADR 0004, [`super::conflict_copy`]), and the merge is always committed
//! or aborted.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};

use super::conflict_copy::{ConflictCopy, file_stem, find_conflict_copies, write_conflict_copy};
use super::git::{Git, GitError, PushOutcome, Side, StatusEntry};
use super::state::{self, SyncState};
use super::{Author, REMOTE_NAME, SyncError, first_line, plural};
use crate::vault::Vault;

/// How many page titles a generated commit message names.
const TITLE_LIMIT: usize = 3;

/// Headline of the commit that finishes a merge an earlier run abandoned.
const LEFTOVER_MERGE_HEADLINE: &str = "sync: resolve in-progress merge";

/// A git-backed vault, ready to sync.
#[derive(Debug, Clone)]
pub struct SyncEngine {
    git: Git,
    root: PathBuf,
    /// Where the per-device state file lives (D8). Resolved once at open,
    /// because in a linked worktree it is not `<root>/.git` — that is a file.
    git_dir: PathBuf,
    branch: String,
    author: Author,
}

/// One commit the engine made.
#[derive(Debug, Clone)]
pub struct CommitSummary {
    pub sha: String,
    /// Number of changed paths that went into it.
    pub files: usize,
    pub message: String,
}

/// What the fetch-and-merge half of a sync did (D4).
#[derive(Debug, Clone)]
pub enum MergeSummary {
    /// No `origin`: this vault syncs to nothing but its own history.
    NoRemote,
    /// The fetch failed (offline, auth, bad URL). Not fatal, and no push is
    /// attempted afterwards.
    FetchFailed(String),
    /// Nothing was fetched — the shutdown path pushes without pulling.
    NotFetched,
    UpToDate,
    FastForward {
        head: String,
    },
    Merged {
        commit: String,
        conflict_copies: Vec<ConflictCopy>,
    },
}

/// What the push half of a sync did (D7).
#[derive(Debug, Clone)]
pub enum PushStatus {
    /// No remote, or the merge never got far enough to try.
    NotAttempted,
    NothingToPush,
    Pushed,
    /// Rejected twice — the remote moved again during the retry.
    Rejected(String),
    Failed(String),
}

/// The result of one whole sync.
#[derive(Debug, Clone)]
pub struct SyncReport {
    pub committed: Option<CommitSummary>,
    pub merge: MergeSummary,
    pub push: PushStatus,
    /// Non-fatal problems worth surfacing (odd merge stages, unwritable
    /// state file).
    pub warnings: Vec<String>,
    pub started_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
}

impl SyncReport {
    /// True when the merge changed the working tree, so the caller has to
    /// rebuild the index (D10).
    pub fn tree_changed(&self) -> bool {
        matches!(
            self.merge,
            MergeSummary::FastForward { .. } | MergeSummary::Merged { .. }
        )
    }

    pub fn conflict_copies(&self) -> &[ConflictCopy] {
        match &self.merge {
            MergeSummary::Merged {
                conflict_copies, ..
            } => conflict_copies,
            _ => &[],
        }
    }

    /// One line for `clep sync` output and the recorded state (D8).
    pub fn one_line(&self) -> String {
        let mut parts = Vec::new();
        parts.push(match &self.committed {
            Some(commit) => format!("committed {} file{}", commit.files, plural(commit.files)),
            None => "nothing to commit".to_string(),
        });
        parts.push(match &self.merge {
            MergeSummary::NoRemote => "no remote".to_string(),
            MergeSummary::FetchFailed(detail) => format!("fetch failed: {}", first_line(detail)),
            MergeSummary::NotFetched => "no fetch".to_string(),
            MergeSummary::UpToDate => "up to date".to_string(),
            MergeSummary::FastForward { .. } => "fast-forwarded".to_string(),
            MergeSummary::Merged {
                conflict_copies, ..
            } if conflict_copies.is_empty() => "merged".to_string(),
            MergeSummary::Merged {
                conflict_copies, ..
            } => format!(
                "merged with {} conflict cop{}",
                conflict_copies.len(),
                if conflict_copies.len() == 1 {
                    "y"
                } else {
                    "ies"
                }
            ),
        });
        parts.push(match &self.push {
            PushStatus::NotAttempted => "no push".to_string(),
            PushStatus::NothingToPush => "nothing to push".to_string(),
            PushStatus::Pushed => "pushed".to_string(),
            PushStatus::Rejected(detail) => format!("push rejected: {}", first_line(detail)),
            PushStatus::Failed(detail) => format!("push failed: {}", first_line(detail)),
        });
        parts.join("; ")
    }

    /// True when nothing went wrong: the fetch and the push both did what
    /// they were asked. Conflict Copies are a success — they are how a
    /// conflict is meant to end.
    pub fn is_success(&self) -> bool {
        !matches!(self.merge, MergeSummary::FetchFailed(_))
            && !matches!(self.push, PushStatus::Rejected(_) | PushStatus::Failed(_))
    }
}

/// What `clep sync status` reports.
#[derive(Debug, Clone)]
pub struct SyncStatus {
    pub initialised: bool,
    pub branch: String,
    pub remote: Option<String>,
    pub head: Option<String>,
    /// Commits ahead of / behind `origin/<branch>`; `None` when the
    /// remote-tracking branch does not exist yet.
    pub ahead: Option<usize>,
    pub behind: Option<usize>,
    pub dirty_files: usize,
    pub unmerged_files: usize,
    pub conflict_copies: usize,
    pub last_sync_at: Option<DateTime<Utc>>,
    pub last_sync_result: Option<String>,
}

impl SyncEngine {
    /// Open the engine over `vault`'s own repository.
    pub fn open(vault: &Vault) -> Result<Self, SyncError> {
        let git = Git::new(vault.root());
        Self::open_with_git(vault, git)
    }

    /// As [`SyncEngine::open`], with the [`Git`] supplied — tests inject an
    /// isolated one (`GIT_CONFIG_GLOBAL` pointing at an empty file).
    pub fn open_with_git(vault: &Vault, git: Git) -> Result<Self, SyncError> {
        if !super::is_initialised(vault, &git)? {
            return Err(SyncError::NotInitialised);
        }
        let author = Author::from_config(&vault.config().sync).ok_or(SyncError::MissingAuthor)?;
        let git_dir = git.git_dir()?;
        Ok(Self {
            git,
            root: vault.root().to_path_buf(),
            git_dir,
            branch: vault.config().sync.branch.clone(),
            author,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Commit everything in the working tree, or `None` when it is clean.
    ///
    /// A merge an earlier run left in progress is finished first: `git add
    /// -A` over unmerged paths would collapse the conflict markers sitting
    /// in the working tree into an ordinary commit and push them to every
    /// device.
    pub fn commit_local(&self) -> Result<Option<CommitSummary>, SyncError> {
        let leftover = self.commit_leftover_merge()?;
        let entries = self.git.status()?;
        if entries.is_empty() {
            return Ok(leftover);
        }
        self.git.add_all()?;
        let message = commit_message(&self.root, &entries);
        let sha = self.git.commit(&message, &self.author)?;
        Ok(Some(match leftover {
            // Both commits are this sync's work, so the report counts both;
            // the leftover's own sha would otherwise go unmentioned.
            Some(leftover) => {
                tracing::info!(
                    "sync: committed a leftover merge as {} before {sha}",
                    leftover.sha
                );
                CommitSummary {
                    sha,
                    files: leftover.files + entries.len(),
                    message,
                }
            }
            None => CommitSummary {
                sha,
                files: entries.len(),
                message,
            },
        }))
    }

    /// Finish a merge an earlier run left in progress — a process killed
    /// between the merge and its resolution, a merge run by hand, or an
    /// abort that itself failed. `None` when none is in progress.
    fn commit_leftover_merge(&self) -> Result<Option<CommitSummary>, SyncError> {
        let in_progress = self.git.merge_head()?.is_some();
        let unmerged = self.git.unmerged()?;
        if !in_progress && unmerged.is_empty() {
            return Ok(None);
        }
        // A merge is ours to finish; a cherry-pick or a rebase is the user's,
        // and committing its unmerged state would turn half of one into a
        // sync commit (D24).
        for (reference, operation) in [
            ("CHERRY_PICK_HEAD", "cherry-pick"),
            ("REBASE_HEAD", "rebase"),
        ] {
            if self.git.rev_parse(reference)?.is_some() {
                return Err(SyncError::GitOperationInProgress {
                    operation: operation.to_string(),
                });
            }
        }
        let files = self.git.status()?.len();
        let (sha, copies, warnings) =
            self.resolve_and_commit("MERGE_HEAD", LEFTOVER_MERGE_HEADLINE, !unmerged.is_empty())?;
        for warning in warnings {
            tracing::warn!("sync: {warning}");
        }
        tracing::info!(
            "sync: finished a merge left in progress ({} unmerged path(s), {} conflict copy/ies)",
            unmerged.len(),
            copies.len()
        );
        Ok(Some(CommitSummary {
            sha,
            files,
            message: merge_message(LEFTOVER_MERGE_HEADLINE, &copies),
        }))
    }

    /// Fetch, merge, resolve every conflict, and commit the merge (D4).
    /// Never leaves a merge in progress.
    pub fn pull(&self) -> Result<MergeSummary, SyncError> {
        let (summary, warnings) = self.pull_inner()?;
        for warning in warnings {
            tracing::warn!("sync: {warning}");
        }
        Ok(summary)
    }

    /// [`SyncEngine::pull`], keeping the warnings for [`SyncReport`].
    fn pull_inner(&self) -> Result<(MergeSummary, Vec<String>), SyncError> {
        if self.git.remote_url(REMOTE_NAME)?.is_none() {
            return Ok((MergeSummary::NoRemote, Vec::new()));
        }
        if let Err(e) = self.git.fetch(REMOTE_NAME, &self.branch) {
            return Ok((MergeSummary::FetchFailed(e.to_string()), Vec::new()));
        }
        let reference = format!("{REMOTE_NAME}/{}", self.branch);
        if self.git.rev_parse(&reference)?.is_none() {
            // The remote branch is unborn: nothing to merge, only to push.
            return Ok((MergeSummary::UpToDate, Vec::new()));
        }
        let before = self.git.head()?;
        let out = self.git.merge_no_commit(&reference)?;
        let merge_head = self.git.merge_head()?;
        match (out.status, merge_head) {
            (0, None) => {
                let after = self.git.head()?;
                if after == before {
                    Ok((MergeSummary::UpToDate, Vec::new()))
                } else {
                    self.tighten_crypto_permissions();
                    Ok((
                        MergeSummary::FastForward {
                            head: after.unwrap_or_default(),
                        },
                        Vec::new(),
                    ))
                }
            }
            (status @ (0 | 1), Some(_)) => {
                let headline = format!("sync: merge {reference}");
                let (commit, conflict_copies, warnings) =
                    self.resolve_and_commit(&reference, &headline, status == 1)?;
                Ok((
                    MergeSummary::Merged {
                        commit,
                        conflict_copies,
                    },
                    warnings,
                ))
            }
            (status, _) => {
                // Unrelated histories, an unwritable tree, a broken index:
                // leave nothing half-merged behind. Some of those refusals
                // happen before git writes `MERGE_HEAD` at all, and aborting
                // a merge that never started only appends a confusing "there
                // is no merge to abort" to the real reason — so only abort
                // when we are not certain there is nothing to abort.
                let note = if matches!(self.git.merge_head(), Ok(None)) {
                    String::new()
                } else {
                    self.abort_merge_note().unwrap_or_default()
                };
                Err(SyncError::MergeFailed {
                    reference,
                    detail: format!("exit {status}: {}{note}", out.stderr.trim()),
                })
            }
        }
    }

    /// Resolve (when git stopped on conflicts) and commit the merge,
    /// aborting it if either step fails — a sync never leaves a merge in
    /// progress or a conflicted tree behind (D4). Returns the commit, the
    /// Conflict Copies it recorded, and any warnings.
    #[allow(clippy::type_complexity)]
    fn resolve_and_commit(
        &self,
        reference: &str,
        headline: &str,
        conflicted: bool,
    ) -> Result<(String, Vec<ConflictCopy>, Vec<String>), SyncError> {
        let resolved = if conflicted {
            self.resolve_unmerged()
        } else {
            Ok((Vec::new(), Vec::new()))
        };
        let committed = resolved.and_then(|(copies, warnings)| {
            Ok((self.finish_merge(headline, &copies)?, copies, warnings))
        });
        match committed {
            Ok(done) => Ok(done),
            // The abort is what keeps the tree usable; if it fails too, say
            // so rather than reporting only the original problem.
            Err(e) => Err(match self.abort_merge_note() {
                None => e,
                Some(note) => SyncError::MergeFailed {
                    reference: reference.to_string(),
                    detail: format!("{e}{note}"),
                },
            }),
        }
    }

    /// `git merge --abort`, reporting the note to append to an error when
    /// the abort itself failed and the tree is still conflicted.
    fn abort_merge_note(&self) -> Option<String> {
        match self.git.abort_merge() {
            Ok(()) => None,
            Err(e) => Some(format!("; additionally `git merge --abort` failed: {e}")),
        }
    }

    /// Resolve every unmerged path (D6): ours stays in the tree, theirs
    /// becomes a Conflict Copy unless the two sides are byte-identical.
    fn resolve_unmerged(&self) -> Result<(Vec<ConflictCopy>, Vec<String>), SyncError> {
        let mut copies = Vec::new();
        let mut warnings = Vec::new();
        for entry in self.git.unmerged()? {
            let path = entry.path.as_str();
            match (entry.stages[2], entry.stages[3]) {
                // Both sides changed it.
                (true, true) => {
                    let ours = self.git.show_stage(2, path)?;
                    let theirs = self.git.show_stage(3, path)?;
                    // A hand-made resolution (differs from ours, carries no
                    // conflict markers) is kept as it is — overwriting it
                    // with stage 2 would throw the user's merge away (D24).
                    let worktree = std::fs::read(self.root.join(path)).ok();
                    let hand_resolved = worktree.as_deref().is_some_and(|w| {
                        w != ours.as_slice()
                            && std::str::from_utf8(w)
                                .map(|t| !crate::vault::conflict::has_conflict_markers(t))
                                .unwrap_or(true)
                    });
                    if hand_resolved {
                        self.git.add(&[path])?;
                    } else {
                        self.git.checkout_side(Side::Ours, path)?;
                        if ours == theirs {
                            self.git.add(&[path])?;
                        } else if is_lfs_pointer(&theirs) {
                            // The pointer stands in for a blob this
                            // repository does not hold: a copy of it would be
                            // metadata, not the user's content.
                            warnings.push(format!(
                                "both sides changed {path}, but the incoming side is a git-LFS pointer; kept ours and wrote no conflict copy"
                            ));
                            self.git.add(&[path])?;
                        } else {
                            let copy = write_conflict_copy(&self.root, path, &theirs)?;
                            self.git.add(&[path, copy.copy.as_str()])?;
                            copies.push(copy);
                        }
                    }
                }
                // They deleted it, we did not: a page in the tree wins.
                (true, false) => {
                    self.git.checkout_side(Side::Ours, path)?;
                    self.git.add(&[path])?;
                }
                // We deleted it, they did not: restore wins over purge.
                (false, true) => {
                    self.git.checkout_side(Side::Theirs, path)?;
                    self.git.add(&[path])?;
                }
                // Base only — git does not produce this, but the index must
                // not be left unmerged whatever it holds.
                (false, false) => {
                    warnings.push(format!(
                        "unmerged path {path} has neither an \"ours\" nor a \"theirs\" stage; taking the working tree as it stands"
                    ));
                    self.git.add_including_removals(&[path])?;
                }
            }
        }
        Ok((copies, warnings))
    }

    /// Commit the merge git left staged, naming the Conflict Copies it
    /// produced.
    fn finish_merge(&self, headline: &str, copies: &[ConflictCopy]) -> Result<String, SyncError> {
        let commit = self
            .git
            .commit(&merge_message(headline, copies), &self.author)?;
        self.tighten_crypto_permissions();
        Ok(commit)
    }

    /// Push the branch, reporting a rejection rather than forcing it.
    pub fn push(&self) -> Result<PushStatus, SyncError> {
        if self.git.remote_url(REMOTE_NAME)?.is_none() {
            return Ok(PushStatus::NotAttempted);
        }
        let upstream = format!("{REMOTE_NAME}/{}", self.branch);
        if let Some((0, _)) = self.git.ahead_behind(&upstream)? {
            return Ok(PushStatus::NothingToPush);
        }
        match self.git.push(REMOTE_NAME, &self.branch) {
            Ok(PushOutcome::Pushed) => Ok(PushStatus::Pushed),
            Ok(PushOutcome::Rejected(stderr)) => Ok(PushStatus::Rejected(stderr)),
            Err(e @ GitError::Failed { .. }) => Ok(PushStatus::Failed(e.to_string())),
            Err(e) => Err(e.into()),
        }
    }

    /// D7: a rejection means someone else pushed first, so fetch and merge
    /// once more and push again. A second rejection is reported as it is.
    pub fn push_with_retry(&self) -> Result<PushStatus, SyncError> {
        let (status, retried) = self.push_with_retry_inner()?;
        if let Some((_, warnings)) = retried {
            for warning in warnings {
                tracing::warn!("sync: {warning}");
            }
        }
        Ok(status)
    }

    /// [`SyncEngine::push_with_retry`], keeping the retry's merge summary
    /// and warnings for [`SyncReport`].
    #[allow(clippy::type_complexity)]
    fn push_with_retry_inner(
        &self,
    ) -> Result<(PushStatus, Option<(MergeSummary, Vec<String>)>), SyncError> {
        let first = self.push()?;
        if !matches!(first, PushStatus::Rejected(_)) {
            return Ok((first, None));
        }
        let retried = self.pull_inner()?;
        Ok((self.push()?, Some(retried)))
    }

    /// Commit, pull, push: the whole sync (D7), recording the result (D8).
    pub fn full_sync(&self) -> Result<SyncReport, SyncError> {
        let started_at = Utc::now();
        self.record_outcome(self.full_sync_inner(started_at))
    }

    /// Record what a sync did (D8): the report on success, an `error:` line
    /// on failure — a failed sync must not leave the last success on show.
    fn record_outcome(
        &self,
        outcome: Result<SyncReport, SyncError>,
    ) -> Result<SyncReport, SyncError> {
        match outcome {
            Ok(report) => Ok(self.record(report)),
            Err(e) => {
                let line = format!("error: {}", first_line(&e.to_string()));
                if let Err(save) = self.save_state(&line, Utc::now()) {
                    tracing::warn!("sync: could not record sync state: {save}");
                }
                Err(e)
            }
        }
    }

    fn full_sync_inner(&self, started_at: DateTime<Utc>) -> Result<SyncReport, SyncError> {
        let committed = self.commit_local()?;
        let (mut merge, mut warnings) = self.pull_inner()?;
        let push = match merge {
            MergeSummary::NoRemote | MergeSummary::FetchFailed(_) => PushStatus::NotAttempted,
            _ => {
                let (status, retried) = self.push_with_retry_inner()?;
                if let Some((retry_merge, retry_warnings)) = retried {
                    warnings.extend(retry_warnings);
                    merge = fold_merges(merge, retry_merge);
                }
                status
            }
        };
        Ok(SyncReport {
            committed,
            merge,
            push,
            warnings,
            started_at,
            finished_at: Utc::now(),
        })
    }

    /// The shutdown path: commit what is outstanding and push it, without
    /// fetching — nothing may block a shutdown on the network for longer
    /// than the push itself.
    pub fn commit_and_push(&self) -> Result<SyncReport, SyncError> {
        let started_at = Utc::now();
        self.record_outcome(self.commit_and_push_inner(started_at))
    }

    fn commit_and_push_inner(&self, started_at: DateTime<Utc>) -> Result<SyncReport, SyncError> {
        let committed = self.commit_local()?;
        let merge = if self.git.remote_url(REMOTE_NAME)?.is_none() {
            MergeSummary::NoRemote
        } else {
            MergeSummary::NotFetched
        };
        let push = self.push()?;
        Ok(SyncReport {
            committed,
            merge,
            push,
            warnings: Vec::new(),
            started_at,
            finished_at: Utc::now(),
        })
    }

    /// What `clep sync status` reads.
    pub fn status(&self) -> Result<SyncStatus, SyncError> {
        let state = state::load(&self.git_dir);
        let upstream = format!("{REMOTE_NAME}/{}", self.branch);
        let (ahead, behind) = match self.git.ahead_behind(&upstream)? {
            Some((ahead, behind)) => (Some(ahead), Some(behind)),
            None => (None, None),
        };
        Ok(SyncStatus {
            // True by construction: `open_with_git` refuses otherwise.
            initialised: true,
            branch: self.branch.clone(),
            remote: self.git.remote_url(REMOTE_NAME)?,
            head: self.git.head()?,
            ahead,
            behind,
            dirty_files: self.git.status()?.len(),
            unmerged_files: self.git.unmerged()?.len(),
            conflict_copies: find_conflict_copies(&self.root).len(),
            last_sync_at: state.last_sync_at,
            last_sync_result: state.last_result,
        })
    }

    /// Record the report as this device's state (D8). A state file that
    /// cannot be written is a warning, never a failed sync.
    fn record(&self, mut report: SyncReport) -> SyncReport {
        if let Err(e) = self.save_state(&report.one_line(), report.finished_at) {
            report
                .warnings
                .push(format!("could not record sync state: {e}"));
        }
        report
    }

    /// Write one line of outcome and its timestamp to the git dir's
    /// `clep-sync.toml`.
    fn save_state(&self, result: &str, at: DateTime<Utc>) -> Result<(), SyncError> {
        state::save(
            &self.git_dir,
            &SyncState {
                last_sync_at: Some(at),
                last_result: Some(result.to_string()),
            },
        )
    }

    /// A checkout recreates `.clepsydra/crypto` with the umask, so tighten
    /// it after every merge that touched the tree. Never fatal.
    fn tighten_crypto_permissions(&self) {
        if let Err(e) = crate::vault::keyring::tighten_crypto_permissions(&self.root) {
            tracing::warn!("sync: crypto permissions: {e}");
        }
    }
}

/// The commit message for a set of changed paths: `sync: 3 pages (A, B, C)`,
/// `sync: 2 pages, 1 other file (A, B)`, `sync: 1 file`, plus the `Device:`
/// trailer (D9).
pub fn commit_message(root: &Path, entries: &[StatusEntry]) -> String {
    let pages: Vec<&str> = entries
        .iter()
        .map(|entry| entry.path.as_str())
        .filter(|path| path.ends_with(".md") && !path.starts_with(".clepsydra/"))
        .collect();
    let others = entries.len() - pages.len();

    let summary = if pages.is_empty() {
        format!("sync: {} file{}", entries.len(), plural(entries.len()))
    } else {
        let mut titles: Vec<String> = pages
            .iter()
            .take(TITLE_LIMIT)
            .map(|path| page_title(root, path))
            .collect();
        if pages.len() > TITLE_LIMIT {
            titles.push("…".to_string());
        }
        let mut summary = format!("sync: {} page{}", pages.len(), plural(pages.len()));
        if others > 0 {
            summary.push_str(&format!(", {others} other file{}", plural(others)));
        }
        summary.push_str(&format!(" ({})", titles.join(", ")));
        summary
    };
    super::with_device_trailer(&summary)
}

/// The message for a merge commit: the headline, the Conflict Copies the
/// merge produced, and the `Device:` trailer (D9).
fn merge_message(headline: &str, copies: &[ConflictCopy]) -> String {
    let mut message = headline.to_string();
    if !copies.is_empty() {
        message.push_str(&format!(
            "\n\n{} conflict cop{}:\n",
            copies.len(),
            if copies.len() == 1 { "y" } else { "ies" }
        ));
        for copy in copies {
            message.push_str(&format!("- {} -> {}\n", copy.original, copy.copy));
        }
    }
    super::with_device_trailer(&message)
}

/// Fold the merge a push retry performed into the one before it (D7).
///
/// The retry is the merge the tree ends on, but the Conflict Copies of the
/// first merge are just as real: both sets are reported, or the push would
/// carry copies no report ever mentions.
fn fold_merges(first: MergeSummary, retry: MergeSummary) -> MergeSummary {
    match retry {
        MergeSummary::Merged {
            commit,
            conflict_copies,
        } => {
            let mut copies = match first {
                MergeSummary::Merged {
                    conflict_copies, ..
                } => conflict_copies,
                _ => Vec::new(),
            };
            copies.extend(conflict_copies);
            MergeSummary::Merged {
                commit,
                conflict_copies: copies,
            }
        }
        MergeSummary::FastForward { head } if matches!(first, MergeSummary::UpToDate) => {
            MergeSummary::FastForward { head }
        }
        _ => first,
    }
}

/// A page's frontmatter title, falling back to its filename stem — a deleted
/// page has no frontmatter left to read.
fn page_title(root: &Path, rel: &str) -> String {
    let stem = || file_stem(rel).to_string();
    let Ok(content) = std::fs::read_to_string(root.join(rel)) else {
        return stem();
    };
    match crate::vault::page::parse_frontmatter(&content) {
        Ok((meta, _)) => meta.title.unwrap_or_else(stem),
        Err(_) => stem(),
    }
}

/// Git-LFS pointer files start with this exact line (LFS spec v1).
fn is_lfs_pointer(bytes: &[u8]) -> bool {
    bytes.starts_with(b"version https://git-lfs.github.com/spec/v1")
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use tempfile::TempDir;

    use super::*;
    use crate::vault::Vault;
    use crate::vault::gitsync::conflict_copy::find_conflict_copies;
    use crate::vault::gitsync::init::{InitOpts, LfsPolicy};
    use crate::vault::gitsync::{SyncError, testing};

    /// A [`SyncEngine`] over one of `TestRepos`' clones. `TestRepos` clones
    /// already carry the D3 marker `init` would have written.
    fn engine(root: &Path) -> SyncEngine {
        let git = testing::git(root);
        let vault = Vault::open(root).unwrap();
        SyncEngine::open_with_git(&vault, git).unwrap()
    }

    fn page(id_tail: &str, title: &str, body: &str) -> String {
        format!(
            "+++\nid = \"0192b6c0-0000-7000-8000-0000000000{id_tail}\"\ntitle = \"{title}\"\n+++\n{body}\n"
        )
    }

    #[test]
    fn commit_local_builds_message_with_titles_and_device_trailer() {
        let repos = testing::TestRepos::new();
        testing::write(&repos.a, "notes/a.md", &page("01", "Alpha", "a"));
        testing::write(&repos.a, "notes/b.md", &page("02", "Beta", "b"));
        testing::write(&repos.a, "_attachments/x.bin", "bin");
        let summary = engine(&repos.a).commit_local().unwrap().unwrap();
        assert_eq!(summary.files, 3);
        assert!(
            summary
                .message
                .starts_with("sync: 2 pages, 1 other file (Alpha, Beta)"),
            "{}",
            summary.message
        );
        assert!(summary.message.contains("\nDevice: "));
        assert!(
            engine(&repos.a).commit_local().unwrap().is_none(),
            "clean tree commits nothing"
        );
    }

    #[test]
    fn commit_local_finishes_a_merge_left_in_progress() {
        let repos = testing::TestRepos::new();
        testing::write(&repos.a, "notes/p.md", &page("12", "Plan", "base"));
        engine(&repos.a).full_sync().unwrap();
        engine(&repos.b).full_sync().unwrap();
        testing::write(&repos.a, "notes/p.md", &page("12", "Plan", "A's edit"));
        engine(&repos.a).full_sync().unwrap();

        // B commits its own edit, then a merge is started and abandoned
        // mid-conflict: a process killed here, or a merge run by hand.
        testing::write(&repos.b, "notes/p.md", &page("12", "Plan", "B's edit"));
        let gb = testing::git(&repos.b);
        gb.add_all().unwrap();
        gb.commit("b", &testing::author()).unwrap();
        gb.fetch("origin", "main").unwrap();
        assert_eq!(gb.merge_no_commit("origin/main").unwrap().status, 1);
        assert!(gb.merge_head().unwrap().is_some());
        assert!(
            testing::read(&repos.b, "notes/p.md").contains("<<<<<<<"),
            "the abandoned merge left conflict markers in the tree"
        );

        let summary = engine(&repos.b).commit_local().unwrap().unwrap();

        assert!(gb.merge_head().unwrap().is_none(), "merge finished");
        assert!(gb.status().unwrap().is_empty(), "tree is clean");
        let parents = gb
            .run(&["rev-list", "--parents", "-n", "1", "HEAD"])
            .unwrap();
        assert_eq!(
            parents.split_whitespace().count(),
            3,
            "HEAD is a merge commit: {parents}"
        );
        assert!(
            summary
                .message
                .starts_with("sync: resolve in-progress merge"),
            "{}",
            summary.message
        );
        let copies = find_conflict_copies(&repos.b);
        assert_eq!(copies.len(), 1, "{copies:?}");
        assert!(copies[0].starts_with("notes/p.conflict."));
        let committed = gb.run(&["show", "HEAD:notes/p.md"]).unwrap();
        assert!(
            !committed.contains("<<<<<<<"),
            "no conflict markers were committed: {committed}"
        );
        assert_eq!(committed.trim(), page("12", "Plan", "B's edit").trim());
    }

    /// A linked worktree's `.git` is a FILE, so the state file has to follow
    /// the resolved git dir rather than `<root>/.git/` (D25).
    #[test]
    fn state_lands_in_the_linked_worktree_git_dir() {
        let repos = testing::TestRepos::new();
        testing::write(&repos.a, "n.md", &page("20", "N", "x"));
        engine(&repos.a).full_sync().unwrap();
        let linked = repos.tmp.path().join("a-linked");
        testing::git(&repos.a)
            .run(&[
                "worktree",
                "add",
                "-q",
                linked.to_str().unwrap(),
                "-b",
                "linked",
                "main",
            ])
            .unwrap();
        assert!(
            linked.join(".git").is_file(),
            "a linked worktree's .git is a file"
        );

        // The linked checkout carries `.clepsydra/config.toml` (it is in the
        // tree), and repo-local config (the D3 marker) is shared, so the
        // engine opens over it.
        let vault = Vault::open(&linked).unwrap();
        let eng = SyncEngine::open_with_git(&vault, testing::git(&linked)).unwrap();
        testing::write(&linked, "m.md", &page("21", "M", "y"));
        let report = eng.commit_and_push().expect("commit_and_push");
        assert_eq!(
            report.warnings,
            Vec::<String>::new(),
            "the state file was written without complaint"
        );

        let git_dir = testing::git(&linked).git_dir().unwrap();
        assert!(
            git_dir.join("clep-sync.toml").is_file(),
            "state in {git_dir:?}"
        );
        assert!(
            !linked.join(".git").is_dir(),
            "nothing turned the .git file into a directory"
        );
        assert!(eng.status().unwrap().last_sync_at.is_some());
    }

    /// D24: a leftover merge the user resolved by hand is committed as it
    /// stands. Overwriting it with stage 2 would throw their merge away.
    #[test]
    fn hand_resolved_leftover_merge_is_kept_without_a_copy() {
        let repos = testing::TestRepos::new();
        testing::write(&repos.a, "notes/p.md", &page("30", "Plan", "base"));
        engine(&repos.a).full_sync().unwrap();
        engine(&repos.b).full_sync().unwrap();
        testing::write(&repos.a, "notes/p.md", &page("30", "Plan", "A's edit"));
        engine(&repos.a).full_sync().unwrap();

        testing::write(&repos.b, "notes/p.md", &page("30", "Plan", "B's edit"));
        let gb = testing::git(&repos.b);
        gb.add_all().unwrap();
        gb.commit("b", &testing::author()).unwrap();
        gb.fetch("origin", "main").unwrap();
        assert_eq!(gb.merge_no_commit("origin/main").unwrap().status, 1);

        // The user resolves by hand: no markers, not equal to either side.
        testing::write(&repos.b, "notes/p.md", &page("30", "Plan", "hand-merged"));
        engine(&repos.b).commit_local().unwrap().unwrap();

        assert_eq!(
            testing::read(&repos.b, "notes/p.md"),
            page("30", "Plan", "hand-merged")
        );
        assert!(
            find_conflict_copies(&repos.b).is_empty(),
            "hand resolution needs no copy"
        );
        assert!(gb.merge_head().unwrap().is_none(), "merge finished");
        assert!(gb.status().unwrap().is_empty(), "tree is clean");
    }

    /// D24: only a merge is ours to finish. A cherry-pick or rebase owning
    /// the unmerged state is refused rather than committed as sync residue.
    #[test]
    fn cherry_pick_in_progress_refuses_to_sync() {
        let repos = testing::TestRepos::new();
        testing::write(&repos.a, "c.md", &page("31", "C", "base"));
        let ga = testing::git(&repos.a);
        engine(&repos.a).full_sync().unwrap();
        ga.run(&["checkout", "-q", "-b", "side"]).unwrap();
        testing::write(&repos.a, "c.md", &page("31", "C", "side edit"));
        ga.add_all().unwrap();
        let side = ga.commit("side", &testing::author()).unwrap();
        ga.run(&["checkout", "-q", "main"]).unwrap();
        testing::write(&repos.a, "c.md", &page("31", "C", "main edit"));
        ga.add_all().unwrap();
        ga.commit("main", &testing::author()).unwrap();
        // Conflicts, leaving CHERRY_PICK_HEAD and an unmerged path behind.
        let _ = ga.run_raw(&["cherry-pick", &side]);
        assert!(ga.rev_parse("CHERRY_PICK_HEAD").unwrap().is_some());

        let err = engine(&repos.a).full_sync().unwrap_err();

        assert!(
            matches!(err, SyncError::GitOperationInProgress { .. }),
            "{err}"
        );
        assert!(
            ga.rev_parse("CHERRY_PICK_HEAD").unwrap().is_some(),
            "the refusal leaves the cherry-pick for the user to finish"
        );
    }

    /// A git-LFS pointer is a stand-in for a blob the repository does not
    /// hold; writing one as a Conflict Copy would leave the user a file of
    /// metadata, not their content.
    #[test]
    fn lfs_pointer_theirs_is_not_written_as_a_copy() {
        const POINTER_A: &str =
            "version https://git-lfs.github.com/spec/v1\noid sha256:aaaa\nsize 1\n";
        const POINTER_B: &str =
            "version https://git-lfs.github.com/spec/v1\noid sha256:bbbb\nsize 2\n";
        let repos = testing::TestRepos::new();
        testing::write(&repos.a, "blob.bin", "base");
        engine(&repos.a).full_sync().unwrap();
        engine(&repos.b).full_sync().unwrap();
        testing::write(&repos.a, "blob.bin", POINTER_A);
        engine(&repos.a).full_sync().unwrap();
        testing::write(&repos.b, "blob.bin", POINTER_B);

        let rb = engine(&repos.b).full_sync().unwrap();

        assert!(rb.conflict_copies().is_empty(), "{:?}", rb.merge);
        assert!(
            rb.warnings.iter().any(|w| w.contains("LFS pointer")),
            "{:?}",
            rb.warnings
        );
        assert_eq!(testing::read(&repos.b, "blob.bin"), POINTER_B, "ours stays");
    }

    #[test]
    fn full_sync_without_remote_commits_and_skips_network() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("v");
        crate::vault::init::init_vault(&root).unwrap();
        let git = testing::git(&root);
        crate::vault::gitsync::init::init(
            &Vault::open(&root).unwrap(),
            &git,
            InitOpts {
                remote: None,
                author: Some(testing::author()),
                lfs: LfsPolicy::Skip,
                prompt: None,
                legacy_cas: None,
            },
        )
        .unwrap();
        testing::write(&root, "n.md", &page("03", "N", "x"));
        let report = SyncEngine::open_with_git(&Vault::open(&root).unwrap(), git)
            .unwrap()
            .full_sync()
            .unwrap();
        assert!(report.committed.is_some());
        assert!(matches!(report.merge, MergeSummary::NoRemote));
        assert!(matches!(report.push, PushStatus::NotAttempted));
        assert!(!report.tree_changed());
    }

    #[test]
    fn two_devices_converge_without_conflicts() {
        let repos = testing::TestRepos::new();
        testing::write(&repos.a, "notes/a.md", &page("01", "Alpha", "a"));
        let ra = engine(&repos.a).full_sync().unwrap();
        assert!(matches!(ra.push, PushStatus::Pushed));
        let rb = engine(&repos.b).full_sync().unwrap();
        assert!(
            matches!(rb.merge, MergeSummary::FastForward { .. }),
            "{:?}",
            rb.merge
        );
        assert!(rb.tree_changed());
        assert_eq!(
            testing::read(&repos.b, "notes/a.md"),
            page("01", "Alpha", "a")
        );
        assert!(matches!(rb.push, PushStatus::NothingToPush));
        testing::write(&repos.b, "notes/b.md", &page("02", "Beta", "b"));
        engine(&repos.b).full_sync().unwrap();
        let ra2 = engine(&repos.a).full_sync().unwrap();
        assert!(matches!(ra2.merge, MergeSummary::FastForward { .. }));
        assert!(repos.a.join("notes/b.md").is_file());
        let st = engine(&repos.a).status().unwrap();
        assert_eq!((st.ahead, st.behind), (Some(0), Some(0)));
        assert!(st.last_sync_at.is_some());
    }

    #[test]
    fn concurrent_edits_of_one_page_yield_ours_plus_conflict_copy() {
        let repos = testing::TestRepos::new();
        testing::write(&repos.a, "notes/p.md", &page("05", "Plan", "base"));
        engine(&repos.a).full_sync().unwrap();
        engine(&repos.b).full_sync().unwrap();
        testing::write(&repos.a, "notes/p.md", &page("05", "Plan", "A's edit"));
        engine(&repos.a).full_sync().unwrap();
        testing::write(&repos.b, "notes/p.md", &page("05", "Plan", "B's edit"));
        let rb = engine(&repos.b).full_sync().unwrap();
        let MergeSummary::Merged {
            conflict_copies, ..
        } = &rb.merge
        else {
            panic!("{:?}", rb.merge)
        };
        assert_eq!(conflict_copies.len(), 1);
        assert_eq!(conflict_copies[0].original, "notes/p.md");
        assert!(conflict_copies[0].copy.starts_with("notes/p.conflict."));
        assert_eq!(
            testing::read(&repos.b, "notes/p.md"),
            page("05", "Plan", "B's edit"),
            "ours stays"
        );
        let copy = testing::read(&repos.b, &conflict_copies[0].copy);
        assert!(copy.contains("A's edit"));
        assert!(copy.contains("conflict_of = \"notes/p.md\""));
        assert!(copy.contains("title = \"Plan (conflict "));
        let copy_meta = crate::vault::page::parse_frontmatter(&copy).unwrap().0;
        assert_ne!(
            copy_meta.id.to_string(),
            "0192b6c0-0000-7000-8000-000000000005",
            "copy has a fresh id"
        );
        assert!(matches!(rb.push, PushStatus::Pushed));
        assert!(
            testing::git(&repos.b).status().unwrap().is_empty(),
            "tree is clean after sync"
        );
        let ra = engine(&repos.a).full_sync().unwrap();
        assert!(matches!(ra.merge, MergeSummary::FastForward { .. }));
        assert!(repos.a.join(&conflict_copies[0].copy).is_file());
        assert_eq!(ra.warnings, Vec::<String>::new());
    }

    #[test]
    fn identical_concurrent_edits_do_not_produce_a_copy() {
        let repos = testing::TestRepos::new();
        testing::write(&repos.a, "n.md", &page("06", "N", "base"));
        engine(&repos.a).full_sync().unwrap();
        engine(&repos.b).full_sync().unwrap();
        testing::write(&repos.a, "n.md", &page("06", "N", "same"));
        engine(&repos.a).full_sync().unwrap();
        testing::write(&repos.b, "n.md", &page("06", "N", "same"));
        let rb = engine(&repos.b).full_sync().unwrap();
        assert!(rb.conflict_copies().is_empty(), "{:?}", rb.merge);
        assert!(find_conflict_copies(&repos.b).is_empty());
    }

    #[test]
    fn page_present_in_tree_wins_over_deletion() {
        let repos = testing::TestRepos::new();
        testing::write(&repos.a, "d.md", &page("07", "D", "base"));
        engine(&repos.a).full_sync().unwrap();
        engine(&repos.b).full_sync().unwrap();
        // A deletes, B edits -> B's edit survives on both sides.
        fs::remove_file(repos.a.join("d.md")).unwrap();
        engine(&repos.a).full_sync().unwrap();
        testing::write(&repos.b, "d.md", &page("07", "D", "edited"));
        let rb = engine(&repos.b).full_sync().unwrap();
        assert!(rb.conflict_copies().is_empty());
        assert_eq!(testing::read(&repos.b, "d.md"), page("07", "D", "edited"));
        engine(&repos.a).full_sync().unwrap();
        assert_eq!(testing::read(&repos.a, "d.md"), page("07", "D", "edited"));
        // Mirror: B deletes, A edits.
        fs::remove_file(repos.b.join("d.md")).unwrap();
        engine(&repos.b).full_sync().unwrap();
        testing::write(&repos.a, "d.md", &page("07", "D", "edited again"));
        engine(&repos.a).full_sync().unwrap();
        assert_eq!(
            testing::read(&repos.a, "d.md"),
            page("07", "D", "edited again")
        );
    }

    #[test]
    fn push_rejection_triggers_one_more_pull_then_succeeds() {
        let repos = testing::TestRepos::new();
        testing::write(&repos.a, "a.md", &page("08", "A", "a"));
        engine(&repos.a).full_sync().unwrap();
        engine(&repos.b).full_sync().unwrap();
        // Race: A pushes after B fetched but before B pushes.
        testing::write(&repos.b, "b.md", &page("09", "B", "b"));
        let eb = engine(&repos.b);
        eb.commit_local().unwrap();
        assert!(matches!(eb.pull().unwrap(), MergeSummary::UpToDate));
        testing::write(&repos.a, "a2.md", &page("10", "A2", "a2"));
        engine(&repos.a).full_sync().unwrap();
        let report = eb.push_with_retry().unwrap();
        assert!(matches!(report, PushStatus::Pushed));
        assert!(repos.b.join("a2.md").is_file());
    }

    /// A `pre-push` hook in `root` that pushes `other` to the shared remote
    /// before the push it precedes — the one deterministic way to land a
    /// remote change between a sync's fetch and its push. It removes itself
    /// so only the first push loses the race.
    #[cfg(unix)]
    fn race_push_from(root: &Path, other: &Path) {
        use std::os::unix::fs::PermissionsExt;

        let hook = root.join(".git/hooks/pre-push");
        fs::create_dir_all(hook.parent().unwrap()).unwrap();
        fs::write(
            &hook,
            format!(
                "#!/bin/sh\n\
                 rm -f -- \"$0\"\n\
                 cat > /dev/null\n\
                 unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR\n\
                 git -C '{}' push -q origin main\n\
                 exit 0\n",
                other.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// The push retry's merge is the one the tree ends on, but the merge
    /// before it produced Conflict Copies too — the report must carry both.
    #[cfg(unix)]
    #[test]
    fn retry_merge_and_its_conflict_copies_reach_the_report() {
        let repos = testing::TestRepos::new();
        testing::write(&repos.a, "notes/p.md", &page("13", "P", "base"));
        testing::write(&repos.a, "notes/q.md", &page("14", "Q", "base"));
        engine(&repos.a).full_sync().unwrap();
        engine(&repos.b).full_sync().unwrap();

        // Already on the remote when B syncs: conflicts with B's q edit.
        testing::write(&repos.a, "notes/q.md", &page("14", "Q", "A's q"));
        engine(&repos.a).full_sync().unwrap();
        // Committed but held back; the hook pushes it mid-sync.
        testing::write(&repos.a, "notes/p.md", &page("13", "P", "A's p"));
        engine(&repos.a).commit_local().unwrap().unwrap();

        testing::write(&repos.b, "notes/q.md", &page("14", "Q", "B's q"));
        testing::write(&repos.b, "notes/p.md", &page("13", "P", "B's p"));
        race_push_from(&repos.b, &repos.a);

        let report = engine(&repos.b).full_sync().unwrap();

        assert!(
            matches!(report.merge, MergeSummary::Merged { .. }),
            "{:?}",
            report.merge
        );
        assert!(
            matches!(report.push, PushStatus::Pushed),
            "{:?}",
            report.push
        );
        let mut originals: Vec<&str> = report
            .conflict_copies()
            .iter()
            .map(|copy| copy.original.as_str())
            .collect();
        originals.sort_unstable();
        assert_eq!(
            originals,
            vec!["notes/p.md", "notes/q.md"],
            "both merges' copies are reported"
        );
        assert!(
            report.one_line().contains("2 conflict copies"),
            "{}",
            report.one_line()
        );
        assert_eq!(find_conflict_copies(&repos.b).len(), 2);
        assert!(testing::git(&repos.b).status().unwrap().is_empty());
        assert_eq!(
            testing::read(&repos.b, "notes/p.md"),
            page("13", "P", "B's p"),
            "ours stays on both merges"
        );
    }

    #[test]
    fn fold_merges_keeps_every_conflict_copy() {
        let copy = |original: &str| ConflictCopy {
            original: original.to_string(),
            copy: format!("{original}.conflict.abc1234"),
        };
        let merged = |sha: &str, originals: &[&str]| MergeSummary::Merged {
            commit: sha.to_string(),
            conflict_copies: originals.iter().map(|o| copy(o)).collect(),
        };
        let copies = |summary: &MergeSummary| match summary {
            MergeSummary::Merged {
                conflict_copies, ..
            } => conflict_copies.len(),
            _ => 0,
        };

        // Both merges' copies survive, under the retry's commit.
        let folded = fold_merges(merged("aaa", &["a.md"]), merged("bbb", &["b.md"]));
        assert_eq!(copies(&folded), 2);
        let MergeSummary::Merged { commit, .. } = &folded else {
            panic!("{folded:?}")
        };
        assert_eq!(commit, "bbb");
        // A retry that merged after a fast-forward still reports its copies.
        assert_eq!(
            copies(&fold_merges(
                MergeSummary::FastForward { head: "aaa".into() },
                merged("bbb", &["b.md"])
            )),
            1
        );
        // Only an uneventful first pull is replaced by a fast-forward.
        assert!(matches!(
            fold_merges(
                MergeSummary::UpToDate,
                MergeSummary::FastForward { head: "bbb".into() }
            ),
            MergeSummary::FastForward { .. }
        ));
        assert!(matches!(
            fold_merges(
                MergeSummary::FastForward { head: "aaa".into() },
                MergeSummary::UpToDate
            ),
            MergeSummary::FastForward { head } if head == "aaa"
        ));
        assert_eq!(
            copies(&fold_merges(
                merged("aaa", &["a.md"]),
                MergeSummary::UpToDate
            )),
            1
        );
    }

    #[test]
    fn unrelated_histories_abort_cleanly() {
        let repos = testing::TestRepos::new();
        let stray = repos.tmp.path().join("stray");
        let g = testing::git(&stray);
        fs::create_dir_all(&stray).unwrap();
        g.init("main").unwrap();
        testing::write(&stray, "x.md", "x");
        g.add_all().unwrap();
        g.commit("stray", &testing::author()).unwrap();
        g.remote_add("origin", repos.remote.to_str().unwrap())
            .unwrap();
        // force the remote to hold an unrelated root: push -f is done by the
        // TEST, never by the engine
        g.run(&["push", "-f", "origin", "main"]).unwrap();
        let err = engine(&repos.a).full_sync().unwrap_err();
        assert!(matches!(err, SyncError::MergeFailed { .. }), "{err}");
        // git refuses unrelated histories before it starts a merge, so there
        // is nothing to abort — and nothing to confess to having failed to
        // abort. The error must be about the histories, only.
        assert!(
            !err.to_string().contains("merge --abort"),
            "no merge was started, so none should be aborted: {err}"
        );
        assert!(
            testing::git(&repos.a).merge_head().unwrap().is_none(),
            "merge aborted"
        );
        assert!(testing::git(&repos.a).status().unwrap().is_empty());
    }

    #[test]
    fn commit_and_push_reports_not_fetched_with_a_remote() {
        let repos = testing::TestRepos::new();
        testing::write(&repos.a, "n.md", &page("22", "N", "x"));
        let report = engine(&repos.a).commit_and_push().unwrap();
        assert!(
            matches!(report.merge, MergeSummary::NotFetched),
            "{report:?}"
        );
        assert!(
            report.one_line().contains("no fetch"),
            "{}",
            report.one_line()
        );
        assert!(!report.tree_changed());
    }

    #[test]
    fn commit_and_push_failure_records_an_error_state() {
        let repos = testing::TestRepos::new();
        testing::write(&repos.a, "n.md", &page("23", "N", "x"));
        engine(&repos.a).full_sync().unwrap();
        let git_dir = testing::git(&repos.a).git_dir().unwrap();
        assert!(
            !state::load(&git_dir)
                .last_result
                .unwrap_or_default()
                .starts_with("error:"),
            "the successful sync is on show before the failure"
        );

        // Poison the index so `commit_local` fails hard.
        fs::write(git_dir.join("index"), "garbage").unwrap();
        testing::write(&repos.a, "n2.md", &page("24", "N2", "y"));
        assert!(engine(&repos.a).commit_and_push().is_err());

        let state = state::load(&git_dir);
        assert!(
            state.last_result.unwrap_or_default().starts_with("error:"),
            "state records the failure"
        );
    }

    #[test]
    fn fetch_failure_is_reported_not_fatal() {
        let repos = testing::TestRepos::new();
        testing::git(&repos.a)
            .run(&["remote", "set-url", "origin", "/nonexistent/remote.git"])
            .unwrap();
        testing::write(&repos.a, "n.md", &page("11", "N", "n"));
        let report = engine(&repos.a).full_sync().unwrap();
        assert!(report.committed.is_some());
        assert!(matches!(report.merge, MergeSummary::FetchFailed(_)));
        assert!(matches!(report.push, PushStatus::NotAttempted));
        assert!(!report.is_success());
    }

    #[cfg(unix)]
    #[test]
    fn crypto_permissions_are_tightened_after_a_merge() {
        use std::os::unix::fs::PermissionsExt;

        let repos = testing::TestRepos::new();
        let keyring = repos.a.join(".clepsydra/crypto/keyring.toml");
        fs::create_dir_all(keyring.parent().unwrap()).unwrap();
        fs::write(&keyring, "keys = []\n").unwrap();
        fs::set_permissions(&keyring, fs::Permissions::from_mode(0o644)).unwrap();
        engine(&repos.a).full_sync().unwrap();

        let rb = engine(&repos.b).full_sync().unwrap();
        assert!(
            matches!(rb.merge, MergeSummary::FastForward { .. }),
            "{:?}",
            rb.merge
        );
        let dir = repos.b.join(".clepsydra/crypto");
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700, "crypto directory is owner-only");
        assert_eq!(
            mode(&dir.join("keyring.toml")),
            0o600,
            "keyring file is owner-only"
        );
    }

    #[test]
    fn commit_message_shapes() {
        let tmp = TempDir::new().unwrap();
        let entry = |path: &str| StatusEntry {
            xy: ['?', '?'],
            path: path.to_string(),
        };
        assert!(
            commit_message(tmp.path(), &[entry("_attachments/x.bin")])
                .starts_with("sync: 1 file\n")
        );
        assert!(
            commit_message(
                tmp.path(),
                &[entry("_attachments/x.bin"), entry("_attachments/y.bin")]
            )
            .starts_with("sync: 2 files\n")
        );
        // `.clepsydra/` markdown is not a page; missing files fall back to
        // their filename stem; more than three pages get an ellipsis.
        let message = commit_message(
            tmp.path(),
            &[
                entry("a.md"),
                entry("b.md"),
                entry("c.md"),
                entry("d.md"),
                entry(".clepsydra/templates/t.md"),
            ],
        );
        assert!(
            message.starts_with("sync: 4 pages, 1 other file (a, b, c, …)"),
            "{message}"
        );
    }
}
