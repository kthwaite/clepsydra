//! `clepsydra doctor` diagnostics.
//!
//! Each `check_*` function appends one or more [`CheckResult`]s to a
//! [`Report`]. Checks are read-only and never panic: failures inside a check
//! become `Status::Err` results so the rest of the report still runs.

use std::io;
use std::path::{Path, PathBuf};

use axum_server::tls_rustls::RustlsConfig;
use rusqlite::{Connection, params};
use serde::Serialize;

use crate::Settings;
use crate::VESSEL_ACCENT as ACCENT;
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

    /// Render the report as styled, human-readable text.
    ///
    /// ANSI styling (via `owo-colors`) is emitted unconditionally; the caller
    /// is expected to wrap a real terminal in an [`anstream::AutoStream`],
    /// which strips the codes when colour is unwanted (piped output,
    /// `NO_COLOR`, a non-TTY, etc.). Styles always wrap whole tokens, so plain
    /// substring matches against this output remain valid even when codes are
    /// present.
    pub fn render_human(&self, w: &mut impl io::Write) -> io::Result<()> {
        use owo_colors::OwoColorize;

        let mut current_section: Option<&'static str> = None;
        for r in &self.results {
            if Some(r.section) != current_section {
                if current_section.is_some() {
                    writeln!(w)?;
                }
                writeln!(
                    w,
                    "{}",
                    r.section.truecolor(ACCENT.0, ACCENT.1, ACCENT.2).bold()
                )?;
                current_section = Some(r.section);
            }
            // Pad the tag to a fixed width *before* styling so the ANSI codes
            // don't throw off alignment.
            let (tag, detail) = (format!("{:<6}", status_tag(r.status)), r.detail.dimmed());
            let styled_tag = match r.status {
                Status::Ok => tag.green().bold().to_string(),
                Status::Warn => tag.yellow().bold().to_string(),
                Status::Err => tag.red().bold().to_string(),
                Status::Info => tag.blue().bold().to_string(),
                Status::Skip => tag.dimmed().to_string(),
            };
            writeln!(w, "  {} {:<22} {}", styled_tag, r.name, detail)?;
            if let Some(hint) = &r.hint {
                writeln!(w, "{}", format!("         hint: {hint}").dimmed())?;
            }
        }
        writeln!(w)?;
        writeln!(
            w,
            "Summary: {} ok, {} warn, {} err ({} info, {} skip)",
            severity_count(self.summary.ok, self.summary.ok.green().to_string()),
            severity_count(
                self.summary.warn,
                self.summary.warn.yellow().bold().to_string()
            ),
            severity_count(self.summary.err, self.summary.err.red().bold().to_string()),
            severity_count(self.summary.info, self.summary.info.blue().to_string()),
            self.summary.skip.dimmed(),
        )?;
        Ok(())
    }

    pub fn render_json(&self, w: &mut impl io::Write) -> io::Result<()> {
        serde_json::to_writer_pretty(&mut *w, self).map_err(io::Error::other)?;
        writeln!(w)?;
        Ok(())
    }
}

/// Fixed-width-free status tag for a check (padding is applied by the caller).
fn status_tag(status: Status) -> &'static str {
    match status {
        Status::Ok => "[OK]",
        Status::Warn => "[WARN]",
        Status::Err => "[ERR]",
        Status::Info => "[INFO]",
        Status::Skip => "[SKIP]",
    }
}

