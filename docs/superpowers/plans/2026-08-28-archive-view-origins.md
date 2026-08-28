# Archive Viewer Origins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archived snapshots render their CAS images and fonts when Clepsydra is reached through a reverse proxy or tunnel name, and archived fonts load at all.

**Architecture:** `ArchiveViewConfig` grows from one precomputed CSP string to a small allowlist: the bind origin plus `server.public_origins`. Each entry has its own precomputed `Content-Security-Policy` `HeaderValue`. The request's `Host` header only *selects* an entry (origin comparison after parsing); unknown, absent, or malformed hosts fall back to the bind origin. Request bytes never reach a response header. Separately, `GET /api/vault/cas/{hash}` gains `Access-Control-Allow-Origin: *` because `@font-face` fetches are CORS-mode and the sandboxed frame's origin is `null`.

**Tech Stack:** Rust 2024, Axum 0.8, `url` crate (`Url`, `Host`, `Origin`), `config` crate for settings, `axum-test` integration tests, MDX docs under `ui/src/docs/content/`.

**Spec:** No standalone spec. Diagnosis and the design decision live in this conversation and in memory `project_fidelity_capture.md` ("Manual browser verification started 2026-08-28"). The decision: **hybrid** — config allowlist + reflect-only-if-listed — plus the CAS CORS header.

## Global Constraints

- Branch `feature/archive-view-origins` off `develop`, worktree `.worktrees/archive-view-origins`. Merge to `develop` when done.
- `cargo test` needs `ui/dist` in the worktree (rust-embed). Copy it from the main checkout: `cp -R /Users/kit/Source/_p.pkm/clepsydra/ui/dist ui/dist`.
- Never pipe cargo output through `| tail` / `| grep -c`; the pipeline exit code hides compile failures. Redirect to a file and inspect it.
- Never run `clep` without `CLEPSYDRA__VAULT__ROOT` pointing at a scratch dir — the ambient `~/.config/clepsydra/config.toml` hits the LIVE vault.
- `cargo fmt` is CI-gated: run `cargo fmt` before every commit.
- No `X-Forwarded-*` trust. Scheme and port come from the configured entry, never from the request.
- Out of scope (do not add): path-scoping CSP sources to `/api/vault/cas/`, API-wide `Host` validation, `report-uri`, env-var form of `public_origins`, OpenAPI regeneration (no DTO changes).
- Style: rustfmt + clippy clean; comments in Simple Technical English.

---

### Task 1: `server.public_origins` and the origin allowlist in `ArchiveViewConfig`

**Files:**
- Modify: `src/lib.rs:131-154` (`ServerSettings` struct + `Default`)
- Modify: `src/lib.rs:2006` (a `ServerSettings { .. }` literal in tests — add the new field)
- Modify: `src/mcp/mod.rs:121` (a `ServerSettings { .. }` literal in tests — add the new field)
- Modify: `src/api/archive.rs:286-330` (`ArchiveViewConfig`)
- Modify: `src/api/archive.rs:421-432` (`sandbox_headers` reads the policy through the new accessor)
- Modify: `src/api/archive.rs:1505-1545` (existing unit test + new unit tests)
- Modify: `tests/archive_test.rs:48-57` and `tests/archive_test.rs:1426` (`ServerSettings` literals — add the new field)

**Interfaces:**
- Consumes: `ServerSettings::server_host_for_origin()` (`src/lib.rs:158`), `url::{Host, Url}` (already imported in `archive.rs`).
- Produces:
  - `ServerSettings.public_origins: Vec<String>` (serde default empty).
  - `ArchiveViewConfig::from_server_settings(&ServerSettings) -> Result<Self, String>` (unchanged signature; now validates `public_origins`).
  - `ArchiveViewConfig::policy_for_host(&self, host: Option<&str>) -> &HeaderValue`.
  - `ArchiveViewConfig::allowed_origins(&self) -> impl Iterator<Item = &str>` (bind origin first).

