use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use thiserror::Error;
use uuid::Uuid;
use walkdir::WalkDir;

use super::Vault;
use super::canonical::CanonicalName;
use super::config::DisambiguationStrategy;
use super::context::extract_context;
use super::derivation::{Deriver, IndexedPage};
use super::derivers::blocks::BlockDeriver;
use super::derivers::canonical_names::CanonicalNameDeriver;
use super::derivers::cite_key::CiteKeyDeriver;
use super::derivers::links::LinkDeriver;
use super::derivers::properties::PropertyDeriver;
use super::derivers::tags::TagDeriver;
use super::link::{Link, extract_links, extract_property_refs};
use super::page::{PageMeta, parse_or_repair_frontmatter, write_page_content};
use super::path::VaultPath;
use super::reference_issues::{ReferenceIssueFilter, ReferenceIssuePage};
use super::rubbish::{RubbishListEntry, RubbishManifest, RubbishStore};

// ---------------------------------------------------------------------------
// IndexError
// ---------------------------------------------------------------------------

#[derive(Debug, Error)]
pub enum IndexError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}

fn fts_prefix_query(input: &str) -> Option<String> {
    let mut query = String::new();
    for term in input
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|term| !term.is_empty())
    {
        if !query.is_empty() {
            query.push_str(" AND ");
        }
        query.push('"');
        query.push_str(term);
        query.push_str("\"*");
    }
    (!query.is_empty()).then_some(query)
}

// ---------------------------------------------------------------------------
// UnresolvedReason / LinkCandidate / UnresolvedLinkDetail
// ---------------------------------------------------------------------------

/// Reason a link is unresolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnresolvedReason {
    /// No canonical name matched.
    NoMatch,
    /// Two or more pages share the canonical name.
    Ambiguous,
}

/// A candidate page for an ambiguous link.
#[derive(Debug, Clone)]
pub struct LinkCandidate {
    pub page_id: String,
    pub path: String,
    pub title: Option<String>,
}

/// An unresolved link with diagnostic info.
#[derive(Debug, Clone)]
pub struct UnresolvedLinkDetail {
    pub source_id: String,
    pub source_path: String,
    pub target_raw: String,
    pub target_canonical: Option<String>,
    pub kind: String,
    pub span_start: i64,
    pub reason: UnresolvedReason,
    pub candidates: Vec<LinkCandidate>,
}

/// A backlink entry with surrounding text context.
#[derive(Debug, Clone)]
pub struct BacklinkWithContext {
    pub source_id: String,
    pub source_path: String,
    pub source_title: Option<String>,
    pub target_raw: String,
    pub kind: String,
    pub context: String,
    /// Body byte offset where the link span starts (-1 for property refs).
    pub span_start: i64,
    /// Body byte offset where the link span ends.
    pub span_end: i64,
}

/// A similar-page result ranked by tag Jaccard similarity.
#[derive(Debug, Clone)]
pub struct SimilarRow {
    pub path: String,
    pub title: Option<String>,
    pub shared_tags: Vec<String>,
    pub score: f64,
}

/// A single full-text search result.
#[derive(Debug)]
pub struct SearchResult {
    pub page_id: String,
    pub path: String,
    pub title: Option<String>,
    pub snippet: String,
    pub rank: f64,
}

/// Lifecycle location that currently reserves a captured-archive URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchiveUrlOwner {
    Active {
        page_id: String,
        path: String,
        source_hash: String,
    },
    Rubbish {
        item_id: String,
        page_id: String,
        original_path: String,
    },
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

const TAG_DERIVATION_VERSION: &str = "1";

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS pages (
    id              TEXT PRIMARY KEY,
    path            TEXT NOT NULL UNIQUE,
    title           TEXT,
    canonical_name  TEXT NOT NULL,
    created_at      TEXT,
    updated_at      TEXT,
    meta_json       TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    journal_date    TEXT,
    kind            TEXT NOT NULL DEFAULT 'NOTE',
    kind_inferred   INTEGER NOT NULL DEFAULT 1,
    project         TEXT,
    encrypted       INTEGER NOT NULL DEFAULT 0,
    word_count      INTEGER
);

CREATE TABLE IF NOT EXISTS rubbish_items (
    item_id         TEXT PRIMARY KEY,
    page_id         TEXT,
    original_path   TEXT,
    title           TEXT,
    kind            TEXT,
    deleted_at      TEXT,
    archive_url     TEXT,
    valid           INTEGER NOT NULL CHECK (valid IN (0, 1)),
    diagnostic      TEXT,
    CHECK (
        (valid = 1
            AND page_id IS NOT NULL
            AND original_path IS NOT NULL
            AND title IS NOT NULL
            AND kind IS NOT NULL
            AND deleted_at IS NOT NULL
            AND diagnostic IS NULL)
        OR
        (valid = 0
            AND page_id IS NULL
            AND original_path IS NULL
            AND title IS NULL
            AND kind IS NULL
            AND deleted_at IS NULL
            AND archive_url IS NULL
            AND diagnostic IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_rubbish_items_archive_url
ON rubbish_items(archive_url) WHERE valid = 1 AND archive_url IS NOT NULL;

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
    target_id       TEXT REFERENCES pages(id) ON DELETE SET NULL,
    target_path     TEXT,
    target_block_id TEXT,
    kind            TEXT NOT NULL,
    source_field    TEXT,
    span_start      INTEGER NOT NULL,
    span_end        INTEGER NOT NULL,
    PRIMARY KEY (source_id, span_start)
);

CREATE TABLE IF NOT EXISTS tags (
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    computed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (page_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_pages_journal_date ON pages(journal_date) WHERE journal_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pages_kind ON pages(kind);
CREATE INDEX IF NOT EXISTS idx_pages_project ON pages(project) WHERE project IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pages_path ON pages(path);
CREATE INDEX IF NOT EXISTS idx_pages_canonical_name ON pages(canonical_name);
CREATE INDEX IF NOT EXISTS idx_canonical_names_name ON canonical_names(canonical_name);
CREATE INDEX IF NOT EXISTS idx_links_target_id ON links(target_id);
CREATE INDEX IF NOT EXISTS idx_links_target_path ON links(target_path);
CREATE INDEX IF NOT EXISTS idx_links_target_canonical ON links(target_canonical);
CREATE INDEX IF NOT EXISTS idx_links_target_block_id ON links(target_block_id) WHERE target_block_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

CREATE TABLE IF NOT EXISTS blocks (
    block_id    TEXT,
    page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    block_type  TEXT NOT NULL,
    parent_id   TEXT,
    order_index INTEGER NOT NULL,
    content     TEXT NOT NULL,
    depth       INTEGER NOT NULL,
    span_start  INTEGER NOT NULL,
    span_end    INTEGER NOT NULL,
    PRIMARY KEY (page_id, span_start)
);

CREATE INDEX IF NOT EXISTS idx_blocks_block_id ON blocks(block_id) WHERE block_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_page_id ON blocks(page_id);

CREATE TABLE IF NOT EXISTS block_properties (
    page_id     TEXT NOT NULL,
    span_start  INTEGER NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    FOREIGN KEY (page_id, span_start) REFERENCES blocks(page_id, span_start) ON DELETE CASCADE,
    PRIMARY KEY (page_id, span_start, key)
);

CREATE INDEX IF NOT EXISTS idx_block_props_key_value ON block_properties(key, value);

CREATE TABLE IF NOT EXISTS code_counters (
    family      TEXT PRIMARY KEY,
    next_value  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS derivation_meta (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_properties (
    page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    ord         INTEGER NOT NULL DEFAULT 0,
    value_json  TEXT NOT NULL,
    value_text  TEXT,
    value_num   REAL,
    value_date  TEXT,
    value_bool  INTEGER,
    PRIMARY KEY (page_id, key, ord)
);

CREATE INDEX IF NOT EXISTS idx_page_props_key_text ON page_properties(key, value_text);
CREATE INDEX IF NOT EXISTS idx_page_props_key_num  ON page_properties(key, value_num);
CREATE INDEX IF NOT EXISTS idx_page_props_key_date ON page_properties(key, value_date);

CREATE TABLE IF NOT EXISTS page_bodies (
    page_id     TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    body        TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    page_id UNINDEXED,
    path UNINDEXED,
    title,
    body,
    tokenize='porter unicode61'
);
"#;

/// Atomically reserve the next code number for `family`.
///
/// The first reservation starts after `observed_max`; later reservations use
/// the persisted counter even if the caller observes a different maximum.
pub fn reserve_code_number(
    conn: &mut Connection,
    family: &str,
    observed_max: u32,
) -> rusqlite::Result<u32> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute(
        "INSERT INTO code_counters (family, next_value) VALUES (?1, ?2)
         ON CONFLICT(family) DO NOTHING",
        params![family, i64::from(observed_max) + 1],
    )?;

    let reserved: i64 = tx.query_row(
        "SELECT next_value FROM code_counters WHERE family = ?1",
        params![family],
        |row| row.get(0),
    )?;
    let reserved = u32::try_from(reserved)
        .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, reserved))?;

    tx.execute(
        "UPDATE code_counters SET next_value = next_value + 1 WHERE family = ?1",
        params![family],
    )?;
    tx.commit()?;
    Ok(reserved)
}

const RUBBISH_UPSERT: &str = "
    INSERT INTO rubbish_items
        (item_id, page_id, original_path, title, kind, deleted_at,
         archive_url, valid, diagnostic)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(item_id) DO UPDATE SET
        page_id = excluded.page_id,
        original_path = excluded.original_path,
        title = excluded.title,
        kind = excluded.kind,
        deleted_at = excluded.deleted_at,
        archive_url = excluded.archive_url,
        valid = excluded.valid,
        diagnostic = excluded.diagnostic";

fn upsert_rubbish_entry_in(conn: &Connection, entry: &RubbishListEntry) -> rusqlite::Result<()> {
    match entry {
        RubbishListEntry::Valid(manifest) => {
            let item_id = manifest.item_id.to_string();
            let page_id = manifest.page_id.to_string();
            let deleted_at = manifest
                .deleted_at
                .to_rfc3339_opts(SecondsFormat::Nanos, true);
            conn.execute(
                RUBBISH_UPSERT,
                params![
                    item_id,
                    page_id,
                    manifest.original_path,
                    manifest.title,
                    manifest.kind,
                    deleted_at,
                    manifest.archive_url,
                    1_i64,
                    Option::<String>::None,
                ],
            )?;
        }
        RubbishListEntry::Invalid { item_id, error } => {
            conn.execute(
                RUBBISH_UPSERT,
                params![
                    item_id,
                    Option::<String>::None,
                    Option::<String>::None,
                    Option::<String>::None,
                    Option::<String>::None,
                    Option::<String>::None,
                    Option::<String>::None,
                    0_i64,
                    error,
                ],
            )?;
        }
    }
    Ok(())
}

fn rubbish_entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RubbishListEntry> {
    use rusqlite::types::Type;

    let item_id: String = row.get(0)?;
    let valid: i64 = row.get(7)?;
    if valid == 0 {
        return Ok(RubbishListEntry::Invalid {
            item_id,
            error: row.get(8)?,
        });
    }
    if valid != 1 {
        return Err(rusqlite::Error::FromSqlConversionFailure(
            7,
            Type::Integer,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("invalid rubbish catalog validity flag {valid}"),
            )),
        ));
    }

    let parsed_item_id = Uuid::parse_str(&item_id).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, Type::Text, Box::new(error))
    })?;
    let page_id_raw: String = row.get(1)?;
    let page_id = Uuid::parse_str(&page_id_raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(1, Type::Text, Box::new(error))
    })?;
    let deleted_at_raw: String = row.get(5)?;
    let deleted_at = chrono::DateTime::parse_from_rfc3339(&deleted_at_raw)
        .map_err(|error| rusqlite::Error::FromSqlConversionFailure(5, Type::Text, Box::new(error)))?
        .with_timezone(&Utc);
    let manifest = RubbishManifest::new(
        parsed_item_id,
        page_id,
        &row.get::<_, String>(2)?,
        row.get::<_, String>(3)?,
        row.get::<_, String>(4)?,
        deleted_at,
        row.get(6)?,
    )
    .map_err(|error| rusqlite::Error::FromSqlConversionFailure(2, Type::Text, Box::new(error)))?;
    Ok(RubbishListEntry::Valid(manifest))
}

// ---------------------------------------------------------------------------
// VaultIndex
// ---------------------------------------------------------------------------

