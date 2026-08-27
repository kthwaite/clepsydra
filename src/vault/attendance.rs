//! The `attendees` relation: the person pages a MEETING or ONE_ON_ONE names.
//!
//! Both kinds use the same frontmatter key so that one query, one backlink
//! set, and one editor affordance cover them. They differ only in cardinality:
//! a MEETING names any number of people; a ONE_ON_ONE names one.
//!
//! Cardinality is enforced as a ceiling, not a floor. Writing a second
//! attendee onto a ONE_ON_ONE is rejected — that is the constraint the kind
//! exists for — but a page that names nobody yet is an unfinished note, not an
//! invalid one, and the API accepts it the way it accepts an untitled page.
//! `clep doctor` reports the unfinished ones (see `check_attendance`).
//!
//! Values are wikilinks (`attendees = ["[[Ada Lovelace]]"]`). A single
//! attendee may also be written bare (`attendees = "[[Ada Lovelace]]"`), which
//! is the natural spelling for a ONE_ON_ONE. `attendees` is a linkable
//! property (see `VaultSection::linkable_properties`), so each entry derives a
//! `property_ref` link and the person page gets the backlink.
//!
//! Attendee targets are *not* checked against the index: a wikilink to a page
//! that does not exist yet is ordinary in this vault, and the existing
//! reference-issue machinery already reports dangling targets. This module
//! validates shape and cardinality only.

use thiserror::Error;

use super::canonical::CanonicalName;
use super::kind::Kind;
use super::page::PageMeta;

/// The frontmatter key holding the relation.
pub const ATTENDEES_KEY: &str = "attendees";

/// How many people a kind's `attendees` relation may name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cardinality {
    /// Any number, including none.
    Many,
    /// One — the defining constraint of a ONE_ON_ONE. Enforced as a ceiling;
    /// see the module docs for why zero is tolerated.
    One,
}

/// The attendee cardinality for `kind`, or `None` for kinds that have no
/// attendees relation. Frontmatter on those kinds is left alone: an arbitrary
/// `attendees` key on a NOTE is an ordinary property, not an error.
pub const fn cardinality(kind: Kind) -> Option<Cardinality> {
    match kind {
        Kind::Meeting => Some(Cardinality::Many),
        Kind::OneOnOne => Some(Cardinality::One),
        _ => None,
    }
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
    #[error("a {kind} names one attendee, not {found}")]
    TooManyAttendees { kind: &'static str, found: usize },
}

/// Read and validate the attendees declared by `meta`, regardless of kind.
///
/// Returns an empty list when the key is absent. Shape, emptiness, and
/// duplication are rejected here; cardinality is [`validate`]'s job because it
/// is the only part that depends on the kind.
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

/// Validate a page's `attendees` against the cardinality its kind allows.
///
/// A no-op for kinds without an attendees relation.
pub fn validate(kind: Kind, meta: &PageMeta) -> Result<(), AttendanceError> {
    let Some(cardinality) = cardinality(kind) else {
        return Ok(());
    };
    let attendees = attendees(meta)?;
    match cardinality {
        Cardinality::Many => Ok(()),
        Cardinality::One if attendees.len() <= 1 => Ok(()),
        Cardinality::One => Err(AttendanceError::TooManyAttendees {
            kind: kind.as_str(),
            found: attendees.len(),
        }),
    }
}

/// Whether a page of this kind is missing an attendee it is defined by: a
/// ONE_ON_ONE that names nobody. Valid to store (see the module docs), worth
/// reporting. Malformed `attendees` is [`validate`]'s business, not this
/// function's, so an unreadable value is not "incomplete" here.
pub fn is_incomplete(kind: Kind, meta: &PageMeta) -> bool {
    matches!(cardinality(kind), Some(Cardinality::One))
        && attendees(meta).is_ok_and(|attendees| attendees.is_empty())
}

/// The frontmatter value for a list of attendee names, wrapped as wikilinks.
///
/// Names already written as `[[…]]` are kept as-is so callers can pass either
/// spelling. A ONE_ON_ONE's single attendee is still written as a one-element
/// array: one shape for both kinds keeps readers and the property editor
/// simple.
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
    fn only_meetings_and_one_on_ones_have_attendees() {
        assert_eq!(cardinality(Kind::Meeting), Some(Cardinality::Many));
        assert_eq!(cardinality(Kind::OneOnOne), Some(Cardinality::One));
        assert_eq!(cardinality(Kind::Note), None);
        assert_eq!(cardinality(Kind::Person), None);
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
        // …and satisfies a ONE_ON_ONE, which is the point of accepting it.
        assert!(validate(Kind::OneOnOne, &meta).is_ok());
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
    fn a_one_on_one_refuses_a_second_attendee() {
        assert!(validate(Kind::OneOnOne, &meta_with_names(&["[[Ada]]"])).is_ok());
        assert_eq!(
            validate(Kind::OneOnOne, &meta_with_names(&["[[Ada]]", "[[Grace]]"])),
            Err(AttendanceError::TooManyAttendees {
                kind: "ONE_ON_ONE",
                found: 2
            })
        );
    }

    #[test]
    fn an_empty_one_on_one_is_unfinished_rather_than_invalid() {
        let empty = PageMeta::new();
        assert!(validate(Kind::OneOnOne, &empty).is_ok());
        assert!(is_incomplete(Kind::OneOnOne, &empty));
        assert!(!is_incomplete(
            Kind::OneOnOne,
            &meta_with_names(&["[[Ada]]"])
        ));
        // A meeting with nobody in it is simply a meeting with nobody in it.
        assert!(!is_incomplete(Kind::Meeting, &empty));
        assert!(!is_incomplete(Kind::Note, &empty));
    }

    #[test]
    fn malformed_attendees_are_not_reported_as_incomplete() {
        // `validate` owns that failure; `is_incomplete` must not double-report
        // it as a missing attendee.
        let malformed = meta_with(toml::Value::Integer(3));
        assert!(!is_incomplete(Kind::OneOnOne, &malformed));
        assert_eq!(
            validate(Kind::OneOnOne, &malformed),
            Err(AttendanceError::InvalidShape)
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
