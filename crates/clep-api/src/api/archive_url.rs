//! `POST /archive/url`: fetch a web page server-side and archive it through
//! the same ingest path the browser extension uses.
//!
//! A server fetch has no browser: no script runs, no resource is inlined, and
//! the page is whatever the origin sends an anonymous client. Pages archived
//! this way carry the `server-fetch` tag to mark that lower fidelity.
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use clep_feeds::network::{CheckedHttpClient, CheckedResponse};
use dom_smoothie::{Metadata, Readability};
use ego_tree::iter::Edge;
use htmd::HtmlToMarkdown;
use html5ever::driver::Parser;
use html5ever::tendril::{StrTendril, TendrilSink};
use scraper::{Html, HtmlTreeSink};
use serde::Deserialize;
use tokio::sync::Semaphore;
use tokio::time::Instant;
use url::Url;
use utoipa::ToSchema;

use super::AppState;
use super::archive::{
    ArchiveRequest, ArchiveResponse, CONTENT_CONFLICT, ensure_archiving_enabled, ingest,
    validate_http_url,
};
use super::error::ApiError;
use crate::external_preview_capture::{decode_html, is_html_document, redirect_target, valid_url};
use crate::vault::cas::ContentStore;

/// Largest page body the server fetches.
pub(crate) const MAX_ARCHIVE_BYTES: usize = 8 * 1024 * 1024;
/// Absolute budget for the whole fetch, redirects included.
const FETCH_DEADLINE: Duration = Duration::from_secs(20);
/// Same hop limit as link previews.
const MAX_REDIRECTS: usize = 10;
/// Deepest element nesting a fetched page may have. Readability and the
/// markdown converter recurse over the tree; deeper pages are refused.
pub(crate) const MAX_ARCHIVE_DEPTH: usize = 512;
/// Largest [`TreeShape::depth_cost`] Readability is run on. Release-build
/// measurements: 20 chains of 250 divs cost 1.1e8 and take 0.96 s; a
/// 400-deep article costs 2.8e7; a 30 KB news page about 2.3e5.
const READABILITY_DEPTH_COST_BUDGET: u64 = 100_000_000;
/// Wall-clock budget for the depth check's own parse. html5ever's tree
/// builder is quadratic in nesting depth, so a page that evades the per-chunk
/// check below still stops here.
const DEPTH_CHECK_BUDGET: Duration = Duration::from_secs(5);
/// The depth check feeds the parser this much at a time, then looks at the
/// newest node.
const DEPTH_CHECK_CHUNK_BYTES: usize = 256;
/// Stack for the extraction thread. The depth limit keeps recursion well
/// inside it; the margin is defence in depth, because an overflow aborts the
/// whole server.
const EXTRACTION_STACK_BYTES: usize = 64 * 1024 * 1024;
/// At most this many pages are parsed at once, server-wide.
static EXTRACTION_PERMITS: Semaphore = Semaphore::const_new(2);
/// How long a request waits for an extraction permit before giving up.
const EXTRACTION_PERMIT_WAIT: Duration = Duration::from_secs(30);
/// Tag on every page archived by a server fetch.
const SERVER_FETCH_TAG: &str = "server-fetch";

#[derive(Debug, Deserialize, ToSchema)]
pub struct ArchiveUrlRequest {
    /// Absolute http(s) URL of the page to fetch and archive.
    pub url: String,
    /// Tags for the archived page. `server-fetch` is always added.
    #[serde(default)]
    pub tags: Vec<String>,
}

/// A fetched HTML page, with its Readability metadata and markdown.
#[derive(Debug)]
pub(crate) struct FetchedPage {
    /// The URL after redirects.
    pub final_url: Url,
    /// The decoded document, as served.
    pub html: String,
    pub title: String,
    pub byline: Option<String>,
    pub site_name: Option<String>,
    pub published_time: Option<String>,
    pub lang: Option<String>,
    /// The Readability article as markdown, or the whole `<body>` when
    /// Readability finds no article.
    pub markdown: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub(crate) enum ArchiveUrlError {
    /// Names only the host: a URL's path or query can carry secrets.
    #[error("could not fetch {host}")]
    Fetch { host: String },
    #[error("not an HTML page")]
    NotHtml,
    #[error("page is nested too deeply")]
    TooDeep,
    #[error("no readable content")]
    NoContent,
    #[error("archive extraction busy")]
    Busy,
    #[error("archive extraction failed")]
    Internal,
}

impl From<ArchiveUrlError> for ApiError {
    fn from(error: ArchiveUrlError) -> Self {
        match error {
            ArchiveUrlError::Busy => ApiError::service_unavailable(error.to_string()),
            ArchiveUrlError::Internal => ApiError::internal(error.to_string()),
            _ => ApiError::unprocessable(error.to_string()),
        }
    }
}

/// What the depth check learned about a document's tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TreeShape {
    /// Depth of the deepest node below the document.
    deepest: usize,
    /// Sum over all nodes of depth squared.
    depth_cost: u64,
}