- [ ] **Step 1: Add the settings field**

In `src/lib.rs`, inside `pub struct ServerSettings` after the `tls` field:

```rust
    /// Extra browser origins that reach this server through a reverse proxy or
    /// tunnel, such as `https://clepsydra.localhost`. The archive snapshot viewer
    /// emits a Content-Security-Policy for exactly one origin — the bind origin or
    /// one of these — selected by the request's `Host` header. Entries must be bare
    /// `scheme://host[:port]` origins: no wildcards, paths, queries, or credentials.
    /// (Default: empty.)
    #[serde(default)]
    pub public_origins: Vec<String>,
```

In `impl Default for ServerSettings`, add `public_origins: Vec::new(),`.

Add `public_origins: Vec::new(),` to every `ServerSettings { .. }` literal: `src/lib.rs:2006`, `src/mcp/mod.rs:121`, `src/api/archive.rs:1512` (the `explicit` closure), `tests/archive_test.rs:48`, `tests/archive_test.rs:1426`. Find them with `grep -rn 'ServerSettings {' src tests`.

- [ ] **Step 2: Write the failing unit tests**

Replace the existing test `configured_hosts_and_ports_are_formatted_as_concrete_csp_origins` body's inner loop so it reads the policy through the accessor, and add three new tests. In `src/api/archive.rs` `mod tests`:

```rust
    fn settings_with_public_origins(origins: &[&str]) -> ServerSettings {
        ServerSettings {
            host: "vault.example".to_string(),
            port: 7443,
            dev_mode: false,
            tls: crate::TlsSettings {
                enabled: true,
                cert_path: None,
                key_path: None,
            },
            public_origins: origins.iter().map(|origin| origin.to_string()).collect(),
        }
    }

    fn policy_origin_count(policy: &HeaderValue, origin: &str) -> usize {
        policy.to_str().unwrap().matches(origin).count()
    }

    #[test]
    fn configured_hosts_and_ports_are_formatted_as_concrete_csp_origins() {
        let explicit = |host: &str, port: u16, tls_enabled: bool| ServerSettings {
            host: host.to_string(),
            port,
            dev_mode: false,
            tls: crate::TlsSettings {
                enabled: tls_enabled,
                cert_path: None,
                key_path: None,
            },
            public_origins: Vec::new(),
        };
        let cases = [
            (ServerSettings::default(), "http://localhost:16667"),
            (
                explicit("vault.example", 7443, true),
                "https://vault.example:7443",
            ),
            (explicit("127.0.0.1", 3000, false), "http://127.0.0.1:3000"),
            (explicit("[::1]", 7443, true), "https://[::1]:7443"),
            (explicit("::1", 8080, false), "http://[::1]:8080"),
        ];

        for (settings, expected_origin) in cases {
            let config = ArchiveViewConfig::from_server_settings(&settings).unwrap();
            let policy = config.policy_for_host(None);

            assert_eq!(
                policy_origin_count(policy, expected_origin),
                4,
                "CSP did not use {expected_origin:?} in every resource directive: {policy:?}"
            );
        }
    }

    #[test]
    fn host_header_selects_a_listed_origin_and_never_reaches_the_policy() {
        let config = ArchiveViewConfig::from_server_settings(&settings_with_public_origins(&[
            "https://clepsydra.localhost",
            "http://tunnel.example:8080",
        ]))
        .unwrap();
        let bind = "https://vault.example:7443";

        let listed = config.policy_for_host(Some("clepsydra.localhost"));
        assert_eq!(policy_origin_count(listed, "https://clepsydra.localhost"), 4);
        assert_eq!(policy_origin_count(listed, "vault.example"), 0);
        assert_eq!(
            policy_origin_count(listed, "tunnel.example"),
            0,
            "other listed origins must not widen the policy"
        );

        // An explicit default port names the same origin.
        assert_eq!(
            config.policy_for_host(Some("clepsydra.localhost:443")),
            listed
        );
        // Case-insensitive host.
        assert_eq!(config.policy_for_host(Some("Clepsydra.LOCALHOST")), listed);
        // A listed non-default port must match exactly.
        assert_eq!(
            policy_origin_count(
                config.policy_for_host(Some("tunnel.example:8080")),
                "http://tunnel.example:8080"
            ),
            4
        );
        assert_eq!(
            policy_origin_count(config.policy_for_host(Some("tunnel.example")), bind),
            4,
            "port mismatch is a different origin"
        );

        // The bind origin itself.
        assert_eq!(
            policy_origin_count(config.policy_for_host(Some("vault.example:7443")), bind),
            4
        );

        // Unknown, absent, or malformed hosts fall back to the bind origin.
        for host in [
            None,
            Some(""),
            Some("attacker.example"),
            Some("clepsydra.localhost/evil"),
            Some("clepsydra.localhost?x"),
            Some("user@clepsydra.localhost"),
            Some("clepsydra.localhost; img-src https://evil.example"),
            Some("clepsydra.localhost\u{0}"),
        ] {
            let policy = config.policy_for_host(host);
            assert_eq!(policy_origin_count(policy, bind), 4, "host {host:?}: {policy:?}");
            assert!(
                !policy.to_str().unwrap().contains("evil"),
                "request bytes reached the policy for {host:?}: {policy:?}"
            );
        }
    }

    #[test]
    fn public_origins_are_validated_and_normalised() {
        let config = ArchiveViewConfig::from_server_settings(&settings_with_public_origins(&[
            "HTTPS://Clepsydra.LOCALHOST:443/",
        ]))
        .unwrap();
        assert_eq!(
            config.allowed_origins().collect::<Vec<_>>(),
            vec!["https://vault.example:7443", "https://clepsydra.localhost"]
        );

        let rejected = [
            ("clepsydra.localhost", "absolute"),
            ("ftp://clepsydra.localhost", "http or https"),
            ("https://*.ts.net", "wildcard"),
            ("https://0.0.0.0", "unspecified"),
            ("https://[::]", "unspecified"),
            ("https://user@clepsydra.localhost", "credentials"),
            ("https://clepsydra.localhost/api", "bare origin"),
            ("https://clepsydra.localhost?x=1", "bare origin"),
            ("https://clepsydra.localhost#top", "bare origin"),
        ];
        for (raw, expected_reason) in rejected {
            let error = ArchiveViewConfig::from_server_settings(&settings_with_public_origins(&[raw]))
                .expect_err(raw);
            assert!(
                error.contains("server.public_origins[0]") && error.contains(expected_reason),
                "{raw}: {error}"
            );
        }
    }

    #[test]
    fn duplicate_public_origins_collapse_into_one_entry() {
        let settings = ServerSettings {
            public_origins: vec![
                "http://localhost:16667".to_string(),
                "https://a.example".to_string(),
                "https://a.example:443".to_string(),
            ],
            ..ServerSettings::default()
        };
        let config = ArchiveViewConfig::from_server_settings(&settings).unwrap();
        assert_eq!(
            config.allowed_origins().collect::<Vec<_>>(),
            vec!["http://localhost:16667", "https://a.example"]
        );
    }
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --lib api::archive::tests > /tmp/t1.txt 2>&1; grep -E '^(error|test result)' /tmp/t1.txt`
Expected: compile errors — `policy_for_host`, `allowed_origins`, and `public_origins` do not exist.

- [ ] **Step 4: Implement the allowlist**

In `src/api/archive.rs`, replace the whole `ArchiveViewConfig` struct and its `impl` (lines 286-330; keep the `impl Default`) with:

```rust
/// Immutable response policy for the dedicated archive snapshot view.
///
/// Every policy string is assembled once from server configuration. The
/// request's `Host` header only *selects* one of them; its bytes never reach a
/// response header.
#[derive(Clone, Debug)]
pub struct ArchiveViewConfig {
    /// The bind origin. Also the fallback for absent, unknown, or malformed hosts.
    bind: AllowedOrigin,
    /// `server.public_origins`, validated, normalised, deduplicated, in order.
    public: Vec<AllowedOrigin>,
}

