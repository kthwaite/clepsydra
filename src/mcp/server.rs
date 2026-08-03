//! The MCP tool surface over the vault API.
//!
//! Read tools (M1): search, page reads, listing, tree, link graph, tags.
//! Write tools (M2): create, update, surgical edit, append, journal capture.
//! Every tool proxies the running HTTP server via [`ApiClient`] and returns
//! the API's JSON as text content; failures come back as tool errors carrying
//! the actionable messages built in `client.rs`.

use std::sync::Arc;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use super::client::{ApiClient, encode_vault_path};
use crate::vault::kind::Kind;

/// The `/pages/{path}` endpoint URL for a vault-relative path.
fn pages_url(path: &str) -> String {
    format!("/api/vault/pages/{}", encode_vault_path(path))
}

/// Maximum page-body size (in bytes) returned inline before truncation.
const MAX_BODY_BYTES: usize = 50_000;

/// Default number of results for listing tools, kept small to protect the
/// calling agent's context window.
const DEFAULT_LIST_LIMIT: u32 = 50;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SearchParams {
    /// Full-text search query, matched against page titles and bodies.
    pub query: String,
    /// Maximum number of results (default 20).
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetPageParams {
    /// Vault-relative page path, e.g. `notes/20260803.example.a1b2.md`.
    /// Exactly one of `path` or `id` must be provided.
    pub path: Option<String>,
    /// Page UUID from frontmatter (the `id` field returned by other tools).
    pub id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListPagesParams {
    /// Maximum number of pages to return (default 50).
    pub limit: Option<u32>,
    /// Offset into the path-ordered page list, for pagination.
    pub offset: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TreeParams {
    /// Folder to list, vault-relative (e.g. `notes`). Omit for the full
    /// folder tree from the vault root.
    pub path: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LinkDirection {
    /// Pages that link TO the given page.
    Backlinks,
    /// Pages the given page links to (including unresolved link text).
    Outlinks,
    /// Pages ranked as most similar by shared links and tags.
    Similar,
}

impl LinkDirection {
    fn endpoint(&self) -> &'static str {
        match self {
            LinkDirection::Backlinks => "backlinks",
            LinkDirection::Outlinks => "outlinks",
            LinkDirection::Similar => "similar",
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct LinksParams {
    /// Vault-relative page path.
    pub path: String,
    /// Which relationship to query: backlinks, outlinks, or similar.
    pub direction: LinkDirection,
}

/// The kind vocabulary, spelled out for tool schemas and error messages.
const KIND_TOKENS: &str =
    "NOTE, PROJECT, JOURNAL, TODO, QUOTE, BOOK, CAPTURE, CODE, PERSON, TASK, CYCLE";

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CreatePageParams {
    /// Page title. Required; also drives the generated filename slug.
    pub title: String,
    /// Kind token (NOTE, PROJECT, JOURNAL, TODO, QUOTE, BOOK, CAPTURE, CODE,
    /// PERSON, TASK, CYCLE). Defaults to NOTE. Declared in frontmatter and
    /// used to pick the canonical folder.
    pub kind: Option<String>,
    /// Folder override, vault-relative (e.g. `notes/drafts`). Defaults to the
    /// kind's canonical folder (notes, quotes, journals, ...).
    pub folder: Option<String>,
    /// Initial markdown body.
    pub body: Option<String>,
    /// Frontmatter tags. Check vault_tags first to reuse existing vocabulary.
    pub tags: Option<Vec<String>>,
    /// Alternative names the page can be wikilinked by.
    pub aliases: Option<Vec<String>>,
    /// Project to assign the page to.
    pub project: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdatePageParams {
    /// Vault-relative page path.
    pub path: String,
    /// New title. Omitted fields keep their current value.
    pub title: Option<String>,
    /// Replacement tag list (replaces ALL existing tags).
    pub tags: Option<Vec<String>>,
    /// Replacement alias list (replaces ALL existing aliases).
    pub aliases: Option<Vec<String>>,
    /// Replacement markdown body (replaces the WHOLE body — prefer
    /// vault_edit_page or vault_append_page for targeted changes).
    pub body: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditPageParams {
    /// Vault-relative page path.
    pub path: String,
    /// Exact text to find in the page body, whitespace included.
    pub old_string: String,
    /// Replacement text.
    pub new_string: String,
    /// Replace every occurrence instead of requiring a unique match.
    pub replace_all: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AppendPageParams {
    /// Vault-relative page path.
    pub path: String,
    /// Markdown to append.
    pub content: String,
    /// Append at the end of this heading's section instead of the end of the
    /// page (matched against ATX heading text, case-insensitive).
    pub heading: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct JournalCaptureParams {
    /// Markdown to append to today's journal page (created if absent).
    pub content: String,
}

/// If `value` carries an oversized `body` string, truncate it in place (on a
/// char boundary) and record the truncation so the agent knows the read is
/// partial.
pub(crate) fn truncate_body(value: &mut Value, max_bytes: usize) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let Some(body) = object.get("body").and_then(Value::as_str) else {
        return;
    };
    if body.len() <= max_bytes {
        return;
    }

    let mut cut = max_bytes;
    while cut > 0 && !body.is_char_boundary(cut) {
        cut -= 1;
    }
    let total = body.len();
    let truncated = body[..cut].to_string();
    object.insert("body".to_string(), Value::String(truncated));
    object.insert("body_truncated".to_string(), Value::Bool(true));
    object.insert(
        "body_truncation_note".to_string(),
        Value::String(format!(
            "body truncated to {cut} of {total} bytes for context safety"
        )),
    );
}

/// Render a tool result payload. Pretty-printed so page bodies and link lists
/// stay legible in transcripts.
fn render(value: &Value) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|e| format!("failed to render response: {e}"))
}

/// MCP server over one clepsydra vault, addressed through the HTTP API.
#[derive(Clone)]
pub struct VaultMcpServer {
    client: Arc<ApiClient>,
}

#[tool_router]
impl VaultMcpServer {
    pub fn new(client: Arc<ApiClient>) -> Self {
        Self { client }
    }

    #[tool(
        name = "vault_search",
        description = "Full-text search the vault. Returns matching pages with path, title, and a snippet. Use this before creating pages to avoid duplicates, and to locate pages whose path you don't know.",
        annotations(read_only_hint = true, idempotent_hint = true)
    )]
    pub async fn vault_search(
        &self,
        Parameters(params): Parameters<SearchParams>,
    ) -> Result<String, String> {
        let mut query = vec![("q", params.query)];
        if let Some(limit) = params.limit {
            query.push(("limit", limit.to_string()));
        }
        let value = self
            .client
            .get_json("/api/vault/index/search", &query)
            .await
            .map_err(|e| e.to_string())?;
        render(&value)
    }

    #[tool(
        name = "vault_get_page",
        description = "Read one page: frontmatter metadata (id, title, tags, aliases), resolved kind, project, and full markdown body. Address it by vault-relative path or by page id (UUID). Oversized bodies are truncated and flagged with body_truncated.",
        annotations(read_only_hint = true, idempotent_hint = true)
    )]
    pub async fn vault_get_page(
        &self,
        Parameters(params): Parameters<GetPageParams>,
    ) -> Result<String, String> {
        let path = match (params.path, params.id) {
            (Some(path), None) => format!("/api/vault/pages/{}", encode_vault_path(&path)),
            (None, Some(id)) => format!("/api/vault/pages/by-id/{}", encode_vault_path(&id)),
            _ => {
                return Err(
                    "provide exactly one of 'path' or 'id' to identify the page".to_string()
                );
            }
        };
        let mut value = self
            .client
            .get_json(&path, &[])
            .await
            .map_err(|e| e.to_string())?;
        truncate_body(&mut value, MAX_BODY_BYTES);
        render(&value)
    }

    #[tool(
        name = "vault_list_pages",
        description = "List pages (path-ordered) with id, path, title, canonical name, kind, project, and tags. Paginated via limit/offset; the response's total field reports the full count.",
        annotations(read_only_hint = true, idempotent_hint = true)
    )]
    pub async fn vault_list_pages(
        &self,
        Parameters(params): Parameters<ListPagesParams>,
    ) -> Result<String, String> {
        let query = vec![
            (
                "limit",
                params.limit.unwrap_or(DEFAULT_LIST_LIMIT).to_string(),
            ),
            ("offset", params.offset.unwrap_or(0).to_string()),
        ];
        let value = self
            .client
            .get_json("/api/vault/pages", &query)
            .await
            .map_err(|e| e.to_string())?;
        render(&value)
    }

    #[tool(
        name = "vault_tree",
        description = "Orient in the vault's folder structure. Without a path: the full folder tree. With a folder path: that folder's subfolders and pages.",
        annotations(read_only_hint = true, idempotent_hint = true)
    )]
    pub async fn vault_tree(
        &self,
        Parameters(params): Parameters<TreeParams>,
    ) -> Result<String, String> {
        let path = match params.path {
            Some(folder) => format!("/api/vault/folders/{}", encode_vault_path(&folder)),
            None => "/api/vault/folders/tree".to_string(),
        };
        let value = self
            .client
            .get_json(&path, &[])
            .await
            .map_err(|e| e.to_string())?;
        render(&value)
    }

    #[tool(
        name = "vault_links",
        description = "Explore the link graph around a page: backlinks (pages linking to it), outlinks (pages it links to, including unresolved targets), or similar (related pages).",
        annotations(read_only_hint = true, idempotent_hint = true)
    )]
    pub async fn vault_links(
        &self,
        Parameters(params): Parameters<LinksParams>,
    ) -> Result<String, String> {
        let path = format!(
            "/api/vault/index/{}/{}",
            params.direction.endpoint(),
            encode_vault_path(&params.path)
        );
        let value = self
            .client
            .get_json(&path, &[])
            .await
            .map_err(|e| e.to_string())?;
        render(&value)
    }

    #[tool(
        name = "vault_tags",
        description = "List every tag in the vault with its usage count, most-used first. Consult this before tagging so new pages reuse the existing vocabulary.",
        annotations(read_only_hint = true, idempotent_hint = true)
    )]
    pub async fn vault_tags(&self) -> Result<String, String> {
        let value = self
            .client
            .get_json("/api/vault/index/tags", &[])
            .await
            .map_err(|e| e.to_string())?;
        render(&value)
    }

    #[tool(
        name = "vault_create_page",
        description = "Create a new page. The canonical filename (yyyymmdd.slug.shortid.md) is derived from the title — never construct paths by hand. Files under the kind's canonical folder unless 'folder' overrides it; kind/project are declared in frontmatter when given. Search first (vault_search) to avoid duplicates. Returns the created page, including the path to use for follow-up calls.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    pub async fn vault_create_page(
        &self,
        Parameters(params): Parameters<CreatePageParams>,
    ) -> Result<String, String> {
        let title = params.title.trim();
        if title.is_empty() {
            return Err("title must not be empty".to_string());
        }
        let kind = match &params.kind {
            Some(token) => Kind::from_token(token)
                .ok_or_else(|| format!("unknown kind \"{token}\" — valid kinds: {KIND_TOKENS}"))?,
            None => Kind::Note,
        };
        let folder = params
            .folder
            .as_deref()
            .map(|f| f.trim().trim_matches('/').to_string())
            .unwrap_or_else(|| kind.canonical_folder().to_string());

        let filename = crate::vault::page_filename::page_filename(
            chrono::Utc::now(),
            title,
            &crate::vault::block_id::generate_short_id(),
        );
        let path = if folder.is_empty() {
            filename
        } else {
            format!("{folder}/{filename}")
        };

        let create_body = serde_json::json!({
            "title": title,
            "tags": params.tags,
            "aliases": params.aliases,
            "body": params.body,
        });
        let mut value = self
            .client
            .post_json(&pages_url(&path), &create_body)
            .await
            .map_err(|e| e.to_string())?;

        // Declaring kind/project happens through the assign endpoint so the
        // server owns frontmatter rewriting and any folder reconciliation.
        if params.kind.is_some() || params.project.is_some() {
            let created_path = value
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or(&path)
                .to_string();
            let assign_body = serde_json::json!({
                "kind": params.kind.as_ref().map(|_| kind.as_str()),
                "project": params.project,
                "clear_project": false,
            });
            value = self
                .client
                .post_json(
                    &format!(
                        "/api/vault/pages-assign/{}",
                        encode_vault_path(&created_path)
                    ),
                    &assign_body,
                )
                .await
                .map_err(|e| {
                    format!(
                        "page was created at {created_path}, but declaring kind/project \
                         failed: {e}"
                    )
                })?;
        }

        truncate_body(&mut value, MAX_BODY_BYTES);
        render(&value)
    }

    #[tool(
        name = "vault_update_page",
        description = "Replace whole fields of a page: title, tags, aliases, and/or body. Omitted fields keep their current values; provided lists replace the existing lists entirely. For targeted body changes prefer vault_edit_page or vault_append_page.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    pub async fn vault_update_page(
        &self,
        Parameters(params): Parameters<UpdatePageParams>,
    ) -> Result<String, String> {
        if params.title.is_none()
            && params.tags.is_none()
            && params.aliases.is_none()
            && params.body.is_none()
        {
            return Err(
                "nothing to update — provide at least one of title, tags, aliases, or body"
                    .to_string(),
            );
        }
        let update_body = serde_json::json!({
            "title": params.title,
            "tags": params.tags,
            "aliases": params.aliases,
            "body": params.body,
        });
        let mut value = self
            .client
            .put_json(&pages_url(&params.path), &update_body)
            .await
            .map_err(|e| e.to_string())?;
        truncate_body(&mut value, MAX_BODY_BYTES);
        render(&value)
    }

    #[tool(
        name = "vault_edit_page",
        description = "Make a targeted edit to a page body by exact string replacement. old_string must match the current body exactly and uniquely (or pass replace_all). The preferred tool for editing page content.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    pub async fn vault_edit_page(
        &self,
        Parameters(params): Parameters<EditPageParams>,
    ) -> Result<String, String> {
        let body = self.fetch_body(&params.path).await?;
        let (new_body, replacements) = super::edit::apply_edit(
            &body,
            &params.old_string,
            &params.new_string,
            params.replace_all.unwrap_or(false),
        )?;
        self.client
            .put_json(
                &pages_url(&params.path),
                &serde_json::json!({ "body": new_body }),
            )
            .await
            .map_err(|e| e.to_string())?;
        render(&serde_json::json!({
            "path": params.path,
            "replacements": replacements,
        }))
    }

    #[tool(
        name = "vault_append_page",
        description = "Append markdown to a page — at the end, or at the end of a named heading's section. Safe for concurrent use: retries once if the page changes mid-write.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    pub async fn vault_append_page(
        &self,
        Parameters(params): Parameters<AppendPageParams>,
    ) -> Result<String, String> {
        // The append derives cleanly from a fresh read, so one retry on a
        // concurrent-write conflict is safe; edits never retry because their
        // match context may have changed.
        let mut attempts = 0;
        loop {
            attempts += 1;
            let body = self.fetch_body(&params.path).await?;
            let new_body =
                super::edit::append_to_body(&body, &params.content, params.heading.as_deref())?;
            match self
                .client
                .put_json(
                    &pages_url(&params.path),
                    &serde_json::json!({ "body": new_body }),
                )
                .await
            {
                Ok(_) => {
                    return render(&serde_json::json!({
                        "path": params.path,
                        "appended": true,
                        "heading": params.heading,
                    }));
                }
                Err(e) if e.is_conflict() && attempts < 2 => continue,
                Err(e) => return Err(e.to_string()),
            }
        }
    }

    #[tool(
        name = "vault_journal_capture",
        description = "Quick-capture markdown into today's journal page (journals/YYYY-MM-DD.md), creating it if needed. The inbox verb: use for fleeting notes and log entries; use vault_create_page for substantial standalone content.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    pub async fn vault_journal_capture(
        &self,
        Parameters(params): Parameters<JournalCaptureParams>,
    ) -> Result<String, String> {
        let mut value = self
            .client
            .post_json(
                "/api/vault/journal/today/capture",
                &serde_json::json!({ "content": params.content }),
            )
            .await
            .map_err(|e| e.to_string())?;
        truncate_body(&mut value, MAX_BODY_BYTES);
        render(&value)
    }

    /// Fetch the current full (untruncated) body of a page for read-modify-
    /// write tools.
    async fn fetch_body(&self, path: &str) -> Result<String, String> {
        let value = self
            .client
            .get_json(&pages_url(path), &[])
            .await
            .map_err(|e| e.to_string())?;
        value
            .get("body")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("page response for {path} carried no body field"))
    }
}

