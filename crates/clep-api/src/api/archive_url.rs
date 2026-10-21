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
use htmd::HtmlToMarkdown;
use serde::Deserialize;
use tokio::time::Instant;
use url::Url;
use utoipa::ToSchema;

use super::AppState;
use super::archive::{
    ArchiveRequest, ArchiveResponse, ensure_archiving_enabled, ingest, validate_http_url,
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
}

impl From<ArchiveUrlError> for ApiError {
    fn from(error: ArchiveUrlError) -> Self {
        ApiError::unprocessable(error.to_string())
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
        (status = 422, description = "Page could not be fetched or is not HTML", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
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
    let captured_at = state
        .clock
        .now()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    ingest(state, to_archive_request(page, req.tags, captured_at)).await
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
    tokio::task::spawn_blocking(move || {
        let content_type = response
            .headers
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok());
        let html = decode_html(&response.body, content_type).into_owned();
        extract(response.final_url, html)
    })
    .await
    .map_err(|_| failed())
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
/// article with no text, the whole `<body>` becomes the markdown instead.
fn extract(final_url: Url, html: String) -> FetchedPage {
    let converter = HtmlToMarkdown::builder()
        .skip_tags(vec!["head", "script", "style", "noscript", "template"])
        .build();
    let article = Readability::new(html.as_str(), Some(final_url.as_str()), None)
        .ok()
        .and_then(|mut readability| readability.parse().ok());
    let article_markdown = article
        .as_ref()
        .and_then(|article| converter.convert(&article.content).ok())
        .filter(|markdown| !markdown.trim().is_empty());
    let markdown = article_markdown.unwrap_or_else(|| converter.convert(&html).unwrap_or_default());
    let metadata = match article {
        Some(article) => Metadata {
            title: article.title,
            byline: article.byline,
            site_name: article.site_name,
            published_time: article.published_time,
            lang: article.lang,
            ..Metadata::default()
        },
        None => Readability::new(html.as_str(), Some(final_url.as_str()), None)
            .map(|readability| readability.get_article_metadata(readability.parse_json_ld()))
            .unwrap_or_default(),
    };
    let title = Some(metadata.title.trim())
        .filter(|title| !title.is_empty())
        .or(final_url.host_str())
        .unwrap_or("untitled")
        .to_owned();
    FetchedPage {
        final_url,
        html,
        title,
        byline: non_empty(metadata.byline),
        site_name: non_empty(metadata.site_name),
        published_time: non_empty(metadata.published_time),
        lang: non_empty(metadata.lang),
        markdown,
    }
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
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", "http://127.0.0.1/secret?token=hunter2"),
            )
            .expect(1)
            .mount(&server)
            .await;

        let error = fetch_page(&client, &url).await.unwrap_err();

        assert_eq!(error.to_string(), "could not fetch example.test");
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
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
