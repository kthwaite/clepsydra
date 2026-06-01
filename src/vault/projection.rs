//! Conservative folder projection: compute a page's expected path from its
//! *declared* kind/project. Absent fields never relocate a page.
//! See docs/adr/0001-metadata-projected-folder-layout.md.

use super::kind::Kind;

/// Expected path for `current` given declared metadata, or `None` if the page
/// is already where its declared metadata projects it (no move needed).
pub fn project_path(
    current: &str,
    declared_kind: Option<Kind>,
    declared_project: Option<&str>,
) -> Option<String> {
    let trimmed = current.trim_start_matches('/');
    let comps: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    let filename = (*comps.last()?).to_string();
    let dirs = &comps[..comps.len() - 1];

    let current_top = dirs.first().copied();
    let current_sub = if dirs.len() >= 2 {
        Some(dirs[1..].join("/"))
    } else {
        None
    };

    // Declared kind forces the top folder; absent keeps the current one.
    let expected_top = match declared_kind {
        Some(k) => Some(k.canonical_folder().to_string()),
        None => current_top.map(str::to_string),
    };
    // Declared project forces the subfolder; absent keeps the current one.
    let expected_sub = match declared_project {
        Some(p) => Some(p.to_string()),
        None => current_sub,
    };

    let mut expected = String::new();
    if let Some(t) = &expected_top {
        expected.push_str(t);
        expected.push('/');
    }
    if let Some(s) = &expected_sub {
        expected.push_str(s);
        expected.push('/');
    }
    expected.push_str(&filename);

    if expected == trimmed {
        None
    } else {
        Some(expected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declared_kind_moves_to_canonical_folder() {
        assert_eq!(
            project_path("projects/x.md", Some(Kind::Quote), None).as_deref(),
            Some("quotes/x.md")
        );
    }
    #[test]
    fn already_consistent_returns_none() {
        assert_eq!(project_path("quotes/x.md", Some(Kind::Quote), None), None);
        assert_eq!(project_path("notes/clep/x.md", None, Some("clep")), None);
    }
    #[test]
    fn absent_project_never_strips_subfolder() {
        // The conservative invariant: no declared project => leave the subfolder alone.
        assert_eq!(project_path("notes/clep/x.md", None, None), None);
    }
    #[test]
    fn declared_project_adds_subfolder() {
        assert_eq!(
            project_path("notes/x.md", None, Some("clep")).as_deref(),
            Some("notes/clep/x.md")
        );
    }
    #[test]
    fn kind_and_project_together() {
        assert_eq!(
            project_path("notes/x.md", Some(Kind::Quote), Some("clep")).as_deref(),
            Some("quotes/clep/x.md")
        );
    }
    #[test]
    fn root_level_file_with_declared_kind() {
        assert_eq!(
            project_path("x.md", Some(Kind::Note), None).as_deref(),
            Some("notes/x.md")
        );
        assert_eq!(project_path("x.md", None, None), None);
    }
}
