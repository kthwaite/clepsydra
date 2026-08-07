# Configuration Reference

Clepsydra uses two config layers:

1. **Application config** (`config.toml`) — server bind settings, frontend serving mode, TLS, and vault root
2. **Vault config** (`<vault>/.clepsydra/config.toml`) — vault behavior, academic/archive settings

---

## 1) Application config (`config.toml`)

### Lookup order

For commands that need app config (`serve`, `new`, `config show`, and `config path`), Clepsydra checks in this order:

1. `./config.toml` (current working directory)
2. `$XDG_CONFIG_HOME/clepsydra/config.toml`
3. `$HOME/.config/clepsydra/config.toml`

### Inspecting and creating the file

```bash
clepsydra config show
clepsydra config show --origin
clepsydra config path
clepsydra config path --trace
clepsydra config create
```

`config show` prints the first existing file from the lookup order byte for
byte on stdout, with no added newline and no stderr output. `--origin` leaves
stdout unchanged and writes `Origin: <selected path>\n` to stderr.

`config path` writes only `<selected path>\n` to stdout and nothing to stderr.
With `--trace`, stderr lists only the candidates actually considered, in
lookup order: unselected candidates have a two-space prefix and the selected
candidate has a `→ ` prefix. Lookup stops at the selected file, so the trace
does not include later candidates.

Origin and trace diagnostics use automatic color only on stderr when supported.
Redirected stderr is plain text, `NO_COLOR=1` disables ANSI color, and stdout
is never styled.

`config create` creates a fully commented user config template at
`$XDG_CONFIG_HOME/clepsydra/config.toml`, or
`$HOME/.config/clepsydra/config.toml` when `XDG_CONFIG_HOME` is unset. It
creates missing parent directories and refuses to overwrite an existing file.
The non-empty template documents precedence and defaults in commented
`[server]`, `[server.tls]`, and `[vault]` sections; all example assignments
remain commented, so the template parses as an empty TOML table. The compact
active equivalent is shown below.

### Example

```toml
[server]
host = "localhost"
port = 3000
dev_mode = false

[server.tls]
enabled = false
# cert_path = "certs/localhost.pem"
# key_path = "certs/localhost-key.pem"

[vault]
root = "./vault"
```

### Keys

| Section | Key | Type | Default | Notes |
|---|---|---:|---|---|
| `server` | `host` | string | `localhost` | Bind host |
| `server` | `port` | integer | `3000` | Bind port |
| `server` | `dev_mode` | bool | `false` | `false`: serve embedded frontend. `true`: API/docs only |
| `server.tls` | `enabled` | bool | `false` | Enable HTTPS |
| `server.tls` | `cert_path` | string | unset | Used only when **both** cert and key are set |
| `server.tls` | `key_path` | string | unset | Used only when **both** cert and key are set |
| `vault` | `root` | string | `./vault` | Vault root path |

### Frontend serving behavior (`server.dev_mode`)

- `dev_mode = false` (default): Clepsydra serves embedded frontend assets from `ui/dist` at `/`.
- `dev_mode = true`: frontend serving is disabled; use the Vite dev server separately (typically `http://127.0.0.1:5173`).

### TLS behavior (`server.tls`)

When `server.tls.enabled = true`:

1. If both `cert_path` and `key_path` are set, Clepsydra uses those certificate files.
2. Otherwise, Clepsydra attempts automatic localhost certificate provisioning with `mkcert`.

Auto-generated certs are stored in your platform app-data dir under `clepsydra/`, for example:

- macOS cert: `~/Library/Application Support/clepsydra/localhost.pem`
- macOS key: `~/Library/Application Support/clepsydra/localhost-key.pem`

If `mkcert` is unavailable, startup fails with an installation hint.

To start an HTTPS server without changing this file — the usual case when
testing an HTTPS-only client against a machine that already runs a plain server
— use the `serve` flags instead:

```bash
clepsydra serve --tls --port 3443
```

