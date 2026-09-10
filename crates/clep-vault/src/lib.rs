//! The vault model: pages, paths, frontmatter, links, and the on-disk
//! conventions that make up a Clepsydra vault, independent of SQLite and
//! HTTP. The `Vault` handle opens a vault root and resolves paths against it.

pub mod atomic_file;
pub mod attendance;
pub mod bcl;
pub mod block;
pub mod block_id;
pub mod board_vocab;
pub mod canonical;
pub mod code;
pub mod config;
pub mod conflict;
pub mod context;
pub mod conversation;
pub mod encryption;
pub mod init;
pub mod keyring;
pub mod kind;
pub mod legacy_yaml;
pub mod link;
pub mod location;
pub mod markdown;
pub mod meeting;
pub mod page;
pub mod page_filename;
pub mod path;
pub mod project;
pub mod projection;
pub mod rewriter;
pub mod rubbish;
pub mod task_history;
pub mod toml_json;
pub mod toml_patch;

use std::path::{Path, PathBuf};

use config::VaultConfig;
use path::VaultPath;

/// A handle to an opened vault on disk.
///
/// Holds the canonicalized root path, the parsed vault configuration, and
/// compiled glob patterns for file exclusion.
#[derive(Clone)]
pub struct Vault {
    root: PathBuf,
    config: VaultConfig,
    exclusion_patterns: Vec<glob::Pattern>,
}

impl Vault {
    /// Open an existing vault rooted at the given path.
    ///
    /// The root is canonicalized so that all subsequent path operations produce
    /// absolute paths. The vault configuration is loaded from
    /// `.clepsydra/config.toml` (defaulting if absent), and exclusion patterns
    /// are compiled from the config.
    pub fn open(root: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let root = root.canonicalize()?;
        let config = VaultConfig::load(&root)?;
        let exclusion_patterns = config
            .vault
            .excluded_patterns
            .iter()
            .map(|p| glob::Pattern::new(p))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            root,
            config,
            exclusion_patterns,
        })
    }

    /// Resolve a [`VaultPath`] to an absolute filesystem path.
    pub fn resolve(&self, vp: &VaultPath) -> PathBuf {
        self.root.join(vp.as_str())
    }

    /// Test whether a [`VaultPath`] is reserved or matches any configured
    /// exclusion pattern. The root `feeds.md` manifest is always reserved;
    /// users cannot accidentally make it indexable by replacing the defaults.
    pub fn is_excluded(&self, vp: &VaultPath) -> bool {
        let path = vp.as_str();
        path == "feeds.md"
            || self
                .exclusion_patterns
                .iter()
                .any(|pattern| pattern.matches(path))
    }

    /// The canonicalized vault root directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The loaded vault configuration.
    pub fn config(&self) -> &VaultConfig {
        &self.config
    }

    /// Absolute CAS root for this vault (see `config::resolve_cas_path`).
    pub fn cas_root(&self) -> PathBuf {
        crate::config::resolve_cas_path(&self.config.archive.cas_path, &self.root)
    }
}