/// An SQLite-backed index of vault pages, links, and canonical names.
pub struct VaultIndex {
    conn: Connection,
    derivers: Vec<Box<dyn Deriver>>,
    /// Whether indexing may persist repaired frontmatter back to the vault.
    ///
    /// `true` for the on-disk index used by `clep serve` and the CLI: a page
    /// with missing fences, a missing `id`, or missing timestamps is healed on
    /// disk as it is indexed. `false` for the in-memory index used by the
    /// standalone LSP process, which must never write vault files (ADR 0001) —
    /// there the repaired metadata is still indexed, only the disk write is
    /// skipped, leaving the file byte-identical.
    repair_frontmatter: bool,
}

impl VaultIndex {
    /// Set up the pragmas, schema, and migrations for a SQLite connection.
    ///
    /// This is the shared post-connection initialization used by all constructors.
    fn setup_connection(conn: &Connection) -> Result<(), IndexError> {
        // 1. Pragmas
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;",
        )?;

        // 2. Run pre-schema migrations (column additions required before index creation)
        migrate_links_add_target_block_id(conn)?;
        migrate_pages_add_projection_columns(conn)?;
        migrate_tags_add_computed(conn)?;
        migrate_page_bodies_projection(conn)?;

        // 3. Execute schema
        conn.execute_batch(SCHEMA)?;

        // 4. Migration: ensure links.target_id has ON DELETE SET NULL
        migrate_links_fk(conn)?;

