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
