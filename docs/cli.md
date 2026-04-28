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
| `clepsydra serve` | Start HTTP API server | ✅ implemented |
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
