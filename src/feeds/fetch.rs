use std::fmt::Write as _;

use chrono::{DateTime, Duration, Utc};
use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use reqwest::header::{CONTENT_TYPE, ETAG, HeaderMap, HeaderName, LAST_MODIFIED};
use reqwest::{StatusCode, Url};
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::network::{CheckedHttpClient, CheckedHttpError, ConditionalRequest};
use super::types::{FeedSummary, FetchOutcome, FetchedEntry};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFeed {
    pub title: Option<String>,
    pub site_url: Option<String>,
    pub entries: Vec<ParsedEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedEntry {
    pub guid: String,
    pub url: Option<String>,
    pub title: String,
    pub author: Option<String>,
    pub content_html: Option<String>,
    pub published_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Error)]
pub enum FetchError {
    #[error(transparent)]
    CheckedHttp(#[from] CheckedHttpError),
    #[error("invalid feed URL {url:?}: {reason}")]
    InvalidUrl { url: String, reason: String },
    #[error("feed request returned HTTP status {0}")]
    HttpStatus(StatusCode),
    #[error("feed could not be parsed: {0}")]
    FeedParse(#[from] feed_rs::parser::ParseFeedError),
    #[error("HTML feed discovery failed: {0}")]
    Discovery(String),
}

pub fn parse_feed(body: &[u8], max_entry_content_bytes: usize) -> Result<ParsedFeed, FetchError> {
    let feed = feed_rs::parser::Builder::new()
        .id_generator(|_, _, _| String::new())
        .build()
        .parse(body)?;
    let title = feed.title.map(|title| title.content);
    let site_url = preferred_link(&feed.links).map(ToOwned::to_owned);
    let entries = feed
        .entries
        .into_iter()
        .map(|entry| parsed_entry(entry, max_entry_content_bytes))
        .collect();

    Ok(ParsedFeed {
        title,
        site_url,
        entries,
    })
}

pub async fn discover_feed_url(
    client: &CheckedHttpClient,
    candidate: &str,
) -> Result<Url, FetchError> {
    discover_feed_url_before(
        client,
        candidate,
        tokio::time::Instant::now() + client.deadline(),
    )
    .await
}

/// Discover a feed without resetting the enclosing operation's deadline
/// between an HTML candidate and its RSS/Atom alternate.
pub async fn discover_feed_url_before(
    client: &CheckedHttpClient,
    candidate: &str,
    deadline: tokio::time::Instant,
) -> Result<Url, FetchError> {
    let candidate_url = parse_url(candidate)?;
    let response = client.get_before(candidate_url, None, deadline).await?;
    ensure_success(response.status)?;

    match parse_feed(&response.body, 0) {
        Ok(_) => return Ok(response.final_url),
        Err(parse_error) if !is_html_response(&response.headers) => return Err(parse_error),
        Err(_) => {}
    }

    let alternate = html_feed_alternate(&response.body, &response.final_url)?
        .ok_or_else(|| FetchError::Discovery("no RSS or Atom alternate link was found".into()))?;
    let alternate_response = client.get_before(alternate, None, deadline).await?;
    ensure_success(alternate_response.status)?;
    parse_feed(&alternate_response.body, 0)?;

    Ok(alternate_response.final_url)
}

pub async fn fetch_feed(
    client: &CheckedHttpClient,
    feed: &FeedSummary,
    fetched_at: DateTime<Utc>,
    fetch_interval: Duration,
    max_entry_content_bytes: usize,
) -> Result<FetchOutcome, FetchError> {
    let url = parse_url(feed.fetch_url.as_deref().unwrap_or(&feed.url))?;
    let conditional = ConditionalRequest {
        etag: feed.etag.clone(),
        last_modified: feed.last_modified.clone(),
    };
    let response = client.get(url, Some(&conditional)).await?;

    if response.status == StatusCode::NOT_MODIFIED {
        return Ok(FetchOutcome::NotModified {
            fetched_at,
            next_fetch_at: fetched_at + fetch_interval,
            etag: response_header(&response.headers, &ETAG).or_else(|| feed.etag.clone()),
            last_modified: response_header(&response.headers, &LAST_MODIFIED)
                .or_else(|| feed.last_modified.clone()),
        });
    }
    ensure_success(response.status)?;
    let fetch_url = response.final_url.to_string();

    let etag = response_header(&response.headers, &ETAG);
    let last_modified = response_header(&response.headers, &LAST_MODIFIED);
    let parsed = parse_feed(&response.body, max_entry_content_bytes)?;
    let entries = parsed
        .entries
        .into_iter()
        .map(|entry| FetchedEntry {
            guid: entry.guid,
            url: entry.url,
            title: entry.title,
            author: entry.author,
            content_html: entry.content_html,
            published_at: entry.published_at,
            fetched_at,
        })
        .collect();

    Ok(FetchOutcome::Success {
        fetched_at,
        next_fetch_at: fetched_at + fetch_interval,
        fetch_url,
        etag,
        last_modified,
        title: parsed.title,
        site_url: parsed.site_url,
        entries,
    })
}

pub async fn fetch_subscription(
    client: &CheckedHttpClient,
    feed: &FeedSummary,
    fetched_at: DateTime<Utc>,
    fetch_interval: Duration,
    max_entry_content_bytes: usize,
) -> FetchOutcome {
    match fetch_feed(
        client,
        feed,
        fetched_at,
        fetch_interval,
        max_entry_content_bytes,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => FetchOutcome::Failure {
            fetched_at,
            next_fetch_at: fetched_at + next_fetch_after(fetch_interval, feed.error_count),
            error: error.to_string(),
        },
    }
}

pub fn next_fetch_after(base: Duration, error_count: u32) -> Duration {
    let cap = Duration::hours(24);
    if base <= Duration::zero() {
        return base;
    }

    let mut delay = base.min(cap);
    for _ in 0..error_count {
        if delay >= cap {
            return cap;
        }
        delay = delay.checked_add(&delay).unwrap_or(cap).min(cap);
    }
    delay
}

fn parsed_entry(entry: feed_rs::model::Entry, max_entry_content_bytes: usize) -> ParsedEntry {
    let feed_rs::model::Entry {
        id,
        title,
        updated,
        authors,
        content,
        links,
        summary,
        published,
        ..
    } = entry;
    let url = preferred_link(&links).map(ToOwned::to_owned);
    let title = title
        .map(|title| title.content)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| url.clone().unwrap_or_else(|| "Untitled".to_owned()));
    let author = authors
        .into_iter()
        .map(|author| author.name)
        .find(|author| !author.trim().is_empty());
    let raw_content = content
        .and_then(|content| content.body)
        .or_else(|| summary.map(|summary| summary.content));
    let published_at = published.or(updated);
    let guid = if !id.trim().is_empty() {
        id
    } else if let Some(url) = url.as_deref() {
        url.to_owned()
    } else {
        stable_entry_guid(
            &title,
            author.as_deref(),
            raw_content.as_deref(),
            published_at.as_ref(),
        )
    };
    let content_html = raw_content.and_then(|content| {
        if content.len() > max_entry_content_bytes {
            return None;
        }
        let sanitized = ammonia::clean(&content);
        (sanitized.len() <= max_entry_content_bytes).then_some(sanitized)
    });

    ParsedEntry {
        guid,
        url,
        title,
        author,
        content_html,
        published_at,
    }
}

fn preferred_link(links: &[feed_rs::model::Link]) -> Option<&str> {
    links
        .iter()
        .filter(|link| {
            link.rel
                .as_deref()
                .is_none_or(|relation| relation.eq_ignore_ascii_case("alternate"))
        })
        .find_map(|link| safe_web_link(&link.href))
        .or_else(|| links.iter().find_map(|link| safe_web_link(&link.href)))
}

fn safe_web_link(href: &str) -> Option<&str> {
    Url::parse(href)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
        .map(|_| href)
}

fn stable_entry_guid(
    title: &str,
    author: Option<&str>,
    content: Option<&str>,
    published_at: Option<&DateTime<Utc>>,
) -> String {
    let mut digest = Sha256::new();
    hash_component(&mut digest, title.as_bytes());
    hash_component(&mut digest, author.unwrap_or_default().as_bytes());
    hash_component(&mut digest, content.unwrap_or_default().as_bytes());
    if let Some(published_at) = published_at {
        hash_component(&mut digest, published_at.to_rfc3339().as_bytes());
    } else {
        hash_component(&mut digest, &[]);
    }

    let digest = digest.finalize();
    let mut guid = String::with_capacity(7 + digest.len() * 2);
    guid.push_str("sha256:");
    for byte in digest {
        write!(&mut guid, "{byte:02x}").expect("writing to a String cannot fail");
    }
    guid
}

fn hash_component(digest: &mut Sha256, component: &[u8]) {
    digest.update((component.len() as u64).to_be_bytes());
    digest.update(component);
}

fn parse_url(candidate: &str) -> Result<Url, FetchError> {
    Url::parse(candidate).map_err(|error| FetchError::InvalidUrl {
        url: candidate.to_owned(),
        reason: error.to_string(),
    })
}

fn ensure_success(status: StatusCode) -> Result<(), FetchError> {
    if status.is_success() {
        Ok(())
    } else {
        Err(FetchError::HttpStatus(status))
    }
}

fn response_header(headers: &HeaderMap, name: &HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}

fn is_html_response(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/html"))
}

fn html_feed_alternate(body: &[u8], base: &Url) -> Result<Option<Url>, FetchError> {
    let mut reader = Reader::from_reader(body);
    let mut buffer = Vec::new();

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element) | Event::Empty(element))
                if element.name().as_ref().eq_ignore_ascii_case(b"link") =>
            {
                if let Some(href) = alternate_href(&reader, &element)? {
                    return base
                        .join(&href)
                        .map(Some)
                        .map_err(|error| FetchError::Discovery(error.to_string()));
                }
            }
            Ok(Event::Eof) => return Ok(None),
            Ok(_) => {}
            Err(error) => return Err(FetchError::Discovery(error.to_string())),
        }
        buffer.clear();
    }
}

