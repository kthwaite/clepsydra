//! Shared `#[cfg(test)]` helpers for driving `LspBackend` against a temp vault.
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use tempfile::TempDir;
use tokio::sync::{Mutex, RwLock, broadcast};
use tower_lsp::lsp_types::*;
use tower_lsp::{Client, LanguageServer, LspService};
use tower_lsp::jsonrpc::Result as JsonRpcResult;

use crate::api::AppState;
use crate::lsp::LspBackend;
use crate::lsp::document::Document;
use crate::vault::Vault;
use crate::vault::cas::ContentStore;
use crate::vault::index::VaultIndex;
use crate::vault::index_handle::IndexHandle;
use crate::vault::init::init_vault;

/// Minimal `LanguageServer` impl whose only purpose is to let `LspService::new`
/// hand us a live `Client` we can clone out.
struct ClientHolder {
    #[allow(dead_code)]
    client: Client,
}

#[tower_lsp::async_trait]
impl LanguageServer for ClientHolder {
    async fn initialize(&self, _: InitializeParams) -> JsonRpcResult<InitializeResult> {
        Ok(InitializeResult::default())
    }
    async fn shutdown(&self) -> JsonRpcResult<()> {
        Ok(())
    }
}

/// Construct a live `Client` for tests. tower-lsp does not expose a public
/// `Client` constructor, so we capture it from a throwaway service.
pub(crate) fn test_client() -> Client {
    let slot: Arc<OnceLock<Client>> = Arc::new(OnceLock::new());
    let slot2 = slot.clone();
    let (_service, _socket) = LspService::new(move |client| {
        let _ = slot2.set(client.clone());
        ClientHolder { client }
    });
    slot.get().expect("client captured by factory").clone()
}

/// Build an `LspBackend` over a fresh temp vault containing `files`
/// (relative path, contents). The index is built and links resolved.
pub(crate) fn make_backend(files: &[(&str, &str)]) -> (LspBackend, TempDir) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    for (rel, contents) in files {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, contents).unwrap();
    }

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let cas = ContentStore::open(&tmp.path().join("cas")).unwrap();
    let index_handle = IndexHandle::spawn(index, vault.clone());
    let (change_tx, _rx) = broadcast::channel(64);

    let state = Arc::new(AppState {
        vault,
        index: index_handle,
        cas: Arc::new(parking_lot::Mutex::new(cas)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: Arc::new(vec![]),
        delete_hooks: Arc::new(vec![]),
        archive_ingest_lock: tokio::sync::Mutex::new(()),
        bcl: None,
        location: None,
    });

    let backend = LspBackend {
        client: test_client(),
        state,
        documents: Mutex::new(HashMap::new()),
        canonical_names: Arc::new(RwLock::new(HashMap::new())),
    };
    (backend, tmp)
}

/// File URI for a vault-relative path under the backend's vault root.
pub(crate) fn uri_for(backend: &LspBackend, rel: &str) -> Url {
    Url::from_file_path(backend.state.vault.root().join(rel)).unwrap()
}

/// Open `text` as a document at `uri` and refresh the canonical-name cache.
pub(crate) async fn open_doc(backend: &LspBackend, uri: &Url, text: &str) {
    backend.refresh_canonical_names().await;
    let mut docs = backend.documents.lock().await;
    docs.insert(uri.clone(), Document::from_text(text, 1));
}
