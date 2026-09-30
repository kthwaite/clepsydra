use std::collections::BTreeSet;
use std::fs;

use chrono::NaiveDate;
use clep_index::index::{CalendarPage, CalendarQuery, VaultIndex};
use clep_index::index_handle::IndexHandle;
use clep_vault::Vault;
use clep_vault::init::init_vault;
use tempfile::TempDir;

fn setup_vault(files: &[(&str, &str)]) -> (TempDir, Vault) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    for (rel_path, content) in files {
        let abs = root.join(rel_path);
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&abs, content).unwrap();
    }
    let vault = Vault::open(&root).unwrap();
    (tmp, vault)
}

/// A synchronously built index, so tests can reach `connection()`.
fn built(files: &[(&str, &str)]) -> (TempDir, VaultIndex) {
    let (tmp, vault) = setup_vault(files);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    (tmp, index)
}

struct Fixture<'a> {
    id: u32,
    title: &'a str,
    kind: Option<&'a str>,
    project: Option<&'a str>,
    tags: &'a [&'a str],
    created_at: &'a str,
}

impl<'a> Fixture<'a> {
    fn new(id: u32, title: &'a str, created_at: &'a str) -> Self {
        Self {
            id,
            title,
            kind: None,
            project: None,
            tags: &[],
            created_at,
        }
    }
    fn kind(mut self, kind: &'a str) -> Self {
        self.kind = Some(kind);
        self
    }
    fn project(mut self, project: &'a str) -> Self {
        self.project = Some(project);
        self
    }
    fn tags(mut self, tags: &'a [&'a str]) -> Self {
        self.tags = tags;
        self
    }
    fn render(&self) -> String {
        let mut out = format!(
            "---\nid: 00000000-0000-0000-0000-{:012}\ntitle: {}\n",
            self.id, self.title
        );
        if let Some(kind) = self.kind {
            out.push_str(&format!("type: {kind}\n"));
        }
        if let Some(project) = self.project {
            out.push_str(&format!("project: {project}\n"));
        }
        if !self.tags.is_empty() {
            out.push_str(&format!("tags: [{}]\n", self.tags.join(", ")));
        }
        out.push_str(&format!(
            "created_at: \"{0}\"\nupdated_at: \"{0}\"\n---\nBody.\n",
            self.created_at
        ));
        out
    }
}

/// September 2026 in London: local midnights as UTC.
fn september() -> CalendarQuery {
    CalendarQuery {
        from_utc: "2026-08-31T23:00:00+00:00".to_string(),
        to_utc: "2026-09-30T23:00:00+00:00".to_string(),
        journal_from: NaiveDate::from_ymd_opt(2026, 9, 1).unwrap(),
        journal_to: NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
        kinds: Vec::new(),
        tag: None,
        project: None,
        limit: 5000,
    }
}

