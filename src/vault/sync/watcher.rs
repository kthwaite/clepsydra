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

fn map_debounced_event(
    root: &std::path::Path,
    root_canonical: &std::path::Path,
    event: &DebouncedEvent,
) -> Option<ChangeEvent> {
    let path = &event.path;

    // Skip non-.md files.
    if path.extension().and_then(|e| e.to_str()) != Some("md") {
        return None;
    }

    // Skip .clepsydra/ directory and normalize path under either raw or canonical root.
    let rel = path
        .strip_prefix(root)
        .or_else(|_| path.strip_prefix(root_canonical))
        .ok()?;
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    if rel_str.starts_with(".clepsydra/") {
        return None;
    }

    let vault_path = VaultPath::new(&rel_str).ok()?;

    match event.kind {
        DebouncedEventKind::Any | DebouncedEventKind::AnyContinuous => {
            if path.exists() {
                Some(ChangeEvent::Upsert(vault_path))
            } else {
                Some(ChangeEvent::Remove(vault_path))
            }
        }
        _ => None,
    }
}

/// Watches a vault directory for filesystem changes and emits [`ChangeEvent`]s.
pub struct VaultWatcher {
    #[allow(dead_code)]
    debouncer: Debouncer<RecommendedWatcher>,
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
        let root_canonical = std::fs::canonicalize(&root).unwrap_or(root.clone());
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
                    if let Some(change) = map_debounced_event(&root_clone, &root_canonical, &event)
                        && tx.send(change).is_err()
                    {
                        return;
                    }
                }
            },
        )?;

        debouncer
            .watcher()
            .watch(root.as_ref(), RecursiveMode::Recursive)?;

        Ok(Self { debouncer })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    #[test]
    fn maps_markdown_create_to_upsert() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();
        let page_path = root.join("notes.md");
        std::fs::write(&page_path, "# note\n").unwrap();
        let event = DebouncedEvent {
            path: page_path,
            kind: DebouncedEventKind::Any,
        };

        let mapped = map_debounced_event(&root, &root, &event);
        assert!(matches!(mapped, Some(ChangeEvent::Upsert(vp)) if vp.as_str() == "notes.md"));
    }

    #[test]
    fn maps_markdown_delete_to_remove() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();
        let page_path = root.join("remove-me.md");
        let event = DebouncedEvent {
            path: page_path,
            kind: DebouncedEventKind::Any,
        };

        let mapped = map_debounced_event(&root, &root, &event);
        assert!(matches!(mapped, Some(ChangeEvent::Remove(vp)) if vp.as_str() == "remove-me.md"));
    }

    #[test]
    fn ignores_non_markdown_and_clepsydra_changes() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();
        std::fs::create_dir_all(root.join(".clepsydra")).unwrap();
        let txt = DebouncedEvent {
            path: root.join("ignore.txt"),
            kind: DebouncedEventKind::Any,
        };
        let hidden = DebouncedEvent {
            path: root.join(".clepsydra/hidden.md"),
            kind: DebouncedEventKind::Any,
        };

        assert!(map_debounced_event(&root, &root, &txt).is_none());
        assert!(map_debounced_event(&root, &root, &hidden).is_none());
    }

    #[test]
    fn maps_any_continuous_like_any() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();
        let page_path = root.join("notes.md");
        std::fs::write(&page_path, "# note\n").unwrap();
        let event = DebouncedEvent {
            path: page_path,
            kind: DebouncedEventKind::AnyContinuous,
        };

        let mapped = map_debounced_event(&root, &root, &event);
        assert!(matches!(mapped, Some(ChangeEvent::Upsert(vp)) if vp.as_str() == "notes.md"));
    }

    #[test]
    fn supports_canonical_root_prefix_matching() {
        let tmp = TempDir::new().unwrap();
        let canonical_root = tmp.path().to_path_buf();
        let event = DebouncedEvent {
            path: canonical_root.join("notes.md"),
            kind: DebouncedEventKind::Any,
        };
        std::fs::write(&event.path, "# note\n").unwrap();

        // Simulate caller passing non-canonical root while canonical matching still works.
        let noncanonical_root = PathBuf::from("/tmp/noncanonical-placeholder");
        let mapped = map_debounced_event(&noncanonical_root, &canonical_root, &event);
        assert!(matches!(mapped, Some(ChangeEvent::Upsert(vp)) if vp.as_str() == "notes.md"));
    }
}