fn alternate_href(
    reader: &Reader<&[u8]>,
    element: &BytesStart<'_>,
) -> Result<Option<String>, FetchError> {
    let mut rel = None;
    let mut media_type = None;
    let mut href = None;

    for attribute in element.attributes().with_checks(false) {
        let attribute = attribute.map_err(|error| FetchError::Discovery(error.to_string()))?;
        let value = attribute
            .decode_and_unescape_value(reader.decoder())
            .map_err(|error| FetchError::Discovery(error.to_string()))?
            .into_owned();
        if attribute.key.as_ref().eq_ignore_ascii_case(b"rel") {
            rel = Some(value);
        } else if attribute.key.as_ref().eq_ignore_ascii_case(b"type") {
            media_type = Some(value);
        } else if attribute.key.as_ref().eq_ignore_ascii_case(b"href") {
            href = Some(value);
        }
    }

    let is_alternate = rel.as_deref().is_some_and(|relations| {
        relations
            .split_ascii_whitespace()
            .any(|relation| relation.eq_ignore_ascii_case("alternate"))
    });
    let is_feed = media_type.as_deref().is_some_and(|media_type| {
        let media_type = media_type.split(';').next().unwrap_or_default().trim();
        media_type.eq_ignore_ascii_case("application/rss+xml")
            || media_type.eq_ignore_ascii_case("application/atom+xml")
    });

    Ok((is_alternate && is_feed).then_some(href).flatten())
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::sync::Arc;

    use chrono::{DateTime, Duration, Utc};
    use wiremock::matchers::{header, header_regex, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;
    use crate::feeds::network::{CheckedHttpClient, HostResolver};
    use crate::feeds::types::{FeedSummary, FetchOutcome};

    const RSS_CONTENT_TYPE: &str = "application/rss+xml; charset=utf-8";
    const ATOM_CONTENT_TYPE: &str = "application/atom+xml; charset=utf-8";

    struct MappingResolver {
        address: SocketAddr,
    }

    impl HostResolver for MappingResolver {
        fn resolve<'a>(
            &'a self,
            _host: &'a str,
            _port: u16,
        ) -> std::pin::Pin<Box<dyn Future<Output = std::io::Result<Vec<SocketAddr>>> + Send + 'a>>
        {
            let address = self.address;
            Box::pin(async move { Ok(vec![address]) })
        }
    }

    fn fixture_client(server: &MockServer, max_response_bytes: usize) -> CheckedHttpClient {
        CheckedHttpClient::for_test(
            max_response_bytes,
            "feed.test",
            SocketAddr::new(server.address().ip(), server.address().port()),
        )
        .expect("fixture client should build")
    }

    fn fixture_url(server: &MockServer, path: &str) -> String {
        format!("http://feed.test:{}{path}", server.address().port())
    }

    fn fetched_at() -> DateTime<Utc> {
        "2026-08-09T12:00:00Z".parse().unwrap()
    }

    fn subscription(id: i64, url: String) -> FeedSummary {
        FeedSummary {
            id,
            url,
            fetch_url: None,
            site_url: None,
            title: "Pending title".to_owned(),
            title_override: None,
            group: "News".to_owned(),
            tags: vec!["fixture".to_owned()],
            subscribed: true,
            etag: None,
            last_modified: None,
            last_fetch_at: None,
            next_fetch_at: fetched_at(),
            error_count: 0,
            last_error: None,
        }
    }

    fn rss_document(items: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Fixture RSS</title>
    <link>https://publisher.example/</link>
    <description>A deterministic RSS fixture.</description>
    {items}
  </channel>
</rss>"#
        )
    }

    fn one_item_rss(content: &str) -> String {
        rss_document(&format!(
            r#"<item>
      <guid isPermaLink="false">rss-guid-1</guid>
      <title>RSS entry</title>
      <link>https://publisher.example/rss-entry</link>
      <dc:creator>RSS Author</dc:creator>
      <pubDate>Sun, 09 Aug 2026 10:00:00 +0000</pubDate>
      <content:encoded><![CDATA[{content}]]></content:encoded>
    </item>"#
        ))
    }

    fn atom_document() -> &'static str {
        r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>urn:fixture:atom</id>
  <title>Fixture Atom</title>
  <updated>2026-08-09T11:30:00Z</updated>
  <link rel="alternate" href="https://atom.example/" />
  <entry>
    <id>urn:fixture:atom-entry-1</id>
    <title>Atom entry</title>
    <updated>2026-08-09T11:00:00Z</updated>
    <link rel="alternate" href="https://atom.example/entry-1" />
    <author><name>Atom Author</name></author>
    <content type="html">&lt;p&gt;Atom body&lt;/p&gt;</content>
  </entry>