See [cli.md](cli.md#running-an-https-server-for-client-testing), including the
one-off step to make the iOS Simulator trust the mkcert CA.

### Environment overrides

Application config supports env overrides via `CLEPSYDRA__...`:

- `CLEPSYDRA__SERVER__HOST`
- `CLEPSYDRA__SERVER__PORT`
- `CLEPSYDRA__SERVER__DEV_MODE`
- `CLEPSYDRA__SERVER__TLS__ENABLED`
- `CLEPSYDRA__SERVER__TLS__CERT_PATH`
- `CLEPSYDRA__SERVER__TLS__KEY_PATH`
- `CLEPSYDRA__VAULT__ROOT`

Example:

```bash
export CLEPSYDRA__SERVER__DEV_MODE=true
export CLEPSYDRA__SERVER__PORT=4000
cargo run -- serve
```

Full precedence, later wins: defaults → config file → environment →
`serve --tls` / `serve --port`.

### Relative path resolution

- `vault.root`:
  - absolute → used as-is
  - relative in `config.toml` → resolved relative to that config file’s directory
  - relative from `CLEPSYDRA__VAULT__ROOT` → resolved relative to process working directory
- `server.tls.cert_path` / `server.tls.key_path`: same rules as `vault.root`
  (`~` expands to the home directory; relative paths in `config.toml` resolve
  against the config file’s directory, env-supplied ones against the process
  working directory)

---

## 2) Vault config (`.clepsydra/config.toml`)

Created by:

```bash
clepsydra init <path>
# or
cargo run -- init <path>
```

Path:

```text
<vault-root>/.clepsydra/config.toml
```

### `[vault]` settings

| Key | Type | Default | Notes |
|---|---:|---|---|
| `attachment_folder` | string | `_attachments` | Attachment root under vault |
| `excluded_patterns` | string[] | see below | Glob/prefix excludes |
| `default_page_folder` | string | `""` | Used by `clepsydra new` |
| `linkable_properties` | string[] | `["tags", "aliases"]` | Frontmatter fields treated as refs |
| `disambiguation_strategy` | enum | `shortest_path` | `shortest_path`, `closest_directory`, `most_recent` |

Default `excluded_patterns`:

```toml
[
  ".clepsydra",
  ".clepsydra/**",
  "_attachments",
  "_attachments/**",
  ".git",
  ".git/**",
  "node_modules",
  "node_modules/**",
]
```

### `[academic]` settings

| Key | Default |
|---|---|
| `library_folder` | `library` |
| `papers_folder` | `library/papers` |
| `books_folder` | `library/books` |
| `annotations_folder` | `library/annotations` |

### `[archive]` settings

| Key | Type | Default |
|---|---:|---|
| `enabled` | bool | `true` |
| `cas_path` | string | `~/.clepsydra/cas` |
| `default_path_prefix` | string | `archive` |
| `max_blob_size_mb` | integer | `50` |
| `max_request_size_mb` | integer | `100` |
| `gc_min_age_days` | integer | `30` |

Notes:

- `cas_path` supports `~/...` (expanded to your home directory).
- Archive request size limits are enforced at ingest time.

---

## Full vault config example

```toml
[vault]
attachment_folder = "_attachments"
default_page_folder = "notes"
linkable_properties = ["tags", "aliases", "related"]
disambiguation_strategy = "closest_directory"
excluded_patterns = [
  ".clepsydra/**",
  "_attachments/**",
  ".git/**",
  "node_modules/**",
  "build/**",
]

[academic]
library_folder = "library"
papers_folder = "library/papers"
books_folder = "library/books"
annotations_folder = "library/annotations"

[archive]
enabled = true
cas_path = "~/.clepsydra/cas"
default_path_prefix = "archive"
max_blob_size_mb = 50
max_request_size_mb = 100
gc_min_age_days = 30
```

---

## Related docs

- `docs/getting-started.md`
- `docs/cli.md`
- `ui/README.md`
- `extension/README.md`
