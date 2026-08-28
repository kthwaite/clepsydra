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
enum CasCommands {
    #[command(about = "Fill {hash, type} blob entries in archive pages from cas.db")]
    Backfill {
        /// Apply changes (default is a dry run).
        #[arg(long)]
        write: bool,
    },
    #[command(about = "Recreate cas.db rows from blob files on disk plus a vault scan")]
    Rebuild {
        /// Apply changes (default is a dry run).
        #[arg(long)]
        write: bool,
    },
    #[command(
        about = "Copy this vault's referenced blobs from an old CAS into the vault's store and rebuild cas.db",
        long_about = "Moves the content-addressed store into the vault (ADR 0005). Copies only the blobs referenced by this vault's live pages and rubbish items from --from (default: the pre-2026-08-28 store at ~/.clepsydra/cas) into [archive].cas_path (default .clepsydra/cas inside the vault), verifies each blob's sha256, then rebuilds the destination cas.db from blob files plus a vault-wide frontmatter scan. The source store is never modified; blobs no page references stay behind. Stop `clep serve` first: the rebuild takes the store's lock. Dry run by default; --write applies."
    )]
    Migrate {
        /// Source CAS root to copy from (default: ~/.clepsydra/cas).
        #[arg(long)]
        from: Option<PathBuf>,
        /// Apply changes (default is a dry run).
        #[arg(long)]
        write: bool,
    },
}

