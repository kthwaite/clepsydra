//! Anonymous screenshots through a disposable, network-disabled browser container.

use std::{collections::BTreeMap, process::Stdio, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use clep_feeds::network::{CheckedHttpClient, CheckedResponse};
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE, WINDOWS_1252};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    time::{Instant, timeout, timeout_at},
};
use url::Url;

const CAPTURE_TIME: Duration = Duration::from_secs(35);
const MAX_RESOURCE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 24 * 1024 * 1024;
const MAX_REQUESTS: usize = 96;
const MAX_SCREENSHOT_BYTES: usize = 2 * 1024 * 1024;
const MAX_WORKER_LINE: usize = 3 * 1024 * 1024;
const FAILURE: &str = "External preview could not be captured";

pub struct CapturedPreview {
    pub title: Option<String>,
    pub description: Option<String>,
    pub final_url: String,
    pub screenshot: Option<Vec<u8>>,
}

#[derive(Default)]
struct Budget {
    requests: usize,
    bytes: usize,
}

fn valid_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.as_str().len() <= 8192
}

async fn checked_get(
    client: &CheckedHttpClient,
    url: Url,
    budget: &mut Budget,
    deadline: Instant,
) -> Result<CheckedResponse, String> {
    if !valid_url(&url)
        || budget.requests >= MAX_REQUESTS
        || MAX_TOTAL_BYTES.saturating_sub(budget.bytes) < MAX_RESOURCE_BYTES
    {
        return Err(FAILURE.into());
    }
    budget.requests += 1;
    // Reserve the full response allowance before I/O: even a rejected oversized
    // response or a failed stream consumes budget rather than allowing amplification.
    budget.bytes += MAX_RESOURCE_BYTES;
    let response = client
        .get_once_before(url, deadline)
        .await
        .map_err(|_| FAILURE.to_owned())?;
    budget.bytes -= MAX_RESOURCE_BYTES.saturating_sub(response.body.len());
    if budget.bytes > MAX_TOTAL_BYTES {
        return Err(FAILURE.into());
    }
    Ok(response)
}

fn redirect_target(response: &CheckedResponse) -> Result<Option<Url>, String> {
    if !matches!(response.status.as_u16(), 301 | 302 | 303 | 307 | 308) {
        return Ok(None);
    }
    let mut target = response
        .headers
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| response.final_url.join(value).ok())
        .filter(valid_url)
        .ok_or_else(|| FAILURE.to_owned())?;
    // HTTP redirects inherit the original fragment unless Location supplies one.
    if target.fragment().is_none() {
        target.set_fragment(response.final_url.fragment());
    }
    Ok(Some(target))
}

async fn document(
    client: &CheckedHttpClient,
    mut url: Url,
    budget: &mut Budget,
    deadline: Instant,
) -> Result<CheckedResponse, String> {
    for hop in 0..=10 {
        let response = checked_get(client, url, budget, deadline).await?;
        if let Some(next) = redirect_target(&response)? {
            if hop == 10 {
                return Err(FAILURE.into());
            }
            url = next;
            continue;
        }
        let content_type = response
            .headers
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim);
        if response.status.as_u16() != 200
            || !content_type.is_some_and(|value| {
                value.eq_ignore_ascii_case("text/html")
                    || value.eq_ignore_ascii_case("application/xhtml+xml")
            })
        {
            return Err(FAILURE.into());
        }
        return Ok(response);
    }
    Err(FAILURE.into())
}

fn clean_text<'a>(parts: impl Iterator<Item = &'a str>, limit: usize) -> Option<String> {
    let mut output = String::new();
    let mut count = 0;
    for word in parts.flat_map(str::split_whitespace) {
        if !output.is_empty() {
            if count == limit {
                break;
            }
            output.push(' ');
            count += 1;
        }
        for character in word.chars().filter(|character| !character.is_control()) {
            if count == limit {
                return Some(output);
            }
            output.push(character);
            count += 1;
        }
    }
    (!output.is_empty()).then_some(output)
}

fn content_type_encoding(content_type: &str) -> Option<&'static Encoding> {
    content_type.split(';').skip(1).find_map(|parameter| {
        let (name, value) = parameter.split_once('=')?;
        if !name.trim().eq_ignore_ascii_case("charset") {
            return None;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .or_else(|| {
                value
                    .strip_prefix('\'')
                    .and_then(|value| value.strip_suffix('\''))
            })
            .unwrap_or(value);
        Encoding::for_label_no_replacement(value.as_bytes())
    })
}

