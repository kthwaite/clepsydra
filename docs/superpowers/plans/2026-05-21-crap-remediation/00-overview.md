# CRAP Remediation — Overview & Conventions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement the per-slice plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This overview file is **not** a task list — it defines the baseline, shared conventions, acceptance gate, and execution order for the six slice plans (`01`–`06`).

**Goal:** Drive `cargo crap --lcov lcov.info` from `26/570 functions exceed CRAP threshold 30` to `0/570`, by (a) splitting the six functions whose cyclomatic complexity alone exceeds the threshold, and (b) raising coverage on the twenty under-tested functions — without adding any network-dependent or flaky tests.

**Architecture:** Each slice extracts pure, testable logic out of fat handlers/methods into named helpers (keeping I/O adapters thin), then adds focused tests against those helpers plus a small number of integration tests through the existing temp-vault fixtures. Slices are independent and individually shippable.

**Tech Stack:** Rust 2024, Axum 0.8, tower-lsp, rusqlite (bundled SQLite), tokio, `cargo-llvm-cov`, `cargo-crap`. New dev-dependency introduced in slice 02: `wiremock` (HTTP fixtures).

---

## 1. The CRAP gate (read this first)

CRAP score per function:

```
CRAP(f) = CC(f)² · (1 − coverage(f))³  +  CC(f)
```

Two consequences that shape every slice:

- **At 100% coverage, `CRAP = CC`.** So any function with `CC > 30` fails *regardless of coverage* — it **must** be refactored. There are exactly six such functions (the "mandatory refactors").
- **For `CC ≤ 30`, coverage alone can pass the gate.** The required coverage to reach `CRAP ≤ 30` is `1 − ((30 − CC) / CC²)^(1/3)`. Refactoring to lower CC is still preferred where it also improves testability, because it lowers the coverage bar and shrinks the blast radius of each test.

### Authoritative baseline — all 26 failing functions

Captured from `cargo crap --lcov lcov.info` against `lcov.info` (generated 2026-05-21 17:10). `Req. cov` is the coverage that brings `CRAP ≤ 30` at the current CC (n/a when `CC > 30`). `Strategy`: **R** = mandatory refactor, **C** = coverage, **R+C** = both.

| # | Function | File:line | CC | Cov | CRAP | Req. cov | Strategy | Slice |
|---|----------|-----------|----|----|------|----------|----------|-------|
| 1 | `LspBackend::rename` | src/lsp/mod.rs:637 | 44 | 0% | 1980 | n/a | R+C | 01 |
| 2 | `run_server` | src/lib.rs:272 | 26 | 0% | 702 | ~82% | R+C | 03 |
| 3 | `import_zotero_handler` | src/api/academic.rs:788 | 63 | 53% | 472 | n/a | R+C | 02 |
| 4 | `LspBackend::references` | src/lsp/mod.rs:336 | 18 | 0% | 342 | ~67% | R+C | 01 |
| 5 | `LspBackend::code_action` | src/lsp/mod.rs:980 | 18 | 0% | 342 | ~67% | R+C | 01 |
| 6 | `LspBackend::prepare_rename` | src/lsp/mod.rs:561 | 16 | 0% | 272 | ~62% | R+C | 01 |
| 7 | `main` | src/bin/cli.rs:89 | 14 | 0% | 210 | ~57% | R+C | 03 |
| 8 | `LspBackend::hover` | src/lsp/mod.rs:231 | 13 | 0% | 182 | ~54% | R+C | 01 |
| 9 | `apply_source_wins` | src/api/academic.rs:702 | 13 | 0% | 182 | ~54% | R+C | 02 |
| 10 | `list_folder_contents` | src/api/folders.rs:190 | 12 | 0% | 156 | ~50% | R+C | 04 |
| 11 | `ensure_certificates` | src/lib.rs:226 | 10 | 0% | 110 | ~42% | R+C | 03 |
| 12 | `LspBackend::goto_definition` | src/lsp/mod.rs:170 | 10 | 0% | 110 | ~42% | R+C | 01 |
| 13 | `fetch_isbn` | src/vault/import_isbn.rs:65 | 10 | 0% | 110 | ~42% | C | 02 |
| 14 | `check_index` | src/diagnostics.rs:637 | 11 | 17% | 81 | ~46% | R+C | 05 |
| 15 | `LspBackend::did_save` | src/lsp/mod.rs:129 | 8 | 0% | 72 | ~30% | C | 01 |
| 16 | `LspBackend::completion` | src/lsp/mod.rs:304 | 8 | 0% | 72 | ~30% | C | 01 |
| 17 | `LspBackend::publish_diagnostics_for` | src/lsp/mod.rs:1345 | 8 | 0% | 72 | ~30% | R+C | 01 |
| 18 | `check_tls` | src/diagnostics.rs:356 | 14 | 41% | 55 | ~57% | R+C | 05 |
| 19 | `VaultIndex::build` | src/vault/index.rs:299 | 43 | 86% | 48 | n/a | R | 06 |
| 20 | `ingest_archive` | src/api/archive.rs:137 | 32 | 76% | 46 | n/a | R+C | 04 |
| 21 | `parse_blocks` | src/vault/block.rs:146 | 41 | 90% | 43 | n/a | R | 06 |
| 22 | `LspBackend::backlink_to_range` | src/lsp/mod.rs:1304 | 6 | 0% | 42 | ~13% | C | 01 |
| 23 | `import_doi` | src/api/academic.rs:527 | 6 | 0% | 42 | ~13% | C | 02 |
| 24 | `import_isbn_handler` | src/api/academic.rs:617 | 6 | 0% | 42 | ~13% | C | 02 |
| 25 | `VaultIndex::resolve_links_for_page` | src/vault/index.rs:870 | 39 | 96% | 39 | n/a | R | 06 |
| 26 | `check_vault` | src/diagnostics.rs:474 | 15 | 54% | 37 | ~60% | R+C | 05 |

