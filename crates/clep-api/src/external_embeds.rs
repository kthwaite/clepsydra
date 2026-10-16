//! Resolve direct HTML embeds without invoking screenshot capture or weakening publisher policy.
use std::sync::Arc;
use std::time::Duration;

use axum::http::{HeaderMap, header};
use clep_feeds::network::{CheckedHttpClient, CheckedHttpError};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use url::Url;
use utoipa::ToSchema;

use crate::api::AppState;
use crate::external_previews::valid_url;
use crate::vault::index::ArchiveUrlOwner;
use crate::vault::path::VaultPath;

const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REDIRECTS: usize = 10;
static RESOLVERS: Semaphore = Semaphore::const_new(4);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ExternalEmbedState {
    Disabled,
    Ready,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ExternalEmbedSource {
    Live,
    Archive,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ExternalEmbedResponse {
    pub state: ExternalEmbedState,
    #[schema(required = true)]
    pub url: Option<String>,
    #[schema(required = true)]
    pub source: Option<ExternalEmbedSource>,
    pub scripts: bool,
    #[schema(required = true)]
    pub reason: Option<String>,
}

impl ExternalEmbedResponse {
    fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            state: ExternalEmbedState::Unavailable,
            url: None,
            source: None,
            scripts: false,
            reason: Some(reason.into()),
        }
    }

    fn ready(url: String, source: ExternalEmbedSource, scripts: bool) -> Self {
        Self {
            state: ExternalEmbedState::Ready,
            url: Some(url),
            source: Some(source),
            scripts,
            reason: None,
        }
    }
}

/// `ready` means the URL passed preflight, not that a browser loaded the frame.
pub async fn resolve(state: &Arc<AppState>, raw: &str) -> ExternalEmbedResponse {
    resolve_with_client(state, raw, None).await
}

async fn resolve_with_client(
    state: &Arc<AppState>,
    raw: &str,
    client: Option<&CheckedHttpClient>,
) -> ExternalEmbedResponse {
    if !state.external_previews.enabled() {
        return ExternalEmbedResponse {
            state: ExternalEmbedState::Disabled,
            url: None,
            source: None,
            scripts: false,
            reason: None,
        };
    }
    let url = match valid_url(raw) {
        Ok(url) => url,
        Err(reason) => return ExternalEmbedResponse::unavailable(reason),
    };
    let Ok(_permit) = RESOLVERS.try_acquire() else {
        return ExternalEmbedResponse::unavailable("External preview resolver is busy");
    };
    tokio::time::timeout(RESOLVE_TIMEOUT, async {
        if let Some(hash) = archive_snapshot(state, raw, &url).await {
            return ExternalEmbedResponse::ready(
                format!("/api/vault/archive/view/{hash}"),
                ExternalEmbedSource::Archive,
                false,
            );
        }
        let owned_client;
        let client = match client {
            Some(client) => client,
            None => {
                owned_client = match CheckedHttpClient::new(MAX_HTML_BYTES) {
                    Ok(client) => client,
                    Err(_) => {
                        return ExternalEmbedResponse::unavailable(
                            "Could not start the external preview request",
                        );
                    }
                };
                &owned_client
            }
        };
        resolve_live(client, url).await
    })
    .await
    .unwrap_or_else(|_| ExternalEmbedResponse::unavailable("External preview request timed out"))
}

