use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Strategy for ranking candidates when a link is ambiguous.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisambiguationStrategy {
    /// Prefer the page with the shortest vault-relative path.
    #[default]
    ShortestPath,
    /// Prefer the page closest in directory hierarchy to the source page.
    ClosestDirectory,
    /// Prefer the most recently updated page.
    MostRecent,
}

/// Configuration read from `.clepsydra/config.toml` inside a vault root.
///
/// Every field carries sensible defaults so that a missing or empty config file
/// still yields a usable configuration.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct VaultConfig {
    #[serde(default)]
    pub vault: VaultSection,
    #[serde(default)]
    pub academic: AcademicSection,
    #[serde(default)]
    pub archive: ArchiveSection,
    #[serde(default)]
    pub sync: SyncSection,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VaultSection {
    #[serde(default = "default_attachment_folder")]
    pub attachment_folder: String,
    #[serde(default = "default_excluded_patterns")]
    pub excluded_patterns: Vec<String>,
    #[serde(default)]
    pub default_page_folder: String,
    #[serde(default = "default_linkable_properties")]
    pub linkable_properties: Vec<String>,
    #[serde(default)]
    pub disambiguation_strategy: DisambiguationStrategy,
    /// Obsidian vault names accepted by obsidian:// compat links, in addition
    /// to the basename of the vault root.
    #[serde(default)]
    pub obsidian_vault_aliases: Vec<String>,
}

impl Default for VaultSection {
    fn default() -> Self {
        Self {
            attachment_folder: default_attachment_folder(),
            excluded_patterns: default_excluded_patterns(),
            default_page_folder: String::new(),
            linkable_properties: default_linkable_properties(),
            disambiguation_strategy: DisambiguationStrategy::default(),
            obsidian_vault_aliases: Vec::new(),
        }
    }
}

fn default_attachment_folder() -> String {
    "_attachments".to_string()
}

fn default_excluded_patterns() -> Vec<String> {
    vec![
        ".clepsydra".to_string(),
        ".clepsydra/**".to_string(),
        "_attachments".to_string(),
        "_attachments/**".to_string(),
        ".git".to_string(),
        ".git/**".to_string(),
        "node_modules".to_string(),
        "node_modules/**".to_string(),
        // Base definitions are registry files, not pages.
        "bases".to_string(),
        "bases/**".to_string(),
    ]
}

fn default_linkable_properties() -> Vec<String> {
    vec![
        "tags".to_string(),
        "aliases".to_string(),
        "link".to_string(),
        // The MEETING attendee relation: linkable by default so a person page
        // collects the backlinks for every meeting naming them.
        crate::vault::attendance::ATTENDEES_KEY.to_string(),
    ]
}

/// Configuration for the academic library subsystem.
#[derive(Debug, Clone, Deserialize)]
pub struct AcademicSection {
    #[serde(default = "default_library_folder")]
    pub library_folder: String,
    #[serde(default = "default_papers_folder")]
    pub papers_folder: String,
    #[serde(default = "default_books_folder")]
    pub books_folder: String,
    #[serde(default = "default_annotations_folder")]
    pub annotations_folder: String,
    #[serde(default)]
    pub zotero: ZoteroSection,
}

