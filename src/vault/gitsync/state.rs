//! Per-device sync state: `.git/clep-sync.toml` (D8).
//!
//! It lives inside `.git/`, so it is never committed, never synced and never
//! needs a `.gitignore` line. Nothing depends on it: a missing or corrupt
//! file simply reads back as [`SyncState::default`].

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::SyncError;
use crate::vault::atomic_file::{atomic_create, atomic_replace};

/// What the last sync on this device did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncState {
    /// When the last sync finished (RFC 3339 on disk).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<DateTime<Utc>>,
    /// One line describing it, as shown by `clep sync status`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_result: Option<String>,
}

/// The state file for the repository at `root`.
fn state_path(root: &Path) -> PathBuf {
    root.join(".git").join("clep-sync.toml")
}

/// Read the recorded state. Missing, unreadable or corrupt all mean "no
/// state recorded yet" — this is a report, never a source of truth.
pub fn load(root: &Path) -> SyncState {
    let path = state_path(root);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return SyncState::default();
    };
    match toml::from_str(&text) {
        Ok(state) => state,
        Err(e) => {
            tracing::warn!("ignoring unreadable {}: {e}", path.display());
            SyncState::default()
        }
    }
}

/// Record the state, replacing whatever was there. Published atomically, so
/// a `clep sync status` running beside a sync reads one whole version of the
/// file or the other, never a half-written one.
pub fn save(root: &Path, state: &SyncState) -> Result<(), SyncError> {
    let path = state_path(root);
    let text = toml::to_string(state)
        .map_err(|e| SyncError::Config(format!("serializing {}: {e}", path.display())))?;
    let bytes = text.as_bytes();
    if path.exists() {
        atomic_replace(&path, bytes)
    } else {
        atomic_create(&path, bytes)
    }
    .or_else(|e| {
        // Another sync published it between the check and the create.
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            atomic_replace(&path, bytes)
        } else {
            Err(e)
        }
    })
    .map_err(|e| SyncError::io(&path, e.into_inner()))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn state_roundtrip_and_defaults() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".git")).unwrap();
        assert!(load(tmp.path()).last_sync_at.is_none());
        let now = chrono::Utc::now();
        save(
            tmp.path(),
            &SyncState {
                last_sync_at: Some(now),
                last_result: Some("ok".into()),
            },
        )
        .unwrap();
        let loaded = load(tmp.path());
        assert_eq!(loaded.last_sync_at.unwrap().timestamp(), now.timestamp());
        assert_eq!(loaded.last_result.as_deref(), Some("ok"));
        // A second save replaces the published file in place.
        save(
            tmp.path(),
            &SyncState {
                last_sync_at: Some(now),
                last_result: Some("error: fetch failed".into()),
            },
        )
        .unwrap();
        assert_eq!(
            load(tmp.path()).last_result.as_deref(),
            Some("error: fetch failed")
        );
        fs::write(tmp.path().join(".git/clep-sync.toml"), "not = [toml").unwrap();
        assert!(load(tmp.path()).last_result.is_none());
    }
}
