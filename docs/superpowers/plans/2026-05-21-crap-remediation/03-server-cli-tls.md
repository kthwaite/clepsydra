# Slice 03 — Server Bootstrap / CLI / TLS CRAP Remediation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Read `00-overview.md` first — §3 and §5 are assumed.

**Goal:** Clear `run_server`, `main`, and `ensure_certificates` by extracting their pure pieces (router build, bind-address parse, cert-plan resolution, app-state build, CLI dispatch) into testable functions, leaving the three originals thin enough (CC ≤ 5) to pass even at the low coverage inherent to socket-binding / process-exiting code.

**Architecture:** `run_server` keeps only: logging init, settings load, `build_app_state`, `build_router`, address resolution, and the TLS-vs-plain bind/serve branch. `main` becomes `std::process::exit(run_cli(Cli::parse()).await?)`. `run_cli` returns an exit code (the Doctor arm returns its code instead of calling `process::exit` inline), making every arm except `Serve` unit-testable.

**Tech Stack:** Axum 0.8, axum-server, Clap, tokio, rustls; `tempfile` (dev-dep) for cert-path tests.

**Targets:** #2 run_server, #7 main, #11 ensure_certificates.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/lib.rs` | `build_router`, `parse_bind_addr`, `resolve_cert_plan` + `CertPlan`, `build_app_state`, `init_logging`; thin `run_server`/`ensure_certificates`; tests | Modify |
| `src/bin/cli.rs` | `pub(crate)` `Cli`/`Commands`; `run_cli(Cli) -> Result<i32, _>`; thin `main`; tests | Modify |
| `src/app_config.rs` | (already testable) reference only | — |

---

## Task 1: `parse_bind_addr` (pure)

**Files:** Modify `src/lib.rs`

- [ ] **Step 1: Write the failing test**

In `src/lib.rs`:

```rust
/// Parse a host + port into a `SocketAddr` for IP-literal hosts
/// (`127.0.0.1`, `0.0.0.0`, `::1`). Returns `None` for names needing DNS.
pub fn parse_bind_addr(host: &str, port: u16) -> Option<std::net::SocketAddr> {
    format!("{host}:{port}").parse().ok()
}

#[cfg(test)]
mod bind_tests {
    use super::*;

    #[test]
    fn parses_ipv4_literal() {
        let a = parse_bind_addr("127.0.0.1", 8080).unwrap();
        assert_eq!(a.port(), 8080);
        assert!(a.is_ipv4());
    }

    #[test]
    fn rejects_hostname() {
        assert!(parse_bind_addr("example.com", 80).is_none());
    }
}
```

- [ ] **Step 2: Run**

Run: `cargo test --lib bind_tests`
Expected: PASS

- [ ] **Step 3: Use it in `run_server`**

In `run_server` (lib.rs:272), replace the `tokio::net::lookup_host(...).await?...next()...` block (lines ~422–427) with:

```rust
let addr = parse_bind_addr(&settings.server.host, settings.server.port)
    .ok_or_else(|| format!("invalid bind address: {}:{}", settings.server.host, settings.server.port))?;
```

> Note: if the default host is a name like `"localhost"` rather than `127.0.0.1`, keep a DNS fallback: `parse_bind_addr(...).or_else(|| /* existing lookup_host path */)`. Confirm the default in `app_config.rs` and choose accordingly; prefer normalizing the default to `127.0.0.1` so the sync path is exercised.

- [ ] **Step 4: Run & commit**

Run: `cargo build`
Expected: builds.

```bash
git add src/lib.rs
git commit -m "refactor(server): extract parse_bind_addr"
```

---

## Task 2: `build_router` (pure)

**Files:** Modify `src/lib.rs`

- [ ] **Step 1: Write the failing test**

In `src/lib.rs`:

```rust
use std::sync::Arc;
use axum::Router;
use crate::api::AppState;

/// Compose the full Axum router from application state.
pub fn build_router(state: Arc<AppState>, archive_body_limit: usize, dev_mode: bool) -> Router {
    let mut app = Router::new()
        .nest("/api/vault", crate::api::api_router_with_archive_limit(archive_body_limit))
        .merge(crate::api::openapi::router());
    if !dev_mode {
        app = app.merge(crate::api::frontend::frontend_router());
    }
    app.with_state(state)
        .layer(tower::ServiceBuilder::new().layer(tower_http::trace::TraceLayer::new_for_http()))
}
```

Add a test (reuse the `make_state` helper from Task 4 once it exists; for now, a build-time test of both branches):

```rust
#[cfg(test)]
mod router_tests {
    use super::*;
    use super::state_test_support::make_state;

    #[tokio::test]
    async fn builds_router_in_both_modes() {
        let (state, _tmp) = make_state();
        let _dev = build_router(state.clone(), 1024, true);
        let _prod = build_router(state, 1024, false);
        // Construction without panic on either branch is the assertion.
    }
}
```

> Note: copy the exact `.nest(...).merge(...).layer(...)` chain currently inline in `run_server` (lib.rs:407–420), including the precise imports (`tower::ServiceBuilder`, `tower_http::trace::TraceLayer`) used there.

- [ ] **Step 2: Run** (after Task 4 provides `make_state`)

Run: `cargo test --lib router_tests`
Expected: PASS

- [ ] **Step 3: Use it in `run_server`**

Replace the inline router construction (lib.rs:407–420) with:

```rust
let app = build_router(state, archive_body_limit, settings.server.dev_mode);
```

- [ ] **Step 4: Commit**

```bash
git add src/lib.rs
git commit -m "refactor(server): extract build_router"
```

---

## Task 3: `resolve_cert_plan` + thin `ensure_certificates` (#11)

**Files:** Modify `src/lib.rs`

- [ ] **Step 1: Write the failing test**

In `src/lib.rs`:

```rust
use std::path::PathBuf;

#[derive(Debug, PartialEq)]
pub enum CertPlan {
    /// Explicit cert + key configured; never generate.
    Explicit { cert: PathBuf, key: PathBuf },
    /// Auto-discovered default paths; generate if absent.
    AutoDiscover { cert: PathBuf, key: PathBuf },
    /// No data dir available; TLS cannot proceed.
    NoDataDir,
}

/// Decide which cert/key paths to use, without touching the filesystem.
pub fn resolve_cert_plan(tls: &crate::TlsSettings, data_dir: Option<PathBuf>) -> CertPlan {
    if let (Some(cert), Some(key)) = (tls.cert_path.clone(), tls.key_path.clone()) {
        return CertPlan::Explicit { cert, key };
    }
    match data_dir {
        Some(dir) => CertPlan::AutoDiscover {
            cert: dir.join("clepsydra/cert.pem"),
            key: dir.join("clepsydra/key.pem"),
        },
        None => CertPlan::NoDataDir,
    }
}

#[cfg(test)]
mod cert_tests {
    use super::*;

    fn tls(cert: Option<&str>, key: Option<&str>) -> crate::TlsSettings {
        crate::TlsSettings {
            enabled: true,
            cert_path: cert.map(Into::into),
            key_path: key.map(Into::into),
            ..Default::default()
        }
    }

    #[test]
    fn explicit_paths_are_used_verbatim() {
        let plan = resolve_cert_plan(&tls(Some("/c.pem"), Some("/k.pem")), Some("/data".into()));
        assert_eq!(plan, CertPlan::Explicit { cert: "/c.pem".into(), key: "/k.pem".into() });
    }

    #[test]
    fn auto_discover_when_unset() {
        let plan = resolve_cert_plan(&tls(None, None), Some("/data".into()));
        assert!(matches!(plan, CertPlan::AutoDiscover { .. }));
    }

    #[test]
    fn no_data_dir_when_unavailable() {
        assert_eq!(resolve_cert_plan(&tls(None, None), None), CertPlan::NoDataDir);
    }
}
```

> Note: confirm `TlsSettings`'s real path field names + the default cert/key filenames used by `default_tls_paths` (lib.rs:204–224); mirror them exactly. Make `TlsSettings` constructible in tests (it likely derives `Default` via `serde` defaults; if not, build it field-by-field).

