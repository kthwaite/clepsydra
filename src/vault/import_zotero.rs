use std::collections::HashSet;
use std::path::{Path, PathBuf};

use regex::Regex;
use rusqlite::{Connection, OpenFlags};

use crate::vault::academic::WorkType;
use crate::vault::import::BibImportEntry;

/// Skip these words when picking the first significant title word.
const SKIP_WORDS: &[&str] = &["a", "an", "the", "on"];

// ── Import request ─────────────────────────────────────────────────────────

/// Request for importing from Zotero.
#[derive(Debug, serde::Deserialize, utoipa::ToSchema)]
pub struct ImportZoteroRequest {
    #[serde(default)]
    pub database_path: Option<String>,
    #[serde(default)]
    pub collection: Option<String>,
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
    /// When true (default), automatically use the last checkpoint as `since`
    /// if no explicit `since` is provided, and save a new checkpoint after
    /// a successful import.
    #[serde(default = "default_true")]
    pub auto_checkpoint: bool,
    #[serde(default)]
    pub conflict_policy: ConflictPolicy,
}

fn default_true() -> bool {
    true
}

/// How to handle items that already exist locally.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    /// Skip items that already exist (current behavior).
    #[default]
    Skip,
    /// Overwrite mapped metadata fields from Zotero, preserving local-only content.
    SourceWins,
    /// Report conflicts without modifying anything.
    Manual,
}

/// A single field-level difference between local and source metadata.
#[derive(Debug, Clone, serde::Serialize, utoipa::ToSchema)]
pub struct FieldDiff {
    pub field: String,
    pub local_value: Option<String>,
    pub source_value: Option<String>,
}

/// Conflict detail returned for `Manual` conflict policy.
#[derive(Debug, Clone, serde::Serialize, utoipa::ToSchema)]
pub struct ConflictDetail {
    pub fields: Vec<FieldDiff>,
}

// ── Zotero database types and query functions ──────────────────────────────

/// Raw query result from Zotero's EAV tables.
#[derive(Debug, Clone)]
pub struct ZoteroItem {
    pub item_id: i64,
    pub zotero_key: String,
    pub item_type: String,
    pub title: String,
    pub date_raw: Option<String>,
    pub doi: Option<String>,
    pub isbn: Option<String>,
    pub url: Option<String>,
    pub venue: Option<String>,
    pub publisher: Option<String>,
    pub extra_field: Option<String>,
    pub authors: Vec<ZoteroAuthor>,
    pub tags: Vec<String>,
    pub pdf_attachments: Vec<ZoteroPdf>,
}

#[derive(Debug, Clone)]
pub struct ZoteroAuthor {
    pub first_name: String,
    pub last_name: String,
    pub field_mode: i32,
}

#[derive(Debug, Clone)]
pub struct ZoteroPdf {
    pub link_mode: i32,
    pub path: Option<String>,
    pub attachment_key: String,
}

/// Auto-detect the default Zotero database path.
pub fn detect_zotero_db() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let path = home.join("Zotero/zotero.sqlite");
    if path.exists() { Some(path) } else { None }
}

/// Resolve the Zotero database path from the request, the vault config, or
/// auto-detection (in that priority order). Tilde-expands `~/` using `home`.
///
/// Does **not** check whether the resolved path exists — the caller does that.
/// Returns `Err(String)` when tilde expansion fails or no path can be found.
pub fn resolve_zotero_db_path(
    request_path: Option<&str>,
    configured_path: Option<&str>,
    home: Option<&Path>,
) -> Result<PathBuf, String> {
    fn expand_tilde(s: &str, home: Option<&Path>) -> Result<PathBuf, String> {
        if let Some(rest) = s.strip_prefix("~/") {
            let home = home.ok_or_else(|| "Cannot expand ~".to_string())?;
            Ok(home.join(rest))
        } else {
            Ok(PathBuf::from(s))
        }
    }

    if let Some(p) = request_path {
        return expand_tilde(p, home);
    }
    if let Some(p) = configured_path {
        return expand_tilde(p, home);
    }
    if let Some(detected) = detect_zotero_db() {
        return Ok(detected);
    }
    Err(
        "No Zotero database path provided and auto-detection failed. \
         Please specify database_path or configure it in config.toml."
            .to_string(),
    )
}

