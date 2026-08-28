mod support;

use std::fs;
use std::path::Path;
use std::sync::Arc;

use chrono::{DateTime, Utc};

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use clepsydra::api::Clock;
use clepsydra::api::events::SyncNotification;
use clepsydra::api::openapi::ApiDoc;
use clepsydra::vault::base_document;
use support::ApiFixture;
use tokio::sync::broadcast::error::TryRecvError;
use tower::ServiceExt;
use utoipa::OpenApi;

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
const IDENTITY_BASE: &str = r#"name = "Identity"

# logical a
[[views]]
name = "A"
layout = "table"
plugin_view = "for-a"

# logical b
[[views]]
name = "B"
layout = "table"
plugin_view = "for-b"
"#;

#[derive(Debug)]
struct FixedClock(DateTime<Utc>);

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

fn fixed_now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-08-09T12:34:56Z")
        .unwrap()
        .with_timezone(&Utc)
}

fn member_fixture(seed_fn: impl FnOnce(&Path) + 'static) -> ApiFixture {
    ApiFixture::builder()
        .clock(Arc::new(FixedClock(fixed_now())))
        .pre_index_seed(seed_fn)
        .build()
}

fn collect_page_paths(root: &Path, current: &Path, paths: &mut Vec<String>) {
    for entry in fs::read_dir(current).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name == ".clepsydra") {
                continue;
            }
            collect_page_paths(root, &path, paths);
        } else if path.extension().is_some_and(|extension| extension == "md") {
            paths.push(
                path.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
}

fn page_paths(root: &Path) -> Vec<String> {
    let mut paths = Vec::new();
    collect_page_paths(root, root, &mut paths);
    paths.sort();
    paths
}

async fn current_base_revision(fixture: &ApiFixture, slug: &str) -> String {
    let detail: serde_json::Value = fixture
        .server
        .get(&format!("/api/vault/bases/{slug}"))
        .await
        .json();
    detail["revision"].as_str().unwrap().to_owned()
}

async fn indexed_page_count(fixture: &ApiFixture) -> i64 {
    fixture
        .state
        .index
        .with_index(|index, _| {
            index
                .connection()
                .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
                .unwrap()
        })
        .await
        .unwrap()
}
async fn raw_embed_evaluation(
    fixture: &ApiFixture,
    body: Vec<u8>,
) -> (StatusCode, serde_json::Value) {
    let response = fixture
        .app
        .clone()
        .oneshot(
            Request::post("/api/vault/bases/embedded/views/reading/evaluate")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = serde_json::from_slice(&bytes).unwrap();
    (status, body)
}

fn canonical_invalid_embed_query() -> serde_json::Value {
    serde_json::json!({
        "status": 400,
        "error": "invalid embed query",
        "detail": {
            "code": "invalid_embed_query",
            "diagnostics": []
        }
    })
}

fn serialized_filter_at_size(size: usize) -> serde_json::Value {
    let mut children = (0..16)
        .map(|index| {
            serde_json::json!({
                "field": "title",
                "op": "eq",
                "value": if index < 15 { "x".repeat(4096) } else { String::new() },
            })
        })
        .collect::<Vec<_>>();
    let mut filter = serde_json::json!({ "all": children });
    let current_size = serde_json::to_vec(&filter).unwrap().len();
    let padding = size.checked_sub(current_size).unwrap();
    assert!(padding <= 4096);
    children = filter["all"].take().as_array().unwrap().clone();
    children[15]["value"] = serde_json::Value::String("x".repeat(padding));
    filter["all"] = serde_json::Value::Array(children);
    assert_eq!(serde_json::to_vec(&filter).unwrap().len(), size);
    filter
}

fn seed_identity_base(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(root.join("bases/identity.base.toml"), IDENTITY_BASE).unwrap();
}

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

fn seed_body_projection(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(
        root.join("bases/excerpts.base.toml"),
        r#"name = "Excerpts"

[[views]]
name = "All"
columns = ["title", "body"]
"#,
    )
    .unwrap();
    fs::write(
        root.join("excerpt.md"),
        "+++\nid = \"0190f8a0-0000-7000-8000-0000000000b2\"\ntitle = \"Excerpt\"\ntype = \"NOTE\"\n+++\nA **readable** [label](https://example.com).\n",
    )
    .unwrap();
}

fn seed_grouped_limit_base(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(
        root.join("bases/grouped.base.toml"),
        r#"
name = "Grouped"
filter = { field = "kind", op = "eq", value = "BOOK" }

[properties]
status = { type = "select", options = ["reading"] }
rating = { type = "number" }

[[views]]
name = "By Status"
layout = "table"
group_by = "status"
aggregates = [ { fn = "count" }, { fn = "sum", field = "rating" } ]
columns = ["title", "rating"]

[[views]]
name = "Flat"
layout = "table"
columns = ["title", "rating"]
sort = [ { field = "rating", dir = "asc" } ]
"#,
    )
    .unwrap();

    for index in 0..55 {
        let id = format!("0190f8a0-0000-7000-8000-{index:012x}");
        let page = format!(
            "+++\nid = \"{id}\"\ntitle = \"Book {index:02}\"\ntype = \"BOOK\"\nstatus = \"reading\"\nrating = {}\n+++\nbody\n",
            index + 1
        );
        fs::write(root.join(format!("group-{index:02}.md")), page).unwrap();
    }
}
fn seed_embed_evaluation(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(
        root.join("bases/embedded.base.toml"),
        r#"
name = "Embedded"
filter = { field = "kind", op = "eq", value = "BOOK" }

[properties]
status = { type = "select", options = ["reading", "queued"] }
rating = { type = "number" }
featured = { type = "bool" }
started = { type = "date" }
series = { type = "relation" }

[[views]]
name = "Reading"
layout = "table"
filter = { field = "status", op = "eq", value = "reading" }
sort = [ { field = "started", dir = "desc" } ]
columns = ["title", "rating", "featured", "series"]

[[views]]
name = "By Status"
layout = "table"
group_by = "status"
sort = [ { field = "rating", dir = "desc" } ]
aggregates = [ { fn = "count" }, { fn = "sum", field = "rating" } ]
columns = ["title", "rating"]
"#,
    )
    .unwrap();

    fs::write(
        root.join("solar-cycle.md"),
        "+++\nid = \"0190f8a0-0000-7000-8000-0000000000f1\"\ntitle = \"Solar Cycle\"\naliases = [\"Science Fiction\"]\ntype = \"NOTE\"\n+++\n",
    )
    .unwrap();
    for (path, id, title, status, rating, featured, started, series) in [
        (
            "a.md",
            "0190f8a0-0000-7000-8000-0000000000a1",
            "Zulu",
            "reading",
            10,
            true,
            "2026-01-01",
            Some("[[Solar Cycle]]"),
        ),
        (
            "b.md",
            "0190f8a0-0000-7000-8000-0000000000b1",
            "Alpha",
            "reading",
            7,
            false,
            "2026-03-01",
            Some("[[Science Fiction]]"),
        ),
        (
            "d.md",
            "0190f8a0-0000-7000-8000-0000000000d1",
            "Middle",
            "reading",
            10,
            false,
            "2026-02-01",
            None,
        ),
        (
            "c.md",
            "0190f8a0-0000-7000-8000-0000000000c1",
            "Queued",
            "queued",
            10,
            true,
            "2026-04-01",
            Some("[[Solar Cycle]]"),
        ),
    ] {
        let series = series.map_or_else(String::new, |value| format!("series = \"{value}\"\n"));
        fs::write(
            root.join(path),
            format!(
                "+++\nid = \"{id}\"\ntitle = \"{title}\"\ntype = \"BOOK\"\nstatus = \"{status}\"\nrating = {rating}\nfeatured = {featured}\nstarted = {started}\n{series}+++\nbody\n"
            ),
        )
        .unwrap();
    }
}

const LINK_TARGET_ID: &str = "0190f8a0-0000-7000-8000-0000000000d1";
const LINK_TARGET_MIXED_ID: &str = "0190F8A0-0000-7000-8000-0000000000D1";
const MISSING_LINK_TARGET_MIXED_ID: &str = "0190F8A0-0000-7000-8000-0000000000E1";

fn seed_relation_member_base(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(
        root.join("bases/relations.base.toml"),
        format!(
            r#"
name = "Relations"
filter = {{ field = "kind", op = "eq", value = "BOOK" }}
[properties]
series = {{ type = "relation" }}
author = {{ type = "text" }}
[[views]]
name = "Canonical"
layout = "table"
filter = {{ field = "series", op = "links_to", value = "Solar Cycle" }}
[[views]]
name = "Alias"
layout = "table"
filter = {{ field = "series", op = "links_to", value = "Science Fiction" }}
[[views]]
name = "Uuid"
layout = "table"
filter = {{ field = "series", op = "links_to", value = "{LINK_TARGET_ID}" }}
[[views]]
name = "MixedUuid"
layout = "table"
filter = {{ field = "series", op = "links_to", value = "{LINK_TARGET_MIXED_ID}" }}
[[views]]
name = "MissingUuid"
layout = "table"
filter = {{ field = "series", op = "links_to", value = "{MISSING_LINK_TARGET_MIXED_ID}" }}
"#
        ),
    )
    .unwrap();
    fs::write(
        root.join("solar-cycle.md"),
        format!(
            "+++\nid = \"{LINK_TARGET_ID}\"\ntitle = \"Solar Cycle\"\naliases = [\"Science Fiction\"]\ntype = \"NOTE\"\n+++\n"
        ),
    )
    .unwrap();
}

fn preview_definition() -> serde_json::Value {
    serde_json::json!({
        "name": "Reading Preview",
        "description": "An unsaved definition.",
        "filter": {
            "all": [{ "field": "kind", "op": "eq", "value": "BOOK" }]
        },
        "properties": [
            { "key": "author", "definition": { "type": "text" } },
            {
                "key": "status",
                "definition": {
                    "type": "select",
                    "options": ["queued", "reading", "finished"]
                }
            },
            { "key": "rating", "definition": { "type": "number" } },
            { "key": "started", "definition": { "type": "date" } }
        ],
        "views": [{
            "name": "Continues",
            "layout": "table",
            "filter": { "field": "status", "op": "eq", "value": "reading" },
            "sort": [{ "field": "started", "dir": "desc" }],
            "columns": ["title", "author", "rating"]
        }]
    })
}

fn base_files(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = fs::read_dir(root.join("bases"))
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            (
                path.file_name().unwrap().to_string_lossy().into_owned(),
                fs::read(path).unwrap(),
            )
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}

fn seed_many(root: &Path) {
    seed(root);
    for index in 0..105 {
        fs::write(
            root.join(format!("extra-{index}.md")),
            format!(
                "+++\nid = \"0190f8a0-0000-7000-8000-{index:012x}\"\ntitle = \"Extra {index}\"\ntype = \"BOOK\"\n+++\nbody\n"
            ),
        )
        .unwrap();
    }
}

/// Books straddling every relative-date window around the fixed clock's
/// Sunday 2026-08-09 (Monday of its ISO week is 2026-08-03).
fn seed_relative_dates(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::create_dir_all(root.join("books")).unwrap();
    fs::write(
        root.join("bases/dates.base.toml"),
        r#"
name = "Dates"
filter = { field = "kind", op = "eq", value = "BOOK" }

[properties]
started = { type = "date" }
note = { type = "text" }
status = { type = "select", options = ["queued", "reading", "finished"] }

[[views]]
name = "today"
filter = { field = "started", op = "is_today" }
columns = ["title", "started"]

[[views]]
name = "this-week"
filter = { field = "started", op = "is_this_week" }

[[views]]
name = "past-week"
filter = { field = "started", op = "is_past_week" }

[[views]]
name = "next-week"
filter = { field = "started", op = "is_next_week" }

[[views]]
name = "this-month"
filter = { field = "started", op = "is_this_month" }

[[views]]
name = "prefix"
filter = { field = "note", op = "starts_with", value = "ab" }

[[views]]
name = "no-reading"
filter = { field = "status", op = "not_contains", value = "reading" }
"#,
    )
    .unwrap();
    let page = |slug: &str, index: u8, extras: &str| {
        fs::write(
            root.join(format!("books/{slug}.md")),
            format!(
                "+++\nid = \"0190f8a0-0000-7000-8000-0000000000{index:02}\"\ntitle = \"Book {slug}\"\ntype = \"BOOK\"\n{extras}+++\nbody\n"
            ),
        )
        .unwrap();
    };
    page(
        "s1",
        1,
        "started = 2026-08-09\nnote = \"Abacus\"\nstatus = \"reading\"\n",
    );
    page(
        "s2",
        2,
        "started = 2026-08-03\nnote = \"cab\"\nstatus = \"queued\"\n",
    );
    page("s3", 3, "started = 2026-08-02\nnote = \"ABBEY\"\n");
    page("s4", 4, "started = 2026-08-12\n");
    page("s5", 5, "started = 2026-07-31\n");
    page("s6", 6, "");
}

/// A base whose membership requires the member be created today.
fn seed_created_today_base(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(
        root.join("bases/fresh.base.toml"),
        r#"
name = "Fresh"

[filter]
all = [
  { field = "kind", op = "eq", value = "BOOK" },
  { field = "created_at", op = "is_today" }
]

[[views]]
name = "All"
layout = "table"
columns = ["title"]
"#,
    )
    .unwrap();
}

fn seed_with_unevaluable_base(root: &Path) {
    seed(root);
    fs::write(
        root.join("bases/unevaluable.base.toml"),
        r#"
name = "Unevaluable"
filter = { field = "rating", op = "contains", value = "9" }

[properties]
rating = { type = "number" }
"#,
    )
    .unwrap();
}

#[tokio::test]
async fn preview_matches_saved_evaluation_without_writing() {
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    let vault_root = tmp.path().join("vault");
    let before = base_files(&vault_root);

    let response = server
        .post("/api/vault/bases/preview")
        .json(&serde_json::json!({
            "definition": preview_definition(),
            "view": "Continues",
            "limit": 25,
            "offset": 0
        }))
        .await;
    response.assert_status_ok();
    let preview: serde_json::Value = response.json();

    let saved = server
        .get("/api/vault/bases/reading/views/Continues?limit=25&offset=0")
        .await;
    saved.assert_status_ok();
    assert_eq!(preview["output"], saved.json::<serde_json::Value>());
    assert_eq!(preview["diagnostics"], serde_json::json!([]));
    assert!(preview["evaluation_error"].is_null());
    assert_eq!(base_files(&vault_root), before);
}

#[tokio::test]
async fn preview_without_a_view_evaluates_membership() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();

    let response = server
        .post("/api/vault/bases/preview")
        .json(&serde_json::json!({
            "definition": preview_definition(),
            "view": null
        }))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert_eq!(body["output"]["shape"], "flat");
    assert_eq!(body["output"]["total"], 3);
    assert_eq!(body["output"]["rows"].as_array().unwrap().len(), 3);
    assert_eq!(body["diagnostics"], serde_json::json!([]));
    assert!(body["evaluation_error"].is_null());
}

#[tokio::test]
async fn preview_reports_unknown_view_as_an_evaluation_error_without_writing() {
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    let vault_root = tmp.path().join("vault");
    let before = base_files(&vault_root);

    let response = server
        .post("/api/vault/bases/preview")
        .json(&serde_json::json!({
            "definition": preview_definition(),
            "view": "Missing"
        }))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert!(body["output"].is_null());
    assert!(
        body["evaluation_error"]
            .as_str()
            .unwrap()
            .contains("Missing")
    );
    assert_eq!(body["diagnostics"], serde_json::json!([]));
    assert_eq!(base_files(&vault_root), before);
}

#[tokio::test]
async fn openapi_registers_base_preview_contract() {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();

    assert!(
        document["paths"]["/api/vault/bases/preview"]["post"].is_object(),
        "preview POST should be documented"
    );
    assert!(
        document["components"]["schemas"]["BasePreviewRequest"].is_object(),
        "preview request should be a reusable schema"
    );
    assert!(
        document["components"]["schemas"]["BasePreviewResponse"].is_object(),
        "preview response should be a reusable schema"
    );
}

#[tokio::test]
async fn preview_keeps_structural_diagnostics_separate_from_evaluation_errors() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    let mut definition = preview_definition();
    definition["name"] = serde_json::json!("");

    let response = server
        .post("/api/vault/bases/preview")
        .json(&serde_json::json!({
            "definition": definition,
            "view": null
        }))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert!(body["output"].is_null());
    assert!(body["evaluation_error"].is_null());
    assert!(
        body["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| {
                diagnostic["severity"] == "error"
                    && diagnostic["path"] == "name"
                    && diagnostic["message"] == "base name must not be empty"
            })
    );
}