async fn archive_snapshot(state: &Arc<AppState>, raw: &str, url: &Url) -> Option<String> {
    let raw = raw.to_owned();
    let mut normalized = url.clone();
    normalized.set_fragment(None);
    let hash = state
        .index
        .with_index(move |index, vault| {
            let owner = match index.find_by_archive_url(&raw)? {
                Some(owner) => Some(owner),
                None => index.find_by_archive_url(normalized.as_str())?,
            };
            let Some(ArchiveUrlOwner::Active { page_id, path, .. }) = owner else {
                return Ok::<_, crate::vault::index::IndexError>(None);
            };
            let Ok(path) = VaultPath::new(&path) else {
                return Ok(None);
            };
            if !vault.resolve(&path).is_file() {
                return Ok(None);
            }
            Ok(index.connection().query_row(
                "SELECT json_extract(meta_json, '$.archive.snapshot_hash') FROM pages WHERE id = ?1",
                [page_id],
                |row| row.get::<_, Option<String>>(0),
            ).optional()?.flatten())
        })
        .await
        .ok()?
        .ok()??;
    if crate::api::archive::valid_embed_snapshot(state, hash.clone()).await {
        Some(hash)
    } else {
        None
    }
}

async fn resolve_live(client: &CheckedHttpClient, mut url: Url) -> ExternalEmbedResponse {
    let deadline = tokio::time::Instant::now() + RESOLVE_TIMEOUT;
    for redirects in 0..=MAX_REDIRECTS {
        let response = match client.get_once_before(url, deadline).await {
            Ok(response) => response,
            Err(error) => return ExternalEmbedResponse::unavailable(network_reason(error)),
        };
        if matches!(response.status.as_u16(), 301 | 302 | 303 | 307 | 308) {
            if redirects == MAX_REDIRECTS {
                return ExternalEmbedResponse::unavailable(
                    "External preview exceeded the redirect limit",
                );
            }
            let next = response
                .headers
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| response.final_url.join(value).ok())
                .and_then(|url| valid_url(url.as_str()).ok());
            let Some(next) = next else {
                return ExternalEmbedResponse::unavailable(
                    "External page returned an unsafe or invalid redirect",
                );
            };
            url = next;
            continue;
        }
        if !response.status.is_success() {
            return ExternalEmbedResponse::unavailable(format!(
                "External page returned HTTP {}",
                response.status.as_u16()
            ));
        }
        let html = response
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .is_some_and(|mime| {
                let mime = mime.trim();
                mime.eq_ignore_ascii_case("text/html")
                    || mime.eq_ignore_ascii_case("application/xhtml+xml")
            });
        if !html {
            return ExternalEmbedResponse::unavailable("External page did not return HTML");
        }
        if let Some(reason) = framing_restriction(&response.headers) {
            return ExternalEmbedResponse::unavailable(reason);
        }
        let scripts = scripts_allowed(&response.final_url);
        return ExternalEmbedResponse::ready(
            response.final_url.into(),
            ExternalEmbedSource::Live,
            scripts,
        );
    }
    unreachable!("redirect loop always returns at its limit")
}

fn network_reason(error: CheckedHttpError) -> &'static str {
    match error {
        CheckedHttpError::NonGlobalDestination(_) => {
            "External preview requires a public internet destination"
        }
        CheckedHttpError::CredentialsNotAllowed => {
            "External preview URLs cannot contain credentials"
        }
        CheckedHttpError::DeadlineExceeded => "External preview request timed out",
        CheckedHttpError::ResponseLimitExceeded { .. } => {
            "External page exceeds the preview size limit"
        }
        _ => "Could not safely fetch the external page",
    }
}

fn framing_restriction(headers: &HeaderMap) -> Option<&'static str> {
    // Enforced frame-ancestors overrides XFO. Every CSP policy must permit
    // framing; repeated directives within one policy use their first value.
    let mut has_ancestors = false;
    for policy in headers.get_all(header::CONTENT_SECURITY_POLICY) {
        let Ok(policy) = policy.to_str() else {
            return Some("Publisher framing policy could not be checked");
        };
        for policy in policy.split(',') {
            for directive in policy.split(';') {
                let mut tokens = directive.split_ascii_whitespace();
                if tokens
                    .next()
                    .is_some_and(|name| name.eq_ignore_ascii_case("frame-ancestors"))
                {
                    has_ancestors = true;
                    // A wildcard works for every deployment origin. Origin-specific
                    // policies are conservatively left to the screenshot fallback.
                    if tokens.next() != Some("*") || tokens.next().is_some() {
                        return Some(
                            "Publisher Content-Security-Policy restricts embedded viewing",
                        );
                    }
                    break;
                }
            }
        }
    }
    if !has_ancestors && headers.contains_key(header::X_FRAME_OPTIONS) {
        return Some("Publisher X-Frame-Options policy restricts embedded viewing");
    }
    None
}

