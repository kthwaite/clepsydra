use std::path::PathBuf;

use clap::{Parser, Subcommand};

use clepsydra::diagnostics::{self, DoctorOpts};
use clepsydra::run_server;
use clepsydra::vault::init::init_vault;
use clepsydra::vault::new_note::create_new_note;

#[derive(Debug, Parser)]
#[command(
    name = "clepsydra",
    version,
    about = "Clepsydra CLI",
    long_about = "CLI for managing Clepsydra vaults and running the API server.\n\nConfiguration lookup order (for commands that require config):\n  1) ./config.toml\n  2) $XDG_CONFIG_HOME/clepsydra/config.toml\n  3) $HOME/.config/clepsydra/config.toml",
    after_help = "Examples:\n  clepsydra init ~/vault\n  clepsydra serve\n  clepsydra new \"Project Plan\"\n  clepsydra new \"Inbox\" --body \"- [ ] follow up\""
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    #[command(
        about = "Initialize a new vault directory",
        long_about = "Initialize a vault at PATH by creating the core Clepsydra structure.\n\nCreated paths:\n  - .clepsydra/config.toml\n  - .clepsydra/templates/\n  - _attachments/\n\nFails if PATH/.clepsydra already exists."
    )]
    Init {
        #[arg(
            value_name = "PATH",
            default_value = ".",
            help = "Vault root path to initialize",
            long_help = "Vault root path to initialize. Defaults to the current directory.\n\nIf PATH does not exist, it will be created."
        )]
        path: PathBuf,
    },
    #[command(
        about = "Create a new note in the configured vault",
        long_about = "Create a markdown note with frontmatter metadata in the configured vault.\n\nVault resolution uses config lookup order:\n  1) ./config.toml\n  2) $XDG_CONFIG_HOME/clepsydra/config.toml\n  3) $HOME/.config/clepsydra/config.toml\n\nThe note filename is derived from TITLE. The destination folder honors `vault.default_page_folder` from the vault's .clepsydra/config.toml.",
        after_help = "Examples:\n  clepsydra new \"Daily Log\"\n  clepsydra new \"Reading List\" --body \"- [ ] Paper A\""
    )]
    New {
        #[arg(
            value_name = "TITLE",
            help = "Note title (stored in frontmatter and used for path generation)"
        )]
        title: String,
        #[arg(short, long, value_name = "TEXT", help = "Optional initial body text")]
        body: Option<String>,
    },
    #[command(
        about = "Show environment/config diagnostics",
        long_about = "Show effective environment/config diagnostics for Clepsydra.\n\nStatus: not implemented yet."
    )]
    Env,
    #[command(
        about = "Run health checks",
        long_about = "Run health checks for configuration, vault accessibility, and runtime dependencies.\n\nThe report groups checks by section (server config, server, vault, index, cas, runtime). Each check is OK / WARN / ERR / INFO / SKIP. Exit code is 0 unless any check fails (or any warning fires under --strict)."
    )]
    Doctor {
        /// Emit the report as JSON instead of human-readable text
        #[arg(long)]
        json: bool,
        /// Treat warnings as errors when computing the exit code
        #[arg(long)]
        strict: bool,
        /// Run expensive checks (e.g. CAS stats)
        #[arg(long)]
        full: bool,
    },
    #[command(
        about = "Start the API server",
        long_about = "Start the Clepsydra HTTP API server.\n\nRequires a config file discovered via:\n  1) ./config.toml\n  2) $XDG_CONFIG_HOME/clepsydra/config.toml\n  3) $HOME/.config/clepsydra/config.toml\n\nVault root is read from [vault].root."
    )]
    Serve {
        /// Start the LSP server on stdio alongside the HTTP server
        #[arg(long)]
        lsp: bool,
    },
    #[command(
        about = "Print version",
        long_about = "Print the clepsydra version string. Equivalent to `clepsydra --version`."
    )]
    Version,
}

