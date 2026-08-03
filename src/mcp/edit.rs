//! Pure text transforms behind the `vault_edit_page` and `vault_append_page`
//! tools. Kept free of I/O so the match/splice rules are unit-testable and the
//! server module stays a thin adapter.

/// Replace `old` with `new` in `body`.
///
/// Without `replace_all` the match must be unique — zero matches and multiple
/// matches both fail with a message telling the agent how to proceed. Returns
/// the new body and the number of replacements.
pub(crate) fn apply_edit(
    body: &str,
    old: &str,
    new: &str,
    replace_all: bool,
) -> Result<(String, usize), String> {
    if old.is_empty() {
        return Err("old_string must not be empty".to_string());
    }
    let count = body.matches(old).count();
    match count {
        0 => Err(
            "old_string not found in the page body — re-read the page with vault_get_page \
             and match its current text exactly (whitespace included)"
                .to_string(),
        ),
        1 => Ok((body.replacen(old, new, 1), 1)),
        n if replace_all => Ok((body.replace(old, new), n)),
        n => Err(format!(
            "old_string matches {n} times — extend it with surrounding context to make it \
             unique, or pass replace_all: true to replace every occurrence"
        )),
    }
}

/// Append `content` to `body`, optionally at the end of the section opened by
/// the ATX heading whose text equals `heading` (case-insensitive, `#` prefix
/// and surrounding whitespace ignored).
///
/// A section runs until the next heading of the same or a shallower level.
/// Heading detection is line-based and does not exclude fenced code blocks; a
/// `#`-prefixed line inside a fence can be mistaken for a heading.
pub(crate) fn append_to_body(
    body: &str,
    content: &str,
    heading: Option<&str>,
) -> Result<String, String> {
    let Some(heading) = heading else {
        return Ok(join_block(body, content));
    };

    let lines: Vec<&str> = body.lines().collect();
    let Some((start, level)) = lines
        .iter()
        .enumerate()
        .find_map(|(i, line)| heading_level(line, heading).map(|level| (i, level)))
    else {
        return Err(format!(
            "heading \"{heading}\" not found in the page — re-read it with vault_get_page, \
             or omit 'heading' to append at the end of the page"
        ));
    };

    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| atx_level(line).is_some_and(|l| l <= level))
        .map(|(i, _)| i)
        .unwrap_or(lines.len());

    let section = lines[start..end].join("\n");
    let mut out = lines[..start].join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(&join_block(&section, content));
    if end < lines.len() {
        out.push('\n');
        out.push_str(&lines[end..].join("\n"));
    }
    if body.ends_with('\n') && !out.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

/// Append `content` after `body` with a blank-line separator and a trailing
/// newline, tolerating any existing trailing whitespace.
fn join_block(body: &str, content: &str) -> String {
    let trimmed = body.trim_end();
    if trimmed.is_empty() {
        format!("{}\n", content.trim_end())
    } else {
        format!("{}\n\n{}\n", trimmed, content.trim_end())
    }
}

/// The ATX heading level of `line` (1-6), if it is one.
fn atx_level(line: &str) -> Option<usize> {
    let trimmed = line.trim_start();
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hashes)
        && trimmed[hashes..]
            .chars()
            .next()
            .is_none_or(|c| c == ' ' || c == '\t')
    {
        Some(hashes)
    } else {
        None
    }
}

/// If `line` is an ATX heading whose text matches `wanted`, return its level.
fn heading_level(line: &str, wanted: &str) -> Option<usize> {
    let level = atx_level(line)?;
    let text = line.trim_start().trim_start_matches('#').trim();
    text.eq_ignore_ascii_case(wanted.trim()).then_some(level)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_edit_replaces_a_unique_match() {
        let (body, n) = apply_edit("alpha beta gamma", "beta", "BETA", false).unwrap();
        assert_eq!(body, "alpha BETA gamma");
        assert_eq!(n, 1);
    }

    #[test]
    fn apply_edit_rejects_missing_match_with_reread_hint() {
        let err = apply_edit("alpha", "zeta", "x", false).unwrap_err();
        assert!(err.contains("vault_get_page"), "{err}");
    }

    #[test]
    fn apply_edit_rejects_ambiguous_match() {
        let err = apply_edit("x y x", "x", "z", false).unwrap_err();
        assert!(err.contains("2 times"), "{err}");
        assert!(err.contains("replace_all"), "{err}");
    }

    #[test]
    fn apply_edit_replace_all_counts_replacements() {
        let (body, n) = apply_edit("x y x", "x", "z", true).unwrap();
        assert_eq!(body, "z y z");
        assert_eq!(n, 2);
    }

    #[test]
    fn apply_edit_rejects_empty_old_string() {
        assert!(apply_edit("body", "", "x", false).is_err());
    }

    #[test]
    fn append_without_heading_separates_with_blank_line() {
        let out = append_to_body("existing\n", "- new item", None).unwrap();
        assert_eq!(out, "existing\n\n- new item\n");
    }

    #[test]
    fn append_to_empty_body_has_no_leading_blank() {
        let out = append_to_body("", "content", None).unwrap();
        assert_eq!(out, "content\n");
    }

    #[test]
    fn append_under_heading_extends_that_section() {
        let body = "# Log\n\nentry one\n\n# Done\n\nfinished\n";
        let out = append_to_body(body, "entry two", Some("Log")).unwrap();
        assert_eq!(
            out,
            "# Log\n\nentry one\n\nentry two\n\n# Done\n\nfinished\n"
        );
    }

    #[test]
    fn append_under_last_heading_reaches_end_of_body() {
        let body = "# Log\n\nentry one\n";
        let out = append_to_body(body, "entry two", Some("Log")).unwrap();
        assert_eq!(out, "# Log\n\nentry one\n\nentry two\n");
    }

    #[test]
    fn append_under_subheading_stops_at_sibling() {
        let body = "## A\n\na text\n\n## B\n\nb text\n";
        let out = append_to_body(body, "more a", Some("A")).unwrap();
        assert!(out.contains("a text\n\nmore a\n\n## B"), "{out}");
    }

    #[test]
    fn append_heading_match_is_case_insensitive() {
        let body = "# Reading Log\n\nx\n";
        assert!(append_to_body(body, "y", Some("reading log")).is_ok());
    }

    #[test]
    fn append_missing_heading_errors_with_hint() {
        let err = append_to_body("# Log\n", "x", Some("Nope")).unwrap_err();
        assert!(err.contains("\"Nope\" not found"), "{err}");
    }

    #[test]
    fn deeper_subheadings_stay_inside_the_section() {
        let body = "# Top\n\n## Sub\n\nsub text\n\n# Next\n";
        let out = append_to_body(body, "tail", Some("Top")).unwrap();
        assert!(out.contains("sub text\n\ntail\n\n# Next"), "{out}");
    }
}
