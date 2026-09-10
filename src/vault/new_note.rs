use thiserror::Error;

use super::kind::Kind;
use super::path::VaultPath;

#[derive(Debug, Error)]
pub enum NewNoteError {
    #[error("no config.toml found (checked: {0})")]
    ConfigNotFound(String),
    #[error("failed to parse config at {path}: {message}")]
    ConfigParse { path: String, message: String },
    #[error("config at {0} does not define [vault].root")]
    VaultRootMissing(String),
    #[error("note title cannot be empty")]
    EmptyTitle,
    #[error("failed to open vault: {0}")]
    VaultOpen(String),
    #[error("invalid new-note path: {0}")]
    InvalidPath(String),
    #[error("note already exists: {0}")]
    AlreadyExists(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

pub fn build_note_path(
    vault: &super::Vault,
    title: &str,
    created: chrono::DateTime<chrono::Utc>,
) -> Result<VaultPath, NewNoteError> {
    let short_id = crate::vault::block_id::generate_short_id();
    let filename = crate::vault::page_filename::page_filename(created, title, &short_id);

    let folder = vault
        .config()
        .vault
        .default_page_folder
        .trim()
        .trim_matches('/');

    let combined = if folder.is_empty() {
        filename
    } else {
        format!("{folder}/{filename}")
    };
    VaultPath::new(&combined).map_err(|e| NewNoteError::InvalidPath(e.to_string()))
}

/// Public for the workspace split; not part of the stable API.
pub fn build_projected_note_path(
    title: &str,
    created: chrono::DateTime<chrono::Utc>,
    kind: Kind,
    project: Option<&str>,
    short_id: &str,
) -> Result<VaultPath, NewNoteError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(NewNoteError::EmptyTitle);
    }
    let filename = crate::vault::page_filename::page_filename(created, title, short_id);
    let folder = match project.map(str::trim).filter(|value| !value.is_empty()) {
        Some(project) => format!("{}/{project}", kind.canonical_folder()),
        None => kind.canonical_folder().to_string(),
    };
    VaultPath::new(&format!("{folder}/{filename}"))
        .map_err(|error| NewNoteError::InvalidPath(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projected_note_path_uses_kind_project_and_supplied_short_id() {
        let created = chrono::DateTime::parse_from_rfc3339("2026-08-09T12:00:00Z")
            .unwrap()
            .to_utc();

        let path = build_projected_note_path(
            "The Left Hand of Darkness",
            created,
            crate::vault::kind::Kind::Book,
            Some("ursula"),
            "Ab3xYz90",
        )
        .unwrap();

        assert_eq!(
            path.as_str(),
            "books/ursula/20260809.the-left-hand-of-darkness.Ab3xYz90.md"
        );
    }

    #[test]
    fn projected_note_path_uses_canonical_kind_folder_without_project() {
        let created = chrono::DateTime::parse_from_rfc3339("2026-08-09T12:00:00Z")
            .unwrap()
            .to_utc();

        let path = build_projected_note_path(
            "Inbox Thought",
            created,
            crate::vault::kind::Kind::Note,
            None,
            "Ab3xYz90",
        )
        .unwrap();

        assert_eq!(path.as_str(), "notes/20260809.inbox-thought.Ab3xYz90.md");
    }

    #[test]
    fn projected_note_path_rejects_project_traversal() {
        let created = chrono::DateTime::parse_from_rfc3339("2026-08-09T12:00:00Z")
            .unwrap()
            .to_utc();

        let error = build_projected_note_path(
            "Escaping Note",
            created,
            crate::vault::kind::Kind::Note,
            Some("../outside"),
            "Ab3xYz90",
        )
        .unwrap_err();

        assert!(matches!(error, NewNoteError::InvalidPath(_)));
    }
}
