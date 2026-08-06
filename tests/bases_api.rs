mod support;

use std::fs;
use std::path::Path;

use support::ApiFixture;

const READING_BASE: &str = r#"
name = "Reading Log"
description = "Books in flight."

[filter]
all = [ { field = "kind", op = "eq", value = "BOOK" } ]

[properties]
author  = { type = "text" }
status  = { type = "select", options = ["queued", "reading", "finished"] }
rating  = { type = "number" }
started = { type = "date" }

[[views]]
name = "Continues"
layout = "table"
filter = { field = "status", op = "eq", value = "reading" }
sort = [ { field = "started", dir = "desc" } ]
columns = ["title", "author", "rating"]
"#;

fn seed(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(root.join("bases/reading.base.toml"), READING_BASE).unwrap();
    fs::write(root.join("bases/broken.base.toml"), "name = = nope").unwrap();

    let page = |id: &str, title: &str, extras: &str| {
        format!("+++\nid = \"{id}\"\ntitle = \"{title}\"\ntype = \"BOOK\"\n{extras}+++\nbody\n")
    };
    fs::write(
        root.join("a.md"),
        page(
            "0190f8a0-0000-7000-8000-0000000000a1",
            "Book A",
            "author = \"Wolfe\"\nstatus = \"reading\"\nrating = 9\nstarted = 2026-07-01\n",
        ),
    )
    .unwrap();
    fs::write(
        root.join("b.md"),
        page(
            "0190f8a0-0000-7000-8000-0000000000b1",
            "Book B",
            "author = \"Le Guin\"\nstatus = \"reading\"\nrating = 10\nstarted = 2026-07-30\n",
        ),
    )
    .unwrap();
    fs::write(
        root.join("c.md"),
        page(
            "0190f8a0-0000-7000-8000-0000000000c1",
            "Book C",
            "author = \"Borges\"\nstatus = \"queued\"\n",
        ),
    )
    .unwrap();
}

#[tokio::test]
async fn list_bases_includes_diagnostics_for_broken_base() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();

    let res = server.get("/api/vault/bases").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();

    let bases = body["bases"].as_array().unwrap();
    assert_eq!(bases.len(), 1);
    assert_eq!(bases[0]["slug"], "reading");
    assert_eq!(bases[0]["name"], "Reading Log");
    assert_eq!(bases[0]["views"], serde_json::json!(["Continues"]));

    let diagnostics = body["diagnostics"].as_array().unwrap();
    assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
    assert_eq!(diagnostics[0]["slug"], "broken");
}

#[tokio::test]
async fn get_base_returns_definition_and_unknown_is_404() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();

    let res = server.get("/api/vault/bases/reading").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["slug"], "reading");
    assert_eq!(body["properties"]["status"]["type"], "select");
    assert_eq!(body["views"][0]["name"], "Continues");

    server
        .get("/api/vault/bases/nonexistent")
        .await
        .assert_status_not_found();
}

#[tokio::test]
async fn view_evaluation_honors_view_filter_and_sort() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();

    let res = server.get("/api/vault/bases/reading/views/continues").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["shape"], "flat");
    let rows = body["rows"].as_array().unwrap();
    // Only the two `reading` books, sorted started desc.
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["path"], "b.md");
    assert_eq!(rows[1]["path"], "a.md");
    assert_eq!(rows[0]["columns"]["author"], "Le Guin");
    assert_eq!(rows[0]["columns"]["rating"], 10);

    server
        .get("/api/vault/bases/reading/views/nope")
        .await
        .assert_status_not_found();
}

#[tokio::test]
async fn generic_query_filters_numerically_with_inline_types() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();

    let res = server
        .post("/api/vault/query")
        .json(&serde_json::json!({
            "filter": { "all": [
                { "field": "kind", "op": "eq", "value": "BOOK" },
                { "field": "rating", "op": "gt", "value": 9 }
            ]},
            "types": { "rating": "number" },
            "columns": ["rating"]
        }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{body}");
    assert_eq!(rows[0]["path"], "b.md");
    assert_eq!(body["total"], 1);
}
