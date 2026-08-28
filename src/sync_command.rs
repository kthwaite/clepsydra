//! CLI glue for `clep sync …`: talks to a running server when one answers,
//! otherwise runs the engine standalone on the configured vault.
//!
//! `run_init` is the only entry point wired up so far (Task 3); the
//! server-or-standalone split (D13) for `clep sync` / `clep sync status`
//! arrives in a later task.

use std::path::Path;

use crate::mcp::client::{ApiCallError, ApiClient};
use crate::mcp::configured_api_client;
use crate::vault::gitsync::Author;
use crate::vault::gitsync::git::Git;
use crate::vault::gitsync::init::{
    InitOpts, InitReport, LfsPolicy, PromptFn, init, probe_lfs_remote,
};

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
    let report = tokio::task::spawn_blocking(move || {
        init(
            &vault,
            &git,
            InitOpts {
                remote: args.remote,
                author,
                lfs: LfsPolicy::Required,
                prompt,
            },
        )
    })
    .await??;
    Ok(report)
}

/// One line per report field; each warning gets its own `warning: …` line.
pub fn render_init(report: &InitReport) -> String {
    use std::fmt::Write as _;
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
}
