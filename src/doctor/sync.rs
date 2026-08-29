//! `sync` doctor section: the git binary, whether the vault is an
//! initialised sync repository, and — when it is — its branch, managed
//! files, git-lfs, remote, working tree, index exclusions, merge driver
//! registration, and Conflict Copies left behind by an unresolved merge.

use super::*;

const SYNC_SECTION: &str = "sync";
/// How many offending entries a `sync` detail lists before summarising.
const SYNC_LISTED: usize = 10;

/// Report the vault's `clep sync` state: the git binary, whether the vault is
/// an initialised sync repository, and — when it is — its branch, managed
/// files, merge driver registration, Conflict Copies, git-lfs, remote,
/// working tree and index exclusions.
///
/// Read-only by contract, like every other check: it only ever asks git
/// questions (`--version`, `rev-parse`, `config --get`, `remote get-url`,
/// `status`, `ls-files -u`, `lfs version`). It never fetches, commits,
/// merges, or writes configuration — and on a vault that has no `.git` at
/// all it never runs git in the first place.
pub(super) fn check_sync(vault: &Vault, report: &mut Report) {
    use crate::vault::gitsync::git::Git;

    // A vault with no `.git` at its root is simply not initialised (D3) —
    // answer from the filesystem rather than spawning git on every `clep
    // doctor` run in every non-syncing vault. The nesting case still gets its
    // own error, walked out of the filesystem rather than asked of git.
    if !crate::vault::gitsync::has_git_entry(vault.root()) {
        report.push(match enclosing_repo(vault.root()) {
            Some(outer) => nested_repo_result(&outer),
            None => info(
                SYNC_SECTION,
                "repo",
                "not initialised — run `clep sync init`",
            ),
        });
        return;
    }

    let version = match Git::version() {
        Ok(version) => version,
        Err(e) => {
            report.push(
                warn(SYNC_SECTION, "git", format!("git is unavailable: {e}")).with_hint(
                    "install git to sync this vault (e.g. `xcode-select --install` or `brew install git`)",
                ),
            );
            return;
        }
    };
    report.push(info(SYNC_SECTION, "git", version));

    let git = Git::new(vault.root());
    if !check_sync_repo(vault, &git, report) {
        return;
    }
    check_sync_branch(vault, &git, report);
    check_sync_managed_files(vault, report);
    check_sync_driver(&git, report);
    check_sync_conflict_copies(vault, report);
    check_sync_lfs(&git, report);
    check_sync_remote(&git, report);
    check_sync_worktree(&git, report);
    check_sync_exclusions(vault, report);
}

/// The `repo` error for a vault sitting inside `outer` — the one arrangement
/// `clep sync init` can never adopt.
fn nested_repo_result(outer: &Path) -> CheckResult {
    err(
        SYNC_SECTION,
        "repo",
        format!(
            "the vault root is inside another git repository ({})",
            outer.display()
        ),
    )
    .with_hint("move the vault out of that repository, or remove the outer repository; `clep sync init` refuses to nest")
}

/// The nearest ancestor of `root` holding a `.git` entry, or `None` when the
/// vault is not inside a repository at all.
///
/// A filesystem-only stand-in for `git rev-parse --show-toplevel`, used for
/// the one case where the vault root itself is not a repository: it still
/// answers the question `clep sync init`'s refusal turns on, without spawning
/// git in every non-syncing vault.
fn enclosing_repo(root: &Path) -> Option<PathBuf> {
    root.ancestors()
        .skip(1)
        .filter(|ancestor| !ancestor.as_os_str().is_empty())
        .find(|ancestor| crate::vault::gitsync::has_git_entry(ancestor))
        .map(Path::to_path_buf)
}

