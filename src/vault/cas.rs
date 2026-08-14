//! Content-addressed storage for blobs, with reference counting and garbage collection.
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};

/// Result of storing a blob in the CAS.
pub struct StoreResult {
    pub hash: String,
    pub already_existed: bool,
}

/// Metadata for a CAS blob whose database row and backing file agree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobMetadata {
    pub content_type: String,
    pub size: u64,
}

#[derive(Debug)]
pub enum RetrieveLimitedError {
    TooLarge { size: u64, limit: usize },
    Store(String),
}

impl std::fmt::Display for RetrieveLimitedError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { size, limit } => {
                write!(formatter, "CAS blob size {size} exceeds read limit {limit}")
            }
            Self::Store(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for RetrieveLimitedError {}

#[derive(Debug)]
pub struct OpenBlob {
    file: File,
    content_type: String,
    expected_size: u64,
}

impl OpenBlob {
    pub fn content_type(&self) -> &str {
        &self.content_type
    }
    pub fn read_limited(mut self, limit: usize) -> Result<(Vec<u8>, String), RetrieveLimitedError> {
        let mut data = Vec::new();
        data.try_reserve_exact(self.expected_size as usize)
            .map_err(|_| RetrieveLimitedError::Store("CAS read allocation failed".to_string()))?;
        self.file
            .by_ref()
            .take((limit as u64).saturating_add(1))
            .read_to_end(&mut data)
            .map_err(|error| RetrieveLimitedError::Store(error.to_string()))?;
        if data.len() > limit {
            return Err(RetrieveLimitedError::TooLarge {
                size: data.len() as u64,
                limit,
            });
        }
        if data.len() as u64 != self.expected_size {
            return Err(RetrieveLimitedError::Store(format!(
                "CAS backing file size changed while reading: expected {}, got {}",
                self.expected_size,
                data.len()
            )));
        }
        Ok((data, self.content_type))
    }
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
            );",
        )?;
        Ok(Self {
            root: root.to_path_buf(),
            db,
        })
    }

    /// Compute the SHA-256 hash of data, returning "sha256:<hex>".
    pub fn hash_bytes(data: &[u8]) -> String {
        let digest = Sha256::digest(data);
        format!("sha256:{:x}", digest)
    }

    /// Validate that a hash has the expected format: "sha256:" followed by exactly
    /// 64 lowercase hex characters. Returns the hex portion on success.
    fn validate_hash(hash: &str) -> Result<&str, Box<dyn std::error::Error>> {
        let hex = hash
            .strip_prefix("sha256:")
            .ok_or("hash must start with 'sha256:'")?;
        if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(
                format!("invalid hash format: expected 64 hex chars, got '{}'", hex).into(),
            );
        }
        Ok(hex)
    }

    /// Resolve a validated hash to its filesystem path (two-level fan-out).
    fn blob_path(&self, hash: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
        let hex = Self::validate_hash(hash)?;
        let prefix = &hex[..2];
        Ok(self.root.join(prefix).join(hex))
    }

    /// Store a blob. Returns the hash and whether it already existed.
    /// If it already exists, increments ref_count instead of writing again.
    pub fn store(
        &self,
        data: &[u8],
        content_type: &str,
    ) -> Result<StoreResult, Box<dyn std::error::Error>> {
        let hash = Self::hash_bytes(data);
        let now = chrono::Utc::now().to_rfc3339();

        // Use a transaction to ensure database consistency
        // Note: we don't use a full transaction here because we also interact with the filesystem.
        // Instead, we use the primary key constraint to detect existence.

        let res = self.db.execute(
            "INSERT OR IGNORE INTO blobs (hash, size, content_type, created_at, ref_count) VALUES (?1, ?2, ?3, ?4, 1)",
            params![hash, data.len() as i64, content_type, now],
        )?;

        if res == 0 {
            // Already existed in DB, just increment ref count
            self.db.execute(
                "UPDATE blobs SET ref_count = ref_count + 1 WHERE hash = ?1",
                params![hash],
            )?;
            Ok(StoreResult {
                hash,
                already_existed: true,
            })
        } else {
            // New blob, write to filesystem
            let path = self.blob_path(&hash)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            if let Err(e) = fs::write(&path, data) {
                // Roll back DB insert if filesystem write fails
                self.db
                    .execute("DELETE FROM blobs WHERE hash = ?1", params![hash])?;
                return Err(e.into());
            }

            Ok(StoreResult {
                hash,
                already_existed: false,
            })
        }
    }

    /// Retrieve a blob's data and content type.
    pub fn retrieve(&self, hash: &str) -> Result<(Vec<u8>, String), Box<dyn std::error::Error>> {
        Self::validate_hash(hash)?;
        let content_type: String = self.db.query_row(
            "SELECT content_type FROM blobs WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )?;
        let path = self.blob_path(hash)?;
        let data = fs::read(&path)?;
        Ok((data, content_type))
    }

    /// Validate metadata and acquire an open backing-file handle without reading
    /// bytes. Callers may release the CAS lock before `OpenBlob::read_limited`;
    /// unlinking cannot invalidate an already-open handle.
    pub fn open_limited(&self, hash: &str, limit: usize) -> Result<OpenBlob, RetrieveLimitedError> {
        self.open_limited_with(hash, limit, |path| File::open(path))
    }

    fn open_limited_with(
        &self,
        hash: &str,
        limit: usize,
        open: impl FnOnce(&Path) -> std::io::Result<File>,
    ) -> Result<OpenBlob, RetrieveLimitedError> {
        Self::validate_hash(hash)
            .map_err(|error| RetrieveLimitedError::Store(error.to_string()))?;
        let (stored_size, content_type): (i64, String) = self
            .db
            .query_row(
                "SELECT size, content_type FROM blobs WHERE hash = ?1",
                params![hash],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| RetrieveLimitedError::Store(error.to_string()))?;
        let expected_size = u64::try_from(stored_size).map_err(|_| {
            RetrieveLimitedError::Store(format!(
                "invalid negative CAS size for {hash}: {stored_size}"
            ))
        })?;
        if expected_size > limit as u64 {
            return Err(RetrieveLimitedError::TooLarge {
                size: expected_size,
                limit,
            });
        }
        let path = self
            .blob_path(hash)
            .map_err(|error| RetrieveLimitedError::Store(error.to_string()))?;
        let file = open(&path).map_err(|error| RetrieveLimitedError::Store(error.to_string()))?;
        let file_metadata = file
            .metadata()
            .map_err(|error| RetrieveLimitedError::Store(error.to_string()))?;
        if !file_metadata.is_file() {
            return Err(RetrieveLimitedError::Store(format!(
                "CAS backing path is not a file: {}",
                path.display()
            )));
        }
        if file_metadata.len() != expected_size {
            return Err(RetrieveLimitedError::Store(format!(
                "CAS backing file size mismatch for {hash}: expected {expected_size}, got {}",
                file_metadata.len()
            )));
        }
        Ok(OpenBlob {
            file,
            content_type,
            expected_size,
        })
    }

    pub fn retrieve_limited(
        &self,
        hash: &str,
        limit: usize,
    ) -> Result<(Vec<u8>, String), RetrieveLimitedError> {
        self.open_limited(hash, limit)?.read_limited(limit)
    }

    /// Inspect a blob without reading its contents.
    ///
    /// A row alone is not enough: callers use this for metadata-only HTTP
    /// responses, so a missing, non-file, or length-mismatched backing object is
    /// reported as corruption rather than as an available blob.
    pub fn inspect(&self, hash: &str) -> Result<BlobMetadata, Box<dyn std::error::Error>> {
        Self::validate_hash(hash)?;
        let (stored_size, content_type): (i64, String) = self.db.query_row(
            "SELECT size, content_type FROM blobs WHERE hash = ?1",
            params![hash],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let expected_size = u64::try_from(stored_size)
            .map_err(|_| format!("invalid negative CAS size for {hash}: {stored_size}"))?;
        let path = self.blob_path(hash)?;
        let file = fs::metadata(&path)?;
        if !file.is_file() {
            return Err(format!("CAS backing path is not a file: {}", path.display()).into());
        }
        if file.len() != expected_size {
            return Err(format!(
                "CAS backing file size mismatch for {hash}: expected {expected_size}, got {}",
                file.len()
            )
            .into());
        }
        Ok(BlobMetadata {
            content_type,
            size: expected_size,
        })
    }

    /// Check whether a blob exists in the store.
    pub fn exists(&self, hash: &str) -> Result<bool, Box<dyn std::error::Error>> {
        Self::validate_hash(hash)?;
        let count: i64 = self.db.query_row(
            "SELECT COUNT(*) FROM blobs WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Increment the reference count for a blob.
    pub fn increment_ref(&self, hash: &str) -> Result<(), Box<dyn std::error::Error>> {
        Self::validate_hash(hash)?;
        self.db.execute(
            "UPDATE blobs SET ref_count = ref_count + 1 WHERE hash = ?1",
            params![hash],
        )?;
        Ok(())
    }

    /// Decrement the reference count for a blob.
    pub fn decrement_ref(&self, hash: &str) -> Result<(), Box<dyn std::error::Error>> {
        Self::validate_hash(hash)?;
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
        let mut stmt = self
            .db
            .prepare("SELECT hash FROM blobs WHERE ref_count <= 0 AND created_at < ?1")?;
        let hashes: Vec<String> = stmt
            .query_map(params![cutoff], |row| row.get(0))?
            .collect::<Result<_, _>>()?;

        let mut pruned = 0u32;
        for hash in &hashes {
            let path = self.blob_path(hash)?;
            if path.exists() {
                fs::remove_file(&path)?;
            }
            self.db
                .execute("DELETE FROM blobs WHERE hash = ?1", params![hash])?;
            pruned += 1;
        }
        Ok(pruned)
    }

    /// Return the current ref_count for a blob (for testing).
    #[cfg(test)]
    pub(crate) fn ref_count(&self, hash: &str) -> Result<i64, Box<dyn std::error::Error>> {
        Self::validate_hash(hash)?;
        let count: i64 = self.db.query_row(
            "SELECT ref_count FROM blobs WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// Return summary stats for the store.
    pub fn stats(&self) -> Result<CasStats, Box<dyn std::error::Error>> {
        let blob_count: i64 = self
            .db
            .query_row("SELECT COUNT(*) FROM blobs", [], |row| row.get(0))?;
        let total_size: i64 =
            self.db
                .query_row("SELECT COALESCE(SUM(size), 0) FROM blobs", [], |row| {
                    row.get(0)
                })?;
        Ok(CasStats {
            blob_count: blob_count as u64,
            total_size_bytes: total_size as u64,
        })
    }
}

pub struct CasStats {
    pub blob_count: u64,
    pub total_size_bytes: u64,
}

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

    #[test]
    fn inspect_reports_metadata_without_returning_blob_bytes() {
        let (store, _tmp) = test_store();
        let result = store.store(b"metadata only", "text/html").unwrap();

        let metadata = store.inspect(&result.hash).unwrap();

        assert_eq!(metadata.content_type, "text/html");
        assert_eq!(metadata.size, 13);
    }

    #[test]
    fn inspect_rejects_a_missing_or_invalid_backing_file() {
        let (store, _tmp) = test_store();
        let missing = store.store(b"delete me", "text/html").unwrap();
        fs::remove_file(store.blob_path(&missing.hash).unwrap()).unwrap();
        assert!(
            store.inspect(&missing.hash).is_err(),
            "database metadata must not hide a missing backing file"
        );

        let truncated = store.store(b"truncate me", "text/html").unwrap();
        fs::write(store.blob_path(&truncated.hash).unwrap(), b"short").unwrap();
        assert!(
            store.inspect(&truncated.hash).is_err(),
            "backing-file length must agree with CAS metadata"
        );
    }

    #[test]
    fn retrieve_limited_rejects_known_oversize_before_opening_backing_file() {
        use std::cell::Cell;

        let (store, _tmp) = test_store();
        let result = store.store(b"larger than limit", "text/html").unwrap();
        let opens = Cell::new(0);
        let error = store
            .open_limited_with(&result.hash, 4, |path| {
                opens.set(opens.get() + 1);
                std::fs::File::open(path)
            })
            .unwrap_err();

        assert_eq!(opens.get(), 0, "oversize blob backing file was opened");
        assert!(matches!(
            error,
            RetrieveLimitedError::TooLarge { size: 17, limit: 4 }
        ));
    }

    #[test]
    fn retrieve_limited_accepts_a_blob_exactly_at_the_limit() {
        let (store, _tmp) = test_store();
        let result = store.store(b"exact", "text/html").unwrap();

        let (data, content_type) = store.retrieve_limited(&result.hash, 5).unwrap();

        assert_eq!(data, b"exact");
        assert_eq!(content_type, "text/html");
    }

    #[test]
    fn invalid_hash_returns_error() {
        let (store, _tmp) = test_store();
        // Path traversal attempt
        assert!(store.retrieve("sha256:../../etc/passwd").is_err());
        // Too short
        assert!(store.retrieve("sha256:ab").is_err());
        // Non-hex characters
        assert!(
            store
                .retrieve("sha256:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")
                .is_err()
        );
        // Missing prefix
        assert!(store.retrieve("abcdef").is_err());
        // Valid format but doesn't exist — different error (not found, not validation)
        assert!(
            store
                .retrieve("sha256:0000000000000000000000000000000000000000000000000000000000000000")
                .is_err()
        );
    }

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
        let r = store.store(data, "text/plain").unwrap();
        store.store(data, "text/plain").unwrap();

        let count = store.ref_count(&r.hash).unwrap();
        assert_eq!(count, 2);
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
        let result = store
            .retrieve("sha256:0000000000000000000000000000000000000000000000000000000000000000");
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
}
