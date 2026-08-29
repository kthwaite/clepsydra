//! CLI glue for `clep sync …`: talks to a running server when one answers,
//! otherwise runs the engine standalone on the configured vault (D13).
//!
//! Only one process may write the vault at a time, so `clep sync` never runs
//! the engine beside a live server — it asks the server to do the work and
//! renders the answer. Both paths render the same DTOs through the same
//! functions, so the output does not depend on which one ran.

use std::fmt::Write as _;
use std::path::Path;
use std::time::Duration;

use crate::api::sync::{SyncReportDto, SyncStatusDto};
use crate::mcp::client::{ApiCallError, ApiClient};
use crate::mcp::configured_api_client;
use crate::vault::gitsync::Author;
use crate::vault::gitsync::engine::SyncEngine;
use crate::vault::gitsync::git::Git;
use crate::vault::gitsync::init::{
    InitOpts, InitReport, LfsPolicy, PromptFn, init, probe_lfs_remote,
};

/// Rendered command output plus the process exit code that goes with it.
pub struct RenderedSync {
    pub lines: String,
    pub exit_code: i32,
}

/// Column the value of every `clep sync` row starts in.
const REPORT_INDENT: &str = "           ";

/// How long `clep sync` waits on the server's `POST /api/vault/sync`.
///
/// A sync is one HTTP request that holds the vault still while it commits,
/// fetches, merges and pushes; on a large vault over a slow remote that is
/// minutes of honest work. The client's ordinary 30 s budget would abandon the
/// request — reporting a failure for a sync the server went on to finish.
const SYNC_REQUEST_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// `Ok(Some(client))` when a server answers `/api/vault/uptime`, `Ok(None)`
/// when nothing listens on the configured address, `Err` for any other
/// failure (bad config, non-loopback host, …).
pub async fn reachable_server(cwd: &Path) -> Result<Option<ApiClient>, Box<dyn std::error::Error>> {
    let client = configured_api_client(cwd, false)?;
    match client.get_json("/api/vault/uptime", &[]).await {
        Ok(_) => Ok(Some(client)),
        Err(ApiCallError::Unreachable { .. }) => Ok(None),
        Err(other) => Err(Box::new(other)),
    }
}

pub struct InitArgs {
    pub remote: Option<String>,
    pub author_name: Option<String>,
    pub author_email: Option<String>,
}

/// `clep sync init`: refuse while a server is running (it, not this
/// process, owns the vault then), probe `--remote` for LFS support up
/// front, then run [`init`] standalone via `spawn_blocking`.
pub async fn run_init(args: InitArgs) -> Result<InitReport, Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()?;
    if reachable_server(&cwd).await?.is_some() {
        return Err(
            "a clepsydra server is running on the configured address; stop `clep serve` before `clep sync init`"
                .into(),
        );
    }
    if let Some(url) = args.remote.as_deref() {
        probe_lfs_remote(url).await?;
    }
    let vault = crate::open_vault()?;
    let author = match (args.author_name, args.author_email) {
        (Some(name), Some(email)) => Some(Author { name, email }),
        (None, None) => None,
        _ => return Err("pass both --author-name and --author-email, or neither".into()),
    };
    let prompt: Option<Box<PromptFn>> = if std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        Some(Box::new(|question: &str| {
            use std::io::Write as _;
            print!("{question}");
            std::io::stdout().flush().ok()?;
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).ok()?;
            let line = line.trim().to_string();
            (!line.is_empty()).then_some(line)
        }))
    } else {
        None
    };
    let git = Git::new(vault.root());
    let legacy_cas = crate::vault::cas_migrate::legacy_store_with_blobs();
    let report = tokio::task::spawn_blocking(move || {
        init(
            &vault,
            &git,
            InitOpts {
                remote: args.remote,
                author,
                lfs: LfsPolicy::Required,
                prompt,
                legacy_cas,
            },
        )
    })
    .await??;
    Ok(report)
}

