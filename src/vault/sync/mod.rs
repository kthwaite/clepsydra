pub mod watcher;

use super::Vault;
use super::index::VaultIndex;
use super::path::VaultPath;

/// A filesystem change detected by the watcher.
#[derive(Debug, Clone)]
pub enum ChangeEvent {
    /// A file was created or modified.
    Upsert(VaultPath),
    /// A file was removed.
    Remove(VaultPath),
    /// A `bases/*.base.toml` file changed: reload the base registry and
    /// re-check the linkable epoch (which may force a full re-derive).
    BaseChanged,
}

/// Statistics from a single sync cycle.
#[derive(Debug, Default)]
pub struct SyncStats {
    pub pages_indexed: usize,
    pub pages_skipped: usize,
    pub pages_removed: usize,
    pub links_resolved: usize,
    pub deps_reresolved: usize,
}

/// Processes change events and incrementally updates the vault index.
pub struct SyncEngine;

impl SyncEngine {
    /// Process a batch of change events against the index.
    ///
    /// For each event:
    /// - **Upsert**: re-index the page, resolve its links, then re-resolve
    ///   links from pages that depend on it (reverse deps).
    /// - **Remove**: collect reverse deps *before* deletion, remove the page,
    ///   invalidate stale links, then re-resolve affected pages' links.
    pub fn process_events(
        events: &[ChangeEvent],
        vault: &Vault,
        index: &mut VaultIndex,
    ) -> Result<SyncStats, super::index::IndexError> {
        tracing::info!(
            "SyncEngine: processing {} events against index",
            events.len(),
        );
        let mut stats = SyncStats::default();

        for event in events {
            match event {
                ChangeEvent::Upsert(vp) => {
                    tracing::debug!("SyncEngine: upserting page {:?}", vp);
                    if vault.is_excluded(vp) {
                        continue;
                    }

                    // Collect reverse deps and invalidate links BEFORE re-indexing.
                    // If canonical names change, stale resolved links must become
                    // unresolved so they can be re-evaluated against the new state.
                    let pre_deps = index.reverse_deps(vp)?;
                    index.invalidate_links_to(vp)?;

                    match index.index_page(vault, vp)? {
                        true => {
                            stats.pages_indexed += 1;

                            // Resolve this page's outgoing + incoming links
                            let resolved = index.resolve_links_for_page(vp)?;
                            stats.links_resolved += resolved;

                            // Re-resolve reverse dependencies (union of pre- and
                            // post-index deps covers both old and new canonical names)
                            let post_deps = index.reverse_deps(vp)?;
                            let mut all_deps = pre_deps;
                            for d in post_deps {
                                if !all_deps
                                    .iter()
                                    .any(|existing| existing.as_str() == d.as_str())
                                {
                                    all_deps.push(d);
                                }
                            }
                            for dep_path in &all_deps {
                                let r = index.resolve_links_for_page(dep_path)?;
                                stats.deps_reresolved += r;
                            }
                        }
                        false => {
                            stats.pages_skipped += 1;
                            // Content unchanged — re-resolve any links we invalidated
                            for dep_path in &pre_deps {
                                let r = index.resolve_links_for_page(dep_path)?;
                                stats.deps_reresolved += r;
                            }
                        }
                    }
                }
                ChangeEvent::Remove(vp) => {
                    tracing::debug!("SyncEngine: removing page {:?}", vp);
                    // Collect reverse deps BEFORE removing
                    let deps = index.reverse_deps(vp)?;

                    // Invalidate links pointing to this page
                    index.invalidate_links_to(vp)?;

                    // Remove the page
                    if index.remove_page(vp)? {
                        stats.pages_removed += 1;
                    }

                    // Re-resolve affected pages' links
                    for dep_path in &deps {
                        let r = index.resolve_links_for_page(dep_path)?;
                        stats.deps_reresolved += r;
                    }
                }
                ChangeEvent::BaseChanged => {
                    tracing::info!(
                        "SyncEngine: base registry changed, reloading and rebuilding index"
                    );
                    // A full build reloads the registry and runs the linkable
                    // epoch check; when the effective set changed, that build
                    // re-derives every page's frontmatter links. When it did
                    // not, skip-unchanged makes this a cheap sweep.
                    let build_stats = index.build(vault)?;
                    stats.pages_indexed += build_stats.pages_indexed;
                    stats.pages_skipped += build_stats.pages_skipped;
                    stats.pages_removed += build_stats.pages_removed;
                    index.resolve_links()?;
                }
            }
        }
        tracing::info!("SyncEngine: finished processing events: {:#?}", stats);

        Ok(stats)
    }

