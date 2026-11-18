//! Link resolution under incremental index updates.
//!
//! Rule (`VaultIndex::resolve_links`): a link is resolved only when exactly
//! one page holds its canonical name (or its block id). An incremental update
//! must leave every link as a full rebuild over the same files would: when a
//! name gains, loses or changes holders, every link aimed at that name is
//! resolved again, including links that were resolved before.

use std::fs;
use std::path::PathBuf;

use clep_index::index::VaultIndex;
use clep_index::sync::{ChangeEvent, SyncEngine};
use clep_vault::Vault;
use clep_vault::init::init_vault;
use clep_vault::path::VaultPath;
use tempfile::TempDir;

/// (source path, target_raw, path of the page `target_id` points at,
/// `links.target_path`).
type LinkRow = (String, String, Option<String>, Option<String>);

struct Fixture {
    _tmp: TempDir,
    root: PathBuf,
    vault: Vault,
    index: VaultIndex,
}

fn page(id: u32, extra_frontmatter: &str, body: &str) -> String {
    format!(
        "+++\nid = \"00000000-0000-7000-8000-{id:012x}\"\n{extra_frontmatter}\
         created_at = 2026-01-01T00:00:00Z\nupdated_at = 2026-01-01T00:00:00Z\n+++\n{body}\n"
    )
}

/// A link resolved to `target`, or unresolved when `target` is `None`.
fn link(source: &str, raw: &str, target: Option<&str>) -> LinkRow {
    (
        source.to_string(),
        raw.to_string(),
        target.map(str::to_string),
        target.map(str::to_string),
    )
}

