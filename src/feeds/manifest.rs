use reqwest::Url;
use std::collections::HashSet;

pub use super::types::{Manifest, ManifestFeed, ManifestWarning};

#[derive(Debug)]
struct SourceLine<'a> {
    number: usize,
    start: usize,
    body_end: usize,
    end: usize,
    body: &'a str,
}

#[derive(Debug)]
struct HeadingLocation {
    line_index: usize,
    group: String,
}

#[derive(Debug)]
struct FeedLocation {
    feed_index: usize,
    line_index: usize,
    start: usize,
    body_end: usize,
    end: usize,
    indent_len: usize,
    marker: char,
    item_tags: Vec<String>,
}

#[derive(Debug)]
struct ParsedDocument<'a> {
    manifest: Manifest,
    lines: Vec<SourceLine<'a>>,
    headings: Vec<HeadingLocation>,
    feeds: Vec<FeedLocation>,
}

struct ListItem<'a> {
    content: &'a str,
    indent_len: usize,
    marker: char,
}

pub fn parse(text: &str) -> Manifest {
    parse_document(text).manifest
}

pub fn add_feed(
    source: &str,
    group: &str,
    url: &str,
    title_override: Option<&str>,
    tags: &[&str],
) -> Result<String, String> {
    let group = validate_group(group)?;
    validate_url(url)?;
    let title_override = validate_title(title_override)?;
    let item_tags = normalize_input_tags(tags)?;
    let item = render_item(url, title_override, &item_tags);
    let candidate = insert_item(source, group, &item);

    validate_candidate(&candidate)?;
    let added = parse(&candidate)
        .feeds
        .into_iter()
        .find(|feed| feed.url == url)
        .ok_or_else(|| format!("feed was not added: {url}"))?;
    if !added.group.eq_ignore_ascii_case(group) {
        return Err(format!(
            "feed was added to the wrong group: {}",
            added.group
        ));
    }
    if added.title_override.as_deref() != title_override {
        return Err(format!(
            "feed was added with the wrong title override: {:?}",
            added.title_override
        ));
    }

    Ok(candidate)
}

pub fn remove_feed(source: &str, url: &str) -> Result<String, String> {
    validate_url(url)?;
    let document = parse_document(source);
    let location = document
        .feeds
        .iter()
        .find(|location| document.manifest.feeds[location.feed_index].url == url)
        .ok_or_else(|| format!("feed not found: {url}"))?;
    let candidate = replace_span(source, location.start, location.end, "");

    validate_candidate(&candidate)?;
    Ok(candidate)
}

pub fn update_feed(
    source: &str,
    url: &str,
    group: &str,
    title_override: Option<&str>,
) -> Result<String, String> {
    validate_url(url)?;
    let group = validate_group(group)?;
    let title_override = validate_title(title_override)?;
    let document = parse_document(source);
    let location = document
        .feeds
        .iter()
        .find(|location| document.manifest.feeds[location.feed_index].url == url)
        .ok_or_else(|| format!("feed not found: {url}"))?;
    let feed = &document.manifest.feeds[location.feed_index];
    let item = render_item(url, title_override, &location.item_tags);

    let candidate = if feed.group.eq_ignore_ascii_case(group) {
        let line = &document.lines[location.line_index];
        let mut replacement = String::with_capacity(
            location.indent_len + item.len() + (location.end - location.body_end) + 2,
        );
        replacement.push_str(&line.body[..location.indent_len]);
        replacement.push(location.marker);
        replacement.push(' ');
        replacement.push_str(&item);
        replacement.push_str(&source[location.body_end..location.end]);
        replace_span(source, location.start, location.end, &replacement)
    } else {
        let without = replace_span(source, location.start, location.end, "");
        insert_item(&without, group, &item)
    };

    validate_candidate(&candidate)?;
    let updated = parse(&candidate)
        .feeds
        .into_iter()
        .find(|feed| feed.url == url)
        .ok_or_else(|| format!("feed disappeared while updating: {url}"))?;
    if !updated.group.eq_ignore_ascii_case(group)
        || updated.title_override.as_deref() != title_override
    {
        return Err(format!(
            "feed update did not produce the requested group and title: {url}"
        ));
    }

    Ok(candidate)
}