#[tool_handler]
impl ServerHandler for VaultMcpServer {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        let mut info = rmcp::model::ServerInfo::new(
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .build(),
        );
        info.server_info =
            rmcp::model::Implementation::new("clepsydra-vault", env!("CARGO_PKG_VERSION"));
        info.instructions = Some(
            "Work with a clepsydra vault (a markdown personal knowledge base) through its \
             running server. Orient with vault_tree and vault_tags, locate pages with \
             vault_search or vault_list_pages, read them with vault_get_page, and explore \
             relationships with vault_links. Create pages with vault_create_page (search \
             first to avoid duplicates), make targeted edits with vault_edit_page or \
             vault_append_page, and quick-capture into today's journal with \
             vault_journal_capture. Page paths are vault-relative; page kinds (NOTE, \
             PROJECT, JOURNAL, ...) map to canonical top-level folders. On a conflict \
             error, re-read the page and re-apply the change."
                .to_string(),
        );
        info
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use serde_json::json;

    use super::*;

    #[test]
    fn truncate_body_leaves_small_bodies_alone() {
        let mut value = json!({"body": "short", "path": "a.md"});
        truncate_body(&mut value, 100);
        assert_eq!(value["body"], "short");
        assert!(value.get("body_truncated").is_none());
    }

    #[test]
    fn truncate_body_cuts_and_flags_large_bodies() {
        let mut value = json!({"body": "x".repeat(200)});
        truncate_body(&mut value, 100);
        assert_eq!(value["body"].as_str().unwrap().len(), 100);
        assert_eq!(value["body_truncated"], true);
    }

