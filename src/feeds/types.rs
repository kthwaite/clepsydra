#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestFeed {
    pub url: String,
    pub title_override: Option<String>,
    pub group: String,
    pub tags: Vec<String>,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestWarning {
    pub line: usize,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Manifest {
    pub feeds: Vec<ManifestFeed>,
    pub warnings: Vec<ManifestWarning>,
}
