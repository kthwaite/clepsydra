//! Fetch pipeline: conditional GET, parse via feed-rs, sanitize at ingestion,
//! idempotent upsert keyed on (feed_id, guid), exponential backoff on error.

use anyhow::{Context, bail};
use chrono::{DateTime, Duration, Utc};
use sha2::{Digest, Sha256};
use sqlx::Row;
use tokio::task::JoinSet;

use crate::AppState;

const MAX_BACKOFF_MINS: i64 = 24 * 60;
const SWEEP_CONCURRENCY: usize = 4;

/// Fetch every subscribed feed that is due.
pub async fn sweep(state: &AppState) {
    let due: Vec<i64> = match sqlx::query_scalar(
        "SELECT id FROM feed WHERE subscribed = 1 AND next_fetch_at <= ?",
    )
    .bind(Utc::now())
    .fetch_all(&state.pool)
    .await
    {
        Ok(ids) => ids,
        Err(e) => {
            tracing::error!("sweep query failed: {e}");
            return;
        }
    };
    if due.is_empty() {
        return;
    }
    tracing::info!("fetching {} due feed(s)", due.len());

    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(SWEEP_CONCURRENCY));
    let mut set = JoinSet::new();
    for id in due {
        let state = state.clone();
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire().await;
            if let Err(e) = fetch_one(&state, id).await {
                tracing::warn!("feed {id}: fetch failed: {e:#}");
            }
        });
    }
    while set.join_next().await.is_some() {}
}

pub async fn fetch_one(state: &AppState, feed_id: i64) -> anyhow::Result<()> {
    let row = sqlx::query("SELECT url, etag, last_modified, error_count FROM feed WHERE id = ?")
        .bind(feed_id)
        .fetch_one(&state.pool)
        .await
        .context("loading feed")?;
    let url: String = row.get("url");
    let etag: Option<String> = row.get("etag");
    let last_modified: Option<String> = row.get("last_modified");
    let error_count: i64 = row.get("error_count");

    let mut req = state.http.get(&url);
    if let Some(etag) = &etag {
        req = req.header("If-None-Match", etag);
    }
    if let Some(lm) = &last_modified {
        req = req.header("If-Modified-Since", lm);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            record_error(state, feed_id, error_count, &format!("request failed: {e}")).await?;
            return Ok(());
        }
    };

    if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
        record_success(state, feed_id, None, None, etag.as_deref(), last_modified.as_deref())
            .await?;
        return Ok(());
    }
    if !resp.status().is_success() {
        record_error(state, feed_id, error_count, &format!("HTTP {}", resp.status())).await?;
        return Ok(());
    }

    let new_etag = header(&resp, "etag");
    let new_lm = header(&resp, "last-modified");
    let body = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            record_error(state, feed_id, error_count, &format!("read failed: {e}")).await?;
            return Ok(());
        }
    };

    let parsed = match feed_rs::parser::parse(&body[..]) {
        Ok(p) => p,
        Err(e) => {
            record_error(state, feed_id, error_count, &format!("parse failed: {e}")).await?;
            return Ok(());
        }
    };

    let feed_title = parsed.title.as_ref().map(|t| t.content.trim().to_string());
    let site_url = parsed
        .links
        .iter()
        .find(|l| l.rel.as_deref() != Some("self"))
        .map(|l| l.href.clone());

    let now = Utc::now();
    for entry in &parsed.entries {
        ingest_entry(state, feed_id, entry, now).await?;
    }

    record_success(
        state,
        feed_id,
        feed_title.as_deref(),
        site_url.as_deref(),
        new_etag.as_deref(),
        new_lm.as_deref(),
    )
    .await?;
    Ok(())
}

async fn ingest_entry(
    state: &AppState,
    feed_id: i64,
    entry: &feed_rs::model::Entry,
    fetched_at: DateTime<Utc>,
) -> anyhow::Result<()> {
    let link = entry.links.first().map(|l| l.href.clone());
    let title = entry
        .title
        .as_ref()
        .map(|t| t.content.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "(untitled)".to_string());
    let published = entry.published.or(entry.updated);

    let guid = if !entry.id.trim().is_empty() {
        entry.id.trim().to_string()
    } else if let Some(link) = &link {
        link.clone()
    } else {
        let mut h = Sha256::new();
        h.update(title.as_bytes());
        h.update(published.map(|d| d.to_rfc3339()).unwrap_or_default());
        format!("sha256:{:x}", h.finalize())
    };

    let raw_content = entry
        .content
        .as_ref()
        .and_then(|c| c.body.clone())
        .or_else(|| entry.summary.as_ref().map(|s| s.content.clone()));
    let content_html = raw_content.map(|c| ammonia::clean(&c));
    let author = entry
        .authors
        .first()
        .map(|a| a.name.clone())
        .filter(|n| !n.is_empty());

    sqlx::query(
        "INSERT INTO entry (feed_id, guid, url, title, author, content_html, published_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (feed_id, guid) DO UPDATE SET
            url = excluded.url,
            title = excluded.title,
            author = excluded.author,
            content_html = excluded.content_html,
            published_at = coalesce(excluded.published_at, entry.published_at)",
    )
    .bind(feed_id)
    .bind(&guid)
    .bind(&link)
    .bind(&title)
    .bind(&author)
    .bind(&content_html)
    .bind(published)
    .bind(fetched_at)
    .execute(&state.pool)
    .await
    .context("upserting entry")?;
    Ok(())
}

