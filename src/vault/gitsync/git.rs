//! Subprocess wrapper around the system `git` binary. Placeholder for Task 2.

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("{0}")]
    Placeholder(String),
}