fn html_encoding(body: &[u8]) -> Option<&'static Encoding> {
    // HTML's encoding prescan is restricted to the first 1024 bytes. Lossy UTF-8
    // here only exposes ASCII-compatible declarations; metadata is decoded below.
    let prefix = String::from_utf8_lossy(&body[..body.len().min(1024)]);
    let html = Html::parse_document(&prefix);
    let selector = Selector::parse("meta").expect("static selector");
    html.select(&selector).find_map(|element| {
        let attributes = element.value();
        let encoding = if let Some(charset) = attributes.attr("charset") {
            Encoding::for_label_no_replacement(charset.as_bytes())
        } else if attributes
            .attr("http-equiv")
            .is_some_and(|value| value.eq_ignore_ascii_case("content-type"))
        {
            attributes.attr("content").and_then(content_type_encoding)
        } else {
            None
        }?;
        // These declarations have HTML-specific interpretation; a real UTF-16
        // document is recognized by its BOM before reaching the ASCII prescan.
        Some(if encoding == UTF_16LE || encoding == UTF_16BE {
            UTF_8
        } else if encoding.name() == "x-user-defined" {
            WINDOWS_1252
        } else {
            encoding
        })
    })
}

fn metadata(body: &[u8], content_type: Option<&str>) -> (Option<String>, Option<String>) {
    let body = &body[..body.len().min(MAX_RESOURCE_BYTES)];
    let (encoding, bom_len) = Encoding::for_bom(body).unwrap_or_else(|| {
        (
            content_type
                .and_then(content_type_encoding)
                .or_else(|| html_encoding(body))
                .unwrap_or(UTF_8),
            0,
        )
    });
    let (decoded, _) = encoding.decode_without_bom_handling(&body[bom_len..]);
    let html = Html::parse_document(&decoded);
    let title_selector = Selector::parse("title").expect("static selector");
    let meta_selector = Selector::parse("meta").expect("static selector");
    let mut title = None;
    let mut description = None;
    for element in html.select(&meta_selector) {
        let Some(name) = element
            .value()
            .attr("property")
            .or_else(|| element.value().attr("name"))
        else {
            continue;
        };
        let Some(content) = element.value().attr("content") else {
            continue;
        };
        if title.is_none() && name.eq_ignore_ascii_case("og:title") {
            title = clean_text(std::iter::once(content), 300);
        }
        if description.is_none()
            && (name.eq_ignore_ascii_case("description")
                || name.eq_ignore_ascii_case("og:description"))
        {
            description = clean_text(std::iter::once(content), 600);
        }
    }
    if title.is_none() {
        title = html
            .select(&title_selector)
            .find_map(|element| clean_text(element.text(), 300));
    }
    (title, description)
}

#[derive(Serialize)]
struct WireResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: String,
}

fn wire_response(response: &CheckedResponse) -> Result<WireResponse, String> {
    let mut headers = BTreeMap::new();
    // Retain browser origin/content security semantics, but never cookies, challenges,
    // tracking headers, server referrers, or hop-by-hop/incorrect content lengths.
    for name in [
        "content-type",
        "content-encoding",
        "content-security-policy",
        "x-content-type-options",
        "access-control-allow-origin",
        "access-control-expose-headers",
        "cross-origin-resource-policy",
        "cross-origin-opener-policy",
        "cross-origin-embedder-policy",
    ] {
        if let Some(value) = response
            .headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            && value.len() <= 8192
        {
            headers.insert(name.to_owned(), value.to_owned());
        }
    }
    if let Some(target) = redirect_target(response)? {
        headers.insert("location".to_owned(), target.into());
    }
    Ok(WireResponse {
        status: response.status.as_u16(),
        headers,
        body: STANDARD.encode(&response.body),
    })
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum WorkerMessage {
    Request {
        id: u32,
        url: String,
        method: String,
    },
    Done {
        screenshot: String,
    },
    Error,
}

async fn read_message(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<WorkerMessage, String> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf().await.map_err(|_| FAILURE.to_owned())?;
        if buffer.is_empty() {
            return Err(FAILURE.into());
        }
        let end = buffer.iter().position(|byte| *byte == b'\n');
        let count = end.map_or(buffer.len(), |index| index + 1);
        if line.len() + count > MAX_WORKER_LINE {
            return Err(FAILURE.into());
        }
        line.extend_from_slice(&buffer[..count]);
        reader.consume(count);
        if end.is_some() {
            return serde_json::from_slice(&line).map_err(|_| FAILURE.to_owned());
        }
    }
}

