# Config Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `clep config show` for printing the application config selected by normal lookup and `clep config create` for exclusively creating an empty user config.

**Architecture:** A focused `config_command` library module owns config inspection and creation policy while reusing candidate ordering from `app_config`. The Clap binary declares the nested commands, dispatches to that module, and handles stdout only; module tests exercise filesystem and environment-dependent behavior without mutating the process environment.

**Tech Stack:** Rust 2024, Clap 4 derive, thiserror 2, standard-library filesystem APIs, Cargo test tooling.

## Global Constraints

- `show` uses lookup order `./config.toml`, `$XDG_CONFIG_HOME/clepsydra/config.toml`, `$HOME/.config/clepsydra/config.toml`.
- `show` writes the selected file bytes verbatim, without a path header or formatting.
- `create` targets `$XDG_CONFIG_HOME/clepsydra/config.toml`, falling back to `$HOME/.config/clepsydra/config.toml` only when `XDG_CONFIG_HOME` is unset.
- `create` creates a zero-byte file and missing parent directories but never overwrites an existing config.
- Neither command reads or writes vault-level `<vault>/.clepsydra/config.toml`.
- No new dependency is required.

---

### Task 1: Application Config File Operations

**Files:**
- Create: `src/config_command.rs`
- Modify: `src/lib.rs:1-8`
- Test: `src/config_command.rs` inline test module

**Interfaces:**
- Consumes: `crate::app_config::config_candidates_with_env(start_dir: &Path, xdg_config_home: Option<OsString>, home: Option<OsString>) -> Vec<PathBuf>`
- Produces: `pub fn read_existing(start_dir: &Path) -> Result<Vec<u8>, ConfigCommandError>`
- Produces: `pub fn create() -> Result<PathBuf, ConfigCommandError>`
- Produces: `pub enum ConfigCommandError`, implementing `std::error::Error` with path-bearing messages

- [ ] **Step 1: Add failing lookup and byte-preservation tests**

Create `src/config_command.rs` with imports, test-only calls to not-yet-written helpers, and these tests:

```rust
use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use thiserror::Error;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_prefers_local_config_and_preserves_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        let xdg_file = xdg.path().join("clepsydra/config.toml");
        fs::create_dir_all(xdg_file.parent().unwrap()).unwrap();
        fs::write(&xdg_file, b"xdg = true\n").unwrap();
        fs::write(dir.path().join("config.toml"), b"local = true").unwrap();

        let bytes = read_existing_with_env(
            dir.path(),
            Some(xdg.path().as_os_str().to_owned()),
            None,
        )
        .unwrap();

        assert_eq!(bytes, b"local = true");
    }

    #[test]
    fn read_uses_xdg_before_home_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let xdg_file = xdg.path().join("clepsydra/config.toml");
        let home_file = home.path().join(".config/clepsydra/config.toml");
        fs::create_dir_all(xdg_file.parent().unwrap()).unwrap();
        fs::create_dir_all(home_file.parent().unwrap()).unwrap();
        fs::write(&xdg_file, b"source = 'xdg'").unwrap();
        fs::write(&home_file, b"source = 'home'").unwrap();

        let bytes = read_existing_with_env(
            dir.path(),
            Some(xdg.path().as_os_str().to_owned()),
            Some(home.path().as_os_str().to_owned()),
        )
        .unwrap();

        assert_eq!(bytes, b"source = 'xdg'");
    }

    #[test]
    fn read_error_lists_all_candidates() {
        let dir = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();

        let error = read_existing_with_env(
            dir.path(),
            Some(xdg.path().as_os_str().to_owned()),
            None,
        )
        .unwrap_err();
        let message = error.to_string();

        assert!(message.contains(&dir.path().join("config.toml").display().to_string()));
        assert!(message.contains(
            &xdg.path()
                .join("clepsydra/config.toml")
                .display()
                .to_string()
        ));
    }
}
```

- [ ] **Step 2: Run the new tests and verify RED**

Run: `cargo test --lib config_command::tests::read -- --nocapture`

Expected: compilation fails because `read_existing_with_env` is not defined.

- [ ] **Step 3: Implement existing-config reads and errors**

Add the concrete error type and read functions above the test module:

```rust
#[derive(Debug, Error)]
pub enum ConfigCommandError {
    #[error("no config.toml found; searched:\n{searched}")]
    NotFound { searched: String },
    #[error("cannot determine user config directory: XDG_CONFIG_HOME and HOME are unset")]
    NoConfigHome,
    #[error("config already exists: {path}")]
    AlreadyExists { path: PathBuf },
    #[error("failed to {operation} {path}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

pub fn read_existing(start_dir: &Path) -> Result<Vec<u8>, ConfigCommandError> {
    read_existing_with_env(
        start_dir,
        env::var_os("XDG_CONFIG_HOME"),
        env::var_os("HOME"),
    )
}

fn read_existing_with_env(
    start_dir: &Path,
    xdg_config_home: Option<OsString>,
    home: Option<OsString>,
) -> Result<Vec<u8>, ConfigCommandError> {
    let candidates = crate::app_config::config_candidates_with_env(
        start_dir,
        xdg_config_home,
        home,
    );
    let Some(path) = candidates.iter().find(|path| path.is_file()) else {
        let searched = candidates
            .iter()
            .map(|path| format!("  {}", path.display()))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(ConfigCommandError::NotFound { searched });
    };

    fs::read(path).map_err(|source| ConfigCommandError::Io {
        operation: "read",
        path: path.clone(),
        source,
    })
}
```

