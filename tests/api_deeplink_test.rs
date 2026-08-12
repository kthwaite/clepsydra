mod support;

use axum::http::StatusCode;
use support::ApiFixture;

fn seed_alpha(root: &std::path::Path) {
    std::fs::create_dir_all(root.join("projects")).unwrap();
    std::fs::write(
        root.join("projects/20260531.alpha.aB3dE9xZ.md"),
        "---\nid: 0190f8a0-0000-7000-8000-0000000000a1\ntitle: Alpha Project\ncreated_at: 2026-05-31T12:00:00Z\n---\nbody\n",
    )
    .unwrap();
}

#[tokio::test]
async fn resolve_returns_path_for_clepsydra_link() {
    let fx = ApiFixture::builder().pre_index_seed(seed_alpha).build();
    let res = fx
        .server
        .get("/api/vault/resolve")
        .add_query_param("url", "clepsydra://page/Alpha%20Project")
        .await;
    res.assert_status(StatusCode::OK);
    let body: serde_json::Value = res.json();
    assert_eq!(body["path"], "projects/20260531.alpha.aB3dE9xZ.md");
}

#[tokio::test]
async fn resolve_handles_obsidian_open_with_matching_vault() {
    let fx = ApiFixture::builder().pre_index_seed(seed_alpha).build();
    // ApiFixture's vault root directory is named "vault" (tests/support/mod.rs:109).
    let res = fx
        .server
        .get("/api/vault/resolve")
        .add_query_param("url", "obsidian://open?vault=vault&file=Alpha%20Project")
        .await;
    res.assert_status(StatusCode::OK);
}

#[tokio::test]
async fn resolve_rejects_vault_mismatch_with_404() {
    let fx = ApiFixture::builder().pre_index_seed(seed_alpha).build();
    let res = fx
        .server
        .get("/api/vault/resolve")
        .add_query_param(
            "url",
            "obsidian://open?vault=someone-elses&file=Alpha%20Project",
        )
        .await;
    res.assert_status(StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn resolve_unknown_target_is_404_and_bad_url_is_400() {
    let fx = ApiFixture::builder().build();
    let miss = fx
        .server
        .get("/api/vault/resolve")
        .add_query_param("url", "clepsydra://page/nope")
        .await;
    miss.assert_status(StatusCode::NOT_FOUND);
    let bad = fx
        .server
        .get("/api/vault/resolve")
        .add_query_param("url", "clepsydra://frobnicate/x")
        .await;
    bad.assert_status(StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn deeplink_redirects_to_page_on_hit() {
    let fx = ApiFixture::builder().pre_index_seed(seed_alpha).build();
    let res = fx
        .server
        .get("/deeplink")
        .add_query_param("url", "clepsydra://page/aB3dE9xZ")
        .await;
    res.assert_status(StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(
        res.header("location"),
        "/pages/projects/20260531.alpha.aB3dE9xZ.md"
    );
}

#[tokio::test]
async fn deeplink_redirects_unknown_targets_to_repairs_with_target_context() {
    let fx = ApiFixture::builder().build();
    for (url, expected_location) in [
        (
            "clepsydra://page/nope",
            "/repairs?target=clepsydra%3A%2F%2Fpage%2Fnope",
        ),
        (
            "clepsydra://frobnicate/nope",
            "/repairs?target=clepsydra%3A%2F%2Ffrobnicate%2Fnope",
        ),
    ] {
        let res = fx
            .server
            .get("/deeplink")
            .add_query_param("url", url)
            .await;
        res.assert_status(StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(res.header("location"), expected_location);
    }
}
