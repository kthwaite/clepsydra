# Sync Merge (phase 4b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish `clep sync`: a structural markdown merge driver, an automatic post-sync journal merger, doctor + UI surfacing of Conflict Copies, and the phase-4a carry-forward hardening.

**Architecture:** Phase 4a (merged as `a5958381`) delivered `src/vault/gitsync/` (init, engine, Conflict Copies), the server quiesce runtime, the sync API and CLI. Phase 4b adds `merge_driver.rs` (pure 3-way page merge invoked by git as `clep merge-driver`), `journal_merge.rs` (fold duplicate journal pages after every tree-changing pull), new doctor rules in a split-out `src/doctor/sync.rs`, an index-backed `GET /api/vault/sync/conflicts` + `/conflicts` UI view, and a hardening pass over the engine/state carry-forwards from the 4a final review.

**Tech Stack:** Rust 2024 (clap, tempfile, walkdir, toml, chrono, utoipa, axum-test), system `git` (`merge-file`), React 19 + TanStack Router/Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-clep-sync-design.md` (§§5, 8, 9, 10) + ADR 0004. Phase 4a decisions D1–D16 live in `docs/superpowers/plans/2026-08-28-sync-core.md`. Carry-forward list: `.superpowers/sdd/2026-08-28-sync-core/progress.md` (main checkout, gitignored).

## Global Constraints

- **NEVER run a built `clep` binary without `CLEPSYDRA__VAULT__ROOT=<scratch>`** — the ambient `~/.config/clepsydra/config.toml` points at the LIVE vault. The one exception is `clep merge-driver`, which by design reads no config (verify this stays true).
- **Never `git add .` / `git add -A` in this repository** — stage explicit paths. (The engine's `add_all()` inside *vault test repos* is fine; the constraint is about the clepsydra repo itself.)
- Tests that spawn real `git` must be isolated: unit tests use `gitsync::testing::git(root)` / `testing::TestRepos`; tests that construct `Git::new` directly (doctor) are `#[serial_test::serial]` + `crate::sync_runtime::tests::isolate_git_process_wide()`; integration tests set `GIT_CONFIG_GLOBAL=<empty file>` + `GIT_CONFIG_NOSYSTEM=1` on every git invocation.
- A fresh worktree needs `ui/dist` before `cargo test` compiles (rust-embed): `cp -R <main>/ui/dist ui/dist`.
- Never pipe cargo through `tail`/`grep` where the exit code matters.
- Rust must stay `cargo fmt` + `cargo clippy` clean; ui files biome-format-clean (run `bunx biome format --write <files>` from `ui/`; never touch `routeTree.gen.ts` / `schema.d.ts` formatting).
- Every new UI route MUST declare `staticData.codexView`, a `VIEW_REGISTRY` entry, a `routeViews.test.ts` row, and `featureInventory.ts` rows — four different files, all enforced by tests.
- After any backend route/DTO change, regenerate `ui/src/api/schema.d.ts` (see Task 6 Step 8 for the exact procedure).
- Known pre-existing UI vitest failures on develop (NOT regressions — do not chase): InscribeModal ×2, Sheaf ×2, one mdx-smoke case; plus a load-flaky feeds timing test.
- `clep doctor` stays read-only.

## Locked decisions (D17–D28)

