//! One background loop drives everything: reconcile `feeds.md` when it
//! changes on disk, sweep due feeds, prune expired entries. Manual refresh
//! pokes the loop via `state.refresh` instead of having its own code path.

use chrono::{Duration, Utc};

use crate::AppState;
use super::fetch;

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut manifest_mtime: Option<std::time::SystemTime> = None;

        loop {
            tokio::select! {
                _ = tick.tick() => {}
                _ = state.refresh.notified() => {}
            }

            match tokio::fs::metadata(state.config.manifest_path()).await {
                Ok(meta) => {
                    let mtime = meta.modified().ok();
                    if manifest_mtime != mtime {
                        if let Err(e) = super::reconcile(&state).await {
                            tracing::warn!("feeds.md reconcile failed: {e:#}");
                        }
                        manifest_mtime = mtime;
                    }
                }
                Err(e) => tracing::warn!("feeds.md missing: {e}"),
            }

            fetch::sweep(&state).await;

            if let Err(e) = prune(&state).await {
                tracing::warn!("prune failed: {e:#}");
            }
        }
    });
}

/// Entries are ephemeral by default; bookmarking exempts an entry forever,
/// including surviving unsubscription of its feed.
async fn prune(state: &AppState) -> anyhow::Result<()> {
    let now = Utc::now();
    let read_cutoff = now - Duration::days(state.config.retention_days);
    let unread_cutoff = now - Duration::days(state.config.unread_retention_days);

    let res = sqlx::query(
        "DELETE FROM entry WHERE bookmarked_at IS NULL AND (
            (read_at IS NOT NULL AND coalesce(published_at, fetched_at) < ?)
            OR (read_at IS NULL AND coalesce(published_at, fetched_at) < ?)
            OR feed_id IN (SELECT id FROM feed WHERE subscribed = 0)
        )",
    )
    .bind(read_cutoff)
    .bind(unread_cutoff)
    .execute(&state.pool)
    .await?;
    if res.rows_affected() > 0 {
        tracing::info!("pruned {} entries", res.rows_affected());
    }

    // Unsubscribed feeds linger only while bookmarked entries still point at them.
    sqlx::query(
        "DELETE FROM feed WHERE subscribed = 0
         AND NOT EXISTS (SELECT 1 FROM entry WHERE entry.feed_id = feed.id)",
    )
    .execute(&state.pool)
    .await?;
    Ok(())
}
