//! What happens to links when a page or folder is renamed or moved: every
//! link that resolved to a page before the move resolves to it afterwards.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use clep_index::index::VaultIndex;
use clep_index::index_handle::IndexHandle;
use clep_mutate::mutation::{MutationOp, MutationPlan, MutationPlanner};
use clep_mutate::mutation_coordinator::{MutationCoordinator, MutationNotification};
use clep_vault::Vault;
use clep_vault::init::init_vault;
use tempfile::TempDir;
use uuid::Uuid;

static RT: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap()
});

fn id(n: u128) -> Uuid {
    Uuid::from_u128(0x019f_d000_0000_7000_8000_0000_0000_0000 + n)
}

/// A page file with fixed frontmatter; `extra` is appended verbatim inside
/// the frontmatter (e.g. `title = "X"\n`).
fn page(n: u128, extra: &str, body: &str) -> String {
    format!(
        "+++\nid = \"{}\"\n{extra}created_at = 2026-01-02T03:04:05Z\nupdated_at = 2026-01-02T03:04:05Z\n+++\n{body}",
        id(n)
    )
}

struct Fixture {
    _temp: TempDir,
    root: PathBuf,
    vault: Vault,
    coordinator: MutationCoordinator,
    index: IndexHandle,
}

impl Fixture {
    fn new(files: &[(&str, String)]) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        init_vault(&root).unwrap();
        let vault = Vault::open(&root).unwrap();
        let root = vault.root().to_path_buf();
        for (path, content) in files {
            let absolute = root.join(path);
            fs::create_dir_all(absolute.parent().unwrap()).unwrap();
            fs::write(absolute, content).unwrap();
        }
        let mut index = VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
        index.build(&vault).unwrap();
        index.resolve_links().unwrap();
        Self {
            _temp: temp,
            root,
            vault: vault.clone(),
            coordinator: MutationCoordinator::new(),
            index: IndexHandle::spawn(index, vault),
        }
    }

    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.root.join(path)).unwrap()
    }

    fn plan(&self, op: MutationOp) -> MutationPlan {
        RT.block_on(
            self.index
                .with_index(move |index, vault| MutationPlanner::new(vault, index).plan(&op)),
        )
        .unwrap()
        .unwrap()
    }

    fn apply(&self, plan: MutationPlan) {
        let command = plan.into_batch_command(&self.vault).unwrap();
        let notifier: Arc<dyn Fn(MutationNotification) + Send + Sync> = Arc::new(|_| {});
        RT.block_on(self.coordinator.execute_batch(
            &self.vault,
            &self.index,
            Arc::new(Vec::new()),
            command,
            notifier,
        ))
        .unwrap();
    }

    fn move_page(&self, source: &str, destination: &str) {
        self.apply(self.plan(MutationOp::MovePage {
            source: source.into(),
            destination: destination.into(),
        }));
    }

    fn move_folder(&self, source: &str, destination: &str) {
        self.apply(self.plan(MutationOp::MoveFolder {
            source: source.into(),
            destination: destination.into(),
        }));
    }

    /// `(target_raw, resolved target path)` of every link in `source`, as the
    /// coordinator-maintained index sees it.
    fn links(&self, source: &'static str) -> Vec<(String, Option<String>)> {
        RT.block_on(
            self.index
                .with_index(move |index, _| link_rows(index, source)),
        )
        .unwrap()
    }

    /// The same rows from a fresh index built from disk.
    fn rebuilt_links(&self, source: &str) -> Vec<(String, Option<String>)> {
        let mut index = VaultIndex::open_in_memory().unwrap();
        index.build(&self.vault).unwrap();
        index.resolve_links().unwrap();
        link_rows(&index, source)
    }
}