fn titles(page: &CalendarPage) -> BTreeSet<String> {
    page.entries
        .iter()
        .map(|e| e.title.clone().unwrap_or_default())
        .collect()
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

#[test]
fn includes_pages_created_inside_the_window_half_open() {
    let a = Fixture::new(1, "InStart", "2026-08-31T23:30:00Z").render();
    let b = Fixture::new(2, "InEnd", "2026-09-30T22:59:59Z").render();
    let c = Fixture::new(3, "OutEnd", "2026-09-30T23:00:00Z").render();
    let d = Fixture::new(4, "OutStart", "2026-08-31T22:59:59Z").render();
    let (_tmp, index) = built(&[("a.md", &a), ("b.md", &b), ("c.md", &c), ("d.md", &d)]);

    let page = index.calendar_entries(&september()).unwrap();

    assert_eq!(titles(&page), set(&["InStart", "InEnd"]));
    assert!(!page.truncated);
}

#[test]
fn places_journal_kinds_by_journal_date_not_created_at() {
    let inside = Fixture::new(1, "Sept Journal", "2026-10-20T00:00:00Z").render();
    let outside = Fixture::new(2, "Aug Journal", "2026-09-10T00:00:00Z").render();
    let (_tmp, index) = built(&[
        ("journals/2026-09-15.md", &inside),
        ("journals/2026-08-20.md", &outside),
    ]);

    let page = index.calendar_entries(&september()).unwrap();

    assert_eq!(page.entries.len(), 1, "{:?}", page.entries);
    let entry = &page.entries[0];
    assert_eq!(entry.title.as_deref(), Some("Sept Journal"));
    assert_eq!(entry.kind, "JOURNAL");
    assert_eq!(entry.journal_date.as_deref(), Some("2026-09-15"));
    assert!(
        entry
            .created_at
            .as_deref()
            .unwrap()
            .starts_with("2026-10-20")
    );
}

#[test]
fn journal_window_is_inclusive_of_both_padded_dates() {
    let first = Fixture::new(1, "First", "2020-01-01T00:00:00Z").render();
    let last = Fixture::new(2, "Last", "2020-01-01T00:00:00Z").render();
    let beyond = Fixture::new(3, "Beyond", "2020-01-01T00:00:00Z").render();
    let (_tmp, index) = built(&[
        ("journals/2026-09-01.md", &first),
        ("journals/2026-10-01.md", &last),
        ("journals/2026-10-02.md", &beyond),
    ]);

    let page = index.calendar_entries(&september()).unwrap();

    assert_eq!(titles(&page), set(&["First", "Last"]));
}

#[test]
fn ai_journal_uses_journal_date() {
    let ai = Fixture::new(1, "Agent Log", "2020-01-01T00:00:00Z").render();
    let (_tmp, index) = built(&[("ai-journals/2026-09-03.md", &ai)]);

    let page = index.calendar_entries(&september()).unwrap();

    assert_eq!(page.entries.len(), 1, "{:?}", page.entries);
    assert_eq!(page.entries[0].kind, "AI_JOURNAL");
    assert_eq!(page.entries[0].journal_date.as_deref(), Some("2026-09-03"));
}

#[test]
fn journal_kind_without_journal_date_falls_back_to_created_at() {
    let loose = Fixture::new(1, "Loose Journal", "2026-09-12T10:00:00Z")
        .kind("JOURNAL")
        .render();
    let old = Fixture::new(2, "Old Loose Journal", "2026-07-12T10:00:00Z")
        .kind("JOURNAL")
        .render();
    let (_tmp, index) = built(&[("loose.md", &loose), ("old-loose.md", &old)]);

    let page = index.calendar_entries(&september()).unwrap();

    assert_eq!(titles(&page), set(&["Loose Journal"]));
    assert_eq!(page.entries[0].journal_date, None);
}

#[test]
fn excludes_pages_without_created_at() {
    let ok = Fixture::new(1, "Fine", "2026-09-10T00:00:00Z").render();
    let broken = Fixture::new(2, "Broken", "2026-09-11T00:00:00Z").render();
    let (_tmp, index) = built(&[("fine.md", &ok), ("broken.md", &broken)]);
    index
        .connection()
        .execute(
            "UPDATE pages SET created_at = NULL WHERE title = 'Broken'",
            [],
        )
        .unwrap();

    let page = index.calendar_entries(&september()).unwrap();

    assert_eq!(titles(&page), set(&["Fine"]));
}

#[test]
fn filters_by_kinds_tag_and_project() {
    let at = "2026-09-10T00:00:00Z";
    let wine_recipe = Fixture::new(1, "Mulled Wine", at)
        .kind("RECIPE")
        .project("Cellar")
        .tags(&["wine"])
        .render();
    let bread = Fixture::new(2, "Bread", at).kind("RECIPE").render();
    let wine_note = Fixture::new(3, "Wine Note", at).tags(&["wine"]).render();
    let cellar_note = Fixture::new(4, "Cellar Plan", at)
        .project("Cellar")
        .render();
    let (_tmp, index) = built(&[
        ("a.md", &wine_recipe),
        ("b.md", &bread),
        ("c.md", &wine_note),
        ("d.md", &cellar_note),
    ]);

    let mut q = september();
    q.kinds = vec!["RECIPE".to_string()];
    assert_eq!(
        titles(&index.calendar_entries(&q).unwrap()),
        set(&["Mulled Wine", "Bread"])
    );

    let mut q = september();
    q.tag = Some("wine".to_string());
    assert_eq!(
        titles(&index.calendar_entries(&q).unwrap()),
        set(&["Mulled Wine", "Wine Note"])
    );

    let mut q = september();
    q.project = Some("Cellar".to_string());
    assert_eq!(
        titles(&index.calendar_entries(&q).unwrap()),
        set(&["Mulled Wine", "Cellar Plan"])
    );

    let mut q = september();
    q.kinds = vec!["RECIPE".to_string(), "NOTE".to_string()];
    q.tag = Some("wine".to_string());
    q.project = Some("Cellar".to_string());
    assert_eq!(
        titles(&index.calendar_entries(&q).unwrap()),
        set(&["Mulled Wine"])
    );
}

#[test]
fn sub_second_created_at_compares_correctly() {
    let inside = Fixture::new(1, "Just In", "2026-09-30T22:59:59.500Z").render();
    let (_tmp, index) = built(&[("a.md", &inside)]);

    let page = index.calendar_entries(&september()).unwrap();

    assert_eq!(titles(&page), set(&["Just In"]));
    assert!(
        page.entries[0]
            .created_at
            .as_deref()
            .unwrap()
            .contains(".5"),
        "{:?}",
        page.entries[0].created_at
    );
}

#[test]
fn truncates_at_limit_and_flags_it() {
    let a = Fixture::new(1, "A", "2026-09-10T00:00:00Z").render();
    let b = Fixture::new(2, "B", "2026-09-11T00:00:00Z").render();
    let c = Fixture::new(3, "C", "2026-09-12T00:00:00Z").render();
    let (_tmp, index) = built(&[("a.md", &a), ("b.md", &b), ("c.md", &c)]);

    let mut q = september();
    q.limit = 2;
    let page = index.calendar_entries(&q).unwrap();
    assert_eq!(page.entries.len(), 2);
    assert!(page.truncated);

    q.limit = 3;
    let page = index.calendar_entries(&q).unwrap();
    assert_eq!(page.entries.len(), 3);
    assert!(!page.truncated);
}

#[test]
fn orders_by_placement_date_then_path() {
    let late = Fixture::new(1, "Late", "2026-09-20T08:00:00Z").render();
    let early = Fixture::new(2, "Early", "2026-09-02T08:00:00Z").render();
    let same_b = Fixture::new(3, "Same B", "2026-09-10T08:00:00Z").render();
    let same_a = Fixture::new(4, "Same A", "2026-09-10T08:00:00Z").render();
    // Journal placed on the 15th although created on the 1st.
    let journal = Fixture::new(5, "Mid Journal", "2026-09-01T08:00:00Z").render();
    let (_tmp, index) = built(&[
        ("late.md", &late),
        ("early.md", &early),
        ("same-b.md", &same_b),
        ("Same-A.md", &same_a),
        ("journals/2026-09-15.md", &journal),
    ]);

    let page = index.calendar_entries(&september()).unwrap();

    let order: Vec<&str> = page
        .entries
        .iter()
        .map(|e| e.title.as_deref().unwrap())
        .collect();
    assert_eq!(
        order,
        vec!["Early", "Same A", "Same B", "Mid Journal", "Late"]
    );
}

#[test]
fn creates_created_at_index() {
    let (tmp, vault) = setup_vault(&[]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    {
        let index = VaultIndex::open(&db_path).unwrap();
        let count: i64 = index
            .connection()
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_pages_created_at'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
    VaultIndex::open(&db_path).expect("reopening is idempotent");
    drop(tmp);
}

#[tokio::test]
async fn handle_wrapper_returns_entries() {
    let a = Fixture::new(1, "Handled", "2026-09-10T00:00:00Z").render();
    let (_tmp, vault) = setup_vault(&[("a.md", &a)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let handle = IndexHandle::spawn(VaultIndex::open(&db_path).unwrap(), vault);
    handle.build().await.unwrap();

    let page = handle.calendar_entries(september()).await.unwrap();

    assert_eq!(titles(&page), set(&["Handled"]));
}