- **D17 — driver contract.** `clep merge-driver <base> <ours> <theirs> [pathname]` is a hidden clap command. The result is always written over the `<ours>` file (`%A`); exit 0 = clean merge, exit 1 = residual conflict. Any internal failure leaves `%A` untouched and exits 1 — git then marks the path unmerged and the engine's Conflict Copy path (unchanged from 4a) takes over. The driver reads no settings, no vault config, spawns nothing but `git merge-file`.
- **D18 — driver algorithm.** If ours or theirs is non-UTF-8 or fails strict `parse_frontmatter` → whole-file 3-way text merge via `git merge-file -p`, its exit deciding cleanliness. If either side is encrypted (`meta.encryption.is_some()`) and bodies differ → conflict, `%A` = ours verbatim. Differing `id`s → conflict (two different pages at one path). Otherwise: field-wise 3-way frontmatter merge (`updated_at` = max, `created_at` = min, `tags`/`aliases` = 3-way set merge honouring removals, every other field + every extra key = scalar 3-way where both-changed-differently is a whole-file conflict with `%A` = ours verbatim), body via `git merge-file -p`. A body conflict outputs merged frontmatter + marker body and exits 1 (the phase-1 conflict-marker guard indexes such a file read-only and doctor flags it — the intended hand-git experience). A clean merge is serialized with `write_page_content` — canonical TOML `+++` frontmatter, meaning a legacy-YAML page comes out converted; the merge rewrote the file anyway.
- **D19 — registration.** `clep sync init` writes repo-local git config `merge.clep.name = "clepsydra structural markdown merge"`, `merge.clep.driver = "clep merge-driver %O %A %B %P"`, `merge.clep.recursive = "binary"` right after the D3 marker; re-running init on an initialised vault adds them (init is idempotent). The command resolves `clep` via PATH. Doctor gains a `driver` check that warns when the key is unset ("run `clep sync init`"). The 4a-written `.gitattributes` line `*.md merge=clep` finally means something; until registration git silently used the default text merge, which is exactly the 4a behaviour.
- **D20 — journal shape.** Spec §8's "`## HH:MM` sections" does not match the code: journal entries are `- HH:MM — ` bullets (U+2014 em dash, `src/api/journal.rs:520`), multi-line content lands at column 0 under the bullet, and non-bullet "block constructs" pass through unstamped. The merger segments on `^- \d\d:\d\d — ` and treats everything until the next such line as part of the current block. The spec is amended by this plan, not the other way round (confirmed against production vault content).
- **D21 — merger scope.** For each (top-level folder ∈ {`journals`, `ai-journals`}, `journal_date`) with more than one page — including Conflict Copies whose `conflict_of` points at a journal page (they have no `journal_date` of their own by 4a design) — the OLDEST page wins (conflict copies always lose; then `created_at` ascending, `None` last; then path ascending). Loser blocks not byte-identical (modulo trailing whitespace) to an existing block interleave by `HH:MM` (stable; untimed blocks append in source order). Winner `updated_at` = max over the group. Losers are deleted; a vault-wide pass rewrites stem- and path-form links loser → winner via `rewrite_links_in_content`. Title/date links (`[[2026-08-29]]`) already resolve to the winner and are untouched.
- **D22 — merger wiring.** The merger runs inside the engine after every tree-changing pull (the main pull AND the push-retry pull), before the push; its changes are committed as `sync: merge N duplicate journal page(s) (<dates>)` with the Device trailer. A merger failure is a warning, never a failed sync (doctor's duplicate rule is the backstop). `SyncReport` gains `journal_merges`.
- **D23 — `NotFetched`.** New `MergeSummary::NotFetched` variant reported by `commit_and_push` (shutdown path) instead of the misleading `UpToDate`; DTO string `not_fetched`, `one_line()` says "no fetch", `tree_changed()` stays false.
- **D24 — leftover merges respect hand edits.** When resolving an unmerged path, a working-tree file that differs from stage 2 (ours) and contains no conflict markers is a hand-made resolution: it is taken as-is, no Conflict Copy. (During engine-driven merges the worktree at a conflicted path holds the marker version or, with the driver, ours verbatim — so this only fires for genuinely hand-edited leftovers.) A cherry-pick or rebase in progress (`CHERRY_PICK_HEAD` / `REBASE_HEAD` resolvable) makes the sync refuse with a clear error instead of committing residue.
- **D25 — real git dir.** New `Git::git_dir()` (`rev-parse --absolute-git-dir`), resolved once at engine open; `state.rs` reads/writes `<git-dir>/clep-sync.toml` so linked worktrees work. The D3 marker read becomes `config --local --get` so a global `clep.sync.version` can never fake initialisation.
- **D26 — index-backed conflicts.** `GET /api/vault/sync/conflicts` lists Conflict Copies from `page_properties` (`key = 'conflict_of'` — extras are schema-blindly indexed) joined to `pages`; the server's status handler counts them the same way and passes the count into a new `SyncEngine::status_with_copies`, ending the per-poll vault walk. The walk-based `status()` remains for the standalone CLI. The endpoint works on never-synced vaults (hand-git can produce copies) and is not gated on the sync runtime.
- **D27 — UI.** New `/conflicts` route + `conflicts` CodexView, palette-only navigation (like Repairs: no sidebar entry). The view lists copies with title, copy path, original path (+ "original missing" note), opens either in a tab, and explains resolution: fold what you want back into the original by ordinary editing, then delete the copy. No merge UI (spec: deferred).
- **D28 — e2e.** `tests/merge_driver_test.rs` registers `env!("CARGO_BIN_EXE_clep")` as the repo's merge driver and proves (a) a structurally clean merge (both frontmatter and disjoint body edits, no unmerged paths, tags unioned, `updated_at` = max) and (b) a residual body conflict handing over to the 4a Conflict Copy path via a real `SyncEngine::full_sync`.
- **LFS pointers (folded into D24's task):** `resolve_unmerged` detects git-LFS pointer content (`version https://git-lfs.github.com/spec/v1` prefix) on the "theirs" stage of a both-changed path and keeps ours with a warning instead of writing a pointer-text Conflict Copy.

## File structure

| File | Responsibility |
|---|---|
| `src/vault/gitsync/merge_driver.rs` (new) | Pure 3-way page merge (`merge`, `run_cli`) + unit tests |
| `src/vault/gitsync/journal_merge.rs` (new) | Duplicate-journal detection (`duplicate_journal_groups`) + merge (`merge_duplicate_journals`) |
| `src/vault/gitsync/{engine,state,git,init,mod}.rs` | Carry-forward hardening; merger + driver wiring |
| `src/doctor/mod.rs` (moved from `src/doctor.rs`) + `src/doctor/sync.rs` (new) | Doctor split; new `driver`, `conflict-copies`, `journals` rules |
| `src/bin/cli.rs` | Hidden `MergeDriver` command |
| `src/api/sync.rs` | `/sync/conflicts` endpoint, `not_fetched`, `journal_merges` DTO, index-backed status count |
| `tests/merge_driver_test.rs` (new) | D28 e2e |
| `ui/src/routes/conflicts.tsx`, `ui/src/components/conflicts/ConflictsPanel.tsx` (new) + registry/palette/inventory/keys/api touches | Conflicts view |
| `ui/src/docs/content/{sync,cli,api-reference}.mdx`, `CONTEXT.md` | Docs |

Execution: worktree `.worktrees/sync-merge`, branch `feature/sync-merge` off `develop` (`a5958381` or later). Copy `ui/dist` in before the first `cargo test`.

---

### Task 1: Engine & repo-shape hardening (4a carry-forwards)

**Files:**
- Modify: `src/vault/gitsync/engine.rs` (NotFetched; hand-edit + LFS-pointer resolution; cherry-pick guard; combined leftover CommitSummary; commit_and_push error state; git-dir plumbing)
- Modify: `src/vault/gitsync/git.rs` (`git_dir`, `config_get_local`)
- Modify: `src/vault/gitsync/state.rs` (state file under the resolved git dir)
- Modify: `src/vault/gitsync/mod.rs` (`is_initialised` via `--local`; new `SyncError` variant; shared `plural`/`first_line`)
- Modify: `src/vault/gitsync/init.rs` (`ssh_target` rejects non-ssh schemes; unborn-HEAD adopt repoints the branch)
- Modify: `src/api/sync.rs` (`not_fetched` DTO arm), `src/sync_command.rs` (render arm for `not_fetched`)
- Modify: `src/sync_runtime.rs` (keep `pending` set after a tree-changing sync)

**Interfaces:**
- Consumes: everything as merged in 4a.
- Produces (later tasks rely on): `Git::git_dir(&self) -> Result<PathBuf, GitError>`; `Git::config_get_local(&self, key: &str) -> Result<Option<String>, GitError>`; `state::load(git_dir: &Path) -> SyncState` / `state::save(git_dir: &Path, ..)` (signature change: the argument is now the git dir, not the vault root); `MergeSummary::NotFetched`; `SyncError::GitOperationInProgress { operation: String }`; `pub(crate) fn plural(usize) -> &'static str` and `pub(crate) fn first_line(&str) -> &str` moved to `gitsync/mod.rs`.

- [ ] **Step 1: failing tests for `git_dir` + linked-worktree state + `--local` marker** — in `engine.rs`/`mod.rs`/`git.rs` test modules:

```rust
// git.rs tests
#[test]
fn git_dir_resolves_the_real_git_directory() {
    let repos = testing::TestRepos::new();
    let dir = testing::git(&repos.a).git_dir().unwrap();
    assert_eq!(dir, repos.a.join(".git").canonicalize().unwrap());
}

// engine.rs tests
#[test]
fn state_lands_in_the_linked_worktree_git_dir() {
    let repos = testing::TestRepos::new();
    testing::write(&repos.a, "n.md", &page("20", "N", "x"));
    engine(&repos.a).full_sync().unwrap();
    let linked = repos.tmp.path().join("a-linked");
    testing::git(&repos.a)
        .run(&["worktree", "add", linked.to_str().unwrap(), "-b", "linked", "main"])
        .unwrap();
    // The linked checkout carries .clepsydra/config.toml (it is in the tree),
    // and repo-local config (the D3 marker) is shared, so the engine opens.
    let vault = Vault::open(&linked).unwrap();
    let eng = SyncEngine::open_with_git(&vault, testing::git(&linked)).unwrap();
    // main is checked out in repos.a, so the linked worktree gets its own branch;
    // status alone exercises load+the branch fields; a sync exercises save.
    testing::write(&linked, "m.md", &page("21", "M", "y"));
    let report = eng.commit_and_push();
    assert!(report.is_ok(), "{report:?}"); // save_state must not ENOTDIR
    let git_dir = testing::git(&linked).git_dir().unwrap();
    assert!(git_dir.join("clep-sync.toml").is_file(), "state in {git_dir:?}");
}
```

Note: `commit_and_push` on the linked worktree will try to push branch `linked` — the engine pushes `[sync] branch` (= `main`); a push of main from the linked worktree is fine (same repo). If `open_with_git` refuses on a branch mismatch, adjust the test to `git.run(&["symbolic-ref", "HEAD", "refs/heads/main"])`-free approach: check out `main` is NOT possible (busy) — instead relax: assert only `eng.status()` works and `state::save` via a direct call:

```rust
    crate::vault::gitsync::state::save(&git_dir, &crate::vault::gitsync::state::SyncState {
        last_sync_at: Some(chrono::Utc::now()),
        last_result: Some("test".into()),
    }).unwrap();
    assert!(crate::vault::gitsync::state::load(&git_dir).last_result.is_some());
```

```rust
// mod.rs tests
#[test]
#[serial_test::serial]
fn a_global_marker_does_not_count_as_initialised() {
    let repos = testing::TestRepos::new();
    let g = testing::git(&repos.a);
    // Write the marker into the isolated *global* config file.
    let global = g.env_value("GIT_CONFIG_GLOBAL").unwrap();
    std::fs::write(&global, "[clep \"sync\"]\n\tversion = 1\n").unwrap();
    g.run(&["config", "--local", "--unset", super::INIT_MARKER_KEY]).unwrap();
    let vault = crate::vault::Vault::open(&repos.a).unwrap();
    assert!(!super::is_initialised(&vault, &g).unwrap());
}
```

(If `--unset` errors because the key format differs, use `config --local --unset clep.sync.version` via `run_raw` and ignore exit 5.)

- [ ] **Step 2: run — all three fail** (`git_dir`/`config_get_local` don't exist; state saved under `.git` blindly; `is_initialised` reads merged config).

- [ ] **Step 3: implement git-dir plumbing**

`git.rs`, next to `toplevel()`:

```rust
    /// The repository's real git directory (`.git`, or the per-worktree dir
    /// inside the main repository for a linked worktree).
    pub fn git_dir(&self) -> Result<PathBuf, GitError> {
        self.run(&["rev-parse", "--absolute-git-dir"])
            .map(|out| PathBuf::from(out.trim()))
    }

    /// `git config --local --get`: repo-local values only, so an inherited
    /// global value can never satisfy a repo-scoped marker.
    pub fn config_get_local(&self, key: &str) -> Result<Option<String>, GitError> {
        // Mirror config_get's treatment of exit code 1 = unset.
    }
```

(Copy `config_get`'s body, inserting `"--local"` after `"config"`.)

`state.rs`: change `state_path(root: &Path)` to `state_path(git_dir: &Path) -> PathBuf { git_dir.join("clep-sync.toml") }`; `load`/`save` take `git_dir: &Path`; update the module doc ("the repository's git directory (D8); in a linked worktree that is the per-worktree dir"). Update its unit test to pass a plain temp dir (no `.git` join needed any more).

`engine.rs`: add `git_dir: PathBuf` to `SyncEngine`, resolved in `open_with_git` (`let git_dir = git.git_dir()?;`); `save_state`/`status` pass `&self.git_dir` to `state::{save,load}`.

`mod.rs`: `is_initialised` uses `git.config_get_local(INIT_MARKER_KEY)`.

- [ ] **Step 4: run — Step-1 tests pass; whole gitsync suite still green** (`cargo test gitsync`).

- [ ] **Step 5: failing tests for NotFetched + commit_and_push error state + pending-after-sync**

```rust
// engine.rs tests
#[test]
fn commit_and_push_reports_not_fetched_with_a_remote() {
    let repos = testing::TestRepos::new();
    testing::write(&repos.a, "n.md", &page("22", "N", "x"));
    let report = engine(&repos.a).commit_and_push().unwrap();
    assert!(matches!(report.merge, MergeSummary::NotFetched));
    assert!(report.one_line().contains("no fetch"), "{}", report.one_line());
    assert!(!report.tree_changed());
}

#[test]
fn commit_and_push_failure_records_an_error_state() {
    let repos = testing::TestRepos::new();
    testing::write(&repos.a, "n.md", &page("23", "N", "x"));
    engine(&repos.a).full_sync().unwrap();
    // Poison the index so commit_local fails hard.
    let git_dir = testing::git(&repos.a).git_dir().unwrap();
    let index = git_dir.join("index");
    std::fs::write(&index, "garbage").unwrap();
    testing::write(&repos.a, "n2.md", &page("24", "N2", "y"));
    let err = engine(&repos.a).commit_and_push();
    assert!(err.is_err());
    let state = crate::vault::gitsync::state::load(&git_dir);
    assert!(state.last_result.unwrap_or_default().starts_with("error:"), "state records the failure");
}
```

```rust
// sync_runtime.rs tests — extend run_full_sync_commits_pulls_reindexes_and_notifies
// (or add a sibling): after a tree-changing sync, pending_autocommit() is true;
// after a no-change sync it is false.
```

- [ ] **Step 6: implement** — `MergeSummary::NotFetched` variant (doc: "Nothing was fetched — the shutdown path pushes without pulling."); `one_line` arm `"no fetch"`; `commit_and_push` uses it when a remote exists; extract `commit_and_push_inner` and wrap exactly like `full_sync` wraps `full_sync_inner` (record `error: <first_line>` state on Err). `fold_merges` needs no arm (NotFetched never reaches it). `src/api/sync.rs` `From<&SyncReport>`: add `MergeSummary::NotFetched => ("not_fetched", None)` and extend the `merge` field doc-comment string list. `src/sync_command.rs`: find the render match on the DTO `merge` string (rg `"fast_forward"` in that file) and add a `"not_fetched" => "no fetch (shutdown push)"`-style arm consistent with neighbours. `sync_runtime.rs`: replace `self.pending.store(false, ..)` in `run_full_sync_window` with `self.pending.store(report.tree_changed(), Ordering::SeqCst);` + comment: a tree-changing merge may be followed by reconcile moves in `rebuild_after_sync`; the debounced autocommit sweeps them up, and `commit_local` on a clean tree is two cheap git calls.

- [ ] **Step 7: run** — Step-5 tests + full `cargo test sync` green.

- [ ] **Step 8: failing tests for D24 (hand edits, cherry-pick guard, LFS pointers)**

```rust
// engine.rs tests
#[test]
fn hand_resolved_leftover_merge_is_kept_without_a_copy() {
    let repos = testing::TestRepos::new();
    testing::write(&repos.a, "notes/p.md", &page("30", "Plan", "base"));
    engine(&repos.a).full_sync().unwrap();
    engine(&repos.b).full_sync().unwrap();
    testing::write(&repos.a, "notes/p.md", &page("30", "Plan", "A's edit"));
    engine(&repos.a).full_sync().unwrap();
    testing::write(&repos.b, "notes/p.md", &page("30", "Plan", "B's edit"));
    let gb = testing::git(&repos.b);
    gb.add_all().unwrap();
    gb.commit("b", &testing::author()).unwrap();
    gb.fetch("origin", "main").unwrap();
    assert_eq!(gb.merge_no_commit("origin/main").unwrap().status, 1);
    // The user resolves by hand: no markers, not equal to either side.
    testing::write(&repos.b, "notes/p.md", &page("30", "Plan", "hand-merged"));
    engine(&repos.b).commit_local().unwrap().unwrap();
    assert_eq!(testing::read(&repos.b, "notes/p.md"), page("30", "Plan", "hand-merged"));
    assert!(find_conflict_copies(&repos.b).is_empty(), "hand resolution needs no copy");
}

#[test]
fn cherry_pick_in_progress_refuses_to_sync() {
    let repos = testing::TestRepos::new();
    testing::write(&repos.a, "c.md", &page("31", "C", "base"));
    let ga = testing::git(&repos.a);
    engine(&repos.a).full_sync().unwrap();
    ga.run(&["checkout", "-b", "side"]).unwrap();
    testing::write(&repos.a, "c.md", &page("31", "C", "side edit"));
    ga.add_all().unwrap();
    let side = ga.commit("side", &testing::author()).unwrap();
    ga.run(&["checkout", "main"]).unwrap();
    testing::write(&repos.a, "c.md", &page("31", "C", "main edit"));
    ga.add_all().unwrap();
    ga.commit("main", &testing::author()).unwrap();
    let _ = ga.run_raw(&["cherry-pick", &side]); // conflicts, leaves CHERRY_PICK_HEAD
    assert!(ga.rev_parse("CHERRY_PICK_HEAD").unwrap().is_some());
    let err = engine(&repos.a).full_sync().unwrap_err();
    assert!(matches!(err, SyncError::GitOperationInProgress { .. }), "{err}");
}

#[test]
fn lfs_pointer_theirs_is_not_written_as_a_copy() {
    const POINTER_A: &str = "version https://git-lfs.github.com/spec/v1\noid sha256:aaaa\nsize 1\n";
    const POINTER_B: &str = "version https://git-lfs.github.com/spec/v1\noid sha256:bbbb\nsize 2\n";
    let repos = testing::TestRepos::new();
    testing::write(&repos.a, "blob.bin", "base");
    engine(&repos.a).full_sync().unwrap();
    engine(&repos.b).full_sync().unwrap();
    testing::write(&repos.a, "blob.bin", POINTER_A);
    engine(&repos.a).full_sync().unwrap();
    testing::write(&repos.b, "blob.bin", POINTER_B);
    let rb = engine(&repos.b).full_sync().unwrap();
    assert!(rb.conflict_copies().is_empty(), "{:?}", rb.merge);
    assert!(rb.warnings.iter().any(|w| w.contains("LFS pointer")), "{:?}", rb.warnings);
    assert_eq!(testing::read(&repos.b, "blob.bin"), POINTER_B, "ours stays");
}
```

- [ ] **Step 9: implement D24** in `engine.rs`:

In `resolve_unmerged`'s `(true, true)` arm, before the checkout:

```rust
                (true, true) => {
                    let ours = self.git.show_stage(2, path)?;
                    let theirs = self.git.show_stage(3, path)?;
                    // A hand-made resolution (differs from ours, carries no
                    // conflict markers) is kept as it is — overwriting it
                    // with stage 2 would throw the user's merge away (D24).
                    let worktree = std::fs::read(self.root.join(path)).ok();
                    let hand_resolved = worktree.as_deref().is_some_and(|w| {
                        w != ours.as_slice()
                            && std::str::from_utf8(w)
                                .map(|t| !crate::vault::conflict::has_conflict_markers(t))
                                .unwrap_or(true)
                    });
                    if hand_resolved {
                        self.git.add(&[path])?;
                    } else {
                        self.git.checkout_side(Side::Ours, path)?;
                        if ours == theirs {
                            self.git.add(&[path])?;
                        } else if is_lfs_pointer(&theirs) {
                            warnings.push(format!(
                                "both sides changed {path}, but the incoming side is a git-LFS pointer; kept ours and wrote no conflict copy"
                            ));
                            self.git.add(&[path])?;
                        } else {
                            let copy = write_conflict_copy(&self.root, path, &theirs)?;
                            self.git.add(&[path, copy.copy.as_str()])?;
                            copies.push(copy);
                        }
                    }
                }
```

```rust
/// Git-LFS pointer files start with this exact line (LFS spec v1).
fn is_lfs_pointer(bytes: &[u8]) -> bool {
    bytes.starts_with(b"version https://git-lfs.github.com/spec/v1")
}
```

In `commit_leftover_merge`, before resolving: refuse when a different operation owns the unmerged state:

```rust
        for (reference, operation) in [("CHERRY_PICK_HEAD", "cherry-pick"), ("REBASE_HEAD", "rebase")] {
            if self.git.rev_parse(reference)?.is_some() {
                return Err(SyncError::GitOperationInProgress {
                    operation: operation.to_string(),
                });
            }
        }
```

`mod.rs` new variant:

```rust
    #[error("a {operation} is in progress in this repository; finish or abort it (`git {operation} --continue|--abort`), then sync again")]
    GitOperationInProgress { operation: String },
```

Combined leftover CommitSummary: in `commit_local`, when a leftover merge was committed AND loose entries follow, return a summary whose `files` is the sum and whose `message` is the second commit's, and push a tracing::info naming the leftover commit (the report's `committed` then reflects everything the sync committed — the 4a review's "leftover CommitSummary dropped" carry).

```rust
        Ok(Some(match leftover {
            Some(leftover) => CommitSummary {
                sha,
                files: leftover.files + entries.len(),
                message,
            },
            None => CommitSummary { sha, files: entries.len(), message },
        }))
```

- [ ] **Step 10: run — Step-8 tests pass.**

- [ ] **Step 11: init fixes + helper cleanup.** In `init.rs`: (a) find `ssh_target` and make any URL containing `"://"` with a scheme other than `ssh` return `None` (a `file://…` or `https://…` remote must never be probed over ssh); add/extend its unit test with `file:///x/y.git` and `https://example.com/x.git`. (b) In the adopt path, when `git.head()?` is `None` (unborn HEAD) and the symbolic ref name differs from the configured branch, repoint instead of failing: `git.run(&["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")])?;` with a comment (no commits exist, so renaming the unborn branch is safe); unit test: `git init` with `-b master`-style default, then `init()` with branch `main` succeeds and the initial commit lands on `main`. (c) Move `plural` and `first_line` from `engine.rs` to `mod.rs` as `pub(crate) fn`, delete `conflict_copy.rs`'s private `file_stem` twin by making it `pub(crate)` and using it from `engine::page_title`. (d) `rg -n "D10" src/` and fix any comment misciting D10 (D10 = one rebuild + one SSE event after sync).

- [ ] **Step 12: gates + commit.**

```bash
cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test
git add src/vault/gitsync src/api/sync.rs src/sync_command.rs src/sync_runtime.rs
git commit -m "fix(sync): 4a carry-forwards — NotFetched, hand-edit-preserving resolution, cherry-pick guard, git-dir state, local-scope marker, LFS pointer copies, pending sweep"
```

---

### Task 2: Merge driver core + hidden CLI command

**Files:**
- Create: `src/vault/gitsync/merge_driver.rs`
- Modify: `src/vault/gitsync/mod.rs` (declare module), `src/bin/cli.rs` (hidden `MergeDriver` command), `src/vault/page.rs` (derive `PartialEq` on `EncryptionMeta` if it lacks one — check first; it is a plain data struct)
- Test: unit tests inside `merge_driver.rs`

**Interfaces:**
- Consumes: `parse_frontmatter`, `write_page_content`, `PageMeta`, `ExtraMap` (`src/vault/page.rs`); `tempfile` (already a regular dependency, Cargo.toml:47).
- Produces: `pub struct DriverOutcome { pub content: Vec<u8>, pub clean: bool }`; `pub fn merge(base: &[u8], ours: &[u8], theirs: &[u8]) -> DriverOutcome`; `pub fn run_cli(base: &Path, ours: &Path, theirs: &Path) -> i32`. Task 3 registers it; Task 5's doctor references the config key only.

- [ ] **Step 1: write the failing unit tests** (new file with module skeleton so it compiles: `merge` returning `todo!()` is fine, or write tests first against the final signatures):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn page(id_tail: &str, extra_fm: &str, body: &str) -> Vec<u8> {
        format!(
            "+++\nid = \"0192b6c0-0000-7000-8000-0000000000{id_tail}\"\n{extra_fm}+++\n{body}"
        ).into_bytes()
    }

    #[test]
    fn disjoint_field_and_body_edits_merge_clean() {
        let base = page("01", "title = \"T\"\ntags = [\"a\"]\n", "one\ntwo\nthree\n");
        let ours = page("01", "title = \"T\"\ntags = [\"a\", \"b\"]\n", "ONE\ntwo\nthree\n");
        let theirs = page("01", "title = \"Renamed\"\ntags = [\"a\", \"c\"]\n", "one\ntwo\nTHREE\n");
        let out = merge(&base, &ours, &theirs);
        assert!(out.clean);
        let text = String::from_utf8(out.content).unwrap();
        let (meta, body) = crate::vault::page::parse_frontmatter(&text).unwrap();
        assert_eq!(meta.title.as_deref(), Some("Renamed"));
        assert_eq!(meta.tags, vec!["a", "b", "c"]);
        assert_eq!(body, "ONE\ntwo\nTHREE\n");
    }

    #[test]
    fn tag_removals_are_honoured() {
        let base = page("02", "tags = [\"keep\", \"drop\"]\n", "b\n");
        let ours = page("02", "tags = [\"keep\"]\n", "b\n");
        let theirs = page("02", "tags = [\"keep\", \"drop\", \"new\"]\n", "b\n");
        let out = merge(&base, &ours, &theirs);
        assert!(out.clean);
        let (meta, _) = crate::vault::page::parse_frontmatter(std::str::from_utf8(&out.content).unwrap()).unwrap();
        assert_eq!(meta.tags, vec!["keep", "new"]);
    }

    #[test]
    fn updated_at_takes_the_max_created_at_the_min() {
        let base = page("03", "created_at = 2026-01-01T00:00:00Z\nupdated_at = 2026-01-01T00:00:00Z\n", "b\n");
        let ours = page("03", "created_at = 2026-01-01T00:00:00Z\nupdated_at = 2026-02-01T00:00:00Z\n", "b\n");
        let theirs = page("03", "created_at = 2025-12-01T00:00:00Z\nupdated_at = 2026-03-01T00:00:00Z\n", "b\n");
        let out = merge(&base, &ours, &theirs);
        assert!(out.clean);
        let (meta, _) = crate::vault::page::parse_frontmatter(std::str::from_utf8(&out.content).unwrap()).unwrap();
        assert_eq!(meta.updated_at.unwrap().to_rfc3339(), "2026-03-01T00:00:00+00:00");
        assert_eq!(meta.created_at.unwrap().to_rfc3339(), "2025-12-01T00:00:00+00:00");
    }

    #[test]
    fn both_changed_scalar_is_a_conflict_with_ours_verbatim() {
        let base = page("04", "title = \"T\"\n", "b\n");
        let ours = page("04", "title = \"Ours\"\n", "b\n");
        let theirs = page("04", "title = \"Theirs\"\n", "b\n");
        let out = merge(&base, &ours, &theirs);
        assert!(!out.clean);
        assert_eq!(out.content, ours);
    }

    #[test]
    fn body_conflict_outputs_markers_and_exit_one() {
        let base = page("05", "", "line\n");
        let ours = page("05", "", "ours line\n");
        let theirs = page("05", "", "theirs line\n");
        let out = merge(&base, &ours, &theirs);
        assert!(!out.clean);
        let text = String::from_utf8(out.content).unwrap();
        assert!(text.starts_with("+++\n"), "frontmatter survives: {text}");
        assert!(crate::vault::conflict::has_conflict_markers(&text));
    }

    #[test]
    fn different_ids_are_a_conflict() {
        let ours = page("06", "", "b\n");
        let theirs = page("07", "", "b\n");
        let out = merge(b"", &ours, &theirs);
        assert!(!out.clean);
        assert_eq!(out.content, ours);
    }

    #[test]
    fn encrypted_bodies_never_text_merge() {
        // Build an encrypted-ish page: any frontmatter that parses with
        // `encryption` set. Read EncryptionMeta's fields in src/vault/page.rs
        // and inline the minimal valid TOML for it here.
        let fm = "[encryption]\n…minimal valid fields…\n";
        let base = page("08", fm, "AGE-A\n");
        let ours = page("08", fm, "AGE-B\n");
        let theirs = page("08", fm, "AGE-C\n");
        let out = merge(&base, &ours, &theirs);
        assert!(!out.clean);
        assert_eq!(out.content, ours);
    }

    #[test]
    fn non_page_files_fall_back_to_plain_text_merge() {
        let out = merge(b"a\nb\n", b"A\nb\n", b"a\nB\n");
        assert!(out.clean);
        assert_eq!(out.content, b"A\nB\n");
    }

    #[test]
    fn extras_merge_per_key() {
        let base = page("09", "custom = \"x\"\n", "b\n");
        let ours = page("09", "custom = \"x\"\nmine = 1\n", "b\n");
        let theirs = page("09", "custom = \"y\"\n", "b\n");
        let out = merge(&base, &ours, &theirs);
        assert!(out.clean);
        let (meta, _) = crate::vault::page::parse_frontmatter(std::str::from_utf8(&out.content).unwrap()).unwrap();
        assert_eq!(meta.extra.get("custom").and_then(|v| v.as_str()), Some("y"));
        assert_eq!(meta.extra.get("mine").and_then(|v| v.as_integer()), Some(1));
    }

    #[test]
    fn run_cli_writes_result_over_ours_and_exits_by_cleanliness() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, bytes: &[u8]| {
            let p = dir.path().join(name);
            std::fs::write(&p, bytes).unwrap();
            p
        };
        let b = write("base", &page("0a", "tags = [\"a\"]\n", "x\n"));
        let o = write("ours", &page("0a", "tags = [\"a\", \"b\"]\n", "x\n"));
        let t = write("theirs", &page("0a", "tags = [\"a\", \"c\"]\n", "x\n"));
        assert_eq!(run_cli(&b, &o, &t), 0);
        let merged = std::fs::read_to_string(&o).unwrap();
        assert!(merged.contains("\"b\"") && merged.contains("\"c\""));
        // Missing file -> exit 1, ours untouched.
        assert_eq!(run_cli(&dir.path().join("nope"), &o, &t), 1);
    }
}
```

(For the encryption test: read `EncryptionMeta` in `src/vault/page.rs` first and use its real minimal TOML; if constructing it via frontmatter is awkward, construct `PageMeta` values directly and call `merge_meta` — the invariant under test is D18's "encrypted bodies never text-merge", which can equally be asserted through `merge` with metas serialized by `write_page_content`.)

- [ ] **Step 2: run — fails** (module absent).

- [ ] **Step 3: implement `merge_driver.rs`:**

```rust
//! `clep merge-driver`: the git merge driver for `*.md` (spec §5, D17/D18).
//!
//! Frontmatter merges structurally — `updated_at` max, `created_at` min,
//! tags/aliases as 3-way sets, every other field and extra key field-wise —
//! and the body as an ordinary 3-way text merge (`git merge-file`). Anything
//! irreconcilable exits 1 with a predictable `%A`: the engine then resolves
//! the path with a Conflict Copy (ADR 0004), and hand-run git leaves the
//! user a file the conflict-marker guard understands.

use std::path::Path;
use std::process::Command;

use chrono::{DateTime, Utc};

use crate::vault::page::{ExtraMap, PageMeta, parse_frontmatter, write_page_content};

/// What the driver leaves in `%A` and how it exits (D17).
#[derive(Debug)]
pub struct DriverOutcome {
    pub content: Vec<u8>,
    /// `true` -> exit 0 (merged clean); `false` -> exit 1 (residual conflict).
    pub clean: bool,
}

/// Merge one path's three sides (D18).
pub fn merge(base: &[u8], ours: &[u8], theirs: &[u8]) -> DriverOutcome {
    let conflict = || DriverOutcome { content: ours.to_vec(), clean: false };
    let parse = |bytes: &[u8]| -> Option<(PageMeta, String)> {
        let text = std::str::from_utf8(bytes).ok()?;
        parse_frontmatter(text).ok()
    };
    let (Some((ours_meta, ours_body)), Some((theirs_meta, theirs_body))) =
        (parse(ours), parse(theirs))
    else {
        // Not two structured pages: a plain whole-file 3-way text merge.
        return match text_merge(base, ours, theirs) {
            Some((content, clean)) => DriverOutcome { content, clean },
            None => conflict(),
        };
    };
    if ours_meta.id != theirs_meta.id {
        // Two different pages at one path — nothing structural to say.
        return conflict();
    }
    if (ours_meta.encryption.is_some() || theirs_meta.encryption.is_some())
        && ours_body != theirs_body
    {
        // Marker-mangled age payloads are unrecoverable; always Conflict Copy.
        return conflict();
    }
    let base_page = parse(base);
    let Some(meta) = merge_meta(base_page.as_ref().map(|(m, _)| m), &ours_meta, &theirs_meta)
    else {
        return conflict();
    };
    let base_body = base_page.as_ref().map(|(_, b)| b.as_str()).unwrap_or("");
    let Some((body, clean)) =
        text_merge(base_body.as_bytes(), ours_body.as_bytes(), theirs_body.as_bytes())
    else {
        return conflict();
    };
    let body = String::from_utf8_lossy(&body);
    DriverOutcome {
        content: write_page_content(&meta, &body).into_bytes(),
        clean,
    }
}

/// The CLI entry (D17): read the three files git hands a merge driver, leave
/// the result in `%A`, exit 0 clean / 1 conflict. Internal failures leave
/// `%A` untouched and exit 1 — git then treats the path as conflicted.
pub fn run_cli(base: &Path, ours: &Path, theirs: &Path) -> i32 {
    let (Ok(b), Ok(o), Ok(t)) = (std::fs::read(base), std::fs::read(ours), std::fs::read(theirs))
    else {
        return 1;
    };
    let outcome = merge(&b, &o, &t);
    if std::fs::write(ours, &outcome.content).is_err() {
        return 1;
    }
    if outcome.clean { 0 } else { 1 }
}

/// 3-way text merge via `git merge-file -p`. `Some((output, clean))`, or
/// `None` when git itself could not run (treated as a conflict upstream).
fn text_merge(base: &[u8], ours: &[u8], theirs: &[u8]) -> Option<(Vec<u8>, bool)> {
    let dir = tempfile::tempdir().ok()?;
    let write = |name: &str, bytes: &[u8]| {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).ok().map(|_| path)
    };
    let (b, o, t) = (write("base", base)?, write("ours", ours)?, write("theirs", theirs)?);
    let out = Command::new("git")
        .args(["merge-file", "-p", "-L", "ours", "-L", "base", "-L", "theirs"])
        .arg(&o)
        .arg(&b)
        .arg(&t)
        .output()
        .ok()?;
    match out.status.code() {
        Some(0) => Some((out.stdout, true)),
        // Positive exit = number of conflict hunks; negative/None = error.
        Some(code) if code > 0 && code < 128 => Some((out.stdout, false)),
        _ => None,
    }
}

/// Field-wise 3-way frontmatter merge; `None` means a field both sides
/// changed to different values — the whole file is a residual conflict.
fn merge_meta(base: Option<&PageMeta>, ours: &PageMeta, theirs: &PageMeta) -> Option<PageMeta> {
    let mut meta = ours.clone();
    meta.title = scalar3(base.map(|b| &b.title), &ours.title, &theirs.title)?;
    meta.kind = scalar3(base.map(|b| &b.kind), &ours.kind, &theirs.kind)?;
    meta.project = scalar3(base.map(|b| &b.project), &ours.project, &theirs.project)?;
    meta.readonly = scalar3(base.map(|b| &b.readonly), &ours.readonly, &theirs.readonly)?;
    meta.encryption = scalar3(base.map(|b| &b.encryption), &ours.encryption, &theirs.encryption)?;
    meta.tags = set3(base.map(|b| b.tags.as_slice()).unwrap_or(&[]), &ours.tags, &theirs.tags);
    meta.aliases = set3(
        base.map(|b| b.aliases.as_slice()).unwrap_or(&[]),
        &ours.aliases,
        &theirs.aliases,
    );
    meta.created_at = min_time(ours.created_at, theirs.created_at);
    meta.updated_at = max_time(ours.updated_at, theirs.updated_at);
    meta.extra = merge_extras(base.map(|b| &b.extra), &ours.extra, &theirs.extra)?;
    Some(meta)
}

fn scalar3<T: PartialEq + Clone>(base: Option<&T>, ours: &T, theirs: &T) -> Option<T> {
    if ours == theirs {
        return Some(ours.clone());
    }
    match base {
        Some(b) if b == ours => Some(theirs.clone()),
        Some(b) if b == theirs => Some(ours.clone()),
        // No usable base (add/add, unparseable) or both changed.
        _ => None,
    }
}

/// 3-way set merge: start from base, honour both sides' removals, keep both
/// sides' additions; survivors keep ours' order, then theirs' additions.
fn set3(base: &[String], ours: &[String], theirs: &[String]) -> Vec<String> {
    let removed: Vec<&String> = base
        .iter()
        .filter(|v| !ours.contains(v) || !theirs.contains(v))
        .collect();
    let keep = |v: &String| !removed.contains(&v);
    let mut out: Vec<String> = ours.iter().filter(|v| keep(v)).cloned().collect();
    for value in theirs {
        if keep(value) && !out.contains(value) {
            out.push(value.clone());
        }
    }
    out
}

fn merge_extras(base: Option<&ExtraMap>, ours: &ExtraMap, theirs: &ExtraMap) -> Option<ExtraMap> {
    let empty = ExtraMap::new();
    let base = base.unwrap_or(&empty);
    let mut keys: Vec<&String> = ours.keys().collect();
    keys.extend(theirs.keys().filter(|k| !ours.contains_key(*k)));
    let mut out = ExtraMap::new();
    for key in keys {
        // A key absent on a side is `None`: an addition merges in, a
        // deletion sticks, and add-vs-edit disagreement conflicts.
        let merged = scalar3(
            Some(&base.get(key).cloned()),
            &ours.get(key).cloned(),
            &theirs.get(key).cloned(),
        )?;
        if let Some(value) = merged {
            out.insert(key.clone(), value);
        }
    }
    Some(out)
}

fn max_time(a: Option<DateTime<Utc>>, b: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

fn min_time(a: Option<DateTime<Utc>>, b: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}
```

Declare `pub mod merge_driver;` in `gitsync/mod.rs`. If `EncryptionMeta` lacks `PartialEq`, add it to the derive list (check `src/vault/page.rs`; `Kind` already derives it — verify, else add there too).

- [ ] **Step 4: run — unit tests pass** (`cargo test merge_driver`).

- [ ] **Step 5: CLI command.** `src/bin/cli.rs`: add to `enum Commands` (next to `Sync`):

```rust
    #[command(
        hide = true,
        about = "Git merge driver for vault markdown (registered by `clep sync init`)",
        long_about = "Invoked by git as `clep merge-driver %O %A %B %P`. Merges frontmatter structurally and the body as 3-way text; writes the result over OURS and exits 0 (clean) or 1 (conflict). Not intended for direct use."
    )]
    MergeDriver {
        /// The common-ancestor version (%O).
        base: std::path::PathBuf,
        /// The current version (%A); receives the result.
        ours: std::path::PathBuf,
        /// The incoming version (%B).
        theirs: std::path::PathBuf,
        /// The path being merged (%P); informational.
        pathname: Option<String>,
    },
