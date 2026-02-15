use std::collections::HashSet;

use regex::Regex;

/// Skip these words when picking the first significant title word.
const SKIP_WORDS: &[&str] = &["a", "an", "the", "on"];

/// Derive a citation key for a Zotero item.
///
/// 1. If `extra_field` contains `Citation Key: <value>` (set by Better BibTeX),
///    use that value directly.
/// 2. Otherwise, derive from `{last_name}{year}{first_significant_title_word}`.
/// 3. If the result collides with `existing_keys`, append `-b`, `-c`, etc.
pub fn derive_cite_key(
    extra_field: Option<&str>,
    authors: &[String],
    year: Option<i32>,
    title: &str,
    existing_keys: &HashSet<String>,
) -> String {
    // 1. Check BBT extra field
    if let Some(extra) = extra_field {
        let re = Regex::new(r"(?m)^Citation Key:\s*(.+)$").unwrap();
        if let Some(caps) = re.captures(extra) {
            let bbt_key = caps[1].trim().to_string();
            if !bbt_key.is_empty() {
                return bbt_key;
            }
        }
    }

    // 2. Derive from metadata
    let author_part = authors
        .first()
        .map(|a| {
            let last = a.split_whitespace().last().unwrap_or("anon");
            strip_diacritics(&last.to_lowercase())
        })
        .unwrap_or_else(|| "anon".to_string());

    let year_part = year.map(|y| y.to_string()).unwrap_or_default();

    let title_part = title
        .split_whitespace()
        .map(|w| w.to_lowercase())
        .map(|w| w.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>())
        .find(|w| !w.is_empty() && !SKIP_WORDS.contains(&w.as_str()))
        .unwrap_or_else(|| "untitled".to_string());

    let base = format!("{author_part}{year_part}{title_part}");

    // 3. Handle collisions
    if !existing_keys.contains(&base) {
        return base;
    }

    for suffix in b'b'..=b'z' {
        let candidate = format!("{base}-{}", suffix as char);
        if !existing_keys.contains(&candidate) {
            return candidate;
        }
    }

    // Extremely unlikely: more than 25 collisions
    for first in b'a'..=b'z' {
        for second in b'a'..=b'z' {
            let candidate = format!("{base}-{}{}", first as char, second as char);
            if !existing_keys.contains(&candidate) {
                return candidate;
            }
        }
    }

    format!("{base}-overflow")
}

/// Strip Unicode diacritics by NFKD decomposition + removing combining marks.
fn strip_diacritics(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;

    s.nfkd()
        .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
        .collect()
}
