//! Test-only fixtures for `gitsync`: isolated [`Git`] instances plus a
//! bare remote with two cloned vault roots, used across the sync test
//! suite (this module and later `gitsync` tasks).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tempfile::TempDir;

use super::git::Git;
use super::{Author, INIT_MARKER_KEY, INIT_MARKER_VALUE};
use crate::vault::init::init_vault;

/// The path of an empty file used as `GIT_CONFIG_GLOBAL`, so tests never
/// read (or write) the developer's real global git config. Created once
/// per process; the backing [`TempDir`] is kept alive for the process
/// lifetime.
pub(crate) fn empty_global_config() -> PathBuf {
    static CONFIG: OnceLock<(TempDir, PathBuf)> = OnceLock::new();
    let (_dir, path) = CONFIG.get_or_init(|| {
        let dir = TempDir::new().expect("create temp dir for empty global git config");
        let path = dir.path().join("gitconfig");
        std::fs::write(&path, "").expect("write empty global git config");
        (dir, path)
    });
    path.clone()
}

/// A [`Git`] rooted at `root`, isolated from the developer's real git
/// config: `GIT_CONFIG_GLOBAL` points at an empty file and
/// `GIT_CONFIG_NOSYSTEM=1` skips `/etc/gitconfig`.
pub fn git(root: &Path) -> Git {
    Git::new(root)
        .with_env(
            "GIT_CONFIG_GLOBAL",
            &empty_global_config().display().to_string(),
        )
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
}

/// The `[sync]` author every `TestRepos` clone is seeded with.
pub fn author() -> Author {
    Author {
        name: "Test Author".to_string(),
        email: "test@example.com".to_string(),
    }
}

/// Write `content` to `root/rel`, creating parent directories as needed.
pub fn write(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent dir for testing::write");
    }
    std::fs::write(&path, content).expect("testing::write");
}

/// Read `root/rel` as a UTF-8 string.
pub fn read(root: &Path, rel: &str) -> String {
    std::fs::read_to_string(root.join(rel)).expect("testing::read")
}

/// A bare remote plus two cloned vault roots (`a`, `b`), both sharing one
/// root commit ("init") and both configured with the [`author`] identity.
pub struct TestRepos {
    // Held only to keep the temp dir alive for `TestRepos`'s lifetime
    // (RAII); nothing reads it directly yet.
    #[allow(dead_code)]
    pub tmp: TempDir,
    // Unused until a later task points tests directly at the bare remote.
    #[allow(dead_code)]
    pub remote: PathBuf,
    pub a: PathBuf,
    pub b: PathBuf,
}

impl TestRepos {
    /// Build a bare `remote`, then `a` and `b` as separate `init_vault`
    /// roots pointed at it. `a` pushes the initial commit; `b` fetches and
    /// hard-resets onto it, so both clones start from the same root commit.
    pub fn new() -> Self {
        let tmp = TempDir::new().expect("create temp dir for TestRepos");
        let remote = tmp.path().join("remote.git");
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");

        std::fs::create_dir_all(&remote).expect("create bare remote dir");
        git(&remote)
            .run(&["init", "--bare", "-q", "-b", "main"])
            .expect("init bare remote");

        init_clone(&a, &remote);
        let ga = git(&a);
        assert!(
            matches!(
                ga.push("origin", "main").expect("push root commit from a"),
                super::git::PushOutcome::Pushed
            ),
            "pushing the root commit from a should succeed against a fresh bare remote"
        );

        init_clone(&b, &remote);
        let gb = git(&b);
        gb.fetch("origin", "main")
            .expect("fetch root commit into b");
        gb.run(&["reset", "--hard", "origin/main"])
            .expect("reset b onto the shared root commit");

        Self { tmp, remote, a, b }
    }
}

/// `init_vault` + `git init` + `remote add origin` + the D3 init marker + a
/// `[sync]` author + one `"init"` commit of the whole vault-init layout —
/// everything `clep sync init` itself would have left behind, so a
/// `TestRepos` clone is sync-initialised without every test having to call
/// `init` directly.
fn init_clone(root: &Path, remote: &Path) {
    init_vault(root).expect("init_vault for TestRepos clone");
    let g = git(root);
    g.init("main").expect("git init for TestRepos clone");
    g.remote_add("origin", &remote.display().to_string())
        .expect("remote add origin");
    g.config_set(INIT_MARKER_KEY, INIT_MARKER_VALUE)
        .expect("set D3 init marker for TestRepos clone");
    seed_sync_author(root);
    g.add_all().expect("add -A for TestRepos clone");
    g.commit("init", &author())
        .expect("commit init for TestRepos clone");
}

/// Append a `[sync]` section (the [`author`] identity) to the
/// `init_vault`-generated `.clepsydra/config.toml`.
fn seed_sync_author(root: &Path) {
    let config_path = root.join(".clepsydra/config.toml");
    let mut contents = std::fs::read_to_string(&config_path).expect("read init config.toml");
    contents
        .push_str("\n[sync]\nauthor_name = \"Test Author\"\nauthor_email = \"test@example.com\"\n");
    std::fs::write(&config_path, contents).expect("write [sync] section into config.toml");
}
