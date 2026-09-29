use std::io::Read;
use std::ops::Range;
use std::path::Path;

use clep_bases::base::{Filter, SortKey, ViewDefinition};
use clep_bases::base_embed::{EmbedOverrides, composed_query_spec, validate_embed_overrides};
use clep_bases::base_render::{RenderSelection, render_base};
use clep_bases::query::{
    GroupRowLimit, QueryContext, QueryOutput, QueryRow, evaluate, project_page_field_value,
    resolve_projection_field,
};
use clep_vault::block::parse_blocks;
use clep_vault::canonical::CanonicalName;
use clep_vault::link::{LinkKind, extract_links};
use clep_vault::page::{Page, parse_frontmatter};
use clep_vault::path::VaultPath;
use pulldown_cmark::{CodeBlockKind, Event, Parser, Tag, TagEnd};
use rusqlite::OptionalExtension;
use serde::Deserialize;

use crate::api::error::ApiError;
use crate::vault::{Vault, index::VaultIndex};

const MAX_MARKDOWN_BYTES: usize = 4 * 1024 * 1024;
const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;
pub(super) const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_ROWS: u32 = 1000;
const MAX_DEPTH: usize = 32;

pub(super) fn unsupported(message: impl Into<String>) -> ApiError {
    ApiError::unprocessable_with_detail(
        message,
        serde_json::json!({"code": "word_export_unavailable"}),
    )
}

// Open every component relative to its already-open parent, refusing symlinks.
// This also prevents an ancestor swap between validation and the actual read.
#[cfg(unix)]
fn open_file(root: &Path, path: &VaultPath) -> Result<std::fs::File, ApiError> {
    use rustix::fs::{Mode, OFlags, open, openat};
    let mut directory = open(
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .map_err(|_| ApiError::forbidden("vault root is not accessible"))?;
    let mut components = path.as_str().split('/').peekable();
    while let Some(component) = components.next() {
        let flags = OFlags::RDONLY
            | OFlags::CLOEXEC
            | OFlags::NOFOLLOW
            | OFlags::NONBLOCK
            | if components.peek().is_some() {
                OFlags::DIRECTORY
            } else {
                OFlags::empty()
            };
        directory = openat(&directory, component, flags, Mode::empty()).map_err(|error| {
            if error == rustix::io::Errno::NOENT {
                ApiError::not_found("export source or attachment was not found")
            } else {
                ApiError::forbidden("export paths must be regular files without symlinks")
            }
        })?;
    }
    let file = std::fs::File::from(directory);
    if !file.metadata().is_ok_and(|metadata| metadata.is_file()) {
        return Err(ApiError::forbidden("export source must be a regular file"));
    }
    Ok(file)
}

#[cfg(windows)]
fn open_file(root: &Path, path: &VaultPath) -> Result<std::fs::File, ApiError> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    // OPEN_REPARSE_POINT prevents dereferencing a link/junction. Excluding
    // FILE_SHARE_DELETE and retaining ancestor handles prevents path swaps.
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const REPARSE_POINT: u32 = 0x400;
    let mut handles = Vec::new();
    let mut absolute = std::path::PathBuf::new();
    let full = root.join(path.as_str());
    for component in full.components() {
        absolute.push(component);
        if !absolute.has_root() {
            continue;
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(3)
            .custom_flags(OPEN_REPARSE_POINT | BACKUP_SEMANTICS)
            .open(&absolute)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    ApiError::not_found("export source or attachment was not found")
                } else {
                    ApiError::forbidden("export path cannot be opened safely")
                }
            })?;
        let metadata = file
            .metadata()
            .map_err(|_| ApiError::forbidden("export path cannot be inspected"))?;
        if metadata.file_attributes() & REPARSE_POINT != 0
            || (absolute != full && !metadata.is_dir())
            || (absolute == full && !metadata.is_file())
        {
            return Err(ApiError::forbidden(
                "export paths must be regular files without reparse points",
            ));
        }
        handles.push(file);
    }
    handles
        .pop()
        .ok_or_else(|| ApiError::forbidden("empty export path"))
}

#[cfg(not(any(unix, windows)))]
fn open_file(_root: &Path, _path: &VaultPath) -> Result<std::fs::File, ApiError> {
    Err(unsupported(
        "secure Word export file access is unavailable on this platform",
    ))
}

