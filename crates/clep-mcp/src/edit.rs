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
    // Occurrences are counted at every offset: `str::matches` skips a match
    // that overlaps the previous one ("aa" in "aaa"), which would make an
    // ambiguous edit look unique.
    let count = occurrences(body, old);
    match count {
        0 => Err(
            "old_string not found in the page body — re-read the page with vault_get_page \
             and match its current text exactly (whitespace included)"
                .to_string(),
        ),
        1 => Ok((body.replacen(old, new, 1), 1)),
        _ if replace_all => Ok((body.replace(old, new), body.matches(old).count())),
        n => Err(format!(
            "old_string matches {n} times — extend it with surrounding context to make it \
             unique, or pass replace_all: true to replace every occurrence"
        )),
    }
}

/// Number of offsets in `body` at which `needle` (non-empty) occurs,
/// overlapping occurrences included.
fn occurrences(body: &str, needle: &str) -> usize {
    let step = needle.chars().next().map_or(1, char::len_utf8);
    let mut count = 0;
    let mut from = 0;
    while let Some(found) = body[from..].find(needle) {
        count += 1;
        from += found + step;
    }
    count
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

    // Splice at byte offsets so every line outside the insertion keeps its
    // bytes, line terminator included (rebuilding the body from `lines()`
    // turned CRLF into LF page-wide and dropped edge blank lines).
    let mut offsets = Vec::with_capacity(lines.len() + 1);
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        offsets.push(offset);
        offset += line.len();
    }
    offsets.push(body.len());
    let (section_start, section_end) = (offsets[start], offsets[end]);

    // The section keeps its text up to its last non-blank line, and that
    // line keeps its own terminator. A last line that has none (the page
    // does not end in a newline) gets the terminator the page uses.
    let kept_end = section_start + body[section_start..section_end].trim_end().len();
    let trailing = &body[kept_end..section_end];
    let terminator = match trailing.find('\n') {
        Some(at) if trailing[..at].ends_with('\r') => "\r\n",
        Some(_) => "\n",
        None if body.contains("\r\n") => "\r\n",
        None => "\n",
    };

    let mut out = String::with_capacity(body.len() + content.len() + 4);
    out.push_str(&body[..kept_end]);
    out.push_str(terminator);
    out.push('\n');
    out.push_str(content.trim_end());
    out.push('\n');
    if end < lines.len() {
        out.push('\n');
        out.push_str(&body[section_end..]);
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

/// The ATX heading level of `line` (1-6), if it is one. A heading is
/// indented by at most three spaces; four or more make an indented code line.
fn atx_level(line: &str) -> Option<usize> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return None;
    }
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
/// A closing sequence (`## Log ##`: hashes after a space, or nothing but
/// hashes) is not part of the heading text.
fn heading_level(line: &str, wanted: &str) -> Option<usize> {
    let level = atx_level(line)?;
    let text = line.trim_start().trim_start_matches('#').trim();
    let unclosed = text.trim_end_matches('#');
    let text = if unclosed.is_empty() || unclosed.ends_with([' ', '\t']) {
        unclosed.trim_end()
    } else {
        text
    };
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

    #[test]
    fn apply_edit_rejects_a_match_that_overlaps_itself() {
        // "aa" occurs at offsets 0 and 1; "\n\n" likewise. `str::matches`
        // counts one, so the first position used to be edited silently.
        for (body, old) in [("aaab", "aa"), ("a\n\n\nb", "\n\n"), ("xabababy", "abab")] {
            let err = apply_edit(body, old, "X", false).unwrap_err();
            assert!(err.contains("matches 2 times"), "{body:?}: {err}");
        }
    }

    #[test]
    fn apply_edit_replace_all_still_replaces_non_overlapping_matches() {
        let (body, n) = apply_edit("aaab", "aa", "X", true).unwrap();
        assert_eq!(body, "Xab");
        assert_eq!(n, 1);
    }

    #[test]
    fn append_under_heading_keeps_crlf_line_endings_of_other_lines() {
        // Regression: the body was rebuilt from `lines()` joined with `\n`,
        // which turned every CRLF of the page into LF.
        let out = append_to_body(
            "# Log\r\none\r\n\r\n# Other\r\ntwo\r\n",
            "- new",
            Some("Log"),
        )
        .unwrap();
        assert_eq!(out, "# Log\r\none\r\n\n- new\n\n# Other\r\ntwo\r\n");

        let out = append_to_body("intro\r\n\r\n# Log\r\none\r\n", "- new", Some("Log")).unwrap();
        assert_eq!(out, "intro\r\n\r\n# Log\r\none\r\n\n- new\n");

        // No final newline: the last line gets the page's terminator.
        let out = append_to_body("intro\r\n# Log\r\none", "- new", Some("Log")).unwrap();
        assert_eq!(out, "intro\r\n# Log\r\none\r\n\n- new\n");
        let out = append_to_body("intro\n# Log\none", "- new", Some("Log")).unwrap();
        assert_eq!(out, "intro\n# Log\none\n\n- new\n");
    }

    #[test]
    fn append_under_heading_keeps_blank_lines_outside_the_section() {
        // Same rebuild: a single leading blank line, and the blank line that
        // ends the page after a later section, were dropped.
        assert_eq!(
            append_to_body("\n# Log\none\n", "- new", Some("Log")).unwrap(),
            "\n# Log\none\n\n- new\n"
        );
        assert_eq!(
            append_to_body("# Log\n# Other\n\n", "- new", Some("Log")).unwrap(),
            "# Log\n\n- new\n\n# Other\n\n"
        );
    }

    #[test]
    fn append_ignores_a_hash_line_indented_as_code() {
        // Four spaces of indent make an indented code line, not a heading.
        let body = "intro\n\n    # Log\n    more code\n\n# Log\nreal\n";
        assert_eq!(
            append_to_body(body, "- new", Some("Log")).unwrap(),
            "intro\n\n    # Log\n    more code\n\n# Log\nreal\n\n- new\n"
        );
        // Nor does it end the section it sits in.
        let body = "# Log\none\n\n    # code\n\n# Other\n";
        assert_eq!(
            append_to_body(body, "- new", Some("Log")).unwrap(),
            "# Log\none\n\n    # code\n\n- new\n\n# Other\n"
        );
        // Up to three spaces is still a heading.
        assert_eq!(
            append_to_body("   # Log\none\n", "- new", Some("Log")).unwrap(),
            "   # Log\none\n\n- new\n"
        );
    }

    #[test]
    fn append_matches_a_heading_with_a_closing_hash_sequence() {
        assert_eq!(
            append_to_body("## Log ##\none\n", "- new", Some("Log")).unwrap(),
            "## Log ##\none\n\n- new\n"
        );
        assert_eq!(
            append_to_body("# Log #####  \none\n", "- new", Some("log")).unwrap(),
            "# Log #####  \none\n\n- new\n"
        );
        // Hashes glued to the text are text, not a closing sequence.
        assert!(append_to_body("# C#\none\n", "- new", Some("C")).is_err());
        assert_eq!(
            append_to_body("# C#\none\n", "- new", Some("C#")).unwrap(),
            "# C#\none\n\n- new\n"
        );
    }
}