/// Render a summary count: the pre-styled (coloured) form when non-zero, an
/// unadorned `0` otherwise, so a clean report doesn't paint its zeroes.
fn severity_count(count: usize, styled: String) -> String {
    if count == 0 {
        count.to_string()
    } else {
        styled
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

    match loaded.as_ref().map(|(settings, _)| &settings.features) {
        Some(features) => {
            report.push(info(
                "features",
                "academic",
                if features.academic {
                    "enabled"
                } else {
                    "disabled"
                },
            ));
            report.push(info(
                "features",
                "feeds",
                if features.feeds {
                    "enabled"
                } else {
                    "disabled"
                },
            ));
        }
        None => {
            report.push(skip(
                "features",
                "academic",
                "skipped — config did not load",
            ));
            report.push(skip(
                "features",
                "feeds",
                "skipped — config did not load",
            ));
        }
    }

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

    let academic_enabled = loaded
        .as_ref()
        .is_some_and(|(settings, _)| settings.features.academic);

    if let Some(v) = vault.as_ref() {
        check_index(v, opts.full, &mut report).await;
        check_cas(v, opts.full, &mut report);
        check_academic(v, academic_enabled, &mut report);
        check_bcl(v, &mut report);
        check_frontmatter(v, &mut report);
        check_bases(v, &mut report);
    } else {
        report.push(skip("index", "cache.db", "skipped — vault unavailable"));
        report.push(skip("cas", "store", "skipped — vault unavailable"));
        report.push(skip("academic", "folders", "skipped — vault unavailable"));
        report.push(skip("bcl", "config", "skipped — vault unavailable"));
        report.push(skip(
            "frontmatter",
            "legacy census",
            "skipped — vault unavailable",
        ));
        report.push(skip("bases", "registry", "skipped — vault unavailable"));
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

#[derive(Debug, Clone)]
struct TlsFacts {
    cert_path: std::path::PathBuf,
    key_path: std::path::PathBuf,
    explicit: bool,
    cert_exists: bool,
    key_exists: bool,
    /// Some iff both files exist (we only attempt a parse then); Ok=parsed, Err=parse failure.
    pem_parse: Option<Result<(), String>>,
}

/// Pure evaluation of TLS facts. `mkcert_available` is injected (PATH lookup).
fn evaluate_tls(facts: &TlsFacts, mkcert_available: bool) -> Vec<CheckResult> {
    const SECTION: &str = "tls";
    let mut out = Vec::new();
    let source = if facts.explicit {
        "explicit"
    } else {
        "auto-discovered"
    };
    out.push(info(
        SECTION,
        "paths",
        format!(
            "cert={} key={} ({source})",
            facts.cert_path.display(),
            facts.key_path.display()
        ),
    ));

    if facts.cert_exists && facts.key_exists {
        match &facts.pem_parse {
            Some(Ok(())) => out.push(ok(SECTION, "certs", "loaded and parsed")),
            Some(Err(e)) => out.push(err(
                SECTION,
                "certs",
                format!("PEM files present but failed to parse: {e}"),
            )),
            None => out.push(err(
                SECTION,
                "certs",
                "PEM files present but were not validated".to_string(),
            )),
        }
        return out;
    }

    let mut missing = Vec::new();
    if !facts.cert_exists {
        missing.push(facts.cert_path.display().to_string());
    }
    if !facts.key_exists {
        missing.push(facts.key_path.display().to_string());
    }

    if facts.explicit {
        out.push(err(
            SECTION,
            "certs",
            format!("missing: {}", missing.join(", ")),
        ));
        return out;
    }

    if mkcert_available {
        out.push(
            warn(
                SECTION,
                "certs",
                format!("missing {} — mkcert available on PATH", missing.join(", ")),
            )
            .with_hint("run `clepsydra serve` once to generate via mkcert"),
        );
    } else {
        out.push(
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
    out
}

async fn gather_tls_facts(tls: &crate::TlsSettings) -> Result<TlsFacts, CheckResult> {
    let (cert_path, key_path, explicit) = match default_tls_paths(tls) {
        Ok(Some(t)) => t,
        Ok(None) => {
            return Err(err(
                "tls",
                "paths",
                "no cert paths configured and dirs::data_dir() is unavailable",
            ));
        }
        Err(msg) => {
            return Err(err("tls", "paths", msg)
                .with_hint("set both server.tls.cert_path and server.tls.key_path"));
        }
    };

    let cert_exists = cert_path.is_file();
    let key_exists = key_path.is_file();
    let pem_parse = if cert_exists && key_exists {
        Some(
            RustlsConfig::from_pem_file(&cert_path, &key_path)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string()),
        )
    } else {
        None
    };

    Ok(TlsFacts {
        cert_path,
        key_path,
        explicit,
        cert_exists,
        key_exists,
        pem_parse,
    })
}

async fn check_tls(settings: &Settings, report: &mut Report) {
    if !settings.server.tls.enabled {
        report.push(info("tls", "enabled", "disabled in config"));
        return;
    }
    match gather_tls_facts(&settings.server.tls).await {
        Ok(facts) => {
            let mkcert = has_executable_on_path("mkcert");
            for r in evaluate_tls(&facts, mkcert) {
                report.push(r);
            }
        }
        Err(result) => report.push(result),
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

#[derive(Debug, Clone)]
struct VaultFacts {
    vault_root: std::path::PathBuf,
    root_exists: bool,
    root_is_dir: bool,
    root_writable: bool,
    dot_dir_exists: bool,
    /// Some iff dot_dir exists (we only load config then); Ok=parsed, Err=error msg.
    config_load: Option<Result<(), String>>,
    excluded_count: usize,
    bad_globs: Vec<String>,
    attachment_folder: String,
    attach_exists: bool,
    default_page_folder: String,
    default_folder_exists: bool,
}

/// Pure evaluation; returns (results, should_open_vault).
fn evaluate_vault(facts: &VaultFacts) -> (Vec<CheckResult>, bool) {
    const SECTION: &str = "vault";
    let mut out = Vec::new();
    let root = &facts.vault_root;

    if !facts.root_exists {
        out.push(
            err(
                SECTION,
                "root",
                format!("{} does not exist", root.display()),
            )
            .with_hint(format!(
                "run `clepsydra init {}` or fix vault.root",
                root.display()
            )),
        );
        return (out, false);
    }
    if !facts.root_is_dir {
        out.push(err(
            SECTION,
            "root",
            format!("{} is not a directory", root.display()),
        ));
        return (out, false);
    }

    if facts.root_writable {
        out.push(ok(
            SECTION,
            "root",
            format!("{} (read+write)", root.display()),
        ));
    } else {
        out.push(warn(
            SECTION,
            "root",
            format!("{} is not writable", root.display()),
        ));
    }

    let dot_dir = root.join(".clepsydra");
    if !facts.dot_dir_exists {
        out.push(
            err(
                SECTION,
                "initialized",
                format!("{} missing", dot_dir.display()),
            )
            .with_hint(format!("run `clepsydra init {}`", root.display())),
        );
        return (out, false);
    }
    out.push(ok(
        SECTION,
        "initialized",
        ".clepsydra/ present".to_string(),
    ));

    match &facts.config_load {
        Some(Ok(())) => out.push(ok(SECTION, "config", "parsed .clepsydra/config.toml")),
        Some(Err(e)) => {
            out.push(err(
                SECTION,
                "config",
                format!(".clepsydra/config.toml: {e}"),
            ));
            return (out, false);
        }
        None => {
            // Unreachable in production: gather_vault_facts only leaves
            // config_load None when dot_dir is absent, and we already returned
            // above in that case. Emit a loud diagnostic rather than aborting
            // silently if the invariant is ever violated.
            out.push(err(
                SECTION,
                "config",
                "internal: .clepsydra present but config load was not attempted",
            ));
            return (out, false);
        }
    }

    if facts.bad_globs.is_empty() {
        out.push(ok(
            SECTION,
            "excluded patterns",
            format!("{} valid", facts.excluded_count),
        ));
    } else {
        out.push(err(
            SECTION,
            "excluded patterns",
            format!("invalid glob(s): {}", facts.bad_globs.join(", ")),
        ));
    }

    let attach = root.join(&facts.attachment_folder);
    if facts.attach_exists {
        out.push(ok(
            SECTION,
            "attachments",
            format!("{} present", facts.attachment_folder),
        ));
    } else {
        out.push(warn(
            SECTION,
            "attachments",
            format!(
                "{} missing (will be created on first use)",
                attach.display()
            ),
        ));
    }

    if facts.default_page_folder.is_empty() {
        out.push(info(
            SECTION,
            "default folder",
            "vault root (default_page_folder = \"\")",
        ));
    } else {
        let folder = root.join(&facts.default_page_folder);
        if facts.default_folder_exists {
            out.push(ok(
                SECTION,
                "default folder",
                facts.default_page_folder.clone(),
            ));
        } else {
            out.push(warn(
                SECTION,
                "default folder",
                format!("{} missing — `clepsydra new` will fail", folder.display()),
            ));
        }
    }

    (out, true)
}

fn gather_vault_facts(settings: &Settings, config_path: &Path, cwd: &Path) -> VaultFacts {
    let vault_root = resolve_vault_root(&settings.vault.root, config_path, cwd);
    let root_exists = vault_root.exists();
    let root_is_dir = vault_root.is_dir();
    let root_writable = is_dir_writable(&vault_root);
    let dot_dir_exists = vault_root.join(".clepsydra").is_dir();

    let mut config_load: Option<Result<(), String>> = None;
    let mut excluded_count = 0usize;
    let mut bad_globs: Vec<String> = Vec::new();
    let mut attachment_folder = String::new();
    let mut attach_exists = false;
    let mut default_page_folder = String::new();
    let mut default_folder_exists = false;

    if dot_dir_exists {
        config_load = Some(match VaultConfig::load(&vault_root) {
            Ok(vault_config) => {
                excluded_count = vault_config.vault.excluded_patterns.len();
                for pat in &vault_config.vault.excluded_patterns {
                    if glob::Pattern::new(pat).is_err() {
                        bad_globs.push(pat.clone());
                    }
                }
                attachment_folder = vault_config.vault.attachment_folder.clone();
                attach_exists = vault_root
                    .join(&vault_config.vault.attachment_folder)
                    .is_dir();
                default_page_folder = vault_config.vault.default_page_folder.clone();
                default_folder_exists = if default_page_folder.is_empty() {
                    false
                } else {
                    vault_root.join(&default_page_folder).is_dir()
                };
                Ok(())
            }
            Err(e) => Err(e.to_string()),
        });
    }

    VaultFacts {
        vault_root,
        root_exists,
        root_is_dir,
        root_writable,
        dot_dir_exists,
        config_load,
        excluded_count,
        bad_globs,
        attachment_folder,
        attach_exists,
        default_page_folder,
        default_folder_exists,
    }
}

fn check_vault(
    settings: &Settings,
    config_path: &Path,
    cwd: &Path,
    report: &mut Report,
) -> Option<Vault> {
    let facts = gather_vault_facts(settings, config_path, cwd);
    let (results, should_open) = evaluate_vault(&facts);
    for r in results {
        report.push(r);
    }
    if !should_open {
        return None;
    }
    match Vault::open(&facts.vault_root) {
        Ok(vault) => Some(vault),
        Err(e) => {
            report.push(err("vault", "open", format!("Vault::open: {e}")));
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

#[derive(Debug, Clone)]
struct IndexFacts {
    db_path: std::path::PathBuf,
    db_open_error: Option<String>,
    missing_tables: Vec<&'static str>,
    page_count: i64,
    unresolved_link_count: i64,
    fts_row_count: i64,
    has_markdown: bool,
}

/// Pure evaluation of index facts (db known to exist; excludes the `--full` dry build).
fn evaluate_index(facts: &IndexFacts) -> Vec<CheckResult> {
    const SECTION: &str = "index";
    let mut out = Vec::new();
    if let Some(e) = &facts.db_open_error {
        out.push(err(
            SECTION,
            "cache.db",
            format!("cannot open {}: {e}", facts.db_path.display()),
        ));
        return out;
    }
    out.push(ok(
        SECTION,
        "cache.db",
        format!("opened {}", facts.db_path.display()),
    ));

    if !facts.missing_tables.is_empty() {
        out.push(
            err(
                SECTION,
                "schema",
                format!("missing tables: {}", facts.missing_tables.join(", ")),
            )
            .with_hint("delete .clepsydra/cache.db and rebuild"),
        );
        return out;
    }
    out.push(ok(
        SECTION,
        "schema",
        format!("{} tables present", REQUIRED_TABLES.len()),
    ));

    out.push(ok(
        SECTION,
        "counts",
        format!(
            "{} pages, {} unresolved links, {} fts rows",
            facts.page_count, facts.unresolved_link_count, facts.fts_row_count
        ),
    ));

    if facts.page_count == 0 && facts.has_markdown {
        out.push(
            warn(SECTION, "stale", "index empty but vault contains markdown")
                .with_hint("delete .clepsydra/cache.db and rebuild"),
        );
    }
    out
}

fn gather_index_facts(vault: &Vault, db_path: std::path::PathBuf) -> IndexFacts {
    let conn = match Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ) {
        Ok(c) => c,
        Err(e) => {
            return IndexFacts {
                db_open_error: Some(format!("{e}")),
                db_path,
                missing_tables: Vec::new(),
                page_count: 0,
                unresolved_link_count: 0,
                fts_row_count: 0,
                has_markdown: false,
            };
        }
    };

    let mut missing_tables: Vec<&'static str> = Vec::new();
    for tbl in REQUIRED_TABLES {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                [tbl],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if exists == 0 {
            missing_tables.push(tbl);
        }
    }

    let page_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
        .unwrap_or(-1);
    let unresolved_link_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM links WHERE target_id IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap_or(-1);
    let fts_row_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM pages_fts", [], |row| row.get(0))
        .unwrap_or(-1);
    let has_markdown = vault_has_markdown(vault.root());

    IndexFacts {
        db_path,
        db_open_error: None,
        missing_tables,
        page_count,
        unresolved_link_count,
        fts_row_count,
        has_markdown,
    }
}

async fn check_index(vault: &Vault, full: bool, report: &mut Report) {
    let db_path = vault.root().join(".clepsydra/cache.db");
    if !db_path.exists() {
        report.push(
            warn(
                "index",
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
    let facts = gather_index_facts(vault, db_path);
    for r in evaluate_index(&facts) {
        report.push(r);
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

fn check_academic(vault: &Vault, enabled: bool, report: &mut Report) {
    const SECTION: &str = "academic";

    if !enabled {
        for name in ["library", "papers", "books", "annotations", "zotero db"] {
            report.push(skip(SECTION, name, "skipped — feature disabled"));
        }
        return;
    }

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
// Check: base registry
// ---------------------------------------------------------------------------

/// Base file validation, property/system-field shadowing, and a
/// type-violation census. Read-only over the base files and the index DB.
fn check_bases(vault: &Vault, report: &mut Report) {
    use crate::vault::base::{BaseRegistry, PropertyType, SYSTEM_FIELDS};

    const SECTION: &str = "bases";

    let registry = BaseRegistry::load(vault.root());
    if registry.bases.is_empty() && registry.diagnostics.is_empty() {
        report.push(info(SECTION, "registry", "no base files under bases/"));
        return;
    }

    if registry.diagnostics.is_empty() {
        report.push(ok(
            SECTION,
            "registry",
            format!("{} base(s) parsed cleanly", registry.bases.len()),
        ));
    } else {
        let mut detail = format!(
            "{} base(s), {} diagnostic(s):",
            registry.bases.len(),
            registry.diagnostics.len()
        );
        for d in &registry.diagnostics {
            detail.push_str(&format!("\n  [{}] {}", d.slug, d.message));
        }
        report.push(warn(SECTION, "registry", detail));
    }

    // Shadowing + type-violation censuses need the index DB; skip gracefully
    // when it has not been built yet.
    let db_path = vault.root().join(".clepsydra/cache.db");
    let conn =
        match Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) {
            Ok(c) => c,
            Err(_) => {
                report.push(skip(
                    SECTION,
                    "shadowing",
                    "skipped — index DB not available",
                ));
                return;
            }
        };

    // Vault properties that shadow system fields (reachable only via
    // `prop.<name>` in filters).
    let placeholders = vec!["?"; SYSTEM_FIELDS.len()].join(", ");
    let shadowed: Vec<String> = conn
        .prepare(&format!(
            "SELECT DISTINCT key FROM page_properties WHERE key IN ({placeholders}) ORDER BY key"
        ))
        .and_then(|mut stmt| {
            let rows = stmt.query_map(rusqlite::params_from_iter(SYSTEM_FIELDS.iter()), |r| {
                r.get::<_, String>(0)
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        })
        .unwrap_or_default();
    if shadowed.is_empty() {
        report.push(ok(
            SECTION,
            "shadowing",
            "no vault property shadows a system field",
        ));
    } else {
        report.push(warn(
            SECTION,
            "shadowing",
            format!(
                "vault properties shadow system fields (reach them as prop.<name>): {}",
                shadowed.join(", ")
            ),
        ));
    }

    // Type-violation census: declared number/date/bool properties whose
    // indexed rows lack the native typed projection (e.g. rating = "4").
    // Vault-wide by key; base membership filters are not applied here.
    let mut violations: Vec<String> = Vec::new();
    for base in &registry.bases {
        for (key, def) in &base.file.properties {
            let column = match def.property_type {
                PropertyType::Number => "value_num",
                PropertyType::Date | PropertyType::Datetime => "value_date",
                PropertyType::Bool => "value_bool",
                _ => continue,
            };
            let count: i64 = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(DISTINCT page_id) FROM page_properties
                         WHERE key = ?1 AND {column} IS NULL"
                    ),
                    params![key],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if count > 0 {
                violations.push(format!(
                    "[{}] {key}: {count} page(s) hold a non-{:?} value",
                    base.slug, def.property_type
                ));
            }
        }
    }
    if violations.is_empty() {
        report.push(ok(SECTION, "type census", "no type violations"));
    } else {
        report.push(warn(
            SECTION,
            "type census",
            format!("type violations:\n  {}", violations.join("\n  ")),
        ));
    }
}

// ---------------------------------------------------------------------------
// Check: frontmatter legacy census
// ---------------------------------------------------------------------------

/// Read-only census of legacy `---` YAML pages awaiting TOML migration.
/// serde_yaml (and its quarantined reader) can be removed once this reads
/// zero across users' vaults.
fn check_frontmatter(vault: &Vault, report: &mut Report) {
    const SECTION: &str = "frontmatter";
    const LISTED: usize = 10;

    let legacy = crate::vault::migrate::legacy_pages(vault);
    if legacy.is_empty() {
        report.push(ok(
            SECTION,
            "legacy census",
            "no legacy --- pages; frontmatter is fully TOML",
        ));
        return;
    }

    let mut detail = format!("{} legacy --- page(s) pending migration:", legacy.len());
    for p in legacy.iter().take(LISTED) {
        detail.push_str("\n  ");
        detail.push_str(p.as_str());
    }
    if legacy.len() > LISTED {
        detail.push_str(&format!("\n  … and {} more", legacy.len() - LISTED));
    }
    report.push(
        info(SECTION, "legacy census", detail)
            .with_hint("run `clepsydra migrate --write` to convert (commit your vault first)"),
    );
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

    fn write_top_level_config_with_features(
        dir: &Path,
        vault_root: &Path,
        academic: bool,
        feeds: bool,
    ) {
        fs::write(
            dir.join("config.toml"),
            format!(
                concat!(
                    "[server]\nhost = \"localhost\"\nport = 0\n\n",
                    "[vault]\nroot = \"{}\"\n\n",
                    "[features]\nacademic = {}\nfeeds = {}\n",
                ),
                vault_root.display(),
                academic,
                feeds,
            ),
        )
        .unwrap();
    }

    fn assert_record(
        report: &Report,
        section: &str,
        name: &str,
        status: Status,
        detail: &str,
    ) {
        let record = report
            .results
            .iter()
            .find(|record| record.section == section && record.name == name)
            .unwrap_or_else(|| panic!("expected {section}.{name}"));
        assert_eq!(record.status, status, "{record:#?}");
        assert_eq!(record.detail, detail, "{record:#?}");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn doctor_reports_effective_feature_states() {
        let enabled = TempDir::new().unwrap();
        let enabled_vault = enabled.path().join("vault");
        crate::vault::init::init_vault(&enabled_vault).unwrap();
        write_top_level_config(enabled.path(), &enabled_vault);

        let enabled_report =
            run_with_cwd(enabled.path(), DoctorOpts::default()).await;
        let enabled_features: Vec<_> = enabled_report
            .results
            .iter()
            .filter(|record| record.section == "features")
            .map(|record| (record.name, record.status, record.detail.as_str()))
            .collect();
        assert_eq!(
            enabled_features,
            [
                ("academic", Status::Info, "enabled"),
                ("feeds", Status::Info, "enabled"),
            ]
        );

        let disabled = TempDir::new().unwrap();
        let disabled_vault = disabled.path().join("vault");
        crate::vault::init::init_vault(&disabled_vault).unwrap();
        write_top_level_config_with_features(
            disabled.path(),
            &disabled_vault,
            false,
            false,
        );

        let disabled_report =
            run_with_cwd(disabled.path(), DoctorOpts::default()).await;
        let disabled_features: Vec<_> = disabled_report
            .results
            .iter()
            .filter(|record| record.section == "features")
            .map(|record| (record.name, record.status, record.detail.as_str()))
            .collect();
        assert_eq!(
            disabled_features,
            [
                ("academic", Status::Info, "disabled"),
                ("feeds", Status::Info, "disabled"),
            ]
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn disabled_academic_skips_academic_checks() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        let vault_root = tmp.path().join("vault");
        crate::vault::init::init_vault(&vault_root).unwrap();

        let vault_cfg = vault_root.join(".clepsydra/config.toml");
        let extant = fs::read_to_string(&vault_cfg).unwrap();
        let missing_zotero_db = tmp.path().join("missing-zotero.sqlite");
        fs::write(
            &vault_cfg,
            format!(
                "{extant}\n[academic.zotero]\ndatabase_path = \"{}\"\n",
                missing_zotero_db.display()
            ),
        )
        .unwrap();
        write_top_level_config_with_features(cwd, &vault_root, false, false);

        let report = run_with_cwd(cwd, DoctorOpts::default()).await;

        for name in ["library", "papers", "books", "annotations", "zotero db"] {
            assert_record(
                &report,
                "academic",
                name,
                Status::Skip,
                "skipped — feature disabled",
            );
        }
        assert_record(
            &report,
            "features",
            "academic",
            Status::Info,
            "disabled",
        );
        assert_record(&report, "features", "feeds", Status::Info, "disabled");
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

        assert_record(
            &report,
            "features",
            "academic",
            Status::Skip,
            "skipped — config did not load",
        );
        assert_record(
            &report,
            "features",
            "feeds",
            Status::Skip,
            "skipped — config did not load",
        );

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
        assert_record(
            &report,
            "features",
            "academic",
            Status::Info,
            "enabled",
        );
        assert_record(
            &report,
            "academic",
            "folders",
            Status::Skip,
            "skipped — vault unavailable",
        );
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
    async fn bases_section_reports_shadowing_and_type_violations() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        let vault_root = tmp.path().join("vault");
        crate::vault::init::init_vault(&vault_root).unwrap();

        // A base declaring `rating = number`, plus a page violating it and
        // carrying a `kind` extra that shadows the system field.
        fs::create_dir_all(vault_root.join("bases")).unwrap();
        fs::write(
            vault_root.join("bases/reading.base.toml"),
            "name = \"Reading\"\n\n[properties]\nrating = { type = \"number\" }\n",
        )
        .unwrap();
        fs::write(
            vault_root.join("book.md"),
            "+++\nid = \"0190f8a0-0000-7000-8000-0000000000d9\"\nkind = \"work\"\nrating = \"4\"\n+++\nbody\n",
        )
        .unwrap();

        // The censuses read the index DB; build it first.
        let mut index =
            crate::vault::index::VaultIndex::open(&vault_root.join(".clepsydra/cache.db")).unwrap();
        index.build(&Vault::open(&vault_root).unwrap()).unwrap();
        drop(index);

        write_top_level_config(cwd, &vault_root);
        let report = run_with_cwd(cwd, DoctorOpts::default()).await;

        let registry = report
            .results
            .iter()
            .find(|r| r.section == "bases" && r.name == "registry")
            .expect("bases.registry");
        assert_eq!(registry.status, Status::Ok, "{}", registry.detail);

        let shadowing = report
            .results
            .iter()
            .find(|r| r.section == "bases" && r.name == "shadowing")
            .expect("bases.shadowing");
        assert_eq!(shadowing.status, Status::Warn);
        assert!(shadowing.detail.contains("kind"), "{}", shadowing.detail);

        let census = report
            .results
            .iter()
            .find(|r| r.section == "bases" && r.name == "type census")
            .expect("bases.type census");
        assert_eq!(census.status, Status::Warn);
        assert!(census.detail.contains("rating"), "{}", census.detail);
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

// ---------------------------------------------------------------------------
// Pure evaluate_* unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod evaluate_tls_tests {
    use super::*;
    use std::path::PathBuf;

    fn base_facts() -> TlsFacts {
        TlsFacts {
            cert_path: PathBuf::from("/tmp/cert.pem"),
            key_path: PathBuf::from("/tmp/key.pem"),
            explicit: false,
            cert_exists: true,
            key_exists: true,
            pem_parse: Some(Ok(())),
        }
    }

    #[test]
    fn valid_pem_both_exist_emits_ok() {
        let facts = base_facts();
        let results = evaluate_tls(&facts, false);
        assert!(
            results
                .iter()
                .any(|r| r.name == "paths" && r.status == Status::Info)
        );
        assert!(
            results
                .iter()
                .any(|r| r.name == "certs" && r.status == Status::Ok)
        );
        assert!(
            results
                .iter()
                .any(|r| r.detail.contains("loaded and parsed"))
        );
    }

    #[test]
    fn corrupt_pem_emits_err() {
        let mut facts = base_facts();
        facts.pem_parse = Some(Err("invalid PEM data".to_string()));
        let results = evaluate_tls(&facts, false);
        let certs = results.iter().find(|r| r.name == "certs").unwrap();
        assert_eq!(certs.status, Status::Err);
        assert!(certs.detail.contains("failed to parse"));
        assert!(certs.detail.contains("invalid PEM data"));
    }

    #[test]
    fn explicit_missing_emits_err() {
        let mut facts = base_facts();
        facts.explicit = true;
        facts.cert_exists = false;
        facts.key_exists = false;
        facts.pem_parse = None;
        let results = evaluate_tls(&facts, false);
        let certs = results.iter().find(|r| r.name == "certs").unwrap();
        assert_eq!(certs.status, Status::Err);
        assert!(certs.detail.contains("missing"));
    }

    #[test]
    fn auto_missing_with_mkcert_emits_warn() {
        let mut facts = base_facts();
        facts.explicit = false;
        facts.cert_exists = false;
        facts.key_exists = false;
        facts.pem_parse = None;
        let results = evaluate_tls(&facts, true);
        let certs = results.iter().find(|r| r.name == "certs").unwrap();
        assert_eq!(certs.status, Status::Warn);
        assert!(certs.detail.contains("mkcert available on PATH"));
        assert!(certs.hint.as_ref().unwrap().contains("clepsydra serve"));
    }

    #[test]
    fn auto_missing_no_mkcert_emits_err() {
        let mut facts = base_facts();
        facts.explicit = false;
        facts.cert_exists = false;
        facts.key_exists = false;
        facts.pem_parse = None;
        let results = evaluate_tls(&facts, false);
        let certs = results.iter().find(|r| r.name == "certs").unwrap();
        assert_eq!(certs.status, Status::Err);
        assert!(certs.detail.contains("mkcert not on PATH"));
        assert!(certs.hint.as_ref().unwrap().contains("mkcert"));
    }

    #[test]
    fn paths_info_always_first() {
        let facts = base_facts();
        let results = evaluate_tls(&facts, false);
        assert_eq!(results[0].name, "paths");
        assert_eq!(results[0].status, Status::Info);
    }

    #[test]
    fn auto_only_key_missing_lists_just_the_key_path() {
        // Exercises the single-missing branch: only one of cert/key absent.
        let mut facts = base_facts();
        facts.cert_exists = true;
        facts.key_exists = false;
        facts.pem_parse = None;
        let results = evaluate_tls(&facts, false);
        let certs = results.iter().find(|r| r.name == "certs").unwrap();
        assert!(
            certs.detail.contains("key.pem"),
            "expected key path in detail: {}",
            certs.detail
        );
        assert!(
            !certs.detail.contains("cert.pem"),
            "present cert path should not appear: {}",
            certs.detail
        );
    }
}

#[cfg(test)]
mod evaluate_index_tests {
    use super::*;
    use std::path::PathBuf;

    fn healthy_facts() -> IndexFacts {
        IndexFacts {
            db_path: PathBuf::from("/vault/.clepsydra/cache.db"),
            db_open_error: None,
            missing_tables: Vec::new(),
            page_count: 5,
            unresolved_link_count: 1,
            fts_row_count: 5,
            has_markdown: true,
        }
    }

    #[test]
    fn healthy_index_emits_ok_results() {
        let facts = healthy_facts();
        let results = evaluate_index(&facts);
        assert!(results.iter().all(|r| r.status == Status::Ok));
        assert!(
            results
                .iter()
                .any(|r| r.name == "cache.db" && r.detail.contains("opened"))
        );
        assert!(results.iter().any(|r| r.name == "schema"));
        assert!(results.iter().any(|r| r.name == "counts"));
    }

    #[test]
    fn open_error_emits_err_and_stops() {
        let mut facts = healthy_facts();
        facts.db_open_error = Some("no such file".to_string());
        let results = evaluate_index(&facts);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].status, Status::Err);
        assert!(results[0].detail.contains("cannot open"));
        assert!(results[0].detail.contains("no such file"));
    }

    #[test]
    fn missing_tables_emits_err_and_stops() {
        let mut facts = healthy_facts();
        facts.missing_tables = vec!["pages", "links"];
        let results = evaluate_index(&facts);
        // cache.db ok + schema err
        assert_eq!(results.len(), 2);
        let schema = results.iter().find(|r| r.name == "schema").unwrap();
        assert_eq!(schema.status, Status::Err);
        assert!(schema.detail.contains("missing tables"));
        assert!(schema.hint.as_ref().unwrap().contains("cache.db"));
    }

    #[test]
    fn empty_index_with_markdown_emits_stale_warn() {
        let mut facts = healthy_facts();
        facts.page_count = 0;
        facts.has_markdown = true;
        let results = evaluate_index(&facts);
        let stale = results.iter().find(|r| r.name == "stale").unwrap();
        assert_eq!(stale.status, Status::Warn);
        assert!(
            stale
                .detail
                .contains("index empty but vault contains markdown")
        );
    }

    #[test]
    fn empty_index_no_markdown_no_stale_warn() {
        let mut facts = healthy_facts();
        facts.page_count = 0;
        facts.has_markdown = false;
        let results = evaluate_index(&facts);
        assert!(!results.iter().any(|r| r.name == "stale"));
    }

    #[test]
    fn counts_detail_format_matches_original() {
        let facts = healthy_facts();
        let results = evaluate_index(&facts);
        let counts = results.iter().find(|r| r.name == "counts").unwrap();
        assert_eq!(counts.detail, "5 pages, 1 unresolved links, 5 fts rows");
    }
}

#[cfg(test)]
mod evaluate_vault_tests {
    use super::*;
    use std::path::PathBuf;

    fn healthy_facts() -> VaultFacts {
        VaultFacts {
            vault_root: PathBuf::from("/vault"),
            root_exists: true,
            root_is_dir: true,
            root_writable: true,
            dot_dir_exists: true,
            config_load: Some(Ok(())),
            excluded_count: 2,
            bad_globs: Vec::new(),
            attachment_folder: "_attachments".to_string(),
            attach_exists: true,
            default_page_folder: "notes".to_string(),
            default_folder_exists: true,
        }
    }

    #[test]
    fn healthy_vault_should_open_true_no_errors() {
        let facts = healthy_facts();
        let (results, should_open) = evaluate_vault(&facts);
        assert!(should_open);
        assert!(
            results
                .iter()
                .all(|r| r.status == Status::Ok || r.status == Status::Info)
        );
    }

    #[test]
    fn root_not_exists_should_open_false_with_err() {
        let mut facts = healthy_facts();
        facts.root_exists = false;
        let (results, should_open) = evaluate_vault(&facts);
        assert!(!should_open);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].status, Status::Err);
        assert!(results[0].detail.contains("does not exist"));
        assert!(results[0].hint.as_ref().unwrap().contains("clepsydra init"));
    }

    #[test]
    fn root_not_dir_should_open_false_with_err() {
        let mut facts = healthy_facts();
        facts.root_is_dir = false;
        let (results, should_open) = evaluate_vault(&facts);
        assert!(!should_open);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].status, Status::Err);
        assert!(results[0].detail.contains("is not a directory"));
    }

    #[test]
    fn config_load_none_is_loud_and_aborts() {
        // Defensive invariant-violation arm: dot_dir present but config_load None.
        let mut facts = healthy_facts();
        facts.config_load = None;
        let (results, should_open) = evaluate_vault(&facts);
        assert!(!should_open);
        let config = results
            .iter()
            .find(|r| r.name == "config")
            .expect("a config diagnostic should be emitted");
        assert_eq!(config.status, Status::Err);
    }

    #[test]
    fn root_not_writable_emits_warn_and_continues() {
        let mut facts = healthy_facts();
        facts.root_writable = false;
        let (results, should_open) = evaluate_vault(&facts);
        assert!(should_open);
        let root_r = results.iter().find(|r| r.name == "root").unwrap();
        assert_eq!(root_r.status, Status::Warn);
        assert!(root_r.detail.contains("is not writable"));
    }

    #[test]
    fn dot_dir_missing_should_open_false_with_err() {
        let mut facts = healthy_facts();
        facts.dot_dir_exists = false;
        let (results, should_open) = evaluate_vault(&facts);
        assert!(!should_open);
        let init_r = results.iter().find(|r| r.name == "initialized").unwrap();
        assert_eq!(init_r.status, Status::Err);
        assert!(init_r.hint.as_ref().unwrap().contains("clepsydra init"));
    }

    #[test]
    fn config_load_error_should_open_false_with_err() {
        let mut facts = healthy_facts();
        facts.config_load = Some(Err("parse error".to_string()));
        let (results, should_open) = evaluate_vault(&facts);
        assert!(!should_open);
        let cfg_r = results.iter().find(|r| r.name == "config").unwrap();
        assert_eq!(cfg_r.status, Status::Err);
        assert!(cfg_r.detail.contains("parse error"));
    }

    #[test]
    fn bad_globs_emits_err() {
        let mut facts = healthy_facts();
        facts.bad_globs = vec!["[invalid".to_string()];
        let (results, _) = evaluate_vault(&facts);
        let globs_r = results
            .iter()
            .find(|r| r.name == "excluded patterns")
            .unwrap();
        assert_eq!(globs_r.status, Status::Err);
        assert!(globs_r.detail.contains("invalid glob"));
    }

    #[test]
    fn attach_missing_emits_warn() {
        let mut facts = healthy_facts();
        facts.attach_exists = false;
        let (results, _) = evaluate_vault(&facts);
        let attach_r = results.iter().find(|r| r.name == "attachments").unwrap();
        assert_eq!(attach_r.status, Status::Warn);
        assert!(
            attach_r
                .detail
                .contains("missing (will be created on first use)")
        );
    }

    #[test]
    fn default_folder_non_empty_missing_emits_warn() {
        let mut facts = healthy_facts();
        facts.default_folder_exists = false;
        let (results, _) = evaluate_vault(&facts);
        let folder_r = results.iter().find(|r| r.name == "default folder").unwrap();
        assert_eq!(folder_r.status, Status::Warn);
        assert!(folder_r.detail.contains("clepsydra new` will fail"));
    }

    #[test]
    fn default_folder_empty_emits_info() {
        let mut facts = healthy_facts();
        facts.default_page_folder = String::new();
        let (results, _) = evaluate_vault(&facts);
        let folder_r = results.iter().find(|r| r.name == "default folder").unwrap();
        assert_eq!(folder_r.status, Status::Info);
        assert!(folder_r.detail.contains("vault root"));
    }
}

// ---------------------------------------------------------------------------
// Renderer tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod render_tests {
    use super::*;

    #[test]
    fn render_json_contains_summary_and_check_name() {
        let mut report = Report::default();
        report.push(ok("mysect", "mycheck", "all good"));
        report.push(warn("mysect", "otherwarn", "heads up"));

        let mut buf = Vec::new();
        report.render_json(&mut buf).unwrap();
        let text = String::from_utf8(buf).unwrap();

        assert!(text.contains("\"summary\""));
        assert!(text.contains("mycheck"));
        assert!(text.contains("otherwarn"));
        // Verify it parses as valid JSON.
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert!(v.get("checks").unwrap().is_array());
        assert_eq!(v["checks"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn render_human_contains_hint_and_summary_line() {
        let mut report = Report::default();
        report.push(
            warn("things", "mything", "something is off").with_hint("try doing the other thing"),
        );
        report.push(ok("things", "another", "fine"));

        let mut buf = Vec::new();
        report.render_human(&mut buf).unwrap();
        let text = String::from_utf8(buf).unwrap();

        assert!(text.contains("try doing the other thing"));
        assert!(text.contains("Summary:"));
        assert!(text.contains("things"));
    }

    #[test]
    fn render_human_emits_ansi_styling() {
        let mut report = Report::default();
        report.push(ok("sect", "good", "all clear"));
        report.push(err("sect", "bad", "broken"));

        let mut buf = Vec::new();
        report.render_human(&mut buf).unwrap();
        let text = String::from_utf8(buf).unwrap();

        // `render_human` always emits codes; the AutoStream in the CLI strips
        // them when colour is unwanted. Here (raw buffer) they must be present.
        assert!(text.contains('\u{1b}'), "expected ANSI escapes in output");
        // Green for OK, red for ERR, and the barbican-orange accent (38;2;…)
        // on the section header.
        assert!(text.contains("\u{1b}[32m"), "expected green OK tag");
        assert!(text.contains("\u{1b}[31m"), "expected red ERR tag");
        assert!(
            text.contains("\u{1b}[38;2;238;119;51m"),
            "expected accent-coloured section header"
        );
    }
}
