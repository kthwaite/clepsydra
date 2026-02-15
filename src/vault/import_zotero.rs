use std::collections::HashSet;
use std::path::{Path, PathBuf};

use regex::Regex;
use rusqlite::{Connection, OpenFlags};

use crate::vault::academic::WorkType;
use crate::vault::import::BibImportEntry;

/// Skip these words when picking the first significant title word.
const SKIP_WORDS: &[&str] = &["a", "an", "the", "on"];

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

// ── Deduplication query ────────────────────────────────────────────────────

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
