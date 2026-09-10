//! Geocoding via the OpenStreetMap Nominatim API.
//!
//! Used by the `GET /api/vault/geocode` proxy so the frontend can resolve a
//! free-text place name (e.g. `"London"`) into latitude/longitude candidates
//! for the Atrium location picker. Mirrors [`crate::vault::import_doi`]: the
//! `base_url` is a parameter so tests can point at a mock server.
//!
//! Nominatim's `/search?format=json` endpoint returns an array where each item
//! carries `lat`/`lon` as **strings** and a `display_name`. We parse the
//! coordinates to `f64`, map `display_name` to a label, and silently skip any
//! item whose coordinates do not parse.

use serde::Serialize;

/// A single geocoding candidate.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GeocodeResult {
    /// Human-readable place name (Nominatim `display_name`).
    pub label: String,
    /// Latitude in degrees.
    pub latitude: f64,
    /// Longitude in degrees.
    pub longitude: f64,
}

/// Query Nominatim for place-name candidates.
///
/// Performs `GET {base_url}/search?format=json&q={q}&limit={limit}&addressdetails=0`
/// with a descriptive `User-Agent` (Nominatim requires one). Returns the parsed
/// candidate list, or an `Err(String)` on transport/HTTP/decode failure (which
/// the caller maps to a 502).
pub async fn geocode(
    client: &reqwest::Client,
    base_url: &str,
    q: &str,
    limit: u32,
) -> Result<Vec<GeocodeResult>, String> {
    let url = format!("{base_url}/search");
    let resp = client
        .get(&url)
        .query(&[
            ("format", "json"),
            ("q", q),
            ("limit", &limit.to_string()),
            ("addressdetails", "0"),
        ])
        .header(
            "User-Agent",
            "Clepsydra/0.0.0 (https://github.com/clepsydra)",
        )
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Nominatim API returned {}", resp.status()));
    }

    let body = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse Nominatim response: {e}"))?;

    let items = body.as_array().cloned().unwrap_or_default();
    let results = items
        .iter()
        .filter_map(|item| {
            let latitude = item.get("lat")?.as_str()?.parse::<f64>().ok()?;
            let longitude = item.get("lon")?.as_str()?.parse::<f64>().ok()?;
            let label = item.get("display_name")?.as_str()?.to_string();
            Some(GeocodeResult {
                label,
                latitude,
                longitude,
            })
        })
        .collect();

    Ok(results)
}
