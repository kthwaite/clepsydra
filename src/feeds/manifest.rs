//! `feeds.md` is the source of truth for subscriptions. `##` sections are
//! groups; trailing `#tag` tokens on a heading apply to the whole section and
//! on a list item to that feed. Anything the parser doesn't understand is
//! preserved untouched — the manifest remains an ordinary vault note.

#[derive(Debug, Clone, PartialEq)]
pub struct ManifestFeed {
    pub url: String,
    pub title_override: Option<String>,
    pub group: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Default)]
pub struct Manifest {
    pub feeds: Vec<ManifestFeed>,
    pub warnings: Vec<String>,
}

pub fn parse(text: &str) -> Manifest {
    let mut m = Manifest::default();
    let mut group: Option<String> = None;
    let mut section_tags: Vec<String> = Vec::new();

    for (i, line) in text.lines().enumerate() {
        let t = line.trim();
        if let Some(h) = heading_text(t) {
            let (name, tags) = split_tags(h);
            group = (!name.is_empty()).then_some(name);
            section_tags = tags;
        } else if let Some(item) = list_item_text(t) {
            let (content, item_tags) = split_tags(item);
            match parse_item(&content) {
                Some((url, title_override)) => {
                    if m.feeds.iter().any(|f| f.url == url) {
                        m.warnings
                            .push(format!("line {}: duplicate feed {url}", i + 1));
                        continue;
                    }
                    let mut tags = section_tags.clone();
                    for t in item_tags {
                        if !tags.contains(&t) {
                            tags.push(t);
                        }
                    }
                    m.feeds.push(ManifestFeed {
                        url,
                        title_override,
                        group: group.clone(),
                        tags,
                    });
                }
                // A list item mentioning :// was probably meant to be a feed;
                // anything else is prose and none of our business.
                None if content.contains("://") => m
                    .warnings
                    .push(format!("line {}: unrecognized feed item: {content}", i + 1)),
                None => {}
            }
        }
    }
    m
}

fn heading_text(line: &str) -> Option<&str> {
    line.strip_prefix("## ").map(str::trim)
}

fn list_item_text(line: &str) -> Option<&str> {
    line.strip_prefix("- ")
        .or_else(|| line.strip_prefix("* "))
        .map(str::trim)
}

/// Split trailing `#tag` tokens off a heading or list item.
fn split_tags(s: &str) -> (String, Vec<String>) {
    let mut tokens: Vec<&str> = s.split_whitespace().collect();
    let mut tags = Vec::new();
    while let Some(last) = tokens.last() {
        if last.len() > 1 && last.starts_with('#') && !last[1..].starts_with('#') {
            tags.push(last[1..].to_string());
            tokens.pop();
        } else {
            break;
        }
    }
    tags.reverse();
    (tokens.join(" "), tags)
}

/// A list item is a bare URL, an `<autolink>`, or a `[Title](url)` link.
fn parse_item(s: &str) -> Option<(String, Option<String>)> {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix('[') {
        let (title, rest) = rest.split_once("](")?;
        let url = rest.strip_suffix(')')?.trim();
        is_url(url).then(|| (url.to_string(), Some(title.trim().to_string())))
    } else {
        let bare = s
            .strip_prefix('<')
            .and_then(|s| s.strip_suffix('>'))
            .unwrap_or(s);
        let url = bare.split_whitespace().next()?;
        is_url(url).then(|| (url.to_string(), None))
    }
}

fn is_url(s: &str) -> bool {
    s.starts_with("http://") || s.starts_with("https://")
}

/// Render a feed as a manifest list item (without the leading `- `).
pub fn render_item(url: &str, title: Option<&str>, tags: &[String]) -> String {
    let mut out = match title {
        Some(t) if !t.is_empty() => format!("[{t}]({url})"),
        _ => url.to_string(),
    };
    for tag in tags {
        out.push_str(&format!(" #{tag}"));
    }
    out
}