```

Dispatch arm (exhaustive match forces it):

```rust
        Commands::MergeDriver { base, ours, theirs, pathname: _ } => Ok(
            clepsydra::vault::gitsync::merge_driver::run_cli(&base, &ours, &theirs),
        ),
```

Check `docs_cli_coverage_test` (`cargo test --test docs_cli_coverage_test`): if it enumerates hidden commands too, add the `## \`clep merge-driver\`` stub to `ui/src/docs/content/cli.mdx` NOW (two sentences; Task 8 expands); if hidden commands are exempt, leave docs to Task 8.

- [ ] **Step 6: gates + commit.**

```bash
cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test
git add src/vault/gitsync/merge_driver.rs src/vault/gitsync/mod.rs src/bin/cli.rs src/vault/page.rs
git commit -m "feat(sync): structural markdown merge driver + hidden clep merge-driver command"
```

(Include `ui/src/docs/content/cli.mdx` in the add if Step 5 touched it.)

---

### Task 3: Driver registration + end-to-end proof

**Files:**
- Modify: `src/vault/gitsync/mod.rs` (registration constant), `src/vault/gitsync/init.rs` (write the keys)
- Create: `tests/merge_driver_test.rs`

**Interfaces:**
- Consumes: Task 2's `run_cli` via the built binary (`env!("CARGO_BIN_EXE_clep")`); `init.rs` step (5) at the `git.config_set(INIT_MARKER_KEY, ..)` call (init.rs:130).
- Produces: `pub const MERGE_DRIVER_KEYS: &[(&str, &str)]` in `gitsync/mod.rs` — Task 5's doctor uses `MERGE_DRIVER_KEYS[1].0` (`"merge.clep.driver"`).