/// `clep sync`: one whole sync, run by the server when one answers and
/// standalone otherwise.
pub async fn run_sync() -> Result<RenderedSync, Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()?;
    let report = match reachable_server(&cwd).await? {
        Some(client) => {
            let value = client
                .with_timeout(SYNC_REQUEST_TIMEOUT)?
                .post_json("/api/vault/sync", &serde_json::json!({}))
                .await?;
            serde_json::from_value::<SyncReportDto>(value)?
        }
        None => {
            let vault = crate::open_vault()?;
            let engine = SyncEngine::open(&vault)?;
            let report = tokio::task::spawn_blocking(move || engine.full_sync()).await??;
            SyncReportDto::from(&report)
        }
    };
    Ok(RenderedSync {
        lines: render_report(&report),
        exit_code: exit_code(&report),
    })
}

/// `clep sync status`: read-only, and read from the server when one answers
/// so its in-memory autocommit state is included.
pub async fn run_status() -> Result<RenderedSync, Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()?;
    let (status, from_server) = match reachable_server(&cwd).await? {
        Some(client) => {
            let value = client.get_json("/api/vault/sync/status", &[]).await?;
            (serde_json::from_value::<SyncStatusDto>(value)?, true)
        }
        None => {
            let vault = crate::open_vault()?;
            let engine = SyncEngine::open(&vault)?;
            let status = tokio::task::spawn_blocking(move || engine.status()).await??;
            // Nothing is running, so nothing can be pending or in progress.
            (SyncStatusDto::from_status(&status, false, false), false)
        }
    };
    if !status.initialised {
        return Err(
            "sync is not initialised for this vault — run `clep sync init`"
                .to_string()
                .into(),
        );
    }
    Ok(RenderedSync {
        lines: render_status(&status, from_server),
        exit_code: status_exit_code(&status),
    })
}

/// `1` when the fetch or the push did not do what it was asked. Conflict
/// Copies are a success — they are how a conflict is meant to end (ADR 0004).
pub fn exit_code(report: &SyncReportDto) -> i32 {
    let failed =
        report.merge == "fetch_failed" || report.push == "rejected" || report.push == "failed";
    i32::from(failed)
}

/// `1` when the tree still holds unmerged paths — the one status a sync
/// should never leave behind.
pub fn status_exit_code(status: &SyncStatusDto) -> i32 {
    i32::from(!status.initialised || status.unmerged_files > 0)
}