#[derive(Clone, Debug)]
struct AllowedOrigin {
    /// The origin exactly as the CSP names it, e.g. `https://clepsydra.localhost`.
    source: String,
    /// Parsed form used to compare against a request `Host`.
    url: Url,
    content_security_policy: HeaderValue,
}

impl AllowedOrigin {
    fn new(source: String) -> Result<Self, String> {
        let url = Url::parse(&source).map_err(|error| format!("{source}: {error}"))?;
        let policy = format!(
            "sandbox; default-src 'none'; img-src {source} data:; \
             media-src {source} data:; style-src 'unsafe-inline' {source} data:; \
             font-src {source} data:"
        );
        let content_security_policy = HeaderValue::from_str(&policy)
            .map_err(|error| format!("invalid archive view CSP for {source}: {error}"))?;
        Ok(Self {
            source,
            url,
            content_security_policy,
        })
    }

    /// Does a raw `Host` header value (`host[:port]`) name this origin?
    ///
    /// The scheme comes from this entry, so a listed `https://` name never
    /// matches an `http://` request policy and vice versa. Anything that is not
    /// a plain host-and-port is rejected before parsing.
    fn matches_host(&self, host: &str) -> bool {
        let plain_host_bytes = host.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':' | b'[' | b']')
        });
        if host.is_empty() || !plain_host_bytes {
            return false;
        }
        Url::parse(&format!("{}://{host}", self.url.scheme()))
            .map(|candidate| candidate.origin() == self.url.origin())
            .unwrap_or(false)
    }
}

