use serde::Serialize;

/// A notification emitted after the vault index changes.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SyncNotification {
    /// Pages were created, modified, or removed.
    IndexChanged {
        upserted: Vec<String>,
        removed: Vec<String>,
    },
}
