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
    object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'";

#[derive(RustEmbed)]
#[folder = "ui/dist/"]
struct Assets;

pub fn frontend_router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new().fallback(get(static_handler))
}

async fn static_handler(uri: Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');

    let response = if path.is_empty() || path == "index.html" {
        index_html().await
    } else if let Some(content) = Assets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        Response::builder()
            .header(header::CONTENT_TYPE, mime.as_ref())
            .body(Body::from(content.data))
            .unwrap()
    } else {
        // SPA fallback: serve index.html for unknown paths
        index_html().await
    };

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
        object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'";

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
}
