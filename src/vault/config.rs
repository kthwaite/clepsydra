use std::path::Path;

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
}

impl Default for VaultSection {
    fn default() -> Self {
        Self {
            attachment_folder: default_attachment_folder(),
            excluded_patterns: default_excluded_patterns(),
            default_page_folder: String::new(),
            linkable_properties: default_linkable_properties(),
            disambiguation_strategy: DisambiguationStrategy::default(),
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
    ]
}

fn default_linkable_properties() -> Vec<String> {
    vec!["tags".to_string(), "aliases".to_string()]
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
    "~/.clepsydra/cas".to_string()
}

fn default_archive_path_prefix() -> String {
    "archive".to_string()
}

fn default_max_blob_size_mb() -> u64 {
    50
}

fn default_max_request_size_mb() -> u64 {
    100
}

fn default_gc_min_age_days() -> u32 {
    30
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
}
