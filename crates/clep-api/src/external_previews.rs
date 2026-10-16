//! Disposable per-vault preview cache. No data is written into the vault.
use std::collections::HashSet;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

use crate::external_preview_capture::CapturedPreview;

const MAX_BYTES: u64 = 256 * 1024 * 1024;
// Reserve the other half for SQLite's rollback journal, including page headers.
const MAX_DATABASE_BYTES: u64 = (MAX_BYTES - 1024 * 1024) / 2;
const MAX_PAYLOAD_BYTES: u64 = MAX_DATABASE_BYTES - 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 1000;
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const POSITIVE_TTL: i64 = 7 * 24 * 60 * 60;
const NEGATIVE_TTL: i64 = 5 * 60;

type CaptureFuture = Pin<Box<dyn Future<Output = Result<CapturedPreview, String>> + Send>>;
type Capture = dyn Fn(url::Url) -> CaptureFuture + Send + Sync;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[schema(as = ExternalPreviewState)]
pub enum PreviewState {
    Disabled,
    Pending,
    Ready,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[schema(as = ExternalPreviewResponse)]
pub struct PreviewResponse {
    pub state: PreviewState,
    #[schema(required = true)]
    pub title: Option<String>,
    #[schema(required = true)]
    pub description: Option<String>,
    #[schema(required = true)]
    pub final_url: Option<String>,
    #[schema(required = true)]
    pub image_url: Option<String>,
    #[schema(required = true)]
    pub captured_at: Option<String>,
    pub refreshing: bool,
}

impl PreviewResponse {
    fn empty(state: PreviewState) -> Self {
        Self {
            state,
            title: None,
            description: None,
            final_url: None,
            image_url: None,
            captured_at: None,
            refreshing: false,
        }
    }
}

struct Entry {
    response: PreviewResponse,
    captured: Option<i64>,
    attempted: i64,
}

struct Store {
    db: Connection,
    max_entries: usize,
    max_bytes: u64,
}

impl Store {
    fn open(path: &Path, max_entries: usize, max_bytes: u64) -> rusqlite::Result<Self> {
        let db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::from_secs(2))?;
        // The rollback journal and database are each bounded by max_page_count.
        // FULL auto-vacuum reclaims evicted blobs instead of growing forever.
        db.execute_batch("PRAGMA page_size=4096; PRAGMA auto_vacuum=FULL; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS previews (
                key TEXT PRIMARY KEY, response TEXT NOT NULL, image BLOB,
                captured INTEGER, attempted INTEGER NOT NULL, bytes INTEGER NOT NULL
            );")?;
        db.pragma_update(None, "max_page_count", MAX_DATABASE_BYTES / 4096)?;
        Ok(Self {
            db,
            max_entries,
            max_bytes,
        })
    }

