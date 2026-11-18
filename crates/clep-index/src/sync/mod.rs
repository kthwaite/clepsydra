pub mod watcher;

use crate::index::{LinkTargets, VaultIndex};
use clep_vault::Vault;
use clep_vault::path::VaultPath;

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
    /// Links whose resolution changed: newly resolved, unresolved again, or
    /// pointed at a moved page's new path.
    pub links_resolved: usize,
    /// One line per file a watcher batch could not index (see
    /// [`SyncEngine::process_watcher_events`]).
    pub warnings: Vec<String>,
}

/// Processes change events and incrementally updates the vault index.
pub struct SyncEngine;

impl SyncEngine {
    /// Process a batch of change events against the index.
    ///
    /// For each event:
    /// - **Upsert**: re-index the page when its bytes changed.
    /// - **Remove**: remove the page.
    ///
    /// Either way, every link aimed at a canonical name or block id the page
    /// held before or holds now is resolved again from the index as it then
    /// stands, so a name that gained or lost a holder is decided the way a
    /// full rebuild decides it. An unchanged page changes no link.
    ///
    /// The first error ends the batch: this is the entry for callers that
    /// index files they have just written (the mutation coordinator).
    pub fn process_events(
        events: &[ChangeEvent],
        vault: &Vault,
        index: &mut VaultIndex,
    ) -> Result<SyncStats, crate::index::IndexError> {
        Self::process_batch(events, vault, index, false)
    }

    /// Process a batch of filesystem watcher events against the index.
    ///
    /// As [`process_events`](Self::process_events), except that a file which
    /// cannot be indexed does not end the batch. The watcher reports paths it
    /// did not write, nobody retries a dropped batch, and one bad file must
    /// not cost the other events:
    /// - a file that is gone by now (deleted after the watcher saw it) is
    ///   handled as a `Remove`;
    /// - any other I/O failure (not UTF-8, no permission) is logged and added
    ///   to [`SyncStats::warnings`]; the page keeps its last indexed state,
    ///   as it does in a startup build.
    ///
    /// Errors that are not about one file (SQLite) still end the batch.
    pub fn process_watcher_events(
        events: &[ChangeEvent],
        vault: &Vault,
        index: &mut VaultIndex,
    ) -> Result<SyncStats, crate::index::IndexError> {
        Self::process_batch(events, vault, index, true)
    }

    fn process_batch(
        events: &[ChangeEvent],
        vault: &Vault,
        index: &mut VaultIndex,
        isolate_file_errors: bool,
    ) -> Result<SyncStats, crate::index::IndexError> {
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

                    let mut targets = LinkTargets::default();
                    match index.index_page_collecting(vault, vp, &mut targets) {
                        Ok(true) => stats.pages_indexed += 1,
                        Ok(false) => stats.pages_skipped += 1,
                        // I/O errors come from reading the file or writing its
                        // repaired frontmatter, before any index row changes.
                        Err(crate::index::IndexError::Io(error)) if isolate_file_errors => {
                            if error.kind() == std::io::ErrorKind::NotFound {
                                if index.remove_page_collecting(vp, &mut targets)? {
                                    stats.pages_removed += 1;
                                }
                            } else {
                                tracing::warn!("SyncEngine: cannot index {}: {error}", vp.as_str());
                                stats
                                    .warnings
                                    .push(format!("cannot index {}: {error}", vp.as_str()));
                            }
                        }
                        Err(error) => return Err(error),
                    }
                    stats.links_resolved += index.reresolve_link_targets(&targets)?;
                }
                ChangeEvent::Remove(vp) => {
                    tracing::debug!("SyncEngine: removing page {:?}", vp);
                    let mut targets = LinkTargets::default();
                    if index.remove_page_collecting(vp, &mut targets)? {
                        stats.pages_removed += 1;
                    }
                    stats.links_resolved += index.reresolve_link_targets(&targets)?;
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

    /// Public for the workspace split; not part of the stable API.
    ///
    /// Process lifecycle page events, a caller-supplied catalog mutation, and
    /// affected-link reconciliation as one SQLite savepoint.
    ///
    /// The callback runs once per event after its page row mutation and before
    /// any link re-resolution for that event.
    pub fn process_events_atomically<F>(
        events: &[ChangeEvent],
        vault: &Vault,
        index: &mut VaultIndex,
        mut after_page_mutation: F,
    ) -> Result<SyncStats, crate::index::IndexError>
    where
        F: FnMut(usize, &ChangeEvent, &mut VaultIndex) -> Result<(), crate::index::IndexError>,
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
                            return Err(crate::index::IndexError::Other(format!(
                                "cannot restore excluded vault path: {}",
                                vp.as_str()
                            )));
                        }

                        let mut targets = LinkTargets::default();
                        if index.index_page_opaque(vault, vp, &mut targets)? {
                            stats.pages_indexed += 1;
                        } else {
                            stats.pages_skipped += 1;
                        }

                        after_page_mutation(event_index, event, index)?;

                        stats.links_resolved += index.reresolve_link_targets(&targets)?;
                    }
                    ChangeEvent::Remove(vp) => {
                        let mut targets = LinkTargets::default();
                        if index.remove_page_collecting(vp, &mut targets)? {
                            stats.pages_removed += 1;
                        }

                        after_page_mutation(event_index, event, index)?;

                        stats.links_resolved += index.reresolve_link_targets(&targets)?;
                    }
                    ChangeEvent::BaseChanged => {
                        return Err(crate::index::IndexError::Other(
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
                        crate::index::IndexError::Other(format!(
                            "{source}; additionally failed to roll back {SAVEPOINT}: {rollback}"
                        ))
                    })?;
                Err(source)
            }
        }
    }
}
