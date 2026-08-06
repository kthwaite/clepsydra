# Config Origin, Path Trace, and Literate Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add colored config-origin metadata, a scriptable config-path resolver with ordered trace output, and a fully commented generated application config.

**Architecture:** `config_command` exposes one resolution model containing the selected path and candidates actually considered. Config reads build on that resolution, renderers own styled origin/trace text, and the CLI chooses stdout versus auto-color stderr. Config creation writes one static comment-only TOML template through the existing exclusive-create boundary.

**Tech Stack:** Rust 2024, Clap 4 derive, anstream 1, owo-colors 4, TOML 0.8, standard-library filesystem APIs.

## Global Constraints

- Bare `clep config show` continues to write only exact config bytes to stdout.
- `clep config show --origin` writes `Origin: <path>\n` to stderr before unchanged config bytes on stdout.
- Bare `clep config path` writes only `<resolved path>\n` to stdout.
- `clep config path --trace` keeps path-only stdout and writes only actually considered candidates to stderr, in order, ending at the selected file.
- Origin and selected trace entries use Clepsydra orange `(0xee, 0x77, 0x33)`; unselected trace entries are dimmed; `anstream` handles TTY and color environment behavior.
- Each command resolves once; selected path, considered paths, and read bytes cannot drift.
- `clep config create` writes a non-empty template in which every TOML section and assignment is commented out.
- The template covers every current application setting and parses as an empty TOML document.
- Existing configs are never overwritten; a failed template write removes only the newly created incomplete file on a best-effort basis.
- No new dependency is added.

---

### Task 1: Shared Resolution Model and Colored Renderers

**Files:**
- Modify: `src/config_command.rs:1-231`
- Test: `src/config_command.rs` inline test module

**Interfaces:**
- Consumes: `crate::app_config::config_candidates_with_env(...) -> Vec<PathBuf>`
- Consumes: `crate::VESSEL_ACCENT: (u8, u8, u8)`
- Produces: `pub struct ConfigResolution { pub path: PathBuf, pub considered: Vec<PathBuf> }`
- Produces: `pub struct ExistingConfig { pub resolution: ConfigResolution, pub contents: Vec<u8> }`
- Produces: `pub fn resolve_existing(start_dir: &Path) -> Result<ConfigResolution, ConfigCommandError>`
- Changes: `pub fn read_existing(start_dir: &Path) -> Result<ExistingConfig, ConfigCommandError>`
- Produces: `pub fn render_origin(path: &Path, writer: &mut impl Write) -> io::Result<()>`
- Produces: `pub fn render_trace(resolution: &ConfigResolution, writer: &mut impl Write) -> io::Result<()>`

- [ ] **Step 1: Find every exported read callsite**

Use LSP references on `read_existing` at `src/config_command.rs:26` before changing its return type. Record every production caller requiring migration; the expected production caller is the config-show dispatch in `src/bin/cli.rs`.

- [ ] **Step 2: Add failing resolution tests**

Add test helpers and these cases while updating existing read assertions to use `.contents`:

```rust
fn path(value: &Path) -> PathBuf {
    value.to_path_buf()
}

#[test]
fn resolution_stops_at_local_config() {
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("config.toml");
    fs::write(&local, b"local").unwrap();

    let resolution = resolve_existing_with_env(
        dir.path(),
        Some(OsString::from("/unused/xdg")),
        Some(OsString::from("/unused/home")),
    )
    .unwrap();

    assert_eq!(resolution.path, local);
    assert_eq!(resolution.considered, vec![path(&local)]);
}

#[test]
fn resolution_stops_at_xdg_after_local() {
    let dir = tempfile::tempdir().unwrap();
    let xdg = tempfile::tempdir().unwrap();
    let local = dir.path().join("config.toml");
    let selected = xdg.path().join("clepsydra/config.toml");
    fs::create_dir_all(selected.parent().unwrap()).unwrap();
    fs::write(&selected, b"xdg").unwrap();

    let resolution = resolve_existing_with_env(
        dir.path(),
        Some(xdg.path().as_os_str().to_owned()),
        Some(OsString::from("/unused/home")),
    )
    .unwrap();

    assert_eq!(resolution.path, selected);
    assert_eq!(resolution.considered, vec![local, selected]);
}

#[test]
fn resolution_reaches_home_after_missing_local_and_xdg() {
    let dir = tempfile::tempdir().unwrap();
    let xdg = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let local = dir.path().join("config.toml");
    let xdg_path = xdg.path().join("clepsydra/config.toml");
    let selected = home.path().join(".config/clepsydra/config.toml");
    fs::create_dir_all(selected.parent().unwrap()).unwrap();
    fs::write(&selected, b"home").unwrap();

    let resolution = resolve_existing_with_env(
        dir.path(),
        Some(xdg.path().as_os_str().to_owned()),
        Some(home.path().as_os_str().to_owned()),
    )
    .unwrap();

    assert_eq!(resolution.path, selected);
    assert_eq!(resolution.considered, vec![local, xdg_path, selected]);
}

#[test]
fn read_returns_same_resolution_and_exact_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("config.toml");
    fs::write(&local, b"\xff\xfe\x00local").unwrap();

    let config = read_existing_with_env(dir.path(), None, None).unwrap();

    assert_eq!(config.resolution.path, local);
    assert_eq!(config.resolution.considered, vec![local]);
    assert_eq!(config.contents, b"\xff\xfe\x00local");
}
```

