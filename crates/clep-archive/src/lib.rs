//! Content-addressed storage for archived page attachments, and the vault
//! hooks and one-time migrations that keep it consistent with page frontmatter.

pub mod archive_backfill;
pub mod archive_hook;
pub mod archive_snapshot;
pub mod cas;
pub mod cas_migrate;
pub mod cas_scan;