#[tokio::test]
async fn preview_caps_requested_limit_at_one_hundred() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_many)
        .build()
        .into_server_and_temp();

    let response = server
        .post("/api/vault/bases/preview")
        .json(&serde_json::json!({
            "definition": preview_definition(),
            "view": null,
            "limit": 1_000
        }))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert_eq!(body["output"]["total"], 108);
    assert_eq!(body["output"]["rows"].as_array().unwrap().len(), 100);
}

#[tokio::test]
async fn list_bases_counts_membership_independently() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_with_unevaluable_base)
        .build()
        .into_server_and_temp();

    let response = server.get("/api/vault/bases").await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    let bases = body["bases"].as_array().unwrap();
    let reading = bases.iter().find(|base| base["slug"] == "reading").unwrap();
    let unevaluable = bases
        .iter()
        .find(|base| base["slug"] == "unevaluable")
        .unwrap();

    assert_eq!(reading["match_count"], 3);
    assert!(unevaluable["match_count"].is_null());
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
async fn get_base_returns_definition_capability_and_unknown_is_404() {
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();

    let res = server.get("/api/vault/bases/reading").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["slug"], "reading");
    assert_eq!(
        body["properties"][1],
        serde_json::json!({
            "key": "status",
            "definition": {
                "type": "select",
                "options": ["queued", "reading", "finished"]
            }
        })
    );
    assert_eq!(body["views"][0]["name"], "Continues");
    assert_eq!(
        body["revision"],
        base_document::revision(
            &fs::read_to_string(tmp.path().join("vault/bases/reading.base.toml")).unwrap()
        )
    );
    assert_eq!(body["member_creation"][0]["view"], "Continues");
    assert_eq!(body["member_creation"][0]["enabled"], true);
    assert!(
        body["member_creation"][0]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|field| field["field"] == "status"
                && field["membership"] == false
                && field["view"] == true
                && field["embed"] == false)
    );

    server
        .get("/api/vault/bases/nonexistent")
        .await
        .assert_status_not_found();
}

fn seed_resolved_capability_base(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(
        root.join("bases/resolved.base.toml"),
        r#"
name = "Resolved capability"
[properties]
kind = { type = "text" }
word_count = { type = "number" }
journal_date = { type = "date" }
status = { type = "select", options = ["reading"] }
[filter]
all = [
  { field = "kind", op = "eq", value = "BOOK" },
  { field = "sys.kind", op = "eq", value = "BOOK" },
  { field = "prop.kind", op = "eq", value = "genre" },
  { field = "word_count", op = "eq", value = 0 },
  { field = "prop.word_count", op = "eq", value = 7 },
  { field = "prop.journal_date", op = "is_empty" },
  { field = "status", op = "eq", value = "reading" },
  { field = "prop.status", op = "eq", value = "reading" }
]
[[views]]
name = "All"
layout = "table"
"#,
    )
    .unwrap();
}

#[tokio::test]
async fn get_base_capability_emits_resolved_member_creation_request_keys() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_resolved_capability_base)
        .build();

    let body = fixture
        .server
        .get("/api/vault/bases/resolved")
        .await
        .json::<serde_json::Value>();

    assert_eq!(body["diagnostics"], serde_json::json!([]));

    assert_eq!(
        body["member_creation"][0]["fields"],
        serde_json::json!([
            { "field": "kind", "membership": true, "view": false, "embed": false,
              "implied": { "kind": "fixed", "value": "BOOK" } },
            { "field": "prop.kind", "membership": true, "view": false, "embed": false,
              "implied": { "kind": "fixed", "value": "genre" } },
            // A system field cannot be authored, but the predicate still names
            // the value it forces.
            { "field": "word_count", "membership": true, "view": false, "embed": false,
              "implied": { "kind": "fixed", "value": 0 } },
            { "field": "prop.word_count", "membership": true, "view": false, "embed": false,
              "implied": { "kind": "fixed", "value": 7 } },
            { "field": "prop.journal_date", "membership": true, "view": false, "embed": false,
              "implied": null },
            { "field": "status", "membership": true, "view": false, "embed": false,
              "implied": { "kind": "fixed", "value": "reading" } }
        ])
    );
}

