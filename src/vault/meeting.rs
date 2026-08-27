//! When a MEETING or ONE_ON_ONE took place.
//!
//! The companion to [`crate::vault::attendance`], which owns *who* was there.
//! Both are frontmatter the two meeting kinds carry; they are separate modules
//! because the attendees relation is a link and this is a scalar.
//!
//! The value is a native TOML date-time, not a string:
//!
//! ```toml
//! type = "MEETING"
//! occurred_at = 2026-08-27T14:00:00Z
//! ```
//!
//! Nativeness is the whole point. `derivers::properties` projects a TOML
//! date-time into `value_date`, so a native value sorts and filters in Bases
//! and the query layer while a quoted string is inert text. A page that quotes
//! it is therefore rejected on write and reported by `clep doctor`, the same
//! way a malformed `attendees` list is.
//!
//! A meeting with no `occurred_at` is an unfinished note, not an invalid one —
//! the field is never invented for you. See the attendance module docs for why
//! this vault enforces ceilings rather than floors.

use thiserror::Error;

use super::kind::Kind;
use super::page::PageMeta;

/// The frontmatter key holding the occurrence time.
pub const OCCURRED_AT_KEY: &str = "occurred_at";

/// Whether pages of this kind record when they took place.
pub const fn records_occurrence(kind: Kind) -> bool {
    matches!(kind, Kind::Meeting | Kind::OneOnOne)
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MeetingTimeError {
    #[error("`{OCCURRED_AT_KEY}` must be a TOML date-time (unquoted), not {found}")]
    NotADateTime { found: &'static str },
    #[error("`{OCCURRED_AT_KEY}` must include a date, not just a time of day")]
    MissingDate,
    #[error("`{OCCURRED_AT_KEY}` is not a valid date-time: {value}")]
    Unparseable { value: String },
}

/// Read the declared occurrence time, or `None` when the key is absent.
pub fn occurred_at(meta: &PageMeta) -> Result<Option<toml::value::Datetime>, MeetingTimeError> {
    let Some(value) = meta.extra.get(OCCURRED_AT_KEY) else {
        return Ok(None);
    };
    let datetime = match value {
        toml::Value::Datetime(datetime) => *datetime,
        other => {
            return Err(MeetingTimeError::NotADateTime {
                found: describe(other),
            });
        }
    };
    // A TOML local-time (`14:00:00`) parses fine and says nothing about which
    // day the meeting was on.
    if datetime.date.is_none() {
        return Err(MeetingTimeError::MissingDate);
    }
    Ok(Some(datetime))
}

/// Validate a page's occurrence time against its kind.
///
/// A no-op for kinds that do not record one: an `occurred_at` key on a NOTE is
/// an ordinary property, as arbitrary frontmatter always is here.
pub fn validate(kind: Kind, meta: &PageMeta) -> Result<(), MeetingTimeError> {
    if !records_occurrence(kind) {
        return Ok(());
    }
    occurred_at(meta).map(|_| ())
}

/// Whether a page of this kind has not recorded when it took place. Valid to
/// store, worth reporting. A malformed value is [`validate`]'s business, so it
/// is not also counted as undated here.
pub fn is_undated(kind: Kind, meta: &PageMeta) -> bool {
    records_occurrence(kind) && occurred_at(meta).is_ok_and(|value| value.is_none())
}

/// Parse a client-supplied date-time string into the native TOML value.
///
/// Accepts what TOML itself accepts — `2026-08-27T14:00:00Z`, the same without
/// an offset, and a bare `2026-08-27` for a meeting whose day is known but
/// whose hour is not.
pub fn parse_occurred_at(raw: &str) -> Result<toml::Value, MeetingTimeError> {
    let trimmed = raw.trim();
    let datetime =
        trimmed
            .parse::<toml::value::Datetime>()
            .map_err(|_| MeetingTimeError::Unparseable {
                value: trimmed.to_string(),
            })?;
    if datetime.date.is_none() {
        return Err(MeetingTimeError::MissingDate);
    }
    Ok(toml::Value::Datetime(datetime))
}

/// The TOML type name of a value, for the "not a date-time" error.
fn describe(value: &toml::Value) -> &'static str {
    match value {
        toml::Value::String(_) => "a string",
        toml::Value::Integer(_) => "an integer",
        toml::Value::Float(_) => "a float",
        toml::Value::Boolean(_) => "a boolean",
        toml::Value::Array(_) => "an array",
        toml::Value::Table(_) => "a table",
        toml::Value::Datetime(_) => "a date-time",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta_with(value: toml::Value) -> PageMeta {
        let mut meta = PageMeta::new();
        meta.extra.insert(OCCURRED_AT_KEY.to_string(), value);
        meta
    }

    fn meta_at(raw: &str) -> PageMeta {
        meta_with(parse_occurred_at(raw).unwrap())
    }

    #[test]
    fn only_meeting_kinds_record_an_occurrence() {
        assert!(records_occurrence(Kind::Meeting));
        assert!(records_occurrence(Kind::OneOnOne));
        assert!(!records_occurrence(Kind::Note));
        assert!(!records_occurrence(Kind::Journal));
    }

    #[test]
    fn absent_key_reads_as_none() {
        assert_eq!(occurred_at(&PageMeta::new()), Ok(None));
        assert!(validate(Kind::Meeting, &PageMeta::new()).is_ok());
    }

    #[test]
    fn a_native_datetime_round_trips() {
        let meta = meta_at("2026-08-27T14:00:00Z");
        let value = occurred_at(&meta).unwrap().expect("a date-time");
        assert_eq!(value.to_string(), "2026-08-27T14:00:00Z");
        assert!(validate(Kind::Meeting, &meta).is_ok());
        assert!(!is_undated(Kind::Meeting, &meta));
    }

    #[test]
    fn an_offsetless_datetime_and_a_bare_date_are_both_accepted() {
        for raw in ["2026-08-27T14:00:00", "2026-08-27"] {
            let meta = meta_at(raw);
            assert!(
                occurred_at(&meta).unwrap().is_some(),
                "{raw} should be readable"
            );
            assert!(validate(Kind::OneOnOne, &meta).is_ok());
        }
    }

    #[test]
    fn a_quoted_datetime_is_rejected() {
        // Inert text: the index would never project it as a date.
        let meta = meta_with(toml::Value::String("2026-08-27T14:00:00Z".to_string()));
        assert_eq!(
            validate(Kind::Meeting, &meta),
            Err(MeetingTimeError::NotADateTime { found: "a string" })
        );
    }

    #[test]
    fn a_time_without_a_day_is_rejected() {
        let meta = meta_with(toml::Value::Datetime(
            "14:00:00".parse::<toml::value::Datetime>().unwrap(),
        ));
        assert_eq!(
            validate(Kind::Meeting, &meta),
            Err(MeetingTimeError::MissingDate)
        );
        assert_eq!(
            parse_occurred_at("14:00:00"),
            Err(MeetingTimeError::MissingDate)
        );
    }

    #[test]
    fn unparseable_input_names_what_it_could_not_read() {
        assert_eq!(
            parse_occurred_at("last tuesday"),
            Err(MeetingTimeError::Unparseable {
                value: "last tuesday".to_string()
            })
        );
    }

    #[test]
    fn an_undated_meeting_is_unfinished_rather_than_invalid() {
        let empty = PageMeta::new();
        assert!(validate(Kind::Meeting, &empty).is_ok());
        assert!(is_undated(Kind::Meeting, &empty));
        assert!(is_undated(Kind::OneOnOne, &empty));
        assert!(!is_undated(Kind::Note, &empty));
        assert!(!is_undated(Kind::Meeting, &meta_at("2026-08-27")));
    }

    #[test]
    fn a_malformed_value_is_not_also_reported_as_undated() {
        let malformed = meta_with(toml::Value::Integer(2026));
        assert!(!is_undated(Kind::Meeting, &malformed));
        assert_eq!(
            validate(Kind::Meeting, &malformed),
            Err(MeetingTimeError::NotADateTime {
                found: "an integer"
            })
        );
    }

    #[test]
    fn kinds_without_an_occurrence_are_left_alone() {
        let meta = meta_with(toml::Value::String("whenever".to_string()));
        assert!(validate(Kind::Note, &meta).is_ok());
        assert!(validate(Kind::Person, &meta).is_ok());
    }
}
