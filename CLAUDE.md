# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Clepsydra is a personal knowledge management system ("digital garden") over a vault of markdown files. It ships three deliverables from one repo:

- **`clep`** — a Rust binary combining the CLI, the Axum HTTP API server, and a tower-lsp LSP server, built from a Cargo workspace of seventeen crates under `crates/`
- **React frontend** (`ui/`) — served by Vite in dev, embedded into the binary via `rust-embed` in production
- **Browser extension** (`extension/`) — web-page archiver that POSTs to the server's archive endpoint (build: `extension/README.md`)

## Verification Gates

After implementing any change, always run typecheck, lint, and the test suite before declaring work complete. Report results explicitly.

## Build & Development Commands

**Frontend:** all commands run from `ui/` with Bun; scripts live in `ui/package.json` (`dev`, `build`, `typecheck`, `lint`, `format`, `test`, `test:watch`, `openapi`, `knip`, `storybook`). Single test: `bun run test <file>` or `bun run test -t "<pattern>"`.

**Backend:** standard cargo (`build`, `test`, `clippy`, `fmt`). `cargo run -- serve` starts the API server; `cargo run -- lsp` starts a standalone, read-only LSP on stdio that can run concurrently with `serve` (see `ui/src/docs/content/lsp.mdx`); `clep sync [init|status]` drives git-backed sync (`ui/src/docs/content/sync.mdx`). Single integration test file: `cargo test --test <name>`. The CLI binary is named `clep` (clap displays "clepsydra"); `clep --help` and `ui/src/docs/content/cli.mdx` cover subcommands and config lookup order.

**Workspace:** the repo root is a virtual workspace (`[workspace]`, no `[package]` of its own — there is no `clepsydra` crate); every crate lives under `crates/`. `crates/clep` is the CLI binary; `crates/clep-api` is the HTTP API and server bootstrap; the rest are extracted feature and infrastructure crates (see Architecture below). `cargo test` at the root covers every crate. `cargo test -p <crate>` runs one crate's tests. Install the binary with `cargo install --path crates/clep --locked --force` (`just install`).

## Feature Workflow

For any feature implementation: (1) grill/clarify scope and design first, (2) write a TDD task plan, (3) execute via subagents, (4) review each task, (5) verify gates, (6) commit and merge to develop.

## Architecture

### Backend (crates/)

Rust 2024 edition. Axum 0.8 + Tokio; rusqlite (bundled, FTS5 powers `grep`); pulldown-cmark; notify for file watching; utoipa for OpenAPI. Seventeen crates under `crates/`, all prefixed `clep-` except the `clep` binary itself; full design and DAG in `docs/superpowers/specs/2026-09-09-crate-split-design.md`.

