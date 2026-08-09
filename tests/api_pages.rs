mod support;

use axum::http::StatusCode;
use support::ApiFixture;

async fn create_page(
    server: &axum_test::TestServer,
    path: &str,
    tags: &[&str],
    project: Option<&str>,
) {
    server
        .post(&format!("/api/vault/pages/{path}"))
        .json(&serde_json::json!({
            "title": path.trim_end_matches(".md"),
            "tags": tags,
            "project": project,
        }))
        .await
        .assert_status(StatusCode::CREATED);
}

fn item_paths(body: &serde_json::Value) -> Vec<&str> {
    body["items"]
        .as_array()
        .expect("items should be an array")
        .iter()
        .map(|item| item["path"].as_str().expect("page path should be a string"))
        .collect()
}

#[tokio::test]
async fn page_query_stops_at_the_sql_page_boundary_but_keeps_the_full_total() {
    let fixture = ApiFixture::builder().build();
    for path in [
        "alpha.md",
        "bravo.md",
        "charlie.md",
        "delta.md",
        "zz-corrupt.md",
    ] {
        create_page(&fixture.server, path, &[], None).await;
    }

    fixture
        .state
        .index
        .with_index(|index, _vault| {
            index.connection().execute(
                "UPDATE pages SET kind_inferred = 'not-an-integer' WHERE path = 'zz-corrupt.md'",
                [],
            )
        })
        .await
        .expect("index thread should remain available")
        .expect("fixture corruption should succeed");

    let first_response = fixture
        .server
        .get("/api/vault/pages?limit=2&offset=0")
        .await;
    first_response.assert_status_ok();
    let first: serde_json::Value = first_response.json();
    assert_eq!(first["total"], 5);
    assert_eq!(item_paths(&first), ["alpha.md", "bravo.md"]);

    let second_response = fixture
        .server
        .get("/api/vault/pages?limit=2&offset=2")
        .await;
    second_response.assert_status_ok();
    let second: serde_json::Value = second_response.json();
    assert_eq!(second["total"], 5);
    assert_eq!(item_paths(&second), ["charlie.md", "delta.md"]);
}

#[tokio::test]
async fn filtered_page_total_is_stable_across_ordered_page_boundaries() {
    let fixture = ApiFixture::builder().build();
    for (path, tags, project) in [
        ("alpha.md", &["focus"][..], Some("atlas")),
        ("bravo.md", &["other"][..], Some("atlas")),
        ("charlie.md", &["focus"][..], Some("atlas")),
        ("delta.md", &["focus"][..], Some("other")),
        ("echo.md", &["focus"][..], Some("atlas")),
    ] {
        create_page(&fixture.server, path, tags, project).await;
    }

    let mut seen = Vec::new();
    for offset in 0..3 {
        let body: serde_json::Value = fixture
            .server
            .get(&format!(
                "/api/vault/pages?tag=focus&project=atlas&limit=1&offset={offset}"
            ))
            .await
            .json();
        assert_eq!(body["total"], 3);
        assert_eq!(body["limit"], 1);
        assert_eq!(body["offset"], offset);
        seen.extend(item_paths(&body).into_iter().map(str::to_owned));
    }

    assert_eq!(seen, ["alpha.md", "charlie.md", "echo.md"]);

    let beyond: serde_json::Value = fixture
        .server
        .get("/api/vault/pages?tag=focus&project=atlas&limit=1&offset=3")
        .await
        .json();
    assert_eq!(beyond["total"], 3);
    assert!(item_paths(&beyond).is_empty());
}