    /// Process lifecycle page events, a caller-supplied catalog mutation, and
    /// affected-link reconciliation as one SQLite savepoint.
    ///
    /// The callback runs once per event after its page row mutation and before
    /// any link invalidation or re-resolution for that event.
    pub(crate) fn process_events_atomically<F>(
        events: &[ChangeEvent],
        vault: &Vault,
        index: &mut VaultIndex,
        mut after_page_mutation: F,
    ) -> Result<SyncStats, super::index::IndexError>
    where
        F: FnMut(
            usize,
            &ChangeEvent,
            &mut VaultIndex,
        ) -> Result<(), super::index::IndexError>,
    {
        const SAVEPOINT: &str = "rubbish_lifecycle_reconciliation";
        index
            .connection_mut()
            .execute_batch("SAVEPOINT rubbish_lifecycle_reconciliation")?;

        let result = (|| {
            let mut stats = SyncStats::default();
            for (event_index, event) in events.iter().enumerate() {
                match event {
                    ChangeEvent::Upsert(vp) => {
                        if vault.is_excluded(vp) {
                            return Err(super::index::IndexError::Other(format!(
                                "cannot restore excluded vault path: {}",
                                vp.as_str()
                            )));
                        }

                        let pre_deps = index.reverse_deps(vp)?;
                        let indexed = index.index_page_opaque(vault, vp)?;
                        if indexed {
                            stats.pages_indexed += 1;
                        } else {
                            stats.pages_skipped += 1;
                        }
                        let post_deps = index.reverse_deps(vp)?;

                        after_page_mutation(event_index, event, index)?;

                        index.invalidate_links_to(vp)?;
                        if indexed {
                            stats.links_resolved += index.resolve_links_for_page(vp)?;
                        }
                        let mut all_deps = pre_deps;
                        for dependency in post_deps {
                            if !all_deps
                                .iter()
                                .any(|existing| existing.as_str() == dependency.as_str())
                            {
                                all_deps.push(dependency);
                            }
                        }
                        for dependency in &all_deps {
                            stats.deps_reresolved +=
                                index.resolve_links_for_page(dependency)?;
                        }
                    }
                    ChangeEvent::Remove(vp) => {
                        let dependencies = index.reverse_deps(vp)?;
                        if index.remove_page(vp)? {
                            stats.pages_removed += 1;
                        }

                        after_page_mutation(event_index, event, index)?;

                        index.invalidate_links_after_removal(vp)?;
                        for dependency in &dependencies {
                            stats.deps_reresolved +=
                                index.resolve_links_for_page(dependency)?;
                        }
                    }
                    ChangeEvent::BaseChanged => {
                        return Err(super::index::IndexError::Other(
                            "base changes cannot be part of rubbish lifecycle reconciliation"
                                .to_owned(),
                        ));
                    }
                }
            }
            Ok(stats)
        })();

        match result {
            Ok(stats) => {
                if let Err(source) = index
                    .connection_mut()
                    .execute_batch("RELEASE SAVEPOINT rubbish_lifecycle_reconciliation")
                {
                    let _ = index.connection_mut().execute_batch(
                        "ROLLBACK TO SAVEPOINT rubbish_lifecycle_reconciliation;
                         RELEASE SAVEPOINT rubbish_lifecycle_reconciliation;",
                    );
                    Err(source.into())
                } else {
                    Ok(stats)
                }
            }
            Err(source) => {
                index
                    .connection_mut()
                    .execute_batch(
                        "ROLLBACK TO SAVEPOINT rubbish_lifecycle_reconciliation;
                         RELEASE SAVEPOINT rubbish_lifecycle_reconciliation;",
                    )
                    .map_err(|rollback| {
                        super::index::IndexError::Other(format!(
                            "{source}; additionally failed to roll back {SAVEPOINT}: {rollback}"
                        ))
                    })?;
                Err(source)
            }
        }
    }
}