fn parse_document(text: &str) -> ParsedDocument<'_> {
    let lines = source_lines(text);
    let frontmatter_end = frontmatter_end(&lines);
    let mut manifest = Manifest::default();
    let mut headings = Vec::new();
    let mut feed_locations = Vec::new();
    let mut current_group = String::new();
    let mut inherited_tags = Vec::new();
    let mut seen_urls = HashSet::new();

    for (line_index, line) in lines.iter().enumerate() {
        if frontmatter_end.is_some_and(|end| line_index <= end) {
            continue;
        }

        if let Some(heading) = heading_text(line.body) {
            let (group, tags) = split_trailing_tags(heading);
            current_group = group;
            inherited_tags = deduplicate_tags(tags);
            headings.push(HeadingLocation {
                line_index,
                group: current_group.clone(),
            });
            continue;
        }

        let Some(list_item) = list_item(line.body) else {
            continue;
        };
        let (content, item_tags) = split_trailing_tags(list_item.content);
        let item_tags = deduplicate_tags(item_tags);
        let Some((url, title_override)) = parse_item(&content) else {
            if looks_like_feed_item(&content) {
                manifest.warnings.push(ManifestWarning {
                    line: line.number,
                    message: format!("malformed feed item: {content}"),
                });
            }
            continue;
        };

        if !seen_urls.insert(url.clone()) {
            manifest.warnings.push(ManifestWarning {
                line: line.number,
                message: format!("duplicate feed URL: {url}"),
            });
            continue;
        }

        let mut tags = inherited_tags.clone();
        for tag in &item_tags {
            push_unique(&mut tags, tag.clone());
        }
        let feed_index = manifest.feeds.len();
        manifest.feeds.push(ManifestFeed {
            url,
            title_override,
            group: current_group.clone(),
            tags,
            line: line.number,
        });
        feed_locations.push(FeedLocation {
            feed_index,
            line_index,
            start: line.start,
            body_end: line.body_end,
            end: line.end,
            indent_len: list_item.indent_len,
            marker: list_item.marker,
            item_tags,
        });
    }

    ParsedDocument {
        manifest,
        lines,
        headings,
        feeds: feed_locations,
    }
}

fn source_lines(text: &str) -> Vec<SourceLine<'_>> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (index, chunk) in text.split_inclusive('\n').enumerate() {
        let without_lf = chunk.strip_suffix('\n').unwrap_or(chunk);
        let body = without_lf.strip_suffix('\r').unwrap_or(without_lf);
        let body_end = start + body.len();
        let end = start + chunk.len();
        lines.push(SourceLine {
            number: index + 1,
            start,
            body_end,
            end,
            body,
        });
        start = end;
    }
    lines
}

fn frontmatter_end(lines: &[SourceLine<'_>]) -> Option<usize> {
    let delimiter = lines.first()?.body.trim();
    if delimiter != "+++" && delimiter != "---" {
        return None;
    }

    Some(
        lines
            .iter()
            .enumerate()
            .skip(1)
            .find_map(|(index, line)| (line.body.trim() == delimiter).then_some(index))
            .unwrap_or_else(|| lines.len().saturating_sub(1)),
    )
}

fn heading_text(line: &str) -> Option<&str> {
    line.trim().strip_prefix("## ").map(str::trim)
}

fn list_item(line: &str) -> Option<ListItem<'_>> {
    let trimmed = line.trim_start_matches(|character| character == ' ' || character == '\t');
    let indent_len = line.len() - trimmed.len();
    let (marker, content) = if let Some(content) = trimmed.strip_prefix("- ") {
        ('-', content)
    } else if let Some(content) = trimmed.strip_prefix("* ") {
        ('*', content)
    } else {
        return None;
    };

    Some(ListItem {
        content: content.trim(),
        indent_len,
        marker,
    })
}

fn split_trailing_tags(text: &str) -> (String, Vec<String>) {
    let mut prefix_end = text.len();
    let mut scan_end = text.len();
    let mut tags = Vec::new();

    loop {
        let candidate = text[..scan_end].trim_end();
        let Some((token_start, token)) = trailing_token(candidate) else {
            break;
        };
        let Some(tag) = tag_token(token) else {
            break;
        };
        tags.push(tag.to_string());
        prefix_end = candidate[..token_start].trim_end().len();
        scan_end = prefix_end;
    }

    tags.reverse();
    (text[..prefix_end].to_string(), tags)
}

