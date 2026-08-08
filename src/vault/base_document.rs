//! Revision-aware persistence for canonical base definition documents.
//!
//! Clepsydra writers are serialized process-wide and revision-check again
//! immediately before publication or removal. An external editor can still
//! race in the narrow interval between that final check and the filesystem
//! operation; the platform helpers do not provide compare-and-swap semantics.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Mutex, MutexGuard};

use thiserror::Error;
use toml_edit::{Array, ArrayOfTables, Decor, DocumentMut, InlineTable, Item, Table, Value};

use super::atomic_file::{AtomicPublicationError, atomic_create, atomic_replace};
use super::base::{
    BaseDefinition, BaseDiagnostic, BaseDiagnosticSeverity, BaseFile, ValidationResult, parse_base,
    validate_definition,
};

const MANAGED_KEYS: &[&str] = &["name", "description", "filter", "properties", "views"];
static BASE_DOCUMENT_WRITER: Mutex<()> = Mutex::new(());

#[derive(Debug)]
pub struct StoredBase {
    pub definition: BaseDefinition,
    pub diagnostics: Vec<BaseDiagnostic>,
    pub revision: String,
}

#[derive(Debug, Error)]
pub enum BaseDocumentError {
    #[error("invalid base slug `{0}`")]
    InvalidSlug(String),
    #[error("base `{0}` was not found")]
    NotFound(String),
    #[error("base `{0}` already exists")]
    AlreadyExists(String),
    #[error("base changed; current revision is {current_revision}")]
    Conflict { current_revision: String },
    #[error("base definition is invalid")]
    InvalidDefinition(Vec<BaseDiagnostic>),
    #[error("base document cannot be updated safely: {0}")]
    UnsupportedDocument(String),
    #[error("atomic publication completed but was not durable: {0}")]
    PublishedButNotDurable(#[source] io::Error),
    #[error(transparent)]
    Io(#[from] io::Error),
}

pub fn create(root: &Path, slug: &str, file: &BaseFile) -> Result<StoredBase, BaseDocumentError> {
    let path = base_path(root, slug)?;
    let _writer = lock_writer();
    reject_blocking_diagnostics(validate_definition(slug, file.clone()))?;
    let content = serialize_managed(file)?;
    fs::create_dir_all(
        path.parent()
            .expect("a resolved base path always has a parent"),
    )?;
    atomic_create(&path, content.as_bytes()).map_err(|error| map_create_error(slug, error))?;
    load_stored(&path, slug)
}

pub fn update(
    root: &Path,
    slug: &str,
    expected_revision: &str,
    file: &BaseFile,
) -> Result<StoredBase, BaseDocumentError> {
    update_with_before_publication(root, slug, expected_revision, file, || {})
}

fn update_with_before_publication(
    root: &Path,
    slug: &str,
    expected_revision: &str,
    file: &BaseFile,
    before_publication: impl FnOnce(),
) -> Result<StoredBase, BaseDocumentError> {
    let path = base_path(root, slug)?;
    let _writer = lock_writer();
    let raw = read_matching_revision(&path, slug, expected_revision)?;
    reject_blocking_diagnostics(validate_definition(slug, file.clone()))?;
    let content = merge_document(&raw, file)?;
    before_publication();
    read_matching_revision(&path, slug, expected_revision)?;
    atomic_replace(&path, content.as_bytes()).map_err(map_publication_error)?;
    load_stored(&path, slug)
}

pub fn delete(root: &Path, slug: &str, expected_revision: &str) -> Result<(), BaseDocumentError> {
    delete_with_before_removal(root, slug, expected_revision, || {})
}

fn delete_with_before_removal(
    root: &Path,
    slug: &str,
    expected_revision: &str,
    before_removal: impl FnOnce(),
) -> Result<(), BaseDocumentError> {
    let path = base_path(root, slug)?;
    let _writer = lock_writer();
    read_matching_revision(&path, slug, expected_revision)?;
    before_removal();
    read_matching_revision(&path, slug, expected_revision)?;
    fs::remove_file(path).map_err(|error| map_read_error(slug, error))
}

pub fn revision(raw: &str) -> String {
    blake3::hash(raw.as_bytes()).to_hex().to_string()
}

fn base_path(root: &Path, slug: &str) -> Result<PathBuf, BaseDocumentError> {
    let safe = !slug.is_empty()
        && !slug.starts_with('.')
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if !safe {
        return Err(BaseDocumentError::InvalidSlug(slug.to_owned()));
    }
    Ok(root.join("bases").join(format!("{slug}.base.toml")))
}

fn reject_blocking_diagnostics(
    result: ValidationResult,
) -> Result<ValidationResult, BaseDocumentError> {
    if result
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == BaseDiagnosticSeverity::Error)
    {
        Err(BaseDocumentError::InvalidDefinition(result.diagnostics))
    } else {
        Ok(result)
    }
}

fn lock_writer() -> MutexGuard<'static, ()> {
    BASE_DOCUMENT_WRITER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn read_matching_revision(
    path: &Path,
    slug: &str,
    expected_revision: &str,
) -> Result<String, BaseDocumentError> {
    let raw = fs::read_to_string(path).map_err(|error| map_read_error(slug, error))?;
    let current_revision = revision(&raw);
    if current_revision != expected_revision {
        return Err(BaseDocumentError::Conflict { current_revision });
    }
    Ok(raw)
}

fn serialize_managed(file: &BaseFile) -> Result<String, BaseDocumentError> {
    toml_edit::ser::to_document(file)
        .map(|document| document.to_string())
        .map_err(|error| BaseDocumentError::UnsupportedDocument(error.to_string()))
}

fn load_stored(path: &Path, slug: &str) -> Result<StoredBase, BaseDocumentError> {
    let raw = fs::read_to_string(path).map_err(|error| map_read_error(slug, error))?;
    let (definition, diagnostics) = parse_base(path, &raw);
    let definition = definition.ok_or_else(|| {
        let message = diagnostics
            .iter()
            .map(|diagnostic| diagnostic.message.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        BaseDocumentError::UnsupportedDocument(message)
    })?;
    Ok(StoredBase {
        definition,
        diagnostics,
        revision: revision(&raw),
    })
}

fn map_read_error(slug: &str, error: io::Error) -> BaseDocumentError {
    if error.kind() == io::ErrorKind::NotFound {
        BaseDocumentError::NotFound(slug.to_owned())
    } else {
        BaseDocumentError::Io(error)
    }
}

fn map_create_error(slug: &str, error: AtomicPublicationError) -> BaseDocumentError {
    match error {
        AtomicPublicationError::NotPublished(error)
            if error.kind() == io::ErrorKind::AlreadyExists =>
        {
            BaseDocumentError::AlreadyExists(slug.to_owned())
        }
        AtomicPublicationError::NotPublished(error) => BaseDocumentError::Io(error),
        AtomicPublicationError::PublishedButNotDurable(error) => {
            BaseDocumentError::PublishedButNotDurable(error)
        }
    }
}

fn map_publication_error(error: AtomicPublicationError) -> BaseDocumentError {
    match error {
        AtomicPublicationError::NotPublished(error) => BaseDocumentError::Io(error),
        AtomicPublicationError::PublishedButNotDurable(error) => {
            BaseDocumentError::PublishedButNotDurable(error)
        }
    }
}

fn merge_document(raw: &str, desired_file: &BaseFile) -> Result<String, BaseDocumentError> {
    let current_file: BaseFile = toml::from_str(raw).map_err(|error| {
        BaseDocumentError::UnsupportedDocument(format!(
            "current managed values cannot be represented safely: {error}"
        ))
    })?;
    let mut document = DocumentMut::from_str(raw).map_err(|error| {
        BaseDocumentError::UnsupportedDocument(format!("current TOML cannot be edited: {error}"))
    })?;
    let current = toml_edit::ser::to_document(&current_file).map_err(|error| {
        BaseDocumentError::UnsupportedDocument(format!(
            "current managed values cannot be serialized: {error}"
        ))
    })?;
    let desired = toml_edit::ser::to_document(desired_file).map_err(|error| {
        BaseDocumentError::UnsupportedDocument(format!(
            "desired managed values cannot be serialized: {error}"
        ))
    })?;

    for key in MANAGED_KEYS {
        merge_table_key(
            document.as_table_mut(),
            key,
            current.as_table().get(key),
            desired.as_table().get(key),
            key,
        )?;
    }
    Ok(document.to_string())
}

fn merge_table_key(
    raw: &mut Table,
    key: &str,
    current: Option<&Item>,
    desired: Option<&Item>,
    path: &str,
) -> Result<(), BaseDocumentError> {
    if canonical_items_equal(current, desired) {
        return Ok(());
    }

    match (current, desired) {
        (None, None) => Ok(()),
        (None, Some(desired)) => {
            if raw.contains_key(key) {
                return Err(unsupported(
                    path,
                    "an unsupported value collides with a managed key",
                ));
            }
            raw.insert(key, desired.clone());
            Ok(())
        }
        (Some(current), None) => {
            if raw
                .key(key)
                .is_some_and(|key| decor_contains_comment(key.leaf_decor()))
            {
                return Err(unsupported(path, "removal would discard a key comment"));
            }
            if let Some(raw_item) = raw.get(key) {
                ensure_removable(raw_item, current, path)?;
                raw.remove(key);
            }
            Ok(())
        }
        (Some(current), Some(desired)) => match raw.get_mut(key) {
            Some(raw_item) => merge_item(raw_item, current, desired, path),
            None => {
                raw.insert(key, desired.clone());
                Ok(())
            }
        },
    }
}

fn merge_item(
    raw: &mut Item,
    current: &Item,
    desired: &Item,
    path: &str,
) -> Result<(), BaseDocumentError> {
    if canonical_items_equal(Some(current), Some(desired)) {
        return Ok(());
    }

    match (raw, current, desired) {
        (Item::Value(raw), Item::Value(current), Item::Value(desired)) => {
            merge_value(raw, current, desired, path)
        }
        (
            Item::Table(raw),
            Item::Value(Value::InlineTable(current)),
            Item::Value(Value::InlineTable(desired)),
        ) => merge_table_inline(raw, current, desired, path),
        (
            Item::ArrayOfTables(raw),
            Item::Value(Value::Array(current)),
            Item::Value(Value::Array(desired)),
        ) => merge_array_tables_inline(raw, current, desired, path),
        (Item::Table(raw), Item::Table(current), Item::Table(desired)) => {
            merge_table(raw, current, desired, path)
        }
        (Item::ArrayOfTables(raw), Item::ArrayOfTables(current), Item::ArrayOfTables(desired)) => {
            merge_array_of_tables(raw, current, desired, path)
        }
        _ => Err(unsupported(
            path,
            "the current syntax does not match the managed document shape",
        )),
    }
}

fn merge_table(
    raw: &mut Table,
    current: &Table,
    desired: &Table,
    path: &str,
) -> Result<(), BaseDocumentError> {
    let mut keys = current
        .iter()
        .map(|(key, _)| key.to_owned())
        .collect::<Vec<_>>();
    for (key, _) in desired.iter() {
        if !keys.iter().any(|known| known == key) {
            keys.push(key.to_owned());
        }
    }

    for key in keys {
        let child_path = format!("{path}.{key}");
        merge_table_key(raw, &key, current.get(&key), desired.get(&key), &child_path)?;
    }
    Ok(())
}

fn merge_table_inline(
    raw: &mut Table,
    current: &InlineTable,
    desired: &InlineTable,
    path: &str,
) -> Result<(), BaseDocumentError> {
    let mut keys = current
        .iter()
        .map(|(key, _)| key.to_owned())
        .collect::<Vec<_>>();
    for (key, _) in desired.iter() {
        if !keys.iter().any(|known| known == key) {
            keys.push(key.to_owned());
        }
    }

    for key in keys {
        let child_path = format!("{path}.{key}");
        let current_value = current.get(&key);
        let desired_value = desired.get(&key);
        if canonical_values_equal(current_value, desired_value) {
            continue;
        }
        match (current_value, desired_value) {
            (None, None) => {}
            (None, Some(desired_value)) => {
                if raw.contains_key(&key) {
                    return Err(unsupported(
                        &child_path,
                        "an unsupported value collides with a managed key",
                    ));
                }
                raw.insert(&key, Item::Value(desired_value.clone()));
            }
            (Some(current_value), None) => {
                if let Some(raw_item) = raw.get(&key) {
                    ensure_raw_value_removable(raw_item, current_value, &child_path)?;
                    raw.remove(&key);
                }
            }
            (Some(current_value), Some(desired_value)) => match raw.get_mut(&key) {
                Some(raw_item) => {
                    merge_raw_value(raw_item, current_value, desired_value, &child_path)?
                }
                None => {
                    raw.insert(&key, Item::Value(desired_value.clone()));
                }
            },
        }
    }
    Ok(())
}

fn merge_raw_value(
    raw: &mut Item,
    current: &Value,
    desired: &Value,
    path: &str,
) -> Result<(), BaseDocumentError> {
    match (raw, current, desired) {
        (Item::Value(raw), current, desired) => merge_value(raw, current, desired, path),
        (Item::Table(raw), Value::InlineTable(current), Value::InlineTable(desired)) => {
            merge_table_inline(raw, current, desired, path)
        }
        (Item::ArrayOfTables(raw), Value::Array(current), Value::Array(desired)) => {
            merge_array_tables_inline(raw, current, desired, path)
        }
        _ => Err(unsupported(
            path,
            "the current syntax does not match the managed value shape",
        )),
    }
}

fn merge_array_tables_inline(
    raw: &mut ArrayOfTables,
    current: &Array,
    desired: &Array,
    path: &str,
) -> Result<(), BaseDocumentError> {
    if raw.len() != current.len() {
        return Err(unsupported(
            path,
            "the current array-of-tables shape is not safely addressable",
        ));
    }

    let shared = current.len().min(desired.len());
    for index in 0..shared {
        let current_table = current
            .get(index)
            .and_then(Value::as_inline_table)
            .ok_or_else(|| unsupported(path, "the managed array contains a non-table value"))?;
        let desired_table = desired
            .get(index)
            .and_then(Value::as_inline_table)
            .ok_or_else(|| unsupported(path, "the managed array contains a non-table value"))?;
        merge_table_inline(
            raw.get_mut(index).expect("length checked"),
            current_table,
            desired_table,
            &format!("{path}[{index}]"),
        )?;
    }
    for index in (desired.len()..current.len()).rev() {
        let current_table = current
            .get(index)
            .and_then(Value::as_inline_table)
            .ok_or_else(|| unsupported(path, "the managed array contains a non-table value"))?;
        ensure_table_inline_removable(
            raw.get(index).expect("length checked"),
            current_table,
            &format!("{path}[{index}]"),
        )?;
        raw.remove(index);
    }
    for index in current.len()..desired.len() {
        let table = desired
            .get(index)
            .and_then(Value::as_inline_table)
            .ok_or_else(|| unsupported(path, "the managed array contains a non-table value"))?
            .clone()
            .into_table();
        raw.push(table);
    }
    Ok(())
}

fn ensure_raw_value_removable(
    raw: &Item,
    current: &Value,
    path: &str,
) -> Result<(), BaseDocumentError> {
    match (raw, current) {
        (Item::Value(raw), current) => ensure_value_removable(raw, current, path),
        (Item::Table(raw), Value::InlineTable(current)) => {
            ensure_table_inline_removable(raw, current, path)
        }
        (Item::ArrayOfTables(raw), Value::Array(current)) => {
            ensure_array_tables_inline_removable(raw, current, path)
        }
        _ => Err(unsupported(
            path,
            "removal would discard an unsupported shape",
        )),
    }
}

fn ensure_table_inline_removable(
    raw: &Table,
    current: &InlineTable,
    path: &str,
) -> Result<(), BaseDocumentError> {
    if decor_contains_comment(raw.decor()) {
        return Err(unsupported(path, "removal would discard a table comment"));
    }
    for (key, raw_item) in raw.iter() {
        if raw
            .key(key)
            .is_some_and(|key| decor_contains_comment(key.leaf_decor()))
        {
            return Err(unsupported(
                &format!("{path}.{key}"),
                "removal would discard a key comment",
            ));
        }
        let current_value = current.get(key).ok_or_else(|| {
            unsupported(
                &format!("{path}.{key}"),
                "removal would discard an unsupported key",
            )
        })?;
        ensure_raw_value_removable(raw_item, current_value, &format!("{path}.{key}"))?;
    }
    Ok(())
}

fn ensure_array_tables_inline_removable(
    raw: &ArrayOfTables,
    current: &Array,
    path: &str,
) -> Result<(), BaseDocumentError> {
    if raw.len() != current.len() {
        return Err(unsupported(
            path,
            "removal would discard unsupported tables",
        ));
    }
    for index in 0..current.len() {
        let current_table = current
            .get(index)
            .and_then(Value::as_inline_table)
            .ok_or_else(|| unsupported(path, "the managed array contains a non-table value"))?;
        ensure_table_inline_removable(
            raw.get(index).expect("length checked"),
            current_table,
            &format!("{path}[{index}]"),
        )?;
    }
    Ok(())
}

fn merge_value(
    raw: &mut Value,
    current: &Value,
    desired: &Value,
    path: &str,
) -> Result<(), BaseDocumentError> {
    match (raw, current, desired) {
        (Value::InlineTable(raw), Value::InlineTable(current), Value::InlineTable(desired)) => {
            merge_inline_table(raw, current, desired, path)
        }
        (Value::Array(raw), Value::Array(current), Value::Array(desired)) => {
            merge_array(raw, current, desired, path)
        }
        (raw, current, desired)
            if same_value_shape(raw, current) && same_value_shape(current, desired) =>
        {
            let decor = raw.decor().clone();
            let mut replacement = desired.clone();
            *replacement.decor_mut() = decor;
            *raw = replacement;
            Ok(())
        }
        _ => Err(unsupported(
            path,
            "the current value syntax does not match the managed value shape",
        )),
    }
}

fn merge_array(
    raw: &mut Array,
    current: &Array,
    desired: &Array,
    path: &str,
) -> Result<(), BaseDocumentError> {
    if raw.len() != current.len() {
        return Err(unsupported(
            path,
            "the current array shape is not safely addressable",
        ));
    }

    let shared = current.len().min(desired.len());
    for index in 0..shared {
        let current_value = current.get(index).expect("length checked");
        let desired_value = desired.get(index).expect("length checked");
        if current_value.to_string() == desired_value.to_string() {
            continue;
        }
        merge_value(
            raw.get_mut(index).expect("length checked"),
            current_value,
            desired_value,
            &format!("{path}[{index}]"),
        )?;
    }
    for index in (desired.len()..current.len()).rev() {
        let raw_value = raw.get(index).expect("length checked");
        let current_value = current.get(index).expect("length checked");
        if raw_value.to_string() != current_value.to_string() {
            return Err(unsupported(
                &format!("{path}[{index}]"),
                "removal would discard decorated or unsupported array content",
            ));
        }
        raw.remove(index);
    }
    for index in current.len()..desired.len() {
        raw.push_formatted(desired.get(index).expect("length checked").clone());
    }
    Ok(())
}

fn merge_inline_table(
    raw: &mut InlineTable,
    current: &InlineTable,
    desired: &InlineTable,
    path: &str,
) -> Result<(), BaseDocumentError> {
    let mut keys = current
        .iter()
        .map(|(key, _)| key.to_owned())
        .collect::<Vec<_>>();
    for (key, _) in desired.iter() {
        if !keys.iter().any(|known| known == key) {
            keys.push(key.to_owned());
        }
    }

    for key in keys {
        let child_path = format!("{path}.{key}");
        let current_value = current.get(&key);
        let desired_value = desired.get(&key);
        if canonical_values_equal(current_value, desired_value) {
            continue;
        }
        match (current_value, desired_value) {
            (None, None) => {}
            (None, Some(desired_value)) => {
                if raw.contains_key(&key) {
                    return Err(unsupported(
                        &child_path,
                        "an unsupported inline value collides with a managed key",
                    ));
                }
                raw.insert(&key, desired_value.clone());
            }
            (Some(current_value), None) => {
                if let Some(raw_value) = raw.get(&key) {
                    ensure_value_removable(raw_value, current_value, &child_path)?;
                    raw.remove(&key);
                }
            }
            (Some(current_value), Some(desired_value)) => match raw.get_mut(&key) {
                Some(raw_value) => {
                    merge_value(raw_value, current_value, desired_value, &child_path)?
                }
                None => {
                    raw.insert(&key, desired_value.clone());
                }
            },
        }
    }
    Ok(())
}

fn merge_array_of_tables(
    raw: &mut ArrayOfTables,
    current: &ArrayOfTables,
    desired: &ArrayOfTables,
    path: &str,
) -> Result<(), BaseDocumentError> {
    if raw.len() != current.len() {
        return Err(unsupported(
            path,
            "the current array-of-tables shape is not safely addressable",
        ));
    }

    let shared = current.len().min(desired.len());
    for index in 0..shared {
        merge_table(
            raw.get_mut(index).expect("length checked"),
            current.get(index).expect("length checked"),
            desired.get(index).expect("length checked"),
            &format!("{path}[{index}]"),
        )?;
    }
    for index in (desired.len()..current.len()).rev() {
        ensure_table_removable(
            raw.get(index).expect("length checked"),
            current.get(index).expect("length checked"),
            &format!("{path}[{index}]"),
        )?;
        raw.remove(index);
    }
    for index in current.len()..desired.len() {
        raw.push(desired.get(index).expect("length checked").clone());
    }
    Ok(())
}

fn ensure_removable(raw: &Item, current: &Item, path: &str) -> Result<(), BaseDocumentError> {
    match (raw, current) {
        (Item::Value(raw), Item::Value(current)) => ensure_value_removable(raw, current, path),
        (Item::Table(raw), Item::Value(Value::InlineTable(current))) => {
            ensure_table_inline_removable(raw, current, path)
        }
        (Item::ArrayOfTables(raw), Item::Value(Value::Array(current))) => {
            ensure_array_tables_inline_removable(raw, current, path)
        }
        (Item::Table(raw), Item::Table(current)) => ensure_table_removable(raw, current, path),
        (Item::ArrayOfTables(raw), Item::ArrayOfTables(current)) => {
            if raw.len() != current.len() {
                return Err(unsupported(
                    path,
                    "removal would discard unsupported tables",
                ));
            }
            for index in 0..current.len() {
                ensure_table_removable(
                    raw.get(index).expect("length checked"),
                    current.get(index).expect("length checked"),
                    &format!("{path}[{index}]"),
                )?;
            }
            Ok(())
        }
        _ => Err(unsupported(
            path,
            "removal would discard an unsupported shape",
        )),
    }
}

fn ensure_table_removable(
    raw: &Table,
    current: &Table,
    path: &str,
) -> Result<(), BaseDocumentError> {
    if decor_contains_comment(raw.decor()) {
        return Err(unsupported(path, "removal would discard a table comment"));
    }
    for (key, raw_item) in raw.iter() {
        if raw
            .key(key)
            .is_some_and(|key| decor_contains_comment(key.leaf_decor()))
        {
            return Err(unsupported(
                &format!("{path}.{key}"),
                "removal would discard a key comment",
            ));
        }
        let current_item = current.get(key).ok_or_else(|| {
            unsupported(
                &format!("{path}.{key}"),
                "removal would discard an unsupported key",
            )
        })?;
        ensure_removable(raw_item, current_item, &format!("{path}.{key}"))?;
    }
    Ok(())
}

fn ensure_value_removable(
    raw: &Value,
    current: &Value,
    path: &str,
) -> Result<(), BaseDocumentError> {
    if decor_contains_comment(raw.decor()) {
        return Err(unsupported(path, "removal would discard a value comment"));
    }
    match (raw, current) {
        (Value::InlineTable(raw), Value::InlineTable(current)) => {
            for (key, raw_value) in raw.iter() {
                if raw
                    .key(key)
                    .is_some_and(|key| decor_contains_comment(key.leaf_decor()))
                {
                    return Err(unsupported(
                        &format!("{path}.{key}"),
                        "removal would discard an inline key comment",
                    ));
                }
                let current_value = current.get(key).ok_or_else(|| {
                    unsupported(
                        &format!("{path}.{key}"),
                        "removal would discard an unsupported inline key",
                    )
                })?;
                ensure_value_removable(raw_value, current_value, &format!("{path}.{key}"))?;
            }
            Ok(())
        }
        (raw, current) if same_value_shape(raw, current) => Ok(()),
        _ => Err(unsupported(
            path,
            "removal would discard an unsupported value shape",
        )),
    }
}

fn canonical_items_equal(left: Option<&Item>, right: Option<&Item>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => left.to_string() == right.to_string(),
        _ => false,
    }
}

fn canonical_values_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => left.to_string() == right.to_string(),
        _ => false,
    }
}

