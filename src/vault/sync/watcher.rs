use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use notify_debouncer_mini::notify::RecommendedWatcher;
use notify_debouncer_mini::{
    DebouncedEvent, DebouncedEventKind, Debouncer, new_debouncer_opt,
    notify::{
        self, EventKind, RecursiveMode,
        event::{AccessKind, AccessMode},
    },
};
use tokio::sync::mpsc;

use super::ChangeEvent;
use crate::vault::path::VaultPath;

/// A [`RecommendedWatcher`] that drops read-side access events before they
/// reach the debouncer.
///
/// The inotify backend subscribes to `IN_OPEN`, so on Linux every read-only
/// open of a watched file surfaces as `EventKind::Access(Open)`. The debouncer
/// discards event kinds — every event it receives becomes a plain
/// `DebouncedEventKind::Any` for its path — so those opens arrive here
/// indistinguishable from real edits. The sync engine reads pages while
/// indexing them, so forwarding them lets the engine's own reads re-trigger it
/// in an endless loop, and because an upsert also re-resolves reverse
/// dependencies the loop amplifies across the link graph rather than staying
/// confined to one page. macOS (FSEvents) never reports opens, which is why
/// the loop is Linux-only.
///
/// Write-side closes stay: `Access(Close(Write))` marks a completed write.
/// Content changes themselves are covered by `Modify` events either way.
struct AccessFilteredWatcher(RecommendedWatcher);

fn is_read_side_access(event: &notify::Event) -> bool {
    match event.kind {
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => false,
        EventKind::Access(_) => true,
        _ => false,
    }
}

impl notify::Watcher for AccessFilteredWatcher {
    fn new<F: notify::EventHandler>(
        mut event_handler: F,
        config: notify::Config,
    ) -> notify::Result<Self> {
        let inner = RecommendedWatcher::new(
            move |result: notify::Result<notify::Event>| {
                if !matches!(&result, Ok(event) if is_read_side_access(event)) {
                    event_handler.handle_event(result);
                }
            },
            config,
        )?;
        Ok(Self(inner))
    }

    fn watch(
        &mut self,
        path: &std::path::Path,
        recursive_mode: RecursiveMode,
    ) -> notify::Result<()> {
        self.0.watch(path, recursive_mode)
    }

    fn unwatch(&mut self, path: &std::path::Path) -> notify::Result<()> {
        self.0.unwatch(path)
    }

    fn configure(&mut self, option: notify::Config) -> notify::Result<bool> {
        self.0.configure(option)
    }

    fn kind() -> notify::WatcherKind {
        RecommendedWatcher::kind()
    }
}

