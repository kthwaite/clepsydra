//! The `attendees` relation: the person pages a MEETING names.
//!
//! MEETING is the only kind with attendees. A meeting names any number of
//! people, including nobody yet — a page with no attendees is an unfinished
//! note, not an invalid one, and the API accepts it the way it accepts an
//! untitled page. A 1:1 is simply a MEETING carrying the user tag `1:1`; since
//! 2026-08-28 there is no ONE_ON_ONE kind and no attendee cardinality (the
//! `type` token and its folders still parse, leniently, as MEETING — see
//! [`Kind::from_token`]).
//!
//! Values are wikilinks (`attendees = ["[[Ada Lovelace]]"]`). A single
//! attendee may also be written bare (`attendees = "[[Ada Lovelace]]"`).
//! `attendees` is a linkable property (see `VaultSection::linkable_properties`),
//! so each entry derives a `property_ref` link and the person page gets the
//! backlink.
//!
//! Attendee targets are *not* checked against the index: a wikilink to a page
//! that does not exist yet is ordinary in this vault, and the existing
//! reference-issue machinery already reports dangling targets. This module
//! validates shape only: a readable list, no empty entries, no duplicates.

use thiserror::Error;

use super::canonical::CanonicalName;
use super::kind::Kind;
use super::page::PageMeta;

/// The frontmatter key holding the relation.
pub const ATTENDEES_KEY: &str = "attendees";

/// Whether pages of this kind carry the `attendees` relation. Frontmatter on
/// other kinds is left alone: an arbitrary `attendees` key on a NOTE is an
/// ordinary property, not an error.
pub const fn has_attendees(kind: Kind) -> bool {
    matches!(kind, Kind::Meeting)
}

/// One named attendee.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attendee {
    /// The frontmatter value as written, e.g. `"[[Ada Lovelace|Ada]]"`.
    pub raw: String,
    /// The link target with wikilink brackets and display alias stripped,
    /// e.g. `"Ada Lovelace"`. Matches `extract_property_refs`.
    pub target: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AttendanceError {
    #[error("`{ATTENDEES_KEY}` must be a wikilink string or an array of wikilink strings")]
    InvalidShape,
    #[error("`{ATTENDEES_KEY}` entries cannot be empty")]
    EmptyAttendee,
    #[error("`{ATTENDEES_KEY}` names {name} more than once")]
    DuplicateAttendee { name: String },
}

/// Read and validate the attendees declared by `meta`, regardless of kind.
///
/// Returns an empty list when the key is absent. Shape, emptiness, and
/// duplication are rejected here; [`validate`] adds only the kind gate.
pub fn attendees(meta: &PageMeta) -> Result<Vec<Attendee>, AttendanceError> {
    let Some(value) = meta.extra.get(ATTENDEES_KEY) else {
        return Ok(Vec::new());
    };
    let raw_values = match value {
        toml::Value::String(single) => vec![single.clone()],
        toml::Value::Array(items) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_owned)
                    .ok_or(AttendanceError::InvalidShape)
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err(AttendanceError::InvalidShape),
    };

    let mut attendees: Vec<Attendee> = Vec::with_capacity(raw_values.len());
    for raw in raw_values {
        let target = link_target(&raw);
        if target.is_empty() {
            return Err(AttendanceError::EmptyAttendee);
        }
        let canonical = CanonicalName::from_title(&target);
        if attendees
            .iter()
            .any(|seen| CanonicalName::from_title(&seen.target).as_str() == canonical.as_str())
        {
            return Err(AttendanceError::DuplicateAttendee { name: target });
        }
        attendees.push(Attendee { raw, target });
    }
    Ok(attendees)
}

/// Validate a page's `attendees` for its kind: a MEETING's list has to be
/// readable (see [`attendees`]); any number of people is fine.
///
/// A no-op for kinds without an attendees relation.
pub fn validate(kind: Kind, meta: &PageMeta) -> Result<(), AttendanceError> {
    if !has_attendees(kind) {
        return Ok(());
    }
    attendees(meta).map(|_| ())
}

/// The frontmatter value for a list of attendee names, wrapped as wikilinks.
///
/// Names already written as `[[…]]` are kept as-is so callers can pass either
/// spelling. A single attendee is still written as a one-element array: one
/// shape keeps readers and the property editor simple.
pub fn attendees_value(names: &[String]) -> toml::Value {
    toml::Value::Array(
        names
            .iter()
            .map(|name| {
                let trimmed = name.trim();
                let wrapped = if trimmed.starts_with("[[") && trimmed.ends_with("]]") {
                    trimmed.to_string()
                } else {
                    format!("[[{trimmed}]]")
                };
                toml::Value::String(wrapped)
            })
            .collect(),
    )
}

