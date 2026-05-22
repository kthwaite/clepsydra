use crate::vault::academic::WorkType;
use crate::vault::import::BibImportEntry;
use crate::vault::import_doi::generate_cite_key;

/// Parse an Open Library edition JSON response into a `BibImportEntry`.
///
/// Open Library `/isbn/{isbn}.json` returns an edition object with fields:
/// - `title` -> string
/// - `authors` -> array of `{key: "/authors/OL..."}` (references, not names)
/// - `publish_date` -> string like "2006" or "January 15, 2006"
/// - `publishers` -> array of strings
/// - `isbn_13` -> array of strings
/// - `isbn_10` -> array of strings
///
/// Author names must be resolved separately via `/authors/{key}.json`.
/// The `authors` parameter contains pre-resolved author names.
pub fn parse_openlibrary_response(
    json: &serde_json::Value,
    authors: &[String],
    isbn: &str,
) -> Result<BibImportEntry, String> {
    let title = json
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();

    let year = json
        .get("publish_date")
        .and_then(|d| d.as_str())
        .and_then(|s| {
            // Extract a 4-digit year from the publish_date string.
            // Could be "2006", "January 15, 2006", "c2006", etc.
            s.split(|c: char| !c.is_ascii_digit())
                .filter_map(|w| w.parse::<i32>().ok())
                .find(|y| *y > 1000 && *y < 3000)
        });

    let publisher = json
        .get("publishers")
        .and_then(|p| p.as_array())
        .and_then(|a| a.first())
        .and_then(|p| p.as_str())
        .map(|s| s.to_string());

    let cite_key = generate_cite_key(authors, year, &title);

    Ok(BibImportEntry {
        cite_key,
        title,
        work_type: WorkType::Book, // ISBN lookup is always a book
        authors: authors.to_vec(),
        year,
        venue: None,
        publisher,
        doi: None,
        isbn: Some(isbn.to_string()),
        arxiv: None,
        url: None,
    })
}

/// Production base URL for the Open Library API. Tests override this with a
/// mock server URL.
pub const DEFAULT_OPENLIBRARY_BASE: &str = "https://openlibrary.org";

/// Fetch book metadata from the Open Library API by ISBN.
/// Returns (edition_json, resolved_author_names).
pub async fn fetch_isbn(isbn: &str, base_url: &str) -> Result<(serde_json::Value, Vec<String>), String> {
    let client = reqwest::Client::new();

    // 1. Fetch edition data
    let edition_url = format!("{base_url}/isbn/{isbn}.json");
    let edition_resp = client
        .get(&edition_url)
        .header(
            "User-Agent",
            "Clepsydra/0.0.0 (https://github.com/clepsydra)",
        )
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {e}"))?;

    if !edition_resp.status().is_success() {
        return Err(format!("Open Library returned {}", edition_resp.status()));
    }

    let edition: serde_json::Value = edition_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Open Library response: {e}"))?;

    // 2. Resolve author names from author key references
    let mut author_names = Vec::new();
    if let Some(authors) = edition.get("authors").and_then(|a| a.as_array()) {
        for author_ref in authors {
            if let Some(key) = author_ref.get("key").and_then(|k| k.as_str()) {
                let author_url = format!("{base_url}{key}.json");
                if let Ok(resp) = client
                    .get(&author_url)
                    .header(
                        "User-Agent",
                        "Clepsydra/0.0.0 (https://github.com/clepsydra)",
                    )
                    .send()
                    .await
                    && let Ok(author_json) = resp.json::<serde_json::Value>().await
                    && let Some(name) = author_json.get("name").and_then(|n| n.as_str())
                {
                    author_names.push(name.to_string());
                }
            }
        }
    }

    Ok((edition, author_names))
}