    #[test]
    fn truncate_body_respects_char_boundaries() {
        // 'é' is 2 bytes; an odd cut point must back off to a boundary.
        let mut value = json!({"body": "é".repeat(60)});
        truncate_body(&mut value, 99);
        assert_eq!(value["body"].as_str().unwrap().len(), 98);
        assert_eq!(value["body_truncated"], true);
    }

    #[test]
    fn tool_router_exposes_the_read_and_write_surface() {
        let router = VaultMcpServer::tool_router();
        let mut names: Vec<String> = router
            .list_all()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "vault_append_page",
                "vault_create_page",
                "vault_edit_page",
                "vault_get_page",
                "vault_journal_capture",
                "vault_links",
                "vault_list_pages",
                "vault_search",
                "vault_tags",
                "vault_tree",
                "vault_update_page",
            ]
        );
    }

    /// Spin the real API router over a seeded temp vault on an ephemeral port
    /// and return a `VaultMcpServer` pointed at it. The `TempDir` keeps the
    /// vault alive for the test's duration.
    async fn serve_seeded_vault() -> (VaultMcpServer, tempfile::TempDir) {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();

        let notes = root.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(
            notes.join("alpha.md"),
            "---\nid: 0190f8a0-0000-7000-8000-0000000000a1\ntitle: Alpha\ntags:\n  - testing\n---\n\nzanzibar content linking to [[Beta]].\n",
        )
        .unwrap();
        std::fs::write(
            notes.join("beta.md"),
            "---\nid: 0190f8a0-0000-7000-8000-0000000000b2\ntitle: Beta\ntags:\n  - testing\n---\n\nbeta body.\n",
        )
        .unwrap();

        let state = crate::build_app_state(&root).await.unwrap();
        let app = crate::build_router(state, 1024 * 1024, true);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = ApiClient::new(format!("http://{addr}"), None).unwrap();
        (VaultMcpServer::new(Arc::new(client)), tmp)
    }

    fn parse(result: Result<String, String>) -> Value {
        serde_json::from_str(&result.expect("tool call should succeed")).unwrap()
    }

    #[tokio::test]
    async fn search_finds_seeded_content() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(
            server
                .vault_search(Parameters(SearchParams {
                    query: "zanzibar".to_string(),
                    limit: None,
                }))
                .await,
        );
        let hits = value.as_array().expect("search returns an array");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["path"], "notes/alpha.md");
    }

    #[tokio::test]
    async fn get_page_returns_meta_and_body() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(
            server
                .vault_get_page(Parameters(GetPageParams {
                    path: Some("notes/alpha.md".to_string()),
                    id: None,
                }))
                .await,
        );
        assert_eq!(value["meta"]["title"], "Alpha");
        assert_eq!(value["kind"], "NOTE");
        assert!(value["body"].as_str().unwrap().contains("zanzibar"));
    }

    #[tokio::test]
    async fn get_page_by_id_resolves() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(
            server
                .vault_get_page(Parameters(GetPageParams {
                    path: None,
                    id: Some("0190f8a0-0000-7000-8000-0000000000b2".to_string()),
                }))
                .await,
        );
        assert_eq!(value["meta"]["title"], "Beta");
    }

    #[tokio::test]
    async fn get_page_requires_exactly_one_address() {
        let (server, _tmp) = serve_seeded_vault().await;
        let err = server
            .vault_get_page(Parameters(GetPageParams {
                path: None,
                id: None,
            }))
            .await
            .expect_err("no address should be rejected");
        assert!(err.contains("exactly one"));
    }

    #[tokio::test]
    async fn get_missing_page_carries_search_hint() {
        let (server, _tmp) = serve_seeded_vault().await;
        let err = server
            .vault_get_page(Parameters(GetPageParams {
                path: Some("notes/nope.md".to_string()),
                id: None,
            }))
            .await
            .expect_err("missing page should error");
        assert!(err.contains("404"), "unexpected error: {err}");
        assert!(err.contains("vault_search"), "missing hint: {err}");
    }

    #[tokio::test]
    async fn list_pages_paginates() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(
            server
                .vault_list_pages(Parameters(ListPagesParams {
                    limit: Some(1),
                    offset: Some(0),
                }))
                .await,
        );
        assert_eq!(value["items"].as_array().unwrap().len(), 1);
        assert_eq!(value["total"], 2);
    }

    #[tokio::test]
    async fn tree_lists_the_notes_folder() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(
            server
                .vault_tree(Parameters(TreeParams { path: None }))
                .await,
        );
        let rendered = value.to_string();
        assert!(
            rendered.contains("notes"),
            "tree missing notes/: {rendered}"
        );
    }

    #[tokio::test]
    async fn backlinks_of_beta_include_alpha() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(
            server
                .vault_links(Parameters(LinksParams {
                    path: "notes/beta.md".to_string(),
                    direction: LinkDirection::Backlinks,
                }))
                .await,
        );
        let rendered = value.to_string();
        assert!(
            rendered.contains("notes/alpha.md"),
            "backlinks missing alpha: {rendered}"
        );
    }

    #[tokio::test]
    async fn tags_report_the_seeded_vocabulary() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(server.vault_tags().await);
        let tags = value.as_array().unwrap();
        assert!(
            tags.iter()
                .any(|t| t["tag"] == "testing" && t["count"] == 2),
            "expected 'testing' tag with count 2: {value}"
        );
    }

    fn create_params(title: &str) -> CreatePageParams {
        CreatePageParams {
            title: title.to_string(),
            kind: None,
            folder: None,
            body: None,
            tags: None,
            aliases: None,
            project: None,
        }
    }

    #[tokio::test]
    async fn create_page_defaults_to_the_notes_folder() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(
            server
                .vault_create_page(Parameters(CreatePageParams {
                    body: Some("fresh body".to_string()),
                    tags: Some(vec!["testing".to_string()]),
                    ..create_params("Fresh Note")
                }))
                .await,
        );
        let path = value["path"].as_str().unwrap();
        assert!(path.starts_with("notes/"), "unexpected path: {path}");
        let filename = path.rsplit('/').next().unwrap();
        assert!(
            crate::vault::path::is_canonical_page_filename(filename),
            "filename not canonical: {filename}"
        );
        assert_eq!(value["meta"]["title"], "Fresh Note");
        assert_eq!(value["body"], "fresh body");

        // The created page is immediately readable back through the API.
        let read = parse(
            server
                .vault_get_page(Parameters(GetPageParams {
                    path: Some(path.to_string()),
                    id: None,
                }))
                .await,
        );
        assert_eq!(read["meta"]["title"], "Fresh Note");
    }

    #[tokio::test]
    async fn create_page_with_kind_files_under_canonical_folder_and_declares_it() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(
            server
                .vault_create_page(Parameters(CreatePageParams {
                    kind: Some("quote".to_string()),
                    body: Some("wise words".to_string()),
                    ..create_params("A Quote")
                }))
                .await,
        );
        assert!(
            value["path"].as_str().unwrap().starts_with("quotes/"),
            "unexpected path: {}",
            value["path"]
        );
        assert_eq!(value["kind"], "QUOTE");
        // Declared via assign, not inferred from the folder.
        assert_eq!(value["inferred"], false);
    }

    #[tokio::test]
    async fn create_page_with_project_declares_the_project() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(
            server
                .vault_create_page(Parameters(CreatePageParams {
                    project: Some("skunkworks".to_string()),
                    ..create_params("Project Note")
                }))
                .await,
        );
        assert_eq!(value["project"], "skunkworks");
    }

    #[tokio::test]
    async fn create_page_rejects_unknown_kind_and_lists_the_vocabulary() {
        let (server, _tmp) = serve_seeded_vault().await;
        let err = server
            .vault_create_page(Parameters(CreatePageParams {
                kind: Some("recipe".to_string()),
                ..create_params("X")
            }))
            .await
            .expect_err("unknown kind should be rejected");
        assert!(err.contains("recipe"), "{err}");
        assert!(err.contains("QUOTE"), "should list valid kinds: {err}");
    }

    #[tokio::test]
    async fn create_page_rejects_empty_title() {
        let (server, _tmp) = serve_seeded_vault().await;
        let err = server
            .vault_create_page(Parameters(create_params("   ")))
            .await
            .expect_err("empty title should be rejected");
        assert!(err.contains("title"), "{err}");
    }

    #[tokio::test]
    async fn update_page_merges_only_the_provided_fields() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(
            server
                .vault_update_page(Parameters(UpdatePageParams {
                    path: "notes/alpha.md".to_string(),
                    title: Some("Alpha Renamed".to_string()),
                    tags: None,
                    aliases: None,
                    body: None,
                }))
                .await,
        );
        assert_eq!(value["meta"]["title"], "Alpha Renamed");
        // Untouched fields survive.
        assert!(value["body"].as_str().unwrap().contains("zanzibar"));
        assert_eq!(value["meta"]["tags"][0], "testing");
    }

    #[tokio::test]
    async fn update_page_with_no_fields_is_rejected() {
        let (server, _tmp) = serve_seeded_vault().await;
        let err = server
            .vault_update_page(Parameters(UpdatePageParams {
                path: "notes/alpha.md".to_string(),
                title: None,
                tags: None,
                aliases: None,
                body: None,
            }))
            .await
            .expect_err("empty update should be rejected");
        assert!(err.contains("nothing to update"), "{err}");
    }

    #[tokio::test]
    async fn edit_page_replaces_matched_text() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(
            server
                .vault_edit_page(Parameters(EditPageParams {
                    path: "notes/alpha.md".to_string(),
                    old_string: "zanzibar content".to_string(),
                    new_string: "replaced content".to_string(),
                    replace_all: None,
                }))
                .await,
        );
        assert_eq!(value["replacements"], 1);

        let read = parse(
            server
                .vault_get_page(Parameters(GetPageParams {
                    path: Some("notes/alpha.md".to_string()),
                    id: None,
                }))
                .await,
        );
        let body = read["body"].as_str().unwrap();
        assert!(body.contains("replaced content"), "{body}");
        assert!(!body.contains("zanzibar"), "{body}");
    }

    #[tokio::test]
    async fn edit_page_missing_match_reports_reread_hint() {
        let (server, _tmp) = serve_seeded_vault().await;
        let err = server
            .vault_edit_page(Parameters(EditPageParams {
                path: "notes/alpha.md".to_string(),
                old_string: "not in the page".to_string(),
                new_string: "x".to_string(),
                replace_all: None,
            }))
            .await
            .expect_err("missing match should error");
        assert!(err.contains("not found"), "{err}");
    }

    #[tokio::test]
    async fn append_page_appends_at_the_end() {
        let (server, _tmp) = serve_seeded_vault().await;
        parse(
            server
                .vault_append_page(Parameters(AppendPageParams {
                    path: "notes/beta.md".to_string(),
                    content: "- appended line".to_string(),
                    heading: None,
                }))
                .await,
        );
        let read = parse(
            server
                .vault_get_page(Parameters(GetPageParams {
                    path: Some("notes/beta.md".to_string()),
                    id: None,
                }))
                .await,
        );
        let body = read["body"].as_str().unwrap();
        assert!(body.ends_with("- appended line\n"), "{body:?}");
        assert!(body.contains("beta body."), "{body:?}");
    }

    #[tokio::test]
    async fn append_page_under_a_heading_extends_that_section() {
        let (server, _tmp) = serve_seeded_vault().await;
        server
            .vault_update_page(Parameters(UpdatePageParams {
                path: "notes/beta.md".to_string(),
                title: None,
                tags: None,
                aliases: None,
                body: Some("# Log\n\nfirst\n\n# Done\n\nshipped\n".to_string()),
            }))
            .await
            .unwrap();

        parse(
            server
                .vault_append_page(Parameters(AppendPageParams {
                    path: "notes/beta.md".to_string(),
                    content: "second".to_string(),
                    heading: Some("Log".to_string()),
                }))
                .await,
        );
        let read = parse(
            server
                .vault_get_page(Parameters(GetPageParams {
                    path: Some("notes/beta.md".to_string()),
                    id: None,
                }))
                .await,
        );
        let body = read["body"].as_str().unwrap();
        let log_section = body.split("# Done").next().unwrap();
        assert!(log_section.contains("second"), "{body:?}");
    }

    #[tokio::test]
    async fn journal_capture_writes_todays_page() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(
            server
                .vault_journal_capture(Parameters(JournalCaptureParams {
                    content: "- captured thought".to_string(),
                }))
                .await,
        );
        let path = value["path"].as_str().unwrap();
        assert!(path.starts_with("journals/"), "unexpected path: {path}");
        assert!(value["body"].as_str().unwrap().contains("captured thought"));

        // A second capture appends rather than replacing.
        let value = parse(
            server
                .vault_journal_capture(Parameters(JournalCaptureParams {
                    content: "- another thought".to_string(),
                }))
                .await,
        );
        let body = value["body"].as_str().unwrap();
        assert!(body.contains("captured thought"), "{body:?}");
        assert!(body.contains("another thought"), "{body:?}");
    }

    #[tokio::test]
    async fn unreachable_server_yields_actionable_error() {
        // A bound-then-dropped listener guarantees a dead port.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);

        let client = ApiClient::new(format!("http://{addr}"), None).unwrap();
        let server = VaultMcpServer::new(Arc::new(client));
        let err = server
            .vault_tags()
            .await
            .expect_err("dead server should error");
        assert!(err.contains("clep serve"), "missing start hint: {err}");
    }
}
