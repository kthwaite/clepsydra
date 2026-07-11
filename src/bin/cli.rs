use std::path::PathBuf;

use clap::{Parser, Subcommand};

use clepsydra::doctor::{self, DoctorOpts};
use clepsydra::vault::init::init_vault;
use clepsydra::vault::new_note::create_new_note;
use clepsydra::{open_vault_and_index, run_server};

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
        about = "Open a clepsydra:// or obsidian:// URL in the running server's UI",
        long_about = "Translate a deep-link URL into a local HTTP hit on the server's /deeplink endpoint and open it in the default browser.\n\nThis is the entry point the macOS URL-handler applet (see `register-url`) invokes; it can also be called directly.",
        after_help = "Examples:\n  clepsydra open-url \"clepsydra://page/Alpha%20Project\"\n  clepsydra open-url \"obsidian://open?vault=brain&file=Note\" --print"
    )]
    OpenUrl {
        #[arg(value_name = "URL", help = "The scheme URL to open")]
        url: String,
        #[arg(
            long,
            help = "Print the translated HTTP URL instead of opening the browser"
        )]
        print: bool,
    },
    /// Rename authored pages to the canonical `yyyymmdd.slug.shortid.md` scheme.
    #[command(about = "Relabel page filenames to the canonical identity scheme")]
    Relabel {
        /// Plan and print renames without touching the filesystem.
        #[arg(long)]
        dry_run: bool,
    },
    #[command(
        about = "Full-text search the vault index",
        long_about = "Search the vault's full-text index and print matches ranked by relevance.\n\nThe query is treated as a literal phrase by default; pass --raw to use FTS5 operator syntax (phrases, AND/OR, NEAR, prefix *).",
        after_help = "Examples:\n  clepsydra grep \"spaced repetition\"\n  clepsydra grep chloroplast --limit 5\n  clepsydra grep \"foo OR bar\" --raw"
    )]
    Grep {
        #[arg(value_name = "QUERY", help = "Text to search for")]
        query: String,
        #[arg(
            short = 'n',
            long,
            value_name = "N",
            default_value_t = 20,
            help = "Maximum number of results"
        )]
        limit: usize,
        #[arg(long, help = "Pass QUERY straight to FTS5 (enables operator syntax)")]
        raw: bool,
        #[arg(long, help = "Emit results as JSON instead of styled text")]
        json: bool,
    },
    #[command(
        about = "List the vault tree with per-note metadata",
        long_about = "Walk the vault directory and print a tree. Indexed notes are annotated with their kind, title, tags, and word count; other files show their size. Dotfiles and the .clepsydra directory are hidden."
    )]
    Tree {
        #[arg(long, help = "Emit the tree as JSON instead of styled text")]
        json: bool,
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
            let report = doctor::run(DoctorOpts { full }).await;
            if json {
                // Machine-readable output stays raw — never styled.
                report.render_json(&mut std::io::stdout().lock())?;
            } else {
                // AutoStream resolves colour from TTY detection plus
                // NO_COLOR/CLICOLOR/CLICOLOR_FORCE, stripping the ANSI codes
                // `render_human` emits whenever colour is unwanted.
                let mut stdout = anstream::AutoStream::auto(std::io::stdout().lock());
                report.render_human(&mut stdout)?;
            }
            Ok(report.exit_code(strict))
        }
        Commands::Serve { lsp } => {
            run_server(lsp).await?;
            Ok(0)
        }
        Commands::OpenUrl { url, print } => {
            let cwd = std::env::current_dir()?;
            let (settings, _config_path) = clepsydra::Settings::load(&cwd)?;
            let scheme = if settings.server.tls.enabled {
                "https"
            } else {
                "http"
            };
            let base = format!(
                "{scheme}://{}:{}",
                settings.server.host, settings.server.port
            );
            let target = clepsydra::deeplink::deeplink_http_url(&base, &url);
            if print || !cfg!(target_os = "macos") {
                println!("{target}");
            } else {
                std::process::Command::new("open").arg(&target).status()?;
            }
            Ok(0)
        }
        Commands::Relabel { dry_run } => {
            // Open vault + a fully-derived index (full deriver chain, links
            // resolved) via the same config path the server uses, so inbound
            // wikilinks get rewritten on rename.
            let (vault, mut index) = open_vault_and_index()?;
            let report = clepsydra::vault::relabel::relabel(&vault, &mut index, dry_run)?;
            println!(
                "relabel: {} renamed, {} skipped{}",
                report.renamed,
                report.skipped,
                if dry_run { " (dry run)" } else { "" }
            );
            Ok(0)
        }
        Commands::Grep {
            query,
            limit,
            raw,
            json,
        } => {
            let (_vault, index) = open_vault_and_index()?;
            let results = clepsydra::vault::grep::run(&index, &query, limit, raw)?;
            if json {
                clepsydra::vault::grep::render_json(&results, &mut std::io::stdout().lock())?;
            } else {
                let mut stdout = anstream::AutoStream::auto(std::io::stdout().lock());
                clepsydra::vault::grep::render_human(&results, &mut stdout)?;
            }
            Ok(0)
        }
        Commands::Tree { json } => {
            let (vault, index) = open_vault_and_index()?;
            let meta = clepsydra::vault::tree::load_note_meta(&index)?;
            let root = clepsydra::vault::tree::build(&vault, &meta);
            if json {
                clepsydra::vault::tree::render_json(&root, &mut std::io::stdout().lock())?;
            } else {
                let mut stdout = anstream::AutoStream::auto(std::io::stdout().lock());
                clepsydra::vault::tree::render_human(&root, &mut stdout)?;
            }
            Ok(0)
        }
        Commands::Version => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(0)
        }
    }
}

