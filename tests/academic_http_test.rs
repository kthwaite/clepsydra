use clepsydra::vault::import_doi::{fetch_doi, parse_crossref_response};
use clepsydra::vault::import_isbn::fetch_isbn;
use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn fetch_doi_parses_a_crossref_fixture() {
    let server = MockServer::start().await;
    let body = serde_json::json!({
        "message": {
            "title": ["A Study of Things"],
            "DOI": "10.1234/abcd",
            "issued": { "date-parts": [[2021]] },
            "author": [{ "given": "Ada", "family": "Lovelace" }]
        }
    });
    Mock::given(method("GET"))
        .and(path_regex(r"/works/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(&body))
        .mount(&server)
        .await;
    let json = fetch_doi("10.1234/abcd", &server.uri()).await.unwrap();
    let entry = parse_crossref_response(&json).unwrap();
    assert_eq!(entry.title, "A Study of Things");
}

#[tokio::test]
async fn fetch_doi_errors_on_500() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"/works/.*"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    assert!(fetch_doi("10.1/x", &server.uri()).await.is_err());
}

#[tokio::test]
async fn fetch_isbn_resolves_edition_and_authors() {
    let server = MockServer::start().await;
    let edition = serde_json::json!({
        "title": "Structure and Interpretation",
        "authors": [{ "key": "/authors/OL1A" }],
        "isbn_13": ["9780262011532"]
    });
    Mock::given(method("GET"))
        .and(path("/isbn/9780262011532.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(&edition))
        .mount(&server)
        .await;
    let author = serde_json::json!({ "name": "Harold Abelson" });
    Mock::given(method("GET"))
        .and(path("/authors/OL1A.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(&author))
        .mount(&server)
        .await;
    let (json, authors) = fetch_isbn("9780262011532", &server.uri()).await.unwrap();
    assert!(json.get("title").is_some());
    assert!(authors.iter().any(|a| a.contains("Abelson")));
}

#[tokio::test]
async fn fetch_isbn_errors_on_missing_edition() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"/isbn/.*"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    assert!(fetch_isbn("0000000000000", &server.uri()).await.is_err());
}
