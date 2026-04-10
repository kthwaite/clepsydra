use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Persisted state from the last successful import run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportCheckpoint {
    pub last_synced: String,
    pub items_imported: u64,
}

impl ImportCheckpoint {
    pub fn load(vault_root: &Path, source: &str) -> Option<Self> {
        let path = vault_root
            .join(".clepsydra/importers")
            .join(format!("{source}.toml"));
        let contents = fs::read_to_string(path).ok()?;
        toml::from_str(&contents).ok()
    }

    pub fn save(&self, vault_root: &Path, source: &str) -> Result<(), String> {
        let dir = vault_root.join(".clepsydra/importers");
        fs::create_dir_all(&dir)
            .map_err(|e| format!("failed to create importers dir: {e}"))?;
        let path = dir.join(format!("{source}.toml"));
        let contents = toml::to_string_pretty(self)
            .map_err(|e| format!("failed to serialize checkpoint: {e}"))?;
        fs::write(path, contents)
            .map_err(|e| format!("failed to write checkpoint: {e}"))?;
        Ok(())
    }
}