/// Push the `repo` result and report whether the rest of the section is
/// meaningful: only an initialised repository (D3 — vault root is the
/// toplevel *and* the marker is set) has a branch, a remote or a worktree to
/// talk about.
fn check_sync_repo(
    vault: &Vault,
    git: &crate::vault::gitsync::git::Git,
    report: &mut Report,
) -> bool {
    use crate::vault::gitsync::INIT_MARKER_KEY;

    let toplevel = match git.toplevel() {
        Ok(toplevel) => toplevel,
        Err(e) => {
            report.push(err(
                SYNC_SECTION,
                "repo",
                format!("could not inspect the repository: {e}"),
            ));
            return false;
        }
    };
    let Some(toplevel) = toplevel else {
        report.push(info(
            SYNC_SECTION,
            "repo",
            "not initialised — run `clep sync init`",
        ));
        return false;
    };
    if toplevel.canonicalize().ok() != vault.root().canonicalize().ok() {
        report.push(nested_repo_result(&toplevel));
        return false;
    }
    // `--local`, exactly as `gitsync::is_initialised` reads it (D25): a
    // `clep.sync.version` inherited from the user's global config would
    // otherwise have doctor calling every vault on the machine initialised
    // while `clep sync` refuses each one with `NotInitialised`.
    match git.config_get_local(INIT_MARKER_KEY) {
        Ok(Some(_)) => {
            report.push(ok(
                SYNC_SECTION,
                "repo",
                format!("initialised at {}", vault.root().display()),
            ));
            true
        }
        Ok(None) => {
            report.push(info(
                SYNC_SECTION,
                "repo",
                "a git repository, but sync is not initialised — run `clep sync init`",
            ));
            false
        }
        Err(e) => {
            report.push(err(
                SYNC_SECTION,
                "repo",
                format!("could not read {INIT_MARKER_KEY}: {e}"),
            ));
            false
        }
    }
}

/// Sync only ever pushes and merges the one configured branch, so a repository
/// sitting on a different one would sync nothing.
fn check_sync_branch(vault: &Vault, git: &crate::vault::gitsync::git::Git, report: &mut Report) {
    let configured = vault.config().sync.branch.clone();
    match git.current_branch() {
        Ok(Some(actual)) if actual == configured => {
            report.push(ok(SYNC_SECTION, "branch", format!("on {actual}")));
        }
        Ok(Some(actual)) => {
            report.push(
                warn(
                    SYNC_SECTION,
                    "branch",
                    format!("on {actual}, but [sync] branch = {configured}"),
                )
                .with_hint(format!(
                    "check out {configured}, or set [sync] branch in .clepsydra/config.toml"
                )),
            );
        }
        Ok(None) => {
            report.push(
                warn(
                    SYNC_SECTION,
                    "branch",
                    format!("HEAD is detached or unborn; [sync] branch = {configured}"),
                )
                .with_hint(format!("check out {configured}")),
            );
        }
        Err(e) => {
            report.push(err(
                SYNC_SECTION,
                "branch",
                format!("could not read the current branch: {e}"),
            ));
        }
    }
}

/// Every managed `.gitignore`/`.gitattributes` line `clep sync init` writes
/// must still be there: a dropped ignore line commits scratch databases, a
/// dropped attributes line takes attachments out of git-lfs.
fn check_sync_managed_files(vault: &Vault, report: &mut Report) {
    use std::collections::HashSet;

    use crate::vault::gitsync::{MANAGED_GITATTRIBUTES, MANAGED_GITIGNORE};

    let mut missing: Vec<String> = Vec::new();
    for (file, managed) in [
        (".gitignore", MANAGED_GITIGNORE),
        (".gitattributes", MANAGED_GITATTRIBUTES),
    ] {
        // An unreadable or absent file simply has none of its lines.
        let text = std::fs::read_to_string(vault.root().join(file)).unwrap_or_default();
        let present: HashSet<&str> = text.lines().collect();
        missing.extend(
            managed
                .iter()
                .filter(|line| !present.contains(*line))
                .map(|line| format!("{file}: {line}")),
        );
    }

    if missing.is_empty() {
        report.push(ok(
            SYNC_SECTION,
            "managed files",
            ".gitignore and .gitattributes carry every managed line",
        ));
        return;
    }
    let mut detail = format!("{} managed line(s) missing:", missing.len());
    for entry in missing.iter().take(SYNC_LISTED) {
        detail.push_str("\n  ");
        detail.push_str(entry);
    }
    if missing.len() > SYNC_LISTED {
        detail.push_str(&format!("\n  … and {} more", missing.len() - SYNC_LISTED));
    }
    report.push(
        warn(SYNC_SECTION, "managed files", detail).with_hint(
            "re-run `clep sync init` — it is idempotent and only appends what is missing",
        ),
    );
}