/// The first seven characters of a sha, or the whole thing when it is
/// shorter. Character-wise, not byte-wise: these strings can come back from a
/// server, and a renderer must not panic on one that is not a sha.
fn short(sha: &str) -> &str {
    match sha.char_indices().nth(7) {
        Some((end, _)) => &sha[..end],
        None => sha,
    }
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

fn detail_or(detail: Option<&String>, fallback: &str) -> String {
    detail.map_or_else(
        || fallback.to_string(),
        |detail| detail.lines().next().unwrap_or(fallback).to_string(),
    )
}

/// One aligned row per phase: what was committed, what the merge did (with
/// each Conflict Copy named beneath it), what the push did, and any warnings.
pub fn render_report(report: &SyncReportDto) -> String {
    let mut out = String::new();

    match &report.committed {
        Some(sha) => {
            let _ = writeln!(
                out,
                "committed: {} file{} ({})",
                report.files_committed,
                plural(report.files_committed),
                short(sha)
            );
        }
        None => {
            let _ = writeln!(out, "committed: nothing to commit");
        }
    }

    let merge = match report.merge.as_str() {
        "no_remote" => "no remote".to_string(),
        "fetch_failed" => format!(
            "fetch failed: {}",
            detail_or(report.merge_detail.as_ref(), "unknown error")
        ),
        "not_fetched" => "no fetch (shutdown push)".to_string(),
        "up_to_date" => "up to date".to_string(),
        "fast_forward" => format!(
            "fast-forward ({})",
            short(&detail_or(report.merge_detail.as_ref(), "?"))
        ),
        "merged" => {
            let head = short(&detail_or(report.merge_detail.as_ref(), "?")).to_string();
            if report.conflict_copies.is_empty() {
                format!("merged ({head})")
            } else {
                let count = report.conflict_copies.len();
                format!(
                    "merged ({head}), {count} conflict cop{}:",
                    if count == 1 { "y" } else { "ies" }
                )
            }
        }
        other => other.to_string(),
    };
    let _ = writeln!(out, "merge:     {merge}");
    for copy in &report.conflict_copies {
        let _ = writeln!(out, "{REPORT_INDENT}- {} → {}", copy.original, copy.copy);
    }

    let push = match report.push.as_str() {
        "not_attempted" => "not attempted".to_string(),
        "nothing_to_push" => "nothing to push".to_string(),
        "pushed" => "pushed".to_string(),
        "rejected" => format!(
            "rejected: {}",
            detail_or(report.push_detail.as_ref(), "unknown reason")
        ),
        "failed" => format!(
            "failed: {}",
            detail_or(report.push_detail.as_ref(), "unknown reason")
        ),
        other => other.to_string(),
    };
    let _ = writeln!(out, "push:      {push}");

    for (i, warning) in report.warnings.iter().enumerate() {
        let label = if i == 0 { "warnings:  " } else { REPORT_INDENT };
        let _ = writeln!(out, "{label}{warning}");
    }

    out
}

/// One aligned row per fact `clep sync status` reports. `from_server` adds
/// the autocommit row, which only a running server can answer.
pub fn render_status(status: &SyncStatusDto, from_server: bool) -> String {
    let mut out = String::new();

    match &status.head {
        Some(head) => {
            let _ = writeln!(
                out,
                "branch:          {} (head {})",
                status.branch,
                short(head)
            );
        }
        None => {
            let _ = writeln!(out, "branch:          {} (no commits yet)", status.branch);
        }
    }
    let _ = writeln!(
        out,
        "remote:          {}",
        status.remote.as_deref().unwrap_or("none")
    );
    match (status.ahead, status.behind) {
        (Some(ahead), Some(behind)) => {
            let _ = writeln!(out, "ahead/behind:    {ahead} / {behind}");
        }
        _ => {
            let _ = writeln!(out, "ahead/behind:    unknown (no upstream)");
        }
    }

    let mut worktree = Vec::new();
    if status.dirty_files > 0 {
        worktree.push(format!(
            "{} uncommitted file{}",
            status.dirty_files,
            plural(status.dirty_files)
        ));
    }
    if status.unmerged_files > 0 {
        worktree.push(format!(
            "{} unmerged file{} (!)",
            status.unmerged_files,
            plural(status.unmerged_files)
        ));
    }
    if worktree.is_empty() {
        worktree.push("clean".to_string());
    }
    let _ = writeln!(out, "worktree:        {}", worktree.join(", "));
    let _ = writeln!(out, "conflict copies: {}", status.conflict_copies);

    match status.last_sync_at {
        Some(at) => {
            let _ = writeln!(
                out,
                "last sync:       {} — {}",
                at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                status.last_sync_result.as_deref().unwrap_or("unknown")
            );
        }
        None => {
            let _ = writeln!(out, "last sync:       never");
        }
    }

    if from_server {
        let autocommit = if status.pending_autocommit {
            "pending"
        } else {
            "idle"
        };
        let running = if status.syncing {
            " (sync running)"
        } else {
            ""
        };
        let _ = writeln!(out, "autocommit:      {autocommit}{running}");
    }

    out
}

/// One line per report field; each warning gets its own `warning: …` line.
pub fn render_init(report: &InitReport) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "repository: {}",
        if report.created_repo {
            "created"
        } else {
            "adopted"
        }
    );
    let _ = writeln!(out, "branch: {}", report.branch);
    let _ = writeln!(
        out,
        ".gitignore: {} managed line(s) added",
        report.gitignore_added
    );
    let _ = writeln!(
        out,
        ".gitattributes: {} managed line(s) added",
        report.gitattributes_added
    );
    let _ = writeln!(
        out,
        "author: {} <{}>",
        report.author.name, report.author.email
    );
    let _ = writeln!(
        out,
        "remote: {}",
        report.remote.as_deref().unwrap_or("(none)")
    );
    let _ = writeln!(out, "lfs: {}", report.lfs);
    let _ = writeln!(out, "cas migration: {}", report.cas_migration);
    let _ = writeln!(
        out,
        "initial commit: {}",
        report
            .initial_commit
            .as_deref()
            .unwrap_or("(none — nothing to commit)")
    );
    for warning in &report.warnings {
        let _ = writeln!(out, "warning: {warning}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::sync::ConflictCopyDto;
    use crate::vault::gitsync::Author;

    fn report(warnings: Vec<String>) -> InitReport {
        InitReport {
            created_repo: true,
            branch: "main".to_string(),
            gitignore_added: 9,
            gitattributes_added: 3,
            author: Author {
                name: "Kit".to_string(),
                email: "kit@example.com".to_string(),
            },
            remote: Some("git@github.com:o/r.git".to_string()),
            lfs: "git-lfs 3.5.0".to_string(),
            cas_migration: "skipped: no legacy store".to_string(),
            initial_commit: Some("abc123".to_string()),
            warnings,
        }
    }

    #[test]
    fn render_init_prints_one_line_per_field() {
        let rendered = render_init(&report(Vec::new()));
        assert!(rendered.contains("repository: created"));
        assert!(rendered.contains("branch: main"));
        assert!(rendered.contains(".gitignore: 9 managed line(s) added"));
        assert!(rendered.contains(".gitattributes: 3 managed line(s) added"));
        assert!(rendered.contains("author: Kit <kit@example.com>"));
        assert!(rendered.contains("remote: git@github.com:o/r.git"));
        assert!(rendered.contains("lfs: git-lfs 3.5.0"));
        assert!(rendered.contains("cas migration: skipped: no legacy store"));
        assert!(rendered.contains("initial commit: abc123"));
        assert!(!rendered.contains("warning:"));
    }

    #[test]
    fn render_init_prefixes_every_warning() {
        let rendered = render_init(&report(vec!["blob xyz missing".to_string()]));
        assert!(rendered.contains("warning: blob xyz missing"));
    }

    fn report_dto() -> SyncReportDto {
        SyncReportDto {
            committed: Some("abc1234def".to_string()),
            files_committed: 3,
            merge: "merged".to_string(),
            merge_detail: Some("0123abc9876".to_string()),
            conflict_copies: vec![ConflictCopyDto {
                original: "notes/p.md".to_string(),
                copy: "notes/p.conflict.ab12cd3.md".to_string(),
            }],
            push: "pushed".to_string(),
            push_detail: None,
            warnings: vec!["could not record sync state".to_string()],
            duration_ms: 1_234,
        }
    }

    fn status_dto() -> SyncStatusDto {
        SyncStatusDto {
            initialised: true,
            branch: "main".to_string(),
            remote: Some("git@github.com:o/r.git".to_string()),
            head: Some("abc1234def".to_string()),
            ahead: Some(1),
            behind: Some(0),
            dirty_files: 3,
            unmerged_files: 0,
            conflict_copies: 0,
            last_sync_at: Some(
                chrono::DateTime::parse_from_rfc3339("2026-08-28T18:20:11Z")
                    .unwrap()
                    .with_timezone(&chrono::Utc),
            ),
            last_sync_result: Some("ok".to_string()),
            pending_autocommit: false,
            syncing: false,
        }
    }

    #[test]
    fn render_report_uses_the_documented_layout() {
        let rendered = render_report(&report_dto());
        assert!(
            rendered.contains("committed: 3 files (abc1234)"),
            "{rendered}"
        );
        assert!(rendered.contains("merge:     merged ("), "{rendered}");
        assert!(rendered.contains("1 conflict copy"), "{rendered}");
        assert!(
            rendered.contains("notes/p.md → notes/p.conflict."),
            "{rendered}"
        );
        assert!(rendered.contains("push:      pushed"), "{rendered}");
        assert!(
            rendered.contains("warnings:  could not record sync state"),
            "{rendered}"
        );
    }

    #[test]
    fn render_report_names_the_quiet_outcomes() {
        let mut dto = report_dto();
        dto.committed = None;
        dto.files_committed = 0;
        dto.merge = "up_to_date".to_string();
        dto.merge_detail = None;
        dto.conflict_copies.clear();
        dto.push = "nothing_to_push".to_string();
        dto.warnings.clear();
        let rendered = render_report(&dto);
        assert!(
            rendered.contains("committed: nothing to commit"),
            "{rendered}"
        );
        assert!(rendered.contains("merge:     up to date"), "{rendered}");
        assert!(
            rendered.contains("push:      nothing to push"),
            "{rendered}"
        );
        assert!(!rendered.contains("warnings:"), "{rendered}");

        // The shutdown path pushes without fetching, and says so rather than
        // claiming to be up to date with a remote it never asked.
        dto.merge = "not_fetched".to_string();
        let rendered = render_report(&dto);
        assert!(
            rendered.contains("merge:     no fetch (shutdown push)"),
            "{rendered}"
        );
        assert_eq!(exit_code(&dto), 0, "a shutdown push is not a failure");
    }

    #[test]
    fn exit_code_is_one_only_for_a_failed_fetch_or_push() {
        assert_eq!(exit_code(&report_dto()), 0);

        let mut fetch_failed = report_dto();
        fetch_failed.merge = "fetch_failed".to_string();
        assert_eq!(exit_code(&fetch_failed), 1);

        let mut rejected = report_dto();
        rejected.push = "rejected".to_string();
        assert_eq!(exit_code(&rejected), 1);

        let mut failed = report_dto();
        failed.push = "failed".to_string();
        assert_eq!(exit_code(&failed), 1);
    }

    #[test]
    fn render_status_uses_the_documented_layout() {
        let rendered = render_status(&status_dto(), true);
        assert!(
            rendered.contains("branch:          main (head abc1234)"),
            "{rendered}"
        );
        assert!(
            rendered.contains("remote:          git@github.com:o/r.git"),
            "{rendered}"
        );
        assert!(rendered.contains("ahead/behind:    1 / 0"), "{rendered}");
        assert!(
            rendered.contains("worktree:        3 uncommitted files"),
            "{rendered}"
        );
        assert!(rendered.contains("conflict copies: 0"), "{rendered}");
        assert!(
            rendered.contains("last sync:       2026-08-28T18:20:11Z — ok"),
            "{rendered}"
        );
        assert!(rendered.contains("autocommit:      idle"), "{rendered}");
    }

    #[test]
    fn render_status_omits_server_only_rows_when_standalone() {
        let mut dto = status_dto();
        dto.remote = None;
        dto.ahead = None;
        dto.behind = None;
        dto.dirty_files = 0;
        dto.unmerged_files = 1;
        dto.last_sync_at = None;
        dto.last_sync_result = None;
        let rendered = render_status(&dto, false);
        assert!(rendered.contains("remote:          none"), "{rendered}");
        assert!(
            rendered.contains("ahead/behind:    unknown (no upstream)"),
            "{rendered}"
        );
        assert!(
            rendered.contains("worktree:        1 unmerged file (!)"),
            "{rendered}"
        );
        assert!(rendered.contains("last sync:       never"), "{rendered}");
        assert!(!rendered.contains("autocommit:"), "{rendered}");
    }

    #[test]
    fn status_exit_code_flags_unmerged_files() {
        assert_eq!(status_exit_code(&status_dto()), 0);
        let mut unmerged = status_dto();
        unmerged.unmerged_files = 2;
        assert_eq!(status_exit_code(&unmerged), 1);
    }
}