        Ok(())
    }

    /// Initialize an index from a ready SQLite connection with all derivers.
    ///
    /// Used internally by constructors that need a fully-setup connection.
    fn from_connection(conn: Connection) -> Result<Self, IndexError> {
        Self::setup_connection(&conn)?;

        Ok(Self {
            conn,
            derivers: vec![
                Box::new(CanonicalNameDeriver),
                Box::new(CiteKeyDeriver),
                Box::new(LinkDeriver),
                Box::new(TagDeriver),
                Box::new(PropertyDeriver),
                Box::new(BlockDeriver),
            ],
            repair_frontmatter: true,
        })
    }

    /// Open (or create) the index database at `db_path`.
    ///
    /// Creates parent directories if needed, sets WAL journal mode and enables
    /// foreign keys, then ensures the schema tables and indexes exist.
    pub fn open(db_path: &Path) -> Result<Self, IndexError> {
        // 1. Create parent directory if needed
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)?;
        }

        // 2. Open SQLite connection and initialize
        let conn = Connection::open(db_path)?;
        Self::from_connection(conn)
    }

    /// Open the index database with NO derivers registered.
    ///
    /// Useful for testing or for callers who want to register a custom set
    /// of derivers via [`Self::register_deriver`].
    pub fn open_bare(db_path: &Path) -> Result<Self, IndexError> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        Self::setup_connection(&conn)?;

        Ok(Self {
            conn,
            derivers: Vec::new(),
            repair_frontmatter: true,
        })
    }

    /// Open an index backed by an in-memory SQLite database. Used by the
    /// standalone LSP process, which must never write inside the vault: the
    /// index is not merely off-vault, it also indexes read-only — repaired
    /// frontmatter stays in memory instead of being written back to the page.
    pub fn open_in_memory() -> Result<Self, IndexError> {
        let conn = Connection::open_in_memory()?;
        let mut index = Self::from_connection(conn)?;
        index.repair_frontmatter = false;
        Ok(index)
    }

    /// Borrow the underlying connection (primarily for test inspection).
    pub fn connection(&self) -> &Connection {
        &self.conn
    }
    /// Project the current index truth into typed, deterministic repair issues.
    pub fn reference_issues(
        &self,
        filter: ReferenceIssueFilter,
    ) -> Result<ReferenceIssuePage, IndexError> {
        super::reference_issues::project(&self.conn, filter)
    }

    /// Mutably borrow the underlying connection for internal transactional work.
    pub(crate) fn connection_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    /// Insert or replace one rebuildable rubbish catalog row.
    pub fn upsert_rubbish_entry(&self, entry: &RubbishListEntry) -> Result<(), IndexError> {
        upsert_rubbish_entry_in(&self.conn, entry)?;
        Ok(())
    }

    /// Remove one rubbish catalog row, returning whether it existed.
    pub fn remove_rubbish_entry(&self, item_id: &str) -> Result<bool, IndexError> {
        Ok(self.conn.execute(
            "DELETE FROM rubbish_items WHERE item_id = ?1",
            params![item_id],
        )? != 0)
    }

    /// Atomically read and remove one lifecycle identity from the rebuildable
    /// rubbish catalog. The returned row records prior cache state; the
    /// authoritative store controls reconciliation after removal errors.
    pub fn take_rubbish_entry(
        &mut self,
        item_id: Uuid,
    ) -> Result<Option<RubbishListEntry>, IndexError> {
        let transaction = self.conn.transaction()?;
        let item_id = item_id.to_string();
        let entry = transaction
            .query_row(
                "SELECT item_id, page_id, original_path, title, kind, deleted_at,
                        archive_url, valid, diagnostic
                 FROM rubbish_items
                 WHERE item_id = ?1",
                params![&item_id],
                rubbish_entry_from_row,
            )
            .optional()?;
        transaction.execute(
            "DELETE FROM rubbish_items WHERE item_id = ?1",
            params![&item_id],
        )?;
        transaction.commit()?;
        Ok(entry)
    }

    /// List catalog rows deterministically: valid newest-first, then invalid
    /// identities in ascending order.
    pub fn rubbish_entries(&self) -> Result<Vec<RubbishListEntry>, IndexError> {
        let mut statement = self.conn.prepare(
            "SELECT item_id, page_id, original_path, title, kind, deleted_at,
                    archive_url, valid, diagnostic
             FROM rubbish_items
             ORDER BY valid DESC, deleted_at DESC, item_id ASC",
        )?;
        let entries = statement
            .query_map([], rubbish_entry_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(entries)
    }

    /// Read one rubbish catalog row by its opaque item identity.
    pub fn rubbish_entry(&self, item_id: &str) -> Result<Option<RubbishListEntry>, IndexError> {
        Ok(self
            .conn
            .query_row(
                "SELECT item_id, page_id, original_path, title, kind, deleted_at,
                        archive_url, valid, diagnostic
                 FROM rubbish_items
                 WHERE item_id = ?1",
                params![item_id],
                rubbish_entry_from_row,
            )
            .optional()?)
    }

    /// Replace the rebuildable catalog with the store's authoritative,
    /// validated manifest enumeration.
    pub fn reconcile_rubbish_catalog(&mut self, store: &RubbishStore) -> Result<(), IndexError> {
        let entries = store.list_entries().map_err(|source| {
            IndexError::Other(format!("failed to enumerate rubbish catalog: {source}"))
        })?;
        let transaction = self.conn.transaction()?;
        transaction.execute("DELETE FROM rubbish_items", [])?;
        for entry in &entries {
            upsert_rubbish_entry_in(&transaction, entry)?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn begin_created_mutation(&mut self) -> Result<(), IndexError> {
        self.conn.execute_batch("SAVEPOINT created_page_mutation")?;
        Ok(())
    }

    pub(crate) fn commit_created_mutation(&mut self) -> Result<(), IndexError> {
        self.conn
            .execute_batch("RELEASE SAVEPOINT created_page_mutation")?;
        Ok(())
    }

    pub(crate) fn rollback_created_mutation(&mut self) -> Result<(), IndexError> {
        self.conn.execute_batch(
            "ROLLBACK TO SAVEPOINT created_page_mutation;
             RELEASE SAVEPOINT created_page_mutation;",
        )?;
        Ok(())
    }

    /// Remove deleted content from SQLite pages and truncate the WAL.
    ///
    /// Call this after replacing plaintext projections with encrypted-page
    /// projections so prior content is not recoverable from cache artifacts.
    pub fn scrub_deleted_content(&mut self) -> Result<(), IndexError> {
        self.conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        self.conn.execute_batch("VACUUM;")?;
        Ok(())
    }

    /// Register an additional deriver to run during index builds.
    pub fn register_deriver(&mut self, deriver: Box<dyn Deriver>) {
        self.derivers.push(deriver);
    }

    /// Build (or incrementally update) the index from vault contents.
    ///
    /// Uses a two-pass approach:
    /// 1. Walk the vault, parse all changed files into [`IndexedPage`] structs.
    /// 2. Detect duplicate UUIDs and resolve them (older `created_at` keeps the
    ///    UUID; the other file gets a new v7 UUID written back to disk).
    /// 3. Upsert all parsed files into the database.
    ///
    /// Pages removed from disk are pruned from the database.
    pub fn build(&mut self, vault: &Vault) -> Result<BuildStats, IndexError> {
        let mut stats = BuildStats::default();

        // The base registry loads BEFORE page indexing: relation-typed
        // properties join the effective linkable set, and a change to that
        // set (the linkable epoch) disables skip-unchanged for this build so
        // untouched pages get their frontmatter links re-derived.
        let registry = crate::vault::base::BaseRegistry::load(vault.root());
        let linkable_properties = crate::vault::base::effective_linkable_properties(
            &vault.config().vault.linkable_properties,
            &registry,
        );
        let epoch = crate::vault::base::linkable_epoch(&linkable_properties);

        let tx = self.conn.transaction()?;
        let stored_epoch: Option<String> = tx
            .query_row(
                "SELECT value FROM derivation_meta WHERE key = 'linkable_epoch'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let stored_tag_derivation_version: Option<String> = tx
            .query_row(
                "SELECT value FROM derivation_meta WHERE key = 'tag_derivation_version'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let force_rederive = stored_epoch.as_deref() != Some(epoch.as_str())
            || stored_tag_derivation_version.as_deref() != Some(TAG_DERIVATION_VERSION);
        let repair_frontmatter = self.repair_frontmatter;
        let (mut parsed_files, seen_paths) = collect_indexed_pages(
            vault,
            &tx,
            &linkable_properties,
            force_rederive,
            repair_frontmatter,
            &mut stats,
        )?;
        resolve_duplicate_uuids(&mut parsed_files, repair_frontmatter, &mut stats)?;
        for pf in &parsed_files {
            upsert_indexed_page(pf, &tx, &self.derivers, &mut stats)?;
        }
        prune_stale_pages(&tx, &seen_paths, &mut stats)?;
        tx.execute(
            "INSERT INTO derivation_meta (key, value) VALUES ('linkable_epoch', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![epoch],
        )?;
        tx.execute(
            "INSERT INTO derivation_meta (key, value) VALUES ('tag_derivation_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![TAG_DERIVATION_VERSION],
        )?;
        tx.commit()?;
        super::reconcile::reconcile_rubbish_catalog(vault, self)?;
        Ok(stats)
    }

    /// Resolve one canonical link target with the same uniqueness rule used
    /// when populating `links.target_id`.
    pub(crate) fn resolve_link_target_id(
        &self,
        target_canonical: &str,
    ) -> Result<Option<String>, IndexError> {
        Ok(
            unique_link_target(self.connection(), target_canonical)?
                .map(|(target_id, _)| target_id),
        )
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
            if let Some((target_id, target_path)) = unique_link_target(&tx, target_canonical)? {
                tx.execute(
                    "UPDATE links SET target_id = ?1, target_path = ?2
                     WHERE source_id = ?3 AND span_start = ?4",
                    params![target_id, target_path, source_id, span_start],
                )?;
            }
            // 0 or 2+ matches: leave unresolved
        }

        // Phase 2: Resolve block_ref links by matching target_block_id against blocks table
        let mut block_ref_stmt = tx.prepare(
            "SELECT source_id, span_start, target_block_id
             FROM links
             WHERE target_id IS NULL AND kind = 'block_ref' AND target_block_id IS NOT NULL",
        )?;

        let unresolved_block_refs: Vec<(String, i64, String)> = block_ref_stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
        drop(block_ref_stmt);

        for (source_id, span_start, block_id) in &unresolved_block_refs {
            let mut lookup = tx.prepare(
                "SELECT b.page_id, p.path
                 FROM blocks b
                 JOIN pages p ON p.id = b.page_id
                 WHERE b.block_id = ?1",
            )?;

            let matches: Vec<(String, String)> = lookup
                .query_map(params![block_id], |row| {
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

    // ------------------------------------------------------------------
    // Granular index primitives (incremental sync engine)
    // ------------------------------------------------------------------

    /// Index (or re-index) a single page from the vault.
    ///
    /// Reads the file at `vault_path`, parses frontmatter, extracts links,
    /// and upserts into the database. Returns `true` if the page was indexed,
    /// `false` if skipped (content unchanged).
    ///
    /// This does NOT resolve links — call [`resolve_links`] or
    /// [`resolve_links_for_page`] after indexing.
    pub fn index_page(
        &mut self,
        vault: &Vault,
        vault_path: &VaultPath,
    ) -> Result<bool, IndexError> {
        let abs_path = vault.resolve(vault_path);
        // Single-page path: compose the effective linkable set from the
        // current registry so relation-typed frontmatter links derive here
        // too. Epoch bookkeeping stays in `build` — a set change forces the
        // full re-derive there.
        let registry = crate::vault::base::BaseRegistry::load(vault.root());
        let linkable_properties = &crate::vault::base::effective_linkable_properties(
            &vault.config().vault.linkable_properties,
            &registry,
        );

        let mut content = std::fs::read_to_string(&abs_path).map_err(IndexError::Io)?;
        let (meta, body, rewrote_frontmatter, fm_warning) = parse_or_repair_frontmatter(&content);
        if let Some(w) = &fm_warning {
            tracing::warn!("{}: {}", vault_path.as_str(), w);
        }

        // Persist the repair only when this index owns the vault on disk
        // (`clep serve` / the CLI). A read-only index still indexes `meta` as
        // repaired, but hashes the untouched on-disk bytes so an unchanged
        // file keeps hashing the same on every re-index.
        if rewrote_frontmatter && self.repair_frontmatter {
            content = write_page_content(&meta, &body);
            std::fs::write(&abs_path, &content).map_err(IndexError::Io)?;
        }

        let content_hash = blake3::hash(content.as_bytes()).to_hex().to_string();

        // Check if hash matches DB -> skip if unchanged. Keep the stored identity
        // so a repaired frontmatter ID can replace the row at the same path.
        let existing_page: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT id, content_hash FROM pages WHERE path = ?1",
                params![vault_path.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        if existing_page.as_ref().map(|(_, hash)| hash.as_str()) == Some(&content_hash) {
            return Ok(false);
        }

        let canonical = if let Some(ref title) = meta.title {
            CanonicalName::from_title(title)
        } else {
            CanonicalName::from_filename(vault_path.filename())
        };

        let encrypted = meta.encryption.is_some();
        let raw_body = body;
        let body = if encrypted {
            String::new()
        } else {
            raw_body.clone()
        };
        let body_links = extract_links(&body);
        let blocks = crate::vault::block::parse_blocks(&body);

        let prop_links = extract_prop_links(&meta, linkable_properties);

        let page = IndexedPage {
            vault_path: vault_path.clone(),
            abs_path: abs_path.clone(),
            meta,
            body,
            encrypted,
            raw_body,
            content_hash,
            body_links,
            prop_links,
            canonical,
            blocks,
        };

        let tx = self.conn.savepoint()?;
        let page_id = page.meta.id.to_string();
        let meta_json = serde_json::to_string(&page.meta).unwrap_or_else(|_| "{}".to_string());
        let created_at = page.meta.created_at.map(|dt| dt.to_rfc3339());
        let updated_at = page.meta.updated_at.map(|dt| dt.to_rfc3339());
        let journal_date = extract_journal_date(page.vault_path.as_str());
        let (kind, kind_inferred) =
            crate::vault::kind::resolve(page.vault_path.as_str(), page.meta.kind);
        let kind_str = kind.as_str();
        let project = page.meta.project.clone();
        let word_count = (!page.encrypted).then(|| page.body.split_whitespace().count() as i64);

        // `pages.path` is unique independently of the page ID. If frontmatter
        // repair changed the ID in place, remove the old identity and every
        // row derived from it before inserting the replacement. Most derived
        // tables cascade from `pages`; FTS must be maintained explicitly.
        if let Some((existing_id, _)) = &existing_page
            && existing_id != &page_id
        {
            tx.execute(
                "DELETE FROM pages_fts WHERE page_id = ?1",
                params![existing_id],
            )?;
            tx.execute("DELETE FROM pages WHERE id = ?1", params![existing_id])?;
        }

        tx.execute(
            "INSERT INTO pages (id, path, title, canonical_name, created_at, updated_at, meta_json, content_hash, journal_date, kind, kind_inferred, project, encrypted, word_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET
               path = excluded.path,
               title = excluded.title,
               canonical_name = excluded.canonical_name,
               created_at = excluded.created_at,
               updated_at = excluded.updated_at,
               meta_json = excluded.meta_json,
               content_hash = excluded.content_hash,
               journal_date = excluded.journal_date,
               kind = excluded.kind,
               kind_inferred = excluded.kind_inferred,
               project = excluded.project,
               encrypted = excluded.encrypted,
               word_count = excluded.word_count",
            params![
                page_id,
                page.vault_path.as_str(),
                page.meta.title,
                page.canonical.as_str(),
                created_at,
                updated_at,
                meta_json,
                page.content_hash,
                journal_date,
                kind_str,
                kind_inferred as i64,
                project,
                page.encrypted as i64,
                word_count,
            ],
        )?;

        // Update FTS index
        tx.execute("DELETE FROM pages_fts WHERE page_id = ?1", params![page_id])?;
        tx.execute(
            "INSERT INTO pages_fts (page_id, path, title, body) VALUES (?1, ?2, ?3, ?4)",
            params![
                page_id,
                page.vault_path.as_str(),
                page.meta.title.as_deref().unwrap_or(""),
                &page.body,
            ],
        )?;
        tx.execute(
            "INSERT INTO page_bodies (page_id, body) VALUES (?1, ?2)
             ON CONFLICT(page_id) DO UPDATE SET body = excluded.body",
            params![page_id, &page.body],
        )?;

        // Clear old derived data
        // block_properties must be deleted before blocks due to FK constraint
        tx.execute(
            "DELETE FROM block_properties WHERE page_id = ?1",
            params![page_id],
        )?;
        tx.execute("DELETE FROM blocks WHERE page_id = ?1", params![page_id])?;
        tx.execute("DELETE FROM links WHERE source_id = ?1", params![page_id])?;
        tx.execute("DELETE FROM tags WHERE page_id = ?1", params![page_id])?;
        tx.execute(
            "DELETE FROM page_properties WHERE page_id = ?1",
            params![page_id],
        )?;
        tx.execute(
            "DELETE FROM canonical_names WHERE page_id = ?1",
            params![page_id],
        )?;

        for deriver in &self.derivers {
            deriver.derive(&page, &page_id, &tx)?;
        }

        tx.commit()?;
        Ok(true)
    }

    /// Index one lifecycle-restored page without repairing or rewriting its bytes.
    pub(crate) fn index_page_opaque(
        &mut self,
        vault: &Vault,
        vault_path: &VaultPath,
    ) -> Result<bool, IndexError> {
        let repair_frontmatter = std::mem::replace(&mut self.repair_frontmatter, false);
        let result = self.index_page(vault, vault_path);
        self.repair_frontmatter = repair_frontmatter;
        result
    }

    /// Remove a page from the index by its vault path.
    ///
    /// Returns `true` if a page was found and removed, `false` if no page
    /// existed at that path. Derived data (links, tags, canonical_names) is
    /// removed via ON DELETE CASCADE.
    pub fn remove_page(&mut self, vault_path: &VaultPath) -> Result<bool, IndexError> {
        // Remove from FTS before deleting the page
        let page_id: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM pages WHERE path = ?1",
                params![vault_path.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(ref pid) = page_id {
            self.conn
                .execute("DELETE FROM pages_fts WHERE page_id = ?1", params![pid])?;
        }

        let changes = self.conn.execute(
            "DELETE FROM pages WHERE path = ?1",
            params![vault_path.as_str()],
        )?;
        Ok(changes > 0)
    }

    /// Resolve unresolved links originating from or targeting a specific page.
    ///
    /// This resolves:
    /// 1. Outgoing links from the page (links where source_id = page's id)
    /// 2. Incoming links to the page (links targeting the page's canonical names)
    ///
    /// Returns the number of links resolved.
    pub fn resolve_links_for_page(&mut self, vault_path: &VaultPath) -> Result<usize, IndexError> {
        let tx = self.conn.savepoint()?;
        let mut resolved_count = 0usize;

        let page_id: Option<String> = tx
            .query_row(
                "SELECT id FROM pages WHERE path = ?1",
                params![vault_path.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        let page_id = match page_id {
            Some(id) => id,
            None => {
                tx.commit()?;
                return Ok(0);
            }
        };

        resolve_outgoing_wikilinks(&tx, &page_id, &mut resolved_count)?;
        resolve_outgoing_block_refs(&tx, &page_id, &mut resolved_count)?;
        resolve_incoming_wikilinks(&tx, &page_id, &mut resolved_count)?;

        // Prefetched for Pass 4 (was inline at the original lines 740–744).
        let page_path: String = tx.query_row(
            "SELECT path FROM pages WHERE id = ?1",
            params![page_id],
            |row| row.get(0),
        )?;
        resolve_incoming_block_refs(&tx, &page_id, &page_path, &mut resolved_count)?;

        tx.commit()?;
        Ok(resolved_count)
    }

    /// Find all pages that link to the given page (by resolved target_id or
    /// target_canonical matching the page's canonical names).
    ///
    /// Returns vault paths of the source pages (deduplicated).
    pub fn reverse_deps(&self, vault_path: &VaultPath) -> Result<Vec<VaultPath>, IndexError> {
        let page_id: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM pages WHERE path = ?1",
                params![vault_path.as_str()],
                |row| row.get(0),
            )
            .optional()?;

        let mut source_paths: std::collections::HashSet<String> = std::collections::HashSet::new();

        if let Some(ref page_id) = page_id {
            // Pages that resolved to this page
            let mut stmt = self.conn.prepare(
                "SELECT DISTINCT p.path FROM links l
                 JOIN pages p ON l.source_id = p.id
                 WHERE l.target_id = ?1",
            )?;
            let paths: Vec<String> = stmt
                .query_map(params![page_id], |row| row.get(0))?
                .collect::<Result<_, _>>()?;
            source_paths.extend(paths);

            // Pages with unresolved links matching this page's canonical names
            let mut cn_stmt = self
                .conn
                .prepare("SELECT canonical_name FROM canonical_names WHERE page_id = ?1")?;
            let cns: Vec<String> = cn_stmt
                .query_map(params![page_id], |row| row.get(0))?
                .collect::<Result<_, _>>()?;
            drop(cn_stmt);

            for cn in &cns {
                let mut stmt = self.conn.prepare(
                    "SELECT DISTINCT p.path FROM links l
                     JOIN pages p ON l.source_id = p.id
                     WHERE l.target_canonical = ?1 AND l.target_id IS NULL",
                )?;
                let paths: Vec<String> = stmt
                    .query_map(params![cn], |row| row.get(0))?
                    .collect::<Result<_, _>>()?;
                source_paths.extend(paths);
            }
        }

        // Remove self
        source_paths.remove(vault_path.as_str());

        let mut result: Vec<VaultPath> = source_paths
            .into_iter()
            .filter_map(|p| VaultPath::new(&p).ok())
            .collect();
        result.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        Ok(result)
    }

    /// Null out `target_id` and `target_path` for all links that currently
    /// resolve to the given page. This makes them "unresolved" again so they
    /// can be re-resolved against updated index state.
    ///
    /// Returns the number of links invalidated.
    pub fn invalidate_links_to(&mut self, vault_path: &VaultPath) -> Result<usize, IndexError> {
        let page_id: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM pages WHERE path = ?1",
                params![vault_path.as_str()],
                |row| row.get(0),
            )
            .optional()?;

        let page_id = match page_id {
            Some(id) => id,
            None => return Ok(0),
        };

        let count = self.conn.execute(
            "UPDATE links SET target_id = NULL, target_path = NULL
             WHERE target_id = ?1",
            params![page_id],
        )?;

        Ok(count)
    }

    /// Clear the retained resolved path after its target page has been removed.
    ///
    /// SQLite's `ON DELETE SET NULL` has already cleared `target_id`, so the
    /// prior target path is the stable key available at this point.
    pub(crate) fn invalidate_links_after_removal(
        &mut self,
        vault_path: &VaultPath,
    ) -> Result<usize, IndexError> {
        Ok(self.conn.execute(
            "UPDATE links SET target_id = NULL, target_path = NULL
             WHERE target_path = ?1",
            params![vault_path.as_str()],
        )?)
    }

    /// Query all unresolved links, enriched with reason and candidates.
    ///
    /// For each link where `target_id IS NULL`:
    /// - If `target_canonical` has 0 matches in `canonical_names` → `NoMatch`
    /// - If `target_canonical` has 2+ matches → `Ambiguous` with candidates
    /// - (1 match should not appear — those get resolved by `resolve_links`)
    pub fn unresolved_with_candidates(&self) -> Result<Vec<UnresolvedLinkDetail>, IndexError> {
        let mut stmt = self.conn.prepare(
            "SELECT l.source_id, p.path, l.target_raw, l.target_canonical, l.kind, l.span_start
             FROM links l
             JOIN pages p ON l.source_id = p.id
             WHERE l.target_id IS NULL",
        )?;

        let rows: Vec<(String, String, String, Option<String>, String, i64)> = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);

        let mut results = Vec::new();

        for (source_id, source_path, target_raw, target_canonical, kind, span_start) in rows {
            let (reason, candidates) = if let Some(ref tc) = target_canonical {
                let mut lookup = self.conn.prepare(
                    "SELECT cn.page_id, p.path, p.title
                     FROM canonical_names cn
                     JOIN pages p ON p.id = cn.page_id
                     WHERE cn.canonical_name = ?1",
                )?;
                let matches: Vec<LinkCandidate> = lookup
                    .query_map(params![tc], |row| {
                        Ok(LinkCandidate {
                            page_id: row.get(0)?,
                            path: row.get(1)?,
                            title: row.get(2)?,
                        })
                    })?
                    .filter_map(|r| r.ok())
                    .collect();
                drop(lookup);

                if matches.len() >= 2 {
                    (UnresolvedReason::Ambiguous, matches)
                } else {
                    // 0 matches or 1 match that wasn't resolved (shouldn't normally happen for 1)
                    (UnresolvedReason::NoMatch, Vec::new())
                }
            } else {
                // No target_canonical at all — no match possible
                (UnresolvedReason::NoMatch, Vec::new())
            };

            results.push(UnresolvedLinkDetail {
                source_id,
                source_path,
                target_raw,
                target_canonical,
                kind,
                span_start,
                reason,
                candidates,
            });
        }

        Ok(results)
    }

    /// Find all pages that link to `vault_path`, returning each link with a
    /// text snippet showing the surrounding context.
    ///
    /// `max_context_chars` controls the maximum length of each snippet.
    /// Only body links (wiki, markdown) get context extracted from the source file;
    /// property_ref links get the source field name as context instead.
    pub fn backlinks_with_context(
        &self,
        vault: &Vault,
        vault_path: &VaultPath,
        max_context_chars: usize,
    ) -> Result<Vec<BacklinkWithContext>, IndexError> {
        // 1. Look up the page_id for vault_path
        let page_id: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM pages WHERE path = ?1",
                params![vault_path.as_str()],
                |row| row.get(0),
            )
            .ok();

        let page_id = match page_id {
            Some(id) => id,
            None => return Ok(Vec::new()),
        };

        // 2. Compute target_canonical from the vault path stem
        let target_canonical = CanonicalName::from_filename(vault_path.stem());

        // 3. Query links where target_path = vault_path OR target_canonical = canonical OR target_id = page_id
        let mut stmt = self.conn.prepare(
            "SELECT l.source_id, p.path, p.title, l.target_raw, l.kind, l.span_start, l.span_end, l.source_field
             FROM links l
             JOIN pages p ON l.source_id = p.id
             WHERE l.target_id = ?1
                OR l.target_path = ?2
                OR l.target_canonical = ?3",
        )?;

        struct BacklinkRow {
            source_id: String,
            source_path: String,
            source_title: Option<String>,
            target_raw: String,
            kind: String,
            span_start: i64,
            span_end: i64,
            source_field: Option<String>,
        }

        let rows: Vec<BacklinkRow> = stmt
            .query_map(
                params![page_id, vault_path.as_str(), target_canonical.as_str()],
                |row| {
                    Ok(BacklinkRow {
                        source_id: row.get(0)?,
                        source_path: row.get(1)?,
                        source_title: row.get(2)?,
                        target_raw: row.get(3)?,
                        kind: row.get(4)?,
                        span_start: row.get(5)?,
                        span_end: row.get(6)?,
                        source_field: row.get(7)?,
                    })
                },
            )?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);

        // 4. For each link, extract context
        let mut results = Vec::new();
        for BacklinkRow {
            source_id,
            source_path,
            source_title,
            target_raw,
            kind,
            span_start,
            span_end,
            source_field,
        } in rows
        {
            let context = if kind == "property_ref" {
                // Property ref links: use field name as context
                let field = source_field.as_deref().unwrap_or("unknown");
                format!("frontmatter field: {field}")
            } else if span_start >= 0 {
                // Body link: read the source file, extract context from body
                VaultPath::new(&source_path)
                    .ok()
                    .and_then(|source_vp| {
                        let abs_path = vault.resolve(&source_vp);
                        fs::read_to_string(&abs_path).ok()
                    })
                    .and_then(|content| {
                        let body_start = find_body_start(&content);
                        let body = &content[body_start..];
                        let start = span_start as usize;
                        let end = span_end as usize;
                        if start <= body.len() && end <= body.len() && start <= end {
                            Some(extract_context(body, start..end, max_context_chars))
                        } else {
                            None
                        }
                    })
                    .unwrap_or_else(|| target_raw.clone())
            } else {
                // Fallback
                target_raw.clone()
            };

            results.push(BacklinkWithContext {
                source_id,
                source_path,
                source_title,
                target_raw,
                kind,
                context,
                span_start,
                span_end,
            });
        }

        Ok(results)
    }

    /// Rank a list of candidates according to the given disambiguation strategy.
    ///
    /// `source_path` is the vault-relative path of the page containing the
    /// unresolved link (used by ClosestDirectory strategy).
    ///
    /// Returns a new Vec sorted by preference (best match first).
    pub fn rank_candidates(
        &self,
        candidates: &[LinkCandidate],
        source_path: &str,
        strategy: DisambiguationStrategy,
    ) -> Vec<LinkCandidate> {
        let mut ranked = candidates.to_vec();

        match strategy {
            DisambiguationStrategy::ShortestPath => {
                ranked.sort_by_key(|c| c.path.len());
            }
            DisambiguationStrategy::ClosestDirectory => {
                let source_dir = source_path
                    .rfind('/')
                    .map(|i| &source_path[..i])
                    .unwrap_or("");
                ranked.sort_by(|a, b| {
                    let a_dir = a.path.rfind('/').map(|i| &a.path[..i]).unwrap_or("");
                    let b_dir = b.path.rfind('/').map(|i| &b.path[..i]).unwrap_or("");
                    let a_common = common_prefix_len(source_dir, a_dir);
                    let b_common = common_prefix_len(source_dir, b_dir);
                    b_common.cmp(&a_common) // Higher common prefix first
                });
            }
            DisambiguationStrategy::MostRecent => {
                // Preload timestamps to avoid O(N log N) DB queries in sort
                use std::collections::HashMap;
                let timestamps: HashMap<String, Option<String>> = ranked
                    .iter()
                    .map(|c| {
                        let ts: Option<String> = self
                            .conn
                            .query_row(
                                "SELECT updated_at FROM pages WHERE id = ?1",
                                params![c.page_id],
                                |row| row.get(0),
                            )
                            .ok()
                            .flatten();
                        (c.page_id.clone(), ts)
                    })
                    .collect();
                ranked.sort_by(|a, b| {
                    let ts_a = timestamps.get(&a.page_id).and_then(|t| t.as_ref());
                    let ts_b = timestamps.get(&b.page_id).and_then(|t| t.as_ref());
                    ts_b.cmp(&ts_a)
                });
            }
        }

        ranked
    }

    /// Human-oriented full-text search across page titles and bodies.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>, IndexError> {
        let Some(query) = fts_prefix_query(query) else {
            return Ok(Vec::new());
        };
        self.search_fts(&query, limit)
    }

    /// Execute an already prepared FTS5 expression.
    ///
    /// This is crate-scoped so CLI callers can deliberately preserve exact
    /// phrase and raw operator semantics without exposing FTS syntax to API
    /// search callers.
    pub(crate) fn search_fts(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<SearchResult>, IndexError> {
        let mut stmt = self.conn.prepare(
            "SELECT f.page_id, f.path, p.title,
                    snippet(pages_fts, 3, '<mark>', '</mark>', '\u{2026}', 32),
                    rank
             FROM pages_fts f
             JOIN pages p ON p.id = f.page_id
             WHERE pages_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2",
        )?;

        let results = stmt
            .query_map(params![query, limit as u32], |row| {
                Ok(SearchResult {
                    page_id: row.get(0)?,
                    path: row.get(1)?,
                    title: row.get(2)?,
                    snippet: row.get(3)?,
                    rank: row.get(4)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(results)
    }

    /// Find pages similar to `target` ranked by Jaccard similarity of tag sets.
    ///
    /// Pages that share no tags with `target` are excluded. Results are sorted
    /// descending by score, then by shared-tag count, then alphabetically by
    /// path as a tiebreaker.
    pub fn similar_by_tags(
        &self,
        target: &VaultPath,
        limit: usize,
    ) -> Result<Vec<SimilarRow>, IndexError> {
        // Look up target page id.
        let target_id: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM pages WHERE path = ?1",
                params![target.as_str()],
                |r| r.get(0),
            )
            .ok();
        let Some(target_id) = target_id else {
            return Ok(Vec::new());
        };

        // Collect the target's tag set.
        let target_tags: Vec<String> = self
            .conn
            .prepare("SELECT tag FROM tags WHERE page_id = ?1")?
            .query_map(params![target_id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if target_tags.is_empty() {
            return Ok(Vec::new());
        }

        // Build a query that finds candidate pages sharing at least one tag.
        // We use GROUP_CONCAT with ASCII unit-separator (0x1F) to retrieve
        // all tags for each candidate in a single pass.
        let placeholders = std::iter::repeat_n("?", target_tags.len())
            .collect::<Vec<_>>()
            .join(",");
        let q = format!(
            "SELECT p.id, p.path, p.title, GROUP_CONCAT(pt.tag, char(31)) \
             FROM pages p \
             JOIN tags pt ON pt.page_id = p.id \
             WHERE p.id != ?1 AND p.id IN ( \
                 SELECT page_id FROM tags WHERE tag IN ({placeholders}) \
             ) \
             GROUP BY p.id"
        );

        let mut stmt = self.conn.prepare(&q)?;

        // Bind params: target_id first, then each tag.
        let mut bind_params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        bind_params.push(Box::new(target_id));
        for t in &target_tags {
            bind_params.push(Box::new(t.clone()));
        }

        let target_set: HashSet<&str> = target_tags.iter().map(String::as_str).collect();

        let rows_iter = stmt.query_map(
            rusqlite::params_from_iter(bind_params.iter().map(|b| b.as_ref())),
            |r| {
                let path: String = r.get(1)?;
                let title: Option<String> = r.get(2)?;
                let tags_concat: Option<String> = r.get(3)?;
                let other_tags: Vec<String> = match tags_concat {
                    Some(s) => s.split('\u{001f}').map(|x| x.to_string()).collect(),
                    None => Vec::new(),
                };
                Ok((path, title, other_tags))
            },
        )?;

        let mut rows: Vec<SimilarRow> = Vec::new();
        for r in rows_iter {
            let (path, title, other_tags) = r?;
            let shared: Vec<String> = other_tags
                .iter()
                .filter(|t| target_set.contains(t.as_str()))
                .cloned()
                .collect();
            let union_size = target_set.len() + other_tags.len() - shared.len();
            let score = if union_size == 0 {
                0.0
            } else {
                shared.len() as f64 / union_size as f64
            };
            rows.push(SimilarRow {
                path,
                title,
                shared_tags: shared,
                score,
            });
        }

        rows.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.shared_tags.len().cmp(&a.shared_tags.len()))
                .then_with(|| a.path.cmp(&b.path))
        });
        rows.truncate(limit);
        Ok(rows)
    }

    /// Find the lifecycle location currently reserving an archive's original
    /// URL. Active pages take precedence if recovery has not yet restored the
    /// normal single-location invariant.
    ///
    /// Active `source_hash` is the hash of the markdown as captured, before
    /// image rewriting. Rubbish ownership is resolved only from SQLite; this
    /// request-time lookup never enumerates item manifests.
    pub fn find_by_archive_url(&self, url: &str) -> Result<Option<ArchiveUrlOwner>, IndexError> {
        let active = self
            .conn
            .query_row(
                "SELECT id, path, json_extract(meta_json, '$.archive.source_hash')
                 FROM pages
                 WHERE json_extract(meta_json, '$.archive.url') = ?1
                 ORDER BY path ASC
                 LIMIT 1",
                params![url],
                |row| {
                    Ok(ArchiveUrlOwner::Active {
                        page_id: row.get(0)?,
                        path: row.get(1)?,
                        source_hash: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    })
                },
            )
            .optional()?;
        if active.is_some() {
            return Ok(active);
        }

        Ok(self
            .conn
            .query_row(
                "SELECT item_id, page_id, original_path
                 FROM rubbish_items
                 WHERE valid = 1 AND archive_url = ?1
                 ORDER BY deleted_at DESC, item_id ASC
                 LIMIT 1",
                params![url],
                |row| {
                    Ok(ArchiveUrlOwner::Rubbish {
                        item_id: row.get(0)?,
                        page_id: row.get(1)?,
                        original_path: row.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    /// `archive.captured_at` for an indexed page, if the page exists and
    /// carries archive frontmatter.
    pub fn archive_captured_at(&self, page_id: &str) -> Result<Option<String>, IndexError> {
        Ok(self
            .conn
            .query_row(
                "SELECT json_extract(meta_json, '$.archive.captured_at')
                 FROM pages WHERE id = ?1",
                params![page_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }
}

/// Pass 1: resolve this page's outgoing wikilinks against canonical_names.
fn resolve_outgoing_wikilinks(
    tx: &rusqlite::Connection,
    page_id: &str,
    count: &mut usize,
) -> Result<(), IndexError> {
    let mut stmt = tx.prepare(
        "SELECT source_id, span_start, target_canonical
         FROM links
         WHERE source_id = ?1 AND target_id IS NULL AND target_canonical IS NOT NULL",
    )?;

    let outgoing: Vec<(String, i64, String)> = stmt
        .query_map(params![page_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<Result<_, _>>()?;
    drop(stmt);

    for (source_id, span_start, target_canonical) in &outgoing {
        let Some((target_id, target_path)) = unique_link_target(tx, target_canonical)? else {
            continue;
        };

        tx.execute(
            "UPDATE links SET target_id = ?1, target_path = ?2
             WHERE source_id = ?3 AND span_start = ?4",
            params![target_id, target_path, source_id, span_start],
        )?;
        *count += 1;
    }

    Ok(())
}

/// Pass 2: resolve this page's outgoing block-ref links against block IDs.
fn resolve_outgoing_block_refs(
    tx: &rusqlite::Connection,
    page_id: &str,
    count: &mut usize,
) -> Result<(), IndexError> {
    let mut block_ref_stmt = tx.prepare(
        "SELECT source_id, span_start, target_block_id
         FROM links
         WHERE source_id = ?1 AND target_id IS NULL AND kind = 'block_ref' AND target_block_id IS NOT NULL",
    )?;
    let outgoing_block_refs: Vec<(String, i64, String)> = block_ref_stmt
        .query_map(params![page_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<Result<_, _>>()?;
    drop(block_ref_stmt);

    for (source_id, span_start, block_id) in &outgoing_block_refs {
        let mut lookup = tx.prepare(
            "SELECT b.page_id, p.path
             FROM blocks b JOIN pages p ON p.id = b.page_id
             WHERE b.block_id = ?1",
        )?;
        let matches: Vec<(String, String)> = lookup
            .query_map(params![block_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        drop(lookup);

        if matches.len() == 1 {
            let (target_id, target_path) = &matches[0];
            tx.execute(
                "UPDATE links SET target_id = ?1, target_path = ?2
                 WHERE source_id = ?3 AND span_start = ?4",
                params![target_id, target_path, source_id, span_start],
            )?;
            *count += 1;
        }
    }

    Ok(())
}

/// Pass 3: resolve other pages' incoming wikilinks that target this page's
/// canonical names (only when the canonical name is unambiguous).
fn resolve_incoming_wikilinks(
    tx: &rusqlite::Connection,
    page_id: &str,
    count: &mut usize,
) -> Result<(), IndexError> {
    let page_path: String = tx.query_row(
        "SELECT path FROM pages WHERE id = ?1",
        params![page_id],
        |row| row.get(0),
    )?;
    let direct_count = tx.execute(
        "UPDATE links SET target_id = ?1, target_path = ?2
         WHERE target_id IS NULL AND target_canonical = ?1",
        params![page_id, page_path],
    )?;
    *count += direct_count;

    let mut cn_stmt =
        tx.prepare("SELECT canonical_name FROM canonical_names WHERE page_id = ?1")?;
    let canonical_names: Vec<String> = cn_stmt
        .query_map(params![page_id], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    drop(cn_stmt);

    for cn in &canonical_names {
        let mut stmt = tx.prepare(
            "SELECT source_id, span_start FROM links
             WHERE target_canonical = ?1 AND target_id IS NULL",
        )?;
        let unresolved: Vec<(String, i64)> = stmt
            .query_map(params![cn], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        drop(stmt);

        for (source_id, span_start) in &unresolved {
            let mut count_stmt =
                tx.prepare("SELECT COUNT(*) FROM canonical_names WHERE canonical_name = ?1")?;
            let match_count: i64 = count_stmt.query_row(params![cn], |row| row.get(0))?;
            drop(count_stmt);

            if match_count == 1 {
                let path: String = tx.query_row(
                    "SELECT path FROM pages WHERE id = ?1",
                    params![page_id],
                    |row| row.get(0),
                )?;
                tx.execute(
                    "UPDATE links SET target_id = ?1, target_path = ?2
                     WHERE source_id = ?3 AND span_start = ?4",
                    params![page_id, path, source_id, span_start],
                )?;
                *count += 1;
            }
        }
    }

    Ok(())
}

/// Pass 4: resolve other pages' incoming block-ref links that target block IDs
/// on this page. `page_path` is prefetched by the caller.
fn resolve_incoming_block_refs(
    tx: &rusqlite::Connection,
    page_id: &str,
    page_path: &str,
    count: &mut usize,
) -> Result<(), IndexError> {
    let mut block_id_stmt =
        tx.prepare("SELECT block_id FROM blocks WHERE page_id = ?1 AND block_id IS NOT NULL")?;
    let page_block_ids: Vec<String> = block_id_stmt
        .query_map(params![page_id], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    drop(block_id_stmt);

    for bid in &page_block_ids {
        let mut stmt = tx.prepare(
            "SELECT source_id, span_start FROM links
             WHERE target_block_id = ?1 AND target_id IS NULL AND kind = 'block_ref'",
        )?;
        let unresolved: Vec<(String, i64)> = stmt
            .query_map(params![bid], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        drop(stmt);

        for (source_id, span_start) in &unresolved {
            tx.execute(
                "UPDATE links SET target_id = ?1, target_path = ?2
                 WHERE source_id = ?3 AND span_start = ?4",
                params![page_id, page_path, source_id, span_start],
            )?;
            *count += 1;
        }
    }

    Ok(())
}

/// Add the equality-indexed body projection to an existing FTS-backed index.
///
/// Legacy indexes are backfilled once from FTS so unchanged pages do not need
/// to be re-indexed after upgrading.
fn migrate_page_bodies_projection(conn: &Connection) -> Result<(), IndexError> {
    let body_table_exists = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'page_bodies'",
        [],
        |row| row.get::<_, i64>(0),
    )? > 0;
    if body_table_exists {
        return Ok(());
    }

    let legacy_source_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'table' AND name IN ('pages', 'pages_fts')",
        [],
        |row| row.get(0),
    )?;
    if legacy_source_count != 2 {
        return Ok(());
    }

    let transaction = conn.unchecked_transaction()?;
    transaction.execute_batch(
        "CREATE TABLE page_bodies (
            page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
            body TEXT NOT NULL
        );",
    )?;
    transaction.execute(
        "INSERT OR REPLACE INTO page_bodies (page_id, body)
         SELECT body_fts.page_id, body_fts.body
         FROM pages_fts body_fts
         JOIN pages p ON p.id = body_fts.page_id",
        [],
    )?;
    transaction.commit()?;
    Ok(())
}

/// Count the number of common path segments between two directory paths.
fn common_prefix_len(a: &str, b: &str) -> usize {
    a.split('/')
        .zip(b.split('/'))
        .take_while(|(x, y)| x == y)
        .count()
}

/// Find the byte offset where the body starts (after the frontmatter fences,
/// `+++` or legacy `---`).
pub(crate) fn find_body_start(content: &str) -> usize {
    crate::vault::page::body_offset(content)
}

/// Add provenance to an existing tags table.
///
/// This runs before the main schema batch because `CREATE TABLE IF NOT EXISTS`
/// cannot add columns to a legacy table.
fn migrate_tags_add_computed(conn: &Connection) -> Result<(), IndexError> {
    let table_exists = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tags'",
        [],
        |row| row.get::<_, i64>(0),
    )? > 0;
    if !table_exists {
        return Ok(());
    }

    let has_computed = {
        let mut stmt = conn.prepare("PRAGMA table_info(tags)")?;
        let mut rows = stmt.query([])?;
        let mut found = false;
        while let Some(row) = rows.next()? {
            if row.get::<_, String>(1)? == "computed" {
                found = true;
                break;
            }
        }
        found
    };

    if !has_computed {
        conn.execute_batch("ALTER TABLE tags ADD COLUMN computed INTEGER NOT NULL DEFAULT 0;")?;
    }
    Ok(())
}

/// Add page projection columns to `pages` if they do not exist.
///
/// Must run BEFORE the main SCHEMA batch, since SCHEMA creates indexes on `kind`
/// and `project` and will fail if the columns are missing on pre-existing DBs.
fn migrate_pages_add_projection_columns(conn: &Connection) -> Result<(), IndexError> {
    // If the pages table doesn't exist yet, nothing to migrate — SCHEMA will create it.
    let table_exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='pages'",
        [],
        |row| row.get::<_, i64>(0),
    )? > 0;

    if !table_exists {
        return Ok(());
    }

    let has_kind: bool = conn.prepare("SELECT kind FROM pages LIMIT 0").is_ok();
    if !has_kind {
        conn.execute_batch("ALTER TABLE pages ADD COLUMN kind TEXT NOT NULL DEFAULT 'NOTE';")?;
    }

    let has_kind_inferred: bool = conn
        .prepare("SELECT kind_inferred FROM pages LIMIT 0")
        .is_ok();
    if !has_kind_inferred {
        conn.execute_batch(
            "ALTER TABLE pages ADD COLUMN kind_inferred INTEGER NOT NULL DEFAULT 1;",
        )?;
    }

    let has_project: bool = conn.prepare("SELECT project FROM pages LIMIT 0").is_ok();
    if !has_project {
        conn.execute_batch("ALTER TABLE pages ADD COLUMN project TEXT;")?;
    }

    // Nullable: existing rows stay NULL until the next index build re-upserts
    // them with a computed count.
    let has_word_count: bool = conn.prepare("SELECT word_count FROM pages LIMIT 0").is_ok();
    if !has_word_count {
        conn.execute_batch("ALTER TABLE pages ADD COLUMN word_count INTEGER;")?;
    }

    let has_encrypted: bool = conn.prepare("SELECT encrypted FROM pages LIMIT 0").is_ok();
    if !has_encrypted {
        conn.execute_batch("ALTER TABLE pages ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;")?;
    }

    Ok(())
}

fn migrate_links_add_target_block_id(conn: &Connection) -> Result<(), IndexError> {
    // If the links table doesn't exist yet, nothing to migrate — SCHEMA will create it.
    let table_exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='links'",
        [],
        |row| row.get::<_, i64>(0),
    )? > 0;

    if !table_exists {
        return Ok(());
    }

    let has_column: bool = conn
        .prepare("SELECT target_block_id FROM links LIMIT 0")
        .is_ok();

    if !has_column {
        conn.execute_batch("ALTER TABLE links ADD COLUMN target_block_id TEXT;")?;
    }

    Ok(())
}

fn unique_link_target(
    conn: &Connection,
    target_canonical: &str,
) -> Result<Option<(String, String)>, IndexError> {
    if let Ok(target_id) = Uuid::parse_str(target_canonical) {
        let exact = conn
            .query_row(
                "SELECT id, path FROM pages WHERE id = ?1",
                params![target_id.hyphenated().to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if exact.is_some() {
            return Ok(exact);
        }
    }

    let mut stmt = conn.prepare(
        "SELECT cn.page_id, p.path
         FROM canonical_names cn
         JOIN pages p ON p.id = cn.page_id
         WHERE cn.canonical_name = ?1",
    )?;
    let matches = stmt
        .query_map(params![target_canonical], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok((matches.len() == 1).then(|| matches.into_iter().next().unwrap()))
}

/// Migrate the `links` table so that `target_id` carries `ON DELETE SET NULL`.
///
/// SQLite cannot alter FK constraints in-place, so we check the existing
/// constraint via `PRAGMA foreign_key_list` and, if needed, recreate the table.
fn migrate_links_fk(conn: &Connection) -> Result<(), IndexError> {
    let needs_migration: bool = {
        let mut stmt = conn.prepare("PRAGMA foreign_key_list(links)")?;
        let fks: Vec<(String, String)> = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(3)?, row.get::<_, String>(6)?))
            })?
            .filter_map(|r| r.ok())
            .collect();
        fks.iter()
            .any(|(col, on_delete)| col == "target_id" && on_delete != "SET NULL")
    };

    if needs_migration {
        conn.execute_batch(
            "PRAGMA foreign_keys=OFF;
            CREATE TABLE IF NOT EXISTS links_new (
                source_id       TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
                target_raw      TEXT NOT NULL,
                target_canonical TEXT,
                target_id       TEXT REFERENCES pages(id) ON DELETE SET NULL,
                target_path     TEXT,
                target_block_id TEXT,
                kind            TEXT NOT NULL,
                source_field    TEXT,
                span_start      INTEGER NOT NULL,
                span_end        INTEGER NOT NULL,
                PRIMARY KEY (source_id, span_start)
            );
            INSERT INTO links_new (source_id, target_raw, target_canonical, target_id, target_path, kind, source_field, span_start, span_end) SELECT source_id, target_raw, target_canonical, target_id, target_path, kind, source_field, span_start, span_end FROM links;
            DROP TABLE links;
            ALTER TABLE links_new RENAME TO links;
            CREATE INDEX IF NOT EXISTS idx_links_target_id ON links(target_id);
            CREATE INDEX IF NOT EXISTS idx_links_target_path ON links(target_path);
            CREATE INDEX IF NOT EXISTS idx_links_target_block_id ON links(target_block_id) WHERE target_block_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_links_target_canonical ON links(target_canonical);
            PRAGMA foreign_keys=ON;",
        )?;
    }

    Ok(())
}

/// Extract a journal date from either a legacy `journals/YYYY-MM-DD.md` path
/// or a canonical `journals/<yyyymmdd>.YYYY-MM-DD.<shortid>.md` path.
///
/// Returns `Some("YYYY-MM-DD")` if the path matches, `None` otherwise.
/// Only matches top-level `journals/` — e.g. `other/journals/2026-02-17.md` is
/// rejected.
fn extract_journal_date(path: &str) -> Option<String> {
    let filename = path.strip_prefix("journals/")?;
    let stem = filename.strip_suffix(".md").unwrap_or(filename);
    let candidate = if stem.len() == 10 {
        stem
    } else if crate::vault::path::is_canonical_page_filename(filename) {
        stem.split('.').nth(1)?
    } else {
        return None;
    };

    // Validate YYYY-MM-DD shape (exactly 10 chars, correct punctuation, all digits).
    if candidate.len() != 10 {
        return None;
    }
    let bytes = candidate.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    for &i in &[0, 1, 2, 3, 5, 6, 8, 9] {
        if !bytes[i].is_ascii_digit() {
            return None;
        }
    }
    Some(candidate.to_string())
}

// ---------------------------------------------------------------------------
// Phase helpers (free functions used by VaultIndex::build)
// ---------------------------------------------------------------------------

/// Extract property-reference links from a page's metadata for the configured
/// linkable properties (tags, aliases, and arbitrary extra fields). Shared by
/// `build` (via collect_indexed_pages) and `index_page`.
///
/// `linkable_properties` is expected to be free of duplicates: property refs are
/// keyed by a negative `span_start` (`-(i+1)`), so emitting the same property
/// twice would collide on the `links` primary key at upsert time.
fn extract_prop_links(meta: &PageMeta, linkable_properties: &[String]) -> Vec<Link> {
    let mut prop_links = Vec::new();
    for prop in linkable_properties {
        let values: Vec<String> = match prop.as_str() {
            "tags" => meta.tags.clone(),
            "aliases" => meta.aliases.clone(),
            _ => {
                if let Some(val) = meta.extra.get(prop) {
                    toml_value_to_strings(val)
                } else {
                    Vec::new()
                }
            }
        };
        if !values.is_empty() {
            prop_links.extend(extract_property_refs(prop, &values));
        }
    }
    prop_links
}

/// Pass 1: walk the vault, parse/repair frontmatter, skip-unchanged, and build
/// IndexedPage records. Returns the parsed pages plus the set of seen paths
/// (for stale pruning).
fn collect_indexed_pages(
    vault: &Vault,
    tx: &rusqlite::Transaction,
    linkable_properties: &[String],
    force_rederive: bool,
    repair_frontmatter: bool,
    stats: &mut BuildStats,
) -> Result<(Vec<IndexedPage>, HashSet<String>), IndexError> {
    let mut parsed_files: Vec<IndexedPage> = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();

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

        // Read content (and normalize frontmatter if needed).
        let mut content = match fs::read_to_string(abs_path) {
            Ok(c) => c,
            Err(e) => {
                stats.warnings.push(format!("cannot read {rel_str}: {e}"));
                continue;
            }
        };

        let (meta, body, rewrote_frontmatter, fm_warning) = parse_or_repair_frontmatter(&content);
        if let Some(w) = fm_warning {
            stats.warnings.push(format!("{rel_str}: {w}"));
        }
        // See `VaultIndex::repair_frontmatter`: a read-only index indexes the
        // repaired `meta` but leaves the file on disk untouched, so the hash
        // below stays the hash of the real bytes.
        if rewrote_frontmatter && repair_frontmatter {
            content = write_page_content(&meta, &body);
            if let Err(e) = fs::write(abs_path, &content) {
                stats
                    .warnings
                    .push(format!("cannot rewrite frontmatter in {rel_str}: {e}"));
                continue;
            }
        }

        let content_hash = blake3::hash(content.as_bytes()).to_hex().to_string();

        // Check if hash matches DB -> skip if unchanged
        let existing_hash: Option<String> = tx
            .query_row(
                "SELECT content_hash FROM pages WHERE path = ?1",
                params![vault_path.as_str()],
                |row| row.get(0),
            )
            .ok();

        if !force_rederive && existing_hash.as_deref() == Some(&content_hash) {
            stats.pages_skipped += 1;
            continue;
        }

        // Derive CanonicalName
        let canonical = if let Some(ref title) = meta.title {
            CanonicalName::from_title(title)
        } else {
            CanonicalName::from_filename(vault_path.filename())
        };

        let encrypted = meta.encryption.is_some();
        let raw_body = body;
        let body = if encrypted {
            String::new()
        } else {
            raw_body.clone()
        };

        // Extract body links
        let body_links = extract_links(&body);

        // Extract blocks
        let blocks = crate::vault::block::parse_blocks(&body);

        // Extract property ref links for configured linkable_properties
        let prop_links = extract_prop_links(&meta, linkable_properties);

        parsed_files.push(IndexedPage {
            vault_path,
            abs_path: abs_path.to_path_buf(),
            meta,
            body,
            encrypted,
            raw_body,
            content_hash,
            body_links,
            prop_links,
            canonical,
            blocks,
        });
    }

    Ok((parsed_files, seen_paths))
}

/// Between passes: when pages share a UUID, keep the oldest (by created_at, then
/// mtime) and reassign + rewrite the rest. With `repair_frontmatter = false`
/// the reassignment happens in memory only (see `VaultIndex::repair_frontmatter`).
fn resolve_duplicate_uuids(
    parsed_files: &mut [IndexedPage],
    repair_frontmatter: bool,
    stats: &mut BuildStats,
) -> Result<(), IndexError> {
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

            // Write the updated frontmatter back to disk (owning indexes only).
            if repair_frontmatter {
                let new_content = write_page_content(&loser.meta, &loser.raw_body);
                fs::write(&loser.abs_path, &new_content)?;

                // Recompute content hash after rewrite
                loser.content_hash = blake3::hash(new_content.as_bytes()).to_hex().to_string();
            }
        }
    }

    Ok(())
}

/// Pass 2 (per page): upsert the page row, refresh FTS, clear derived rows, run
/// derivers. Increments stats.pages_indexed.
fn upsert_indexed_page(
    pf: &IndexedPage,
    tx: &rusqlite::Transaction,
    derivers: &[Box<dyn Deriver>],
    stats: &mut BuildStats,
) -> Result<(), IndexError> {
    let meta_json = serde_json::to_string(&pf.meta).unwrap_or_else(|_| "{}".to_string());

    let page_id = pf.meta.id.to_string();
    let created_at = pf.meta.created_at.map(|dt| dt.to_rfc3339());
    let updated_at = pf.meta.updated_at.map(|dt| dt.to_rfc3339());

    let journal_date = extract_journal_date(pf.vault_path.as_str());
    let (kind, kind_inferred) = crate::vault::kind::resolve(pf.vault_path.as_str(), pf.meta.kind);
    let kind_str = kind.as_str();
    let project = pf.meta.project.clone();
    let word_count = (!pf.encrypted).then(|| pf.body.split_whitespace().count() as i64);

    // Upsert into pages table
    tx.execute(
        "INSERT INTO pages (id, path, title, canonical_name, created_at, updated_at, meta_json, content_hash, journal_date, kind, kind_inferred, project, encrypted, word_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(id) DO UPDATE SET
           path = excluded.path,
           title = excluded.title,
           canonical_name = excluded.canonical_name,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           meta_json = excluded.meta_json,
           content_hash = excluded.content_hash,
           journal_date = excluded.journal_date,
           kind = excluded.kind,
           kind_inferred = excluded.kind_inferred,
           project = excluded.project,
           encrypted = excluded.encrypted,
           word_count = excluded.word_count",
        params![
            page_id,
            pf.vault_path.as_str(),
            pf.meta.title,
            pf.canonical.as_str(),
            created_at,
            updated_at,
            meta_json,
            pf.content_hash,
            journal_date,
            kind_str,
            kind_inferred as i64,
            project,
            pf.encrypted as i64,
            word_count,
        ],
    )?;

    // Update FTS index
    tx.execute("DELETE FROM pages_fts WHERE page_id = ?1", params![page_id])?;
    tx.execute(
        "INSERT INTO pages_fts (page_id, path, title, body) VALUES (?1, ?2, ?3, ?4)",
        params![
            page_id,
            pf.vault_path.as_str(),
            pf.meta.title.as_deref().unwrap_or(""),
            &pf.body,
        ],
    )?;
    tx.execute(
        "INSERT INTO page_bodies (page_id, body) VALUES (?1, ?2)
         ON CONFLICT(page_id) DO UPDATE SET body = excluded.body",
        params![page_id, &pf.body],
    )?;

    // Clear old derived data for this page
    // block_properties must be deleted before blocks due to FK constraint
    tx.execute(
        "DELETE FROM block_properties WHERE page_id = ?1",
        params![page_id],
    )?;
    tx.execute("DELETE FROM blocks WHERE page_id = ?1", params![page_id])?;
    tx.execute("DELETE FROM links WHERE source_id = ?1", params![page_id])?;
    tx.execute("DELETE FROM tags WHERE page_id = ?1", params![page_id])?;
    tx.execute(
        "DELETE FROM page_properties WHERE page_id = ?1",
        params![page_id],
    )?;
    tx.execute(
        "DELETE FROM canonical_names WHERE page_id = ?1",
        params![page_id],
    )?;

    // Dispatch to derivers
    for deriver in derivers {
        deriver.derive(pf, &page_id, tx)?;
    }

    stats.pages_indexed += 1;
    Ok(())
}

/// Remove pages from the DB that are no longer present on disk.
fn prune_stale_pages(
    tx: &rusqlite::Transaction,
    seen_paths: &HashSet<String>,
    stats: &mut BuildStats,
) -> Result<(), IndexError> {
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
        tx.execute("DELETE FROM pages_fts WHERE page_id = ?1", params![id])?;
        tx.execute("DELETE FROM pages WHERE id = ?1", params![id])?;
        stats.pages_removed += 1;
    }

    Ok(())
}

/// Extract string values from a toml::Value (handles both scalar strings
/// and arrays of strings).
fn toml_value_to_strings(val: &toml::Value) -> Vec<String> {
    match val {
        toml::Value::String(s) => vec![s.clone()],
        toml::Value::Array(items) => items
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod schema_tests {
    use super::*;

    /// Old-shape `pages` table (pre kind/kind_inferred/project columns).
    const OLD_PAGES_SCHEMA: &str = "CREATE TABLE pages (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT, canonical_name TEXT NOT NULL, created_at TEXT, updated_at TEXT, meta_json TEXT NOT NULL, content_hash TEXT NOT NULL, journal_date TEXT)";

    fn pages_columns(conn: &Connection) -> Vec<String> {
        conn.prepare("SELECT name FROM pragma_table_info('pages')")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn pages_table_has_kind_columns() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("test.db");
        let index = VaultIndex::open_bare(&db_path).unwrap();
        let cols = pages_columns(index.connection());
        assert!(cols.contains(&"kind".to_string()));
        assert!(cols.contains(&"kind_inferred".to_string()));
        assert!(cols.contains(&"project".to_string()));
    }

    #[test]
    fn migrates_existing_pages_table_adding_kind_columns() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("old.db");

        // Build a pre-existing DB with the OLD pages schema (no new columns).
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(OLD_PAGES_SCHEMA).unwrap();
            let cols = pages_columns(&conn);
            assert!(!cols.contains(&"kind".to_string()));
            assert!(!cols.contains(&"kind_inferred".to_string()));
            assert!(!cols.contains(&"project".to_string()));
        } // conn dropped/closed here

        // Opening through the real constructor runs the ALTER migration.
        let index = VaultIndex::open_bare(&db_path).unwrap();
        let cols = pages_columns(index.connection());
        assert!(cols.contains(&"kind".to_string()));
        assert!(cols.contains(&"kind_inferred".to_string()));
        assert!(cols.contains(&"project".to_string()));
        drop(index);

        // Re-opening an already-migrated DB is idempotent (no error, columns persist).
        let index = VaultIndex::open_bare(&db_path).unwrap();
        let cols = pages_columns(index.connection());
        assert!(cols.contains(&"kind".to_string()));
        assert!(cols.contains(&"kind_inferred".to_string()));
        assert!(cols.contains(&"project".to_string()));
    }

    #[test]
    fn migrates_existing_fts_bodies_into_the_keyed_projection() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("old.db");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.execute_batch("DROP TABLE page_bodies;").unwrap();
            conn.execute(
                "INSERT INTO pages
                 (id, path, canonical_name, meta_json, content_hash)
                 VALUES ('page-1', 'page.md', 'page', '{}', 'hash')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO pages_fts (page_id, path, title, body)
                 VALUES ('page-1', 'page.md', 'Page', 'legacy body')",
                [],
            )
            .unwrap();
        }

        let index = VaultIndex::open_bare(&db_path).unwrap();
        let body: String = index
            .connection()
            .query_row(
                "SELECT body FROM page_bodies WHERE page_id = 'page-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(body, "legacy body");
    }
}

#[cfg(test)]
mod rubbish_catalog_tests {
    use super::*;
    use crate::vault::rubbish::{RubbishListEntry, RubbishManifest};
    use chrono::{DateTime, Utc};

    fn manifest(
        item_id: &str,
        page_id: &str,
        deleted_at: &str,
        archive_url: Option<&str>,
    ) -> RubbishManifest {
        RubbishManifest::new(
            Uuid::parse_str(item_id).unwrap(),
            Uuid::parse_str(page_id).unwrap(),
            "archive/example.md",
            format!("Item {item_id}"),
            "ARCHIVE",
            deleted_at.parse::<DateTime<Utc>>().unwrap(),
            archive_url.map(str::to_owned),
        )
        .unwrap()
    }

    #[test]
    fn rubbish_catalog_schema_migrates_fresh_and_existing_databases_separately_from_pages() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("existing.db");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch("CREATE TABLE legacy_marker (value TEXT);")
                .unwrap();
        }

        for _ in 0..2 {
            let index = VaultIndex::open_bare(&db_path).unwrap();
            let columns = index
                .connection()
                .prepare("SELECT name FROM pragma_table_info('rubbish_items') ORDER BY cid")
                .unwrap()
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .map(Result::unwrap)
                .collect::<Vec<_>>();
            assert_eq!(
                columns,
                vec![
                    "item_id",
                    "page_id",
                    "original_path",
                    "title",
                    "kind",
                    "deleted_at",
                    "archive_url",
                    "valid",
                    "diagnostic",
                ]
            );
            let foreign_keys: i64 = index
                .connection()
                .query_row(
                    "SELECT count(*) FROM pragma_foreign_key_list('rubbish_items')",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(foreign_keys, 0, "rubbish catalog must not join to pages");
            let legacy_marker: i64 = index
                .connection()
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name = 'legacy_marker'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(legacy_marker, 1);
        }
    }

    #[test]
    fn rubbish_catalog_crud_is_deterministic_and_valid_entries_are_newest_first() {
        let index = VaultIndex::open_in_memory().unwrap();
        let first = RubbishListEntry::Valid(manifest(
            "00000000-0000-4000-8000-000000000001",
            "10000000-0000-4000-8000-000000000001",
            "2026-08-13T12:00:00Z",
            Some("https://example.com/first"),
        ));
        let second = RubbishListEntry::Valid(manifest(
            "00000000-0000-4000-8000-000000000002",
            "10000000-0000-4000-8000-000000000002",
            "2026-08-13T12:00:00Z",
            None,
        ));
        let older = RubbishListEntry::Valid(manifest(
            "00000000-0000-4000-8000-000000000003",
            "10000000-0000-4000-8000-000000000003",
            "2026-08-12T12:00:00Z",
            None,
        ));
        let invalid_b = RubbishListEntry::Invalid {
            item_id: "broken-b".to_owned(),
            error: "diagnostic b".to_owned(),
        };
        let invalid_a = RubbishListEntry::Invalid {
            item_id: "broken-a".to_owned(),
            error: "diagnostic a".to_owned(),
        };

        for entry in [&older, &invalid_b, &second, &invalid_a, &first] {
            index.upsert_rubbish_entry(entry).unwrap();
        }

        assert_eq!(
            index.rubbish_entries().unwrap(),
            vec![
                first.clone(),
                second.clone(),
                older.clone(),
                invalid_a.clone(),
                invalid_b.clone(),
            ]
        );
        assert_eq!(
            index
                .rubbish_entry("00000000-0000-4000-8000-000000000001")
                .unwrap(),
            Some(first.clone())
        );
        assert_eq!(
            index.rubbish_entry("missing").unwrap(),
            None,
            "missing catalog identities are not errors"
        );
        assert!(index.remove_rubbish_entry("broken-a").unwrap());
        assert!(!index.remove_rubbish_entry("broken-a").unwrap());
        assert_eq!(
            index.rubbish_entries().unwrap(),
            vec![first, second, older, invalid_b]
        );
    }

    #[test]
    fn rubbish_catalog_archive_url_lookup_identifies_active_and_rubbish_owners() {
        let index = VaultIndex::open_in_memory().unwrap();
        index
            .connection()
            .execute(
                "INSERT INTO pages
                 (id, path, canonical_name, meta_json, content_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    "10000000-0000-4000-8000-000000000001",
                    "archive/active.md",
                    "active",
                    r#"{"archive":{"url":"https://example.com/active","source_hash":"sha256:active"}}"#,
                    "content"
                ],
            )
            .unwrap();
        let rubbish = RubbishListEntry::Valid(manifest(
            "00000000-0000-4000-8000-000000000001",
            "10000000-0000-4000-8000-000000000002",
            "2026-08-13T12:00:00Z",
            Some("https://example.com/rubbish"),
        ));
        index.upsert_rubbish_entry(&rubbish).unwrap();

        assert_eq!(
            index
                .find_by_archive_url("https://example.com/active")
                .unwrap(),
            Some(ArchiveUrlOwner::Active {
                page_id: "10000000-0000-4000-8000-000000000001".to_owned(),
                path: "archive/active.md".to_owned(),
                source_hash: "sha256:active".to_owned(),
            })
        );
        assert_eq!(
            index
                .find_by_archive_url("https://example.com/rubbish")
                .unwrap(),
            Some(ArchiveUrlOwner::Rubbish {
                item_id: "00000000-0000-4000-8000-000000000001".to_owned(),
                page_id: "10000000-0000-4000-8000-000000000002".to_owned(),
                original_path: "archive/example.md".to_owned(),
            })
        );
    }
}

#[cfg(test)]
mod prop_link_tests {
    use super::*;
    use crate::vault::page::PageMeta;

    #[test]
    fn extracts_tag_and_alias_refs() {
        let mut meta = PageMeta::new();
        meta.tags = vec!["rust".into()];
        meta.aliases = vec!["Alias One".into()];
        let links = extract_prop_links(&meta, &["tags".to_string(), "aliases".to_string()]);
        // Exactly one ref per value (one tag + one alias) — a dropped branch
        // would change this count.
        assert_eq!(links.len(), 2, "expected one ref each for tag and alias");
    }

    #[test]
    fn no_linkable_props_yields_nothing() {
        let meta = PageMeta::new();
        assert!(extract_prop_links(&meta, &[]).is_empty());
    }
}

#[cfg(test)]
mod kind_index_tests {
    use super::*;
    use std::fs;

    /// Create a temp vault dir, write `rel_path` with `content`, open `Vault`
    /// + `VaultIndex`, call `index_page`, and return the index for inspection.
    fn index_one(tmp: &tempfile::TempDir, index: &mut VaultIndex, rel_path: &str, content: &str) {
        let abs = tmp.path().join(rel_path);
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&abs, content).unwrap();

        let vault = Vault::open(tmp.path()).unwrap();
        let vp = VaultPath::new(rel_path).unwrap();
        index.index_page(&vault, &vp).unwrap();
    }

    #[test]
    fn index_persists_resolved_kind_and_inferred_flag() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join(".clepsydra/index.db");
        let mut index = VaultIndex::open_bare(&db_path).unwrap();

        // A page in journals/ with no declared type -> inferred JOURNAL.
        index_one(
            &tmp,
            &mut index,
            "journals/2026-05-31.md",
            "---\nid: 0190f8a0-0000-7000-8000-000000000001\n---\nbody",
        );
        // A page in notes/ with declared type: quote -> declared QUOTE, project set.
        index_one(
            &tmp,
            &mut index,
            "notes/q.md",
            "---\nid: 0190f8a0-0000-7000-8000-000000000002\ntype: quote\nproject: clepsydra\n---\nbody",
        );

        let conn = index.connection();

        let (k1, inf1): (String, i64) = conn
            .query_row(
                "SELECT kind, kind_inferred FROM pages WHERE path = 'journals/2026-05-31.md'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(k1, "JOURNAL");
        assert_eq!(inf1, 1);

        let (k2, inf2, proj): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT kind, kind_inferred, project FROM pages WHERE path = 'notes/q.md'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(k2, "QUOTE");
        assert_eq!(inf2, 0);
        assert_eq!(proj.as_deref(), Some("clepsydra"));
    }

    /// The full-vault scan (`build` -> `upsert_indexed_page`) is a SEPARATE
    /// insert site from `index_page`; this guards both paths against future
    /// divergence on the kind/inferred/project persistence contract.
    #[test]
    fn build_persists_resolved_kind_and_inferred_flag() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join(".clepsydra/index.db");

        // Write fixtures directly into the vault tree (no per-file index call).
        let write = |rel: &str, content: &str| {
            let abs = tmp.path().join(rel);
            fs::create_dir_all(abs.parent().unwrap()).unwrap();
            fs::write(&abs, content).unwrap();
        };
        write(
            "journals/2026-05-31.md",
            "---\nid: 0190f8a0-0000-7000-8000-000000000011\n---\nbody",
        );
        write(
            "notes/q.md",
            "---\nid: 0190f8a0-0000-7000-8000-000000000012\ntype: quote\nproject: clepsydra\n---\nbody",
        );

        // Full build over the populated vault (exercises upsert_indexed_page).
        let mut index = VaultIndex::open_bare(&db_path).unwrap();
        let vault = Vault::open(tmp.path()).unwrap();
        index.build(&vault).unwrap();

        let conn = index.connection();

        let (k1, inf1): (String, i64) = conn
            .query_row(
                "SELECT kind, kind_inferred FROM pages WHERE path = 'journals/2026-05-31.md'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(k1, "JOURNAL");
        assert_eq!(inf1, 1);

        let (k2, inf2, proj): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT kind, kind_inferred, project FROM pages WHERE path = 'notes/q.md'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(k2, "QUOTE");
        assert_eq!(inf2, 0);
        assert_eq!(proj.as_deref(), Some("clepsydra"));
    }

    #[test]
    fn build_persists_word_count() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join(".clepsydra/index.db");

        let abs = tmp.path().join("notes/wc.md");
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        // Frontmatter is stripped before counting; the body has five words.
        fs::write(
            &abs,
            "---\nid: 0190f8a0-0000-7000-8000-000000000013\n---\none two three four five",
        )
        .unwrap();

        let mut index = VaultIndex::open_bare(&db_path).unwrap();
        let vault = Vault::open(tmp.path()).unwrap();
        index.build(&vault).unwrap();

        let wc: Option<i64> = index
            .connection()
            .query_row(
                "SELECT word_count FROM pages WHERE path = 'notes/wc.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(wc, Some(5));
    }

    /// The on-disk index owns the vault: building it heals a page that has no
    /// frontmatter, writing the generated id and timestamps back to the file.
    /// This is `clep serve`/CLI behaviour and must not change — it is the
    /// counterpart to `in_memory_build_never_writes_repaired_frontmatter`.
    #[test]
    fn build_repairs_frontmatter_on_disk() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let page = root.join("Loose.md");
        fs::write(&page, "# Loose\n\nbody\n").unwrap();

        let vault = Vault::open(&root).unwrap();
        let mut index = VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
        index.build(&vault).unwrap();

        let repaired = fs::read_to_string(&page).unwrap();
        assert!(
            repaired.starts_with("+++"),
            "serve-side build must write repaired frontmatter: {repaired:?}"
        );
        assert!(repaired.contains("id = "), "repair must persist an id");
        assert!(
            repaired.contains("created_at = "),
            "repair must persist created_at"
        );
    }

    #[cfg(unix)]
    #[test]
    fn build_repair_write_failure_preserves_page_and_reports_warning() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let page = root.join("Loose.md");
        let original = "# Loose\n\nbody\n";
        fs::write(&page, original).unwrap();
        fs::set_permissions(&page, fs::Permissions::from_mode(0o400)).unwrap();

        let vault = Vault::open(&root).unwrap();
        let mut index = VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
        let stats = index.build(&vault).unwrap();

        fs::set_permissions(&page, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(fs::read_to_string(&page).unwrap(), original);
        assert!(
            stats
                .warnings
                .iter()
                .any(|warning| warning.contains("cannot rewrite frontmatter in Loose.md")),
            "repair publication failure must remain actionable: {:?}",
            stats.warnings
        );
    }

    /// The in-memory index is read-only: the same page is indexed with the
    /// repaired metadata, but the file on disk keeps its exact bytes.
    #[test]
    fn in_memory_build_never_writes_repaired_frontmatter() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let page = root.join("Loose.md");
        let original = "# Loose\n\nbody\n";
        fs::write(&page, original).unwrap();

        let vault = Vault::open(&root).unwrap();
        let mut index = VaultIndex::open_in_memory().unwrap();
        index.build(&vault).unwrap();

        assert_eq!(
            fs::read_to_string(&page).unwrap(),
            original,
            "in-memory build must leave the file byte-identical"
        );
        // ...and the repaired page is still indexed, with the generated id.
        let id: String = index
            .connection()
            .query_row("SELECT id FROM pages WHERE path = 'Loose.md'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(!id.is_empty());
    }

    #[test]
    fn open_in_memory_builds_and_queries() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        std::fs::write(root.join("Note.md"), "# Note\n\nbody\n").unwrap();

        let vault = crate::vault::Vault::open(&root).unwrap();
        let mut index = VaultIndex::open_in_memory().unwrap();
        index.build(&vault).unwrap();
        index.resolve_links().unwrap();

        // Assert that the page was indexed by checking its path in the pages table
        let page_path: String = index
            .connection()
            .query_row("SELECT path FROM pages WHERE path = 'Note.md'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(page_path, "Note.md");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn search_index() -> VaultIndex {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(
            root.join("notes/stray.md"),
            "# Clepsydra: Stray Thoughts\n\nIdeas gathered between sessions.\n",
        )
        .unwrap();
        fs::write(
            root.join("notes/clepsydra.md"),
            "# Clepsydra Handbook\n\nReference notes for the project.\n",
        )
        .unwrap();
        fs::write(
            root.join("notes/unicode.md"),
            "# Élan vital\n\nA Unicode search fixture.\n",
        )
        .unwrap();

        let vault = Vault::open(&root).unwrap();
        let mut index = VaultIndex::open_in_memory().unwrap();
        index.build(&vault).unwrap();
        index
    }

    fn assert_paths(results: Vec<SearchResult>, expected: &[&str]) {
        let mut paths = results
            .into_iter()
            .map(|result| result.path)
            .collect::<Vec<_>>();
        let mut expected = expected
            .iter()
            .map(|path| (*path).to_owned())
            .collect::<Vec<_>>();
        paths.sort();
        expected.sort();
        assert_eq!(paths, expected);
    }

    #[test]
    fn search_prefixes_human_tokens() {
        let index = search_index();

        assert_paths(
            index.search("clep", 20).unwrap(),
            &["notes/stray.md", "notes/clepsydra.md"],
        );
        assert_paths(
            index.search("clepsydra", 20).unwrap(),
            &["notes/stray.md", "notes/clepsydra.md"],
        );
        assert_paths(
            index.search("Clepsydra: Stray", 20).unwrap(),
            &["notes/stray.md"],
        );
    }

    #[test]
    fn search_treats_fts_punctuation_as_inert_separators() {
        let index = search_index();

        assert!(index.search(": OR *", 20).is_ok());
        assert!(index.search("", 20).unwrap().is_empty());
        assert!(index.search("---", 20).unwrap().is_empty());
    }

    #[test]
    fn search_preserves_multi_token_and_unicode_prefixes() {
        let index = search_index();

        assert_paths(index.search("clep stray", 20).unwrap(), &["notes/stray.md"]);
        assert_paths(index.search("Éla", 20).unwrap(), &["notes/unicode.md"]);
    }
}

#[cfg(test)]
mod property_derivation_tests {
    use super::*;

    fn open_vault_with(pages: &[(&str, &str)]) -> (tempfile::TempDir, Vault, VaultIndex) {
        let tmp = tempfile::tempdir().unwrap();
        for (rel, content) in pages {
            let abs = tmp.path().join(rel);
            fs::create_dir_all(abs.parent().unwrap()).unwrap();
            fs::write(&abs, content).unwrap();
        }
        let db_path = tmp.path().join(".clepsydra/index.db");
        let mut index = VaultIndex::open(&db_path).unwrap();
        let vault = Vault::open(tmp.path()).unwrap();
        index.build(&vault).unwrap();
        (tmp, vault, index)
    }

    const BOOK: &str = "+++\nid = \"0190f8a0-0000-7000-8000-0000000000f1\"\ntitle = \"Book\"\nauthor = \"Gene Wolfe\"\nrating = 4.5\npages = 371\ndone = false\nstarted = 2026-07-30\nthemes = [\"memory\", \"identity\"]\n\n[archive]\nurl = \"https://x\"\n+++\nbody\n";

    #[test]
    fn build_projects_mixed_extras_into_page_properties() {
        let (_tmp, _vault, index) = open_vault_with(&[("book.md", BOOK)]);
        let conn = index.connection();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM page_properties", [], |r| r.get(0))
            .unwrap();
        // author, rating, pages, done, started, themes x2, archive = 8 rows.
        assert_eq!(count, 8);

        let rating: f64 = conn
            .query_row(
                "SELECT value_num FROM page_properties WHERE key = 'rating'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rating, 4.5);

        let started: String = conn
            .query_row(
                "SELECT value_date FROM page_properties WHERE key = 'started'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(started, "2026-07-30");

        let themes: Vec<(i64, String)> = conn
            .prepare(
                "SELECT ord, value_text FROM page_properties WHERE key = 'themes' ORDER BY ord",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            themes,
            vec![(0, "memory".to_string()), (1, "identity".to_string())]
        );

        let (archive_text, archive_json): (Option<String>, String) = conn
            .query_row(
                "SELECT value_text, value_json FROM page_properties WHERE key = 'archive'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(archive_text, None, "tables are opaque");
        assert!(archive_json.contains("https://x"));
    }

    #[test]
    fn rebuild_after_key_removal_deletes_its_rows() {
        let (tmp, vault, mut index) = open_vault_with(&[("book.md", BOOK)]);

        // Rewrite the page without `rating` (and with a changed value elsewhere).
        let trimmed = BOOK.replace("rating = 4.5\n", "");
        fs::write(tmp.path().join("book.md"), trimmed).unwrap();
        index
            .index_page(&vault, &VaultPath::new("book.md").unwrap())
            .unwrap();

        let conn = index.connection();
        let rating_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM page_properties WHERE key = 'rating'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rating_rows, 0, "stale rows must be cleared on rebuild");

        let author_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM page_properties WHERE key = 'author'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(author_rows, 1, "surviving keys re-derive exactly once");
    }

    #[test]
    fn page_removal_cascades_property_rows() {
        let (_tmp, _vault, mut index) = open_vault_with(&[("book.md", BOOK)]);
        index
            .remove_page(&VaultPath::new("book.md").unwrap())
            .unwrap();
        let count: i64 = index
            .connection()
            .query_row("SELECT COUNT(*) FROM page_properties", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "ON DELETE CASCADE must clear property rows");
    }

    #[test]
    fn typed_projection_indexes_exist() {
        let tmp = tempfile::tempdir().unwrap();
        let index = VaultIndex::open(&tmp.path().join("i.db")).unwrap();
        let names: Vec<String> = index
            .connection()
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'page_properties'")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        for expected in [
            "idx_page_props_key_text",
            "idx_page_props_key_num",
            "idx_page_props_key_date",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
    }

    #[test]
    fn forward_migration_adds_table_to_preexisting_db() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("old.db");

        // Simulate a pre-bases DB: full current schema minus page_properties.
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.execute_batch("DROP TABLE page_properties;").unwrap();
        }

        let index = VaultIndex::open(&db_path).unwrap();
        let present: i64 = index
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'page_properties'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(present, 1, "open must add page_properties to an old DB");
    }
}

#[cfg(test)]
mod linkable_epoch_tests {
    use super::*;
    use crate::vault::base::{BaseRegistry, effective_linkable_properties, linkable_epoch};

    const SERIES_PAGE: &str = "+++\nid = \"0190f8a0-0000-7000-8000-0000000000e1\"\ntitle = \"Book\"\nseries = [\"[[Solar Cycle]]\"]\n+++\nbody\n";
    const SERIES_BASE: &str =
        "name = \"Reading\"\n\n[properties]\nseries = { type = \"relation\" }\n";

    fn setup(with_base: bool) -> (tempfile::TempDir, Vault, VaultIndex) {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("book.md"), SERIES_PAGE).unwrap();
        if with_base {
            fs::create_dir_all(tmp.path().join("bases")).unwrap();
            fs::write(tmp.path().join("bases/reading.base.toml"), SERIES_BASE).unwrap();
        }
        let index = VaultIndex::open(&tmp.path().join(".clepsydra/index.db")).unwrap();
        let vault = Vault::open(tmp.path()).unwrap();
        (tmp, vault, index)
    }

    fn series_link_count(index: &VaultIndex) -> i64 {
        index
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM links WHERE source_field = 'series'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[test]
    fn registry_loads_bases_and_effective_set_unions_config() {
        let (tmp, vault, _index) = setup(true);
        let registry = BaseRegistry::load(tmp.path());
        assert_eq!(registry.bases.len(), 1);
        assert_eq!(registry.bases[0].slug, "reading");
        assert_eq!(registry.relation_property_keys(), vec!["series"]);

        let effective =
            effective_linkable_properties(&vault.config().vault.linkable_properties, &registry);
        assert!(effective.contains(&"tags".to_string()));
        assert!(effective.contains(&"series".to_string()));
        // Union is deduped even when config already carries the key.
        let mut with_dup = vault.config().vault.linkable_properties.clone();
        with_dup.push("series".to_string());
        let deduped = effective_linkable_properties(&with_dup, &registry);
        assert_eq!(
            deduped.iter().filter(|k| *k == "series").count(),
            1,
            "duplicate keys collapse"
        );
    }

    #[test]
    fn derivation_meta_created_and_epoch_written_by_build() {
        let (_tmp, vault, mut index) = setup(false);
        index.build(&vault).unwrap();
        let epoch: String = index
            .connection()
            .query_row(
                "SELECT value FROM derivation_meta WHERE key = 'linkable_epoch'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(epoch.len(), 64);
        assert_eq!(
            epoch,
            linkable_epoch(&vault.config().vault.linkable_properties)
        );
    }

    #[test]
    fn epoch_mismatch_rederives_unchanged_page_links() {
        // Build once WITHOUT the base: `series` is not linkable, no link rows.
        let (tmp, vault, mut index) = setup(false);
        index.build(&vault).unwrap();
        assert_eq!(series_link_count(&index), 0);

        // Add the base declaring `series = relation`. The page file itself is
        // untouched — without the epoch check, skip-unchanged would silently
        // keep its stale link set.
        fs::create_dir_all(tmp.path().join("bases")).unwrap();
        fs::write(tmp.path().join("bases/reading.base.toml"), SERIES_BASE).unwrap();

        let stats = index.build(&vault).unwrap();
        assert_eq!(stats.pages_skipped, 0, "epoch mismatch must bypass skip");
        assert_eq!(
            series_link_count(&index),
            1,
            "unchanged page's series link must appear after the epoch rebuild"
        );

        // Epoch is now stable: the next build skips unchanged pages again.
        let stats = index.build(&vault).unwrap();
        assert!(stats.pages_skipped >= 1, "no-op rebuild must skip");
        assert_eq!(series_link_count(&index), 1);
    }
}