fn read_file(vault: &Vault, path: &VaultPath, limit: usize) -> Result<Vec<u8>, ApiError> {
    if path.as_str().split('/').any(|part| {
        part.starts_with('.') || part.contains(':') || part.chars().any(char::is_control)
    }) {
        return Err(ApiError::forbidden(
            "private vault files cannot be exported",
        ));
    }
    let mut bytes = Vec::new();
    open_file(vault.root(), path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unsupported("export source could not be read"))?;
    if bytes.len() > limit {
        return Err(unsupported("export source exceeds the input limit"));
    }
    Ok(bytes)
}

pub(super) fn read_image(
    vault: &Vault,
    reference: &str,
    limit: usize,
) -> Result<Vec<u8>, ApiError> {
    let path = VaultPath::new(reference).map_err(|_| ApiError::forbidden("unsafe image path"))?;
    let extension = Path::new(path.as_str())
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"]
        .iter()
        .any(|allowed| extension.eq_ignore_ascii_case(allowed))
    {
        return Err(unsupported(
            "Word export requires a supported local raster image",
        ));
    }
    // The attachment folder is intentionally excluded from page indexing.
    let attachment = &vault.config().vault.attachment_folder;
    let in_attachments = path
        .as_str()
        .strip_prefix(attachment)
        .is_some_and(|suffix| suffix.starts_with('/'));
    if vault.is_excluded(&path) && !in_attachments {
        return Err(ApiError::forbidden("excluded image cannot be exported"));
    }
    read_file(vault, &path, limit)
}

pub(super) fn read_cas_image(root: &Path, hash: &str, limit: usize) -> Result<Vec<u8>, ApiError> {
    let relative = clep_archive::cas::blob_relative_path(hash)
        .ok_or_else(|| unsupported("invalid CAS image reference"))?;
    let path = VaultPath::new(&relative.to_string_lossy())
        .map_err(|_| unsupported("invalid CAS image path"))?;
    let mut bytes = Vec::new();
    open_file(root, &path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unsupported("CAS image could not be read"))?;
    if bytes.len() > limit {
        return Err(unsupported("CAS image exceeds the export limit"));
    }
    if clep_archive::cas::ContentStore::hash_bytes(&bytes) != hash {
        return Err(unsupported("CAS image content does not match its hash"));
    }
    Ok(bytes)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BaseEmbed {
    base: String,
    view: Option<String>,
    template: Option<String>,
    filter: Option<Filter>,
    sort: Option<Vec<SortKey>>,
    limit: Option<u32>,
    // These are screen-only presentation choices, not selection semantics.
    display: Option<String>,
    width: Option<u32>,
}

pub(super) struct Snapshot<'a> {
    vault: &'a Vault,
    index: &'a VaultIndex,
    today: chrono::NaiveDate,
    stack: Vec<String>,
    remaining: usize,
    next_scope: usize,
}

impl<'a> Snapshot<'a> {
    pub(super) fn new(vault: &'a Vault, index: &'a VaultIndex, today: chrono::NaiveDate) -> Self {
        Self {
            vault,
            index,
            today,
            stack: Vec::new(),
            remaining: MAX_INPUT_BYTES,
            next_scope: 0,
        }
    }

    pub(super) fn page(&mut self, path: VaultPath) -> Result<Page, ApiError> {
        if self.vault.is_excluded(&path) || !path.as_str().ends_with(".md") {
            return Err(ApiError::forbidden(
                "source is not an accessible plaintext vault page",
            ));
        }
        let bytes = read_file(self.vault, &path, self.remaining)?;
        self.remaining -= bytes.len();
        let raw_content =
            String::from_utf8(bytes).map_err(|_| unsupported("page is not valid UTF-8"))?;
        let (meta, body) = parse_frontmatter(&raw_content)
            .map_err(|_| unsupported("page frontmatter is invalid"))?;
        let page = Page {
            path,
            meta,
            body,
            raw_content,
        };
        if page.is_encrypted() {
            return Err(ApiError::forbidden(
                "encrypted pages cannot be exported to Word: decryption keys are available only in the browser",
            ));
        }
        Ok(page)
    }

    pub(super) fn expand(&mut self, page: &Page, body: &str) -> Result<String, ApiError> {
        self.expand_key(page, body, page.path.as_str().to_string())
    }

    fn expand_key(&mut self, page: &Page, body: &str, key: String) -> Result<String, ApiError> {
        if self.stack.len() >= MAX_DEPTH || self.stack.contains(&key) {
            return Err(unsupported(
                "recursive embed cycle or maximum embed depth exceeded",
            ));
        }
        self.stack.push(key);
        let result = self.expand_body(page, body);
        self.stack.pop();
        result
    }

