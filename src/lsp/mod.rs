pub mod code_action;
pub mod completion;
pub mod diagnostics;
pub mod document;
pub mod hover;
pub mod queries;
pub mod references;
pub mod rename;
pub mod state;
pub mod symbols;

#[cfg(test)]
pub(crate) mod test_support;

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, RwLock};
use tower_lsp::jsonrpc::Result;
use tower_lsp::lsp_types::*;
use tower_lsp::{Client, LanguageServer, LspService, Server};

use crate::vault::path::VaultPath;
use crate::vault::sync::ChangeEvent;

/// LSP backend holding the per-document data and late-initialized vault state.
///
/// `vault_state` is empty until `initialize` resolves the workspace root and
/// opens a read-only vault + in-memory index (see `state::open_lsp_state`).
/// The LSP process never writes vault files (ADR 0001).
pub struct LspBackend {
    /// The tower-lsp client handle for sending notifications/requests to the editor.
    pub client: Client,
    /// Vault + index, opened during `initialize` once the workspace root is known.
    pub vault_state: tokio::sync::OnceCell<Arc<state::LspState>>,
    /// Open documents keyed by URI. `Arc`-wrapped so the spawned watcher task
    /// (see `spawn_vault_watcher`) can share ownership with the backend.
    pub documents: Arc<Mutex<HashMap<Url, document::Document>>>,
    /// Cached snapshot of canonical names → page paths for diagnostic checks.
    pub canonical_names: Arc<RwLock<HashMap<String, Vec<String>>>>,
    /// The debounced filesystem watcher keeping the read-only index fresh
    /// (`spawn_vault_watcher`, started from `initialized`). `None` before
    /// `initialized` runs and in tests that don't exercise the watcher.
    pub watcher: std::sync::Mutex<Option<crate::vault::sync::watcher::VaultWatcher>>,
}

impl LspBackend {
    /// State accessor for request handlers (jsonrpc error before initialize).
    fn state(&self) -> tower_lsp::jsonrpc::Result<Arc<state::LspState>> {
        self.vault_state.get().cloned().ok_or_else(|| {
            let mut e = tower_lsp::jsonrpc::Error::internal_error();
            e.message = "clepsydra: vault not initialized".to_string().into();
            e
        })
    }
    /// State accessor for notification handlers (silently skip before initialize).
    fn state_opt(&self) -> Option<Arc<state::LspState>> {
        self.vault_state.get().cloned()
    }
}

