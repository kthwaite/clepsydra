use clepsydra::vault::geocode::geocode;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn geocode_parses_nominatim_string_coordinates() {
    let server = MockServer::start().await;
    // Nominatim returns lat/lon as STRINGS, plus a display_name.
    let body = serde_json::json!([
        {
            "lat": "51.5073219",
            "lon": "-0.1276474",
            "display_name": "London, Greater London, England, United Kingdom"
        },
        {
            "lat": "42.9832406",
            "lon": "-81.2496068",
            "display_name": "London, Ontario, Canada"
        }
    ]);
    Mock::given(method("GET"))
        .and(path("/search"))
        .respond_with(ResponseTemplate::new(200).set_body_json(&body))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let results = geocode(&client, &server.uri(), "London", 5)
        .await
        .expect("geocode should succeed");

    assert_eq!(results.len(), 2);
    assert_eq!(
        results[0].label,
        "London, Greater London, England, United Kingdom"
    );
    assert!((results[0].latitude - 51.5073219).abs() < 1e-6);
    assert!((results[0].longitude - -0.1276474).abs() < 1e-6);
    assert_eq!(results[1].label, "London, Ontario, Canada");
    assert!((results[1].latitude - 42.9832406).abs() < 1e-6);
}

#[tokio::test]
async fn geocode_returns_empty_vec_for_no_matches() {
    let server = MockServer::start().await;
    let body = serde_json::json!([]);
    Mock::given(method("GET"))
        .and(path("/search"))
        .respond_with(ResponseTemplate::new(200).set_body_json(&body))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let results = geocode(&client, &server.uri(), "asdfqwerty-nowhere", 5)
        .await
        .expect("geocode should succeed");
    assert!(results.is_empty());
}

#[tokio::test]
async fn geocode_skips_items_with_unparseable_coordinates() {
    let server = MockServer::start().await;
    let body = serde_json::json!([
        { "lat": "not-a-number", "lon": "0.0", "display_name": "Bad" },
        { "lat": "1.0", "lon": "2.0", "display_name": "Good" }
    ]);
    Mock::given(method("GET"))
        .and(path("/search"))
        .respond_with(ResponseTemplate::new(200).set_body_json(&body))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let results = geocode(&client, &server.uri(), "x", 5)
        .await
        .expect("geocode should succeed");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].label, "Good");
}

#[tokio::test]
async fn geocode_errors_on_upstream_failure() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/search"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    assert!(geocode(&client, &server.uri(), "x", 5).await.is_err());
}