Expose the module in `src/lib.rs`:

```rust
pub mod config_command;
```

- [ ] **Step 4: Run read tests and verify GREEN**

Run: `cargo test --lib config_command::tests::read -- --nocapture`

Expected: all three read tests pass.

- [ ] **Step 5: Add failing creation-policy tests**

Append these tests inside `config_command::tests`:

```rust
#[test]
fn create_targets_xdg_and_makes_missing_parents() {
    let xdg = tempfile::tempdir().unwrap();
    let root = xdg.path().join("nested");

    let path = create_with_env(Some(root.as_os_str().to_owned()), None).unwrap();

    assert_eq!(path, root.join("clepsydra/config.toml"));
    assert!(path.is_file());
    assert_eq!(fs::metadata(path).unwrap().len(), 0);
}

#[test]
fn create_falls_back_to_home_dot_config() {
    let home = tempfile::tempdir().unwrap();

    let path = create_with_env(None, Some(home.path().as_os_str().to_owned())).unwrap();

    assert_eq!(path, home.path().join(".config/clepsydra/config.toml"));
    assert_eq!(fs::metadata(path).unwrap().len(), 0);
}

#[test]
fn create_refuses_to_overwrite_existing_config() {
    let xdg = tempfile::tempdir().unwrap();
    let path = xdg.path().join("clepsydra/config.toml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"keep = true\n").unwrap();

    let error = create_with_env(Some(xdg.path().as_os_str().to_owned()), None).unwrap_err();

    assert!(matches!(error, ConfigCommandError::AlreadyExists { path: p } if p == path));
    assert_eq!(fs::read(path).unwrap(), b"keep = true\n");
}

#[test]
fn create_requires_xdg_or_home() {
    let error = create_with_env(None, None).unwrap_err();
    assert!(matches!(error, ConfigCommandError::NoConfigHome));
}
```

- [ ] **Step 6: Run creation tests and verify RED**

Run: `cargo test --lib config_command::tests::create -- --nocapture`

Expected: compilation fails because `create_with_env` is not defined.

- [ ] **Step 7: Implement exclusive empty config creation**

Add these functions above the test module:

```rust
pub fn create() -> Result<PathBuf, ConfigCommandError> {
    create_with_env(
        env::var_os("XDG_CONFIG_HOME"),
        env::var_os("HOME"),
    )
}

fn create_with_env(
    xdg_config_home: Option<OsString>,
    home: Option<OsString>,
) -> Result<PathBuf, ConfigCommandError> {
    let path = match xdg_config_home {
        Some(root) => PathBuf::from(root).join("clepsydra/config.toml"),
        None => PathBuf::from(home.ok_or(ConfigCommandError::NoConfigHome)?)
            .join(".config/clepsydra/config.toml"),
    };
    let parent = path.parent().expect("config path always has a parent");
    fs::create_dir_all(parent).map_err(|source| ConfigCommandError::Io {
        operation: "create directory for",
        path: parent.to_path_buf(),
        source,
    })?;

    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(_) => Ok(path),
        Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {
            Err(ConfigCommandError::AlreadyExists { path })
        }
        Err(source) => Err(ConfigCommandError::Io {
            operation: "create",
            path,
            source,
        }),
    }
}
```

- [ ] **Step 8: Run the focused module tests**

Run: `cargo test --lib config_command::tests -- --nocapture`

Expected: all seven config-command tests pass.

- [ ] **Step 9: Commit the config operations**

```bash
git add src/config_command.rs src/lib.rs
git commit -m "feat: add application config file operations"
```

---

### Task 2: Nested CLI Commands and Documentation

**Files:**
- Modify: `src/bin/cli.rs:1-174,176-220,355-578`
- Modify: `docs/cli.md:13-24,43-71,134-158`
- Modify: `docs/configuration.md:10-37`
- Test: `src/bin/cli.rs` inline `cli_tests` module

**Interfaces:**
- Consumes: `clepsydra::config_command::read_existing(&Path) -> Result<Vec<u8>, ConfigCommandError>`
- Consumes: `clepsydra::config_command::create() -> Result<PathBuf, ConfigCommandError>`
- Produces: Clap syntax `clep config show` and `clep config create`

- [ ] **Step 1: Add failing nested-command parser tests**

Add these tests to `cli_tests`:

```rust
#[test]
fn config_show_parses() {
    let cli = Cli::try_parse_from(["clep", "config", "show"]).unwrap();
    assert!(matches!(
        cli.command,
        Commands::Config {
            command: ConfigCommands::Show
        }
    ));
}

#[test]
fn config_create_parses() {
    let cli = Cli::try_parse_from(["clep", "config", "create"]).unwrap();
    assert!(matches!(
        cli.command,
        Commands::Config {
            command: ConfigCommands::Create
        }
    ));
}

#[test]
fn config_requires_a_subcommand() {
    assert!(Cli::try_parse_from(["clep", "config"]).is_err());
}
```

