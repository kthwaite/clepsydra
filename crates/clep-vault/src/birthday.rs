//! PERSON birthdays from frontmatter `birthday`.
//!
//! Two stored forms. A native TOML date (`birthday = 1983-05-12`) reaches
//! JSON as `"1983-05-12"`. A month-day string (`birthday = "05-12"`) means
//! the year is unknown; `"--05-12"` is also accepted on read.

use chrono::NaiveDate;
use serde_json::Value;

/// A leap year, so a yearless `02-29` validates.
const LEAP_YEAR: i32 = 2000;

/// A parsed birthday. `year` is `None` when the year is unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Birthday {
    pub year: Option<i32>,
    pub month: u32,
    pub day: u32,
}

/// Parse a `birthday` value. Invalid values give `None`.
pub fn parse(value: &Value) -> Option<Birthday> {
    let text = value.as_str()?.trim();
    let month_day = text.strip_prefix("--").unwrap_or(text);
    if month_day.len() == 5 {
        let (month, day) = parse_month_day(month_day)?;
        NaiveDate::from_ymd_opt(LEAP_YEAR, month, day)?;
        return Some(Birthday {
            year: None,
            month,
            day,
        });
    }
    if text.len() != 10 || text.as_bytes()[4] != b'-' {
        return None;
    }
    let year: i32 = digits(&text[..4])?.try_into().ok()?;
    let (month, day) = parse_month_day(&text[5..])?;
    NaiveDate::from_ymd_opt(year, month, day)?;
    Some(Birthday {
        year: Some(year),
        month,
        day,
    })
}

/// `MM-DD`, two digits each.
fn parse_month_day(text: &str) -> Option<(u32, u32)> {
    if text.len() != 5 || text.as_bytes()[2] != b'-' {
        return None;
    }
    Some((digits(&text[..2])?, digits(&text[3..])?))
}

/// An all-ASCII-digit string as a number.
fn digits(text: &str) -> Option<u32> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bday(year: Option<i32>, month: u32, day: u32) -> Option<Birthday> {
        Some(Birthday { year, month, day })
    }

    #[test]
    fn parses_full_date() {
        assert_eq!(parse(&json!("1983-05-12")), bday(Some(1983), 5, 12));
    }

    #[test]
    fn parses_month_day() {
        assert_eq!(parse(&json!("05-12")), bday(None, 5, 12));
    }

    #[test]
    fn parses_double_dash_month_day() {
        assert_eq!(parse(&json!("--05-12")), bday(None, 5, 12));
    }

    #[test]
    fn trims_whitespace() {
        assert_eq!(parse(&json!("  1983-05-12 ")), bday(Some(1983), 5, 12));
        assert_eq!(parse(&json!(" 05-12\n")), bday(None, 5, 12));
    }

    #[test]
    fn accepts_feb_29_without_year_and_in_leap_years() {
        assert_eq!(parse(&json!("02-29")), bday(None, 2, 29));
        assert_eq!(parse(&json!("1984-02-29")), bday(Some(1984), 2, 29));
    }

    #[test]
    fn rejects_invalid_month_day() {
        assert_eq!(parse(&json!("13-01")), None);
        assert_eq!(parse(&json!("02-30")), None);
        assert_eq!(parse(&json!("00-10")), None);
        assert_eq!(parse(&json!("05-00")), None);
    }

    #[test]
    fn rejects_feb_29_in_non_leap_year() {
        assert_eq!(parse(&json!("1983-02-29")), None);
    }

    #[test]
    fn rejects_non_strings_and_other_shapes() {
        assert_eq!(parse(&json!(19830512)), None);
        assert_eq!(parse(&json!(null)), None);
        assert_eq!(parse(&json!(["05-12"])), None);
        assert_eq!(parse(&json!("1983-05-12T09:00:00Z")), None);
        assert_eq!(parse(&json!("5-12")), None);
        assert_eq!(parse(&json!("May 12")), None);
        assert_eq!(parse(&json!("")), None);
    }
}
