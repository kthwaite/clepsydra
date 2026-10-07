use std::{fs, process::Command};

use clep_api::vault::{init::init_vault, page::Page, path::VaultPath};

#[test]
fn new_expands_tilde_in_configured_vault_root() {
    for (configured_root, vault_folder) in [("~/vault", "vault"), ("~", "")] {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("cwd");
        let config_dir = home.join(".config/clepsydra");
        let vault = home.join(vault_folder);
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&config_dir).unwrap();
        init_vault(&vault).unwrap();
        fs::write(
            config_dir.join("config.toml"),
            format!("[vault]\nroot = {configured_root:?}\n"),
        )
        .unwrap();
        fs::write(
            vault.join(".clepsydra/config.toml"),
            "[vault]\ndefault_page_folder = \"notes\"\n",
        )
        .unwrap();

        let output = Command::new(env!("CARGO_BIN_EXE_clep"))
            .args(["new", "Tilde root", "--body", "Written in the home vault."])
            .current_dir(&cwd)
            .env("HOME", &home)
            .env_remove("XDG_CONFIG_HOME")
            .env_remove("CLEPSYDRA__VAULT__ROOT")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "root {configured_root:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let notes = fs::read_dir(vault.join("notes"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(notes.len(), 1);
        let path = VaultPath::new(&format!(
            "notes/{}",
            notes[0].file_name().unwrap().to_str().unwrap()
        ))
        .unwrap();
        let page = Page::from_file(&notes[0], path).unwrap();
        assert_eq!(page.meta.title.as_deref(), Some("Tilde root"));
        assert_eq!(page.body.trim(), "Written in the home vault.");
        assert!(!config_dir.join("~").exists());
    }
}
