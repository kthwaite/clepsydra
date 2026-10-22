<h1 align="center">
  <img src="ui/public/favicon.svg" alt="Clepsydra icon" width="128" height="128"><br/>
  clepsydra
</h1>

a bespoke personal knowledge management system.

## Getting started

- Local setup: [ui/src/docs/content/getting-started.mdx](ui/src/docs/content/getting-started.mdx) (in app: `/docs/getting-started`)
- Tailnet HTTPS via Caddy: [ui/src/docs/content/getting-started.mdx#6-optional-expose-over-tailscale-with-caddy](ui/src/docs/content/getting-started.mdx#6-optional-expose-over-tailscale-with-caddy)

## Development

Run `just debug` to start an isolated backend at <http://127.0.0.1:3100>
and a Vite frontend with HMR at <http://127.0.0.1:5174>. Each invocation
creates a fresh, representative disposable vault. Press Ctrl-C to stop both
services and remove all temporary data.

### CI verification

The [CI workflow](.github/workflows/ci.yml) checks frontend types, lint, tests,
and build, plus Rust formatting, Clippy, and tests on Linux and macOS.
To reproduce the core gates locally from the repository root:

```sh
(cd ui && bun run typecheck && bun run lint && bun run test && bun run build)
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --no-fail-fast -- --test-threads=4
```

Inspect failures with `gh run list` and `gh run view <run-id> --log-failed`.
For runner-only Clippy failures, compare compiler versions: the runners'
preinstalled Rust versions can differ by platform and from the local toolchain.
Use `cargo +<runner-version> clippy --locked --all-targets -- -D warnings`
to check with the failing runner's version rather than suppressing its lint.

A Git failure with exit status `-1` means the child had no normal exit code.
Its diagnostic includes the OS termination status (such as `signal: 9`), while
preserving any Git stderr. Use that signal and the runner's crash/resource logs
to investigate; do not assume a configuration error or retry a mutation blindly.

## Documentation

- Frontend guide: [ui/README.md](ui/README.md)
- UI component audit: [docs/design-notes/react-aria-component-audit.md](docs/design-notes/react-aria-component-audit.md)
- UI migration plan: [docs/plans/2026-04-09-react-aria-ui-migration.md](docs/plans/2026-04-09-react-aria-ui-migration.md)
- CLI reference: [ui/src/docs/content/cli.mdx](ui/src/docs/content/cli.mdx) (in app: `/docs/cli`)
- Configuration reference: [ui/src/docs/content/configuration.mdx](ui/src/docs/content/configuration.mdx) (in app: `/docs/configuration`)
- Encrypted notes and security model: [docs/encrypted-notes.md](docs/encrypted-notes.md)
- Browser extension install/dev guide: [extension/README.md](extension/README.md)

## RSS/Atom reader

Subscriptions live in the reserved, human-editable `<vault>/feeds.md` manifest.
Use `##` headings for groups, Markdown feed links for optional title overrides,
and trailing hashtags for feed-level tags:

```markdown
## Engineering

- [Rust Blog](https://blog.rust-lang.org/feed.xml) #rust
```

The API is served below `/api/vault/feeds`. Configure scheduling, read/unread
retention, response/content limits, and bounded fetch concurrency in the
application config’s `[feeds]` section; see the
[configuration reference](ui/src/docs/content/configuration.mdx).

Feed requests and redirects reject non-global destinations, response bodies are
bounded, and stored entry HTML is sanitized. Bookmarks are durable and excluded
from retention pruning. `feeds.md` is never indexed, and manifest writes use
revision-checked atomic publication so UI mutations cannot overwrite external
edits.
