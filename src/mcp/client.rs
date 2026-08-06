//! Thin HTTP client over the running clepsydra server's vault API.
//!
//! The MCP layer never touches vault files or the index directly — every call
//! goes through the HTTP API so the server stays the single writer (path
//! locks, hooks, SSE notifications). This module owns the reqwest plumbing and
//! the translation of API failures into actionable, agent-facing messages.

use std::time::Duration;

use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use serde_json::Value;

/// Characters percent-encoded inside a single URL path segment. `/` never
/// appears here because [`encode_vault_path`] encodes segment-by-segment.
const PATH_SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'\\')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

/// Percent-encode a vault-relative path for use in a request URL, preserving
/// `/` separators so it matches the server's `{*path}` wildcard routes.
pub fn encode_vault_path(path: &str) -> String {
    path.split('/')
        .map(|segment| utf8_percent_encode(segment, PATH_SEGMENT).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// A failed API call, formatted for direct display to the calling agent.
#[derive(Debug, thiserror::Error)]
pub enum ApiCallError {
    #[error(
        "clepsydra server not reachable at {base} — start it with `clep serve` (underlying error: {source})"
    )]
    Unreachable {
        base: String,
        #[source]
        source: reqwest::Error,
    },
    #[error("{message}")]
    Api { status: u16, message: String },
    #[error("unexpected response from {url}: {message}")]
    Protocol { url: String, message: String },
}

impl ApiCallError {
    /// True for a 409 response — the optimistic-concurrency signal callers
    /// may choose to retry after re-reading.
    pub fn is_conflict(&self) -> bool {
        matches!(self, ApiCallError::Api { status: 409, .. })
    }
}

/// Build the agent-facing message for a non-success API response, unpacking
/// the server's uniform `ApiError` payload when present and appending a
/// next-step hint keyed on the status code.
pub(crate) fn api_error_message(status: u16, body: &str) -> String {
    let (error, server_hint, detail) = match serde_json::from_str::<Value>(body) {
        Ok(parsed) => {
            let error = parsed
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| body.to_string());
            let hint = parsed
                .get("hint")
                .and_then(Value::as_str)
                .map(str::to_string);
            let detail = parsed.get("detail").filter(|d| !d.is_null()).cloned();
            (error, hint, detail)
        }
        Err(_) => (body.to_string(), None, None),
    };

    let mut message = format!("API error {status}: {error}");
    if let Some(hint) = server_hint {
        message.push_str(&format!(" (hint: {hint})"));
    }
    if let Some(detail) = detail {
        message.push_str(&format!(" — detail: {detail}"));
    }
    match status {
        404 => message.push_str(
            " — the page may have been moved by a kind/project assignment; \
             locate it with vault_search",
        ),
        // A backlink conflict is a deliberate guard, not a lost race: the
        // caller must confirm before forcing. Everything else on 409 is
        // optimistic concurrency.
        409 if message.contains("backlink") => message.push_str(
            " — review the listed backlinks with the user, then re-run with force: true \
             to delete and rewrite them",
        ),
        409 => message
            .push_str(" — the page changed concurrently; re-read it with vault_get_page and retry"),
        _ => {}
    }
    message
}

/// HTTP client bound to one server base URL (e.g. `http://localhost:16667`).
pub struct ApiClient {
    http: reqwest::Client,
    base: String,
}