- [ ] **Step 3: Run resolution tests and verify RED**

Run: `cargo test --lib config_command::tests::resolution -- --nocapture`

Expected: compilation fails because `ConfigResolution` and `resolve_existing_with_env` do not exist.

- [ ] **Step 4: Implement shared resolution and migrate reads**

Change imports and add the models:

```rust
use std::io::{self, Write};

use owo_colors::OwoColorize;
use thiserror::Error;

use crate::VESSEL_ACCENT as ACCENT;

#[derive(Debug, PartialEq, Eq)]
pub struct ConfigResolution {
    pub path: PathBuf,
    pub considered: Vec<PathBuf>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ExistingConfig {
    pub resolution: ConfigResolution,
    pub contents: Vec<u8>,
}
```

Implement public and environment-injected resolution:

```rust
pub fn resolve_existing(start_dir: &Path) -> Result<ConfigResolution, ConfigCommandError> {
    resolve_existing_with_env(
        start_dir,
        env::var_os("XDG_CONFIG_HOME"),
        env::var_os("HOME"),
    )
}

fn resolve_existing_with_env(
    start_dir: &Path,
    xdg_config_home: Option<OsString>,
    home: Option<OsString>,
) -> Result<ConfigResolution, ConfigCommandError> {
    let mut considered =
        crate::app_config::config_candidates_with_env(start_dir, xdg_config_home, home);
    let Some(selected_index) = considered.iter().position(|path| path.is_file()) else {
        let searched = considered
            .iter()
            .map(|path| format!("  {}", path.display()))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(ConfigCommandError::NotFound { searched });
    };

    considered.truncate(selected_index + 1);
    Ok(ConfigResolution {
        path: considered[selected_index].clone(),
        considered,
    })
}
```

Build reads on that exact result:

```rust
pub fn read_existing(start_dir: &Path) -> Result<ExistingConfig, ConfigCommandError> {
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
) -> Result<ExistingConfig, ConfigCommandError> {
    let resolution = resolve_existing_with_env(start_dir, xdg_config_home, home)?;
    let contents = fs::read(&resolution.path).map_err(|source| ConfigCommandError::Io {
        operation: "read",
        path: resolution.path.clone(),
        source,
    })?;
    Ok(ExistingConfig {
        resolution,
        contents,
    })
}
```

- [ ] **Step 5: Add failing renderer tests**

```rust
#[test]
fn origin_renderer_colors_selected_path_and_strips_cleanly() {
    let selected = Path::new("/tmp/clepsydra/config.toml");
    let mut styled = Vec::new();
    render_origin(selected, &mut styled).unwrap();
    let styled = String::from_utf8(styled).unwrap();
    assert!(styled.contains("\u{1b}[38;2;238;119;51m"));

    let mut plain = Vec::new();
    {
        let mut stream = anstream::AutoStream::new(&mut plain, anstream::ColorChoice::Never);
        render_origin(selected, &mut stream).unwrap();
    }
    assert_eq!(plain, b"Origin: /tmp/clepsydra/config.toml\n");
}

#[test]
fn trace_renderer_lists_considered_paths_in_order_and_highlights_selected() {
    let resolution = ConfigResolution {
        path: PathBuf::from("/xdg/clepsydra/config.toml"),
        considered: vec![
            PathBuf::from("/cwd/config.toml"),
            PathBuf::from("/xdg/clepsydra/config.toml"),
        ],
    };
    let mut plain = Vec::new();
    {
        let mut stream = anstream::AutoStream::new(&mut plain, anstream::ColorChoice::Never);
        render_trace(&resolution, &mut stream).unwrap();
    }

    assert_eq!(
        plain,
        b"  /cwd/config.toml\n\xe2\x86\x92 /xdg/clepsydra/config.toml\n"
    );
}
```