/// Append a feed item to a group's section, creating the section (at the end
/// of the note) if it doesn't exist. `item` is a rendered item without `- `.
pub fn add_item(text: &str, group: &str, item: &str) -> String {
    let mut lines: Vec<String> = text.lines().map(String::from).collect();

    // Find the group's heading, matching with tags stripped, case-insensitive.
    let heading_idx = lines.iter().position(|l| {
        heading_text(l.trim())
            .map(|h| split_tags(h).0.eq_ignore_ascii_case(group))
            .unwrap_or(false)
    });

    match heading_idx {
        Some(h) => {
            // Insert after the last list item in the section, or right after
            // the heading (skipping adjacent blank/prose lines up to the first
            // item) if the section has none.
            let section_end = lines[h + 1..]
                .iter()
                .position(|l| heading_text(l.trim()).is_some())
                .map(|p| h + 1 + p)
                .unwrap_or(lines.len());
            let last_item = (h + 1..section_end)
                .rev()
                .find(|&i| list_item_text(lines[i].trim()).is_some());
            let insert_at = match last_item {
                Some(i) => i + 1,
                None => {
                    // After the heading and any immediately-following blank line.
                    let mut i = h + 1;
                    while i < section_end && lines[i].trim().is_empty() {
                        i += 1;
                    }
                    i
                }
            };
            lines.insert(insert_at, format!("- {item}"));
        }
        None => {
            if !lines.is_empty() && !lines.last().unwrap().trim().is_empty() {
                lines.push(String::new());
            }
            lines.push(format!("## {group}"));
            lines.push(String::new());
            lines.push(format!("- {item}"));
        }
    }
    lines.join("\n") + "\n"
}

/// Remove the list item for `url`. Returns the new text and the removed
/// item's content (tags included, `- ` stripped) if it was found.
pub fn remove_item(text: &str, url: &str) -> (String, Option<String>) {
    let mut removed = None;
    let lines: Vec<&str> = text
        .lines()
        .filter(|l| {
            if removed.is_none()
                && let Some(item) = list_item_text(l.trim())
            {
                let (content, _) = split_tags(item);
                if parse_item(&content).map(|(u, _)| u).as_deref() == Some(url) {
                    removed = Some(item.to_string());
                    return false;
                }
            }
            true
        })
        .collect();
    (lines.join("\n") + "\n", removed)
}

