use std::cmp::Ordering;
use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::path::VaultPath;
use super::sync::ChangeEvent;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExpectedPathState {
    Missing,
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BatchPathIntent {
    Write {
        path: VaultPath,
        expected: ExpectedPathState,
        content: Vec<u8>,
    },
    Move {
        source: VaultPath,
        destination: VaultPath,
        expected_source: Vec<u8>,
    },
    Delete {
        path: VaultPath,
        expected: Vec<u8>,
    },
}

#[derive(Debug, Clone)]
pub struct BatchMutationCommand {
    pub intents: Vec<BatchPathIntent>,
    pub index_events: Vec<ChangeEvent>,
    pub moved_pages: Vec<(VaultPath, VaultPath)>,
}

impl BatchMutationCommand {
    pub fn affected_paths(&self) -> Vec<VaultPath> {
        let mut paths = BTreeSet::new();

        for intent in &self.intents {
            match intent {
                BatchPathIntent::Write { path, .. } | BatchPathIntent::Delete { path, .. } => {
                    paths.insert(SortedVaultPath(path));
                }
                BatchPathIntent::Move {
                    source,
                    destination,
                    ..
                } => {
                    paths.insert(SortedVaultPath(source));
                    paths.insert(SortedVaultPath(destination));
                }
            }
        }

        paths.into_iter().map(|path| path.0.clone()).collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SortedVaultPath<'a>(&'a VaultPath);

impl Ord for SortedVaultPath<'_> {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.as_str().cmp(other.0.as_str())
    }
}

impl PartialOrd for SortedVaultPath<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct TransactionManifest {
    phase: TransactionPhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TransactionPhase {
    Prepared,
    Committing,
    FilesystemCommitted,
}

#[derive(Debug, Error, PartialEq, Eq)]
enum IntentValidationError {
    #[error("batch mutation command is empty")]
    EmptyCommand,
    #[error("duplicate final destination: {0}")]
    DuplicateFinalDestination(String),
    #[error("move source and destination are the same: {0}")]
    UnchangedMove(String),
    #[error("conflicting intents for source: {0}")]
    ConflictingSource(String),
}

fn validate_intents(intents: &[BatchPathIntent]) -> Result<(), IntentValidationError> {
    if intents.is_empty() {
        return Err(IntentValidationError::EmptyCommand);
    }

    let mut final_destinations = BTreeSet::new();
    let mut sources = BTreeSet::new();

    for intent in intents {
        let (source, final_destination) = match intent {
            BatchPathIntent::Write { path, .. } => (path.as_str(), Some(path.as_str())),
            BatchPathIntent::Move {
                source,
                destination,
                ..
            } => {
                if source == destination {
                    return Err(IntentValidationError::UnchangedMove(
                        source.as_str().to_owned(),
                    ));
                }
                (source.as_str(), Some(destination.as_str()))
            }
            BatchPathIntent::Delete { path, .. } => (path.as_str(), None),
        };

        if let Some(destination) = final_destination
            && !final_destinations.insert(destination)
        {
            return Err(IntentValidationError::DuplicateFinalDestination(
                destination.to_owned(),
            ));
        }

        if !sources.insert(source) {
            return Err(IntentValidationError::ConflictingSource(
                source.to_owned(),
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_missing(path: &str, content: &[u8]) -> BatchPathIntent {
        BatchPathIntent::Write {
            path: VaultPath::new(path).unwrap(),
            expected: ExpectedPathState::Missing,
            content: content.to_vec(),
        }
    }

    #[test]
    fn affected_paths_are_sorted_and_deduplicated() {
        let command = BatchMutationCommand {
            intents: vec![
                BatchPathIntent::Move {
                    source: VaultPath::new("z.md").unwrap(),
                    destination: VaultPath::new("a.md").unwrap(),
                    expected_source: b"z".to_vec(),
                },
                BatchPathIntent::Write {
                    path: VaultPath::new("z.md").unwrap(),
                    expected: ExpectedPathState::Missing,
                    content: b"new".to_vec(),
                },
            ],
            index_events: vec![],
            moved_pages: vec![],
        };
        assert_eq!(
            command
                .affected_paths()
                .iter()
                .map(VaultPath::as_str)
                .collect::<Vec<_>>(),
            vec!["a.md", "z.md"]
        );
    }

    #[test]
    fn duplicate_final_destinations_are_rejected() {
        let error = validate_intents(&[
            write_missing("same.md", b"one"),
            write_missing("same.md", b"two"),
        ])
        .unwrap_err();
        assert!(error.to_string().contains("same.md"));
    }

    #[test]
    fn empty_commands_are_rejected() {
        let error = validate_intents(&[]).unwrap_err();
        assert!(error.to_string().contains("empty"));
    }

    #[test]
    fn moves_must_change_the_path() {
        let path = VaultPath::new("same.md").unwrap();
        let error = validate_intents(&[BatchPathIntent::Move {
            source: path.clone(),
            destination: path,
            expected_source: b"before".to_vec(),
        }])
        .unwrap_err();
        assert!(error.to_string().contains("same.md"));
    }

    #[test]
    fn conflicting_move_sources_are_rejected() {
        let error = validate_intents(&[
            BatchPathIntent::Move {
                source: VaultPath::new("source.md").unwrap(),
                destination: VaultPath::new("first.md").unwrap(),
                expected_source: b"before".to_vec(),
            },
            BatchPathIntent::Move {
                source: VaultPath::new("source.md").unwrap(),
                destination: VaultPath::new("second.md").unwrap(),
                expected_source: b"before".to_vec(),
            },
        ])
        .unwrap_err();
        assert!(error.to_string().contains("source.md"));
    }

    #[test]
    fn transaction_phases_have_stable_serialized_values() {
        for (phase, serialized) in [
            (TransactionPhase::Prepared, r#"{"phase":"prepared"}"#),
            (TransactionPhase::Committing, r#"{"phase":"committing"}"#),
            (
                TransactionPhase::FilesystemCommitted,
                r#"{"phase":"filesystem_committed"}"#,
            ),
        ] {
            let manifest = TransactionManifest { phase };
            assert_eq!(serde_json::to_string(&manifest).unwrap(), serialized);
            assert_eq!(
                serde_json::from_str::<TransactionManifest>(serialized).unwrap(),
                manifest
            );
        }
    }
}