- [ ] **Step 6: Run renderer tests and verify RED**

Run:

```bash
cargo test --lib config_command::tests::origin_renderer -- --nocapture
cargo test --lib config_command::tests::trace_renderer -- --nocapture
```

Expected: compilation fails because both renderers are missing.

- [ ] **Step 7: Implement origin and trace renderers**

```rust
pub fn render_origin(path: &Path, writer: &mut impl Write) -> io::Result<()> {
    writeln!(
        writer,
        "Origin: {}",
        path.display().truecolor(ACCENT.0, ACCENT.1, ACCENT.2)
    )
}

pub fn render_trace(
    resolution: &ConfigResolution,
    writer: &mut impl Write,
) -> io::Result<()> {
    for candidate in &resolution.considered {
        if candidate == &resolution.path {
            writeln!(
                writer,
                "→ {}",
                candidate.display().truecolor(ACCENT.0, ACCENT.1, ACCENT.2)
            )?;
        } else {
            writeln!(writer, "  {}", candidate.display().dimmed())?;
        }
    }
    Ok(())
}
```

- [ ] **Step 8: Run complete resolution/renderer tests**

Run: `cargo test --lib config_command::tests -- --nocapture`

Expected: all current config-command tests plus new resolution and renderer tests pass.

- [ ] **Step 9: Commit shared resolution and rendering**

```bash
git add src/config_command.rs
git commit -m "feat: expose config resolution trace"
```

---

### Task 2: Literate Config Creation

**Files:**
- Modify: `src/config_command.rs`
- Test: `src/config_command.rs` inline test module

**Interfaces:**
- Preserves: `pub fn create() -> Result<PathBuf, ConfigCommandError>`
- Produces internally: `const LITERATE_CONFIG_TEMPLATE: &str`

- [ ] **Step 1: Add failing template tests**

Replace zero-byte assertions in creation tests and add:

```rust
#[test]
fn create_writes_literate_comment_only_template() {
    let xdg = tempfile::tempdir().unwrap();
    let path = create_with_env(Some(xdg.path().as_os_str().to_owned()), None).unwrap();
    let contents = fs::read_to_string(path).unwrap();

    assert!(!contents.is_empty());
    for expected in [
        "# [server]",
        "# host = \"localhost\"",
        "# port = 3000",
        "# dev_mode = false",
        "# [server.tls]",
        "# enabled = false",
        "# cert_path = \"certs/localhost.pem\"",
        "# key_path = \"certs/localhost-key.pem\"",
        "# [vault]",
        "# root = \"./vault\"",
    ] {
        assert!(contents.contains(expected), "missing template line: {expected}");
    }

    let parsed = contents.parse::<toml::Table>().unwrap();
    assert!(parsed.is_empty());
}

#[test]
fn template_documents_precedence_and_tls_pairing() {
    let xdg = tempfile::tempdir().unwrap();
    let path = create_with_env(Some(xdg.path().as_os_str().to_owned()), None).unwrap();
    let contents = fs::read_to_string(path).unwrap();

    assert!(contents.contains("CLEPSYDRA__SERVER__HOST"));
    assert!(contents.contains("defaults → config file → environment → serve flags"));
    assert!(contents.contains("cert_path and key_path must be set together"));
    assert!(contents.contains("relative to this config file"));
}
```

Update XDG and HOME creation tests to compare the created bytes against `LITERATE_CONFIG_TEMPLATE.as_bytes()`. Preserve the existing overwrite-refusal test and its byte-for-byte assertion.

- [ ] **Step 2: Run template tests and verify RED**

Run:

```bash
cargo test --lib config_command::tests::create_writes_literate_comment_only_template -- --nocapture
cargo test --lib config_command::tests::template_documents_precedence_and_tls_pairing -- --nocapture
```

Expected: tests fail because created configs are empty.

- [ ] **Step 3: Add the complete static template**

