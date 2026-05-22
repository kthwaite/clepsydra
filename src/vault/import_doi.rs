use crate::vault::academic::WorkType;
use crate::vault::import::BibImportEntry;

/// Parse a Crossref API JSON response into a `BibImportEntry`.
///
/// Crossref response shape:
/// - `message.type` -> "journal-article", "book", "dissertation", "report", etc.
/// - `message.title` -> array of strings (take first)
/// - `message.author` -> array of `{given, family, sequence}` objects
/// - `message.published-print.date-parts` or `message.published-online.date-parts` -> `[[year, month?, day?]]`
/// - `message.container-title` -> array of strings (journal name, take first)
/// - `message.publisher` -> string
/// - `message.DOI` -> string
/// - `message.ISBN` -> array of strings (take first)
pub fn parse_crossref_response(json: &serde_json::Value) -> Result<BibImportEntry, String> {
    let msg = json.get("message").ok_or("missing 'message' field")?;

    let title = msg
        .get("title")
        .and_then(|t| t.as_array())
        .and_then(|a| a.first())
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();

    let work_type = match msg.get("type").and_then(|t| t.as_str()) {
        Some("book" | "monograph" | "edited-book") => WorkType::Book,
        Some("dissertation") => WorkType::Thesis,
        Some("report" | "report-component") => WorkType::Report,
        _ => WorkType::Paper,
    };

    let authors: Vec<String> = msg
        .get("author")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    let given = a.get("given").and_then(|g| g.as_str()).unwrap_or("");
                    let family = a.get("family").and_then(|f| f.as_str()).unwrap_or("");
                    if family.is_empty() {
                        None
                    } else if given.is_empty() {
                        Some(family.to_string())
                    } else {
                        Some(format!("{given} {family}"))
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    let year = msg
        .get("published-print")
        .or_else(|| msg.get("published-online"))
        .and_then(|p| p.get("date-parts"))
        .and_then(|d| d.as_array())
        .and_then(|a| a.first())
        .and_then(|inner| inner.as_array())
        .and_then(|parts| parts.first())
        .and_then(|y| y.as_i64())
        .map(|y| y as i32);

    let venue = msg
        .get("container-title")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());

    let publisher = msg
        .get("publisher")
        .and_then(|p| p.as_str())
        .map(|s| s.to_string());

    let doi = msg
        .get("DOI")
        .and_then(|d| d.as_str())
        .map(|s| s.to_string());

    let isbn = msg
        .get("ISBN")
        .and_then(|i| i.as_array())
        .and_then(|a| a.first())
        .and_then(|i| i.as_str())
        .map(|s| s.to_string());

    let cite_key = generate_cite_key(&authors, year, &title);

    Ok(BibImportEntry {
        cite_key,
        title,
        work_type,
        authors,
        year,
        venue,
        publisher,
        doi,
        isbn,
        arxiv: None,
        url: None,
    })
}

pub const DEFAULT_CROSSREF_BASE: &str = "https://api.crossref.org";

/// Fetch metadata for a DOI from the Crossref API.
pub async fn fetch_doi(doi: &str, base_url: &str) -> Result<serde_json::Value, String> {
    let url = format!("{base_url}/works/{doi}");
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header(
            "User-Agent",
            "Clepsydra/0.0.0 (https://github.com/clepsydra)",
        )
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Crossref API returned {}", resp.status()));
    }

    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse Crossref response: {e}"))
}

/// Generate a cite_key from author, year, title.
///
/// Example: authors=\["G. Kucsko"\], year=Some(2013), title="Nanometre-scale..." -> "kucsko2013nanometre"
pub fn generate_cite_key(authors: &[String], year: Option<i32>, title: &str) -> String {
    let author_part = authors
        .first()
        .map(|a| {
            a.split_whitespace()
                .last()
                .unwrap_or("unknown")
                .to_lowercase()
        })
        .unwrap_or_else(|| "unknown".to_string());

    let year_part = year.map(|y| y.to_string()).unwrap_or_default();

    let title_part = title
        .split_whitespace()
        .next()
        .unwrap_or("untitled")
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>();

    format!("{author_part}{year_part}{title_part}")
}