/// The `*.md merge=clep` driver is only as good as `merge.clep.driver` being
/// registered (spec §5) — `clep sync init` writes it, but it lives in local
/// git config, so nothing stops a hand-edit or a fresh clone from dropping it.
fn check_sync_driver(git: &crate::vault::gitsync::git::Git, report: &mut Report) {
    match git.config_get_local(crate::vault::gitsync::MERGE_DRIVER_KEY) {
        Ok(Some(_)) => {
            report.push(ok(SYNC_SECTION, "driver", "markdown merge driver registered"));
            report.push(driver_path_result(std::env::var_os("PATH").as_deref()));
        }
        Ok(None) => report.push(
            warn(
                SYNC_SECTION,
                "driver",
                "markdown merge driver is not registered; *.md merges fall back to plain text merge",
            )
            .with_hint("run `clep sync init` to register `clep merge-driver`"),
        ),
        Err(e) => report.push(warn(
            SYNC_SECTION,
            "driver",
            format!("could not read merge driver config: {e}"),
        )),
    }
}

/// The registration is a command line — `clep merge-driver %O %A %B %P` —
/// which git resolves through its child's `PATH`. `clep sync`'s own merges
/// always find it (the engine puts the running binary's own directory first),
/// but a `git merge` run by hand from a shell without `clep` on `PATH` gets
/// "command not found", and git turns every page both sides changed into a
/// conflict — including the disjoint edits the default text merge would have
/// merged cleanly.
fn driver_path_result(path: Option<&std::ffi::OsStr>) -> CheckResult {
    if clep_on_path(path) {
        return ok(SYNC_SECTION, "driver-path", "`clep` resolves on PATH");
    }
    warn(
        SYNC_SECTION,
        "driver-path",
        "`clep` does not resolve on PATH; a `git merge` run by hand cannot start the merge driver and conflicts every page both sides changed",
    )
    .with_hint(
        "put `clep` on PATH (for example symlink it into /usr/local/bin), or run it from an installed location",
    )
}

/// Whether `clep` resolves to an executable file on `path` (a `PATH`-shaped
/// value), the way git's child shell resolves the driver command.
fn clep_on_path(path: Option<&std::ffi::OsStr>) -> bool {
    path.is_some_and(|path| {
        std::env::split_paths(path).any(|dir| is_executable_file(&dir.join("clep")))
    })
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file())
}

/// Conflict Copies are the intentional, permanent side effect of a resolved
/// merge (D-series design): the loser survives beside the winner so nothing
/// is silently dropped. They pile up if nobody folds them back by hand.
fn check_sync_conflict_copies(vault: &Vault, report: &mut Report) {
    let copies = crate::vault::gitsync::conflict_copy::find_conflict_copies(vault.root());
    if copies.is_empty() {
        report.push(ok(SYNC_SECTION, "conflict-copies", "none"));
        return;
    }
    let listed: Vec<&str> = copies
        .iter()
        .take(SYNC_LISTED)
        .map(String::as_str)
        .collect();
    let more = copies.len().saturating_sub(SYNC_LISTED);
    let mut detail = format!(
        "{} conflict cop{}: {}",
        copies.len(),
        if copies.len() == 1 { "y" } else { "ies" },
        listed.join(", ")
    );
    if more > 0 {
        detail.push_str(&format!(" (+{more} more)"));
    }
    report.push(warn(SYNC_SECTION, "conflict-copies", detail).with_hint(
        "each copy holds the other device's version of its page — fold what you want into the original (the /conflicts view lists them), then delete the copy",
    ));
}