fn map_debounced_event(
    root: &std::path::Path,
    root_canonical: &std::path::Path,
    event: &DebouncedEvent,
) -> Option<ChangeEvent> {
    let path = &event.path;

    // Normalize path under either raw or canonical root.
    let rel = path
        .strip_prefix(root)
        .or_else(|_| path.strip_prefix(root_canonical))
        .ok()?;
    let rel_str = rel.to_string_lossy().replace('\\', "/");

    // Base definition files reload the registry instead of indexing a page.
    if rel_str.starts_with("bases/") && rel_str.ends_with(".base.toml") {
        return Some(ChangeEvent::BaseChanged);
    }

    // Skip non-.md files.
    if path.extension().and_then(|e| e.to_str()) != Some("md") {
        return None;
    }

    // Skip .clepsydra/ directory.
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
    debouncer: Debouncer<AccessFilteredWatcher>,
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
        Self::start_with_pause(root, debounce, tx, Arc::new(AtomicBool::new(false)))
    }

    /// As [`VaultWatcher::start`], with a shared pause flag: every event
    /// observed while `paused` is set is dropped rather than forwarded.
    ///
    /// The server holds this flag across a git sync window (D10). A merge
    /// rewrites the working tree wholesale, and the one full index rebuild
    /// that follows already covers every path it touched; without the pause
    /// the watcher would re-index each of those files a second time — while
    /// the mutation gate is held shut, so the reconcile pass behind it would
    /// stall until the window closed.
    pub fn start_with_pause(
        root: PathBuf,
        debounce: Duration,
        tx: mpsc::UnboundedSender<ChangeEvent>,
        paused: Arc<AtomicBool>,
    ) -> Result<Self, notify::Error> {
        tracing::info!("Starting vault watcher on {:?}", root);
        let root_clone = root.clone();
        let root_canonical = std::fs::canonicalize(&root).unwrap_or(root.clone());
        let mut debouncer = new_debouncer_opt::<_, AccessFilteredWatcher>(
            notify_debouncer_mini::Config::default().with_timeout(debounce),
            move |result: Result<Vec<DebouncedEvent>, notify::Error>| {
                if paused.load(Ordering::SeqCst) {
                    return;
                }
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
    fn maps_base_file_to_base_changed() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();
        std::fs::create_dir_all(root.join("bases")).unwrap();
        let base = DebouncedEvent {
            path: root.join("bases/reading.base.toml"),
            kind: DebouncedEventKind::Any,
        };
        assert!(matches!(
            map_debounced_event(&root, &root, &base),
            Some(ChangeEvent::BaseChanged)
        ));

        // A markdown file under bases/ is still mapped as a page event (the
        // sync engine drops it via excluded_patterns).
        let md = DebouncedEvent {
            path: root.join("bases/notes.md"),
            kind: DebouncedEventKind::Any,
        };
        assert!(matches!(
            map_debounced_event(&root, &root, &md),
            Some(ChangeEvent::Remove(_) | ChangeEvent::Upsert(_))
        ));

        // A .toml outside bases/ stays dropped.
        let stray = DebouncedEvent {
            path: root.join("notes/x.toml"),
            kind: DebouncedEventKind::Any,
        };
        assert!(map_debounced_event(&root, &root, &stray).is_none());

        // A non-.base.toml inside bases/ stays dropped too.
        let plain = DebouncedEvent {
            path: root.join("bases/readme.toml"),
            kind: DebouncedEventKind::Any,
        };
        assert!(map_debounced_event(&root, &root, &plain).is_none());
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
    fn write_side_closes_survive_the_access_filter() {
        let event = notify::Event::new(EventKind::Access(AccessKind::Close(AccessMode::Write)));
        assert!(!is_read_side_access(&event));
    }

    #[test]
    fn read_side_access_is_filtered() {
        // What inotify reports for a read-only open, and for the close that
        // ends one. Both are the sync engine looking at a page, not a change.
        for kind in [
            AccessKind::Open(AccessMode::Any),
            AccessKind::Open(AccessMode::Read),
            AccessKind::Close(AccessMode::Read),
            AccessKind::Read,
            AccessKind::Any,
            AccessKind::Other,
        ] {
            let event = notify::Event::new(EventKind::Access(kind));
            assert!(
                is_read_side_access(&event),
                "{kind:?} reached the debouncer"
            );
        }
    }

    #[test]
    fn non_access_events_survive_the_access_filter() {
        for kind in [
            EventKind::Create(notify::event::CreateKind::File),
            EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any,
            )),
            EventKind::Remove(notify::event::RemoveKind::File),
            EventKind::Any,
        ] {
            let event = notify::Event::new(kind);
            assert!(!is_read_side_access(&event), "{kind:?} was filtered out");
        }
    }

    /// End-to-end cover for the wiring: the filter is only worth anything if
    /// `VaultWatcher::start` actually installs it. Linux-only because inotify
    /// is the one backend that reports opens at all.
    #[cfg(target_os = "linux")]
    #[test]
    fn indexer_style_reads_do_not_emit_events() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _watcher = VaultWatcher::start(root.clone(), Duration::from_millis(50), tx).unwrap();
        // Give the backend time to establish its watches.
        std::thread::sleep(Duration::from_millis(200));

        let page = root.join("note.md");
        std::fs::write(&page, "# note\n").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            match rx.try_recv() {
                Ok(_) => break,
                Err(_) => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "watcher never reported the file creation"
                    );
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        // Drain any stragglers from the creation burst.
        std::thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}

        // Read-only opens are what the sync engine itself performs while
        // indexing; if they surface as change events the engine re-triggers
        // itself forever (inotify IN_OPEN).
        for _ in 0..3 {
            std::fs::read_to_string(&page).unwrap();
            std::thread::sleep(Duration::from_millis(100));
        }
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            rx.try_recv().is_err(),
            "a read-only open emitted a change event"
        );
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

    #[tokio::test]
    async fn paused_watcher_drops_events_and_resumes() {
        let tmp = TempDir::new().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let paused = Arc::new(AtomicBool::new(true));
        let _watcher = VaultWatcher::start_with_pause(
            tmp.path().to_path_buf(),
            Duration::from_millis(100),
            tx,
            Arc::clone(&paused),
        )
        .unwrap();

        std::fs::write(tmp.path().join("a.md"), "x").unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(1_500), rx.recv())
                .await
                .is_err(),
            "a paused watcher must deliver nothing"
        );

        paused.store(false, Ordering::SeqCst);
        std::fs::write(tmp.path().join("b.md"), "y").unwrap();
        let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("no event within 5s after resuming")
            .expect("watcher channel closed");
        assert!(
            matches!(event, ChangeEvent::Upsert(ref p) if p.as_str() == "b.md"),
            "the event observed while paused must be dropped, not replayed: {event:?}"
        );
    }
}
