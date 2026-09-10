use std::sync::Arc;
use std::time::Duration;

use chrono::{TimeZone, Utc};
use clepsydra::api::AppState;
use clepsydra::feeds::scheduler::{reconcile_feed_manifest, run_due_sweep, spawn_scheduler};
use clepsydra::feeds::types::FetchOutcome;
use clepsydra::{FeatureFlags, FeedsSettings, build_app_state_with_settings};
use tempfile::TempDir;

struct SchedulerFixture {
    state: Arc<AppState>,
    _temp: TempDir,
}

async fn scheduler_fixture(manifest: &str) -> SchedulerFixture {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("vault");
    clepsydra::vault::init::init_vault(&root).unwrap();
    std::fs::write(root.join("feeds.md"), manifest).unwrap();
    let state =
        build_app_state_with_settings(&root, &FeedsSettings::default(), FeatureFlags::default())
            .await
            .unwrap();
    reconcile_feed_manifest(&state.feed_host()).await.unwrap();

    // Keep the deterministic fixture feed outside the due set. A scheduler
    // bug must not turn this local contract test into a network request.
    let runtime = state
        .feed_runtime
        .as_ref()
        .expect("scheduler fixture enables the feed runtime");
    if let Some(feed) = runtime.feeds.list_feeds().await.unwrap().first() {
        runtime
            .feeds
            .apply_fetch(
                feed.id,
                FetchOutcome::Failure {
                    fetched_at: Utc.with_ymd_and_hms(2026, 8, 9, 0, 0, 0).unwrap(),
                    next_fetch_at: Utc.with_ymd_and_hms(2099, 1, 1, 0, 0, 0).unwrap(),
                    error: "fixture bookkeeping".to_owned(),
                },
            )
            .await
            .unwrap();
    }

    SchedulerFixture { state, _temp: temp }
}

#[tokio::test]
async fn refresh_notification_reconciles_before_the_next_timer_tick() {
    let fixture = scheduler_fixture("## Before\n- [Fixture](http://127.0.0.1:9/rss)\n").await;
    let scheduler = spawn_scheduler(fixture.state.feed_host());

    // Allow the scheduler's immediate startup sweep to finish, then require
    // the notifier—not the long periodic interval—to observe this edit.
    tokio::time::sleep(Duration::from_millis(50)).await;
    std::fs::write(
        fixture.state.vault.root().join("feeds.md"),
        "## After\n- [Fixture](http://127.0.0.1:9/rss)\n",
    )
    .unwrap();
    let runtime = fixture.state.feed_runtime.as_ref().unwrap();
    runtime.feed_refresh.notify_one();

    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let feeds = runtime.feeds.list_feeds().await.unwrap();
            if feeds.len() == 1 && feeds[0].group == "After" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("refresh notification did not wake the scheduler");

    scheduler.shutdown().await.unwrap();
}

#[tokio::test]
async fn persisted_reconciliation_and_every_due_fetch_broadcast_feed_changed() {
    let fixture = scheduler_fixture(
        "## Fixture\n\
         - [Explicit](http://127.0.0.1:9/explicit.xml)\n\
         - [Periodic](http://127.0.0.1:9/periodic.xml)\n",
    )
    .await;
    let runtime = fixture.state.feed_runtime.as_ref().unwrap();
    let feeds = runtime.feeds.list_feeds().await.unwrap();
    assert_eq!(feeds.len(), 2);
    for feed in &feeds {
        let periodic = feed.url.ends_with("/periodic.xml");
        runtime
            .feeds
            .apply_fetch(
                feed.id,
                FetchOutcome::Failure {
                    fetched_at: Utc.with_ymd_and_hms(2026, 8, 9, 0, 0, 0).unwrap(),
                    next_fetch_at: if periodic {
                        Utc::now() - chrono::Duration::minutes(1)
                    } else {
                        Utc.with_ymd_and_hms(2099, 1, 1, 0, 0, 0).unwrap()
                    },
                    error: "pre-sweep fixture state".to_owned(),
                },
            )
            .await
            .unwrap();
    }
    let explicit_id = feeds
        .iter()
        .find(|feed| feed.url.ends_with("/explicit.xml"))
        .unwrap()
        .id;
    runtime
        .feeds
        .schedule_refresh(Some(explicit_id), Utc::now())
        .await
        .unwrap();
    std::fs::write(
        fixture.state.vault.root().join("feeds.md"),
        "## Fixture\n\
         - [Explicit](http://127.0.0.1:9/explicit.xml)\n\
         - [Periodic](http://127.0.0.1:9/periodic.xml)\n\
         - [New subscription](http://127.0.0.1:9/new.xml)\n",
    )
    .unwrap();
    let mut changes = fixture.state.change_tx.subscribe();

    run_due_sweep(&fixture.state.feed_host()).await.unwrap();

    let persisted = runtime.feeds.list_feeds().await.unwrap();
    assert_eq!(persisted.len(), 3);
    assert!(
        persisted.iter().all(|feed| {
            feed.last_error
                .as_deref()
                .is_some_and(|error| error != "pre-sweep fixture state")
        }),
        "explicit, periodic, and first-subscription fetch outcomes must be persisted"
    );
    for completion in [
        "external manifest reconciliation",
        "explicit refresh fetch",
        "periodic fetch",
        "new-subscription first fetch",
    ] {
        let notification = tokio::time::timeout(Duration::from_millis(100), changes.recv())
            .await
            .unwrap_or_else(|_| panic!("missing feed-changed event after {completion}"))
            .unwrap();
        assert_eq!(
            serde_json::to_value(notification).unwrap(),
            serde_json::json!({ "type": "feed_changed" }),
            "{completion} must use the existing SyncNotification channel"
        );
    }
}

#[tokio::test]
async fn shutdown_cancels_and_joins_without_waiting_for_the_next_tick() {
    let fixture = scheduler_fixture("").await;
    let scheduler = spawn_scheduler(fixture.state.feed_host());

    tokio::time::timeout(Duration::from_secs(1), scheduler.shutdown())
        .await
        .expect("scheduler shutdown waited for its periodic tick")
        .unwrap();

    // A joined worker cannot consume later notifications.
    std::fs::write(
        fixture.state.vault.root().join("feeds.md"),
        "## After shutdown\n- https://after.example/rss\n",
    )
    .unwrap();
    let runtime = fixture.state.feed_runtime.as_ref().unwrap();
    runtime.feed_refresh.notify_one();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(runtime.feeds.list_feeds().await.unwrap().is_empty());
}
