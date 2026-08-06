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
/// Lines inside fenced code blocks (backtick or tilde fences) are never
/// treated as headings, so a `# comment` in an example cannot become a
/// section boundary.
pub(crate) fn append_to_body(
    body: &str,
    content: &str,
    heading: Option<&str>,
) -> Result<String, String> {
    let Some(heading) = heading else {
        return Ok(join_block(body, content));
    };

    let lines: Vec<&str> = body.lines().collect();
    let fenced = fence_flags(&lines);
    let Some((start, level)) = lines
        .iter()
        .enumerate()
        .filter(|(i, _)| !fenced[*i])
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
        .find(|(i, line)| !fenced[*i] && atx_level(line).is_some_and(|l| l <= level))
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

/// Per-line "inside a fenced code block" flags, opening and closing fence
/// lines included. A fence opens on a line whose trimmed start is three or
/// more backticks or tildes; it closes on a line of at least as many of the
/// same character followed only by whitespace (CommonMark's closing rule).
/// An unclosed fence runs to the end of the body.
fn fence_flags(lines: &[&str]) -> Vec<bool> {
    let mut flags = Vec::with_capacity(lines.len());
    let mut open: Option<(char, usize)> = None;
    for line in lines {
        let trimmed = line.trim_start();
        match open {
            None => {
                let first = trimmed.chars().next();
                if let Some(c @ ('`' | '~')) = first {
                    let run = trimmed.chars().take_while(|x| *x == c).count();
                    if run >= 3 {
                        open = Some((c, run));
                        flags.push(true);
                        continue;
                    }
                }
                flags.push(false);
            }
            Some((c, run)) => {
                flags.push(true);
                let close_run = trimmed.chars().take_while(|x| *x == c).count();
                if close_run >= run && trimmed[close_run..].trim().is_empty() {
                    open = None;
                }
            }
        }
    }
    flags
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

    #[test]
    fn hash_lines_inside_backtick_fences_are_not_boundaries() {
        let body = "# Log\n\n```sh\n# not a heading\necho hi\n```\n\ntext\n\n# Done\n";
        let out = append_to_body(body, "tail", Some("Log")).unwrap();
        // The append lands after `text`, before `# Done` — never inside the fence.
        assert!(out.contains("text\n\ntail\n\n# Done"), "{out}");
        assert!(out.contains("# not a heading\necho hi\n```"), "{out}");
    }

    #[test]
    fn headings_inside_fences_are_not_targets() {
        let body = "```\n# Fake\n```\n\n# Real\n\nbody\n";
        let err = append_to_body(body, "x", Some("Fake")).unwrap_err();
        assert!(err.contains("not found"), "{err}");
        assert!(append_to_body(body, "x", Some("Real")).is_ok());
    }

    #[test]
    fn tilde_fences_and_nested_backticks_are_tracked() {
        // A ~~~~ fence containing ``` must stay open until the ~~~~ closes.
        let body = "# Log\n\n~~~~\n```\n# inner\n```\n~~~~\n\n# Done\n";
        let out = append_to_body(body, "tail", Some("Log")).unwrap();
        assert!(out.contains("~~~~\n\ntail\n\n# Done"), "{out}");
    }

    #[test]
    fn unclosed_fence_runs_to_end_of_body() {
        let body = "# Log\n\n```\n# never closed\n";
        let out = append_to_body(body, "tail", Some("Log")).unwrap();
        // Everything after the open fence is fenced; append goes to the end.
        assert!(out.ends_with("tail\n"), "{out}");
    }
}
