pub mod api;
pub mod fetch;
pub mod manifest;
pub mod scheduler;

use std::fmt;

use anyhow::Context;
use chrono::Utc;
use sqlx::QueryBuilder;

use crate::AppState;

#[derive(Debug)]
pub enum ManifestUpdateError {
    InvalidSource(Vec<String>),
    InvalidCandidate(Vec<String>),
    Conflict,
    Rejected(String),
    ItemNotFound,
    Internal(anyhow::Error),
}

impl fmt::Display for ManifestUpdateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSource(warnings) => {
                write!(f, "manifest source is invalid: {}", warnings.join("; "))
            }
            Self::InvalidCandidate(warnings) => {
                write!(f, "manifest update is invalid: {}", warnings.join("; "))
            }
            Self::Conflict => f.write_str("manifest changed during update"),
            Self::Rejected(message) => f.write_str(message),
            Self::ItemNotFound => f.write_str("feed is not present in the manifest"),
            Self::Internal(error) => write!(f, "{error:#}"),
        }
    }
}

impl std::error::Error for ManifestUpdateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Internal(error) => Some(error.as_ref()),
            _ => None,
        }
    }
}

impl From<std::io::Error> for ManifestUpdateError {
    fn from(error: std::io::Error) -> Self {
        Self::Internal(error.into())
    }
}

fn record_manifest_warnings(state: &AppState, warnings: &[String]) {
    for warning in warnings {
        tracing::warn!("feeds.md: {warning}");
    }
    *state.manifest_warnings.lock().unwrap() = warnings.to_vec();
}

/// Sync the `feed` table from `feeds.md`. The file is the source of truth for
/// what is subscribed and how it's organized; the DB copy is a cache plus
/// fetch bookkeeping.
pub async fn reconcile(state: &AppState) -> anyhow::Result<()> {
    let _manifest_guard = state.manifest_lock.lock().await;
    let text = read_manifest(state).await?;
    let parsed = manifest::parse(&text);
    record_manifest_warnings(state, &parsed.warnings);
    if !parsed.warnings.is_empty() {
        return Ok(());
    }
    reconcile_parsed(state, &parsed).await
}

