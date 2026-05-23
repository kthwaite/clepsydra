use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};

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
