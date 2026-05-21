# Slice 05 — Diagnostics (`doctor`) CRAP Remediation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Read `00-overview.md` first — §3 and §5 are assumed.

**Goal:** Clear `check_index`, `check_tls`, and `check_vault` by splitting each into a `gather_*` step (I/O) and a pure `evaluate_*(facts) -> Vec<CheckResult>` step, then exhaustively unit-testing the evaluate functions (which carry the branch complexity) with constructed fact structs.

**Architecture:** Every check becomes `gather` (stat/SQL/PEM/env I/O → a plain `*Facts` struct) + `evaluate` (pure facts → `CheckResult`s). The async wrappers (`check_tls`/`check_index`) and the staged `check_vault` keep only the I/O dispatch. Environment dependencies (`mkcert` on `$PATH`, `dirs::data_dir()`) are passed in as parameters so no process env is mutated.

**Tech Stack:** rustls (PEM parse), rusqlite, `tempfile`, `rcgen` (test-only self-signed certs — add as dev-dep if not present), the existing `EnvGuard`/`serial_test` pattern in `diagnostics.rs` tests.

**Targets:** #14 check_index, #18 check_tls, #26 check_vault.

Reference design doc: `docs/plans/2026-04-29-doctor-command.md` (its Tests section enumerates the branches to cover).

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/diagnostics.rs` | `TlsFacts`/`gather_tls_facts`/`evaluate_tls`; `VaultFacts`/`gather_vault_facts`/`evaluate_vault`; `IndexFacts`/`gather_index_facts`/`evaluate_index`; thin wrappers; new pure tests | Modify |
| `Cargo.toml` | `rcgen` dev-dep (only if a real cert fixture is needed) | Modify (optional) |

---

## Task 1: `evaluate_tls` (pure) + thin `check_tls` (#18)

**Files:** Modify `src/diagnostics.rs`

- [ ] **Step 1: Write the failing test**

In `src/diagnostics.rs`:

```rust
#[derive(Debug, Clone)]
pub(crate) struct TlsFacts {
    pub cert_path: std::path::PathBuf,
    pub key_path: std::path::PathBuf,
    pub explicit: bool,
    pub cert_exists: bool,
    pub key_exists: bool,
    /// None = not both present; Some(Ok) = parsed; Some(Err) = parse failure.
    pub pem_parse: Option<Result<(), String>>,
}

/// Pure evaluation of TLS facts into check results. `mkcert_available` is the
/// `$PATH` lookup result, injected for testability.
pub(crate) fn evaluate_tls(facts: &TlsFacts, mkcert_available: bool) -> Vec<CheckResult> {
    // Port the branching from check_tls (lines ~383-454): source label,
    // certs ok/warn/err on (explicit, cert_exists, key_exists, pem_parse,
    // mkcert_available).
    todo!("port tls evaluation")
}

#[cfg(test)]
mod tls_eval_tests {
    use super::*;
    use std::path::PathBuf;

    fn facts(explicit: bool, cert: bool, key: bool, pem: Option<Result<(), String>>) -> TlsFacts {
        TlsFacts {
            cert_path: PathBuf::from("/c.pem"),
            key_path: PathBuf::from("/k.pem"),
            explicit, cert_exists: cert, key_exists: key, pem_parse: pem,
        }
    }

    #[test]
    fn valid_pem_is_ok() {
        let r = evaluate_tls(&facts(false, true, true, Some(Ok(()))), true);
        assert!(r.iter().any(|c| c.status == Status::Ok));
    }

    #[test]
    fn corrupt_pem_is_err() {
        let r = evaluate_tls(&facts(false, true, true, Some(Err("bad".into()))), true);
        assert!(r.iter().any(|c| c.status == Status::Err));
    }

    #[test]
    fn explicit_missing_is_err() {
        let r = evaluate_tls(&facts(true, false, false, None), true);
        assert!(r.iter().any(|c| c.status == Status::Err));
    }

    #[test]
    fn auto_missing_with_mkcert_is_warn() {
        let r = evaluate_tls(&facts(false, false, false, None), true);
        assert!(r.iter().any(|c| c.status == Status::Warn));
    }

    #[test]
    fn auto_missing_without_mkcert_is_err() {
        let r = evaluate_tls(&facts(false, false, false, None), false);
        assert!(r.iter().any(|c| c.status == Status::Err));
    }
}
```

> Note: confirm `Status` variant names (`Ok`/`Warn`/`Err`/`Info`/`Skip`) and `CheckResult` field names. Mirror the source's exact result `name`/`detail`/`hint` strings if any existing tests assert on them.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib diagnostics::tls_eval_tests`
Expected: FAIL — `todo!`.

- [ ] **Step 3: Port and split**

Fill `evaluate_tls`. Add `async fn gather_tls_facts(tls: &TlsSettings) -> Result<TlsFacts, CheckResult>` doing the `default_tls_paths` resolution + `is_file()` checks + `RustlsConfig::from_pem_file`. Rewrite `check_tls` (356):