- [ ] **Step 2: Run**

Run: `cargo test --lib cert_tests`
Expected: PASS

- [ ] **Step 3: Thin `ensure_certificates`**

Rewrite `ensure_certificates` (lib.rs:226–270) to:

```rust
async fn ensure_certificates(tls: &TlsSettings)
    -> Result<(PathBuf, PathBuf), Box<dyn std::error::Error>>
{
    let (cert_path, key_path) = match resolve_cert_plan(tls, dirs::data_dir()) {
        CertPlan::Explicit { cert, key } => return Ok((cert, key)),
        CertPlan::AutoDiscover { cert, key } => (cert, key),
        CertPlan::NoDataDir => return Err("no data directory for TLS certificates".into()),
    };
    if !cert_path.exists() || !key_path.exists() {
        // existing mkcert generation I/O, unchanged
    }
    Ok((cert_path, key_path))
}
```

This drops `ensure_certificates` to CC ≤ 4 (the mkcert I/O branch). Even at 0% coverage that is `CRAP = 16 + 4 = 20`, under threshold.

- [ ] **Step 4: Run & commit**

Run: `cargo test --lib cert_tests && cargo build`
Expected: PASS / builds.

```bash
git add src/lib.rs
git commit -m "refactor(server): extract resolve_cert_plan; thin ensure_certificates"
```

---

## Task 4: `build_app_state` + `init_logging` + thin `run_server` (#2)

**Files:** Modify `src/lib.rs`

- [ ] **Step 1: Extract `init_logging`**

Move the logging setup (lib.rs:275–280) into:

```rust
pub fn init_logging() {
    use tracing_subscriber::EnvFilter;
    let _ = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .try_init(); // try_init so repeated test calls don't panic
}
```

- [ ] **Step 2: Write the failing test for `build_app_state`**

In `src/lib.rs`:

```rust
/// Build the shared application state from a settings + vault root.
pub async fn build_app_state(settings: &Settings, vault_root: &std::path::Path)
    -> Result<Arc<AppState>, Box<dyn std::error::Error>>
{
    // Port lines 286-349 of run_server: open vault, CAS, index (build + resolve),
    // spawn IndexHandle, broadcast channel, hooks, bcl/location, assemble AppState.
    todo!("port AppState construction from run_server")
}

#[cfg(test)]
pub(crate) mod state_test_support {
    use super::*;
    use tempfile::TempDir;

    /// A built AppState over a fresh temp vault, for router/state tests.
    pub(crate) fn make_state() -> (Arc<AppState>, TempDir) {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let settings = Settings::default();
        let state = tokio::runtime::Handle::try_current()
            .map(|_| ()) // already in a runtime when called from #[tokio::test]
            .ok();
        let _ = state;
        let st = futures::executor::block_on(build_app_state(&settings, &root)).unwrap();
        (st, tmp)
    }
}

#[cfg(test)]
mod state_tests {
    use super::*;

    #[tokio::test]
    async fn build_app_state_opens_a_temp_vault() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let settings = Settings::default();
        let state = build_app_state(&settings, &root).await.unwrap();
        assert!(state.vault.root().exists());
    }
}
```

> Note: `Settings::default()` must produce a usable config; if `Settings` has no `Default`, load from an empty tempfile via `Settings::load_from`. The `make_state` helper is used by `router_tests` (Task 2) — if `futures::executor` is not a dependency, instead make `make_state` an `async fn` and call it from `#[tokio::test]`.

- [ ] **Step 3: Run to verify it fails**

Run: `cargo test --lib state_tests`
Expected: FAIL — `todo!`.

- [ ] **Step 4: Port the body, then thin `run_server`**

Fill `build_app_state` from lib.rs:286–349. Rewrite `run_server` (272) to:

```rust
pub async fn run_server(enable_lsp: bool) -> Result<(), Box<dyn std::error::Error>> {
    init_logging();
    let cwd = std::env::current_dir()?;
    let (settings, _config_path) = Settings::load(&cwd)?;
    let state = build_app_state(&settings, /* vault root from settings/cwd */ &cwd).await?;
    if enable_lsp {
        let lsp_state = state.clone();
        tokio::spawn(async move { crate::lsp::run_lsp(lsp_state).await; std::process::exit(0); });
    }
    // file-watcher spawn (unchanged)
    let app = build_router(state, archive_body_limit, settings.server.dev_mode);
    let addr = parse_bind_addr(&settings.server.host, settings.server.port)
        .ok_or_else(|| format!("invalid bind address"))?;
    if settings.server.tls.enabled {
        let (cert, key) = ensure_certificates(&settings.server.tls).await?;
        let config = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key).await?;
        axum_server::bind_rustls(addr, config).serve(app.into_make_service()).await?;
    } else {
        axum_server::bind(addr).serve(app.into_make_service()).await?;
    }
    Ok(())
}
```

Target `run_server` CC ≤ 5 (lsp branch + tls branch + 2 `?` error edges). At 0% coverage that is `CRAP = 25 + 5 = 30`, which does **not exceed** the threshold — but aim for CC 4 by keeping the file-watcher spawn inside `build_app_state` or a `spawn_file_watcher(state)` helper if the count comes out at 6.

> Note: keep the `vault root` resolution and `archive_body_limit` derivation consistent with the original; if they require `settings`/`config_path`, thread them into `build_app_state`'s signature.

- [ ] **Step 5: Run & commit**

Run: `cargo test --lib state_tests router_tests && cargo build`
Expected: PASS / builds.

```bash
git add src/lib.rs
git commit -m "refactor(server): extract build_app_state/init_logging; thin run_server"
```

---

## Task 5: `Settings::load_from` coverage

`Settings::load_from` (lib.rs:103) is `pub` but untested; covering it is cheap insurance and confirms the config layering.

**Files:** Modify `src/lib.rs`

- [ ] **Step 1: Write the test**

```rust
#[cfg(test)]
mod settings_tests {
    use super::*;

    #[test]
    fn load_from_reads_toml_overrides() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cfg = tmp.path().join("config.toml");
        std::fs::write(&cfg, "[server]\nport = 9999\n").unwrap();
        let settings = Settings::load_from(&cfg).unwrap();
        assert_eq!(settings.server.port, 9999);
    }
}
```

> Note: confirm the TOML section/key names against the `Settings`/`ServerSettings` structs.

- [ ] **Step 2: Run & commit**

Run: `cargo test --lib settings_tests`
Expected: PASS

```bash
git add src/lib.rs
git commit -m "test(server): cover Settings::load_from"
```

---

## Task 6: `run_cli` + thin `main` (#7)

**Files:** Modify `src/bin/cli.rs`

- [ ] **Step 1: Make `Cli`/`Commands` `pub(crate)` and extract `run_cli`**

In `src/bin/cli.rs`, change `struct Cli` (line 18) and `enum Commands` (line 24) to `pub(crate)`. Add:

```rust
/// Dispatch a parsed CLI invocation; returns the process exit code.
pub(crate) async fn run_cli(cli: Cli) -> Result<i32, Box<dyn std::error::Error>> {
    match cli.command {
        Commands::Init { path } => {
            init_vault(&path)?;
            println!("Initialized vault at {}", path.display());
            Ok(0)
        }
        Commands::New { title, body } => {
            let cwd = std::env::current_dir()?;
            let p = create_new_note(&cwd, &title, body.as_deref())?;
            println!("Created {}", p.display());
            Ok(0)
        }
        Commands::Env => { println!("(env stub)"); Ok(0) }
        Commands::Doctor { json, strict, full } => {
            let report = diagnostics::run(DoctorOpts { full }).await;
            let stdout = std::io::stdout();
            let mut w = stdout.lock();
            if json { report.render_json(&mut w)?; } else { report.render_human(&mut w)?; }
            Ok(report.exit_code(strict))   // return, do NOT process::exit here
        }
        Commands::Serve { lsp } => { run_server(lsp).await?; Ok(0) }
        Commands::Version => { println!("{}", env!("CARGO_PKG_VERSION")); Ok(0) }
    }
}
```

