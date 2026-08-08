//! Fetch pipeline: conditional GET, parse via feed-rs, sanitize at ingestion,
//! idempotent upsert keyed on (feed_id, guid), exponential backoff on error.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use anyhow::{Context, bail, ensure};
use bytes::BytesMut;
use chrono::{DateTime, Duration, Utc};
use sha2::{Digest, Sha256};
use sqlx::Row;
use tokio::task::JoinSet;

use crate::AppState;

const MAX_BACKOFF_MINS: i64 = 24 * 60;
const SWEEP_CONCURRENCY: usize = 4;
const MAX_REDIRECTS: usize = 5;

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !(address.is_unspecified()
        || address.is_loopback()
        || address.is_private()
        || address.is_link_local()
        || address.is_multicast()
        || address.is_broadcast()
        || a == 0
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 240)
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(address) = address.to_ipv4() {
        return is_public_ipv4(address);
    }

    let segments = address.segments();
    !(address.is_unspecified()
        || address.is_loopback()
        || address.is_multicast()
        || segments[0] & 0xfe00 == 0xfc00
        || segments[0] & 0xffc0 == 0xfe80
        || segments[0] & 0xffc0 == 0xfec0
        || (segments[0] == 0x0100
            && segments[1] == 0
            && segments[2] == 0
            && segments[3] == 0)
        || (segments[0] == 0x2001 && segments[1] == 0x0002 && segments[2] == 0)
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

async fn validate_remote_url(url: &reqwest::Url) -> anyhow::Result<()> {
    ensure!(
        matches!(url.scheme(), "http" | "https"),
        "not an HTTP(S) URL: {url}"
    );
    let host = url.host_str().context("URL has no host")?;
    let address_literal = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(address) = address_literal.parse::<IpAddr>() {
        ensure!(
            is_public_ip(address),
            "URL resolves to non-public address {address}"
        );
        return Ok(());
    }

    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    ensure!(
        normalized != "localhost" && !normalized.ends_with(".localhost"),
        "localhost URLs are not allowed"
    );
    let port = url
        .port_or_known_default()
        .context("HTTP(S) URL has no known port")?;
    let mut addresses = tokio::net::lookup_host((host, port))
        .await
        .with_context(|| format!("resolving {host}"))?;
    let mut found = false;
    for address in &mut addresses {
        found = true;
        ensure!(
            is_public_ip(address.ip()),
            "{host} resolves to non-public address {}",
            address.ip()
        );
    }
    ensure!(found, "{host} did not resolve to any address");
    Ok(())
}

async fn send_checked(
    state: &AppState,
    url: reqwest::Url,
    conditional: Option<(&str, &str)>,
) -> anyhow::Result<reqwest::Response> {
    validate_remote_url(&url).await?;
    send_checked_after_validation(&state.http, url, conditional).await
}

async fn send_checked_after_validation(
    client: &reqwest::Client,
    mut url: reqwest::Url,
    conditional: Option<(&str, &str)>,
) -> anyhow::Result<reqwest::Response> {
    for redirect_count in 0..=MAX_REDIRECTS {
        let mut request = client.get(url.clone());
        if let Some((etag, last_modified)) = conditional {
            if !etag.is_empty() {
                request = request.header(reqwest::header::IF_NONE_MATCH, etag);
            }
            if !last_modified.is_empty() {
                request = request.header(reqwest::header::IF_MODIFIED_SINCE, last_modified);
            }
        }
        let response = request
            .send()
            .await
            .with_context(|| format!("requesting {url}"))?;
        if !matches!(
            response.status(),
            reqwest::StatusCode::MOVED_PERMANENTLY
                | reqwest::StatusCode::FOUND
                | reqwest::StatusCode::SEE_OTHER
                | reqwest::StatusCode::TEMPORARY_REDIRECT
                | reqwest::StatusCode::PERMANENT_REDIRECT
        ) {
            return Ok(response);
        }
        ensure!(
            redirect_count < MAX_REDIRECTS,
            "too many redirects (maximum {MAX_REDIRECTS})"
        );
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .context("redirect response is missing Location")?
            .to_str()
            .context("redirect Location is not valid text")?;
        let next = url
            .join(location)
            .with_context(|| format!("invalid redirect target {location:?}"))?;
        validate_remote_url(&next)
            .await
            .with_context(|| format!("unsafe redirect target {next}"))?;
        url = next;
    }
    unreachable!("redirect loop always returns or errors")
}

async fn read_limited(
    mut response: reqwest::Response,
    limit: usize,
) -> anyhow::Result<bytes::Bytes> {
    if let Some(length) = response.content_length() {
        ensure!(
            length <= limit as u64,
            "response body exceeds {limit} byte limit"
        );
    }
    let capacity = response.content_length().unwrap_or(0).min(limit as u64) as usize;
    let mut body = BytesMut::with_capacity(capacity);
    while let Some(chunk) = response.chunk().await.context("reading response body")? {
        let next_len = body
            .len()
            .checked_add(chunk.len())
            .context("response body length overflow")?;
        ensure!(
            next_len <= limit,
            "response body exceeds {limit} byte limit"
        );
        body.extend_from_slice(&chunk);
    }
    Ok(body.freeze())
}

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

    let url = match reqwest::Url::parse(&url) {
        Ok(url) => url,
        Err(error) => {
            record_error(
                state,
                feed_id,
                error_count,
                &format!("invalid feed URL: {error}"),
            )
            .await?;
            return Ok(());
        }
    };
    let conditional = if etag.is_some() || last_modified.is_some() {
        Some((
            etag.as_deref().unwrap_or_default(),
            last_modified.as_deref().unwrap_or_default(),
        ))
    } else {
        None
    };
    let resp = match send_checked(state, url, conditional).await {
        Ok(response) => response,
        Err(error) => {
            record_error(
                state,
                feed_id,
                error_count,
                &format!("request failed: {error:#}"),
            )
            .await?;
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
    let body = match read_limited(resp, state.config.max_response_bytes).await {
        Ok(body) => body,
        Err(error) => {
            record_error(
                state,
                feed_id,
                error_count,
                &format!("read failed: {error:#}"),
            )
            .await?;
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
    let content_html =
        sanitize_entry_content(raw_content, state.config.max_entry_content_bytes);
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

fn sanitize_entry_content(raw_content: Option<String>, limit: usize) -> Option<String> {
    raw_content
        .filter(|content| content.len() <= limit)
        .map(|content| ammonia::clean(&content))
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
    let input_url =
        reqwest::Url::parse(input).with_context(|| format!("invalid feed URL: {input}"))?;
    let response = send_checked(state, input_url, None)
        .await
        .context("fetching URL")?;
    if !response.status().is_success() {
        bail!("HTTP {} fetching {input}", response.status());
    }
    let base = response.url().clone();
    let body = read_limited(response, state.config.max_response_bytes)
        .await
        .context("reading response")?;

    if feed_rs::parser::parse(&body[..]).is_ok() {
        return Ok(input.to_string());
    }

    let html = String::from_utf8_lossy(&body);
    let candidate = discover_feed_href(&html)
        .and_then(|href| base.join(&href).ok())
        .context("no feed found at URL (not a feed, and no alternate link discovered)")?;

    let response = send_checked(state, candidate.clone(), None)
        .await
        .context("fetching discovered feed")?;
    if !response.status().is_success() {
        bail!(
            "HTTP {} fetching discovered feed {candidate}",
            response.status()
        );
    }
    let body = read_limited(response, state.config.max_response_bytes)
        .await
        .context("reading discovered feed")?;
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
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use axum::{
        Router,
        http::{StatusCode, header::LOCATION},
        response::IntoResponse,
        routing::get,
    };

    use super::*;

    #[test]
    fn classifies_only_public_ip_addresses_as_remote() {
        for address in [
            Ipv4Addr::LOCALHOST,
            Ipv4Addr::new(10, 0, 0, 1),
            Ipv4Addr::new(172, 16, 0, 1),
            Ipv4Addr::new(192, 168, 0, 1),
            Ipv4Addr::new(169, 254, 0, 1),
            Ipv4Addr::new(100, 64, 0, 1),
            Ipv4Addr::new(240, 0, 0, 1),
        ] {
            assert!(!is_public_ip(IpAddr::V4(address)), "{address}");
        }
        for address in [
            Ipv6Addr::LOCALHOST,
            "fc00::1".parse().unwrap(),
            "fd12:3456::1".parse().unwrap(),
            "fe80::1".parse().unwrap(),
        ] {
            assert!(!is_public_ip(IpAddr::V6(address)), "{address}");
        }
        for address in [
            "8.8.8.8".parse().unwrap(),
            "1.1.1.1".parse().unwrap(),
            "2606:4700:4700::1111".parse().unwrap(),
            "2001:4860:4860::8888".parse().unwrap(),
        ] {
            assert!(is_public_ip(address), "{address}");
        }
    }

    #[tokio::test]
    async fn rejects_non_http_and_localhost_urls() {
        let ftp = reqwest::Url::parse("ftp://example.com/feed.xml").unwrap();
        assert!(validate_remote_url(&ftp).await.is_err());

        let localhost = reqwest::Url::parse("http://news.localhost/feed.xml").unwrap();
        assert!(validate_remote_url(&localhost).await.is_err());

        let ipv6_loopback = reqwest::Url::parse("http://[::1]/feed.xml").unwrap();
        assert!(validate_remote_url(&ipv6_loopback).await.is_err());
    }

    #[tokio::test]
    async fn rejects_loopback_redirect_before_following_it() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let route_hits = hits.clone();
        let forbidden_hits = hits.clone();
        let assert_hits = hits;
        let location = format!("http://127.0.0.1:{}/forbidden", address.port());
        let app = Router::new()
            .route(
                "/",
                get(move || {
                    let route_hits = route_hits.clone();
                    let location = location.clone();
                    async move {
                        route_hits.fetch_add(1, Ordering::SeqCst);
                        (StatusCode::FOUND, [(LOCATION, location)]).into_response()
                    }
                }),
            )
            .route(
                "/forbidden",
                get(move || {
                    let forbidden_hits = forbidden_hits.clone();
                    async move {
                        forbidden_hits.fetch_add(1, Ordering::SeqCst);
                        StatusCode::OK
                    }
                }),
            );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();

        let error = send_checked_after_validation(
            &client,
            reqwest::Url::parse(&format!("http://{address}/")).unwrap(),
            None,
        )
        .await
        .unwrap_err();

        assert!(format!("{error:#}").contains("non-public"));
        assert_eq!(assert_hits.load(Ordering::SeqCst), 1);
        server.abort();
    }

    #[tokio::test]
    async fn rejects_response_body_one_byte_over_limit() {
        let limit = 16;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/",
            get(move || async move { vec![b'x'; limit + 1] }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let response = reqwest::get(format!("http://{address}/")).await.unwrap();

        let error = read_limited(response, limit).await.unwrap_err();

        assert!(error.to_string().contains("exceeds"));
        server.abort();
    }

    #[test]
    fn drops_oversized_entry_content_without_truncating_it() {
        assert_eq!(
            sanitize_entry_content(Some("<b>ok</b>".to_string()), 9).as_deref(),
            Some("<b>ok</b>")
        );
        assert_eq!(
            sanitize_entry_content(Some("<b>too long</b>".to_string()), 9),
            None
        );
    }

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
