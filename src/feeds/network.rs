use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, IF_MODIFIED_SINCE, IF_NONE_MATCH, LOCATION};
use reqwest::redirect::Policy;
use reqwest::{StatusCode, Url};
use thiserror::Error;

const MAX_REDIRECTS: usize = 10;
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConditionalRequest {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

#[derive(Debug)]
pub struct CheckedResponse {
    pub status: StatusCode,
    pub final_url: Url,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum CheckedHttpError {
    #[error("URL must use the http or https scheme: {0}")]
    UnsupportedScheme(String),
    #[error("URL has no destination host")]
    MissingHost,
    #[error("URL has no known destination port")]
    MissingPort,
    #[error("destination address {0} is non-global")]
    NonGlobalDestination(IpAddr),
    #[error("failed to resolve {host}: {source}")]
    Resolve {
        host: String,
        #[source]
        source: io::Error,
    },
    #[error("resolver returned no addresses for {0}")]
    NoAddresses(String),
    #[error("failed to build checked HTTP client: {0}")]
    ClientBuild(#[source] reqwest::Error),
    #[error("checked HTTP request failed: {0}")]
    Request(#[source] reqwest::Error),
    #[error("invalid {name} conditional header: {source}")]
    InvalidConditionalHeader {
        name: &'static str,
        #[source]
        source: reqwest::header::InvalidHeaderValue,
    },
    #[error("redirect response did not contain a valid Location header")]
    InvalidRedirectLocation,
    #[error("redirect limit was exceeded")]
    TooManyRedirects,
    #[error("checked HTTP request exceeded its absolute deadline")]
    DeadlineExceeded,
    #[error("response body exceeds the configured {limit}-byte limit")]
    ResponseLimitExceeded { limit: usize },
}

pub trait HostResolver: Send + Sync {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> Pin<Box<dyn Future<Output = io::Result<Vec<SocketAddr>>> + Send + 'a>>;
}

#[derive(Debug)]
struct SystemResolver;

impl HostResolver for SystemResolver {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> Pin<Box<dyn Future<Output = io::Result<Vec<SocketAddr>>> + Send + 'a>> {
        Box::pin(async move { Ok(tokio::net::lookup_host((host, port)).await?.collect()) })
    }
}

#[derive(Clone)]
pub struct CheckedHttpClient {
    max_response_bytes: usize,
    resolver: Arc<dyn HostResolver>,
    allow_non_global_resolver_results: bool,
    deadline: Duration,
}

impl std::fmt::Debug for CheckedHttpClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CheckedHttpClient")
            .field("max_response_bytes", &self.max_response_bytes)
            .field("deadline", &self.deadline)
            .finish_non_exhaustive()
    }
}

impl CheckedHttpClient {
    pub fn new(max_response_bytes: usize) -> Result<Self, CheckedHttpError> {
        Ok(Self {
            max_response_bytes,
            resolver: Arc::new(SystemResolver),
            allow_non_global_resolver_results: false,
            deadline: DEFAULT_DEADLINE,
        })
    }

    #[cfg(test)]
    pub fn for_test(
        max_response_bytes: usize,
        host: &str,
        address: SocketAddr,
    ) -> Result<Self, CheckedHttpError> {
        Ok(Self {
            max_response_bytes,
            resolver: Arc::new(FixedResolver {
                host: host.to_owned(),
                address,
            }),
            allow_non_global_resolver_results: true,
            deadline: DEFAULT_DEADLINE,
        })
    }

    #[cfg(test)]
    pub fn for_test_with_resolver(
        max_response_bytes: usize,
        resolver: Arc<dyn HostResolver>,
    ) -> Result<Self, CheckedHttpError> {
        Ok(Self {
            max_response_bytes,
            resolver,
            allow_non_global_resolver_results: true,
            deadline: DEFAULT_DEADLINE,
        })
    }

    #[cfg(test)]
    pub fn for_test_with_production_policy(
        max_response_bytes: usize,
        resolver: Arc<dyn HostResolver>,
    ) -> Result<Self, CheckedHttpError> {
        Ok(Self {
            max_response_bytes,
            resolver,
            allow_non_global_resolver_results: false,
            deadline: DEFAULT_DEADLINE,
        })
    }

    pub fn with_deadline(mut self, deadline: Duration) -> Self {
        self.deadline = deadline;
        self
    }

    pub async fn get(
        &self,
        url: Url,
        conditional: Option<&ConditionalRequest>,
    ) -> Result<CheckedResponse, CheckedHttpError> {
        tokio::time::timeout(self.deadline, self.get_until_deadline(url, conditional))
            .await
            .map_err(|_| CheckedHttpError::DeadlineExceeded)?
    }

    async fn get_until_deadline(
        &self,
        url: Url,
        conditional: Option<&ConditionalRequest>,
    ) -> Result<CheckedResponse, CheckedHttpError> {
        let mut current_url = url;

        for redirect_count in 0..=MAX_REDIRECTS {
            let response = self
                .request_once(
                    &current_url,
                    if redirect_count == 0 {
                        conditional
                    } else {
                        None
                    },
                )
                .await?;

            if !is_followed_redirect(response.status()) {
                return self.collect_response(response, current_url).await;
            }
            if redirect_count == MAX_REDIRECTS {
                return Err(CheckedHttpError::TooManyRedirects);
            }

            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(CheckedHttpError::InvalidRedirectLocation)?;
            current_url = current_url
                .join(location)
                .map_err(|_| CheckedHttpError::InvalidRedirectLocation)?;
        }

        Err(CheckedHttpError::TooManyRedirects)
    }

    async fn request_once(
        &self,
        url: &Url,
        conditional: Option<&ConditionalRequest>,
    ) -> Result<reqwest::Response, CheckedHttpError> {
        if !matches!(url.scheme(), "http" | "https") {
            return Err(CheckedHttpError::UnsupportedScheme(url.scheme().to_owned()));
        }

        let host = url.host_str().ok_or(CheckedHttpError::MissingHost)?;
        let address_host = host
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
            .unwrap_or(host);
        let port = url
            .port_or_known_default()
            .ok_or(CheckedHttpError::MissingPort)?;
        let mut builder = reqwest::Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .timeout(self.deadline)
            .connect_timeout(self.deadline)
            .read_timeout(self.deadline)
            .user_agent(concat!("clepsydra/", env!("CARGO_PKG_VERSION")));

        if let Ok(address) = address_host.parse::<IpAddr>() {
            if !is_global_destination(address) {
                return Err(CheckedHttpError::NonGlobalDestination(address));
            }
        } else {
            let resolved = self.resolver.resolve(host, port).await.map_err(|source| {
                CheckedHttpError::Resolve {
                    host: host.to_owned(),
                    source,
                }
            })?;
            if resolved.is_empty() {
                return Err(CheckedHttpError::NoAddresses(host.to_owned()));
            }

            let mut validated = Vec::with_capacity(resolved.len());
            for address in resolved {
                if !self.allow_non_global_resolver_results && !is_global_destination(address.ip()) {
                    return Err(CheckedHttpError::NonGlobalDestination(address.ip()));
                }
                validated.push(SocketAddr::new(address.ip(), port));
            }
            builder = builder.resolve_to_addrs(host, &validated);
        }

        let client = builder.build().map_err(CheckedHttpError::ClientBuild)?;
        let mut request = client.get(url.clone());
        if let Some(conditional) = conditional {
            if let Some(etag) = conditional.etag.as_deref() {
                let etag = HeaderValue::from_str(etag).map_err(|source| {
                    CheckedHttpError::InvalidConditionalHeader {
                        name: "ETag",
                        source,
                    }
                })?;
                request = request.header(IF_NONE_MATCH, etag);
            }
            if let Some(last_modified) = conditional.last_modified.as_deref() {
                let last_modified = HeaderValue::from_str(last_modified).map_err(|source| {
                    CheckedHttpError::InvalidConditionalHeader {
                        name: "Last-Modified",
                        source,
                    }
                })?;
                request = request.header(IF_MODIFIED_SINCE, last_modified);
            }
        }

        request.send().await.map_err(CheckedHttpError::Request)
    }

    async fn collect_response(
        &self,
        mut response: reqwest::Response,
        final_url: Url,
    ) -> Result<CheckedResponse, CheckedHttpError> {
        if response
            .content_length()
            .is_some_and(|length| length > self.max_response_bytes as u64)
        {
            return Err(CheckedHttpError::ResponseLimitExceeded {
                limit: self.max_response_bytes,
            });
        }

        let status = response.status();
        let headers = response.headers().clone();
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(CheckedHttpError::Request)? {
            let remaining = self.max_response_bytes.saturating_sub(body.len());
            if chunk.len() > remaining {
                return Err(CheckedHttpError::ResponseLimitExceeded {
                    limit: self.max_response_bytes,
                });
            }
            body.extend_from_slice(&chunk);
        }

        Ok(CheckedResponse {
            status,
            final_url,
            headers,
            body,
        })
    }
}

fn is_followed_redirect(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    )
}

