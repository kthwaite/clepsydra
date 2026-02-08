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
        let mut stats = SyncStats::default();

        for event in events {
            match event {
                ChangeEvent::Upsert(vp) => {
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
            }
        }

        Ok(stats)
    }
}