Rewrite `main`:

```rust
#[tokio::main]
async fn main() {
    match run_cli(Cli::parse()).await {
        Ok(code) => std::process::exit(code),
        Err(e) => { eprintln!("error: {e}"); std::process::exit(1); }
    }
}
```

> Note: mirror the exact arm bodies/messages currently in `main` (cli.rs:89–128). The only behavioral change is that the Doctor arm *returns* its exit code instead of calling `std::process::exit` inline — the exit now happens in `main`.

- [ ] **Step 2: Write the failing tests**

```rust
#[cfg(test)]
mod cli_tests {
    use super::*;

    #[tokio::test]
    async fn version_returns_zero() {
        let cli = Cli::try_parse_from(["clepsydra", "version"]).unwrap();
        assert_eq!(run_cli(cli).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn env_returns_zero() {
        let cli = Cli::try_parse_from(["clepsydra", "env"]).unwrap();
        assert_eq!(run_cli(cli).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn init_creates_a_vault() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("v");
        let cli = Cli::try_parse_from(["clepsydra", "init", root.to_str().unwrap()]).unwrap();
        assert_eq!(run_cli(cli).await.unwrap(), 0);
        assert!(root.join(".clepsydra").exists());
    }

    #[tokio::test]
    async fn doctor_on_clean_vault_returns_zero() {
        // Run doctor with CWD pointed at a fresh vault; expect exit code 0.
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("v");
        init_vault(&root).unwrap();
        let _guard = std::env::set_current_dir(&root);
        let cli = Cli::try_parse_from(["clepsydra", "doctor"]).unwrap();
        let code = run_cli(cli).await.unwrap();
        assert!(code == 0 || code == 0);
    }
}
```

> Note: confirm `Cli::try_parse_from` subcommand names match the Clap definitions (`init`, `new`, `env`, `doctor`, `serve`, `version`). The `doctor` test mutates CWD — gate it with `serial_test::serial` if other tests depend on CWD, or assert only that `run_cli` returns `Ok`. Do **not** test the `Serve` arm (binds a socket).

- [ ] **Step 3: Run**

Run: `cargo test --bin cli cli_tests`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/bin/cli.rs
git commit -m "refactor(cli): extract run_cli; thin main; cover CLI arms"
```

---

## Task 7: Slice gate

- [ ] **Step 1: Full suite green**

Run: `cargo test`
Expected: PASS.

- [ ] **Step 2: CRAP gate**

Run: `./scripts/crap-check.sh`
Expected: count strictly below slice-02 result; none of `run_server`, `main`, `ensure_certificates` in `✗`.

```bash
cargo crap --lcov lcov.info 2>&1 | rg '✗' | rg 'lib\.rs|cli\.rs' || echo "server/cli/tls cleared"
```
Expected: `server/cli/tls cleared`

- [ ] **Step 3: Check new helpers**

If `build_app_state` or `run_cli` appear in `✗`, add the missing arm/branch tests. `run_server`/`main` must be confirmed at CC ≤ 5 / ≤ 2 (so they pass even uncovered).

- [ ] **Step 4: Commit top-ups**

```bash
git add -A && git commit -m "test(server): close remaining coverage gaps for slice 03"
```

---

## Self-Review

- **Spec coverage:** run_server (T1–T4), ensure_certificates (T3), main (T6). ✓
- **New helpers covered:** parse_bind_addr (T1), build_router (T2), resolve_cert_plan (T3), build_app_state (T4), Settings::load_from (T5), run_cli (T6). ✓
- **Thin-and-acceptable:** `run_server` (CC ≤ 5) and `main` (CC ≤ 2) pass even at 0% coverage — the genuinely untestable socket/exit code stays there.
- **Behavior risk:** moving Doctor's `process::exit` from the arm into `main` is the one semantic change — preserved exit code via `run_cli`'s return value.
- **Dependency note:** if `futures::executor::block_on` is unavailable, convert `make_state` to async (noted in T4).
