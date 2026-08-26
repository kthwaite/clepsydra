use std::{
    future::Future,
    io::{Read, Write},
    path::PathBuf,
};

use clap::{Parser, Subcommand};

use clepsydra::doctor::{self, DoctorOpts};
use clepsydra::vault::backup::create_backup;
use clepsydra::vault::init::init_vault;
use clepsydra::vault::new_note::create_new_note;
use clepsydra::{ServeOverrides, open_vault_and_index, run_lsp_standalone, run_server};

#[derive(Debug, Parser)]
#[command(
    name = "clepsydra",
    version,
    about = "Clepsydra CLI",
    long_about = "CLI for managing Clepsydra vaults and running the API server.\n\nConfiguration lookup order (for commands that require config):\n  1) ./config.toml\n  2) $XDG_CONFIG_HOME/clepsydra/config.toml\n  3) $HOME/.config/clepsydra/config.toml",
    after_help = "Examples:\n  clepsydra init ~/vault\n  clepsydra serve\n  clepsydra new \"Project Plan\"\n  clepsydra new \"Inbox\" --body \"- [ ] follow up\"\n  clep backup --destination ~/Backups\n  clepsydra config show\n  clepsydra config show --origin\n  clepsydra config path\n  clepsydra config path --trace\n  clepsydra config create"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

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
        about = "Capture one Todo in today's journal",
        long_about = "Capture one unchecked Markdown Todo in today's journal through the configured local Clepsydra server.\n\nProvide the Todo text as positional words. With no words, text is read from stdin to EOF.",
        after_help = "Examples:\n  clep todo Buy milk\n  clep todo \"Buy milk and eggs\"\n  echo \"Buy milk\" | clep todo\n  clep todo Ship release --due 2026-09-01 --scheduled 2026-08-30 --priority A"
    )]
    Todo {
        #[arg(
            value_name = "WORDS",
            num_args = 0..,
            help = "Todo text as one or more words; omit to read stdin"
        )]
        words: Vec<String>,
        #[arg(long, value_name = "YYYY-MM-DD", help = "Optional due date")]
        due: Option<String>,
        #[arg(long, value_name = "YYYY-MM-DD", help = "Optional scheduled date")]
        scheduled: Option<String>,
        #[arg(long, value_name = "A|B|C", help = "Optional priority")]
        priority: Option<String>,
    },
    #[command(about = "Create a local archive of the configured vault")]
    Backup {
        #[arg(
            long,
            value_name = "DIRECTORY",
            help = "Directory in which to create the backup archive"
        )]
        destination: PathBuf,
    },
    #[command(
        about = "Inspect or create application config",
        long_about = "Inspect the application config selected by Clepsydra, print its path, or create a commented user config template. This command does not operate on vault-level .clepsydra/config.toml files."
    )]
    Config {
        #[command(subcommand)]
        command: ConfigCommands,
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
        #[arg(long)]
        strict: bool,
        /// Run expensive checks (e.g. CAS stats)
        #[arg(long)]
        full: bool,
    },
    #[command(
        about = "Start the API server",
        long_about = "Start the Clepsydra HTTP API server.\n\nRequires a config file discovered via:\n  1) ./config.toml\n  2) $XDG_CONFIG_HOME/clepsydra/config.toml\n  3) $HOME/.config/clepsydra/config.toml\n\nVault root is read from [vault].root.\n\n--tls and --port override the config file and the CLEPSYDRA__* environment variables, so a second server (HTTPS, spare port) can be started for testing without editing shared config. --tls only ever turns HTTPS on; to serve cleartext, leave it off.",
        after_help = "Examples:\n  clepsydra serve\n  clepsydra serve --tls                 # HTTPS on the configured port\n  clepsydra serve --tls --port 3443     # HTTPS alongside a plain server\n\nHTTPS uses certs from [server.tls], or generates localhost ones with mkcert."
    )]
    Serve {
        /// Serve over HTTPS, generating localhost certs with mkcert if needed
        #[arg(long)]
        tls: bool,
        /// Listen on PORT instead of the configured port
        #[arg(long, value_name = "PORT")]
        port: Option<u16>,
    },
    /// Start the LSP server on stdio (standalone, read-only; the vault is
    /// resolved from the editor's workspace root, falling back to config.toml)
    Lsp,
    #[command(
        about = "Start the MCP server on stdio",
        long_about = "Speak MCP (Model Context Protocol) on stdio, proxying tool calls to the running Clepsydra HTTP API server.\n\nThe server is discovered via the usual config lookup:\n  1) ./config.toml\n  2) $XDG_CONFIG_HOME/clepsydra/config.toml\n  3) $HOME/.config/clepsydra/config.toml\n\n`clep serve` must already be running; tool calls fail with a hint otherwise.",
        after_help = "Example MCP client registration (.mcp.json):\n  { \"mcpServers\": { \"clepsydra\": { \"command\": \"clep\", \"args\": [\"mcp\"] } } }"
    )]
    Mcp {
        #[arg(
            long,
            help = "Allow targeting a non-loopback [server].host from config"
        )]
        allow_remote: bool,
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
        about = "Convert legacy YAML frontmatter to TOML",
        long_about = "Sweep the vault for pages with legacy `---` YAML frontmatter and convert them to `+++` TOML.\n\nDry run by default: prints what would convert and touches nothing. Pass --write to apply. Conversion preserves the page id, every field, and the body; YAML comments inside frontmatter are NOT preserved — commit your vault first.\n\n`clepsydra doctor` reports the remaining legacy-page census.",
        after_help = "Examples:\n  clepsydra migrate            # dry run\n  clepsydra migrate --write    # convert in place"
    )]
    Migrate {
        /// Apply the conversion (default is a dry run).
        #[arg(long)]
        write: bool,
    },
    #[command(
        about = "Register the clepsydra:// URL scheme with macOS",
        long_about = "Build and install a small URL-handler app at ~/Applications/Clepsydra URL Handler.app that routes clepsydra:// links (and optionally obsidian:// links) to this clepsydra binary via `open-url`.\n\nmacOS only.",
        after_help = "Examples:\n  clepsydra register-url\n  clepsydra register-url --obsidian   # also claim obsidian:// (competes with Obsidian if installed)"
    )]
    RegisterUrl {
        #[arg(long, help = "Also register the obsidian:// scheme (compat mode)")]
        obsidian: bool,
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

async fn run_todo_command<R, W, C, F>(
    words: Vec<String>,
    due: Option<String>,
    scheduled: Option<String>,
    priority: Option<String>,
    stdin: &mut R,
    stdout: &mut W,
    capture: C,
) -> Result<(), Box<dyn std::error::Error>>
where
    R: Read + ?Sized,
    W: Write + ?Sized,
    C: FnOnce(clepsydra::todo_capture::TodoCaptureInput) -> F,
    F: Future<Output = Result<String, clepsydra::todo_capture::TodoCaptureError>>,
{
    let text = if words.is_empty() {
        let mut text = String::new();
        stdin.read_to_string(&mut text)?;
        text
    } else {
        words.join(" ")
    };
    let path = capture(clepsydra::todo_capture::TodoCaptureInput {
        text,
        due,
        scheduled,
        priority,
    })
    .await?;
    writeln!(stdout, "Captured Todo in {path}")?;
    Ok(())
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
        Commands::Todo {
            words,
            due,
            scheduled,
            priority,
        } => {
            let mut stdin = std::io::stdin().lock();
            let mut stdout = std::io::stdout().lock();
            run_todo_command(
                words,
                due,
                scheduled,
                priority,
                &mut stdin,
                &mut stdout,
                clepsydra::todo_capture::capture_todo,
            )
            .await?;
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
        Commands::Backup { destination } => {
            let cwd = std::env::current_dir()?;
            let (settings, config_path) = clepsydra::Settings::load(&cwd)?;
            let vault_root =
                clepsydra::resolve_vault_root(&settings.vault.root, &config_path, &cwd);
            let archive = create_backup(&vault_root, &destination, chrono::Utc::now())?;
            println!("{}", archive.display());
            Ok(0)
        }
        Commands::Config { command } => match command {
            ConfigCommands::Show { origin } => {
                let cwd = std::env::current_dir()?;
                let config = clepsydra::config_command::read_existing(&cwd)?;
                if origin {
                    let mut stderr = anstream::AutoStream::auto(std::io::stderr().lock());
                    clepsydra::config_command::render_origin(&config.resolution.path, &mut stderr)?;
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
        Commands::Serve { tls, port } => {
            run_server(ServeOverrides { tls, port }).await?;
            Ok(0)
        }
        Commands::Lsp => {
            run_lsp_standalone().await;
            Ok(0)
        }
        Commands::Mcp { allow_remote } => {
            clepsydra::mcp::run_mcp(allow_remote).await?;
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
                let status = std::process::Command::new("open").arg(&target).status()?;
                if !status.success() {
                    return Err(format!("open exited with {status}").into());
                }
            }
            Ok(0)
        }
        Commands::RegisterUrl { obsidian } => {
            if !cfg!(target_os = "macos") {
                return Err("register-url is only supported on macOS".into());
            }
            let binary = std::env::current_exe()?;
            let app = clepsydra::macos_url_handler::install(&binary, obsidian)?;
            println!("Installed URL handler at {}", app.display());
            println!("Registered scheme: clepsydra://");
            if obsidian {
                println!(
                    "Registered scheme: obsidian:// (note: competes with Obsidian.app if installed)"
                );
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
        Commands::Migrate { write } => {
            let cwd = std::env::current_dir()?;
            let (settings, config_path) = clepsydra::Settings::load(&cwd)?;
            let vault_root =
                clepsydra::resolve_vault_root(&settings.vault.root, &config_path, &cwd);
            let vault = clepsydra::vault::Vault::open(&vault_root)?;

            println!(
                "Converting legacy YAML frontmatter to TOML. YAML comments inside frontmatter are not preserved — commit your vault before running with --write."
            );
            let report = clepsydra::vault::migrate::migrate(&vault, write);
            let verb = if report.dry_run {
                "would convert"
            } else {
                "converted"
            };
            for path in &report.converted {
                println!("  {verb} {path}");
            }
            for warning in &report.warnings {
                println!("  warning {warning}");
            }
            println!(
                "migrate: {} legacy page(s) {verb}, {} warning(s){}",
                report.converted.len(),
                report.warnings.len(),
                if report.dry_run {
                    " (dry run — pass --write to apply)"
                } else {
                    ""
                }
            );
            Ok(if report.warnings.is_empty() { 0 } else { 1 })
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
    use clap::{CommandFactory, Parser};

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
        let cas = root.join(".clepsydra/cas");
        std::fs::write(
            root.join(".clepsydra/config.toml"),
            format!(
                "[vault]\n\n[archive]\ncas_path = {:?}\n",
                cas.display().to_string()
            ),
        )
        .unwrap();
        drop(clepsydra::vault::cas::ContentStore::open(&cas).unwrap());
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

    struct PanicReader;

    impl std::io::Read for PanicReader {
        fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
            panic!("stdin must not be read when positional words are present");
        }
    }

    #[test]
    fn todo_parses_words_and_metadata() {
        let cli = Cli::try_parse_from([
            "clep",
            "todo",
            "Ship",
            "the",
            "release",
            "--due",
            "2026-09-01",
            "--scheduled",
            "2026-08-30",
            "--priority",
            "A",
        ])
        .unwrap();

        assert!(matches!(
            cli.command,
            Commands::Todo {
                words,
                due,
                scheduled,
                priority,
            } if words == ["Ship", "the", "release"]
                && due.as_deref() == Some("2026-09-01")
                && scheduled.as_deref() == Some("2026-08-30")
                && priority.as_deref() == Some("A")
        ));
    }

    #[test]
    fn todo_accepts_no_words_for_stdin() {
        let cli = Cli::try_parse_from(["clep", "todo"]).unwrap();

        assert!(matches!(
            cli.command,
            Commands::Todo {
                words,
                due: None,
                scheduled: None,
                priority: None,
            } if words.is_empty()
        ));
    }

    #[test]
    fn todo_help_shows_each_input_form_and_metadata() {
        let mut command = Cli::command();
        let todo = command.find_subcommand_mut("todo").unwrap();
        let help = todo.render_long_help().to_string();

        assert!(help.contains("clep todo Buy milk"));
        assert!(help.contains("clep todo \"Buy milk and eggs\""));
        assert!(help.contains("echo \"Buy milk\" | clep todo"));
        assert!(help.contains(
            "clep todo Ship release --due 2026-09-01 --scheduled 2026-08-30 --priority A"
        ));
    }

    #[tokio::test]
    async fn todo_words_take_precedence_without_reading_stdin() {
        let mut stdin = PanicReader;
        let mut stdout = Vec::new();
        let mut captured = None;

        run_todo_command(
            vec!["Buy".into(), "milk".into()],
            None,
            None,
            None,
            &mut stdin,
            &mut stdout,
            |input| {
                captured = Some(input);
                std::future::ready(Ok("journals/2026-08-26.md".to_string()))
            },
        )
        .await
        .unwrap();

        assert_eq!(
            captured.unwrap(),
            clepsydra::todo_capture::TodoCaptureInput {
                text: "Buy milk".into(),
                due: None,
                scheduled: None,
                priority: None,
            }
        );
    }

    #[tokio::test]
    async fn todo_reads_stdin_to_eof_when_words_are_absent() {
        let mut stdin = std::io::Cursor::new("Buy\nmilk\n");
        let mut stdout = Vec::new();
        let mut captured = None;

        run_todo_command(
            Vec::new(),
            None,
            None,
            None,
            &mut stdin,
            &mut stdout,
            |input| {
                captured = Some(input);
                std::future::ready(Ok("journals/2026-08-26.md".to_string()))
            },
        )
        .await
        .unwrap();

        assert_eq!(captured.unwrap().text, "Buy\nmilk\n");
    }

    #[tokio::test]
    async fn todo_passes_metadata_to_the_capture_module() {
        let mut stdin = PanicReader;
        let mut stdout = Vec::new();
        let mut captured = None;

        run_todo_command(
            vec!["Plan".into()],
            Some("2026-09-01".into()),
            Some("2026-08-30".into()),
            Some("B".into()),
            &mut stdin,
            &mut stdout,
            |input| {
                captured = Some(input);
                std::future::ready(Ok("journals/2026-08-26.md".to_string()))
            },
        )
        .await
        .unwrap();

        assert_eq!(
            captured.unwrap(),
            clepsydra::todo_capture::TodoCaptureInput {
                text: "Plan".into(),
                due: Some("2026-09-01".into()),
                scheduled: Some("2026-08-30".into()),
                priority: Some("B".into()),
            }
        );
    }

    #[tokio::test]
    async fn todo_blank_stdin_flows_to_module_validation() {
        let mut stdin = std::io::Cursor::new(" \n\t");
        let mut stdout = Vec::new();

        let error = run_todo_command(
            Vec::new(),
            None,
            None,
            None,
            &mut stdin,
            &mut stdout,
            clepsydra::todo_capture::capture_todo,
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error.downcast_ref::<clepsydra::todo_capture::TodoCaptureError>(),
            Some(clepsydra::todo_capture::TodoCaptureError::BlankText)
        ));
        assert!(stdout.is_empty());
    }

    #[tokio::test]
    async fn todo_prints_the_exact_success_message() {
        let mut stdin = PanicReader;
        let mut stdout = Vec::new();

        run_todo_command(
            vec!["Buy".into(), "milk".into()],
            None,
            None,
            None,
            &mut stdin,
            &mut stdout,
            |_| std::future::ready(Ok("journals/2026-08-26.md".to_string())),
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"Captured Todo in journals/2026-08-26.md\n");
    }

    #[tokio::test]
    async fn todo_propagates_server_errors_without_writing_success_output() {
        let mut stdin = PanicReader;
        let mut stdout = Vec::new();

        let error = run_todo_command(
            vec!["Buy".into(), "milk".into()],
            None,
            None,
            None,
            &mut stdin,
            &mut stdout,
            |_| {
                std::future::ready(Err(clepsydra::todo_capture::TodoCaptureError::Api(
                    clepsydra::mcp::client::ApiCallError::Api {
                        status: 503,
                        message: "server unavailable".into(),
                    },
                )))
            },
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error.downcast_ref::<clepsydra::todo_capture::TodoCaptureError>(),
            Some(clepsydra::todo_capture::TodoCaptureError::Api(
                clepsydra::mcp::client::ApiCallError::Api {
                    status: 503,
                    message,
                }
            )) if message == "server unavailable"
        ));
        assert!(stdout.is_empty());
    }

    #[test]
    fn config_show_defaults_origin_off() {
        assert!(!config_show_origin(&["clep", "config", "show"]));
    }

    #[test]
    fn config_show_accepts_origin() {
        assert!(config_show_origin(&["clep", "config", "show", "--origin",]));
    }

    #[test]
    fn config_path_defaults_trace_off() {
        assert!(!config_path_trace(&["clep", "config", "path"]));
    }

    #[test]
    fn config_path_accepts_trace() {
        assert!(config_path_trace(&["clep", "config", "path", "--trace",]));
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

    #[test]
    fn backup_accepts_a_required_destination() {
        let cli = Cli::try_parse_from(["clep", "backup", "--destination", "out"]).unwrap();
        assert!(matches!(
            cli.command,
            Commands::Backup { destination } if destination == std::path::Path::new("out")
        ));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn backup_creates_one_archive_in_the_destination() {
        let (_dir, root) = vault_in_tempdir();
        let destination = root.join("backups");
        let cli = Cli::try_parse_from([
            "clepsydra",
            "backup",
            "--destination",
            destination.to_str().unwrap(),
        ])
        .unwrap();

        let result = run_cli_in(&root, cli).await;

        assert_eq!(result.unwrap(), 0);
        let archives = std::fs::read_dir(&destination)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "tar"))
            .collect::<Vec<_>>();
        assert_eq!(archives.len(), 1);
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

    #[test]
    fn register_url_parses_with_and_without_obsidian_flag() {
        assert!(Cli::try_parse_from(["clepsydra", "register-url"]).is_ok());
        assert!(Cli::try_parse_from(["clepsydra", "register-url", "--obsidian"]).is_ok());
    }

    fn serve_flags(args: &[&str]) -> (bool, Option<u16>) {
        let cli = Cli::try_parse_from(args).unwrap();
        match cli.command {
            Commands::Serve { tls, port, .. } => (tls, port),
            other => panic!("expected serve, got {other:?}"),
        }
    }

    #[test]
    fn bare_serve_requests_no_overrides() {
        assert_eq!(serve_flags(&["clepsydra", "serve"]), (false, None));
    }

    #[test]
    fn serve_accepts_tls_and_port_together() {
        assert_eq!(
            serve_flags(&["clepsydra", "serve", "--tls", "--port", "3443"]),
            (true, Some(3443))
        );
    }

    #[test]
    fn serve_rejects_a_port_outside_the_u16_range() {
        assert!(Cli::try_parse_from(["clepsydra", "serve", "--port", "70000"]).is_err());
    }

    #[test]
    fn lsp_is_a_subcommand_and_serve_rejects_the_old_flag() {
        assert!(Cli::try_parse_from(["clep", "lsp"]).is_ok());
        assert!(Cli::try_parse_from(["clep", "serve", "--lsp"]).is_err());
    }
}