/// Open a Zotero SQLite database read-only.
pub fn open_zotero_db(path: &Path) -> Result<Connection, String> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    Connection::open_with_flags(path, flags)
        .map_err(|e| format!("failed to open Zotero database at {}: {e}", path.display()))
}

/// Row type from the main EAV query.
type ItemRow = (
    i64,           // item_id
    String,        // zotero_key
    String,        // item_type
    Option<String>, // title
    Option<String>, // date_raw
    Option<String>, // doi
    Option<String>, // isbn
    Option<String>, // url
    Option<String>, // venue
    Option<String>, // publisher
    Option<String>, // extra_field
);

/// Query bibliographic items from the Zotero database.
pub fn query_items(
    conn: &Connection,
    collection: Option<&str>,
    since: Option<&str>,
) -> Result<Vec<ZoteroItem>, String> {
    let mut sql = String::from(
        "SELECT
            i.itemID,
            i.key AS zotero_key,
            i.dateModified,
            it.typeName AS item_type,
            MAX(CASE WHEN f.fieldName = 'title' THEN idv.value END) AS title,
            MAX(CASE WHEN f.fieldName = 'date' THEN idv.value END) AS date_raw,
            MAX(CASE WHEN f.fieldName = 'DOI' THEN idv.value END) AS doi,
            MAX(CASE WHEN f.fieldName = 'ISBN' THEN idv.value END) AS isbn,
            MAX(CASE WHEN f.fieldName = 'url' THEN idv.value END) AS url,
            MAX(CASE WHEN f.fieldName = 'publicationTitle' THEN idv.value END) AS venue,
            MAX(CASE WHEN f.fieldName = 'publisher' THEN idv.value END) AS publisher,
            MAX(CASE WHEN f.fieldName = 'extra' THEN idv.value END) AS extra_field
        FROM items i
        JOIN itemTypes it ON it.itemTypeID = i.itemTypeID
        LEFT JOIN itemData id ON id.itemID = i.itemID
        LEFT JOIN itemDataValues idv ON idv.valueID = id.valueID
        LEFT JOIN fields f ON f.fieldID = id.fieldID
        WHERE it.typeName IN ('journalArticle','conferencePaper','book','bookSection','thesis','report','preprint')
        AND i.itemID NOT IN (SELECT itemID FROM deletedItems)"
    );

    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut param_idx = 1u32;

    if let Some(coll) = collection {
        sql.push_str(&format!(
            " AND i.itemID IN (
                SELECT ci.itemID FROM collectionItems ci
                JOIN collections c ON c.collectionID = ci.collectionID
                WHERE c.collectionName = ?{param_idx}
            )"
        ));
        param_values.push(Box::new(coll.to_string()));
        param_idx += 1;
    }

    if let Some(since_ts) = since {
        sql.push_str(&format!(" AND i.dateModified > ?{param_idx}"));
        param_values.push(Box::new(since_ts.to_string()));
        param_idx += 1;
    }

    let _ = param_idx;
    sql.push_str(" GROUP BY i.itemID ORDER BY i.itemID");

    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|b| b.as_ref()).collect();

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<ItemRow> = stmt
        .query_map(param_refs.as_slice(), |row| {
            Ok((
                row.get(0)?, row.get(1)?, row.get(3)?,
                row.get(4)?, row.get(5)?, row.get(6)?,
                row.get(7)?, row.get(8)?, row.get(9)?,
                row.get(10)?, row.get(11)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    // Batch-load creators
    let mut creators_stmt = conn.prepare(
        "SELECT ic.itemID, c.firstName, c.lastName, c.fieldMode
         FROM itemCreators ic
         JOIN creators c ON c.creatorID = ic.creatorID
         JOIN creatorTypes ct ON ct.creatorTypeID = ic.creatorTypeID
         WHERE ct.creatorType = 'author'
         ORDER BY ic.itemID, ic.orderIndex"
    ).map_err(|e| e.to_string())?;
    let all_creators: Vec<(i64, String, String, i32)> = creators_stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    // Batch-load tags
    let mut tags_stmt = conn.prepare(
        "SELECT it.itemID, t.name FROM itemTags it JOIN tags t ON t.tagID = it.tagID ORDER BY it.itemID"
    ).map_err(|e| e.to_string())?;
    let all_tags: Vec<(i64, String)> = tags_stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    // Batch-load PDF attachments
    let mut att_stmt = conn.prepare(
        "SELECT ia.parentItemID, ia.linkMode, ia.path, i.key
         FROM itemAttachments ia
         JOIN items i ON i.itemID = ia.itemID
         WHERE ia.contentType = 'application/pdf' AND ia.parentItemID IS NOT NULL"
    ).map_err(|e| e.to_string())?;
    let all_attachments: Vec<(i64, i32, Option<String>, String)> = att_stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    // Assemble
    let mut items = Vec::with_capacity(rows.len());
    for (item_id, zotero_key, item_type, title, date_raw, doi, isbn, url, venue, publisher, extra_field) in rows {
        let authors: Vec<ZoteroAuthor> = all_creators.iter()
            .filter(|(id, _, _, _)| *id == item_id)
            .map(|(_, f, l, m)| ZoteroAuthor {
                first_name: f.clone(),
                last_name: l.clone(),
                field_mode: *m,
            })
            .collect();

        let tags: Vec<String> = all_tags.iter()
            .filter(|(id, _)| *id == item_id)
            .map(|(_, name)| name.clone())
            .collect();

        let pdf_attachments: Vec<ZoteroPdf> = all_attachments.iter()
            .filter(|(parent_id, _, _, _)| *parent_id == item_id)
            .map(|(_, lm, p, k)| ZoteroPdf {
                link_mode: *lm,
                path: p.clone(),
                attachment_key: k.clone(),
            })
            .collect();

        items.push(ZoteroItem {
            item_id,
            zotero_key,
            item_type,
            title: title.unwrap_or_default(),
            date_raw,
            doi,
            isbn,
            url,
            venue,
            publisher,
            extra_field,
            authors,
            tags,
            pdf_attachments,
        });
    }

    Ok(items)
}

/// Derive a citation key for a Zotero item.
///
/// 1. If `extra_field` contains `Citation Key: <value>` (set by Better BibTeX),
///    use that value directly.
/// 2. Otherwise, derive from `{last_name}{year}{first_significant_title_word}`.
/// 3. If the result collides with `existing_keys`, append `-b`, `-c`, etc.
pub fn derive_cite_key(
    extra_field: Option<&str>,
    authors: &[String],
    year: Option<i32>,
    title: &str,
    existing_keys: &HashSet<String>,
) -> String {
    // 1. Check BBT extra field
    if let Some(extra) = extra_field {
        let re = Regex::new(r"(?m)^Citation Key:\s*(.+)$").unwrap();
        if let Some(caps) = re.captures(extra) {
            let bbt_key = caps[1].trim().to_string();
            if !bbt_key.is_empty() {
                return bbt_key;
            }
        }
    }

    // 2. Derive from metadata
    let author_part = authors
        .first()
        .map(|a| {
            let last = a.split_whitespace().last().unwrap_or("anon");
            strip_diacritics(&last.to_lowercase())
        })
        .unwrap_or_else(|| "anon".to_string());

    let year_part = year.map(|y| y.to_string()).unwrap_or_default();

    let title_part = title
        .split_whitespace()
        .map(|w| w.to_lowercase())
        .map(|w| w.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>())
        .find(|w| !w.is_empty() && !SKIP_WORDS.contains(&w.as_str()))
        .unwrap_or_else(|| "untitled".to_string());

    let base = format!("{author_part}{year_part}{title_part}");

    // 3. Handle collisions
    if !existing_keys.contains(&base) {
        return base;
    }

    for suffix in b'b'..=b'z' {
        let candidate = format!("{base}-{}", suffix as char);
        if !existing_keys.contains(&candidate) {
            return candidate;
        }
    }

    // Extremely unlikely: more than 25 collisions
    for first in b'a'..=b'z' {
        for second in b'a'..=b'z' {
            let candidate = format!("{base}-{}{}", first as char, second as char);
            if !existing_keys.contains(&candidate) {
                return candidate;
            }
        }
    }

    format!("{base}-overflow")
}

/// Strip Unicode diacritics by NFKD decomposition + removing combining marks.
fn strip_diacritics(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;

    s.nfkd()
        .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
        .collect()
}

// ── ZoteroItem mapping functions ──────────────────────────────────────────

/// Extract a 4-digit year from Zotero's free-text date field.
fn extract_year(date_raw: Option<&str>) -> Option<i32> {
    let re = Regex::new(r"\b(\d{4})\b").unwrap();
    date_raw
        .and_then(|s| re.captures(s))
        .and_then(|caps| caps[1].parse::<i32>().ok())
        .filter(|y| *y > 1000 && *y < 3000)
}

/// Extract arXiv ID from Zotero's `extra` field.
fn extract_arxiv(extra: Option<&str>) -> Option<String> {
    let re = Regex::new(r"(?im)^arXiv:\s*(.+)$").unwrap();
    extra
        .and_then(|s| re.captures(s))
        .map(|caps| caps[1].trim().to_string())
}

/// Map a Zotero item type name to a Clepsydra WorkType.
fn map_item_type(type_name: &str) -> WorkType {
    match type_name {
        "journalArticle" | "conferencePaper" | "preprint" => WorkType::Paper,
        "book" | "bookSection" => WorkType::Book,
        "thesis" => WorkType::Thesis,
        "report" => WorkType::Report,
        _ => WorkType::Other,
    }
}

/// Format a ZoteroAuthor into a display string.
pub fn format_author(author: &ZoteroAuthor) -> String {
    if author.field_mode == 1 || author.first_name.is_empty() {
        author.last_name.clone()
    } else {
        format!("{} {}", author.first_name, author.last_name)
    }
}

/// Convert a ZoteroItem into a BibImportEntry for the existing import pipeline.
///
/// Does NOT set cite_key — that's handled separately by derive_cite_key().
pub fn map_to_import_entry(item: &ZoteroItem) -> BibImportEntry {
    BibImportEntry {
        cite_key: String::new(), // set by caller via derive_cite_key()
        title: item.title.clone(),
        work_type: map_item_type(&item.item_type),
        authors: item.authors.iter().map(format_author).collect(),
        year: extract_year(item.date_raw.as_deref()),
        venue: item.venue.clone(),
        publisher: item.publisher.clone(),
        doi: item.doi.clone(),
        isbn: item.isbn.clone(),
        arxiv: extract_arxiv(item.extra_field.as_deref()),
        url: item.url.clone(),
    }
}

/// Resolve a Zotero PDF attachment to a filesystem path or URL.
///
/// - linkMode 0 (imported file): storage:<filename> → <data_dir>/storage/<key>/<filename>
/// - linkMode 1 (imported URL): return URL as-is
/// - linkMode 2 (linked file): return absolute path as-is
/// - linkMode 3 (linked URL): return URL as-is
pub fn resolve_attachment_path(zotero_data_dir: &Path, pdf: &ZoteroPdf) -> Option<String> {
    match pdf.link_mode {
        0 => {
            let filename = pdf.path.as_deref()?.strip_prefix("storage:")?;
            let resolved = zotero_data_dir
                .join("storage")
                .join(&pdf.attachment_key)
                .join(filename);
            Some(resolved.to_string_lossy().to_string())
        }
        1 | 3 => pdf.path.clone(),
        2 => pdf.path.clone(),
        _ => None,
    }
}

/// Normalize a user-provided `since` timestamp to Zotero's datetime format.
///
/// Zotero stores `dateModified` as `YYYY-MM-DD HH:MM:SS` (space-separated,
/// no timezone). ISO 8601 variants like `2024-05-01T00:00:00Z` need the `T`
/// replaced with a space and trailing `Z` stripped so that SQLite lexical
/// comparison works correctly.
pub fn normalize_since(since: &str) -> String {
    since
        .replace('T', " ")
        .trim_end_matches('Z')
        .to_string()
}

// ── Deduplication query ────────────────────────────────────────────────────

/// Compare a source import entry against local page metadata.
/// Returns a list of fields where the source and local values differ.
/// Only compares mapped metadata fields (title, year, venue, publisher, doi, isbn).
pub fn compute_field_diffs(source: &BibImportEntry, local: &crate::vault::page::PageMeta) -> Vec<FieldDiff> {
    let mut diffs = Vec::new();

    // Title
    let local_title = local.title.as_deref().unwrap_or("");
    if local_title != source.title {
        diffs.push(FieldDiff {
            field: "title".to_string(),
            local_value: Some(local_title.to_string()),
            source_value: Some(source.title.clone()),
        });
    }

    // Year — compare via extra.year
    let local_year = local.extra.get("year")
        .and_then(|v| match v {
            serde_yaml::Value::Number(n) => n.as_i64().map(|i| i as i32),
            _ => None,
        });
    if local_year != source.year {
        diffs.push(FieldDiff {
            field: "year".to_string(),
            local_value: local_year.map(|y| y.to_string()),
            source_value: source.year.map(|y| y.to_string()),
        });
    }

    // Venue
    let local_venue = local.extra.get("venue")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if local_venue != source.venue {
        diffs.push(FieldDiff {
            field: "venue".to_string(),
            local_value: local_venue,
            source_value: source.venue.clone(),
        });
    }

    // Publisher
    let local_publisher = local.extra.get("publisher")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if local_publisher != source.publisher {
        diffs.push(FieldDiff {
            field: "publisher".to_string(),
            local_value: local_publisher,
            source_value: source.publisher.clone(),
        });
    }

    // DOI — nested in external_ids
    let local_doi = local.extra.get("external_ids")
        .and_then(|v| v.as_mapping())
        .and_then(|m| m.get(serde_yaml::Value::String("doi".to_string())))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if local_doi != source.doi {
        diffs.push(FieldDiff {
            field: "doi".to_string(),
            local_value: local_doi,
            source_value: source.doi.clone(),
        });
    }

    // ISBN — nested in external_ids
    let local_isbn = local.extra.get("external_ids")
        .and_then(|v| v.as_mapping())
        .and_then(|m| m.get(serde_yaml::Value::String("isbn".to_string())))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if local_isbn != source.isbn {
        diffs.push(FieldDiff {
            field: "isbn".to_string(),
            local_value: local_isbn,
            source_value: source.isbn.clone(),
        });
    }

    diffs
}

/// Check if a work was previously imported from Zotero by its item key.
/// Returns Some(vault_path) if found, None otherwise.
pub fn find_existing_by_zotero_key(conn: &rusqlite::Connection, zotero_key: &str) -> Option<String> {
    conn.query_row(
        "SELECT path FROM pages WHERE json_extract(meta_json, '$.import.source') = 'zotero' AND json_extract(meta_json, '$.import.zotero_key') = ?1",
        rusqlite::params![zotero_key],
        |row| row.get(0),
    )
    .ok()
}

/// Apply "source wins" field overwrites from a bibliographic entry onto an
/// already-loaded page's metadata, in place. Pure: no filesystem I/O.
pub fn apply_source_wins_to_meta(
    meta: &mut crate::vault::page::PageMeta,
    entry: &crate::vault::import::BibImportEntry,
) {
    meta.title = Some(entry.title.clone());

    if let Some(year) = entry.year {
        meta.extra.insert("year".to_string(), serde_yaml::Value::Number(year.into()));
    }
    if let Some(ref venue) = entry.venue {
        meta.extra.insert("venue".to_string(), serde_yaml::Value::String(venue.clone()));
    }
    if let Some(ref publisher) = entry.publisher {
        meta.extra.insert("publisher".to_string(), serde_yaml::Value::String(publisher.clone()));
    }

    let authors_val: Vec<serde_yaml::Value> = entry.authors.iter()
        .map(|a| serde_yaml::Value::String(a.clone()))
        .collect();
    meta.extra.insert("authors".to_string(), serde_yaml::Value::Sequence(authors_val));

    let mut ext_ids = serde_yaml::Mapping::new();
    if let Some(ref doi) = entry.doi {
        ext_ids.insert(
            serde_yaml::Value::String("doi".to_string()),
            serde_yaml::Value::String(doi.clone()),
        );
    }
    if let Some(ref isbn) = entry.isbn {
        ext_ids.insert(
            serde_yaml::Value::String("isbn".to_string()),
            serde_yaml::Value::String(isbn.clone()),
        );
    }
    if let Some(ref arxiv) = entry.arxiv {
        ext_ids.insert(
            serde_yaml::Value::String("arxiv".to_string()),
            serde_yaml::Value::String(arxiv.clone()),
        );
    }
    if !ext_ids.is_empty() {
        meta.extra.insert("external_ids".to_string(), serde_yaml::Value::Mapping(ext_ids));
    }

    if let Some(import_val) = meta.extra.get_mut("import") {
        if let serde_yaml::Value::Mapping(import_map) = import_val {
            import_map.insert(
                serde_yaml::Value::String("imported_at".to_string()),
                serde_yaml::Value::String(chrono::Utc::now().to_rfc3339()),
            );
        }
    }
}

// ── Decision kernel ────────────────────────────────────────────────────────

/// What the importer should do with a single item, decided purely from its
/// dedup state, the conflict policy, and the dry-run flag.
#[derive(Debug, PartialEq, Eq)]
pub enum ItemActionKind {
    /// Only record a result; perform no filesystem mutation.
    ReportOnly,
    /// Apply source-wins field updates to the existing page, then reindex.
    ApplySourceWins,
    /// Create a new work page.
    Create,
}

/// The decided action for one item: the `ImportResult.status` string to record
/// and the side effect (if any) to perform.
#[derive(Debug, PartialEq, Eq)]
pub struct ItemAction {
    pub status: &'static str,
    pub kind: ItemActionKind,
}

/// Decide the action for a single Zotero item.
///
/// `exists` is whether a dedup match was found. `has_diffs` is only consulted
/// when `exists && policy == Manual` (whether the source differs from local);
/// pass `false` otherwise. dry_run is intentionally ignored for the Manual
/// policy (matching `import_zotero_handler`'s current behavior).
pub fn decide_item_action(
    exists: bool,
    policy: ConflictPolicy,
    dry_run: bool,
    has_diffs: bool,
) -> ItemAction {
    if !exists {
        return if dry_run {
            ItemAction { status: "would_create", kind: ItemActionKind::ReportOnly }
        } else {
            ItemAction { status: "created", kind: ItemActionKind::Create }
        };
    }
    match policy {
        ConflictPolicy::Skip => ItemAction {
            status: if dry_run { "would_skip" } else { "skipped" },
            kind: ItemActionKind::ReportOnly,
        },
        ConflictPolicy::SourceWins => {
            if dry_run {
                ItemAction { status: "would_update", kind: ItemActionKind::ReportOnly }
            } else {
                ItemAction { status: "updated", kind: ItemActionKind::ApplySourceWins }
            }
        }
        ConflictPolicy::Manual => {
            if has_diffs {
                ItemAction { status: "conflict", kind: ItemActionKind::ReportOnly }
            } else {
                ItemAction { status: "skipped", kind: ItemActionKind::ReportOnly }
            }
        }
    }
}

#[cfg(test)]
mod decide_tests {
    use super::*;

    #[test]
    fn not_existing_creates_or_would_create() {
        assert_eq!(
            decide_item_action(false, ConflictPolicy::Skip, false, false),
            ItemAction { status: "created", kind: ItemActionKind::Create }
        );
        assert_eq!(
            decide_item_action(false, ConflictPolicy::Skip, true, false),
            ItemAction { status: "would_create", kind: ItemActionKind::ReportOnly }
        );
        // Policy is irrelevant when the item does not exist yet.
        assert_eq!(
            decide_item_action(false, ConflictPolicy::Manual, false, false),
            ItemAction { status: "created", kind: ItemActionKind::Create }
        );
    }

    #[test]
    fn existing_skip_policy() {
        assert_eq!(
            decide_item_action(true, ConflictPolicy::Skip, false, false),
            ItemAction { status: "skipped", kind: ItemActionKind::ReportOnly }
        );
        assert_eq!(
            decide_item_action(true, ConflictPolicy::Skip, true, false),
            ItemAction { status: "would_skip", kind: ItemActionKind::ReportOnly }
        );
    }

    #[test]
    fn existing_source_wins() {
        let live = decide_item_action(true, ConflictPolicy::SourceWins, false, false);
        assert_eq!(live, ItemAction { status: "updated", kind: ItemActionKind::ApplySourceWins });
        let dry = decide_item_action(true, ConflictPolicy::SourceWins, true, false);
        assert_eq!(dry, ItemAction { status: "would_update", kind: ItemActionKind::ReportOnly });
    }

    #[test]
    fn existing_manual_ignores_dry_run() {
        // Manual reports conflict/skipped identically in dry and live mode.
        assert_eq!(decide_item_action(true, ConflictPolicy::Manual, false, true).status, "conflict");
        assert_eq!(decide_item_action(true, ConflictPolicy::Manual, true, true).status, "conflict");
        assert_eq!(decide_item_action(true, ConflictPolicy::Manual, false, false).status, "skipped");
        assert_eq!(decide_item_action(true, ConflictPolicy::Manual, true, false).status, "skipped");
    }
}

#[cfg(test)]
mod source_wins_tests {
    use super::*;
    use crate::vault::page::PageMeta;

    fn sample_entry() -> BibImportEntry {
        BibImportEntry {
            cite_key: "smith2020".into(),
            title: "A Study".into(),
            work_type: WorkType::Paper,
            authors: vec!["Smith, J.".into()],
            year: Some(2020),
            venue: Some("Nature".into()),
            publisher: None,
            doi: Some("10.1/x".into()),
            isbn: None,
            arxiv: None,
            url: None,
        }
    }

    #[test]
    fn overwrites_title_and_scalar_fields() {
        let mut meta = PageMeta::new();
        apply_source_wins_to_meta(&mut meta, &sample_entry());
        assert_eq!(meta.title.as_deref(), Some("A Study"));
        assert_eq!(meta.extra.get("year"), Some(&serde_yaml::Value::Number(2020.into())));
        assert_eq!(meta.extra.get("venue"), Some(&serde_yaml::Value::String("Nature".into())));
    }

    #[test]
    fn builds_external_ids_only_for_present_fields() {
        let mut meta = PageMeta::new();
        apply_source_wins_to_meta(&mut meta, &sample_entry());
        let ext = meta.extra.get("external_ids").expect("external_ids present");
        let serde_yaml::Value::Mapping(m) = ext else { panic!("expected mapping") };
        assert!(m.contains_key(serde_yaml::Value::String("doi".into())));
        assert!(!m.contains_key(serde_yaml::Value::String("isbn".into())));
    }

    #[test]
    fn imported_at_updates_existing_import_mapping() {
        let mut meta = PageMeta::new();
        let mut import_map = serde_yaml::Mapping::new();
        import_map.insert(
            serde_yaml::Value::String("source".into()),
            serde_yaml::Value::String("zotero".into()),
        );
        meta.extra.insert("import".into(), serde_yaml::Value::Mapping(import_map));
        apply_source_wins_to_meta(&mut meta, &sample_entry());
        let serde_yaml::Value::Mapping(m) = meta.extra.get("import").unwrap() else { panic!() };
        assert!(m.contains_key(serde_yaml::Value::String("imported_at".into())));
    }

    #[test]
    fn imported_at_is_not_created_when_import_key_absent() {
        // Fresh meta has no "import" mapping; the helper must not create one.
        let mut meta = PageMeta::new();
        apply_source_wins_to_meta(&mut meta, &sample_entry());
        assert!(!meta.extra.contains_key("import"));
    }
}

#[cfg(test)]
mod resolve_db_path_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn explicit_path_returned_as_is() {
        let home = Path::new("/home/user");
        let result = resolve_zotero_db_path(Some("/absolute/zotero.sqlite"), None, Some(home));
        assert_eq!(result.unwrap(), PathBuf::from("/absolute/zotero.sqlite"));
    }

    #[test]
    fn explicit_tilde_path_expanded() {
        let home = Path::new("/home/user");
        let result = resolve_zotero_db_path(Some("~/Zotero/zotero.sqlite"), None, Some(home));
        assert_eq!(result.unwrap(), PathBuf::from("/home/user/Zotero/zotero.sqlite"));
    }

    #[test]
    fn configured_path_used_when_no_request() {
        let home = Path::new("/home/user");
        let result = resolve_zotero_db_path(None, Some("/configured/zotero.sqlite"), Some(home));
        assert_eq!(result.unwrap(), PathBuf::from("/configured/zotero.sqlite"));
    }

    #[test]
    fn configured_tilde_expanded() {
        let home = Path::new("/home/user");
        let result = resolve_zotero_db_path(None, Some("~/custom/zotero.sqlite"), Some(home));
        assert_eq!(result.unwrap(), PathBuf::from("/home/user/custom/zotero.sqlite"));
    }

    #[test]
    fn tilde_expansion_fails_without_home() {
        let result = resolve_zotero_db_path(Some("~/Zotero/zotero.sqlite"), None, None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Cannot expand ~"));
    }

    #[test]
    fn explicit_path_returned_without_existence_check() {
        // An explicit request path is resolved verbatim — `resolve_zotero_db_path`
        // performs no existence check, so a nonexistent path still returns Ok.
        // (Detection via `detect_zotero_db` is only reached when both request and
        // config are None; that branch is not exercised here.)
        let result = resolve_zotero_db_path(
            Some("/nonexistent/path/zotero.sqlite"),
            None,
            Some(Path::new("/home/user")),
        );
        assert_eq!(
            result.unwrap(),
            PathBuf::from("/nonexistent/path/zotero.sqlite")
        );
    }
}