impl Default for AcademicSection {
    fn default() -> Self {
        Self {
            library_folder: default_library_folder(),
            papers_folder: default_papers_folder(),
            books_folder: default_books_folder(),
            annotations_folder: default_annotations_folder(),
            zotero: ZoteroSection::default(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ZoteroSection {
    /// Path to zotero.sqlite. If `None`, auto-detect from platform default.
    #[serde(default)]
    pub database_path: Option<String>,
}

fn default_library_folder() -> String {
    "library".to_string()
}

fn default_papers_folder() -> String {
    "library/papers".to_string()
}

fn default_books_folder() -> String {
    "library/books".to_string()
}

fn default_annotations_folder() -> String {
    "library/annotations".to_string()
}

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

fn default_archive_enabled() -> bool {
    true
}

fn default_cas_path() -> String {
    ".clepsydra/cas".to_string()
}

/// Resolve `[archive].cas_path` to an absolute directory. `~` and `~/…`
/// expand to the home directory, an absolute path is used as-is, and any
/// other path is relative to the vault root — so the default
/// `.clepsydra/cas` lands inside the vault (ADR 0005). A blank value means
/// "the default": `vault_root.join("")` would otherwise make the vault root
/// itself the blob store.
pub fn resolve_cas_path(raw: &str, vault_root: &Path) -> PathBuf {
    let raw = raw.trim();
    if raw.is_empty() {
        return vault_root.join(default_cas_path());
    }
    if let Some(expanded) = crate::expand_tilde(raw) {
        return expanded;
    }
    let path = Path::new(raw);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        vault_root.join(path)
    }
}

fn default_archive_path_prefix() -> String {
    "archive".to_string()
}

fn default_max_blob_size_mb() -> u64 {
    // Matches gwern's `--max-resource-size 100`. A media-heavy capture inlines
    // tens of megabytes and base64 adds a third.
    100
}

fn default_max_request_size_mb() -> u64 {
    // One page carrying several large resources, plus base64 overhead.
    250
}

fn default_gc_min_age_days() -> u32 {
    30
}

/// `[sync]` — git-backed vault synchronisation (spec §4).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct SyncSection {
    /// Seconds of quiet after the last mutation before the server commits.
    #[serde(default = "default_autocommit_debounce_secs")]
    pub autocommit_debounce_secs: u64,
    /// Seconds between scheduled full syncs; `0` disables the schedule.
    #[serde(default)]
    pub interval_secs: u64,
    /// The single synced branch.
    #[serde(default = "default_sync_branch")]
    pub branch: String,
    #[serde(default)]
    pub author_name: Option<String>,
    #[serde(default)]
    pub author_email: Option<String>,
}

impl Default for SyncSection {
    fn default() -> Self {
        Self {
            autocommit_debounce_secs: default_autocommit_debounce_secs(),
            interval_secs: 0,
            branch: default_sync_branch(),
            author_name: None,
            author_email: None,
        }
    }
}

fn default_autocommit_debounce_secs() -> u64 {
    300
}

fn default_sync_branch() -> String {
    "main".to_string()
}

impl VaultConfig {
    /// Load vault configuration from `.clepsydra/config.toml` under the given
    /// vault root. Returns defaults if the file does not exist.
    pub fn load(vault_root: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let config_path = vault_root.join(".clepsydra/config.toml");
        if !config_path.exists() {
            return Ok(Self::default());
        }
        let contents = std::fs::read_to_string(&config_path)?;
        let config: VaultConfig = toml::from_str(&contents)?;
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn archive_config_defaults() {
        let config = VaultConfig::default();
        assert!(config.archive.enabled);
        assert_eq!(config.archive.cas_path, ".clepsydra/cas");
        assert_eq!(config.archive.default_path_prefix, "archive");
        assert_eq!(config.archive.max_blob_size_mb, 100);
        assert_eq!(config.archive.max_request_size_mb, 250);
        assert_eq!(config.archive.gc_min_age_days, 30);
    }

    #[test]
    fn resolve_cas_path_rules() {
        let root = Path::new("/vaults/main");
        assert_eq!(
            resolve_cas_path(".clepsydra/cas", root),
            PathBuf::from("/vaults/main/.clepsydra/cas")
        );
        assert_eq!(
            resolve_cas_path("cas-here", root),
            PathBuf::from("/vaults/main/cas-here")
        );
        // blank / whitespace means the default, never the vault root itself
        assert_eq!(
            resolve_cas_path("", root),
            PathBuf::from("/vaults/main/.clepsydra/cas")
        );
        assert_eq!(
            resolve_cas_path("  ", root),
            PathBuf::from("/vaults/main/.clepsydra/cas")
        );
        assert_eq!(
            resolve_cas_path("/abs/cas", root),
            PathBuf::from("/abs/cas")
        );
        let home = dirs::home_dir().expect("home dir in tests");
        assert_eq!(
            resolve_cas_path("~/.clepsydra/cas", root),
            home.join(".clepsydra/cas")
        );
        assert_eq!(resolve_cas_path("~", root), home);
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
        )
        .unwrap();

        let config = VaultConfig::load(vault_root).unwrap();
        assert!(!config.archive.enabled);
        assert_eq!(config.archive.cas_path, "/custom/cas");
        assert_eq!(config.archive.max_blob_size_mb, 200);
        // Unset fields keep defaults
        assert_eq!(config.archive.default_path_prefix, "archive");
    }

    #[test]
    fn vault_section_defaults() {
        let config = VaultConfig::default();
        assert_eq!(
            config.vault.linkable_properties,
            vec!["tags", "aliases", "link", "attendees"]
        );
    }

    #[test]
    fn zotero_config_defaults() {
        let config = VaultConfig::default();
        assert!(config.academic.zotero.database_path.is_none());
    }

    #[test]
    fn zotero_config_from_toml() {
        let tmp = TempDir::new().unwrap();
        let vault_root = tmp.path();
        fs::create_dir_all(vault_root.join(".clepsydra")).unwrap();
        fs::write(
            vault_root.join(".clepsydra/config.toml"),
            r#"
[academic.zotero]
database_path = "/custom/path/zotero.sqlite"
"#,
        )
        .unwrap();

        let config = VaultConfig::load(vault_root).unwrap();
        assert_eq!(
            config.academic.zotero.database_path.as_deref(),
            Some("/custom/path/zotero.sqlite")
        );
    }

    #[test]
    fn root_feeds_manifest_is_excluded_independently_of_configured_patterns() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".clepsydra")).unwrap();
        fs::write(
            tmp.path().join(".clepsydra/config.toml"),
            "[vault]\nexcluded_patterns = [\"private\", \"private/**\"]\n",
        )
        .unwrap();

        let vault = crate::vault::Vault::open(tmp.path()).unwrap();

        assert!(vault.is_excluded(&crate::vault::path::VaultPath::new("feeds.md").unwrap()));
        assert!(
            !vault.is_excluded(&crate::vault::path::VaultPath::new("notes/feeds.md").unwrap()),
            "only the reserved root manifest is unconditional"
        );
        assert!(vault.is_excluded(&crate::vault::path::VaultPath::new("private/page.md").unwrap()));
    }

    #[test]
    fn sync_config_defaults() {
        let config = VaultConfig::default();
        assert_eq!(config.sync.autocommit_debounce_secs, 300);
        assert_eq!(config.sync.interval_secs, 0);
        assert_eq!(config.sync.branch, "main");
        assert!(config.sync.author_name.is_none());
        assert!(config.sync.author_email.is_none());
    }

    #[test]
    fn sync_config_parses_partial_section() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".clepsydra")).unwrap();
        fs::write(
            tmp.path().join(".clepsydra/config.toml"),
            "[sync]\nbranch = \"trunk\"\nauthor_name = \"Kit\"\nauthor_email = \"kit@example.com\"\n",
        )
        .unwrap();
        let config = VaultConfig::load(tmp.path()).unwrap();
        assert_eq!(config.sync.branch, "trunk");
        assert_eq!(config.sync.autocommit_debounce_secs, 300);
        assert_eq!(config.sync.author_name.as_deref(), Some("Kit"));
        assert_eq!(config.sync.author_email.as_deref(), Some("kit@example.com"));
    }
}
