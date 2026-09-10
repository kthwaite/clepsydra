use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;
use crate::vault::keyring::{
    KeyringError, KeyringSnapshot, MAX_RECIPIENT_BYTES, MAX_WRAPPED_IDENTITY_BYTES, load_keyring,
    rewrap_identity, setup_keyring,
};

const KEY_ID_MAX_BYTES: usize = 64;
const JSON_ENVELOPE_ALLOWANCE: usize = 256 * 1024;
const MAX_KEYRING_REQUEST_BYTES: usize = MAX_WRAPPED_IDENTITY_BYTES + JSON_ENVELOPE_ALLOWANCE;

#[derive(Debug, Serialize, ToSchema)]
pub struct EncryptionConfigResponse {
    pub initialized: bool,
    pub key_id: Option<String>,
    pub recipient: Option<String>,
    pub wrapped_identity: Option<String>,
    pub revision: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SetupEncryptionRequest {
    pub key_id: String,
    pub recipient: String,
    pub wrapped_identity: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RewrapIdentityRequest {
    pub expected_revision: String,
    pub wrapped_identity: String,
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(get_encryption_config))
        .route("/setup", post(setup_encryption))
        .route("/wrapped-identity", put(rewrap_wrapped_identity))
        .layer(DefaultBodyLimit::max(MAX_KEYRING_REQUEST_BYTES))
}

#[utoipa::path(
    get,
    path = "/encryption",
    context_path = "/api/vault",
    tag = "Encryption",
    responses(
        (status = 200, description = "Vault encryption configuration", body = EncryptionConfigResponse),
        (status = 500, description = "Invalid or unreadable keyring", body = ApiError)
    )
)]
pub async fn get_encryption_config(
    State(state): State<Arc<AppState>>,
) -> Result<Json<EncryptionConfigResponse>, ApiError> {
    let snapshot = load_keyring(state.vault.root()).map_err(keyring_error)?;
    Ok(Json(config_response(snapshot.as_ref())?))
}

#[utoipa::path(
    post,
    path = "/encryption/setup",
    context_path = "/api/vault",
    tag = "Encryption",
    request_body = SetupEncryptionRequest,
    responses(
        (status = 201, description = "Vault encryption initialized", body = EncryptionConfigResponse),
        (status = 400, description = "Invalid public key or wrapped identity", body = ApiError),
        (status = 409, description = "Vault encryption already initialized", body = ApiError),
        (status = 500, description = "Keyring persistence failed", body = ApiError)
    )
)]
pub async fn setup_encryption(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SetupEncryptionRequest>,
) -> Result<Response, ApiError> {
    validate_setup_sizes(&body)?;
    let snapshot = setup_keyring(
        state.vault.root(),
        &body.key_id,
        &body.recipient,
        body.wrapped_identity.as_deref(),
    )
    .map_err(keyring_error)?;
    let response = config_response(Some(&snapshot))?;
    Ok((StatusCode::CREATED, Json(response)).into_response())
}

#[utoipa::path(
    put,
    path = "/encryption/wrapped-identity",
    context_path = "/api/vault",
    tag = "Encryption",
    request_body = RewrapIdentityRequest,
    responses(
        (status = 200, description = "Wrapped identity replaced", body = EncryptionConfigResponse),
        (status = 400, description = "Invalid wrapped identity", body = ApiError),
        (status = 404, description = "Vault encryption is not initialized", body = ApiError),
        (status = 409, description = "Keyring revision conflict", body = ApiError),
        (status = 500, description = "Keyring persistence failed", body = ApiError)
    )
)]
pub async fn rewrap_wrapped_identity(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RewrapIdentityRequest>,
) -> Result<Json<EncryptionConfigResponse>, ApiError> {
    if body.expected_revision.len() > 128 {
        return Err(ApiError::bad_request("expected revision is too long"));
    }
    if body.wrapped_identity.len() > MAX_WRAPPED_IDENTITY_BYTES {
        return Err(ApiError::bad_request("wrapped identity is too large"));
    }
    let snapshot = rewrap_identity(
        state.vault.root(),
        &body.expected_revision,
        Some(&body.wrapped_identity),
    )
    .map_err(keyring_error)?;
    Ok(Json(config_response(Some(&snapshot))?))
}

fn validate_setup_sizes(body: &SetupEncryptionRequest) -> Result<(), ApiError> {
    if body.key_id.len() > KEY_ID_MAX_BYTES {
        return Err(ApiError::bad_request("key ID is too long"));
    }
    if body.recipient.len() > MAX_RECIPIENT_BYTES {
        return Err(ApiError::bad_request("recipient is too long"));
    }
    if body
        .wrapped_identity
        .as_ref()
        .is_some_and(|armor| armor.len() > MAX_WRAPPED_IDENTITY_BYTES)
    {
        return Err(ApiError::bad_request("wrapped identity is too large"));
    }
    Ok(())
}

fn config_response(
    snapshot: Option<&KeyringSnapshot>,
) -> Result<EncryptionConfigResponse, ApiError> {
    let Some(snapshot) = snapshot else {
        return Ok(EncryptionConfigResponse {
            initialized: false,
            key_id: None,
            recipient: None,
            wrapped_identity: None,
            revision: None,
        });
    };
    let active = snapshot
        .keyring
        .keys
        .iter()
        .find(|record| record.id == snapshot.keyring.active_key_id)
        .ok_or_else(|| ApiError::internal("active key is missing from keyring"))?;
    Ok(EncryptionConfigResponse {
        initialized: true,
        key_id: Some(active.id.clone()),
        recipient: Some(active.recipient.clone()),
        wrapped_identity: snapshot.wrapped_identity.clone(),
        revision: Some(snapshot.revision.clone()),
    })
}

fn keyring_error(error: KeyringError) -> ApiError {
    match error {
        KeyringError::AlreadyInitialized => ApiError::conflict(error.to_string()),
        KeyringError::NotInitialized => ApiError::not_found(error.to_string()),
        KeyringError::RevisionConflict { current_revision } => {
            ApiError::revision_conflict(current_revision)
        }
        KeyringError::InvalidKeyId
        | KeyringError::InvalidRecipient
        | KeyringError::InvalidWrappedIdentity => ApiError::bad_request(error.to_string()),
        KeyringError::InvalidMetadata | KeyringError::Io(_) | KeyringError::Publication(_) => {
            ApiError::internal(error.to_string())
        }
    }
}
