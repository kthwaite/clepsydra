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

fn presentation_fixture() -> ApiFixture {
    ApiFixture::builder().pre_index_seed(|root| {
        fs::create_dir_all(root.join("bases")).unwrap();
        fs::write(root.join("bases/presentation.base.toml"), r#"
# Owner's presentation
name = "Presentation"
plugin_key = "keep"
filter = { field = "kind", op = "eq", value = "BOOK" }
[properties]
rating = { type = "number" }
status = { type = "select", options = ["reading", "queued"] }
finished = { type = "date" }
[[views]]
name = "All"
columns = ["title"]
plugin_view = "keep"
color_rules = [
  { color = "madder", filter = { field = "rating", op = "gt", value = 5 } },
  { color = "ochre", filter = { field = "rating", op = "gt", value = 0 } },
]
metrics = [
  { fn = "count", label = "Books", target = 10 },
  { fn = "sum", field = "rating", target = 20 },
  { fn = "median", field = "rating" },
  { fn = "count_empty", field = "rating" },
]
"#).unwrap();
        for (i, rating, status) in [(0, Some(0), "reading"), (1, Some(2), "queued"), (2, Some(8), "reading"), (3, None, "queued")] {
            let rating = rating.map(|rating| format!("rating = {rating}\n")).unwrap_or_default();
            fs::write(root.join(format!("book-{i}.md")), format!(
                "+++\nid = \"0190f8a0-0000-7000-8000-{i:012x}\"\ntype = \"BOOK\"\ntitle = \"Book {i}\"\n{rating}status = \"{status}\"\n+++\n"
            )).unwrap();
        }
    }).build()
}

#[tokio::test]
async fn presentation_uses_hidden_fields_first_match_and_whole_view_metrics() {
    let fixture = presentation_fixture();
    let response = fixture
        .server
        .get("/api/vault/bases/presentation/views/All")
        .add_query_param("limit", 1)
        .add_query_param("offset", 2)
        .await;
    response.assert_status_ok();
    let output: serde_json::Value = response.json();
    assert_eq!(output["metrics"], json!([4, 10.0, 2.0, 1]));
    assert_eq!(output["rows"].as_array().unwrap().len(), 1);
    assert_eq!(output["rows"][0]["color"], "madder");
    assert!(output["rows"][0]["columns"].get("rating").is_none());
    let response = fixture
        .server
        .get("/api/vault/bases/presentation/views/All")
        .await;
    response.assert_status_ok();
    let output: serde_json::Value = response.json();
    assert!(output["rows"][0].get("color").is_none());
    assert_eq!(output["rows"][1]["color"], "ochre");
    assert!(output["rows"][3].get("color").is_none());
    let response = fixture
        .server
        .post("/api/vault/bases/presentation/views/All/evaluate")
        .json(&json!({"group_by":"status", "limit":1}))
        .await;
    response.assert_status_ok();
    let result: serde_json::Value = response.json();
    assert_eq!(result["output"]["metrics"], json!([4, 10.0, 2.0, 1]));
    assert_eq!(result["output"]["groups"].as_array().unwrap().len(), 2);
    assert_eq!(
        result["output"]["groups"][0]["rows"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn metrics_compose_search_and_filter_and_keep_zero_distinct_from_null() {
    let fixture = presentation_fixture();
    for (query, expected) in [
        ("Book", json!([2, 10.0, 5.0, 0])),
        ("Book 1", json!([1, 2.0, 2.0, 0])),
        ("missing", json!([0, null, null, 0])),
    ] {
        let filter = json!({"field":"rating", "op":"gt", "value":0});
        let response = fixture
            .server
            .get("/api/vault/bases/presentation/views/All")
            .add_query_param("q", query)
            .add_query_param("filter", filter.to_string())
            .add_query_param("limit", 1)
            .await;
        response.assert_status_ok();
        assert_eq!(response.json::<serde_json::Value>()["metrics"], expected);
        for group_by in ["", "status"] {
            let response = fixture
                .server
                .post("/api/vault/bases/presentation/views/All/evaluate")
                .json(&json!({"q":query, "filter":filter, "group_by":group_by, "limit":1}))
                .await;
            response.assert_status_ok();
            assert_eq!(
                response.json::<serde_json::Value>()["output"]["metrics"],
                expected
            );
        }
    }
    let response = fixture
        .server
        .get("/api/vault/bases/presentation/views/All")
        .add_query_param("q", "Book 0")
        .await;
    response.assert_status_ok();
    assert_eq!(
        response.json::<serde_json::Value>()["metrics"],
        json!([1, 0.0, 0.0, 0])
    );
    let response = fixture
        .server
        .get("/api/vault/bases/presentation/views/All")
        .add_query_param("q", "Book 3")
        .await;
    response.assert_status_ok();
    assert_eq!(
        response.json::<serde_json::Value>()["metrics"],
        json!([1, null, null, 1])
    );
}

#[tokio::test]
async fn invalid_presentation_configuration_is_rejected_with_addressed_diagnostics() {
    use axum::http::StatusCode;
    let fixture = presentation_fixture();
    for (view, path) in [
        (json!({"metrics":[{"fn":"count","target":0}]}), "metrics[0]"),
        (
            json!({"metrics":[{"fn":"count","target":-1}]}),
            "metrics[0]",
        ),
        (json!({"metrics":[{"fn":"sum"}]}), "metrics[0]"),
        (
            json!({"metrics":[{"fn":"sum","field":"status"}]}),
            "metrics[0]",
        ),
        (
            json!({"metrics":[{"fn":"min","field":"finished","target":10}]}),
            "metrics[0]",
        ),
        (
            json!({"metrics":[{"fn":"count_unique","field":"tags"}]}),
            "metrics[0]",
        ),
        (
            json!({"color_rules":[{"color":"madder","filter":{"field":"body","op":"eq","value":"text"}}]}),
            "color_rules[0].filter",
        ),
        (
            json!({"color_rules":[{"color":"madder","filter":{"field":"rating","op":"gt","value":"bad"}}]}),
            "color_rules[0].filter",
        ),
    ] {
        let mut view = view;
        view["name"] = json!("All");
        let response = fixture
            .server
            .post("/api/vault/bases")
            .json(&json!({
                "slug":"invalid",
                "definition":{"name":"Invalid", "properties":[
                    {"key":"rating","definition":{"type":"number"}},
                    {"key":"status","definition":{"type":"text"}},
                    {"key":"finished","definition":{"type":"date"}}
                ], "views":[view]}
            }))
            .await;
        response.assert_status(StatusCode::BAD_REQUEST);
        let error: serde_json::Value = response.json();
        assert!(
            error["detail"]["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| {
                    diagnostic["severity"] == "error"
                        && diagnostic["path"]
                            .as_str()
                            .is_some_and(|actual| actual.starts_with(&format!("views[0].{path}")))
                }),
            "{error}"
        );
    }
    for color in ["#ff0000", "vessel", ""] {
        let response = fixture
            .server
            .post("/api/vault/bases")
            .json(&json!({
                "slug":"invalid",
                "definition":{"name":"Invalid","views":[{"name":"All","color_rules":[
                    {"color":color,"filter":{"all":[]}}
                ]}]}
            }))
            .await;
        response.assert_status(StatusCode::UNPROCESSABLE_ENTITY);
    }
    assert!(
        !fixture
            .state
            .vault
            .root()
            .join("bases/invalid.base.toml")
            .exists()
    );
}

#[tokio::test]
async fn presentation_edits_reload_and_property_repairs_preserve_unrelated_toml() {
    let fixture = presentation_fixture();
    let loaded = fixture.server.get("/api/vault/bases/presentation").await;
    loaded.assert_status_ok();
    let mut definition: serde_json::Value = loaded.json();
    assert_eq!(definition["views"][0]["color_rules"][0]["color"], "madder");
    assert_eq!(definition["views"][0]["metrics"][0]["target"], 10.0);
    let revision = definition["revision"].clone();
    definition["properties"][0]["key"] = json!("score");
    for rule in definition["views"][0]["color_rules"]
        .as_array_mut()
        .unwrap()
    {
        rule["filter"]["field"] = json!("score");
    }
    for metric in definition["views"][0]["metrics"].as_array_mut().unwrap() {
        if metric["field"] == "rating" {
            metric["field"] = json!("score");
        }
    }
    definition["views"][0]["metrics"][0]["label"] = json!("Library");
    let saved = fixture
        .server
        .put("/api/vault/bases/presentation")
        .json(&json!({
            "expected_revision":revision, "definition":definition,
            "view_origins":[{"kind":"existing","name":"All"}]
        }))
        .await;
    saved.assert_status_ok();
    let loaded = fixture.server.get("/api/vault/bases/presentation").await;
    loaded.assert_status_ok();
    let mut definition: serde_json::Value = loaded.json();
    assert_eq!(
        definition["views"][0]["color_rules"][0]["filter"]["field"],
        "score"
    );
    assert_eq!(definition["views"][0]["metrics"][1]["field"], "score");
    assert_eq!(definition["views"][0]["metrics"][0]["label"], "Library");
    let revision = definition["revision"].clone();
    definition["properties"].as_array_mut().unwrap().remove(0);
    definition["views"][0]["color_rules"] = json!([]);
    definition["views"][0]["metrics"]
        .as_array_mut()
        .unwrap()
        .retain(|metric| metric["field"] != "score");
    let saved = fixture
        .server
        .put("/api/vault/bases/presentation")
        .json(&json!({
            "expected_revision":revision, "definition":definition,
            "view_origins":[{"kind":"existing","name":"All"}]
        }))
        .await;
    saved.assert_status_ok();
    let response = fixture
        .server
        .get("/api/vault/bases/presentation/views/All")
        .await;
    response.assert_status_ok();
    let result: serde_json::Value = response.json();
    assert_eq!(result["metrics"], json!([4]));
    assert!(
        result["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row.get("color").is_none())
    );
    let raw = fs::read_to_string(
        fixture
            .state
            .vault
            .root()
            .join("bases/presentation.base.toml"),
    )
    .unwrap();
    assert!(raw.contains("# Owner's presentation"));
    assert!(raw.contains("plugin_key = \"keep\""));
    assert!(raw.contains("plugin_view = \"keep\""));
}

#[tokio::test]
async fn imported_nonfinite_metric_targets_are_reported_without_losing_the_definition() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::create_dir_all(root.join("bases")).unwrap();
            fs::write(
                root.join("bases/nonfinite.base.toml"),
                r#"
name = "Nonfinite"
[[views]]
name = "All"
metrics = [{ fn = "count", target = nan }, { fn = "count", target = inf }]
"#,
            )
            .unwrap();
        })
        .build();
    let response = fixture.server.get("/api/vault/bases/nonfinite").await;
    response.assert_status_ok();
    let result: serde_json::Value = response.json();
    assert_eq!(result["name"], "Nonfinite");
    for path in ["views[0].metrics[0]", "views[0].metrics[1]"] {
        assert!(
            result["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| {
                    diagnostic["path"] == path
                        && diagnostic["severity"] == "error"
                        && diagnostic["message"].as_str().unwrap().contains("finite")
                })
        );
    }
}

#[tokio::test]
async fn color_rule_reordering_changes_precedence_after_reload() {
    let fixture = presentation_fixture();
    let loaded = fixture.server.get("/api/vault/bases/presentation").await;
    loaded.assert_status_ok();
    let mut definition: serde_json::Value = loaded.json();
    let revision = definition["revision"].clone();
    definition["views"][0]["color_rules"][1]["filter"] =
        json!({"field":"status", "op":"eq", "value":"reading"});
    definition["views"][0]["color_rules"]
        .as_array_mut()
        .unwrap()
        .reverse();
    let saved = fixture
        .server
        .put("/api/vault/bases/presentation")
        .json(&json!({
            "expected_revision":revision, "definition":definition,
            "view_origins":[{"kind":"existing","name":"All"}]
        }))
        .await;
    saved.assert_status_ok();
    let response = fixture
        .server
        .post("/api/vault/bases/presentation/views/All/evaluate")
        .json(&json!({"q":"Book 2"}))
        .await;
    response.assert_status_ok();
    assert_eq!(
        response.json::<serde_json::Value>()["output"]["rows"][0]["color"],
        "ochre"
    );
}