impl TreeShape {
    /// Readability's running time grows with each node's depth squared:
    /// on release builds, 20 chains of 500 nested divs (110 KB) take 6.2 s,
    /// where a 300,000-node page 15 deep takes 1.2 s. Above
    /// [`READABILITY_DEPTH_COST_BUDGET`] the page skips Readability and its
    /// whole body becomes the markdown.
    fn readability_affordable(&self) -> bool {
        self.depth_cost <= READABILITY_DEPTH_COST_BUDGET
    }
}

#[utoipa::path(
    post,
    path = "/archive/url",
    context_path = "/api/vault",
    tag = "Archive",
    request_body = ArchiveUrlRequest,
    responses(
        (status = 200, description = "Archive already exists", body = ArchiveResponse),
        (status = 201, description = "Archive created", body = ArchiveResponse),
        (status = 400, description = "Invalid URL", body = ApiError),
        (status = 403, description = "Archiving disabled", body = ApiError),
        (status = 409, description = "Archive content conflict", body = ApiError),
        (status = 422, description = "Page could not be fetched, is not HTML, is nested too deeply, or has no readable content", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError),
        (status = 503, description = "Archive extraction busy", body = ApiError)
    )
)]
pub async fn archive_url(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ArchiveUrlRequest>,
) -> Result<Response, ApiError> {
    ensure_archiving_enabled(&state)?;
    let client = CheckedHttpClient::new(MAX_ARCHIVE_BYTES)
        .map_err(|error| ApiError::internal(format!("archive fetch client: {error}")))?;
    let (status, response) = archive_with_client(&state, &client, req).await?;
    Ok((status, Json(response)).into_response())
}

async fn archive_with_client(
    state: &AppState,
    client: &CheckedHttpClient,
    req: ArchiveUrlRequest,
) -> Result<(StatusCode, ArchiveResponse), ApiError> {
    validate_http_url("url", &req.url)?;
    let url = Url::parse(&req.url)
        .map_err(|_| ApiError::bad_request("url must be an absolute HTTP(S) URL"))?;
    let page = fetch_page(client, &url).await?;
    let host = page.final_url.host_str().unwrap_or_default().to_owned();
    let captured_at = state
        .clock
        .now()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    ingest(state, to_archive_request(page, req.tags, captured_at))
        .await
        .map_err(|mut error| {
            // Ingest's conflict message carries the full URL; name only the host.
            if error.status == 409 && error.error.starts_with(CONTENT_CONFLICT) {
                error.error = format!("{CONTENT_CONFLICT}: {host}");
            }
            error
        })
}

/// Fetch `url` as an anonymous client and extract its article.
///
/// Redirects are followed hop by hop through `client`, so every destination
/// passes the same global-address check as the first. Any failure names only
/// the requested host.
pub(crate) async fn fetch_page(
    client: &CheckedHttpClient,
    url: &Url,
) -> Result<FetchedPage, ArchiveUrlError> {
    let host = url.host_str().unwrap_or_default().to_owned();
    let failed = || ArchiveUrlError::Fetch { host: host.clone() };
    let response = fetch_document(client, url.clone()).await.map_err(|error| {
        tracing::debug!(host = %host, error = %error, "archive URL fetch failed");
        failed()
    })?;
    if !response.status.is_success() {
        tracing::debug!(host = %host, status = %response.status, "archive URL fetch failed");
        return Err(failed());
    }
    if !is_html_document(&response) {
        return Err(ArchiveUrlError::NotHtml);
    }
    on_extraction_thread(&EXTRACTION_PERMITS, EXTRACTION_PERMIT_WAIT, move || {
        let content_type = response
            .headers
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok());
        let html = decode_html(&response.body, content_type).into_owned();
        let shape = measure(&html)?;
        extract(response.final_url, html, shape)
    })
    .await
}

/// Run `job` on a dedicated large-stack thread, holding one of `permits`
/// until the thread ends. The permit moves into the thread, so a dropped
/// request cannot free it while the parse still runs. Waiting longer than
/// `wait` for a permit is [`ArchiveUrlError::Busy`].
async fn on_extraction_thread<T: Send + 'static>(
    permits: &'static Semaphore,
    wait: Duration,
    job: impl FnOnce() -> Result<T, ArchiveUrlError> + Send + 'static,
) -> Result<T, ArchiveUrlError> {
    let permit = tokio::time::timeout(wait, permits.acquire())
        .await
        .map_err(|_| ArchiveUrlError::Busy)?
        .map_err(|_| ArchiveUrlError::Internal)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("archive-extract".to_owned())
        .stack_size(EXTRACTION_STACK_BYTES)
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job))
                .unwrap_or_else(|_| {
                    tracing::error!("archive extraction panicked");
                    Err(ArchiveUrlError::Internal)
                });
            // Free the slot before the caller sees the result.
            drop(permit);
            let _ = sender.send(result);
        })
        .map_err(|error| {
            tracing::error!(error = %error, "could not start archive extraction thread");
            ArchiveUrlError::Internal
        })?;
    receiver.await.unwrap_or(Err(ArchiveUrlError::Internal))
}