- [ ] **Step 1: failing unit test** in `init.rs` tests:

```rust
#[test]
fn init_registers_the_merge_driver_and_rerun_is_idempotent() {
    // Reuse the existing init test harness in this module (TestRepos-free
    // fresh-vault pattern, LfsPolicy::Skip). After init():
    let git = testing::git(&root);
    for (key, value) in crate::vault::gitsync::MERGE_DRIVER_KEYS {
        assert_eq!(git.config_get_local(key).unwrap().as_deref(), Some(*value), "{key}");
    }
    // Re-run on the already-initialised vault: still there, still Ok.
    init(&vault, &git, opts_again).unwrap();
    assert_eq!(
        git.config_get_local("merge.clep.driver").unwrap().as_deref(),
        Some("clep merge-driver %O %A %B %P")
    );
}
```

- [ ] **Step 2: run — fails.**

- [ ] **Step 3: implement.** `mod.rs`:

```rust
/// Repo-local merge-driver registration `clep sync init` writes (spec §5).
/// `recursive = binary` keeps the driver out of the recursive strategy's
/// internal virtual-ancestor merges.
pub const MERGE_DRIVER_KEYS: &[(&str, &str)] = &[
    ("merge.clep.name", "clepsydra structural markdown merge"),
    ("merge.clep.driver", "clep merge-driver %O %A %B %P"),
    ("merge.clep.recursive", "binary"),
];
```

`init.rs` step (5), directly after the marker write:

```rust
    for (key, value) in super::MERGE_DRIVER_KEYS {
        git.config_set(key, value)?;
    }
```

- [ ] **Step 4: run — passes.**

- [ ] **Step 5: write the e2e integration test** `tests/merge_driver_test.rs` (failing only if the driver misbehaves; it exercises the real binary):

```rust
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
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
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
    ok(&repo, &global, &["config", "merge.clep.recursive", "binary"]);
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
    commit_page(&repo, &global, "\"a\", \"side\"", "one\ntwo\nTHREE\n", "side");
    ok(&repo, &global, &["checkout", "main"]);
    commit_page(&repo, &global, "\"a\", \"main\"", "ONE\ntwo\nthree\n", "main");
    let merge = git(&repo, &global, &["merge", "side"]);
    assert!(merge.status.success(), "{}", String::from_utf8_lossy(&merge.stderr));
    let merged = std::fs::read_to_string(repo.join("p.md")).unwrap();
    assert!(merged.contains("\"main\"") && merged.contains("\"side\""), "{merged}");
    assert!(merged.contains("ONE") && merged.contains("THREE"), "{merged}");
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
    assert!(tree_file.starts_with("+++\n"), "frontmatter intact: {tree_file}");
    assert!(tree_file.contains("<<<<<<<"), "{tree_file}");
}
```

Add a third test driving the library engine with the registered driver (proves driver + Conflict-Copy handover):

```rust
#[test]
fn full_sync_with_driver_conflicts_hand_over_to_conflict_copies() {
    // Two clones of a bare remote, vaults via clepsydra::vault::init::init_vault,
    // gitsync::init::init(.., LfsPolicy::Skip, author Some), then override the
    // registered driver command with env!("CARGO_BIN_EXE_clep") (the PATH-based
    // default from init would not resolve in the test environment):
    //   git config merge.clep.driver "'<exe>' merge-driver %O %A %B %P"
    // Use clepsydra::vault::gitsync::git::Git::new(root)
    //   .with_env("GIT_CONFIG_GLOBAL", <empty>).with_env("GIT_CONFIG_NOSYSTEM", "1")
    // for engine construction (SyncEngine::open_with_git).
    // Device A and B both edit ONE page: A changes only tags, B changes only the
    // body -> B's full_sync reports MergeSummary::Merged with ZERO conflict
    // copies (driver merged it). Then both edit the SAME body line -> B's
    // full_sync reports Merged with ONE conflict copy (driver exited 1, engine
    // resolved ours + copy).
}
```

