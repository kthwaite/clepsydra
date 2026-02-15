pub mod document;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tokio::sync::{Mutex, RwLock};
use tower_lsp::jsonrpc::Result;
use tower_lsp::lsp_types::*;
use tower_lsp::{Client, LanguageServer, LspService, Server};

use crate::api::AppState;

/// LSP backend holding the shared vault state and per-document data.
pub struct LspBackend {
    /// The tower-lsp client handle for sending notifications/requests to the editor.
    pub client: Client,
    /// Shared application state (vault, index, etc.).
    pub state: Arc<AppState>,
    /// Open documents keyed by URI.
    pub documents: Mutex<HashMap<Url, document::Document>>,
    /// Cached snapshot of all canonical names for fast diagnostic checks.
    pub canonical_names: Arc<RwLock<HashSet<String>>>,
}

#[tower_lsp::async_trait]
impl LanguageServer for LspBackend {
    async fn initialize(&self, _params: InitializeParams) -> Result<InitializeResult> {
        Ok(InitializeResult {
            capabilities: ServerCapabilities {
                position_encoding: Some(PositionEncodingKind::UTF8),
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                completion_provider: Some(CompletionOptions {
                    trigger_characters: Some(vec!["[".to_string(), "#".to_string()]),
                    ..Default::default()
                }),
                hover_provider: Some(HoverProviderCapability::Simple(true)),
                definition_provider: Some(OneOf::Left(true)),
                references_provider: Some(OneOf::Left(true)),
                document_symbol_provider: Some(OneOf::Left(true)),
                workspace_symbol_provider: Some(OneOf::Left(true)),
                rename_provider: Some(OneOf::Right(RenameOptions {
                    prepare_provider: Some(true),
                    work_done_progress_options: WorkDoneProgressOptions::default(),
                })),
                code_action_provider: Some(CodeActionProviderCapability::Simple(true)),
                code_lens_provider: Some(CodeLensOptions {
                    resolve_provider: Some(true),
                }),
                ..Default::default()
            },
            server_info: Some(ServerInfo {
                name: "clepsydra-lsp".to_string(),
                version: Some(env!("CARGO_PKG_VERSION").to_string()),
            }),
        })
    }

    async fn initialized(&self, _params: InitializedParams) {
        let names = self
            .state
            .index
            .with_index(|index, _| {
                let mut stmt = index
                    .connection()
                    .prepare("SELECT canonical_name FROM canonical_names")
                    .unwrap();
                stmt.query_map([], |row| row.get::<_, String>(0))
                    .unwrap()
                    .filter_map(|r| r.ok())
                    .collect::<HashSet<String>>()
            })
            .await
            .unwrap_or_default();
        *self.canonical_names.write().await = names;
        self.client
            .log_message(MessageType::INFO, "clepsydra LSP initialized")
            .await;
    }

    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        let uri = params.text_document.uri;
        let text = params.text_document.text;
        let version = params.text_document.version;

        let doc = document::Document::from_text(&text, version);

        {
            let mut docs = self.documents.lock().await;
            docs.insert(uri.clone(), doc);
        }

        {
            let docs = self.documents.lock().await;
            if let Some(doc) = docs.get(&uri) {
                self.publish_diagnostics_for(&uri, doc).await;
            }
        }
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        let uri = params.text_document.uri;
        let version = params.text_document.version;

        // Full sync: take the last (only) content change
        if let Some(change) = params.content_changes.into_iter().last() {
            let mut doc = document::Document::from_text(&change.text, version);
            doc.dirty = true;
            {
                let mut docs = self.documents.lock().await;
                docs.insert(uri.clone(), doc);
            }

            {
                let docs = self.documents.lock().await;
                if let Some(doc) = docs.get(&uri) {
                    self.publish_diagnostics_for(&uri, doc).await;
                }
            }
        }
    }

    async fn did_close(&self, params: DidCloseTextDocumentParams) {
        let uri = params.text_document.uri;
        let mut docs = self.documents.lock().await;
        docs.remove(&uri);
    }

    async fn goto_definition(
        &self,
        params: GotoDefinitionParams,
    ) -> Result<Option<GotoDefinitionResponse>> {
        let uri = params.text_document_position_params.text_document.uri;
        let pos = params.text_document_position_params.position;

        let link = {
            let docs = self.documents.lock().await;
            let doc = match docs.get(&uri) {
                Some(d) => d,
                None => return Ok(None),
            };
            doc.link_at_position(pos).cloned()
        };

        let link = match link {
            Some(l) => l,
            None => return Ok(None),
        };

        let canonical = crate::vault::canonical::CanonicalName::from_title(&link.target_raw);
        let target_path: Option<String> = self
            .state
            .index
            .with_index({
                let cn = canonical.as_str().to_string();
                move |index, _vault| {
                    index
                        .connection()
                        .query_row(
                            "SELECT p.path FROM canonical_names cn \
                             JOIN pages p ON p.id = cn.page_id \
                             WHERE cn.canonical_name = ?1 LIMIT 1",
                            rusqlite::params![cn],
                            |row| row.get(0),
                        )
                        .ok()
                }
            })
            .await
            .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;

        let target_path = match target_path {
            Some(p) => p,
            None => return Ok(None),
        };

        let abs_path = self.state.vault.resolve(
            &crate::vault::path::VaultPath::new(&target_path)
                .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?,
        );
        let target_uri = Url::from_file_path(&abs_path)
            .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;

        Ok(Some(GotoDefinitionResponse::Scalar(Location {
            uri: target_uri,
            range: Range::default(),
        })))
    }
}

impl LspBackend {
    /// Publish diagnostics for a single open document.
    ///
    /// Checks each extracted link against the cached canonical name snapshot
    /// and reports unresolved links as warnings.
    async fn publish_diagnostics_for(&self, uri: &Url, doc: &document::Document) {
        let mut diagnostics = Vec::new();
        let names = self.canonical_names.read().await;

        for link in &doc.links {
            if link.span.start == 0 && link.span.end == 0 {
                continue; // skip property ref links
            }
            let canonical = crate::vault::canonical::CanonicalName::from_title(&link.target_raw);
            if !names.contains(canonical.as_str()) {
                diagnostics.push(Diagnostic {
                    range: doc.link_to_range(link),
                    severity: Some(DiagnosticSeverity::WARNING),
                    code: Some(NumberOrString::String("unresolved-link".into())),
                    source: Some("clepsydra".into()),
                    message: format!("Unresolved link: \"{}\"", link.target_raw),
                    ..Default::default()
                });
            }
        }
        self.client
            .publish_diagnostics(uri.clone(), diagnostics, Some(doc.version))
            .await;
    }
}

/// Start the LSP server on stdio, using the given shared state.
///
/// This function returns when the client disconnects (stdin EOF).
pub async fn run_lsp(state: Arc<AppState>) {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();

    let (service, socket) = LspService::new(|client| LspBackend {
        client,
        state,
        documents: Mutex::new(HashMap::new()),
        canonical_names: Arc::new(RwLock::new(HashSet::new())),
    });

    Server::new(stdin, stdout, socket).serve(service).await;
}
