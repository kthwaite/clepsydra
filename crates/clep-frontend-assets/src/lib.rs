//! Serves the built React UI (`ui/dist/`) embedded into the `clep` binary via
//! `rust-embed`.
//!
//! This lives in its own crate purely for build isolation: `rust-embed`
//! re-embeds `ui/dist/` and forces a recompile whenever any file under it
//! changes. Kept inline in the main lib, that recompile drags the whole
//! `clepsydra` crate down with it. Isolated here, a UI rebuild only
//! recompiles this crate and the `clep` binary, never the server lib.

use axum::{
    Router,
    body::Body,
    http::{HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use rust_embed::RustEmbed;

// React renders a small number of dynamic style attributes (for example graph
// coordinates), so style-src must retain unsafe-inline. Scripts are all
// external and same-origin; connect-src 'self' covers both API fetches and SSE.
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; base-uri 'self'; connect-src 'self'; \
    font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; \
    manifest-src 'self'; object-src 'none'; script-src 'self'; \
    style-src 'self' 'unsafe-inline'; worker-src 'self'";

/// Hashed build output under `assets/` never changes at a given URL, so it may
/// be cached for a year. Everything else (the HTML shell, the service worker,
/// the manifest, unhashed public files) must be revalidated on every load so a
/// deploy is picked up and the service worker update check sees new bytes.
fn cache_control_for(path: &str) -> &'static str {
    if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

fn content_type_for(path: &str) -> String {
    if path.ends_with(".webmanifest") {
        return "application/manifest+json".to_string();
    }
    mime_guess::from_path(path)
        .first_or_octet_stream()
        .essence_str()
        .to_string()
}

#[derive(RustEmbed)]
#[folder = "../../ui/dist/"]
struct Assets;

pub fn frontend_router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new().fallback(get(static_handler))
}

async fn static_handler(uri: Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');

    let (mut response, cache_control) = if path.is_empty() || path == "index.html" {
        (index_html().await, cache_control_for("index.html"))
    } else if let Some(content) = Assets::get(path) {
        let response = Response::builder()
            .header(header::CONTENT_TYPE, content_type_for(path))
            .body(Body::from(content.data))
            .unwrap();
        (response, cache_control_for(path))
    } else {
        // SPA fallback: serve index.html for unknown paths
        (index_html().await, cache_control_for("index.html"))
    };

    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    with_security_headers(response)
}

fn with_security_headers(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    response
}

async fn index_html() -> Response {
    match Assets::get("index.html") {
        Some(content) => Response::builder()
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(Body::from(content.data))
            .unwrap(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    const EXPECTED_CSP: &str = "default-src 'self'; base-uri 'self'; connect-src 'self'; \
        font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; \
        manifest-src 'self'; object-src 'none'; script-src 'self'; \
        style-src 'self' 'unsafe-inline'; worker-src 'self'";

    fn assert_security_headers(response: &Response) {
        let headers = response.headers();
        assert_eq!(
            headers
                .get(header::CONTENT_SECURITY_POLICY)
                .and_then(|value| value.to_str().ok()),
            Some(EXPECTED_CSP)
        );
        assert_eq!(
            headers
                .get(header::X_CONTENT_TYPE_OPTIONS)
                .and_then(|value| value.to_str().ok()),
            Some("nosniff")
        );
        assert_eq!(
            headers
                .get(header::REFERRER_POLICY)
                .and_then(|value| value.to_str().ok()),
            Some("no-referrer")
        );
        assert_eq!(
            headers
                .get(header::X_FRAME_OPTIONS)
                .and_then(|value| value.to_str().ok()),
            Some("DENY")
        );

        let csp = headers
            .get(header::CONTENT_SECURITY_POLICY)
            .expect("CSP header")
            .to_str()
            .expect("ASCII CSP");
        assert!(!csp.contains("'unsafe-eval'"));
        assert!(!csp.contains("script-src 'self' 'unsafe-inline'"));
    }

    #[tokio::test]
    async fn docs_paths_use_the_spa_fallback() {
        for uri in ["/docs", "/docs/getting-started", "/docs/bases"] {
            let response = static_handler(Uri::from_static(uri)).await.into_response();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok()),
                Some("text/html; charset=utf-8")
            );
        }
    }

    #[tokio::test]
    async fn index_and_asset_responses_include_security_headers() {
        let index = static_handler(Uri::from_static("/index.html"))
            .await
            .into_response();
        assert_security_headers(&index);

        let asset = Assets::iter()
            .find(|path| path.as_ref() != "index.html")
            .expect("at least one embedded asset");
        let uri = Uri::try_from(format!("/{asset}")).expect("asset URI");
        let asset = static_handler(uri).await.into_response();
        assert_security_headers(&asset);
    }

    #[tokio::test]
    async fn embedded_index_uses_only_external_scripts() {
        let response = index_html().await;
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read embedded index");
        let html = String::from_utf8(body.to_vec()).expect("UTF-8 index");

        for script in html.match_indices("<script") {
            let tag = &html[script.0..];
            let tag = &tag[..tag.find('>').expect("complete script tag")];
            assert!(tag.contains(" src="), "inline script found: {tag}>");
        }
    }

    #[test]
    fn hashed_assets_are_immutable_and_shell_files_are_revalidated() {
        assert_eq!(
            cache_control_for("assets/index-m5_YmWWd.js"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            cache_control_for("assets/react-CwJFpaho.js"),
            "public, max-age=31536000, immutable"
        );
        for shell in [
            "index.html",
            "sw.js",
            "manifest.webmanifest",
            "registerSW.js",
            "",
        ] {
            assert_eq!(cache_control_for(shell), "no-cache", "path {shell:?}");
        }
        assert_eq!(cache_control_for("favicon.svg"), "no-cache");
    }

    #[test]
    fn manifest_and_common_assets_get_the_right_content_type() {
        assert_eq!(
            content_type_for("manifest.webmanifest"),
            "application/manifest+json"
        );
        assert_eq!(content_type_for("sw.js"), "text/javascript");
        assert_eq!(content_type_for("assets/a.css"), "text/css");
        assert_eq!(content_type_for("pwa-512.png"), "image/png");
    }

    #[tokio::test]
    async fn responses_carry_cache_control() {
        let index = static_handler(Uri::from_static("/index.html"))
            .await
            .into_response();
        assert_eq!(
            index
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("no-cache")
        );

        let fallback = static_handler(Uri::from_static("/docs/anything"))
            .await
            .into_response();
        assert_eq!(
            fallback
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("no-cache")
        );

        let asset = Assets::iter()
            .find(|path| path.starts_with("assets/"))
            .expect("at least one hashed asset");
        let uri = Uri::try_from(format!("/{asset}")).expect("asset URI");
        let asset = static_handler(uri).await.into_response();
        assert_eq!(
            asset
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("public, max-age=31536000, immutable")
        );
    }

    #[test]
    fn csp_allows_same_origin_workers_and_manifest() {
        assert!(CONTENT_SECURITY_POLICY.contains("worker-src 'self'"));
        assert!(CONTENT_SECURITY_POLICY.contains("manifest-src 'self'"));
    }
}