Write this test out in full following the comment's recipe; every named API is public (`clepsydra::vault::init::init_vault`, `clepsydra::vault::gitsync::{init::init, init::InitOpts, init::LfsPolicy, git::Git, engine::SyncEngine, engine::MergeSummary}`, `clepsydra::vault::Vault::open`). The bare remote: `git init --bare` via the `git()` helper; wire with `remote add origin` before `gitsync::init`.

- [ ] **Step 6: run** `cargo test --test merge_driver_test` — all three pass.

- [ ] **Step 7: gates + commit.**

```bash
cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test
git add src/vault/gitsync/mod.rs src/vault/gitsync/init.rs tests/merge_driver_test.rs
git commit -m "feat(sync): register merge.clep driver at init; e2e driver coverage"
```

---

### Task 4: Post-sync journal merger

**Files:**
- Create: `src/vault/gitsync/journal_merge.rs`
- Modify: `src/vault/gitsync/mod.rs` (declare), `src/vault/gitsync/engine.rs` (wiring + `SyncReport.journal_merges`), `src/vault/index.rs` (make `extract_journal_date` `pub(crate)`), `src/api/sync.rs` (`JournalMergeDto`), `src/sync_command.rs` (render)

**Interfaces:**
- Consumes: `crate::vault::index::extract_journal_date(path: &str) -> Option<String>` (currently private at index.rs:2128 — make `pub(crate)`, do NOT move it); `conflict_copy::{is_conflict_copy_name, find_conflict_copies}`; `crate::vault::rewriter::rewrite_links_in_content(content, &[(&str, &str)]) -> String`; `crate::vault::page::{parse_frontmatter, write_page_content}`; `crate::vault::atomic_file::atomic_replace` (check the exact name/signature in `src/vault/atomic_file.rs` — 4a used `atomic_create`; use whichever replace-existing primitive exists, else `fs::write`).
- Produces:
  - `pub struct JournalGroup { pub folder: String, pub date: String, pub paths: Vec<String> }`
  - `pub fn duplicate_journal_groups(root: &Path) -> Vec<JournalGroup>` (Task 5's doctor rule consumes this)
  - `pub struct JournalMerge { pub folder: String, pub date: String, pub winner: String, pub merged: Vec<String> }`
  - `pub fn merge_duplicate_journals(root: &Path) -> (Vec<JournalMerge>, Vec<String>)` — infallible; problems are warnings
  - `SyncReport.journal_merges: Vec<JournalMerge>`; DTO `JournalMergeDto { folder, date, winner, merged }` on `SyncReportDto.journal_merges`

- [ ] **Step 1: failing unit tests** in `journal_merge.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn journal(dir: &std::path::Path, name: &str, id_tail: &str, created: &str, body: &str) {
        let path = dir.join("journals").join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            format!(
                "+++\nid = \"0192b6c0-0000-7000-8000-0000000000{id_tail}\"\ntitle = \"2026-08-29\"\ncreated_at = {created}\nupdated_at = {created}\n+++\n{body}"
            ),
        )
        .unwrap();
    }

    #[test]
    fn split_blocks_absorbs_continuation_lines() {
        let blocks = split_blocks("- 09:00 — first\ncontinued\n- 10:30 — second\n\nfree text\n");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].time.as_deref(), Some("09:00"));
        assert_eq!(blocks[0].text, "- 09:00 — first\ncontinued\n");
        assert_eq!(blocks[1].text, "- 10:30 — second\n\nfree text\n");
    }

    #[test]
    fn duplicate_groups_pair_same_folder_and_date_and_fold_conflict_copies() {
        let tmp = TempDir::new().unwrap();
        journal(tmp.path(), "20260829.2026-08-29.aaaaaaaa.md", "01", "2026-08-29T08:00:00Z", "- 08:00 — a\n");
        journal(tmp.path(), "20260829.2026-08-29.bbbbbbbb.md", "02", "2026-08-29T09:00:00Z", "- 09:00 — b\n");
        // A conflict copy of the first journal: no journal_date of its own,
        // joined to the group through conflict_of.
        std::fs::write(
            tmp.path().join("journals/20260829.2026-08-29.aaaaaaaa.conflict.abc1234.md"),
            "+++\nid = \"0192b6c0-0000-7000-8000-000000000003\"\ntitle = \"2026-08-29 (conflict abc1234)\"\nconflict_of = \"journals/20260829.2026-08-29.aaaaaaaa.md\"\n+++\n- 08:30 — c\n",
        )
        .unwrap();
        // A different date does not group.
        journal(tmp.path(), "20260830.2026-08-30.cccccccc.md", "04", "2026-08-30T08:00:00Z", "- 08:00 — d\n");
        let groups = duplicate_journal_groups(tmp.path());
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].date, "2026-08-29");
        assert_eq!(groups[0].paths.len(), 3);
    }

    #[test]
    fn merge_interleaves_dedupes_and_deletes_losers() {
        let tmp = TempDir::new().unwrap();
        journal(tmp.path(), "20260829.2026-08-29.aaaaaaaa.md", "01", "2026-08-29T08:00:00Z",
            "- 08:00 — morning\n- 12:00 — noon\n");
        journal(tmp.path(), "20260829.2026-08-29.bbbbbbbb.md", "02", "2026-08-29T09:00:00Z",
            "- 08:00 — morning\n- 10:00 — from B\nan appendix line\n");
        let (merges, warnings) = merge_duplicate_journals(tmp.path());
        assert_eq!(warnings, Vec::<String>::new());
        assert_eq!(merges.len(), 1);
        assert_eq!(merges[0].winner, "journals/20260829.2026-08-29.aaaaaaaa.md");
        assert_eq!(merges[0].merged, vec!["journals/20260829.2026-08-29.bbbbbbbb.md"]);
        assert!(!tmp.path().join("journals/20260829.2026-08-29.bbbbbbbb.md").exists());
        let text = std::fs::read_to_string(tmp.path().join("journals/20260829.2026-08-29.aaaaaaaa.md")).unwrap();
        let (meta, body) = crate::vault::page::parse_frontmatter(&text).unwrap();
        assert_eq!(
            body,
            "- 08:00 — morning\n- 10:00 — from B\nan appendix line\n- 12:00 — noon\n",
            "deduped, interleaved by time, continuation stays attached"
        );
        assert_eq!(meta.updated_at.unwrap().to_rfc3339(), "2026-08-29T09:00:00+00:00", "max updated_at");
        // Idempotent: nothing left to merge.
        assert!(merge_duplicate_journals(tmp.path()).0.is_empty());
    }

    #[test]
    fn conflict_copies_always_lose_and_stem_links_are_repointed() {
        let tmp = TempDir::new().unwrap();
        journal(tmp.path(), "20260829.2026-08-29.aaaaaaaa.md", "01", "2026-08-29T08:00:00Z", "- 08:00 — a\n");
        std::fs::write(
            tmp.path().join("journals/20260829.2026-08-29.aaaaaaaa.conflict.abc1234.md"),
            "+++\nid = \"0192b6c0-0000-7000-8000-000000000002\"\ntitle = \"2026-08-29 (conflict abc1234)\"\nconflict_of = \"journals/20260829.2026-08-29.aaaaaaaa.md\"\ncreated_at = 2026-08-29T07:00:00Z\n+++\n- 07:30 — theirs\n",
        )
        .unwrap();
        std::fs::create_dir_all(tmp.path().join("notes")).unwrap();
        std::fs::write(
            tmp.path().join("notes/ref.md"),
            "+++\nid = \"0192b6c0-0000-7000-8000-000000000009\"\ntitle = \"Ref\"\n+++\nsee [[20260829.2026-08-29.aaaaaaaa.conflict.abc1234]]\n",
        )
        .unwrap();
        let (merges, _) = merge_duplicate_journals(tmp.path());
        // The copy is older by created_at but still loses (D21).
        assert_eq!(merges[0].winner, "journals/20260829.2026-08-29.aaaaaaaa.md");
        let winner = std::fs::read_to_string(tmp.path().join("journals/20260829.2026-08-29.aaaaaaaa.md")).unwrap();
        assert!(winner.contains("- 07:30 — theirs"), "{winner}");
        let referer = std::fs::read_to_string(tmp.path().join("notes/ref.md")).unwrap();
        assert!(referer.contains("[[20260829.2026-08-29.aaaaaaaa]]"), "{referer}");
    }

    #[test]
    fn unparseable_member_is_skipped_with_a_warning() {
        let tmp = TempDir::new().unwrap();
        journal(tmp.path(), "20260829.2026-08-29.aaaaaaaa.md", "01", "2026-08-29T08:00:00Z", "- 08:00 — a\n");
        std::fs::write(tmp.path().join("journals/2026-08-29.md"), "no frontmatter").unwrap();
        let (merges, warnings) = merge_duplicate_journals(tmp.path());
        assert!(merges.is_empty(), "one parseable member left: nothing to merge");
        assert_eq!(warnings.len(), 1);
        assert!(tmp.path().join("journals/2026-08-29.md").exists(), "never deletes what it cannot read");
    }
}
```

- [ ] **Step 2: run — fails** (module absent).

- [ ] **Step 3: implement `journal_merge.rs`:**

```rust
//! The post-sync journal merger (spec §8 as amended by D20/D21).
//!
//! Sync makes duplicate journal pages routine: each device mints its own
//! filename for the same date (different random suffix), and a conflicted
//! journal leaves a Conflict Copy. Both cases fold into one page here —
//! filesystem-only, so it can run inside the sync window before any index
//! rebuild.

use std::collections::BTreeMap;
use std::path::Path;

use super::conflict_copy::is_conflict_copy_name;
use crate::vault::page::{PageMeta, parse_frontmatter, write_page_content};
use crate::vault::rewriter::rewrite_links_in_content;

/// The two top-level folders whose pages carry a path-derived journal date.
pub(crate) const JOURNAL_FOLDERS: [&str; 2] = ["journals", "ai-journals"];

#[derive(Debug, Clone)]
pub struct JournalGroup {
    pub folder: String,
    pub date: String,
    /// Vault-relative paths, sorted; more than one by construction.
    pub paths: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct JournalMerge {
    pub folder: String,
    pub date: String,
    pub winner: String,
    pub merged: Vec<String>,
}
```

`duplicate_journal_groups(root)`: for each folder in `JOURNAL_FOLDERS`, `walkdir::WalkDir::new(root.join(folder))` (missing folder → skip), files ending `.md`; rel path = `format!("{folder}/{name-relative}")` with `/` separators. If `is_conflict_copy_name(file_name)`: read + `parse_frontmatter`, take `meta.extra["conflict_of"]` as str, and use `extract_journal_date(conflict_of)`; a copy whose original is not a journal (or unreadable) is ignored here. Otherwise `crate::vault::index::extract_journal_date(&rel)`. Accumulate `BTreeMap<(String, String), Vec<String>>`, retain `len > 1`, sort member paths.

`merge_duplicate_journals(root)`: for each group — parse every member (`std::fs::read_to_string` + `parse_frontmatter`); a member that fails either → warning `"journal merge: skipping unreadable {path}: {e}"` and drop it from the group; if fewer than 2 parseable members remain, skip the group. Winner selection:

```rust
    members.sort_by(|a, b| {
        let copy_a = is_conflict_copy_name(file_name(&a.path));
        let copy_b = is_conflict_copy_name(file_name(&b.path));
        copy_a
            .cmp(&copy_b) // copies always lose
            .then_with(|| cmp_created(a.meta.created_at, b.meta.created_at)) // None sorts last
            .then_with(|| a.path.cmp(&b.path))
    });
```

Then `interleave` (below) the losers' bodies into the winner's, set `winner.meta.updated_at` to the max across members, strip a `conflict_of` extra if the WINNER somehow carries one (it cannot by D21, but cheap), write with `write_page_content` (atomic replace primitive from `src/vault/atomic_file.rs`), `fs::remove_file` each loser, then `repoint_links` for each loser. Any single-file IO error mid-group → push a warning and leave the group as intact as possible (write the winner BEFORE deleting losers, so a failed delete duplicates content rather than losing it; deletes happen only after a successful winner write).

```rust
#[derive(Debug)]
struct Block {
    time: Option<String>,
    text: String,
}

/// A block is a `- HH:MM — ` entry plus everything up to the next entry
/// (multi-line captures land at column 0 — D20), or a headless run of lines
/// before the first entry.
fn split_blocks(body: &str) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    for line in body.lines() {
        match entry_time(line) {
            Some(time) => blocks.push(Block { time: Some(time), text: format!("{line}\n") }),
            None => match blocks.last_mut() {
                Some(last) => {
                    last.text.push_str(line);
                    last.text.push('\n');
                }
                None => blocks.push(Block { time: None, text: format!("{line}\n") }),
            },
        }
    }
    blocks
}

/// `- 09:41 — text` -> `Some("09:41")`.
fn entry_time(line: &str) -> Option<String> {
    let rest = line.strip_prefix("- ")?;
    let (time, tail) = rest.split_at_checked(5)?;
    let b = time.as_bytes();
    let shaped = b[0].is_ascii_digit()
        && b[1].is_ascii_digit()
        && b[2] == b':'
        && b[3].is_ascii_digit()
        && b[4].is_ascii_digit();
    (shaped && tail.starts_with(" — ")).then(|| time.to_string())
}

/// Fold each loser's blocks into the winner's: byte-identical blocks
/// (trailing whitespace ignored) dedupe; timed blocks insert after the last
/// block with a time <= theirs; untimed blocks append in source order.
fn interleave(winner: &str, losers: &[&str]) -> String {
    let mut blocks = split_blocks(winner);
    for loser in losers {
        for block in split_blocks(loser) {
            if blocks.iter().any(|b| b.text.trim_end() == block.text.trim_end()) {
                continue;
            }
            match &block.time {
                Some(time) => {
                    let at = blocks
                        .iter()
                        .rposition(|b| b.time.as_deref().is_some_and(|t| t <= time.as_str()))
                        .map(|found| found + 1)
                        .unwrap_or_else(|| {
                            blocks
                                .iter()
                                .position(|b| b.time.is_some())
                                .unwrap_or(blocks.len())
                        });
                    blocks.insert(at, block);
                }
                None => blocks.push(block),
            }
        }
    }
    blocks.into_iter().map(|b| b.text).collect()
}

/// Rewrite stem- and path-form links from a deleted loser to the winner —
/// a filesystem pass, because the merger runs before any index exists.
/// Title links (`[[2026-08-29]]`) already resolve to the winner.
fn repoint_links(root: &Path, loser_rel: &str, winner_rel: &str, warnings: &mut Vec<String>) {
    let stem = |rel: &str| {
        rel.rsplit('/').next().unwrap_or(rel).strip_suffix(".md").unwrap_or(rel).to_string()
    };
    let (old_stem, new_stem) = (stem(loser_rel), stem(winner_rel));
    let pairs = [(old_stem.as_str(), new_stem.as_str()), (loser_rel, winner_rel)];
    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || (e.file_name() != ".git" && e.file_name() != ".clepsydra"))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
    {
        let Ok(content) = std::fs::read_to_string(entry.path()) else { continue };
        if !content.contains(&old_stem) {
            continue;
        }
        let rewritten = rewrite_links_in_content(&content, &pairs);
        if rewritten != content
            && let Err(e) = std::fs::write(entry.path(), rewritten)
        {
            warnings.push(format!("journal merge: could not rewrite links in {}: {e}", entry.path().display()));
        }
    }
}
```

`src/vault/index.rs`: change `fn extract_journal_date` to `pub(crate) fn` (no other change).

- [ ] **Step 4: run — Step-1 tests pass.**

- [ ] **Step 5: failing engine tests** (in `engine.rs`):

```rust
#[test]
fn sync_folds_two_devices_journals_for_one_date() {
    let repos = testing::TestRepos::new();
    let journal = |body: &str, tail: &str, suffix: &str| format!(
        "+++\nid = \"0192b6c0-0000-7000-8000-0000000000{tail}\"\ntitle = \"2026-08-29\"\ncreated_at = 2026-08-29T0{suffix}:00:00Z\n+++\n{body}"
    );
    testing::write(&repos.a, "journals/20260829.2026-08-29.aaaaaaaa.md", &journal("- 08:00 — from A\n", "40", "8"));
    engine(&repos.a).full_sync().unwrap();
    testing::write(&repos.b, "journals/20260829.2026-08-29.bbbbbbbb.md", &journal("- 10:00 — from B\n", "41", "9"));
    let rb = engine(&repos.b).full_sync().unwrap();
    assert_eq!(rb.journal_merges.len(), 1, "{:?}", rb.journal_merges);
    assert_eq!(rb.journal_merges[0].winner, "journals/20260829.2026-08-29.aaaaaaaa.md");
    assert!(rb.one_line().contains("1 duplicate journal"), "{}", rb.one_line());
    assert!(matches!(rb.push, PushStatus::Pushed), "the fold commit is pushed: {:?}", rb.push);
    assert!(!repos.b.join("journals/20260829.2026-08-29.bbbbbbbb.md").exists());
    let body = testing::read(&repos.b, "journals/20260829.2026-08-29.aaaaaaaa.md");
    assert!(body.contains("- 08:00 — from A") && body.contains("- 10:00 — from B"), "{body}");
    assert!(testing::git(&repos.b).status().unwrap().is_empty(), "tree clean after fold");
    // A pulls the fold: fast-forward, nothing further to merge.
    let ra = engine(&repos.a).full_sync().unwrap();
    assert!(ra.journal_merges.is_empty());
    assert!(!repos.a.join("journals/20260829.2026-08-29.bbbbbbbb.md").exists());
}

#[test]
fn journal_conflict_copy_is_folded_back() {
    let repos = testing::TestRepos::new();
    let journal = |body: &str| format!(
        "+++\nid = \"0192b6c0-0000-7000-8000-000000000042\"\ntitle = \"2026-08-29\"\n+++\n{body}"
    );
    testing::write(&repos.a, "journals/20260829.2026-08-29.aaaaaaaa.md", &journal("- 08:00 — base\n"));
    engine(&repos.a).full_sync().unwrap();
    engine(&repos.b).full_sync().unwrap();
    testing::write(&repos.a, "journals/20260829.2026-08-29.aaaaaaaa.md", &journal("- 08:00 — base\n- 09:00 — from A\n"));
    engine(&repos.a).full_sync().unwrap();
    testing::write(&repos.b, "journals/20260829.2026-08-29.aaaaaaaa.md", &journal("- 08:00 — base\n- 10:00 — from B\n"));
    let rb = engine(&repos.b).full_sync().unwrap();
    // The merge produced a copy; the merger immediately folded it back.
    assert_eq!(rb.conflict_copies().len(), 1);
    assert_eq!(rb.journal_merges.len(), 1);
    assert!(find_conflict_copies(&repos.b).is_empty(), "copy folded and deleted");
    let body = testing::read(&repos.b, "journals/20260829.2026-08-29.aaaaaaaa.md");
    assert!(body.contains("from A") && body.contains("from B"), "{body}");
}
```

(Note: without the driver registered in `TestRepos`, both-changed journals text-merge by default git behaviour — the second test's edits conflict on the same region because both append after the same base line, producing the copy the test needs. If default text merge happens to merge them cleanly, adjust both sides to edit the SAME line — e.g. change `- 08:00 — base` to different text on each side — so a copy is guaranteed.)

- [ ] **Step 6: implement the wiring** in `engine.rs`:

- `SyncReport` gains `pub journal_merges: Vec<super::journal_merge::JournalMerge>` (all construction sites updated; `commit_and_push` passes `Vec::new()`).
- `one_line()` appends, when non-empty: `format!("folded {} duplicate journal page{}", n, plural(n))` as an extra `parts` entry.
- New private method:

```rust
    /// D22: after a tree-changing pull, fold duplicate journal pages and
    /// commit the fold so the push carries it. Failures are warnings.
    fn merge_journals_after_pull(
        &self,
        summary: &MergeSummary,
        warnings: &mut Vec<String>,
        merges: &mut Vec<super::journal_merge::JournalMerge>,
    ) -> Result<(), SyncError> {
        if !matches!(summary, MergeSummary::FastForward { .. } | MergeSummary::Merged { .. }) {
            return Ok(());
        }
        let (folded, merge_warnings) = super::journal_merge::merge_duplicate_journals(&self.root);
        warnings.extend(merge_warnings);
        if folded.is_empty() {
            return Ok(());
        }
        self.git.add_all()?;
        let dates: Vec<String> = folded.iter().map(|m| m.date.clone()).collect();
        let message = super::with_device_trailer(&format!(
            "sync: merge {} duplicate journal page{} ({})",
            folded.len(),
            super::plural(folded.len()),
            dates.join(", ")
        ));
        self.git.commit(&message, &self.author)?;
        merges.extend(folded);
        Ok(())
    }
```

- `full_sync_inner`: after `let (mut merge, mut warnings) = self.pull_inner()?;` add `let mut journal_merges = Vec::new(); self.merge_journals_after_pull(&merge, &mut warnings, &mut journal_merges)?;`. Thread `journal_merges` into the report.
- `push_with_retry_inner`: after the retry's `pull_inner()`, call `merge_journals_after_pull` on the retry summary too; extend the returned tuple so `full_sync_inner` can fold the retry's merges and warnings in (mirror how retry warnings are handled today).
- `pull()` (public, CLI-unused directly? it is used by tests): leave as-is — merger wiring lives on the `full_sync` path only; document that on the method.

`src/api/sync.rs`: add

```rust
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct JournalMergeDto {
    /// `journals` or `ai-journals`.
    pub folder: String,
    pub date: String,
    pub winner: String,
    pub merged: Vec<String>,
}
```

`SyncReportDto` gains `pub journal_merges: Vec<JournalMergeDto>`; `From<&SyncReport>` maps it. `src/sync_command.rs`: render a line per merge in the report renderer (find where `conflict_copies` are rendered and mirror: `folded journals: 2026-08-29 -> journals/… (1 page)`).

- [ ] **Step 7: run — Step-5 tests + `cargo test sync` green.**

- [ ] **Step 8: gates + commit.**

```bash
cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test
git add src/vault/gitsync src/vault/index.rs src/api/sync.rs src/sync_command.rs
git commit -m "feat(sync): post-sync journal merger — fold duplicate journal dates and conflict copies"
```

---

### Task 5: Doctor split + new rules

**Files:**
- Move: `src/doctor.rs` → `src/doctor/mod.rs` (use `git mv`)
- Create: `src/doctor/sync.rs`
- Modify: `src/doctor/mod.rs` (new `journals` section; git-missing → warn; skip-branch entries)

**Interfaces:**
- Consumes: `gitsync::MERGE_DRIVER_KEYS`, `Git::config_get_local` (Tasks 1/3), `journal_merge::duplicate_journal_groups` (Task 4), `conflict_copy::find_conflict_copies`.
- Produces: no new public API; the `sync` doctor section gains `driver` and `conflict-copies` checks; a new `journals` section gains `duplicates`.

- [ ] **Step 1: mechanical split.** `git mv src/doctor.rs src/doctor/mod.rs`. Cut the sync block — `SYNC_SECTION`/`SYNC_LISTED` consts, `check_sync`, `nested_repo_result`, `enclosing_repo`, `check_sync_repo`, `check_sync_branch`, `check_sync_managed_files`, `check_sync_lfs`, `check_sync_remote`, `check_sync_worktree`, `check_sync_exclusions` — into `src/doctor/sync.rs` starting with `use super::*;` plus whatever `use` lines the moved code needs. Move the sync test helpers (`sync_result`, `has_sync_check`, `sync_initialised_vault`) and every `#[serial]` sync test into a `#[cfg(test)] mod tests` in `sync.rs`. In `mod.rs`: `mod sync;` + call `sync::check_sync(v, &mut report);` (make `check_sync` `pub(super)`). Run `cargo test doctor` — identical results to before the move. Commit the pure move separately:

```bash
git add src/doctor && git commit -m "refactor(doctor): split sync checks into doctor/sync.rs (no behaviour change)"
```

- [ ] **Step 2: failing tests for the new rules** (in `doctor/sync.rs` tests and `doctor/mod.rs` tests, following the `conflicts_check_warns_and_lists_files` pattern at old doctor.rs:3355 — temp vault, `Report::default()`, call the check, `find` the `(section, name)`):

```rust
// sync.rs tests
#[test]
#[serial_test::serial]
fn driver_check_warns_until_init_registers_it() {
    crate::sync_runtime::tests::isolate_git_process_wide();
    // sync_initialised_vault runs gitsync::init, which now registers the
    // driver (Task 3) -> ok. Unset it -> warn.
    let tmp = TempDir::new().unwrap();
    let vault = sync_initialised_vault(tmp.path());
    let mut report = Report::default();
    check_sync(&vault, &mut report);
    assert!(matches!(sync_result(&report, "driver").status, Status::Ok));
    let git = crate::vault::gitsync::git::Git::new(vault.root());
    git.run(&["config", "--unset", "merge.clep.driver"]).unwrap();
    let mut report = Report::default();
    check_sync(&vault, &mut report);
    let result = sync_result(&report, "driver");
    assert!(matches!(result.status, Status::Warn));
    assert!(result.hint.as_deref().unwrap_or_default().contains("clep sync init"));
}

#[test]
#[serial_test::serial]
fn conflict_copies_check_lists_copies() {
    crate::sync_runtime::tests::isolate_git_process_wide();
    let tmp = TempDir::new().unwrap();
    let vault = sync_initialised_vault(tmp.path());
    std::fs::create_dir_all(vault.root().join("notes")).unwrap();
    std::fs::write(vault.root().join("notes/p.conflict.abc1234.md"), "x").unwrap();
    let mut report = Report::default();
    check_sync(&vault, &mut report);
    let result = sync_result(&report, "conflict-copies");
    assert!(matches!(result.status, Status::Warn));
    assert!(result.detail.contains("notes/p.conflict.abc1234.md"));
}
```

```rust
// mod.rs tests
#[test]
fn journals_check_warns_on_duplicate_dates() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    crate::vault::init::init_vault(&root).unwrap();
    std::fs::create_dir_all(root.join("journals")).unwrap();
    for (name, tail) in [("20260829.2026-08-29.aaaaaaaa.md", "01"), ("20260829.2026-08-29.bbbbbbbb.md", "02")] {
        std::fs::write(
            root.join("journals").join(name),
            format!("+++\nid = \"0192b6c0-0000-7000-8000-0000000000{tail}\"\ntitle = \"2026-08-29\"\n+++\n"),
        ).unwrap();
    }
    let vault = crate::vault::Vault::open(&root).unwrap();
    let mut report = Report::default();
    check_journals(&vault, &mut report);
    let result = report.results.iter().find(|r| r.section == "journals").unwrap();
    assert!(matches!(result.status, Status::Warn));
    assert!(result.detail.contains("2026-08-29"));
    assert!(result.hint.as_deref().unwrap_or_default().contains("clep sync"));
}
```

- [ ] **Step 3: run — fails.**

- [ ] **Step 4: implement.** In `sync.rs`, called from `check_sync` after `check_sync_managed_files` (contiguous section ordering matters — see `render_human`):

```rust
fn check_sync_driver(git: &Git, report: &mut Report) {
    let key = crate::vault::gitsync::MERGE_DRIVER_KEYS
        .iter()
        .find(|(k, _)| k.ends_with(".driver"))
        .map(|(k, _)| *k)
        .expect("driver key present");
    match git.config_get_local(key) {
        Ok(Some(_)) => report.push(ok(SYNC_SECTION, "driver", "markdown merge driver registered")),
        Ok(None) => report.push(
            warn(SYNC_SECTION, "driver", "markdown merge driver is not registered; *.md merges fall back to plain text merge")
                .with_hint("run `clep sync init` to register `clep merge-driver`"),
        ),
        Err(e) => report.push(warn(SYNC_SECTION, "driver", format!("could not read merge driver config: {e}"))),
    }
}

fn check_sync_conflict_copies(vault: &Vault, report: &mut Report) {
    let copies = crate::vault::gitsync::conflict_copy::find_conflict_copies(vault.root());
    if copies.is_empty() {
        report.push(ok(SYNC_SECTION, "conflict-copies", "none"));
        return;
    }
    let listed: Vec<&str> = copies.iter().take(SYNC_LISTED).map(String::as_str).collect();
    let more = copies.len().saturating_sub(SYNC_LISTED);
    let mut detail = format!("{} conflict cop{}: {}", copies.len(), if copies.len() == 1 { "y" } else { "ies" }, listed.join(", "));
    if more > 0 {
        detail.push_str(&format!(" (+{more} more)"));
    }
    report.push(warn(SYNC_SECTION, "conflict-copies", detail).with_hint(
        "each copy holds the other device's version of its page — fold what you want into the original (the /conflicts view lists them), then delete the copy",
    ));
}
```

Both only when the repo checks passed (mirror how `check_sync_lfs` etc. gate on `check_sync_repo`'s bool). Git-missing: in `check_sync`, change the `Git::version()` failure push from `err(..)` to `warn(..)` with hint `"install git to sync this vault (e.g. `xcode-select --install` or `brew install git`)"` and update the test asserting `Status::Err` for that case if one exists.

In `mod.rs`:

```rust
fn check_journals(vault: &Vault, report: &mut Report) {
    const SECTION: &str = "journals";
    let groups = crate::vault::gitsync::journal_merge::duplicate_journal_groups(vault.root());
    if groups.is_empty() {
        report.push(ok(SECTION, "duplicates", "one page per journal date"));
        return;
    }
    for group in &groups {
        report.push(
            warn(SECTION, "duplicates", format!("{}/{}: {}", group.folder, group.date, group.paths.join(", ")))
                .with_hint("run `clep sync` to fold duplicates automatically, or merge the pages by hand"),
        );
    }
}
```

Wait — `name` must be `&'static str`, which `"duplicates"` is; multiple pushes with the same name are fine (the marker rule does the same? verify; if doctor conventions want one result, join all groups into one detail string instead — follow whatever `check_conflicts` does for multiple files). Call `check_journals(v, &mut report);` right after `check_conflicts` in `run_with_cwd`, and add the matching `skip("journals", "duplicates", ..)` push in the vault-unavailable `else` branch (doctor.rs:260-281 pattern).

- [ ] **Step 5: run — Step-2 tests + full doctor suite green.**

- [ ] **Step 6: gates + commit.**

```bash
cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test
git add src/doctor
git commit -m "feat(doctor): driver, conflict-copies, duplicate-journal rules; git-less machines warn"
```

---

### Task 6: Conflicts API + index-backed status count

**Files:**
- Modify: `src/api/sync.rs` (endpoint + DTOs + status count), `src/vault/gitsync/engine.rs` (`status_with_copies`), `src/sync_runtime.rs` (`status_with_copies`), `src/api/openapi.rs` (register the path), `src/sync_command.rs` (only if it calls `runtime.status` — it talks HTTP; verify no change needed)
- Test: `src/api/sync.rs` test module (axum-test)

**Interfaces:**
- Consumes: `page_properties` (key `conflict_of`, `value_text`) + `pages` tables; `IndexHandle::with_index` (copy the closure pattern from `src/api/journal.rs:117`'s `find_journal_path`).
- Produces: `GET /api/vault/sync/conflicts` → `ConflictListDto { items: Vec<ConflictPageDto>, total: usize }`, `ConflictPageDto { path, title: Option<String>, original, original_title: Option<String>, original_exists: bool }`; `SyncEngine::status_with_copies(&self, conflict_copies: usize) -> Result<SyncStatus, SyncError>`; `SyncRuntime::status_with_copies(&self, conflict_copies: usize) -> Result<SyncStatus, SyncError>` (the old zero-arg `status` on the runtime is removed; the engine keeps a walking `status()` for the standalone CLI). Task 7 consumes the endpoint via the regenerated schema.

- [ ] **Step 1: failing API test** in `src/api/sync.rs` tests:

```rust
#[tokio::test]
async fn conflicts_endpoint_lists_copies_from_the_index() {
    let (state, _tmp) = crate::state_test_support::make_state().await;
    let server = TestServer::new(crate::api::api_router().with_state(Arc::clone(&state))).unwrap();
    // A conflict copy page + its original, indexed.
    let root = state.vault.root().to_path_buf();
    std::fs::create_dir_all(root.join("notes")).unwrap();
    std::fs::write(
        root.join("notes/plan.md"),
        "+++\nid = \"0192b6c0-0000-7000-8000-0000000000c1\"\ntitle = \"Plan\"\n+++\nours\n",
    ).unwrap();
    std::fs::write(
        root.join("notes/plan.conflict.abc1234.md"),
        "+++\nid = \"0192b6c0-0000-7000-8000-0000000000c2\"\ntitle = \"Plan (conflict abc1234)\"\nconflict_of = \"notes/plan.md\"\n+++\ntheirs\n",
    ).unwrap();
    // Rebuild the index the way other api tests do (find the existing helper
    // used after direct fs writes — e.g. the reindex route or a
    // state_test_support rebuild fn — and reuse it here).
    // <rebuild>
    let list: ConflictListDto = server.get("/sync/conflicts").await.json();
    assert_eq!(list.total, 1);
    assert_eq!(list.items[0].path, "notes/plan.conflict.abc1234.md");
    assert_eq!(list.items[0].original, "notes/plan.md");
    assert!(list.items[0].original_exists);
    assert_eq!(list.items[0].original_title.as_deref(), Some("Plan"));
    // A plain vault (no sync runtime) still answers.
    let status: SyncStatusDto = server.get("/sync/status").await.json();
    assert!(!status.initialised);
}
```

(For `<rebuild>`: `rg "rebuild" tests/api_pages.rs src/api/index_routes.rs` — there is a reindex route (`index_routes::rebuild_index_and_notify` used by 4a); POST to it or call the support fn, whichever existing tests do after direct writes.)

- [ ] **Step 2: run — fails** (404).

- [ ] **Step 3: implement.** DTOs in `src/api/sync.rs`:

```rust
/// One Conflict Copy page, as indexed.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ConflictPageDto {
    /// Vault-relative path of the copy.
    pub path: String,
    pub title: Option<String>,
    /// `conflict_of`: the page whose local version won the merge.
    pub original: String,
    pub original_title: Option<String>,
    /// False when the original has since been deleted or moved.
    pub original_exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ConflictListDto {
    pub items: Vec<ConflictPageDto>,
    pub total: usize,
}
```

Handler (mirror `journal.rs`'s `with_index` usage exactly for locking/error style):

```rust
#[utoipa::path(
    get,
    path = "/sync/conflicts",
    context_path = "/api/vault",
    tag = "Sync",
    responses(
        (status = 200, description = "Conflict Copies present in the vault, from the index", body = ConflictListDto),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn list_conflicts(State(state): State<Arc<AppState>>) -> Result<Json<ConflictListDto>, ApiError> {
    // with_index closure:
    //   SELECT p.path, p.title, pp.value_text, o.path, o.title
    //   FROM page_properties pp
    //   JOIN pages p ON p.id = pp.page_id
    //   LEFT JOIN pages o ON o.path = pp.value_text
    //   WHERE pp.key = 'conflict_of' AND pp.value_text IS NOT NULL
    //   ORDER BY p.path
    // map rows -> ConflictPageDto { original_exists: o.path.is_some(), .. }
}
```

Route: `.route("/conflicts", get(list_conflicts))` in `sync::router()`. Register `list_conflicts` in `src/api/openapi.rs`'s `paths(...)` list next to the existing `sync::run_sync, sync::sync_status` entries, and the two DTOs in `components(schemas(...))` if the existing pattern lists DTOs explicitly (check how `SyncReportDto` was registered in 4a and mirror).

Status count: `engine.rs` — split `status`:

```rust
    /// [`SyncEngine::status`] with the Conflict Copy count supplied — the
    /// server counts from the index instead of walking the vault per poll.
    pub fn status_with_copies(&self, conflict_copies: usize) -> Result<SyncStatus, SyncError> {
        // former body, with `conflict_copies` used directly
    }

    pub fn status(&self) -> Result<SyncStatus, SyncError> {
        let copies = find_conflict_copies(&self.root).len();
        self.status_with_copies(copies)
    }
```

`sync_runtime.rs`: rename `status` → `status_with_copies(&self, conflict_copies: usize)` calling `engine.status_with_copies(conflict_copies)` in the `spawn_blocking`. `src/api/sync.rs::sync_status`: count first (`SELECT count(*) FROM page_properties WHERE key = 'conflict_of'` via `with_index`), then `runtime.status_with_copies(count)`. Fix every compile-error caller (runtime tests).

- [ ] **Step 4: run — Step-1 test + full `cargo test` green.**

- [ ] **Step 5: regenerate the schema.**

```bash
mkdir -p /tmp/clep-scratch-vault
CLEPSYDRA__VAULT__ROOT=/tmp/clep-scratch-vault CLEPSYDRA__SERVER__PORT=3000 cargo run -- serve &
# poll http://localhost:3000/api/vault/uptime until it answers
cd ui && bun run openapi
# kill the serve process
```

**The `CLEPSYDRA__VAULT__ROOT` override is mandatory** — without it the ambient config points at the live vault. Verify the diff to `ui/src/api/schema.d.ts` contains `ConflictListDto`, `ConflictPageDto`, `JournalMergeDto`, `not_fetched` in the merge doc string, and nothing destructive.

- [ ] **Step 6: gates + commit.**

```bash
cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test
cd ui && bun run typecheck
git add src/api/sync.rs src/api/openapi.rs src/vault/gitsync/engine.rs src/sync_runtime.rs ui/src/api/schema.d.ts
git commit -m "feat(sync): GET /api/vault/sync/conflicts; index-backed conflict-copy counts"
```

---

### Task 7: `/conflicts` UI view

**Files:**
- Create: `ui/src/routes/conflicts.tsx`, `ui/src/components/conflicts/ConflictsPanel.tsx`, `ui/src/components/conflicts/__tests__/ConflictsPanel.test.tsx`, `ui/src/routes/__tests__/-conflicts.test.tsx`
- Modify: `ui/src/api/keys.ts` (sync keys), `ui/src/api/index.ts` (`useSyncConflicts`), `ui/src/hooks/useVaultEvents.ts` (invalidate sync prefix on `index_changed`), `ui/src/components/codex/useCodexView.ts` (union), `ui/src/components/codex/viewRegistry.ts` (entry), `ui/src/components/codex/commandRegistry.ts` + `CommandPalette.tsx` (palette nav), `ui/src/routes/__tests__/routeViews.test.ts` (row), `ui/src/docs/featureInventory.ts` (route + command rows), `ui/src/docs/content/sync.mdx` (a `](/conflicts)` link if featureInventory's disposition demands the target doc to reference it — check `featureInventory.test.ts` + `mdx-smoke.test.tsx` requirements and satisfy them)

**Interfaces:**
- Consumes: `GET /api/vault/sync/conflicts` via generated schema types (`components["schemas"]["ConflictPageDto"]`); `useOpenTab` (`rg "useOpenTab" ui/src` for the import path); repairs components as the pattern (`ui/src/components/repairs/RepairWorkspace.tsx` for state roles, `RepairIssueList` for list idiom).
- Produces: route `/conflicts`, CodexView `"conflicts"`, command `nav.conflicts`.

- [ ] **Step 1: registry + route + failing tests.** Add `"conflicts"` to the `CodexView` union (`useCodexView.ts:4`) — `viewRegistry.ts`'s exhaustive `Record` now fails typecheck; add:

```ts
  conflicts: {
    label: "CONFLICTS",
    folioCode: "CONFLICTS",
    showsSheaf: false,
    feature: null,
    navRoot: null,
    mobile: null,
    go: ({ navigate }) => void navigate({ to: "/conflicts" }),
  },
```

Route file `ui/src/routes/conflicts.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { ConflictsPanel } from "#/components/conflicts/ConflictsPanel";

export const Route = createFileRoute("/conflicts")({
  staticData: { codexView: "conflicts" },
  component: ConflictsPage,
});

function ConflictsPage() {
  return <ConflictsPanel />;
}
```

Add `"/conflicts": "conflicts",` to `OWN_CODEX_VIEW_BY_ROUTE_ID` in `routeViews.test.ts:21` (and bump the prose count in its comment). Palette: extend the action union in `commandRegistry.ts:13` with `"navigate-conflicts"`, add `{ id: "nav.conflicts", title: "Open Sync Conflicts", action: "navigate-conflicts" }` beside `nav.repairs` (:192), dispatch `goToView("conflicts", …)` in `CommandPalette.tsx:166`'s switch. featureInventory: add a route row for `/conflicts` and a command row for `nav.conflicts` modeled on the repairs rows (:71, :187), pointing their disposition at the sync docs page — inspect `featureInventory.ts`'s `disposition` type for the right kind for an operations-reference page (repairs uses `{ kind: "guide", slug: "links-search-graph-and-repair" }`; sync.mdx's slug is `sync`). Run `cd ui && bun run test featureInventory docs` and satisfy whatever the tests demand (likely a literal `](/conflicts)` link inside the disposition target's mdx — add it to `sync.mdx`'s conflict section: `see the [Conflicts view](/conflicts)`).

- [ ] **Step 2: API hook.** `keys.ts`: add to `queryKeys`:

```ts
  sync: {
    prefix: ["sync"] as const,
    conflicts: () => [...queryKeys.sync.prefix, "conflicts"] as const,
    conflictsPath: "/api/vault/sync/conflicts" as const,
  },
```

`api/index.ts`:

```ts
export type ConflictPage = components["schemas"]["ConflictPageDto"];

export function useSyncConflicts() {
  return useQuery({
    queryKey: queryKeys.sync.conflicts(),
    queryFn: async () => {
      const { data, error } = await fetchClient.GET(queryKeys.sync.conflictsPath);
      if (error) throw new Error("failed to load conflict copies");
      return data;
    },
  });
}
```

(Match the file's existing hook style exactly — `useReferenceIssues` at index.ts:197 is the template; if `fetchClient.GET` needs the literal path for openapi-fetch typing, inline `"/api/vault/sync/conflicts"`.) `useVaultEvents.ts`: in the `index_changed` invalidation list add `queryKeys.sync.prefix`.

- [ ] **Step 3: failing component test** `ConflictsPanel.test.tsx` (vi.hoisted mock pattern from `RepairWorkspace.test.tsx:21`):

```tsx
const mocks = vi.hoisted(() => ({
  data: undefined as undefined | { items: unknown[]; total: number },
  isPending: false,
  isError: false,
  openTab: vi.fn(),
}));

vi.mock("#/api/index", () => ({
  useSyncConflicts: () => ({
    data: mocks.data,
    isPending: mocks.isPending,
    isError: mocks.isError,
  }),
}));
// mock useOpenTab's module the way RepairWorkspace.test.tsx does

it("lists copies with their originals and opens either", async () => {
  mocks.data = {
    total: 1,
    items: [{
      path: "notes/plan.conflict.abc1234.md",
      title: "Plan (conflict abc1234)",
      original: "notes/plan.md",
      original_title: "Plan",
      original_exists: true,
    }],
  };
  render(<ConflictsPanel />);
  expect(screen.getByText("Plan (conflict abc1234)")).toBeInTheDocument();
  expect(screen.getByText(/notes\/plan\.md/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /open copy/i }));
  expect(mocks.openTab).toHaveBeenCalled();
});

it("shows empty, loading, error and missing-original states", () => {
  // empty: data { items: [], total: 0 } -> "No conflict copies" text
  // loading: isPending -> role="status"
  // error: isError -> role="alert"
  // original_exists: false -> "original missing" note and no open-original button
});
```

- [ ] **Step 4: implement `ConflictsPanel.tsx`.** Structure (follow RepairWorkspace's Vessel styling idioms — headings, list, buttons; keep it a single component, no filters/pagination for v1):

- Header: title "Conflicts", one-paragraph explanation: *each entry is a page another device changed at the same time as this one; the local version kept its place, the other version was saved as a copy. Fold anything you want to keep into the original, then delete the copy.*
- `useSyncConflicts()`; `isPending` → `<div role="status">Loading conflict copies…</div>`; `isError` → `<div role="alert">Could not load conflict copies.</div>`; empty → "No conflict copies. Merges are clean."
- Per item: copy `title ?? path`, monospace copy path, "conflicted with" original path (+ `original_title`), buttons **Open copy** / **Open original** via `useOpenTab` (disable/omit the latter with an "original missing — it was deleted or moved after the merge" note when `!original_exists`).

- [ ] **Step 5: run** `cd ui && bun run test conflicts routeViews viewRegistry featureInventory` — green; then `bun run typecheck && bun run lint`.

- [ ] **Step 6: format + commit.**

```bash
cd ui && bunx biome format --write src/routes/conflicts.tsx src/components/conflicts src/api/keys.ts src/api/index.ts src/hooks/useVaultEvents.ts src/components/codex src/routes/__tests__/-conflicts.test.tsx src/routes/__tests__/routeViews.test.ts src/docs/featureInventory.ts
git add ui/src/routes/conflicts.tsx ui/src/components/conflicts ui/src/api/keys.ts ui/src/api/index.ts ui/src/hooks/useVaultEvents.ts ui/src/components/codex ui/src/routes/__tests__ ui/src/docs/featureInventory.ts ui/src/docs/content/sync.mdx ui/src/routeTree.gen.ts
git commit -m "feat(ui): /conflicts view listing sync Conflict Copies"
```

(`routeTree.gen.ts` regenerates when vitest/vite runs — commit the regenerated file, do not hand-edit or reformat it.)

---

### Task 8: Docs, CONTEXT.md, final verification

**Files:**
- Modify: `ui/src/docs/content/sync.mdx` (merge driver, journal merger, conflicts-view sections), `ui/src/docs/content/cli.mdx` (`clep merge-driver`; `clep sync` output additions), `ui/src/docs/content/api-reference.mdx` (Sync: `/sync/conflicts`), `CONTEXT.md` (**Journal Merge** entry; extend **Conflict Copy** with the fold-back behaviour), `docs/superpowers/specs/2026-08-27-clep-sync-design.md` (§8: one-line amendment noting D20 — bullets, not `## HH:MM` headings)

**Interfaces:** none produced; everything consumed is from Tasks 1–7.

- [ ] **Step 1: sync.mdx.** Add sections after the existing conflict material: **"The merge driver"** (what merges structurally, what conflicts — both-changed scalar fields, encrypted bodies, differing ids; that a body conflict left by *hand-run* git shows as a read-only conflicted page which doctor flags; that `clep sync init` registers it and doctor warns when unregistered), **"Journal merging"** (duplicate dates fold automatically after sync; oldest page wins; conflict copies of journals fold back; doctor's `journals` rule is the backstop), **"Resolving conflicts"** (the `/conflicts` view — keep the link added in Task 7; resolution = edit the original, delete the copy). Keep the wording register of the existing page.
- [ ] **Step 2: cli.mdx.** Under the sync family: `## \`clep merge-driver\`` (registered by init, invoked by git, not for direct use — arguments and exit semantics in two sentences); extend `clep sync` (journal-merge report line, `no fetch` in shutdown pushes) and `clep sync status` (conflict-copy count now index-backed on the server) as needed. Run `cargo test --test docs_cli_coverage_test`.
- [ ] **Step 3: api-reference.mdx.** Add `GET /api/vault/sync/conflicts` to the Sync section with the DTO field list.
- [ ] **Step 4: CONTEXT.md + spec amendment.** CONTEXT.md: add **Journal Merge** ("the post-sync fold of duplicate journal pages for one date; oldest page wins, entries interleave by time"); extend **Conflict Copy** with "journal conflict copies are folded back automatically by the journal merger". Spec §8: replace the `## HH:MM` sentence with the bullet-format reality, marked "(amended by the 4b plan, D20)".
- [ ] **Step 5: full gates.**

```bash
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cd ui && bun run typecheck && bun run lint && bun run test
```

UI failures must be exactly the pre-existing develop set (see Global Constraints).

- [ ] **Step 6: commit.**

```bash
git add ui/src/docs/content CONTEXT.md docs/superpowers/specs/2026-08-27-clep-sync-design.md
git commit -m "docs(sync): merge driver, journal merger, conflicts view; amend spec §8 journal shape"
```

---

## Deliberately deferred (record, do not do)

- Sidebar/Stats badge for conflict count (palette + doctor + status suffice for v1).
- `SyncStatusDto` UI polling / sync indicator surfacing `/sync/status` — separate QoL.
- Rubbish `.purge-*` tombstone races (spec §5 note: mid-run sweep waits for restart) — unchanged from 4a.
- `mutations_wait_for_the_sync_window` test-shape complaint; `FlagGuard` refcount; POST /sync coalescing — 4a review minors, still deferred.
- Live-vault `clep sync init` — user-run only; requires `brew install git-lfs` first.

## Self-review notes

- Spec coverage: §5 driver → T2/T3; §5 residual/encrypted → D17/D18 + 4a engine; §8 → T4 (amended by D20); §9 doctor → T5; §9 UI → T7; §10 CLI → T2 (hidden command; other CLI shipped in 4a). Carry-forwards → T1 (engine/state/init), T5 (doctor git-less), T6 (status walk), deferred list above (explicitly recorded).
- Type consistency: `MERGE_DRIVER_KEYS` (T3) used by T5; `duplicate_journal_groups`/`JournalGroup` (T4) used by T5; `status_with_copies` (T6) matches T1's untouched `status` split; `JournalMerge { folder, date, winner, merged }` consistent across T4 engine/DTO/render.
