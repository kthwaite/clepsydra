//! End-to-end: git invokes the built `clep` binary as a merge driver (D28).

use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

fn git(dir: &Path, global: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", global)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git runs")
}

fn ok(dir: &Path, global: &Path, args: &[&str]) -> String {
    let out = git(dir, global, args);
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn setup(tmp: &TempDir) -> (PathBuf, PathBuf) {
    let global = tmp.path().join("gitconfig");
    std::fs::write(&global, "[user]\n\tname = t\n\temail = t@example.com\n").unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    ok(&repo, &global, &["init", "-b", "main"]);
    let driver = format!("'{}' merge-driver %O %A %B %P", env!("CARGO_BIN_EXE_clep"));
    ok(&repo, &global, &["config", "merge.clep.driver", &driver]);
    ok(
        &repo,
        &global,
        &["config", "merge.clep.recursive", "binary"],
    );
    std::fs::write(repo.join(".gitattributes"), "*.md merge=clep\n").unwrap();
    (repo, global)
}

fn page(tags: &str, body: &str) -> String {
    format!(
        "+++\nid = \"0192b6c0-0000-7000-8000-0000000000f0\"\ntitle = \"P\"\ntags = [{tags}]\n+++\n{body}"
    )
}

fn commit_page(repo: &Path, global: &Path, tags: &str, body: &str, msg: &str) {
    std::fs::write(repo.join("p.md"), page(tags, body)).unwrap();
    ok(repo, global, &["add", "p.md", ".gitattributes"]);
    ok(repo, global, &["commit", "-m", msg]);
}

#[test]
fn git_merge_uses_the_clep_driver_for_a_clean_structural_merge() {
    let tmp = TempDir::new().unwrap();
    let (repo, global) = setup(&tmp);
    commit_page(&repo, &global, "\"a\"", "one\ntwo\nthree\n", "base");
    ok(&repo, &global, &["checkout", "-b", "side"]);
    commit_page(
        &repo,
        &global,
        "\"a\", \"side\"",
        "one\ntwo\nTHREE\n",
        "side",
    );
    ok(&repo, &global, &["checkout", "main"]);
    commit_page(
        &repo,
        &global,
        "\"a\", \"main\"",
        "ONE\ntwo\nthree\n",
        "main",
    );
    let merge = git(&repo, &global, &["merge", "side"]);
    assert!(
        merge.status.success(),
        "{}",
        String::from_utf8_lossy(&merge.stderr)
    );
    let merged = std::fs::read_to_string(repo.join("p.md")).unwrap();
    assert!(
        merged.contains("\"main\"") && merged.contains("\"side\""),
        "{merged}"
    );
    assert!(
        merged.contains("ONE") && merged.contains("THREE"),
        "{merged}"
    );
    assert!(!merged.contains("<<<<<<<"));
}

#[test]
fn residual_body_conflict_leaves_an_unmerged_path_with_frontmatter_intact() {
    let tmp = TempDir::new().unwrap();
    let (repo, global) = setup(&tmp);
    commit_page(&repo, &global, "\"a\"", "line\n", "base");
    ok(&repo, &global, &["checkout", "-b", "side"]);
    commit_page(&repo, &global, "\"a\"", "side line\n", "side");
    ok(&repo, &global, &["checkout", "main"]);
    commit_page(&repo, &global, "\"a\"", "main line\n", "main");
    let merge = git(&repo, &global, &["merge", "side"]);
    assert!(!merge.status.success());
    let unmerged = ok(&repo, &global, &["diff", "--name-only", "--diff-filter=U"]);
    assert_eq!(unmerged.trim(), "p.md");
    let tree_file = std::fs::read_to_string(repo.join("p.md")).unwrap();
    assert!(
        tree_file.starts_with("+++\n"),
        "frontmatter intact: {tree_file}"
    );
    assert!(tree_file.contains("<<<<<<<"), "{tree_file}");
}

/// Drives the library engine end to end: two device roots, a bare remote, and
/// the merge driver registered by `init` (overridden to point at the built
/// binary, since the PATH-based `clep` the driver key names does not resolve
/// in the test environment). Proves the driver and the engine's Conflict-Copy
/// handover work together, not just the driver in isolation.
#[test]
fn full_sync_with_driver_conflicts_hand_over_to_conflict_copies() {
    use clepsydra::vault::Vault;
    use clepsydra::vault::gitsync::Author;
    use clepsydra::vault::gitsync::engine::{MergeSummary, PushStatus, SyncEngine};
    use clepsydra::vault::gitsync::git::{Git, PushOutcome};
    use clepsydra::vault::gitsync::init::{InitOpts, LfsPolicy, init};
    use clepsydra::vault::init::init_vault;

    let tmp = TempDir::new().unwrap();
    let global = tmp.path().join("gitconfig");
    std::fs::write(&global, "[user]\n\tname = t\n\temail = t@example.com\n").unwrap();

    let remote = tmp.path().join("remote.git");
    std::fs::create_dir_all(&remote).unwrap();
    ok(&remote, &global, &["init", "--bare", "-q", "-b", "main"]);
    let remote_url = remote.to_str().unwrap().to_string();

    let author = Author {
        name: "Test Author".to_string(),
        email: "test@example.com".to_string(),
    };
    let driver_cmd = format!("'{}' merge-driver %O %A %B %P", env!("CARGO_BIN_EXE_clep"));

    let isolated = |root: &Path| -> Git {
        Git::new(root)
            .with_env("GIT_CONFIG_GLOBAL", global.to_str().unwrap())
            .with_env("GIT_CONFIG_NOSYSTEM", "1")
    };
    let init_opts = || InitOpts {
        remote: Some(remote_url.clone()),
        author: Some(author.clone()),
        lfs: LfsPolicy::Skip,
        prompt: None,
        legacy_cas: None,
    };

    // Device A seeds the shared history: init, override the driver command
    // (the registered `clep merge-driver ...` is not on PATH here), push.
    let a = tmp.path().join("a");
    init_vault(&a).unwrap();
    let git_a = isolated(&a);
    init(&Vault::open(&a).unwrap(), &git_a, init_opts()).unwrap();
    git_a.config_set("merge.clep.driver", &driver_cmd).unwrap();
    assert!(matches!(
        git_a.push("origin", "main").unwrap(),
        PushOutcome::Pushed
    ));

    // Device B: its own independent init commit is discarded in favour of
    // A's, so both devices share one root commit to diverge from.
    let b = tmp.path().join("b");
    init_vault(&b).unwrap();
    let git_b = isolated(&b);
    init(&Vault::open(&b).unwrap(), &git_b, init_opts()).unwrap();
    git_b.config_set("merge.clep.driver", &driver_cmd).unwrap();
    git_b.fetch("origin", "main").unwrap();
    git_b.run(&["reset", "--hard", "origin/main"]).unwrap();

    let page_path = "p.md";
    let write_page = |root: &Path, tags: &str, body: &str| {
        std::fs::write(root.join(page_path), page(tags, body)).unwrap();
    };
    let sync = |root: &Path| -> clepsydra::vault::gitsync::engine::SyncReport {
        SyncEngine::open_with_git(&Vault::open(root).unwrap(), isolated(root))
            .unwrap()
            .full_sync()
            .unwrap()
    };

    // A publishes the page; B pulls it (fast-forward), so both start level.
    write_page(&a, "\"a\"", "line one\nline two\n");
    let ra0 = sync(&a);
    assert!(matches!(ra0.push, PushStatus::Pushed), "{:?}", ra0.push);
    let rb0 = sync(&b);
    assert!(
        matches!(rb0.merge, MergeSummary::FastForward { .. }),
        "{:?}",
        rb0.merge
    );

    // Scenario 1: A changes only tags, B changes only the body -> the
    // structural driver merges both changes cleanly, no Conflict Copy.
    write_page(&a, "\"a\", \"main\"", "line one\nline two\n");
    let ra1 = sync(&a);
    assert!(matches!(ra1.push, PushStatus::Pushed), "{:?}", ra1.push);

    write_page(&b, "\"a\"", "line one\nLINE TWO\n");
    let rb1 = sync(&b);
    let MergeSummary::Merged {
        conflict_copies, ..
    } = &rb1.merge
    else {
        panic!("expected a merge: {:?}", rb1.merge)
    };
    assert!(conflict_copies.is_empty(), "{:?}", rb1.merge);
    assert!(matches!(rb1.push, PushStatus::Pushed), "{:?}", rb1.push);
    let merged = std::fs::read_to_string(b.join(page_path)).unwrap();
    assert!(merged.contains("\"main\""), "{merged}");
    assert!(merged.contains("LINE TWO"), "{merged}");

    // A catches up to B's merge before the next round diverges again.
    let ra_catchup = sync(&a);
    assert!(
        matches!(ra_catchup.merge, MergeSummary::FastForward { .. }),
        "{:?}",
        ra_catchup.merge
    );

    // Scenario 2: both devices edit the SAME body line from that shared
    // base -> the driver cannot reconcile it, exits 1, and the engine
    // resolves the path with ours-plus-one-Conflict-Copy.
    write_page(&a, "\"a\", \"main\"", "A's line one\nLINE TWO\n");
    let ra2 = sync(&a);
    assert!(matches!(ra2.push, PushStatus::Pushed), "{:?}", ra2.push);

    write_page(&b, "\"a\", \"main\"", "B's line one\nLINE TWO\n");
    let rb2 = sync(&b);
    let MergeSummary::Merged {
        conflict_copies, ..
    } = &rb2.merge
    else {
        panic!("expected a merge: {:?}", rb2.merge)
    };
    assert_eq!(conflict_copies.len(), 1, "{:?}", rb2.merge);
    let ours = std::fs::read_to_string(b.join(page_path)).unwrap();
    assert!(ours.contains("B's line one"), "{ours}");
    let copy = std::fs::read_to_string(b.join(&conflict_copies[0].copy)).unwrap();
    assert!(copy.contains("A's line one"), "{copy}");
}