/// Validate one `server.public_origins` entry and normalise it to its ASCII
/// origin serialisation (lowercase host, default port dropped).
fn validate_public_origin(raw: &str) -> Result<String, &'static str> {
    // Checked before parsing: the URL parser may reject `*` with a generic error.
    if raw.contains('*') {
        return Err("must not contain a wildcard");
    }
    let url = Url::parse(raw.trim()).map_err(|_| "must be an absolute http(s) origin")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("must use the http or https scheme");
    }
    match url.host().ok_or("must name a host")? {
        Host::Ipv4(address) if address.is_unspecified() => {
            return Err("must name a concrete host, not an unspecified address");
        }
        Host::Ipv6(address) if address.is_unspecified() => {
            return Err("must name a concrete host, not an unspecified address");
        }
        _ => {}
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("must not carry credentials");
    }
    if !matches!(url.path(), "" | "/") || url.query().is_some() || url.fragment().is_some() {
        return Err("must be a bare origin without path, query, or fragment");
    }
    Ok(url.origin().ascii_serialization())
}

impl ArchiveViewConfig {
    pub fn from_server_settings(settings: &ServerSettings) -> Result<Self, String> {
        let raw_host = settings.server_host_for_origin()?;
        let host = match raw_host {
            Host::Domain(host) => host,
            Host::Ipv4(host) => host.to_string(),
            Host::Ipv6(host) => format!("[{host}]"),
        };
        let scheme = if settings.tls.enabled {
            "https"
        } else {
            "http"
        };
        let bind = AllowedOrigin::new(format!("{scheme}://{host}:{}", settings.port))
            .map_err(|error| format!("invalid archive view origin from server configuration: {error}"))?;

        let mut public: Vec<AllowedOrigin> = Vec::with_capacity(settings.public_origins.len());
        for (index, raw) in settings.public_origins.iter().enumerate() {
            let source = validate_public_origin(raw)
                .map_err(|reason| format!("server.public_origins[{index}] {reason}: {raw:?}"))?;
            let origin = AllowedOrigin::new(source)?;
            let already_listed = origin.url.origin() == bind.url.origin()
                || public.iter().any(|listed| listed.url.origin() == origin.url.origin());
            if !already_listed {
                public.push(origin);
            }
        }
        Ok(Self { bind, public })
    }

