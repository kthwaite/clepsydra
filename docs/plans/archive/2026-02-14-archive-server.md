# Archive Server: CAS Module & Archive Endpoint

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a content-addressed blob store and archive ingest endpoint to the Clepsydra server so the browser extension can store captured web pages.

**Architecture:** New `src/vault/cas.rs` module owns blob storage (SHA-256 keyed, two-level fan-out directory). New `src/api/archive.rs` provides `POST /archive` (ingest), `GET /cas/{hash}` (blob serving), and `GET /archive/status` (diagnostics). A `PostDeleteHook` decrements blob ref_counts when archive pages are removed. Config extended with `[archive]` section.

**Tech Stack:** Rust, Axum 0.8, rusqlite (bundled), sha2 crate, base64 crate, serde

**Design doc:** `docs/plans/2026-02-14-browser-extension-design.md`

---

### Task 1: Add dependencies

**Files:**
- Modify: `Cargo.toml`

**Step 1: Add sha2 and base64 crates**

Add to `[dependencies]` in `Cargo.toml`:

```toml
sha2 = "0.10"
base64 = "0.22"
```

blake3 is already present but Web Crypto API only supports SHA-256, so both extension and server must agree on SHA-256 for cross-platform hash consistency.

**Step 2: Verify it compiles**

Run: `cargo check`
Expected: compiles cleanly

**Step 3: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "deps: add sha2 and base64 for content-addressed storage"
```

---

### Task 2: CAS module — ContentStore struct and blob storage

**Files:**
- Create: `src/vault/cas.rs`
- Modify: `src/vault/mod.rs` (add `pub mod cas;`)

**Step 1: Write the failing test — store and retrieve a blob**

At the bottom of `src/vault/cas.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_store() -> (ContentStore, TempDir) {
        let tmp = TempDir::new().unwrap();
        let store = ContentStore::open(tmp.path()).unwrap();
        (store, tmp)
    }

    #[test]
    fn store_and_retrieve_blob() {
        let (store, _tmp) = test_store();
        let data = b"hello world";
        let result = store.store(data, "text/plain").unwrap();
        assert!(result.hash.starts_with("sha256:"));
        assert!(!result.already_existed);

        let (retrieved, content_type) = store.retrieve(&result.hash).unwrap();
        assert_eq!(retrieved, data);
        assert_eq!(content_type, "text/plain");
    }
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --lib vault::cas::tests::store_and_retrieve_blob`
Expected: FAIL — module doesn't exist yet

**Step 3: Implement ContentStore with store/retrieve**

In `src/vault/cas.rs`:

```rust
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use sha2::{Sha256, Digest};

/// Result of storing a blob in the CAS.
pub struct StoreResult {
    pub hash: String,
    pub already_existed: bool,
}

/// Content-addressed blob store.
///
/// Blobs are stored on disk in a two-level fan-out directory (like git objects)
/// keyed by their SHA-256 hash. Metadata (size, content_type, ref_count) is
/// tracked in a SQLite table.
pub struct ContentStore {
    root: PathBuf,
    db: Connection,
}