#[test]
fn capability_openapi_includes_embed_scope_and_required_provenance() {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();
    assert_eq!(
        document["components"]["schemas"]["BaseMemberScope"]["enum"],
        serde_json::json!(["membership", "view", "field", "embed"])
    );
    assert!(
        document["components"]["schemas"]["BaseMemberFieldRequirement"]["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|field| field == "embed")
    );
}

fn seed_diagnostic_key_base(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(
        root.join("bases/diagnostic-keys.base.toml"),
        r#"
name = "Diagnostic keys"
filter = { field = "kind", op = "eq", value = "BOOK" }
[properties]
kind = { type = "text" }
word_count = { type = "number" }
journal_date = { type = "date" }
[[views]]
name = "PropKind"
layout = "table"
filter = { field = "prop.kind", op = "eq", value = "genre" }
[[views]]
name = "PropWord"
layout = "table"
filter = { field = "prop.word_count", op = "eq", value = 7 }
[[views]]
name = "PropJournal"
layout = "table"
filter = { field = "prop.journal_date", op = "eq", value = "2026-08-09" }
"#,
    )
    .unwrap();
}

#[tokio::test]
async fn member_rejection_diagnostics_emit_resolved_request_keys() {
    let fixture = member_fixture(seed_diagnostic_key_base);
    let revision = current_base_revision(&fixture, "diagnostic-keys").await;
    let cases = [
        (
            "PropKind",
            serde_json::json!({ "kind": "NOTE", "prop.kind": "genre" }),
            "membership",
            "kind",
        ),
        (
            "PropKind",
            serde_json::json!({ "kind": "BOOK", "prop.kind": "wrong" }),
            "view",
            "prop.kind",
        ),
        (
            "PropWord",
            serde_json::json!({ "kind": "BOOK", "prop.word_count": 8 }),
            "view",
            "prop.word_count",
        ),
        (
            "PropJournal",
            serde_json::json!({ "kind": "BOOK", "prop.journal_date": "2026-08-08" }),
            "view",
            "prop.journal_date",
        ),
    ];

    for (view, fields, expected_scope, expected_field) in cases {
        let response = fixture
            .server
            .post("/api/vault/bases/diagnostic-keys/members")
            .json(&serde_json::json!({
                "base_revision": revision,
                "view": view,
                "title": format!("Wrong {view}"),
                "fields": fields
            }))
            .await;
        response.assert_status(StatusCode::UNPROCESSABLE_ENTITY);
        let error: serde_json::Value = response.json();
        let diagnostics = error["detail"]["diagnostics"].as_array().unwrap();

        assert_eq!(diagnostics.len(), 1, "{error}");
        assert_eq!(diagnostics[0]["scope"], expected_scope);
        assert_eq!(diagnostics[0]["field"], expected_field);
    }
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

async fn view_paths(fixture: &ApiFixture, slug: &str, view: &str) -> Vec<String> {
    let response = fixture
        .server
        .get(&format!("/api/vault/bases/{slug}/views/{view}"))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    let mut paths = body["rows"]
        .as_array()
        .unwrap_or_else(|| panic!("flat rows for `{view}`: {body}"))
        .iter()
        .map(|row| row["path"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

#[tokio::test]
async fn saved_views_evaluate_relative_date_and_text_operators_against_the_request_clock() {
    let fixture = member_fixture(seed_relative_dates);

    // The fixed clock reads 2026-08-09 (a Sunday).
    assert_eq!(
        view_paths(&fixture, "dates", "today").await,
        ["books/s1.md"]
    );
    assert_eq!(
        view_paths(&fixture, "dates", "this-week").await,
        ["books/s1.md", "books/s2.md"]
    );
    assert_eq!(
        view_paths(&fixture, "dates", "past-week").await,
        ["books/s1.md", "books/s2.md", "books/s3.md"]
    );
    assert_eq!(
        view_paths(&fixture, "dates", "next-week").await,
        ["books/s4.md"]
    );
    assert_eq!(
        view_paths(&fixture, "dates", "this-month").await,
        ["books/s1.md", "books/s2.md", "books/s3.md", "books/s4.md"]
    );
    // `starts_with` is case-insensitive and anchored: "cab" does not match.
    assert_eq!(
        view_paths(&fixture, "dates", "prefix").await,
        ["books/s1.md", "books/s3.md"]
    );
    // A page without `status` matches the negation.
    assert_eq!(
        view_paths(&fixture, "dates", "no-reading").await,
        [
            "books/s2.md",
            "books/s3.md",
            "books/s4.md",
            "books/s5.md",
            "books/s6.md"
        ]
    );
}

#[tokio::test]
async fn embedded_evaluation_composes_a_not_contains_override_over_a_relative_date_view() {
    let fixture = member_fixture(seed_relative_dates);

    let response = fixture
        .server
        .post("/api/vault/bases/dates/views/today/evaluate")
        .json(&serde_json::json!({
            "filter": { "field": "status", "op": "not_contains", "value": "queued" }
        }))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    let paths = body["output"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["path"].as_str().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(paths, ["books/s1.md"], "{body}");
}

#[tokio::test]
async fn preview_reports_relative_date_field_errors_and_stray_value_warnings() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_relative_dates)
        .build()
        .into_server_and_temp();
    let definition = |filter: serde_json::Value| {
        serde_json::json!({
            "name": "Dates Preview",
            "filter": filter,
            "properties": [
                { "key": "started", "definition": { "type": "date" } },
                { "key": "note", "definition": { "type": "text" } }
            ],
            "views": [{ "name": "All", "layout": "table" }]
        })
    };
    let diagnostics = |body: &serde_json::Value| {
        body["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .map(|diagnostic| {
                (
                    diagnostic["severity"].as_str().unwrap().to_owned(),
                    diagnostic["path"].as_str().unwrap_or_default().to_owned(),
                )
            })
            .collect::<Vec<_>>()
    };

    let response = server
        .post("/api/vault/bases/preview")
        .json(&serde_json::json!({
            "definition": definition(serde_json::json!({ "field": "note", "op": "is_today" })),
            "view": null
        }))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    assert!(
        diagnostics(&body).contains(&("error".to_owned(), "filter.op".to_owned())),
        "{body}"
    );

    let response = server
        .post("/api/vault/bases/preview")
        .json(&serde_json::json!({
            "definition": definition(
                serde_json::json!({ "field": "started", "op": "is_today", "value": "x" })
            ),
            "view": null
        }))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    assert!(
        diagnostics(&body).contains(&("warning".to_owned(), "filter.value".to_owned())),
        "{body}"
    );
}

#[tokio::test]
async fn a_created_at_is_today_membership_still_admits_a_new_member() {
    let fixture = member_fixture(seed_created_today_base);

    let detail: serde_json::Value = fixture.server.get("/api/vault/bases/fresh").await.json();
    assert_eq!(detail["member_creation"][0]["enabled"], true, "{detail}");

    let response = fixture
        .server
        .post("/api/vault/bases/fresh/members")
        .json(&serde_json::json!({
            "base_revision": detail["revision"].as_str().unwrap(),
            "view": "All",
            "title": "Written Today",
            "fields": { "kind": "BOOK" }
        }))
        .await;
    response.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = response.json();

    let view: serde_json::Value = fixture
        .server
        .get("/api/vault/bases/fresh/views/all")
        .await
        .json();
    assert!(
        view["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == body["id"]),
        "{view}"
    );
}

#[tokio::test]
async fn saved_view_returns_body_excerpt_without_a_page_detail_request() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_body_projection)
        .build()
        .into_server_and_temp();

    let response = server.get("/api/vault/bases/excerpts/views/all").await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert_eq!(body["rows"][0]["columns"]["title"], "Excerpt");
    assert_eq!(body["rows"][0]["columns"]["body"], "A readable label.");
}

#[tokio::test]
async fn grouped_saved_view_without_limit_keeps_default_fifty_row_cap() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_grouped_limit_base)
        .build()
        .into_server_and_temp();

    let response = server
        .get("/api/vault/bases/grouped/views/by%20status")
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    let groups = body["groups"].as_array().unwrap();

    assert_eq!(groups.len(), 1, "{body}");
    assert_eq!(groups[0]["rows"].as_array().unwrap().len(), 50);
    assert_eq!(groups[0]["total"], 55);
    assert_eq!(groups[0]["aggregates"], serde_json::json!([55, 1540.0]));
}
#[tokio::test]
async fn evaluate_embedded_flat_composes_typed_relation_and_logical_filters() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_embed_evaluation)
        .build();
    let expected_revision = base_document::revision(
        &fs::read_to_string(fixture.state.vault.root().join("bases/embedded.base.toml")).unwrap(),
    );

    let response = fixture
        .server
        .post("/api/vault/bases/embedded/views/rEaDiNg/evaluate")
        .json(&serde_json::json!({
            "filter": {
                "all": [
                    { "field": "rating", "op": "gte", "value": 10 },
                    { "field": "started", "op": "gte", "value": "2026-01-01" },
                    {
                        "any": [
                            { "field": "featured", "op": "eq", "value": true },
                            {
                                "field": "series",
                                "op": "links_to",
                                "value": "Science Fiction"
                            }
                        ]
                    },
                    {
                        "not": {
                            "field": "title",
                            "op": "eq",
                            "value": "Never"
                        }
                    }
                ]
            }
        }))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert_eq!(
        body.as_object().unwrap().keys().collect::<Vec<_>>(),
        vec!["member_creation", "output", "revision"]
    );
    assert_eq!(body["output"]["shape"], "flat");
    let rows = body["output"]["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{body}");
    assert_eq!(rows[0]["path"], "a.md");
    assert_eq!(body["member_creation"]["view"], "Reading");
    assert_eq!(body["member_creation"]["enabled"], true);
    assert_eq!(body["member_creation"]["blockers"], serde_json::json!([]));
    let requirements = body["member_creation"]["fields"].as_array().unwrap();
    let embed_fields = requirements
        .iter()
        .filter(|field| field["embed"] == true)
        .map(|field| field["field"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        embed_fields,
        vec!["rating", "started", "featured", "series", "title"]
    );
    assert_eq!(body["revision"], expected_revision);
    assert!(body.get("diagnostics").is_none(), "{body}");
}

#[tokio::test]
async fn evaluate_embedded_capability_blockers_use_embed_scope_without_duplicate_diagnostics() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_embed_evaluation)
        .build();

    let response = fixture
        .server
        .post("/api/vault/bases/embedded/views/reading/evaluate")
        .json(&serde_json::json!({
            "filter": {
                "not": { "field": "word_count", "op": "eq", "value": 0 }
            }
        }))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert_eq!(body["member_creation"]["enabled"], false);
    let blockers = body["member_creation"]["blockers"].as_array().unwrap();
    assert_eq!(blockers.len(), 1, "{body}");
    assert_eq!(blockers[0]["scope"], "embed");
    assert_eq!(blockers[0]["field"], "word_count");
    assert_eq!(blockers[0]["filter_path"], "embed_filter.not");
    assert!(body.get("diagnostics").is_none(), "{body}");
}

#[tokio::test]
async fn evaluate_embedded_sort_inheritance_empty_reset_and_replacement_are_exact() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_embed_evaluation)
        .build();
    let cases = [
        (serde_json::json!({}), vec!["b.md", "d.md", "a.md"]),
        (
            serde_json::json!({ "sort": [] }),
            vec!["a.md", "b.md", "d.md"],
        ),
        (
            serde_json::json!({
                "sort": [
                    { "field": "rating", "dir": "desc" },
                    { "field": "title", "dir": "asc" }
                ]
            }),
            vec!["d.md", "a.md", "b.md"],
        ),
    ];

    for (request, expected_paths) in cases {
        let body: serde_json::Value = fixture
            .server
            .post("/api/vault/bases/embedded/views/Reading/evaluate")
            .json(&request)
            .await
            .json();
        let paths = body["output"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["path"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(paths, expected_paths, "{body}");
    }
}

#[tokio::test]
async fn evaluate_embedded_grouped_limit_is_per_group_and_absence_is_the_default_window() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_grouped_limit_base)
        .build();

    for (request, expected_rows, expected_total, expected_aggregates) in [
        (
            serde_json::json!({}),
            50,
            55,
            serde_json::json!([55, 1540.0]),
        ),
        (
            serde_json::json!({ "limit": 1 }),
            1,
            55,
            serde_json::json!([55, 1540.0]),
        ),
        (
            serde_json::json!({ "limit": 200 }),
            55,
            55,
            serde_json::json!([55, 1540.0]),
        ),
        (
            serde_json::json!({
                "filter": { "field": "rating", "op": "gt", "value": 50 }
            }),
            5,
            5,
            serde_json::json!([5, 265.0]),
        ),
    ] {
        let response = fixture
            .server
            .post("/api/vault/bases/grouped/views/by%20STATUS/evaluate")
            .json(&request)
            .await;
        response.assert_status_ok();
        let body: serde_json::Value = response.json();
        let groups = body["output"]["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 1, "{body}");
        assert_eq!(
            groups[0]["rows"].as_array().unwrap().len(),
            expected_rows,
            "{body}"
        );
        assert_eq!(groups[0]["total"], expected_total);
        assert_eq!(groups[0]["aggregates"], expected_aggregates);
    }
}

#[tokio::test]
async fn evaluate_embedded_flat_without_a_limit_serves_one_window_of_the_true_total() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_grouped_limit_base)
        .build();

    let response = fixture
        .server
        .post("/api/vault/bases/grouped/views/flat/evaluate")
        .json(&serde_json::json!({}))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert_eq!(
        body["output"]["rows"].as_array().unwrap().len(),
        50,
        "{body}"
    );
    assert_eq!(body["output"]["total"], 55);
}

#[tokio::test]
async fn evaluate_embedded_flat_offset_walks_the_result_without_repeating_rows() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_grouped_limit_base)
        .build();

    let mut seen: Vec<String> = Vec::new();
    for offset in [0, 20, 40] {
        let response = fixture
            .server
            .post("/api/vault/bases/grouped/views/flat/evaluate")
            .json(&serde_json::json!({ "limit": 20, "offset": offset }))
            .await;
        response.assert_status_ok();
        let body: serde_json::Value = response.json();
        assert_eq!(body["output"]["total"], 55, "{body}");
        let rows = body["output"]["rows"].as_array().unwrap();
        assert_eq!(rows.len(), if offset == 40 { 15 } else { 20 }, "{body}");
        seen.extend(
            rows.iter()
                .map(|row| row["id"].as_str().unwrap().to_owned()),
        );
    }

    let mut unique = seen.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), 55, "windows overlapped: {seen:?}");
}

#[tokio::test]
async fn evaluate_embedded_offset_past_the_end_is_an_empty_window() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_grouped_limit_base)
        .build();

    let response = fixture
        .server
        .post("/api/vault/bases/grouped/views/flat/evaluate")
        .json(&serde_json::json!({ "limit": 20, "offset": 500 }))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert!(
        body["output"]["rows"].as_array().unwrap().is_empty(),
        "{body}"
    );
    assert_eq!(body["output"]["total"], 55);
}

