pub mod api;
pub mod fetch;
pub mod manifest;
pub mod scheduler;

use anyhow::Context;
use chrono::Utc;
use sqlx::QueryBuilder;

use crate::AppState;

/// Sync the `feed` table from `feeds.md`. The file is the source of truth for
/// what is subscribed and how it's organized; the DB copy is a cache plus
/// fetch bookkeeping.
pub async fn reconcile(state: &AppState) -> anyhow::Result<()> {
    let path = state.config.manifest_path();
    let text = tokio::fs::read_to_string(&path)
        .await
        .with_context(|| format!("reading {}", path.display()))?;
    let m = manifest::parse(&text);
    for w in &m.warnings {
        tracing::warn!("feeds.md: {w}");
    }
    *state.manifest_warnings.lock().unwrap() = m.warnings;

    let now = Utc::now();
    for (i, f) in m.feeds.iter().enumerate() {
        let tags = serde_json::to_string(&f.tags)?;
        sqlx::query(
            "INSERT INTO feed (url, title_override, group_name, tags, subscribed, sort_order, added_at, next_fetch_at)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?)
             ON CONFLICT (url) DO UPDATE SET
                title_override = excluded.title_override,
                group_name = excluded.group_name,
                tags = excluded.tags,
                sort_order = excluded.sort_order,
                subscribed = 1",
        )
        .bind(&f.url)
        .bind(&f.title_override)
        .bind(&f.group)
        .bind(&tags)
        .bind(i as i64)
        .bind(now)
        .bind(now)
        .execute(&state.pool)
        .await?;
    }

    // Anything in the DB but not the manifest is unsubscribed (softly — the
    // prune job clears its entries, respecting bookmarks).
    let mut qb = QueryBuilder::new("UPDATE feed SET subscribed = 0 WHERE subscribed = 1");
    if !m.feeds.is_empty() {
        qb.push(" AND url NOT IN (");
        let mut sep = qb.separated(", ");
        for f in &m.feeds {
            sep.push_bind(&f.url);
        }
        qb.push(")");
    }
    qb.build().execute(&state.pool).await?;
    Ok(())
}

/// Atomically rewrite `feeds.md` (write temp + rename) and reconcile.
pub async fn write_manifest(state: &AppState, text: &str) -> anyhow::Result<()> {
    let path = state.config.manifest_path();
    let tmp = path.with_extension("md.tmp");
    tokio::fs::write(&tmp, text).await?;
    tokio::fs::rename(&tmp, &path).await?;
    reconcile(state).await
}

pub async fn read_manifest(state: &AppState) -> anyhow::Result<String> {
    let path = state.config.manifest_path();
    Ok(tokio::fs::read_to_string(&path)
        .await
        .with_context(|| format!("reading {}", path.display()))?)
}
