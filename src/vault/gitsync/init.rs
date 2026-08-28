//! `clep sync init`: create or adopt the git repository at the vault root,
//! write the managed `.gitignore`/`.gitattributes` blocks, gate on git-lfs,
//! seed the `[sync]` author, migrate a legacy CAS store (D16), add the
//! remote, and make the initial commit.

use std::path::{Path, PathBuf};

use super::config_writer::{self, SyncSectionPatch};
use super::git::Git;
use super::managed_block;
use super::{
    Author, INIT_MARKER_KEY, INIT_MARKER_VALUE, MANAGED_GITATTRIBUTES, MANAGED_GITIGNORE, SyncError,
};
use crate::vault::Vault;
use crate::vault::config::SyncSection;

/// Whether `init` requires a working `git-lfs`. Tests use [`LfsPolicy::Skip`]
/// to stay hermetic; the CLI always requests [`LfsPolicy::Required`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LfsPolicy {
    Required,
    Skip,
}

/// An interactive fallback for a missing `[sync]` author: `question ->
/// answer`, `None` for a blank/cancelled answer. `+ Send` so [`InitOpts`] can
/// cross into `tokio::task::spawn_blocking` (`sync_command::run_init` runs
/// `init` there).
pub type PromptFn = dyn Fn(&str) -> Option<String> + Send;

/// Options for [`init`]. `prompt` is only consulted when neither an explicit
/// author, a configured one, nor git's global config supplies one.
/// `legacy_cas` is the resolved D16 migration source, if any — `init` itself
/// never probes `~/.clepsydra/cas` or any other ambient location; the caller
/// (`sync_command::run_init`) resolves that via
/// `cas_migrate::legacy_store_with_blobs()` before calling in, and tests
/// pass an explicit fixture path or `None`.
pub struct InitOpts {
    pub remote: Option<String>,
    pub author: Option<Author>,
    pub lfs: LfsPolicy,
    pub prompt: Option<Box<PromptFn>>,
    pub legacy_cas: Option<PathBuf>,
}

/// What `init` did, for CLI rendering.
#[derive(Debug)]
pub struct InitReport {
    pub created_repo: bool,
    pub branch: String,
    pub gitignore_added: usize,
    pub gitattributes_added: usize,
    pub author: Author,
    pub remote: Option<String>,
    /// e.g. `"git-lfs 3.x"`, `"skipped (tests)"`.
    pub lfs: String,
    /// e.g. `"skipped: no legacy store"`, `"copied N blobs"`.
    pub cas_migration: String,
    pub initial_commit: Option<String>,
    pub warnings: Vec<String>,
}