// A detached cleanup also covers cancellation of the owning capture future. The
// container's PID 1 watchdog is independent of both this process and Docker's CLI.
struct ContainerGuard(String, bool);

impl Drop for ContainerGuard {
    fn drop(&mut self) {
        if self.1 {
            return;
        }
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let name = self.0.clone();
            handle.spawn(async move {
                remove_container(&name).await;
            });
        }
    }
}

async fn remove_container(name: &str) {
    let _ = timeout(
        Duration::from_secs(5),
        Command::new("docker")
            .args(["rm", "--force", name])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .status(),
    )
    .await;
}

async fn screenshot(
    response: &CheckedResponse,
    image: &str,
    client: &CheckedHttpClient,
    budget: &mut Budget,
    deadline: Instant,
) -> Result<Vec<u8>, String> {
    if image.is_empty()
        || image.starts_with('-')
        || image.len() > 256
        || image.chars().any(char::is_whitespace)
    {
        return Err(FAILURE.into());
    }
    let mut guard = ContainerGuard(format!("clepsydra-preview-{}", uuid::Uuid::now_v7()), false);
    let mut child = Command::new("docker")
        .args([
            "run",
            "--rm",
            "--interactive",
            "--pull=never",
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--cpus=1",
            "--memory=768m",
            "--memory-swap=768m",
            "--pids-limit=128",
            "--shm-size=64m",
            "--tmpfs=/tmp:rw,nosuid,nodev,size=256m,mode=1777",
            "--user=pwuser",
            "--log-driver=none",
            "--name",
            &guard.0,
            image,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| FAILURE.to_owned())?;
    let result = timeout_at(deadline, async {
        let mut input = child.stdin.take().ok_or_else(|| FAILURE.to_owned())?;
        let mut output = BufReader::new(child.stdout.take().ok_or_else(|| FAILURE.to_owned())?);
        let start = serde_json::json!({
            "type": "start",
            "url": response.final_url.as_str(),
            "document": wire_response(response)?,
        });
        let mut encoded = serde_json::to_vec(&start).map_err(|_| FAILURE.to_owned())?;
        encoded.push(b'\n');
        input
            .write_all(&encoded)
            .await
            .map_err(|_| FAILURE.to_owned())?;
        let mut last_id = 0;
        loop {
            match read_message(&mut output).await? {
                WorkerMessage::Request { id, url, method } => {
                    if id <= last_id || id as usize > MAX_REQUESTS || method != "GET" {
                        return Err(FAILURE.to_owned());
                    }
                    last_id = id;
                    let resource = if let Ok(url) = Url::parse(&url) {
                        checked_get(client, url, budget, deadline)
                            .await
                            .and_then(|response| wire_response(&response))
                    } else {
                        Err(FAILURE.to_owned())
                    };
                    let reply = match resource {
                        Ok(response) => serde_json::json!({
                            "type": "response", "id": id, "status": response.status,
                            "headers": response.headers, "body": response.body,
                        }),
                        Err(_) => {
                            serde_json::json!({ "type": "response", "id": id, "error": true })
                        }
                    };
                    let mut encoded = serde_json::to_vec(&reply).map_err(|_| FAILURE.to_owned())?;
                    encoded.push(b'\n');
                    input
                        .write_all(&encoded)
                        .await
                        .map_err(|_| FAILURE.to_owned())?;
                }
                WorkerMessage::Done { screenshot } => {
                    let bytes = STANDARD
                        .decode(screenshot)
                        .map_err(|_| FAILURE.to_owned())?;
                    if bytes.len() > MAX_SCREENSHOT_BYTES || !bytes.starts_with(&[0xff, 0xd8, 0xff])
                    {
                        return Err(FAILURE.to_owned());
                    }
                    return Ok(bytes);
                }
                WorkerMessage::Error => return Err(FAILURE.to_owned()),
            }
        }
    })
    .await
    .unwrap_or_else(|_| Err(FAILURE.to_owned()));
    // Stop the container, not merely the attached Docker CLI.
    remove_container(&guard.0).await;
    guard.1 = true;
    let _ = child.kill().await;
    result
}

pub async fn capture(url: &Url, image: &str) -> Result<CapturedPreview, String> {
    let client = CheckedHttpClient::new(MAX_RESOURCE_BYTES).map_err(|_| FAILURE.to_owned())?;
    capture_with_client(url, image, &client).await
}

async fn capture_with_client(
    url: &Url,
    image: &str,
    client: &CheckedHttpClient,
) -> Result<CapturedPreview, String> {
    let deadline = Instant::now() + CAPTURE_TIME;
    let mut budget = Budget::default();
    let response = document(client, url.clone(), &mut budget, deadline).await?;
    let (response, title, description) = timeout_at(
        deadline,
        tokio::task::spawn_blocking(move || {
            let content_type = response
                .headers
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok());
            let (title, description) = metadata(&response.body, content_type);
            (response, title, description)
        }),
    )
    .await
    .map_err(|_| FAILURE.to_owned())?
    .map_err(|_| FAILURE.to_owned())?;
    let screenshot = screenshot(&response, image, client, &mut budget, deadline)
        .await
        .ok();
    Ok(CapturedPreview {
        title,
        description,
        final_url: response.final_url.into(),
        screenshot,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{method, path},
    };

    async fn fixture() -> (MockServer, CheckedHttpClient, Url) {
        let server = MockServer::start().await;
        let client =
            CheckedHttpClient::for_test(MAX_RESOURCE_BYTES, "preview.test", *server.address())
                .unwrap();
        let url = Url::parse(&format!(
            "http://preview.test:{}/start",
            server.address().port()
        ))
        .unwrap();
        (server, client, url)
    }

    #[tokio::test]
    async fn missing_worker_preserves_parsed_metadata_and_final_url() {
        let (server, client, url) = fixture().await;
        Mock::given(method("GET"))
            .and(path("/start"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/final/index.html"))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/final/index.html"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(
                "<TITLE>Fallback</TITLE><META content='Alice &amp; Bob' property='og:title'><meta CONTENT='A &quot;quoted&quot; description' NAME='description'>",
                "text/html; charset=utf-8",
            ))
            .expect(1)
            .mount(&server)
            .await;
        // An invalid image fails before touching Docker, exercising the same
        // metadata-only consumer result as an absent image/daemon.
        let result = capture_with_client(&url, "-", &client).await.unwrap();
        assert_eq!(result.title.as_deref(), Some("Alice & Bob"));
        assert_eq!(
            result.description.as_deref(),
            Some("A \"quoted\" description")
        );
        assert_eq!(
            result.final_url,
            url.join("/final/index.html").unwrap().as_str()
        );
        assert!(result.screenshot.is_none());
    }

    #[tokio::test]
    async fn metadata_fallback_respects_declared_encoding_and_bom_precedence() {
        let utf16_html = "<meta charset=windows-1252><title>Café</title>";
        let utf16_le = [0xff, 0xfe]
            .into_iter()
            .chain(utf16_html.encode_utf16().flat_map(u16::to_le_bytes))
            .collect::<Vec<_>>();
        let utf16_be = [0xfe, 0xff]
            .into_iter()
            .chain(utf16_html.encode_utf16().flat_map(u16::to_be_bytes))
            .collect::<Vec<_>>();
        for (body, content_type) in [
            (
                b"<meta charset=utf-8><title>Caf\xe9</title>".to_vec(),
                "text/html; Charset=\"Windows-1252\"",
            ),
            (
                b"<meta charset=windows-1252><title>Caf\xe9</title>".to_vec(),
                "text/html",
            ),
            (
                b"<meta content='text/html; charset=windows-1252' http-equiv=Content-Type><title>Caf\xe9</title>".to_vec(),
                "text/html",
            ),
            (
                b"<meta charset=windows-1252><title>Caf\xe9</title>".to_vec(),
                "text/html; charset=unknown",
            ),
            (
                "\u{feff}<meta charset=windows-1252><title>Café</title>".as_bytes().to_vec(),
                "text/html; charset=windows-1252",
            ),
            (utf16_le, "text/html; charset=windows-1252"),
            (utf16_be, "text/html; charset=windows-1252"),
            ("<title>Café</title>".as_bytes().to_vec(), "text/html"),
            (
                "<meta charset=unknown><title>Café</title>".as_bytes().to_vec(),
                "text/html; charset=unknown",
            ),
        ] {
            let (server, client, url) = fixture().await;
            Mock::given(path("/start"))
                .respond_with(ResponseTemplate::new(200).set_body_raw(body, content_type))
                .expect(1)
                .mount(&server)
                .await;
            let result = capture_with_client(&url, "-", &client).await.unwrap();
            assert_eq!(result.title.as_deref(), Some("Café"), "{content_type}");
            assert!(result.screenshot.is_none());
        }
    }

    #[tokio::test]
    async fn redirects_preserve_or_explicitly_replace_the_original_fragment() {
        for (location, fragment) in [
            ("/final?q=kept", "section"),
            ("/final?q=kept#other", "other"),
            ("/final?q=kept#", ""),
        ] {
            let (server, client, mut url) = fixture().await;
            url.set_fragment(Some("section"));
            Mock::given(path("/start"))
                .respond_with(ResponseTemplate::new(302).insert_header("location", location))
                .mount(&server)
                .await;
            Mock::given(path("/final"))
                .respond_with(
                    ResponseTemplate::new(200).set_body_raw("<title>Final</title>", "text/html"),
                )
                .mount(&server)
                .await;
            let result = capture_with_client(&url, "-", &client).await.unwrap();
            let final_url = Url::parse(&result.final_url).unwrap();
            assert_eq!(final_url.fragment(), Some(fragment));
            assert_eq!(final_url.query(), Some("q=kept"));
        }
    }

    #[tokio::test]
    async fn private_destinations_and_credentials_fail_without_exposing_urls() {
        for value in [
            "http://127.0.0.1/private?secret=value",
            "http://[::1]/private",
            "http://169.254.169.254/latest/meta-data",
            "http://user:password@example.com/",
            "file:///etc/passwd",
        ] {
            let result = capture(&Url::parse(value).unwrap(), "-").await;
            assert!(matches!(result, Err(error) if error == FAILURE));
        }
    }

    #[tokio::test]
    async fn redirects_to_private_networks_or_credentials_are_rejected() {
        for location in [
            "http://127.0.0.1/secret",
            "http://user:password@preview.test/secret",
        ] {
            let (server, client, url) = fixture().await;
            Mock::given(path("/start"))
                .respond_with(ResponseTemplate::new(302).insert_header("location", location))
                .expect(1)
                .mount(&server)
                .await;
            let result = capture_with_client(&url, "-", &client).await;
            assert!(matches!(result, Err(error) if error == FAILURE));
            assert_eq!(server.received_requests().await.unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn resource_redirects_remain_redirects_and_strip_credentials() {
        let (server, client, url) = fixture().await;
        Mock::given(path("/start"))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", "/assets/theme.css")
                    .insert_header("set-cookie", "secret=yes")
                    .insert_header("www-authenticate", "Basic realm=private")
                    .insert_header("access-control-allow-origin", "https://allowed.example")
                    .set_body_string("redirect"),
            )
            .expect(1)
            .mount(&server)
            .await;
        let mut budget = Budget::default();
        let response = checked_get(
            &client,
            url.clone(),
            &mut budget,
            Instant::now() + CAPTURE_TIME,
        )
        .await
        .unwrap();
        let wire = wire_response(&response).unwrap();
        assert_eq!(wire.status, 302);
        assert_eq!(
            wire.headers["location"],
            url.join("/assets/theme.css").unwrap().as_str()
        );
        assert_eq!(
            wire.headers["access-control-allow-origin"],
            "https://allowed.example"
        );
        assert!(!wire.headers.contains_key("set-cookie"));
        assert!(!wire.headers.contains_key("www-authenticate"));
        assert_eq!(STANDARD.decode(wire.body).unwrap(), b"redirect");
        assert_eq!(budget.bytes, b"redirect".len());
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn exhausted_request_and_byte_budgets_never_fetch() {
        let (server, client, url) = fixture().await;
        for mut budget in [
            Budget {
                requests: MAX_REQUESTS,
                bytes: 0,
            },
            Budget {
                requests: 0,
                bytes: MAX_TOTAL_BYTES,
            },
        ] {
            assert!(
                checked_get(
                    &client,
                    url.clone(),
                    &mut budget,
                    Instant::now() + CAPTURE_TIME
                )
                .await
                .is_err()
            );
        }
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn failed_responses_still_consume_transfer_budget() {
        let (server, _, url) = fixture().await;
        let client = CheckedHttpClient::for_test(8, "preview.test", *server.address()).unwrap();
        Mock::given(path("/start"))
            .respond_with(ResponseTemplate::new(200).set_body_string("more than eight bytes"))
            .mount(&server)
            .await;
        let mut budget = Budget::default();
        assert!(
            checked_get(&client, url, &mut budget, Instant::now() + CAPTURE_TIME)
                .await
                .is_err()
        );
        assert_eq!(budget.bytes, MAX_RESOURCE_BYTES);
    }

    #[tokio::test]
    async fn oversized_or_incomplete_worker_messages_fail_closed() {
        let oversized = vec![b'x'; MAX_WORKER_LINE + 1];
        assert!(read_message(&mut oversized.as_slice()).await.is_err());
        assert!(
            read_message(&mut &b"{\"type\":\"error\"}"[..])
                .await
                .is_err()
        );
        assert!(matches!(
            read_message(&mut &b"{\"type\":\"error\"}\n"[..])
                .await
                .unwrap(),
            WorkerMessage::Error
        ));
    }

    #[tokio::test]
    #[ignore = "requires the locally built clepsydra-preview:1 Docker image"]
    async fn actual_worker_renders_checked_html_and_relative_resources() {
        let (server, client, url) = fixture().await;
        Mock::given(path("/start"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/final/index.html"))
            .mount(&server)
            .await;
        Mock::given(path("/final/index.html"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(
                "<title>Worker smoke</title><link rel=stylesheet href=theme.css><h1>Real screenshot</h1>",
                "text/html",
            ))
            .mount(&server)
            .await;
        Mock::given(path("/final/theme.css"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(
                "body { background: rgb(12, 34, 56); color: white; }",
                "text/css",
            ))
            .expect(1)
            .mount(&server)
            .await;
        let image_name = std::env::var("CLEPSYDRA_PREVIEW_TEST_IMAGE")
            .unwrap_or_else(|_| "clepsydra-preview:1".to_owned());
        let result = capture_with_client(&url, &image_name, &client).await.unwrap();
        assert_eq!(result.title.as_deref(), Some("Worker smoke"));
        let bytes = result
            .screenshot
            .expect("network-disabled worker must return a real screenshot");
        let image = image::load_from_memory(&bytes).unwrap().to_rgb8();
        assert_eq!((image.width(), image.height()), (1200, 800));
        let pixel = image.get_pixel(1190, 790);
        for (actual, expected) in pixel.0.into_iter().zip([12_u8, 34, 56]) {
            assert!(
                actual.abs_diff(expected) <= 5,
                "relative stylesheet must be rendered"
            );
        }
    }

    #[test]
    fn malformed_html_metadata_is_bounded_plain_text() {
        let body = format!(
            "<title>{}</title><meta name=description content='&lt;script&gt;no execution&lt;/script&gt;'>",
            "🦀".repeat(1000)
        );
        let (title, description) = metadata(body.as_bytes(), None);
        assert_eq!(title.unwrap().chars().count(), 300);
        assert_eq!(
            description.as_deref(),
            Some("<script>no execution</script>")
        );
    }

    #[test]
    fn metadata_encoding_prescan_and_document_input_are_bounded() {
        let beyond_prescan = format!(
            "{}<meta charset=windows-1252><title>Café</title>",
            " ".repeat(1024),
        );
        assert_eq!(
            metadata(beyond_prescan.as_bytes(), None).0.as_deref(),
            Some("Café")
        );

        let missing_pragma = "<meta content='text/html; charset=windows-1252'><title>Café</title>";
        assert_eq!(
            metadata(missing_pragma.as_bytes(), None).0.as_deref(),
            Some("Café")
        );

        let beyond_document_limit = format!(
            "{}<title>Outside limit</title>",
            " ".repeat(MAX_RESOURCE_BYTES)
        );
        assert_eq!(
            metadata(beyond_document_limit.as_bytes(), None),
            (None, None)
        );
    }
}