Mandatory refactors (CC > 30): `rename`, `import_zotero_handler`, `VaultIndex::build`, `ingest_archive`, `parse_blocks`, `resolve_links_for_page`.

---

## 2. Execution order

Run the slices in this order (highest CRAP-reduction-per-effort first; behavior-sensitive core last):

1. **01-lsp** — 10 functions, all 0% coverage, contains the single worst function (`rename`, CRAP 1980). Largest win.
2. **02-academic-import** — `import_zotero_handler` (CRAP 472) plus the DOI/ISBN handlers; introduces the `wiremock` HTTP seam reused nowhere else.
3. **03-server-cli-tls** — `run_server`/`main`/`ensure_certificates`; extraction-heavy, modest test count.
4. **04-archive-folders** — `ingest_archive` (mandatory refactor) + `list_folder_contents`.
5. **05-diagnostics** — `check_index`/`check_tls`/`check_vault`; gather/evaluate split, fixture vaults.
6. **06-core-vault** — `parse_blocks`, `VaultIndex::build`, `resolve_links_for_page`. **Behavior-preserving only**, guarded by the existing extensive test suite. Do this last, when the workflow is well-rehearsed.

Each slice ends green and reduces the failing count. After every slice, the count must strictly decrease (see §5).

---

## 3. Shared test conventions

These apply to all slices. Do not restate them in each plan; reference this section.

### 3.1 No network, ever
No test may make a real outbound HTTP request or depend on external services (Crossref, OpenLibrary, a real Zotero install). Network-dependent logic is tested via injected base URLs + `wiremock` (slice 02) or by testing the pure parse/merge functions directly. A test that hits the network is a plan failure.

### 3.2 Temp-vault fixture
Vault-backed tests use a `tempfile::TempDir` and the existing init helper. The canonical pattern (already used across `tests/`) is:

```rust
use tempfile::TempDir;

fn temp_vault(files: &[(&str, &str)]) -> (TempDir, crate::vault::Vault) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    crate::vault::init::init_vault(&root).unwrap();
    for (rel, contents) in files {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, contents).unwrap();
    }
    let vault = crate::vault::Vault::open(&root).unwrap();
    (tmp, vault)
}
```

Integration tests in `tests/` reuse each module's existing `setup_server()` / `create_mock_zotero_db()` helpers rather than re-inventing fixtures (cited per-slice).

### 3.3 Unit tests vs integration tests
- **Pure helper tests** live in a `#[cfg(test)] mod tests` in the same source file as the helper. Prefer these — they are fast, need no `tokio`, and carry the bulk of the coverage.
- **Adapter / integration tests** that need the full stack live in `tests/` and reuse `setup_server()`-style fixtures.

### 3.4 Determinism
No reliance on wall-clock time, ordering of `HashMap` iteration, or filesystem ordering. Where a function reads `dirs::data_dir()` / `$PATH` / `$HOME`, inject the value as a parameter (see slices 03 and 05) rather than mutating process env; if process env must be touched, use the existing `EnvGuard` + `serial_test::serial` pattern already present in `src/diagnostics.rs` tests.

### 3.5 Behavior preservation
Every refactor is behavior-preserving. Before extracting, run the function's existing guard tests and confirm green; after extracting (before adding new tests), run them again and confirm still green. The new tests then *raise coverage of the extracted units*; they are not a substitute for the guard.

---

## 4. Baseline guardrail (do this once, before slice 01)

