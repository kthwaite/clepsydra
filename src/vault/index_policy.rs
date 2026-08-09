use thiserror::Error;

use super::Vault;
use super::index::{IndexError, VaultIndex};
use super::path::VaultPath;

/// The filesystem mutation whose effects must be reflected in the vault index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IndexMutation {
    Created,
    ContentChanged,
    Moved { old_path: VaultPath },
    Deleted,
}

/// The index operation that failed while applying a mutation policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexPolicyOperation {
    BeginCreatedTransaction,
    CommitCreatedTransaction,
    CollectReverseDependencies,
    InvalidateInboundLinks,
    IndexPage,
    ResolvePageLinks,
    RemovePage,
}

impl std::fmt::Display for IndexPolicyOperation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let description = match self {
            Self::BeginCreatedTransaction => "begin created-page transaction",
            Self::CommitCreatedTransaction => "commit created-page transaction",
            Self::CollectReverseDependencies => "collect reverse dependencies",
            Self::InvalidateInboundLinks => "invalidate inbound links",
            Self::IndexPage => "index page",
            Self::ResolvePageLinks => "resolve page links",
            Self::RemovePage => "remove page",
        };
        formatter.write_str(description)
    }
}

/// A typed failure from an intent-level index mutation policy.
#[derive(Debug, Error)]
pub enum IndexPolicyError {
    #[error("index thread unavailable: {0}")]
    IndexThread(#[source] IndexError),
    #[error("failed to {operation} for {path:?}: {source}")]
    Operation {
        operation: IndexPolicyOperation,
        path: VaultPath,
        #[source]
        source: IndexError,
    },
    #[error(
        "created-page index transaction rollback failed for {path:?}: primary error: {primary}; rollback error: {rollback}"
    )]
    TransactionRollback {
        path: VaultPath,
        #[source]
        primary: Box<IndexPolicyError>,
        rollback: IndexError,
    },
}

pub(crate) fn apply_mutation(
    index: &mut VaultIndex,
    vault: &Vault,
    path: &VaultPath,
    mutation: IndexMutation,
) -> Result<(), IndexPolicyError> {
    match mutation {
        IndexMutation::Created => created_page(index, vault, path)?,
        IndexMutation::ContentChanged => {
            let previous_dependencies = reverse_dependencies(index, path)?;
            invalidate_inbound_links(index, path)?;
            index_page(index, vault, path)?;
            resolve_page_links(index, path)?;
            let current_dependencies = reverse_dependencies(index, path)?;
            refresh_dependencies(index, previous_dependencies, current_dependencies)?;
        }
        IndexMutation::Moved { old_path } => {
            let previous_dependencies = reverse_dependencies(index, &old_path)?;
            invalidate_inbound_links(index, &old_path)?;
            index_page(index, vault, path)?;
            if old_path != *path {
                remove_page(index, &old_path)?;
            }
            resolve_page_links(index, path)?;
            let current_dependencies = reverse_dependencies(index, path)?;
            refresh_dependencies(index, previous_dependencies, current_dependencies)?;
        }
        IndexMutation::Deleted => {
            let dependencies = reverse_dependencies(index, path)?;
            invalidate_inbound_links(index, path)?;
            remove_page(index, path)?;
            refresh_dependencies(index, dependencies, Vec::new())?;
        }
    }

    Ok(())
}

fn created_page(
    index: &mut VaultIndex,
    vault: &Vault,
    path: &VaultPath,
) -> Result<(), IndexPolicyError> {
    index.begin_created_mutation().map_err(|source| {
        operation_error(IndexPolicyOperation::BeginCreatedTransaction, path, source)
    })?;
    let result = (|| {
        index_page(index, vault, path)?;
        resolve_page_links(index, path)
    })();

    match result {
        Ok(()) => match index.commit_created_mutation() {
            Ok(()) => Ok(()),
            Err(source) => rollback_created_transaction(
                index,
                path,
                operation_error(IndexPolicyOperation::CommitCreatedTransaction, path, source),
            ),
        },
        Err(primary) => rollback_created_transaction(index, path, primary),
    }
}

fn rollback_created_transaction(
    index: &mut VaultIndex,
    path: &VaultPath,
    primary: IndexPolicyError,
) -> Result<(), IndexPolicyError> {
    match index.rollback_created_mutation() {
        Ok(()) => Err(primary),
        Err(rollback) => Err(IndexPolicyError::TransactionRollback {
            path: path.clone(),
            primary: Box::new(primary),
            rollback,
        }),
    }
}

fn reverse_dependencies(
    index: &VaultIndex,
    path: &VaultPath,
) -> Result<Vec<VaultPath>, IndexPolicyError> {
    index.reverse_deps(path).map_err(|source| {
        operation_error(
            IndexPolicyOperation::CollectReverseDependencies,
            path,
            source,
        )
    })
}

fn invalidate_inbound_links(
    index: &mut VaultIndex,
    path: &VaultPath,
) -> Result<(), IndexPolicyError> {
    index
        .invalidate_links_to(path)
        .map(|_| ())
        .map_err(|source| {
            operation_error(IndexPolicyOperation::InvalidateInboundLinks, path, source)
        })
}

fn index_page(
    index: &mut VaultIndex,
    vault: &Vault,
    path: &VaultPath,
) -> Result<(), IndexPolicyError> {
    index
        .index_page(vault, path)
        .map(|_| ())
        .map_err(|source| operation_error(IndexPolicyOperation::IndexPage, path, source))
}

fn resolve_page_links(index: &mut VaultIndex, path: &VaultPath) -> Result<(), IndexPolicyError> {
    index
        .resolve_links_for_page(path)
        .map(|_| ())
        .map_err(|source| operation_error(IndexPolicyOperation::ResolvePageLinks, path, source))
}

fn remove_page(index: &mut VaultIndex, path: &VaultPath) -> Result<(), IndexPolicyError> {
    index
        .remove_page(path)
        .map(|_| ())
        .map_err(|source| operation_error(IndexPolicyOperation::RemovePage, path, source))
}

fn refresh_dependencies(
    index: &mut VaultIndex,
    mut previous: Vec<VaultPath>,
    current: Vec<VaultPath>,
) -> Result<(), IndexPolicyError> {
    previous.extend(current);
    previous.sort_unstable_by(|left, right| left.as_str().cmp(right.as_str()));
    previous.dedup();

    for dependency in previous {
        resolve_page_links(index, &dependency)?;
    }
    Ok(())
}

fn operation_error(
    operation: IndexPolicyOperation,
    path: &VaultPath,
    source: IndexError,
) -> IndexPolicyError {
    IndexPolicyError::Operation {
        operation,
        path: path.clone(),
        source,
    }
}
