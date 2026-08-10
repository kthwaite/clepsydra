pub mod academic;
pub mod academic_hook;
pub mod archive_hook;
pub mod atomic_file;
pub mod backup;
pub mod base;
pub mod base_embed;
pub mod base_document;
pub mod base_member;
pub mod bcl;
pub mod block;
pub mod block_id;
pub mod canonical;
pub mod cas;
pub mod checkpoint;
pub mod config;
pub mod context;
pub mod derivation;
pub mod derivers;
pub mod encryption;
pub mod geocode;
pub mod grep;
pub mod hooks;
pub mod import;
pub mod import_doi;
pub mod import_isbn;
pub mod import_zotero;
pub mod index;
pub mod index_handle;
pub mod index_policy;
pub mod init;
pub mod keyring;
pub mod kind;
pub mod legacy_yaml;
pub mod link;
pub mod location;
pub mod migrate;
pub mod mutation;
pub mod mutation_coordinator;
pub mod new_note;
pub mod page;
pub mod page_filename;
pub mod path;
pub mod projection;
pub mod property_value;
pub mod query;
pub mod reconcile;
pub mod relabel;
pub mod rewriter;
pub mod sync;
pub mod task_history;
pub mod toml_json;
pub mod toml_patch;
pub mod tree;

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
}
