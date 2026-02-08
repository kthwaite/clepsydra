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
}

impl Default for AcademicSection {
    fn default() -> Self {
        Self {
            library_folder: default_library_folder(),
            papers_folder: default_papers_folder(),
            books_folder: default_books_folder(),
            annotations_folder: default_annotations_folder(),
        }
    }
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