#[tokio::test]
async fn evaluate_embedded_rejects_an_offset_on_a_grouped_view() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_grouped_limit_base)
        .build();

    let response = fixture
        .server
        .post("/api/vault/bases/grouped/views/by%20status/evaluate")
        .json(&serde_json::json!({ "limit": 10, "offset": 10 }))
        .await;
    response.assert_status(StatusCode::BAD_REQUEST);
    let body: serde_json::Value = response.json();

    assert_eq!(body["detail"]["code"], "invalid_embed_query");
    assert_eq!(body["detail"]["diagnostics"][0]["field"], "offset");
    assert_eq!(
        body["detail"]["diagnostics"][0]["message"],
        "offset is not supported for a grouped view"
    );
}

#[tokio::test]
async fn evaluate_embedded_flat_accepts_limit_boundaries_and_rejects_out_of_range_limits() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_embed_evaluation)
        .build();

    for (limit, expected_rows) in [(1, 1), (200, 3)] {
        let response = fixture
            .server
            .post("/api/vault/bases/embedded/views/reading/evaluate")
            .json(&serde_json::json!({ "limit": limit }))
            .await;
        response.assert_status_ok();
        let body: serde_json::Value = response.json();
        assert_eq!(
            body["output"]["rows"].as_array().unwrap().len(),
            expected_rows
        );
    }

    for limit in [0, 201] {
        let response = fixture
            .server
            .post("/api/vault/bases/embedded/views/reading/evaluate")
            .json(&serde_json::json!({ "limit": limit }))
            .await;
        response.assert_status(StatusCode::BAD_REQUEST);
        let error: serde_json::Value = response.json();
        assert_eq!(error["status"], 400);
        assert_eq!(error["error"], "invalid embed query");
        assert_eq!(error["detail"]["code"], "invalid_embed_query");
        let diagnostics = error["detail"]["diagnostics"].as_array().unwrap();
        assert_eq!(diagnostics.len(), 1, "{error}");
        assert_eq!(diagnostics[0]["scope"], "embed");
        assert_eq!(diagnostics[0]["field"], "limit");
        assert_eq!(diagnostics[0]["filter_path"], serde_json::Value::Null);
        assert_eq!(diagnostics[0]["message"], "limit must be between 1 and 200");
    }
}

#[tokio::test]
async fn evaluate_embedded_rejects_unknown_and_duplicate_canonical_sort_fields_once() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_embed_evaluation)
        .build();
    let cases = [
        (
            serde_json::json!({ "sort": [{ "field": "missing", "dir": "asc" }] }),
            "missing",
            "unknown field `missing`",
        ),
        (
            serde_json::json!({
                "sort": [
                    { "field": "title", "dir": "asc" },
                    { "field": "sys.title", "dir": "desc" }
                ]
            }),
            "title",
            "duplicate canonical sort field `title`",
        ),
        (
            serde_json::json!({ "sort": [{ "field": "prop.missing", "dir": "asc" }] }),
            "missing",
            "unknown property field `missing`",
        ),
    ];

    for (request, field, message) in cases {
        let response = fixture
            .server
            .post("/api/vault/bases/embedded/views/reading/evaluate")
            .json(&request)
            .await;
        response.assert_status(StatusCode::BAD_REQUEST);
        let error: serde_json::Value = response.json();
        let diagnostics = error["detail"]["diagnostics"].as_array().unwrap();
        assert_eq!(diagnostics.len(), 1, "{error}");
        assert_eq!(diagnostics[0]["scope"], "embed");
        assert_eq!(diagnostics[0]["field"], field);
        assert_eq!(diagnostics[0]["filter_path"], serde_json::Value::Null);
        assert_eq!(diagnostics[0]["message"], message);
    }
}

#[tokio::test]
async fn evaluate_embedded_maps_domain_diagnostics_to_canonical_embed_filter_paths() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_embed_evaluation)
        .build();
    let cases = [
        (
            serde_json::json!({
                "filter": {
                    "all": [{ "field": "prop.rating", "op": "eq", "value": "ten" }]
                }
            }),
            "rating",
            "embed_filter.all[0].value",
        ),
        (
            serde_json::json!({
                "filter": { "field": "featured", "op": "gt", "value": true }
            }),
            "featured",
            "embed_filter.op",
        ),
        (
            serde_json::json!({
                "filter": { "field": "series", "op": "links_to", "value": 7 }
            }),
            "series",
            "embed_filter.value",
        ),
        (
            serde_json::json!({
                "filter": { "field": "prop.missing", "op": "eq", "value": "x" }
            }),
            "missing",
            "embed_filter.field",
        ),
    ];

    for (request, field, path) in cases {
        let response = fixture
            .server
            .post("/api/vault/bases/embedded/views/reading/evaluate")
            .json(&request)
            .await;
        response.assert_status(StatusCode::BAD_REQUEST);
        let error: serde_json::Value = response.json();
        let diagnostics = error["detail"]["diagnostics"].as_array().unwrap();
        assert_eq!(diagnostics.len(), 1, "{error}");
        assert_eq!(diagnostics[0]["scope"], "embed");
        assert_eq!(diagnostics[0]["field"], field);
        assert_eq!(diagnostics[0]["filter_path"], path);
    }
}

#[tokio::test]
async fn evaluate_embedded_missing_stale_and_io_failures_do_not_leak_internal_causes() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_embed_evaluation)
        .build();

    fixture
        .server
        .post("/api/vault/bases/missing/views/reading/evaluate")
        .json(&serde_json::json!({}))
        .await
        .assert_status_not_found();
    fixture
        .server
        .post("/api/vault/bases/embedded/views/missing/evaluate")
        .json(&serde_json::json!({}))
        .await
        .assert_status_not_found();

    let base_path = fixture.state.vault.root().join("bases/embedded.base.toml");
    fs::write(&base_path, "name = = stale syntax").unwrap();
    let stale = fixture
        .server
        .post("/api/vault/bases/embedded/views/reading/evaluate")
        .json(&serde_json::json!({}))
        .await;
    stale.assert_status(StatusCode::CONFLICT);
    let stale_error: serde_json::Value = stale.json();
    assert_eq!(
        stale_error,
        serde_json::json!({
            "status": 409,
            "error": "base definition is unavailable"
        })
    );

    fs::remove_file(&base_path).unwrap();
    fs::create_dir(&base_path).unwrap();
    let internal = fixture
        .server
        .post("/api/vault/bases/embedded/views/reading/evaluate")
        .json(&serde_json::json!({}))
        .await;
    internal.assert_status(StatusCode::INTERNAL_SERVER_ERROR);
    let internal_error: serde_json::Value = internal.json();
    assert_eq!(
        internal_error,
        serde_json::json!({
            "status": 500,
            "error": "base evaluation failed"
        })
    );
}

#[tokio::test]
async fn evaluate_embedded_body_bound_and_malformed_json_use_the_canonical_400_envelope() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_embed_evaluation)
        .build();

    let mut exact = b"{}".to_vec();
    exact.resize(64 * 1024, b' ');
    let (status, body) = raw_embed_evaluation(&fixture, exact).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, body) = raw_embed_evaluation(&fixture, b"{".to_vec()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, canonical_invalid_embed_query());

    let mut oversized = b"{}".to_vec();
    oversized.resize(64 * 1024 + 1, b' ');
    let (status, body) = raw_embed_evaluation(&fixture, oversized).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, canonical_invalid_embed_query());
}

#[tokio::test]
async fn grouped_generic_query_without_limit_maps_to_default_fifty_row_cap() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_grouped_limit_base)
        .build()
        .into_server_and_temp();

    let response = server
        .post("/api/vault/query")
        .json(&serde_json::json!({
            "filter": { "field": "kind", "op": "eq", "value": "BOOK" },
            "types": {
                "status": "select",
                "rating": "number"
            },
            "group_by": "status",
            "aggregates": [
                { "fn": "count" },
                { "fn": "sum", "field": "rating" }
            ]
        }))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    let groups = body["groups"].as_array().unwrap();

    assert_eq!(groups.len(), 1, "{body}");
    assert_eq!(groups[0]["rows"].as_array().unwrap().len(), 50);
    assert_eq!(groups[0]["total"], 55);
    assert_eq!(groups[0]["aggregates"], serde_json::json!([55, 1540.0]));
}

#[tokio::test]
async fn every_accepted_named_view_is_ascii_case_insensitively_addressable() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let response = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "addressable",
            "definition": {
                "name": "Addressable",
                "properties": [
                    { "key": "rating", "definition": { "type": "number" } }
                ],
                "views": [
                    { "name": "All", "layout": "table" },
                    {
                        "name": "Rated",
                        "layout": "table",
                        "sort": [{ "field": "rating", "dir": "desc" }]
                    }
                ]
            }
        }))
        .await;
    response.assert_status_ok();
    let created: serde_json::Value = response.json();
    assert_eq!(
        created["views"]
            .as_array()
            .unwrap()
            .iter()
            .map(|view| view["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["All", "Rated"]
    );

    for address in ["all", "RATED"] {
        fixture
            .server
            .get(&format!("/api/vault/bases/addressable/views/{address}"))
            .await
            .assert_status_ok();
    }
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

fn assert_base_registry_changed(
    notifications: &mut tokio::sync::broadcast::Receiver<SyncNotification>,
) {
    assert!(
        matches!(
            notifications.try_recv(),
            Ok(SyncNotification::BaseRegistryChanged)
        ),
        "expected one base_registry_changed notification"
    );
}

fn assert_no_notification(notifications: &mut tokio::sync::broadcast::Receiver<SyncNotification>) {
    assert!(
        matches!(notifications.try_recv(), Err(TryRecvError::Empty)),
        "failed mutation must not emit a notification"
    );
}

#[tokio::test]
async fn ordered_property_entries_preserve_reverse_integer_like_keys_across_save_reload() {
    let fixture = ApiFixture::builder().build();
    let properties = serde_json::json!([
        { "key": "2", "definition": { "type": "number" } },
        { "key": "ordinary", "definition": { "type": "text" } },
        { "key": "1", "definition": { "type": "bool" } }
    ]);

    let create = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "ordered",
            "definition": {
                "name": "Ordered",
                "properties": properties,
                "views": [{ "name": "All", "layout": "table" }]
            }
        }))
        .await;
    create.assert_status_ok();
    let created: serde_json::Value = create.json();
    assert_eq!(created["properties"], properties);

    let stored = base_document::load(fixture.state.vault.root(), "ordered").unwrap();
    assert_eq!(
        stored
            .definition
            .file
            .properties
            .iter()
            .map(|(key, _)| key.as_str())
            .collect::<Vec<_>>(),
        vec!["2", "ordinary", "1"]
    );

    let reloaded: serde_json::Value = fixture.server.get("/api/vault/bases/ordered").await.json();
    assert_eq!(reloaded["properties"], properties);
}

#[tokio::test]
async fn base_property_wire_rejects_the_removed_map_representation() {
    let fixture = ApiFixture::builder().build();
    let response = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "legacy-map",
            "definition": {
                "name": "Legacy map",
                "properties": {
                    "status": { "type": "text" }
                },
                "views": [{ "name": "All", "layout": "table" }]
            }
        }))
        .await;

    response.assert_status(StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        !fixture
            .state
            .vault
            .root()
            .join("bases/legacy-map.base.toml")
            .exists()
    );
}