impl ApiClient {
    /// Build a client for `base`. When the server runs HTTPS with its local
    /// mkcert certificate, pass that certificate's PEM bytes so verification
    /// succeeds without touching system trust stores.
    pub fn new(
        base: String,
        extra_root_cert_pem: Option<Vec<u8>>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(30));
        if let Some(pem) = extra_root_cert_pem {
            builder = builder.add_root_certificate(reqwest::Certificate::from_pem(&pem)?);
        }
        Ok(Self {
            http: builder.build()?,
            base,
        })
    }

    /// The server base URL this client targets.
    pub fn base(&self) -> &str {
        &self.base
    }

    /// GET `path` (server-relative, already encoded) with query parameters,
    /// returning the parsed JSON body.
    pub async fn get_json(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Value, ApiCallError> {
        let url = format!("{}{}", self.base, path);
        let request = self.http.get(&url).query(query);
        self.send(url, request).await
    }

    /// POST a JSON `body` to `path`, returning the parsed JSON response.
    pub async fn post_json(&self, path: &str, body: &Value) -> Result<Value, ApiCallError> {
        let url = format!("{}{}", self.base, path);
        let request = self.http.post(&url).json(body);
        self.send(url, request).await
    }

    /// PUT a JSON `body` to `path`, returning the parsed JSON response.
    pub async fn put_json(&self, path: &str, body: &Value) -> Result<Value, ApiCallError> {
        let url = format!("{}{}", self.base, path);
        let request = self.http.put(&url).json(body);
        self.send(url, request).await
    }

    /// DELETE `path` with query parameters. Success responses are typically
    /// 204 with no body, which parses to `Value::Null`.
    pub async fn delete_json(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Value, ApiCallError> {
        let url = format!("{}{}", self.base, path);
        let request = self.http.delete(&url).query(query);
        self.send(url, request).await
    }

    /// Send a prepared request and translate the outcome: transport failures
    /// become [`ApiCallError::Unreachable`], non-2xx responses become
    /// agent-facing [`ApiCallError::Api`] messages, and success bodies parse
    /// as JSON.
    async fn send(
        &self,
        url: String,
        request: reqwest::RequestBuilder,
    ) -> Result<Value, ApiCallError> {
        let response = request
            .send()
            .await
            .map_err(|source| ApiCallError::Unreachable {
                base: self.base.clone(),
                source,
            })?;

        let status = response.status();
        let body = response.text().await.map_err(|e| ApiCallError::Protocol {
            url: url.clone(),
            message: format!("failed to read response body: {e}"),
        })?;

        if !status.is_success() {
            return Err(ApiCallError::Api {
                status: status.as_u16(),
                message: api_error_message(status.as_u16(), &body),
            });
        }

        // Some mutation endpoints succeed with an empty body (204 deletes,
        // the folder move's bare 200).
        if body.trim().is_empty() {
            return Ok(Value::Null);
        }

        serde_json::from_str(&body).map_err(|e| ApiCallError::Protocol {
            url,
            message: format!("invalid JSON in response: {e}"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_vault_path_preserves_slashes_and_encodes_spaces() {
        assert_eq!(encode_vault_path("notes/My Note.md"), "notes/My%20Note.md");
        assert_eq!(encode_vault_path("plain.md"), "plain.md");
    }

    #[test]
    fn encode_vault_path_encodes_reserved_characters() {
        assert_eq!(
            encode_vault_path("notes/50% done?.md"),
            "notes/50%25%20done%3F.md"
        );
    }

    #[test]
    fn api_error_message_unpacks_api_error_payload() {
        let msg = api_error_message(400, r#"{"status":400,"error":"invalid path"}"#);
        assert_eq!(msg, "API error 400: invalid path");
    }

    #[test]
    fn api_error_message_includes_server_hint() {
        let msg = api_error_message(
            400,
            r#"{"status":400,"error":"bad","hint":"do it differently"}"#,
        );
        assert!(msg.contains("bad"));
        assert!(msg.contains("do it differently"));
    }

    #[test]
    fn api_error_message_adds_search_hint_on_404() {
        let msg = api_error_message(404, r#"{"status":404,"error":"page not found: x.md"}"#);
        assert!(msg.contains("page not found: x.md"));
        assert!(
            msg.contains("vault_search"),
            "missing next-step hint: {msg}"
        );
    }

    #[test]
    fn api_error_message_adds_retry_hint_on_409() {
        let msg = api_error_message(409, r#"{"status":409,"error":"page changed"}"#);
        assert!(msg.contains("re-read"), "missing retry hint: {msg}");
    }

    #[test]
    fn api_error_message_backlink_conflict_guides_toward_force() {
        let msg = api_error_message(
            409,
            r#"{"status":409,"error":"page has 2 backlink(s); use force=true to delete","detail":{"backlinks":["notes/a.md","notes/b.md"]}}"#,
        );
        assert!(msg.contains("notes/a.md"), "detail missing: {msg}");
        assert!(msg.contains("force: true"), "{msg}");
        assert!(!msg.contains("re-read"), "wrong 409 hint: {msg}");
    }

    #[test]
    fn api_error_message_includes_detail_payload() {
        let msg = api_error_message(
            400,
            r#"{"status":400,"error":"bad","detail":{"field":"x"}}"#,
        );
        assert!(msg.contains(r#""field":"x""#), "{msg}");
    }

    #[test]
    fn api_error_message_survives_non_json_bodies() {
        let msg = api_error_message(502, "Bad Gateway");
        assert_eq!(msg, "API error 502: Bad Gateway");
    }
}