/// Turn the vault at `vault.root()` into a synced git repository, or adopt
/// (and validate) one already there. Idempotent: a second call makes no
/// further changes beyond what has drifted since the first (e.g. a newly
/// missing managed line).
pub fn init(vault: &Vault, git: &Git, opts: InitOpts) -> Result<InitReport, SyncError> {
    let InitOpts {
        remote: requested_remote,
        author: explicit_author,
        lfs: lfs_policy,
        prompt,
        legacy_cas,
    } = opts;
    let mut warnings = Vec::new();

    // (1) git must be present at all.
    Git::version().map_err(|e| SyncError::GitMissing(e.to_string()))?;

    let cfg = vault.config().sync.clone();
    let branch = cfg.branch.clone();
    let root = vault.root();

    // (2) toplevel / nested / adopt / create.
    let created_repo = match git.toplevel()? {
        Some(top) => {
            let same_root = top.canonicalize().ok() == root.canonicalize().ok();
            if !same_root {
                return Err(SyncError::NestedRepo {
                    root: root.display().to_string(),
                    outer: top.display().to_string(),
                });
            }
            if git.head()?.is_some() {
                let actual = git.current_branch()?;
                if actual.as_deref() != Some(branch.as_str()) {
                    return Err(SyncError::BranchMismatch {
                        actual: actual.unwrap_or_default(),
                        configured: branch.clone(),
                    });
                }
            }
            false
        }
        None => {
            git.init(&branch)?;
            true
        }
    };

    // (3) LFS gate.
    let lfs = match lfs_policy {
        LfsPolicy::Required => {
            let version = git
                .lfs_version()?
                .ok_or_else(|| SyncError::LfsMissing("git lfs version".to_string()))?;
            git.lfs_install_local()?;
            version
        }
        LfsPolicy::Skip => "skipped (tests)".to_string(),
    };

    // (4) managed .gitignore / .gitattributes blocks.
    let gitignore_added =
        managed_block::upsert_managed_block(&root.join(".gitignore"), MANAGED_GITIGNORE)?;
    let gitattributes_added =
        managed_block::upsert_managed_block(&root.join(".gitattributes"), MANAGED_GITATTRIBUTES)?;

    // (5) initialised marker.
    git.config_set(INIT_MARKER_KEY, INIT_MARKER_VALUE)?;

    // (6) author, seeded and persisted to [sync] when it (or the branch)
    // drifted from what was already on disk.
    let author = resolve_author(&cfg, git, explicit_author, prompt.as_deref())?;
    write_sync_drift(root, &cfg, &author, &branch)?;

    // (7) CAS migration (D16, ADR 0005): only when the vault's own store is
    // still empty and a legacy store was given to pull from.
    let cas_migration = migrate_legacy_cas(vault, legacy_cas.as_deref(), &mut warnings)?;

    // (8) remote.
    let remote = resolve_remote(git, requested_remote.as_deref())?;

    // (9) commit whatever is outstanding (including the files written
    // above), unless nothing changed and history already exists.
    git.add_all()?;
    let needs_commit = !git.status()?.is_empty() || git.head()?.is_none();
    let initial_commit = if needs_commit {
        let message = super::with_device_trailer("sync: initial commit");
        Some(git.commit(&message, &author)?)
    } else {
        None
    };

    Ok(InitReport {
        created_repo,
        branch,
        gitignore_added,
        gitattributes_added,
        author,
        remote,
        lfs,
        cas_migration,
        initial_commit,
        warnings,
    })
}

/// `opts.author` → configured `[sync]` author → git's global config → an
/// interactive `prompt` → [`SyncError::MissingAuthor`].
fn resolve_author(
    cfg: &SyncSection,
    git: &Git,
    explicit: Option<Author>,
    prompt: Option<&PromptFn>,
) -> Result<Author, SyncError> {
    if let Some(author) = explicit {
        return Ok(author);
    }
    if let Some(author) = Author::from_config(cfg) {
        return Ok(author);
    }
    let name = git.global_config_get("user.name")?;
    let email = git.global_config_get("user.email")?;
    if let (Some(name), Some(email)) = (name, email)
        && !name.trim().is_empty()
        && !email.trim().is_empty()
    {
        return Ok(Author { name, email });
    }
    if let Some(prompt) = prompt {
        let name = prompt("Author name: ").filter(|s| !s.trim().is_empty());
        let email = prompt("Author email: ").filter(|s| !s.trim().is_empty());
        if let (Some(name), Some(email)) = (name, email) {
            return Ok(Author { name, email });
        }
    }
    Err(SyncError::MissingAuthor)
}

/// Persist `author`/`branch` into `[sync]` only for the fields that differ
/// from what was already loaded — a no-op write is skipped entirely.
fn write_sync_drift(
    vault_root: &Path,
    cfg: &SyncSection,
    author: &Author,
    branch: &str,
) -> Result<(), SyncError> {
    let mut patch = SyncSectionPatch::default();
    if cfg.branch != branch {
        patch.branch = Some(branch.to_string());
    }
    if cfg.author_name.as_deref() != Some(author.name.as_str()) {
        patch.author_name = Some(author.name.clone());
    }
    if cfg.author_email.as_deref() != Some(author.email.as_str()) {
        patch.author_email = Some(author.email.clone());
    }
    if patch.branch.is_none() && patch.author_name.is_none() && patch.author_email.is_none() {
        return Ok(());
    }
    config_writer::write_sync_section(vault_root, &patch)
}