fn links_of(index: &VaultIndex) -> Vec<LinkRow> {
    let mut stmt = index
        .connection()
        .prepare(
            "SELECT s.path, l.target_raw, t.path, l.target_path
             FROM links l
             JOIN pages s ON s.id = l.source_id
             LEFT JOIN pages t ON t.id = l.target_id
             ORDER BY s.path, l.span_start",
        )
        .unwrap();
    stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

impl Fixture {
    /// A vault holding `files`, indexed as a server start does.
    fn new(files: &[(&str, &str)]) -> Self {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        init_vault(&root).unwrap();
        let vault = Vault::open(&root).unwrap();
        let root = vault.root().to_path_buf();
        let index = VaultIndex::open_in_memory().unwrap();
        let mut fixture = Fixture {
            _tmp: tmp,
            root,
            vault,
            index,
        };
        for (rel, content) in files {
            fixture.write(rel, content);
        }
        fixture.index.build(&fixture.vault).unwrap();
        fixture.index.resolve_links().unwrap();
        fixture
    }

    fn write(&self, rel: &str, content: &str) {
        let abs = self.root.join(rel);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        fs::write(abs, content).unwrap();
    }

    fn events(&mut self, events: &[ChangeEvent]) {
        SyncEngine::process_events(events, &self.vault, &mut self.index).unwrap();
    }

    /// The links of a brand-new index built over the files now on disk.
    fn rebuilt_links(&self) -> Vec<LinkRow> {
        let mut fresh = VaultIndex::open_in_memory().unwrap();
        fresh.build(&self.vault).unwrap();
        fresh.resolve_links().unwrap();
        links_of(&fresh)
    }

    /// Assert the incremental index and a rebuild both hold `expected`.
    fn assert_links(&self, expected: &[LinkRow]) {
        assert_eq!(self.rebuilt_links(), expected, "full rebuild");
        assert_eq!(links_of(&self.index), expected, "incremental index");
    }
}

fn upsert(rel: &str) -> ChangeEvent {
    ChangeEvent::Upsert(VaultPath::new(rel).unwrap())
}

fn remove(rel: &str) -> ChangeEvent {
    ChangeEvent::Remove(VaultPath::new(rel).unwrap())
}

#[test]
fn new_page_sharing_a_filename_unresolves_links_to_the_first_holder() {
    let mut fx = Fixture::new(&[
        ("a.md", &page(1, "", "one")),
        ("c.md", &page(2, "", "see [[a]]")),
    ]);
    assert_eq!(links_of(&fx.index), vec![link("c.md", "a", Some("a.md"))]);

    fx.write("n/a.md", &page(3, "", "two"));
    fx.events(&[upsert("n/a.md")]);

    fx.assert_links(&[link("c.md", "a", None)]);
}

#[test]
fn alias_colliding_with_another_page_unresolves_links_to_that_name() {
    let mut fx = Fixture::new(&[
        ("a.md", &page(1, "", "one")),
        ("b.md", &page(2, "", "two")),
        ("c.md", &page(3, "", "see [[a]]")),
    ]);
    assert_eq!(links_of(&fx.index), vec![link("c.md", "a", Some("a.md"))]);

    fx.write("b.md", &page(2, "aliases = [\"a\"]\n", "two"));
    fx.events(&[upsert("b.md")]);

    // b.md's alias is a property link to the name "a": ambiguous as well.
    fx.assert_links(&[link("b.md", "a", None), link("c.md", "a", None)]);
}

#[test]
fn removing_the_second_holder_resolves_the_name_again() {
    let mut fx = Fixture::new(&[
        ("a.md", &page(1, "", "one")),
        ("n/a.md", &page(2, "", "two")),
        ("c.md", &page(3, "", "see [[a]]")),
    ]);
    assert_eq!(links_of(&fx.index), vec![link("c.md", "a", None)]);

    fs::remove_file(fx.root.join("n/a.md")).unwrap();
    fx.events(&[remove("n/a.md")]);

    fx.assert_links(&[link("c.md", "a", Some("a.md"))]);
}

#[test]
fn second_page_defining_a_block_id_unresolves_block_refs() {
    let mut fx = Fixture::new(&[
        ("a.md", &page(1, "", "txt ^blk0000001")),
        ("c.md", &page(2, "", "see ((blk0000001))")),
    ]);
    assert_eq!(
        links_of(&fx.index),
        vec![link("c.md", "blk0000001", Some("a.md"))]
    );

    fx.write("b.md", &page(3, "", "txt ^blk0000001"));
    fx.events(&[upsert("b.md")]);

    fx.assert_links(&[link("c.md", "blk0000001", None)]);
}

#[test]
fn reindexing_one_of_two_block_id_holders_keeps_block_refs_unresolved() {
    let mut fx = Fixture::new(&[
        ("a.md", &page(1, "", "txt ^blk0000001")),
        ("b.md", &page(2, "", "txt ^blk0000001")),
        ("c.md", &page(3, "", "see ((blk0000001))")),
    ]);
    assert_eq!(links_of(&fx.index), vec![link("c.md", "blk0000001", None)]);

    fx.write("a.md", &page(1, "", "changed ^blk0000001"));
    fx.events(&[upsert("a.md")]);

    fx.assert_links(&[link("c.md", "blk0000001", None)]);
}

#[test]
fn upsert_of_an_unchanged_page_keeps_its_links_to_itself() {
    let mut fx = Fixture::new(&[(
        "a.md",
        &page(
            1,
            "aliases = [\"zz\"]\n",
            "see [[a]] and ((blk0000001))\n\ntxt ^blk0000001",
        ),
    )]);
    let expected = [
        // The alias is a property link that resolves to its own page.
        link("a.md", "zz", Some("a.md")),
        link("a.md", "a", Some("a.md")),
        link("a.md", "blk0000001", Some("a.md")),
    ];
    assert_eq!(links_of(&fx.index), expected);

    fx.events(&[upsert("a.md")]);

    fx.assert_links(&expected);
}

#[test]
fn duplicate_upsert_in_one_batch_keeps_self_links() {
    let mut fx = Fixture::new(&[]);
    fx.write("a.md", &page(1, "aliases = [\"zz\"]\n", "see [[a]]"));

    fx.events(&[upsert("a.md"), upsert("a.md")]);

    fx.assert_links(&[
        link("a.md", "zz", Some("a.md")),
        link("a.md", "a", Some("a.md")),
    ]);
}

#[test]
fn rename_seen_as_upsert_then_remove_unresolves_links_to_the_old_name() {
    let mut fx = Fixture::new(&[
        ("a.md", &page(1, "", "one")),
        ("c.md", &page(2, "", "see [[a]]")),
    ]);

    fs::rename(fx.root.join("a.md"), fx.root.join("b.md")).unwrap();
    fx.events(&[upsert("b.md"), remove("a.md")]);

    fx.assert_links(&[link("c.md", "a", None)]);
}

#[test]
fn rename_keeps_title_links_resolved_and_updates_their_target_path() {
    let mut fx = Fixture::new(&[
        ("a.md", &page(1, "title = \"Alpha\"\n", "one")),
        ("c.md", &page(2, "", "see [[Alpha]] and [[a]]")),
    ]);

    fs::rename(fx.root.join("a.md"), fx.root.join("b.md")).unwrap();
    fx.events(&[upsert("b.md"), remove("a.md")]);

    fx.assert_links(&[link("c.md", "Alpha", Some("b.md")), link("c.md", "a", None)]);
}

#[test]
fn title_change_moves_links_between_the_old_and_the_new_name() {
    let mut fx = Fixture::new(&[
        ("a.md", &page(1, "title = \"Old\"\n", "one")),
        ("c.md", &page(2, "", "see [[Old]] and [[New]]")),
    ]);

    fx.write("a.md", &page(1, "title = \"New\"\n", "one"));
    fx.events(&[upsert("a.md")]);

    fx.assert_links(&[link("c.md", "Old", None), link("c.md", "New", Some("a.md"))]);
}

#[test]
fn link_by_page_id_resolves_when_the_page_appears() {
    let simple_id = "0000000000007000800000000000000a";
    let mut fx = Fixture::new(&[("c.md", &page(2, "", &format!("see [[{simple_id}]]")))]);
    assert_eq!(links_of(&fx.index), vec![link("c.md", simple_id, None)]);

    fx.write("a.md", &page(10, "", "one"));
    fx.events(&[upsert("a.md")]);

    fx.assert_links(&[link("c.md", simple_id, Some("a.md"))]);
}

/// `index_page` and `remove_page` are called directly too (the LSP on save,
/// the mutation coordinator): they keep the same rule without a caller-side
/// invalidate / re-resolve sequence.
#[test]
fn index_page_and_remove_page_keep_link_resolution_current() {
    let mut fx = Fixture::new(&[
        ("a.md", &page(1, "", "one")),
        ("c.md", &page(2, "", "see [[a]] and [[d]]")),
    ]);
    let second = VaultPath::new("n/a.md").unwrap();
    let new_page = VaultPath::new("d.md").unwrap();

    fx.write("n/a.md", &page(3, "", "two"));
    fx.write("d.md", &page(4, "", "see [[c]]"));
    assert!(fx.index.index_page(&fx.vault, &second).unwrap());
    assert!(fx.index.index_page(&fx.vault, &new_page).unwrap());

    fx.assert_links(&[
        link("c.md", "a", None),
        link("c.md", "d", Some("d.md")),
        link("d.md", "c", Some("c.md")),
    ]);

    fs::remove_file(fx.root.join("n/a.md")).unwrap();
    assert!(fx.index.remove_page(&second).unwrap());

    fx.assert_links(&[
        link("c.md", "a", Some("a.md")),
        link("c.md", "d", Some("d.md")),
        link("d.md", "c", Some("c.md")),
    ]);
}
