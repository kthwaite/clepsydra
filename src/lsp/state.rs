//! Vault state for the standalone LSP process.
//!
//! The LSP is read-only by design: it opens the vault with a private
//! in-memory index and never writes vault files. Edits reach the vault
//! through the editor (buffer saves, applied WorkspaceEdits); the running
//! `clep serve` absorbs them like any other external edit (ADR 0001).
use std::path::Path;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
