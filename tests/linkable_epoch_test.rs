use std::fs;

use clepsydra::vault::Vault;
use clepsydra::vault::base::{BaseLinkableProperties, BaseRegistry, effective_linkable_properties};
use clepsydra::vault::index::{ConfigLinkableProperties, VaultIndex, linkable_epoch};
use clepsydra::vault::path::VaultPath;

const SERIES_PAGE: &str = "+++\nid = \"0190f8a0-0000-7000-8000-0000000000e1\"\ntitle = \"Book\"\nseries = [\"[[Solar Cycle]]\"]\n+++\nbody\n";
const SERIES_BASE: &str = "name = \"Reading\"\n\n[properties]\nseries = { type = \"relation\" }\n";

fn setup(with_base: bool) -> (tempfile::TempDir, Vault, VaultIndex) {
    let tmp = tempfile::tempdir().unwrap();
    fs::write(tmp.path().join("book.md"), SERIES_PAGE).unwrap();
    if with_base {
        fs::create_dir_all(tmp.path().join("bases")).unwrap();
        fs::write(tmp.path().join("bases/reading.base.toml"), SERIES_BASE).unwrap();
    }
    let index = VaultIndex::open(&tmp.path().join(".clepsydra/index.db"))
        .unwrap()
        .with_linkable_properties(Box::new(BaseLinkableProperties));
    let vault = Vault::open(tmp.path()).unwrap();
    (tmp, vault, index)
}

/// The seam: the same vault indexes with or without base relations
/// depending only on the injected provider. Neither adapter is special
/// to the index.
#[test]
fn provider_decides_whether_base_relations_are_linkable() {
    let tmp = tempfile::tempdir().unwrap();
    fs::write(tmp.path().join("book.md"), SERIES_PAGE).unwrap();
    fs::create_dir_all(tmp.path().join("bases")).unwrap();
    fs::write(tmp.path().join("bases/reading.base.toml"), SERIES_BASE).unwrap();
    let vault = Vault::open(tmp.path()).unwrap();

    let mut config_only = VaultIndex::open_in_memory()
        .unwrap()
        .with_linkable_properties(Box::new(ConfigLinkableProperties));
    config_only.build(&vault).unwrap();
    assert_eq!(
        series_link_count(&config_only),
        0,
        "config-only ignores the base"
    );

    let mut base_aware = VaultIndex::open_in_memory()
        .unwrap()
        .with_linkable_properties(Box::new(BaseLinkableProperties));
    base_aware.build(&vault).unwrap();
    assert_eq!(
        series_link_count(&base_aware),
        1,
        "bases adapter links `series`"
    );
}

fn series_link_count(index: &VaultIndex) -> i64 {
    index
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM links WHERE source_field = 'series'",
            [],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn registry_loads_bases_and_effective_set_unions_config() {
    let (tmp, vault, _index) = setup(true);
    let registry = BaseRegistry::load(tmp.path());
    assert_eq!(registry.bases.len(), 1);
    assert_eq!(registry.bases[0].slug, "reading");
    assert_eq!(registry.relation_property_keys(), vec!["series"]);

    let effective =
        effective_linkable_properties(&vault.config().vault.linkable_properties, &registry);
    assert!(effective.contains(&"tags".to_string()));
    assert!(effective.contains(&"series".to_string()));
    // Union is deduped even when config already carries the key.
    let mut with_dup = vault.config().vault.linkable_properties.clone();
    with_dup.push("series".to_string());
    let deduped = effective_linkable_properties(&with_dup, &registry);
    assert_eq!(
        deduped.iter().filter(|k| *k == "series").count(),
        1,
        "duplicate keys collapse"
    );
}

/// A vault whose config predates the `attendees` default still collects
/// the meeting → person backlinks: the relation is built in, not opted
/// into (see `BUILTIN_RELATION_PROPERTIES`).
#[test]
fn legacy_config_still_links_attendees() {
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir_all(tmp.path().join(".clepsydra")).unwrap();
    fs::write(
        tmp.path().join(".clepsydra/config.toml"),
        "[vault]\nlinkable_properties = [\"tags\", \"aliases\"]\n",
    )
    .unwrap();
    fs::write(
        tmp.path().join("kickoff.md"),
        "+++\nid = \"0190f8a0-0000-7000-8000-0000000000e2\"\ntitle = \"Kickoff\"\ntype = \"MEETING\"\nattendees = [\"[[Ada Lovelace]]\"]\n+++\nbody\n",
    )
    .unwrap();
    fs::write(
        tmp.path().join("ada-lovelace.md"),
        "+++\nid = \"0190f8a0-0000-7000-8000-0000000000e3\"\ntitle = \"Ada Lovelace\"\ntype = \"PERSON\"\n+++\nbody\n",
    )
    .unwrap();

    let mut index = VaultIndex::open(&tmp.path().join(".clepsydra/index.db")).unwrap();
    let vault = Vault::open(tmp.path()).unwrap();
    assert!(
        !vault
            .config()
            .vault
            .linkable_properties
            .iter()
            .any(|k| k == "attendees"),
        "the fixture config must be the legacy one"
    );
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let backlinks = index
        .backlinks_with_context(&vault, &VaultPath::new("ada-lovelace.md").unwrap(), 200)
        .unwrap();
    assert_eq!(backlinks.len(), 1, "the meeting backlinks the person page");
    assert_eq!(backlinks[0].source_path, "kickoff.md");
    assert_eq!(backlinks[0].kind, "property_ref");
}

#[test]
fn derivation_meta_created_and_epoch_written_by_build() {
    let (_tmp, vault, mut index) = setup(false);
    index.build(&vault).unwrap();
    let epoch: String = index
        .connection()
        .query_row(
            "SELECT value FROM derivation_meta WHERE key = 'linkable_epoch'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(epoch.len(), 64);
    assert_eq!(
        epoch,
        linkable_epoch(&vault.config().vault.linkable_properties)
    );
}

#[test]
fn epoch_mismatch_rederives_unchanged_page_links() {
    // Build once WITHOUT the base: `series` is not linkable, no link rows.
    let (tmp, vault, mut index) = setup(false);
    index.build(&vault).unwrap();
    assert_eq!(series_link_count(&index), 0);

    // Add the base declaring `series = relation`. The page file itself is
    // untouched — without the epoch check, skip-unchanged would silently
    // keep its stale link set.
    fs::create_dir_all(tmp.path().join("bases")).unwrap();
    fs::write(tmp.path().join("bases/reading.base.toml"), SERIES_BASE).unwrap();

    let stats = index.build(&vault).unwrap();
    assert_eq!(stats.pages_skipped, 0, "epoch mismatch must bypass skip");
    assert_eq!(
        series_link_count(&index),
        1,
        "unchanged page's series link must appear after the epoch rebuild"
    );

    // Epoch is now stable: the next build skips unchanged pages again.
    let stats = index.build(&vault).unwrap();
    assert!(stats.pages_skipped >= 1, "no-op rebuild must skip");
    assert_eq!(series_link_count(&index), 1);
}
