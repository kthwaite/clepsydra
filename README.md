# clepsydra

a bespoke personal knowledge management system.

## Getting started

- Local setup: [ui/src/docs/content/getting-started.mdx](ui/src/docs/content/getting-started.mdx) (in app: `/docs/getting-started`)
- Tailnet HTTPS via Caddy: [ui/src/docs/content/getting-started.mdx#6-optional-expose-over-tailscale-with-caddy](ui/src/docs/content/getting-started.mdx#6-optional-expose-over-tailscale-with-caddy)

## Development

Run `just debug` to start an isolated backend at <http://127.0.0.1:3100>
and a Vite frontend with HMR at <http://127.0.0.1:5174>. Each invocation
creates a fresh, representative disposable vault. Press Ctrl-C to stop both
services and remove all temporary data.

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