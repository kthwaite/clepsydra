pub mod code_action;
pub mod completion;
pub mod diagnostics;
pub mod document;
pub mod hover;
pub mod queries;
pub mod references;
pub mod rename;
pub mod symbols;

#[cfg(test)]
pub(crate) mod test_support;

use std::collections::HashMap;
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
    /// Cached snapshot of canonical names → page paths for diagnostic checks.
    pub canonical_names: Arc<RwLock<HashMap<String, Vec<String>>>>,
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
        let target_path =
            crate::lsp::queries::canonical_to_vault_path(&self.state.index, canonical.as_str())
                .await;

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
        let path =
            crate::lsp::queries::canonical_to_vault_path(&self.state.index, canonical.as_str())
                .await;

        let content = match path {
            Some(path) => {
                let vault_path = crate::vault::path::VaultPath::new(&path)
                    .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;
                let abs_path = self.state.vault.resolve(&vault_path);
                let (title, preview) = match tokio::fs::read_to_string(&abs_path).await {
                    Ok(file_content) => {
                        let (title, body) =
                            match crate::vault::page::parse_frontmatter(&file_content) {
                                Ok((meta, body)) => (meta.title, body),
                                Err(_) => (None, file_content),
                            };
                        let preview = crate::lsp::hover::extract_preview(&body, 10);
                        (title, preview)
                    }
                    Err(_) => (None, String::new()),
                };
                crate::lsp::hover::format_hover_resolved(&path, title.as_deref(), &preview)
            }
            None => crate::lsp::hover::format_hover_unresolved(&link.target_raw),
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

    async fn prepare_rename(
        &self,
        params: TextDocumentPositionParams,
    ) -> Result<Option<PrepareRenameResponse>> {
        let uri = params.text_document.uri;
        let pos = params.position;

        let docs = self.documents.lock().await;
        let doc = match docs.get(&uri) {
            Some(d) => d,
            None => return Ok(None),
        };

        // Case 1: Cursor on a wikilink
        if let Some(link) = doc.link_at_position(pos)
            && link.kind == crate::vault::link::LinkKind::Wiki
        {
            let range = doc.link_to_range(link);
            return Ok(Some(PrepareRenameResponse::RangeWithPlaceholder {
                range,
                placeholder: link.target_raw.clone(),
            }));
        }

        // Case 2: Cursor in frontmatter on the title line
        if doc.position_to_body_byte_offset(pos).is_none() {
            // Cursor is in frontmatter region
            let line_idx = pos.line as usize;
            if line_idx < doc.rope.len_lines() {
                let line_text = doc.rope.line(line_idx).to_string();
                let trimmed = line_text.trim_start();
                if let Some(rest) = trimmed.strip_prefix("title:") {
                    let value = rest.trim();
                    // Strip surrounding quotes if present
                    let title_value = if (value.starts_with('"') && value.ends_with('"'))
                        || (value.starts_with('\'') && value.ends_with('\''))
                    {
                        &value[1..value.len() - 1]
                    } else {
                        value.trim_end_matches('\n')
                    };

                    // Compute the range of the title value on this line.
                    let value_start_in_line = if (value.starts_with('"') && value.ends_with('"'))
                        || (value.starts_with('\'') && value.ends_with('\''))
                    {
                        // Position after the opening quote
                        line_text.find(value).unwrap_or(0) + 1
                    } else {
                        // Position at start of the trimmed value
                        line_text.find(value).unwrap_or(0)
                    };
                    let value_end_in_line = value_start_in_line + title_value.len();

                    let range = Range {
                        start: Position {
                            line: pos.line,
                            character: value_start_in_line as u32,
                        },
                        end: Position {
                            line: pos.line,
                            character: value_end_in_line as u32,
                        },
                    };

                    return Ok(Some(PrepareRenameResponse::RangeWithPlaceholder {
                        range,
                        placeholder: title_value.to_string(),
                    }));
                }
            }
        }

        Ok(None)
    }

    async fn rename(&self, params: RenameParams) -> Result<Option<WorkspaceEdit>> {
        let uri = params.text_document_position.text_document.uri;
        let pos = params.text_document_position.position;
        let new_name = params.new_name;

        // ---------------------------------------------------------------
        // 1. Determine what is being renamed and resolve old vault path
        // ---------------------------------------------------------------
        let (old_vp, _current_title) = {
            let docs = self.documents.lock().await;
            let doc = match docs.get(&uri) {
                Some(d) => d,
                None => return Ok(None),
            };

            // Case A: cursor on a wikilink
            if let Some(link) = doc.link_at_position(pos) {
                if link.kind == crate::vault::link::LinkKind::Wiki {
                    let target_raw = link.target_raw.clone();
                    drop(docs);

                    // Resolve target_raw to a VaultPath via canonical name lookup
                    let canonical =
                        crate::vault::canonical::CanonicalName::from_title(&target_raw);
                    let target_path: Option<String> = self
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

                    match target_path {
                        Some(p) => {
                            let vp = crate::vault::path::VaultPath::new(&p)
                                .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;
                            (vp, target_raw)
                        }
                        None => return Ok(None),
                    }
                } else {
                    return Ok(None);
                }
            }
            // Case B: cursor in frontmatter (rename current page)
            else if doc.position_to_body_byte_offset(pos).is_none() {
                let title = doc.meta.title.clone().unwrap_or_default();
                drop(docs);

                match self.uri_to_vault_path(&uri) {
                    Some(vp) => (vp, title),
                    None => return Ok(None),
                }
            } else {
                return Ok(None);
            }
        };

        // ---------------------------------------------------------------
        // 2. Compute new VaultPath
        // ---------------------------------------------------------------
        let new_filename_vp = crate::vault::path::VaultPath::from_title(&new_name);
        let new_vp_str = match old_vp.parent() {
            Some(parent) => format!("{}/{}", parent, new_filename_vp.as_str()),
            None => new_filename_vp.as_str().to_string(),
        };
        let new_vp = crate::vault::path::VaultPath::new(&new_vp_str)
            .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;

        // ---------------------------------------------------------------
        // 3. Check for conflicts
        // ---------------------------------------------------------------
        if new_vp.as_str() != old_vp.as_str() {
            let new_abs = self.state.vault.resolve(&new_vp);
            if new_abs.exists() {
                return Err(tower_lsp::jsonrpc::Error::new(
                    tower_lsp::jsonrpc::ErrorCode::InvalidParams,
                ));
            }
        }

        // ---------------------------------------------------------------
        // 4. Get all canonical names for the old page
        // ---------------------------------------------------------------
        let old_canonical_names: Vec<String> = self
            .state
            .index
            .with_index({
                let old_path = old_vp.as_str().to_string();
                move |index, _| -> std::result::Result<Vec<String>, rusqlite::Error> {
                    let page_id: String = index.connection().query_row(
                        "SELECT id FROM pages WHERE path = ?1",
                        rusqlite::params![old_path],
                        |row| row.get(0),
                    )?;
                    let mut stmt = index
                        .connection()
                        .prepare("SELECT canonical_name FROM canonical_names WHERE page_id = ?1")?;
                    let names = stmt
                        .query_map(rusqlite::params![page_id], |row| row.get(0))?
                        .filter_map(|r| r.ok())
                        .collect();
                    Ok(names)
                }
            })
            .await
            .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?
            .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;

        if old_canonical_names.is_empty() {
            return Ok(None);
        }

        // ---------------------------------------------------------------
        // 5. Find all referring pages via index
        // ---------------------------------------------------------------
        let referring_paths: Vec<String> = self
            .state
            .index
            .with_index({
                let old_path = old_vp.as_str().to_string();
                let cn_list = old_canonical_names.clone();
                move |index, _| -> std::result::Result<Vec<String>, rusqlite::Error> {
                    let page_id: Option<String> = index
                        .connection()
                        .query_row(
                            "SELECT id FROM pages WHERE path = ?1",
                            rusqlite::params![old_path],
                            |row| row.get(0),
                        )
                        .ok();

                    let mut source_paths =
                        std::collections::HashSet::<String>::new();

                    if let Some(ref pid) = page_id {
                        // Resolved links targeting this page
                        let mut stmt = index.connection().prepare(
                            "SELECT DISTINCT p.path FROM links l \
                             JOIN pages p ON l.source_id = p.id \
                             WHERE l.target_id = ?1",
                        )?;
                        let paths: Vec<String> = stmt
                            .query_map(rusqlite::params![pid], |row| row.get(0))?
                            .filter_map(|r| r.ok())
                            .collect();
                        source_paths.extend(paths);
                    }

                    // Unresolved links matching canonical names
                    for cn in &cn_list {
                        let mut stmt = index.connection().prepare(
                            "SELECT DISTINCT p.path FROM links l \
                             JOIN pages p ON l.source_id = p.id \
                             WHERE l.target_canonical = ?1 AND l.target_id IS NULL",
                        )?;
                        let paths: Vec<String> = stmt
                            .query_map(rusqlite::params![cn], |row| row.get(0))?
                            .filter_map(|r| r.ok())
                            .collect();
                        source_paths.extend(paths);
                    }

                    // Remove self
                    if let Some(ref pid) = page_id {
                        let self_path: Option<String> = index
                            .connection()
                            .query_row(
                                "SELECT path FROM pages WHERE id = ?1",
                                rusqlite::params![pid],
                                |row| row.get(0),
                            )
                            .ok();
                        if let Some(sp) = self_path {
                            source_paths.remove(&sp);
                        }
                    }

                    Ok(source_paths.into_iter().collect())
                }
            })
            .await
            .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?
            .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;

        // ---------------------------------------------------------------
        // 6. Build DocumentChanges::Operations
        // ---------------------------------------------------------------
        let mut ops: Vec<DocumentChangeOperation> = Vec::new();

        // 6a. TextDocumentEdit on the target page — update frontmatter title
        // (Must come BEFORE RenameFile so the edit targets a URI that still exists.)
        let old_abs = self.state.vault.resolve(&old_vp);
        let old_uri = Url::from_file_path(&old_abs)
            .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;

        let target_content = {
            let docs = self.documents.lock().await;
            docs.get(&old_uri)
                .map(|doc| (doc.version, doc.rope.to_string()))
        };

        let (target_version, target_text) = match target_content {
            Some((v, t)) => (Some(v), t),
            None => match tokio::fs::read_to_string(&old_abs).await {
                Ok(t) => (None, t),
                Err(_) => return Ok(None),
            },
        };

        {
            let new_text = rename::update_frontmatter_title(&target_text, &new_name);
            let full_range = {
                let line_count = target_text.lines().count();
                let last_line = target_text.lines().last().unwrap_or("");
                Range {
                    start: Position {
                        line: 0,
                        character: 0,
                    },
                    end: Position {
                        line: line_count.saturating_sub(1) as u32,
                        character: last_line.len() as u32,
                    },
                }
            };

            let edit = TextDocumentEdit {
                text_document: OptionalVersionedTextDocumentIdentifier {
                    uri: old_uri.clone(),
                    version: target_version,
                },
                edits: vec![OneOf::Left(TextEdit {
                    range: full_range,
                    new_text,
                })],
            };
            ops.push(DocumentChangeOperation::Edit(edit));
        }

        // 6b. File rename operation (if path changes)
        if new_vp.as_str() != old_vp.as_str() {
            let new_abs = self.state.vault.resolve(&new_vp);
            let new_uri = Url::from_file_path(&new_abs)
                .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;
            ops.push(DocumentChangeOperation::Op(ResourceOp::Rename(
                RenameFile {
                    old_uri: old_uri.clone(),
                    new_uri,
                    options: None,
                    annotation_id: None,
                },
            )));
        }

        // 6c. TextDocumentEdit on each referring page — rewrite wikilinks
        for ref_path_str in &referring_paths {
            let ref_vp = match crate::vault::path::VaultPath::new(ref_path_str) {
                Ok(vp) => vp,
                Err(_) => continue,
            };
            let ref_abs = self.state.vault.resolve(&ref_vp);
            let ref_uri = match Url::from_file_path(&ref_abs) {
                Ok(u) => u,
                Err(_) => continue,
            };

            // Get the document content and version
            let (ref_version, ref_text) = {
                let docs = self.documents.lock().await;
                if let Some(doc) = docs.get(&ref_uri) {
                    (Some(doc.version), doc.rope.to_string())
                } else {
                    drop(docs);
                    match tokio::fs::read_to_string(&ref_abs).await {
                        Ok(t) => (None, t),
                        Err(_) => continue,
                    }
                }
            };

            // Build a throwaway Document to find links
            let ref_doc = document::Document::from_text(&ref_text, 0);

            let mut text_edits: Vec<OneOf<TextEdit, AnnotatedTextEdit>> = Vec::new();
            for link in &ref_doc.links {
                // Skip property ref links (span 0..0)
                if link.span.start == 0 && link.span.end == 0 {
                    continue;
                }
                if link.kind != crate::vault::link::LinkKind::Wiki {
                    continue;
                }
                if !rename::link_matches_target(&link.target_raw, &old_canonical_names) {
                    continue;
                }

                let raw_span_text = &ref_doc.body[link.span.clone()];
                let new_link_text = rename::rewrite_wikilink(raw_span_text, &new_name);
                let range = ref_doc.link_to_range(link);

                text_edits.push(OneOf::Left(TextEdit {
                    range,
                    new_text: new_link_text,
                }));
            }

            if !text_edits.is_empty() {
                let edit = TextDocumentEdit {
                    text_document: OptionalVersionedTextDocumentIdentifier {
                        uri: ref_uri,
                        version: ref_version,
                    },
                    edits: text_edits,
                };
                ops.push(DocumentChangeOperation::Edit(edit));
            }
        }

        if ops.is_empty() {
            return Ok(None);
        }

        Ok(Some(WorkspaceEdit {
            changes: None,
            document_changes: Some(DocumentChanges::Operations(ops)),
            change_annotations: None,
        }))
    }

    async fn code_action(&self, params: CodeActionParams) -> Result<Option<CodeActionResponse>> {
        let uri = params.text_document.uri;
        let mut actions: Vec<CodeActionOrCommand> = Vec::new();

        // Extract link data and body text in a single lock scope, then drop
        // the lock before acquiring canonical_names in the diagnostic loop.
        let (link_data, body_text) = {
            let docs = self.documents.lock().await;
            let doc = match docs.get(&uri) {
                Some(d) => d,
                None => return Ok(None),
            };
            let links: Vec<(crate::vault::link::Link, Range)> = doc
                .links
                .iter()
                .filter(|l| {
                    l.kind == crate::vault::link::LinkKind::Wiki
                        && !(l.span.start == 0 && l.span.end == 0)
                })
                .map(|l| (l.clone(), doc.link_to_range(l)))
                .collect();
            (links, doc.body.clone())
        };

        for diag in &params.context.diagnostics {
            let code = match &diag.code {
                Some(NumberOrString::String(s)) => s.as_str(),
                _ => continue,
            };

            // Find the link matching this diagnostic range
            let link = match link_data.iter().find(|(_, range)| *range == diag.range) {
                Some((l, _)) => l,
                None => continue,
            };

            match code {
                "unresolved-link" => {
                    let target = &link.target_raw;
                    let new_vp = crate::vault::path::VaultPath::from_title(target);
                    let new_abs = self.state.vault.resolve(&new_vp);
                    let new_uri = match Url::from_file_path(&new_abs) {
                        Ok(u) => u,
                        Err(_) => continue,
                    };

                    // Build frontmatter scaffold
                    let mut meta = crate::vault::page::PageMeta::new();
                    meta.title = Some(target.to_string());
                    let content = crate::vault::page::write_page_content(&meta, "\n");

                    let ops = vec![
                        DocumentChangeOperation::Op(ResourceOp::Create(
                            CreateFile {
                                uri: new_uri.clone(),
                                options: Some(CreateFileOptions {
                                    overwrite: Some(false),
                                    ignore_if_exists: Some(false),
                                }),
                                annotation_id: None,
                            },
                        )),
                        DocumentChangeOperation::Edit(TextDocumentEdit {
                            text_document: OptionalVersionedTextDocumentIdentifier {
                                uri: new_uri,
                                version: None,
                            },
                            edits: vec![OneOf::Left(TextEdit {
                                range: Range::default(),
                                new_text: content,
                            })],
                        }),
                    ];

                    actions.push(CodeActionOrCommand::CodeAction(CodeAction {
                        title: format!("Create page: {target}"),
                        kind: Some(CodeActionKind::QUICKFIX),
                        diagnostics: Some(vec![diag.clone()]),
                        edit: Some(WorkspaceEdit {
                            changes: None,
                            document_changes: Some(DocumentChanges::Operations(ops)),
                            change_annotations: None,
                        }),
                        is_preferred: Some(true),
                        ..Default::default()
                    }));
                }
                "ambiguous-link" => {
                    let canonical =
                        crate::vault::canonical::CanonicalName::from_title(&link.target_raw);
                    let names = self.canonical_names.read().await;

                    if let Some(candidate_paths) = names.get(canonical.as_str())
                        && candidate_paths.len() > 1
                    {
                        for path in candidate_paths {
                            // Use the full path stem (path minus .md) as the
                            // wikilink target. This is always indexed as a
                            // canonical name, unlike shorter suffixes which
                            // may not have corresponding index entries.
                            let path_stem =
                                path.strip_suffix(".md").unwrap_or(path);

                            // Read raw wikilink text to preserve display text
                            let raw_text = if link.span.end <= body_text.len() {
                                &body_text[link.span.clone()]
                            } else {
                                continue;
                            };
                            let new_text =
                                rename::rewrite_wikilink(raw_text, path_stem);

                            let edit = TextEdit {
                                range: diag.range,
                                new_text,
                            };

                            let title_display =
                                path.strip_suffix(".md").unwrap_or(path);

                            actions.push(CodeActionOrCommand::CodeAction(
                                CodeAction {
                                    title: format!(
                                        "Resolve to: {title_display}"
                                    ),
                                    kind: Some(CodeActionKind::QUICKFIX),
                                    diagnostics: Some(vec![diag.clone()]),
                                    edit: Some(WorkspaceEdit {
                                        changes: Some(
                                            [(uri.clone(), vec![edit])]
                                                .into_iter()
                                                .collect(),
                                        ),
                                        document_changes: None,
                                        change_annotations: None,
                                    }),
                                    ..Default::default()
                                },
                            ));
                        }
                    }
                }
                _ => {}
            }
        }

        if actions.is_empty() {
            Ok(None)
        } else {
            Ok(Some(actions))
        }
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
    pub(crate) fn uri_to_vault_path(&self, uri: &Url) -> Option<crate::vault::path::VaultPath> {
        let file_path = uri.to_file_path().ok()?;
        let rel = file_path.strip_prefix(self.state.vault.root()).ok()?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        crate::vault::path::VaultPath::new(&rel_str).ok()
    }

    /// Reload the canonical name snapshot from the index.
    ///
    /// Builds a map from canonical name to all page paths that share it,
    /// enabling both unresolved-link and ambiguous-link diagnostics.
    pub(crate) async fn refresh_canonical_names(&self) {
        let result = self
            .state
            .index
            .with_index(
                |index, _| -> std::result::Result<HashMap<String, Vec<String>>, rusqlite::Error> {
                    let mut stmt = index.connection().prepare(
                        "SELECT cn.canonical_name, p.path \
                         FROM canonical_names cn \
                         JOIN pages p ON p.id = cn.page_id \
                         ORDER BY cn.canonical_name",
                    )?;
                    let mut map: HashMap<String, Vec<String>> = HashMap::new();
                    let rows = stmt.query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?;
                    for row in rows.flatten() {
                        map.entry(row.0).or_default().push(row.1);
                    }
                    Ok(map)
                },
            )
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

    /// Resolve a backlink to a source range using its indexed span offsets.
    ///
    /// Uses the span_start/span_end from the backlink record directly,
    /// converting body byte offsets to LSP positions via the open document
    /// or a throwaway Document built from disk.
    async fn backlink_to_range(
        &self,
        source_uri: &Url,
        bl: &crate::vault::index::BacklinkWithContext,
    ) -> Range {
        // Property refs or invalid spans: return default range
        if bl.span_start < 0 || bl.span_end < 0 {
            return Range::default();
        }
        let start = bl.span_start as usize;
        let end = bl.span_end as usize;

        // Check if source is open in editor
        {
            let docs = self.documents.lock().await;
            if let Some(doc) = docs.get(source_uri) {
                return Range {
                    start: doc.byte_offset_to_position(start),
                    end: doc.byte_offset_to_position(end),
                };
            }
        }
        // Fall back: read from disk, build throwaway Document
        if let Some(vp) = self.uri_to_vault_path(source_uri) {
            let abs_path = self.state.vault.resolve(&vp);
            if let Ok(content) = tokio::fs::read_to_string(&abs_path).await {
                let doc = document::Document::from_text(&content, 0);
                return Range {
                    start: doc.byte_offset_to_position(start),
                    end: doc.byte_offset_to_position(end),
                };
            }
        }
        Range::default()
    }

    /// Publish diagnostics for a single open document.
    ///
    /// Checks each extracted link against the cached canonical name snapshot.
    /// Reports unresolved links (no match) as warnings and ambiguous links
    /// (multiple matches) as informational diagnostics with related locations.
    async fn publish_diagnostics_for(&self, uri: &Url, doc: &document::Document) {
        let names = self.canonical_names.read().await;
        let diagnostics =
            crate::lsp::diagnostics::compute_link_diagnostics(doc, &names, self.state.vault.root());
        drop(names);
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
        canonical_names: Arc::new(RwLock::new(HashMap::new())),
    });

    Server::new(stdin, stdout, socket).serve(service).await;
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use tower_lsp::lsp_types::*;
    use tower_lsp::LanguageServer;

    #[tokio::test]
    async fn backend_constructs_and_opens_a_document() {
        let (backend, _tmp) = make_backend(&[("Note.md", "# Note\n\nbody\n")]);
        let uri = uri_for(&backend, "Note.md");
        open_doc(&backend, &uri, "# Note\n\nbody\n").await;
        let docs = backend.documents.lock().await;
        assert!(docs.contains_key(&uri));
    }

    #[tokio::test]
    async fn goto_definition_resolves_wikilink() {
        let (backend, _tmp) = make_backend(&[
            ("Source.md", "# Source\n\nsee [[Target]]\n"),
            ("Target.md", "# Target\n"),
        ]);
        let uri = uri_for(&backend, "Source.md");
        open_doc(&backend, &uri, "# Source\n\nsee [[Target]]\n").await;
        let params = GotoDefinitionParams {
            text_document_position_params: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position { line: 2, character: 8 },
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };
        let resp = backend.goto_definition(params).await.unwrap();
        let Some(GotoDefinitionResponse::Scalar(loc)) = resp else {
            panic!("expected a scalar location, got {resp:?}");
        };
        assert!(loc.uri.path().ends_with("Target.md"));
    }

    #[tokio::test]
    async fn completion_suggests_wikilink_targets() {
        let (backend, _tmp) = make_backend(&[
            ("Src.md", "# Src\n\n[[Tar\n"),
            ("Target.md", "# Target\n"),
        ]);
        let uri = uri_for(&backend, "Src.md");
        open_doc(&backend, &uri, "# Src\n\n[[Tar\n").await;
        let params = CompletionParams {
            text_document_position: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position { line: 2, character: 5 },
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
            context: None,
        };
        let resp = backend.completion(params).await.unwrap();
        let items = match resp {
            Some(CompletionResponse::Array(v)) => v,
            Some(CompletionResponse::List(l)) => l.items,
            None => panic!("expected completions"),
        };
        assert!(items.iter().any(|i| i.label.contains("Target")));
    }

    #[tokio::test]
    async fn completion_returns_none_off_a_prefix() {
        let (backend, _tmp) = make_backend(&[("Src.md", "# Src\n\nplain text\n")]);
        let uri = uri_for(&backend, "Src.md");
        open_doc(&backend, &uri, "# Src\n\nplain text\n").await;
        let params = CompletionParams {
            text_document_position: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position { line: 2, character: 3 },
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
            context: None,
        };
        assert!(backend.completion(params).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn hover_renders_resolved_target_title() {
        let (backend, _tmp) = make_backend(&[
            ("Src.md", "# Src\n\n[[Target]]\n"),
            ("Target.md", "---\ntitle: Target Page\n---\nhello world\n"),
        ]);
        let uri = uri_for(&backend, "Src.md");
        open_doc(&backend, &uri, "# Src\n\n[[Target]]\n").await;
        let params = HoverParams {
            text_document_position_params: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position { line: 2, character: 4 },
            },
            work_done_progress_params: Default::default(),
        };
        let hover = backend.hover(params).await.unwrap().expect("hover present");
        let HoverContents::Markup(MarkupContent { value, .. }) = hover.contents else {
            panic!("expected markup hover");
        };
        assert!(value.contains("Target Page"));
    }

    #[tokio::test]
    async fn did_save_reindexes_and_clears_dirty() {
        let (backend, _tmp) = make_backend(&[("Note.md", "# Note\n\n[[Note]]\n")]);
        let uri = uri_for(&backend, "Note.md");
        open_doc(&backend, &uri, "# Note\n\n[[Note]]\n").await;
        // mark dirty to verify did_save clears it
        {
            let mut docs = backend.documents.lock().await;
            if let Some(d) = docs.get_mut(&uri) {
                d.dirty = true;
            }
        }
        let params = DidSaveTextDocumentParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            text: None,
        };
        backend.did_save(params).await; // drives index_page + resolve_links + republish
        let docs = backend.documents.lock().await;
        assert!(!docs.get(&uri).unwrap().dirty);
    }
}