</feed>"#
    }

    #[test]
    fn parses_rss_metadata_and_entry_fields() {
        let parsed = parse_feed(one_item_rss("<p>RSS body</p>").as_bytes(), 1024).unwrap();

        assert_eq!(parsed.title.as_deref(), Some("Fixture RSS"));
        assert_eq!(
            parsed.site_url.as_deref(),
            Some("https://publisher.example/")
        );
        assert_eq!(parsed.entries.len(), 1);
        let entry = &parsed.entries[0];
        assert_eq!(entry.guid, "rss-guid-1");
        assert_eq!(
            entry.url.as_deref(),
            Some("https://publisher.example/rss-entry")
        );
        assert_eq!(entry.title, "RSS entry");
        assert_eq!(entry.author.as_deref(), Some("RSS Author"));
        assert_eq!(entry.content_html.as_deref(), Some("<p>RSS body</p>"));
        assert_eq!(
            entry.published_at,
            Some("2026-08-09T10:00:00Z".parse().unwrap())
        );
    }

    #[test]
    fn parses_atom_metadata_and_entry_fields() {
        let parsed = parse_feed(atom_document().as_bytes(), 1024).unwrap();

        assert_eq!(parsed.title.as_deref(), Some("Fixture Atom"));
        assert_eq!(parsed.site_url.as_deref(), Some("https://atom.example/"));
        assert_eq!(parsed.entries.len(), 1);
        let entry = &parsed.entries[0];
        assert_eq!(entry.guid, "urn:fixture:atom-entry-1");
        assert_eq!(entry.url.as_deref(), Some("https://atom.example/entry-1"));
        assert_eq!(entry.title, "Atom entry");
        assert_eq!(entry.author.as_deref(), Some("Atom Author"));
        assert_eq!(entry.content_html.as_deref(), Some("<p>Atom body</p>"));
        assert_eq!(
            entry.published_at,
            Some("2026-08-09T11:00:00Z".parse().unwrap())
        );
    }

    #[test]
    fn entry_urls_allow_only_absolute_http_and_https_destinations() {
        let xml = rss_document(
            r#"<item>
      <guid>https-link</guid><title>HTTPS</title>
      <link>https://publisher.example/secure</link><description>safe</description>
    </item>
    <item>
      <guid>http-link</guid><title>HTTP</title>
      <link>http://publisher.example/plain</link><description>safe</description>
    </item>
    <item>
      <guid>javascript-link</guid><title>JavaScript</title>
      <link>javascript:alert(1)</link><description>unsafe</description>
    </item>
    <item>
      <guid>data-link</guid><title>Data</title>
      <link>data:text/html,unsafe</link><description>unsafe</description>
    </item>
    <item>
      <guid>file-link</guid><title>File</title>
      <link>file:///etc/passwd</link><description>unsafe</description>
    </item>
    <item>
      <guid>custom-link</guid><title>Custom</title>
      <link>reader:open-me</link><description>unsafe</description>
    </item>
    <item>
      <guid>malformed-link</guid><title>Malformed</title>
      <link>not a url</link><description>unsafe</description>
    </item>
    <item>
      <guid>hostless-link</guid><title>Hostless</title>
      <link>https://</link><description>unsafe</description>
    </item>
    <item>
      <title>Unsafe fallback</title>
      <link>javascript:alert(2)</link>
      <description>must hash instead of adopting the unsafe link as a GUID</description>
    </item>"#,
        );

        let parsed = parse_feed(xml.as_bytes(), 4096).unwrap();
        let urls: Vec<_> = parsed
            .entries
            .iter()
            .map(|entry| entry.url.as_deref())
            .collect();

        assert_eq!(
            urls,
            vec![
                Some("https://publisher.example/secure"),
                Some("http://publisher.example/plain"),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            ]
        );
        assert!(parsed.entries[8].guid.starts_with("sha256:"));
        assert!(!parsed.entries[8].guid.contains("javascript:"));
    }

    #[test]
    fn guid_falls_back_to_link_then_to_a_stable_content_hash() {
        let xml = rss_document(
            r#"<item>
      <title>Linked fallback</title>
      <link>https://publisher.example/link-fallback</link>
      <description>Has a link but no GUID.</description>
    </item>
    <item>
      <title>Stable fallback</title>
      <pubDate>Sun, 09 Aug 2026 09:00:00 +0000</pubDate>
      <description>Has neither a GUID nor a link.</description>
    </item>"#,
        );

        let first = parse_feed(xml.as_bytes(), 1024).unwrap();
        let second = parse_feed(xml.as_bytes(), 1024).unwrap();
        assert_eq!(
            first.entries[0].guid,
            "https://publisher.example/link-fallback"
        );
        assert_eq!(
            first.entries[1].guid,
            "sha256:9e808ca8822208885a4d7c0132089ed8f14d531fc43ff614187898d315d53a66"
        );
        assert_eq!(first.entries[1].guid, second.entries[1].guid);

        let changed = xml.replace("Stable fallback", "Changed fallback");
        let changed = parse_feed(changed.as_bytes(), 1024).unwrap();
        assert_ne!(first.entries[1].guid, changed.entries[1].guid);
    }

    #[test]
    fn sanitized_entries_remove_scripts_and_event_handlers() {
        let xml = one_item_rss(r#"<p onclick="steal()">safe</p><script>steal()</script>"#);

        let mut parsed = parse_feed(xml.as_bytes(), 1_048_576).unwrap();
        let html = parsed.entries.remove(0).content_html.unwrap();

        assert!(html.contains("<p>safe</p>"), "sanitized HTML was {html:?}");
        assert!(!html.contains("onclick"), "sanitized HTML was {html:?}");
        assert!(!html.contains("<script"), "sanitized HTML was {html:?}");
    }

    #[test]
    fn oversized_entry_content_is_omitted_without_losing_the_source_url() {
        let xml = one_item_rss("<p>This body is intentionally over the entry cap.</p>");

        let parsed = parse_feed(xml.as_bytes(), 24).unwrap();
        let entry = &parsed.entries[0];

        assert_eq!(entry.content_html, None);
        assert_eq!(
            entry.url.as_deref(),
            Some("https://publisher.example/rss-entry")
        );
    }

    #[tokio::test]
    async fn fetched_entries_never_expose_an_unsafe_publisher_link() {
        let server = MockServer::start().await;
        let xml = rss_document(
            r#"<item>
      <guid>unsafe-ingested-link</guid>
      <title>Unsafe ingested link</title>
      <link>javascript:alert(document.cookie)</link>
      <description>The entry itself is otherwise valid.</description>
    </item>"#,
        );
        Mock::given(method("GET"))
            .and(path("/unsafe-link.xml"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", RSS_CONTENT_TYPE)
                    .set_body_string(xml),
            )
            .expect(1)
            .mount(&server)
            .await;
        let client = fixture_client(&server, 16 * 1024);
        let feed = subscription(7, fixture_url(&server, "/unsafe-link.xml"));

        let outcome = fetch_feed(&client, &feed, fetched_at(), Duration::minutes(30), 4096)
            .await
            .unwrap();

        match outcome {
            FetchOutcome::Success { entries, .. } => {
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].guid, "unsafe-ingested-link");
                assert_eq!(entries[0].url, None);
            }
            other => panic!("unsafe-link feed produced {other:?}"),
        }
        server.verify().await;
    }

    #[tokio::test]
    async fn discovers_and_validates_a_relative_html_alternate() {
        let server = MockServer::start().await;
        let html = r#"<!doctype html>
<html><head>
  <link rel="stylesheet" href="/site.css">
  <link title="News" href="/feed.xml" type="application/rss+xml" rel="alternate">
</head><body>Fixture page</body></html>"#;
        Mock::given(method("GET"))
            .and(path("/publication"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_raw(html.as_bytes(), "text/html; charset=utf-8"),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/feed.xml"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", RSS_CONTENT_TYPE)
                    .set_body_string(one_item_rss("<p>Discovered</p>")),
            )
            .expect(1)
            .mount(&server)
            .await;
        let client = fixture_client(&server, 16 * 1024);

        let discovered = discover_feed_url(&client, &fixture_url(&server, "/publication"))
            .await
            .expect("valid alternate should be discovered and parsed");

        assert_eq!(discovered.as_str(), fixture_url(&server, "/feed.xml"));
        server.verify().await;
    }

    #[tokio::test]
    async fn sends_stored_validators_and_preserves_them_on_304() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/conditional.xml"))
            .and(header("if-none-match", "\"fixture-v1\""))
            .and(header_regex(
                "if-modified-since",
                "^Sun, 09 Aug 2026 08:00:00 GMT$",
            ))
            .respond_with(ResponseTemplate::new(304))
            .expect(1)
            .mount(&server)
            .await;
        let client = fixture_client(&server, 4096);
        let mut feed = subscription(1, fixture_url(&server, "/conditional.xml"));
        feed.etag = Some("\"fixture-v1\"".to_owned());
        feed.last_modified = Some("Sun, 09 Aug 2026 08:00:00 GMT".to_owned());
        feed.error_count = 7;
        let now = fetched_at();
        let interval = Duration::minutes(30);

        let outcome = fetch_feed(&client, &feed, now, interval, 1024)
            .await
            .expect("304 is a successful conditional fetch");

        assert_eq!(
            outcome,
            FetchOutcome::NotModified {
                fetched_at: now,
                next_fetch_at: now + interval,
                etag: feed.etag.clone(),
                last_modified: feed.last_modified.clone(),
            }
        );
        server.verify().await;
    }

    #[tokio::test]
    async fn redirected_feed_persists_canonical_url_and_scopes_validators_to_that_origin() {
        let server = MockServer::start().await;
        let redirect_url = format!(
            "http://redirect.test:{}/subscription",
            server.address().port()
        );
        let canonical_url = format!("http://feed.test:{}/feed.xml", server.address().port());
        Mock::given(method("GET"))
            .and(path("/subscription"))
            .respond_with(
                ResponseTemplate::new(302).insert_header("location", canonical_url.as_str()),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/feed.xml"))
            .and(header("if-none-match", "\"canonical-v1\""))
            .respond_with(ResponseTemplate::new(304))
            .with_priority(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/feed.xml"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", RSS_CONTENT_TYPE)
                    .insert_header("etag", "\"canonical-v1\"")
                    .set_body_string(one_item_rss("<p>Canonical</p>")),
            )
            .with_priority(2)
            .expect(1)
            .mount(&server)
            .await;
        let resolver = Arc::new(MappingResolver {
            address: *server.address(),
        });
        let client = CheckedHttpClient::for_test_with_resolver(16 * 1024, resolver)
            .expect("fixture client should build");
        let mut feed = subscription(1, redirect_url.clone());
        let now = fetched_at();
        let interval = Duration::minutes(30);

        let first = fetch_feed(&client, &feed, now, interval, 1024)
            .await
            .expect("redirected feed should fetch");
        let (effective_url, etag) = match first {
            FetchOutcome::Success {
                fetch_url, etag, ..
            } => (fetch_url, etag),
            other => panic!("redirected feed produced {other:?}"),
        };
        assert_eq!(effective_url, canonical_url);
        assert_eq!(etag.as_deref(), Some("\"canonical-v1\""));
        assert_eq!(feed.url, redirect_url, "manifest identity must not change");

        feed.fetch_url = Some(effective_url);
        feed.etag = etag;
        let second = fetch_feed(&client, &feed, now + interval, interval, 1024)
            .await
            .expect("canonical feed should receive the conditional request");
        assert!(matches!(second, FetchOutcome::NotModified { .. }));

        let requests = server.received_requests().await.unwrap();
        let redirect_requests: Vec<_> = requests
            .iter()
            .filter(|request| request.url.path() == "/subscription")
            .collect();
        assert_eq!(redirect_requests.len(), 1);
        assert!(
            redirect_requests[0].headers.get("if-none-match").is_none(),
            "a final-origin validator leaked to the redirector"
        );
        let final_requests: Vec<_> = requests
            .iter()
            .filter(|request| request.url.path() == "/feed.xml")
            .collect();
        assert_eq!(final_requests.len(), 2);
        assert!(final_requests[0].headers.get("if-none-match").is_none());
        assert_eq!(
            final_requests[1]
                .headers
                .get("if-none-match")
                .unwrap()
                .to_str()
                .unwrap(),
            "\"canonical-v1\""
        );
        server.verify().await;
    }

    #[test]
    fn exponential_backoff_uses_reset_input_and_caps_at_twenty_four_hours() {
        let base = Duration::minutes(30);

        assert_eq!(next_fetch_after(base, 0), base);
        assert_eq!(next_fetch_after(base, 1), Duration::hours(1));
        assert_eq!(next_fetch_after(base, 5), Duration::hours(16));
        assert_eq!(next_fetch_after(base, 10), Duration::hours(24));
        assert_eq!(next_fetch_after(base, u32::MAX), Duration::hours(24));
    }

    #[tokio::test]
    async fn one_failed_subscription_does_not_suppress_another_outcome() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/bad.xml"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", RSS_CONTENT_TYPE)
                    .set_body_string("this is deliberately not a feed"),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/good.xml"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", ATOM_CONTENT_TYPE)
                    .insert_header("etag", "\"good-v1\"")
                    .set_body_string(atom_document()),
            )
            .expect(1)
            .mount(&server)
            .await;
        let client = fixture_client(&server, 16 * 1024);
        let bad = subscription(1, fixture_url(&server, "/bad.xml"));
        let mut good = subscription(2, fixture_url(&server, "/good.xml"));
        good.error_count = 9;
        let now = fetched_at();
        let interval = Duration::minutes(30);

        let (failed, succeeded) = tokio::join!(
            fetch_subscription(&client, &bad, now, interval, 1024),
            fetch_subscription(&client, &good, now, interval, 1024),
        );

        match failed {
            FetchOutcome::Failure {
                fetched_at,
                next_fetch_at,
                error,
            } => {
                assert_eq!(fetched_at, now);
                assert!(next_fetch_at > now);
                assert!(!error.is_empty());
            }
            other => panic!("bad feed produced {other:?}"),
        }
        match succeeded {
            FetchOutcome::Success {
                fetched_at,
                next_fetch_at,
                etag,
                entries,
                ..
            } => {
                assert_eq!(fetched_at, now);
                assert_eq!(next_fetch_at, now + interval);
                assert_eq!(etag.as_deref(), Some("\"good-v1\""));
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].guid, "urn:fixture:atom-entry-1");
                assert_eq!(entries[0].fetched_at, now);
            }
            other => panic!("good feed produced {other:?}"),
        }
        server.verify().await;
    }
}