/// git-lfs is mandatory for sync (spec §3): attachments and the CAS store are
/// tracked through its filters.
fn check_sync_lfs(git: &crate::vault::gitsync::git::Git, report: &mut Report) {
    match git.lfs_version() {
        Ok(Some(version)) => report.push(ok(SYNC_SECTION, "lfs", version)),
        Ok(None) => report.push(
            warn(
                SYNC_SECTION,
                "lfs",
                "git-lfs not installed — required for sync",
            )
            .with_hint(
                "install git-lfs (e.g. `brew install git-lfs`), then re-run `clep sync init`",
            ),
        ),
        Err(e) => report.push(err(
            SYNC_SECTION,
            "lfs",
            format!("could not run `git lfs version`: {e}"),
        )),
    }
}

/// Sync talks to exactly one remote. Having none is a valid single-device
/// setup, so both outcomes are informational.
fn check_sync_remote(git: &crate::vault::gitsync::git::Git, report: &mut Report) {
    use crate::vault::gitsync::REMOTE_NAME;

    match git.remote_url(REMOTE_NAME) {
        Ok(Some(url)) => report.push(info(SYNC_SECTION, "remote", url)),
        Ok(None) => report.push(info(SYNC_SECTION, "remote", "none")),
        Err(e) => report.push(err(
            SYNC_SECTION,
            "remote",
            format!("could not read the {REMOTE_NAME} URL: {e}"),
        )),
    }
}

/// Uncommitted files are ordinary (the server commits them after the
/// autocommit debounce); unmerged files are not — sync never leaves them
/// behind, so they mean a hand-run `git merge` stopped half way.
fn check_sync_worktree(git: &crate::vault::gitsync::git::Git, report: &mut Report) {
    let unmerged = match git.unmerged() {
        Ok(unmerged) => unmerged,
        Err(e) => {
            report.push(err(
                SYNC_SECTION,
                "worktree",
                format!("could not list unmerged paths: {e}"),
            ));
            return;
        }
    };
    if !unmerged.is_empty() {
        let mut detail = format!("{} unmerged file(s):", unmerged.len());
        for entry in unmerged.iter().take(SYNC_LISTED) {
            detail.push_str("\n  ");
            detail.push_str(&entry.path);
        }
        if unmerged.len() > SYNC_LISTED {
            detail.push_str(&format!("\n  … and {} more", unmerged.len() - SYNC_LISTED));
        }
        report.push(err(SYNC_SECTION, "worktree", detail).with_hint(
            "run `clep sync`: it resolves every unmerged path, keeping yours and writing theirs beside it as a Conflict Copy",
        ));
        return;
    }

    match git.status() {
        Ok(entries) if entries.is_empty() => {
            report.push(ok(SYNC_SECTION, "worktree", "clean"));
        }
        Ok(entries) => {
            report.push(info(
                SYNC_SECTION,
                "worktree",
                format!("{} uncommitted file(s) (autocommit pending)", entries.len()),
            ));
        }
        Err(e) => report.push(err(
            SYNC_SECTION,
            "worktree",
            format!("could not read the working tree status: {e}"),
        )),
    }
}

