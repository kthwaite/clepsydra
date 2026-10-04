//! Board vocabulary shared by the API layer and the vault history snapshotter.

pub const DEFAULT_STATUS: &str = "INTAKE";
pub const DEFAULT_PRIORITY: &str = "P2";

/// The Task frontmatter key that lists the Task's Blockers, as wikilinks to
/// their codes (`blocked_by = ["[[TSK-brave-finch-7q3zd]]"]`). A built-in
/// relation property, so each entry is a backlink on the Blocker's page.
pub const BLOCKED_BY_KEY: &str = "blocked_by";
