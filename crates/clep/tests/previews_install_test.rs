#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::{fs, process::Command};

#[test]
fn previews_install_outside_checkout_reports_missing_node_without_vault_config() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().join("unrelated working directory");
    let home = temp.path().join("isolated home");
    fs::create_dir(&cwd).unwrap();
    fs::create_dir(&home).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_clep"))
        .args(["previews", "install"])
        .current_dir(&cwd)
        .env_clear()
        .env("HOME", &home)
        .env("XDG_DATA_HOME", temp.path().join("data"))
        .env("PATH", temp.path().join("missing tools"))
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("required executable `node`"), "{stderr}");
    assert!(stderr.contains("clep previews install"), "{stderr}");
    assert!(!stderr.contains("config.toml"), "{stderr}");
    assert!(!temp.path().join("data").exists());
}

#[test]
fn previews_help_is_offline_and_describes_explicit_setup() {
    let temp = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_clep"))
        .args(["previews", "install", "--help"])
        .current_dir(temp.path())
        .env_clear()
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Node.js >=20"), "{stdout}");
    assert!(stdout.contains("No Docker"), "{stdout}");
}

#[test]
fn previews_install_reports_missing_npm_before_running_node() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let tools = temp.path().join("tools");
    fs::create_dir(&tools).unwrap();
    let node = tools.join("node");
    // This must not execute: prerequisite resolution is complete before setup.
    fs::write(&node, "#!/bin/sh\nexit 99\n").unwrap();
    fs::set_permissions(&node, fs::Permissions::from_mode(0o700)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_clep"))
        .args(["previews", "install"])
        .current_dir(temp.path())
        .env_clear()
        .env("HOME", temp.path())
        .env("XDG_DATA_HOME", temp.path().join("data"))
        .env("PATH", &tools)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("required executable `npm`"), "{stderr}");
    assert!(!stderr.contains("99"), "{stderr}");
    assert!(!temp.path().join("data").exists());
}
