pub mod completion;
pub mod document;
pub mod symbols;

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
        self.refresh_canonical_names().await;
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

    async fn references(&self, params: ReferenceParams) -> Result<Option<Vec<Location>>> {
        let uri = params.text_document_position.text_document.uri;
        let pos = params.text_document_position.position;

        // Determine target vault path: either link target or current file
        let target_vp = {
            let link_target = {
                let docs = self.documents.lock().await;
                let doc = match docs.get(&uri) {
                    Some(d) => d,
                    None => return Ok(None),
                };
                doc.link_at_position(pos).map(|l| l.target_raw.clone())
            };

            if let Some(target_raw) = link_target {
                let canonical = crate::vault::canonical::CanonicalName::from_title(&target_raw);
                let path: Option<String> = self
                    .state
                    .index
                    .with_index({
                        let cn = canonical.as_str().to_string();
                        move |index, _| {
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

                match path {
                    Some(p) => match crate::vault::path::VaultPath::new(&p) {
                        Ok(vp) => vp,
                        Err(_) => return Ok(None),
                    },
                    None => return Ok(None),
                }
            } else {
                match self.uri_to_vault_path(&uri) {
                    Some(vp) => vp,
                    None => return Ok(None),
                }
            }
        };

        let backlinks = self
            .state
            .index
            .backlinks(target_vp, 0)
            .await
            .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;

        let vault_root = self.state.vault.root().to_path_buf();
        let mut locations = Vec::new();
        for bl in &backlinks {
            let source_vp = match crate::vault::path::VaultPath::new(&bl.source_path) {
                Ok(vp) => vp,
                Err(_) => continue,
            };
            let abs_path = vault_root.join(source_vp.as_str());
            let source_uri = match Url::from_file_path(&abs_path) {
                Ok(u) => u,
                Err(_) => continue,
            };
            let range = self.backlink_to_range(&source_uri, bl).await;
            locations.push(Location {
                uri: source_uri,
                range,
            });
        }

        if locations.is_empty() {
            Ok(None)
        } else {
            Ok(Some(locations))
        }
    }

    async fn symbol(
        &self,
        params: WorkspaceSymbolParams,
    ) -> Result<Option<Vec<SymbolInformation>>> {
        let query = params.query.trim().to_string();
        let vault_root = self.state.vault.root().to_path_buf();

        let results: Vec<(String, Option<String>)> = if query.is_empty() {
            // Empty query: return pages sorted by path
            self.state
                .index
                .with_index(
                    move |index, _| -> std::result::Result<Vec<_>, rusqlite::Error> {
                        let mut stmt = index.connection().prepare(
                            "SELECT path, title FROM pages ORDER BY path LIMIT 50",
                        )?;
                        let rows = stmt
                            .query_map([], |row| {
                                Ok((
                                    row.get::<_, String>(0)?,
                                    row.get::<_, Option<String>>(1)?,
                                ))
                            })?
                            .filter_map(|r| r.ok())
                            .collect();
                        Ok(rows)
                    },
                )
                .await
                .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?
                .unwrap_or_default()
        } else {
            // FTS5 search
            self.state
                .index
                .search(query, 50)
                .await
                .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?
                .into_iter()
                .map(|r| (r.path, r.title))
                .collect()
        };

        #[allow(deprecated)]
        let symbols: Vec<SymbolInformation> = results
            .into_iter()
            .filter_map(|(path, title)| {
                let vp = crate::vault::path::VaultPath::new(&path).ok()?;
                let abs_path = vault_root.join(vp.as_str());
                let uri = Url::from_file_path(&abs_path).ok()?;
                Some(SymbolInformation {
                    name: title.unwrap_or_else(|| {
                        path.rsplit('/')
                            .next()
                            .unwrap_or(&path)
                            .trim_end_matches(".md")
                            .to_string()
                    }),
                    kind: SymbolKind::FILE,
                    tags: None,
                    deprecated: None,
                    location: Location {
                        uri,
                        range: Range::default(),
                    },
                    container_name: Some(
                        path.rsplit_once('/')
                            .map(|(folder, _)| folder.to_string())
                            .unwrap_or_default(),
                    ),
                })
            })
            .collect();

        if symbols.is_empty() {
            Ok(None)
        } else {
            Ok(Some(symbols))
        }
    }

    async fn code_lens(&self, params: CodeLensParams) -> Result<Option<Vec<CodeLens>>> {
        let uri = params.text_document.uri;
        let vault_path = match self.uri_to_vault_path(&uri) {
            Some(vp) => vp,
            None => return Ok(None),
        };

        Ok(Some(vec![CodeLens {
            range: Range {
                start: Position {
                    line: 0,
                    character: 0,
                },
                end: Position {
                    line: 0,
                    character: 0,
                },
            },
            command: None,
            data: serde_json::to_value(vault_path.as_str()).ok(),
        }]))
    }

    async fn code_lens_resolve(&self, lens: CodeLens) -> Result<CodeLens> {
        let vault_path_str = lens
            .data
            .as_ref()
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let count = if let Ok(vp) = crate::vault::path::VaultPath::new(vault_path_str) {
            self.state
                .index
                .backlinks(vp, 0)
                .await
                .map(|bl| bl.len())
                .unwrap_or(0)
        } else {
            0
        };

        let title = if count == 1 {
            "1 reference".to_string()
        } else {
            format!("{count} references")
        };

        Ok(CodeLens {
            range: lens.range,
            command: Some(Command {
                title,
                command: "clepsydra.findReferences".to_string(),
                arguments: lens.data.map(|d| vec![d]),
            }),
            data: None,
        })
    }

    async fn document_symbol(
        &self,
        params: DocumentSymbolParams,
    ) -> Result<Option<DocumentSymbolResponse>> {
        let uri = params.text_document.uri;

        let docs = self.documents.lock().await;
        let doc = match docs.get(&uri) {
            Some(d) => d,
            None => return Ok(None),
        };

        let title = doc
            .meta
            .title
            .as_deref()
            .unwrap_or_else(|| {
                uri.path_segments()
                    .and_then(|mut s| s.next_back())
                    .unwrap_or("untitled")
            })
            .to_string();

        let syms = symbols::build_document_symbols(&title, &doc.body, |offset| {
            doc.byte_offset_to_position(offset)
        });

        Ok(Some(DocumentSymbolResponse::Nested(syms)))
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
        let result = self
            .state
            .index
            .with_index(|index, _| -> std::result::Result<HashSet<String>, rusqlite::Error> {
                let mut stmt = index
                    .connection()
                    .prepare("SELECT canonical_name FROM canonical_names")?;
                let names = stmt
                    .query_map([], |row| row.get::<_, String>(0))?
                    .filter_map(|r| r.ok())
                    .collect();
                Ok(names)
            })
            .await;

        match result {
            Ok(Ok(names)) => *self.canonical_names.write().await = names,
            Ok(Err(e)) => tracing::error!("failed to load canonical names: {e}"),
            Err(e) => tracing::error!("index thread error loading canonical names: {e}"),
        }
    }

    /// Complete wikilink targets by prefix matching against canonical names.
    async fn complete_wikilinks(&self, prefix: &str) -> Result<Vec<CompletionItem>> {
        let prefix = prefix.to_string();
        let results: Vec<(String, String, Option<String>)> = self
            .state
            .index
            .with_index({
                let prefix = prefix.clone();
                move |index, _| -> std::result::Result<Vec<_>, rusqlite::Error> {
                    let like_pattern = format!("{}%", prefix.to_lowercase());
                    let mut stmt = index.connection().prepare(
                        "SELECT DISTINCT cn.canonical_name, p.path, p.title \
                         FROM canonical_names cn \
                         JOIN pages p ON p.id = cn.page_id \
                         WHERE cn.canonical_name LIKE ?1 \
                         ORDER BY cn.canonical_name LIMIT 50",
                    )?;
                    let rows = stmt
                        .query_map(rusqlite::params![like_pattern], |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, Option<String>>(2)?,
                            ))
                        })?
                        .filter_map(|r| r.ok())
                        .collect();
                    Ok(rows)
                }
            })
            .await
            .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?
            .unwrap_or_default();

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
                move |index, _| -> std::result::Result<Vec<String>, rusqlite::Error> {
                    let like_pattern = format!("{prefix}%");
                    let mut stmt = index.connection().prepare(
                        "SELECT DISTINCT tag FROM tags \
                         WHERE tag LIKE ?1 ORDER BY tag LIMIT 50",
                    )?;
                    let rows = stmt
                        .query_map(rusqlite::params![like_pattern], |row| row.get(0))?
                        .filter_map(|r| r.ok())
                        .collect();
                    Ok(rows)
                }
            })
            .await
            .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?
            .unwrap_or_default();

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

    /// Resolve a backlink to a source range.
    ///
    /// First checks if the source file is open in the editor (using the
    /// in-memory document). Falls back to reading the file from disk and
    /// building a throwaway `Document` to find the link span.
    async fn backlink_to_range(
        &self,
        source_uri: &Url,
        bl: &crate::vault::index::BacklinkWithContext,
    ) -> Range {
        // Check if source is open in editor
        {
            let docs = self.documents.lock().await;
            if let Some(doc) = docs.get(source_uri) {
                for link in &doc.links {
                    if link.target_raw == bl.target_raw
                        && link.span.start != 0
                        && link.span.end != 0
                    {
                        return doc.link_to_range(link);
                    }
                }
            }
        }
        // Fall back: read from disk, build throwaway Document
        if let Some(vp) = self.uri_to_vault_path(source_uri) {
            let abs_path = self.state.vault.resolve(&vp);
            if let Ok(content) = tokio::fs::read_to_string(&abs_path).await {
                let doc = document::Document::from_text(&content, 0);
                for link in &doc.links {
                    if link.target_raw == bl.target_raw
                        && link.span.start != 0
                        && link.span.end != 0
                    {
                        return doc.link_to_range(link);
                    }
                }
            }
        }
        Range::default()
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
