mod html;
mod snapshot;
mod word;

use std::path::PathBuf;
use std::sync::Arc;

use pulldown_cmark::{Event, TagEnd};

use crate::api::{AppState, error::ApiError};
use crate::vault::{Vault, path::VaultPath};

/// One page expanded into self-contained Markdown, plus what its image loader reads.
struct Source {
    title: String,
    markdown: String,
    vault: Vault,
    cas_root: PathBuf,
}

async fn snapshot(state: Arc<AppState>, path: VaultPath) -> Result<Source, ApiError> {
    let today = state.clock.now().date_naive();
    let cas_root = state.cas.lock().root().to_path_buf();
    let (title, markdown, vault) = state
        .index
        .with_index(move |index, vault| {
            let current = crate::vault::Vault::open(vault.root())
                .map_err(|_| ApiError::internal("vault access policy could not be read"))?;
            let mut snapshot = snapshot::Snapshot::new(&current, index, today);
            let page = snapshot.page(path)?;
            let title = page
                .meta
                .title
                .clone()
                .unwrap_or_else(|| page.path.decode_slug());
            let markdown = snapshot.expand(&page, &page.body)?;
            Ok::<_, ApiError>((title, markdown, current))
        })
        .await
        .map_err(|_| ApiError::internal("export snapshot worker failed"))??;
    Ok(Source {
        title,
        markdown,
        vault,
        cas_root,
    })
}

/// Reads snapshot-resolved image references within one shared byte budget.
fn image_loader(
    vault: &Vault,
    cas_root: &std::path::Path,
) -> impl FnMut(&str) -> Result<Vec<u8>, String> {
    let mut remaining = snapshot::MAX_IMAGE_BYTES;
    move |reference| {
        let bytes = if let Some(hash) = reference.strip_prefix("/api/vault/cas/") {
            snapshot::read_cas_image(cas_root, hash, remaining).map_err(|error| error.error)?
        } else {
            snapshot::read_image(vault, reference, remaining).map_err(|error| error.error)?
        };
        remaining = remaining
            .checked_sub(bytes.len())
            .ok_or("images exceed the export limit")?;
        Ok(bytes)
    }
}

/// Render the snapshot off the async runtime with one format's renderer.
async fn render<T: Send + 'static>(
    source: Source,
    render: impl FnOnce(
        &str,
        &str,
        &mut dyn FnMut(&str) -> Result<Vec<u8>, String>,
    ) -> Result<T, String>
    + Send
    + 'static,
) -> Result<(String, T), ApiError> {
    tokio::task::spawn_blocking(move || {
        let mut load_image = image_loader(&source.vault, &source.cas_root);
        let output = render(&source.title, &source.markdown, &mut load_image)
            .map_err(snapshot::unsupported)?;
        Ok((source.title, output))
    })
    .await
    .map_err(|_| ApiError::internal("export rendering worker failed"))?
}

pub(crate) async fn export_word(
    state: Arc<AppState>,
    path: VaultPath,
) -> Result<(String, Vec<u8>), ApiError> {
    let source = snapshot(state, path).await?;
    render(source, |title, markdown, load_image| {
        word::render(title, markdown, load_image)
    })
    .await
}

pub(crate) async fn export_html(
    state: Arc<AppState>,
    path: VaultPath,
) -> Result<(String, String), ApiError> {
    let source = snapshot(state, path).await?;
    render(source, |title, markdown, load_image| {
        html::render(title, markdown, load_image)
    })
    .await
}

// Presentation rules shared by every format.

fn skip_until_end<'a>(events: &mut impl Iterator<Item = Event<'a>>, end: TagEnd) {
    let mut nesting = 0;
    for event in events {
        match event {
            Event::Start(_) => nesting += 1,
            Event::End(tag) if nesting == 0 && tag == end => break,
            Event::End(_) => nesting -= 1,
            _ => {}
        }
    }
}

fn comments_only(mut html: &str) -> bool {
    loop {
        html = html.trim();
        if html.is_empty() {
            return true;
        }
        let Some(comment) = html.strip_prefix("<!--") else {
            return false;
        };
        let Some(end) = comment.find("-->") else {
            return false;
        };
        html = &comment[end + 3..];
    }
}

fn safe_external_url(target: &str) -> bool {
    url::Url::parse(target).is_ok_and(|url| {
        matches!(url.scheme(), "https" | "http" | "mailto")
            && url.username().is_empty()
            && url.password().is_none()
    })
}

/// Decode a raster image within fixed resource limits and re-encode only its
/// pixels as PNG, dropping any metadata. Returns the PNG with its dimensions.
fn raster_png(bytes: Vec<u8>) -> Result<(Vec<u8>, u32, u32), String> {
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("Could not identify image: {error}"))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|error| format!("Could not decode image for export: {error}"))?;
    let (width, height) = (decoded.width(), decoded.height());
    if width == 0 || height == 0 {
        return Err("An image has no displayable pixels".into());
    }
    let mut png = std::io::Cursor::new(Vec::new());
    decoded
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|error| format!("Could not encode image for export: {error}"))?;
    Ok((png.into_inner(), width, height))
}
