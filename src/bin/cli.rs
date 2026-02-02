use clap::{Parser, Subcommand};

use clepsydra::run_server;

#[derive(Debug, Parser)]
#[command(name = "clepsydra", version, about = "Clepsydra CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    Init,
    Env,
    Doctor,
    Serve,
    Version,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Init => {
            println!("init command not implemented yet");
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