#[tokio::test]
async fn duplicate_property_entries_are_rejected_by_create_update_and_preview() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let mut notifications = fixture.state.change_tx.subscribe();
    let duplicate_properties = serde_json::json!([
        { "key": "status", "definition": { "type": "text" } },
        { "key": "status", "definition": { "type": "number" } },
        { "key": "rating", "definition": { "type": "number" } },
        { "key": "status", "definition": { "type": "bool" } }
    ]);

    let create = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "duplicates",
            "definition": {
                "name": "Duplicates",
                "properties": duplicate_properties.clone()
            }
        }))
        .await;
    create.assert_status(StatusCode::BAD_REQUEST);
    let create_error: serde_json::Value = create.json();
    assert_eq!(
        create_error["detail"]["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|diagnostic| diagnostic["path"].as_str())
            .collect::<Vec<_>>(),
        vec!["properties[1].key", "properties[3].key"]
    );
    assert!(
        !fixture
            .state
            .vault
            .root()
            .join("bases/duplicates.base.toml")
            .exists()
    );
    assert_no_notification(&mut notifications);

    let reading_path = fixture.state.vault.root().join("bases/reading.base.toml");
    let reading_before = fs::read_to_string(&reading_path).unwrap();
    let revision = current_base_revision(&fixture, "reading").await;
    let update = fixture
        .server
        .put("/api/vault/bases/reading")
        .json(&serde_json::json!({
            "expected_revision": revision,
            "definition": {
                "name": "Reading",
                "properties": duplicate_properties.clone()
            },
            "view_origins": []
        }))
        .await;
    update.assert_status(StatusCode::BAD_REQUEST);
    assert_eq!(fs::read_to_string(&reading_path).unwrap(), reading_before);
    assert_no_notification(&mut notifications);

    let preview = fixture
        .server
        .post("/api/vault/bases/preview")
        .json(&serde_json::json!({
            "definition": {
                "name": "Preview",
                "properties": duplicate_properties
            }
        }))
        .await;
    preview.assert_status_ok();
    let preview_body: serde_json::Value = preview.json();
    assert!(preview_body["output"].is_null());
    assert!(preview_body["evaluation_error"].is_null());
    assert_eq!(
        preview_body["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|diagnostic| diagnostic["path"].as_str())
            .collect::<Vec<_>>(),
        vec!["properties[1].key", "properties[3].key"]
    );
    assert_eq!(fs::read_to_string(reading_path).unwrap(), reading_before);
    assert_no_notification(&mut notifications);
}

#[tokio::test]
async fn create_update_and_delete_are_revision_guarded_and_non_owning() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let root = fixture.state.vault.root();
    let page_path = root.join("a.md");
    let page_before = fs::read_to_string(&page_path).unwrap();
    let mut notifications = fixture.state.change_tx.subscribe();

    let create = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "books",
            "definition": {
                "name": "Books",
                "properties": [
                    {
                        "key": "status",
                        "definition": { "type": "select", "options": [] }
                    }
                ],
                "views": [{ "name": "All", "layout": "table" }]
            }
        }))
        .await;
    create.assert_status_ok();
    let created: serde_json::Value = create.json();
    let created_revision = created["revision"].as_str().unwrap().to_owned();
    assert_eq!(created["slug"], "books");
    assert_eq!(
        created_revision,
        base_document::revision(&fs::read_to_string(root.join("bases/books.base.toml")).unwrap())
    );
    assert_base_registry_changed(&mut notifications);

    let stale_update = fixture
        .server
        .put("/api/vault/bases/books")
        .json(&serde_json::json!({
            "expected_revision": "stale",
            "definition": {
                "name": "Books Updated",
                "properties": [
                    {
                        "key": "status",
                        "definition": { "type": "select", "options": [] }
                    }
                ],
                "views": [{ "name": "All", "layout": "table" }]
            },
            "view_origins": [{ "kind": "existing", "name": "All" }]
        }))
        .await;
    stale_update.assert_status(StatusCode::CONFLICT);
    let stale_update_error: serde_json::Value = stale_update.json();
    assert_eq!(
        stale_update_error["error"],
        "base definition changed since expected_revision"
    );
    assert_eq!(stale_update_error["detail"]["revision"], created_revision);
    assert_no_notification(&mut notifications);

    let update = fixture
        .server
        .put("/api/vault/bases/books")
        .json(&serde_json::json!({
            "expected_revision": created_revision,
            "definition": {
                "name": "Books Updated",
                "properties": [
                    {
                        "key": "status",
                        "definition": { "type": "select", "options": [] }
                    }
                ],
                "views": [{ "name": "All", "layout": "table" }]
            },
            "view_origins": [{ "kind": "existing", "name": "All" }]
        }))
        .await;
    update.assert_status_ok();
    let updated: serde_json::Value = update.json();
    let updated_revision = updated["revision"].as_str().unwrap().to_owned();
    assert_eq!(updated["name"], "Books Updated");
    assert_ne!(updated_revision, created["revision"]);
    assert_eq!(
        updated_revision,
        base_document::revision(&fs::read_to_string(root.join("bases/books.base.toml")).unwrap())
    );
    assert_base_registry_changed(&mut notifications);

    let stale_delete = fixture
        .server
        .delete("/api/vault/bases/books")
        .json(&serde_json::json!({
            "expected_revision": created["revision"]
        }))
        .await;
    stale_delete.assert_status(StatusCode::CONFLICT);
    let stale_delete_error: serde_json::Value = stale_delete.json();
    assert_eq!(stale_delete_error["detail"]["revision"], updated_revision);
    assert_no_notification(&mut notifications);

    fixture
        .server
        .delete("/api/vault/bases/books")
        .json(&serde_json::json!({
            "expected_revision": updated_revision
        }))
        .await
        .assert_status_ok();
    assert!(!root.join("bases/books.base.toml").exists());
    assert_base_registry_changed(&mut notifications);
    assert_eq!(fs::read_to_string(page_path).unwrap(), page_before);
}

#[tokio::test]
async fn update_view_origins_are_validated_and_drive_raw_table_identity() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_identity_base)
        .build();
    let path = fixture.state.vault.root().join("bases/identity.base.toml");
    let before = fs::read_to_string(&path).unwrap();
    let detail = fixture
        .server
        .get("/api/vault/bases/identity")
        .await
        .json::<serde_json::Value>();
    let revision = detail["revision"].as_str().unwrap();

    let malformed = fixture
        .server
        .put("/api/vault/bases/identity")
        .json(&serde_json::json!({
            "expected_revision": revision,
            "definition": {
                "name": "Identity",
                "views": [{ "name": "B", "layout": "table" }]
            },
            "view_origins": []
        }))
        .await;
    malformed.assert_status(StatusCode::CONFLICT);
    assert_eq!(fs::read_to_string(&path).unwrap(), before);

    fixture
        .server
        .put("/api/vault/bases/identity")
        .json(&serde_json::json!({
            "expected_revision": revision,
            "definition": {
                "name": "Identity",
                "views": [{ "name": "B", "layout": "table" }]
            },
            "view_origins": [{ "kind": "existing", "name": "A" }]
        }))
        .await
        .assert_status_ok();
    let after = fs::read_to_string(path).unwrap();
    assert!(after.contains("# logical a\n[[views]]\nname = \"B\""));
    assert!(after.contains("plugin_view = \"for-a\""));
    assert!(!after.contains("plugin_view = \"for-b\""));
}

#[tokio::test]
async fn duplicate_create_is_conflict_without_notification() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let mut notifications = fixture.state.change_tx.subscribe();
    let original =
        fs::read_to_string(fixture.state.vault.root().join("bases/reading.base.toml")).unwrap();

    let response = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "reading",
            "definition": {
                "name": "Replacement",
                "views": [{ "name": "All", "layout": "table" }]
            }
        }))
        .await;
    response.assert_status(StatusCode::CONFLICT);
    assert_no_notification(&mut notifications);
    assert_eq!(
        fs::read_to_string(fixture.state.vault.root().join("bases/reading.base.toml")).unwrap(),
        original
    );
}

#[tokio::test]
async fn unsafe_slug_is_bad_request_without_notification_or_escape() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let mut notifications = fixture.state.change_tx.subscribe();

    let response = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "../escape",
            "definition": {
                "name": "Escape",
                "views": [{ "name": "All", "layout": "table" }]
            }
        }))
        .await;
    response.assert_status(StatusCode::BAD_REQUEST);
    assert_no_notification(&mut notifications);
    assert!(!fixture.temp_dir.path().join("escape.base.toml").exists());
}

#[tokio::test]
async fn blocking_diagnostics_are_bad_request_detail_without_notification() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let mut notifications = fixture.state.change_tx.subscribe();

    let response = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "invalid",
            "definition": {
                "name": "",
                "views": [{ "name": "All", "layout": "table" }]
            }
        }))
        .await;
    response.assert_status(StatusCode::BAD_REQUEST);
    let error: serde_json::Value = response.json();
    assert_eq!(error["status"], 400);
    assert_eq!(error["error"], "base definition is invalid");
    assert!(error.get("hint").is_none());
    let diagnostics = error["detail"]["diagnostics"].as_array().unwrap();
    assert!(diagnostics.iter().any(|diagnostic| {
        diagnostic["slug"] == "invalid"
            && diagnostic["severity"] == "error"
            && diagnostic["path"] == "name"
            && diagnostic["message"] == "base name must not be empty"
    }));
    assert_no_notification(&mut notifications);
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
async fn update_blocks_body_aliases_and_keeps_the_canonical_view_evaluable() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(seed_body_projection)
        .build();
    let revision = current_base_revision(&fixture, "excerpts").await;

    for (columns, expected_duplicates) in [
        (serde_json::json!(["sys.body"]), 0),
        (serde_json::json!(["prop.body"]), 0),
        (serde_json::json!(["body", "sys.body"]), 1),
    ] {
        let response = fixture
            .server
            .put("/api/vault/bases/excerpts")
            .json(&serde_json::json!({
                "expected_revision": revision,
                "definition": {
                    "name": "Excerpts",
                    "views": [{
                        "name": "All",
                        "layout": "table",
                        "columns": columns
                    }]
                },
                "view_origins": [{ "kind": "existing", "name": "All" }]
            }))
            .await;
        response.assert_status(StatusCode::BAD_REQUEST);
        let error: serde_json::Value = response.json();
        let diagnostics = error["detail"]["diagnostics"].as_array().unwrap();
        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic["severity"] == "error"
                && diagnostic["message"]
                    .as_str()
                    .is_some_and(|message| message.starts_with("noncanonical body column"))
        }));
        assert_eq!(
            diagnostics
                .iter()
                .filter(|diagnostic| {
                    diagnostic["message"] == "duplicate `body` column in view `All`"
                })
                .count(),
            expected_duplicates
        );
    }

    fixture
        .server
        .get("/api/vault/bases/excerpts/views/All")
        .await
        .assert_status_ok();
}

#[tokio::test]
async fn non_text_contains_definition_is_rejected_with_stable_diagnostics() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let mut notifications = fixture.state.change_tx.subscribe();

    let response = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "invalid-contains",
            "definition": {
                "name": "Invalid contains",
                "filter": {
                    "all": [
                        { "field": "word_count", "op": "contains", "value": 0 },
                        { "field": "rating", "op": "contains", "value": 1.5 },
                        { "field": "done", "op": "contains", "value": true }
                    ]
                },
                "properties": [
                    { "key": "rating", "definition": { "type": "number" } },
                    { "key": "done", "definition": { "type": "bool" } }
                ],
                "views": [{ "name": "All", "layout": "table" }]
            }
        }))
        .await;

    response.assert_status(StatusCode::BAD_REQUEST);
    let error: serde_json::Value = response.json();
    let diagnostics = error["detail"]["diagnostics"].as_array().unwrap();
    assert_eq!(
        diagnostics
            .iter()
            .map(|diagnostic| {
                (
                    diagnostic["path"].as_str(),
                    diagnostic["severity"].as_str(),
                    diagnostic["message"].as_str(),
                )
            })
            .collect::<Vec<_>>(),
        vec![
            (
                Some("filter.all[0].op"),
                Some("error"),
                Some("filter: op `contains` is not valid for non-text field `word_count`"),
            ),
            (
                Some("filter.all[1].op"),
                Some("error"),
                Some("filter: op `contains` is not valid for non-text field `rating`"),
            ),
            (
                Some("filter.all[2].op"),
                Some("error"),
                Some("filter: op `contains` is not valid for non-text field `done`"),
            ),
        ]
    );
    assert_no_notification(&mut notifications);
    assert!(
        !fixture
            .state
            .vault
            .root()
            .join("bases/invalid-contains.base.toml")
            .exists()
    );
}

