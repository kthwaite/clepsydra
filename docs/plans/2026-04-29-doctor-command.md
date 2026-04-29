# `clepsydra doctor` Plan

_Date:_ 2026-04-29

## Context

The CLI defines a `doctor` subcommand (`src/bin/cli.rs:60`) that currently
prints `"doctor command not implemented yet"` and exits. The intent (per its
`long_about`) is to "run health checks for configuration, vault accessibility,
and runtime dependencies".

Today, those failure modes only surface as runtime errors when the user runs
`serve`, `init`, or `new` — typically deep inside `Settings::load`,
`Vault::open`, `VaultIndex::open`, `ContentStore::open`, or
`ensure_certificates`. `doctor` should pre-flight all of those code paths in a
read-only way and emit a structured report so the user can fix problems before
starting the server.

## Goals

1. give the user a single command that verifies every prerequisite `serve` and
   the LSP rely on
2. keep the report grouped, scannable, and machine-readable (`--json`) so it
   composes with CI and shell scripts
3. reuse the existing loaders (`Settings::load`, `Vault::open`,
   `VaultIndex::open`, `ContentStore::open`, `resolve_vault_root`,
   `expand_tilde`, `app_config::config_candidates`,
   `ensure_certificates`, `bcl::load_or_seed`) rather than duplicating logic
4. never panic — every check must report failure as a `CheckResult`, not an
   error bubbling out of `main`
5. produce an exit code that downstream tooling can act on

## Non-goals

This plan does **not** aim to:

- implement an auto-fix mode (`--fix`) — `doctor` stays read-only
- reach external services (DOI, ISBN, Crossref, Zotero web API) — health checks
  for those belong behind a future `--full --network` flag
- replace or subsume the still-unimplemented `env` subcommand; `doctor` only
  *reports* effective config, it does not pretty-print env layering
- mutate any on-disk state, including running `mkcert -install`

## Output format

Default human output, one line per check, grouped by section:

```
[OK]   server config        loaded from /home/me/.config/clepsydra/config.toml
[OK]   server address       resolves to 127.0.0.1:3000
[WARN] tls                  enabled but no cert_path/key_path; mkcert available
[OK]   vault root           /home/me/Documents/vault (read+write)
[ERR]  vault initialized    .clepsydra/ missing — run `clepsydra init`
[OK]   index                12,481 pages, 41 unresolved links
[OK]   cas                  1,204 blobs, 312 MB
...

Summary: 8 ok, 1 warn, 1 err
```

Flags:

- `--json` — emits `{ checks: [{ section, name, status, detail, hint }], summary: { ok, warn, err } }`
- `--strict` — promote warnings to errors for exit-code purposes
- `--full` — opt in to expensive checks (fresh `VaultIndex::build` dry-run, full
  CAS scan via `ContentStore::stats`); off by default

Exit codes:

- `0` — no errors (warnings allowed unless `--strict`)
- `1` — at least one error (or any warning under `--strict`)
- `2` — `doctor` itself crashed before producing a report (should be
  unreachable; treat as a bug)

## Checks

Each check is a small function returning `CheckResult { section, name, status,
detail, hint }`. Checks never short-circuit each other — a failed config-load
check still leaves the vault/index/CAS checks running with sensible
"skipped — depends on X" results.

### 1. Top-level config (`src/lib.rs:80-110`, `src/app_config.rs`)

- Probe `config_candidates(cwd)` and report which path matched (or `ERR` if
  none, listing every checked path — mirroring `Settings::load`'s error
  string).
- Re-run the `Config::builder()` chain and report parse failures with file +
  line where possible.
- Enumerate active `CLEPSYDRA__*` env overrides (informational).
- Print effective `server.host:port`, `dev_mode`, `tls.enabled` as info lines.

### 2. Server address (`src/lib.rs:370-376`)

- `tokio::net::lookup_host(host:port)` — `ERR` on resolution failure.
- Optional: attempt a non-blocking `TcpListener::bind` on the resolved
  `SocketAddr` and immediately drop, surfacing "address already in use" as
  `WARN` (it can be transient and is not necessarily wrong if the user already
  has the server running).

### 3. TLS (`src/lib.rs:178-222`)

Only runs when `server.tls.enabled = true`.

- If `cert_path`/`key_path` set, verify both files exist + readable, and
  validate them by calling `RustlsConfig::from_pem_file` (without binding).
- If unset, look for `dirs::data_dir()/clepsydra/localhost{,-key}.pem`. If
  missing, check whether `mkcert` is on `PATH`. If not, `ERR` with the same
  hint string the server prints today.

### 4. Vault root (`src/lib.rs:122-145`, `src/vault/mod.rs:53`)

- Resolve `vault.root` via `resolve_vault_root` and print the absolute path.
- Check it exists, is a directory, is readable, and is writable.
- Check `<root>/.clepsydra/` exists (vault initialized). Hint:
  `clepsydra init <root>`.
- Parse `.clepsydra/config.toml` via `VaultConfig::load`; report parse errors.
- Validate every `excluded_patterns` entry with `glob::Pattern::new` (this is
  currently a hard error inside `Vault::open`).
- Report `default_page_folder` resolves to an existing directory (`WARN` if
  not — `clepsydra new` will fail otherwise).
- Report attachment folder (`vault.attachment_folder`) existence (`WARN` only).

### 5. Index DB (`src/lib.rs:249-261`, `src/vault/index.rs:216`)

- Open `<root>/.clepsydra/cache.db` and confirm SQLite opens with WAL +
  foreign-keys pragmas applied.
