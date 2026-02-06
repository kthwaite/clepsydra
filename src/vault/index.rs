use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use chrono::Utc;
use rusqlite::{Connection, params};
use thiserror::Error;
use uuid::Uuid;
use walkdir::WalkDir;

use super::Vault;
use super::canonical::CanonicalName;
use super::derivation::{Deriver, IndexedPage};
use super::derivers::canonical_names::CanonicalNameDeriver;
use super::derivers::canonical_names::filename_component;
use super::derivers::links::LinkDeriver;
use super::derivers::tags::TagDeriver;
use super::link::{extract_links, extract_property_refs};
use super::page::{parse_frontmatter, write_page_content};
use super::path::VaultPath;

// ---------------------------------------------------------------------------
// IndexError
// ---------------------------------------------------------------------------

#[derive(Debug, Error)]
pub enum IndexError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

// ---------------------------------------------------------------------------
// BuildStats
// ---------------------------------------------------------------------------

/// Statistics returned by [`VaultIndex::build`].
#[derive(Debug, Default)]
pub struct BuildStats {
    pub pages_indexed: usize,
    pub pages_skipped: usize,
    pub pages_removed: usize,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS pages (
    id              TEXT PRIMARY KEY,
    path            TEXT NOT NULL UNIQUE,
    title           TEXT,
    canonical_name  TEXT NOT NULL,
    created_at      TEXT,
    updated_at      TEXT,
    meta_json       TEXT NOT NULL,
    content_hash    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS canonical_names (
    canonical_name  TEXT NOT NULL,
    page_id         TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    source          TEXT NOT NULL,
    PRIMARY KEY (canonical_name, page_id)
);

CREATE TABLE IF NOT EXISTS links (
    source_id       TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    target_raw      TEXT NOT NULL,
    target_canonical TEXT,
    target_id       TEXT REFERENCES pages(id),
    target_path     TEXT,
    kind            TEXT NOT NULL,
    source_field    TEXT,
    span_start      INTEGER NOT NULL,
    span_end        INTEGER NOT NULL,
    PRIMARY KEY (source_id, span_start)
);

CREATE TABLE IF NOT EXISTS tags (
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (page_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_pages_path ON pages(path);
CREATE INDEX IF NOT EXISTS idx_pages_canonical_name ON pages(canonical_name);
CREATE INDEX IF NOT EXISTS idx_canonical_names_name ON canonical_names(canonical_name);
CREATE INDEX IF NOT EXISTS idx_links_target_id ON links(target_id);
CREATE INDEX IF NOT EXISTS idx_links_target_path ON links(target_path);
CREATE INDEX IF NOT EXISTS idx_links_target_canonical ON links(target_canonical);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
"#;

// ---------------------------------------------------------------------------
// VaultIndex
// ---------------------------------------------------------------------------

/// An SQLite-backed index of vault pages, links, and canonical names.
pub struct VaultIndex {
    conn: Connection,
    derivers: Vec<Box<dyn Deriver>>,
}

impl VaultIndex {
    /// Open (or create) the index database at `db_path`.
    ///
    /// Creates parent directories if needed, sets WAL journal mode and enables
    /// foreign keys, then ensures the schema tables and indexes exist.
    pub fn open(db_path: &Path) -> Result<Self, IndexError> {
        // 1. Create parent directory if needed
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)?;
        }

        // 2. Open SQLite connection
        let conn = Connection::open(db_path)?;

        // 3. Pragmas
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

        // 4. Execute schema
        conn.execute_batch(SCHEMA)?;

        Ok(Self {
            conn,
            derivers: vec![
                Box::new(CanonicalNameDeriver),
                Box::new(LinkDeriver),
                Box::new(TagDeriver),
            ],
        })
    }

    /// Open the index database with NO derivers registered.
    ///
    /// Useful for testing or for callers who want to register a custom set
    /// of derivers via [`register_deriver`].
    pub fn open_bare(db_path: &Path) -> Result<Self, IndexError> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        conn.execute_batch(SCHEMA)?;

        Ok(Self {
            conn,
            derivers: Vec::new(),
        })
    }

    /// Borrow the underlying connection (primarily for test inspection).
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Register an additional deriver to run during index builds.
    pub fn register_deriver(&mut self, deriver: Box<dyn Deriver>) {
        self.derivers.push(deriver);
    }

    /// Build (or incrementally update) the index from vault contents.
    ///
    /// Uses a two-pass approach:
    /// 1. Walk the vault, parse all changed files into `ParsedFile` structs.
    /// 2. Detect duplicate UUIDs and resolve them (older `created_at` keeps the
    ///    UUID; the other file gets a new v7 UUID written back to disk).
    /// 3. Upsert all parsed files into the database.
    ///
    /// Pages removed from disk are pruned from the database.
    pub fn build(&mut self, vault: &Vault) -> Result<BuildStats, IndexError> {
        let mut stats = BuildStats::default();
        let mut seen_paths: HashSet<String> = HashSet::new();

        let linkable_properties = &vault.config().vault.linkable_properties;

        // -----------------------------------------------------------------
        // Pass 1: Walk vault, parse files, collect into Vec<ParsedFile>
        // -----------------------------------------------------------------

        let mut parsed_files: Vec<IndexedPage> = Vec::new();

        let tx = self.conn.transaction()?;

        for entry in WalkDir::new(vault.root())
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
        {
            let abs_path = entry.path();
            let rel_path = match abs_path.strip_prefix(vault.root()) {
                Ok(p) => p,
                Err(_) => continue,
            };

            let rel_str = rel_path.to_string_lossy().replace('\\', "/");

            // Build VaultPath
            let vault_path = match VaultPath::new(&rel_str) {
                Ok(vp) => vp,
                Err(e) => {
                    stats.warnings.push(format!("skipping {rel_str}: {e}"));
                    continue;
                }
            };

            // Skip if excluded
            if vault.is_excluded(&vault_path) {
                continue;
            }

            seen_paths.insert(vault_path.as_str().to_string());

            // Read content, compute blake3 hash
            let content = match fs::read_to_string(abs_path) {
                Ok(c) => c,
                Err(e) => {
                    stats.warnings.push(format!("cannot read {rel_str}: {e}"));
                    continue;
                }
            };
            let content_hash = blake3::hash(content.as_bytes()).to_hex().to_string();

            // Check if hash matches DB -> skip if unchanged
            let existing_hash: Option<String> = tx
                .query_row(
                    "SELECT content_hash FROM pages WHERE path = ?1",
                    params![vault_path.as_str()],
                    |row| row.get(0),
                )
                .ok();

            if existing_hash.as_deref() == Some(&content_hash) {
                stats.pages_skipped += 1;
                continue;
            }

            // Parse frontmatter -> get PageMeta + body
            let (meta, body) = match parse_frontmatter(&content) {
                Ok((m, b)) => (m, b),
                Err(e) => {
                    stats
                        .warnings
                        .push(format!("frontmatter error in {rel_str}: {e}"));
                    continue;
                }
            };

            // Derive CanonicalName
            let canonical = if let Some(ref title) = meta.title {
                CanonicalName::from_title(title)
            } else {
                CanonicalName::from_filename(filename_component(&vault_path))
            };

            // Extract body links
            let body_links = extract_links(&body);

            // Extract property ref links for configured linkable_properties
            let mut prop_links = Vec::new();
            for prop in linkable_properties {
                let values: Vec<String> = match prop.as_str() {
                    "tags" => meta.tags.clone(),
                    "aliases" => meta.aliases.clone(),
                    _ => {
                        // Look in meta.extra
                        if let Some(val) = meta.extra.get(prop) {
                            yaml_value_to_strings(val)
                        } else {
                            Vec::new()
                        }
                    }
                };
                if !values.is_empty() {
                    prop_links.extend(extract_property_refs(prop, &values));
                }
            }

            parsed_files.push(IndexedPage {
                vault_path,
                abs_path: abs_path.to_path_buf(),
                meta,
                body,
                content_hash,
                body_links,
                prop_links,
                canonical,
            });
        }

        // -----------------------------------------------------------------
        // Between passes: Detect and resolve duplicate UUIDs
        // -----------------------------------------------------------------

        // Group parsed files by UUID
        let mut uuid_groups: HashMap<Uuid, Vec<usize>> = HashMap::new();
        for (idx, pf) in parsed_files.iter().enumerate() {
            uuid_groups.entry(pf.meta.id).or_default().push(idx);
        }

        for indices in uuid_groups.values() {
            if indices.len() < 2 {
                continue;
            }

            // Sort indices by created_at (older first), falling back to
            // filesystem mtime for files without created_at.
            let mut sorted = indices.clone();
            sorted.sort_by(|&a, &b| {
                let ts_a = parsed_files[a].meta.created_at.or_else(|| {
                    fs::metadata(&parsed_files[a].abs_path)
                        .and_then(|m| m.modified())
                        .ok()
                        .map(chrono::DateTime::<Utc>::from)
                });
                let ts_b = parsed_files[b].meta.created_at.or_else(|| {
                    fs::metadata(&parsed_files[b].abs_path)
                        .and_then(|m| m.modified())
                        .ok()
                        .map(chrono::DateTime::<Utc>::from)
                });
                ts_a.cmp(&ts_b)
            });

            let winner_path = parsed_files[sorted[0]].vault_path.as_str().to_string();
            let original_uuid = parsed_files[sorted[0]].meta.id;

            // The first entry (oldest) keeps the UUID; all others get new UUIDs.
            for &loser_idx in &sorted[1..] {
                let new_uuid = Uuid::now_v7();
                let loser = &mut parsed_files[loser_idx];
                let loser_path = loser.vault_path.as_str().to_string();

                stats.warnings.push(format!(
                    "duplicate UUID {original_uuid}: \"{loser_path}\" reassigned to {new_uuid} \
                     (kept by \"{winner_path}\")"
                ));

                // Update the in-memory meta with the new UUID
                loser.meta.id = new_uuid;

                // Write the updated frontmatter back to disk
                let new_content = write_page_content(&loser.meta, &loser.body);
                fs::write(&loser.abs_path, &new_content)?;

                // Recompute content hash after rewrite
                loser.content_hash = blake3::hash(new_content.as_bytes()).to_hex().to_string();
            }
        }

        // -----------------------------------------------------------------
        // Pass 2: Upsert all parsed files into the database
        // -----------------------------------------------------------------

        for pf in &parsed_files {
            let meta_json = serde_json::to_string(&pf.meta).unwrap_or_else(|_| "{}".to_string());

            let page_id = pf.meta.id.to_string();
            let created_at = pf.meta.created_at.map(|dt| dt.to_rfc3339());
            let updated_at = pf.meta.updated_at.map(|dt| dt.to_rfc3339());

            // Upsert into pages table
            tx.execute(
                "INSERT INTO pages (id, path, title, canonical_name, created_at, updated_at, meta_json, content_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                   path = excluded.path,
                   title = excluded.title,
                   canonical_name = excluded.canonical_name,
                   created_at = excluded.created_at,
                   updated_at = excluded.updated_at,
                   meta_json = excluded.meta_json,
                   content_hash = excluded.content_hash",
                params![
                    page_id,
                    pf.vault_path.as_str(),
                    pf.meta.title,
                    pf.canonical.as_str(),
                    created_at,
                    updated_at,
                    meta_json,
                    pf.content_hash,
                ],
            )?;

            // Clear old links/tags/canonical_names for this page
            tx.execute("DELETE FROM links WHERE source_id = ?1", params![page_id])?;
            tx.execute("DELETE FROM tags WHERE page_id = ?1", params![page_id])?;
            tx.execute(
                "DELETE FROM canonical_names WHERE page_id = ?1",
                params![page_id],
            )?;

            // Dispatch to derivers
            for deriver in &self.derivers {
                deriver.derive(pf, &page_id, &tx)?;
            }

            stats.pages_indexed += 1;
        }

        // Remove pages from DB that are no longer on disk
        let mut stmt = tx.prepare("SELECT id, path FROM pages")?;
        let stale: Vec<String> = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .filter_map(|r| r.ok())
            .filter(|(_, path)| !seen_paths.contains(path))
            .map(|(id, _)| id)
            .collect();
        drop(stmt);

        for id in &stale {
            tx.execute("DELETE FROM pages WHERE id = ?1", params![id])?;
            stats.pages_removed += 1;
        }

        tx.commit()?;
        Ok(stats)
    }

    /// Resolve unresolved links by matching `target_canonical` against the
    /// `canonical_names` table.
    ///
    /// A link is resolved only when exactly one page matches the canonical
    /// name. Ambiguous matches (2+ pages) are left unresolved to avoid silent
    /// first-match behavior.
    pub fn resolve_links(&mut self) -> Result<(), IndexError> {
        let tx = self.conn.transaction()?;

        // Collect unresolved links
        let mut stmt = tx.prepare(
            "SELECT source_id, span_start, target_canonical
             FROM links
             WHERE target_id IS NULL AND target_canonical IS NOT NULL",
        )?;

        let unresolved: Vec<(String, i64, String)> = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);

        for (source_id, span_start, target_canonical) in &unresolved {
            // Look up target_canonical in canonical_names table
            let mut lookup = tx.prepare(
                "SELECT cn.page_id, p.path
                 FROM canonical_names cn
                 JOIN pages p ON p.id = cn.page_id
                 WHERE cn.canonical_name = ?1",
            )?;

            let matches: Vec<(String, String)> = lookup
                .query_map(params![target_canonical], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .filter_map(|r| r.ok())
                .collect();
            drop(lookup);

            if matches.len() == 1 {
                let (target_id, target_path) = &matches[0];
                tx.execute(
                    "UPDATE links SET target_id = ?1, target_path = ?2
                     WHERE source_id = ?3 AND span_start = ?4",
                    params![target_id, target_path, source_id, span_start],
                )?;
            }
            // 0 or 2+ matches: leave unresolved
        }

        tx.commit()?;
        Ok(())
    }
}

/// Extract string values from a serde_yaml::Value (handles both scalar strings
/// and sequences of strings).
fn yaml_value_to_strings(val: &serde_yaml::Value) -> Vec<String> {
    match val {
        serde_yaml::Value::String(s) => vec![s.clone()],
        serde_yaml::Value::Sequence(seq) => seq
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        _ => Vec::new(),
    }
}