#[derive(Debug, Subcommand)]
enum CodesCommands {
    #[command(
        about = "One-time migration: recode legacy TASK/CYCLE pages and rewrite prose tokens",
        long_about = "Rename every TASK/CYCLE page whose filename stem is not already a petname code (docs/adr/0003-hybrid-petname-task-codes.md) to a freshly minted one, rewriting inbound wikilinks through the move planner. Then rewrite every plain-text legacy token (`TSK-0072`, `S-3`) vault-wide, including inside frontmatter values such as `cycle = \"S-3\"`, which the move planner does not touch.\n\nStop `clep serve` first: this command opens the vault index directly, and a server running concurrently would hold a now-stale index and could reintroduce the renamed files' old paths.\n\nThis is a one-time, irreversible clean break: after it runs, no code in the legacy `TSK-0072` / `S-3` format is recognized anywhere in Clepsydra, and there is no alias mapping old codes to new ones. A legacy code recorded outside the vault (an external link, a chat log, a paper notebook) will no longer resolve to anything. Commit or back up the vault before running with --write.\n\nA page that fails to rename, or whose destination already exists, is warned about and left untouched for a later run rather than aborting the whole migration; its legacy code is correspondingly left unrewritten wherever it's mentioned in prose, also warned about, rather than rewritten to a code that was never created.",
        after_help = "Examples:\n  clep codes migrate            # dry run\n  clep codes migrate --write    # rename and rewrite in place"
    )]
    Migrate {
        /// Apply changes (default is a dry run).
        #[arg(long)]
        write: bool,
    },
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
        about = "CAS maintenance",
        long_about = "Maintain the content-addressed store: backfill typed blob metadata into archive pages, or rebuild the derived cas.db from the vault."
    )]
    Cas {
        #[command(subcommand)]
        command: CasCommands,
    },
    #[command(
        about = "Petname code utilities",
        long_about = "Utilities for the Task/Cycle petname code scheme (docs/adr/0003-hybrid-petname-task-codes.md)."
    )]
    Codes {
        #[command(subcommand)]
        command: CodesCommands,
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
        Commands::Cas { command } => match command {
            CasCommands::Backfill { write } => {
                let cwd = std::env::current_dir()?;
                let (settings, config_path) = clepsydra::Settings::load(&cwd)?;
                let vault_root =
                    clepsydra::resolve_vault_root(&settings.vault.root, &config_path, &cwd);
                let vault = clepsydra::vault::Vault::open(&vault_root)?;
                let cas_path = vault.cas_root();
                let cas_db = cas_path.join("cas.db");

                println!(
                    "Backfilling {{hash, type}} blob entries in archive pages from {}.",
                    cas_db.display()
                );
                let report = clepsydra::vault::archive_backfill::backfill(&vault, &cas_db, write);
                let verb = if report.dry_run {
                    "would update"
                } else {
                    "updated"
                };
                for path in &report.updated {
                    println!("  {verb} {path}");
                }
                for warning in &report.warnings {
                    println!("  warning {warning}");
                }
                println!(
                    "cas backfill: {} page(s) {verb}, {} warning(s){}",
                    report.updated.len(),
                    report.warnings.len(),
                    if report.dry_run {
                        " (dry run — pass --write to apply)"
                    } else {
                        ""
                    }
                );
                Ok(if report.warnings.is_empty() { 0 } else { 1 })
            }
            CasCommands::Rebuild { write } => {
                let cwd = std::env::current_dir()?;
                let (settings, config_path) = clepsydra::Settings::load(&cwd)?;
                let vault_root =
                    clepsydra::resolve_vault_root(&settings.vault.root, &config_path, &cwd);
                let vault = clepsydra::vault::Vault::open(&vault_root)?;
                let cas_path = vault.cas_root();

                println!(
                    "Rebuilding {} from blob files under {} plus a vault-wide scan.",
                    cas_path.join("cas.db").display(),
                    cas_path.display()
                );
                let scan = clepsydra::vault::cas_scan::scan_archive_refs(&vault);
                for warning in &scan.warnings {
                    println!("  warning {warning}");
                }

                let store = clepsydra::vault::cas::ContentStore::open(&cas_path)?;
                let report = store.rebuild_metadata(&scan, write)?;
                for hash in &report.untyped_blobs {
                    println!("  untyped {hash}");
                }
                for hash in &report.missing_files {
                    println!("  missing {hash}");
                }
                let verb = if report.dry_run {
                    "would write"
                } else {
                    "wrote"
                };
                println!(
                    "cas rebuild: {verb} {} row(s), {} unreferenced, {} untyped, {} missing{}",
                    report.rows_written,
                    report.unreferenced_blobs,
                    report.untyped_blobs.len(),
                    report.missing_files.len(),
                    if report.dry_run {
                        " (dry run — pass --write to apply)"
                    } else {
                        ""
                    }
                );
                Ok(
                    if report.missing_files.is_empty() && scan.warnings.is_empty() {
                        0
                    } else {
                        1
                    },
                )
            }
            CasCommands::Migrate { from, write } => {
                let cwd = std::env::current_dir()?;
                let (settings, config_path) = clepsydra::Settings::load(&cwd)?;
                let vault_root =
                    clepsydra::resolve_vault_root(&settings.vault.root, &config_path, &cwd);
                let vault = clepsydra::vault::Vault::open(&vault_root)?;

                let source = from.unwrap_or_else(|| {
                    clepsydra::expand_tilde(clepsydra::vault::cas_migrate::LEGACY_DEFAULT_CAS_PATH)
                        .unwrap_or_else(|| {
                            PathBuf::from(clepsydra::vault::cas_migrate::LEGACY_DEFAULT_CAS_PATH)
                        })
                });

                println!(
                    "Migrating referenced blobs from {} into {}.",
                    source.display(),
                    vault.cas_root().display()
                );
                let report = clepsydra::vault::cas_migrate::migrate(&vault, &source, write)?;
                let verb = if report.dry_run {
                    "would copy"
                } else {
                    "copied"
                };
                for hash in &report.copied {
                    println!("  {verb} {hash}");
                }
                if !report.already_present.is_empty() {
                    println!("  {} already present", report.already_present.len());
                }
                for warning in &report.warnings {
                    println!("  warning {warning}");
                }
                if let Some(rebuild) = &report.rebuild {
                    println!(
                        "cas.db: {} row(s), {} untyped, {} missing",
                        rebuild.rows_written,
                        rebuild.untyped_blobs.len(),
                        rebuild.missing_files.len()
                    );
                }
                println!(
                    "cas migrate: {} blob(s) {verb} ({} bytes), {} already present, {} missing, {} corrupt, {} failed, {} orphan(s) left in source, {} warning(s){}",
                    report.copied.len(),
                    report.bytes_copied,
                    report.already_present.len(),
                    report.missing.len(),
                    report.corrupt.len(),
                    report.failed.len(),
                    report.orphans_left,
                    report.warnings.len(),
                    if report.dry_run {
                        " (dry run — pass --write to apply)"
                    } else {
                        ""
                    }
                );
                Ok(if report.warnings.is_empty() { 0 } else { 1 })
            }
        },
        Commands::Codes { command } => match command {
            CodesCommands::Migrate { write } => {
                // Opens the vault and a fully-derived index directly (see
                // long_about: stop `clep serve` first), the same way
                // `Commands::Relabel` does, so inbound wikilinks get
                // rewritten on rename.
                let (vault, mut index) = open_vault_and_index()?;
                println!(
                    "Recoding legacy TASK/CYCLE pages to petname codes. This is a one-time, irreversible clean break — commit or back up the vault before running with --write."
                );
                let report = clepsydra::vault::recode::recode(&vault, &mut index, write)?;
                for (old, new) in &report.renamed {
                    println!("  {old} -> {new}");
                }
                for (path, count) in &report.rewritten {
                    println!("  {path}: {count} token(s)");
                }
                for warning in &report.warnings {
                    println!("  warning {warning}");
                }
                println!(
                    "codes migrate: {} renamed, {} rewritten, {} warning(s){}",
                    report.renamed.len(),
                    report.rewritten.len(),
                    report.warnings.len(),
                    if report.dry_run {
                        " (dry run — pass --write to apply)"
                    } else {
                        ""
                    }
                );
                Ok(if report.warnings.is_empty() { 0 } else { 1 })
            }
        },
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

    fn cas_backfill_write(args: &[&str]) -> bool {
        let cli = Cli::try_parse_from(args).unwrap();
        match cli.command {
            Commands::Cas {
                command: CasCommands::Backfill { write },
            } => write,
            other => panic!("expected cas backfill, got {other:?}"),
        }
    }

    #[test]
    fn cas_backfill_defaults_write_off() {
        assert!(!cas_backfill_write(&["clep", "cas", "backfill"]));
    }

    #[test]
    fn cas_backfill_accepts_write() {
        assert!(cas_backfill_write(&["clep", "cas", "backfill", "--write"]));
    }

    #[test]
    fn cas_requires_a_subcommand() {
        assert!(Cli::try_parse_from(["clep", "cas"]).is_err());
    }

    fn cas_rebuild_write(args: &[&str]) -> bool {
        let cli = Cli::try_parse_from(args).unwrap();
        match cli.command {
            Commands::Cas {
                command: CasCommands::Rebuild { write },
            } => write,
            other => panic!("expected cas rebuild, got {other:?}"),
        }
    }

    #[test]
    fn cas_rebuild_defaults_write_off() {
        assert!(!cas_rebuild_write(&["clep", "cas", "rebuild"]));
    }

    #[test]
    fn cas_rebuild_accepts_write() {
        assert!(cas_rebuild_write(&["clep", "cas", "rebuild", "--write"]));
    }

    #[test]
    fn cas_migrate_defaults_to_dry_run_and_legacy_source() {
        let cli = Cli::try_parse_from(["clep", "cas", "migrate"]).unwrap();
        match cli.command {
            Commands::Cas {
                command: CasCommands::Migrate { from, write },
            } => {
                assert!(from.is_none());
                assert!(!write);
            }
            other => panic!("expected cas migrate, got {other:?}"),
        }
    }

    #[test]
    fn cas_migrate_accepts_from_and_write() {
        let cli = Cli::try_parse_from(["clep", "cas", "migrate", "--from", "/old/cas", "--write"])
            .unwrap();
        match cli.command {
            Commands::Cas {
                command: CasCommands::Migrate { from, write },
            } => {
                assert_eq!(from.unwrap(), PathBuf::from("/old/cas"));
                assert!(write);
            }
            other => panic!("expected cas migrate, got {other:?}"),
        }
    }

    fn codes_migrate_write(args: &[&str]) -> bool {
        let cli = Cli::try_parse_from(args).unwrap();
        match cli.command {
            Commands::Codes {
                command: CodesCommands::Migrate { write },
            } => write,
            other => panic!("expected codes migrate, got {other:?}"),
        }
    }

    #[test]
    fn codes_migrate_defaults_write_off() {
        assert!(!codes_migrate_write(&["clep", "codes", "migrate"]));
    }

    #[test]
    fn codes_migrate_accepts_write() {
        assert!(codes_migrate_write(&[
            "clep", "codes", "migrate", "--write"
        ]));
    }

    #[test]
    fn codes_requires_a_subcommand() {
        assert!(Cli::try_parse_from(["clep", "codes"]).is_err());
    }
}
