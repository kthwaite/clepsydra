//! Git-backed vault synchronisation (`clep sync`).
//!
//! Distinct from [`crate::vault::sync`], which turns filesystem events into
//! index updates. This module drives the system `git` binary: repository
//! setup ([`init`]), the sync algorithm ([`engine`]), and Conflict Copies
//! ([`conflict_copy`]). Design: `docs/superpowers/specs/2026-08-27-clep-sync-design.md`,
//! ADR 0004.

pub mod config_writer;
pub mod git;
pub mod init;
pub mod managed_block;
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

/// A vault is sync-initialised iff its root is a git repository's toplevel
/// AND the repo-local `clep.sync.version` config key is set (D3, written by
/// [`init::init`]).
pub fn is_initialised(vault: &crate::vault::Vault, git: &git::Git) -> Result<bool, SyncError> {
    let Some(top) = git.toplevel()? else {
        return Ok(false);
    };
    let same_root = top.canonicalize().ok() == vault.root().canonicalize().ok();
    Ok(same_root && git.config_get(INIT_MARKER_KEY)?.is_some())
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
