//! Git-backed vault synchronisation (`clep sync`).
//!
//! Distinct from [`crate::vault::sync`], which turns filesystem events into
//! index updates. This module drives the system `git` binary: repository
//! setup ([`init`]), the sync algorithm ([`engine`]), and Conflict Copies
//! ([`conflict_copy`]). Design: `docs/superpowers/specs/2026-08-27-clep-sync-design.md`,
//! ADR 0004.

pub mod config_writer;
pub mod conflict_copy;
pub mod engine;
pub mod git;
pub mod init;
pub mod journal_merge;
pub mod managed_block;
pub mod merge_driver;
pub mod state;
#[cfg(test)]
pub(crate) mod testing;

use std::path::Path;

use thiserror::Error;

/// The only remote sync talks to.
pub const REMOTE_NAME: &str = "origin";

/// Repo-local git config key `clep sync init` writes; its presence is the
/// "initialised" marker (D3).
pub const INIT_MARKER_KEY: &str = "clep.sync.version";
pub const INIT_MARKER_VALUE: &str = "1";

/// Managed `.gitignore` lines (spec §2, exact).
pub const MANAGED_GITIGNORE: &[&str] = &[
    ".clepsydra/cache.db*",
    ".clepsydra/feeds.db*",
    ".clepsydra/*.lock",
    ".clepsydra/.feeds.db.*.lock",
    ".clepsydra/transactions/",
    ".clepsydra/cas/cas.db*",
    ".clepsydra/cas/cas.lock",
    ".clepsydra/crypto/*.identity.age",
    ".DS_Store",
];

/// Managed `.gitattributes` lines (spec §§3, 5, exact).
pub const MANAGED_GITATTRIBUTES: &[&str] = &[
    "*.md merge=clep",
    ".clepsydra/cas/** filter=lfs diff=lfs merge=lfs -text",
    "_attachments/** filter=lfs diff=lfs merge=lfs -text",
];

/// The key naming the driver command — the one registration key whose
/// presence means `*.md` merges go through `clep merge-driver` (D19).
pub const MERGE_DRIVER_KEY: &str = "merge.clep.driver";

/// Repo-local merge-driver registration `clep sync init` writes (spec §5).
/// `recursive = binary` keeps the driver out of the recursive strategy's
/// internal virtual-ancestor merges.
pub const MERGE_DRIVER_KEYS: &[(&str, &str)] = &[
    ("merge.clep.name", "clepsydra structural markdown merge"),
    (MERGE_DRIVER_KEY, "clep merge-driver %O %A %B %P"),
    ("merge.clep.recursive", "binary"),
];

/// Commit identity taken from `[sync] author_name` / `author_email`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Author {
    pub name: String,
    pub email: String,
}

impl Author {
    /// The configured author, if both halves are present and non-blank.
    pub fn from_config(section: &crate::vault::config::SyncSection) -> Option<Self> {
        let name = section.author_name.as_deref()?.trim();
        let email = section.author_email.as_deref()?.trim();
        (!name.is_empty() && !email.is_empty()).then(|| Self {
            name: name.to_string(),
            email: email.to_string(),
        })
    }
}

#[derive(Debug, Error)]
pub enum SyncError {
    #[error("git is not installed or not on PATH: {0}")]
    GitMissing(String),
    #[error(transparent)]
    Git(#[from] git::GitError),
    #[error(
        "vault root {root} is inside another git repository ({outer}); move the vault or remove the outer repository"
    )]
    NestedRepo { root: String, outer: String },
    #[error("sync is not initialised for this vault — run `clep sync init`")]
    NotInitialised,
    #[error("[sync] author_name and author_email are not set — run `clep sync init`")]
    MissingAuthor,
    #[error(
        "repository is on branch {actual:?} but [sync] branch = {configured:?}; check out the configured branch or change the config"
    )]
    BranchMismatch { actual: String, configured: String },
    #[error("remote {name} already points at {existing}, not {requested}")]
    RemoteMismatch {
        name: String,
        existing: String,
        requested: String,
    },
    #[error(
        "git-lfs is required for sync but `git lfs version` failed: {0}. Install git-lfs (e.g. `brew install git-lfs`) and retry"
    )]
    LfsMissing(String),
    #[error(
        "remote {url} does not answer the git-lfs batch API ({detail}); sync requires an LFS-capable remote"
    )]
    LfsRemoteUnsupported { url: String, detail: String },
    #[error("merge of {reference} failed: {detail}")]
    MergeFailed { reference: String, detail: String },
    #[error(
        "a {operation} is in progress in this repository; finish or abort it (`git {operation} --continue|--abort`), then sync again"
    )]
    GitOperationInProgress { operation: String },
    #[error("I/O error at {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("{0}")]
    Config(String),
}

