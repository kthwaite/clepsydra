//! Deep-link endpoints: JSON resolution for the editor, redirect for the OS
//! URL handler.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Query, State};
use axum::response::{Json, Redirect};
use axum::routing::get;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;
use crate::deeplink;

/// Keep `/` so a vault path stays a path in the redirect location.
const PATH_KEEP_SLASH: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'/')
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

const QUERY_VALUE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

#[derive(Debug, Deserialize)]
pub struct DeepLinkParams {
    pub url: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ResolveResponse {
    /// Vault-relative path of the resolved page.
    pub path: String,
}

/// Parse + vault-check + resolve; `Ok(None)` is a miss, `Err` a parse error.
async fn resolve_pipeline(
    state: &Arc<AppState>,
    url: &str,
) -> Result<Option<String>, deeplink::ParseError> {
    let parsed = deeplink::parse(url)?;
    let aliases = state.vault.config().vault.obsidian_vault_aliases.clone();
    if !deeplink::vault_matches(parsed.vault.as_deref(), state.vault.root(), &aliases) {
        return Ok(None);
    }
    let raw = parsed.target_raw;
    let decoded = parsed.target_decoded;
    let found = state
        .index
        .with_index(move |index, _vault| {
            deeplink::resolve_target(index.connection(), &raw, &decoded).unwrap_or(None)
        })
        .await
        .unwrap_or(None);
    Ok(found)
}

#[utoipa::path(
    get,
    path = "/resolve",
    context_path = "/api/vault",
    tag = "Deeplink",
    params(("url" = String, Query, description = "clepsydra:// or obsidian:// URL")),
    responses(
        (status = 200, description = "Resolved page path", body = ResolveResponse),
        (status = 400, description = "Unparseable link", body = ApiError),
        (status = 404, description = "No page matches", body = ApiError)
    )
)]
pub async fn resolve_url(
    State(state): State<Arc<AppState>>,
    Query(params): Query<DeepLinkParams>,
) -> Result<Json<ResolveResponse>, ApiError> {
    let found = resolve_pipeline(&state, &params.url)
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    found
        .map(|path| Json(ResolveResponse { path }))
        .ok_or_else(|| ApiError::not_found(format!("no page matches: {}", params.url)))
}

/// Root-level redirect target for the OS URL handler. Misses and parse errors
/// both land on the UI's not-found page — an OS click must never dead-end on
/// a JSON error body.
pub async fn deeplink_redirect(
    State(state): State<Arc<AppState>>,
    Query(params): Query<DeepLinkParams>,
) -> Redirect {
    match resolve_pipeline(&state, &params.url).await {
        Ok(Some(path)) => Redirect::temporary(&format!(
            "/pages/{}",
            utf8_percent_encode(&path, PATH_KEEP_SLASH)
        )),
        _ => Redirect::temporary(&format!(
            "/link-miss?target={}",
            utf8_percent_encode(&params.url, QUERY_VALUE)
        )),
    }
}

/// Routes mounted under `/api/vault`.
pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/resolve", get(resolve_url))
}

/// Routes mounted at the server root (outside `/api`).
pub fn root_router() -> Router<Arc<AppState>> {
    Router::new().route("/deeplink", get(deeplink_redirect))
}