/// Rewrite the item line for `url` with a new title override (None clears it),
/// preserving its tags and position.
pub fn set_title(text: &str, url: &str, title: Option<&str>) -> String {
    text.lines()
        .map(|l| {
            let t = l.trim();
            if let Some(item) = list_item_text(t) {
                let (content, tags) = split_tags(item);
                if parse_item(&content).map(|(u, _)| u) == Some(url.to_string()) {
                    let indent = &l[..l.len() - l.trim_start().len()];
                    return format!("{indent}- {}", render_item(url, title, &tags));
                }
            }
            l.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

/// Move a feed's item to another group, preserving its title and tags.
pub fn move_item(text: &str, url: &str, new_group: &str) -> String {
    let (without, removed) = remove_item(text, url);
    match removed {
        Some(item) => add_item(&without, new_group, &item),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
# feeds

some prose that should be left alone.

## News #news

- https://example.com/world.rss
- [FT](https://ft.example.com/rss) #finance

## Tech News #news #tech

things i skim in the morning:

- <https://arstechnica.example/feed/>
- not a feed, just a list item
- https://hn.example/rss #hn

## Empty Section #quiet
";

    #[test]
    fn parses_groups_tags_and_overrides() {
        let m = parse(SAMPLE);
        assert_eq!(m.feeds.len(), 4);
        assert!(m.warnings.is_empty());

        let ft = &m.feeds[1];
        assert_eq!(ft.url, "https://ft.example.com/rss");
        assert_eq!(ft.title_override.as_deref(), Some("FT"));
        assert_eq!(ft.group.as_deref(), Some("News"));
        assert_eq!(ft.tags, vec!["news", "finance"]);

        let ars = &m.feeds[2];
        assert_eq!(ars.url, "https://arstechnica.example/feed/");
        assert_eq!(ars.group.as_deref(), Some("Tech News"));
        assert_eq!(ars.tags, vec!["news", "tech"]);

        let hn = &m.feeds[3];
        assert_eq!(hn.tags, vec!["news", "tech", "hn"]);
    }

    #[test]
    fn warns_on_broken_feed_like_items_only() {
        let m = parse("## G\n\n- htp://typo.example/feed x\n- plain prose\n");
        assert_eq!(m.feeds.len(), 0);
        assert_eq!(m.warnings.len(), 1);
        assert!(m.warnings[0].contains("line 3"));
    }

    #[test]
    fn warns_on_duplicates() {
        let m = parse("## A\n- https://x.example/f\n## B\n- https://x.example/f\n");
        assert_eq!(m.feeds.len(), 1);
        assert_eq!(m.feeds[0].group.as_deref(), Some("A"));
        assert_eq!(m.warnings.len(), 1);
    }

    #[test]
    fn add_appends_to_existing_section() {
        let out = add_item(SAMPLE, "News", "https://new.example/rss");
        let m = parse(&out);
        let added = m.feeds.iter().find(|f| f.url == "https://new.example/rss");
        assert_eq!(added.unwrap().group.as_deref(), Some("News"));
        // prose untouched
        assert!(out.contains("some prose that should be left alone."));
        assert!(out.contains("things i skim in the morning:"));
    }

    #[test]
    fn add_to_empty_section_and_missing_section() {
        let out = add_item(SAMPLE, "Empty Section", "https://q.example/rss");
        let m = parse(&out);
        let f = m.feeds.iter().find(|f| f.url == "https://q.example/rss");
        assert_eq!(f.unwrap().group.as_deref(), Some("Empty Section"));
        assert_eq!(f.unwrap().tags, vec!["quiet"]);

        let out = add_item(SAMPLE, "Brand New", "https://b.example/rss");
        let m = parse(&out);
        let f = m.feeds.iter().find(|f| f.url == "https://b.example/rss");
        assert_eq!(f.unwrap().group.as_deref(), Some("Brand New"));
    }

    #[test]
    fn remove_and_move_preserve_the_rest() {
        let (out, removed) = remove_item(SAMPLE, "https://ft.example.com/rss");
        assert_eq!(removed.as_deref(), Some("[FT](https://ft.example.com/rss) #finance"));
        assert_eq!(parse(&out).feeds.len(), 3);

        let out = move_item(SAMPLE, "https://ft.example.com/rss", "Tech News");
        let m = parse(&out);
        let ft = m.feeds.iter().find(|f| f.url == "https://ft.example.com/rss").unwrap();
        assert_eq!(ft.group.as_deref(), Some("Tech News"));
        assert_eq!(ft.title_override.as_deref(), Some("FT"));
        // item tag survives; section tags now come from the new section
        assert!(ft.tags.contains(&"finance".to_string()));
        assert!(ft.tags.contains(&"tech".to_string()));
    }

    #[test]
    fn set_title_rewrites_in_place() {
        let out = set_title(SAMPLE, "https://hn.example/rss", Some("Hacker News"));
        let m = parse(&out);
        let hn = m.feeds.iter().find(|f| f.url == "https://hn.example/rss").unwrap();
        assert_eq!(hn.title_override.as_deref(), Some("Hacker News"));
        assert!(hn.tags.contains(&"hn".to_string()));

        let out = set_title(&out, "https://hn.example/rss", None);
        let m = parse(&out);
        let hn = m.feeds.iter().find(|f| f.url == "https://hn.example/rss").unwrap();
        assert_eq!(hn.title_override, None);
    }
}