/// D16: migrate a legacy CAS store into the vault when the vault's own store
/// is still empty and `legacy_cas` names a source to pull from. `init` never
/// resolves that source itself (no ambient `~/.clepsydra/cas` probing) — the
/// caller decides. Never touches the legacy store. Per-blob problems are
/// reported as warnings, not fatal.
fn migrate_legacy_cas(
    vault: &Vault,
    legacy_cas: Option<&Path>,
    warnings: &mut Vec<String>,
) -> Result<String, SyncError> {
    if !crate::vault::cas::list_blob_hashes(&vault.cas_root()).is_empty() {
        return Ok("skipped: vault CAS store already has blobs".to_string());
    }
    let Some(source) = legacy_cas else {
        return Ok("skipped: no legacy store".to_string());
    };
    let report = crate::vault::cas_migrate::migrate(vault, source, true)
        .map_err(|e| SyncError::Config(format!("CAS migration from {}: {e}", source.display())))?;
    for warning in &report.warnings {
        warnings.push(format!("cas migration: {warning}"));
    }
    Ok(format!(
        "copied {} blob(s) from {}",
        report.copied.len(),
        source.display()
    ))
}

/// `None` → add `requested` as `origin`, when one was given. `Some(existing)`
/// differing from `requested` → [`SyncError::RemoteMismatch`]. No
/// `requested` at all → just report whatever `origin` already points at.
fn resolve_remote(git: &Git, requested: Option<&str>) -> Result<Option<String>, SyncError> {
    let existing = git.remote_url(super::REMOTE_NAME)?;
    let Some(requested) = requested else {
        return Ok(existing);
    };
    match existing {
        None => {
            git.remote_add(super::REMOTE_NAME, requested)?;
            Ok(Some(requested.to_string()))
        }
        Some(existing) if existing == requested => Ok(Some(existing)),
        Some(existing) => Err(SyncError::RemoteMismatch {
            name: super::REMOTE_NAME.to_string(),
            existing,
            requested: requested.to_string(),
        }),
    }
}

/// `https(s)://…` (with or without a trailing `.git`) → the LFS batch-API
/// URL. `None` for anything else (ssh/scp remotes use [`ssh_target`]
/// instead).
pub(crate) fn lfs_batch_url(url: &str) -> Option<String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return None;
    }
    let base = url.strip_suffix(".git").unwrap_or(url);
    Some(format!("{base}.git/info/lfs/objects/batch"))
}

/// `git@host:path` or `ssh://user@host/path` → `(user@host, path)`. `None`
/// for an http(s) URL (or anything else [`lfs_batch_url`] already handles).
pub(crate) fn ssh_target(url: &str) -> Option<(String, String)> {
    if let Some(rest) = url.strip_prefix("ssh://") {
        let (host, path) = rest.split_once('/')?;
        return Some((host.to_string(), path.to_string()));
    }
    if url.starts_with("http://") || url.starts_with("https://") {
        return None;
    }
    let (host, path) = url.split_once(':')?;
    if host.is_empty() || host.contains('/') {
        return None;
    }
    Some((host.to_string(), path.to_string()))
}