fn trailing_token(text: &str) -> Option<(usize, &str)> {
    if text.is_empty() {
        return None;
    }
    let start = text
        .char_indices()
        .rev()
        .find(|(_, character)| character.is_whitespace())
        .map(|(index, character)| index + character.len_utf8())
        .unwrap_or(0);
    Some((start, &text[start..]))
}

fn tag_token(token: &str) -> Option<&str> {
    let tag = token.strip_prefix('#')?;
    (!tag.is_empty() && !tag.starts_with('#')).then_some(tag)
}

fn deduplicate_tags(tags: Vec<String>) -> Vec<String> {
    let mut deduplicated = Vec::with_capacity(tags.len());
    for tag in tags {
        push_unique(&mut deduplicated, tag);
    }
    deduplicated
}

fn push_unique(tags: &mut Vec<String>, tag: String) {
    if !tags.iter().any(|existing| existing == &tag) {
        tags.push(tag);
    }
}

fn parse_item(content: &str) -> Option<(String, Option<String>)> {
    let content = content.trim();
    if let Some(link) = content.strip_prefix('[') {
        let (title, destination) = link.split_once("](")?;
        let url = destination.strip_suffix(')')?;
        if !is_http_url(url) {
            return None;
        }
        let title = title.trim();
        return Some((
            url.to_string(),
            (!title.is_empty()).then(|| title.to_string()),
        ));
    }

    let url = content
        .strip_prefix('<')
        .and_then(|value| value.strip_suffix('>'))
        .unwrap_or(content);
    is_http_url(url).then(|| (url.to_string(), None))
}

fn is_http_url(url: &str) -> bool {
    if url.chars().any(char::is_whitespace) {
        return false;
    }
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some()
}

fn looks_like_feed_item(content: &str) -> bool {
    let content = content.trim();
    content.contains("://")
        || (content.starts_with('[') && content.contains("]("))
        || (content.starts_with('<') && content.ends_with('>'))
}

fn validate_url(url: &str) -> Result<(), String> {
    if is_http_url(url) {
        Ok(())
    } else {
        Err(format!("invalid feed URL: {url}"))
    }
}

fn validate_group(group: &str) -> Result<&str, String> {
    let group = group.trim();
    if group.is_empty() || group.contains('\r') || group.contains('\n') {
        Err("feed group must be a non-empty single line".to_string())
    } else {
        Ok(group)
    }
}

fn validate_title(title: Option<&str>) -> Result<Option<&str>, String> {
    let title = title.map(str::trim).filter(|title| !title.is_empty());
    if title.is_some_and(|title| title.contains('\r') || title.contains('\n')) {
        Err("feed title override must be a single line".to_string())
    } else {
        Ok(title)
    }
}

fn normalize_input_tags(tags: &[&str]) -> Result<Vec<String>, String> {
    let mut normalized = Vec::with_capacity(tags.len());
    for tag in tags {
        let tag = tag.trim().trim_start_matches('#');
        if tag.is_empty() || tag.chars().any(char::is_whitespace) {
            return Err(format!("invalid feed tag: {tag:?}"));
        }
        push_unique(&mut normalized, tag.to_string());
    }
    Ok(normalized)
}

fn render_item(url: &str, title: Option<&str>, tags: &[String]) -> String {
    let mut item = match title {
        Some(title) => format!("[{title}]({url})"),
        None => url.to_string(),
    };
    for tag in tags {
        item.push_str(" #");
        item.push_str(tag);
    }
    item
}

