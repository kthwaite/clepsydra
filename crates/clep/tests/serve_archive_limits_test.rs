//! Spawns the real `clep serve` binary to exercise transport-level request
//! size limits that the in-process `axum-test` harness (used by
//! `clepsydra`'s own `archive_test.rs`) cannot: those limits are enforced by
//! the real Hyper/axum-server listener, not by anything reachable without an
//! actual process boundary.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

fn sha256_hash(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    format!("sha256:{:x}", digest)
}

fn content_hash(body: &str) -> String {
    sha256_hash(body.as_bytes())
}

#[tokio::test]
async fn request_above_base64_only_allowance_reaches_archive_validation() {
    let temp = TempDir::new().unwrap();
    let vault_root = temp.path().join("vault");
    let cas_root = temp.path().join("cas");
    clepsydra::vault::init::init_vault(&vault_root).unwrap();
    std::fs::write(
        vault_root.join(".clepsydra/config.toml"),
        format!(
            "[archive]\ncas_path = \"{}\"\nmax_blob_size_mb = 1\nmax_request_size_mb = 2\n",
            cas_root.display()
        ),
    )
    .unwrap();

    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    std::fs::write(
        temp.path().join("config.toml"),
        format!(
            "[server]\nhost = \"127.0.0.1\"\nport = {port}\n\n[vault]\nroot = \"{}\"\n",
            vault_root.display()
        ),
    )
    .unwrap();

    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_clep"))
        .arg("serve")
        .current_dir(temp.path())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let client = reqwest::Client::new();
    let base_url = format!("http://127.0.0.1:{port}");
    for _ in 0..100 {
        if client
            .get(format!("{base_url}/api/vault/uptime"))
            .send()
            .await
            .is_ok()
        {
            break;
        }
        assert!(
            child.try_wait().unwrap().is_none(),
            "production server exited before becoming ready"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let markdown = "m".repeat(950 * 1024);
    let image_b64 = BASE64.encode(vec![0_u8; 850 * 1024]);
    let snapshot_html =
        format!(r#"<html><body><img src="data:image/png;base64,{image_b64}"></body></html>"#);
    let request = serde_json::json!({
        "url": "https://example.com/transport-headroom",
        "domain": "example.com",
        "title": "Transport Headroom",
        "captured_at": "2026-08-13T00:00:00Z",
        "content_hash": content_hash(&markdown),
        "snapshot_html": snapshot_html,
        "markdown_body": markdown,
        "tags": ["archive"],
    });
    let request_body = serde_json::to_vec(&request).unwrap();
    assert!(
        request_body.len() > 2 * 1024 * 1024,
        "fixture must exceed the former two-MiB transport allowance"
    );

    let response = client
        .post(format!("{base_url}/api/vault/archive"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(request_body)
        .send()
        .await
        .unwrap();
    let status = response.status();
    child.kill().await.unwrap();

    assert_eq!(status, reqwest::StatusCode::CREATED);
}