#[tokio::test]
async fn case_only_duplicate_view_names_are_rejected_before_publication() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let mut notifications = fixture.state.change_tx.subscribe();

    let response = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "duplicate-views",
            "definition": {
                "name": "Duplicate Views",
                "views": [
                    { "name": "All", "layout": "table" },
                    { "name": "aLL", "layout": "table" }
                ]
            }
        }))
        .await;
    response.assert_status(StatusCode::BAD_REQUEST);
    let error: serde_json::Value = response.json();
    let diagnostics = error["detail"]["diagnostics"].as_array().unwrap();
    assert!(diagnostics.iter().any(|diagnostic| {
        diagnostic["severity"] == "error"
            && diagnostic["path"] == "views[1].name"
            && diagnostic["message"] == "duplicate view name `aLL`"
    }));
    assert_no_notification(&mut notifications);
    assert!(
        !fixture
            .state
            .vault
            .root()
            .join("bases/duplicate-views.base.toml")
            .exists()
    );
}

#[tokio::test]
async fn non_scalar_system_view_sorts_are_rejected_before_publication() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let mut notifications = fixture.state.change_tx.subscribe();

    let response = fixture
        .server
        .post("/api/vault/bases")
        .json(&serde_json::json!({
            "slug": "invalid-sorts",
            "definition": {
                "name": "Invalid Sorts",
                "views": [{
                    "name": "All",
                    "layout": "table",
                    "sort": [
                        { "field": "tags" },
                        { "field": "sys.aliases" },
                        { "field": "encryption" }
                    ]
                }]
            }
        }))
        .await;
    response.assert_status(StatusCode::BAD_REQUEST);
    let error: serde_json::Value = response.json();
    let error_paths = error["detail"]["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|diagnostic| diagnostic["severity"] == "error")
        .map(|diagnostic| diagnostic["path"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        error_paths,
        vec![
            "views[0].sort[0].field",
            "views[0].sort[1].field",
            "views[0].sort[2].field",
        ]
    );
    assert_no_notification(&mut notifications);
    assert!(
        !fixture
            .state
            .vault
            .root()
            .join("bases/invalid-sorts.base.toml")
            .exists()
    );
}

#[tokio::test]
async fn create_base_member_writes_one_matching_typed_page() {
    let fixture = member_fixture(seed);
    let revision = current_base_revision(&fixture, "reading").await;
    let mut notifications = fixture.state.change_tx.subscribe();

    let response = fixture
        .server
        .post("/api/vault/bases/reading/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "Continues",
            "title": "The Left Hand of Darkness",
            "fields": {
                "kind": "BOOK",
                "author": "Le Guin",
                "status": "reading",
                "rating": 10,
                "started": "2026-08-09"
            }
        }))
        .await;

    response.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = response.json();
    let path = body["path"].as_str().unwrap();
    assert!(path.starts_with("books/20260809.the-left-hand-of-darkness."));
    assert_eq!(body["title"], "The Left Hand of Darkness");

    let vault_path = clepsydra::vault::path::VaultPath::new(path).unwrap();
    let page = clepsydra::vault::page::Page::from_file(
        &fixture.state.vault.resolve(&vault_path),
        vault_path,
    )
    .unwrap();
    assert_eq!(body["id"], page.meta.id.to_string());
    assert_eq!(
        body["revision"],
        clepsydra::vault::page::page_revision(&page.raw_content)
    );
    assert_eq!(page.meta.kind, Some(clepsydra::vault::kind::Kind::Book));
    assert_eq!(page.meta.extra["rating"], toml::Value::Integer(10));
    assert!(matches!(
        page.meta.extra["started"],
        toml::Value::Datetime(_)
    ));
    assert!(page.body.is_empty());

    let view: serde_json::Value = fixture
        .server
        .get("/api/vault/bases/reading/views/continues")
        .await
        .json();
    assert!(
        view["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == body["id"])
    );
    match notifications.try_recv().unwrap() {
        SyncNotification::IndexChanged { upserted, removed } => {
            assert_eq!(upserted, vec![path]);
            assert!(removed.is_empty());
        }
        other => panic!("unexpected notification: {other:?}"),
    }
}

#[tokio::test]
async fn filtered_member_creation_matches_the_exact_uncapped_composed_query() {
    let fixture = member_fixture(seed);
    let revision = current_base_revision(&fixture, "reading").await;
    let embed_filter = serde_json::json!({
        "all": [
            { "field": "rating", "op": "gte", "value": 10 },
            { "field": "author", "op": "contains", "value": "Le Guin" }
        ]
    });

    let response = fixture
        .server
        .post("/api/vault/bases/reading/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "Continues",
            "embed_filter": embed_filter.clone(),
            "title": "The Dispossessed",
            "fields": {
                "kind": "BOOK",
                "author": "Ursula Le Guin",
                "status": "reading",
                "rating": 10
            }
        }))
        .await;

    response.assert_status(StatusCode::CREATED);
    let created: serde_json::Value = response.json();
    assert_eq!(
        created.as_object().unwrap().keys().collect::<Vec<_>>(),
        vec!["id", "path", "revision", "title"]
    );

    let evaluated = fixture
        .server
        .post("/api/vault/bases/reading/views/continues/evaluate")
        .json(&serde_json::json!({ "filter": embed_filter }))
        .await;
    evaluated.assert_status_ok();
    let evaluated: serde_json::Value = evaluated.json();
    assert!(
        evaluated["output"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == created["id"]),
        "{evaluated}"
    );
}

#[tokio::test]
async fn filtered_member_mismatch_and_invalid_overrides_publish_nothing() {
    let fixture = member_fixture(seed);
    let revision = current_base_revision(&fixture, "reading").await;
    let before_paths = page_paths(fixture.state.vault.root());
    let before_rows = indexed_page_count(&fixture).await;
    let cases = [
        (
            serde_json::json!({
                "base_revision": revision,
                "view": "Continues",
                "embed_filter": { "field": "rating", "op": "gte", "value": 10 },
                "title": "Below filter",
                "fields": { "kind": "BOOK", "status": "reading", "rating": 9 }
            }),
            StatusCode::UNPROCESSABLE_ENTITY,
            "candidate is not valid for the selected Base view",
            "rating",
            "embed_filter",
        ),
        (
            serde_json::json!({
                "base_revision": revision,
                "view": "Continues",
                "embed_filter": { "field": "prop.missing", "op": "eq", "value": "x" },
                "title": "Unknown filter field",
                "fields": { "kind": "BOOK", "status": "reading" }
            }),
            StatusCode::BAD_REQUEST,
            "invalid embed query",
            "missing",
            "embed_filter.field",
        ),
        (
            serde_json::json!({
                "base_revision": revision,
                "view": "Continues",
                "embed_filter": { "field": "rating", "op": "contains", "value": 10 },
                "title": "Invalid filter operator",
                "fields": { "kind": "BOOK", "status": "reading", "rating": 10 }
            }),
            StatusCode::BAD_REQUEST,
            "invalid embed query",
            "rating",
            "embed_filter.op",
        ),
    ];

    for (request, status, error_message, field, filter_path) in cases {
        let response = fixture
            .server
            .post("/api/vault/bases/reading/members")
            .json(&request)
            .await;
        response.assert_status(status);
        let error: serde_json::Value = response.json();
        assert_eq!(error["status"], status.as_u16());
        assert_eq!(error["error"], error_message);
        if status == StatusCode::BAD_REQUEST {
            assert_eq!(error["detail"]["code"], "invalid_embed_query");
        }
        let diagnostics = error["detail"]["diagnostics"].as_array().unwrap();
        assert_eq!(diagnostics.len(), 1, "{error}");
        assert_eq!(diagnostics[0]["scope"], "embed");
        assert_eq!(diagnostics[0]["field"], field);
        assert_eq!(diagnostics[0]["filter_path"], filter_path);
        assert_eq!(page_paths(fixture.state.vault.root()), before_paths);
        assert_eq!(indexed_page_count(&fixture).await, before_rows);
    }

    let stale = fixture
        .server
        .post("/api/vault/bases/reading/members")
        .json(&serde_json::json!({
            "base_revision": "stale",
            "view": "Continues",
            "embed_filter": { "field": "rating", "op": "gte", "value": 10 },
            "title": "Stale filtered member",
            "fields": { "kind": "BOOK", "status": "reading", "rating": 10 }
        }))
        .await;
    stale.assert_status(StatusCode::CONFLICT);
    assert_eq!(page_paths(fixture.state.vault.root()), before_paths);
    assert_eq!(indexed_page_count(&fixture).await, before_rows);
}

#[tokio::test]
async fn filtered_member_serialized_filter_enforces_the_exact_64_kib_boundary() {
    let exact_fixture = member_fixture(seed);
    let exact_revision = current_base_revision(&exact_fixture, "reading").await;
    let exact_before_paths = page_paths(exact_fixture.state.vault.root());
    let exact_before_rows = indexed_page_count(&exact_fixture).await;
    let exact = exact_fixture
        .server
        .post("/api/vault/bases/reading/members")
        .json(&serde_json::json!({
            "base_revision": exact_revision,
            "view": "Continues",
            "embed_filter": serialized_filter_at_size(64 * 1024),
            "title": "Exact filter boundary",
            "fields": { "kind": "BOOK", "status": "reading" }
        }))
        .await;
    exact.assert_status(StatusCode::UNPROCESSABLE_ENTITY);
    let exact_error: serde_json::Value = exact.json();
    assert_eq!(exact_error["detail"]["diagnostics"][0]["scope"], "embed");
    assert_eq!(
        page_paths(exact_fixture.state.vault.root()),
        exact_before_paths
    );
    assert_eq!(indexed_page_count(&exact_fixture).await, exact_before_rows);

    let oversized_fixture = member_fixture(seed);
    let oversized_revision = current_base_revision(&oversized_fixture, "reading").await;
    let oversized_before_paths = page_paths(oversized_fixture.state.vault.root());
    let oversized_before_rows = indexed_page_count(&oversized_fixture).await;
    let oversized = oversized_fixture
        .server
        .post("/api/vault/bases/reading/members")
        .json(&serde_json::json!({
            "base_revision": oversized_revision,
            "view": "Continues",
            "embed_filter": serialized_filter_at_size(64 * 1024 + 1),
            "title": "Oversized filter",
            "fields": { "kind": "BOOK", "status": "reading" }
        }))
        .await;
    oversized.assert_status(StatusCode::BAD_REQUEST);
    let error: serde_json::Value = oversized.json();
    assert_eq!(error["status"], 400);
    assert_eq!(error["error"], "invalid embed query");
    assert_eq!(error["detail"]["code"], "invalid_embed_query");
    assert_eq!(error["detail"]["diagnostics"][0]["scope"], "embed");
    assert_eq!(
        error["detail"]["diagnostics"][0]["filter_path"],
        "embed_filter"
    );
    assert_eq!(
        page_paths(oversized_fixture.state.vault.root()),
        oversized_before_paths
    );
    assert_eq!(
        indexed_page_count(&oversized_fixture).await,
        oversized_before_rows
    );
}

#[tokio::test]
async fn member_rejections_leave_no_file_or_index_row() {
    let fixture = member_fixture(seed);
    let before_paths = page_paths(fixture.state.vault.root());
    let before_rows = indexed_page_count(&fixture).await;
    let revision = current_base_revision(&fixture, "reading").await;

    for request in [
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Queued", "fields": { "kind": "BOOK", "status": "queued" } }),
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Wrong kind", "fields": { "kind": "NOTE", "status": "reading" } }),
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Bad rating", "fields": { "kind": "BOOK", "status": "reading", "rating": "five" } }),
    ] {
        let response = fixture
            .server
            .post("/api/vault/bases/reading/members")
            .json(&request)
            .await;
        response.assert_status(StatusCode::UNPROCESSABLE_ENTITY);
        let error: serde_json::Value = response.json();
        assert!(error["detail"]["diagnostics"].is_array(), "{error}");
        assert_eq!(page_paths(fixture.state.vault.root()), before_paths);
        assert_eq!(indexed_page_count(&fixture).await, before_rows);
    }
}