fn insert_item(source: &str, group: &str, item: &str) -> String {
    let document = parse_document(source);
    let newline = newline_sequence(source);
    let heading = document
        .headings
        .iter()
        .find(|heading| heading.group.eq_ignore_ascii_case(group));

    let Some(heading) = heading else {
        return append_group(source, group, item, newline);
    };
    let section_end = document
        .headings
        .iter()
        .find(|other| other.line_index > heading.line_index)
        .map(|other| other.line_index)
        .unwrap_or(document.lines.len());
    let last_feed = document
        .feeds
        .iter()
        .filter(|feed| feed.line_index > heading.line_index && feed.line_index < section_end)
        .max_by_key(|feed| feed.line_index);

    let (insert_at, needs_leading_newline) = if let Some(feed) = last_feed {
        (feed.end, feed.end == feed.body_end)
    } else {
        let mut line_index = heading.line_index + 1;
        while line_index < section_end && document.lines[line_index].body.trim().is_empty() {
            line_index += 1;
        }
        if line_index < document.lines.len() {
            (document.lines[line_index].start, false)
        } else {
            let heading_line = &document.lines[heading.line_index];
            (source.len(), heading_line.end == heading_line.body_end)
        }
    };

    let mut insertion = String::with_capacity(item.len() + newline.len() * 2 + 2);
    if needs_leading_newline {
        insertion.push_str(newline);
    }
    insertion.push_str("- ");
    insertion.push_str(item);
    insertion.push_str(newline);
    replace_span(source, insert_at, insert_at, &insertion)
}

fn append_group(source: &str, group: &str, item: &str, newline: &str) -> String {
    let mut candidate =
        String::with_capacity(source.len() + group.len() + item.len() + newline.len() * 4 + 5);
    candidate.push_str(source);
    if !candidate.is_empty() {
        if !candidate.ends_with('\n') {
            candidate.push_str(newline);
        }
        let ends_with_blank_line = candidate.ends_with("\n\n") || candidate.ends_with("\r\n\r\n");
        if !ends_with_blank_line {
            candidate.push_str(newline);
        }
    }
    candidate.push_str("## ");
    candidate.push_str(group);
    candidate.push_str(newline);
    candidate.push_str(newline);
    candidate.push_str("- ");
    candidate.push_str(item);
    candidate.push_str(newline);
    candidate
}

fn newline_sequence(text: &str) -> &'static str {
    match text.find('\n') {
        Some(index) if index > 0 && text.as_bytes()[index - 1] == b'\r' => "\r\n",
        _ => "\n",
    }
}

fn replace_span(source: &str, start: usize, end: usize, replacement: &str) -> String {
    let mut candidate = String::with_capacity(source.len() - (end - start) + replacement.len());
    candidate.push_str(&source[..start]);
    candidate.push_str(replacement);
    candidate.push_str(&source[end..]);
    candidate
}