```rust
async fn check_tls(settings: &Settings, report: &mut Report) {
    if !settings.server.tls.enabled {
        report.push(/* Info: tls disabled */);
        return;
    }
    match gather_tls_facts(&settings.server.tls).await {
        Ok(facts) => {
            let mkcert = has_executable_on_path("mkcert");
            for r in evaluate_tls(&facts, mkcert) { report.push(r); }
        }
        Err(result) => report.push(result),
    }
}
```

- [ ] **Step 4: Run** — `cargo test --lib diagnostics::tls_eval_tests` → PASS. Run existing TLS tests too: `cargo test --lib diagnostics::tests::tls`.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics.rs
git commit -m "refactor(diagnostics): split check_tls into gather + pure evaluate"
```

---

## Task 2: `evaluate_index` (pure) + thin `check_index` (#14)

**Files:** Modify `src/diagnostics.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[derive(Debug, Clone)]
pub(crate) struct IndexFacts {
    pub db_exists: bool,
    pub db_open_error: Option<String>,
    pub missing_tables: Vec<&'static str>,
    pub page_count: i64,
    pub unresolved_link_count: i64,
    pub fts_row_count: i64,
    pub has_markdown: bool,
}

/// Pure evaluation of index facts (excludes the `--full` dry-build path).
pub(crate) fn evaluate_index(facts: &IndexFacts) -> Vec<CheckResult> {
    // Port check_index decision points (lines ~656-728): open error, missing
    // tables, counts detail, stale-index warning (page_count == 0 && has_markdown).
    todo!("port index evaluation")
}

#[cfg(test)]
mod index_eval_tests {
    use super::*;

    fn facts() -> IndexFacts {
        IndexFacts {
            db_exists: true, db_open_error: None, missing_tables: vec![],
            page_count: 5, unresolved_link_count: 0, fts_row_count: 5, has_markdown: true,
        }
    }

    #[test]
    fn healthy_index_is_ok() {
        let r = evaluate_index(&facts());
        assert!(r.iter().all(|c| c.status != Status::Err));
    }

    #[test]
    fn missing_table_is_err() {
        let mut f = facts();
        f.missing_tables = vec!["links"];
        let r = evaluate_index(&f);
        assert!(r.iter().any(|c| c.status == Status::Err));
    }

    #[test]
    fn open_error_is_err() {
        let mut f = facts();
        f.db_open_error = Some("corrupt".into());
        let r = evaluate_index(&f);
        assert!(r.iter().any(|c| c.status == Status::Err));
    }

    #[test]
    fn empty_index_with_markdown_warns_stale() {
        let mut f = facts();
        f.page_count = 0;
        let r = evaluate_index(&f);
        assert!(r.iter().any(|c| c.status == Status::Warn));
    }
}
```

- [ ] **Step 2–4: Fail → port → pass**

Add `fn gather_index_facts(vault: &Vault) -> IndexFacts` (db exists, open, schema check, the three counts, `vault_has_markdown`). Rewrite `check_index` (637) to: missing-db fast path (+ optional `run_index_dry_build` under `full`) → else `gather_index_facts` → push `evaluate_index(&facts)` → `if full { run_index_dry_build(...).await }`.

Run: `cargo test --lib diagnostics::index_eval_tests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics.rs
git commit -m "refactor(diagnostics): split check_index into gather + pure evaluate"
```

---

## Task 3: `evaluate_vault` (pure) + thin `check_vault` (#26)

**Files:** Modify `src/diagnostics.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[derive(Debug, Clone)]
pub(crate) struct VaultFacts {
    pub vault_root: std::path::PathBuf,
    pub root_exists: bool,
    pub root_is_dir: bool,
    pub root_writable: bool,
    pub dot_dir_exists: bool,
    pub config_load: Option<Result<(), String>>, // None until root/.clepsydra ok
    pub bad_globs: Vec<String>,
    pub attach_exists: bool,
    pub default_folder_empty: bool,
    pub default_folder_exists: bool,
}

/// Pure evaluation; returns (results, should_open_vault).
pub(crate) fn evaluate_vault(facts: &VaultFacts) -> (Vec<CheckResult>, bool) {
    // Port check_vault branches (lines ~484-611), except the final Vault::open.
    todo!("port vault evaluation")
}

#[cfg(test)]
mod vault_eval_tests {
    use super::*;
    use std::path::PathBuf;

    fn ok_facts() -> VaultFacts {
        VaultFacts {
            vault_root: PathBuf::from("/v"),
            root_exists: true, root_is_dir: true, root_writable: true,
            dot_dir_exists: true, config_load: Some(Ok(())),
            bad_globs: vec![], attach_exists: true,
            default_folder_empty: false, default_folder_exists: true,
        }
    }

