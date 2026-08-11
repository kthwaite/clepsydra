mod support;

use std::time::Duration;

use chrono::{TimeZone, Utc};
use clepsydra::feeds::scheduler::reconcile_feed_manifest;
use clepsydra::feeds::types::{
    EntryFilters, EntryPatch, EntryView, FetchOutcome, FetchedEntry,
};
use serde_json::Value;
use support::ApiFixture;

struct FeedFixture {
    api: ApiFixture,
    entry_id: i64,
}

async fn feed_fixture() -> FeedFixture {
    let api = ApiFixture::builder()
        .configure(|root| {
            std::fs::write(
                root.join("feeds.md"),
                "## Fixtures\n- [Fixture](https://fixture.example/rss) #fixture\n",
            )
            .unwrap();
        })
        .build();
    reconcile_feed_manifest(&api.state).await.unwrap();
    let feed_id = api.state.feeds.list_feeds().await.unwrap()[0].id;
    let fetched_at = Utc.with_ymd_and_hms(2026, 8, 11, 12, 0, 0).unwrap();
    api.state
        .feeds
        .apply_fetch(
            feed_id,
            FetchOutcome::Success {
                fetched_at,
                next_fetch_at: Utc.with_ymd_and_hms(2099, 1, 1, 0, 0, 0).unwrap(),
                fetch_url: "https://fixture.example/rss".to_owned(),
                etag: None,
                last_modified: None,
                title: Some("Fixture".to_owned()),
                site_url: Some("https://fixture.example".to_owned()),
                entries: vec![FetchedEntry {
                    guid: "entry-detail".to_owned(),
                    url: Some("https://fixture.example/entry-detail".to_owned()),
                    title: "Sanitized detail".to_owned(),
                    author: Some("Fixture Author".to_owned()),
                    content_html: Some("<p>safe content</p>".to_owned()),
                    published_at: Some(fetched_at),
                    fetched_at,
                }],
            },
        )
        .await
        .unwrap();
    let entry_id = api
        .state
        .feeds
        .list_entries(EntryFilters {
            view: EntryView::All,
            feed_id: None,
            group: None,
            tag: None,
            limit: 10,
            cursor: None,
        })
        .await
        .unwrap()
        .entries[0]
        .id;
    api.state
        .feeds
        .patch_entry(
            entry_id,
            EntryPatch {
                read: Some(true),
                bookmarked: Some(true),
                tags: Some(vec!["fixture".to_owned(), "saved".to_owned()]),
            },
        )
        .await
        .unwrap();

    FeedFixture { api, entry_id }
}

#[tokio::test]
async fn entry_detail_returns_the_list_projection_without_scheduling_refresh() {
    let fixture = feed_fixture().await;
    let list_response = fixture
        .api
        .server
        .get("/api/vault/feeds/entries")
        .await;
    list_response.assert_status_ok();
    let listed = list_response.json::<Value>()["entries"][0].clone();
    let due_before = fixture
        .api
        .state
        .feeds
        .due_feeds(Utc::now())
        .await
        .unwrap();

    let detail_response = fixture
        .api
        .server
        .get(&format!(
            "/api/vault/feeds/entries/{}",
            fixture.entry_id
        ))
        .await;

    detail_response.assert_status_ok();
    let detail = detail_response.json::<Value>();
    for field in [
        "id",
        "title",
        "content_html",
        "read",
        "bookmarked",
        "tags",
    ] {
        assert_eq!(detail[field], listed[field], "mismatched {field}");
    }
    assert_eq!(detail["content_html"], "<p>safe content</p>");
    assert_eq!(detail["read"], true);
    assert_eq!(detail["bookmarked"], true);
    assert_eq!(detail["tags"], serde_json::json!(["fixture", "saved"]));

    let due_after = fixture
        .api
        .state
        .feeds
        .due_feeds(Utc::now())
        .await
        .unwrap();
    assert_eq!(
        due_after.iter().map(|feed| feed.id).collect::<Vec<_>>(),
        due_before.iter().map(|feed| feed.id).collect::<Vec<_>>()
    );
    assert!(
        tokio::time::timeout(
            Duration::from_millis(25),
            fixture.api.state.feed_refresh.notified(),
        )
        .await
        .is_err(),
        "entry detail must not wake the feed scheduler"
    );
}

#[tokio::test]
async fn entry_detail_missing_id_returns_the_standard_not_found_error() {
    let fixture = feed_fixture().await;

    let response = fixture
        .api
        .server
        .get("/api/vault/feeds/entries/999999")
        .await;

    response.assert_status_not_found();
    assert_eq!(
        response.json::<Value>(),
        serde_json::json!({
            "status": 404,
            "error": "entry 999999 was not found"
        })
    );
}

async fn preference_namespace(api: &ApiFixture) -> String {
    let response = api.server.get("/api/vault/feeds").await;
    response.assert_status_ok();
    response.json::<Value>()["preference_namespace"]
        .as_str()
        .expect("feed list response must expose preference_namespace")
        .to_owned()
}

#[tokio::test]
async fn preference_namespace_is_stable_non_empty_lowercase_hex() {
    let api = ApiFixture::builder().build();

    let first = preference_namespace(&api).await;
    let second = preference_namespace(&api).await;
    let canonical_root = std::fs::canonicalize(api.state.vault.root()).unwrap();
    let mut expected = blake3::Hasher::new();
    expected.update(b"clepsydra-feed-preferences-v1\0");
    expected.update(canonical_root.as_os_str().as_encoded_bytes());

    assert_eq!(first, second);
    assert_eq!(first, expected.finalize().to_hex().as_str());
    assert_eq!(first.len(), 64);
    assert!(
        first
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );
}

#[tokio::test]
async fn preference_namespace_is_opaque_and_differs_across_vault_roots() {
    let first = ApiFixture::builder().build();
    let second = ApiFixture::builder().build();
    let first_root = first.state.vault.root().to_string_lossy().into_owned();
    let second_root = second.state.vault.root().to_string_lossy().into_owned();

    let first_namespace = preference_namespace(&first).await;
    let second_namespace = preference_namespace(&second).await;

    assert_ne!(first_namespace, second_namespace);
    for namespace in [&first_namespace, &second_namespace] {
        assert!(!namespace.contains(&first_root));
        assert!(!namespace.contains(&second_root));
    }
}