    fn expand_body(&mut self, page: &Page, body: &str) -> Result<String, ApiError> {
        let scope = self.next_scope;
        self.next_scope += 1;
        let mut edits: Vec<(Range<usize>, String)> = Vec::new();
        let mut base_fence: Option<(Range<usize>, String)> = None;
        let mut image: Option<(Range<usize>, String, String)> = None;
        for (event, range) in
            Parser::new_ext(body, clep_vault::markdown::markdown_options()).into_offset_iter()
        {
            match event {
                Event::FootnoteReference(name) => {
                    let label = format!("clep-{scope}-{}", blake3::hash(name.as_bytes()));
                    edits.push((range, format!("[^{label}]")));
                }
                Event::Start(Tag::FootnoteDefinition(name)) => {
                    let marker = &body[range.clone()];
                    let start = marker
                        .find("[^")
                        .ok_or_else(|| unsupported("invalid footnote definition"))?
                        + range.start
                        + 2;
                    let end = body[start..range.end]
                        .find("]:")
                        .ok_or_else(|| unsupported("invalid footnote definition"))?
                        + start;
                    let label = format!("clep-{scope}-{}", blake3::hash(name.as_bytes()));
                    edits.push((start..end, label));
                }
                Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info)))
                    if info.trim() == "base" =>
                {
                    base_fence = Some((range, String::new()));
                }
                Event::Text(text) if base_fence.is_some() => {
                    base_fence.as_mut().unwrap().1.push_str(&text);
                }
                Event::End(TagEnd::CodeBlock) if base_fence.is_some() => {
                    let (range, source) = base_fence.take().unwrap();
                    edits.push((range, self.base(page, &source)?));
                }
                Event::Start(Tag::Image { dest_url, .. }) => {
                    image = Some((range, dest_url.to_string(), String::new()));
                }
                Event::Text(text) | Event::Code(text) if image.is_some() => {
                    image.as_mut().unwrap().2.push_str(&text)
                }
                Event::End(TagEnd::Image) if image.is_some() => {
                    let (range, target, alt) = image.take().unwrap();
                    let path = self.image_reference(page, &target)?;
                    let destination = path
                        .replace('&', "&amp;")
                        .replace('<', "&lt;")
                        .replace('>', "&gt;");
                    edits.push((
                        range,
                        format!("![{}](<{}>)", escape_text(&alt), destination),
                    ));
                }
                _ => {}
            }
        }
        for link in extract_links(body) {
            if edits
                .iter()
                .any(|(range, _)| range.start <= link.span.start && range.end >= link.span.end)
            {
                continue;
            }
            match link.kind {
                LinkKind::Wiki
                    if link.span.start > 0 && body.as_bytes()[link.span.start - 1] == b'!' =>
                {
                    let start = link.span.start - 1;
                    // An escaped exclamation mark is authored text, not a transclusion.
                    if start > 0 && body.as_bytes()[start - 1] == b'\\' {
                        continue;
                    }
                    let expanded = self.embed(page, &link.target_raw)?;
                    edits.push((start..link.span.end, expanded));
                }
                LinkKind::BlockRef => {
                    let expanded = self.block(&link.target_raw)?;
                    edits.push((link.span, expanded));
                }
                _ => {}
            }
        }
        edits.sort_by_key(|(range, _)| range.start);
        let mut result = String::new();
        let mut cursor = 0;
        for (range, replacement) in edits {
            if range.start < cursor {
                return Err(unsupported("overlapping embed syntax cannot be exported"));
            }
            append(&mut result, &body[cursor..range.start])?;
            append(&mut result, &replacement)?;
            cursor = range.end;
        }
        append(&mut result, &body[cursor..])?;
        Ok(result)
    }

    fn image_reference(&self, page: &Page, target: &str) -> Result<String, ApiError> {
        let decoded = percent_encoding::percent_decode_str(target)
            .decode_utf8()
            .map_err(|_| unsupported("invalid image URL"))?;
        if decoded.chars().any(char::is_control) {
            return Err(ApiError::forbidden("unsafe image path"));
        }
        if let Some(hash) = decoded
            .strip_prefix("/api/vault/cas/")
            .or_else(|| decoded.strip_prefix("cas:"))
        {
            if clep_archive::cas::blob_relative_path(hash).is_none() {
                return Err(unsupported("invalid CAS image reference"));
            }
            return Ok(format!("/api/vault/cas/{hash}"));
        }
        let path = if let Some(relative) = decoded.strip_prefix("/api/vault/attachments/") {
            format!("{}/{relative}", self.vault.config().vault.attachment_folder)
        } else if decoded.contains(':') || decoded.starts_with("//") {
            return Err(unsupported(
                "remote images are not fetched during Word export; save the image in the vault first",
            ));
        } else if let Some(relative) = decoded.strip_prefix('/') {
            relative.to_string()
        } else if decoded.starts_with(&format!("{}/", self.vault.config().vault.attachment_folder))
        {
            decoded.into_owned()
        } else {
            relative_path(page.path.as_str(), &decoded)?
        };
        let path = VaultPath::new(&path).map_err(|_| ApiError::forbidden("unsafe image path"))?;
        Ok(path.as_str().to_owned())
    }

    fn embed(&mut self, source: &Page, target: &str) -> Result<String, ApiError> {
        let (target, fragment) = target
            .split_once('#')
            .map_or((target, None), |(target, fragment)| {
                (target, Some(fragment))
            });
        let path = if target.is_empty() {
            source.path.clone()
        } else if target.starts_with("./") || target.starts_with("../") {
            VaultPath::new(&relative_path(source.path.as_str(), target)?)
                .map_err(|_| unsupported("invalid embed path"))?
        } else {
            let canonical = CanonicalName::new(target);
            let id = self
                .index
                .resolve_link_target_id(canonical.as_str())
                .map_err(|_| unsupported("embed reference lookup failed"))?
                .ok_or_else(|| unsupported("embedded page is missing or ambiguous"))?;
            let path: String = self
                .index
                .connection()
                .query_row("SELECT path FROM pages WHERE id = ?1", [&id], |row| {
                    row.get(0)
                })
                .map_err(|_| unsupported("embedded page is unavailable"))?;
            VaultPath::new(&path).map_err(|_| unsupported("invalid embedded page path"))?
        };
        let page = self.page(path)?;
        if let Some(fragment) = fragment {
            if let Some(id) = fragment.strip_prefix('^') {
                return self.page_block(&page, id);
            }
            let fragment = percent_encoding::percent_decode_str(fragment)
                .decode_utf8()
                .map_err(|_| unsupported("invalid heading fragment"))?;
            let range = heading_section(&page.body, &fragment)?;
            return self.expand_key(
                &page,
                &page.body[range],
                format!("{}#{fragment}", page.path),
            );
        }
        self.expand(&page, &page.body)
    }

    fn block(&mut self, id: &str) -> Result<String, ApiError> {
        let path: Option<String> = self.index.connection().query_row(
            "SELECT p.path FROM blocks b JOIN pages p ON p.id = b.page_id WHERE b.block_id = ?1", [id], |row| row.get(0),
        ).optional().map_err(|_| unsupported("block lookup failed"))?;
        let path = path.ok_or_else(|| unsupported("embedded block was not found"))?;
        let page =
            self.page(VaultPath::new(&path).map_err(|_| unsupported("invalid block page path"))?)?;
        self.page_block(&page, id)
    }

    fn page_block(&mut self, page: &Page, id: &str) -> Result<String, ApiError> {
        let block = parse_blocks(&page.body)
            .into_iter()
            .find(|block| block.block_id.as_deref() == Some(id))
            .ok_or_else(|| unsupported("embedded block changed or was not found"))?;
        let raw = &page.body[block.span];
        let marker = format!(" ^{id}");
        let raw = raw.replace(&marker, "");
        self.expand_key(page, &raw, format!("{}#^{id}", page.path))
    }

    fn base(&mut self, page: &Page, source: &str) -> Result<String, ApiError> {
        let embed: BaseEmbed =
            toml::from_str(source).map_err(|_| unsupported("invalid Base embed TOML"))?;
        if embed.base.trim().is_empty()
            || embed
                .display
                .as_deref()
                .is_some_and(|value| !matches!(value, "compact" | "full"))
            || embed
                .width
                .is_some_and(|value| !(480..=1600).contains(&value))
        {
            return Err(unsupported("invalid Base embed configuration"));
        }
        if let Some(template) = embed.template {
            let source = clep_bases::template_document::read_template(self.vault.root(), &template)
                .map_err(|_| unsupported("Base template is missing or inaccessible"))?
                .source;
            let selection = RenderSelection {
                base: embed.base,
                view: embed.view,
                filter: embed.filter,
                sort: embed.sort,
                limit: embed.limit,
                template,
            };
            let rendered = render_base(self.vault.root(), self.index.connection(), &selection, page, &source, self.today)
                .map_err(|_| unsupported("Base template could not be rendered; check its selection, source access, template, and resource limits"))?;
            return self.expand_key(
                page,
                &rendered.markdown,
                format!("template:{}:{}", selection.base, selection.template),
            );
        }
        let view_name = embed
            .view
            .ok_or_else(|| unsupported("Base embed must select a saved view or template"))?;
        let stored = clep_bases::base_document::load(self.vault.root(), &embed.base)
            .map_err(|_| unsupported("Base is missing or invalid"))?;
        let base = &stored.definition;
        let view = base
            .view(&view_name)
            .ok_or_else(|| unsupported("saved Base view was not found"))?;
        validate_embed_overrides(
            base,
            EmbedOverrides {
                filter: embed.filter.as_ref(),
                sort: embed.sort.as_deref(),
                limit: embed.limit,
                group_by: None,
            },
        )
        .map_err(|_| unsupported("invalid Base selection overrides"))?;
        let mut spec = composed_query_spec(base, view, embed.filter, embed.sort, embed.limit, None);
        // Screen pagination is not an export limit. Unspecified limits include
        // every row, with a hard failure rather than a successful truncated file.
        spec.limit = Some(embed.limit.unwrap_or(MAX_ROWS + 1));
        spec.group_row_limit = GroupRowLimit::Limit(embed.limit.unwrap_or(MAX_ROWS + 1));
        let output = evaluate(
            self.index.connection(),
            &spec,
            &QueryContext::for_base(base).with_today(self.today),
        )
        .map_err(|_| unsupported("Base query could not be evaluated"))?;
        let mut markdown = String::new();
        let mut rows_seen = 0;
        match output {
            QueryOutput::Flat {
                rows,
                total,
                aggregates,
            } => {
                self.table(
                    &mut markdown,
                    &rows,
                    total,
                    view,
                    embed.limit,
                    &mut rows_seen,
                )?;
                append_aggregates(&mut markdown, view, &aggregates)?;
            }
            QueryOutput::Grouped { groups } => {
                for group in groups {
                    append(
                        &mut markdown,
                        &format!("\n### {}\n\n", escape_cell(&value_text(&group.key))),
                    )?;
                    self.table(
                        &mut markdown,
                        &group.rows,
                        group.total,
                        view,
                        embed.limit,
                        &mut rows_seen,
                    )?;
                    append_aggregates(&mut markdown, view, &group.aggregates)?;
                }
            }
        }
        Ok(markdown)
    }

    fn table(
        &mut self,
        output: &mut String,
        rows: &[QueryRow],
        total: i64,
        view: &ViewDefinition,
        limit: Option<u32>,
        rows_seen: &mut usize,
    ) -> Result<(), ApiError> {
        *rows_seen += rows.len();
        if *rows_seen > MAX_ROWS as usize || (limit.is_none() && rows.len() as i64 != total) {
            return Err(unsupported(
                "Base snapshot exceeds 1000 rows; set an explicit Base embed limit",
            ));
        }
        if rows.len() as i64 != total {
            append(
                output,
                &format!(
                    "Showing {} of {total} rows (saved embed limit).\n\n",
                    rows.len()
                ),
            )?;
        }
        let defaults = vec!["title".to_string()];
        let columns = if view.columns.is_empty() {
            &defaults
        } else {
            &view.columns
        };
        append(output, "| ")?;
        for column in columns {
            append(
                output,
                &format!(
                    "{} | ",
                    escape_cell(
                        view.labels
                            .get(column)
                            .map(String::as_str)
                            .unwrap_or(column)
                    )
                ),
            )?;
        }
        append(output, "\n|")?;
        for _ in columns {
            append(output, " --- |")?;
        }
        append(output, "\n")?;
        let mut bodies = String::new();
        for row in rows {
            let page = self.page(
                VaultPath::new(&row.path).map_err(|_| unsupported("invalid Base row path"))?,
            )?;
            append(output, "| ")?;
            for column in columns {
                let identity = resolve_projection_field(column)
                    .map_err(|_| unsupported("invalid Base column"))?;
                let text = if matches!(identity, clep_bases::query::ProjectionFieldIdentity::Body) {
                    let label = view
                        .labels
                        .get(column)
                        .map(String::as_str)
                        .unwrap_or(column);
                    let title = page
                        .meta
                        .title
                        .clone()
                        .unwrap_or_else(|| page.path.decode_slug());
                    append(
                        &mut bodies,
                        &format!(
                            "\n#### {} — {}\n\n",
                            escape_text(&title),
                            escape_text(label)
                        ),
                    )?;
                    append(&mut bodies, &self.expand(&page, &page.body)?)?;
                    append(&mut bodies, "\n\n")?;
                    "Full content below".to_string()
                } else {
                    let (_, value) = project_page_field_value(&page, &identity);
                    value.map(|value| value_text(&value)).unwrap_or_default()
                };
                append(output, &format!("{} | ", escape_cell(&text)))?;
            }
            append(output, "\n")?;
        }
        append(output, "\n")?;
        append(output, &bodies)
    }
}