- Verify expected tables exist (`pages`, `links`, `tags`, `blocks`,
  `block_properties`, `canonical_names`, `pages_fts`) by querying
  `sqlite_master`.
- Report row counts: `pages`, unresolved links, FTS rows.
- Surface a stale-index hint if `pages = 0` while the vault contains `.md`
  files.
- Under `--full`: open in a temp copy, run `VaultIndex::build` against the
  vault, and report `BuildStats.warnings`.

### 6. Content-addressed store (`src/lib.rs:243-247`, `src/vault/cas.rs`)

- Expand-tilde `archive.cas_path` (via `expand_tilde`) and check directory +
  writability.
- Open the CAS sqlite DB; under `--full`, call `ContentStore::stats()` and
  report blob count + total size.
- `WARN` (not `ERR`) when `archive.enabled = false` in vault config — this is
  a valid configuration but worth surfacing.

### 7. Academic / Zotero (`src/vault/config.rs:80-111`)

- Check `library_folder`, `papers_folder`, `books_folder`,
  `annotations_folder` paths exist (`WARN` only — they are created on first
  use).
- If `academic.zotero.database_path` is set, verify the file exists; otherwise
  emit an info line noting auto-detection happens at runtime.

### 8. BCL (`src/vault/bcl.rs:28`)

- Run `load_or_seed(vault.root())` and report whether a date was loaded and
  from where (informational only).

### 9. Runtime / build info

- `clepsydra` version (`env!("CARGO_PKG_VERSION")`).
- `RUST_LOG` value if set (informational).
- Target triple (via `env!("TARGET")` set in `build.rs` or a small `built`
  crate dependency — keep optional).

## Implementation shape

Module layout:

- new `src/diagnostics.rs` (or `src/diagnostics/mod.rs` if it grows) owning
  the public surface:

  ```rust
  pub enum Status { Ok, Warn, Err }
  pub struct CheckResult {
      section: &'static str,
      name: &'static str,
      status: Status,
      detail: String,
      hint: Option<String>,
  }
  pub struct Report { results: Vec<CheckResult> }
  impl Report {
      pub fn exit_code(&self, strict: bool) -> i32;
      pub fn render_human(&self, w: &mut impl io::Write) -> io::Result<()>;
      pub fn render_json(&self, w: &mut impl io::Write) -> io::Result<()>;
  }
  pub async fn run(opts: DoctorOpts) -> Report;
  pub struct DoctorOpts { pub full: bool }
  ```

- factor a non-aborting variant of `Settings::load` so `doctor` can keep going
  after a config failure. Either:
  - extract the pure `Config::builder()...try_deserialize()` step into a
    `pub fn try_load_settings(path: &Path) -> Result<Settings, ConfigError>`,
    and let `doctor` first call `find_config_path` itself, or
  - keep `Settings::load` but mark the error type structured enough that
    `doctor` can format it as a check result.

- widen visibility on a few items currently `pub(crate)` / private in
  `src/lib.rs` so `diagnostics` can call them from inside the crate:
  `Settings`, `ServerSettings`, `TlsSettings`, `VaultSettings`,
  `resolve_vault_root`, `expand_tilde`, `ensure_certificates`. Refactor
  `ensure_certificates` so the cert-discovery half is separable from the
  `mkcert -install` side-effect; `doctor` only calls the read-only half.

- wire into `cli.rs`:

  ```rust
  Commands::Doctor { json, strict, full } => {
      let report = clepsydra::diagnostics::run(DoctorOpts { full }).await;
      let mut stdout = std::io::stdout().lock();
      if json {
          report.render_json(&mut stdout)?;
      } else {
          report.render_human(&mut stdout)?;
      }
      std::process::exit(report.exit_code(strict));
  }
  ```

- update the `Doctor` variant to carry flags:

  ```rust
  Doctor {
      #[arg(long)] json: bool,
      #[arg(long)] strict: bool,
      #[arg(long)] full: bool,
  }
  ```

## Tests

Unit tests per check, using `tempfile::TempDir`-backed vaults:

- missing top-level config (none of the candidates exist)
- malformed `config.toml` (invalid TOML; missing required fields)
- env override layering (set `CLEPSYDRA__SERVER__PORT` and assert it appears
  in the report)
- vault root nonexistent / not a directory / not writable
- vault root exists but `.clepsydra/` missing
- vault config has a bad `excluded_patterns` glob
- `default_page_folder` references nonexistent directory
- index DB present + schema valid; index DB present + missing table; index DB
  absent
- CAS path under tilde; CAS path nonexistent; CAS disabled in vault config
- TLS enabled with both cert paths missing; TLS enabled with invalid PEM
  contents; TLS enabled with `PATH=""` so `mkcert` is unfindable
- Zotero database path set to a missing file vs. a real file

Renderer:

- snapshot test (plain string compare) on `render_human` for a known fixture
  report
- `serde_json::from_str` roundtrip on `render_json` output to assert schema
  shape

Integration:

- `cargo run -- doctor` against a freshly `init`-ed vault → exit 0
- `cargo run -- doctor` against an empty CWD with no config anywhere →
  exit 1 with helpful message
- `cargo run -- doctor --json` parses as JSON

## Rollout

1. land the module + flags + minimal renderer with checks 1, 2, 4, 5, 6, 9
2. add TLS (3) and academic/Zotero (7) checks
3. add `--full` index dry-build and CAS stats
4. add BCL info line (8)

Each step is independently shippable; the CLI flag surface is fixed at step 1
so later steps don't change UX.