/// Dispatch a parsed CLI invocation; returns the process exit code.
/// (Extracted from main so every arm except Serve is unit-testable.)
async fn run_cli(cli: Cli) -> Result<i32, Box<dyn std::error::Error>> {
    match cli.command {
        Commands::Init { path } => {
            init_vault(&path)?;
            println!("Initialized vault at {}", path.display());
            Ok(0)
        }
        Commands::New { title, body } => {
            let cwd = std::env::current_dir()?;
            let created = create_new_note(&cwd, &title, body.as_deref())?;
            println!(
                "Created note at {} (vault: {})",
                created.vault_path.as_str(),
                created.vault_root.display()
            );
            Ok(0)
        }
        Commands::Env => {
            println!("env command not implemented yet");
            Ok(0)
        }
        Commands::Doctor { json, strict, full } => {
            let report = diagnostics::run(DoctorOpts { full }).await;
            let mut stdout = std::io::stdout().lock();
            if json {
                report.render_json(&mut stdout)?;
            } else {
                report.render_human(&mut stdout)?;
            }
            Ok(report.exit_code(strict))
        }
        Commands::Serve { lsp } => {
            run_server(lsp).await?;
            Ok(0)
        }
        Commands::Version => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(0)
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let code = run_cli(Cli::parse()).await?;
    std::process::exit(code);
}

#[cfg(test)]
mod cli_tests {
    use clap::Parser;

    use super::*;

    /// Create a temp vault with a CWD-discoverable `config.toml` pointing at it.
    /// Returns the `TempDir` (keep it alive for the test's duration) and its root.
    /// The `config.toml` makes config-dependent commands (`new`, `doctor`)
    /// hermetic: they resolve `./config.toml` first, never an ambient
    /// `~/.config/clepsydra/config.toml` on the dev machine.
    fn vault_in_tempdir() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        init_vault(&root).unwrap();
        std::fs::write(
            root.join("config.toml"),
            format!("[vault]\nroot = \"{}\"\n", root.display()),
        )
        .unwrap();
        (dir, root)
    }

    /// Run `run_cli` with the process CWD temporarily set to `root`, restoring
    /// the original CWD before returning. All fallible setup happens before the
    /// CWD is changed, so the only code running under the mutated CWD is
    /// `run_cli` itself (Result-returning) — keeping the window panic-free.
    async fn run_cli_in(
        root: &std::path::Path,
        cli: Cli,
    ) -> Result<i32, Box<dyn std::error::Error>> {
        let orig = std::env::current_dir().unwrap();
        std::env::set_current_dir(root).unwrap();
        let result = run_cli(cli).await;
        std::env::set_current_dir(orig).unwrap();
        result
    }

    #[tokio::test]
    async fn version_returns_zero() {
        let cli = Cli::try_parse_from(["clepsydra", "version"]).unwrap();
        let code = run_cli(cli).await.unwrap();
        assert_eq!(code, 0);
    }

    #[tokio::test]
    async fn env_returns_zero() {
        let cli = Cli::try_parse_from(["clepsydra", "env"]).unwrap();
        let code = run_cli(cli).await.unwrap();
        assert_eq!(code, 0);
    }

    #[tokio::test]
    async fn init_creates_a_vault() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let cli = Cli::try_parse_from(["clepsydra", "init", root.to_str().unwrap()]).unwrap();
        let code = run_cli(cli).await.unwrap();
        assert_eq!(code, 0);
        assert!(root.join(".clepsydra").exists());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn new_creates_a_note() {
        let (_dir, root) = vault_in_tempdir();
        let cli = Cli::try_parse_from(["clepsydra", "new", "Test Note"]).unwrap();
        let result = run_cli_in(&root, cli).await;
        assert_eq!(result.unwrap(), 0);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn doctor_human_returns_ok() {
        let (_dir, root) = vault_in_tempdir();
        let cli = Cli::try_parse_from(["clepsydra", "doctor"]).unwrap();
        let result = run_cli_in(&root, cli).await;
        // Exit code reflects the vault's check results (env-dependent); we only
        // assert that dispatch + human rendering succeeded — a render error
        // would surface as Err via `?`.
        assert!(result.is_ok(), "doctor dispatch/render failed: {result:?}");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn doctor_json_returns_ok() {
        let (_dir, root) = vault_in_tempdir();
        let cli = Cli::try_parse_from(["clepsydra", "doctor", "--json"]).unwrap();
        let result = run_cli_in(&root, cli).await;
        // Covers the `if json` true branch; Err would indicate a JSON render
        // failure.
        assert!(
            result.is_ok(),
            "doctor --json dispatch/render failed: {result:?}"
        );
    }
}