```rust
const LITERATE_CONFIG_TEMPLATE: &str = r##"# Clepsydra application configuration
#
# Every setting below is commented out. Uncomment the sections and values you
# want to override; leaving them commented preserves Clepsydra's defaults.
#
# Precedence: defaults → config file → environment → serve flags.
# Environment keys use CLEPSYDRA__SECTION__KEY, for example:
# CLEPSYDRA__SERVER__HOST or CLEPSYDRA__VAULT__ROOT.

# [server]
# Bind host. Default: localhost.
# host = "localhost"
# Bind port. Default: 3000.
# port = 3000
# Disable the embedded frontend when true. Default: false.
# dev_mode = false

# [server.tls]
# Serve HTTPS when true. Default: false.
# enabled = false
# Optional certificate paths. cert_path and key_path must be set together.
# If both are omitted, TLS uses an automatically provisioned localhost cert.
# cert_path = "certs/localhost.pem"
# key_path = "certs/localhost-key.pem"

# [vault]
# Vault root. Relative paths resolve relative to this config file.
# Default: ./vault.
# root = "./vault"
"##;
```

- [ ] **Step 4: Write the template after exclusive creation**

Replace the successful open arm:

```rust
match OpenOptions::new().write(true).create_new(true).open(&path) {
    Ok(mut file) => {
        if let Err(source) = file.write_all(LITERATE_CONFIG_TEMPLATE.as_bytes()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(ConfigCommandError::Io {
                operation: "write",
                path,
                source,
            });
        }
        Ok(path)
    }
    Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {
        Err(ConfigCommandError::AlreadyExists { path })
    }
    Err(source) => Err(ConfigCommandError::Io {
        operation: "create",
        path,
        source,
    }),
}
```

- [ ] **Step 5: Run complete config-command tests**

Run: `cargo test --lib config_command::tests -- --nocapture`

Expected: all resolution, rendering, creation, TOML parsing, HOME fallback, and overwrite-refusal tests pass.

- [ ] **Step 6: Commit literate creation**

```bash
git add src/config_command.rs
git commit -m "feat: create literate config template"
```

---

### Task 3: CLI Commands, Stream Routing, and Documentation

**Files:**
- Modify: `src/bin/cli.rs:1-70,211-223,439-464`
- Modify: `docs/cli.md:73-99`
- Modify: `docs/configuration.md:20-48`
- Test: `src/bin/cli.rs` inline `cli_tests` module

**Interfaces:**
- Consumes: `config_command::resolve_existing(&Path) -> Result<ConfigResolution, ConfigCommandError>`
- Consumes: `config_command::read_existing(&Path) -> Result<ExistingConfig, ConfigCommandError>`
- Consumes: `config_command::{render_origin, render_trace}`
- Produces: `clep config show [--origin]`
- Produces: `clep config path [--trace]`

- [ ] **Step 1: Add failing parser tests**

Replace `config_show_parses` and add path parsing:

```rust
fn config_show_origin(args: &[&str]) -> bool {
    let cli = Cli::try_parse_from(args).unwrap();
    match cli.command {
        Commands::Config {
            command: ConfigCommands::Show { origin },
        } => origin,
        other => panic!("expected config show, got {other:?}"),
    }
}

fn config_path_trace(args: &[&str]) -> bool {
    let cli = Cli::try_parse_from(args).unwrap();
    match cli.command {
        Commands::Config {
            command: ConfigCommands::Path { trace },
        } => trace,
        other => panic!("expected config path, got {other:?}"),
    }
}

#[test]
fn config_show_defaults_origin_off() {
    assert!(!config_show_origin(&["clep", "config", "show"]));
}

#[test]
fn config_show_accepts_origin() {
    assert!(config_show_origin(&["clep", "config", "show", "--origin"]));
}

#[test]
fn config_path_defaults_trace_off() {
    assert!(!config_path_trace(&["clep", "config", "path"]));
}

#[test]
fn config_path_accepts_trace() {
    assert!(config_path_trace(&["clep", "config", "path", "--trace"]));
}
```

- [ ] **Step 2: Run parser tests and verify RED**

Run: `cargo test --bin clep cli_tests::config_ -- --nocapture`

Expected: compilation fails because `Show` is a unit variant and `Path` does not exist.

- [ ] **Step 3: Declare both option-bearing commands**

```rust
#[derive(Debug, Subcommand)]
enum ConfigCommands {
    #[command(about = "Print the application config selected by normal lookup")]
    Show {
        #[arg(long, help = "Print the selected config path to stderr")]
        origin: bool,
    },
    #[command(about = "Print the selected application config path")]
    Path {
        #[arg(long, help = "Trace considered config paths to stderr")]
        trace: bool,
    },
    #[command(about = "Create a commented application config template")]
    Create,
}
```