#[tokio::test]
async fn member_revision_and_lookup_errors_have_exact_statuses_without_artifacts() {
    let fixture = member_fixture(seed);
    let revision = current_base_revision(&fixture, "reading").await;
    let before = page_paths(fixture.state.vault.root());

    let stale = fixture
        .server
        .post("/api/vault/bases/reading/members")
        .json(&serde_json::json!({
            "base_revision": "stale",
            "view": "Continues",
            "title": "Stale",
            "fields": {}
        }))
        .await;
    stale.assert_status(StatusCode::CONFLICT);
    let error: serde_json::Value = stale.json();
    assert_eq!(error["detail"]["code"], "base_revision_conflict");
    assert_eq!(error["detail"]["current_revision"], revision);

    fixture
        .server
        .post("/api/vault/bases/missing/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "Continues",
            "title": "Missing",
            "fields": {}
        }))
        .await
        .assert_status_not_found();
    fixture
        .server
        .post("/api/vault/bases/reading/members")
        .json(&serde_json::json!({
            "base_revision": current_base_revision(&fixture, "reading").await,
            "view": "Missing",
            "title": "Missing view",
            "fields": {}
        }))
        .await
        .assert_status_not_found();
    assert_eq!(page_paths(fixture.state.vault.root()), before);
}

#[tokio::test]
async fn member_malformed_and_unsupported_fields_are_bad_requests() {
    let fixture = member_fixture(seed);
    let revision = current_base_revision(&fixture, "reading").await;
    let before = page_paths(fixture.state.vault.root());

    for request in [
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "  ", "fields": {} }),
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Unknown", "fields": { "missing": "value" } }),
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Reserved", "fields": { "id": "client-id" } }),
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Bad tags", "fields": { "tags": "not-an-array" } }),
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Bad kind", "fields": { "kind": "MISSING" } }),
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Bad project", "fields": { "project": "../escape" } }),
        serde_json::json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Malformed", "fields": [] }),
    ] {
        fixture
            .server
            .post("/api/vault/bases/reading/members")
            .json(&request)
            .await
            .assert_status(StatusCode::BAD_REQUEST);
        assert_eq!(page_paths(fixture.state.vault.root()), before);
    }
}

fn seed_property_types(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(
        root.join("bases/types.base.toml"),
        r#"
name = "Typed"
filter = { field = "kind", op = "eq", value = "NOTE" }

[properties]
text = { type = "text" }
url = { type = "url" }
relation = { type = "relation", many = false }
select = { type = "select", options = ["one", "two"] }
multi = { type = "multi_select", options = ["red", "blue"] }
number = { type = "number" }
bool = { type = "bool" }
date = { type = "date" }
datetime = { type = "datetime" }

[[views]]
name = "Compound"
filter = { all = [
  { any = [
    { field = "select", op = "eq", value = "one" },
    { field = "number", op = "gt", value = 100 }
  ] },
  { not = { field = "bool", op = "eq", value = false } }
] }
"#,
    )
    .unwrap();
}

#[tokio::test]
async fn member_creation_coerces_every_custom_property_type_and_compound_filters() {
    let fixture = member_fixture(seed_property_types);
    let revision = current_base_revision(&fixture, "types").await;
    let response = fixture
        .server
        .post("/api/vault/bases/types/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "compound",
            "title": "Typed values",
            "fields": {
                "text": "hello",
                "prop.url": "https://example.com",
                "relation": ["alpha", "beta"],
                "select": "one",
                "multi": ["red", "blue"],
                "number": 2.5,
                "bool": true,
                "date": "2026-08-09",
                "datetime": "2026-08-09T12:34:56Z",
                "tags": ["typed"],
                "aliases": ["Types"]
            }
        }))
        .await;
    response.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = response.json();
    let path = clepsydra::vault::path::VaultPath::new(body["path"].as_str().unwrap()).unwrap();
    let page =
        clepsydra::vault::page::Page::from_file(&fixture.state.vault.resolve(&path), path).unwrap();
    assert_eq!(
        page.meta.kind,
        Some(clepsydra::vault::kind::Kind::Note),
        "missing kind must persist the NOTE declaration"
    );
    assert_eq!(page.meta.tags, vec!["typed"]);
    assert_eq!(page.meta.aliases, vec!["Types"]);
    assert_eq!(page.meta.extra["text"], toml::Value::String("hello".into()));
    assert_eq!(
        page.meta.extra["url"],
        toml::Value::String("https://example.com".into())
    );
    assert_eq!(
        page.meta.extra["relation"],
        toml::Value::Array(vec![
            toml::Value::String("alpha".into()),
            toml::Value::String("beta".into())
        ])
    );
    assert_eq!(page.meta.extra["select"], toml::Value::String("one".into()));
    assert_eq!(
        page.meta.extra["multi"],
        toml::Value::Array(vec![
            toml::Value::String("red".into()),
            toml::Value::String("blue".into())
        ])
    );
    assert!(matches!(page.meta.extra["number"], toml::Value::Float(_)));
    assert!(matches!(
        page.meta.extra["bool"],
        toml::Value::Boolean(true)
    ));
    assert!(matches!(page.meta.extra["date"], toml::Value::Datetime(_)));
    assert!(matches!(
        page.meta.extra["datetime"],
        toml::Value::Datetime(_)
    ));
}

fn seed_shadowed_title_base(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(
        root.join("bases/shadow.base.toml"),
        r#"
name = "Shadow"

[properties]
title = { type = "text" }

[[views]]
name = "All"
filter = { field = "prop.title", op = "eq", value = "shadow value" }
"#,
    )
    .unwrap();
}

#[tokio::test]
async fn forbidden_fields_are_rejected_through_prop_aliases_before_candidate_validation() {
    let fixture = member_fixture(seed_shadowed_title_base);
    let revision = current_base_revision(&fixture, "shadow").await;
    let before = page_paths(fixture.state.vault.root());

    fixture
        .server
        .post("/api/vault/bases/shadow/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "All",
            "title": "Visible title",
            "fields": { "prop.title": "shadow value" }
        }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);

    assert_eq!(page_paths(fixture.state.vault.root()), before);
}

#[tokio::test]
async fn duplicate_bare_and_prop_field_aliases_are_bad_request_without_artifacts() {
    let fixture = member_fixture(seed);
    let revision = current_base_revision(&fixture, "reading").await;
    let before = page_paths(fixture.state.vault.root());

    fixture
        .server
        .post("/api/vault/bases/reading/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "Continues",
            "title": "Duplicate status",
            "fields": {
                "kind": "BOOK",
                "status": "reading",
                "prop.status": "reading"
            }
        }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);

    assert_eq!(page_paths(fixture.state.vault.root()), before);
}

fn seed_persistable_shadow_base(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(
        root.join("bases/persistable-shadow.base.toml"),
        r#"
name = "Persistable shadow"
filter = { field = "kind", op = "eq", value = "BOOK" }

[properties]
kind = { type = "text" }
word_count = { type = "number" }
project = { type = "text" }
tags = { type = "text" }
aliases = { type = "text" }

[[views]]
name = "Escaped"
filter = { all = [
  { field = "prop.kind", op = "eq", value = "genre" },
  { field = "prop.word_count", op = "eq", value = 7 }
] }
"#,
    )
    .unwrap();
}

#[tokio::test]
async fn bare_system_and_persistable_prop_shadow_fields_coexist() {
    let fixture = member_fixture(seed_persistable_shadow_base);
    let revision = current_base_revision(&fixture, "persistable-shadow").await;

    let response = fixture
        .server
        .post("/api/vault/bases/persistable-shadow/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "Escaped",
            "title": "Shadow fields",
            "fields": {
                "kind": "BOOK",
                "prop.kind": "genre",
                "prop.word_count": 7
            }
        }))
        .await;
    response.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = response.json();
    let path = clepsydra::vault::path::VaultPath::new(body["path"].as_str().unwrap()).unwrap();
    let page =
        clepsydra::vault::page::Page::from_file(&fixture.state.vault.resolve(&path), path).unwrap();
    assert_eq!(page.meta.kind, Some(clepsydra::vault::kind::Kind::Book));
    assert_eq!(page.meta.extra["kind"], toml::Value::String("genre".into()));
    assert_eq!(page.meta.extra["word_count"], toml::Value::Integer(7));
}

#[tokio::test]
async fn invalid_shadow_property_value_reports_canonical_request_key() {
    let fixture = member_fixture(seed_persistable_shadow_base);
    let revision = current_base_revision(&fixture, "persistable-shadow").await;
    let before = page_paths(fixture.state.vault.root());

    let response = fixture
        .server
        .post("/api/vault/bases/persistable-shadow/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "Escaped",
            "title": "Invalid shadow",
            "fields": {
                "kind": "BOOK",
                "prop.kind": 42,
                "prop.word_count": 7
            }
        }))
        .await;

    response.assert_status(StatusCode::UNPROCESSABLE_ENTITY);
    let error: serde_json::Value = response.json();
    assert_eq!(
        error["detail"]["diagnostics"][0]["field"], "prop.kind",
        "{error}"
    );
    assert_eq!(page_paths(fixture.state.vault.root()), before);
}

#[tokio::test]
async fn unpersistable_prop_system_shadows_are_bad_request_without_artifacts() {
    for field in ["project", "tags", "aliases"] {
        let fixture = member_fixture(seed_persistable_shadow_base);
        let revision = current_base_revision(&fixture, "persistable-shadow").await;
        let before = page_paths(fixture.state.vault.root());
        let prop_field = format!("prop.{field}");

        fixture
            .server
            .post("/api/vault/bases/persistable-shadow/members")
            .json(&serde_json::json!({
                "base_revision": revision,
                "view": "Escaped",
                "title": "Unpersistable shadow",
                "fields": {
                    "kind": "BOOK",
                    (prop_field): "custom"
                }
            }))
            .await
            .assert_status(StatusCode::BAD_REQUEST);
        assert_eq!(page_paths(fixture.state.vault.root()), before);
    }
}

#[tokio::test]
async fn member_index_failure_rolls_back_generated_page_without_notification() {
    let fixture = member_fixture(seed);
    let revision = current_base_revision(&fixture, "reading").await;
    let before = page_paths(fixture.state.vault.root());
    let mut notifications = fixture.state.change_tx.subscribe();
    let _ = fixture
        .state
        .index
        .with_index(|_, _| -> () { panic!("terminate index thread for failure test") })
        .await;

    fixture
        .server
        .post("/api/vault/bases/reading/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "Continues",
            "title": "Rollback",
            "fields": { "kind": "BOOK", "status": "reading" }
        }))
        .await
        .assert_status(StatusCode::INTERNAL_SERVER_ERROR);

    assert_eq!(page_paths(fixture.state.vault.root()), before);
    assert_no_notification(&mut notifications);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_member_request_still_emits_one_event_after_commit() {
    let fixture = member_fixture(seed);
    let revision = current_base_revision(&fixture, "reading").await;
    let (publication_entered_tx, publication_entered_rx) = tokio::sync::oneshot::channel();
    let publication_entered_tx = Arc::new(parking_lot::Mutex::new(Some(publication_entered_tx)));
    let (publication_release_tx, publication_release_rx) = std::sync::mpsc::channel();
    let publication_release_rx = Arc::new(parking_lot::Mutex::new(publication_release_rx));
    fixture
        .state
        .mutation_coordinator
        .set_create_publication_hook(Some(Arc::new({
            let publication_entered_tx = Arc::clone(&publication_entered_tx);
            let publication_release_rx = Arc::clone(&publication_release_rx);
            move |path, content| {
                if let Some(entered) = publication_entered_tx.lock().take() {
                    let _ = entered.send(());
                }
                publication_release_rx.lock().recv().unwrap();
                clepsydra::vault::atomic_file::atomic_create(path, content)
            }
        })));
    let mut notifications = fixture.state.change_tx.subscribe();
    let (server, _temp_dir, state) = fixture.into_parts();
    let server = Arc::new(server);
    let request = tokio::spawn(async move {
        server
            .post("/api/vault/bases/reading/members")
            .json(&serde_json::json!({
                "base_revision": revision,
                "view": "Continues",
                "title": "Cancelled caller",
                "fields": { "kind": "BOOK", "status": "reading" }
            }))
            .await
    });

    publication_entered_rx.await.unwrap();
    request.abort();
    let _ = request.await;
    publication_release_tx.send(()).unwrap();

    let event = tokio::time::timeout(std::time::Duration::from_secs(2), notifications.recv())
        .await
        .expect("committed member did not emit an event after request cancellation")
        .unwrap();
    let upserted = match event {
        SyncNotification::IndexChanged { upserted, removed } => {
            assert!(removed.is_empty());
            upserted
        }
        other => panic!("unexpected notification: {other:?}"),
    };
    assert_eq!(upserted.len(), 1);
    let created_path = clepsydra::vault::path::VaultPath::new(&upserted[0]).unwrap();
    assert!(state.vault.resolve(&created_path).exists());
    let indexed: i64 = state
        .index
        .with_index(move |index, _| {
            index
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM pages WHERE path = ?1",
                    [created_path.as_str()],
                    |row| row.get(0),
                )
                .unwrap()
        })
        .await
        .unwrap();
    assert_eq!(indexed, 1);
}

