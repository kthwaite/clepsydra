//! The MCP tool surface over the vault API.
//!
//! Read tools (M1): search, page reads, listing, tree, link graph, tags.
//! Write tools (M2): create, update, surgical edit, append, journal capture.
//! Organise tools (M3): assign, move, folders, delete (force two-step), and
//! mutation preview.
//! Every tool proxies the running HTTP server via [`ApiClient`] and returns
//! the API's JSON as text content; failures come back as tool errors carrying
//! the actionable messages built in `client.rs`.

use std::sync::Arc;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::client::{ApiClient, encode_vault_path};
use crate::vault::kind::Kind;

/// The `/pages/{path}` endpoint URL for a vault-relative path.
fn pages_url(path: &str) -> String {
    format!("/api/vault/pages/{}", encode_vault_path(path))
}

/// Resolve where a new page lands, enforcing the metadata-projected layout
/// (ADR-0001) so a freshly created page is never in a folder the reconcile
/// sweep would immediately move it out of:
///
/// - declared project => `<kind-folder>/<project>` exactly; no `folder`
///   override is accepted
/// - declared kind (no project) => the kind's canonical folder, or a `folder`
///   beneath it
/// - neither => `folder` free-form, defaulting to `notes`
fn resolve_create_folder(
    declared: Option<Kind>,
    project: Option<&str>,
    folder: Option<&str>,
) -> Result<String, String> {
    let folder = folder
        .map(|f| f.trim().trim_matches('/').to_string())
        .filter(|f| !f.is_empty());
    let base = declared.unwrap_or(Kind::Note).canonical_folder();

    if let Some(project) = project {
        let projected = format!("{base}/{project}");
        return match folder {
            None => Ok(projected),
            Some(f) if f == projected => Ok(projected),
            Some(f) => Err(format!(
                "'folder' \"{f}\" cannot be combined with project \"{project}\" — a declared \
                 project files the page under {projected}/ (the vault relocates it there); \
                 omit 'folder'"
            )),
        };
    }

    if let Some(declared) = declared {
        let canonical = declared.canonical_folder();
        return match folder {
            None => Ok(canonical.to_string()),
            Some(f) if f == canonical || f.starts_with(&format!("{canonical}/")) => Ok(f),
            Some(f) => Err(format!(
                "'folder' \"{f}\" conflicts with kind {kind}: declared {kind} pages live under \
                 {canonical}/ (the vault relocates them there) — use a subfolder like \
                 \"{canonical}/...\" or omit 'folder'",
                kind = declared.as_str(),
            )),
        };
    }

    Ok(folder.unwrap_or_else(|| base.to_string()))
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
    /// Only pages of this resolved kind (NOTE, PROJECT, JOURNAL, TODO, QUOTE,
    /// BOOK, CAPTURE, CODE, PERSON, TASK, CYCLE).
    pub kind: Option<String>,
    /// Only pages carrying this exact tag.
    pub tag: Option<String>,
    /// Only pages declaring this exact project.
    pub project: Option<String>,
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
    /// Folder override, vault-relative. With a declared kind it must be the
    /// kind's canonical folder or a subfolder beneath it (e.g. `notes/drafts`
    /// for NOTE); it cannot be combined with 'project'. Defaults to the
    /// kind's canonical folder (notes, quotes, journals, ...), or
    /// `<kind-folder>/<project>` when a project is declared.
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

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AssignParams {
    /// Page paths to assign. One path returns the updated page; several paths
    /// use the bulk endpoint and report per-path successes and failures.
    pub paths: Vec<String>,
    /// Kind token to declare in frontmatter (NOTE, PROJECT, JOURNAL, TODO,
    /// QUOTE, BOOK, CAPTURE, CODE, PERSON, TASK, CYCLE).
    pub kind: Option<String>,
    /// Project to declare in frontmatter.
    pub project: Option<String>,
    /// Clear the project instead (takes precedence over 'project').
    pub clear_project: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MovePageParams {
    /// Current vault-relative page path.
    pub path: String,
    /// Full destination path including the filename
    /// (e.g. `archive/20260803.old-note.a1b2c3d4.md`).
    pub destination: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum FolderAction {
    /// Create the folder (and any missing parents).
    Create,
    /// Delete the folder; non-empty folders need `recursive: true`.
    Delete,
    /// Move/rename the folder to `destination`, rewriting inbound links.
    Move,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FolderParams {
    /// What to do: create, delete, or move.
    pub action: FolderAction,
    /// Vault-relative folder path.
    pub path: String,
    /// Destination folder path (required for 'move').
    pub destination: Option<String>,
    /// For 'delete': also delete contained pages and subfolders.
    pub recursive: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RewriteMode {
    /// Replace inbound wikilinks with the page's plain-text name.
    PlainText,
    /// Keep the link text but strip the wikilink brackets.
    Unlink,
    /// Leave inbound wikilinks untouched (they become unresolved).
    None,
}

impl RewriteMode {
    fn as_str(&self) -> &'static str {
        match self {
            RewriteMode::PlainText => "plain_text",
            RewriteMode::Unlink => "unlink",
            RewriteMode::None => "none",
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeletePageParams {
    /// Vault-relative page path.
    pub path: String,
    /// Delete even when other pages link here, rewriting those links per
    /// 'rewrite'. Without it, a page with backlinks refuses to delete and
    /// returns the backlink list for review.
    pub force: Option<bool>,
    /// How inbound wikilinks are rewritten on a forced delete
    /// (default plain_text).
    pub rewrite: Option<RewriteMode>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PreviewOperation {
    /// Preview moving a page to 'destination'.
    MovePage,
    /// Preview deleting a page (honors 'rewrite').
    DeletePage,
    /// Preview moving a folder to 'destination'.
    MoveFolder,
}

impl PreviewOperation {
    fn as_str(&self) -> &'static str {
        match self {
            PreviewOperation::MovePage => "move_page",
            PreviewOperation::DeletePage => "delete_page",
            PreviewOperation::MoveFolder => "move_folder",
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct PreviewMutationParams {
    /// The mutation to preview.
    pub operation: PreviewOperation,
    /// Source page or folder path.
    pub source: String,
    /// Destination path (moves only).
    pub destination: Option<String>,
    /// Link rewrite mode (delete_page only; default plain_text).
    pub rewrite: Option<RewriteMode>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ConversationRoleParam {
    User,
    Assistant,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct CaptureConversationTurnParams {
    /// Visible participant role. System/developer/tool turns are not accepted.
    pub role: ConversationRoleParam,
    /// Exact visible turn content as Markdown; do not summarize.
    pub content: String,
    pub source_turn_id: Option<String>,
    pub timestamp: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct CaptureConversationParams {
    pub title: String,
    pub provider: Option<String>,
    pub host_conversation_id: Option<String>,
    pub turns: Vec<CaptureConversationTurnParams>,
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
        description = "List pages (path-ordered) with id, path, title, canonical name, kind, project, and tags, optionally filtered by kind, tag, and/or project. Paginated via limit/offset; the response's total field reports the full filtered count.",
        annotations(read_only_hint = true, idempotent_hint = true)
    )]
    pub async fn vault_list_pages(
        &self,
        Parameters(params): Parameters<ListPagesParams>,
    ) -> Result<String, String> {
        if let Some(token) = &params.kind
            && Kind::from_token(token).is_none()
        {
            return Err(format!(
                "unknown kind \"{token}\" — valid kinds: {KIND_TOKENS}"
            ));
        }
        let mut query = vec![
            (
                "limit",
                params.limit.unwrap_or(DEFAULT_LIST_LIMIT).to_string(),
            ),
            ("offset", params.offset.unwrap_or(0).to_string()),
        ];
        if let Some(kind) = params.kind {
            query.push(("kind", kind));
        }
        if let Some(tag) = params.tag {
            query.push(("tag", tag));
        }
        if let Some(project) = params.project {
            query.push(("project", project));
        }
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
        description = "Create a new page in one atomic call; kind/project are declared as part of the create itself. The canonical filename (yyyymmdd.slug.shortid.md) is derived from the title — never construct paths by hand. A declared kind files under its canonical folder ('folder' may only choose a subfolder beneath it); a declared project files under <kind-folder>/<project> and takes no 'folder' override. Search first (vault_search) to avoid duplicates. Returns the created page, including the path for follow-up calls.",
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
        let declared =
            match &params.kind {
                Some(token) => Some(Kind::from_token(token).ok_or_else(|| {
                    format!("unknown kind \"{token}\" — valid kinds: {KIND_TOKENS}")
                })?),
                None => None,
            };
        let folder = resolve_create_folder(
            declared,
            params.project.as_deref(),
            params.folder.as_deref(),
        )?;

        let filename = crate::vault::page_filename::page_filename(
            chrono::Utc::now(),
            title,
            &crate::vault::block_id::generate_short_id(),
        );
        let path = format!("{folder}/{filename}");

        // Kind/project ride the create request itself, so the page never
        // exists half-assigned and a failed create leaves nothing behind.
        let create_body = serde_json::json!({
            "title": title,
            "tags": params.tags,
            "aliases": params.aliases,
            "body": params.body,
            "kind": declared.map(Kind::as_str),
            "project": params.project,
        });
        let mut value = self
            .client
            .post_json(&pages_url(&path), &create_body)
            .await
            .map_err(|e| e.to_string())?;
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
        let current = self.fetch_page(&params.path).await?;
        let revision = Self::page_field(&current, &params.path, "revision")?;
        let update_body = serde_json::json!({
            "expected_revision": revision,
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
        let current = self.fetch_page(&params.path).await?;
        let body = Self::page_field(&current, &params.path, "body")?;
        let revision = Self::page_field(&current, &params.path, "revision")?;
        let (new_body, replacements) = super::edit::apply_edit(
            &body,
            &params.old_string,
            &params.new_string,
            params.replace_all.unwrap_or(false),
        )?;
        // The revision this edit was computed against travels with the write,
        // so a concurrent change surfaces as a 409 instead of being silently
        // overwritten.
        self.client
            .put_json(
                &pages_url(&params.path),
                &serde_json::json!({ "body": new_body, "expected_revision": revision }),
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
            let current = self.fetch_page(&params.path).await?;
            let body = Self::page_field(&current, &params.path, "body")?;
            let revision = Self::page_field(&current, &params.path, "revision")?;
            let new_body =
                super::edit::append_to_body(&body, &params.content, params.heading.as_deref())?;
            match self
                .client
                .put_json(
                    &pages_url(&params.path),
                    &serde_json::json!({ "body": new_body, "expected_revision": revision }),
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

    #[tool(
        name = "vault_capture_conversation",
        description = "Capture the complete visible user/assistant conversation as an AI_CONVERSATION Folio. Send ordered turns verbatim, not a summary. Clepsydra creates once and appends only when provider + host_conversation_id identify an exact existing capture; truncated or divergent context conflicts rather than guessing. Hidden system/developer prompts and tool traces are not accepted.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    pub async fn vault_capture_conversation(
        &self,
        Parameters(params): Parameters<CaptureConversationParams>,
    ) -> Result<String, String> {
        let value = self
            .client
            .post_json(
                "/api/vault/conversations/capture",
                &serde_json::to_value(params).map_err(|e| e.to_string())?,
            )
            .await
            .map_err(|e| e.to_string())?;
        render(&value)
    }

    #[tool(
        name = "vault_assign",
        description = "File pages by declaring kind and/or project in frontmatter — the vault then relocates each file to its canonical folder automatically. THE preferred way to organise pages (use vault_move_page only for destinations assignment can't express). Accepts one path or many; bulk runs report per-path failures without aborting.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    pub async fn vault_assign(
        &self,
        Parameters(params): Parameters<AssignParams>,
    ) -> Result<String, String> {
        if params.paths.is_empty() {
            return Err("provide at least one page path in 'paths'".to_string());
        }
        let clear_project = params.clear_project.unwrap_or(false);
        if params.kind.is_none() && params.project.is_none() && !clear_project {
            return Err(
                "nothing to assign — provide 'kind', 'project', and/or clear_project: true"
                    .to_string(),
            );
        }
        // Validate the kind token locally for a message that lists the
        // vocabulary; the server would reject it with less context.
        let kind = match &params.kind {
            Some(token) => Some(
                Kind::from_token(token)
                    .ok_or_else(|| {
                        format!("unknown kind \"{token}\" — valid kinds: {KIND_TOKENS}")
                    })?
                    .as_str(),
            ),
            None => None,
        };
        let assign_body = serde_json::json!({
            "kind": kind,
            "project": params.project,
            "clear_project": clear_project,
        });

        if let [path] = params.paths.as_slice() {
            let mut value = self
                .client
                .post_json(
                    &format!("/api/vault/pages-assign/{}", encode_vault_path(path)),
                    &assign_body,
                )
                .await
                .map_err(|e| e.to_string())?;
            truncate_body(&mut value, MAX_BODY_BYTES);
            render(&value)
        } else {
            let mut bulk_body = assign_body;
            bulk_body["paths"] = serde_json::json!(params.paths);
            let value = self
                .client
                .post_json("/api/vault/pages-assign-bulk", &bulk_body)
                .await
                .map_err(|e| e.to_string())?;
            render(&value)
        }
    }

    #[tool(
        name = "vault_move_page",
        description = "Move/rename a page to an explicit destination path (including filename). Inbound wikilinks keep resolving. Prefer vault_assign for kind/project filing — it computes the destination for you. Preview link impact first with vault_preview_mutation.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    pub async fn vault_move_page(
        &self,
        Parameters(params): Parameters<MovePageParams>,
    ) -> Result<String, String> {
        let mut value = self
            .client
            .post_json(
                &format!("/api/vault/pages-move/{}", encode_vault_path(&params.path)),
                &serde_json::json!({ "destination": params.destination }),
            )
            .await
            .map_err(|e| e.to_string())?;
        truncate_body(&mut value, MAX_BODY_BYTES);
        render(&value)
    }

    #[tool(
        name = "vault_folder",
        description = "Create, delete, or move a folder. Deleting a non-empty folder requires recursive: true and deletes its pages — preview with vault_tree first. Moving a folder relocates its pages and rewrites inbound links.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false
        )
    )]
    pub async fn vault_folder(
        &self,
        Parameters(params): Parameters<FolderParams>,
    ) -> Result<String, String> {
        let encoded = encode_vault_path(&params.path);
        match params.action {
            FolderAction::Create => {
                let value = self
                    .client
                    .post_json(
                        &format!("/api/vault/folders/{encoded}"),
                        &serde_json::json!({}),
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                render(&value)
            }
            FolderAction::Delete => {
                let recursive = params.recursive.unwrap_or(false);
                self.client
                    .delete_json(
                        &format!("/api/vault/folders/{encoded}"),
                        &[("recursive", recursive.to_string())],
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                render(&serde_json::json!({
                    "deleted": params.path,
                    "recursive": recursive,
                }))
            }
            FolderAction::Move => {
                let destination = params.destination.as_deref().ok_or(
                    "folder move needs a 'destination' — the new vault-relative folder path",
                )?;
                self.client
                    .post_json(
                        &format!("/api/vault/folders-move/{encoded}"),
                        &serde_json::json!({ "destination": destination }),
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                render(&serde_json::json!({
                    "moved": params.path,
                    "destination": destination,
                }))
            }
        }
    }

    #[tool(
        name = "vault_delete_page",
        description = "Delete a page. Without force, a page that other pages link to refuses to delete and returns its backlinks — review them (with the user for anything load-bearing) before re-running with force: true, which rewrites those links per 'rewrite'. vault_preview_mutation shows the exact impact first.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false
        )
    )]
    pub async fn vault_delete_page(
        &self,
        Parameters(params): Parameters<DeletePageParams>,
    ) -> Result<String, String> {
        let rewrite = params.rewrite.unwrap_or(RewriteMode::PlainText);
        self.client
            .delete_json(
                &pages_url(&params.path),
                &[
                    ("force", params.force.unwrap_or(false).to_string()),
                    ("rewrite", rewrite.as_str().to_string()),
                ],
            )
            .await
            .map_err(|e| e.to_string())?;
        render(&serde_json::json!({
            "deleted": params.path,
            "rewrite": rewrite.as_str(),
        }))
    }

    #[tool(
        name = "vault_preview_mutation",
        description = "Dry-run a move or delete: returns the mutation plan — file operations and every wikilink rewrite it would perform — without changing anything. Use before bulk reorganisation, deletes of linked pages, or folder moves.",
        annotations(read_only_hint = true, idempotent_hint = true)
    )]
    pub async fn vault_preview_mutation(
        &self,
        Parameters(params): Parameters<PreviewMutationParams>,
    ) -> Result<String, String> {
        if matches!(
            params.operation,
            PreviewOperation::MovePage | PreviewOperation::MoveFolder
        ) && params.destination.is_none()
        {
            return Err("this operation needs a 'destination'".to_string());
        }
        let value = self
            .client
            .post_json(
                "/api/vault/index/preview-mutation",
                &serde_json::json!({
                    "operation": params.operation.as_str(),
                    "source": params.source,
                    "destination": params.destination.unwrap_or_default(),
                    "rewrite": params
                        .rewrite
                        .unwrap_or(RewriteMode::PlainText)
                        .as_str(),
                }),
            )
            .await
            .map_err(|e| e.to_string())?;
        render(&value)
    }

    /// Fetch the current full page response for a read-modify-write tool.
    async fn fetch_page(&self, path: &str) -> Result<Value, String> {
        self.client
            .get_json(&pages_url(path), &[])
            .await
            .map_err(|e| e.to_string())
    }

    /// Extract a required string field from a page response.
    fn page_field(value: &Value, path: &str, field: &str) -> Result<String, String> {
        value
            .get(field)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("page response for {path} carried no {field} field"))
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
             vault_journal_capture. When a user asks to send this conversation to Clepsydra, \
             use vault_capture_conversation: supply every complete visible user/assistant turn \
             in order, verbatim; generic vault_create_page is not the conversation-capture path. \
             Organise by declaring kind/project with vault_assign (the vault relocates files \
             itself); vault_preview_mutation dry-runs moves and deletes before they touch linked \
             pages. Page paths are vault-relative; page kinds (NOTE, PROJECT, JOURNAL, ...) map \
             to canonical top-level folders. On a conflict error, re-read the page and re-apply \
             the change."
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
                "vault_assign",
                "vault_capture_conversation",
                "vault_create_page",
                "vault_delete_page",
                "vault_edit_page",
                "vault_folder",
                "vault_get_page",
                "vault_journal_capture",
                "vault_links",
                "vault_list_pages",
                "vault_move_page",
                "vault_preview_mutation",
                "vault_search",
                "vault_tags",
                "vault_tree",
                "vault_update_page",
            ]
        );
    }

    #[test]
    fn capture_conversation_schema_restricts_roles_and_requires_turns() {
        let tool = VaultMcpServer::tool_router()
            .list_all()
            .into_iter()
            .find(|tool| tool.name == "vault_capture_conversation")
            .expect("conversation capture tool should be registered");
        let schema = &*tool.input_schema;
        let role_schema = &schema["$defs"]["ConversationRoleParam"];
        assert_eq!(role_schema["enum"], json!(["user", "assistant"]));
        assert!(
            schema["required"]
                .as_array()
                .is_some_and(|required| required.iter().any(|field| field == "turns")),
            "turns should be required: {schema:?}"
        );
    }

    fn capture_turn(role: ConversationRoleParam, content: &str) -> CaptureConversationTurnParams {
        CaptureConversationTurnParams {
            role,
            content: content.to_string(),
            source_turn_id: None,
            timestamp: None,
        }
    }

    #[tokio::test]
    async fn capture_conversation_creates_then_appends_without_exposing_host_id() {
        let (server, _tmp) = serve_seeded_vault().await;
        let params = CaptureConversationParams {
            title: "MCP transcript".into(),
            provider: Some("claude".into()),
            host_conversation_id: Some("mcp-host-id".into()),
            turns: vec![
                capture_turn(ConversationRoleParam::User, "Question"),
                capture_turn(ConversationRoleParam::Assistant, "Answer"),
            ],
        };

        let created = server
            .vault_capture_conversation(Parameters(params))
            .await
            .expect("first capture should succeed");
        assert!(created.contains(r#""operation": "created""#), "{created}");
        assert!(!created.contains("mcp-host-id"), "{created}");

        let appended = server
            .vault_capture_conversation(Parameters(CaptureConversationParams {
                title: "MCP transcript".into(),
                provider: Some("claude".into()),
                host_conversation_id: Some("mcp-host-id".into()),
                turns: vec![
                    capture_turn(ConversationRoleParam::User, "Question"),
                    capture_turn(ConversationRoleParam::Assistant, "Answer"),
                    capture_turn(ConversationRoleParam::User, "Follow-up"),
                ],
            }))
            .await
            .expect("second capture should append");
        assert!(appended.contains(r#""operation": "appended""#), "{appended}");
        assert!(!appended.contains("mcp-host-id"), "{appended}");
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
                    kind: None,
                    tag: None,
                    project: None,
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
    async fn create_page_with_project_files_under_the_project_subfolder() {
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
        assert!(
            value["path"]
                .as_str()
                .unwrap()
                .starts_with("notes/skunkworks/"),
            "project pages live under <kind-folder>/<project>: {}",
            value["path"]
        );
    }

    #[tokio::test]
    async fn create_page_folder_must_sit_under_a_declared_kinds_canonical_folder() {
        let (server, _tmp) = serve_seeded_vault().await;
        let err = server
            .vault_create_page(Parameters(CreatePageParams {
                kind: Some("quote".to_string()),
                folder: Some("drafts".to_string()),
                ..create_params("Misfiled Quote")
            }))
            .await
            .expect_err("conflicting folder should be rejected");
        assert!(err.contains("quotes"), "{err}");

        let value = parse(
            server
                .vault_create_page(Parameters(CreatePageParams {
                    kind: Some("quote".to_string()),
                    folder: Some("quotes/stoics".to_string()),
                    ..create_params("Filed Quote")
                }))
                .await,
        );
        assert!(
            value["path"]
                .as_str()
                .unwrap()
                .starts_with("quotes/stoics/"),
            "subfolder beneath the canonical folder is allowed: {}",
            value["path"]
        );
        assert_eq!(value["kind"], "QUOTE");
        assert_eq!(value["inferred"], false);
    }

    #[tokio::test]
    async fn create_page_rejects_folder_combined_with_project() {
        let (server, _tmp) = serve_seeded_vault().await;
        let err = server
            .vault_create_page(Parameters(CreatePageParams {
                project: Some("skunkworks".to_string()),
                folder: Some("drafts".to_string()),
                ..create_params("X")
            }))
            .await
            .expect_err("folder+project should be rejected");
        assert!(err.contains("notes/skunkworks"), "{err}");
    }

    #[tokio::test]
    async fn stale_revision_is_rejected_instead_of_overwriting() {
        let (server, _tmp) = serve_seeded_vault().await;
        // A reader captures the page revision...
        let stale_page = server.fetch_page("notes/alpha.md").await.unwrap();
        let stale_revision =
            VaultMcpServer::page_field(&stale_page, "notes/alpha.md", "revision").unwrap();
        // ...then another writer changes the page...
        server
            .vault_update_page(Parameters(UpdatePageParams {
                path: "notes/alpha.md".to_string(),
                title: None,
                tags: None,
                aliases: None,
                body: Some("rewritten by someone else\n".to_string()),
            }))
            .await
            .unwrap();
        // ...so a write carrying the stale revision must 409, not clobber.
        let err = server
            .client
            .put_json(
                &pages_url("notes/alpha.md"),
                &serde_json::json!({
                    "body": "based on a stale read",
                    "expected_revision": stale_revision,
                }),
            )
            .await
            .expect_err("stale revision should conflict");
        assert!(err.is_conflict(), "expected 409, got: {err}");

        let current = server.fetch_page("notes/alpha.md").await.unwrap();
        let body = VaultMcpServer::page_field(&current, "notes/alpha.md", "body").unwrap();
        assert_eq!(body, "rewritten by someone else\n", "no lost update");
    }

    #[tokio::test]
    async fn list_pages_filters_by_tag_kind_and_project() {
        let (server, _tmp) = serve_seeded_vault().await;
        server
            .vault_create_page(Parameters(CreatePageParams {
                kind: Some("quote".to_string()),
                project: None,
                ..create_params("Filter Target")
            }))
            .await
            .unwrap();
        server
            .vault_create_page(Parameters(CreatePageParams {
                project: Some("skunkworks".to_string()),
                ..create_params("Project Page")
            }))
            .await
            .unwrap();

        let by_tag = parse(
            server
                .vault_list_pages(Parameters(ListPagesParams {
                    limit: None,
                    offset: None,
                    kind: None,
                    tag: Some("testing".to_string()),
                    project: None,
                }))
                .await,
        );
        assert_eq!(by_tag["total"], 2, "alpha and beta carry 'testing'");

        let by_kind = parse(
            server
                .vault_list_pages(Parameters(ListPagesParams {
                    limit: None,
                    offset: None,
                    kind: Some("quote".to_string()),
                    tag: None,
                    project: None,
                }))
                .await,
        );
        assert_eq!(by_kind["total"], 1);
        assert_eq!(by_kind["items"][0]["title"], "Filter Target");

        let by_project = parse(
            server
                .vault_list_pages(Parameters(ListPagesParams {
                    limit: None,
                    offset: None,
                    kind: None,
                    tag: None,
                    project: Some("skunkworks".to_string()),
                }))
                .await,
        );
        assert_eq!(by_project["total"], 1);
        assert_eq!(by_project["items"][0]["title"], "Project Page");

        let err = server
            .vault_list_pages(Parameters(ListPagesParams {
                limit: None,
                offset: None,
                kind: Some("recipe".to_string()),
                tag: None,
                project: None,
            }))
            .await
            .expect_err("unknown kind filter should be rejected");
        assert!(err.contains("QUOTE"), "{err}");
    }

    #[test]
    fn resolve_create_folder_enforces_the_projection_contract() {
        // Free-form when nothing is declared.
        assert_eq!(resolve_create_folder(None, None, None).unwrap(), "notes");
        assert_eq!(
            resolve_create_folder(None, None, Some("scratch/inbox")).unwrap(),
            "scratch/inbox"
        );
        // Declared kind pins the top folder.
        assert_eq!(
            resolve_create_folder(Some(Kind::Quote), None, None).unwrap(),
            "quotes"
        );
        assert_eq!(
            resolve_create_folder(Some(Kind::Quote), None, Some("quotes/stoics")).unwrap(),
            "quotes/stoics"
        );
        assert!(resolve_create_folder(Some(Kind::Quote), None, Some("drafts")).is_err());
        // Declared project pins the whole path.
        assert_eq!(
            resolve_create_folder(None, Some("clep"), None).unwrap(),
            "notes/clep"
        );
        assert_eq!(
            resolve_create_folder(Some(Kind::Code), Some("clep"), None).unwrap(),
            "code/clep"
        );
        assert_eq!(
            resolve_create_folder(Some(Kind::Code), Some("clep"), Some("code/clep")).unwrap(),
            "code/clep"
        );
        assert!(resolve_create_folder(None, Some("clep"), Some("drafts")).is_err());
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
    async fn assign_single_page_declares_kind_and_relocates() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(
            server
                .vault_assign(Parameters(AssignParams {
                    paths: vec!["notes/alpha.md".to_string()],
                    kind: Some("quote".to_string()),
                    project: None,
                    clear_project: None,
                }))
                .await,
        );
        assert_eq!(value["kind"], "QUOTE");
        assert_eq!(value["inferred"], false);
        assert!(
            value["path"].as_str().unwrap().starts_with("quotes/"),
            "assign should relocate to the canonical folder: {}",
            value["path"]
        );
    }

    #[tokio::test]
    async fn assign_bulk_reports_moves_per_path() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(
            server
                .vault_assign(Parameters(AssignParams {
                    paths: vec!["notes/alpha.md".to_string(), "notes/beta.md".to_string()],
                    kind: Some("TODO".to_string()),
                    project: None,
                    clear_project: None,
                }))
                .await,
        );
        assert_eq!(value["moved"].as_array().unwrap().len(), 2);
        assert_eq!(value["failed"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn assign_requires_something_to_assign() {
        let (server, _tmp) = serve_seeded_vault().await;
        let err = server
            .vault_assign(Parameters(AssignParams {
                paths: vec!["notes/alpha.md".to_string()],
                kind: None,
                project: None,
                clear_project: None,
            }))
            .await
            .expect_err("no-op assign should be rejected");
        assert!(err.contains("nothing to assign"), "{err}");
    }

    #[tokio::test]
    async fn assign_rejects_unknown_kind() {
        let (server, _tmp) = serve_seeded_vault().await;
        let err = server
            .vault_assign(Parameters(AssignParams {
                paths: vec!["notes/alpha.md".to_string()],
                kind: Some("recipe".to_string()),
                project: None,
                clear_project: None,
            }))
            .await
            .expect_err("unknown kind should be rejected");
        assert!(err.contains("QUOTE"), "should list valid kinds: {err}");
    }

    #[tokio::test]
    async fn move_page_relocates_to_the_destination() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(
            server
                .vault_move_page(Parameters(MovePageParams {
                    path: "notes/beta.md".to_string(),
                    destination: "notes/renamed-beta.md".to_string(),
                }))
                .await,
        );
        assert_eq!(value["path"], "notes/renamed-beta.md");

        let err = server
            .vault_get_page(Parameters(GetPageParams {
                path: Some("notes/beta.md".to_string()),
                id: None,
            }))
            .await
            .expect_err("old path should be gone");
        assert!(err.contains("404"), "{err}");
    }

    #[tokio::test]
    async fn folder_create_then_move_then_delete() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(
            server
                .vault_folder(Parameters(FolderParams {
                    action: FolderAction::Create,
                    path: "scratch".to_string(),
                    destination: None,
                    recursive: None,
                }))
                .await,
        );
        assert_eq!(value["path"], "scratch");

        let value = parse(
            server
                .vault_folder(Parameters(FolderParams {
                    action: FolderAction::Move,
                    path: "scratch".to_string(),
                    destination: Some("scratch2".to_string()),
                    recursive: None,
                }))
                .await,
        );
        assert_eq!(value["destination"], "scratch2");

        let value = parse(
            server
                .vault_folder(Parameters(FolderParams {
                    action: FolderAction::Delete,
                    path: "scratch2".to_string(),
                    destination: None,
                    recursive: None,
                }))
                .await,
        );
        assert_eq!(value["deleted"], "scratch2");
    }

    #[tokio::test]
    async fn folder_move_requires_a_destination() {
        let (server, _tmp) = serve_seeded_vault().await;
        let err = server
            .vault_folder(Parameters(FolderParams {
                action: FolderAction::Move,
                path: "notes".to_string(),
                destination: None,
                recursive: None,
            }))
            .await
            .expect_err("move without destination should be rejected");
        assert!(err.contains("destination"), "{err}");
    }

    #[tokio::test]
    async fn folder_delete_of_nonempty_folder_needs_recursive() {
        let (server, _tmp) = serve_seeded_vault().await;
        let err = server
            .vault_folder(Parameters(FolderParams {
                action: FolderAction::Delete,
                path: "notes".to_string(),
                destination: None,
                recursive: None,
            }))
            .await
            .expect_err("non-empty folder delete without recursive should fail");
        assert!(err.contains("409"), "{err}");
    }

    #[tokio::test]
    async fn delete_page_with_backlinks_returns_them_and_asks_for_force() {
        let (server, _tmp) = serve_seeded_vault().await;
        // alpha links to Beta, so beta has a backlink.
        let err = server
            .vault_delete_page(Parameters(DeletePageParams {
                path: "notes/beta.md".to_string(),
                force: None,
                rewrite: None,
            }))
            .await
            .expect_err("backlinked page should refuse deletion");
        assert!(err.contains("backlink"), "{err}");
        assert!(err.contains("notes/alpha.md"), "should list sources: {err}");
        assert!(err.contains("force: true"), "{err}");

        // Forced delete succeeds and the page is gone.
        let value = parse(
            server
                .vault_delete_page(Parameters(DeletePageParams {
                    path: "notes/beta.md".to_string(),
                    force: Some(true),
                    rewrite: None,
                }))
                .await,
        );
        assert_eq!(value["deleted"], "notes/beta.md");
        let err = server
            .vault_get_page(Parameters(GetPageParams {
                path: Some("notes/beta.md".to_string()),
                id: None,
            }))
            .await
            .expect_err("deleted page should 404");
        assert!(err.contains("404"), "{err}");
    }

    #[tokio::test]
    async fn delete_page_without_backlinks_needs_no_force() {
        let (server, _tmp) = serve_seeded_vault().await;
        let value = parse(
            server
                .vault_delete_page(Parameters(DeletePageParams {
                    path: "notes/alpha.md".to_string(),
                    force: None,
                    rewrite: None,
                }))
                .await,
        );
        assert_eq!(value["deleted"], "notes/alpha.md");
    }

    #[tokio::test]
    async fn preview_mutation_reports_a_plan_without_mutating() {
        let (server, _tmp) = serve_seeded_vault().await;
        let result = server
            .vault_preview_mutation(Parameters(PreviewMutationParams {
                operation: PreviewOperation::DeletePage,
                source: "notes/beta.md".to_string(),
                destination: None,
                rewrite: None,
            }))
            .await;
        assert!(result.is_ok(), "preview failed: {result:?}");

        // The preview must not have deleted anything.
        let read = server
            .vault_get_page(Parameters(GetPageParams {
                path: Some("notes/beta.md".to_string()),
                id: None,
            }))
            .await;
        assert!(read.is_ok(), "preview mutated the vault: {read:?}");
    }

    #[tokio::test]
    async fn preview_move_requires_a_destination() {
        let (server, _tmp) = serve_seeded_vault().await;
        let err = server
            .vault_preview_mutation(Parameters(PreviewMutationParams {
                operation: PreviewOperation::MovePage,
                source: "notes/beta.md".to_string(),
                destination: None,
                rewrite: None,
            }))
            .await
            .expect_err("move preview without destination should be rejected");
        assert!(err.contains("destination"), "{err}");
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
