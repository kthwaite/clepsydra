//! Frontmatter migration sweep: legacy `---` YAML pages → `+++` TOML.
//!
//! Heal-on-touch converts pages as a side effect of ordinary mutations; this
//! sweep converts the remainder in one pass. Dry-run by default — the CLI only
//! writes with `--write`. The doctor legacy census shares [`legacy_pages`].

use walkdir::WalkDir;

use super::Vault;
use super::atomic_file::atomic_replace;
use super::legacy_yaml;
use super::page::write_page_content;
use super::path::VaultPath;

/// Outcome of a migration sweep (or dry run).
#[derive(Debug, Default)]
pub struct MigrateReport {
    /// Legacy pages converted (or, on a dry run, that would be converted).
    pub converted: Vec<String>,
    /// Pages skipped with a problem (unparseable YAML, IO error).
    pub warnings: Vec<String>,
    pub dry_run: bool,
}

/// Walk the vault and return every non-excluded `.md` page whose frontmatter
/// is legacy `---` YAML. Read-only; shared by `clep migrate` and the doctor
/// census.
pub fn legacy_pages(vault: &Vault) -> Vec<VaultPath> {
    let mut out = Vec::new();
    for entry in WalkDir::new(vault.root())
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
    {
        let Ok(rel_path) = entry.path().strip_prefix(vault.root()) else {
            continue;
        };
        let rel_str = rel_path.to_string_lossy().replace('\\', "/");
        if rel_str.starts_with(".clepsydra/") {
            continue;
        }
        let Ok(vault_path) = VaultPath::new(&rel_str) else {
            continue;
        };
        if vault.is_excluded(&vault_path) {
            continue;
        }
        match std::fs::read_to_string(entry.path()) {
            Ok(content) if content.starts_with("---") => out.push(vault_path),
            _ => {}
        }
    }
    out.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    out
}

/// Convert every legacy `---` page to TOML frontmatter via legacy-parse →
/// full TOML serialization → atomic write. With `write = false` (dry run),
/// reports what would convert and touches nothing.
///
/// Unparseable frontmatter is reported and left alone — the sweep never
/// destroys what it cannot read.
pub fn migrate(vault: &Vault, write: bool) -> MigrateReport {
    migrate_with_publication(vault, write, atomic_replace)
}

