//! What a `project` slug may be.
//!
//! A project is named by a slug, and that slug is also the folder its member
//! pages live in: `project = "field notes"` on a NOTE puts the file at
//! `notes/field notes/…`. The two facts are one rule, which is why the shape
//! is checked here rather than at the HTTP boundary — the folder has to be a
//! name the filesystem round-trips, whether the value arrives over the API or
//! in a file someone wrote by hand.
//!
//! A slug is one or more `/`-separated segments. A segment may hold letters,
//! digits, spaces, `-` and `_`, so `field notes` names a project as readily as
//! `field-notes`. A segment may not lead or trail with a space: such a folder
//! name survives no round-trip reliably, and two slugs differing only in
//! padding would look identical everywhere they are displayed.
//!
//! Every write path checks a slug before persisting it. Files stay
//! hand-editable, though, so `clep doctor` reports the slugs already in a
//! vault that would fail this — the same way it reports a malformed
//! `attendees` list.

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SlugError {
    #[error("project must not be empty")]
    Empty,
    #[error("project must not have an empty path segment")]
    EmptySegment,
    #[error("project must not contain `.` or `..` segments")]
    DotSegment,
    #[error("project must not start or end with a space")]
    PaddedSegment,
    #[error("project may contain only letters, digits, spaces, `-`, `_` and `/`")]
    IllegalCharacter,
}

/// Whether `slug` is a well-formed project slug.
pub fn validate_slug(slug: &str) -> Result<(), SlugError> {
    if slug.is_empty() {
        return Err(SlugError::Empty);
    }
    for segment in slug.split('/') {
        if segment.is_empty() {
            return Err(SlugError::EmptySegment);
        }
        if segment == "." || segment == ".." {
            return Err(SlugError::DotSegment);
        }
        if segment.starts_with(' ') || segment.ends_with(' ') {
            return Err(SlugError::PaddedSegment);
        }
        if segment
            .chars()
            .any(|c| !(c.is_alphanumeric() || c == '-' || c == '_' || c == ' '))
        {
            return Err(SlugError::IllegalCharacter);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_segment_may_hold_letters_digits_spaces_dashes_and_underscores() {
        for slug in [
            "clepsydra",
            "field notes",
            "field-notes",
            "field_notes",
            "field notes/river survey",
            "2026",
            "über die grenzen",
        ] {
            assert_eq!(validate_slug(slug), Ok(()), "{slug} should be well-formed");
        }
    }

    #[test]
    fn a_segment_may_not_lead_or_trail_with_a_space() {
        for slug in [" field notes", "field notes ", "field / notes"] {
            assert_eq!(validate_slug(slug), Err(SlugError::PaddedSegment), "{slug}");
        }
    }

    #[test]
    fn a_segment_may_not_be_empty() {
        for slug in ["/clepsydra", "clepsydra/", "field//notes"] {
            assert_eq!(validate_slug(slug), Err(SlugError::EmptySegment), "{slug}");
        }
        assert_eq!(validate_slug(""), Err(SlugError::Empty));
    }

    #[test]
    fn traversal_is_refused_whole_or_embedded() {
        assert_eq!(validate_slug("../escape"), Err(SlugError::DotSegment));
        assert_eq!(validate_slug("a/./b"), Err(SlugError::DotSegment));
        // `.` is not a legal character, so an embedded `..` cannot slip past
        // the segment check either.
        assert_eq!(
            validate_slug("field..notes"),
            Err(SlugError::IllegalCharacter)
        );
    }

    #[test]
    fn characters_outside_the_set_are_refused() {
        for slug in [
            "field:notes",
            "field\tnotes",
            "field\nnotes",
            "field\0notes",
            "field*notes",
            "field\\notes",
        ] {
            assert_eq!(
                validate_slug(slug),
                Err(SlugError::IllegalCharacter),
                "{slug:?}"
            );
        }
    }
}
