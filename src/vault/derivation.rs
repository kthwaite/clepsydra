use std::path::PathBuf;

use rusqlite::Connection;

use super::block::Block;
use super::canonical::CanonicalName;
use super::index::IndexError;
use super::link::Link;
use super::page::PageMeta;
use super::path::VaultPath;

/// The parsed, normalized representation of a single page, ready for derivation.
///
/// Produced by the index builder's parse phase and consumed by each [`Deriver`].
/// This struct is the shared contract between the index builder and all derivers.
pub struct IndexedPage {
    /// Vault-relative path to the page.
    pub vault_path: VaultPath,
    /// Parsed frontmatter metadata.
    pub meta: PageMeta,
    /// Markdown body (after frontmatter).
    pub body: String,
    /// Whether body-derived projections must be suppressed.
    pub encrypted: bool,
    /// Original body bytes, retained only for full-file frontmatter rewrites.
    pub(crate) raw_body: String,
    /// blake3 hash of the full file content.
    pub content_hash: String,
    /// Links extracted from the markdown body.
    pub body_links: Vec<Link>,
    /// Links extracted from frontmatter properties (tags, aliases, custom).
    pub prop_links: Vec<Link>,
    /// Canonical name derived from title or filename.
    pub canonical: CanonicalName,
    /// Blocks extracted from the markdown body.
    pub blocks: Vec<Block>,
    /// Absolute filesystem path. Used during UUID conflict resolution; not
    /// consumed by derivers.
    pub(crate) abs_path: PathBuf,
}

/// A composable unit of index derivation.
///
/// Implementors produce derived artifacts (canonical names, links, tags, etc.)
/// from a parsed [`IndexedPage`] and persist them within a SQLite transaction.
///
/// The index builder calls [`Deriver::derive`] once per page per build cycle,
/// after upserting the page row and clearing stale derived data. Derivers MUST
/// be idempotent: the builder deletes old derived rows before calling derivers,
/// so each call produces the complete set of derived rows for that page.
pub trait Deriver: Send + Sync {
    /// Human-readable name for logging and diagnostics.
    fn name(&self) -> &str;

    /// Derive artifacts for a single page and persist them in the transaction.
    ///
    /// `page_id` is the stringified UUID of the page (already inserted into
    /// the `pages` table). The deriver should INSERT rows into its target
    /// table(s) within `tx`.
    fn derive(
        &self,
        page: &IndexedPage,
        page_id: &str,
        conn: &Connection,
    ) -> Result<(), IndexError>;
}
