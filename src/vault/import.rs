use biblatex::{Bibliography, ChunksExt, DateValue, EntryType, PermissiveType};

use crate::vault::academic::WorkType;

/// A parsed BibTeX entry normalized for import into the vault.
#[derive(Debug, Clone)]
pub struct BibImportEntry {
    pub cite_key: String,
    pub title: String,
    pub work_type: WorkType,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub venue: Option<String>,
    pub publisher: Option<String>,
    pub doi: Option<String>,
    pub isbn: Option<String>,
    pub arxiv: Option<String>,
    pub url: Option<String>,
}

/// Parse a BibTeX/BibLaTeX string into a list of normalized import entries.
pub fn parse_bibtex(input: &str) -> Result<Vec<BibImportEntry>, String> {
    let bibliography =
        Bibliography::parse(input).map_err(|e| format!("BibTeX parse error: {e}"))?;

    let mut entries = Vec::new();

    for entry in bibliography.iter() {
        let cite_key = entry.key.clone();

        let title = entry
            .title()
            .ok()
            .map(|chunks| chunks.format_verbatim())
            .unwrap_or_default();

        let work_type = match entry.entry_type {
            EntryType::Book | EntryType::MvBook => WorkType::Book,
            EntryType::Thesis | EntryType::PhdThesis | EntryType::MastersThesis => {
                WorkType::Thesis
            }
            EntryType::Report | EntryType::TechReport => WorkType::Report,
            _ => WorkType::Paper,
        };

        let authors = entry
            .author()
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.to_string())
            .collect();

        let year = extract_year(entry);

        let venue = entry
            .journal()
            .ok()
            .map(|chunks| chunks.format_verbatim());

        let publisher = entry
            .publisher()
            .ok()
            .and_then(|publishers| publishers.first().map(|c| c.format_verbatim()));

        let doi = entry.doi().ok();

        let isbn = entry.isbn().ok().map(|chunks| chunks.format_verbatim());

        let arxiv = entry
            .eprint()
            .ok()
            .or_else(|| entry.get("arxiv").map(|c| c.format_verbatim()));

        let url = entry.url().ok();

        entries.push(BibImportEntry {
            cite_key,
            title,
            work_type,
            authors,
            year,
            venue,
            publisher,
            doi,
            isbn,
            arxiv,
            url,
        });
    }

    Ok(entries)
}

/// Extract the year from an entry, trying the `date` field first,
/// then falling back to the raw `year` field.
fn extract_year(entry: &biblatex::Entry) -> Option<i32> {
    if let Ok(date) = entry.date() {
        match date {
            PermissiveType::Typed(d) => {
                let year = match d.value {
                    DateValue::At(dt)
                    | DateValue::After(dt)
                    | DateValue::Before(dt) => dt.year,
                    DateValue::Between(dt, _) => dt.year,
                };
                return Some(year);
            }
            PermissiveType::Chunks(chunks) => {
                // Try parsing the raw chunk text as an integer.
                if let Ok(y) = chunks.format_verbatim().trim().parse::<i32>() {
                    return Some(y);
                }
            }
        }
    }

    // Fallback: try the raw "year" field directly.
    entry
        .get("year")
        .and_then(|chunks| chunks.format_verbatim().trim().parse::<i32>().ok())
}
