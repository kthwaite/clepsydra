use std::collections::BTreeSet;
use std::fs;

use chrono::NaiveDate;
use clep_index::index::{
    BirthdayEntry, CalendarDueItem, CalendarPage, CalendarQuery, CalendarTodoPage, VaultIndex,
};
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

/// A TOML-fronted page carrying a raw `birthday` line.
fn person(id: u32, title: &str, kind: &str, extra: &str) -> String {
    format!(
        "+++\nid = \"00000000-0000-0000-0000-{id:012}\"\ntitle = \"{title}\"\ntype = \"{kind}\"\n\
         created_at = \"2020-01-01T00:00:00Z\"\n{extra}\n+++\nBody.\n"
    )
}

fn birthday_rows(entries: &[BirthdayEntry]) -> Vec<(String, Option<i32>, u32, u32)> {
    entries
        .iter()
        .map(|e| (e.title.clone().unwrap_or_default(), e.year, e.month, e.day))
        .collect()
}

#[test]
fn birthdays_come_from_person_pages_in_month_day_title_order() {
    let ada = person(1, "Ada", "PERSON", "birthday = 1983-05-12");
    let bob = person(2, "Bob", "PERSON", "birthday = \"05-12\"");
    let cy = person(3, "Cy", "PERSON", "birthday = \"--02-29\"");
    let bad = person(4, "Bad", "PERSON", "birthday = \"13-01\"");
    let none = person(5, "Nobody", "PERSON", "");
    let note = person(6, "Note", "NOTE", "birthday = 1990-01-01");
    let (_tmp, index) = built(&[
        ("ada.md", &ada),
        ("bob.md", &bob),
        ("cy.md", &cy),
        ("bad.md", &bad),
        ("nobody.md", &none),
        ("note.md", &note),
    ]);

    let entries = index.calendar_birthdays(None, None).unwrap();

    assert_eq!(
        birthday_rows(&entries),
        vec![
            ("Cy".to_string(), None, 2, 29),
            ("Ada".to_string(), Some(1983), 5, 12),
            ("Bob".to_string(), None, 5, 12),
        ]
    );
    assert!(entries[0].path.ends_with("cy.md"), "{}", entries[0].path);
}

#[test]
fn birthdays_filter_by_tag_and_project() {
    let ada = person(
        1,
        "Ada",
        "PERSON",
        "birthday = 1983-05-12\ntags = [\"family\"]\nproject = \"kin\"",
    );
    let bob = person(
        2,
        "Bob",
        "PERSON",
        "birthday = \"06-01\"\ntags = [\"work\"]",
    );
    let (_tmp, index) = built(&[("ada.md", &ada), ("bob.md", &bob)]);

    let tagged = index.calendar_birthdays(Some("family"), None).unwrap();
    assert_eq!(
        birthday_rows(&tagged),
        vec![("Ada".to_string(), Some(1983), 5, 12)]
    );

    let work = index.calendar_birthdays(Some("work"), None).unwrap();
    assert_eq!(birthday_rows(&work), vec![("Bob".to_string(), None, 6, 1)]);

    let project = index.calendar_birthdays(None, Some("kin")).unwrap();
    assert_eq!(
        birthday_rows(&project),
        vec![("Ada".to_string(), Some(1983), 5, 12)]
    );

    let both = index.calendar_birthdays(Some("work"), Some("kin")).unwrap();
    assert!(both.is_empty());
}

