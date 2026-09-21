//! Exact-byte, revision-guarded storage for vault-authored Markdown templates.
//!
//! Paths must be physical children of the template directory. Cooperating
//! writers are serialized; conditional publication also protects external file
//! replacements. As with the vault's other path-based filesystem operations,
//! ancestor directories must not be renamed concurrently by external writers.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use clep_vault::atomic_file::{
    AtomicPublicationError, ConditionalPublicationError, atomic_create, atomic_replace_if_unchanged,
};
use serde::Serialize;
use thiserror::Error;
use utoipa::ToSchema;

const MAX_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_SLUG_BYTES: usize = 128;
const TEMPLATE_SUFFIX: &str = ".md.jinja";
static TEMPLATE_WRITER: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TemplateDocument {
    pub slug: String,
    pub source: String,
    pub revision: String,
}

#[derive(Debug, Error)]
pub enum TemplateError {
    #[error(
        "invalid template slug `{0}`; use 1–128 ASCII letters, digits, hyphens or underscores, starting with a letter or digit"
    )]
    InvalidSlug(String),
    #[error("template storage path must contain only physical directories and regular files")]
    UnsafePath,
    #[error("template source exceeds the 1 MiB limit")]
    TooLarge,
    #[error("template source is not valid UTF-8")]
    InvalidSource,
    #[error("template `{0}` was not found")]
    NotFound(String),
    #[error("template `{0}` already exists")]
    AlreadyExists(String),
    #[error("template changed since it was read")]
    Conflict { current_revision: Option<String> },
    #[error("atomic publication completed but was not durable: {0}")]
    PublishedButNotDurable(#[source] io::Error),
    #[error(transparent)]
    Io(#[from] io::Error),
}

pub fn list_templates(root: &Path) -> Result<Vec<String>, TemplateError> {
    let _writer = lock_writer();
    let directory = template_directory(root, false)?;
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut templates = Vec::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(slug) = name
            .to_str()
            .and_then(|name| name.strip_suffix(TEMPLATE_SUFFIX))
        else {
            continue;
        };
        if validate_slug(slug).is_ok() {
            templates.push(slug.to_owned());
        }
    }
    templates.sort_unstable();
    Ok(templates)
}

pub fn read_template(root: &Path, slug: &str) -> Result<TemplateDocument, TemplateError> {
    validate_slug(slug)?;
    let _writer = lock_writer();
    let directory = template_directory(root, false)?;
    read_document(&directory.join(format!("{slug}{TEMPLATE_SUFFIX}")), slug)
}

pub fn create_template(
    root: &Path,
    slug: &str,
    source: &str,
) -> Result<TemplateDocument, TemplateError> {
    validate_slug(slug)?;
    validate_source(source)?;
    let _writer = lock_writer();
    let directory = template_directory(root, true)?;
    let path = directory.join(format!("{slug}{TEMPLATE_SUFFIX}"));
    validate_file_if_present(&path)?;
    atomic_create(&path, source.as_bytes()).map_err(|error| match error {
        AtomicPublicationError::NotPublished(error)
            if error.kind() == io::ErrorKind::AlreadyExists =>
        {
            TemplateError::AlreadyExists(slug.to_owned())
        }
        error => publication_error(error),
    })?;
    Ok(document(slug, source.to_owned()))
}

pub fn update_template(
    root: &Path,
    slug: &str,
    source: &str,
    expected_revision: &str,
) -> Result<TemplateDocument, TemplateError> {
    validate_slug(slug)?;
    validate_source(source)?;
    let _writer = lock_writer();
    let directory = template_directory(root, false)?;
    let path = directory.join(format!("{slug}{TEMPLATE_SUFFIX}"));
    let current = read_document(&path, slug)?;
    if current.revision != expected_revision {
        return Err(TemplateError::Conflict {
            current_revision: Some(current.revision),
        });
    }
    atomic_replace_if_unchanged(&path, current.source.as_bytes(), source.as_bytes(), || {})
        .map_err(|error| match error {
            ConditionalPublicationError::Stale => TemplateError::Conflict {
                current_revision: read_document(&path, slug).ok().map(|value| value.revision),
            },
            ConditionalPublicationError::Publication(error) => publication_error(error),
        })?;
    Ok(document(slug, source.to_owned()))
}

fn lock_writer() -> MutexGuard<'static, ()> {
    TEMPLATE_WRITER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn validate_slug(slug: &str) -> Result<(), TemplateError> {
    if slug.is_empty()
        || slug.len() > MAX_SLUG_BYTES
        || !slug.as_bytes()[0].is_ascii_alphanumeric()
        || !slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(TemplateError::InvalidSlug(slug.to_owned()));
    }
    Ok(())
}

fn validate_source(source: &str) -> Result<(), TemplateError> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(TemplateError::TooLarge);
    }
    Ok(())
}

fn template_directory(root: &Path, create: bool) -> Result<PathBuf, TemplateError> {
    let mut directory = root.canonicalize()?;
    for component in [".clepsydra", "templates"] {
        directory.push(component);
        if create {
            match fs::create_dir(&directory) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(TemplateError::UnsafePath);
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound && !create => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(directory)
}

fn validate_file_if_present(path: &Path) -> Result<(), TemplateError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(TemplateError::UnsafePath)
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn read_document(path: &Path, slug: &str) -> Result<TemplateDocument, TemplateError> {
    validate_file_if_present(path)?;
    let file = fs::File::open(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            TemplateError::NotFound(slug.to_owned())
        } else {
            TemplateError::Io(error)
        }
    })?;
    let mut bytes = Vec::new();
    file.take((MAX_SOURCE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err(TemplateError::TooLarge);
    }
    let source = String::from_utf8(bytes).map_err(|_| TemplateError::InvalidSource)?;
    Ok(document(slug, source))
}

fn document(slug: &str, source: String) -> TemplateDocument {
    let revision = blake3::hash(source.as_bytes()).to_hex().to_string();
    TemplateDocument {
        slug: slug.to_owned(),
        source,
        revision,
    }
}

fn publication_error(error: AtomicPublicationError) -> TemplateError {
    match error {
        AtomicPublicationError::NotPublished(error) => TemplateError::Io(error),
        AtomicPublicationError::PublishedButNotDurable(error) => {
            TemplateError::PublishedButNotDurable(error)
        }
    }
}