fn scripts_allowed(url: &Url) -> bool {
    // Production HTTPS origins only, never subdomain/suffix matches or custom ports.
    url.scheme() == "https"
        && url.port().is_none()
        && match url.host_str() {
            Some("docs.google.com" | "lesswrong.com" | "www.lesswrong.com") => true,
            Some("archive.org") => url.path().starts_with("/details/"),
            _ => false,
        }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external_previews::PreviewRuntime;
    use serial_test::serial;
    use wiremock::matchers::path;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn fixture() -> (
        Arc<AppState>,
        tempfile::TempDir,
        MockServer,
        CheckedHttpClient,
        String,
    ) {
        let (mut state, temp) = crate::state_test_support::make_state().await;
        Arc::get_mut(&mut state).unwrap().external_previews = PreviewRuntime::enabled_for_test();
        let server = MockServer::start().await;
        let client =
            CheckedHttpClient::for_test(MAX_HTML_BYTES, "preview.test", *server.address()).unwrap();
        let url = format!("http://preview.test:{}/start", server.address().port());
        (state, temp, server, client, url)
    }

    fn html() -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_raw(
            "<html><body>Readable content</body></html>",
            "text/html; charset=utf-8",
        )
    }

    fn assert_unavailable(response: ExternalEmbedResponse) {
        assert_eq!(response.state, ExternalEmbedState::Unavailable);
        assert!(response.url.is_none());
        assert!(response.source.is_none());
        assert!(!response.scripts);
        assert!(response.reason.is_some());
    }

    #[tokio::test]
    #[serial(external_embeds)]
    async fn disabled_resolver_never_fetches_or_validates() {
        let (state, _temp) = crate::state_test_support::make_state().await;
        let server = MockServer::start().await;
        let client =
            CheckedHttpClient::for_test(MAX_HTML_BYTES, "preview.test", *server.address()).unwrap();
        for url in [
            format!("http://preview.test:{}/start", server.address().port()),
            "not a URL".into(),
        ] {
            let response = resolve_with_client(&state, &url, Some(&client)).await;
            assert_eq!(response.state, ExternalEmbedState::Disabled);
            assert!(response.url.is_none());
            assert!(response.source.is_none());
            assert!(!response.scripts);
        }
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    #[serial(external_embeds)]
    async fn resolver_denies_publisher_framing_policies_and_non_html() {
        let (state, _temp, server, client, url) = fixture().await;
        for (name, value) in [
            ("x-frame-options", "DENY"),
            ("x-frame-options", "SAMEORIGIN"),
            (
                "content-security-policy",
                "default-src 'self'; frame-ancestors 'none'",
            ),
            (
                "content-security-policy",
                "frame-ancestors https://another.example",
            ),
            (
                "content-security-policy",
                "frame-ancestors *, frame-ancestors 'none'",
            ),
        ] {
            Mock::given(path("/start"))
                .respond_with(html().insert_header(name, value))
                .mount(&server)
                .await;
            assert_unavailable(resolve_with_client(&state, &url, Some(&client)).await);
            server.reset().await;
        }
        Mock::given(path("/start"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/pdf")
                    .set_body_string("Not HTML"),
            )
            .mount(&server)
            .await;
        assert_unavailable(resolve_with_client(&state, &url, Some(&client)).await);
        server.reset().await;
        Mock::given(path("/start"))
            .respond_with(
                html()
                    .insert_header("x-frame-options", "SAMEORIGIN")
                    .insert_header(
                        "content-security-policy",
                        "default-src 'none'; frame-ancestors *; frame-ancestors 'self'",
                    ),
            )
            .mount(&server)
            .await;
        let response = resolve_with_client(&state, &url, Some(&client)).await;
        assert_eq!(response.state, ExternalEmbedState::Ready);
        assert_eq!(response.source, Some(ExternalEmbedSource::Live));
    }

    #[tokio::test]
    #[serial(external_embeds)]
    async fn resolver_returns_checked_redirect_destination_and_rejects_private_or_credential_redirects()
     {
        let (state, _temp, server, client, url) = fixture().await;
        Mock::given(path("/start"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/final#section"))
            .mount(&server)
            .await;
        Mock::given(path("/final"))
            .respond_with(html())
            .mount(&server)
            .await;
        let response = resolve_with_client(&state, &url, Some(&client)).await;
        assert_eq!(response.state, ExternalEmbedState::Ready);
        assert_eq!(response.url, Some(url.replace("/start", "/final#section")));
        assert!(!response.scripts);
        for destination in [
            "http://127.0.0.1/private",
            "http://user:secret@preview.test/private",
            "file:///tmp/private",
        ] {
            server.reset().await;
            Mock::given(path("/start"))
                .respond_with(ResponseTemplate::new(302).insert_header("location", destination))
                .expect(1)
                .mount(&server)
                .await;
            assert_unavailable(resolve_with_client(&state, &url, Some(&client)).await);
            assert_eq!(server.received_requests().await.unwrap().len(), 1);
        }
    }

    #[tokio::test]
    #[serial(external_embeds)]
    async fn resolver_rejects_private_credentials_and_oversized_bodies() {
        let (state, _temp, server, client, url) = fixture().await;
        for url in [
            "http://127.0.0.1/private",
            "http://[::1]/private",
            "http://user:secret@preview.test/start",
        ] {
            assert_unavailable(resolve_with_client(&state, url, Some(&client)).await);
        }
        assert!(server.received_requests().await.unwrap().is_empty());
        let small_client =
            CheckedHttpClient::for_test(8, "preview.test", *server.address()).unwrap();
        Mock::given(path("/start"))
            .respond_with(html())
            .mount(&server)
            .await;
        assert_unavailable(resolve_with_client(&state, &url, Some(&small_client)).await);
    }

    #[test]
    fn script_capability_is_limited_to_supported_production_urls() {
        for url in [
            "https://docs.google.com/document/d/id",
            "https://lesswrong.com/posts/id",
            "https://www.lesswrong.com/posts/id",
            "https://archive.org/details/book",
        ] {
            assert!(scripts_allowed(&Url::parse(url).unwrap()), "{url}");
        }
        for url in [
            "http://docs.google.com/document/d/id",
            "https://docs.google.com:444/document/d/id",
            "https://docs.google.com.evil.test/",
            "https://evil.docs.google.com/",
            "https://archive.org/",
            "https://archive.org/details",
            "https://archive.org/download/book",
            "https://example.com/",
            "https://localhost/",
        ] {
            assert!(!scripts_allowed(&Url::parse(url).unwrap()), "{url}");
        }
    }

    #[tokio::test]
    #[serial(external_embeds)]
    async fn redirect_from_supported_host_does_not_grant_final_host_scripts() {
        let (state, _temp, server, client, url) = fixture().await;
        // The checked test resolver admits just its named host. Redirecting away
        // from a supported host therefore cannot inherit that host's capability.
        let supported =
            CheckedHttpClient::for_test(MAX_HTML_BYTES, "docs.google.com", *server.address())
                .unwrap();
        Mock::given(path("/start"))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", &url.replace("/start", "/final")),
            )
            .mount(&server)
            .await;
        let response = resolve_with_client(
            &state,
            &url.replace("preview.test", "docs.google.com"),
            Some(&supported),
        )
        .await;
        assert_unavailable(response);
        server.reset().await;
        Mock::given(path("/start"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/final"))
            .mount(&server)
            .await;
        Mock::given(path("/final"))
            .respond_with(html())
            .mount(&server)
            .await;
        let response = resolve_with_client(&state, &url, Some(&client)).await;
        assert!(!response.scripts);
    }

    async fn save_archive(state: &Arc<AppState>, url: &str) -> (axum_test::TestServer, String) {
        let server =
            axum_test::TestServer::new(crate::api::api_router().with_state(Arc::clone(state)))
                .unwrap();
        let body = "# Saved page";
        let response = server
            .post("/archive")
            .json(&serde_json::json!({
                "url": url,
                "domain": "preview.test",
                "title": "Saved page",
                "captured_at": "2026-10-16T12:00:00Z",
                "content_hash": crate::vault::cas::ContentStore::hash_bytes(body.as_bytes()),
                "snapshot_html": "<html><body>Saved page</body></html>",
                "markdown_body": body,
                "tags": ["archive"]
            }))
            .await;
        response.assert_status(axum::http::StatusCode::CREATED);
        let page = response.json::<serde_json::Value>();
        (server, page["vault_path"].as_str().unwrap().to_owned())
    }

    #[tokio::test]
    #[serial(external_embeds)]
    async fn valid_active_archive_wins_without_fetch_and_rubbish_never_does() {
        let (state, _temp, network, client, url) = fixture().await;
        let (server, page_path) = save_archive(&state, &url).await;
        let response = resolve_with_client(&state, &url, Some(&client)).await;
        assert_eq!(response.state, ExternalEmbedState::Ready);
        assert_eq!(response.source, Some(ExternalEmbedSource::Archive));
        assert!(!response.scripts);
        assert!(
            response
                .url
                .unwrap()
                .starts_with("/api/vault/archive/view/sha256:")
        );
        assert!(network.received_requests().await.unwrap().is_empty());
        server
            .delete(&format!("/pages/{page_path}"))
            .await
            .assert_status(axum::http::StatusCode::CREATED);
        Mock::given(path("/start"))
            .respond_with(html())
            .expect(1)
            .mount(&network)
            .await;
        let response = resolve_with_client(&state, &url, Some(&client)).await;
        assert_eq!(response.source, Some(ExternalEmbedSource::Live));
    }

    #[tokio::test]
    #[serial(external_embeds)]
    async fn invalid_saved_snapshot_falls_back_to_checked_live_html() {
        let (state, _temp, network, client, url) = fixture().await;
        let (_server, _path) = save_archive(&state, &url).await;
        Mock::given(path("/start"))
            .respond_with(html())
            .mount(&network)
            .await;
        let corrupt = format!(
            "<html><body>{}text{}</body></html>",
            "<noscript>".repeat(17),
            "</noscript>".repeat(17)
        );
        let non_html = state
            .cas
            .lock()
            .store(b"not HTML", "image/png")
            .unwrap()
            .hash;
        let unrenderable = state
            .cas
            .lock()
            .store(corrupt.as_bytes(), "text/html")
            .unwrap()
            .hash;
        let invalid_hashes = [format!("sha256:{}", "0".repeat(64)), non_html, unrenderable];
        for hash in invalid_hashes {
            let lookup_url = url.clone();
            state.index.with_index(move |index, _vault| {
                index.connection().execute(
                    "UPDATE pages SET meta_json = json_set(meta_json, '$.archive.snapshot_hash', ?1) WHERE json_extract(meta_json, '$.archive.url') = ?2",
                    rusqlite::params![hash, lookup_url],
                )
            }).await.unwrap().unwrap();
            let response = resolve_with_client(&state, &url, Some(&client)).await;
            assert_eq!(response.source, Some(ExternalEmbedSource::Live));
            assert_eq!(response.url.as_deref(), Some(url.as_str()));
        }
    }
}