async fn record_success(
    state: &AppState,
    feed_id: i64,
    title: Option<&str>,
    site_url: Option<&str>,
    etag: Option<&str>,
    last_modified: Option<&str>,
) -> anyhow::Result<()> {
    let now = Utc::now();
    let next = now + Duration::minutes(state.config.fetch_interval_mins);
    sqlx::query(
        "UPDATE feed SET
            title = coalesce(?, title),
            site_url = coalesce(?, site_url),
            etag = ?,
            last_modified = ?,
            last_fetch_at = ?,
            next_fetch_at = ?,
            error_count = 0,
            last_error = NULL
         WHERE id = ?",
    )
    .bind(title)
    .bind(site_url)
    .bind(etag)
    .bind(last_modified)
    .bind(now)
    .bind(next)
    .bind(feed_id)
    .execute(&state.pool)
    .await?;
    Ok(())
}

async fn record_error(
    state: &AppState,
    feed_id: i64,
    prev_error_count: i64,
    error: &str,
) -> anyhow::Result<()> {
    let count = prev_error_count + 1;
    let backoff = (state.config.fetch_interval_mins << (count - 1).min(10)).min(MAX_BACKOFF_MINS);
    let now = Utc::now();
    sqlx::query(
        "UPDATE feed SET last_fetch_at = ?, next_fetch_at = ?, error_count = ?, last_error = ?
         WHERE id = ?",
    )
    .bind(now)
    .bind(now + Duration::minutes(backoff))
    .bind(count)
    .bind(error)
    .bind(feed_id)
    .execute(&state.pool)
    .await?;
    tracing::warn!("feed {feed_id}: {error} (error #{count}, retry in {backoff}m)");
    Ok(())
}

fn header(resp: &reqwest::Response, name: &str) -> Option<String> {
    resp.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(String::from)
}

/// Resolve user input (a feed URL or an HTML page URL) to a validated feed
/// URL: fetch it, and if it isn't a feed, discover one via
/// `<link rel="alternate" type="application/rss+xml|atom+xml">`.
pub async fn resolve_feed_url(state: &AppState, input: &str) -> anyhow::Result<String> {
    let input = input.trim();
    if !input.starts_with("http://") && !input.starts_with("https://") {
        bail!("not an http(s) URL: {input}");
    }
    let resp = state.http.get(input).send().await.context("fetching URL")?;
    if !resp.status().is_success() {
        bail!("HTTP {} fetching {input}", resp.status());
    }
    let base = resp.url().clone();
    let body = resp.bytes().await.context("reading response")?;

    if feed_rs::parser::parse(&body[..]).is_ok() {
        return Ok(input.to_string());
    }

    let html = String::from_utf8_lossy(&body);
    let candidate = discover_feed_href(&html)
        .and_then(|href| base.join(&href).ok())
        .context("no feed found at URL (not a feed, and no alternate link discovered)")?;

    let resp = state
        .http
        .get(candidate.clone())
        .send()
        .await
        .context("fetching discovered feed")?;
    let body = resp.bytes().await?;
    feed_rs::parser::parse(&body[..])
        .with_context(|| format!("discovered {candidate} but it does not parse as a feed"))?;
    Ok(candidate.to_string())
}

/// Scan HTML for the first `<link>` whose rel is `alternate` and whose type
/// is an RSS/Atom/JSON-feed MIME type. Deliberately unfancy.
fn discover_feed_href(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let mut at = 0;
    while let Some(pos) = lower[at..].find("<link") {
        let start = at + pos;
        let end = lower[start..].find('>').map(|e| start + e)?;
        let tag = &lower[start..end];
        if tag.contains("alternate")
            && (tag.contains("rss+xml") || tag.contains("atom+xml") || tag.contains("feed+json"))
            && let Some(href) = attr_value(&html[start..end], "href")
        {
            return Some(href);
        }
        at = end;
    }
    None
}

fn attr_value(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let idx = lower.find(&format!("{name}="))? + name.len() + 1;
    let rest = &tag[idx..];
    let (quote, rest) = match rest.chars().next()? {
        c @ ('"' | '\'') => (Some(c), &rest[1..]),
        _ => (None, rest),
    };
    let end = match quote {
        Some(q) => rest.find(q)?,
        None => rest
            .find(|c: char| c.is_whitespace() || c == '>')
            .unwrap_or(rest.len()),
    };
    Some(rest[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_alternate_links() {
        let html = r#"<html><head>
            <link rel="stylesheet" href="/style.css">
            <LINK REL="alternate" TYPE="application/rss+xml" HREF="/feed.xml" title="Feed">
        </head></html>"#;
        assert_eq!(discover_feed_href(html).as_deref(), Some("/feed.xml"));
        assert_eq!(discover_feed_href("<html><head></head></html>"), None);
    }

    #[test]
    fn attr_extraction_handles_quotes() {
        assert_eq!(attr_value(r#"<link href="/a.xml">"#, "href").as_deref(), Some("/a.xml"));
        assert_eq!(attr_value("<link href='/b.xml'>", "href").as_deref(), Some("/b.xml"));
        assert_eq!(attr_value("<link href=/c.xml >", "href").as_deref(), Some("/c.xml"));
    }
}