    #[test]
    fn healthy_vault_should_open() {
        let (results, should_open) = evaluate_vault(&ok_facts());
        assert!(should_open);
        assert!(results.iter().all(|c| c.status != Status::Err));
    }

    #[test]
    fn missing_root_is_err_and_no_open() {
        let mut f = ok_facts();
        f.root_exists = false;
        let (results, should_open) = evaluate_vault(&f);
        assert!(!should_open);
        assert!(results.iter().any(|c| c.status == Status::Err));
    }

    #[test]
    fn unwritable_root_warns() {
        let mut f = ok_facts();
        f.root_writable = false;
        let (results, _) = evaluate_vault(&f);
        assert!(results.iter().any(|c| c.status == Status::Warn));
    }

    #[test]
    fn bad_glob_is_err() {
        let mut f = ok_facts();
        f.bad_globs = vec!["[invalid".into()];
        let (results, _) = evaluate_vault(&f);
        assert!(results.iter().any(|c| c.status == Status::Err));
    }

    #[test]
    fn missing_default_folder_warns() {
        let mut f = ok_facts();
        f.default_folder_empty = false;
        f.default_folder_exists = false;
        let (results, _) = evaluate_vault(&f);
        assert!(results.iter().any(|c| c.status == Status::Warn));
    }
}
```

- [ ] **Step 2–4: Fail → port → pass**

Add `fn gather_vault_facts(settings, config_path, cwd) -> VaultFacts`. Rewrite `check_vault` (474) to: `let facts = gather_vault_facts(...); let (results, should_open) = evaluate_vault(&facts); for r in results { report.push(r); } if should_open { match Vault::open(&facts.vault_root) { Ok(v) => Some(v), Err(e) => { report.push(/* err */); None } } } else { None }`.

Run: `cargo test --lib diagnostics::vault_eval_tests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics.rs
git commit -m "refactor(diagnostics): split check_vault into gather + pure evaluate"
```

---

## Task 4: Renderer coverage top-up

`render_human`/`render_json` are low-CC but worth pinning so the report schema is asserted independently.

**Files:** Modify `src/diagnostics.rs`

- [ ] **Step 1: Write tests**

```rust
#[cfg(test)]
mod render_tests {
    use super::*;

    fn sample_report() -> Report {
        let mut r = Report::default();
        r.push(CheckResult { section: "vault", name: "root", status: Status::Ok,
            detail: "ok".into(), hint: None });
        r.push(CheckResult { section: "tls", name: "certs", status: Status::Warn,
            detail: "missing".into(), hint: Some("run mkcert".into()) });
        r
    }

    #[test]
    fn json_contains_checks_and_summary() {
        let mut buf = Vec::new();
        sample_report().render_json(&mut buf).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("\"summary\""));
        assert!(s.contains("certs"));
    }

    #[test]
    fn human_renders_hint_line() {
        let mut buf = Vec::new();
        sample_report().render_human(&mut buf).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("run mkcert"));
    }
}
```

> Note: confirm `Report::default()`/`push` and `CheckResult` literal construction (the `section`/`name` are `&'static str`). Mirror the actual `Summary` JSON key.

- [ ] **Step 2: Run & commit**

Run: `cargo test --lib diagnostics::render_tests`
Expected: PASS

```bash
git add src/diagnostics.rs
git commit -m "test(diagnostics): cover report renderers directly"
```

---

## Task 5: Slice gate

- [ ] **Step 1: Full suite green**

Run: `cargo test`
Expected: PASS. The existing 15 diagnostics tests plus the new evaluate/render tests are all green.

- [ ] **Step 2: CRAP gate**

Run: `./scripts/crap-check.sh`
Expected: count strictly below slice-04; none of `check_index`/`check_tls`/`check_vault` in `✗`.

```bash
cargo crap --lcov lcov.info 2>&1 | rg '✗' | rg 'diagnostics\.rs' || echo "diagnostics cleared"
```
Expected: `diagnostics cleared`

- [ ] **Step 3: New-helper check**

If any `evaluate_*` appears in `✗`, it has uncovered branches — add the missing fact-combination test. (The evaluate functions inherit the original CC, so their tests must hit every status path.)

- [ ] **Step 4: Commit top-ups**

```bash
git add -A && git commit -m "test(diagnostics): close coverage gaps for slice 05"
```

---

## Self-Review

- **Spec coverage:** check_tls (T1), check_index (T2), check_vault (T3), renderers (T4). ✓
- **Pure evaluables:** each `evaluate_*` takes only a `*Facts` value and returns `Vec<CheckResult>` (or a tuple for vault) — fully unit-testable with no I/O, no env mutation. ✓
- **Env injection:** `mkcert_available` and `dirs::data_dir()` are parameters, so no `$PATH`/env mutation in the pure tests. ✓
- **Behavior guard:** the existing in-file diagnostics tests must stay green through every split. ✓
- **Risk:** `evaluate_*` functions carry the original branch count — the §5 new-helper check is the safety net ensuring each branch is covered.
