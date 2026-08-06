# Config Origin and Literate Template Design

## Goal

Extend the application-config commands so `clep config show` can identify the selected file without contaminating its stdout data stream, and `clep config create` produces a useful, fully commented configuration guide instead of a zero-byte file.

## `clep config show --origin`

### Output contract

Without the option, behavior remains unchanged: the selected config file bytes are written verbatim to stdout with no heading, path, or extra newline.

With `--origin`:

1. Resolve and read the selected application config once.
2. Write `Origin: <path>\n` to stderr.
3. Write the config bytes verbatim to stdout.

The origin path uses Clepsydra's existing orange terminal accent. Rendering uses `anstream` so terminal capability, `NO_COLOR`, `CLICOLOR`, and redirected stderr are handled consistently with existing CLI output. Redirected or color-disabled stderr contains the same line without ANSI escapes.

Keeping origin metadata on stderr preserves uses such as `clep config show --origin | toml-tool`.

### Data model

The config-command library operation returns a value containing both the resolved `PathBuf` and the file's `Vec<u8>`. This guarantees the displayed origin is the file that supplied the displayed bytes and avoids a second lookup race.

A focused renderer accepts a path and `std::io::Write`, following the existing library renderer pattern. The CLI supplies an auto-coloring stderr stream when `--origin` is set.

## `clep config create` literate template

`create` keeps its existing destination and exclusivity rules but writes a static, fully commented TOML guide instead of an empty file.

Every section header and assignment remains commented. The file therefore parses as an empty TOML document and preserves Clepsydra's runtime defaults until the user deliberately uncomments settings.

The template covers every current application-config key:

- `server.host` — default `localhost`;
- `server.port` — runtime default `3000`;
- `server.dev_mode` — default `false` and frontend-serving effect;
- `server.tls.enabled` — default `false`;
- `server.tls.cert_path` and `server.tls.key_path` — optional and required as a pair;
- `vault.root` — default `./vault` and resolution relative to the config file.

The prose also identifies `CLEPSYDRA__...` environment overrides and precedence: defaults, then config file, then environment, then applicable `serve` flags.

The template is a single static byte/string constant owned by the config-command module. This avoids runtime assembly and keeps docs/tests anchored to one generated artifact.

### Failure behavior

Creation continues to:

- select `$XDG_CONFIG_HOME/clepsydra/config.toml`, falling back to `$HOME/.config/clepsydra/config.toml` when XDG is unset;
- create missing parent directories;
- use exclusive creation and refuse to overwrite an existing file.

After exclusive creation, the template is written with `write_all`. If writing fails, Clepsydra makes a best-effort removal of the newly created incomplete file and returns the existing path-bearing I/O error. It never removes a pre-existing file because exclusive creation must succeed before writing begins.

## CLI and API changes

- `ConfigCommands::Show` gains a boolean `--origin` flag.
- The byte-only config read result becomes a struct containing `path` and `contents`; the existing CLI caller and tests migrate in a clean cutover.
- `ConfigCommands::Create` syntax and success output remain unchanged.
- No new dependency is required; `anstream` and `owo-colors` already exist.

## Tests

Behavioral tests cover:

- parsing `clep config show --origin` and defaulting the flag off;
- returning the resolved path together with exact, potentially non-UTF-8 bytes;
- origin rendering with the exact `Origin: <path>\n` structure independently of terminal detection;
- the unchanged contents-only stdout contract;
- creation writing a non-empty template;
- all application-config sections and keys appearing commented in the template;
- parsing the template successfully as an empty TOML document;
- parent-directory creation and overwrite refusal remaining intact;
- an existing config remaining byte-for-byte unchanged after refused creation.

CLI and configuration documentation show `--origin`, explain stderr placement and color behavior, and replace the empty-config description with the literate-template contract.
