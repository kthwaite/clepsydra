pub mod completion;
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
                text_document_sync: Some(TextDocumentSyncCapability::Options(
                    TextDocumentSyncOptions {
                        open_close: Some(true),
                        change: Some(TextDocumentSyncKind::FULL),
                        save: Some(TextDocumentSyncSaveOptions::SaveOptions(SaveOptions {
                            include_text: Some(false),
                        })),
                        ..Default::default()
                    },
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

    async fn did_save(&self, params: DidSaveTextDocumentParams) {
        let uri = params.text_document.uri;

        // Flush index update for this file
        let vault_path = match self.uri_to_vault_path(&uri) {
            Some(vp) => vp,
            None => return,
        };

        if let Err(e) = self.state.index.index_page(vault_path.clone()).await {
            tracing::error!("index flush on save failed: {e}");
            return;
        }
        if let Err(e) = self.state.index.resolve_links_for_page(vault_path).await {
            tracing::error!("link resolution on save failed: {e}");
        }

        // Refresh canonical name snapshot
        self.refresh_canonical_names().await;

        // Mark document as clean
        {
            let mut docs = self.documents.lock().await;
            if let Some(doc) = docs.get_mut(&uri) {
                doc.dirty = false;
            }
        }

        // Re-publish diagnostics for all open documents (snapshot changed)
        let doc_uris: Vec<Url> = {
            let docs = self.documents.lock().await;
            docs.keys().cloned().collect()
        };
        for doc_uri in doc_uris {
            let docs = self.documents.lock().await;
            if let Some(doc) = docs.get(&doc_uri) {
                self.publish_diagnostics_for(&doc_uri, doc).await;
            }
        }
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

    async fn hover(&self, params: HoverParams) -> Result<Option<Hover>> {
        let uri = params.text_document_position_params.text_document.uri;
        let pos = params.text_document_position_params.position;

        let (link, range) = {
            let docs = self.documents.lock().await;
            let doc = match docs.get(&uri) {
                Some(d) => d,
                None => return Ok(None),
            };
            match doc.link_at_position(pos) {
                Some(link) => (link.clone(), doc.link_to_range(link)),
                None => return Ok(None),
            }
        };

        let canonical = crate::vault::canonical::CanonicalName::from_title(&link.target_raw);
        let target_info: Option<(String, Option<String>)> = self
            .state
            .index
            .with_index({
                let cn = canonical.as_str().to_string();
                move |index, _| {
                    index
                        .connection()
                        .query_row(
                            "SELECT p.path, p.title FROM canonical_names cn \
                             JOIN pages p ON p.id = cn.page_id \
                             WHERE cn.canonical_name = ?1 LIMIT 1",
                            rusqlite::params![cn],
                            |row| {
                                Ok((
                                    row.get::<_, String>(0)?,
                                    row.get::<_, Option<String>>(1)?,
                                ))
                            },
                        )
                        .ok()
                }
            })
            .await
            .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;

        let content = match target_info {
            Some((path, title)) => {
                let vault_path = crate::vault::path::VaultPath::new(&path)
                    .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;
                let abs_path = self.state.vault.resolve(&vault_path);
                let preview = match tokio::fs::read_to_string(&abs_path).await {
                    Ok(content) => {
                        let body = match crate::vault::page::parse_frontmatter(&content) {
                            Ok((_meta, body)) => body,
                            Err(_) => content,
                        };
                        body.lines().take(10).collect::<Vec<_>>().join("\n")
                    }
                    Err(_) => String::new(),
                };
                let display_title = title.as_deref().unwrap_or(&path);
                format!("**{display_title}**\n`{path}`\n\n---\n\n{preview}")
            }
            None => format!("*Unresolved link:* `{}`", link.target_raw),
        };

        Ok(Some(Hover {
            contents: HoverContents::Markup(MarkupContent {
                kind: MarkupKind::Markdown,
                value: content,
            }),
            range: Some(range),
        }))
    }

    async fn completion(&self, params: CompletionParams) -> Result<Option<CompletionResponse>> {
        let uri = params.text_document_position.text_document.uri;
        let pos = params.text_document_position.position;

        let line_text = {
            let docs = self.documents.lock().await;
            let doc = match docs.get(&uri) {
                Some(d) => d,
                None => return Ok(None),
            };
            let line_idx = pos.line as usize;
            if line_idx >= doc.rope.len_lines() {
                return Ok(None);
            }
            doc.rope.line(line_idx).to_string()
        };

        let character = pos.character as usize;

        if let Some(prefix) = completion::wikilink_prefix(&line_text, character) {
            let items = self.complete_wikilinks(&prefix).await?;
            return Ok(Some(CompletionResponse::Array(items)));
        }

        if let Some(prefix) = completion::tag_prefix(&line_text, character) {
            let items = self.complete_tags(&prefix).await?;
            return Ok(Some(CompletionResponse::Array(items)));
        }

        Ok(None)
    }
}

impl LspBackend {
    /// Convert an LSP URI to a vault-relative path.
    fn uri_to_vault_path(&self, uri: &Url) -> Option<crate::vault::path::VaultPath> {
        let file_path = uri.to_file_path().ok()?;
        let rel = file_path.strip_prefix(self.state.vault.root()).ok()?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        crate::vault::path::VaultPath::new(&rel_str).ok()
    }

    /// Reload the canonical name snapshot from the index.
    async fn refresh_canonical_names(&self) {
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
    }

    /// Complete wikilink targets by prefix matching against canonical names.
    async fn complete_wikilinks(&self, prefix: &str) -> Result<Vec<CompletionItem>> {
        let prefix = prefix.to_string();
        let results: Vec<(String, String, Option<String>)> = self
            .state
            .index
            .with_index({
                let prefix = prefix.clone();
                move |index, _| {
                    let like_pattern = format!("{}%", prefix.to_lowercase());
                    let mut stmt = index
                        .connection()
                        .prepare(
                            "SELECT DISTINCT cn.canonical_name, p.path, p.title \
                             FROM canonical_names cn \
                             JOIN pages p ON p.id = cn.page_id \
                             WHERE cn.canonical_name LIKE ?1 \
                             ORDER BY cn.canonical_name LIMIT 50",
                        )
                        .unwrap();
                    stmt.query_map(rusqlite::params![like_pattern], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    })
                    .unwrap()
                    .filter_map(|r| r.ok())
                    .collect()
                }
            })
            .await
            .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;

        Ok(results
            .into_iter()
            .map(|(_canonical, path, title)| {
                let label = title.unwrap_or_else(|| {
                    path.rsplit('/')
                        .next()
                        .unwrap_or(&path)
                        .trim_end_matches(".md")
                        .to_string()
                });
                CompletionItem {
                    label: label.clone(),
                    kind: Some(CompletionItemKind::REFERENCE),
                    detail: Some(path),
                    insert_text: Some(label),
                    ..Default::default()
                }
            })
            .collect())
    }

    /// Complete tags by prefix matching against the tags table.
    async fn complete_tags(&self, prefix: &str) -> Result<Vec<CompletionItem>> {
        let prefix = prefix.to_string();
        let tags: Vec<String> = self
            .state
            .index
            .with_index({
                let prefix = prefix.clone();
                move |index, _| {
                    let like_pattern = format!("{prefix}%");
                    let mut stmt = index
                        .connection()
                        .prepare(
                            "SELECT DISTINCT tag FROM tags \
                             WHERE tag LIKE ?1 ORDER BY tag LIMIT 50",
                        )
                        .unwrap();
                    stmt.query_map(rusqlite::params![like_pattern], |row| row.get(0))
                        .unwrap()
                        .filter_map(|r| r.ok())
                        .collect()
                }
            })
            .await
            .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;

        Ok(tags
            .into_iter()
            .map(|tag| CompletionItem {
                label: tag.clone(),
                kind: Some(CompletionItemKind::KEYWORD),
                insert_text: Some(tag),
                ..Default::default()
            })
            .collect())
    }

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
