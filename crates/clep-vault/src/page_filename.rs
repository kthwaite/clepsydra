//! The single source of truth for an authored page's filename shape:
//! `<yyyymmdd>.<title-slug>.<shortid>.md`. See docs/adr/0002.

use chrono::{DateTime, Utc};

use super::path::slugify_title;

/// Maximum length of the title slug segment.
const SLUG_MAX: usize = 40;

/// Build a canonical page filename (no folder) from a creation timestamp,
/// title, and pre-generated short id.
pub fn page_filename(created: DateTime<Utc>, title: &str, short_id: &str) -> String {
    let date = created.format("%Y%m%d");
    let slug = slugify_title(title, SLUG_MAX);
    format!("{date}.{slug}.{short_id}.md")
}

/// Extract a journal date from a `journals/` or `ai-journals/` path, in
/// either the legacy `<prefix>/YYYY-MM-DD.md` or the canonical
/// `<prefix>/<yyyymmdd>.YYYY-MM-DD.<shortid>.md` shape.
///
/// Returns `Some("YYYY-MM-DD")` if the path matches, `None` otherwise.
/// Only matches the top-level prefix — e.g. `other/journals/2026-02-17.md`
/// is rejected.
pub fn extract_journal_date(path: &str) -> Option<String> {
    let filename = path
        .strip_prefix("journals/")
        .or_else(|| path.strip_prefix("ai-journals/"))?;
    let stem = filename.strip_suffix(".md").unwrap_or(filename);
    let candidate = if stem.len() == 10 {
        stem
    } else if super::path::is_canonical_page_filename(filename) {
        stem.split('.').nth(1)?
    } else {
        return None;
    };

    // Validate YYYY-MM-DD shape (exactly 10 chars, correct punctuation, all digits).
    if candidate.len() != 10 {
        return None;
    }
    let bytes = candidate.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    for &i in &[0, 1, 2, 3, 5, 6, 8, 9] {
        if !bytes[i].is_ascii_digit() {
            return None;
        }
    }
    Some(candidate.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn builds_dotted_filename() {
        let created = Utc.with_ymd_and_hms(2026, 5, 31, 12, 0, 0).unwrap();
        let name = page_filename(created, "Redesign Retro", "3kF9a2bQ");
        assert_eq!(name, "20260531.redesign-retro.3kF9a2bQ.md");
    }

    #[test]
    fn empty_title_uses_untitled() {
        let created = Utc.with_ymd_and_hms(2026, 1, 2, 0, 0, 0).unwrap();
        let name = page_filename(created, "", "aaaa0000");
        assert_eq!(name, "20260102.untitled.aaaa0000.md");
    }
}

#[cfg(test)]
mod journal_date_tests {
    use super::extract_journal_date;

    #[test]
    fn legacy_and_canonical_journal_paths_yield_the_date() {
        assert_eq!(
            extract_journal_date("journals/2026-02-17.md").as_deref(),
            Some("2026-02-17")
        );
        assert_eq!(
            extract_journal_date("ai-journals/20260217.2026-02-17.abcd1234.md").as_deref(),
            Some("2026-02-17")
        );
    }

    #[test]
    fn non_journal_paths_yield_nothing() {
        assert_eq!(extract_journal_date("other/journals/2026-02-17.md"), None);
        assert_eq!(extract_journal_date("notes/2026-02-17.md"), None);
    }
}