#[tokio::test]
async fn handle_wrapper_returns_birthdays() {
    let ada = person(1, "Ada", "PERSON", "birthday = 1983-05-12");
    let (_tmp, vault) = setup_vault(&[("ada.md", &ada)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let handle = IndexHandle::spawn(VaultIndex::open(&db_path).unwrap(), vault);
    handle.build().await.unwrap();

    let entries = handle.calendar_birthdays(None, None).await.unwrap();

    assert_eq!(
        birthday_rows(&entries),
        vec![("Ada".to_string(), Some(1983), 5, 12)]
    );
}

// ---------------------------------------------------------------------------
// Calendar todos: checkbox todos and TASK pages placed by due date.
// ---------------------------------------------------------------------------

/// A YAML-fronted host page with a body of checkbox lines.
fn host(id: u32, title: &str, extra: &str, body: &str) -> String {
    format!(
        "---\nid: 00000000-0000-0000-0000-{id:012}\ntitle: {title}\n{extra}\
         created_at: \"2020-01-01T00:00:00Z\"\n---\n{body}"
    )
}

/// A TASK page with frontmatter `extra` (status, due, priority, ...).
fn task(id: u32, title: &str, extra: &str) -> String {
    format!(
        "---\nid: 00000000-0000-0000-0000-{id:012}\ntitle: {title}\ntype: TASK\n{extra}\
         created_at: \"2020-01-01T00:00:00Z\"\n---\nBody.\n"
    )
}

/// `(label, status, due)` per item: content for todos, title for tasks.
fn due_rows(page: &CalendarTodoPage) -> Vec<(String, String, String)> {
    page.items
        .iter()
        .map(|item| match item {
            CalendarDueItem::Todo(todo) => {
                (todo.content.clone(), todo.status.clone(), todo.due.clone())
            }
            CalendarDueItem::Task(task) => (
                task.title.clone().unwrap_or_default(),
                task.status.clone(),
                task.due.clone(),
            ),
        })
        .collect()
}

fn due_labels(page: &CalendarTodoPage) -> BTreeSet<String> {
    due_rows(page)
        .into_iter()
        .map(|(label, _, _)| label)
        .collect()
}

fn content_of(item: &CalendarDueItem) -> &str {
    match item {
        CalendarDueItem::Todo(todo) => todo.content.as_str(),
        CalendarDueItem::Task(task) => task.title.as_deref().unwrap_or_default(),
    }
}

#[test]
fn todos_window_is_inclusive_of_both_padded_dates() {
    let body = "- [ ] Before [due:: 2026-08-31]\n\
                - [ ] First [due:: 2026-09-01]\n\
                - [ ] Last [due:: 2026-10-01]\n\
                - [ ] After [due:: 2026-10-02]\n";
    let (_tmp, index) = built(&[("host.md", &host(1, "Host", "", body))]);

    let page = index.calendar_todos(&september()).unwrap();

    let labels: Vec<&str> = page.items.iter().map(content_of).collect();
    assert_eq!(labels.len(), 2, "{labels:?}");
    assert!(labels[0].starts_with("First"), "{labels:?}");
    assert!(labels[1].starts_with("Last"), "{labels:?}");
    assert!(!page.truncated);
}

#[test]
fn todos_include_every_status_and_carry_host_details() {
    let body = "- [ ] Open [due:: 2026-09-10] [priority:: P1]\n\
                - [x] Done [due:: 2026-09-10]\n\
                - [-] Dropped [due:: 2026-09-10]\n";
    let (_tmp, index) = built(&[("notes/host.md", &host(1, "Host", "type: NOTE\n", body))]);

    let page = index.calendar_todos(&september()).unwrap();

    let statuses: BTreeSet<String> = due_rows(&page).into_iter().map(|(_, s, _)| s).collect();
    assert_eq!(statuses, set(&["todo", "done", "cancelled"]));
    let CalendarDueItem::Todo(open) = &page.items[0] else {
        panic!("expected a todo: {:?}", page.items[0]);
    };
    assert!(open.content.starts_with("Open"), "{open:?}");
    assert_eq!(open.due, "2026-09-10");
    assert_eq!(open.priority.as_deref(), Some("P1"));
    assert_eq!(open.page_title.as_deref(), Some("Host"));
    assert_eq!(open.page_kind, "NOTE");
    assert!(open.page_path.ends_with("host.md"), "{}", open.page_path);
    let CalendarDueItem::Todo(done) = &page.items[1] else {
        panic!("expected a todo");
    };
    assert_eq!(done.priority, None);
    assert!(done.span_start > open.span_start);
}

#[test]
fn todos_without_or_with_malformed_due_are_excluded() {
    let body = "- [ ] Undated\n\
                - [ ] Short [due:: 2026-9-10]\n\
                - [ ] Impossible [due:: 2026-09-31]\n\
                - [ ] Timestamped [due:: 2026-09-10T10:00]\n\
                - [ ] Good [due:: 2026-09-10]\n\
                - Plain bullet [due:: 2026-09-10]\n";
    let (_tmp, index) = built(&[("host.md", &host(1, "Host", "", body))]);

    let page = index.calendar_todos(&september()).unwrap();

    assert_eq!(page.items.len(), 1, "{:?}", page.items);
    assert!(content_of(&page.items[0]).starts_with("Good"));
}

#[test]
fn todos_filter_on_the_host_page() {
    let body = |label: &str| format!("- [ ] {label} [due:: 2026-09-10]\n");
    let (_tmp, index) = built(&[
        (
            "wine.md",
            &host(
                1,
                "Wine",
                "type: RECIPE\nproject: Cellar\ntags: [wine]\n",
                &body("WineTodo"),
            ),
        ),
        (
            "bread.md",
            &host(2, "Bread", "type: RECIPE\n", &body("BreadTodo")),
        ),
        (
            "note.md",
            &host(3, "Note", "tags: [wine]\n", &body("NoteTodo")),
        ),
        (
            "tasks/TSK-a.md",
            &task(4, "Cellar Task", "project: Cellar\ndue: 2026-09-11\n"),
        ),
    ]);
    let starts = |page: &CalendarTodoPage| -> BTreeSet<String> {
        page.items
            .iter()
            .map(|item| content_of(item).split(' ').next().unwrap().to_string())
            .collect()
    };

    let mut q = september();
    q.kinds = vec!["RECIPE".to_string()];
    assert_eq!(
        starts(&index.calendar_todos(&q).unwrap()),
        set(&["WineTodo", "BreadTodo"])
    );

    let mut q = september();
    q.kinds = vec!["TASK".to_string()];
    assert_eq!(starts(&index.calendar_todos(&q).unwrap()), set(&["Cellar"]));

    let mut q = september();
    q.tag = Some("wine".to_string());
    assert_eq!(
        starts(&index.calendar_todos(&q).unwrap()),
        set(&["WineTodo", "NoteTodo"])
    );

    let mut q = september();
    q.project = Some("Cellar".to_string());
    assert_eq!(
        starts(&index.calendar_todos(&q).unwrap()),
        set(&["WineTodo", "Cellar"])
    );
}

#[test]
fn todos_skip_ai_journal_hosts() {
    let ai = host(1, "Agent Log", "", "- [ ] Agent todo [due:: 2026-09-10]\n");
    let mine = host(2, "Mine", "", "- [ ] My todo [due:: 2026-09-10]\n");
    let (_tmp, index) = built(&[("ai-journals/2026-09-03.md", &ai), ("mine.md", &mine)]);

    let page = index.calendar_todos(&september()).unwrap();

    assert_eq!(page.items.len(), 1, "{:?}", page.items);
    assert!(content_of(&page.items[0]).starts_with("My todo"));
}

#[test]
fn tasks_are_placed_by_frontmatter_due_with_defaults() {
    let (_tmp, index) = built(&[
        (
            "tasks/TSK-sealed.md",
            &task(
                1,
                "Sealed",
                "status: SEALED\npriority: P0\ndue: 2026-09-05\n",
            ),
        ),
        (
            "tasks/TSK-plain.md",
            &task(2, "Plain", "due: \"2026-09-06\"\n"),
        ),
        (
            "tasks/TSK-undated.md",
            &task(3, "Undated", "status: FIELD\n"),
        ),
        ("tasks/TSK-late.md", &task(4, "Late", "due: 2026-10-02\n")),
        ("tasks/TSK-bad.md", &task(5, "Bad", "due: soon\n")),
        (
            "tasks/TSK-odd.md",
            &task(6, "Odd", "status: PARKED\ndue: 2026-09-07\n"),
        ),
        (
            "tasks/TSK-pri.md",
            &task(7, "Pri", "priority: P9\ndue: 2026-09-07\n"),
        ),
    ]);

    let page = index.calendar_todos(&september()).unwrap();

    assert_eq!(
        due_rows(&page),
        vec![
            (
                "Sealed".to_string(),
                "SEALED".to_string(),
                "2026-09-05".to_string()
            ),
            (
                "Plain".to_string(),
                "INTAKE".to_string(),
                "2026-09-06".to_string()
            ),
        ]
    );
    let CalendarDueItem::Task(sealed) = &page.items[0] else {
        panic!("expected a task");
    };
    assert_eq!(sealed.priority, "P0");
    assert_eq!(sealed.id, "00000000-0000-0000-0000-000000000001");
    assert!(sealed.path.ends_with("TSK-sealed.md"), "{}", sealed.path);
    let CalendarDueItem::Task(plain) = &page.items[1] else {
        panic!("expected a task");
    };
    assert_eq!(plain.priority, "P2");
}

#[test]
fn todos_order_by_due_then_host_path_then_span() {
    let b = host(
        1,
        "B",
        "",
        "- [ ] B2 [due:: 2026-09-10]\n- [ ] B1 [due:: 2026-09-09]\n- [ ] B3 [due:: 2026-09-10]\n",
    );
    let a = host(2, "A", "", "- [ ] A1 [due:: 2026-09-10]\n");
    let (_tmp, index) = built(&[
        ("b.md", &b),
        ("a.md", &a),
        ("tasks/TSK-c.md", &task(3, "C1", "due: 2026-09-10\n")),
    ]);

    let page = index.calendar_todos(&september()).unwrap();

    let order: Vec<&str> = page
        .items
        .iter()
        .map(|item| content_of(item).split(' ').next().unwrap())
        .collect();
    assert_eq!(order, vec!["B1", "A1", "B2", "B3", "C1"]);
}

#[test]
fn todos_truncate_at_limit_and_flag_it() {
    let body = "- [ ] One [due:: 2026-09-10]\n- [ ] Two [due:: 2026-09-11]\n";
    let (_tmp, index) = built(&[
        ("host.md", &host(1, "Host", "", body)),
        ("tasks/TSK-t.md", &task(2, "Three", "due: 2026-09-12\n")),
    ]);

    let mut q = september();
    q.limit = 2;
    let page = index.calendar_todos(&q).unwrap();
    assert_eq!(due_labels(&page).len(), 2);
    assert!(page.truncated);

    q.limit = 3;
    let page = index.calendar_todos(&q).unwrap();
    assert_eq!(page.items.len(), 3);
    assert!(!page.truncated);
}

#[tokio::test]
async fn handle_wrapper_returns_todos() {
    let (_tmp, vault) = setup_vault(&[(
        "host.md",
        &host(1, "Host", "", "- [ ] Handled [due:: 2026-09-10]\n"),
    )]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let handle = IndexHandle::spawn(VaultIndex::open(&db_path).unwrap(), vault);
    handle.build().await.unwrap();

    let page = handle.calendar_todos(september()).await.unwrap();

    assert_eq!(page.items.len(), 1);
}