fn link_rows(index: &VaultIndex, source: &str) -> Vec<(String, Option<String>)> {
    let mut statement = index
        .connection()
        .prepare(
            "SELECT l.target_raw, l.target_path FROM links l
             JOIN pages p ON p.id = l.source_id
             WHERE p.path = ?1 ORDER BY l.span_start",
        )
        .unwrap();
    statement
        .query_map([source], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn row(raw: &str, target: Option<&str>) -> (String, Option<String>) {
    (raw.to_string(), target.map(str::to_string))
}

// ---------------------------------------------------------------------------
// Links inside the moved pages
// ---------------------------------------------------------------------------

#[test]
fn renaming_a_page_rewrites_its_links_to_itself() {
    let fixture = Fixture::new(&[
        ("a.md", page(1, "", "[[a]] and ![[a|me]]\n")),
        ("other.md", page(2, "", "[[a]]\n")),
    ]);
    assert_eq!(
        fixture.links("a.md"),
        vec![row("a", Some("a.md")), row("a", Some("a.md"))]
    );

    fixture.move_page("a.md", "b.md");

    assert_eq!(fixture.read("b.md"), page(1, "", "[[b]] and ![[b|me]]\n"));
    assert_eq!(fixture.read("other.md"), page(2, "", "[[b]]\n"));
    assert!(!fixture.root.join("a.md").exists());
    let resolved = vec![row("b", Some("b.md")), row("b", Some("b.md"))];
    assert_eq!(fixture.links("b.md"), resolved);
    assert_eq!(fixture.rebuilt_links("b.md"), resolved);
}

#[test]
fn page_move_preview_lists_the_moved_page_at_its_destination() {
    let fixture = Fixture::new(&[("box/a.md", page(1, "", "[[box/a]]\n"))]);

    let plan = fixture.plan(MutationOp::MovePage {
        source: "box/a.md".into(),
        destination: "arch/a.md".into(),
    });

    // The preview names the file as it will exist after the move.
    assert_eq!(plan.staged_writes.len(), 1);
    assert_eq!(plan.staged_writes[0].path, fixture.root.join("arch/a.md"));
    assert_eq!(plan.staged_writes[0].content, page(1, "", "[[arch/a]]\n"));
    assert!(plan.text_edits.iter().all(|edit| edit.path == "arch/a.md"));
    assert!(!plan.text_edits.is_empty());
    // Planning is a dry run.
    assert_eq!(fixture.read("box/a.md"), page(1, "", "[[box/a]]\n"));

    fixture.apply(plan);
    assert_eq!(fixture.read("arch/a.md"), page(1, "", "[[arch/a]]\n"));
    assert!(!fixture.root.join("box/a.md").exists());
}

#[test]
fn renaming_a_page_without_links_to_itself_keeps_its_bytes() {
    let content = page(1, "", "[[other]] and plain a\n");
    let fixture = Fixture::new(&[
        ("a.md", content.clone()),
        ("other.md", page(2, "", "two\n")),
    ]);

    let plan = fixture.plan(MutationOp::MovePage {
        source: "a.md".into(),
        destination: "b.md".into(),
    });
    assert!(plan.staged_writes.is_empty());
    fixture.apply(plan);

    assert_eq!(fixture.read("b.md"), content);
}

#[test]
fn folder_move_rewrites_path_links_between_the_moved_pages() {
    let fixture = Fixture::new(&[
        ("box/a.md", page(1, "", "[[box/b]] [[box/a]] [[b]]\n")),
        ("box/b.md", page(2, "", "[[box/a|first]]\n")),
        ("box/deep/c.md", page(3, "", "[[box/b.md]]\n")),
        ("out.md", page(4, "", "[[box/b]]\n")),
    ]);
    assert_eq!(
        fixture.links("box/a.md"),
        vec![
            row("box/b", Some("box/b.md")),
            row("box/a", Some("box/a.md")),
            row("b", Some("box/b.md")),
        ]
    );

    fixture.move_folder("box", "arch");

    assert_eq!(fixture.read("out.md"), page(4, "", "[[arch/b]]\n"));
    assert_eq!(
        fixture.read("arch/a.md"),
        page(1, "", "[[arch/b]] [[arch/a]] [[b]]\n")
    );
    assert_eq!(fixture.read("arch/b.md"), page(2, "", "[[arch/a|first]]\n"));
    assert_eq!(
        fixture.read("arch/deep/c.md"),
        page(3, "", "[[arch/b.md]]\n")
    );
    assert!(!fixture.root.join("box").exists());
    let resolved = vec![
        row("arch/b", Some("arch/b.md")),
        row("arch/a", Some("arch/a.md")),
        row("b", Some("arch/b.md")),
    ];
    assert_eq!(fixture.links("arch/a.md"), resolved);
    assert_eq!(fixture.rebuilt_links("arch/a.md"), resolved);
    assert_eq!(
        fixture.links("arch/deep/c.md"),
        vec![row("arch/b.md", Some("arch/b.md"))]
    );
}

// ---------------------------------------------------------------------------
// Which links follow a move: those that resolve to the moved page
// ---------------------------------------------------------------------------

fn targets(rows: Vec<(String, Option<String>)>) -> Vec<Option<String>> {
    rows.into_iter().map(|(_, target)| target).collect()
}

#[test]
fn wikilinks_follow_a_rename_however_the_name_is_spelled() {
    let fixture = Fixture::new(&[
        ("alpha.md", page(1, "", "one\n")),
        (
            "b.md",
            page(
                2,
                "",
                "[[Alpha]] [[alpha.md]] [[ alpha ]] [[ALPHA.MD|shown]] ![[alpha]]\n",
            ),
        ),
    ]);
    assert_eq!(
        targets(fixture.links("b.md")),
        vec![Some("alpha.md".to_string()); 5]
    );

    fixture.move_page("alpha.md", "beta.md");

    assert_eq!(
        fixture.read("b.md"),
        page(
            2,
            "",
            "[[beta]] [[beta.md]] [[beta]] [[beta.md|shown]] ![[beta]]\n"
        )
    );
    assert_eq!(
        targets(fixture.links("b.md")),
        vec![Some("beta.md".to_string()); 5]
    );
    assert_eq!(
        targets(fixture.rebuilt_links("b.md")),
        vec![Some("beta.md".to_string()); 5]
    );
}

#[test]
fn path_form_wikilinks_follow_a_move_however_the_path_is_spelled() {
    let fixture = Fixture::new(&[
        ("box/alpha.md", page(1, "", "one\n")),
        (
            "b.md",
            page(2, "", "[[Box/Alpha]] [[box/alpha.md]] [[alpha]]\n"),
        ),
    ]);

    fixture.move_page("box/alpha.md", "arch/beta.md");

    assert_eq!(
        fixture.read("b.md"),
        page(2, "", "[[arch/beta]] [[arch/beta.md]] [[beta]]\n")
    );
    assert_eq!(
        targets(fixture.rebuilt_links("b.md")),
        vec![Some("arch/beta.md".to_string()); 3]
    );
}

#[test]
fn links_by_title_alias_or_id_are_left_as_written() {
    let body = format!("[[First Page]] [[the first]] [[{}]]\n", id(1));
    let fixture = Fixture::new(&[
        (
            "alpha.md",
            page(
                1,
                "title = \"First Page\"\naliases = [\"The First\"]\n",
                "one\n",
            ),
        ),
        ("b.md", page(2, "", &body)),
    ]);
    assert_eq!(
        targets(fixture.links("b.md")),
        vec![Some("alpha.md".to_string()); 3]
    );

    let plan = fixture.plan(MutationOp::MovePage {
        source: "alpha.md".into(),
        destination: "beta.md".into(),
    });
    assert!(plan.staged_writes.is_empty());
    assert!(plan.text_edits.is_empty());
    fixture.apply(plan);

    assert_eq!(fixture.read("b.md"), page(2, "", &body));
    assert_eq!(
        targets(fixture.rebuilt_links("b.md")),
        vec![Some("beta.md".to_string()); 3]
    );
}

#[test]
fn a_name_that_is_also_the_title_follows_the_file_only_when_spelled_as_the_file() {
    let fixture = Fixture::new(&[
        ("target.md", page(1, "title = \"Target\"\n", "one\n")),
        ("b.md", page(2, "", "[[Target]] [[target]] [[TARGET]]\n")),
    ]);

    fixture.move_page("target.md", "renamed.md");

    // `Target` in any case still names the page through its title.
    assert_eq!(
        fixture.read("b.md"),
        page(2, "", "[[Target]] [[renamed]] [[TARGET]]\n")
    );
    assert_eq!(
        targets(fixture.rebuilt_links("b.md")),
        vec![Some("renamed.md".to_string()); 3]
    );
}

#[test]
fn source_relative_markdown_urls_are_still_rewritten() {
    let fixture = Fixture::new(&[
        ("people/ada.md", page(1, "", "one\n")),
        (
            "notes/b.md",
            page(2, "", "[[people/ada]] [p](../people/ada.md)\n"),
        ),
    ]);
    assert_eq!(
        fixture.links("notes/b.md"),
        vec![
            row("people/ada", Some("people/ada.md")),
            row("../people/ada.md", None),
        ]
    );

    fixture.move_page("people/ada.md", "people/moved.md");

    assert_eq!(
        fixture.read("notes/b.md"),
        page(2, "", "[[people/moved]] [p](../people/moved.md)\n")
    );
}

#[test]
fn an_ambiguous_link_is_not_claimed_by_the_page_that_moves() {
    let fixture = Fixture::new(&[
        ("alpha.md", page(1, "", "one\n")),
        ("box/alpha.md", page(2, "", "two\n")),
        (
            "b.md",
            page(3, "", "[[alpha]] [x](alpha.md) [[box/alpha]]\n"),
        ),
    ]);
    assert_eq!(
        fixture.links("b.md"),
        vec![
            row("alpha", None),
            row("alpha.md", None),
            row("box/alpha", Some("box/alpha.md")),
        ]
    );

    fixture.move_page("box/alpha.md", "box/gamma.md");

    assert_eq!(
        fixture.read("b.md"),
        page(3, "", "[[alpha]] [x](alpha.md) [[box/gamma]]\n")
    );
    assert_eq!(
        fixture.rebuilt_links("b.md"),
        vec![
            row("alpha", Some("alpha.md")),
            row("alpha.md", Some("alpha.md")),
            row("box/gamma", Some("box/gamma.md")),
        ]
    );
}

#[test]
fn folder_move_rewrites_each_referrer_once_for_all_moved_pages() {
    let fixture = Fixture::new(&[
        ("box/a.md", page(1, "", "[x](b.md) [[Box/B]]\n")),
        ("box/b.md", page(2, "", "two\n")),
        (
            "out.md",
            page(
                3,
                "",
                "[[box/a]] [[BOX/B.md|second]] [y](box/a.md) [[a]] [[b]]\n",
            ),
        ),
    ]);

    let plan = fixture.plan(MutationOp::MoveFolder {
        source: "box".into(),
        destination: "arch".into(),
    });
    let mut staged: Vec<_> = plan
        .staged_writes
        .iter()
        .map(|write| write.path.clone())
        .collect();
    staged.sort();
    assert_eq!(
        staged,
        vec![fixture.root.join("arch/a.md"), fixture.root.join("out.md")]
    );
    fixture.apply(plan);

    assert_eq!(
        fixture.read("out.md"),
        page(
            3,
            "",
            "[[arch/a]] [[arch/b.md|second]] [y](arch/a.md) [[a]] [[b]]\n"
        )
    );
    assert_eq!(
        fixture.read("arch/a.md"),
        page(1, "", "[x](b.md) [[arch/b]]\n")
    );
    assert_eq!(
        targets(fixture.rebuilt_links("out.md")),
        vec![
            Some("arch/a.md".to_string()),
            Some("arch/b.md".to_string()),
            Some("arch/a.md".to_string()),
            Some("arch/a.md".to_string()),
            Some("arch/b.md".to_string()),
        ]
    );
    assert_eq!(
        targets(fixture.rebuilt_links("arch/a.md")),
        vec![Some("arch/b.md".to_string()); 2]
    );
}

// ---------------------------------------------------------------------------
// Bare property references
// ---------------------------------------------------------------------------

#[test]
fn bare_relation_property_values_follow_a_rename() {
    let frontmatter = "# people\nattendees = [\n  \"Alpha\", # chair\n  \"[[alpha|A]]\",\n  \"other\",\n]\nlink = \" alpha.md \"\nnote = \"alpha\"\n";
    let fixture = Fixture::new(&[
        ("alpha.md", page(1, "", "one\n")),
        ("other.md", page(2, "", "two\n")),
        ("b.md", page(3, frontmatter, "three\n")),
    ]);
    let sorted_targets = |rows| {
        let mut targets = targets(rows);
        targets.sort();
        targets
    };
    let alpha = Some("alpha.md".to_string());
    let other = Some("other.md".to_string());
    assert_eq!(
        sorted_targets(fixture.links("b.md")),
        vec![alpha.clone(), alpha.clone(), alpha, other.clone()]
    );

    fixture.move_page("alpha.md", "beta.md");

    // Only the values that resolved to the page change; comments, layout,
    // padding and the non-linkable `note` are kept.
    assert_eq!(
        fixture.read("b.md"),
        page(
            3,
            "# people\nattendees = [\n  \"beta\", # chair\n  \"[[beta|A]]\",\n  \"other\",\n]\nlink = \" beta.md \"\nnote = \"alpha\"\n",
            "three\n"
        )
    );
    let beta = Some("beta.md".to_string());
    let resolved = vec![beta.clone(), beta.clone(), beta, other];
    assert_eq!(sorted_targets(fixture.links("b.md")), resolved);
    assert_eq!(sorted_targets(fixture.rebuilt_links("b.md")), resolved);
}

#[test]
fn a_bare_property_reference_inside_a_moved_page_follows_too() {
    let fixture = Fixture::new(&[("box/a.md", page(1, "link = [\"box/a\", \"a\"]\n", "one\n"))]);

    fixture.move_folder("box", "arch");

    assert_eq!(
        fixture.read("arch/a.md"),
        page(1, "link = [\"arch/a\", \"a\"]\n", "one\n")
    );
    assert_eq!(
        targets(fixture.rebuilt_links("arch/a.md")),
        vec![Some("arch/a.md".to_string()); 2]
    );
}

#[test]
fn tags_and_aliases_are_not_renamed_with_a_page() {
    let frontmatter = "tags = [\"alpha\"]\naliases = [\"gamma\"]\n";
    let fixture = Fixture::new(&[
        ("alpha.md", page(1, "", "one\n")),
        ("b.md", page(2, frontmatter, "[[alpha]]\n")),
    ]);

    fixture.move_page("alpha.md", "beta.md");

    assert_eq!(fixture.read("b.md"), page(2, frontmatter, "[[beta]]\n"));
}