fn migrate_with_publication(
    vault: &Vault,
    write: bool,
    mut publish: impl FnMut(
        &std::path::Path,
        &[u8],
    ) -> Result<(), super::atomic_file::AtomicPublicationError>,
) -> MigrateReport {
    let mut report = MigrateReport {
        dry_run: !write,
        ..Default::default()
    };

    for vault_path in legacy_pages(vault) {
        let abs = vault.resolve(&vault_path);
        let content = match std::fs::read_to_string(&abs) {
            Ok(c) => c,
            Err(e) => {
                report
                    .warnings
                    .push(format!("{}: cannot read: {e}", vault_path.as_str()));
                continue;
            }
        };

        let (meta, body, _rewrote, warning) = legacy_yaml::parse_or_repair_frontmatter(&content);
        if let Some(w) = warning {
            report
                .warnings
                .push(format!("{}: {w}", vault_path.as_str()));
            continue;
        }

        if write {
            let new_content = write_page_content(&meta, &body);
            if let Err(e) = publish(&abs, new_content.as_bytes()) {
                report
                    .warnings
                    .push(format!("{}: write failed: {e}", vault_path.as_str()));
                continue;
            }
        }
        report.converted.push(vault_path.as_str().to_string());
    }

    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::page::parse_frontmatter;

    fn make_vault(pages: &[(&str, &str)]) -> (tempfile::TempDir, Vault) {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        for (rel, content) in pages {
            let abs = root.join(rel);
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(abs, content).unwrap();
        }
        let vault = Vault::open(&root).unwrap();
        (tmp, vault)
    }

    const LEGACY: &str = "---\nid: 01900000-0000-7000-8000-000000000001\ntitle: Legacy\nauthor: Gene Wolfe\nrating: 4.5\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-02T00:00:00Z\n---\nBody stays.\n";
    const MODERN: &str = "+++\nid = \"01900000-0000-7000-8000-000000000002\"\ntitle = \"Modern\"\n+++\nAlready TOML.\n";

    #[test]
    fn dry_run_reports_but_writes_nothing() {
        let (_tmp, vault) = make_vault(&[("legacy.md", LEGACY), ("modern.md", MODERN)]);
        let report = migrate(&vault, false);
        assert!(report.dry_run);
        assert_eq!(report.converted, vec!["legacy.md"]);
        assert!(report.warnings.is_empty());
        // Nothing touched on disk.
        let content =
            std::fs::read_to_string(vault.resolve(&VaultPath::new("legacy.md").unwrap())).unwrap();
        assert_eq!(content, LEGACY);
    }

    #[test]
    fn write_converts_preserving_id_and_extras() {
        let (_tmp, vault) = make_vault(&[("legacy.md", LEGACY), ("modern.md", MODERN)]);
        let report = migrate(&vault, true);
        assert_eq!(report.converted, vec!["legacy.md"]);

        let content =
            std::fs::read_to_string(vault.resolve(&VaultPath::new("legacy.md").unwrap())).unwrap();
        assert!(content.starts_with("+++\n"), "converted page must be TOML");
        let (meta, body) = parse_frontmatter(&content).unwrap();
        assert_eq!(
            meta.id.to_string(),
            "01900000-0000-7000-8000-000000000001",
            "id preserved"
        );
        assert_eq!(meta.title.as_deref(), Some("Legacy"));
        assert_eq!(
            meta.extra["author"],
            toml::Value::String("Gene Wolfe".into())
        );
        assert_eq!(meta.extra["rating"], toml::Value::Float(4.5));
        assert_eq!(
            meta.updated_at.unwrap().to_rfc3339(),
            "2026-01-02T00:00:00+00:00",
            "timestamps not bumped"
        );
        assert_eq!(body, "Body stays.\n");

        // Second run is a no-op.
        let again = migrate(&vault, true);
        assert!(again.converted.is_empty());
        assert!(again.warnings.is_empty());
    }

    #[test]
    fn unparseable_yaml_is_reported_and_left_alone() {
        let broken = "---\n: :\nbad {{{\n---\nBody\n";
        let (_tmp, vault) = make_vault(&[("broken.md", broken)]);
        let report = migrate(&vault, true);
        assert!(report.converted.is_empty());
        assert_eq!(report.warnings.len(), 1);
        let content =
            std::fs::read_to_string(vault.resolve(&VaultPath::new("broken.md").unwrap())).unwrap();
        assert_eq!(content, broken, "unparseable page must not be touched");
    }

    #[test]
    fn census_counts_only_legacy_pages() {
        let (_tmp, vault) = make_vault(&[
            ("a.md", LEGACY),
            ("sub/b.md", LEGACY),
            ("modern.md", MODERN),
            ("plain.md", "no frontmatter\n"),
        ]);
        let pages = legacy_pages(&vault);
        let paths: Vec<&str> = pages.iter().map(|p| p.as_str()).collect();
        assert_eq!(paths, vec!["a.md", "sub/b.md"]);
    }

    #[test]
    fn publication_failure_preserves_page_and_continues() {
        let (_tmp, vault) = make_vault(&[("a.md", LEGACY), ("b.md", LEGACY)]);

        let report = migrate_with_publication(&vault, true, |path, content| {
            if path.ends_with("a.md") {
                Err(
                    crate::vault::atomic_file::AtomicPublicationError::NotPublished(
                        std::io::Error::other("injected migration publication failure"),
                    ),
                )
            } else {
                crate::vault::atomic_file::atomic_replace(path, content)
            }
        });

        assert_eq!(report.converted, vec!["b.md"]);
        assert_eq!(report.warnings.len(), 1);
        assert!(report.warnings[0].contains("injected migration publication failure"));
        assert_eq!(
            std::fs::read_to_string(vault.root().join("a.md")).unwrap(),
            LEGACY
        );
        assert!(
            std::fs::read_to_string(vault.root().join("b.md"))
                .unwrap()
                .starts_with("+++\n")
        );
    }
}
