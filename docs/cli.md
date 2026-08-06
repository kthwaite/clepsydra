# CLI Reference

Clepsydra ships a single CLI binary: `clepsydra`.

If you are developing from source, you can run commands with:

```bash
cargo run -- <subcommand>
```

Examples in this doc use `clepsydra ...`; replace with `cargo run -- ...` if needed.

## Commands

| Command | Description | Status |
|---|---|---|
| `clepsydra init [PATH]` | Initialize a vault directory | ✅ implemented |
| `clepsydra new <TITLE> [--body TEXT]` | Create a note in configured vault | ✅ implemented |
| `clepsydra config show` | Print the selected application config verbatim | ✅ implemented |
| `clepsydra config create` | Create an empty user application config | ✅ implemented |
| `clepsydra serve` | Start the API server (HTTP, or HTTPS with `--tls`) | ✅ implemented |
| `clepsydra mcp` | MCP server on stdio (proxies the running API server) | ✅ implemented |
| `clepsydra version` | Print version | ✅ implemented |
| `clepsydra env` | Environment/config diagnostics | ⚠️ placeholder |
| `clepsydra doctor` | Health checks | ✅ implemented |

---

## `init`

Initialize a vault structure at `PATH` (defaults to current directory).

```bash
clepsydra init ./my-vault
```

Creates:

- `.clepsydra/config.toml`
- `.clepsydra/templates/`
- `_attachments/`

Fails if `PATH/.clepsydra` already exists.

---

## `new`

Create a note in the configured vault:

```bash
clepsydra new "Daily Log"
clepsydra new "Inbox" --body "- [ ] follow up"
```

Behavior:

- Reads vault root from app `config.toml` lookup order:
  1. `./config.toml`
  2. `$XDG_CONFIG_HOME/clepsydra/config.toml`
  3. `$HOME/.config/clepsydra/config.toml`
- Uses vault setting `vault.default_page_folder` from `<vault>/.clepsydra/config.toml`.
- Generates filename from title and writes markdown with frontmatter (`id`, timestamps, title).

Common errors:

- `no config.toml found ...`
- `config ... does not define [vault].root`
- `note already exists: ...`

---

## `config`

Inspect or create the application config. These commands do not operate on the
vault config at `<vault>/.clepsydra/config.toml`.

```bash
clepsydra config show
clepsydra config show --origin
clepsydra config path
clepsydra config path --trace
clepsydra config create
```

`config show` and `config path` select the first existing application config
from this lookup order:

1. `./config.toml`
2. `$XDG_CONFIG_HOME/clepsydra/config.toml`
3. `$HOME/.config/clepsydra/config.toml`

`config show` writes the selected file's bytes to stdout verbatim, with no
heading, path, or extra newline. It writes nothing to stderr by default.
`config show --origin` preserves that byte-exact stdout and writes exactly
`Origin: <selected path>\n` to stderr after styling is removed.

`config path` writes only `<selected path>\n` to stdout and nothing to stderr.
`config path --trace` preserves that path-only stdout and traces to stderr only
the candidates actually considered, in lookup order. Unselected candidates
start with two spaces; the selected candidate starts with `→ `. Resolution
stops at the selected file, so later candidates do not appear.

Origin and trace diagnostics use automatic color on stderr when the stream
supports it. Redirected stderr is plain text, and `NO_COLOR=1` disables ANSI
color. Stdout is never styled.

`config create` creates a fully commented application config template at
`$XDG_CONFIG_HOME/clepsydra/config.toml`, or
`$HOME/.config/clepsydra/config.toml` when `XDG_CONFIG_HOME` is unset. It
creates missing parent directories and prints `Created config at <path>`.
The template documents defaults and precedence and contains commented
`[server]`, `[server.tls]`, and `[vault]` sections with every example
assignment still commented. It is therefore non-empty but parses as an empty
TOML table. The command refuses to overwrite an existing file.

---

## `serve`

Start the API server:

```bash
clepsydra serve
```

Requires app config (`config.toml`) with at least `[vault].root`.

Useful endpoints once running:

- `GET /` → `ok`
- `GET /docs` → Swagger UI
- `GET /api/openapi.json` → OpenAPI schema

### Flags

| Flag | Effect |
|---|---|
| `--lsp` | Also start the LSP server on stdio |
| `--tls` | Serve over HTTPS |
| `--port PORT` | Listen on `PORT` instead of the configured port |

`--tls` and `--port` override both the config file and the `CLEPSYDRA__*`
environment variables. `--tls` only ever turns HTTPS *on*: there is no flag to
force cleartext, so `serve` cannot silently downgrade a TLS config.

### Running an HTTPS server for client testing

Clients that require HTTPS (the iOS app, which has no ATS exception) need a TLS
server. Rather than flipping `[server.tls].enabled` in the config your everyday
plain server shares, start a second one on a spare port:

```bash
clepsydra serve --tls --port 3443
```

Certificates come from `[server.tls]` when `cert_path` and `key_path` are both
set; otherwise Clepsydra generates localhost certs with `mkcert` and caches them
in the app data dir. See [configuration.md](configuration.md) for details.

For the iOS Simulator, install the mkcert CA into its keychain once per
simulator — without this the app reports an untrusted certificate:

```bash
scripts/trust-simulator-ca.sh
```

Run `clepsydra doctor` to check cert state and `mkcert` availability.

---

## `version`

```bash
clepsydra version
```

Equivalent to `clepsydra --version`.

---

## `env` and `doctor`

`env` is currently a placeholder and prints:

- `env command not implemented yet`

`doctor` is implemented and runs the health checks described above.

---

## Typical workflow

```bash
# 1) Initialize a vault once
clepsydra init ./my-vault

# 2) Create an empty user application config
clepsydra config create

# 3) Edit that config and point [vault].root at the vault
# [vault]
# root = "./my-vault"

# 4) Start server
clepsydra serve

# 5) Create notes from another terminal
clepsydra new "Research log"
```