- [ ] **Step 1: Add the CRAP check script**

Create `scripts/crap-check.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cargo llvm-cov --lcov --output-path lcov.info
cargo crap --lcov lcov.info
```

```bash
chmod +x scripts/crap-check.sh
```

- [ ] **Step 2: Record the starting count**

Run: `./scripts/crap-check.sh`
Expected tail: `✗ 26/570 function(s) exceed CRAP threshold 30.`

- [ ] **Step 3: Wire CI (if a CI workflow exists)**

Add a job step that runs `./scripts/crap-check.sh`. `cargo crap` exits non-zero when any function exceeds the threshold, so the build fails until the count reaches 0. If no CI exists yet, skip this step and rely on the local script as the gate.

- [ ] **Step 4: Ignore the generated report**

Ensure `lcov.info` is git-ignored (it is a generated artifact; it currently shows as untracked in `git status`).

Run: `rg -q '^/?lcov\.info$' .gitignore || printf '\nlcov.info\n' >> .gitignore`

- [ ] **Step 5: Commit the guardrail**

```bash
git add scripts/crap-check.sh .gitignore
git commit -m "chore(crap): add CRAP coverage guardrail script"
```

---

## 5. Validation loop (run after every task and at slice boundaries)

**Per task** (fast inner loop — avoid the full instrumented recompile):

```bash
cargo test --lib <module>::tests::<test_name>      # unit test in src/
cargo test --test <integration_file> <test_name>   # integration test in tests/
```

**Per slice** (the gate — slow, full instrumented recompile + run):

```bash
./scripts/crap-check.sh
```

Track at each slice boundary:
- The `✗ N/570` count **strictly decreased** from the previous slice.
- Every function the slice targeted is gone from the `✗` rows (`rg '✗' <(cargo crap --lcov lcov.info) | rg '<function>'` returns nothing).
- No new function appeared in the `✗` list (extraction can create a new helper that is itself complex — if so, it must also be covered within the same slice).
- `cargo test` is fully green and no test performs network I/O (`rg -n 'reqwest|http://|https://' tests/ src/**/tests` reviewed for new occurrences).

**Final acceptance:** `cargo crap --lcov lcov.info` prints `✓ 0/570 function(s) exceed CRAP threshold 30.` and `cargo test` is green.

---

## 6. Cross-cutting risks

- **`run_server` needs ~82% coverage if left intact** — impractical for a socket-binding function. Slice 03 therefore treats it as a refactor: extract `build_router`, `resolve_cert_plan`, `build_bind_addr`, `build_app_state`, `run_cli`, leaving `run_server`/`main` thin enough (CC ≤ 5) to pass even at low coverage.
- **Core-vault refactors (slice 06) are behavior-sensitive.** They already sit at 86–96% coverage. The risk is a silent behavior change during extraction. Mitigation: the slice is gated entirely by the existing `tests/index_test.rs`, `tests/block_parser_test.rs`, `tests/block_ref_resolution_test.rs`, and `tests/e2e_block_refs_test.rs` suites — these must stay green at every step. No new behavior, only relocation.
- **Extraction can spawn a new over-threshold helper.** E.g. `evaluate_vault` (slice 05) inherits CC ~10. Each slice's plan covers its own new helpers; the §5 check guards against regressions.
- **tower-lsp `Client` is not publicly constructible** (slice 01). The plan resolves this with a `test_client()` helper that extracts a `Client` from a throwaway `LspService` via `service.inner()`; the bulk of LSP coverage comes from pure-helper tests that need no client at all.

---

## 7. Slice index

| Plan | Subsystem | Targets | New test seam |
|------|-----------|---------|---------------|
| `01-lsp.md` | LSP adapter | rename, references, code_action, prepare_rename, hover, goto_definition, did_save, completion, publish_diagnostics_for, backlink_to_range | `test_client()` + pure helper modules |
| `02-academic-import.md` | Academic import | import_zotero_handler, apply_source_wins, import_doi, import_isbn_handler, fetch_isbn | `wiremock` + `base_url` injection |
| `03-server-cli-tls.md` | Bootstrap/CLI/TLS | run_server, ensure_certificates, main | pure extractions (`build_router`, `resolve_cert_plan`, `run_cli`) |
| `04-archive-folders.md` | Archive/folders API | ingest_archive, list_folder_contents | pure extractions + existing `setup_server()` |
| `05-diagnostics.md` | Doctor diagnostics | check_index, check_tls, check_vault | gather/evaluate split + fixture vaults |
| `06-core-vault.md` | Vault core | parse_blocks, VaultIndex::build, resolve_links_for_page | behavior-preserving extraction under existing suite |
