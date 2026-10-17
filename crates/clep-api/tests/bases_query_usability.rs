mod support;

use serde_json::json;
use std::fs;
use support::ApiFixture;

fn fixture() -> ApiFixture {
    ApiFixture::builder().pre_index_seed(|root| {
        fs::create_dir_all(root.join("bases")).unwrap();
        fs::write(root.join("bases/search.base.toml"), r#"
name = "Search"
filter = { field = "kind", op = "eq", value = "BOOK" }
[properties]
author = { type = "text" }
rating = { type = "number" }
secret = { type = "text" }
[[views]]
name = "All"
columns = ["title", "author", "rating", "body", "secret"]
aggregates = [{ fn = "sum", field = "rating" }]
"#).unwrap();
        for i in 0..125 {
            fs::write(root.join(format!("book-{i:03}.md")), format!(
                "+++\nid = \"0190f8a0-0000-7000-8000-{i:012x}\"\ntype = \"BOOK\"\ntitle = \"Book {i}\"\nauthor = \"{}\"\nsecret = \"Hidden Needle\"\nrating = {}\n+++\nBody Needle\n",
                if i == 124 { "Needle Author" } else { "Other Author" }, i + 1,
            )).unwrap();
        }
    }).build()
}

#[tokio::test]
async fn standalone_and_embedded_search_are_authoritative_beyond_the_loaded_window() {
    let fixture = fixture();
    let get = fixture
        .server
        .get("/api/vault/bases/search/views/All")
        .add_query_param("q", "Needle")
        .add_query_param("search_columns", "[\"author\"]")
        .add_query_param("limit", 1)
        .await;
    get.assert_status_ok();
    let standalone: serde_json::Value = get.json();
    let post = fixture
        .server
        .post("/api/vault/bases/search/views/All/evaluate")
        .json(&json!({"q":"Needle", "search_columns":["author"], "limit":1}))
        .await;
    post.assert_status_ok();
    let embedded: serde_json::Value = post.json();
    for output in [&standalone, &embedded["output"]] {
        assert_eq!(output["total"], 1);
        assert_eq!(output["unfiltered_total"], 125);
        assert_eq!(output["aggregates"], json!([125.0]));
        assert_eq!(output["rows"][0]["title"], "Book 124");
    }
}

#[tokio::test]
async fn search_excludes_hidden_fields_body_and_retains_request_predicates() {
    let fixture = fixture();
    let response = fixture.server.post("/api/vault/bases/search/views/All/evaluate")
        .json(&json!({"q":"Needle", "search_columns":["body"], "filter":{"field":"rating", "op":"gt", "value":100}})).await;
    response.assert_status_ok();
    let value: serde_json::Value = response.json();
    assert_eq!(value["output"]["total"], 0);
    assert_eq!(value["output"]["unfiltered_total"], 25);
    assert_eq!(value["output"]["aggregates"], json!([null]));
    let response = fixture
        .server
        .get("/api/vault/bases/search/views/All")
        .add_query_param("q", "Book 124")
        .add_query_param("search_columns", "[]")
        .await;
    response.assert_status_ok();
    assert_eq!(response.json::<serde_json::Value>()["total"], 1);
}