#[tokio::main]
async fn main() {
    // Display-print errors (real newlines, no quotes) instead of letting the
    // runtime Debug-print the returned `Err`, so multi-line hints stay readable.
    match run_cli(Cli::parse()).await {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("Error: {e}");
            std::process::exit(1);
        }
    }
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

    /// RAII guard that restores the process CWD on drop, including on panic
    /// unwind. The Drop is what makes serial tests robust against an async
    /// panic during `run_cli(..).await`.
    struct CwdGuard(Option<std::path::PathBuf>);

    impl CwdGuard {
        fn enter(new: &std::path::Path) -> Self {
            let orig = std::env::current_dir().ok();
            std::env::set_current_dir(new).expect("set_current_dir to test vault");
            Self(orig)
        }
    }

    impl Drop for CwdGuard {
        fn drop(&mut self) {
            if let Some(orig) = self.0.take() {
                let _ = std::env::set_current_dir(orig);
            }
        }
    }

    /// Run `run_cli` with the process CWD temporarily set to `root`. The CWD is
    /// restored via a Drop guard, so a panic during `run_cli(..).await` cannot
    /// leak a mutated CWD into the next serial test.
    async fn run_cli_in(
        root: &std::path::Path,
        cli: Cli,
    ) -> Result<i32, Box<dyn std::error::Error>> {
        let _guard = CwdGuard::enter(root);
        run_cli(cli).await
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
    async fn relabel_dry_run_returns_zero() {
        let (_dir, root) = vault_in_tempdir();
        // Seed one old-style (non-canonical) note so the index has something the
        // dry run would plan to relabel.
        std::fs::write(
            root.join("Relabel Me.md"),
            "---\nid: 0190f8a0-0000-7000-8000-0000000000c1\ntitle: Relabel Me\ncreated_at: 2026-05-31T12:00:00Z\n---\nbody\n",
        )
        .unwrap();
        let cli = Cli::try_parse_from(["clepsydra", "relabel", "--dry-run"]).unwrap();
        let result = run_cli_in(&root, cli).await;
        assert_eq!(result.unwrap(), 0);
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

    #[tokio::test]
    #[serial_test::serial]
    async fn grep_returns_zero() {
        let (_dir, root) = vault_in_tempdir();
        std::fs::write(
            root.join("Searchme.md"),
            "---\ntitle: Searchme\n---\nuniquetoken here\n",
        )
        .unwrap();
        let cli = Cli::try_parse_from(["clepsydra", "grep", "uniquetoken"]).unwrap();
        let result = run_cli_in(&root, cli).await;
        assert_eq!(result.unwrap(), 0);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn grep_json_returns_zero() {
        let (_dir, root) = vault_in_tempdir();
        let cli = Cli::try_parse_from(["clepsydra", "grep", "anything", "--json"]).unwrap();
        let result = run_cli_in(&root, cli).await;
        assert_eq!(result.unwrap(), 0);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn tree_returns_zero() {
        let (_dir, root) = vault_in_tempdir();
        std::fs::write(root.join("Note.md"), "---\ntitle: Note\n---\nbody\n").unwrap();
        let cli = Cli::try_parse_from(["clepsydra", "tree"]).unwrap();
        let result = run_cli_in(&root, cli).await;
        assert_eq!(result.unwrap(), 0);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn tree_json_returns_zero() {
        let (_dir, root) = vault_in_tempdir();
        let cli = Cli::try_parse_from(["clepsydra", "tree", "--json"]).unwrap();
        let result = run_cli_in(&root, cli).await;
        assert_eq!(result.unwrap(), 0);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn open_url_print_returns_zero() {
        let (_dir, root) = vault_in_tempdir();
        let cli = Cli::try_parse_from([
            "clepsydra",
            "open-url",
            "clepsydra://page/whatever",
            "--print",
        ])
        .unwrap();
        let result = run_cli_in(&root, cli).await;
        assert_eq!(result.unwrap(), 0);
    }

    #[tokio::test]
    async fn open_url_requires_a_url_argument() {
        assert!(Cli::try_parse_from(["clepsydra", "open-url"]).is_err());
    }
}
