//! The MCP tool surface over the vault API.
//!
//! Milestone 1 (read-only): search, page reads, listing, tree, link graph,
//! and tags. Every tool proxies the running HTTP server via [`ApiClient`] and
//! returns the API's JSON as text content; failures come back as tool errors
//! carrying the actionable messages built in `client.rs`.

use std::sync::Arc;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use super::client::{ApiClient, encode_vault_path};

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
            "Read-only access to a clepsydra vault (a markdown personal knowledge base) \
             through its running server. Orient with vault_tree and vault_tags, locate \
             pages with vault_search or vault_list_pages, read them with vault_get_page, \
             and explore relationships with vault_links. Page paths are vault-relative; \
             page kinds (NOTE, PROJECT, JOURNAL, ...) map to canonical top-level folders."
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
    fn tool_router_exposes_the_m1_read_surface() {
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
                "vault_get_page",
                "vault_links",
                "vault_list_pages",
                "vault_search",
                "vault_tags",
                "vault_tree",
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