pub fn is_global_destination(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_global_ipv4(address),
        IpAddr::V6(address) => is_global_ipv6(address),
    }
}

fn is_global_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, d] = address.octets();

    match (a, b, c, d) {
        (0, ..)
        | (10, ..)
        | (100, 64..=127, ..)
        | (127, ..)
        | (169, 254, ..)
        | (172, 16..=31, ..)
        | (192, 0, 2, _)
        | (192, 88, 99, _)
        | (192, 168, ..)
        | (198, 18..=19, ..)
        | (198, 51, 100, _)
        | (203, 0, 113, _)
        | (224..=255, ..) => false,
        (192, 0, 0, 9 | 10) => true,
        (192, 0, 0, _) => false,
        _ => true,
    }
}

fn is_global_ipv6(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    let octets = address.octets();

    if segments[..5] == [0, 0, 0, 0, 0] && segments[5] == u16::MAX {
        return is_global_ipv4(Ipv4Addr::new(
            octets[12], octets[13], octets[14], octets[15],
        ));
    }
    if octets[..12] == [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0] {
        return is_global_ipv4(Ipv4Addr::new(
            octets[12], octets[13], octets[14], octets[15],
        ));
    }
    if is_global_ietf_protocol_assignment(&segments) {
        return true;
    }

    if segments[..6] == [0, 0, 0, 0, 0, 0]
        || (segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2] == 1)
        || (segments[0] == 0x0100 && segments[1..4] == [0, 0, 0])
        || (segments[0] == 0x2001 && segments[1] < 0x0200)
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || segments[0] == 0x2002
        || (segments[0] == 0x3fff && segments[1] & 0xf000 == 0)
        || segments[0] == 0x5f00
        || segments[0] & 0xfe00 == 0xfc00
        || segments[0] & 0xffc0 == 0xfe80
        || segments[0] & 0xffc0 == 0xfec0
        || segments[0] & 0xff00 == 0xff00
    {
        return false;
    }

    segments[0] & 0xe000 == 0x2000
}