- `crates/clep` — the binary: clap dispatch (`main.rs`), `sync_command.rs` and `config_command.rs` (CLI), `macos_url_handler.rs`, `new_note_command.rs`, `run_lsp_standalone` (bridges to `clep-lsp`), grep/tree human-readable rendering
- `crates/clep-config` — `Settings` and its layered sources, `FeatureFlags`, TLS/server/vault settings, `app_config`, `expand_tilde`; no dependencies on other workspace crates
- `crates/clep-vault` — the vault model, independent of SQLite and HTTP: paths (`VaultPath`, NFC-normalized), page/frontmatter parsing, link extraction/rewriting, kinds, codes, config, atomic writes, rubbish, task history, init
- `crates/clep-index` — SQLite index + derivation chain (`derivers/`), hooks traits, FTS `grep`/`tree`, filesystem sync/reconcile (`sync/`)
- `crates/clep-bases` — Bases (`.base` definitions), queries, property values; supplies the `LinkablePropertiesProvider` the index consults (provider inversion, so the index never depends on bases)
- `crates/clep-mutate` — the mutation coordinator, batch mutations, reconciliation, and reference/label/code repair (`relabel`, `recode`, `migrate`)
- `crates/clep-academic` — DOI/ISBN/Zotero imports and the academic move hook
- `crates/clep-archive` — content-addressed attachment storage (`cas.rs`), archive hooks, snapshot, backfill
- `crates/clep-gitsync` — git-backed vault sync: `git.rs` subprocess wrapper, `init.rs`, `engine.rs` (commit → pull → resolve → fold journals → push), `conflict_copy.rs`, `merge_driver.rs` (the hidden `clep merge-driver` git invokes for `*.md`), `journal_merge.rs`, `state.rs` (`<git-dir>/clep-sync.toml`); driven by `crates/clep-api/src/sync_runtime.rs` (the server's quiesce window) and `crates/clep/src/sync_command.rs` (CLI). See `ui/src/docs/content/sync.mdx`
- `crates/clep-feeds` — RSS/Atom feed fetching, storage, and the scheduler (takes a runtime + root + change callback, not `AppState`)
- `crates/clep-client` — `ApiClient`, `configured_api_client`, TLS/loopback helpers, `todo_capture`
- `crates/clep-mcp` — the MCP server (`server.rs`, `tasking.rs`, `edit.rs`, `run_mcp`)
- `crates/clep-lsp` — tower-lsp server (completion, hover, references, rename, diagnostics, code actions) over its own private, read-only vault index; started standalone with `clep lsp` (see `ui/src/docs/content/lsp.mdx`)
- `crates/clep-doctor` — `clep doctor`'s read-only checks, one section per concern (`mod.rs` + `sync.rs`); never writes to the vault or the repo
- `crates/clep-frontend-assets` — the embedded UI (`api/frontend.rs`, rust-embed over `ui/dist`); only the `clep` binary links it, so a `ui/dist` change recompiles this small crate and the binary, not the whole API layer
- `crates/clep-api` — everything else: `crates/clep-api/src/api/` (one module per HTTP resource — pages, blocks, tasks, journal, agenda, board, folders, attachments, archive, academic, …; `events.rs` is the SSE stream the UI's sync indicator consumes; `openapi.rs` + Swagger UI at `/api/docs`), plus `lib.rs` bootstrap (`build_app_state`, `build_router`, `run_server`, watcher, TLS serve, shutdown, `run_startup_reconcile`), `sync_runtime.rs`, `deeplink.rs`, `vault/geocode.rs` (declared by the vault shim), `backup.rs`. Depends on every feature crate above except `clep-lsp`, `clep-doctor`, and `clep-frontend-assets` — the `clep` binary links those directly
- `crates/clep-test-support` (dev only) — `EnvGuard` and shared test fixtures (e.g. the `private-note.age` encryption fixture)
- `tests/` under each crate — integration tests using axum-test, wiremock, serial_test; multi-crate/`ApiFixture` tests live in `crates/clep-api/tests`, bin-spawning tests in `crates/clep/tests`

### API contract

The OpenAPI spec is the typed bridge between backend and frontend: utoipa annotations → `/api/openapi.json` → `bun run openapi` → `ui/src/api/schema.d.ts` → `openapi-fetch` + `openapi-react-query` clients in `ui/src/api/`. **After changing any backend route or DTO, regenerate `schema.d.ts`.** `bun run openapi` needs a running server; to regenerate without one (and without the ambient-config risk of starting `clep` against the live vault), use `cargo run -q -p clep-api --example openapi > target/openapi.json && (cd ui && bun run openapi:file)`.

### Frontend

UI conventions — stack, path alias, editor (Slate) architecture, the Vessel design language, and TypeScript code style — live in `ui/CLAUDE.md`, which loads automatically when working under `ui/`.

## Code Style

### Rust
- Standard `rustfmt` and `clippy` conventions

## Tooling / Conventions

- Use ruff and ty for Python tooling (not black); respect NO_COLOR conventions in CLI output.

## Git Workflow

- `main` is the primary branch; `develop` is the integration branch
- Feature branches off `develop`
- Merge completed feature branches into `develop` and clean up worktrees afterward
