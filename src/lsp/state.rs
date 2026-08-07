//! Vault state for the standalone LSP process.
//!
//! The LSP is read-only by design: it opens the vault with a private
//! in-memory index and never writes vault files. Edits reach the vault
//! through the editor (buffer saves, applied WorkspaceEdits); the running
//! `clep serve` absorbs them like any other external edit (ADR 0001).
use std::path::{Path, PathBuf};

use tower_lsp::lsp_types::InitializeParams;

use crate::vault::Vault;
use crate::vault::index::VaultIndex;
use crate::vault::index_handle::IndexHandle;

pub struct LspState {
    pub vault: Vault,
    pub index: IndexHandle,
}

/// Open `root` as a vault and build a fully-derived in-memory index.
/// Blocking (full index build) — call from `spawn_blocking` in async context.
pub fn open_lsp_state(root: &Path) -> Result<LspState, Box<dyn std::error::Error + Send + Sync>> {
    let vault = Vault::open(root)
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.to_string().into() })?;
    let mut index = VaultIndex::open_in_memory()?;
    index.build(&vault)?;
    index.resolve_links()?;
    let index = IndexHandle::spawn(index, vault.clone());
    Ok(LspState { vault, index })
}

/// Resolve the vault root for a standalone LSP session.
///
/// Priority: any workspace folder (then the deprecated rootUri) whose
/// ancestor chain contains a `.clepsydra` directory; otherwise the
/// application config lookup relative to `cwd` (./config.toml → XDG).
pub(crate) fn resolve_lsp_root(params: &InitializeParams, cwd: &Path) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for folder in params.workspace_folders.iter().flatten() {
        if let Ok(p) = folder.uri.to_file_path() {
            candidates.push(p);
        }
    }
    #[allow(deprecated)]
    if let Some(uri) = &params.root_uri
        && let Ok(p) = uri.to_file_path()
    {
        candidates.push(p);
    }
    for candidate in &candidates {
        for dir in candidate.ancestors() {
            if dir.join(".clepsydra").is_dir() {
                return Ok(dir.to_path_buf());
            }
        }
    }
    let (settings, config_path) = crate::Settings::load(cwd).map_err(|e| {
        format!("no .clepsydra directory in the workspace and no config.toml found: {e}")
    })?;
    Ok(crate::resolve_vault_root(
        &settings.vault.root,
        &config_path,
        cwd,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower_lsp::lsp_types::{Url, WorkspaceFolder};

    #[test]
    fn opens_vault_with_in_memory_index() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        std::fs::write(root.join("Note.md"), "# Note\n\nbody\n").unwrap();

        let state = open_lsp_state(&root).unwrap();
        assert_eq!(state.vault.root(), root.canonicalize().unwrap());
        // No index db file may appear inside the vault:
        assert!(!root.join(".clepsydra/cache.db").exists());
        assert!(!root.join(".clepsydra/index.db").exists());
    }

    #[test]
    fn resolves_workspace_folder_with_marker() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let sub = root.join("notes");
        std::fs::create_dir_all(&sub).unwrap();

        #[allow(deprecated)]
        let params = InitializeParams {
            workspace_folders: Some(vec![WorkspaceFolder {
                uri: Url::from_file_path(&sub).unwrap(),
                name: "notes".into(),
            }]),
            ..Default::default()
        };
        // Marker found by walking ancestors from the workspace folder:
        assert_eq!(resolve_lsp_root(&params, tmp.path()).unwrap(), root);
    }

    #[test]
    fn falls_back_to_config_lookup_without_marker() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        std::fs::write(
            tmp.path().join("config.toml"),
            format!("[vault]\nroot = \"{}\"\n", root.display()),
        )
        .unwrap();
        let params = InitializeParams::default();
        let resolved = resolve_lsp_root(&params, tmp.path()).unwrap();
        assert_eq!(resolved, root);
    }

    /// RAII guard that records the prior value of an env var on construction
    /// and restores it on drop. Mirrors `doctor::tests::EnvGuard` — required
    /// because the default test runner shares process-wide env state across
    /// threads, and `find_config_path`/`dirs::home_dir` read these values.
    struct EnvGuard {
        key: &'static str,
        prior: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let prior = std::env::var_os(key);
            // SAFETY: tests touching env are gated behind `#[serial_test::serial]`
            // so no other thread is racing on the same variable.
            unsafe { std::env::set_var(key, value) }
            Self { key, prior }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            // SAFETY: see `set`.
            unsafe {
                match self.prior.take() {
                    Some(v) => std::env::set_var(self.key, v),
                    None => std::env::remove_var(self.key),
                }
            }
        }
    }

    #[test]
    #[serial_test::serial]
    fn errors_when_nothing_resolves() {
        let tmp = tempfile::TempDir::new().unwrap();
        // Override XDG/HOME so the config lookup doesn't accidentally find a
        // real user config.toml on the machine running the test.
        let _xdg = EnvGuard::set("XDG_CONFIG_HOME", tmp.path().join("xdg-empty"));
        let _home = EnvGuard::set("HOME", tmp.path().join("home-empty"));

        let params = InitializeParams::default();
        assert!(resolve_lsp_root(&params, tmp.path()).is_err());
    }
}