    /// The policy for the origin the browser addressed, or the bind-origin
    /// policy when `host` is absent, malformed, or not configured.
    pub fn policy_for_host(&self, host: Option<&str>) -> &HeaderValue {
        let Some(host) = host else {
            return &self.bind.content_security_policy;
        };
        std::iter::once(&self.bind)
            .chain(self.public.iter())
            .find(|origin| origin.matches_host(host))
            .map_or(&self.bind.content_security_policy, |origin| {
                &origin.content_security_policy
            })
    }

    /// Every origin the viewer may name, bind origin first. For startup logs.
    pub fn allowed_origins(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.bind.source.as_str())
            .chain(self.public.iter().map(|origin| origin.source.as_str()))
    }
}
```

Then update `sandbox_headers` (`src/api/archive.rs:421`) so it compiles against the new shape — this task keeps the fallback behaviour; Task 2 threads the host through:

```rust
fn sandbox_headers(config: &ArchiveViewConfig, host: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        config.policy_for_host(host).clone(),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers
}
```

and change its one caller in `snapshot_response_with` (`src/api/archive.rs:509`) to `sandbox_headers(config, None)` for now.

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `cargo test --lib api::archive::tests > /tmp/t1.txt 2>&1; grep -E '^(error|warning: unused|test result)' /tmp/t1.txt`
Expected: `test result: ok.` and no `error` lines. If `Url::parse("https://*.ts.net")` errors before the wildcard check, the test still passes because the reason string `absolute` is not asserted for that case — only `wildcard` is; if that assertion fails, move the `contains('*')` check to run on `raw` before `Url::parse`:

```rust
    if raw.contains('*') {
        return Err("must not contain a wildcard");
    }
```

- [ ] **Step 6: Whole-crate check, fmt, commit**

Run: `cargo fmt && cargo clippy --all-targets > /tmp/c1.txt 2>&1; grep -E '^(error|warning)' /tmp/c1.txt; cargo test > /tmp/t1b.txt 2>&1; grep -E '^(error|test result)' /tmp/t1b.txt`
Expected: no clippy warnings; every `test result:` line is `ok`.

```bash
git add src/lib.rs src/mcp/mod.rs src/api/archive.rs tests/archive_test.rs
git commit -m "feat(archive): server.public_origins allowlist for the snapshot view CSP"
```

---

### Task 2: Select the policy by request `Host` in the view handlers

**Files:**
- Modify: `src/api/archive.rs:486-520` (`snapshot_response_with` gains a `host` parameter)
- Modify: `src/api/archive.rs:977-999` (`view_snapshot`)
- Modify: `src/api/archive.rs:1041-1068` (`head_snapshot`)
- Modify: `src/lib.rs:1053-1056` (`run_server` logs the effective origins)
- Modify: `tests/archive_test.rs:46-67` (`setup_archive_view_server` lists two public origins)
- Test: `tests/archive_test.rs` (new integration test next to `archive_view_serves_html_with_configuration_bound_sandbox`)

**Interfaces:**
- Consumes: `ArchiveViewConfig::policy_for_host(Option<&str>)`, `ArchiveViewConfig::allowed_origins()` from Task 1; `store_blob(&state, bytes, content_type) -> String` (existing helper in `tests/archive_test.rs`).
- Produces: `fn request_host(headers: &HeaderMap, uri: &Uri) -> Option<String>` (private, `src/api/archive.rs`).

- [ ] **Step 1: List public origins in the test harness**

In `tests/archive_test.rs` `setup_archive_view_server`, add to the `ServerSettings` literal:

```rust
        public_origins: vec![
            "https://clepsydra.example".to_string(),
            "http://tunnel.example:8080".to_string(),
        ],
```

The existing test `archive_view_serves_html_with_configuration_bound_sandbox` sends `host: attacker.example` and asserts the `https://vault.example:7443` policy. It must keep passing unchanged: an unlisted host falls back to the bind origin.