/// `.git/**` must stay out of the index: git's own object files are not
/// pages, and indexing them would churn on every commit.
fn check_sync_exclusions(vault: &Vault, report: &mut Report) {
    use crate::vault::path::VaultPath;

    let probe = match VaultPath::new(".git/x.md") {
        Ok(probe) => probe,
        Err(e) => {
            report.push(err(
                SYNC_SECTION,
                "exclusions",
                format!("could not build the `.git` probe path: {e}"),
            ));
            return;
        }
    };
    if vault.is_excluded(&probe) {
        report.push(ok(
            SYNC_SECTION,
            "exclusions",
            "`.git/**` is excluded from the index",
        ));
    } else {
        report.push(
            warn(
                SYNC_SECTION,
                "exclusions",
                "`.git/**` is indexed; git's internal files would be read as pages",
            )
            .with_hint("add \".git/**\" to [vault] excluded_patterns in .clepsydra/config.toml"),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // -----------------------------------------------------------------
    // Check: sync
    // -----------------------------------------------------------------
    //
    // `check_sync` builds its own `Git` with `Git::new` (not the isolated
    // test wrapper), so every test below points the whole process at an
    // empty global git config and must therefore be `#[serial]`.

    /// The one `sync` result named `name`, or a panic naming the whole report.
    fn sync_result(report: &Report, name: &str) -> CheckResult {
        report
            .results
            .iter()
            .find(|r| r.section == "sync" && r.name == name)
            .unwrap_or_else(|| panic!("sync.{name} should be reported: {:#?}", report.results))
            .clone()
    }

    fn has_sync_check(report: &Report, name: &str) -> bool {
        report
            .results
            .iter()
            .any(|r| r.section == "sync" && r.name == name)
    }

    /// Run `gitsync::init` over an existing repository root (a `TestRepos`
    /// clone) so it carries the managed `.gitignore`/`.gitattributes` blocks,
    /// then re-open the vault: `init` rewrites `.clepsydra/config.toml`.
    fn sync_initialised_vault(root: &Path) -> crate::vault::Vault {
        use crate::vault::gitsync::{init, testing};
        let vault = crate::vault::Vault::open(root).unwrap();
        init::init(
            &vault,
            &testing::git(root),
            init::InitOpts {
                remote: None,
                author: Some(testing::author()),
                lfs: init::LfsPolicy::Skip,
                prompt: None,
                legacy_cas: None,
            },
        )
        .unwrap();
        crate::vault::Vault::open(root).unwrap()
    }

    #[test]
    #[serial_test::serial]
    fn sync_check_reports_uninitialised_vault_as_info() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("v");
        crate::vault::init::init_vault(&root).unwrap();
        let vault = crate::vault::Vault::open(&root).unwrap();

        let mut report = Report::default();
        check_sync(&vault, &mut report);

        // A vault with no `.git` is answered from the filesystem alone: the
        // check must not spawn `git --version` (or anything else) to say so,
        // which is why this test needs no git isolation guard.
        assert!(
            !has_sync_check(&report, "git"),
            "a vault with no .git must not be probed with git: {:#?}",
            report.results
        );
        let repo = sync_result(&report, "repo");
        assert_eq!(repo.status, Status::Info, "{repo:#?}");
        assert!(repo.detail.contains("clep sync init"), "{repo:#?}");
        for name in [
            "branch",
            "managed files",
            "lfs",
            "remote",
            "worktree",
            "exclusions",
        ] {
            assert!(
                !has_sync_check(&report, name),
                "an uninitialised vault stops after `repo`, but reported {name}: {:#?}",
                report.results
            );
        }
    }

    #[test]
    #[serial_test::serial]
    fn sync_check_passes_on_an_initialised_clean_vault_and_flags_unmerged() {
        use crate::vault::gitsync::testing;
        let _env = crate::sync_runtime::tests::isolate_git_process_wide();
        let repos = testing::TestRepos::new();
        let vault = sync_initialised_vault(&repos.a);

        let mut report = Report::default();
        check_sync(&vault, &mut report);

        assert_eq!(sync_result(&report, "repo").status, Status::Ok);
        assert_eq!(sync_result(&report, "branch").status, Status::Ok);
        assert_eq!(sync_result(&report, "managed files").status, Status::Ok);
        assert_eq!(sync_result(&report, "worktree").status, Status::Ok);
        assert_eq!(sync_result(&report, "exclusions").status, Status::Ok);
        let remote = sync_result(&report, "remote");
        assert_eq!(remote.status, Status::Info);
        assert!(remote.detail.contains("remote.git"), "{remote:#?}");
        // git-lfs may or may not be installed on the machine running the
        // suite; the check must report either way and never error.
        let lfs = sync_result(&report, "lfs");
        assert!(matches!(lfs.status, Status::Ok | Status::Warn), "{lfs:#?}");

        // Leave one unmerged path behind by hand — the doctor may only
        // observe an in-progress merge, never start or finish one.
        let ga = testing::git(&repos.a);
        testing::write(&repos.a, "notes/p.md", "A's edit\n");
        ga.add_all().unwrap();
        ga.commit("a edit", &testing::author()).unwrap();
        ga.push("origin", "main").unwrap();

        let gb = testing::git(&repos.b);
        testing::write(&repos.b, "notes/p.md", "B's edit\n");
        gb.add_all().unwrap();
        gb.commit("b edit", &testing::author()).unwrap();
        gb.fetch("origin", "main").unwrap();
        gb.merge_no_commit("origin/main").unwrap();
        assert_eq!(
            gb.unmerged().unwrap().len(),
            1,
            "the hand-made merge should leave exactly one unmerged path"
        );

        let conflicted = crate::vault::Vault::open(&repos.b).unwrap();
        let mut report = Report::default();
        check_sync(&conflicted, &mut report);
        let worktree = sync_result(&report, "worktree");
        assert_eq!(worktree.status, Status::Err, "{worktree:#?}");
        assert!(worktree.detail.contains("1 unmerged file"), "{worktree:#?}");
        assert!(
            worktree
                .hint
                .as_deref()
                .is_some_and(|hint| hint.contains("clep sync")),
            "{worktree:#?}"
        );
    }

    #[test]
    #[serial_test::serial]
    fn sync_check_flags_missing_managed_lines_and_nested_repo() {
        use crate::vault::gitsync::{MANAGED_GITIGNORE, testing};
        let _env = crate::sync_runtime::tests::isolate_git_process_wide();
        let repos = testing::TestRepos::new();
        let vault = sync_initialised_vault(&repos.a);

        let gitignore = repos.a.join(".gitignore");
        let dropped = MANAGED_GITIGNORE[0];
        let kept: String = std::fs::read_to_string(&gitignore)
            .unwrap()
            .lines()
            .filter(|line| *line != dropped)
            .map(|line| format!("{line}\n"))
            .collect();
        std::fs::write(&gitignore, kept).unwrap();

        let mut report = Report::default();
        check_sync(&vault, &mut report);

        let managed = sync_result(&report, "managed files");
        assert_eq!(managed.status, Status::Warn, "{managed:#?}");
        assert!(managed.detail.contains(dropped), "{managed:#?}");
        assert!(
            managed
                .hint
                .as_deref()
                .is_some_and(|hint| hint.contains("clep sync init")),
            "{managed:#?}"
        );
        // Editing a tracked file leaves the tree dirty, which is normal
        // between autocommits and must not be an error.
        let worktree = sync_result(&report, "worktree");
        assert_eq!(worktree.status, Status::Info, "{worktree:#?}");
        assert!(
            worktree.detail.contains("1 uncommitted file")
                && worktree.detail.contains("autocommit"),
            "{worktree:#?}"
        );

        // A vault nested inside an outer repository can never be initialised.
        let tmp = TempDir::new().unwrap();
        testing::git(tmp.path()).init("main").unwrap();
        let inner = tmp.path().join("inner");
        crate::vault::init::init_vault(&inner).unwrap();
        let nested = crate::vault::Vault::open(&inner).unwrap();

        let mut report = Report::default();
        check_sync(&nested, &mut report);

        let repo = sync_result(&report, "repo");
        assert_eq!(repo.status, Status::Err, "{repo:#?}");
        assert!(
            repo.detail.contains("inside another git repository"),
            "{repo:#?}"
        );
        assert!(
            !has_sync_check(&report, "worktree"),
            "a nested repository stops after `repo`: {:#?}",
            report.results
        );
    }

    #[test]
    #[serial_test::serial]
    fn sync_check_warns_when_dot_git_is_not_excluded() {
        use crate::vault::gitsync::testing;
        let _env = crate::sync_runtime::tests::isolate_git_process_wide();
        let repos = testing::TestRepos::new();
        sync_initialised_vault(&repos.a);

        let config_path = repos.a.join(".clepsydra/config.toml");
        let config = std::fs::read_to_string(&config_path).unwrap();
        let without_git = config.replace("    \".git/**\",\n", "");
        assert_ne!(config, without_git, "the default config excludes .git/**");
        std::fs::write(&config_path, without_git).unwrap();
        let vault = crate::vault::Vault::open(&repos.a).unwrap();

        let mut report = Report::default();
        check_sync(&vault, &mut report);

        let exclusions = sync_result(&report, "exclusions");
        assert_eq!(exclusions.status, Status::Warn, "{exclusions:#?}");
        assert!(
            exclusions
                .hint
                .as_deref()
                .is_some_and(|hint| hint.contains("excluded_patterns")),
            "{exclusions:#?}"
        );
    }

    #[test]
    #[serial_test::serial]
    fn sync_check_reports_a_repo_without_the_marker_as_uninitialised() {
        use crate::vault::gitsync::testing;
        let _env = crate::sync_runtime::tests::isolate_git_process_wide();
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("v");
        crate::vault::init::init_vault(&root).unwrap();
        testing::git(&root).init("main").unwrap();
        let vault = crate::vault::Vault::open(&root).unwrap();

        let mut report = Report::default();
        check_sync(&vault, &mut report);

        // `.git` exists here, so the git binary is still checked — only the
        // no-repository case skips it.
        assert_eq!(sync_result(&report, "git").status, Status::Info);
        let repo = sync_result(&report, "repo");
        assert_eq!(repo.status, Status::Info, "{repo:#?}");
        assert!(repo.detail.contains("clep sync init"), "{repo:#?}");
        assert!(
            !has_sync_check(&report, "worktree"),
            "a git repository without the D3 marker is not initialised: {:#?}",
            report.results
        );
    }

    /// D25: the marker is repo-local. A `clep.sync.version` in the user's
    /// global config must not have doctor reporting every vault on the machine
    /// as initialised while `clep sync` refuses each one.
    #[test]
    #[serial_test::serial]
    fn sync_check_ignores_a_marker_inherited_from_the_global_config() {
        use crate::vault::gitsync::INIT_MARKER_KEY;
        use crate::vault::gitsync::git::Git;
        use crate::vault::gitsync::testing;
        let tmp = TempDir::new().unwrap();
        // A private global config carrying the marker, pointed at process-wide
        // because `check_sync` builds its own `Git::new`.
        let global = tmp.path().join("gitconfig-with-marker");
        std::fs::write(&global, "[clep \"sync\"]\n\tversion = 1\n").unwrap();
        let _global = crate::env_test_support::EnvGuard::set("GIT_CONFIG_GLOBAL", &global);
        let _nosystem = crate::env_test_support::EnvGuard::set("GIT_CONFIG_NOSYSTEM", "1");

        let root = tmp.path().join("v");
        crate::vault::init::init_vault(&root).unwrap();
        testing::git(&root).init("main").unwrap();
        let vault = crate::vault::Vault::open(&root).unwrap();
        assert_eq!(
            Git::new(&root)
                .config_get(INIT_MARKER_KEY)
                .unwrap()
                .as_deref(),
            Some("1"),
            "the merged config does see the global marker"
        );

        let mut report = Report::default();
        check_sync(&vault, &mut report);

        let repo = sync_result(&report, "repo");
        assert_eq!(
            repo.status,
            Status::Info,
            "a global marker is not this repository's marker: {repo:#?}"
        );
        assert!(repo.detail.contains("clep sync init"), "{repo:#?}");
        assert!(
            !has_sync_check(&report, "worktree"),
            "the rest of the section is skipped for an uninitialised vault: {:#?}",
            report.results
        );
    }

    #[test]
    #[serial_test::serial]
    fn sync_check_warns_when_the_checked_out_branch_is_not_the_configured_one() {
        use crate::vault::gitsync::testing;
        let _env = crate::sync_runtime::tests::isolate_git_process_wide();
        let repos = testing::TestRepos::new();
        let vault = sync_initialised_vault(&repos.a);
        testing::git(&repos.a)
            .run(&["checkout", "-q", "-b", "scratch"])
            .unwrap();

        let mut report = Report::default();
        check_sync(&vault, &mut report);

        let branch = sync_result(&report, "branch");
        assert_eq!(branch.status, Status::Warn, "{branch:#?}");
        assert!(branch.detail.contains("scratch"), "{branch:#?}");
        assert!(branch.detail.contains("main"), "{branch:#?}");
        assert!(
            branch
                .hint
                .as_deref()
                .is_some_and(|hint| hint.contains("main")),
            "{branch:#?}"
        );
    }

    #[test]
    #[serial_test::serial]
    fn driver_check_warns_until_init_registers_it() {
        let _env = crate::sync_runtime::tests::isolate_git_process_wide();
        // `sync_initialised_vault` runs `gitsync::init`, which now registers
        // the merge driver (Task 3) -> ok. Unset it by hand -> warn.
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("v");
        crate::vault::init::init_vault(&root).unwrap();
        let vault = sync_initialised_vault(&root);
        let mut report = Report::default();
        check_sync(&vault, &mut report);
        assert!(matches!(sync_result(&report, "driver").status, Status::Ok));
        assert!(
            has_sync_check(&report, "driver-path"),
            "a registered driver is also asked whether git could resolve it: {:#?}",
            report.results
        );

        let git = crate::vault::gitsync::git::Git::new(vault.root());
        git.run(&["config", "--unset", "merge.clep.driver"])
            .unwrap();

        let mut report = Report::default();
        check_sync(&vault, &mut report);
        let result = sync_result(&report, "driver");
        assert!(matches!(result.status, Status::Warn));
        assert!(
            result
                .hint
                .as_deref()
                .unwrap_or_default()
                .contains("clep sync init")
        );
        assert!(
            !has_sync_check(&report, "driver-path"),
            "nothing is registered, so there is no command to resolve: {:#?}",
            report.results
        );
    }

    /// The registration is a command line git runs through a shell, so the
    /// driver is only reachable when `clep` resolves on the `PATH` that shell
    /// inherits. Checked against synthetic `PATH`s: the ambient one is the
    /// developer's, and would make this test say different things on
    /// different machines.
    #[cfg(unix)]
    #[test]
    fn driver_path_result_follows_whether_clep_resolves_on_path() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        let (bin, empty) = (tmp.path().join("bin"), tmp.path().join("empty"));
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&empty).unwrap();
        let with_bin = std::env::join_paths([&empty, &bin]).unwrap();
        let without_bin = std::env::join_paths([&empty]).unwrap();

        // Present but not executable: git's shell could not run it either.
        let clep = bin.join("clep");
        std::fs::write(&clep, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&clep, std::fs::Permissions::from_mode(0o644)).unwrap();
        let unrunnable = driver_path_result(Some(with_bin.as_os_str()));
        assert!(matches!(unrunnable.status, Status::Warn), "{unrunnable:#?}");

        std::fs::set_permissions(&clep, std::fs::Permissions::from_mode(0o755)).unwrap();
        let found = driver_path_result(Some(with_bin.as_os_str()));
        assert!(matches!(found.status, Status::Ok), "{found:#?}");

        let missing = driver_path_result(Some(without_bin.as_os_str()));
        assert!(matches!(missing.status, Status::Warn), "{missing:#?}");
        assert!(
            missing.hint.as_deref().unwrap_or_default().contains("PATH"),
            "{missing:#?}"
        );
        assert!(matches!(driver_path_result(None).status, Status::Warn));
    }

    #[test]
    #[serial_test::serial]
    fn conflict_copies_check_lists_copies() {
        let _env = crate::sync_runtime::tests::isolate_git_process_wide();
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("v");
        crate::vault::init::init_vault(&root).unwrap();
        let vault = sync_initialised_vault(&root);
        std::fs::create_dir_all(vault.root().join("notes")).unwrap();
        std::fs::write(vault.root().join("notes/p.conflict.abc1234.md"), "x").unwrap();

        let mut report = Report::default();
        check_sync(&vault, &mut report);
        let result = sync_result(&report, "conflict-copies");
        assert!(matches!(result.status, Status::Warn));
        assert!(result.detail.contains("notes/p.conflict.abc1234.md"));
    }
}
