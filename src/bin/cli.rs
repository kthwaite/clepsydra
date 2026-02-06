use std::path::PathBuf;

use clap::{Parser, Subcommand};

use clepsydra::run_server;
use clepsydra::vault::init::init_vault;

#[derive(Debug, Parser)]
#[command(name = "clepsydra", version, about = "Clepsydra CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Initialize a new vault
    Init {
        /// Path to vault root (defaults to current directory)
        #[arg(default_value = ".")]
        path: PathBuf,
    },
    Env,
    Doctor,
    Serve,
    Version,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Init { path } => {
            init_vault(&path)?;
            println!("Initialized vault at {}", path.display());
        }
        Commands::Env => {
            println!("env command not implemented yet");
        }
        Commands::Doctor => {
            println!("doctor command not implemented yet");
        }
        Commands::Serve => {
            run_server().await?;
        }
        Commands::Version => {
            println!("{}", env!("CARGO_PKG_VERSION"));
        }
    }

    Ok(())
}
