# Config Command Design

## Goal

Add a `clep config` command group for inspecting the application config selected by Clepsydra and creating an empty user-level application config.

## Command contract

### `clep config show`

- Use the existing application-config lookup order:
  1. `./config.toml`
  2. `$XDG_CONFIG_HOME/clepsydra/config.toml`
  3. `$HOME/.config/clepsydra/config.toml`
- Read the first existing candidate.
- Write the file bytes verbatim to stdout, with no path header or formatting.
- If no candidate exists, return an error that identifies the searched locations.

This command exposes the config file Clepsydra would load. It does not merge defaults, environment overrides, or CLI overrides into an effective-config rendering.

### `clep config create`

- Target `$XDG_CONFIG_HOME/clepsydra/config.toml` when `XDG_CONFIG_HOME` is set.
- Otherwise target `$HOME/.config/clepsydra/config.toml`, following the XDG Base Directory default.
- Return an error if neither environment variable is available.
- Create missing parent directories.
- Create a zero-byte file without overwriting an existing file.
- Print the created path on success.

The command creates application config only. It does not create or modify a vault-level `<vault>/.clepsydra/config.toml`.

## Architecture

Add a focused library module for user-facing application-config operations. It will reuse the candidate ordering in `app_config` rather than duplicate lookup policy. The module owns:

- reading the resolved config bytes for `show`;
- selecting the user config destination for `create`;
- parent-directory creation and exclusive file creation;
- precise errors for missing config, missing environment roots, and an existing destination.

`src/bin/cli.rs` remains responsible for Clap declarations, writing command output, and converting operation errors into the CLI's existing error path.

## Data flow

For `show`:

1. CLI obtains the current directory.
2. The config command module asks `app_config` for the selected existing path.
3. The module reads and returns the file bytes.
4. CLI writes those bytes directly to stdout.

For `create`:

1. The config command module reads `XDG_CONFIG_HOME` and `HOME`.
2. It computes the user config path.
3. It creates the `clepsydra` parent directory when absent.
4. It exclusively creates the empty `config.toml`.
5. CLI prints the resulting path.

## Error behavior

- `show` reports that no config exists and includes the candidates checked.
- `create` reports that no user config directory can be determined when both `XDG_CONFIG_HOME` and `HOME` are unavailable.
- `create` refuses to truncate or replace an existing config.
- Filesystem errors retain the affected path and source error.

All failures use the existing non-zero CLI error path.

## Tests

Behavioral tests will cover:

- parsing `clep config show` and `clep config create`;
- local config winning over user config for `show`;
- XDG config winning over the HOME fallback for `show`;
- byte-for-byte `show` reads;
- XDG target selection for `create`;
- `$HOME/.config` fallback when `XDG_CONFIG_HOME` is unset;
- recursive parent-directory creation;
- zero-byte output file creation;
- refusal to overwrite an existing file;
- errors when no config exists or no user config root can be determined.

CLI and configuration documentation will describe both commands and preserve the distinction between application and vault config.