/// Refuse a document nested deeper than [`MAX_ARCHIVE_DEPTH`] before any
/// recursive parser sees it.
///
/// The document is parsed with html5ever in small chunks. After each chunk
/// the newest node's depth is checked, which stops a plain nesting bomb
/// within a few kilobytes. A page that keeps its newest node shallow still
/// meets the [`DEPTH_CHECK_BUDGET`] and the exact depth check on the
/// finished tree.
fn measure(html: &str) -> Result<TreeShape, ArchiveUrlError> {
    let deadline = std::time::Instant::now() + DEPTH_CHECK_BUDGET;
    let mut parser = html5ever::parse_document(
        HtmlTreeSink::new(Html::new_document()),
        extractor_parse_opts(),
    );
    let mut rest = html;
    while !rest.is_empty() {
        let mut end = rest.len().min(DEPTH_CHECK_CHUNK_BYTES);
        while !rest.is_char_boundary(end) {
            end += 1;
        }
        let (chunk, tail) = rest.split_at(end);
        parser.process(StrTendril::from_slice(chunk));
        rest = tail;
        if newest_node_too_deep(&parser) || std::time::Instant::now() > deadline {
            return Err(ArchiveUrlError::TooDeep);
        }
    }
    let document = parser.finish();
    let shape = tree_shape(&document);
    if shape.deepest > MAX_ARCHIVE_DEPTH {
        return Err(ArchiveUrlError::TooDeep);
    }
    Ok(shape)
}

fn newest_node_too_deep(parser: &Parser<HtmlTreeSink>) -> bool {
    let document = parser.tokenizer.sink.sink.0.borrow();
    document.tree.nodes().next_back().is_some_and(|node| {
        node.ancestors().take(MAX_ARCHIVE_DEPTH + 1).count() > MAX_ARCHIVE_DEPTH
    })
}

/// Parse options matching the extractors' parsers. dom_smoothie (through
/// dom_query) parses with scripting disabled, which reads `<noscript>` as
/// markup; the markdown converter is configured the same way.
fn extractor_parse_opts() -> html5ever::ParseOpts {
    html5ever::ParseOpts {
        tree_builder: html5ever::tree_builder::TreeBuilderOpts {
            scripting_enabled: false,
            ..Default::default()
        },
        ..Default::default()
    }
}

/// Walk the tree iteratively. Depths count from the document's children (1).
fn tree_shape(document: &Html) -> TreeShape {
    let mut depth = 0u64;
    let mut shape = TreeShape {
        deepest: 0,
        depth_cost: 0,
    };
    for edge in document.tree.root().traverse() {
        match edge {
            // The document node itself is depth 0.
            Edge::Open(node) if node.parent().is_none() => {}
            Edge::Open(_) => {
                depth += 1;
                shape.deepest = shape.deepest.max(depth as usize);
                shape.depth_cost = shape.depth_cost.saturating_add(depth * depth);
            }
            Edge::Close(node) if node.parent().is_none() => {}
            Edge::Close(_) => depth -= 1,
        }
    }
    shape
}

/// GET `url`, following redirects, within [`FETCH_DEADLINE`].
async fn fetch_document(
    client: &CheckedHttpClient,
    mut url: Url,
) -> Result<CheckedResponse, String> {
    let deadline = Instant::now() + FETCH_DEADLINE;
    for _ in 0..=MAX_REDIRECTS {
        if !valid_url(&url) {
            return Err("URL is not an anonymous http(s) URL".to_owned());
        }
        let response = client
            .get_once_before(url, deadline)
            .await
            .map_err(|error| error.to_string())?;
        match redirect_target(&response)? {
            Some(next) => url = next,
            None => return Ok(response),
        }
    }
    Err("redirect limit exceeded".to_owned())
}

