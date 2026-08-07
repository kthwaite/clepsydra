# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Clepsydra is a personal knowledge management system ("digital garden") over a vault of markdown files. It ships three deliverables from one repo:

- **`clep`** — a Rust binary combining the CLI, the Axum HTTP API server, and a tower-lsp LSP server (`src/`)
- **React frontend** (`ui/`) — served by Vite in dev, embedded into the binary via `rust-embed` in production
- **Browser extension** (`extension/`) — web-page archiver that POSTs to the server's archive endpoint (build: `extension/README.md`)

## Verification Gates

After implementing any change, always run typecheck, lint, and the test suite before declaring work complete. Report results explicitly.

## Build & Development Commands

**Frontend:** all commands run from `ui/` with Bun; scripts live in `ui/package.json` (`dev`, `build`, `typecheck`, `lint`, `format`, `test`, `test:watch`, `openapi`, `knip`, `storybook`). Single test: `bun run test <file>` or `bun run test -t "<pattern>"`.

**Backend:** standard cargo (`build`, `test`, `clippy`, `fmt`). `cargo run -- serve` starts the API server; `cargo run -- lsp` starts a standalone, read-only LSP on stdio that can run concurrently with `serve` (see `docs/lsp.md`). Single integration test file: `cargo test --test <name>`. The CLI binary is named `clep` (clap displays "clepsydra"); `clep --help` and `docs/cli.md` cover subcommands and config lookup order.

## Feature Workflow

For any feature implementation: (1) grill/clarify scope and design first, (2) write a TDD task plan, (3) execute via subagents, (4) review each task, (5) verify gates, (6) commit and merge to develop.

## Architecture

### Backend (src/)

Rust 2024 edition. Axum 0.8 + Tokio; rusqlite (bundled, FTS5 powers `grep`); pulldown-cmark; notify for file watching; utoipa for OpenAPI.

- `src/bin/cli.rs` — clap dispatch → `src/lib.rs` (settings layering, `open_vault_and_index`, `run_server`)
- `src/vault/` — the domain layer, independent of HTTP: paths (`VaultPath`, NFC-normalized), page/frontmatter parsing, SQLite index + derivation chain (`derivers/`), link extraction/rewriting, mutation coordinator, filesystem sync/reconcile, content-addressed attachment storage (`cas.rs`), academic imports (DOI/ISBN/Zotero), hooks
- `src/api/` — one module per resource (pages, blocks, tasks, journal, agenda, board, folders, attachments, archive, academic, …); `events.rs` is the SSE stream the UI's sync indicator consumes; `frontend.rs` serves the embedded UI; `openapi.rs` + Swagger UI at `/docs`
- `src/lsp/` — tower-lsp server (completion, hover, references, rename, diagnostics, code actions) over its own private, read-only vault index; started standalone with `clep lsp` (see `docs/lsp.md`)
- `tests/` — integration tests using axum-test, wiremock, serial_test

### API contract

The OpenAPI spec is the typed bridge between backend and frontend: utoipa annotations → `/api/openapi.json` → `bun run openapi` → `ui/src/api/schema.d.ts` → `openapi-fetch` + `openapi-react-query` clients in `ui/src/api/`. **After changing any backend route or DTO, regenerate `schema.d.ts`** (server must be running).

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