fn is_global_ietf_protocol_assignment(segments: &[u16; 8]) -> bool {
    if segments[0] != 0x2001 {
        return false;
    }

    (segments[1] == 1 && segments[2..7] == [0, 0, 0, 0, 0] && matches!(segments[7], 1..=3))
        || segments[1] == 3
        || (segments[1] == 4 && segments[2] == 0x0112)
        || segments[1] & 0xfff0 == 0x0020
        || segments[1] & 0xfff0 == 0x0030
}

#[cfg(test)]
#[derive(Debug)]
struct FixedResolver {
    host: String,
    address: SocketAddr,
}

#[cfg(test)]
impl HostResolver for FixedResolver {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> Pin<Box<dyn Future<Output = io::Result<Vec<SocketAddr>>> + Send + 'a>> {
        Box::pin(async move {
            if host != self.host || port != self.address.port() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "test resolver rejected an unregistered destination",
                ));
            }
            Ok(vec![self.address])
        })
    }
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::net::{IpAddr, SocketAddr};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    use axum::Router;
    use axum::body::{Body, Bytes};
    use axum::http::header::LOCATION;
    use axum::routing::get;
    use reqwest::Url;
    use tokio_stream::wrappers::ReceiverStream;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    struct CountingResolver {
        address: SocketAddr,
        calls: Arc<AtomicUsize>,
    }

    impl HostResolver for CountingResolver {
        fn resolve<'a>(
            &'a self,
            host: &'a str,
            port: u16,
        ) -> std::pin::Pin<Box<dyn Future<Output = std::io::Result<Vec<SocketAddr>>> + Send + 'a>>
        {
            assert_eq!(host, "feed.test");
            assert_eq!(port, self.address.port());
            self.calls.fetch_add(1, Ordering::SeqCst);
            let address = self.address;
            Box::pin(async move { Ok(vec![address]) })
        }
    }

    struct RoutingResolver {
        address: SocketAddr,
        delay: Duration,
        calls: Arc<AtomicUsize>,
    }

    impl HostResolver for RoutingResolver {
        fn resolve<'a>(
            &'a self,
            _host: &'a str,
            _port: u16,
        ) -> std::pin::Pin<Box<dyn Future<Output = std::io::Result<Vec<SocketAddr>>> + Send + 'a>>
        {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let address = self.address;
            let delay = self.delay;
            Box::pin(async move {
                tokio::time::sleep(delay).await;
                Ok(vec![address])
            })
        }
    }

    fn fixture_client(server: &MockServer, max_response_bytes: usize) -> CheckedHttpClient {
        CheckedHttpClient::for_test(
            max_response_bytes,
            "feed.test",
            SocketAddr::new(server.address().ip(), server.address().port()),
        )
        .expect("fixture client should build")
    }

    fn fixture_url(server: &MockServer, path: &str) -> Url {
        Url::parse(&format!(
            "http://feed.test:{}{path}",
            server.address().port()
        ))
        .unwrap()
    }

    #[test]
    fn builds_the_default_checked_client_with_a_response_limit() {
        let _client = CheckedHttpClient::new(1024).expect("checked client should build");
    }

    #[test]
    fn classifies_ipv4_reserved_ranges_as_non_global() {
        let non_global = [
            "0.0.0.0",
            "0.0.0.1",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.0.0.1",
            "192.0.2.1",
            "192.168.0.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
        ];

        for address in non_global {
            let address: IpAddr = address.parse().unwrap();
            assert!(!is_global_destination(address), "{address}");
        }

        for address in ["1.1.1.1", "8.8.8.8", "93.184.216.34"] {
            let address: IpAddr = address.parse().unwrap();
            assert!(is_global_destination(address), "{address}");
        }
    }

    #[test]
    fn classifies_ipv6_reserved_ranges_and_embedded_ipv4() {
        let non_global = [
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "64:ff9b::127.0.0.1",
            "100::1",
            "2001:db8::1",
            "2002::1",
            "3fff::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "ff02::1",
        ];

        for address in non_global {
            let address: IpAddr = address.parse().unwrap();
            assert!(!is_global_destination(address), "{address}");
        }

        let global = [
            "2001:4860:4860::8888",
            "2606:4700:4700::1111",
            "::ffff:8.8.8.8",
            "64:ff9b::8.8.8.8",
        ];
        for address in global {
            let address: IpAddr = address.parse().unwrap();
            assert!(is_global_destination(address), "{address}");
        }
    }

    #[tokio::test]
    async fn binds_validated_hostname_resolution_into_the_connector() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/bound"))
            .respond_with(ResponseTemplate::new(200).set_body_string("bound fixture"))
            .expect(1)
            .mount(&server)
            .await;
        let calls = Arc::new(AtomicUsize::new(0));
        let resolver = Arc::new(CountingResolver {
            address: SocketAddr::new(server.address().ip(), server.address().port()),
            calls: calls.clone(),
        });
        let client = CheckedHttpClient::for_test_with_resolver(1024, resolver)
            .expect("fixture client should build");

        let response = client
            .get(fixture_url(&server, "/bound"), None)
            .await
            .expect("the test-only hostname must use its validated socket binding");

        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(response.body, b"bound fixture");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "resolution must happen once, then the validated addresses must be bound into the connector"
        );
        server.verify().await;
    }

    #[tokio::test]
    async fn production_policy_rejects_injected_private_hostname_answers_before_connecting() {
        let server = MockServer::start().await;
        let calls = Arc::new(AtomicUsize::new(0));
        let resolver = Arc::new(RoutingResolver {
            address: *server.address(),
            delay: Duration::ZERO,
            calls: calls.clone(),
        });
        let client = CheckedHttpClient::for_test_with_production_policy(1024, resolver)
            .expect("fixture client should build");

        for host in ["private.test", "redirect-private.test"] {
            let url = Url::parse(&format!(
                "http://{host}:{}/must-not-connect",
                server.address().port()
            ))
            .unwrap();
            let error = client
                .get(url, None)
                .await
                .expect_err("production policy must reject injected loopback answers");
            assert!(
                matches!(
                    &error,
                    CheckedHttpError::NonGlobalDestination(address)
                        if *address == server.address().ip()
                ),
                "unexpected error for {host}: {error}"
            );
        }

        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(
            server.received_requests().await.unwrap().is_empty(),
            "a rejected resolver answer reached the fixture server"
        );
    }

    #[tokio::test]
    async fn follows_a_safe_relative_redirect() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/start"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/final"))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/final"))
            .respond_with(ResponseTemplate::new(200).set_body_string("feed"))
            .expect(1)
            .mount(&server)
            .await;
        let client = fixture_client(&server, 1024);

        let response = client
            .get(fixture_url(&server, "/start"), None)
            .await
            .expect("same-host redirect should be accepted");

        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(response.final_url.path(), "/final");
        assert_eq!(response.body, b"feed");
        server.verify().await;
    }

    #[tokio::test]
    async fn rejects_a_redirect_to_loopback_before_requesting_it() {
        let server = MockServer::start().await;
        let forbidden = format!("http://127.0.0.1:{}/forbidden", server.address().port());
        Mock::given(method("GET"))
            .and(path("/start"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", forbidden))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/forbidden"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;
        let client = fixture_client(&server, 1024);

        let error = client
            .get(fixture_url(&server, "/start"), None)
            .await
            .expect_err("redirect target must be checked independently");

        assert!(
            error.to_string().contains("non-global"),
            "unexpected error: {error}"
        );
        server.verify().await;
    }

    #[tokio::test]
    async fn enforces_the_response_limit_at_the_exact_byte_boundary() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/exact"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![b'x'; 16]))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/too-large"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![b'x'; 17]))
            .expect(1)
            .mount(&server)
            .await;
        let client = fixture_client(&server, 16);

        let exact = client
            .get(fixture_url(&server, "/exact"), None)
            .await
            .expect("a body equal to the limit should be accepted");
        assert_eq!(exact.body.len(), 16);

        let error = client
            .get(fixture_url(&server, "/too-large"), None)
            .await
            .expect_err("a body one byte over the limit must be rejected");
        assert!(
            error.to_string().contains("16") && error.to_string().contains("limit"),
            "unexpected error: {error}"
        );
        server.verify().await;
    }

    #[tokio::test]
    async fn one_deadline_covers_resolution_redirects_and_streaming_the_body() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let route_hits = Arc::new(AtomicUsize::new(0));
        let redirect_hits = route_hits.clone();
        let body_hits = route_hits.clone();
        let redirect_location = format!("http://final.test:{}/slow", address.port());
        let app = Router::new()
            .route(
                "/start",
                get(move || {
                    let redirect_location = redirect_location.clone();
                    let redirect_hits = redirect_hits.clone();
                    async move {
                        redirect_hits.fetch_add(1, Ordering::SeqCst);
                        (StatusCode::FOUND, [(LOCATION, redirect_location)])
                    }
                }),
            )
            .route(
                "/slow",
                get(move || {
                    let body_hits = body_hits.clone();
                    async move {
                        body_hits.fetch_add(1, Ordering::SeqCst);
                        let (sender, receiver) = tokio::sync::mpsc::channel(1);
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(35)).await;
                            if sender
                                .send(Ok::<_, Infallible>(Bytes::from_static(b"first")))
                                .await
                                .is_err()
                            {
                                return;
                            }
                            tokio::time::sleep(Duration::from_millis(35)).await;
                            let _ = sender
                                .send(Ok::<_, Infallible>(Bytes::from_static(b"second")))
                                .await;
                        });
                        Body::from_stream(ReceiverStream::new(receiver))
                    }
                }),
            );
        let server_task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let calls = Arc::new(AtomicUsize::new(0));
        let resolver = Arc::new(RoutingResolver {
            address,
            delay: Duration::from_millis(15),
            calls,
        });
        let client = CheckedHttpClient::for_test_with_resolver(1024, resolver)
            .expect("fixture client should build")
            .with_deadline(Duration::from_millis(80));
        let started = Instant::now();

        let error = client
            .get(
                Url::parse(&format!("http://redirect.test:{}/start", address.port())).unwrap(),
                None,
            )
            .await
            .expect_err("the absolute deadline must expire during the streamed body");

        assert!(matches!(error, CheckedHttpError::DeadlineExceeded));
        assert!(
            started.elapsed() < Duration::from_millis(180),
            "per-hop timeouts allowed the fixture to hold the request too long"
        );
        assert_eq!(route_hits.load(Ordering::SeqCst), 2);
        server_task.abort();
    }
}