/// How long the ssh branch of [`probe_lfs_remote`] waits for the host to
/// answer `git-lfs-authenticate` before giving up.
const SSH_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Probe whether a remote answers the git-lfs batch API (D12). Never called
/// by [`init`] itself — the CLI glue calls it up front, before opening the
/// vault, so a doomed `init` never partially runs.
pub async fn probe_lfs_remote(url: &str) -> Result<(), SyncError> {
    if let Some(batch_url) = lfs_batch_url(url) {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| SyncError::LfsRemoteUnsupported {
                url: url.to_string(),
                detail: e.to_string(),
            })?;
        let response = client
            .post(&batch_url)
            .header("Accept", "application/vnd.git-lfs+json")
            .json(&serde_json::json!({"operation": "download", "objects": []}))
            .send()
            .await;
        return match response {
            Ok(response) => {
                let status = response.status();
                if status.as_u16() == 404 || status.is_server_error() {
                    Err(SyncError::LfsRemoteUnsupported {
                        url: url.to_string(),
                        detail: format!("HTTP {status}"),
                    })
                } else {
                    Ok(())
                }
            }
            Err(e) => Err(SyncError::LfsRemoteUnsupported {
                url: url.to_string(),
                detail: e.to_string(),
            }),
        };
    }

    if let Some((target, path)) = ssh_target(url) {
        // A host that accepts the connection and then says nothing would
        // otherwise hang `clep sync init` for ever: `BatchMode` only stops
        // ssh asking for a password. `kill_on_drop` reaps the child the
        // timeout abandons.
        let probe = tokio::process::Command::new("ssh")
            .args([
                "-o",
                "BatchMode=yes",
                &target,
                "git-lfs-authenticate",
                &path,
                "download",
            ])
            .kill_on_drop(true)
            .status();
        let status = match tokio::time::timeout(SSH_PROBE_TIMEOUT, probe).await {
            Ok(result) => result.map_err(|e| SyncError::LfsRemoteUnsupported {
                url: url.to_string(),
                detail: e.to_string(),
            })?,
            Err(_) => {
                return Err(SyncError::LfsRemoteUnsupported {
                    url: url.to_string(),
                    detail: "ssh probe timed out after 30s".to_string(),
                });
            }
        };
        return if status.success() {
            Ok(())
        } else {
            Err(SyncError::LfsRemoteUnsupported {
                url: url.to_string(),
                detail: format!("ssh exited with {status}"),
            })
        };
    }

    Err(SyncError::LfsRemoteUnsupported {
        url: url.to_string(),
        detail: "remote URL is neither http(s) nor ssh/scp".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;
    use crate::vault::cas::{ContentStore, blob_relative_path};
    use crate::vault::gitsync::testing;
    use crate::vault::gitsync::{MANAGED_GITATTRIBUTES, MANAGED_GITIGNORE};

    fn fresh_vault() -> (TempDir, Vault) {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        fs::write(
            root.join("note.md"),
            "+++\nid = \"0192b6c0-0000-7000-8000-000000000001\"\ntitle = \"Note\"\n+++\nhi\n",
        )
        .unwrap();
        let vault = Vault::open(&root).unwrap();
        (tmp, vault)
    }

    fn opts() -> InitOpts {
        InitOpts {
            remote: None,
            author: Some(testing::author()),
            lfs: LfsPolicy::Skip,
            prompt: None,
            legacy_cas: None,
        }
    }

    #[test]
    fn init_creates_repo_files_marker_config_and_initial_commit() {
        let (_tmp, vault) = fresh_vault();
        let git = testing::git(vault.root());
        let report = init(&vault, &git, opts()).unwrap();
        assert!(report.created_repo);
        assert_eq!(report.branch, "main");
        assert_eq!(report.gitignore_added, MANAGED_GITIGNORE.len());
        assert_eq!(report.gitattributes_added, MANAGED_GITATTRIBUTES.len());
        assert!(report.initial_commit.is_some());
        assert!(report.warnings.is_empty(), "{:?}", report.warnings);
        assert_eq!(
            git.config_get(INIT_MARKER_KEY).unwrap().as_deref(),
            Some("1")
        );
        let ignore = fs::read_to_string(vault.root().join(".gitignore")).unwrap();
        for line in MANAGED_GITIGNORE {
            assert!(ignore.lines().any(|l| l == *line), "{line}");
        }
        let attrs = fs::read_to_string(vault.root().join(".gitattributes")).unwrap();
        for line in MANAGED_GITATTRIBUTES {
            assert!(attrs.lines().any(|l| l == *line), "{line}");
        }
        let cfg = crate::vault::config::VaultConfig::load(vault.root()).unwrap();
        assert_eq!(cfg.sync.author_name.as_deref(), Some("Test Author"));
        assert!(git.status().unwrap().is_empty());
        let tracked = git.run(&["ls-files"]).unwrap();
        assert!(tracked.contains("note.md"));
        assert!(tracked.contains(".clepsydra/config.toml"));
        assert!(!tracked.contains("cache.db"));
        let reopened = Vault::open(vault.root()).unwrap();
        assert!(super::super::is_initialised(&reopened, &git).unwrap());
    }

    #[test]
    fn init_is_idempotent_and_adopts_an_existing_repo() {
        let (_tmp, vault) = fresh_vault();
        let git = testing::git(vault.root());
        let first = init(&vault, &git, opts()).unwrap();
        let vault = Vault::open(vault.root()).unwrap();
        let second = init(&vault, &git, opts()).unwrap();
        assert!(!second.created_repo);
        assert_eq!(second.gitignore_added, 0);
        assert_eq!(second.initial_commit, None);
        assert_eq!(git.log_count().unwrap(), 1);
        assert_eq!(first.initial_commit.unwrap(), git.head().unwrap().unwrap());
    }

    #[test]
    fn init_migrates_legacy_cas_only_when_a_source_is_given() {
        // No `legacy_cas` at all: D16 never runs, regardless of what might
        // exist on the machine at any ambient default location — `init`
        // itself never resolves that path.
        let (_tmp, vault) = fresh_vault();
        let git = testing::git(vault.root());
        let report = init(&vault, &git, opts()).unwrap();
        assert_eq!(report.cas_migration, "skipped: no legacy store");
        assert!(!vault.root().join(".clepsydra/cas").exists());

        // `legacy_cas: Some(fixture)`: the referenced blob is copied in.
        let (tmp2, vault2) = fresh_vault();
        let hash = ContentStore::hash_bytes(b"<html>snap</html>");
        fs::write(
            vault2.root().join("archived.md"),
            format!(
                "+++\nid = \"0192b6c0-0000-7000-8000-000000000002\"\ntitle = \"Archived\"\n\n[archive]\nsnapshot_hash = \"{hash}\"\n+++\nbody\n"
            ),
        )
        .unwrap();
        let vault2 = Vault::open(vault2.root()).unwrap();
        let legacy = tmp2.path().join("legacy-cas");
        let blob_path = legacy.join(blob_relative_path(&hash).unwrap());
        fs::create_dir_all(blob_path.parent().unwrap()).unwrap();
        fs::write(&blob_path, b"<html>snap</html>").unwrap();

        let git2 = testing::git(vault2.root());
        let report2 = init(
            &vault2,
            &git2,
            InitOpts {
                legacy_cas: Some(legacy.clone()),
                ..opts()
            },
        )
        .unwrap();
        assert!(
            report2.cas_migration.contains("copied 1 blob"),
            "{}",
            report2.cas_migration
        );
        assert!(report2.warnings.is_empty(), "{:?}", report2.warnings);
        assert!(
            vault2
                .cas_root()
                .join(blob_relative_path(&hash).unwrap())
                .exists()
        );
    }

    #[test]
    fn init_refuses_a_vault_nested_in_another_repo() {
        let tmp = TempDir::new().unwrap();
        testing::git(tmp.path()).init("main").unwrap();
        let root = tmp.path().join("inner");
        crate::vault::init::init_vault(&root).unwrap();
        let vault = Vault::open(&root).unwrap();
        let err = init(&vault, &testing::git(&root), opts()).unwrap_err();
        assert!(matches!(err, SyncError::NestedRepo { .. }), "{err}");
        assert!(!root.join(".git").exists());
    }

    #[test]
    fn init_refuses_branch_mismatch_on_adopt() {
        let (_tmp, vault) = fresh_vault();
        let git = testing::git(vault.root());
        git.init("trunk").unwrap();
        git.add_all().unwrap();
        git.commit("x", &testing::author()).unwrap();
        let err = init(&vault, &git, opts()).unwrap_err();
        assert!(matches!(err, SyncError::BranchMismatch { .. }), "{err}");
    }

    #[test]
    fn init_seeds_author_from_global_git_config_then_prompt() {
        let (_tmp, vault) = fresh_vault();
        let global = vault.root().parent().unwrap().join("gitconfig");
        fs::write(
            &global,
            "[user]\n\tname = Global Name\n\temail = global@example.com\n",
        )
        .unwrap();
        let git = Git::new(vault.root())
            .with_env("GIT_CONFIG_GLOBAL", global.to_str().unwrap())
            .with_env("GIT_CONFIG_NOSYSTEM", "1");
        let report = init(
            &vault,
            &git,
            InitOpts {
                author: None,
                ..opts()
            },
        )
        .unwrap();
        assert_eq!(
            report.author,
            Author {
                name: "Global Name".into(),
                email: "global@example.com".into()
            }
        );

        let (_tmp2, vault2) = fresh_vault();
        let git2 = testing::git(vault2.root());
        let prompt: Box<PromptFn> = Box::new(|q| {
            Some(if q.contains("name") {
                "Prompted".into()
            } else {
                "p@example.com".into()
            })
        });
        let report = init(
            &vault2,
            &git2,
            InitOpts {
                author: None,
                prompt: Some(prompt),
                ..opts()
            },
        )
        .unwrap();
        assert_eq!(report.author.name, "Prompted");

        let (_tmp3, vault3) = fresh_vault();
        let err = init(
            &vault3,
            &testing::git(vault3.root()),
            InitOpts {
                author: None,
                ..opts()
            },
        )
        .unwrap_err();
        assert!(matches!(err, SyncError::MissingAuthor), "{err}");
    }

    #[test]
    fn init_adds_remote_and_refuses_a_different_existing_one() {
        let repos = testing::TestRepos::new();
        let (_tmp, vault) = fresh_vault();
        let git = testing::git(vault.root());
        let url = repos.remote.to_str().unwrap().to_string();
        let report = init(
            &vault,
            &git,
            InitOpts {
                remote: Some(url.clone()),
                ..opts()
            },
        )
        .unwrap();
        assert_eq!(report.remote.as_deref(), Some(url.as_str()));
        assert_eq!(
            git.remote_url("origin").unwrap().as_deref(),
            Some(url.as_str())
        );
        let vault = Vault::open(vault.root()).unwrap();
        let err = init(
            &vault,
            &git,
            InitOpts {
                remote: Some("/elsewhere.git".into()),
                ..opts()
            },
        )
        .unwrap_err();
        assert!(matches!(err, SyncError::RemoteMismatch { .. }), "{err}");
    }

    #[test]
    fn init_requires_lfs_when_policy_is_required() {
        // A PATH holding only `git` (symlinked to the real binary) guarantees
        // `git lfs version` fails whether or not git-lfs is installed.
        let (_tmp, vault) = fresh_vault();
        let shim = vault.root().parent().unwrap().join("shim");
        fs::create_dir_all(&shim).unwrap();
        let real = std::process::Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .unwrap();
        let real = String::from_utf8(real.stdout).unwrap().trim().to_string();
        std::os::unix::fs::symlink(&real, shim.join("git")).unwrap();
        let git = testing::git(vault.root()).with_env("PATH", shim.to_str().unwrap());
        let err = init(
            &vault,
            &git,
            InitOpts {
                lfs: LfsPolicy::Required,
                ..opts()
            },
        )
        .unwrap_err();
        assert!(matches!(err, SyncError::LfsMissing(_)), "{err}");
        assert!(
            !vault.root().join(".gitignore").exists(),
            "refusal happens before any file is written"
        );
    }

    #[test]
    fn lfs_url_helpers() {
        assert_eq!(
            lfs_batch_url("https://github.com/o/r").as_deref(),
            Some("https://github.com/o/r.git/info/lfs/objects/batch")
        );
        assert_eq!(
            lfs_batch_url("https://github.com/o/r.git").as_deref(),
            Some("https://github.com/o/r.git/info/lfs/objects/batch")
        );
        assert_eq!(lfs_batch_url("git@github.com:o/r.git"), None);
        assert_eq!(
            ssh_target("git@github.com:o/r.git"),
            Some(("git@github.com".into(), "o/r.git".into()))
        );
        assert_eq!(
            ssh_target("ssh://git@host/o/r"),
            Some(("git@host".into(), "o/r".into()))
        );
        assert_eq!(ssh_target("https://host/o/r"), None);
    }

    #[tokio::test]
    async fn probe_lfs_remote_accepts_401_and_refuses_404() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/o/r.git/info/lfs/objects/batch"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        probe_lfs_remote(&format!("{}/o/r", server.uri()))
            .await
            .unwrap();
        server.reset().await;
        Mock::given(method("POST"))
            .and(path("/o/r.git/info/lfs/objects/batch"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let err = probe_lfs_remote(&format!("{}/o/r", server.uri()))
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::LfsRemoteUnsupported { .. }),
            "{err}"
        );
        let err = probe_lfs_remote("http://127.0.0.1:1/o/r")
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::LfsRemoteUnsupported { .. }),
            "{err}"
        );
    }
}