impl SyncError {
    pub(crate) fn io(path: &Path, source: std::io::Error) -> Self {
        Self::Io {
            path: path.display().to_string(),
            source,
        }
    }
}

/// Whether `root` could be a sync repository at all: D3 requires the vault
/// root to *be* the repository toplevel, so a root with no `.git` entry is
/// definitively not initialised.
///
/// Filesystem-only, and that is the point — it lets every non-syncing vault
/// answer [`is_initialised`]'s question at startup and on every `clep doctor`
/// run without spawning a single `git`. Inside a linked worktree or a
/// submodule `.git` is a file rather than a directory, so either counts.
pub fn has_git_entry(root: &Path) -> bool {
    root.join(".git").exists()
}

/// A vault is sync-initialised iff its root is a git repository's toplevel
/// AND the repo-local `clep.sync.version` config key is set (D3, written by
/// [`init::init`]).
///
/// The marker is read in the `--local` scope only: a `clep.sync.version` a
/// user has in `~/.gitconfig` would otherwise make every repository on the
/// machine claim to be sync-initialised.
pub fn is_initialised(vault: &crate::vault::Vault, git: &git::Git) -> Result<bool, SyncError> {
    let Some(top) = git.toplevel()? else {
        return Ok(false);
    };
    let same_root = top.canonicalize().ok() == vault.root().canonicalize().ok();
    Ok(same_root && git.config_get_local(INIT_MARKER_KEY)?.is_some())
}

/// The local machine's hostname, recorded in every commit's `Device:`
/// trailer (D9) so a conflict or a `clep sync status` report can say which
/// device made a change.
pub fn device_name() -> String {
    gethostname::gethostname().to_string_lossy().into_owned()
}

/// Append a `Device: <hostname>` trailer to a commit message.
pub fn with_device_trailer(message: &str) -> String {
    format!("{}\n\nDevice: {}\n", message.trim_end(), device_name())
}

pub(crate) fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

/// Git's stderr is multi-line; a one-line report takes the first of it.
pub(crate) fn first_line(text: &str) -> &str {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::{INIT_MARKER_KEY, has_git_entry};
    use crate::vault::gitsync::git::Git;
    use crate::vault::gitsync::testing;

    #[test]
    fn a_global_marker_does_not_count_as_initialised() {
        let repos = testing::TestRepos::new();
        // A private `GIT_CONFIG_GLOBAL`: writing the marker into the shared
        // one `testing::git` uses would leak into every other test in the
        // process.
        let global = repos.tmp.path().join("gitconfig-with-marker");
        std::fs::write(&global, "[clep \"sync\"]\n\tversion = 1\n").unwrap();
        let git = Git::new(&repos.a)
            .with_env("GIT_CONFIG_GLOBAL", global.to_str().unwrap())
            .with_env("GIT_CONFIG_NOSYSTEM", "1");
        // `TestRepos` writes the marker locally; only the global one is left.
        git.run(&["config", "--local", "--unset", INIT_MARKER_KEY])
            .unwrap();
        assert_eq!(
            git.config_get(INIT_MARKER_KEY).unwrap().as_deref(),
            Some("1"),
            "the merged config does see the global marker"
        );

        let vault = crate::vault::Vault::open(&repos.a).unwrap();
        assert!(
            !super::is_initialised(&vault, &git).unwrap(),
            "a global clep.sync.version must not make a vault look initialised"
        );
    }

    #[test]
    fn a_git_dir_or_a_git_file_both_count_as_a_repository_entry() {
        let plain = TempDir::new().unwrap();
        assert!(!has_git_entry(plain.path()));

        let repo = TempDir::new().unwrap();
        std::fs::create_dir(repo.path().join(".git")).unwrap();
        assert!(has_git_entry(repo.path()));

        // A linked worktree or a submodule has a `.git` FILE, not a directory.
        let linked = TempDir::new().unwrap();
        std::fs::write(linked.path().join(".git"), "gitdir: /elsewhere/.git\n").unwrap();
        assert!(has_git_entry(linked.path()));
    }
}
