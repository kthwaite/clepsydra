//! Subprocess wrapper around the system `git` binary.
//!
//! Every invocation runs as `git -C <root> -c http.lowSpeedLimit=… -c
//! http.lowSpeedTime=… <args>` with the D2 environment defaults:
//! `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, and [`SSH_COMMAND_DEFAULT`] unless
//! the calling process already sets `GIT_SSH_COMMAND`. Between them, the
//! `-c` overrides and the ssh options are what stops an unreachable remote
//! from holding a sync window open indefinitely — git has no timeout of its
//! own. Tests layer `GIT_CONFIG_GLOBAL` /
//! `GIT_CONFIG_NOSYSTEM` on top via [`super::testing::git`] so the user's
//! real global git config never influences a test.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use thiserror::Error;

use super::Author;

/// `GIT_SSH_COMMAND` when the calling process does not set one. `BatchMode`
/// keeps ssh from prompting; the rest bound how long an unreachable or gone-
/// silent host can hold a sync window open: 30 s to connect, then keepalive
/// probes every 15 s and four unanswered probes (≈60 s) before ssh gives up.
const SSH_COMMAND_DEFAULT: &str =
    "ssh -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4";

/// `-c key=value` overrides carried by every invocation. They are git's only
/// timeout for HTTP transports: a fetch or push moving under 1 KiB/s for a
/// minute is aborted rather than left to stall the sync window for ever.
const NETWORK_CONFIG: [&str; 2] = ["http.lowSpeedLimit=1024", "http.lowSpeedTime=60"];

/// Thin, synchronous wrapper around `git -C <root> <args>`.
#[derive(Debug, Clone)]
pub struct Git {
    root: PathBuf,
    program: String,
    env: Vec<(String, String)>,
}

