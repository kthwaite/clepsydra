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
| `clepsydra serve` | Start the API server (HTTP, or HTTPS with `--tls`) | ✅ implemented |
| `clepsydra version` | Print version | ✅ implemented |
| `clepsydra env` | Environment/config diagnostics | ⚠️ placeholder |
| `clepsydra doctor` | Health checks | ⚠️ placeholder |

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

These commands are currently placeholders and print:

- `env command not implemented yet`
- `doctor command not implemented yet`

---

## Typical workflow

```bash
# 1) Initialize a vault once
clepsydra init ./my-vault

# 2) Create app config (config.toml) pointing at it
# [vault]
# root = "./my-vault"

# 3) Start server
clepsydra serve

# 4) Create notes from another terminal
clepsydra new "Research log"
```