#[tower_lsp::async_trait]
impl LanguageServer for LspBackend {
    async fn initialize(&self, params: InitializeParams) -> Result<InitializeResult> {
        let cwd = std::env::current_dir().map_err(|e| {
            let mut err = tower_lsp::jsonrpc::Error::internal_error();
            err.message = format!("clepsydra: cannot read cwd: {e}").into();
            err
        })?;
        let root = state::resolve_lsp_root(&params, &cwd).map_err(|msg| {
            let mut err = tower_lsp::jsonrpc::Error::internal_error();
            err.message = format!("clepsydra: {msg}").into();
            err
        })?;
        let opened = tokio::task::spawn_blocking(move || state::open_lsp_state(&root))
            .await
            .map_err(|e| {
                let mut err = tower_lsp::jsonrpc::Error::internal_error();
                err.message = format!("clepsydra: vault open task failed: {e}").into();
                err
            })?
            .map_err(|e| {
                let mut err = tower_lsp::jsonrpc::Error::internal_error();
                err.message = format!("clepsydra: cannot open vault: {e}").into();
                err
            })?;
        let _ = self.vault_state.set(Arc::new(opened));
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
                    trigger_characters: Some(vec![
                        "[".to_string(),
                        "#".to_string(),
                        "(".to_string(),
                    ]),
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
        if let Some(state) = self.state_opt() {
            match self.spawn_vault_watcher(Arc::clone(&state)) {
                Ok(w) => *self.watcher.lock().unwrap() = Some(w),
                Err(e) => tracing::warn!("lsp watcher failed to start: {e}"),
            }
        }
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
        let Some(state) = self.state_opt() else {
            return;
        };

        // Flush index update for this file
        let vault_path = match self.uri_to_vault_path(&uri) {
            Some(vp) => vp,
            None => return,
        };

        if let Err(e) = state.index.index_page(vault_path.clone()).await {
            tracing::error!("index flush on save failed: {e}");
            return;
        }
        let path = vault_path.as_str().to_string();
        if let Err(e) = state.index.resolve_links_for_page(vault_path).await {
            tracing::error!("link resolution on save failed: {e}");
        }

        // Reindex without reconciling folder placement: the standalone LSP is
        // read-only (ADR 0001) — `clep serve`'s watcher owns healing folder
        // drift (a page whose declared kind/project no longer matches its
        // folder). This just keeps completion/diagnostics fresh.
        let reconcile_path = path.clone();
        match crate::vault::path::VaultPath::new(&reconcile_path) {
            Ok(vp) => {
                let _ = state
                    .index
                    .process_sync_events(vec![crate::vault::sync::ChangeEvent::Upsert(vp)])
                    .await;
            }
            Err(e) => tracing::warn!("did_save reindex failed for {reconcile_path}: {e}"),
        }

        // Mark document as clean
        {
            let mut docs = self.documents.lock().await;
            if let Some(doc) = docs.get_mut(&uri) {
                doc.dirty = false;
            }
        }

        // Refresh canonical name snapshot and re-publish diagnostics for all
        // open documents (snapshot changed). Shared with the watch-resync
        // path (`resync_from_watch_batch`) so the two flows cannot drift.
        refresh_names_and_republish(&self.client, &state, &self.documents, &self.canonical_names)
            .await;
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

        if link.kind == crate::vault::link::LinkKind::BlockRef {
            let state = self.state()?;
            let Some(hit) = crate::lsp::queries::block_by_id(&state.index, &link.target_raw).await
            else {
                return Ok(None);
            };
            let vp = crate::vault::path::VaultPath::new(&hit.path)
                .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;
            let abs_path = state.vault.resolve(&vp);
            let target_uri = Url::from_file_path(&abs_path)
                .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;
            let range = match tokio::fs::read_to_string(&abs_path).await {
                Ok(text) => document::Document::from_text(&text, 0)
                    .body_span_to_range(hit.span_start, hit.span_end),
                Err(_) => Range::default(),
            };
            return Ok(Some(GotoDefinitionResponse::Scalar(Location {
                uri: target_uri,
                range,
            })));
        }

        let state = self.state()?;
        let canonical = crate::vault::canonical::CanonicalName::from_title(&link.target_raw);
        let target_path =
            crate::lsp::queries::canonical_to_vault_path(&state.index, canonical.as_str()).await;

        let target_path = match target_path {
            Some(p) => p,
            None => return Ok(None),
        };

        let abs_path = state.vault.resolve(
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

        let state = self.state()?;

        if link.kind == crate::vault::link::LinkKind::BlockRef {
            let content = match crate::lsp::queries::block_by_id(&state.index, &link.target_raw)
                .await
            {
                Some(hit) => {
                    crate::lsp::hover::format_hover_block(&link.target_raw, &hit.path, &hit.content)
                }
                None => crate::lsp::hover::format_hover_block_unresolved(&link.target_raw),
            };
            return Ok(Some(Hover {
                contents: HoverContents::Markup(MarkupContent {
                    kind: MarkupKind::Markdown,
                    value: content,
                }),
                range: Some(range),
            }));
        }

        let canonical = crate::vault::canonical::CanonicalName::from_title(&link.target_raw);
        let path =
            crate::lsp::queries::canonical_to_vault_path(&state.index, canonical.as_str()).await;

        let content = match path {
            Some(path) => {
                let vault_path = crate::vault::path::VaultPath::new(&path)
                    .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;
                let abs_path = state.vault.resolve(&vault_path);
                let (title, preview) = match tokio::fs::read_to_string(&abs_path).await {
                    Ok(file_content) => {
                        let target = document::Document::from_text(&file_content, 0);
                        let preview = crate::lsp::hover::extract_preview(&target.body, 10);
                        (target.meta.title, preview)
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

        let (line_text, frontmatter_meta, encrypted_body_position) = {
            let docs = self.documents.lock().await;
            let doc = match docs.get(&uri) {
                Some(d) => d,
                None => return Ok(None),
            };
            let line_idx = pos.line as usize;
            if line_idx >= doc.rope.len_lines() {
                return Ok(None);
            }
            let line_text = doc.rope.line(line_idx).to_string();

            // Property intelligence keys off the `+++` TOML region: past the
            // opening fence, before the body, and not on a fence line.
            // Legacy `---` pages get none (the census-driven migration makes
            // this self-limiting).
            let is_toml = doc.rope.len_bytes() >= 3 && doc.rope.byte_slice(0..3) == "+++";
            let line_start_byte = doc.rope.line_to_byte(line_idx);
            let inside_frontmatter = is_toml
                && line_idx >= 1
                && line_start_byte < doc.body_byte_offset
                && line_text.trim_end() != "+++";
            let meta = inside_frontmatter.then(|| doc.meta.clone());
            (
                line_text,
                meta,
                doc.encrypted && line_start_byte >= doc.body_byte_offset,
            )
        };

        if encrypted_body_position {
            return Ok(None);
        }

        let character = pos.character as usize;

        // Wikilink completion works in body and frontmatter alike — relation
        // values (`series = ["[[…`) delegate to the same completer.
        if let Some(prefix) = completion::wikilink_prefix(&line_text, character) {
            let items = self.complete_wikilinks(&prefix).await?;
            return Ok(Some(CompletionResponse::Array(items)));
        }

        if let Some(prefix) = completion::block_ref_prefix(&line_text, character) {
            let items = self.complete_block_refs(&prefix).await?;
            return Ok(Some(CompletionResponse::Array(items)));
        }

        if let Some(meta) = frontmatter_meta {
            if let Some((key, prefix)) = completion::property_value_prefix(&line_text, character) {
                let items = self.complete_property_values(&key, &prefix).await?;
                if !items.is_empty() {
                    return Ok(Some(CompletionResponse::Array(items)));
                }
            }
            if let Some(prefix) = completion::property_key_prefix(&line_text, character) {
                let items = self.complete_property_keys(&prefix, &meta, &uri);
                return Ok(if items.is_empty() {
                    None
                } else {
                    Some(CompletionResponse::Array(items))
                });
            }
            return Ok(None);
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
        let state = self.state()?;

        // Determine target vault path: either link target or current file
        let link_info = {
            let docs = self.documents.lock().await;
            let doc = match docs.get(&uri) {
                Some(d) => d,
                None => return Ok(None),
            };
            if doc.encrypted {
                return Ok(None);
            }
            doc.link_at_position(pos)
                .map(|l| (l.target_raw.clone(), l.kind.clone()))
        };

        if let Some((target_raw, crate::vault::link::LinkKind::BlockRef)) = &link_info {
            let sources = crate::lsp::queries::block_ref_sources(&state.index, target_raw).await;
            let mut locations = Vec::new();
            for s in &sources {
                if let Some(loc) = self
                    .span_to_location(&s.source_path, s.span_start, s.span_end)
                    .await
                {
                    locations.push(loc);
                }
            }
            return Ok(if locations.is_empty() {
                None
            } else {
                Some(locations)
            });
        }

        let target_vp = {
            let link_target = link_info.map(|(raw, _)| raw);

            if let Some(target_raw) = link_target {
                let canonical = crate::vault::canonical::CanonicalName::from_title(&target_raw);
                let path =
                    crate::lsp::queries::canonical_to_vault_path(&state.index, canonical.as_str())
                        .await;

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

        let backlinks = state
            .index
            .backlinks(target_vp, 0)
            .await
            .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?;

        let vault_root = state.vault.root();
        let mut locations = Vec::new();
        for bl in &backlinks {
            let source_vp = match crate::vault::path::VaultPath::new(&bl.source_path) {
                Ok(vp) => vp,
                Err(_) => continue,
            };
            let source_uri = match crate::lsp::references::vault_path_to_uri(vault_root, &source_vp)
            {
                Some(uri) => uri,
                None => continue,
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
        let state = self.state()?;
        let vault_root = state.vault.root().to_path_buf();

        let results: Vec<(String, Option<String>)> = if query.is_empty() {
            // Empty query: return pages sorted by path
            state
                .index
                .with_index(
                    move |index, _| -> std::result::Result<Vec<_>, rusqlite::Error> {
                        let mut stmt = index
                            .connection()
                            .prepare("SELECT path, title FROM pages ORDER BY path LIMIT 50")?;
                        let rows = stmt
                            .query_map([], |row| {
                                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
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
            state
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
        let state = self.state()?;
        let vault_path_str = lens.data.as_ref().and_then(|v| v.as_str()).unwrap_or("");

        let count = if let Ok(vp) = crate::vault::path::VaultPath::new(vault_path_str) {
            state
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
        if doc.encrypted {
            return Ok(None);
        }

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
                if let Some(response) = rename::frontmatter_title_rename_range(&line_text, pos.line)
                {
                    return Ok(Some(response));
                }
            }
        }

        Ok(None)
    }

    async fn rename(&self, params: RenameParams) -> Result<Option<WorkspaceEdit>> {
        let uri = params.text_document_position.text_document.uri;
        let pos = params.text_document_position.position;
        let new_name = params.new_name;

        {
            let docs = self.documents.lock().await;
            if docs.get(&uri).is_some_and(|doc| doc.encrypted) {
                return Ok(None);
            }
        }

        // ---------------------------------------------------------------
        // 1. Determine what is being renamed and resolve old vault path
        // ---------------------------------------------------------------
        let old_vp = match self.resolve_rename_target(&uri, pos).await? {
            Some(vp) => vp,
            None => return Ok(None),
        };
        let state = self.state()?;

        // ---------------------------------------------------------------
        // 2. Compute new VaultPath
        // ---------------------------------------------------------------
        let new_vp = rename::compute_new_vault_path(&old_vp, &new_name)
            .ok_or_else(tower_lsp::jsonrpc::Error::internal_error)?;

        // ---------------------------------------------------------------
        // 3. Check for conflicts
        // ---------------------------------------------------------------
        if new_vp.as_str() != old_vp.as_str() {
            let new_abs = state.vault.resolve(&new_vp);
            if new_abs.exists() {
                return Err(tower_lsp::jsonrpc::Error::new(
                    tower_lsp::jsonrpc::ErrorCode::InvalidParams,
                ));
            }
        }

        // ---------------------------------------------------------------
        // 4. Get all canonical names for the old page
        // ---------------------------------------------------------------
        let old_canonical_names: Vec<String> = {
            let old_path = old_vp.as_str().to_string();
            flatten_index_result(
                state
                    .index
                    .with_index(move |index, _| {
                        rename::fetch_canonical_names_for_path(index.connection(), &old_path)
                    })
                    .await,
            )?
        };

        if old_canonical_names.is_empty() {
            return Ok(None);
        }

        // ---------------------------------------------------------------
        // 5. Find all referring pages via index
        // ---------------------------------------------------------------
        let referring_paths: Vec<String> = {
            let old_path = old_vp.as_str().to_string();
            let cn_list = old_canonical_names.clone();
            flatten_index_result(
                state
                    .index
                    .with_index(move |index, _| {
                        rename::find_referring_paths(index.connection(), &old_path, &cn_list)
                    })
                    .await,
            )?
        };

        // ---------------------------------------------------------------
        // 6. Build DocumentChanges::Operations
        // ---------------------------------------------------------------
        let mut ops: Vec<DocumentChangeOperation> = Vec::new();

        // 6a. TextDocumentEdit on the target page — update frontmatter title
        // (Must come BEFORE RenameFile so the edit targets a URI that still exists.)
        let old_abs = state.vault.resolve(&old_vp);
        let old_uri = file_uri(&old_abs)?;

        match self
            .build_rename_title_edit(&old_uri, &old_abs, &new_name)
            .await?
        {
            Some(op) => ops.push(op),
            None => return Ok(None),
        }

        // 6b. File rename operation (if path changes)
        if new_vp.as_str() != old_vp.as_str() {
            let new_abs = state.vault.resolve(&new_vp);
            let new_uri = file_uri(&new_abs)?;
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
        ops.extend(
            self.build_rename_referrer_edits(&referring_paths, &old_canonical_names, &new_name)
                .await,
        );

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
        let state = self.state()?;
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
                    if let Some(action) = code_action::build_create_page_action(
                        &link.target_raw,
                        state.vault.root(),
                        diag,
                    ) {
                        actions.push(action);
                    }
                }
                "ambiguous-link" => {
                    let canonical =
                        crate::vault::canonical::CanonicalName::from_title(&link.target_raw);
                    let names = self.canonical_names.read().await;

                    if let Some(candidate_paths) = names.get(canonical.as_str())
                        && candidate_paths.len() > 1
                    {
                        actions.extend(code_action::build_disambiguate_actions(
                            candidate_paths,
                            diag.range,
                            &body_text,
                            link.span.clone(),
                            diag,
                            &uri,
                        ));
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
        if doc.encrypted {
            return Ok(None);
        }

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

/// Flatten the doubly-nested result returned by `IndexHandle::with_index`
/// (whose closure itself returns a `Result`) into a single JSON-RPC result,
/// mapping any error to an internal error.
fn flatten_index_result<T, E1, E2>(
    r: std::result::Result<std::result::Result<T, E1>, E2>,
) -> Result<T> {
    match r {
        Ok(Ok(v)) => Ok(v),
        _ => Err(tower_lsp::jsonrpc::Error::internal_error()),
    }
}

/// Convert an absolute filesystem path to a `file://` URL, mapping failure to a
/// JSON-RPC internal error.
fn file_uri(abs: &std::path::Path) -> Result<Url> {
    Url::from_file_path(abs).map_err(|_| tower_lsp::jsonrpc::Error::internal_error())
}

impl LspBackend {
    /// Convert an LSP URI to a vault-relative path.
    ///
    /// Returns `None` before `initialize` opens the vault (no root to strip
    /// against), matching the "not part of the vault" case.
    pub(crate) fn uri_to_vault_path(&self, uri: &Url) -> Option<VaultPath> {
        let state = self.state_opt()?;
        vault_path_for_uri(&state, uri)
    }

    /// Reload the canonical name snapshot from the index.
    ///
    /// Builds a map from canonical name to all page paths that share it,
    /// enabling both unresolved-link and ambiguous-link diagnostics. A no-op
    /// before `initialize` opens the vault.
    pub(crate) async fn refresh_canonical_names(&self) {
        let Some(state) = self.state_opt() else {
            return;
        };
        refresh_canonical_names(&state, &self.canonical_names).await;
    }

    /// Start the debounced vault watcher and spawn the resync loop that
    /// consumes its batches.
    ///
    /// The returned `VaultWatcher` must be kept alive (stored on
    /// `self.watcher`) for the process lifetime — dropping it stops the
    /// underlying `notify` watch. Each drained batch is handed to
    /// `resync_from_watch_batch`, which reindexes, refreshes the canonical
    /// snapshot, republishes diagnostics, and notifies on external moves of
    /// open documents.
    fn spawn_vault_watcher(
        &self,
        state: Arc<state::LspState>,
    ) -> std::result::Result<
        crate::vault::sync::watcher::VaultWatcher,
        notify_debouncer_mini::notify::Error,
    > {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let watcher = crate::vault::sync::watcher::VaultWatcher::start(
            state.vault.root().to_path_buf(),
            std::time::Duration::from_millis(500),
            tx,
        )?;
        let client = self.client.clone();
        let documents = Arc::clone(&self.documents);
        let canonical_names = Arc::clone(&self.canonical_names);
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                let mut batch = vec![event];
                while let Ok(next) = rx.try_recv() {
                    batch.push(next);
                }
                resync_from_watch_batch(
                    client.clone(),
                    Arc::clone(&state),
                    Arc::clone(&documents),
                    Arc::clone(&canonical_names),
                    batch,
                )
                .await;
            }
        });
        Ok(watcher)
    }

    // -----------------------------------------------------------------------
    // rename sub-methods
    // -----------------------------------------------------------------------

    /// Resolve the vault path being renamed: the wikilink target under the
    /// cursor, or the current page when the cursor is in frontmatter.
    ///
    /// Returns `Ok(None)` when the cursor is not on something renamable
    /// (caller returns `Ok(None)`).
    async fn resolve_rename_target(
        &self,
        uri: &Url,
        pos: Position,
    ) -> Result<Option<crate::vault::path::VaultPath>> {
        let docs = self.documents.lock().await;
        let doc = match docs.get(uri) {
            Some(d) => d,
            None => return Ok(None),
        };

        // Case A: cursor on a wikilink
        if let Some(link) = doc.link_at_position(pos) {
            if link.kind == crate::vault::link::LinkKind::Wiki {
                let target_raw = link.target_raw.clone();
                drop(docs);

                // Resolve target_raw to a VaultPath via canonical name lookup
                let canonical = crate::vault::canonical::CanonicalName::from_title(&target_raw);
                let target_path: Option<String> = self
                    .state()?
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
                        Ok(Some(vp))
                    }
                    None => Ok(None),
                }
            } else {
                Ok(None)
            }
        }
        // Case B: cursor in frontmatter (rename current page)
        else if doc.position_to_body_byte_offset(pos).is_none() {
            drop(docs);
            match self.uri_to_vault_path(uri) {
                Some(vp) => Ok(Some(vp)),
                None => Ok(None),
            }
        } else {
            Ok(None)
        }
    }

    /// Build the frontmatter-title `TextDocumentEdit` for the page being
    /// renamed.  Returns `Ok(None)` if the page content cannot be read
    /// (caller returns `Ok(None)`).
    async fn build_rename_title_edit(
        &self,
        old_uri: &Url,
        old_abs: &std::path::Path,
        new_name: &str,
    ) -> Result<Option<DocumentChangeOperation>> {
        let target_content = {
            let docs = self.documents.lock().await;
            docs.get(old_uri)
                .map(|doc| (doc.version, doc.rope.to_string()))
        };

        let (target_version, target_text) = match target_content {
            Some((v, t)) => (Some(v), t),
            None => match tokio::fs::read_to_string(old_abs).await {
                Ok(t) => (None, t),
                Err(_) => return Ok(None),
            },
        };

        let new_text = rename::update_frontmatter_title(&target_text, new_name);
        let full_range = rename::full_document_range(&target_text);
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
        Ok(Some(DocumentChangeOperation::Edit(edit)))
    }

    /// Build the wikilink-rewrite edits for every referring page.  Pages that
    /// cannot be resolved/read, or that yield no edits, are skipped silently.
    async fn build_rename_referrer_edits(
        &self,
        referring_paths: &[String],
        old_canonical_names: &[String],
        new_name: &str,
    ) -> Vec<DocumentChangeOperation> {
        let Some(state) = self.state_opt() else {
            return Vec::new();
        };
        let mut ops: Vec<DocumentChangeOperation> = Vec::new();
        for ref_path_str in referring_paths {
            let ref_vp = match crate::vault::path::VaultPath::new(ref_path_str) {
                Ok(vp) => vp,
                Err(_) => continue,
            };
            let ref_abs = state.vault.resolve(&ref_vp);
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
            let text_edits =
                rename::build_wikilink_text_edits(&ref_doc, old_canonical_names, new_name);

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
        ops
    }

    /// Complete wikilink targets by prefix matching against canonical names.
    async fn complete_wikilinks(&self, prefix: &str) -> Result<Vec<CompletionItem>> {
        let prefix = prefix.to_string();
        let results: Vec<(String, String, Option<String>)> = self
            .state()?
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

    /// Complete block references by substring-matching block content.
    /// Newest blocks first (block IDs are time-sorted base62).
    async fn complete_block_refs(&self, prefix: &str) -> Result<Vec<CompletionItem>> {
        let prefix = prefix.to_string();
        let results: Vec<(String, String, String)> = self
            .state()?
            .index
            .with_index({
                let prefix = prefix.clone();
                move |index, _| -> std::result::Result<Vec<_>, rusqlite::Error> {
                    let mut stmt = index.connection().prepare(
                        "SELECT b.block_id, b.content, p.path \
                         FROM blocks b JOIN pages p ON p.id = b.page_id \
                         WHERE b.block_id IS NOT NULL \
                           AND b.content LIKE '%' || ?1 || '%' \
                         ORDER BY b.block_id DESC LIMIT 50",
                    )?;
                    let rows = stmt
                        .query_map(rusqlite::params![prefix], |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
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
            .map(|(block_id, content, path)| {
                let first_line = content.lines().next().unwrap_or("");
                let label: String = first_line.chars().take(60).collect();
                CompletionItem {
                    label,
                    kind: Some(CompletionItemKind::REFERENCE),
                    detail: Some(path),
                    insert_text: Some(format!("{block_id}))")),
                    ..Default::default()
                }
            })
            .collect())
    }

    /// Complete tags by prefix matching against the tags table.
    async fn complete_tags(&self, prefix: &str) -> Result<Vec<CompletionItem>> {
        let prefix = prefix.to_string();
        let tags: Vec<String> = self
            .state()?
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

    /// Complete frontmatter property keys from the base registry.
    ///
    /// Keys from bases whose filter matches the current document's parsed
    /// meta rank first; other bases' keys follow at lower sort text. The
    /// filter match is evaluated in memory — no SQL on the completion path.
    fn complete_property_keys(
        &self,
        prefix: &str,
        meta: &crate::vault::page::PageMeta,
        uri: &Url,
    ) -> Vec<CompletionItem> {
        let Some(state) = self.state_opt() else {
            return Vec::new();
        };
        let registry = crate::vault::base::BaseRegistry::load(state.vault.root());
        let path = self
            .uri_to_vault_path(uri)
            .map(|vp| vp.as_str().to_string())
            .unwrap_or_default();

        // key → (item, best rank) so a key declared by several bases appears once.
        let mut best: std::collections::HashMap<String, (CompletionItem, char)> =
            std::collections::HashMap::new();
        for base in &registry.bases {
            let rank = if crate::vault::base::base_matches_meta(base, meta, &path) {
                '0'
            } else {
                '1'
            };
            for (key, def) in &base.file.properties {
                if !key.starts_with(prefix) {
                    continue;
                }
                let replace = match best.get(key) {
                    Some((_, existing_rank)) => rank < *existing_rank,
                    None => true,
                };
                if replace {
                    let item = CompletionItem {
                        label: key.clone(),
                        kind: Some(CompletionItemKind::FIELD),
                        detail: Some(format!("{:?} — {}", def.property_type, base.file.name)),
                        insert_text: Some(format!("{key} = ")),
                        sort_text: Some(format!("{rank}{key}")),
                        ..Default::default()
                    };
                    best.insert(key.clone(), (item, rank));
                }
            }
        }
        let mut items: Vec<CompletionItem> = best.into_values().map(|(item, _)| item).collect();
        items.sort_by(|a, b| a.sort_text.cmp(&b.sort_text));
        items
    }

    /// Complete frontmatter property values: declared `select`/`multi_select`
    /// options; observed values for open vocabularies (empty options list).
    async fn complete_property_values(
        &self,
        key: &str,
        prefix: &str,
    ) -> Result<Vec<CompletionItem>> {
        use crate::vault::base::PropertyType;
        let state = self.state()?;
        let registry = crate::vault::base::BaseRegistry::load(state.vault.root());

        let mut options: Vec<String> = Vec::new();
        let mut open_vocabulary = false;
        for base in &registry.bases {
            if let Some(def) = base.property(key)
                && matches!(
                    def.property_type,
                    PropertyType::Select | PropertyType::MultiSelect
                )
            {
                if def.options.is_empty() {
                    open_vocabulary = true;
                } else {
                    options.extend(def.options.iter().cloned());
                }
            }
        }

        if options.is_empty() && open_vocabulary {
            // Open vocabulary: offer values observed anywhere in the vault.
            let key = key.to_string();
            options = state
                .index
                .with_index(
                    move |index, _| -> std::result::Result<Vec<String>, rusqlite::Error> {
                        let mut stmt = index.connection().prepare(
                            "SELECT DISTINCT value_text FROM page_properties \
                         WHERE key = ?1 AND value_text IS NOT NULL ORDER BY value_text LIMIT 50",
                        )?;
                        let rows = stmt
                            .query_map(rusqlite::params![key], |row| row.get(0))?
                            .filter_map(|r| r.ok())
                            .collect();
                        Ok(rows)
                    },
                )
                .await
                .map_err(|_| tower_lsp::jsonrpc::Error::internal_error())?
                .unwrap_or_default();
        }

        options.sort();
        options.dedup();
        Ok(options
            .into_iter()
            .filter(|o| o.starts_with(prefix))
            .map(|option| CompletionItem {
                label: option.clone(),
                kind: Some(CompletionItemKind::ENUM_MEMBER),
                insert_text: Some(option),
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
                return doc.body_span_to_range(start, end);
            }
        }
        // Fall back: read from disk, build throwaway Document
        if let Some(vp) = self.uri_to_vault_path(source_uri)
            && let Some(state) = self.state_opt()
        {
            let abs_path = state.vault.resolve(&vp);
            if let Ok(content) = tokio::fs::read_to_string(&abs_path).await {
                let doc = document::Document::from_text(&content, 0);
                return doc.body_span_to_range(start, end);
            }
        }
        Range::default()
    }

    /// Convert an indexed body span in `source_path` to a `Location`, using
    /// the open document if present, else a throwaway parse from disk.
    async fn span_to_location(
        &self,
        source_path: &str,
        span_start: i64,
        span_end: i64,
    ) -> Option<Location> {
        if span_start < 0 || span_end < 0 {
            return None;
        }
        let state = self.state_opt()?;
        let vp = crate::vault::path::VaultPath::new(source_path).ok()?;
        let abs = state.vault.resolve(&vp);
        let uri = Url::from_file_path(&abs).ok()?;
        let (start, end) = (span_start as usize, span_end as usize);
        {
            let docs = self.documents.lock().await;
            if let Some(doc) = docs.get(&uri) {
                return Some(Location {
                    range: doc.body_span_to_range(start, end),
                    uri,
                });
            }
        }
        let content = tokio::fs::read_to_string(&abs).await.ok()?;
        let doc = document::Document::from_text(&content, 0);
        Some(Location {
            range: doc.body_span_to_range(start, end),
            uri,
        })
    }

    /// Publish diagnostics for a single open document.
    ///
    /// Checks each extracted link against the cached canonical name snapshot.
    /// Reports unresolved links (no match) as warnings and ambiguous links
    /// (multiple matches) as informational diagnostics with related locations.
    async fn publish_diagnostics_for(&self, uri: &Url, doc: &document::Document) {
        let Some(state) = self.state_opt() else {
            return;
        };
        publish_diagnostics_for(&self.client, &state, &self.canonical_names, uri, doc).await;
    }
}

/// Convert an LSP URI to a vault-relative path, given an already-resolved
/// `LspState`. Shared core of `LspBackend::uri_to_vault_path` and the
/// free-function diagnostics path (`publish_diagnostics_for` below), which
/// run without a `&self` to call the method on.
fn vault_path_for_uri(state: &state::LspState, uri: &Url) -> Option<VaultPath> {
    let file_path = uri.to_file_path().ok()?;
    let root = state.vault.root();
    // `Vault::open` canonicalizes the root, but the editor's URI is whatever
    // path the user opened — often through a symlink (macOS `/tmp` →
    // `/private/tmp`, an iCloud or dotfiles symlink to the vault). Try the
    // canonicalized path first, then the raw one, so neither a symlinked root
    // nor a not-yet-created file (canonicalize fails on those) silently
    // detaches the document from the vault.
    let rel = file_path
        .canonicalize()
        .ok()
        .and_then(|resolved| {
            resolved
                .strip_prefix(root)
                .map(std::path::Path::to_path_buf)
                .ok()
        })
        .or_else(|| {
            file_path
                .strip_prefix(root)
                .map(std::path::Path::to_path_buf)
                .ok()
        })?;
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    VaultPath::new(&rel_str).ok()
}

/// Free-function core of `LspBackend::refresh_canonical_names` — reloads the
/// canonical name snapshot from the index. Shared with the watch-resync path
/// (via `refresh_names_and_republish`) so the two flows cannot drift.
async fn refresh_canonical_names(
    state: &state::LspState,
    canonical_names: &RwLock<HashMap<String, Vec<String>>>,
) {
    let result = state
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
        Ok(Ok(names)) => *canonical_names.write().await = names,
        Ok(Err(e)) => tracing::error!("failed to load canonical names: {e}"),
        Err(e) => tracing::error!("index thread error loading canonical names: {e}"),
    }
}

/// Free-function core of `LspBackend::publish_diagnostics_for`. Shared with
/// the watch-resync path (via `refresh_names_and_republish`) so the two
/// flows cannot drift.
async fn publish_diagnostics_for(
    client: &Client,
    state: &state::LspState,
    canonical_names: &RwLock<HashMap<String, Vec<String>>>,
    uri: &Url,
    doc: &document::Document,
) {
    let names = canonical_names.read().await;
    let mut diagnostics =
        crate::lsp::diagnostics::compute_link_diagnostics(doc, &names, state.vault.root());

    if !doc.encrypted {
        // Frontmatter property diagnostics against the base registry.
        let registry = crate::vault::base::BaseRegistry::load(state.vault.root());
        let path = vault_path_for_uri(state, uri)
            .map(|vp| vp.as_str().to_string())
            .unwrap_or_default();
        diagnostics.extend(crate::lsp::diagnostics::compute_property_diagnostics(
            doc, &registry, &path, &names,
        ));
    }
    drop(names);
    client
        .publish_diagnostics(uri.clone(), diagnostics, Some(doc.version))
        .await;
}

/// Refresh the canonical name snapshot and republish diagnostics for every
/// open document. This is the exact tail of `did_save`'s post-write flow,
/// extracted so the watch-resync path (`resync_from_watch_batch`) drives the
/// identical sequence — the two paths cannot drift apart.
async fn refresh_names_and_republish(
    client: &Client,
    state: &state::LspState,
    documents: &Arc<Mutex<HashMap<Url, document::Document>>>,
    canonical_names: &Arc<RwLock<HashMap<String, Vec<String>>>>,
) {
    refresh_canonical_names(state, canonical_names).await;

    let doc_uris: Vec<Url> = {
        let docs = documents.lock().await;
        docs.keys().cloned().collect()
    };
    for doc_uri in doc_uris {
        let docs = documents.lock().await;
        if let Some(doc) = docs.get(&doc_uri) {
            publish_diagnostics_for(client, state, canonical_names, &doc_uri, doc).await;
        }
    }
}

/// Pair Remove/Upsert events sharing a filename: a folder-projection move
/// (server-side reconcile) shows up as exactly such a pair in one batch.
fn pair_moves_by_filename(batch: &[ChangeEvent]) -> Vec<(VaultPath, VaultPath)> {
    let mut moves = Vec::new();
    for removed in batch {
        let ChangeEvent::Remove(old) = removed else {
            continue;
        };
        let old_name = old.as_str().rsplit('/').next().unwrap_or(old.as_str());
        for added in batch {
            let ChangeEvent::Upsert(new) = added else {
                continue;
            };
            let new_name = new.as_str().rsplit('/').next().unwrap_or(new.as_str());
            if old_name == new_name && old.as_str() != new.as_str() {
                moves.push((old.clone(), new.clone()));
            }
        }
    }
    moves
}

/// Process one drained batch from the vault watcher: reindex, refresh the
/// canonical snapshot, republish diagnostics for open docs, and log a
/// message for any open document that the batch shows was moved externally
/// (e.g. `clep serve`'s folder-follows-metadata reconcile).
///
/// Free function (not a method) so the spawned loop in `spawn_vault_watcher`
/// can own clones of the backend's shared state independent of `&self`.
async fn resync_from_watch_batch(
    client: Client,
    state: Arc<state::LspState>,
    documents: Arc<Mutex<HashMap<Url, document::Document>>>,
    canonical_names: Arc<RwLock<HashMap<String, Vec<String>>>>,
    batch: Vec<ChangeEvent>,
) {
    let moves = pair_moves_by_filename(&batch);
    if let Err(e) = state.index.process_sync_events(batch).await {
        tracing::warn!("lsp watch resync failed: {e}");
        return;
    }
    // Refresh snapshot + republish, mirroring the existing post-save flow.
    refresh_names_and_republish(&client, &state, &documents, &canonical_names).await;

    for (old, new) in moves {
        // Match on the resolved vault path rather than on a reconstructed URI:
        // the editor's document URIs may run through a symlinked workspace
        // root, so they need not be string-equal to `root.join(old)`.
        let is_open = {
            let documents = documents.lock().await;
            documents
                .keys()
                .any(|uri| vault_path_for_uri(&state, uri).as_ref() == Some(&old))
        };
        if is_open {
            client
                .log_message(
                    MessageType::INFO,
                    format!(
                        "clepsydra: {old} moved to {new} (folder follows kind/project); reopen the file"
                    ),
                )
                .await;
        }
    }
}

/// Start the LSP server on stdio. The vault opens during `initialize`
/// (workspace root → config fallback). Returns on client disconnect.
pub async fn run_lsp() {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();

    let (service, socket) = LspService::new(|client| LspBackend {
        client,
        vault_state: tokio::sync::OnceCell::new(),
        documents: Arc::new(Mutex::new(HashMap::new())),
        canonical_names: Arc::new(RwLock::new(HashMap::new())),
        watcher: std::sync::Mutex::new(None),
    });

    Server::new(stdin, stdout, socket).serve(service).await;
}

#[cfg(test)]
mod tests {
    use super::LspBackend;
    use super::test_support::*;
    use super::{ChangeEvent, VaultPath, pair_moves_by_filename, resync_from_watch_batch};
    use std::sync::Arc;
    use tower_lsp::LanguageServer;
    use tower_lsp::lsp_types::*;

    #[tokio::test]
    async fn backend_constructs_and_opens_a_document() {
        let (backend, _tmp) = make_backend(&[("Note.md", "# Note\n\nbody\n")]);
        let uri = uri_for(&backend, "Note.md");
        open_doc(&backend, &uri, "# Note\n\nbody\n").await;
        let docs = backend.documents.lock().await;
        assert!(docs.contains_key(&uri));
    }

    #[tokio::test]
    async fn initialize_opens_vault_from_root_uri() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        std::fs::write(root.join("Note.md"), "# Note\n").unwrap();

        let backend = make_uninitialized_backend();
        #[allow(deprecated)]
        let params = InitializeParams {
            root_uri: Some(Url::from_file_path(&root).unwrap()),
            ..Default::default()
        };
        let result = backend.initialize(params).await.unwrap();
        assert!(result.capabilities.completion_provider.is_some());
        assert!(backend.state().is_ok());
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
                position: Position {
                    line: 2,
                    character: 8,
                },
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
        let (backend, _tmp) =
            make_backend(&[("Src.md", "# Src\n\n[[Tar\n"), ("Target.md", "# Target\n")]);
        let uri = uri_for(&backend, "Src.md");
        open_doc(&backend, &uri, "# Src\n\n[[Tar\n").await;
        let params = CompletionParams {
            text_document_position: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position {
                    line: 2,
                    character: 5,
                },
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
                position: Position {
                    line: 2,
                    character: 3,
                },
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
                position: Position {
                    line: 2,
                    character: 4,
                },
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

    #[tokio::test]
    async fn did_save_reindexes_but_never_moves_files() {
        // A page that declares `type: quote` while living under notes/ —
        // declared kind mismatches its folder (mirrors lib.rs's
        // serve_startup_reconciles_drifted_pages fixture). Only `clep
        // serve`'s watcher reconciles folder drift (Task 3); the standalone
        // LSP must never move vault files itself.
        let initial = "---\nid: 0190f8a0-0000-7000-8000-0000000000a1\ntype: quote\n---\nbody\n";
        let (backend, tmp) = make_backend(&[("notes/q.md", initial)]);
        let root = tmp.path().join("vault");
        let uri = uri_for(&backend, "notes/q.md");
        open_doc(&backend, &uri, initial).await;

        // The editor writes the saved content to disk before sending didSave.
        let updated = "---\nid: 0190f8a0-0000-7000-8000-0000000000a1\ntype: quote\n---\nupdated needle body\n";
        std::fs::write(root.join("notes/q.md"), updated).unwrap();

        let params = DidSaveTextDocumentParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            text: None,
        };
        backend.did_save(params).await;

        assert!(
            root.join("notes/q.md").exists(),
            "did_save must never move the file off its saved path"
        );
        assert!(
            !root.join("quotes/q.md").exists(),
            "did_save must not reconcile declared kind into a projected folder"
        );

        let results = backend
            .state()
            .unwrap()
            .index
            .search("needle".to_string(), 10)
            .await
            .unwrap();
        assert!(
            results.iter().any(|r| r.path == "notes/q.md"),
            "index should reflect the saved content: {results:?}"
        );
    }

    /// The Global Constraint (ADR 0001): the standalone LSP process must never
    /// write vault files. Frontmatter repair is the sharpest edge — a page with
    /// no frontmatter at all, and a page whose frontmatter lacks `created_at`,
    /// both make `parse_or_repair_frontmatter` ask for a rewrite. Under
    /// `clep serve` that rewrite lands on disk; under `clep lsp` it must stay
    /// in memory, at `initialize` (`open_lsp_state`) and on `didSave` alike.
    #[tokio::test]
    async fn lsp_never_rewrites_vault_files_to_repair_frontmatter() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();

        // No frontmatter fences at all.
        let loose = "# Loose\n\nneedleloose\n";
        std::fs::write(root.join("Loose.md"), loose).unwrap();
        // Valid frontmatter, but missing created_at/updated_at.
        let partial = "+++\nid = \"0190f8a0-0000-7000-8000-0000000000b1\"\n+++\n\nneedlepartial\n";
        std::fs::write(root.join("Partial.md"), partial).unwrap();

        let before = snapshot_tree(&root);

        // initialize: full index build over both pages.
        let backend = backend_for_root(&root);
        assert_eq!(
            snapshot_tree(&root),
            before,
            "open_lsp_state must leave every vault file byte-identical"
        );

        // didSave on each page: index_page runs the same repair path.
        for rel in ["Loose.md", "Partial.md"] {
            let uri = uri_for(&backend, rel);
            open_doc(
                &backend,
                &uri,
                &String::from_utf8(before[rel].clone()).unwrap(),
            )
            .await;
            backend
                .did_save(DidSaveTextDocumentParams {
                    text_document: TextDocumentIdentifier { uri },
                    text: None,
                })
                .await;
        }
        assert_eq!(
            snapshot_tree(&root),
            before,
            "did_save must leave every vault file byte-identical"
        );

        // The repaired metadata is still indexed in memory — read-only does not
        // mean "unindexed".
        let results = backend
            .state()
            .unwrap()
            .index
            .search("needleloose".to_string(), 10)
            .await
            .unwrap();
        assert!(
            results.iter().any(|r| r.path == "Loose.md"),
            "frontmatter-less page must still be indexed: {results:?}"
        );
    }

    /// A workspace opened through a symlink (macOS `/tmp` → `/private/tmp`, an
    /// iCloud or dotfiles link) still resolves to vault paths: `Vault::open`
    /// canonicalizes the root, so a raw `strip_prefix` would fail for every
    /// document and silently disable didSave, diagnostics, and references.
    #[cfg(unix)]
    #[tokio::test]
    async fn resolves_documents_opened_through_a_symlinked_root() {
        let initial = "# Note\n\nneedlebefore\n";
        let (backend, tmp) = make_backend(&[("Note.md", initial)]);
        let root = tmp.path().join("vault");
        let linked_root = tmp.path().join("linked-vault");
        std::os::unix::fs::symlink(&root, &linked_root).unwrap();

        // The editor's URI travels through the symlink, not the canonical root.
        let uri = Url::from_file_path(linked_root.join("Note.md")).unwrap();
        assert_ne!(uri, uri_for(&backend, "Note.md"));
        open_doc(&backend, &uri, initial).await;

        std::fs::write(root.join("Note.md"), "# Note\n\nneedleafter\n").unwrap();
        backend
            .did_save(DidSaveTextDocumentParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                text: None,
            })
            .await;

        let results = backend
            .state()
            .unwrap()
            .index
            .search("needleafter".to_string(), 10)
            .await
            .unwrap();
        assert!(
            results.iter().any(|r| r.path == "Note.md"),
            "didSave through a symlinked root must reindex the page: {results:?}"
        );

        let docs = backend.documents.lock().await;
        assert!(
            !docs.get(&uri).unwrap().dirty,
            "didSave through a symlinked root must clear the dirty flag"
        );
    }

    #[tokio::test]
    async fn backlink_to_range_used_in_references() {
        let (backend, _tmp) = make_backend(&[
            ("Target.md", "# Target\n"),
            ("Other.md", "# Other\n\nlink to [[Target]]\n"),
        ]);
        let uri = uri_for(&backend, "Target.md");
        open_doc(&backend, &uri, "# Target\n").await;
        let params = ReferenceParams {
            text_document_position: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position {
                    line: 0,
                    character: 2,
                },
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
            context: ReferenceContext {
                include_declaration: false,
            },
        };
        let refs = backend
            .references(params)
            .await
            .unwrap()
            .unwrap_or_default();
        assert!(refs.iter().any(|l| l.uri.path().ends_with("Other.md")));
    }

    #[tokio::test]
    async fn references_from_link_under_cursor() {
        let (backend, _tmp) = make_backend(&[
            ("A.md", "# A\n\n[[Target]]\n"),
            ("Target.md", "# Target\n"),
            ("B.md", "# B\n\n[[Target]]\n"),
        ]);
        let uri = uri_for(&backend, "A.md");
        open_doc(&backend, &uri, "# A\n\n[[Target]]\n").await;
        let params = ReferenceParams {
            text_document_position: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position {
                    line: 2,
                    character: 4,
                },
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
            context: ReferenceContext {
                include_declaration: false,
            },
        };
        let refs = backend
            .references(params)
            .await
            .unwrap()
            .unwrap_or_default();
        assert!(refs.iter().any(|l| l.uri.path().ends_with("B.md")));
        assert!(refs.iter().any(|l| l.uri.path().ends_with("A.md")));
    }

    #[tokio::test]
    async fn prepare_rename_on_wikilink() {
        let (backend, _tmp) =
            make_backend(&[("A.md", "# A\n\n[[Target]]\n"), ("Target.md", "# Target\n")]);
        let uri = uri_for(&backend, "A.md");
        open_doc(&backend, &uri, "# A\n\n[[Target]]\n").await;
        let params = TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            position: Position {
                line: 2,
                character: 4,
            },
        };
        assert!(backend.prepare_rename(params).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn prepare_rename_on_frontmatter_title() {
        let text = "---\ntitle: Old Title\n---\nbody\n";
        let (backend, _tmp) = make_backend(&[("A.md", text)]);
        let uri = uri_for(&backend, "A.md");
        open_doc(&backend, &uri, text).await;
        let params = TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            position: Position {
                line: 1,
                character: 9,
            },
        };
        let resp = backend.prepare_rename(params).await.unwrap();
        assert!(resp.is_some());
        match resp.unwrap() {
            PrepareRenameResponse::RangeWithPlaceholder { placeholder, .. } => {
                assert_eq!(placeholder, "Old Title");
            }
            _ => panic!("expected RangeWithPlaceholder"),
        }
    }

    #[tokio::test]
    async fn rename_wikilink_target_rewrites_referrers() {
        let (backend, _tmp) = make_backend(&[
            ("Target.md", "---\ntitle: Target\n---\nbody\n"),
            ("A.md", "# A\n\n[[Target]]\n"),
        ]);
        let uri = uri_for(&backend, "A.md");
        open_doc(&backend, &uri, "# A\n\n[[Target]]\n").await;
        let params = RenameParams {
            text_document_position: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position {
                    line: 2,
                    character: 4,
                },
            },
            new_name: "Renamed Target".to_string(),
            work_done_progress_params: Default::default(),
        };
        let edit = backend
            .rename(params)
            .await
            .unwrap()
            .expect("workspace edit");
        assert!(edit.document_changes.is_some());
    }

    #[tokio::test]
    async fn rename_to_existing_path_is_rejected() {
        let (backend, _tmp) = make_backend(&[
            ("Target.md", "---\ntitle: Target\n---\n"),
            ("Existing.md", "---\ntitle: Existing\n---\n"),
            ("A.md", "# A\n\n[[Target]]\n"),
        ]);
        let uri = uri_for(&backend, "A.md");
        open_doc(&backend, &uri, "# A\n\n[[Target]]\n").await;
        let params = RenameParams {
            text_document_position: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position {
                    line: 2,
                    character: 4,
                },
            },
            new_name: "Existing".to_string(),
            work_done_progress_params: Default::default(),
        };
        assert!(backend.rename(params).await.is_err());
    }

    #[tokio::test]
    async fn rename_from_frontmatter_renames_current_page() {
        // Cursor in the frontmatter `title:` line renames the current page
        // (Case B in resolve_rename_target) and rewrites referrers.
        let text = "---\ntitle: Old Note\n---\nbody\n";
        let (backend, _tmp) =
            make_backend(&[("Old Note.md", text), ("A.md", "# A\n\n[[Old Note]]\n")]);
        let uri = uri_for(&backend, "Old Note.md");
        open_doc(&backend, &uri, text).await;
        let params = RenameParams {
            text_document_position: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position {
                    line: 1,
                    character: 9,
                }, // inside "title: Old Note" (frontmatter)
            },
            new_name: "New Note".to_string(),
            work_done_progress_params: Default::default(),
        };
        let edit = backend
            .rename(params)
            .await
            .unwrap()
            .expect("workspace edit");
        assert!(edit.document_changes.is_some());
    }

    #[tokio::test]
    async fn code_action_offers_create_page_for_unresolved_link() {
        let (backend, _tmp) = make_backend(&[("A.md", "# A\n\n[[Ghost]]\n")]);
        let uri = uri_for(&backend, "A.md");
        open_doc(&backend, &uri, "# A\n\n[[Ghost]]\n").await;
        // Build the diagnostics the editor would send back in the request context.
        let names = backend.canonical_names.read().await.clone();
        let diagnostics = {
            let docs = backend.documents.lock().await;
            let doc = docs.get(&uri).unwrap();
            crate::lsp::diagnostics::compute_link_diagnostics(
                doc,
                &names,
                backend.state().unwrap().vault.root(),
            )
        };
        let params = CodeActionParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            range: Range::default(),
            context: CodeActionContext {
                diagnostics,
                only: None,
                trigger_kind: None,
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };
        let actions = backend
            .code_action(params)
            .await
            .unwrap()
            .unwrap_or_default();
        assert!(!actions.is_empty());
        let CodeActionOrCommand::CodeAction(ca) = &actions[0] else {
            panic!("expected a CodeAction");
        };
        assert_eq!(ca.kind, Some(CodeActionKind::QUICKFIX));
        assert!(ca.title.contains("Ghost"));
    }

    // -- Phase 5: frontmatter property intelligence ------------------------

    const READING_BASE: &str = "name = \"Reading\"\n\n[filter]\nfield = \"kind\"\nop = \"eq\"\nvalue = \"BOOK\"\n\n[properties]\nauthor = { type = \"text\" }\nstatus = { type = \"select\", options = [\"queued\", \"reading\", \"finished\", \"abandoned\"] }\nseries = { type = \"relation\" }\n";
    const HABITS_BASE: &str = "name = \"Habits\"\n\n[filter]\nfield = \"kind\"\nop = \"eq\"\nvalue = \"NOTE\"\n\n[properties]\ncadence = { type = \"text\" }\n";

    async fn complete_at(
        backend: &LspBackend,
        uri: &Url,
        line: u32,
        character: u32,
    ) -> Option<Vec<CompletionItem>> {
        let params = CompletionParams {
            text_document_position: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position { line, character },
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
            context: None,
        };
        match backend.completion(params).await.unwrap() {
            Some(CompletionResponse::Array(v)) => Some(v),
            Some(CompletionResponse::List(l)) => Some(l.items),
            None => None,
        }
    }

    #[tokio::test]
    async fn frontmatter_key_completion_ranks_matching_base_first() {
        let text =
            "+++\nid = \"0190f8a0-0000-7000-8000-000000000071\"\ntype = \"BOOK\"\n\n+++\nbody\n";
        let (backend, _tmp) = make_backend(&[
            ("bases/reading.base.toml", READING_BASE),
            ("bases/habits.base.toml", HABITS_BASE),
            ("book.md", text),
        ]);
        let uri = uri_for(&backend, "book.md");
        open_doc(&backend, &uri, text).await;

        // Cursor at column 0 of the blank line inside the fences.
        let items = complete_at(&backend, &uri, 3, 0).await.expect("items");
        let labels: Vec<&str> = items.iter().map(|i| i.label.as_str()).collect();
        assert!(labels.contains(&"author"), "{labels:?}");
        assert!(labels.contains(&"cadence"), "{labels:?}");
        // The matching base (Reading, kind = BOOK) ranks ahead of Habits.
        let author = items.iter().find(|i| i.label == "author").unwrap();
        let cadence = items.iter().find(|i| i.label == "cadence").unwrap();
        assert!(author.sort_text < cadence.sort_text);
        assert_eq!(author.insert_text.as_deref(), Some("author = "));
    }

    #[tokio::test]
    async fn frontmatter_key_completion_absent_in_body_and_legacy() {
        let toml_text = "+++\nid = \"0190f8a0-0000-7000-8000-000000000072\"\n+++\naut\n";
        let legacy_text =
            "---\nid: 0190f8a0-0000-7000-8000-000000000073\ntype: BOOK\n\n---\nbody\n";
        let (backend, _tmp) = make_backend(&[
            ("bases/reading.base.toml", READING_BASE),
            ("a.md", toml_text),
            ("b.md", legacy_text),
        ]);

        // Body position: a bare word is not a property key context.
        let uri_a = uri_for(&backend, "a.md");
        open_doc(&backend, &uri_a, toml_text).await;
        assert!(complete_at(&backend, &uri_a, 3, 3).await.is_none());

        // Legacy page: no property intelligence inside --- fences.
        let uri_b = uri_for(&backend, "b.md");
        open_doc(&backend, &uri_b, legacy_text).await;
        assert!(complete_at(&backend, &uri_b, 3, 0).await.is_none());
    }

    #[tokio::test]
    async fn frontmatter_key_completion_empty_without_bases() {
        let text = "+++\nid = \"0190f8a0-0000-7000-8000-000000000074\"\n\n+++\nbody\n";
        let (backend, _tmp) = make_backend(&[("a.md", text)]);
        let uri = uri_for(&backend, "a.md");
        open_doc(&backend, &uri, text).await;
        assert!(complete_at(&backend, &uri, 2, 0).await.is_none());
    }

    #[tokio::test]
    async fn frontmatter_select_value_completion_offers_options() {
        let text = "+++\nid = \"0190f8a0-0000-7000-8000-000000000075\"\ntype = \"BOOK\"\nstatus = \"\n+++\nbody\n";
        let (backend, _tmp) =
            make_backend(&[("bases/reading.base.toml", READING_BASE), ("book.md", text)]);
        let uri = uri_for(&backend, "book.md");
        open_doc(&backend, &uri, text).await;

        // Cursor right after the opening quote on the status line.
        let items = complete_at(&backend, &uri, 3, 10).await.expect("items");
        let labels: Vec<&str> = items.iter().map(|i| i.label.as_str()).collect();
        assert_eq!(labels, vec!["abandoned", "finished", "queued", "reading"]);
    }

    #[tokio::test]
    async fn frontmatter_relation_completion_matches_body_wikilinks() {
        let text = "+++\nid = \"0190f8a0-0000-7000-8000-000000000076\"\ntype = \"BOOK\"\nseries = [\"[[Sol\n+++\n[[Sol\n";
        let (backend, _tmp) = make_backend(&[
            ("bases/reading.base.toml", READING_BASE),
            ("book.md", text),
            (
                "Solar Cycle.md",
                "+++\nid = \"0190f8a0-0000-7000-8000-0000000000aa\"\ntitle = \"Solar Cycle\"\n+++\n",
            ),
        ]);
        let uri = uri_for(&backend, "book.md");
        open_doc(&backend, &uri, text).await;

        // In-frontmatter relation completion ("series = [\"[[Sol") …
        let fm_items = complete_at(&backend, &uri, 3, 16).await.expect("items");
        // … must be identical to body wikilink completion ("[[Sol").
        let body_items = complete_at(&backend, &uri, 5, 5).await.expect("items");
        let fm_labels: Vec<&str> = fm_items.iter().map(|i| i.label.as_str()).collect();
        let body_labels: Vec<&str> = body_items.iter().map(|i| i.label.as_str()).collect();
        assert_eq!(fm_labels, body_labels);
        assert!(
            fm_labels.iter().any(|l| l.contains("Solar Cycle")),
            "{fm_labels:?}"
        );
    }

    // -- Phase 6: watcher-driven resync -------------------------------------

    #[tokio::test]
    async fn watch_batch_refreshes_canonical_names() {
        let (backend, _tmp) = make_backend(&[("Note.md", "# Note\n")]);
        backend.refresh_canonical_names().await;
        let state = backend.state().unwrap();
        // Simulate an external creation: write the file, then feed the batch.
        std::fs::write(state.vault.root().join("Fresh.md"), "# Fresh\n").unwrap();
        resync_from_watch_batch(
            backend.client.clone(),
            Arc::clone(&state),
            Arc::clone(&backend.documents),
            Arc::clone(&backend.canonical_names),
            vec![crate::vault::sync::ChangeEvent::Upsert(
                crate::vault::path::VaultPath::new("Fresh.md").unwrap(),
            )],
        )
        .await;
        let names = backend.canonical_names.read().await;
        assert!(names.keys().any(|k| k.eq_ignore_ascii_case("fresh")));
    }

    #[test]
    fn pairs_remove_and_upsert_by_filename() {
        let batch = vec![
            ChangeEvent::Remove(VaultPath::new("notes/20260807.a.abc123.md").unwrap()),
            ChangeEvent::Upsert(VaultPath::new("projects/x/20260807.a.abc123.md").unwrap()),
        ];
        let moves = pair_moves_by_filename(&batch);
        assert_eq!(moves.len(), 1);
        assert_eq!(moves[0].0.as_str(), "notes/20260807.a.abc123.md");
        assert_eq!(moves[0].1.as_str(), "projects/x/20260807.a.abc123.md");
    }

    #[tokio::test]
    async fn completion_suggests_block_refs_by_content() {
        let (backend, _tmp) = make_backend(&[
            ("Ref.md", "# Ref\n\nA fact worth citing ^blk123XYZ99\n"),
            ("Src.md", "# Src\n\n((fact\n"),
        ]);
        let uri = uri_for(&backend, "Src.md");
        open_doc(&backend, &uri, "# Src\n\n((fact\n").await;
        let params = CompletionParams {
            text_document_position: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position {
                    line: 2,
                    character: 6,
                },
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
            context: None,
        };
        let resp = backend.completion(params).await.unwrap();
        let items = match resp {
            Some(CompletionResponse::Array(v)) => v,
            other => panic!("expected completions, got {other:?}"),
        };
        let item = items
            .iter()
            .find(|i| i.label.contains("A fact worth citing"))
            .expect("block content offered");
        assert_eq!(item.insert_text.as_deref(), Some("blk123XYZ99))"));
        assert_eq!(item.detail.as_deref(), Some("Ref.md"));
    }

    #[tokio::test]
    async fn completion_block_refs_no_match_returns_empty() {
        let (backend, _tmp) = make_backend(&[
            ("Ref.md", "# Ref\n\nA fact worth citing ^blk123XYZ99\n"),
            ("Src.md", "# Src\n\n((zzzz\n"),
        ]);
        let uri = uri_for(&backend, "Src.md");
        open_doc(&backend, &uri, "# Src\n\n((zzzz\n").await;
        let params = CompletionParams {
            text_document_position: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position {
                    line: 2,
                    character: 6,
                },
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
            context: None,
        };
        let resp = backend.completion(params).await.unwrap();
        let items = match resp {
            Some(CompletionResponse::Array(v)) => v,
            other => panic!("expected an (empty) array, got {other:?}"),
        };
        assert!(items.is_empty());
    }

    #[tokio::test]
    async fn initialize_advertises_paren_trigger() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let backend = make_uninitialized_backend();
        #[allow(deprecated)]
        let params = InitializeParams {
            root_uri: Some(Url::from_file_path(&root).unwrap()),
            ..Default::default()
        };
        let result = backend.initialize(params).await.unwrap();
        let triggers = result
            .capabilities
            .completion_provider
            .unwrap()
            .trigger_characters
            .unwrap();
        assert!(triggers.contains(&"(".to_string()));
    }

    #[tokio::test]
    async fn hover_on_block_ref_shows_block_content() {
        let (backend, _tmp) = make_backend(&[
            ("Ref.md", "# Ref\n\nA fact worth citing ^blk123XYZ99\n"),
            ("Src.md", "# Src\n\nsee ((blk123XYZ99))\n"),
        ]);
        let uri = uri_for(&backend, "Src.md");
        open_doc(&backend, &uri, "# Src\n\nsee ((blk123XYZ99))\n").await;
        let params = HoverParams {
            text_document_position_params: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position {
                    line: 2,
                    character: 8,
                },
            },
            work_done_progress_params: Default::default(),
        };
        let hover = backend.hover(params).await.unwrap().expect("hover content");
        let HoverContents::Markup(m) = hover.contents else {
            panic!("expected markup");
        };
        assert!(m.value.contains("A fact worth citing"));
        assert!(m.value.contains("Ref.md"));
    }

    #[tokio::test]
    async fn hover_on_unknown_block_ref_reports_unresolved() {
        let (backend, _tmp) = make_backend(&[("Src.md", "# Src\n\nsee ((nope1234567))\n")]);
        let uri = uri_for(&backend, "Src.md");
        open_doc(&backend, &uri, "# Src\n\nsee ((nope1234567))\n").await;
        let params = HoverParams {
            text_document_position_params: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position {
                    line: 2,
                    character: 8,
                },
            },
            work_done_progress_params: Default::default(),
        };
        let hover = backend.hover(params).await.unwrap().expect("hover content");
        let HoverContents::Markup(m) = hover.contents else {
            panic!("expected markup");
        };
        assert!(m.value.contains("Unresolved block reference"));
    }

    #[tokio::test]
    async fn goto_definition_jumps_to_block_span() {
        let ref_text =
            "+++\ntitle = \"Ref\"\n+++\nintro line\n\nA fact worth citing ^blk123XYZ99\n";
        let (backend, _tmp) = make_backend(&[
            ("Ref.md", ref_text),
            ("Src.md", "# Src\n\nsee ((blk123XYZ99))\n"),
        ]);
        let uri = uri_for(&backend, "Src.md");
        open_doc(&backend, &uri, "# Src\n\nsee ((blk123XYZ99))\n").await;
        let params = GotoDefinitionParams {
            text_document_position_params: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position {
                    line: 2,
                    character: 8,
                },
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };
        let resp = backend.goto_definition(params).await.unwrap();
        let Some(GotoDefinitionResponse::Scalar(loc)) = resp else {
            panic!("expected a scalar location, got {resp:?}");
        };
        assert!(loc.uri.path().ends_with("Ref.md"));
        // "A fact worth citing" is line 5 of the file (0-indexed), after the
        // three frontmatter lines, "intro line", and a blank line.
        assert_eq!(loc.range.start.line, 5);
    }

    #[tokio::test]
    async fn references_on_block_ref_lists_all_referrers() {
        let (backend, _tmp) = make_backend(&[
            ("Ref.md", "# Ref\n\nA fact worth citing ^blk123XYZ99\n"),
            ("SrcA.md", "# A\n\nsee ((blk123XYZ99))\n"),
            ("SrcB.md", "# B\n\nalso ((blk123XYZ99))\n"),
        ]);
        let uri = uri_for(&backend, "SrcA.md");
        open_doc(&backend, &uri, "# A\n\nsee ((blk123XYZ99))\n").await;
        let params = ReferenceParams {
            text_document_position: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                position: Position {
                    line: 2,
                    character: 8,
                },
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
            context: ReferenceContext {
                include_declaration: false,
            },
        };
        let locs = backend
            .references(params)
            .await
            .unwrap()
            .expect("locations");
        assert_eq!(locs.len(), 2);
        let mut paths: Vec<String> = locs
            .iter()
            .map(|l| l.uri.path().rsplit('/').next().unwrap().to_string())
            .collect();
        paths.sort();
        assert_eq!(paths, vec!["SrcA.md".to_string(), "SrcB.md".to_string()]);
        // Spans are real (converted from indexed offsets), not defaults.
        assert!(locs.iter().any(|l| l.range.start.line > 0));
    }
}