fn same_value_shape(left: &Value, right: &Value) -> bool {
    matches!(
        (left, right),
        (Value::String(_), Value::String(_))
            | (Value::Integer(_), Value::Integer(_))
            | (Value::Float(_), Value::Float(_))
            | (Value::Boolean(_), Value::Boolean(_))
            | (Value::Datetime(_), Value::Datetime(_))
            | (Value::Array(_), Value::Array(_))
            | (Value::InlineTable(_), Value::InlineTable(_))
    )
}

fn decor_contains_comment(decor: &Decor) -> bool {
    decor
        .prefix()
        .into_iter()
        .chain(decor.suffix())
        .filter_map(|raw| raw.as_str())
        .any(|raw| raw.contains('#'))
}

fn unsupported(path: &str, reason: &str) -> BaseDocumentError {
    BaseDocumentError::UnsupportedDocument(format!("{path}: {reason}"))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use tempfile::TempDir;

    use super::*;
    use crate::vault::base::{BaseFile, PropertyDefinition, PropertyType};
    use std::sync::mpsc;
    use std::thread;

    const MINIMAL_BASE: &str = "name = \"Reading\"\nproperties = {}\n";

    struct Fixture {
        root: TempDir,
        path: PathBuf,
    }

    impl Fixture {
        fn root(&self) -> &Path {
            self.root.path()
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    fn fixture_base(content: &str) -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let bases = root.path().join("bases");
        fs::create_dir_all(&bases).unwrap();
        let path = bases.join("reading.base.toml");
        fs::write(&path, content).unwrap();
        Fixture { root, path }
    }

    fn minimal_file() -> BaseFile {
        BaseFile {
            name: "Reading".into(),
            description: None,
            filter: None,
            properties: Vec::new(),
            views: Vec::new(),
        }
    }

    fn load_for_test(root: &Path, slug: &str) -> StoredBase {
        let path = root.join("bases").join(format!("{slug}.base.toml"));
        load_stored(&path, slug).unwrap()
    }

    #[test]
    fn revision_is_exact_blake3_of_raw_bytes() {
        assert_eq!(
            revision(""),
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
        );
        assert_ne!(revision(MINIMAL_BASE), revision("name = \"Reading\"\n"));
    }

    #[test]
    fn unsafe_slugs_are_rejected_before_filesystem_access() {
        let root = tempfile::tempdir().unwrap();
        let unusable_root = root.path().join("not-a-directory");
        fs::write(&unusable_root, b"sentinel").unwrap();

        for slug in ["../escape", "/absolute", "a/b", ".", "", ".hidden"] {
            assert!(matches!(
                create(&unusable_root, slug, &minimal_file()),
                Err(BaseDocumentError::InvalidSlug(value)) if value == slug
            ));
            assert!(matches!(
                update(&unusable_root, slug, "stale", &minimal_file()),
                Err(BaseDocumentError::InvalidSlug(value)) if value == slug
            ));
            assert!(matches!(
                delete(&unusable_root, slug, "stale"),
                Err(BaseDocumentError::InvalidSlug(value)) if value == slug
            ));
        }

        assert_eq!(fs::read(&unusable_root).unwrap(), b"sentinel");
    }

    #[test]
    fn create_uses_stable_canonical_serialization() {
        let root = tempfile::tempdir().unwrap();

        let stored = create(root.path(), "reading", &minimal_file()).unwrap();
        let raw = fs::read_to_string(root.path().join("bases/reading.base.toml")).unwrap();

        assert_eq!(raw, MINIMAL_BASE);
        assert_eq!(stored.definition.slug, "reading");
        assert_eq!(stored.definition.file.name, "Reading");
        assert_eq!(stored.revision, revision(MINIMAL_BASE));
    }

    #[test]
    fn create_never_overwrites_an_existing_base() {
        let fixture = fixture_base("# sentinel\nname = \"Existing\"\n\n[properties]\n");
        let before = fs::read(fixture.path()).unwrap();

        let error = create(fixture.root(), "reading", &minimal_file()).unwrap_err();

        assert!(matches!(error, BaseDocumentError::AlreadyExists(slug) if slug == "reading"));
        assert_eq!(fs::read(fixture.path()).unwrap(), before);
    }

    #[test]
    fn stale_update_does_not_touch_file() {
        let fixture = fixture_base(MINIMAL_BASE);
        let before = fs::read(fixture.path()).unwrap();

        let error = update(fixture.root(), "reading", "stale", &minimal_file()).unwrap_err();

        assert!(matches!(
            error,
            BaseDocumentError::Conflict { current_revision }
                if current_revision == revision(MINIMAL_BASE)
        ));
        assert_eq!(fs::read(fixture.path()).unwrap(), before);
    }

    #[test]
    fn update_rechecks_revision_immediately_before_publication() {
        let fixture = fixture_base(MINIMAL_BASE);
        let before = fs::read_to_string(fixture.path()).unwrap();
        let external = "name = \"Externally edited\"\nproperties = {}\n";
        let mut next = minimal_file();
        next.description = Some("Books".into());

        let error = update_with_before_publication(
            fixture.root(),
            "reading",
            &revision(&before),
            &next,
            || fs::write(fixture.path(), external).unwrap(),
        )
        .unwrap_err();

        assert!(matches!(
            error,
            BaseDocumentError::Conflict { current_revision }
                if current_revision == revision(external)
        ));
        assert_eq!(fs::read_to_string(fixture.path()).unwrap(), external);
    }

    #[test]
    fn clepsydra_updates_serialize_and_the_second_writer_conflicts() {
        let fixture = fixture_base(MINIMAL_BASE);
        let expected_revision = revision(MINIMAL_BASE);
        let mut first = minimal_file();
        first.description = Some("First".into());
        let mut second = minimal_file();
        second.description = Some("Second".into());
        let first_root = fixture.root().to_path_buf();
        let second_root = fixture.root().to_path_buf();
        let first_revision = expected_revision.clone();
        let second_revision = expected_revision.clone();
        let (first_ready_tx, first_ready_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();
        let (second_started_tx, second_started_rx) = mpsc::channel();

        let first_writer = thread::spawn(move || {
            update_with_before_publication(&first_root, "reading", &first_revision, &first, || {
                first_ready_tx.send(()).unwrap();
                release_first_rx.recv().unwrap();
            })
        });
        first_ready_rx.recv().unwrap();
        let second_writer = thread::spawn(move || {
            second_started_tx.send(()).unwrap();
            update(&second_root, "reading", &second_revision, &second)
        });
        second_started_rx.recv().unwrap();
        release_first_tx.send(()).unwrap();

        let first_stored = first_writer.join().unwrap().unwrap();
        let second_error = second_writer.join().unwrap().unwrap_err();

        assert!(matches!(
            second_error,
            BaseDocumentError::Conflict { current_revision }
                if current_revision == first_stored.revision
        ));
        assert_eq!(
            load_for_test(fixture.root(), "reading")
                .definition
                .file
                .description
                .as_deref(),
            Some("First")
        );
    }

    #[test]
    fn publication_errors_preserve_the_atomic_failure_phase() {
        let already_exists = map_create_error(
            "reading",
            AtomicPublicationError::NotPublished(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "destination exists",
            )),
        );
        assert!(matches!(
            already_exists,
            BaseDocumentError::AlreadyExists(slug) if slug == "reading"
        ));

        let create_not_durable = map_create_error(
            "reading",
            AtomicPublicationError::PublishedButNotDurable(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "directory sync failed",
            )),
        );
        assert!(matches!(
            create_not_durable,
            BaseDocumentError::PublishedButNotDurable(error)
                if error.kind() == io::ErrorKind::AlreadyExists
        ));

        let update_not_durable =
            map_publication_error(AtomicPublicationError::PublishedButNotDurable(
                io::Error::new(io::ErrorKind::Other, "directory sync failed"),
            ));
        assert!(matches!(
            update_not_durable,
            BaseDocumentError::PublishedButNotDurable(error)
                if error.kind() == io::ErrorKind::Other
        ));
    }

    #[test]
    fn invalid_update_is_rejected_before_atomic_publication() {
        let fixture = fixture_base(MINIMAL_BASE);
        let before = fs::read(fixture.path()).unwrap();
        let mut invalid = minimal_file();
        invalid.name.clear();

        let error =
            update(fixture.root(), "reading", &revision(MINIMAL_BASE), &invalid).unwrap_err();

        assert!(matches!(error, BaseDocumentError::InvalidDefinition(_)));
        assert_eq!(fs::read(fixture.path()).unwrap(), before);
    }

    #[test]
    fn update_preserves_comments_unknown_keys_and_unchanged_nodes() {
        let fixture = fixture_base(
            "# owner note\nname = \"Reading\"\nplugin_key = \"keep\"\n\n[properties]\n# vocabulary\nstatus = { type = \"select\", options = [\"queued\"] }\n\n[[views]]\nname = \"All\"\nlayout = \"table\"\n",
        );
        let before = fs::read_to_string(fixture.path()).unwrap();
        let current = load_for_test(fixture.root(), "reading");
        let mut next = current.definition.file.clone();
        next.description = Some("Books".into());

        update(fixture.root(), "reading", &current.revision, &next).unwrap();
        let after = fs::read_to_string(fixture.path()).unwrap();

        assert!(after.contains("# owner note\nname = \"Reading\""));
        assert!(after.contains("plugin_key = \"keep\""));
        assert!(after.contains(
            "[properties]\n# vocabulary\nstatus = { type = \"select\", options = [\"queued\"] }"
        ));
        assert!(after.contains("[[views]]\nname = \"All\"\nlayout = \"table\""));
        assert!(after.contains("description = \"Books\""));
        assert_ne!(before, after);
    }

    #[test]
    fn changed_nested_tables_preserve_comments_and_unsupported_keys() {
        let fixture = fixture_base(
            "name = \"Reading\"\nplugin_key = \"keep\"\n\n[properties.status]\n# vocabulary kind\ntype = \"select\"\n# vocabulary values\noptions = [\"queued\"]\nplugin_option = \"keep\"\n",
        );
        let current = load_for_test(fixture.root(), "reading");
        let mut next = current.definition.file.clone();
        next.properties[0].1.options.push("done".into());

        update(fixture.root(), "reading", &current.revision, &next).unwrap();
        let after = fs::read_to_string(fixture.path()).unwrap();

        assert!(after.contains("plugin_key = \"keep\""));
        assert!(after.contains("# vocabulary kind\ntype = \"select\""));
        assert!(after.contains("# vocabulary values\noptions = [\"queued\", \"done\"]"));
        assert!(after.contains("plugin_option = \"keep\""));
    }

    #[test]
    fn changed_arrays_preserve_element_comments() {
        let fixture = fixture_base(
            "name = \"Reading\"\n\n[properties.status]\ntype = \"select\"\noptions = [\n  \"queued\", # keep queued\n]\n",
        );
        let current = load_for_test(fixture.root(), "reading");
        let mut next = current.definition.file.clone();
        next.properties[0].1.options.push("done".into());

        update(fixture.root(), "reading", &current.revision, &next).unwrap();
        let after = fs::read_to_string(fixture.path()).unwrap();

        assert!(after.contains("# keep queued"));
        assert!(after.contains("\"done\""));
    }

    #[test]
    fn changed_view_tables_preserve_comments_and_unsupported_keys() {
        let fixture = fixture_base(
            "name = \"Reading\"\n\n[[views]]\n# saved view\nname = \"All\"\nlayout = \"table\"\nplugin_view = \"keep\"\n",
        );
        let current = load_for_test(fixture.root(), "reading");
        let mut next = current.definition.file.clone();
        next.views[0].name = "Library".into();

        update(fixture.root(), "reading", &current.revision, &next).unwrap();
        let after = fs::read_to_string(fixture.path()).unwrap();

        assert!(after.contains("# saved view\nname = \"Library\""));
        assert!(after.contains("layout = \"table\""));
        assert!(after.contains("plugin_view = \"keep\""));
    }

    #[test]
    fn removal_that_would_drop_a_comment_is_rejected() {
        let fixture = fixture_base(
            "name = \"Reading\"\n# keep description context\ndescription = \"Books\"\nproperties = {}\n",
        );
        let before = fs::read_to_string(fixture.path()).unwrap();
        let current = load_for_test(fixture.root(), "reading");
        let mut next = current.definition.file.clone();
        next.description = None;

        let error = update(fixture.root(), "reading", &current.revision, &next).unwrap_err();

        assert!(matches!(error, BaseDocumentError::UnsupportedDocument(_)));
        assert_eq!(fs::read_to_string(fixture.path()).unwrap(), before);
    }

    #[test]
    fn unsafe_managed_shape_is_rejected_without_touching_file() {
        let fixture = fixture_base("name = \"Reading\"\nproperties = []\n");
        let before = fs::read_to_string(fixture.path()).unwrap();

        let error = update(
            fixture.root(),
            "reading",
            &revision(&before),
            &minimal_file(),
        )
        .unwrap_err();

        assert!(matches!(error, BaseDocumentError::UnsupportedDocument(_)));
        assert_eq!(fs::read_to_string(fixture.path()).unwrap(), before);
    }

    #[test]
    fn stale_delete_does_not_touch_file() {
        let fixture = fixture_base(MINIMAL_BASE);
        let before = fs::read(fixture.path()).unwrap();

        let error = delete(fixture.root(), "reading", "stale").unwrap_err();

        assert!(matches!(error, BaseDocumentError::Conflict { .. }));
        assert_eq!(fs::read(fixture.path()).unwrap(), before);
    }

    #[test]
    fn delete_rechecks_revision_immediately_before_removal() {
        let fixture = fixture_base(MINIMAL_BASE);
        let external = "name = \"Externally edited\"\nproperties = {}\n";

        let error =
            delete_with_before_removal(fixture.root(), "reading", &revision(MINIMAL_BASE), || {
                fs::write(fixture.path(), external).unwrap()
            })
            .unwrap_err();

        assert!(matches!(
            error,
            BaseDocumentError::Conflict { current_revision }
                if current_revision == revision(external)
        ));
        assert_eq!(fs::read_to_string(fixture.path()).unwrap(), external);
    }

    #[test]
    fn delete_removes_only_the_base_file() {
        let fixture = fixture_base(MINIMAL_BASE);
        let page = fixture.root().join("Reading.md");
        let page_bytes = b"+++\ntitle = \"Reading\"\n+++\nNotes.\n";
        fs::write(&page, page_bytes).unwrap();

        delete(fixture.root(), "reading", &revision(MINIMAL_BASE)).unwrap();

        assert!(!fixture.path().exists());
        assert_eq!(fs::read(page).unwrap(), page_bytes);
    }

    #[test]
    fn changing_a_property_keeps_the_definition_valid() {
        let fixture = fixture_base(MINIMAL_BASE);
        let current = load_for_test(fixture.root(), "reading");
        let mut next = current.definition.file.clone();
        next.properties.push((
            "status".into(),
            PropertyDefinition {
                property_type: PropertyType::Select,
                options: vec!["queued".into()],
                many: None,
            },
        ));

        let stored = update(fixture.root(), "reading", &current.revision, &next).unwrap();

        assert_eq!(stored.definition.file.properties.len(), 1);
        assert_eq!(stored.definition.file.properties[0].0, "status");
        assert!(stored.diagnostics.is_empty());
    }
}