- [ ] **Step 2: Run parser tests and verify RED**

Run: `cargo test --bin clep cli_tests::config -- --nocapture`

Expected: compilation fails because `Commands::Config` and `ConfigCommands` do not exist.

- [ ] **Step 3: Declare the nested Clap command group**

Add this enum near `Commands`:

```rust
#[derive(Debug, Subcommand)]
enum ConfigCommands {
    #[command(about = "Print the application config selected by normal lookup")]
    Show,
    #[command(about = "Create an empty user application config")]
    Create,
}
```

Add this variant to `Commands` after `New`:

```rust
#[command(
    about = "Inspect or create application config",
    long_about = "Inspect the application config selected by Clepsydra or create an empty user config. This command does not operate on vault-level .clepsydra/config.toml files."
)]
Config {
    #[command(subcommand)]
    command: ConfigCommands,
},
```

Update the top-level `after_help` examples to include:

```text
  clepsydra config show
  clepsydra config create
```

- [ ] **Step 4: Dispatch both commands with byte-safe stdout**

Import `std::io::Write` alongside `PathBuf`, then add this match arm after `Commands::New`:

```rust
Commands::Config { command } => match command {
    ConfigCommands::Show => {
        let cwd = std::env::current_dir()?;
        let contents = clepsydra::config_command::read_existing(&cwd)?;
        std::io::stdout().lock().write_all(&contents)?;
        Ok(0)
    }
    ConfigCommands::Create => {
        let path = clepsydra::config_command::create()?;
        println!("Created config at {}", path.display());
        Ok(0)
    }
},
```

- [ ] **Step 5: Run parser and existing CLI unit tests**

Run: `cargo test --bin clep -- --nocapture`

Expected: all CLI unit tests pass.

- [ ] **Step 6: Document the new commands**

Update `docs/cli.md`:

- Add implemented rows for `clepsydra config show` and `clepsydra config create` to the command table.
- Add a `## config` section with exact lookup order, contents-only stdout behavior, XDG/HOME creation destination, parent-directory creation, empty-file behavior, and refusal to overwrite.
- Update the typical workflow to use `clepsydra config create` before editing `[vault].root`.
- Correct the stale statement that `doctor` is unimplemented; leave only `env` described that way.

Update `docs/configuration.md` after the application-config lookup order:

````markdown
### Inspecting and creating the file

```bash
clepsydra config show
clepsydra config create
```

`config show` prints the first existing file from the lookup order verbatim.
`config create` creates an empty user config at
`$XDG_CONFIG_HOME/clepsydra/config.toml`, or
`$HOME/.config/clepsydra/config.toml` when `XDG_CONFIG_HOME` is unset. It
creates missing parent directories and refuses to overwrite an existing file.
````

- [ ] **Step 7: Smoke-test both commands with an isolated environment**

Build the binary:

```bash
cargo build --bin clep
```

In a temporary directory with a separate empty working directory and config root:

```bash
XDG_CONFIG_HOME="$tmp/config" HOME="$tmp/home" target/debug/clep config create
XDG_CONFIG_HOME="$tmp/config" HOME="$tmp/home" target/debug/clep config show
```

Expected:

- `create` prints `Created config at <tmp>/config/clepsydra/config.toml`.
- The created file exists and has size 0.
- `show` exits 0 and prints zero bytes.
- A second `create` exits 1, reports `config already exists`, and leaves the file unchanged.

Then write `[vault]\nroot = "/tmp/example"\n` into the isolated XDG config and rerun `config show`.

Expected: stdout matches those bytes exactly.

- [ ] **Step 8: Commit CLI and documentation**

```bash
git add src/bin/cli.rs docs/cli.md docs/configuration.md
git commit -m "feat: add config show and create commands"
```

---

### Task 3: Verification Gates

**Files:**
- No source changes expected; fix only failures caused by Tasks 1-2.

**Interfaces:**
- Consumes: completed `clep config show` and `clep config create` implementation
- Produces: verification evidence for the complete feature

- [ ] **Step 1: Run typecheck**

Run: `cargo check --all-targets --all-features`

Expected: exit 0.

- [ ] **Step 2: Run lint**

Run: `cargo clippy --all-targets --all-features -- -D warnings`

Expected: exit 0 with no warnings.

- [ ] **Step 3: Run the full test suite**

Run: `cargo test --all-targets --all-features`

Expected: exit 0 with all tests passing.

- [ ] **Step 4: Review affected artifacts**

Confirm the implementation changes only application config behavior; vault initialization and `.clepsydra/config.toml` remain untouched. Confirm CLI help exposes both nested commands and documentation matches observed smoke-test behavior.

- [ ] **Step 5: Commit any verification fixes**

If a gate required a source change, stage only the files changed for that fix and commit with a message naming the corrected failure. If all gates passed without changes, do not create an empty commit.
