//! MCP (Model Context Protocol) server over the vault API.
//!
//! `clep mcp` speaks MCP on stdio and proxies every tool call to the running
//! `clep serve` HTTP server, discovered through the same config lookup the
//! rest of the CLI uses. See docs/plans/2026-08-03-vault-mcp-server-and-skill.md
//! for the design and milestones.

mod edit;
pub mod server;
pub mod tasking;

use std::sync::Arc;

use rmcp::ServiceExt;

use clep_client::configured_api_client;
use server::VaultMcpServer;

/// Run the MCP server on stdio until the client disconnects.
///
/// No tracing subscriber is installed here on purpose: stdout belongs to the
/// MCP protocol, and a default `fmt` subscriber would corrupt it.
pub async fn run_mcp(allow_remote: bool) -> Result<(), Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()?;
    let client = configured_api_client(&cwd, allow_remote)?;
    let mcp = VaultMcpServer::new(Arc::new(client));

    let service = mcp.serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    /// The eval fixture (crates/clep-api/tests/mcp_evals/vault) must stay drift-free: its
    /// declared metadata already matches folder placement, so the serve-time
    /// reconcile sweep moves nothing and the checked-in answers in
    /// evaluation.xml stay valid. Runs over a copy — building the index
    /// writes a cache the checked-in tree must not accumulate.
    #[tokio::test]
    async fn eval_fixture_vault_is_drift_free() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../clep-api/tests/mcp_evals/vault");
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        copy_tree(&fixture, &root);

        let paths_before = markdown_paths(&root);
        assert_eq!(paths_before.len(), 10, "fixture should hold 10 pages");

        let state = clep_api::build_app_state(&root).await.unwrap();
        clep_api::run_startup_reconcile(&state).await;

        assert_eq!(
            markdown_paths(&root),
            paths_before,
            "reconcile moved fixture pages — evaluation.xml answers may now be stale"
        );
    }

    fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in walkdir::WalkDir::new(from) {
            let entry = entry.unwrap();
            let dest = to.join(entry.path().strip_prefix(from).unwrap());
            if entry.file_type().is_dir() {
                std::fs::create_dir_all(&dest).unwrap();
            } else {
                std::fs::copy(entry.path(), &dest).unwrap();
            }
        }
    }

    fn markdown_paths(root: &std::path::Path) -> Vec<String> {
        let mut paths: Vec<String> = walkdir::WalkDir::new(root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
            .map(|e| {
                e.path()
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        paths.sort();
        paths
    }
}