#[tokio::test]
async fn member_base_load_io_failure_is_generic_and_writes_nothing() {
    let fixture = member_fixture(seed);
    let before_paths = page_paths(fixture.state.vault.root());
    let root = fixture.state.vault.root().to_string_lossy().into_owned();
    let base_path = fixture.state.vault.root().join("bases/reading.base.toml");
    fs::remove_file(&base_path).unwrap();
    fs::create_dir(&base_path).unwrap();
    let mut notifications = fixture.state.change_tx.subscribe();

    let response = fixture
        .server
        .post("/api/vault/bases/reading/members")
        .json(&serde_json::json!({
            "base_revision": "unreachable",
            "view": "Continues",
            "title": "Unreadable Base",
            "fields": { "kind": "BOOK", "status": "reading" }
        }))
        .await;
    response.assert_status(StatusCode::INTERNAL_SERVER_ERROR);
    let response_text = response.text();
    let error: serde_json::Value = serde_json::from_str(&response_text).unwrap();
    assert_eq!(error["error"], "Base member creation failed");
    assert_eq!(error["detail"]["code"], "base_member_creation_failed");
    assert!(!response_text.contains(&root), "{response_text}");
    assert!(!response_text.contains("directory"), "{response_text}");
    assert_eq!(page_paths(fixture.state.vault.root()), before_paths);
    assert_no_notification(&mut notifications);
}

#[tokio::test]
async fn member_internal_failure_is_generic_and_leaves_no_artifact_or_event() {
    let fixture = member_fixture(seed);
    let revision = current_base_revision(&fixture, "reading").await;
    let before_paths = page_paths(fixture.state.vault.root());
    let before_rows = indexed_page_count(&fixture).await;
    let root = fixture.state.vault.root().to_string_lossy().into_owned();
    let trigger_sql = format!(
        "CREATE TRIGGER reject_member_status_property
         BEFORE INSERT ON page_properties
         WHEN NEW.key = 'status'
         BEGIN
           SELECT RAISE(FAIL, 'injected index failure at {root}');
         END;
         CREATE TRIGGER reject_member_page_delete
         BEFORE DELETE ON pages
         BEGIN
           SELECT RAISE(FAIL, 'delete compensation must not run');
         END;"
    );
    fixture
        .state
        .index
        .with_index(move |index, _| {
            index.connection().execute_batch(&trigger_sql).unwrap();
        })
        .await
        .unwrap();
    fixture
        .state
        .mutation_coordinator
        .set_create_rollback_sync_hook(Some(Arc::new(|parent| {
            Err(std::io::Error::other(format!(
                "injected rollback sync failure at {}",
                parent.display()
            )))
        })));
    let mut notifications = fixture.state.change_tx.subscribe();

    let response = fixture
        .server
        .post("/api/vault/bases/reading/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "Continues",
            "title": "Private failure",
            "fields": { "kind": "BOOK", "status": "reading" }
        }))
        .await;
    response.assert_status(StatusCode::INTERNAL_SERVER_ERROR);
    let response_text = response.text();
    let error: serde_json::Value = serde_json::from_str(&response_text).unwrap();
    assert_eq!(error["error"], "Base member creation failed");
    assert_eq!(error["detail"]["code"], "base_member_creation_failed");
    assert!(!response_text.contains(&root), "{response_text}");
    assert!(!response_text.contains("injected"), "{response_text}");
    assert_eq!(page_paths(fixture.state.vault.root()), before_paths);
    assert_eq!(indexed_page_count(&fixture).await, before_rows);
    assert_no_notification(&mut notifications);
}

#[tokio::test]
async fn openapi_registers_base_member_contract() {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();
    assert!(document["paths"]["/api/vault/bases/{slug}/members"]["post"].is_object());
    for schema in [
        "BaseMemberCreateRequest",
        "BaseMemberCreateResponse",
        "BaseMemberValidationDetail",
        "BaseMemberCapability",
        "BaseMemberDiagnostic",
    ] {
        assert!(
            document["components"]["schemas"][schema].is_object(),
            "missing {schema}"
        );
    }
    let request = &document["components"]["schemas"]["BaseMemberCreateRequest"];
    assert!(request["properties"]["embed_filter"].is_object());
    assert!(
        !request["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|field| field == "embed_filter")
    );
}

#[tokio::test]
async fn filtered_member_relation_candidate_matches_indexed_links_for_canonical_alias_and_uuid() {
    let fixture = member_fixture(seed_relation_member_base);
    let revision = current_base_revision(&fixture, "relations").await;

    for (view, title, target, embed_target) in [
        (
            "Canonical",
            "Canonical relation",
            "[[Solar Cycle]]",
            "Solar Cycle",
        ),
        (
            "Alias",
            "Alias relation",
            "[[Science Fiction]]",
            "Science Fiction",
        ),
        (
            "Uuid",
            "UUID relation",
            "[[Science Fiction]]",
            LINK_TARGET_MIXED_ID,
        ),
        (
            "MixedUuid",
            "Mixed UUID relation",
            "[[Science Fiction]]",
            LINK_TARGET_ID,
        ),
    ] {
        let response = fixture
            .server
            .post("/api/vault/bases/relations/members")
            .json(&serde_json::json!({
                "base_revision": revision,
                "view": view,
                "title": title,
                "embed_filter": {
                    "field": "series",
                    "op": "links_to",
                    "value": embed_target
                },
                "fields": { "kind": "BOOK", "series": target }
            }))
            .await;
        response.assert_status(StatusCode::CREATED);
        let created: serde_json::Value = response.json();

        let queried = fixture
            .server
            .post(&format!("/api/vault/bases/relations/views/{view}/evaluate"))
            .json(&serde_json::json!({
                "filter": {
                    "field": "series",
                    "op": "links_to",
                    "value": embed_target
                }
            }))
            .await;
        queried.assert_status_ok();
        let queried: serde_json::Value = queried.json();
        assert!(
            queried["output"]["rows"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["id"] == created["id"]),
            "created candidate and indexed SQL disagreed for {view}: {queried}"
        );
    }

    let before_paths = page_paths(fixture.state.vault.root());
    let before_rows = indexed_page_count(&fixture).await;
    let response = fixture
        .server
        .post("/api/vault/bases/relations/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "MissingUuid",
            "title": "Mismatched UUID relation",
            "fields": { "kind": "BOOK", "series": "[[Science Fiction]]" }
        }))
        .await;
    response.assert_status(StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(page_paths(fixture.state.vault.root()), before_paths);
    assert_eq!(indexed_page_count(&fixture).await, before_rows);
}

// -- Flat-view aggregates: count/median/range functions --------------------

const TOTALS_BASE: &str = r#"
name = "Totals"

[filter]
all = [ { field = "kind", op = "eq", value = "BOOK" } ]

[properties]
rating  = { type = "number" }
status  = { type = "select", options = ["queued", "reading", "finished"] }

[[views]]
name = "All"
columns = ["title", "rating"]
aggregates = [
  { fn = "count" },
  { fn = "count_filled", field = "rating" },
  { fn = "percent_filled", field = "rating" },
  { fn = "median", field = "rating" },
  { fn = "range", field = "rating" },
]
"#;

/// Six BOOK pages with ratings `5, 3, 4, (absent), 2, 3`.
fn seed_totals_base(root: &Path) {
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::create_dir_all(root.join("books")).unwrap();
    fs::write(root.join("bases/totals.base.toml"), TOTALS_BASE).unwrap();

    let page = |id: &str, title: &str, extras: &str| {
        format!("+++\nid = \"{id}\"\ntitle = \"{title}\"\ntype = \"BOOK\"\n{extras}+++\nbody\n")
    };
    let books = [
        ("a", "Book A", "rating = 5\nstatus = \"reading\"\n"),
        ("b", "Book B", "rating = 3\nstatus = \"reading\"\n"),
        ("c", "Book C", "rating = 4\nstatus = \"queued\"\n"),
        ("d", "Book D", ""),
        ("e", "Book E", "rating = 2\nstatus = \"finished\"\n"),
        ("f", "Book F", "rating = 3\nstatus = \"reading\"\n"),
    ];
    for (letter, title, extras) in books {
        fs::write(
            root.join(format!("books/{letter}.md")),
            page(
                &format!("0190f8a0-0000-7000-8000-0000000000a{letter}"),
                title,
                extras,
            ),
        )
        .unwrap();
    }
}

#[tokio::test]
async fn flat_view_aggregates_are_unaffected_by_the_row_window() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_totals_base)
        .build()
        .into_server_and_temp();

    let response = server
        .get("/api/vault/bases/totals/views/All?limit=2")
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert_eq!(body["shape"], "flat");
    assert_eq!(body["rows"].as_array().unwrap().len(), 2);
    assert_eq!(body["total"], 6);
    assert_eq!(
        body["aggregates"],
        serde_json::json!([6, 5, 83.3, 3.0, 3.0]),
        "the window (limit=2) must not change the aggregates"
    );
}

#[tokio::test]
async fn preview_reports_a_warning_for_a_median_over_a_select_field() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_totals_base)
        .build()
        .into_server_and_temp();

    let definition = serde_json::json!({
        "name": "Totals Preview",
        "filter": { "all": [{ "field": "kind", "op": "eq", "value": "BOOK" }] },
        "properties": [
            { "key": "rating", "definition": { "type": "number" } },
            {
                "key": "status",
                "definition": {
                    "type": "select",
                    "options": ["queued", "reading", "finished"]
                }
            }
        ],
        "views": [{
            "name": "All",
            "aggregates": [{ "fn": "median", "field": "status" }]
        }]
    });

    let response = server
        .post("/api/vault/bases/preview")
        .json(&serde_json::json!({
            "definition": definition,
            "view": "All"
        }))
        .await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();

    assert!(
        body["diagnostics"].as_array().unwrap().iter().any(|d| {
            d["severity"] == "warning"
                && d["path"] == "views[0].aggregates[0].field"
                && d["message"]
                    .as_str()
                    .unwrap()
                    .contains("needs a number, date, or datetime field")
        }),
        "{body:#}"
    );
}

#[tokio::test]
async fn openapi_documents_the_new_aggregate_functions_and_flat_aggregates_field() {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();

    assert_eq!(
        document["components"]["schemas"]["AggregateFn"]["enum"],
        serde_json::json!([
            "count",
            "sum",
            "avg",
            "min",
            "max",
            "count_empty",
            "count_filled",
            "percent_filled",
            "count_unique",
            "median",
            "range",
        ])
    );

    let query_output = &document["components"]["schemas"]["QueryOutput"]["oneOf"];
    let flat = query_output
        .as_array()
        .unwrap()
        .iter()
        .find(|variant| variant["properties"]["shape"]["enum"] == serde_json::json!(["flat"]))
        .expect("flat variant present");
    assert!(
        flat["properties"]["aggregates"].is_object(),
        "flat variant should carry an `aggregates` field: {flat:#}"
    );
    assert!(
        flat["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|field| field == "aggregates")
    );
}
