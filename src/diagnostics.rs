//! `clepsydra doctor` diagnostics.
//!
//! Each `check_*` function appends one or more [`CheckResult`]s to a
//! [`Report`]. Checks are read-only and never panic: failures inside a check
//! become `Status::Err` results so the rest of the report still runs.

use std::fmt::Write as _;
use std::io;
use std::path::{Path, PathBuf};

use axum_server::tls_rustls::RustlsConfig;
use rusqlite::Connection;
use serde::Serialize;

use crate::Settings;
use crate::app_config;
use crate::default_tls_paths;
use crate::expand_tilde;
use crate::resolve_vault_root;
use crate::vault::Vault;
use crate::vault::config::VaultConfig;

/// Status of a single check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Warn,
    Err,
    Info,
    Skip,
}

/// Result of a single check.
#[derive(Debug, Clone, Serialize)]
pub struct CheckResult {
    pub section: &'static str,
    pub name: &'static str,
    pub status: Status,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl CheckResult {
    fn new(section: &'static str, name: &'static str, status: Status, detail: String) -> Self {
        Self {
            section,
            name,
            status,
            detail,
            hint: None,
        }
    }

    fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

/// Aggregate diagnostic report.
#[derive(Debug, Default, Serialize)]
pub struct Report {
    #[serde(rename = "checks")]
    pub results: Vec<CheckResult>,
    pub summary: Summary,
}

#[derive(Debug, Default, Clone, Copy, Serialize)]
pub struct Summary {
    pub ok: usize,
    pub warn: usize,
    pub err: usize,
    pub info: usize,
    pub skip: usize,
}

impl Report {
    fn push(&mut self, result: CheckResult) {
        match result.status {
            Status::Ok => self.summary.ok += 1,
            Status::Warn => self.summary.warn += 1,
            Status::Err => self.summary.err += 1,
            Status::Info => self.summary.info += 1,
            Status::Skip => self.summary.skip += 1,
        }
        self.results.push(result);
    }

    /// Exit code for the overall report.
    ///
    /// `0` when there are no errors (and, under `strict`, no warnings either).
    /// `1` otherwise.
    pub fn exit_code(&self, strict: bool) -> i32 {
        if self.summary.err > 0 {
            return 1;
        }
        if strict && self.summary.warn > 0 {
            return 1;
        }
        0
    }

    pub fn render_human(&self, w: &mut impl io::Write) -> io::Result<()> {
        let mut current_section: Option<&'static str> = None;
        for r in &self.results {
            if Some(r.section) != current_section {
                if current_section.is_some() {
                    writeln!(w)?;
                }
                writeln!(w, "{}", r.section)?;
                current_section = Some(r.section);
            }
            let tag = match r.status {
                Status::Ok => "[OK]  ",
                Status::Warn => "[WARN]",
                Status::Err => "[ERR] ",
                Status::Info => "[INFO]",
                Status::Skip => "[SKIP]",
            };
            writeln!(w, "  {} {:<22} {}", tag, r.name, r.detail)?;
            if let Some(hint) = &r.hint {
                writeln!(w, "         hint: {hint}")?;
            }
        }
        writeln!(w)?;
        writeln!(
            w,
            "Summary: {} ok, {} warn, {} err ({} info, {} skip)",
            self.summary.ok,
            self.summary.warn,
            self.summary.err,
            self.summary.info,
            self.summary.skip,
        )?;
        Ok(())
    }

    pub fn render_json(&self, w: &mut impl io::Write) -> io::Result<()> {
        serde_json::to_writer_pretty(&mut *w, self).map_err(io::Error::other)?;
        writeln!(w)?;
        Ok(())
    }
}

/// Options passed to [`run`].
#[derive(Debug, Default, Clone, Copy)]
pub struct DoctorOpts {
    /// Enable expensive checks (e.g. CAS stats).
    pub full: bool,
}

/// Run all diagnostic checks against the current process environment.
pub async fn run(opts: DoctorOpts) -> Report {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    run_with_cwd(&cwd, opts).await
}

/// Run all diagnostic checks rooted at `cwd` (used for tests).
pub async fn run_with_cwd(cwd: &Path, opts: DoctorOpts) -> Report {
    let mut report = Report::default();

    let loaded = check_top_level_config(cwd, &mut report);

    if let Some(settings) = loaded.as_ref().map(|(s, _)| s) {
        check_server_address(settings, &mut report).await;
        check_tls(settings, &mut report).await;
    } else {
        report.push(skip("server", "address", "skipped — config did not load"));
        report.push(skip("tls", "certs", "skipped — config did not load"));
    }

    let vault = match loaded.as_ref() {
        Some((settings, config_path)) => check_vault(settings, config_path, cwd, &mut report),
        None => {
            report.push(skip("vault", "root", "skipped — config did not load"));
            None
        }
    };

    if let Some(v) = vault.as_ref() {
        check_index(v, opts.full, &mut report).await;
        check_cas(v, opts.full, &mut report);
        check_academic(v, &mut report);
        check_bcl(v, &mut report);
    } else {
        report.push(skip("index", "cache.db", "skipped — vault unavailable"));
        report.push(skip("cas", "store", "skipped — vault unavailable"));
        report.push(skip("academic", "folders", "skipped — vault unavailable"));
        report.push(skip("bcl", "config", "skipped — vault unavailable"));
    }

    check_runtime(&mut report);

    report
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn ok(section: &'static str, name: &'static str, detail: impl Into<String>) -> CheckResult {
    CheckResult::new(section, name, Status::Ok, detail.into())
}
fn warn(section: &'static str, name: &'static str, detail: impl Into<String>) -> CheckResult {
    CheckResult::new(section, name, Status::Warn, detail.into())
}
fn err(section: &'static str, name: &'static str, detail: impl Into<String>) -> CheckResult {
    CheckResult::new(section, name, Status::Err, detail.into())
}
fn info(section: &'static str, name: &'static str, detail: impl Into<String>) -> CheckResult {
    CheckResult::new(section, name, Status::Info, detail.into())
}
fn skip(section: &'static str, name: &'static str, detail: impl Into<String>) -> CheckResult {
    CheckResult::new(section, name, Status::Skip, detail.into())
}

/// Read-only writability check.
///
/// Uses metadata permission bits rather than a write probe so the doctor
/// never leaves stray files behind, even if the process is killed mid-check.
/// This is coarser than an actual write attempt (a directory whose mode bits
/// say writable may still fail to write, e.g. read-only filesystem mounts),
/// but the trade-off matches the read-only contract of `clepsydra doctor`.
fn is_dir_writable(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(m) => !m.permissions().readonly(),
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Check 1: top-level config
// ---------------------------------------------------------------------------

fn check_top_level_config(cwd: &Path, report: &mut Report) -> Option<(Settings, PathBuf)> {
    const SECTION: &str = "server config";

    let candidates = app_config::config_candidates(cwd);
    let candidate_list = candidates
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");

    let config_path = match app_config::find_config_path(cwd) {
        Some(p) => p,
        None => {
            report.push(
                err(
                    SECTION,
                    "config.toml",
                    format!("not found in any of: {candidate_list}"),
                )
                .with_hint("create config.toml in CWD or $XDG_CONFIG_HOME/clepsydra/"),
            );
            return None;
        }
    };

    report.push(ok(
        SECTION,
        "config.toml",
        format!("loaded from {}", config_path.display()),
    ));

    let settings = match Settings::load_from(&config_path) {
        Ok(s) => s,
        Err(e) => {
            report.push(err(SECTION, "parse", format!("{e}")));
            return None;
        }
    };

    let mut env_overrides: Vec<String> = std::env::vars_os()
        .filter_map(|(k, _)| k.into_string().ok())
        .filter(|k| k.starts_with("CLEPSYDRA__"))
        .collect();
    env_overrides.sort();
    if env_overrides.is_empty() {
        report.push(info(SECTION, "env overrides", "none".to_string()));
    } else {
        report.push(info(SECTION, "env overrides", env_overrides.join(", ")));
    }

    let tls_state = if settings.server.tls.enabled {
        "enabled"
    } else {
        "disabled"
    };
    report.push(info(
        SECTION,
        "effective",
        format!(
            "host={} port={} dev_mode={} tls={}",
            settings.server.host, settings.server.port, settings.server.dev_mode, tls_state
        ),
    ));

    Some((settings, config_path))
}

// ---------------------------------------------------------------------------
// Check 2: server address
// ---------------------------------------------------------------------------

async fn check_server_address(settings: &Settings, report: &mut Report) {
    const SECTION: &str = "server";
    let host_port = format!("{}:{}", settings.server.host, settings.server.port);

    let resolved = match tokio::net::lookup_host(&host_port).await {
        Ok(mut iter) => iter.next(),
        Err(e) => {
            report.push(err(
                SECTION,
                "address",
                format!("cannot resolve {host_port:?}: {e}"),
            ));
            return;
        }
    };

    let addr = match resolved {
        Some(a) => a,
        None => {
            report.push(err(
                SECTION,
                "address",
                format!("{host_port:?} resolved to no addresses"),
            ));
            return;
        }
    };

    report.push(ok(SECTION, "address", format!("{host_port} -> {addr}")));

    match std::net::TcpListener::bind(addr) {
        Ok(listener) => {
            drop(listener);
            report.push(ok(SECTION, "bind", format!("{addr} is bindable")));
        }
        Err(e) => {
            report.push(
                warn(SECTION, "bind", format!("{addr} not bindable: {e}"))
                    .with_hint("port already in use"),
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Check 3: TLS
// ---------------------------------------------------------------------------

async fn check_tls(settings: &Settings, report: &mut Report) {
    const SECTION: &str = "tls";

    if !settings.server.tls.enabled {
        report.push(info(SECTION, "enabled", "disabled in config"));
        return;
    }

    let (cert_path, key_path, explicit) = match default_tls_paths(&settings.server.tls) {
        Ok(Some(t)) => t,
        Ok(None) => {
            report.push(err(
                SECTION,
                "paths",
                "no cert paths configured and dirs::data_dir() is unavailable",
            ));
            return;
        }
        Err(msg) => {
            report.push(
                err(SECTION, "paths", msg)
                    .with_hint("set both server.tls.cert_path and server.tls.key_path"),
            );
            return;
        }
    };

    let source = if explicit {
        "explicit"
    } else {
        "auto-discovered"
    };
    report.push(info(
        SECTION,
        "paths",
        format!(
            "cert={} key={} ({source})",
            cert_path.display(),
            key_path.display()
        ),
    ));

    let cert_exists = cert_path.is_file();
    let key_exists = key_path.is_file();

    if cert_exists && key_exists {
        match RustlsConfig::from_pem_file(&cert_path, &key_path).await {
            Ok(_) => {
                report.push(ok(SECTION, "certs", "loaded and parsed"));
            }
            Err(e) => {
                report.push(err(
                    SECTION,
                    "certs",
                    format!("PEM files present but failed to parse: {e}"),
                ));
            }
        }
        return;
    }

    let mut missing = Vec::new();
    if !cert_exists {
        missing.push(cert_path.display().to_string());
    }
    if !key_exists {
        missing.push(key_path.display().to_string());
    }

    if explicit {
        report.push(err(
            SECTION,
            "certs",
            format!("missing: {}", missing.join(", ")),
        ));
        return;
    }

    if has_executable_on_path("mkcert") {
        report.push(
            warn(
                SECTION,
                "certs",
                format!("missing {} — mkcert available on PATH", missing.join(", ")),
            )
            .with_hint("run `clepsydra serve` once to generate via mkcert"),
        );
    } else {
        report.push(
            err(
                SECTION,
                "certs",
                format!("missing {} and mkcert not on PATH", missing.join(", ")),
            )
            .with_hint(
                "install mkcert (https://github.com/FiloSottile/mkcert) or set tls.cert_path/tls.key_path",
            ),
        );
    }
}

fn has_executable_on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Check 4: vault
// ---------------------------------------------------------------------------

fn check_vault(
    settings: &Settings,
    config_path: &Path,
    cwd: &Path,
    report: &mut Report,
) -> Option<Vault> {
    const SECTION: &str = "vault";

    let vault_root = resolve_vault_root(&settings.vault.root, config_path, cwd);

    if !vault_root.exists() {
        report.push(
            err(
                SECTION,
                "root",
                format!("{} does not exist", vault_root.display()),
            )
            .with_hint(format!(
                "run `clepsydra init {}` or fix vault.root",
                vault_root.display()
            )),
        );
        return None;
    }
    if !vault_root.is_dir() {
        report.push(err(
            SECTION,
            "root",
            format!("{} is not a directory", vault_root.display()),
        ));
        return None;
    }

    let writable = is_dir_writable(&vault_root);
    if writable {
        report.push(ok(
            SECTION,
            "root",
            format!("{} (read+write)", vault_root.display()),
        ));
    } else {
        report.push(warn(
            SECTION,
            "root",
            format!("{} is not writable", vault_root.display()),
        ));
    }

    let dot_dir = vault_root.join(".clepsydra");
    if !dot_dir.is_dir() {
        report.push(
            err(
                SECTION,
                "initialized",
                format!("{} missing", dot_dir.display()),
            )
            .with_hint(format!("run `clepsydra init {}`", vault_root.display())),
        );
        return None;
    }
    report.push(ok(
        SECTION,
        "initialized",
        ".clepsydra/ present".to_string(),
    ));

    let vault_config = match VaultConfig::load(&vault_root) {
        Ok(c) => c,
        Err(e) => {
            report.push(err(
                SECTION,
                "config",
                format!(".clepsydra/config.toml: {e}"),
            ));
            return None;
        }
    };
    report.push(ok(SECTION, "config", "parsed .clepsydra/config.toml"));

    let mut bad_globs: Vec<String> = Vec::new();
    for pat in &vault_config.vault.excluded_patterns {
        if glob::Pattern::new(pat).is_err() {
            bad_globs.push(pat.clone());
        }
    }
    if bad_globs.is_empty() {
        report.push(ok(
            SECTION,
            "excluded patterns",
            format!("{} valid", vault_config.vault.excluded_patterns.len()),
        ));
    } else {
        report.push(err(
            SECTION,
            "excluded patterns",
            format!("invalid glob(s): {}", bad_globs.join(", ")),
        ));
    }

    let attach = vault_root.join(&vault_config.vault.attachment_folder);
    if attach.is_dir() {
        report.push(ok(
            SECTION,
            "attachments",
            format!("{} present", vault_config.vault.attachment_folder),
        ));
    } else {
        report.push(warn(
            SECTION,
            "attachments",
            format!(
                "{} missing (will be created on first use)",
                attach.display()
            ),
        ));
    }

    if vault_config.vault.default_page_folder.is_empty() {
        report.push(info(
            SECTION,
            "default folder",
            "vault root (default_page_folder = \"\")",
        ));
    } else {
        let folder = vault_root.join(&vault_config.vault.default_page_folder);
        if folder.is_dir() {
            report.push(ok(
                SECTION,
                "default folder",
                vault_config.vault.default_page_folder.clone(),
            ));
        } else {
            report.push(warn(
                SECTION,
                "default folder",
                format!("{} missing — `clepsydra new` will fail", folder.display()),
            ));
        }
    }

    match Vault::open(&vault_root) {
        Ok(vault) => Some(vault),
        Err(e) => {
            report.push(err(SECTION, "open", format!("Vault::open: {e}")));
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Check 5: index DB
// ---------------------------------------------------------------------------

const REQUIRED_TABLES: &[&str] = &[
    "pages",
    "links",
    "tags",
    "blocks",
    "block_properties",
    "canonical_names",
    "pages_fts",
];

async fn check_index(vault: &Vault, full: bool, report: &mut Report) {
    const SECTION: &str = "index";
    let db_path = vault.root().join(".clepsydra/cache.db");

    if !db_path.exists() {
        report.push(
            warn(
                SECTION,
                "cache.db",
                format!("{} missing", db_path.display()),
            )
            .with_hint("run `clepsydra serve` once to build the index"),
        );
        if full {
            run_index_dry_build(vault, report).await;
        }
        return;
    }

    let conn = match Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ) {
        Ok(c) => c,
        Err(e) => {
            report.push(err(
                SECTION,
                "cache.db",
                format!("cannot open {}: {e}", db_path.display()),
            ));
            return;
        }
    };
    report.push(ok(
        SECTION,
        "cache.db",
        format!("opened {}", db_path.display()),
    ));

    let mut missing: Vec<&str> = Vec::new();
    for tbl in REQUIRED_TABLES {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                [tbl],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if exists == 0 {
            missing.push(tbl);
        }
    }
    if missing.is_empty() {
        report.push(ok(
            SECTION,
            "schema",
            format!("{} tables present", REQUIRED_TABLES.len()),
        ));
    } else {
        report.push(
            err(
                SECTION,
                "schema",
                format!("missing tables: {}", missing.join(", ")),
            )
            .with_hint("delete .clepsydra/cache.db and rebuild"),
        );
        return;
    }

    let pages: i64 = conn
        .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
        .unwrap_or(-1);
    let unresolved: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM links WHERE target_id IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap_or(-1);
    let fts: i64 = conn
        .query_row("SELECT COUNT(*) FROM pages_fts", [], |row| row.get(0))
        .unwrap_or(-1);

    let mut detail = String::new();
    let _ = write!(
        &mut detail,
        "{pages} pages, {unresolved} unresolved links, {fts} fts rows"
    );
    report.push(ok(SECTION, "counts", detail));

    if pages == 0 && vault_has_markdown(vault.root()) {
        report.push(
            warn(SECTION, "stale", "index empty but vault contains markdown")
                .with_hint("delete .clepsydra/cache.db and rebuild"),
        );
    }

    if full {
        run_index_dry_build(vault, report).await;
    }
}

/// RAII guard that removes a temporary directory when dropped.
///
/// We avoid pulling `tempfile` into the runtime dependency graph — it's only
/// needed by tests now — by allocating a uniquely-named directory under
/// `std::env::temp_dir()` and cleaning it up ourselves.
struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn make_doctor_tempdir() -> std::io::Result<TempDirGuard> {
    let dir = std::env::temp_dir().join(format!(
        "clepsydra-doctor-{}-{}",
        std::process::id(),
        uuid::Uuid::now_v7().simple()
    ));
    std::fs::create_dir_all(&dir)?;
    Ok(TempDirGuard(dir))
}

async fn run_index_dry_build(vault: &Vault, report: &mut Report) {
    const SECTION: &str = "index";

    let guard = match make_doctor_tempdir() {
        Ok(g) => g,
        Err(e) => {
            report.push(warn(
                SECTION,
                "dry-build",
                format!("could not create tempdir: {e}"),
            ));
            return;
        }
    };
    let tmp_db = guard.0.join("doctor-cache.db");

    // `VaultIndex::build` walks the entire vault and parses every markdown
    // file synchronously. Run it under `spawn_blocking` so we don't stall
    // the tokio runtime on large vaults.
    let vault = vault.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let mut index =
            crate::vault::index::VaultIndex::open(&tmp_db).map_err(|e| format!("open: {e}"))?;
        index.build(&vault).map_err(|e| format!("build: {e}"))
    })
    .await;
    drop(guard);

    let stats = match result {
        Ok(Ok(stats)) => stats,
        Ok(Err(msg)) => {
            report.push(err(SECTION, "dry-build", format!("VaultIndex::{msg}")));
            return;
        }
        Err(join_err) => {
            report.push(err(
                SECTION,
                "dry-build",
                format!("blocking task panicked: {join_err}"),
            ));
            return;
        }
    };

    report.push(ok(
        SECTION,
        "dry-build",
        format!(
            "{} indexed, {} skipped, {} removed",
            stats.pages_indexed, stats.pages_skipped, stats.pages_removed
        ),
    ));
    if stats.warnings.is_empty() {
        report.push(ok(SECTION, "build warnings", "none"));
    } else {
        let preview: Vec<String> = stats.warnings.iter().take(5).cloned().collect();
        let extra = stats.warnings.len().saturating_sub(preview.len());
        let detail = if extra == 0 {
            preview.join("; ")
        } else {
            format!("{} (+{extra} more)", preview.join("; "))
        };
        report.push(warn(SECTION, "build warnings", detail));
    }
}

fn vault_has_markdown(root: &Path) -> bool {
    walkdir::WalkDir::new(root)
        .max_depth(3)
        .into_iter()
        .filter_map(|e| e.ok())
        .any(|e| {
            e.file_type().is_file() && e.path().extension().and_then(|s| s.to_str()) == Some("md")
        })
}

// ---------------------------------------------------------------------------
// Check 6: CAS
// ---------------------------------------------------------------------------

fn check_cas(vault: &Vault, full: bool, report: &mut Report) {
    const SECTION: &str = "cas";
    let archive = &vault.config().archive;

    if !archive.enabled {
        report.push(warn(
            SECTION,
            "enabled",
            "archive disabled in vault config; validating configured CAS path because serve still opens it",
        ));
    }

    let raw = &archive.cas_path;
    let path = expand_tilde(raw).unwrap_or_else(|| PathBuf::from(raw));
    report.push(info(SECTION, "path", path.display().to_string()));

    if !path.exists() {
        report.push(
            warn(
                SECTION,
                "directory",
                format!("{} does not exist", path.display()),
            )
            .with_hint("`clepsydra serve` will create it on first run"),
        );
        return;
    }
    if !path.is_dir() {
        report.push(err(
            SECTION,
            "directory",
            format!("{} exists but is not a directory", path.display()),
        ));
        return;
    }
    if !is_dir_writable(&path) {
        report.push(err(
            SECTION,
            "directory",
            format!("{} not writable", path.display()),
        ));
        return;
    }
    report.push(ok(SECTION, "directory", "writable"));

    let db_path = path.join("cas.db");
    if !db_path.exists() {
        report.push(
            warn(SECTION, "open", format!("{} missing", db_path.display()))
                .with_hint("`clepsydra serve` will create it on first run"),
        );
        return;
    }
    if !db_path.is_file() {
        report.push(err(
            SECTION,
            "open",
            format!("{} exists but is not a file", db_path.display()),
        ));
        return;
    }

    match Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ) {
        Ok(conn) => {
            let blobs_table: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'blobs'",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            if blobs_table == 0 {
                report.push(err(SECTION, "schema", "missing blobs table"));
                return;
            }

            report.push(ok(SECTION, "open", "cas.db opened read-only"));
            if full {
                let blob_count: rusqlite::Result<i64> =
                    conn.query_row("SELECT COUNT(*) FROM blobs", [], |row| row.get(0));
                let total_size: rusqlite::Result<i64> =
                    conn.query_row("SELECT COALESCE(SUM(size), 0) FROM blobs", [], |row| {
                        row.get(0)
                    });
                match (blob_count, total_size) {
                    (Ok(blob_count), Ok(total_size)) => report.push(ok(
                        SECTION,
                        "stats",
                        format!("{} blobs, {} bytes", blob_count, total_size),
                    )),
                    (Err(e), _) | (_, Err(e)) => {
                        report.push(warn(SECTION, "stats", format!("{e}")))
                    }
                }
            }
        }
        Err(e) => report.push(err(
            SECTION,
            "open",
            format!("cannot open {} read-only: {e}", db_path.display()),
        )),
    }
}

// ---------------------------------------------------------------------------
// Check 7: academic / Zotero
// ---------------------------------------------------------------------------

fn check_academic(vault: &Vault, report: &mut Report) {
    const SECTION: &str = "academic";
    let cfg = &vault.config().academic;

    let folders: [(&'static str, &str); 4] = [
        ("library", &cfg.library_folder),
        ("papers", &cfg.papers_folder),
        ("books", &cfg.books_folder),
        ("annotations", &cfg.annotations_folder),
    ];

    for (name, rel) in folders {
        let path = vault.root().join(rel);
        if path.is_dir() {
            report.push(ok(SECTION, name, rel.to_string()));
        } else {
            report.push(warn(
                SECTION,
                name,
                format!("{} missing (created on first use)", path.display()),
            ));
        }
    }

    match &cfg.zotero.database_path {
        Some(p) => {
            let path = expand_tilde(p).unwrap_or_else(|| PathBuf::from(p));
            if path.is_file() {
                report.push(ok(SECTION, "zotero db", path.display().to_string()));
            } else {
                report.push(err(
                    SECTION,
                    "zotero db",
                    format!("{} does not exist", path.display()),
                ));
            }
        }
        None => {
            report.push(info(
                SECTION,
                "zotero db",
                "unset (auto-detected at runtime)",
            ));
        }
    }
}

// ---------------------------------------------------------------------------
// Check 8: BCL
// ---------------------------------------------------------------------------

fn check_bcl(vault: &Vault, report: &mut Report) {
    const SECTION: &str = "bcl";

    let vault_file = vault.root().join(".clepsydra/bcl");
    let home_file = dirs::home_dir().map(|h| h.join(".config/bcl"));

    if vault_file.is_file() {
        match read_bcl_date(&vault_file) {
            Some(date) => report.push(ok(SECTION, "config", format!(".clepsydra/bcl -> {date}"))),
            None => report.push(warn(
                SECTION,
                "config",
                ".clepsydra/bcl present but not a valid YYYY-MM-DD date".to_string(),
            )),
        }
        return;
    }

    match home_file.as_ref().filter(|p| p.is_file()) {
        Some(p) => {
            report.push(info(
                SECTION,
                "config",
                format!(
                    "vault file absent; will seed from {} on next serve",
                    p.display()
                ),
            ));
        }
        None => {
            report.push(info(
                SECTION,
                "config",
                "no bcl file in vault or ~/.config/bcl",
            ));
        }
    }
}

fn read_bcl_date(path: &Path) -> Option<chrono::NaiveDate> {
    let raw = std::fs::read_to_string(path).ok()?;
    chrono::NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d").ok()
}

// ---------------------------------------------------------------------------
// Check 9: runtime / build info
// ---------------------------------------------------------------------------

fn check_runtime(report: &mut Report) {
    const SECTION: &str = "runtime";
    report.push(info(
        SECTION,
        "version",
        env!("CARGO_PKG_VERSION").to_string(),
    ));
    let rust_log = std::env::var("RUST_LOG").unwrap_or_else(|_| "(unset)".to_string());
    report.push(info(SECTION, "RUST_LOG", rust_log));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// RAII guard that records the prior value of an env var on construction
    /// and restores it on drop. Required because tokio's default test runtime
    /// runs tests on a multi-threaded executor where process-wide env state is
    /// shared, and `find_config_path`/`dirs::home_dir` read these values.
    struct EnvGuard {
        key: &'static str,
        prior: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let prior = std::env::var_os(key);
            // SAFETY: tests touching env are gated behind `#[serial_test::serial]`
            // so no other thread is racing on the same variable.
            unsafe { std::env::set_var(key, value) }
            Self { key, prior }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            // SAFETY: see `set`.
            unsafe {
                match self.prior.take() {
                    Some(v) => std::env::set_var(self.key, v),
                    None => std::env::remove_var(self.key),
                }
            }
        }
    }

    fn write_top_level_config(dir: &Path, vault_root: &Path) {
        fs::write(
            dir.join("config.toml"),
            format!(
                "[server]\nhost = \"localhost\"\nport = 0\n\n[vault]\nroot = \"{}\"\n",
                vault_root.display()
            ),
        )
        .unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn report_for_initialized_vault_is_clean() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        let vault_root = tmp.path().join("vault");
        crate::vault::init::init_vault(&vault_root).unwrap();
        write_top_level_config(cwd, &vault_root);

        let report = run_with_cwd(cwd, DoctorOpts::default()).await;

        assert_eq!(report.summary.err, 0, "errors: {:#?}", report.results);
        assert!(report.results.iter().any(|r| r.section == "server config"));
        assert!(report.results.iter().any(|r| r.section == "vault"));
        assert!(report.results.iter().any(|r| r.section == "runtime"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn missing_config_reports_error_and_keeps_going() {
        let tmp = TempDir::new().unwrap();
        // Override XDG/HOME so the doctor doesn't accidentally pick up a real
        // user config. The guards restore the prior values on drop, even if
        // the test panics, so they cannot leak into sibling tests.
        let _xdg = EnvGuard::set("XDG_CONFIG_HOME", tmp.path().join("xdg-empty"));
        let _home = EnvGuard::set("HOME", tmp.path().join("home-empty"));

        let report = run_with_cwd(tmp.path(), DoctorOpts::default()).await;

        assert!(report.summary.err > 0);
        // Runtime info should still appear.
        assert!(report.results.iter().any(|r| r.section == "runtime"));
        // Vault should be skipped.
        assert!(
            report
                .results
                .iter()
                .any(|r| r.section == "vault" && r.status == Status::Skip)
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn uninitialized_vault_reports_init_hint() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        let vault_root = tmp.path().join("vault");
        fs::create_dir_all(&vault_root).unwrap();
        write_top_level_config(cwd, &vault_root);

        let report = run_with_cwd(cwd, DoctorOpts::default()).await;

        let init = report
            .results
            .iter()
            .find(|r| r.section == "vault" && r.name == "initialized")
            .expect("expected vault initialized check");
        assert_eq!(init.status, Status::Err);
        assert!(init.hint.as_ref().unwrap().contains("clepsydra init"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn renderers_round_trip() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        let vault_root = tmp.path().join("vault");
        crate::vault::init::init_vault(&vault_root).unwrap();
        write_top_level_config(cwd, &vault_root);

        let report = run_with_cwd(cwd, DoctorOpts::default()).await;

        let mut human = Vec::new();
        report.render_human(&mut human).unwrap();
        let human = String::from_utf8(human).unwrap();
        assert!(human.contains("server config"));
        assert!(human.contains("Summary:"));

        let mut json = Vec::new();
        report.render_json(&mut json).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&json).unwrap();
        assert!(v.get("checks").unwrap().is_array());
        assert!(v.get("summary").unwrap().is_object());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn cas_check_does_not_create_missing_db() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        let vault_root = tmp.path().join("vault");
        crate::vault::init::init_vault(&vault_root).unwrap();
        let cas_path = tmp.path().join("cas");
        fs::create_dir_all(&cas_path).unwrap();
        fs::write(
            vault_root.join(".clepsydra/config.toml"),
            format!(
                "[vault]\nattachment_folder = \"_attachments\"\n\n[archive]\nenabled = true\ncas_path = \"{}\"\n",
                cas_path.display()
            ),
        )
        .unwrap();
        write_top_level_config(cwd, &vault_root);

        let report = run_with_cwd(cwd, DoctorOpts::default()).await;

        assert!(!cas_path.join("cas.db").exists());
        assert!(
            report
                .results
                .iter()
                .any(|r| { r.section == "cas" && r.name == "open" && r.status == Status::Warn })
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn cas_check_validates_path_even_when_archive_disabled() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        let vault_root = tmp.path().join("vault");
        crate::vault::init::init_vault(&vault_root).unwrap();
        let cas_path = tmp.path().join("not-a-directory");
        fs::write(&cas_path, "not a directory").unwrap();
        fs::write(
            vault_root.join(".clepsydra/config.toml"),
            format!(
                "[vault]\nattachment_folder = \"_attachments\"\n\n[archive]\nenabled = false\ncas_path = \"{}\"\n",
                cas_path.display()
            ),
        )
        .unwrap();
        write_top_level_config(cwd, &vault_root);

        let report = run_with_cwd(cwd, DoctorOpts::default()).await;

        assert!(
            report.results.iter().any(|r| {
                r.section == "cas" && r.name == "directory" && r.status == Status::Err
            })
        );
    }

    #[test]
    fn exit_code_strict_promotes_warnings() {
        let mut report = Report::default();
        report.push(warn("x", "y", "z"));
        assert_eq!(report.exit_code(false), 0);
        assert_eq!(report.exit_code(true), 1);
    }

    #[test]
    fn exit_code_errors_always_fail() {
        let mut report = Report::default();
        report.push(err("x", "y", "z"));
        assert_eq!(report.exit_code(false), 1);
        assert_eq!(report.exit_code(true), 1);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn tls_disabled_emits_info_only() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        let vault_root = tmp.path().join("vault");
        crate::vault::init::init_vault(&vault_root).unwrap();
        write_top_level_config(cwd, &vault_root);

        let report = run_with_cwd(cwd, DoctorOpts::default()).await;

        let tls = report
            .results
            .iter()
            .find(|r| r.section == "tls" && r.name == "enabled")
            .expect("expected tls.enabled");
        assert_eq!(tls.status, Status::Info);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn tls_enabled_with_missing_explicit_certs_errors() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        let vault_root = tmp.path().join("vault");
        crate::vault::init::init_vault(&vault_root).unwrap();

        let cert = tmp.path().join("cert.pem");
        let key = tmp.path().join("key.pem");
        fs::write(
            cwd.join("config.toml"),
            format!(
                concat!(
                    "[server]\nhost = \"localhost\"\nport = 0\n\n",
                    "[server.tls]\nenabled = true\ncert_path = \"{}\"\nkey_path = \"{}\"\n\n",
                    "[vault]\nroot = \"{}\"\n",
                ),
                cert.display(),
                key.display(),
                vault_root.display(),
            ),
        )
        .unwrap();

        let report = run_with_cwd(cwd, DoctorOpts::default()).await;

        let tls = report
            .results
            .iter()
            .find(|r| r.section == "tls" && r.name == "certs")
            .expect("expected tls.certs");
        assert_eq!(tls.status, Status::Err, "{:#?}", tls);
        assert!(tls.detail.contains("missing"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn academic_folders_warn_when_missing() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        let vault_root = tmp.path().join("vault");
        crate::vault::init::init_vault(&vault_root).unwrap();
        write_top_level_config(cwd, &vault_root);

        let report = run_with_cwd(cwd, DoctorOpts::default()).await;

        for name in ["library", "papers", "books", "annotations"] {
            let r = report
                .results
                .iter()
                .find(|r| r.section == "academic" && r.name == name)
                .unwrap_or_else(|| panic!("expected academic.{name}"));
            assert_eq!(r.status, Status::Warn);
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn zotero_missing_db_path_is_err() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        let vault_root = tmp.path().join("vault");
        crate::vault::init::init_vault(&vault_root).unwrap();

        // Append a zotero config block pointing at a missing file.
        let vault_cfg = vault_root.join(".clepsydra/config.toml");
        let extant = fs::read_to_string(&vault_cfg).unwrap();
        let bogus = tmp.path().join("nope.sqlite");
        fs::write(
            &vault_cfg,
            format!(
                "{extant}\n[academic.zotero]\ndatabase_path = \"{}\"\n",
                bogus.display()
            ),
        )
        .unwrap();
        write_top_level_config(cwd, &vault_root);

        let report = run_with_cwd(cwd, DoctorOpts::default()).await;
        let r = report
            .results
            .iter()
            .find(|r| r.section == "academic" && r.name == "zotero db")
            .expect("zotero db check");
        assert_eq!(r.status, Status::Err);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn bcl_vault_file_parsed() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        let vault_root = tmp.path().join("vault");
        crate::vault::init::init_vault(&vault_root).unwrap();
        fs::write(vault_root.join(".clepsydra/bcl"), "1990-01-15\n").unwrap();
        write_top_level_config(cwd, &vault_root);

        let report = run_with_cwd(cwd, DoctorOpts::default()).await;

        let r = report
            .results
            .iter()
            .find(|r| r.section == "bcl" && r.name == "config")
            .expect("bcl.config");
        assert_eq!(r.status, Status::Ok);
        assert!(r.detail.contains("1990-01-15"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn bcl_malformed_file_warns() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        let vault_root = tmp.path().join("vault");
        crate::vault::init::init_vault(&vault_root).unwrap();
        fs::write(vault_root.join(".clepsydra/bcl"), "garbage").unwrap();
        write_top_level_config(cwd, &vault_root);

        let report = run_with_cwd(cwd, DoctorOpts::default()).await;
        let r = report
            .results
            .iter()
            .find(|r| r.section == "bcl" && r.name == "config")
            .expect("bcl.config");
        assert_eq!(r.status, Status::Warn);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn full_index_dry_build_runs_when_requested() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        let vault_root = tmp.path().join("vault");
        crate::vault::init::init_vault(&vault_root).unwrap();
        // Add a markdown page so the build has something to index.
        fs::write(
            vault_root.join("hello.md"),
            "---\ntitle: Hello\n---\n\nworld\n",
        )
        .unwrap();
        write_top_level_config(cwd, &vault_root);

        let report = run_with_cwd(cwd, DoctorOpts { full: true }).await;

        let r = report
            .results
            .iter()
            .find(|r| r.section == "index" && r.name == "dry-build")
            .expect("expected index.dry-build under --full");
        assert_eq!(r.status, Status::Ok, "{:#?}", r);
        assert!(
            r.detail.contains("indexed"),
            "expected detail to mention indexed pages: {}",
            r.detail
        );
    }
}