- [ ] **Step 2: Write the failing integration test**

Add after `archive_view_serves_html_with_configuration_bound_sandbox`:

```rust
#[tokio::test]
async fn archive_view_names_the_listed_origin_the_browser_addressed() {
    let (server, _tmp, state) = setup_archive_view_server();
    let hash = store_blob(&state, b"<html><body>hi</body></html>", "text/html");
    let path = format!("/api/vault/archive/view/{hash}");
    let csp_of = |response: &axum_test::TestResponse| {
        response
            .headers()
            .get("content-security-policy")
            .expect("view responses carry a CSP")
            .to_str()
            .unwrap()
            .to_string()
    };
    let bind = "https://vault.example:7443";

    let listed = server
        .get(&path)
        .add_header("host", "clepsydra.example")
        .await;
    listed.assert_status(StatusCode::OK);
    let csp = csp_of(&listed);
    assert_eq!(csp.matches("https://clepsydra.example").count(), 4, "{csp}");
    assert!(!csp.contains("vault.example"), "{csp}");
    assert!(
        !csp.contains("tunnel.example"),
        "other listed origins must not widen the policy: {csp}"
    );

    let default_port = server
        .get(&path)
        .add_header("host", "clepsydra.example:443")
        .await;
    assert_eq!(csp_of(&default_port), csp, "explicit default port is the same origin");

    let wrong_port = server.get(&path).add_header("host", "tunnel.example").await;
    let csp = csp_of(&wrong_port);
    assert_eq!(csp.matches(bind).count(), 4, "port mismatch falls back: {csp}");

    let injected = server
        .get(&path)
        .add_header("host", "clepsydra.example; img-src https://evil.example")
        .await;
    let csp = csp_of(&injected);
    assert!(!csp.contains("evil.example"), "request bytes reached the policy: {csp}");
    assert_eq!(csp.matches(bind).count(), 4, "{csp}");

    let head = server
        .method(axum::http::Method::HEAD, &path)
        .add_header("host", "clepsydra.example")
        .await;
    head.assert_status(StatusCode::OK);
    assert_eq!(csp_of(&head), csp_of(&listed), "HEAD selects the same policy as GET");
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test --test archive_test archive_view_names_the_listed_origin > /tmp/t2.txt 2>&1; grep -E '^(error|test result|---- )' /tmp/t2.txt`
Expected: FAIL — the first `listed` assertion sees the bind origin (`vault.example`) because handlers still pass `None`.

- [ ] **Step 4: Thread the host through the handlers**

In `src/api/archive.rs`:

1. Add the helper near `sandbox_headers`:

```rust
/// The host the browser addressed: the `Host` header, or the request-target
/// authority for HTTP/2 requests, which carry `:authority` instead.
fn request_host(headers: &HeaderMap, uri: &Uri) -> Option<String> {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .or_else(|| uri.authority().map(|authority| authority.as_str().to_owned()))
}
```

Add `Uri` to the `axum::http` imports at the top of the file (find the existing `use axum::http::{...}` line and add `Uri`).

2. Change `snapshot_response_with` signature and body:

```rust
fn snapshot_response_with(
    snapshot: LoadedSnapshot,
    config: &ArchiveViewConfig,
    host: Option<&str>,
    body_permit: Option<tokio::sync::OwnedSemaphorePermit>,
) -> Response {
```
and inside it `let mut headers = sandbox_headers(config, host);`.

3. `view_snapshot`:

```rust
pub async fn view_snapshot(
    State(state): State<Arc<AppState>>,
    Extension(config): Extension<ArchiveViewConfig>,
    Path(hash): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let host = request_host(&headers, &uri);
    // ... existing body unchanged ...
    Ok(snapshot_response_with(snapshot, &config, host.as_deref(), Some(permit)))
}
```