impl Git {
    /// A `Git` rooted at `root`, with the D2 environment defaults.
    pub fn new(root: &Path) -> Self {
        let mut env = vec![
            ("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()),
            ("LC_ALL".to_string(), "C".to_string()),
        ];
        if std::env::var_os("GIT_SSH_COMMAND").is_none() {
            env.push((
                "GIT_SSH_COMMAND".to_string(),
                SSH_COMMAND_DEFAULT.to_string(),
            ));
        }
        Self {
            root: root.to_path_buf(),
            program: "git".to_string(),
            env,
        }
    }

    /// Layer an extra environment variable on top of the current set. A
    /// repeated key wins over any earlier value for that key (see
    /// [`Git::env_value`]).
    pub fn with_env(mut self, key: &str, value: &str) -> Self {
        self.env.push((key.to_string(), value.to_string()));
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The value that would be passed to the subprocess for `key` — the
    /// last one set via [`Git::new`] or [`Git::with_env`]. Used by tests and
    /// the doctor.
    pub fn env_value(&self, key: &str) -> Option<String> {
        self.env
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    }

    /// The arguments that precede every subcommand: the repository root and
    /// the [`NETWORK_CONFIG`] overrides. Test-only window onto what
    /// [`Git::command`] builds; production code never needs it.
    #[cfg(test)]
    pub(crate) fn base_args(&self) -> Vec<String> {
        let mut args = vec!["-C".to_string(), self.root.to_string_lossy().into_owned()];
        args.extend(Self::network_args());
        args
    }

    fn network_args() -> impl Iterator<Item = String> {
        NETWORK_CONFIG
            .into_iter()
            .flat_map(|setting| ["-c".to_string(), setting.to_string()])
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(&self.program);
        cmd.arg("-C")
            .arg(&self.root)
            .args(Self::network_args())
            .args(args)
            .stdin(Stdio::null());
        for (key, value) in &self.env {
            cmd.env(key, value);
        }
        cmd
    }

    fn spawn(cmd: &mut Command) -> Result<Output, GitError> {
        cmd.output().map_err(GitError::Spawn)
    }

    /// `git --version`. Does not need a repo root.
    pub fn version() -> Result<String, GitError> {
        let mut cmd = Command::new("git");
        cmd.arg("--version").stdin(Stdio::null());
        let output = Self::spawn(&mut cmd)?;
        let status = output.status.code().unwrap_or(-1);
        if status != 0 {
            return Err(GitError::Failed {
                args: "--version".to_string(),
                status,
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }
        String::from_utf8(output.stdout)
            .map(|s| s.trim_end().to_string())
            .map_err(|_| GitError::Utf8 {
                args: "--version".to_string(),
            })
    }

    /// Run `git <args>`, returning trimmed stdout. A non-zero exit becomes
    /// [`GitError::Failed`].
    pub fn run(&self, args: &[&str]) -> Result<String, GitError> {
        let raw = self.run_raw(args)?;
        if raw.status != 0 {
            return Err(GitError::Failed {
                args: args.join(" "),
                status: raw.status,
                stderr: raw.stderr,
            });
        }
        Ok(raw.stdout.trim_end().to_string())
    }

    /// Run `git <args>`, never mapping the exit status to an error. Callers
    /// inspect [`RawOutput::status`] themselves.
    pub fn run_raw(&self, args: &[&str]) -> Result<RawOutput, GitError> {
        let output = Self::spawn(&mut self.command(args))?;
        let status = output.status.code().unwrap_or(-1);
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        let stdout = String::from_utf8(output.stdout).map_err(|_| GitError::Utf8 {
            args: args.join(" "),
        })?;
        Ok(RawOutput {
            status,
            stdout,
            stderr,
        })
    }

    /// Run `git <args>`, returning raw stdout bytes. A non-zero exit becomes
    /// [`GitError::Failed`].
    pub fn run_bytes(&self, args: &[&str]) -> Result<Vec<u8>, GitError> {
        let output = Self::spawn(&mut self.command(args))?;
        let status = output.status.code().unwrap_or(-1);
        if status != 0 {
            return Err(GitError::Failed {
                args: args.join(" "),
                status,
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }
        Ok(output.stdout)
    }

    /// `Some(root)` when `self.root` is inside a git repository, `None`
    /// otherwise.
    pub fn toplevel(&self) -> Result<Option<PathBuf>, GitError> {
        let raw = self.run_raw(&["rev-parse", "--show-toplevel"])?;
        if raw.status == 0 {
            return Ok(Some(PathBuf::from(raw.stdout.trim())));
        }
        if raw.status == 128 && raw.stderr.contains("not a git repository") {
            return Ok(None);
        }
        Err(GitError::Failed {
            args: "rev-parse --show-toplevel".to_string(),
            status: raw.status,
            stderr: raw.stderr,
        })
    }

    /// `git init -q -b <branch>`.
    pub fn init(&self, branch: &str) -> Result<(), GitError> {
        self.run(&["init", "-q", "-b", branch]).map(|_| ())
    }

    /// `None` when HEAD is detached or unborn.
    pub fn current_branch(&self) -> Result<Option<String>, GitError> {
        let raw = self.run_raw(&["symbolic-ref", "--short", "-q", "HEAD"])?;
        match raw.status {
            0 => Ok(Some(raw.stdout.trim().to_string())),
            1 => Ok(None),
            _ => Err(GitError::Failed {
                args: "symbolic-ref --short -q HEAD".to_string(),
                status: raw.status,
                stderr: raw.stderr,
            }),
        }
    }

    /// `None` when HEAD is unborn (no commits yet).
    pub fn head(&self) -> Result<Option<String>, GitError> {
        self.rev_parse("HEAD")
    }

    /// `git rev-parse -q --verify <reference>`. `None` when `reference`
    /// does not resolve.
    pub fn rev_parse(&self, reference: &str) -> Result<Option<String>, GitError> {
        let raw = self.run_raw(&["rev-parse", "-q", "--verify", reference])?;
        match raw.status {
            0 => Ok(Some(raw.stdout.trim().to_string())),
            1 => Ok(None),
            _ => Err(GitError::Failed {
                args: format!("rev-parse -q --verify {reference}"),
                status: raw.status,
                stderr: raw.stderr,
            }),
        }
    }

    pub fn config_get(&self, key: &str) -> Result<Option<String>, GitError> {
        let raw = self.run_raw(&["config", "--get", key])?;
        match raw.status {
            0 => Ok(Some(raw.stdout.trim_end().to_string())),
            1 => Ok(None),
            _ => Err(GitError::Failed {
                args: format!("config --get {key}"),
                status: raw.status,
                stderr: raw.stderr,
            }),
        }
    }

    /// `git config --local <key> <value>`.
    pub fn config_set(&self, key: &str, value: &str) -> Result<(), GitError> {
        self.run(&["config", "--local", key, value]).map(|_| ())
    }

    pub fn global_config_get(&self, key: &str) -> Result<Option<String>, GitError> {
        let raw = self.run_raw(&["config", "--global", "--get", key])?;
        match raw.status {
            0 => Ok(Some(raw.stdout.trim_end().to_string())),
            1 => Ok(None),
            _ => Err(GitError::Failed {
                args: format!("config --global --get {key}"),
                status: raw.status,
                stderr: raw.stderr,
            }),
        }
    }

    pub fn remote_url(&self, name: &str) -> Result<Option<String>, GitError> {
        let raw = self.run_raw(&["remote", "get-url", name])?;
        match raw.status {
            0 => Ok(Some(raw.stdout.trim_end().to_string())),
            2 | 128 => Ok(None),
            _ => Err(GitError::Failed {
                args: format!("remote get-url {name}"),
                status: raw.status,
                stderr: raw.stderr,
            }),
        }
    }

    pub fn remote_add(&self, name: &str, url: &str) -> Result<(), GitError> {
        self.run(&["remote", "add", name, url]).map(|_| ())
    }

    /// `git status --porcelain=v1 -z --untracked-files=all`, one entry per
    /// file (never per directory).
    pub fn status(&self) -> Result<Vec<StatusEntry>, GitError> {
        let bytes = self.run_bytes(&["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
        let text = String::from_utf8(bytes).map_err(|_| GitError::Utf8 {
            args: "status --porcelain=v1 -z --untracked-files=all".to_string(),
        })?;
        let mut fields = text.split('\0').filter(|s| !s.is_empty());
        let mut entries = Vec::new();
        while let Some(field) = fields.next() {
            let mut chars = field.chars();
            let x = chars.next().unwrap_or(' ');
            let y = chars.next().unwrap_or(' ');
            // Byte 2 is the separating space; the path starts at byte 3.
            // XY codes are always ASCII, so byte indexing here is safe.
            let path = field.get(3..).unwrap_or("").to_string();
            if x == 'R' || x == 'C' {
                // Renames/copies carry the original path as the next NUL
                // field; we only need the current path.
                fields.next();
            }
            entries.push(StatusEntry { xy: [x, y], path });
        }
        Ok(entries)
    }

    pub fn add_all(&self) -> Result<(), GitError> {
        self.run(&["add", "-A"]).map(|_| ())
    }

    pub fn add(&self, paths: &[&str]) -> Result<(), GitError> {
        let mut args = vec!["add", "--"];
        args.extend_from_slice(paths);
        self.run(&args).map(|_| ())
    }

    /// `git add -A -- <paths>`: stage each path as the working tree has it,
    /// including its removal when the file is gone. `add` alone refuses a
    /// path that no longer exists.
    pub fn add_including_removals(&self, paths: &[&str]) -> Result<(), GitError> {
        let mut args = vec!["add", "-A", "--"];
        args.extend_from_slice(paths);
        self.run(&args).map(|_| ())
    }

    /// `git commit -q -m <message>` under `author`'s identity for both the
    /// author and committer. Returns the new commit's sha.
    pub fn commit(&self, message: &str, author: &Author) -> Result<String, GitError> {
        let mut cmd = self.command(&["commit", "-q", "-m", message]);
        cmd.env("GIT_AUTHOR_NAME", &author.name)
            .env("GIT_AUTHOR_EMAIL", &author.email)
            .env("GIT_COMMITTER_NAME", &author.name)
            .env("GIT_COMMITTER_EMAIL", &author.email);
        let output = Self::spawn(&mut cmd)?;
        let status = output.status.code().unwrap_or(-1);
        if status != 0 {
            return Err(GitError::Failed {
                args: "commit -q -m <message>".to_string(),
                status,
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }
        self.head()?.ok_or_else(|| GitError::Failed {
            args: "commit -q -m <message>".to_string(),
            status: 0,
            stderr: "HEAD is unresolved after a successful commit".to_string(),
        })
    }

    pub fn fetch(&self, remote: &str, branch: &str) -> Result<(), GitError> {
        self.run(&["fetch", "-q", remote, branch]).map(|_| ())
    }

    /// `git merge --no-commit --no-edit <reference>`. Never maps the exit
    /// status to an error — callers branch on `MERGE_HEAD` / unmerged paths.
    pub fn merge_no_commit(&self, reference: &str) -> Result<RawOutput, GitError> {
        self.run_raw(&["merge", "--no-commit", "--no-edit", reference])
    }

    pub fn merge_head(&self) -> Result<Option<String>, GitError> {
        self.rev_parse("MERGE_HEAD")
    }

    pub fn abort_merge(&self) -> Result<(), GitError> {
        self.run(&["merge", "--abort"]).map(|_| ())
    }

    /// `git ls-files -u -z`, grouped per path. `stages[n]` is `true` when
    /// stage `n` (1=base, 2=ours, 3=theirs) is present; index 0 is unused.
    pub fn unmerged(&self) -> Result<Vec<UnmergedEntry>, GitError> {
        let bytes = self.run_bytes(&["ls-files", "-u", "-z"])?;
        let text = String::from_utf8(bytes).map_err(|_| GitError::Utf8 {
            args: "ls-files -u -z".to_string(),
        })?;
        let mut order: Vec<String> = Vec::new();
        let mut by_path: HashMap<String, [bool; 4]> = HashMap::new();
        for record in text.split('\0').filter(|s| !s.is_empty()) {
            let Some((meta, path)) = record.split_once('\t') else {
                continue;
            };
            let stage: usize = meta
                .split(' ')
                .nth(2)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let entry = by_path.entry(path.to_string()).or_insert_with(|| {
                order.push(path.to_string());
                [false; 4]
            });
            if stage < 4 {
                entry[stage] = true;
            }
        }
        Ok(order
            .into_iter()
            .map(|path| {
                let stages = by_path[&path];
                UnmergedEntry { path, stages }
            })
            .collect())
    }

    pub fn show_stage(&self, stage: u8, path: &str) -> Result<Vec<u8>, GitError> {
        let arg = format!(":{stage}:{path}");
        self.run_bytes(&["show", &arg])
    }

    /// `git checkout --ours|--theirs -- <path>`.
    pub fn checkout_side(&self, side: Side, path: &str) -> Result<(), GitError> {
        let flag = match side {
            Side::Ours => "--ours",
            Side::Theirs => "--theirs",
        };
        self.run(&["checkout", flag, "--", path]).map(|_| ())
    }

    /// `git push -q -u <remote> <branch>`. A rejection (non-fast-forward,
    /// stale, etc.) is reported as [`PushOutcome::Rejected`], never forced.
    pub fn push(&self, remote: &str, branch: &str) -> Result<PushOutcome, GitError> {
        let raw = self.run_raw(&["push", "-q", "-u", remote, branch])?;
        if raw.status == 0 {
            return Ok(PushOutcome::Pushed);
        }
        const REJECT_MARKERS: [&str; 4] = [
            "[rejected]",
            "non-fast-forward",
            "fetch first",
            "failed to push some refs",
        ];
        if REJECT_MARKERS
            .iter()
            .any(|marker| raw.stderr.contains(marker))
        {
            return Ok(PushOutcome::Rejected(raw.stderr));
        }
        Err(GitError::Failed {
            args: format!("push -q -u {remote} {branch}"),
            status: raw.status,
            stderr: raw.stderr,
        })
    }

    /// `(ahead, behind)` of `HEAD` relative to `upstream`. `None` when
    /// `upstream` does not exist (no fetch/upstream yet).
    pub fn ahead_behind(&self, upstream: &str) -> Result<Option<(usize, usize)>, GitError> {
        let range = format!("HEAD...{upstream}");
        let raw = self.run_raw(&["rev-list", "--left-right", "--count", &range])?;
        if raw.status == 128 {
            return Ok(None);
        }
        if raw.status != 0 {
            return Err(GitError::Failed {
                args: format!("rev-list --left-right --count {range}"),
                status: raw.status,
                stderr: raw.stderr,
            });
        }
        let trimmed = raw.stdout.trim();
        let unexpected = || GitError::Failed {
            args: format!("rev-list --left-right --count {range}"),
            status: raw.status,
            stderr: format!("unexpected output: {trimmed:?}"),
        };
        let (ahead, behind) = trimmed.split_once('\t').ok_or_else(unexpected)?;
        let ahead: usize = ahead.parse().map_err(|_| unexpected())?;
        let behind: usize = behind.parse().map_err(|_| unexpected())?;
        Ok(Some((ahead, behind)))
    }

    /// `None` when `git lfs` is not a recognised git command (git-lfs is
    /// not installed).
    pub fn lfs_version(&self) -> Result<Option<String>, GitError> {
        let raw = self.run_raw(&["lfs", "version"])?;
        if raw.status == 0 {
            return Ok(Some(raw.stdout.trim_end().to_string()));
        }
        Ok(None)
    }

    pub fn lfs_install_local(&self) -> Result<(), GitError> {
        self.run(&["lfs", "install", "--local"]).map(|_| ())
    }

    /// `git rev-list --count HEAD`. `0` when HEAD is unborn.
    pub fn log_count(&self) -> Result<usize, GitError> {
        let raw = self.run_raw(&["rev-list", "--count", "HEAD"])?;
        if raw.status != 0 {
            return Ok(0);
        }
        raw.stdout.trim().parse().map_err(|_| GitError::Failed {
            args: "rev-list --count HEAD".to_string(),
            status: raw.status,
            stderr: format!("unexpected output: {:?}", raw.stdout),
        })
    }
}

/// The raw result of a git invocation, exit status included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawOutput {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

/// One entry from `git status --porcelain=v1 -z`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    pub xy: [char; 2],
    pub path: String,
}

/// One unmerged path from `git ls-files -u -z`, with the index stages
/// present for it. `stages[1..=3]` correspond to base/ours/theirs; index 0
/// is unused and always `false`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnmergedEntry {
    pub path: String,
    pub stages: [bool; 4],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Ours,
    Theirs,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushOutcome {
    Pushed,
    Rejected(String),
}

#[derive(Debug, Error)]
pub enum GitError {
    #[error("failed to run git: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("git {args} failed (exit {status}): {stderr}")]
    Failed {
        args: String,
        status: i32,
        stderr: String,
    },
    #[error("git output was not UTF-8 for {args}")]
    Utf8 { args: String },
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;
    use crate::vault::gitsync::testing;

    #[test]
    fn version_reports_git() {
        assert!(Git::version().unwrap().starts_with("git version"));
    }

    #[test]
    fn toplevel_is_none_outside_a_repo_and_root_inside() {
        let tmp = TempDir::new().unwrap();
        let git = testing::git(tmp.path());
        assert_eq!(git.toplevel().unwrap(), None);
        git.init("main").unwrap();
        let top = git.toplevel().unwrap().unwrap();
        assert_eq!(
            top.canonicalize().unwrap(),
            tmp.path().canonicalize().unwrap()
        );
        assert_eq!(git.current_branch().unwrap().as_deref(), Some("main"));
        assert_eq!(git.head().unwrap(), None);
    }

    #[test]
    fn status_add_commit_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let git = testing::git(tmp.path());
        git.init("main").unwrap();
        std::fs::write(tmp.path().join("a.md"), "hello").unwrap();
        let status = git.status().unwrap();
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].xy, ['?', '?']);
        assert_eq!(status[0].path, "a.md");
        git.add_all().unwrap();
        let sha = git
            .commit("sync: 1 page (a)\n\nDevice: box\n", &testing::author())
            .unwrap();
        assert_eq!(sha.len(), 40);
        assert!(git.status().unwrap().is_empty());
        let body = git.run(&["log", "-1", "--format=%an <%ae>%n%B"]).unwrap();
        assert!(body.starts_with("Test Author <test@example.com>"));
        assert!(body.contains("Device: box"));
        assert_eq!(git.log_count().unwrap(), 1);
    }

    #[test]
    fn config_roundtrip_and_missing_key() {
        let tmp = TempDir::new().unwrap();
        let git = testing::git(tmp.path());
        git.init("main").unwrap();
        assert_eq!(git.config_get("clep.sync.version").unwrap(), None);
        git.config_set("clep.sync.version", "1").unwrap();
        assert_eq!(
            git.config_get("clep.sync.version").unwrap().as_deref(),
            Some("1")
        );
    }

    #[test]
    fn unmerged_reports_stages_and_show_stage_returns_bytes() {
        let repos = testing::TestRepos::new();
        let a = testing::git(&repos.a);
        let b = testing::git(&repos.b);
        testing::write(&repos.a, "n.md", "+++\nid = \"x\"\n+++\nA side\n");
        a.add_all().unwrap();
        a.commit("a", &testing::author()).unwrap();
        assert!(matches!(
            a.push("origin", "main").unwrap(),
            PushOutcome::Pushed
        ));
        testing::write(&repos.b, "n.md", "+++\nid = \"x\"\n+++\nB side\n");
        b.add_all().unwrap();
        b.commit("b", &testing::author()).unwrap();
        b.fetch("origin", "main").unwrap();
        let out = b.merge_no_commit("origin/main").unwrap();
        assert_eq!(out.status, 1);
        let unmerged = b.unmerged().unwrap();
        assert_eq!(unmerged.len(), 1);
        assert_eq!(unmerged[0].path, "n.md");
        assert_eq!(unmerged[0].stages, [false, false, true, true]); // add/add: no base
        assert_eq!(
            b.show_stage(3, "n.md").unwrap(),
            b"+++\nid = \"x\"\n+++\nA side\n"
        );
        b.checkout_side(Side::Ours, "n.md").unwrap();
        assert_eq!(
            testing::read(&repos.b, "n.md"),
            "+++\nid = \"x\"\n+++\nB side\n"
        );
        b.abort_merge().unwrap();
        assert!(b.merge_head().unwrap().is_none());
    }

    #[test]
    fn push_rejection_is_reported_not_forced() {
        let repos = testing::TestRepos::new();
        let a = testing::git(&repos.a);
        let b = testing::git(&repos.b);
        testing::write(&repos.a, "a.md", "a");
        a.add_all().unwrap();
        a.commit("a", &testing::author()).unwrap();
        assert!(matches!(
            a.push("origin", "main").unwrap(),
            PushOutcome::Pushed
        ));
        testing::write(&repos.b, "b.md", "b");
        b.add_all().unwrap();
        b.commit("b", &testing::author()).unwrap();
        assert!(matches!(
            b.push("origin", "main").unwrap(),
            PushOutcome::Rejected(_)
        ));
        b.fetch("origin", "main").unwrap();
        assert_eq!(b.ahead_behind("origin/main").unwrap(), Some((1, 1)));
    }

    #[test]
    fn ahead_behind_is_none_without_upstream() {
        let tmp = TempDir::new().unwrap();
        let git = testing::git(tmp.path());
        git.init("main").unwrap();
        assert_eq!(git.ahead_behind("origin/main").unwrap(), None);
    }

    #[test]
    #[serial_test::serial]
    fn env_defaults_disable_prompts() {
        let _unset = crate::env_test_support::EnvGuard::remove("GIT_SSH_COMMAND");
        let tmp = TempDir::new().unwrap();
        let git = Git::new(tmp.path());
        assert_eq!(git.env_value("GIT_TERMINAL_PROMPT").as_deref(), Some("0"));
        assert_eq!(git.env_value("LC_ALL").as_deref(), Some("C"));
        // An unreachable host must not hang the sync window for ever: ssh
        // gets a connect timeout and a keepalive probe budget on top of
        // BatchMode.
        let ssh = git.env_value("GIT_SSH_COMMAND").expect("GIT_SSH_COMMAND");
        for option in [
            "BatchMode=yes",
            "ConnectTimeout=30",
            "ServerAliveInterval=15",
            "ServerAliveCountMax=4",
        ] {
            assert!(ssh.contains(option), "{option} missing from {ssh:?}");
        }
    }

    #[test]
    #[serial_test::serial]
    fn an_inherited_ssh_command_is_left_alone() {
        let _set = crate::env_test_support::EnvGuard::set("GIT_SSH_COMMAND", "ssh -i /custom/key");
        let tmp = TempDir::new().unwrap();
        assert_eq!(Git::new(tmp.path()).env_value("GIT_SSH_COMMAND"), None);
    }

    #[test]
    fn every_invocation_bounds_stalled_http_transfers() {
        let tmp = TempDir::new().unwrap();
        let args = Git::new(tmp.path()).base_args();
        assert_eq!(args[0], "-C");
        let pairs: Vec<(&str, &str)> = args
            .windows(2)
            .map(|w| (w[0].as_str(), w[1].as_str()))
            .filter(|(flag, _)| *flag == "-c")
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("-c", "http.lowSpeedLimit=1024"),
                ("-c", "http.lowSpeedTime=60"),
            ],
            "{args:?}"
        );
    }
}