async fn reconcile_parsed(state: &AppState, parsed: &manifest::Manifest) -> anyhow::Result<()> {
    let mut tx = state.pool.begin().await?;
    let now = Utc::now();
    for (i, feed) in parsed.feeds.iter().enumerate() {
        let tags = serde_json::to_string(&feed.tags)?;
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
        .bind(&feed.url)
        .bind(&feed.title_override)
        .bind(&feed.group)
        .bind(&tags)
        .bind(i as i64)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }

    // Anything in the DB but not the manifest is unsubscribed (softly — the
    // prune job clears its entries, respecting bookmarks).
    let mut query = QueryBuilder::new("UPDATE feed SET subscribed = 0 WHERE subscribed = 1");
    if !parsed.feeds.is_empty() {
        query.push(" AND url NOT IN (");
        let mut separated = query.separated(", ");
        for feed in &parsed.feeds {
            separated.push_bind(&feed.url);
        }
        query.push(")");
    }
    query.build().execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// Serialize, validate, atomically write, and reconcile a manifest transform.
pub async fn update_manifest<T, F>(
    state: &AppState,
    transform: F,
) -> Result<T, ManifestUpdateError>
where
    F: FnOnce(&str) -> Result<(String, T), ManifestUpdateError>,
{
    let _manifest_guard = state.manifest_lock.lock().await;
    let path = state.config.manifest_path();
    let source = read_manifest(state)
        .await
        .map_err(ManifestUpdateError::Internal)?;
    let source_manifest = manifest::parse(&source);
    record_manifest_warnings(state, &source_manifest.warnings);
    if !source_manifest.warnings.is_empty() {
        return Err(ManifestUpdateError::InvalidSource(source_manifest.warnings));
    }

    let (candidate, output) = transform(&source)?;
    let candidate_manifest = manifest::parse(&candidate);
    if !candidate_manifest.warnings.is_empty() {
        return Err(ManifestUpdateError::InvalidCandidate(
            candidate_manifest.warnings,
        ));
    }

    let temporary_path = path.with_extension("md.tmp");
    tokio::fs::write(&temporary_path, &candidate)
        .await
        .with_context(|| format!("writing {}", temporary_path.display()))
        .map_err(ManifestUpdateError::Internal)?;

    let current = read_manifest(state)
        .await
        .map_err(ManifestUpdateError::Internal)?;
    if current != source {
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(ManifestUpdateError::Conflict);
    }

    tokio::fs::rename(&temporary_path, &path)
        .await
        .with_context(|| format!("replacing {}", path.display()))
        .map_err(ManifestUpdateError::Internal)?;
    record_manifest_warnings(state, &candidate_manifest.warnings);
    reconcile_parsed(state, &candidate_manifest)
        .await
        .map_err(ManifestUpdateError::Internal)?;
    Ok(output)
}

pub async fn read_manifest(state: &AppState) -> anyhow::Result<String> {
    let path = state.config.manifest_path();
    tokio::fs::read_to_string(&path)
        .await
        .with_context(|| format!("reading {}", path.display()))
}


#[cfg(test)]
mod tests {
    use std::{
        net::{IpAddr, Ipv4Addr},
        sync::{Arc, Mutex},
    };

    use sqlx::sqlite::SqlitePoolOptions;
    use tempfile::TempDir;
    use tokio::sync::Notify;

    use super::*;
    use crate::Config;

    const VALID_MANIFEST: &str = "# feeds\n\n## Feeds\n\n- https://valid.example/feed\n";

    async fn test_state(manifest: &str) -> (TempDir, AppState) {
        let vault = tempfile::tempdir().unwrap();
        tokio::fs::write(vault.path().join("feeds.md"), manifest)
            .await
            .unwrap();
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!().run(&pool).await.unwrap();
        let config = Config {
            db_path: vault.path().join("clepsydra.db"),
            vault_dir: vault.path().to_path_buf(),
            ui_dist: vault.path().join("ui"),
            bind_addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 0,
            fetch_interval_mins: 30,
            retention_days: 30,
            unread_retention_days: 90,
            max_response_bytes: 1024,
            max_entry_content_bytes: 1024,
        };
        let state = AppState {
            pool,
            config: Arc::new(config),
            refresh: Arc::new(Notify::new()),
            http: reqwest::Client::new(),
            manifest_warnings: Arc::new(Mutex::new(Vec::new())),
            manifest_lock: Arc::new(tokio::sync::Mutex::new(())),
        };
        (vault, state)
    }

    #[tokio::test]
    async fn warning_bearing_manifest_preserves_last_good_subscriptions() {
        let (_vault, state) = test_state(VALID_MANIFEST).await;
        reconcile(&state).await.unwrap();

        tokio::fs::write(
            state.config.manifest_path(),
            "# feeds\n\n## Feeds\n\n- [broken](https://invalid.example/feed\n",
        )
        .await
        .unwrap();
        reconcile(&state).await.unwrap();

        let subscribed: i64 =
            sqlx::query_scalar("SELECT subscribed FROM feed WHERE url = ?")
                .bind("https://valid.example/feed")
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(subscribed, 1);
        assert!(!state.manifest_warnings.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn concurrent_manifest_updates_preserve_both_changes() {
        let (_vault, state) = test_state("# feeds\n\n## Feeds\n").await;
        let first_state = state.clone();
        let second_state = state.clone();

        let (first, second) = tokio::join!(
            update_manifest(&first_state, |text| {
                Ok((
                    manifest::add_item(text, "Feeds", "https://one.example/feed"),
                    (),
                ))
            }),
            update_manifest(&second_state, |text| {
                Ok((
                    manifest::add_item(text, "Feeds", "https://two.example/feed"),
                    (),
                ))
            }),
        );
        first.unwrap();
        second.unwrap();

        let parsed = manifest::parse(&read_manifest(&state).await.unwrap());
        assert_eq!(parsed.feeds.len(), 2);
        assert!(parsed.feeds.iter().any(|feed| feed.url == "https://one.example/feed"));
        assert!(parsed.feeds.iter().any(|feed| feed.url == "https://two.example/feed"));
    }

    #[tokio::test]
    async fn external_edit_conflict_preserves_external_content() {
        let (_vault, state) = test_state(VALID_MANIFEST).await;
        let manifest_path = state.config.manifest_path();
        let external =
            "# feeds\n\n## External\n\n- https://external.example/feed\n".to_string();
        let external_write = external.clone();

        let result = update_manifest(&state, move |text| {
            std::fs::write(&manifest_path, external_write)?;
            Ok((
                manifest::add_item(text, "Feeds", "https://candidate.example/feed"),
                (),
            ))
        })
        .await;

        assert!(matches!(result, Err(ManifestUpdateError::Conflict)));
        assert_eq!(read_manifest(&state).await.unwrap(), external);
    }

    #[tokio::test]
    async fn warning_bearing_candidate_does_not_mutate_file_or_subscriptions() {
        let (_vault, state) = test_state(VALID_MANIFEST).await;
        reconcile(&state).await.unwrap();

        let result = update_manifest(&state, |_| {
            Ok((
                "# feeds\n\n## Feeds\n\n- [broken](https://invalid.example/feed\n".to_string(),
                (),
            ))
        })
        .await;

        assert!(matches!(result, Err(ManifestUpdateError::InvalidCandidate(_))));
        assert_eq!(read_manifest(&state).await.unwrap(), VALID_MANIFEST);
        let subscribed: i64 =
            sqlx::query_scalar("SELECT subscribed FROM feed WHERE url = ?")
                .bind("https://valid.example/feed")
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(subscribed, 1);
    }
}