fn validate_candidate(candidate: &str) -> Result<(), String> {
    let parsed = parse(candidate);
    if parsed.warnings.is_empty() {
        Ok(())
    } else {
        Err(parsed
            .warnings
            .iter()
            .map(|warning| format!("line {}: {}", warning.line, warning.message))
            .collect::<Vec<_>>()
            .join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::{add_feed, parse, remove_feed, update_feed};

    #[test]
    fn parses_groups_inherited_tags_and_title_overrides() {
        let parsed = parse(
            "+++\nid = 'x'\n+++\n\n## Tech #news #tech\n\n- [HN](https://news.example/rss) #tech #hn\n\n## Culture #arts\n\n- [Reviews](https://reviews.example/feed)\n",
        );

        assert!(parsed.warnings.is_empty());
        assert_eq!(parsed.feeds.len(), 2);
        assert_eq!(parsed.feeds[0].url, "https://news.example/rss");
        assert_eq!(parsed.feeds[0].group, "Tech");
        assert_eq!(parsed.feeds[0].title_override.as_deref(), Some("HN"));
        assert_eq!(parsed.feeds[0].tags, ["news", "tech", "hn"]);
        assert_eq!(parsed.feeds[0].line, 7);
        assert_eq!(parsed.feeds[1].group, "Culture");
        assert_eq!(parsed.feeds[1].title_override.as_deref(), Some("Reviews"));
        assert_eq!(parsed.feeds[1].tags, ["arts"]);
        assert_eq!(parsed.feeds[1].line, 11);
    }

    #[test]
    fn parses_bare_url_list_items_without_a_title_override() {
        let parsed = parse("## Reading\n\n- https://reader.example/feed.xml #long-form\n");

        assert!(parsed.warnings.is_empty());
        assert_eq!(parsed.feeds.len(), 1);
        assert_eq!(parsed.feeds[0].url, "https://reader.example/feed.xml");
        assert_eq!(parsed.feeds[0].title_override, None);
        assert_eq!(parsed.feeds[0].group, "Reading");
        assert_eq!(parsed.feeds[0].tags, ["long-form"]);
        assert_eq!(parsed.feeds[0].line, 3);
    }

    #[test]
    fn normalizes_and_deduplicates_tags_in_first_seen_order() {
        let parsed =
            parse("## Tech #news #tech #news\n\n- https://one.example/feed #tech #hn #hn\n");

        assert!(parsed.warnings.is_empty());
        assert_eq!(parsed.feeds[0].tags, ["news", "tech", "hn"]);
        assert!(parsed.feeds[0].tags.iter().all(|tag| !tag.starts_with('#')));
    }

    #[test]
    fn reports_the_later_line_of_a_duplicate_url() {
        let parsed = parse(
            "## One\n\n- https://same.example/feed\n\n## Two\n\n- [Same](https://same.example/feed)\n",
        );

        assert_eq!(parsed.warnings.len(), 1);
        assert_eq!(parsed.warnings[0].line, 7);
        assert!(
            parsed.warnings[0]
                .message
                .to_ascii_lowercase()
                .contains("duplicate")
        );
        assert!(
            parsed.warnings[0]
                .message
                .contains("https://same.example/feed")
        );
    }

    #[test]
    fn add_feed_rejects_a_url_already_in_the_manifest() {
        let source = "## Existing\n\n- https://same.example/feed\n\n## Other\n";

        assert!(
            add_feed(
                source,
                "Other",
                "https://same.example/feed",
                Some("Duplicate"),
                &[],
            )
            .is_err()
        );
    }

    #[test]
    fn malformed_markdown_link_items_warn_with_the_source_line() {
        let parsed =
            parse("Preamble.\n\n## Tech\n\n- [Broken](https://broken.example/feed\n\nAfter.\n");

        assert!(parsed.feeds.is_empty());
        assert_eq!(parsed.warnings.len(), 1);
        assert_eq!(parsed.warnings[0].line, 5);
        assert!(
            parsed.warnings[0]
                .message
                .to_ascii_lowercase()
                .contains("malformed")
        );
    }

    #[test]
    fn transform_preserves_frontmatter_and_unrecognized_prose_bytes() {
        let source = "+++\nid = 'x'\nkeep = \"spacing  matters\"\n+++\n\nIntro.  \n<!-- keep: α -->\n\n## Tech\n\nParagraph.  \n";
        let candidate = add_feed(source, "Tech", "https://one.example/feed", None, &[]).unwrap();

        assert!(candidate.starts_with(
            "+++\nid = 'x'\nkeep = \"spacing  matters\"\n+++\n\nIntro.  \n<!-- keep: α -->\n"
        ));
        assert!(candidate.contains("Paragraph.  \n"));
        assert!(candidate.contains("- https://one.example/feed\n"));
    }

    #[test]
    fn remove_feed_deletes_exactly_the_matching_list_item() {
        let source = "+++\nid = 'x'\n+++\n\n## Tech\n\nBefore.\n- [One](https://one.example/feed) #one\n- [Two](https://two.example/feed) #two\nAfter.\n";
        let expected = "+++\nid = 'x'\n+++\n\n## Tech\n\nBefore.\n- [Two](https://two.example/feed) #two\nAfter.\n";

        let candidate = remove_feed(source, "https://one.example/feed").unwrap();

        assert_eq!(candidate, expected);
    }

    #[test]
    fn update_feed_moves_group_and_changes_title_without_rewriting_prose() {
        let source = "+++\nid = 'x'\n+++\n\nPreamble.  \n\n## Old #legacy\n\nOld intro.\n- https://one.example/feed #personal\nOld outro.\n\n## New #current\n\nNew intro.\n- https://two.example/feed\nNew outro.  \n";

        let candidate =
            update_feed(source, "https://one.example/feed", "New", Some("One Feed")).unwrap();
        let parsed = parse(&candidate);
        let updated = parsed
            .feeds
            .iter()
            .find(|feed| feed.url == "https://one.example/feed")
            .unwrap();

        assert!(parsed.warnings.is_empty());
        assert_eq!(updated.group, "New");
        assert_eq!(updated.title_override.as_deref(), Some("One Feed"));
        assert_eq!(updated.tags, ["current", "personal"]);
        for prose in [
            "Preamble.  \n",
            "Old intro.\n",
            "Old outro.\n",
            "New intro.\n",
            "New outro.  \n",
        ] {
            assert!(
                candidate.contains(prose),
                "missing preserved prose: {prose:?}"
            );
        }
    }

    #[test]
    fn feed_shaped_malformed_links_warn_on_their_exact_lines() {
        let parsed = parse("## Tech\n\n- [Broken]()\n- <not-a-url>\n");

        assert!(parsed.feeds.is_empty());
        assert_eq!(parsed.warnings.len(), 2);
        assert_eq!(parsed.warnings[0].line, 3);
        assert_eq!(parsed.warnings[1].line, 4);
        assert!(
            parsed
                .warnings
                .iter()
                .all(|warning| warning.message.to_ascii_lowercase().contains("malformed"))
        );
    }

    #[test]
    fn warning_bearing_source_is_rejected_by_every_transform_candidate() {
        let source = "## Tech\n\n- [Broken]()\n- https://one.example/feed #personal\n\n## Other\n";

        assert!(add_feed(source, "Other", "https://two.example/feed", None, &[],).is_err());
        assert!(update_feed(source, "https://one.example/feed", "Other", Some("One"),).is_err());
        assert!(remove_feed(source, "https://one.example/feed").is_err());
    }

    #[test]
    fn http_urls_without_hosts_are_rejected_by_the_url_contract() {
        let parsed = parse("## Tech\n\n- https://?query\n- http://#fragment\n");

        assert!(parsed.feeds.is_empty());
        assert_eq!(
            parsed
                .warnings
                .iter()
                .map(|warning| warning.line)
                .collect::<Vec<_>>(),
            [3, 4]
        );
        for url in ["https://?query", "http://#fragment"] {
            assert!(add_feed("", "Tech", url, None, &[]).is_err());
        }
    }

    #[test]
    fn repeated_title_and_group_whitespace_round_trips_exactly() {
        let source = "## Research  and\tDevelopment #reading\n\n- [A  title\twith spacing](https://one.example/feed) #personal\n";
        let parsed = parse(source);

        assert!(parsed.warnings.is_empty());
        assert_eq!(parsed.feeds[0].group, "Research  and\tDevelopment");
        assert_eq!(
            parsed.feeds[0].title_override.as_deref(),
            Some("A  title\twith spacing")
        );

        let candidate = add_feed(
            "",
            "Tech",
            "https://two.example/feed",
            Some("Another  title\twith spacing"),
            &[],
        )
        .unwrap();
        let added = parse(&candidate);
        assert_eq!(
            added.feeds[0].title_override.as_deref(),
            Some("Another  title\twith spacing")
        );
    }

    #[test]
    fn add_feed_has_exact_outputs_for_empty_existing_and_missing_groups() {
        assert_eq!(
            add_feed("", "Tech", "https://one.example/feed", None, &[]).unwrap(),
            "## Tech\n\n- https://one.example/feed\n"
        );

        let toml_source = "+++\nid = 'x'\n+++\n\nIntro.\n\n## Tech\n\nParagraph.\n";
        let toml_expected =
            "+++\nid = 'x'\n+++\n\nIntro.\n\n## Tech\n\n- https://one.example/feed\nParagraph.\n";
        assert_eq!(
            add_feed(toml_source, "Tech", "https://one.example/feed", None, &[],).unwrap(),
            toml_expected
        );

        let yaml_without_final_newline = "---\r\nid: x\r\n---\r\n\r\nIntro.";
        let yaml_missing_group_expected = "---\r\nid: x\r\n---\r\n\r\nIntro.\r\n\r\n## New\r\n\r\n- [One](https://one.example/feed) #personal\r\n";
        assert_eq!(
            add_feed(
                yaml_without_final_newline,
                "New",
                "https://one.example/feed",
                Some("One"),
                &["#personal"],
            )
            .unwrap(),
            yaml_missing_group_expected
        );

        let populated_without_final_newline = "## Tech\r\n\r\n- https://old.example/feed";
        let populated_expected =
            "## Tech\r\n\r\n- https://old.example/feed\r\n- https://one.example/feed\r\n";
        assert_eq!(
            add_feed(
                populated_without_final_newline,
                "Tech",
                "https://one.example/feed",
                None,
                &[],
            )
            .unwrap(),
            populated_expected
        );
    }

    #[test]
    fn update_feed_has_exact_lf_and_crlf_outputs() {
        let same_group_source = "+++\nid = 'x'\n+++\n\n## Tech\n\nPrefix.\n\t* https://one.example/feed #personal\nSuffix.";
        let same_group_expected = "+++\nid = 'x'\n+++\n\n## Tech\n\nPrefix.\n\t* [One  Feed](https://one.example/feed) #personal\nSuffix.";
        assert_eq!(
            update_feed(
                same_group_source,
                "https://one.example/feed",
                "Tech",
                Some("One  Feed"),
            )
            .unwrap(),
            same_group_expected
        );

        let move_source = "---\r\nid: x\r\n---\r\n\r\nIntro.\r\n\r\n## Old #legacy\r\n\r\n- https://one.example/feed #personal\r\nOld prose.\r\n\r\n## New #current\r\n\r\n- https://two.example/feed\r\nNew prose.";
        let move_expected = "---\r\nid: x\r\n---\r\n\r\nIntro.\r\n\r\n## Old #legacy\r\n\r\nOld prose.\r\n\r\n## New #current\r\n\r\n- https://two.example/feed\r\n- [One](https://one.example/feed) #personal\r\nNew prose.";
        assert_eq!(
            update_feed(move_source, "https://one.example/feed", "New", Some("One"),).unwrap(),
            move_expected
        );
    }

    #[test]
    fn remove_feed_has_exact_lf_and_crlf_outputs_without_rebuilding_documents() {
        let toml_source = "+++\nid = 'x'\n+++\n\n## Tech\n\nBefore.\n- [One](https://one.example/feed) #one\n- [Two](https://two.example/feed) #two\nAfter.\n";
        let toml_expected = "+++\nid = 'x'\n+++\n\n## Tech\n\nBefore.\n- [Two](https://two.example/feed) #two\nAfter.\n";
        assert_eq!(
            remove_feed(toml_source, "https://one.example/feed").unwrap(),
            toml_expected
        );

        let yaml_without_final_newline = "---\r\nid: x\r\n---\r\n\r\n## Tech\r\n\r\n- https://one.example/feed\r\n- https://two.example/feed";
        let yaml_expected = "---\r\nid: x\r\n---\r\n\r\n## Tech\r\n\r\n- https://two.example/feed";
        assert_eq!(
            remove_feed(yaml_without_final_newline, "https://one.example/feed",).unwrap(),
            yaml_expected
        );
    }

    #[test]
    fn parser_rejects_urls_containing_unicode_whitespace() {
        let parsed = parse(
            "## Tech\n\n- https://example.com/\tfeed\n- [Leading]( https://example.com/feed)\n- [Trailing](https://example.com/feed )\n- https://example.com/\u{00a0}feed\n",
        );

        assert!(parsed.feeds.is_empty());
        assert_eq!(
            parsed
                .warnings
                .iter()
                .map(|warning| warning.line)
                .collect::<Vec<_>>(),
            [3, 4, 5, 6]
        );
    }

    #[test]
    fn every_transform_rejects_whitespace_bearing_url_inputs_as_invalid() {
        let source = "## Tech\n\n- https://one.example/feed\n";
        for url in [
            " https://one.example/feed",
            "https://one.example/feed ",
            "https://one.example/\tfeed",
            "https://one.example/\nfeed",
            "https://one.example/\rfeed",
            "https://one.example/\u{00a0}feed",
        ] {
            let add_error = add_feed("", "Tech", url, None, &[]).unwrap_err();
            assert!(
                add_error.contains("invalid feed URL"),
                "add accepted or misclassified {url:?}: {add_error}"
            );

            let update_error = update_feed(source, url, "Other", Some("One")).unwrap_err();
            assert!(
                update_error.contains("invalid feed URL"),
                "update accepted or misclassified {url:?}: {update_error}"
            );

            let remove_error = remove_feed(source, url).unwrap_err();
            assert!(
                remove_error.contains("invalid feed URL"),
                "remove accepted or misclassified {url:?}: {remove_error}"
            );
        }
    }
}