impl ContentStore {
    /// Open or create a content store at the given root directory.
    pub fn open(root: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        fs::create_dir_all(root)?;
        let db_path = root.join("cas.db");
        let db = Connection::open(&db_path)?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS blobs (
                hash         TEXT PRIMARY KEY,
                size         INTEGER NOT NULL,
                content_type TEXT NOT NULL,
                created_at   TEXT NOT NULL,
                ref_count    INTEGER NOT NULL DEFAULT 1
            );"
        )?;
        Ok(Self { root: root.to_path_buf(), db })
    }

    /// Compute the SHA-256 hash of data, returning "sha256:<hex>".
    fn hash(data: &[u8]) -> String {
        let digest = Sha256::digest(data);
        format!("sha256:{:x}", digest)
    }

    /// Resolve a hash to its filesystem path.
    fn blob_path(&self, hash: &str) -> PathBuf {
        // hash format: "sha256:abcdef..."
        let hex = hash.strip_prefix("sha256:").unwrap_or(hash);
        let prefix = &hex[..2];
        self.root.join(prefix).join(hex)
    }

    /// Store a blob. Returns the hash and whether it already existed.
    pub fn store(&self, data: &[u8], content_type: &str) -> Result<StoreResult, Box<dyn std::error::Error>> {
        let hash = Self::hash(data);

        // Check if already stored
        if self.exists(&hash)? {
            self.increment_ref(&hash)?;
            return Ok(StoreResult { hash, already_existed: true });
        }

        // Write blob to disk
        let path = self.blob_path(&hash);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, data)?;

        // Insert metadata row
        let now = chrono::Utc::now().to_rfc3339();
        self.db.execute(
            "INSERT INTO blobs (hash, size, content_type, created_at, ref_count) VALUES (?1, ?2, ?3, ?4, 1)",
            params![hash, data.len() as i64, content_type, now],
        )?;

        Ok(StoreResult { hash, already_existed: false })
    }

    /// Retrieve a blob's data and content type.
    pub fn retrieve(&self, hash: &str) -> Result<(Vec<u8>, String), Box<dyn std::error::Error>> {
        let content_type: String = self.db.query_row(
            "SELECT content_type FROM blobs WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )?;

        let path = self.blob_path(hash);
        let data = fs::read(&path)?;
        Ok((data, content_type))
    }

    /// Check whether a blob exists in the store.
    pub fn exists(&self, hash: &str) -> Result<bool, Box<dyn std::error::Error>> {
        let count: i64 = self.db.query_row(
            "SELECT COUNT(*) FROM blobs WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Increment the reference count for a blob.
    pub fn increment_ref(&self, hash: &str) -> Result<(), Box<dyn std::error::Error>> {
        self.db.execute(
            "UPDATE blobs SET ref_count = ref_count + 1 WHERE hash = ?1",
            params![hash],
        )?;
        Ok(())
    }

    /// Decrement the reference count for a blob.
    pub fn decrement_ref(&self, hash: &str) -> Result<(), Box<dyn std::error::Error>> {
        self.db.execute(
            "UPDATE blobs SET ref_count = ref_count - 1 WHERE hash = ?1",
            params![hash],
        )?;
        Ok(())
    }

    /// Remove blobs with ref_count <= 0 that are older than `min_age`.
    /// Returns the number of blobs pruned.
    pub fn gc(&self, min_age: std::time::Duration) -> Result<u32, Box<dyn std::error::Error>> {
        let cutoff = (chrono::Utc::now() - chrono::Duration::from_std(min_age)?).to_rfc3339();
        let mut stmt = self.db.prepare(
            "SELECT hash FROM blobs WHERE ref_count <= 0 AND created_at < ?1"
        )?;
        let hashes: Vec<String> = stmt.query_map(params![cutoff], |row| row.get(0))?
            .collect::<Result<_, _>>()?;

        let mut pruned = 0u32;
        for hash in &hashes {
            let path = self.blob_path(hash);
            if path.exists() {
                fs::remove_file(&path)?;
            }
            self.db.execute("DELETE FROM blobs WHERE hash = ?1", params![hash])?;
            pruned += 1;
        }
        Ok(pruned)
    }

    /// Return summary stats for the store.
    pub fn stats(&self) -> Result<CasStats, Box<dyn std::error::Error>> {
        let blob_count: i64 = self.db.query_row(
            "SELECT COUNT(*) FROM blobs", [], |row| row.get(0),
        )?;
        let total_size: i64 = self.db.query_row(
            "SELECT COALESCE(SUM(size), 0) FROM blobs", [], |row| row.get(0),
        )?;
        Ok(CasStats { blob_count: blob_count as u64, total_size_bytes: total_size as u64 })
    }
}

pub struct CasStats {
    pub blob_count: u64,
    pub total_size_bytes: u64,
}
```

Add `pub mod cas;` to `src/vault/mod.rs` after the existing module declarations.

**Step 4: Run test to verify it passes**

Run: `cargo test --lib vault::cas::tests::store_and_retrieve_blob`
Expected: PASS

**Step 5: Commit**

```bash
git add src/vault/cas.rs src/vault/mod.rs
git commit -m "feat(cas): add ContentStore with blob storage and retrieval"
```

---

### Task 3: CAS module — deduplication, ref_count, and gc tests

**Files:**
- Modify: `src/vault/cas.rs` (add tests)

**Step 1: Write tests for dedup and gc**

Add to the `tests` module in `src/vault/cas.rs`:

```rust
#[test]
fn storing_same_blob_twice_deduplicates() {
    let (store, _tmp) = test_store();
    let data = b"duplicate content";
    let r1 = store.store(data, "text/plain").unwrap();
    let r2 = store.store(data, "text/plain").unwrap();

    assert_eq!(r1.hash, r2.hash);
    assert!(!r1.already_existed);
    assert!(r2.already_existed);
}

#[test]
fn ref_count_increments_on_duplicate_store() {
    let (store, _tmp) = test_store();
    let data = b"ref counted";
    store.store(data, "text/plain").unwrap();
    store.store(data, "text/plain").unwrap();

    let ref_count: i64 = store.db.query_row(
        "SELECT ref_count FROM blobs WHERE hash = ?1",
        params![ContentStore::hash(data)],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(ref_count, 2);
}

#[test]
fn decrement_ref_and_gc() {
    let (store, _tmp) = test_store();
    let data = b"ephemeral";
    let result = store.store(data, "text/plain").unwrap();

    store.decrement_ref(&result.hash).unwrap();
    let pruned = store.gc(std::time::Duration::ZERO).unwrap();
    assert_eq!(pruned, 1);
    assert!(!store.exists(&result.hash).unwrap());
}

#[test]
fn gc_respects_min_age() {
    let (store, _tmp) = test_store();
    let data = b"young blob";
    let result = store.store(data, "text/plain").unwrap();

    store.decrement_ref(&result.hash).unwrap();
    // min_age of 1 hour — blob was just created, should not be pruned
    let pruned = store.gc(std::time::Duration::from_secs(3600)).unwrap();
    assert_eq!(pruned, 0);
    assert!(store.exists(&result.hash).unwrap());
}

#[test]
fn retrieve_nonexistent_returns_error() {
    let (store, _tmp) = test_store();
    let result = store.retrieve("sha256:0000000000000000000000000000000000000000000000000000000000000000");
    assert!(result.is_err());
}

#[test]
fn stats_reflect_stored_blobs() {
    let (store, _tmp) = test_store();
    store.store(b"blob1", "text/plain").unwrap();
    store.store(b"blob2", "image/png").unwrap();
    store.store(b"blob1", "text/plain").unwrap(); // dedup

    let stats = store.stats().unwrap();
    assert_eq!(stats.blob_count, 2);
    assert_eq!(stats.total_size_bytes, 10); // 5 + 5
}
```

**Step 2: Run tests**

Run: `cargo test --lib vault::cas::tests`
Expected: all PASS

**Step 3: Commit**

```bash
git add src/vault/cas.rs
git commit -m "test(cas): add dedup, ref_count, gc, and stats tests"
```

---

### Task 4: Configuration — add [archive] section

**Files:**
- Modify: `src/vault/config.rs`

**Step 1: Write the failing test**

Add to `src/vault/config.rs` (add a `#[cfg(test)] mod tests` block if none exists):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use std::fs;

    #[test]
    fn archive_config_defaults() {
        let config = VaultConfig::default();
        assert!(config.archive.enabled);
        assert_eq!(config.archive.cas_path, "~/.clepsydra/cas");
        assert_eq!(config.archive.default_path_prefix, "archive");
        assert_eq!(config.archive.max_blob_size_mb, 50);
        assert_eq!(config.archive.max_request_size_mb, 100);
        assert_eq!(config.archive.gc_min_age_days, 30);
    }

    #[test]
    fn archive_config_from_toml() {
        let tmp = TempDir::new().unwrap();
        let vault_root = tmp.path();
        fs::create_dir_all(vault_root.join(".clepsydra")).unwrap();
        fs::write(
            vault_root.join(".clepsydra/config.toml"),
            r#"
[archive]
enabled = false
cas_path = "/custom/cas"
max_blob_size_mb = 200
"#,
        ).unwrap();

        let config = VaultConfig::load(vault_root).unwrap();
        assert!(!config.archive.enabled);
        assert_eq!(config.archive.cas_path, "/custom/cas");
        assert_eq!(config.archive.max_blob_size_mb, 200);
        // Unset fields keep defaults
        assert_eq!(config.archive.default_path_prefix, "archive");
    }
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --lib vault::config::tests`
Expected: FAIL — `archive` field doesn't exist on VaultConfig

**Step 3: Add ArchiveSection to VaultConfig**

Add to `src/vault/config.rs`, after `AcademicSection`:

```rust
/// Configuration for the web archive subsystem.
#[derive(Debug, Clone, Deserialize)]
pub struct ArchiveSection {
    #[serde(default = "default_archive_enabled")]
    pub enabled: bool,
    #[serde(default = "default_cas_path")]
    pub cas_path: String,
    #[serde(default = "default_archive_path_prefix")]
    pub default_path_prefix: String,
    #[serde(default = "default_max_blob_size_mb")]
    pub max_blob_size_mb: u64,
    #[serde(default = "default_max_request_size_mb")]
    pub max_request_size_mb: u64,
    #[serde(default = "default_gc_min_age_days")]
    pub gc_min_age_days: u32,
}

impl Default for ArchiveSection {
    fn default() -> Self {
        Self {
            enabled: default_archive_enabled(),
            cas_path: default_cas_path(),
            default_path_prefix: default_archive_path_prefix(),
            max_blob_size_mb: default_max_blob_size_mb(),
            max_request_size_mb: default_max_request_size_mb(),
            gc_min_age_days: default_gc_min_age_days(),
        }
    }
}

fn default_archive_enabled() -> bool { true }
fn default_cas_path() -> String { "~/.clepsydra/cas".to_string() }
fn default_archive_path_prefix() -> String { "archive".to_string() }
fn default_max_blob_size_mb() -> u64 { 50 }
fn default_max_request_size_mb() -> u64 { 100 }
fn default_gc_min_age_days() -> u32 { 30 }
```

Add the field to `VaultConfig`:

```rust
pub struct VaultConfig {
    #[serde(default)]
    pub vault: VaultSection,
    #[serde(default)]
    pub academic: AcademicSection,
    #[serde(default)]
    pub archive: ArchiveSection,
}
```

**Step 4: Run tests**

Run: `cargo test --lib vault::config::tests`
Expected: PASS

**Step 5: Commit**

```bash
git add src/vault/config.rs
git commit -m "feat(config): add [archive] section with CAS path and limits"
```

---

### Task 5: Archive API — request/response types and slug generation

**Files:**
- Create: `src/api/archive.rs`
- Modify: `src/api/mod.rs` (add `pub mod archive;`)

**Step 1: Define the types and slug helper**

Create `src/api/archive.rs` with request/response types and a slugify helper. Write a test for the slugifier:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct ArchiveRequest {
    pub url: String,
    pub canonical_url: Option<String>,
    pub domain: String,
    pub title: String,
    pub description: Option<String>,
    pub captured_at: String,
    pub content_hash: String,
    pub snapshot_hash: String,
    pub markdown_body: String,
    pub tags: Vec<String>,
    pub blobs: Vec<BlobUpload>,
}

#[derive(Debug, Deserialize)]
pub struct BlobUpload {
    pub hash: String,
    pub content_type: String,
    pub data: String, // base64
}

#[derive(Debug, Serialize)]
pub struct ArchiveResponse {
    pub page_id: String,
    pub vault_path: String,
    pub blobs_stored: u32,
    pub blobs_deduped: u32,
    pub status: ArchiveStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveStatus {
    Created,
    AlreadyExists,
    ContentChanged,
}

/// Convert a title to a URL-safe slug, truncated to `max_len` chars.
fn slugify(title: &str, max_len: usize) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    // Collapse runs of dashes, trim leading/trailing dashes
    let collapsed: String = slug
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if collapsed.len() > max_len {
        // Truncate at a dash boundary if possible
        match collapsed[..max_len].rfind('-') {
            Some(pos) if pos > max_len / 2 => collapsed[..pos].to_string(),
            _ => collapsed[..max_len].to_string(),
        }
    } else {
        collapsed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Hello World", 80), "hello-world");
    }

    #[test]
    fn slugify_special_chars() {
        assert_eq!(
            slugify("The Architecture of Open-Source Applications!", 80),
            "the-architecture-of-open-source-applications"
        );
    }

    #[test]
    fn slugify_truncates() {
        let long_title = "a ".repeat(50); // 100 chars
        let slug = slugify(&long_title, 20);
        assert!(slug.len() <= 20);
    }

    #[test]
    fn slugify_unicode() {
        assert_eq!(slugify("Über die Grenzen", 80), "über-die-grenzen");
    }
}
```

Add `pub mod archive;` to `src/api/mod.rs`.

**Step 2: Run tests**

Run: `cargo test --lib api::archive::tests`
Expected: PASS

**Step 3: Commit**

```bash
git add src/api/archive.rs src/api/mod.rs
git commit -m "feat(archive): add request/response types and slug generation"
```

---

### Task 6: Archive API — POST /archive endpoint

**Files:**
- Modify: `src/api/archive.rs`
- Modify: `src/api/mod.rs` (add to router)

This task depends on the CAS being available through `AppState`. We need to wire that up first.

**Step 1: Add ContentStore to AppState**

In `src/api/mod.rs`, add the CAS field:

```rust
use crate::vault::cas::ContentStore;

pub struct AppState {
    pub vault: Vault,
    pub index: Arc<parking_lot::Mutex<VaultIndex>>,
    pub cas: Arc<parking_lot::Mutex<ContentStore>>,  // NEW
    pub warnings: parking_lot::Mutex<Vec<String>>,
    pub change_tx: broadcast::Sender<SyncNotification>,
    pub hooks: Vec<Box<dyn crate::vault::hooks::PostMoveHook>>,
}
```

**Step 2: Initialize CAS in run_server()**

In `src/lib.rs`, after opening the vault, initialize the CAS. Resolve `~` in the CAS path:

```rust
// Open CAS
let cas_path_raw = &vault.config().archive.cas_path;
let cas_path = if cas_path_raw.starts_with("~/") {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(&cas_path_raw[2..])
} else {
    PathBuf::from(cas_path_raw)
};
let cas = vault::cas::ContentStore::open(&cas_path)?;
```

Add `cas: Arc::new(parking_lot::Mutex::new(cas))` to the `AppState` construction.

Note: Add `dirs = "6"` to `Cargo.toml` `[dependencies]` for home directory resolution.

**Step 3: Update test helper**

In `tests/api_test.rs`, update `setup_server()` to include the CAS:

```rust
use clepsydra::vault::cas::ContentStore;

fn setup_server() -> (TestServer, TempDir) {
    // ... existing setup ...
    let cas_path = tmp.path().join("cas");
    let cas = ContentStore::open(&cas_path).unwrap();

    let state = Arc::new(AppState {
        vault,
        index: Arc::new(parking_lot::Mutex::new(index)),
        cas: Arc::new(parking_lot::Mutex::new(cas)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: production_hooks(),
    });
    // ...
}
```

**Step 4: Implement the POST handler**

In `src/api/archive.rs`, add the handler and router:

```rust
use std::fs;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use chrono::Utc;
use rusqlite::params;
use uuid::Uuid;

use super::AppState;
use super::error::ApiError;
use crate::vault::page::{PageMeta, write_page_content};
use crate::vault::path::VaultPath;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", post(ingest_archive))
        .route("/status", get(archive_status))
}

async fn ingest_archive(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ArchiveRequest>,
) -> Result<Response, ApiError> {
    // 1. Check for existing archive of this URL
    {
        let index = state.index.lock();
        if let Some(existing) = find_existing_archive(&index, &req.url)? {
            if existing.content_hash == req.content_hash {
                return Ok((StatusCode::OK, Json(ArchiveResponse {
                    page_id: existing.page_id,
                    vault_path: existing.vault_path,
                    blobs_stored: 0,
                    blobs_deduped: 0,
                    status: ArchiveStatus::AlreadyExists,
                })).into_response());
            }
            return Err(ApiError::conflict_with_detail(
                "URL already archived with different content",
                serde_json::json!({
                    "existing_page_id": existing.page_id,
                    "existing_path": existing.vault_path,
                    "existing_content_hash": existing.content_hash,
                }),
            ));
        }
    }

    // 2. Store blobs in CAS
    let mut blobs_stored = 0u32;
    let mut blobs_deduped = 0u32;
    {
        let cas = state.cas.lock();
        for blob in &req.blobs {
            let data = BASE64.decode(&blob.data)
                .map_err(|e| ApiError::bad_request(format!("invalid base64 in blob {}: {}", blob.hash, e)))?;

            // Verify hash matches
            let computed = crate::vault::cas::ContentStore::hash_bytes(&data);
            if computed != blob.hash {
                return Err(ApiError::bad_request(format!(
                    "hash mismatch for blob: expected {}, got {}", blob.hash, computed
                )));
            }

            let result = cas.store(&data, &blob.content_type)
                .map_err(|e| ApiError::internal(format!("CAS store error: {e}")))?;
            if result.already_existed {
                blobs_deduped += 1;
            } else {
                blobs_stored += 1;
            }
        }
    }

    // 3. Create vault page
    let slug = slugify(&req.title, 80);
    let prefix = &state.vault.config().archive.default_path_prefix;
    let base_path = format!("{}/{}/{}.md", prefix, req.domain, slug);

    // Find a non-colliding path
    let vault_path_str = find_available_path(&state.vault, &base_path);
    let vault_path = VaultPath::new(&vault_path_str)
        .map_err(|e| ApiError::bad_request(format!("invalid vault path: {e}")))?;

    // Build frontmatter
    let mut meta = PageMeta::new();
    meta.title = Some(req.title.clone());
    meta.tags = req.tags.clone();

    // Insert archive metadata into extra
    let mut archive_meta = serde_yaml::Mapping::new();
    archive_meta.insert("url".into(), req.url.clone().into());
    archive_meta.insert("domain".into(), req.domain.clone().into());
    archive_meta.insert("captured_at".into(), req.captured_at.clone().into());
    archive_meta.insert("snapshot_hash".into(), req.snapshot_hash.clone().into());
    let resource_hashes: Vec<serde_yaml::Value> = req.blobs.iter()
        .map(|b| serde_yaml::Value::String(b.hash.clone()))
        .collect();
    archive_meta.insert("resource_hashes".into(), serde_yaml::Value::Sequence(resource_hashes));
    archive_meta.insert("content_hash".into(), req.content_hash.clone().into());
    if let Some(ref canonical_url) = req.canonical_url {
        archive_meta.insert("canonical_url".into(), canonical_url.clone().into());
    }
    if let Some(ref description) = req.description {
        archive_meta.insert("description".into(), description.clone().into());
    }
    meta.extra.insert(
        "archive".to_string(),
        serde_yaml::Value::Mapping(archive_meta),
    );

    // Write page file
    let abs_path = state.vault.resolve(&vault_path);
    if let Some(parent) = abs_path.parent() {
        fs::create_dir_all(parent).map_err(|e| ApiError::internal(format!("mkdir: {e}")))?;
    }
    let content = write_page_content(&meta, &req.markdown_body);
    fs::write(&abs_path, &content).map_err(|e| ApiError::internal(format!("write: {e}")))?;

    // Index the page
    {
        let mut index = state.index.lock();
        index.index_page(&state.vault, &vault_path)
            .map_err(|e| ApiError::internal(format!("index: {e}")))?;
        index.resolve_links_for_page(&vault_path)
            .map_err(|e| ApiError::internal(format!("resolve links: {e}")))?;
    }

    // Broadcast change
    let _ = state.change_tx.send(
        crate::api::events::SyncNotification::IndexChanged {
            upserted: vec![vault_path_str.clone()],
            removed: vec![],
        }
    );

    Ok((StatusCode::CREATED, Json(ArchiveResponse {
        page_id: meta.id.to_string(),
        vault_path: vault_path_str,
        blobs_stored,
        blobs_deduped,
        status: ArchiveStatus::Created,
    })).into_response())
}
```

The `find_existing_archive` and `find_available_path` helpers:

```rust
struct ExistingArchive {
    page_id: String,
    vault_path: String,
    content_hash: String,
}

fn find_existing_archive(
    index: &crate::vault::index::VaultIndex,
    url: &str,
) -> Result<Option<ExistingArchive>, ApiError> {
    // Query the pages table for a page whose extra->archive->url matches
    // This requires scanning pages; for v1 a sequential scan is acceptable
    let conn = index.connection();
    let mut stmt = conn.prepare(
        "SELECT p.id, p.path, p.extra FROM pages p WHERE p.extra IS NOT NULL"
    ).map_err(|e| ApiError::internal(format!("query: {e}")))?;

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    }).map_err(|e| ApiError::internal(format!("query: {e}")))?;

    for row in rows {
        let (id, path, extra_json) = row.map_err(|e| ApiError::internal(format!("row: {e}")))?;
        if let Ok(extra) = serde_json::from_str::<serde_json::Value>(&extra_json) {
            if let Some(archive_url) = extra.get("archive").and_then(|a| a.get("url")).and_then(|u| u.as_str()) {
                if archive_url == url {
                    let content_hash = extra.get("archive")
                        .and_then(|a| a.get("content_hash"))
                        .and_then(|h| h.as_str())
                        .unwrap_or("")
                        .to_string();
                    return Ok(Some(ExistingArchive { page_id: id, vault_path: path, content_hash }));
                }
            }
        }
    }
    Ok(None)
}

fn find_available_path(vault: &crate::vault::Vault, base_path: &str) -> String {
    let base = base_path.strip_suffix(".md").unwrap_or(base_path);
    let abs = vault.resolve(&VaultPath::new(base_path).unwrap());
    if !abs.exists() {
        return base_path.to_string();
    }
    for i in 2..1000 {
        let candidate = format!("{}-{}.md", base, i);
        let abs = vault.resolve(&VaultPath::new(&candidate).unwrap());
        if !abs.exists() {
            return candidate;
        }
    }
    format!("{}-{}.md", base, Uuid::now_v7())
}
```

Note: `ContentStore::hash_bytes` needs to be a public static method. Rename the existing private `hash` method:

```rust
// In src/vault/cas.rs, rename and make public:
pub fn hash_bytes(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    format!("sha256:{:x}", digest)
}
```

**Step 5: Add archive router to api_router()**

In `src/api/mod.rs`, in `api_router()`:

```rust
.nest("/archive", archive::router())
```

**Step 6: Verify it compiles**

Run: `cargo check`
Expected: compiles (may need adjustments for `index.connection()` — see note below)

Note: The `find_existing_archive` function needs access to the raw SQLite connection from `VaultIndex`. If `VaultIndex` doesn't expose `connection()`, you have two options:
- Add a `pub fn connection(&self) -> &Connection` accessor to `VaultIndex`
- Or query by reading page files from disk using existing vault APIs

Check `src/vault/index.rs` for the available interface and adapt. The plan assumes adding a `connection()` accessor if needed.

**Step 7: Commit**

```bash
git add src/api/archive.rs src/api/mod.rs src/vault/cas.rs src/lib.rs Cargo.toml Cargo.lock
git commit -m "feat(archive): add POST /archive ingest endpoint"
```

---

### Task 7: Archive API — GET /cas/{hash} blob serving

**Files:**
- Modify: `src/api/archive.rs`

**Step 1: Write the integration test**

In `tests/api_test.rs`:

```rust
#[tokio::test]
async fn archive_ingest_and_retrieve_blob() {
    let (server, _tmp) = setup_server();

    // Ingest an archive
    let body = serde_json::json!({
        "url": "https://example.com/article",
        "domain": "example.com",
        "title": "Test Article",
        "captured_at": "2026-02-14T10:00:00Z",
        "content_hash": "sha256:placeholder",
        "snapshot_hash": "sha256:placeholder",
        "markdown_body": "# Test\n\nHello world.",
        "tags": ["archive", "example.com"],
        "blobs": [{
            "hash": "<computed>",
            "content_type": "text/plain",
            "data": "<base64>"
        }]
    });
    // (Test will need real hashes — compute in test setup)

    // For now, just test the CAS serving route directly
    // by storing a blob via the CAS and retrieving it
}
```

Actually, a more focused test: test the blob serving endpoint after a successful ingest. This is better done as a full integration test in Task 9. For now, implement the handler.

**Step 2: Implement the CAS serving route**

Add to `src/api/archive.rs`:

```rust
use axum::extract::Path;
use axum::http::header;

pub fn cas_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/{hash}", get(serve_blob))
}

async fn serve_blob(
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
) -> Result<Response, ApiError> {
    let cas = state.cas.lock();
    let (data, content_type) = cas.retrieve(&hash)
        .map_err(|_| ApiError::not_found(format!("blob not found: {hash}")))?;

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, content_type)],
        data,
    ).into_response())
}
```

Mount in `src/api/mod.rs`:

```rust
.nest("/cas", archive::cas_router())
```

**Step 3: Implement the status endpoint**

```rust
async fn archive_status(
    State(state): State<Arc<AppState>>,
) -> Result<Response, ApiError> {
    let cas = state.cas.lock();
    let stats = cas.stats()
        .map_err(|e| ApiError::internal(format!("stats: {e}")))?;

    // Count archive pages (pages with archive.url in extra)
    // For v1, return blob stats only
    Ok((StatusCode::OK, Json(serde_json::json!({
        "enabled": state.vault.config().archive.enabled,
        "blob_count": stats.blob_count,
        "total_size_bytes": stats.total_size_bytes,
    }))).into_response())
}
```

**Step 4: Verify it compiles**

Run: `cargo check`
Expected: compiles cleanly

**Step 5: Commit**

```bash
git add src/api/archive.rs src/api/mod.rs
git commit -m "feat(archive): add GET /cas/{hash} blob serving and /archive/status"
```

---

### Task 8: PostDeleteHook for ref_count cleanup

**Files:**
- Modify: `src/vault/hooks.rs`
- Create: `src/vault/archive_hook.rs`
- Modify: `src/vault/mod.rs`
- Modify: `src/lib.rs` (wire hook)

**Step 1: Add PostDeleteHook trait**

In `src/vault/hooks.rs`, add after `PostMoveHook`:

```rust
/// Hook invoked after a page has been deleted.
///
/// Domain modules implement this to clean up related resources.
pub trait PostDeleteHook: Send + Sync {
    fn on_page_deleted(
        &self,
        path: &VaultPath,
        page_id: &Uuid,
        meta: &crate::vault::page::PageMeta,
    ) -> Result<(), Box<dyn std::error::Error>>;
}
```

Note: We pass `PageMeta` (read before deletion) so the hook can inspect `extra.archive.resource_hashes`.

**Step 2: Add delete_hooks to AppState**

In `src/api/mod.rs`:

```rust
pub struct AppState {
    // ... existing fields ...
    pub delete_hooks: Vec<Box<dyn crate::vault::hooks::PostDeleteHook>>,
}
```

Update all `AppState` constructions (lib.rs, tests) to include `delete_hooks: vec![]` initially.

**Step 3: Create ArchiveDeleteHook**

Create `src/vault/archive_hook.rs`:

```rust
use crate::vault::cas::ContentStore;
use crate::vault::hooks::PostDeleteHook;
use crate::vault::page::PageMeta;
use crate::vault::path::VaultPath;
use std::sync::Arc;
use uuid::Uuid;

/// Decrements CAS ref_counts when an archive page is deleted.
pub struct ArchiveDeleteHook {
    pub cas: Arc<parking_lot::Mutex<ContentStore>>,
}

impl PostDeleteHook for ArchiveDeleteHook {
    fn on_page_deleted(
        &self,
        _path: &VaultPath,
        _page_id: &Uuid,
        meta: &PageMeta,
    ) -> Result<(), Box<dyn std::error::Error>> {
        // Check if this page has archive metadata
        let archive = match meta.extra.get("archive") {
            Some(serde_yaml::Value::Mapping(m)) => m,
            _ => return Ok(()), // not an archive page
        };

        let cas = self.cas.lock();

        // Decrement snapshot_hash
        if let Some(serde_yaml::Value::String(hash)) = archive.get("snapshot_hash") {
            let _ = cas.decrement_ref(hash); // ignore error if blob already gone
        }

        // Decrement resource_hashes
        if let Some(serde_yaml::Value::Sequence(hashes)) = archive.get("resource_hashes") {
            for h in hashes {
                if let serde_yaml::Value::String(hash) = h {
                    let _ = cas.decrement_ref(hash);
                }
            }
        }

        Ok(())
    }
}
```

Add `pub mod archive_hook;` to `src/vault/mod.rs`.

**Step 4: Wire the hook into the delete handler**

The existing delete handler in `src/api/pages.rs` needs to call delete hooks after removing the page. Read the page metadata *before* deletion, then invoke hooks after the file is removed.

In the delete handler, after the file is deleted and index is updated:

```rust
// Call delete hooks
for hook in &state.delete_hooks {
    if let Err(e) = hook.on_page_deleted(&vault_path, &page_meta.id, &page_meta) {
        tracing::warn!("delete hook error: {e}");
    }
}
```

**Step 5: Wire into run_server()**

In `src/lib.rs`, construct the hook:

```rust
let delete_hooks: Vec<Box<dyn vault::hooks::PostDeleteHook>> = vec![
    Box::new(vault::archive_hook::ArchiveDeleteHook {
        cas: Arc::clone(&state_cas),
    }),
];
```

Where `state_cas` is the `Arc<parking_lot::Mutex<ContentStore>>` created earlier.

**Step 6: Verify it compiles**

Run: `cargo check`
Expected: compiles cleanly

**Step 7: Commit**

```bash
git add src/vault/hooks.rs src/vault/archive_hook.rs src/vault/mod.rs src/api/mod.rs src/api/pages.rs src/lib.rs
git commit -m "feat(archive): add PostDeleteHook for CAS ref_count cleanup"
```

---

### Task 9: Integration tests

**Files:**
- Create: `tests/archive_test.rs`

**Step 1: Write end-to-end archive tests**

```rust
use std::sync::Arc;

use axum::Router;
use axum::http::StatusCode;
use axum_test::TestServer;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use sha2::{Sha256, Digest};
use tokio::sync::broadcast;

use clepsydra::api::{AppState, api_router};
use clepsydra::vault::Vault;
use clepsydra::vault::cas::ContentStore;
use clepsydra::vault::hooks::PostMoveHook;
use clepsydra::vault::academic_hook::AcademicMoveHook;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;
use tempfile::TempDir;

fn sha256_hash(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    format!("sha256:{:x}", digest)
}

fn setup_server() -> (TestServer, TempDir) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let cas_path = tmp.path().join("cas");
    let cas = ContentStore::open(&cas_path).unwrap();

    let (change_tx, _) = broadcast::channel(64);
    let state = Arc::new(AppState {
        vault,
        index: Arc::new(parking_lot::Mutex::new(index)),
        cas: Arc::new(parking_lot::Mutex::new(cas)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: vec![Box::new(AcademicMoveHook)],
        delete_hooks: vec![],
    });

    let app: Router = Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);

    let server = TestServer::new(app).unwrap();
    (server, tmp)
}

#[tokio::test]
async fn archive_ingest_creates_page_and_stores_blobs() {
    let (server, _tmp) = setup_server();

    let image_data = b"fake png data";
    let image_hash = sha256_hash(image_data);
    let image_b64 = BASE64.encode(image_data);

    let markdown = "# Test Article\n\nSome content.";
    let content_hash = sha256_hash(markdown.as_bytes());
    let snapshot_hash = sha256_hash(b"<html>full page</html>");

    let res = server
        .post("/api/vault/archive")
        .json(&serde_json::json!({
            "url": "https://example.com/article",
            "domain": "example.com",
            "title": "Test Article",
            "captured_at": "2026-02-14T10:00:00Z",
            "content_hash": content_hash,
            "snapshot_hash": snapshot_hash,
            "markdown_body": markdown,
            "tags": ["archive", "example.com"],
            "blobs": [{
                "hash": image_hash,
                "content_type": "image/png",
                "data": image_b64,
            }]
        }))
        .await;

    res.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = res.json();
    assert_eq!(body["status"], "created");
    assert_eq!(body["blobs_stored"], 1);
    assert_eq!(body["blobs_deduped"], 0);
    assert!(body["vault_path"].as_str().unwrap().starts_with("archive/example.com/"));

    // Retrieve the blob via CAS endpoint
    let blob_res = server
        .get(&format!("/api/vault/cas/{}", image_hash))
        .await;
    blob_res.assert_status_ok();
}

#[tokio::test]
async fn archive_duplicate_url_same_content_returns_200() {
    let (server, _tmp) = setup_server();

    let markdown = "# Same Content";
    let content_hash = sha256_hash(markdown.as_bytes());

    let payload = serde_json::json!({
        "url": "https://example.com/same",
        "domain": "example.com",
        "title": "Same Page",
        "captured_at": "2026-02-14T10:00:00Z",
        "content_hash": content_hash,
        "snapshot_hash": "sha256:0000",
        "markdown_body": markdown,
        "tags": ["archive"],
        "blobs": [],
    });

    server.post("/api/vault/archive").json(&payload).await
        .assert_status(StatusCode::CREATED);

    let res = server.post("/api/vault/archive").json(&payload).await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["status"], "already_exists");
}

#[tokio::test]
async fn archive_duplicate_url_different_content_returns_409() {
    let (server, _tmp) = setup_server();

    let payload1 = serde_json::json!({
        "url": "https://example.com/changing",
        "domain": "example.com",
        "title": "Changing Page",
        "captured_at": "2026-02-14T10:00:00Z",
        "content_hash": "sha256:aaaa",
        "snapshot_hash": "sha256:0000",
        "markdown_body": "# Version 1",
        "tags": ["archive"],
        "blobs": [],
    });

    server.post("/api/vault/archive").json(&payload1).await
        .assert_status(StatusCode::CREATED);

    let payload2 = serde_json::json!({
        "url": "https://example.com/changing",
        "domain": "example.com",
        "title": "Changing Page",
        "captured_at": "2026-02-14T11:00:00Z",
        "content_hash": "sha256:bbbb",
        "snapshot_hash": "sha256:0000",
        "markdown_body": "# Version 2",
        "tags": ["archive"],
        "blobs": [],
    });

    let res = server.post("/api/vault/archive").json(&payload2).await;
    res.assert_status(StatusCode::CONFLICT);
}

#[tokio::test]
async fn archive_status_returns_stats() {
    let (server, _tmp) = setup_server();

    let res = server.get("/api/vault/archive/status").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["enabled"], true);
    assert_eq!(body["blob_count"], 0);
}
```

**Step 2: Run tests**

Run: `cargo test --test archive_test`
Expected: all PASS

**Step 3: Commit**

```bash
git add tests/archive_test.rs
git commit -m "test(archive): add integration tests for ingest, dedup, and blob serving"
```

---

### Task 10: Final polish — cargo clippy, fmt, full test suite

**Files:**
- Various (lint fixes)

**Step 1: Format**

Run: `cargo fmt`

**Step 2: Lint**

Run: `cargo clippy -- -D warnings`
Fix any warnings.

**Step 3: Run full test suite**

Run: `cargo test`
Expected: all tests pass, including existing tests (verify no regressions from AppState changes)

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: clippy and fmt cleanup for archive module"
```