4. `head_snapshot`: same two extractors (`uri: Uri, headers: HeaderMap`), `let host = request_host(&headers, &uri);` at the top, and the match arm becomes `snapshot_response_with(snapshot, &config, host.as_deref(), None)`.

5. In `src/lib.rs` `run_server`, directly after `archive_view_config` is built (line ~1055):

```rust
    tracing::info!(
        origins = %archive_view_config.allowed_origins().collect::<Vec<_>>().join(", "),
        "archive snapshot view CSP origins (bind origin first)"
    );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --test archive_test > /tmp/t2.txt 2>&1; grep -E '^(error|test result|---- )' /tmp/t2.txt`
Expected: `test result: ok.` — both the new test and `archive_view_serves_html_with_configuration_bound_sandbox`.

- [ ] **Step 6: Whole-crate check, fmt, commit**

Run: `cargo fmt && cargo clippy --all-targets > /tmp/c2.txt 2>&1; grep -E '^(error|warning)' /tmp/c2.txt; cargo test > /tmp/t2b.txt 2>&1; grep -E '^(error|test result)' /tmp/t2b.txt`
Expected: clean.

```bash
git add src/api/archive.rs src/lib.rs tests/archive_test.rs
git commit -m "feat(archive): snapshot view CSP names the listed origin the browser addressed"
```

---

### Task 3: `Access-Control-Allow-Origin: *` on CAS blobs

**Files:**
- Modify: `src/api/archive.rs:1082-1125` (`serve_blob`)
- Test: `tests/archive_test.rs` (new integration test)

**Interfaces:**
- Consumes: `setup_archive_view_server()`, `store_blob()` from `tests/archive_test.rs`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `tests/archive_test.rs`:

```rust
#[tokio::test]
async fn cas_blobs_allow_cross_origin_reads_but_snapshot_views_do_not() {
    // `@font-face` fetches are CORS-mode and the sandboxed frame's origin is
    // `null`, so archived fonts need an ACAO header even on the bind origin.
    let (server, _tmp, state) = setup_archive_view_server();
    let font = store_blob(&state, b"wOF2 fake font bytes", "font/woff2");
    let view = store_blob(&state, b"<html><body>hi</body></html>", "text/html");

    let blob = server
        .get(&format!("/api/vault/cas/{font}"))
        .add_header("origin", "null")
        .await;
    blob.assert_status(StatusCode::OK);
    assert_eq!(
        blob.headers()
            .get("access-control-allow-origin")
            .map(|value| value.to_str().unwrap()),
        Some("*")
    );
    assert_eq!(
        blob.headers()
            .get("content-type")
            .map(|value| value.to_str().unwrap()),
        Some("font/woff2")
    );

    let snapshot = server
        .get(&format!("/api/vault/archive/view/{view}"))
        .add_header("origin", "null")
        .await;
    snapshot.assert_status(StatusCode::OK);
    assert!(
        snapshot.headers().get("access-control-allow-origin").is_none(),
        "snapshot documents must stay unreadable cross-origin"
    );
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --test archive_test cas_blobs_allow_cross_origin > /tmp/t3.txt 2>&1; grep -E '^(error|test result|---- )' /tmp/t3.txt`
Expected: FAIL on the `access-control-allow-origin` assertion (`None` vs `Some("*")`).

- [ ] **Step 3: Add the header**

In `serve_blob`, after the `X_CONTENT_TYPE_OPTIONS` insert and before `if is_active_content(...)`:

```rust
    // `@font-face` loads are CORS-mode and the sandboxed snapshot frame has an
    // opaque (`null`) origin, so without this header every archived font fails
    // even on the bind origin. Blobs are immutable, content-addressed, and
    // unauthenticated; `*` adds readability only for callers that already hold
    // the hash.
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --test archive_test cas_blobs_allow_cross_origin > /tmp/t3.txt 2>&1; grep -E '^(error|test result)' /tmp/t3.txt`
Expected: `test result: ok.`

- [ ] **Step 5: fmt, clippy, commit**

