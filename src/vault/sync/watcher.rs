use std::path::PathBuf;
use std::time::Duration;

use notify_debouncer_mini::notify::RecommendedWatcher;
use notify_debouncer_mini::{
    DebouncedEvent, DebouncedEventKind, Debouncer, new_debouncer,
    notify::{self, RecursiveMode},
};
use tokio::sync::mpsc;

use super::ChangeEvent;
use crate::vault::path::VaultPath;

/// Watches a vault directory for filesystem changes and emits [`ChangeEvent`]s.
pub struct VaultWatcher {
    _debouncer: Debouncer<RecommendedWatcher>,
}

impl VaultWatcher {
    /// Start watching the vault at `root`.
    ///
    /// Debounces events by `debounce` duration. Sends change events to `tx`.
    /// Only `.md` files are emitted; the `.clepsydra/` directory is excluded.
    pub fn start(
        root: PathBuf,
        debounce: Duration,
        tx: mpsc::UnboundedSender<ChangeEvent>,
    ) -> Result<Self, notify::Error> {
        let root_clone = root.clone();
        let mut debouncer = new_debouncer(
            debounce,
            move |result: Result<Vec<DebouncedEvent>, notify::Error>| {
                let events = match result {
                    Ok(events) => events,
                    Err(e) => {
                        tracing::warn!("watcher error: {e}");
                        return;
                    }
                };

                for event in events {
                    let path = &event.path;

                    // Skip non-.md files
                    if path.extension().and_then(|e| e.to_str()) != Some("md") {
                        continue;
                    }

                    // Skip .clepsydra/ directory
                    if let Ok(rel) = path.strip_prefix(&root_clone) {
                        let rel_str = rel.to_string_lossy().replace('\\', "/");
                        if rel_str.starts_with(".clepsydra/") {
                            continue;
                        }

                        let vault_path = match VaultPath::new(&rel_str) {
                            Ok(vp) => vp,
                            Err(_) => continue,
                        };

                        let change = match event.kind {
                            DebouncedEventKind::Any => {
                                if path.exists() {
                                    ChangeEvent::Upsert(vault_path)
                                } else {
                                    ChangeEvent::Remove(vault_path)
                                }
                            }
                            DebouncedEventKind::AnyContinuous | _ => {
                                continue; // skip continuous / unknown events
                            }
                        };

                        if tx.send(change).is_err() {
                            return;
                        }
                    }
                }
            },
        )?;

        debouncer
            .watcher()
            .watch(root.as_ref(), RecursiveMode::Recursive)?;

        Ok(Self {
            _debouncer: debouncer,
        })
    }
}