fn append(output: &mut String, text: &str) -> Result<(), ApiError> {
    if output.len().saturating_add(text.len()) > MAX_MARKDOWN_BYTES {
        return Err(unsupported(
            "Word snapshot exceeds the 4 MiB Markdown limit",
        ));
    }
    output.push_str(text);
    Ok(())
}

fn escape_text(text: &str) -> String {
    let mut result = String::new();
    for character in text.chars() {
        if "\\`*_{}[]<>#!|".contains(character) {
            result.push('\\');
        }
        result.push(character);
    }
    result
}

fn escape_cell(text: &str) -> String {
    let mut display = String::new();
    let mut cursor = 0;
    for link in extract_links(text)
        .into_iter()
        .filter(|link| link.kind == LinkKind::Wiki)
    {
        display.push_str(&text[cursor..link.span.start]);
        let inner = &text[link.span.start + 2..link.span.end - 2];
        let label = inner.split_once('|').map_or_else(
            || inner.split(['#', '^']).next().unwrap_or(inner),
            |(_, label)| label,
        );
        display.push_str(label);
        cursor = link.span.end;
    }
    display.push_str(&text[cursor..]);
    escape_text(&display)
        .replace('\r', "")
        .replace('\n', "<br>")
}

fn value_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Array(values) => {
            values.iter().map(value_text).collect::<Vec<_>>().join(", ")
        }
        value => value.to_string(),
    }
}