    fn get(&self, key: &str) -> rusqlite::Result<Option<Entry>> {
        self.db
            .query_row(
                "SELECT response, captured, attempted FROM previews WHERE key = ?1",
                [key],
                |row| {
                    let json: String = row.get(0)?;
                    let response = serde_json::from_str(&json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                    Ok(Entry {
                        response,
                        captured: row.get(1)?,
                        attempted: row.get(2)?,
                    })
                },
            )
            .optional()
    }

    fn save(
        &mut self,
        key: &str,
        result: Result<CapturedPreview, String>,
        now: i64,
    ) -> rusqlite::Result<()> {
        let capture = result.ok().filter(|value| {
            valid_url(&value.final_url).is_ok()
                && value.title.as_ref().is_none_or(|text| text.len() <= 4096)
                && value
                    .description
                    .as_ref()
                    .is_none_or(|text| text.len() <= 16384)
        });
        // A failed refresh keeps the last useful capture, but backs off retries.
        if capture.is_none() && self.get(key)?.is_some_and(|entry| entry.captured.is_some()) {
            self.db.execute(
                "UPDATE previews SET attempted = ?2 WHERE key = ?1",
                params![key, now],
            )?;
            return Ok(());
        }
        let (response, image, captured) = match capture {
            Some(value) => {
                let image = value.screenshot.filter(|bytes| {
                    bytes.len() <= MAX_IMAGE_BYTES && bytes.starts_with(&[0xff, 0xd8, 0xff])
                });
                let response = PreviewResponse {
                    state: PreviewState::Ready,
                    title: value.title,
                    description: value.description,
                    final_url: Some(value.final_url),
                    image_url: image
                        .as_ref()
                        .map(|_| format!("/api/vault/external-previews/images/{key}")),
                    captured_at: DateTime::from_timestamp(now, 0).map(|time| time.to_rfc3339()),
                    refreshing: false,
                };
                (response, image, Some(now))
            }
            None => (
                PreviewResponse::empty(PreviewState::Unavailable),
                None,
                None,
            ),
        };
        let json = serde_json::to_string(&response).expect("preview response is serializable");
        let bytes = (json.len() + image.as_ref().map_or(0, Vec::len)) as u64;
        if bytes > self.max_bytes {
            return Ok(());
        }
        let transaction = self.db.transaction()?;
        transaction.execute("DELETE FROM previews WHERE key = ?1", [key])?;
        loop {
            let (count, size): (usize, u64) = transaction.query_row(
                "SELECT count(*), coalesce(sum(bytes), 0) FROM previews",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if count < self.max_entries && size + bytes <= self.max_bytes {
                break;
            }
            transaction.execute(
                "DELETE FROM previews WHERE key = (SELECT key FROM previews ORDER BY attempted, key LIMIT 1)", [],
            )?;
        }
        transaction.execute(
            "INSERT INTO previews (key, response, image, captured, attempted, bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![key, json, image, captured, now, bytes],
        )?;
        transaction.commit()
    }
}

/// Only HTTP(S), without credentials. DNS and every redirect are checked by capture.
pub(crate) fn valid_url(raw: &str) -> Result<url::Url, &'static str> {
    if raw.len() > 16_384 {
        return Err("preview URL is too long");
    }
    let url = url::Url::parse(raw).map_err(|_| "invalid preview URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("preview requires an HTTP(S) URL without credentials");
    }
    Ok(url)
}

fn key_for(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
#[derive(Debug)]
pub enum PreviewError {
    InvalidUrl(&'static str),
    CacheUnavailable,
}

pub struct PreviewRuntime {
    store: Option<Arc<Mutex<Store>>>,
    running: tokio::sync::Mutex<HashSet<String>>,
    capture: Arc<Capture>,
    cache_error_until: std::sync::atomic::AtomicI64,
}

impl Default for PreviewRuntime {
    fn default() -> Self {
        Self {
            store: None,
            running: tokio::sync::Mutex::new(HashSet::new()),
            cache_error_until: std::sync::atomic::AtomicI64::new(0),
            capture: Arc::new(|url| {
                Box::pin(async move { crate::external_preview_capture::capture(&url, None).await })
            }),
        }
    }
}

impl PreviewRuntime {
    pub async fn for_vault(
        root: &Path,
        settings: &clep_config::ExternalPreviewsSettings,
    ) -> std::io::Result<Arc<Self>> {
        if !settings.enabled {
            return Ok(Arc::new(Self::default()));
        }
        let root = root.to_path_buf();
        let (store, installation) = tokio::task::spawn_blocking(move || {
            let root = std::fs::canonicalize(root)?;
            let cache = dirs::cache_dir()
                .ok_or_else(|| std::io::Error::other("OS cache directory unavailable"))?
                .join("clepsydra/external-previews")
                .join(key_for(root.as_os_str().as_encoded_bytes()));
            // An unusual vault rooted above the OS cache must not ingest previews.
            if cache.starts_with(&root) {
                return Err(std::io::Error::other(
                    "preview cache must be outside the vault",
                ));
            }
            std::fs::create_dir_all(&cache)?;
            let cache = std::fs::canonicalize(cache)?;
            if cache.starts_with(&root) {
                return Err(std::io::Error::other(
                    "preview cache must be outside the vault",
                ));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&cache, std::fs::Permissions::from_mode(0o700))?;
            }
            let store = Store::open(
                &cache.join("previews.sqlite3"),
                MAX_ENTRIES,
                MAX_PAYLOAD_BYTES,
            )
            .map_err(|_| std::io::Error::other("could not open preview cache"))?;
            let installation = match crate::preview_worker::installed() {
                Ok(installation) if !installation.root().starts_with(&root) => {
                    Some(Arc::new(installation))
                }
                Ok(_) => {
                    tracing::warn!("Preview worker installation must be outside the vault");
                    None
                }
                Err(error) => {
                    tracing::warn!(%error, "Screenshots unavailable; metadata previews remain enabled");
                    None
                }
            };
            Ok::<_, std::io::Error>((store, installation))
        })
        .await
        .map_err(|_| std::io::Error::other("preview cache task failed"))??;
        Ok(Arc::new(Self {
            store: Some(Arc::new(Mutex::new(store))),
            capture: Arc::new(move |url| {
                let installation = installation.clone();
                Box::pin(async move {
                    crate::external_preview_capture::capture(&url, installation.as_deref()).await
                })
            }),
            ..Self::default()
        }))
    }

    pub fn enabled(&self) -> bool {
        self.store.is_some()
    }

    pub async fn request(self: &Arc<Self>, raw: &str) -> Result<PreviewResponse, PreviewError> {
        let Some(store) = self.store.as_ref() else {
            return Ok(PreviewResponse::empty(PreviewState::Disabled));
        };
        let url = valid_url(raw).map_err(PreviewError::InvalidUrl)?;
        // Serialize lookup/admission with completion so a request cannot admit
        // a second capture from a snapshot taken before the first one completed.
        let mut running = self.running.lock().await;
        if Utc::now().timestamp()
            < self
                .cache_error_until
                .load(std::sync::atomic::Ordering::Relaxed)
        {
            return Err(PreviewError::CacheUnavailable);
        }
        // Preserve the exact request, including queries and fragments, in its identity.
        let key = key_for(raw.as_bytes());
        let lookup_store = Arc::clone(store);
        let lookup_key = key.clone();
        let entry = tokio::task::spawn_blocking(move || lookup_store.lock().get(&lookup_key))
            .await
            .map_err(|_| PreviewError::CacheUnavailable)?
            .map_err(|_| PreviewError::CacheUnavailable)?;
        let now = Utc::now().timestamp();
        let should_capture = entry.as_ref().is_none_or(|entry| {
            let ttl = if entry.response.image_url.is_some() {
                POSITIVE_TTL
            } else {
                // A temporary browser failure must not suppress screenshots for a week.
                NEGATIVE_TTL
            };
            now.saturating_sub(entry.attempted) >= NEGATIVE_TTL
                && entry
                    .captured
                    .is_none_or(|captured| now.saturating_sub(captured) >= ttl)
        });
        if should_capture && !running.contains(&key) && running.len() < 2 {
            running.insert(key.clone());
            let runtime = Arc::clone(self);
            let store = Arc::clone(store);
            let job_key = key.clone();
            tokio::spawn(async move {
                // Separate task ensures even a panicking worker releases admission.
                let capture = Arc::clone(&runtime.capture);
                let result = tokio::spawn(async move { capture(url).await })
                    .await
                    .unwrap_or_else(|_| Err("preview capture failed".into()));
                let mut running = runtime.running.lock().await;
                let save_key = job_key.clone();
                let saved = tokio::task::spawn_blocking(move || {
                    store.lock().save(&save_key, result, Utc::now().timestamp())
                })
                .await;
                if !matches!(saved, Ok(Ok(()))) {
                    // A full/read-only cache must not turn UI polling into repeated
                    // external captures. One bounded cooldown covers storage failure.
                    runtime.cache_error_until.store(
                        Utc::now().timestamp() + NEGATIVE_TTL,
                        std::sync::atomic::Ordering::Relaxed,
                    );
                }
                running.remove(&job_key);
            });
        }
        let active = running.contains(&key);
        Ok(match entry {
            Some(mut entry) => {
                if entry.captured.is_some() {
                    entry.response.refreshing = active;
                    entry.response
                } else if active {
                    PreviewResponse::empty(PreviewState::Pending)
                } else {
                    entry.response
                }
            }
            None => PreviewResponse::empty(if active {
                PreviewState::Pending
            } else {
                PreviewState::Unavailable
            }),
        })
    }

    pub async fn image(&self, key: &str) -> Option<Vec<u8>> {
        // Never interpret a request key as a filesystem path.
        if key.len() != 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let store = Arc::clone(self.store.as_ref()?);
        let key = key.to_owned();
        tokio::task::spawn_blocking(move || {
            store
                .lock()
                .db
                .query_row("SELECT image FROM previews WHERE key = ?1", [key], |row| {
                    row.get::<_, Option<Vec<u8>>>(0)
                })
                .optional()
                .ok()
                .flatten()
                .flatten()
        })
        .await
        .ok()
        .flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Semaphore;

    const URL: &str = "https://example.com/article?token=private#section";

    fn captured() -> CapturedPreview {
        CapturedPreview {
            title: Some("Example article".into()),
            description: Some("A safe text description".into()),
            final_url: URL.into(),
            screenshot: Some(vec![0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
        }
    }

    fn controlled(fail: bool) -> (Arc<PreviewRuntime>, Arc<AtomicUsize>, Arc<Semaphore>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Semaphore::new(0));
        let capture_calls = Arc::clone(&calls);
        let capture_gate = Arc::clone(&gate);
        let runtime = PreviewRuntime {
            store: Some(Arc::new(Mutex::new(
                Store::open(Path::new(":memory:"), MAX_ENTRIES, MAX_BYTES).unwrap(),
            ))),
            capture: Arc::new(move |_| {
                let calls = Arc::clone(&capture_calls);
                let gate = Arc::clone(&capture_gate);
                Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    gate.acquire().await.unwrap().forget();
                    if fail {
                        Err("capture unavailable".into())
                    } else {
                        Ok(captured())
                    }
                })
            }),
            ..PreviewRuntime::default()
        };
        (Arc::new(runtime), calls, gate)
    }

    async fn idle(runtime: &PreviewRuntime) {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if runtime.running.lock().await.is_empty() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("capture jobs should finish");
    }

    #[tokio::test]
    async fn disabled_runtime_does_not_open_vault_or_validate_or_capture() {
        let runtime = PreviewRuntime::for_vault(
            Path::new("/does/not/exist"),
            &clep_config::ExternalPreviewsSettings::default(),
        )
        .await
        .unwrap();
        assert_eq!(
            runtime.request("not a URL").await.unwrap().state,
            PreviewState::Disabled
        );
        assert!(runtime.image(&"a".repeat(64)).await.is_none());
    }

    #[tokio::test]
    async fn capture_jobs_deduplicate_and_reject_over_capacity_without_a_queue() {
        let (runtime, calls, gate) = controlled(false);
        assert_eq!(
            runtime.request(URL).await.unwrap().state,
            PreviewState::Pending
        );
        for _ in 0..8 {
            assert_eq!(
                runtime.request(URL).await.unwrap().state,
                PreviewState::Pending
            );
        }
        // Fragments are part of the cache identity, not silently discarded.
        let second = format!("{URL}-other");
        assert_eq!(
            runtime.request(&second).await.unwrap().state,
            PreviewState::Pending
        );
        assert_eq!(
            runtime.request("https://example.org/").await.unwrap().state,
            PreviewState::Unavailable
        );
        gate.add_permits(2);
        idle(&runtime).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let ready = runtime.request(URL).await.unwrap();
        assert_eq!(ready.state, PreviewState::Ready);
        assert!(!ready.refreshing);
        assert_eq!(ready.title.as_deref(), Some("Example article"));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn metadata_fallback_retries_the_screenshot_after_failure_cooldown() {
        let (runtime, calls, gate) = controlled(false);
        let mut metadata = captured();
        metadata.screenshot = None;
        runtime
            .store
            .as_ref()
            .unwrap()
            .lock()
            .save(
                &key_for(URL.as_bytes()),
                Ok(metadata),
                Utc::now().timestamp() - NEGATIVE_TTL - 1,
            )
            .unwrap();
        let pending = runtime.request(URL).await.unwrap();
        assert_eq!(pending.state, PreviewState::Ready);
        assert_eq!(pending.title.as_deref(), Some("Example article"));
        assert!(pending.image_url.is_none());
        assert!(pending.refreshing);
        gate.add_permits(1);
        idle(&runtime).await;
        let ready = runtime.request(URL).await.unwrap();
        assert!(ready.image_url.is_some());
        assert!(!ready.refreshing);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn unwritable_cache_stops_polling_from_restarting_captures() {
        let (runtime, calls, gate) = controlled(false);
        runtime
            .store
            .as_ref()
            .unwrap()
            .lock()
            .db
            .pragma_update(None, "query_only", true)
            .unwrap();
        assert_eq!(
            runtime.request(URL).await.unwrap().state,
            PreviewState::Pending
        );
        gate.add_permits(1);
        idle(&runtime).await;
        for _ in 0..3 {
            assert!(matches!(
                runtime.request(URL).await,
                Err(PreviewError::CacheUnavailable)
            ));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn stale_success_is_served_during_refresh_and_failed_refresh_backs_off() {
        let (runtime, calls, gate) = controlled(true);
        let key = key_for(URL.as_bytes());
        let old_time = Utc::now().timestamp() - POSITIVE_TTL - 1;
        runtime
            .store
            .as_ref()
            .unwrap()
            .lock()
            .save(&key, Ok(captured()), old_time)
            .unwrap();
        let stale = runtime.request(URL).await.unwrap();
        assert_eq!(stale.state, PreviewState::Ready);
        assert!(stale.refreshing);
        let again = runtime.request(URL).await.unwrap();
        assert!(again.refreshing);
        assert_eq!(again.captured_at, stale.captured_at);
        gate.add_permits(1);
        idle(&runtime).await;
        let retained = runtime.request(URL).await.unwrap();
        assert_eq!(retained.state, PreviewState::Ready);
        assert!(!retained.refreshing);
        assert_eq!(retained.captured_at, stale.captured_at);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn negative_cache_expires_and_successful_refresh_replaces_old_metadata() {
        let (runtime, calls, gate) = controlled(false);
        let key = key_for(URL.as_bytes());
        runtime
            .store
            .as_ref()
            .unwrap()
            .lock()
            .save(&key, Err("failed".into()), Utc::now().timestamp())
            .unwrap();
        assert_eq!(
            runtime.request(URL).await.unwrap().state,
            PreviewState::Unavailable
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        runtime
            .store
            .as_ref()
            .unwrap()
            .lock()
            .db
            .execute(
                "UPDATE previews SET attempted = ?1",
                [Utc::now().timestamp() - NEGATIVE_TTL - 1],
            )
            .unwrap();
        assert_eq!(
            runtime.request(URL).await.unwrap().state,
            PreviewState::Pending
        );
        gate.add_permits(1);
        idle(&runtime).await;
        assert_eq!(
            runtime.request(URL).await.unwrap().state,
            PreviewState::Ready
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn persistent_cache_evicts_by_count_and_bytes_in_atomic_replacements() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("previews.sqlite3");
        {
            let mut store = Store::open(&path, 2, 2000).unwrap();
            store.save("first", Ok(captured()), 1).unwrap();
            store.save("second", Ok(captured()), 2).unwrap();
            store.save("third", Ok(captured()), 3).unwrap();
            assert!(store.get("first").unwrap().is_none());
            assert!(store.get("second").unwrap().is_some());
            let mut larger = captured();
            larger.screenshot.as_mut().unwrap().resize(1600, 0);
            store.save("fourth", Ok(larger), 4).unwrap();
            assert!(store.get("second").unwrap().is_none());
            assert!(store.get("third").unwrap().is_none());
            assert!(store.get("fourth").unwrap().is_some());
        }
        let reopened = Store::open(&path, 2, 2000).unwrap();
        assert!(reopened.get("third").unwrap().is_none());
        assert_eq!(
            reopened
                .get("fourth")
                .unwrap()
                .unwrap()
                .response
                .title
                .as_deref(),
            Some("Example article")
        );
    }

    #[tokio::test]
    async fn image_http_reads_are_local_only_and_keys_cannot_be_paths() {
        let (runtime, calls, _) = controlled(false);
        let key = key_for(URL.as_bytes());
        runtime
            .store
            .as_ref()
            .unwrap()
            .lock()
            .save(&key, Ok(captured()), Utc::now().timestamp())
            .unwrap();
        assert!(runtime.image("../previews.sqlite3").await.is_none());
        assert!(runtime.image(&"g".repeat(64)).await.is_none());
        let (mut state, _tmp) = crate::state_test_support::make_state().await;
        Arc::get_mut(&mut state).unwrap().external_previews = runtime;
        let server =
            axum_test::TestServer::new(crate::api::external_previews::router().with_state(state))
                .unwrap();
        let status = server.get("/external-previews/status").await;
        assert_eq!(status.json::<serde_json::Value>()["enabled"], true);
        let image = server
            .get(&format!("/external-previews/images/{key}"))
            .await;
        image.assert_status_ok();
        image.assert_header("content-type", "image/jpeg");
        image.assert_header("x-content-type-options", "nosniff");
        assert_eq!(
            image.as_bytes().as_ref(),
            captured().screenshot.unwrap().as_slice()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn invalid_urls_do_not_admit_workers() {
        let (runtime, calls, _) = controlled(false);
        for url in [
            "file:///etc/passwd",
            "https://user:secret@example.com/",
            "javascript:alert(1)",
        ] {
            assert!(matches!(
                runtime.request(url).await,
                Err(PreviewError::InvalidUrl(_))
            ));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}
