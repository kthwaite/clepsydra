mod document;
mod snapshot;

use std::sync::Arc;

use crate::api::{AppState, error::ApiError};
use crate::vault::path::VaultPath;

pub(crate) async fn export(
    state: Arc<AppState>,
    path: VaultPath,
) -> Result<(String, Vec<u8>), ApiError> {
    let today = state.clock.now().date_naive();
    let cas_root = state.cas.lock().root().to_path_buf();
    let (title, markdown, vault) = state
        .index
        .with_index(move |index, vault| {
            let current = crate::vault::Vault::open(vault.root())
                .map_err(|_| ApiError::internal("vault access policy could not be read"))?;
            let mut snapshot = snapshot::Snapshot::new(&current, index, today);
            let page = snapshot.page(path)?;
            let title = page
                .meta
                .title
                .clone()
                .unwrap_or_else(|| page.path.decode_slug());
            let markdown = snapshot.expand(&page, &page.body)?;
            Ok::<_, ApiError>((title, markdown, current))
        })
        .await
        .map_err(|_| ApiError::internal("Word snapshot worker failed"))??;
    tokio::task::spawn_blocking(move || {
        let mut remaining = snapshot::MAX_IMAGE_BYTES;
        let bytes = document::render(&title, &markdown, |reference| {
            let bytes = if let Some(hash) = reference.strip_prefix("/api/vault/cas/") {
                snapshot::read_cas_image(&cas_root, hash, remaining).map_err(|error| error.error)?
            } else {
                snapshot::read_image(&vault, reference, remaining).map_err(|error| error.error)?
            };
            remaining = remaining
                .checked_sub(bytes.len())
                .ok_or("images exceed the export limit")?;
            Ok(bytes)
        })
        .map_err(snapshot::unsupported)?;
        Ok((title, bytes))
    })
    .await
    .map_err(|_| ApiError::internal("Word rendering worker failed"))?
}