fn append_aggregates(
    output: &mut String,
    view: &ViewDefinition,
    values: &[serde_json::Value],
) -> Result<(), ApiError> {
    for (aggregate, value) in view.aggregates.iter().zip(values) {
        append(
            output,
            &format!(
                "{}: {}\n\n",
                escape_text(&format!(
                    "{:?} {}",
                    aggregate.function,
                    aggregate.field.as_deref().unwrap_or("rows")
                )),
                escape_text(&value_text(value))
            ),
        )?;
    }
    Ok(())
}

fn relative_path(source: &str, target: &str) -> Result<String, ApiError> {
    if target.contains('\\') || target.starts_with('/') || target.contains(':') {
        return Err(ApiError::forbidden("unsafe relative export path"));
    }
    let mut parts: Vec<&str> = source.split('/').collect();
    parts.pop();
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(ApiError::forbidden("export path escapes the vault"));
                }
            }
            part => parts.push(part),
        }
    }
    Ok(parts.join("/"))
}

fn heading_section(body: &str, fragment: &str) -> Result<Range<usize>, ApiError> {
    let mut headings = Vec::new();
    let mut current = None;
    for (event, range) in
        Parser::new_ext(body, clep_vault::markdown::markdown_options()).into_offset_iter()
    {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                current = Some((level, range.start, String::new()))
            }
            Event::Text(text) | Event::Code(text) if current.is_some() => {
                current.as_mut().unwrap().2.push_str(&text)
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some(heading) = current.take() {
                    headings.push(heading);
                }
            }
            _ => {}
        }
    }
    let canonical = CanonicalName::new(fragment);
    let matches: Vec<_> = headings
        .iter()
        .enumerate()
        .filter(|(_, (_, _, text))| {
            CanonicalName::new(text) == canonical
                || text
                    .to_lowercase()
                    .chars()
                    .filter(|ch| {
                        ch.is_alphanumeric() || ch.is_whitespace() || matches!(ch, '-' | '_')
                    })
                    .map(|ch| if ch.is_whitespace() { '-' } else { ch })
                    .collect::<String>()
                    == fragment.to_lowercase()
        })
        .collect();
    if matches.len() != 1 {
        return Err(unsupported("embedded heading is missing or ambiguous"));
    }
    let (index, (level, start, _)) = matches[0];
    let end = headings[index + 1..]
        .iter()
        .find(|(next, _, _)| next <= level)
        .map_or(body.len(), |(_, start, _)| *start);
    Ok(*start..end)
}
