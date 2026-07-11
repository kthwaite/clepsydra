//! Pure helpers for the `references` request.
use std::path::Path;

use tower_lsp::lsp_types::Url;

use crate::vault::path::VaultPath;

/// Resolve a vault path to a `file://` URL against the vault root.
/// Returns `None` if the absolute path is not representable as a URL.
pub(crate) fn vault_path_to_uri(vault_root: &Path, vp: &VaultPath) -> Option<Url> {
    Url::from_file_path(vault_root.join(vp.as_str())).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_uri_for_relative_path() {
        let vp = VaultPath::new("notes/A.md").unwrap();
        let uri = vault_path_to_uri(Path::new("/vault"), &vp).unwrap();
        assert!(uri.path().ends_with("notes/A.md"));
    }
}
