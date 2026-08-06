mod support;

use std::fs;

use clepsydra::doctor::{self, DoctorOpts, Status};
use clepsydra::vault::Vault;
use clepsydra::vault::init::init_vault;
use clepsydra::vault::migrate::{legacy_pages, migrate};
use clepsydra::vault::page::parse_frontmatter;
use tempfile::TempDir;

use support::ApiFixture;

const LEGACY_A: &str = "---\nid: 01900000-0000-7000-8000-0000000000a1\ntitle: Alpha\nauthor: Gene Wolfe\ntags:\n  - sf\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-02T00:00:00Z\n---\nAlpha body.\n";
const LEGACY_B: &str = "---\nid: 01900000-0000-7000-8000-0000000000b1\ntitle: Beta\nrating: 4.5\ncreated_at: 2026-02-01T00:00:00Z\nupdated_at: 2026-02-02T00:00:00Z\n---\nBeta body.\n";
const MODERN: &str = "+++\nid = \"01900000-0000-7000-8000-0000000000c1\"\ntitle = \"Gamma\"\ncreated_at = 2026-03-01T00:00:00Z\nupdated_at = 2026-03-02T00:00:00Z\n+++\nGamma body.\n";

fn mixed_vault() -> (TempDir, Vault) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(root.join("alpha.md"), LEGACY_A).unwrap();
    fs::write(root.join("sub/beta.md"), LEGACY_B).unwrap();
    fs::write(root.join("gamma.md"), MODERN).unwrap();
    let vault = Vault::open(&root).unwrap();
    (tmp, vault)
}

fn write_top_level_config(dir: &std::path::Path, vault_root: &std::path::Path) {
    fs::write(
        dir.join("config.toml"),
        format!(
            "[server]\nhost = \"localhost\"\nport = 0\n\n[vault]\nroot = \"{}\"\n",
            vault_root.display()
        ),
    )
    .unwrap();
}

#[test]
fn dry_run_reports_and_writes_nothing() {
    let (_tmp, vault) = mixed_vault();

    let report = migrate(&vault, false);
    assert!(report.dry_run);
    assert_eq!(report.converted, vec!["alpha.md", "sub/beta.md"]);
    assert!(report.warnings.is_empty());

    assert_eq!(
        fs::read_to_string(vault.root().join("alpha.md")).unwrap(),
        LEGACY_A
    );
    assert_eq!(
        fs::read_to_string(vault.root().join("sub/beta.md")).unwrap(),
        LEGACY_B
    );
}

#[test]
fn write_converts_all_legacy_pages_and_is_idempotent() {
    let (_tmp, vault) = mixed_vault();

    let report = migrate(&vault, true);
    assert_eq!(report.converted, vec!["alpha.md", "sub/beta.md"]);
    assert!(report.warnings.is_empty());

    // Every page now carries TOML frontmatter with id and extras intact.
    let alpha = fs::read_to_string(vault.root().join("alpha.md")).unwrap();
    assert!(alpha.starts_with("+++\n"));
    let (meta, body) = parse_frontmatter(&alpha).unwrap();
    assert_eq!(meta.id.to_string(), "01900000-0000-7000-8000-0000000000a1");
    assert_eq!(meta.title.as_deref(), Some("Alpha"));
    assert_eq!(meta.tags, vec!["sf"]);
    assert_eq!(
        meta.extra["author"],
        toml::Value::String("Gene Wolfe".into())
    );
    assert_eq!(
        meta.updated_at.unwrap().to_rfc3339(),
        "2026-01-02T00:00:00+00:00",
        "conversion must not bump timestamps"
    );
    assert_eq!(body, "Alpha body.\n");

    let beta = fs::read_to_string(vault.root().join("sub/beta.md")).unwrap();
    let (beta_meta, _) = parse_frontmatter(&beta).unwrap();
    assert_eq!(beta_meta.extra["rating"], toml::Value::Float(4.5));

    // The already-TOML page is untouched byte-for-byte.
    assert_eq!(
        fs::read_to_string(vault.root().join("gamma.md")).unwrap(),
        MODERN
    );

    // Second run is a no-op.
    let again = migrate(&vault, true);
    assert!(again.converted.is_empty());
    assert!(again.warnings.is_empty());
    assert!(legacy_pages(&vault).is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn doctor_census_counts_before_and_after() {
    let (tmp, vault) = mixed_vault();
    write_top_level_config(tmp.path(), vault.root());

    // Before: two legacy pages in the census.
    let report = doctor::run_with_cwd(tmp.path(), DoctorOpts::default()).await;
    let census = report
        .results
        .iter()
        .find(|r| r.section == "frontmatter" && r.name == "legacy census")
        .expect("legacy census check");
    assert_eq!(census.status, Status::Info);
    assert!(census.detail.contains("2 legacy"), "{}", census.detail);
    assert!(census.detail.contains("alpha.md"), "{}", census.detail);
    assert!(census.detail.contains("sub/beta.md"), "{}", census.detail);

    // Sweep, then the census reads zero.
    migrate(&vault, true);
    let report = doctor::run_with_cwd(tmp.path(), DoctorOpts::default()).await;
    let census = report
        .results
        .iter()
        .find(|r| r.section == "frontmatter" && r.name == "legacy census")
        .expect("legacy census check");
    assert_eq!(census.status, Status::Ok, "{}", census.detail);
}

#[tokio::test]
async fn mutation_on_legacy_page_heals_to_toml() {
    // A complete legacy page (id + timestamps) survives indexing as `---`;
    // only a coordinator mutation converts it — heal-on-touch.
    let (server, dir) = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::write(root.join("legacy.md"), LEGACY_A).unwrap();
        })
        .build()
        .into_server_and_temp();

    let on_disk = fs::read_to_string(dir.path().join("vault/legacy.md")).unwrap();
    assert!(
        on_disk.starts_with("---\n"),
        "indexing alone must not convert a clean legacy page: {on_disk}"
    );

    let detail = server.get("/api/vault/pages/legacy.md").await;
    detail.assert_status_ok();
    let page: serde_json::Value = detail.json();
    let revision = page["revision"].as_str().unwrap();

    server
        .put("/api/vault/pages/legacy.md")
        .json(&serde_json::json!({
            "expected_revision": revision,
            "title": "Alpha Healed",
        }))
        .await
        .assert_status_ok();

    let healed = fs::read_to_string(dir.path().join("vault/legacy.md")).unwrap();
    assert!(
        healed.starts_with("+++\n"),
        "update must heal the page to TOML: {healed}"
    );
    let (meta, _) = parse_frontmatter(&healed).unwrap();
    assert_eq!(meta.id.to_string(), "01900000-0000-7000-8000-0000000000a1");
    assert_eq!(meta.title.as_deref(), Some("Alpha Healed"));
    assert_eq!(
        meta.extra["author"],
        toml::Value::String("Gene Wolfe".into()),
        "extras must survive the heal"
    );
}