/// Strip wikilink brackets and any `|display` alias, mirroring
/// [`crate::vault::link::extract_property_refs`].
fn link_target(raw: &str) -> String {
    let trimmed = raw.trim();
    let inner = trimmed
        .strip_prefix("[[")
        .and_then(|rest| rest.strip_suffix("]]"))
        .unwrap_or(trimmed);
    match inner.split_once('|') {
        Some((target, _)) => target.trim().to_string(),
        None => inner.trim().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta_with(value: toml::Value) -> PageMeta {
        let mut meta = PageMeta::new();
        meta.extra.insert(ATTENDEES_KEY.to_string(), value);
        meta
    }

    fn meta_with_names(names: &[&str]) -> PageMeta {
        meta_with(toml::Value::Array(
            names
                .iter()
                .map(|name| toml::Value::String((*name).to_string()))
                .collect(),
        ))
    }

    #[test]
    fn only_meetings_have_attendees() {
        assert!(has_attendees(Kind::Meeting));
        assert!(!has_attendees(Kind::Note));
        assert!(!has_attendees(Kind::Person));
        assert!(!has_attendees(Kind::Journal));
    }

    #[test]
    fn absent_key_yields_no_attendees() {
        assert_eq!(attendees(&PageMeta::new()), Ok(Vec::new()));
    }

    #[test]
    fn wikilinks_are_unwrapped_and_aliases_dropped() {
        let meta = meta_with_names(&["[[Ada Lovelace]]", "[[Grace Hopper|Grace]]", "Alan Turing"]);
        let targets: Vec<String> = attendees(&meta)
            .unwrap()
            .into_iter()
            .map(|a| a.target)
            .collect();
        assert_eq!(targets, ["Ada Lovelace", "Grace Hopper", "Alan Turing"]);
    }

    #[test]
    fn a_bare_string_is_a_single_attendee() {
        let meta = meta_with(toml::Value::String("[[Ada Lovelace]]".to_string()));
        let attendees = attendees(&meta).unwrap();
        assert_eq!(attendees.len(), 1);
        assert_eq!(attendees[0].target, "Ada Lovelace");
        assert_eq!(attendees[0].raw, "[[Ada Lovelace]]");
    }

    #[test]
    fn non_string_values_are_rejected() {
        assert_eq!(
            attendees(&meta_with(toml::Value::Integer(3))),
            Err(AttendanceError::InvalidShape)
        );
        assert_eq!(
            attendees(&meta_with(toml::Value::Array(vec![toml::Value::Integer(
                3
            )]))),
            Err(AttendanceError::InvalidShape)
        );
    }

    #[test]
    fn empty_entries_are_rejected() {
        assert_eq!(
            attendees(&meta_with_names(&["[[]]"])),
            Err(AttendanceError::EmptyAttendee)
        );
        assert_eq!(
            attendees(&meta_with_names(&["   "])),
            Err(AttendanceError::EmptyAttendee)
        );
    }

    #[test]
    fn duplicates_are_rejected_by_canonical_name() {
        // Same person, different spelling and display alias.
        let meta = meta_with_names(&["[[Ada Lovelace]]", "[[ada lovelace|Ada]]"]);
        assert_eq!(
            attendees(&meta),
            Err(AttendanceError::DuplicateAttendee {
                name: "ada lovelace".to_string()
            })
        );
    }

    #[test]
    fn a_meeting_accepts_any_number_including_none() {
        assert!(validate(Kind::Meeting, &PageMeta::new()).is_ok());
        assert!(validate(Kind::Meeting, &meta_with_names(&["[[Ada]]"])).is_ok());
        assert!(
            validate(
                Kind::Meeting,
                &meta_with_names(&["[[Ada]]", "[[Grace]]", "[[Alan]]"])
            )
            .is_ok()
        );
    }

    #[test]
    fn a_meeting_is_still_held_to_shape_emptiness_and_uniqueness() {
        // No cardinality any more (a 1:1 is a MEETING tagged `1:1`), but the
        // relation still has to be readable.
        assert_eq!(
            validate(Kind::Meeting, &meta_with(toml::Value::Integer(3))),
            Err(AttendanceError::InvalidShape)
        );
        assert_eq!(
            validate(Kind::Meeting, &meta_with_names(&["[[]]"])),
            Err(AttendanceError::EmptyAttendee)
        );
        assert_eq!(
            validate(
                Kind::Meeting,
                &meta_with_names(&["[[Ada Lovelace]]", "[[ada lovelace|Ada]]"])
            ),
            Err(AttendanceError::DuplicateAttendee {
                name: "ada lovelace".to_string()
            })
        );
    }

    #[test]
    fn kinds_without_the_relation_are_left_alone() {
        // An `attendees` key on a NOTE is an ordinary property, even a malformed
        // one — this module does not police pages it has no claim on.
        let meta = meta_with(toml::Value::Integer(3));
        assert!(validate(Kind::Note, &meta).is_ok());
        assert!(validate(Kind::Person, &meta).is_ok());
    }

    #[test]
    fn attendees_value_wraps_bare_names_only() {
        let value = attendees_value(&["Ada Lovelace".to_string(), "[[Grace Hopper]]".to_string()]);
        assert_eq!(
            value,
            toml::Value::Array(vec![
                toml::Value::String("[[Ada Lovelace]]".to_string()),
                toml::Value::String("[[Grace Hopper]]".to_string()),
            ])
        );
    }

    #[test]
    fn attendees_value_round_trips_through_attendees() {
        let mut meta = PageMeta::new();
        meta.extra.insert(
            ATTENDEES_KEY.to_string(),
            attendees_value(&["Ada Lovelace".to_string(), "Grace Hopper".to_string()]),
        );
        let targets: Vec<String> = attendees(&meta)
            .unwrap()
            .into_iter()
            .map(|a| a.target)
            .collect();
        assert_eq!(targets, ["Ada Lovelace", "Grace Hopper"]);
        assert!(validate(Kind::Meeting, &meta).is_ok());
    }
}