- [ ] **Step 4: Dispatch with stable stdout and auto-color stderr**

```rust
Commands::Config { command } => match command {
    ConfigCommands::Show { origin } => {
        let cwd = std::env::current_dir()?;
        let config = clepsydra::config_command::read_existing(&cwd)?;
        if origin {
            let mut stderr = anstream::AutoStream::auto(std::io::stderr().lock());
            clepsydra::config_command::render_origin(
                &config.resolution.path,
                &mut stderr,
            )?;
        }
        std::io::stdout().lock().write_all(&config.contents)?;
        Ok(0)
    }
    ConfigCommands::Path { trace } => {
        let cwd = std::env::current_dir()?;
        let resolution = clepsydra::config_command::resolve_existing(&cwd)?;
        if trace {
            let mut stderr = anstream::AutoStream::auto(std::io::stderr().lock());
            clepsydra::config_command::render_trace(&resolution, &mut stderr)?;
        }
        println!("{}", resolution.path.display());
        Ok(0)
    }
    ConfigCommands::Create => {
        let path = clepsydra::config_command::create()?;
        println!("Created config at {}", path.display());
        Ok(0)
    }
},
```

- [ ] **Step 5: Run all CLI unit tests**

Run: `cargo test --bin clep -- --nocapture`

Expected: all CLI tests pass, including default/enabled states for both flags and existing config-create parsing.

- [ ] **Step 6: Update CLI and configuration documentation**

Update `docs/cli.md` examples:

```bash
clepsydra config show
clepsydra config show --origin
clepsydra config path
clepsydra config path --trace
clepsydra config create
```

Document exact stdout/stderr contracts, ordered considered-path trace semantics, colors and no-color behavior, and that resolution stops at the selected file. Replace empty-file language with the fully commented template and list its sections.

Update `docs/configuration.md` similarly. Keep its compact active config example and explain that `config create` generates the commented equivalent with descriptions and defaults.

- [ ] **Step 7: Build and smoke-test all user-visible contracts**

Build: `cargo build --bin clep`

Use an isolated CWD, XDG root, and HOME. Seed an existing HOME config, leaving local/XDG absent, then exercise all commands with stdout/stderr captured separately.

Expected:

- `config path` stdout is exactly `<home config path>\n`, stderr empty;
- `config path --trace` has the same stdout; ANSI-stripped stderr lists local, XDG, then selected HOME exactly once and in order;
- `NO_COLOR=1 config path --trace` emits no escape byte;
- `config show --origin` stdout equals HOME config bytes exactly and stripped stderr is exactly `Origin: <home config path>\n`;
- bare `config show` emits exact config bytes and zero stderr bytes;
- after removing the HOME file, `config create` writes a non-empty comment-only template to XDG;
- the template parses as an empty TOML table and every example section/assignment remains commented;
- a second `create` exits 1 and preserves the template byte-for-byte.

- [ ] **Step 8: Commit CLI and docs**

```bash
git add src/bin/cli.rs docs/cli.md docs/configuration.md
git commit -m "feat: add config path and origin output"
```

---

### Task 4: Verification Gates

**Files:**
- No source changes expected; fix only failures caused by Tasks 1-3.

**Interfaces:**
- Consumes: completed origin, path trace, and literate-template behavior
- Produces: final verification evidence

- [ ] **Step 1: Run typecheck**

Run: `cargo check --all-targets --all-features`

Expected: exit 0.

- [ ] **Step 2: Run lint**

Run: `cargo clippy --all-targets --all-features -- -D warnings`

Expected: exit 0 with no warnings.

- [ ] **Step 3: Run full tests**

Run: `cargo test --all-targets --all-features`

Expected: exit 0 with all tests passing.

- [ ] **Step 4: Confirm help and final behavior**

Run `target/debug/clep config show --help` and `target/debug/clep config path --help`; confirm `--origin` and `--trace` are documented. Repeat the isolated smoke scenario on the final tree, including ordered stopping behavior for local and XDG selections so lower-precedence paths never appear.

- [ ] **Step 5: Commit verification fixes if needed**

If a gate required a source change, stage only the files changed for that fix and commit with a message naming the corrected failure. If every gate passed without changes, do not create an empty commit.