/// Readability article → markdown. When Readability finds no article, or an
/// article with no text, or the tree is too costly for it, the whole
/// `<body>` becomes the markdown instead. A page with no text either way has
/// no readable content.
fn extract(final_url: Url, html: String, shape: TreeShape) -> Result<FetchedPage, ArchiveUrlError> {
    let converter = HtmlToMarkdown::builder()
        .scripting_enabled(false)
        .skip_tags(vec!["head", "script", "style", "noscript", "template"])
        .build();
    let mut readability = Readability::new(html.as_str(), Some(final_url.as_str()), None).ok();
    // Read before `parse`, which strips the JSON-LD scripts it reads from.
    let page_metadata = readability
        .as_ref()
        .map(|readability| readability.get_article_metadata(readability.parse_json_ld()))
        .unwrap_or_default();
    let article = readability
        .as_mut()
        .filter(|_| shape.readability_affordable())
        .and_then(|readability| readability.parse().ok());
    let article_markdown = article
        .as_ref()
        .and_then(|article| converter.convert(&article.content).ok())
        .filter(|markdown| !markdown.trim().is_empty());
    let markdown = article_markdown
        .or_else(|| converter.convert(&html).ok())
        .filter(|markdown| !markdown.trim().is_empty())
        .ok_or(ArchiveUrlError::NoContent)?;
    let metadata = match article {
        Some(article) => Metadata {
            title: article.title,
            byline: article.byline,
            site_name: article.site_name,
            published_time: article.published_time,
            lang: article.lang,
            ..Metadata::default()
        },
        None => page_metadata,
    };
    let title = Some(metadata.title.trim())
        .filter(|title| !title.is_empty())
        .or(final_url.host_str())
        .unwrap_or("untitled")
        .to_owned();
    Ok(FetchedPage {
        final_url,
        html,
        title,
        byline: non_empty(metadata.byline),
        site_name: non_empty(metadata.site_name),
        published_time: non_empty(metadata.published_time),
        lang: non_empty(metadata.lang),
        markdown,
    })
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

/// The ingest request for a fetched page. Its `content_hash` is computed here,
/// so ingest's transport check always passes.
fn to_archive_request(
    page: FetchedPage,
    mut tags: Vec<String>,
    captured_at: String,
) -> ArchiveRequest {
    tags.retain(|tag| tag != SERVER_FETCH_TAG);
    tags.push(SERVER_FETCH_TAG.to_owned());
    ArchiveRequest {
        domain: page.final_url.host_str().unwrap_or_default().to_owned(),
        url: page.final_url.into(),
        canonical_url: None,
        title: page.title,
        description: None,
        captured_at,
        content_hash: ContentStore::hash_bytes(page.markdown.as_bytes()),
        snapshot_html: page.html,
        markdown_body: page.markdown,
        tags,
        byline: page.byline,
        site_name: page.site_name,
        published_time: page.published_time,
        lang: page.lang,
        excerpt: None,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use chrono::{DateTime, Utc};
    use tempfile::TempDir;
    use tokio::sync::broadcast;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;
    use crate::api::Clock;
    use crate::api::archive::ArchiveStatus;
    use crate::vault::Vault;
    use crate::vault::index::VaultIndex;
    use crate::vault::index_handle::IndexHandle;
    use crate::vault::init::init_vault;

    const ARTICLE_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
  <title>Water clocks of antiquity</title>
  <meta property="og:site_name" content="Horology Weekly">
  <meta name="author" content="Ada Ctesibius">
</head>
<body>
  <nav class="site-nav"><a href="/">Home</a> <a href="/about">Navigation menu entry</a></nav>
  <article>
    <h1>Water clocks of antiquity</h1>
    <h2>How the clepsydra kept time</h2>
    <p>A clepsydra measured time by the regulated flow of water into or out of a vessel.
       The earliest surviving examples come from Egypt, where temple priests used them to
       mark the hours of the night when the sun could not be observed.</p>
    <p>Greek engineers refined the design. Ctesibius of Alexandria added a float and a
       pointer, and a constant-head reservoir that kept the flow steady, so that the
       vessel filled at an even rate through the whole of a long night watch.</p>
    <p>Later Islamic and Chinese clockmakers built monumental water clocks with gears,
       automata and striking mechanisms, which announced each hour to the city around
       them long before mechanical escapements made such clocks smaller and cheaper.</p>
  </article>
  <footer>Copyright footer text</footer>
</body>
</html>"#;

    async fn fixture(max_bytes: usize) -> (MockServer, CheckedHttpClient, Url) {
        let server = MockServer::start().await;
        let client =
            CheckedHttpClient::for_test(max_bytes, "example.test", *server.address()).unwrap();
        let url = Url::parse(&format!(
            "http://example.test:{}/start",
            server.address().port()
        ))
        .unwrap();
        (server, client, url)
    }

    async fn serve(server: &MockServer, route: &str, body: impl Into<Vec<u8>>, content_type: &str) {
        Mock::given(method("GET"))
            .and(path(route))
            .respond_with(ResponseTemplate::new(200).set_body_raw(body.into(), content_type))
            .mount(server)
            .await;
    }

    fn page(markdown: &str) -> FetchedPage {
        FetchedPage {
            final_url: Url::parse("https://www.example.com/post?id=1").unwrap(),
            html: "<html><body><p>Body</p></body></html>".to_string(),
            title: "A post".to_string(),
            byline: Some("Ada".to_string()),
            site_name: Some("Example".to_string()),
            published_time: Some("2026-10-01T00:00:00Z".to_string()),
            lang: Some("en".to_string()),
            markdown: markdown.to_string(),
        }
    }

    #[tokio::test]
    async fn fetch_page_extracts_article() {
        let (server, client, url) = fixture(MAX_ARCHIVE_BYTES).await;
        Mock::given(method("GET"))
            .and(path("/start"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/article"))
            .mount(&server)
            .await;
        serve(
            &server,
            "/article",
            ARTICLE_HTML,
            "text/html; charset=utf-8",
        )
        .await;

        let page = fetch_page(&client, &url).await.unwrap();

        assert_eq!(page.final_url.path(), "/article");
        assert_eq!(page.title, "Water clocks of antiquity");
        assert!(
            page.markdown.contains("How the clepsydra kept time"),
            "{}",
            page.markdown
        );
        assert!(
            !page.markdown.contains("Navigation menu entry"),
            "{}",
            page.markdown
        );
        assert_eq!(page.site_name.as_deref(), Some("Horology Weekly"));
        assert_eq!(page.lang.as_deref(), Some("en"));
        assert_eq!(page.html, ARTICLE_HTML);
    }

    #[tokio::test]
    async fn fetch_page_falls_back_to_body() {
        // Readability finds no article in a page whose only text is an
        // `<aside>`; the whole body becomes the markdown instead.
        let html = "<html><head><title>Sidebar page</title><style>p{}</style>\
                    <script>var secret = 1;</script></head>\
                    <body><aside>Aside words</aside></body></html>";
        assert!(matches!(
            Readability::new(html, None, None).unwrap().parse(),
            Err(dom_smoothie::ReadabilityError::GrabFailed)
        ));
        let (server, client, url) = fixture(MAX_ARCHIVE_BYTES).await;
        serve(&server, "/start", html, "text/html").await;

        let page = fetch_page(&client, &url).await.unwrap();

        assert_eq!(page.markdown, "Aside words");
        assert_eq!(page.title, "Sidebar page");
    }

    #[tokio::test]
    async fn fetch_page_decodes_declared_charset() {
        let (server, client, url) = fixture(MAX_ARCHIVE_BYTES).await;
        serve(
            &server,
            "/start",
            b"<html><head><title>Caf\xe9</title></head><body><p>Caf\xe9 au lait</p></body></html>"
                .to_vec(),
            "text/html; charset=windows-1252",
        )
        .await;

        let page = fetch_page(&client, &url).await.unwrap();

        assert_eq!(page.title, "Café");
        assert!(page.html.contains("Café au lait"));
    }

    #[tokio::test]
    async fn fetch_page_rejects_pdf() {
        let (server, client, url) = fixture(MAX_ARCHIVE_BYTES).await;
        serve(&server, "/start", b"%PDF-1.7".to_vec(), "application/pdf").await;

        assert_eq!(
            fetch_page(&client, &url).await.unwrap_err(),
            ArchiveUrlError::NotHtml
        );
    }

    #[tokio::test]
    async fn fetch_page_rejects_oversize() {
        let (server, client, url) = fixture(64).await;
        serve(&server, "/start", "x".repeat(65), "text/html").await;

        assert_eq!(
            fetch_page(&client, &url).await.unwrap_err(),
            ArchiveUrlError::Fetch {
                host: "example.test".to_string()
            }
        );
    }

    #[tokio::test]
    async fn fetch_page_refuses_redirect_to_private_address() {
        let (server, client, url) = fixture(MAX_ARCHIVE_BYTES).await;
        Mock::given(method("GET"))
            .and(path("/start"))
            .respond_with(ResponseTemplate::new(302).insert_header(
                "location",
                format!(
                    "http://127.0.0.1:{}/secret?token=hunter2",
                    server.address().port()
                ),
            ))
            .expect(1)
            .mount(&server)
            .await;

        let error = fetch_page(&client, &url).await.unwrap_err();

        // The redirect names the mock server itself, so a second request
        // would reach it if the policy let the hop through.
        assert_eq!(error.to_string(), "could not fetch example.test");
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    fn nested(depth: usize, inner: &str) -> String {
        format!(
            "<html><head><title>Nested</title></head><body>{}{inner}{}</body></html>",
            "<div>".repeat(depth),
            "</div>".repeat(depth)
        )
    }

    #[tokio::test]
    async fn fetch_page_refuses_deep_nesting_quickly() {
        let (server, client, url) = fixture(MAX_ARCHIVE_BYTES).await;
        let html = nested(20_000, "text");
        serve(&server, "/start", html.clone(), "text/html").await;

        let error = fetch_page(&client, &url).await.unwrap_err();
        assert_eq!(error, ArchiveUrlError::TooDeep);
        assert_eq!(ApiError::from(error).status, 422);

        // Time the gate itself. `fetch_page`'s wall clock also counts the wait
        // for a global extraction permit, which parallel tests may hold.
        let started = std::time::Instant::now();
        assert_eq!(measure(&html).unwrap_err(), ArchiveUrlError::TooDeep);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "refused after {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn depth_check_counts_nodes_below_the_document() {
        // html, body, then the divs, then the text node.
        assert_eq!(
            tree_shape(&Html::parse_document(&nested(600, "x"))).deepest,
            603
        );
        assert_eq!(
            measure(&nested(MAX_ARCHIVE_DEPTH - 3, "x")).map(|shape| shape.deepest),
            Ok(MAX_ARCHIVE_DEPTH)
        );
        assert_eq!(
            measure(&nested(MAX_ARCHIVE_DEPTH - 2, "x")),
            Err(ArchiveUrlError::TooDeep)
        );
    }

    #[test]
    fn depth_check_follows_implied_end_tags() {
        // Unclosed `<li>` and `<p>` are closed by the parser, not nested.
        let html = format!("<ul>{}</ul>", "<li><p>item".repeat(5_000));
        assert!(measure(&html).is_ok());
    }

    #[test]
    fn depth_check_parses_noscript_as_the_extractors_do() {
        // dom_smoothie parses with scripting disabled, so `<noscript>` holds
        // markup, not text. The depth check must see the same tree.
        let html = nested(20_000, "x").replace("<body>", "<body><noscript>");
        let error = measure(&html).unwrap_err();
        assert_eq!(error, ArchiveUrlError::TooDeep);
        assert_eq!(ApiError::from(error).status, 422);
    }

    #[tokio::test]
    async fn fetch_page_refuses_deep_nesting_inside_noscript() {
        let (server, client, url) = fixture(MAX_ARCHIVE_BYTES).await;
        let html = nested(20_000, "x").replace("<body>", "<body><noscript>");
        serve(&server, "/start", html, "text/html").await;

        let error = fetch_page(&client, &url).await.unwrap_err();

        assert_eq!(ApiError::from(error).status, 422);
    }

    /// `subtrees` chains of `depth` nested divs, each holding a sentence,
    /// after a navigation bar.
    fn chains(depth: usize, subtrees: usize) -> String {
        let chain = format!(
            "{}Water flowed through the vessel at an even rate.{}",
            "<div>".repeat(depth),
            "</div>".repeat(depth)
        );
        format!(
            "<html><head><title>Chains</title></head><body>\
             <nav><a href=\"/\">Navigation menu entry</a></nav>{}</body></html>",
            chain.repeat(subtrees)
        )
    }

    /// A news page: masthead, a long navigation list, an article of many
    /// paragraphs inside a dozen layout wrappers, a related-links aside, and
    /// a footer.
    fn news_page() -> String {
        let nav = (0..200)
            .map(|i| format!("<li><a href=\"/section/{i}\">Section {i}</a></li>"))
            .collect::<String>();
        let paragraphs = (0..80)
            .map(|i| {
                format!(
                    "<p>Paragraph {i} of the report. The clepsydra measured time by the \
                     regulated flow of water, and <a href=\"/ref/{i}\">its makers</a> \
                     refined it over centuries of careful <em>observation</em>.</p>"
                )
            })
            .collect::<String>();
        let related = (0..100)
            .map(|i| format!("<li><a href=\"/story/{i}\">Related story {i}</a></li>"))
            .collect::<String>();
        let wrappers = 12;
        format!(
            "<html lang=\"en\"><head><title>Water clocks report</title></head><body>\
             <header><nav class=\"site-nav\"><ul>{nav}</ul></nav></header>\
             {open}<article><h1>Water clocks report</h1><h2>How the clepsydra kept time</h2>\
             {paragraphs}</article>{close}\
             <aside class=\"related\"><ul>{related}</ul></aside>\
             <footer>Copyright footer text</footer></body></html>",
            open = "<div class=\"layout\">".repeat(wrappers),
            close = "</div>".repeat(wrappers),
        )
    }

    #[test]
    fn depth_cost_budget_separates_nesting_bombs_from_articles() {
        let bomb = measure(&chains(500, 20)).unwrap();
        assert!(!bomb.readability_affordable(), "{bomb:?}");
        let deep_article = measure(&nested(400, ARTICLE_HTML)).unwrap();
        assert!(deep_article.readability_affordable(), "{deep_article:?}");
        let news = measure(&news_page()).unwrap();
        assert!(news.readability_affordable(), "{news:?}");
    }

    #[tokio::test]
    async fn fetch_page_skips_readability_when_the_tree_is_too_costly() {
        let (server, client, url) = fixture(MAX_ARCHIVE_BYTES).await;
        serve(&server, "/start", chains(500, 20), "text/html").await;

        let page = fetch_page(&client, &url).await.unwrap();

        // The whole body, navigation included: Readability did not run.
        assert!(page.markdown.contains("Navigation menu entry"));
        assert!(page.markdown.contains("Water flowed through the vessel"));
        assert_eq!(page.title, "Chains");
    }

    #[tokio::test]
    async fn fetch_page_runs_readability_on_a_news_page() {
        let (server, client, url) = fixture(MAX_ARCHIVE_BYTES).await;
        serve(&server, "/start", news_page(), "text/html").await;

        let page = fetch_page(&client, &url).await.unwrap();

        assert!(page.markdown.contains("How the clepsydra kept time"));
        assert!(!page.markdown.contains("Section 7"), "{}", page.markdown);
        assert!(
            !page.markdown.contains("Related story"),
            "{}",
            page.markdown
        );
    }

    static NO_PERMITS: Semaphore = Semaphore::const_new(0);
    static CLOSED_PERMITS: Semaphore = Semaphore::const_new(1);
    static SPARE_PERMITS: Semaphore = Semaphore::const_new(1);

    #[tokio::test]
    async fn extraction_wait_times_out_as_busy() {
        let error = on_extraction_thread(&NO_PERMITS, Duration::from_millis(10), || Ok(()))
            .await
            .unwrap_err();
        assert_eq!(error, ArchiveUrlError::Busy);
        assert_eq!(ApiError::from(error).status, 503);
    }

    #[tokio::test]
    async fn extraction_failures_are_internal_errors() {
        CLOSED_PERMITS.close();
        let closed = on_extraction_thread(&CLOSED_PERMITS, Duration::from_secs(1), || Ok(()))
            .await
            .unwrap_err();
        assert_eq!(closed, ArchiveUrlError::Internal);

        // `resume_unwind` unwinds without running the panic hook, so the
        // test output stays clean.
        let panicked = on_extraction_thread(
            &SPARE_PERMITS,
            Duration::from_secs(1),
            || -> Result<(), ArchiveUrlError> { std::panic::resume_unwind(Box::new("boom")) },
        )
        .await
        .unwrap_err();
        assert_eq!(panicked, ArchiveUrlError::Internal);
        assert_eq!(ApiError::from(panicked).status, 500);
        assert_eq!(
            SPARE_PERMITS.available_permits(),
            1,
            "the permit is returned"
        );
    }

    #[tokio::test]
    async fn fetch_page_refuses_empty_pages() {
        let (server, client, url) = fixture(MAX_ARCHIVE_BYTES).await;
        serve(
            &server,
            "/start",
            "<html><head><title>Empty</title></head><body> </body></html>",
            "text/html",
        )
        .await;

        let error = fetch_page(&client, &url).await.unwrap_err();

        assert_eq!(error, ArchiveUrlError::NoContent);
        assert_eq!(ApiError::from(error).status, 422);
    }

    #[tokio::test]
    async fn fetch_page_refuses_error_status() {
        let (server, client, url) = fixture(MAX_ARCHIVE_BYTES).await;
        Mock::given(method("GET"))
            .and(path("/start"))
            .respond_with(ResponseTemplate::new(404).set_body_raw("<p>gone</p>", "text/html"))
            .mount(&server)
            .await;

        assert!(matches!(
            fetch_page(&client, &url).await.unwrap_err(),
            ArchiveUrlError::Fetch { .. }
        ));
    }

    #[test]
    fn to_archive_request_adds_server_fetch_tag_and_hash() {
        let markdown = "# A post\n\nBody text.";
        let request = to_archive_request(
            page(markdown),
            vec!["reading".to_string(), SERVER_FETCH_TAG.to_string()],
            "2026-10-21T09:00:00Z".to_string(),
        );

        assert_eq!(request.tags, vec!["reading", SERVER_FETCH_TAG]);
        assert_eq!(
            request.content_hash,
            ContentStore::hash_bytes(markdown.as_bytes())
        );
        assert_eq!(request.markdown_body, markdown);
        assert_eq!(request.url, "https://www.example.com/post?id=1");
        assert_eq!(request.domain, "www.example.com");
        assert_eq!(
            request.snapshot_html,
            "<html><body><p>Body</p></body></html>"
        );
        assert_eq!(request.captured_at, "2026-10-21T09:00:00Z");
        assert_eq!(request.title, "A post");
        assert_eq!(request.byline.as_deref(), Some("Ada"));

        let untagged = to_archive_request(page(markdown), Vec::new(), String::new());
        assert_eq!(untagged.tags, vec![SERVER_FETCH_TAG]);
    }

    #[derive(Debug)]
    struct FixedClock(DateTime<Utc>);

    impl Clock for FixedClock {
        fn now(&self) -> DateTime<Utc> {
            self.0
        }
    }

    fn app_state() -> (TempDir, AppState) {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("vault");
        init_vault(&root).unwrap();
        let vault = Vault::open(&root).unwrap();
        let mut index = VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
        index.build(&vault).unwrap();
        index.resolve_links().unwrap();
        let index = IndexHandle::spawn(index, vault.clone());
        let cas = Arc::new(parking_lot::Mutex::new(
            ContentStore::open(&temp.path().join("cas")).unwrap(),
        ));
        let (change_tx, _) = broadcast::channel(8);
        let rubbish = crate::vault::rubbish::RubbishStore::for_vault(vault.root());
        let state = AppState {
            external_previews: Default::default(),
            started_at: std::time::Instant::now(),
            features: crate::FeatureFlags::default(),
            clock: Arc::new(FixedClock(
                DateTime::parse_from_rfc3339("2026-10-21T09:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
            )),
            vault,
            index,
            cas,
            rubbish,
            warnings: parking_lot::Mutex::new(Vec::new()),
            change_tx,
            hooks: Arc::new(Vec::new()),
            delete_hooks: Arc::new(Vec::new()),
            purge_hooks: Arc::new(Vec::new()),
            mutation_coordinator: crate::vault::mutation_coordinator::MutationCoordinator::new(),
            sync: None,
            watcher_paused: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            feed_runtime: None,
            archive_ingest_lock: tokio::sync::Mutex::new(()),
            archive_view_semaphore: Arc::new(tokio::sync::Semaphore::new(1)),
            archive_resource_semaphore: Arc::new(tokio::sync::Semaphore::new(1)),
            bcl: None,
            location: parking_lot::RwLock::new(None),
        };
        (temp, state)
    }

    #[tokio::test]
    async fn archive_with_client_ingests_the_fetched_page_once() {
        let (_temp, state) = app_state();
        let (server, client, url) = fixture(MAX_ARCHIVE_BYTES).await;
        serve(&server, "/start", ARTICLE_HTML, "text/html").await;
        let request = || ArchiveUrlRequest {
            url: url.to_string(),
            tags: vec!["reading".to_string()],
        };

        let (status, created) = archive_with_client(&state, &client, request())
            .await
            .unwrap();
        assert_eq!(status, StatusCode::CREATED);
        assert!(matches!(created.status, ArchiveStatus::Created));
        let page = fs::read_to_string(state.vault.root().join(&created.vault_path)).unwrap();
        assert!(page.contains(SERVER_FETCH_TAG), "{page}");
        assert!(page.contains("How the clepsydra kept time"), "{page}");

        let (status, again) = archive_with_client(&state, &client, request())
            .await
            .unwrap();
        assert_eq!(status, StatusCode::OK);
        assert!(matches!(again.status, ArchiveStatus::AlreadyExists));
        assert_eq!(again.page_id, created.page_id);
    }

    #[tokio::test]
    async fn archive_with_client_archives_a_400_deep_page() {
        let (_temp, state) = app_state();
        let (server, client, url) = fixture(MAX_ARCHIVE_BYTES).await;
        let article = ARTICLE_HTML
            .split_once("<body>")
            .and_then(|(_, body)| body.split_once("</body>"))
            .map(|(body, _)| body)
            .unwrap();
        serve(&server, "/start", nested(400, article), "text/html").await;

        let (status, created) = archive_with_client(
            &state,
            &client,
            ArchiveUrlRequest {
                url: url.to_string(),
                tags: Vec::new(),
            },
        )
        .await
        .unwrap();

        assert_eq!(status, StatusCode::CREATED);
        let page = fs::read_to_string(state.vault.root().join(&created.vault_path)).unwrap();
        assert!(page.contains("How the clepsydra kept time"), "{page}");
    }

    #[tokio::test]
    async fn archive_with_client_conflict_names_only_the_host() {
        let (_temp, state) = app_state();
        let (server, client, mut url) = fixture(MAX_ARCHIVE_BYTES).await;
        url.set_query(Some("token=hunter2"));
        Mock::given(method("GET"))
            .and(path("/start"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(ARTICLE_HTML, "text/html"))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        serve(
            &server,
            "/start",
            ARTICLE_HTML.replace("Greek engineers", "Roman engineers"),
            "text/html",
        )
        .await;
        let request = || ArchiveUrlRequest {
            url: url.to_string(),
            tags: Vec::new(),
        };
        archive_with_client(&state, &client, request())
            .await
            .unwrap();

        let error = archive_with_client(&state, &client, request())
            .await
            .unwrap_err();

        assert_eq!(error.status, 409);
        assert_eq!(
            error.error,
            "archive exists with different content: example.test"
        );
        assert!(error.detail.is_some(), "conflict detail is kept");
    }

    #[tokio::test]
    async fn archive_with_client_rejects_non_http_urls() {
        let (_temp, state) = app_state();
        let (_server, client, _url) = fixture(MAX_ARCHIVE_BYTES).await;

        let error = archive_with_client(
            &state,
            &client,
            ArchiveUrlRequest {
                url: "ftp://x".to_string(),
                tags: Vec::new(),
            },
        )
        .await
        .unwrap_err();

        assert_eq!(error.status, 400);
    }
}
