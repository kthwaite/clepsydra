//! Pure helpers for the `references` request.
use std::path::Path;

use tower_lsp::lsp_types::{Location, Range, Url};

use crate::vault::path::VaultPath;

/// Resolve a vault path to a `file://` URL against the vault root.
/// Returns `None` if the absolute path is not representable as a URL.
pub(crate) fn vault_path_to_uri(vault_root: &Path, vp: &VaultPath) -> Option<Url> {
    Url::from_file_path(vault_root.join(vp.as_str())).ok()
}

/// Build a `Location` for a vault path + range, resolving the path against the
/// vault root. Returns `None` if the absolute path is not representable as a
/// `file://` URL.
///
/// Paired with `vault_path_to_uri` for LSP handlers that already have a
/// precomputed `Range`. The current backlinks path computes the range *after*
/// it has the URI (async), so it calls `vault_path_to_uri` directly; this
/// wrapper is kept for future handlers that have a synchronous range in hand.
#[allow(dead_code)]
pub(crate) fn vault_path_to_location(
    vault_root: &Path,
    vp: &VaultPath,
    range: Range,
) -> Option<Location> {
    Some(Location {
        uri: vault_path_to_uri(vault_root, vp)?,
        range,
    })
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

    #[test]
    fn builds_location_for_relative_path() {
        let vp = VaultPath::new("notes/A.md").unwrap();
        let loc = vault_path_to_location(Path::new("/vault"), &vp, Range::default()).unwrap();
        assert!(loc.uri.path().ends_with("notes/A.md"));
    }
}