Run: `cargo fmt && cargo clippy --all-targets > /tmp/c3.txt 2>&1; grep -E '^(error|warning)' /tmp/c3.txt`
Expected: clean.

```bash
git add src/api/archive.rs tests/archive_test.rs
git commit -m "fix(archive): allow cross-origin reads of CAS blobs so sandboxed fonts load"
```

---

### Task 4: Documentation

**Files:**
- Modify: `ui/src/docs/content/configuration.mdx:106-110` (example), `:136-138` (keys table), after `:176` (new subsection before `### TLS behavior`)
- Modify: `ui/src/docs/content/troubleshooting.mdx:93-97` (reverse proxy paragraph)

**Interfaces:** none.

- [ ] **Step 1: Example config**

In the `### Example` TOML block, after `dev_mode = false` add:

```toml
# public_origins = ["https://clepsydra.localhost"]
```

- [ ] **Step 2: Keys table**

After the `server` / `dev_mode` row add:

```markdown
| `server` | `public_origins` | string[] | `[]` | Reverse-proxy or tunnel origins the archive viewer may name; config file only |
```

- [ ] **Step 3: New subsection**

Insert before `### TLS behavior (\`server.tls\`)`:

````markdown
### Archive viewer origins (`server.public_origins`)

Archived snapshots render inside a sandboxed frame. The frame's
Content-Security-Policy names exactly one origin that images, fonts, and media
may load from: the origin the browser used to reach Clepsydra. That origin is
chosen from the bind origin (`server.host`, `server.port`, TLS) plus this list by
matching the request's `Host` header. The header only selects a configured
entry; its bytes never reach the policy.

Behind a reverse proxy or tunnel, list every name browsers use:

```toml
[server]
public_origins = ["https://clepsydra.localhost", "https://vault.tail1234.ts.net"]
```

Entries must be bare `scheme://host[:port]` origins — no wildcards, paths,
queries, or credentials; startup fails otherwise. A name missing from the list
falls back to the bind origin, and the snapshot renders without its images and
fonts (fail closed, nothing leaks). `clep serve` logs the effective origins at
startup. This key is read from the config file only; it has no
environment-variable form.
````

- [ ] **Step 4: Troubleshooting pointer**

In `troubleshooting.mdx`, after the paragraph ending `not the Clepsydra API contract.` add:

```markdown
An archived snapshot that renders without its images and fonts behind a reverse
proxy or tunnel means that name is not in `server.public_origins`; see
[Configuration](/docs/configuration#archive-viewer-origins-serverpublic_origins).
```

The anchor is what `rehype-slug` (github-slugger) derives from the heading text: lowercase, backticks/parentheses/dots dropped, spaces to `-`, underscores kept. `ui/src/docs/toc.ts` mirrors the same rule if you need to double-check.

- [ ] **Step 5: Verify docs build and tests**

Run from `ui/`: `bun run typecheck && bun run lint && bun run test src/docs > /tmp/d4.txt 2>&1; tail -5 /tmp/d4.txt`
Expected: typecheck and lint clean; `Test Files ... passed`.

- [ ] **Step 6: Commit**

```bash
git add ui/src/docs/content/configuration.mdx ui/src/docs/content/troubleshooting.mdx
git commit -m "docs: server.public_origins for the archive snapshot viewer"
```

---

## Verification gates (after all tasks)

- `cargo fmt --check`, `cargo clippy --all-targets`, `cargo test` — all clean (no piping; read the files).
- `cd ui && bun run typecheck && bun run lint && bun run test` — clean.
- Live check after merge: add `public_origins = ["https://clepsydra.localhost", "https://gathering.tail94fed9.ts.net"]` to `~/.config/clepsydra/config.toml`, restart `clep serve`, open `https://clepsydra.localhost/archive/archive/surya.website/surya-narreddi.md`: zero `img-src`/`font-src` CSP errors and zero CORS font errors in the console. The remaining `script-src` errors are hotlinked third-party scripts, blocked by design.
