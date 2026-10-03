mod support;

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use axum::http::StatusCode;
use axum_test::TestServer;
use serde_json::Value;
use tempfile::TempDir;

use support::ApiFixture;

const ROUTE: &str = "/api/vault/index/calendar";
const SEPT_FROM_LONDON: &str = "2026-09-01T00:00:00+01:00";
const SEPT_TO_LONDON: &str = "2026-10-01T00:00:00+01:00";

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
            "created_at: {}\n---\n\n# {}\n",
            self.created_at, self.title
        ));
        out
    }
}

fn write(root: &Path, rel: &str, content: &str) {
    let abs = root.join(rel);
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(abs, content).unwrap();
}

fn seed(root: &Path) {
    let pages = [
        (
            "early-bird.md",
            Fixture::new(1, "Early Bird", "2026-08-31T23:30:00Z"),
        ),
        (
            "mid-month.md",
            Fixture::new(2, "Mid Month", "2026-09-10T12:00:00Z"),
        ),
        (
            "outside.md",
            Fixture::new(3, "Outside", "2026-10-05T12:00:00Z"),
        ),
        (
            "claret.md",
            Fixture::new(4, "Claret", "2026-09-12T12:00:00Z")
                .kind("RECIPE")
                .project("Cellar")
                .tags(&["wine"]),
        ),
        (
            "bread.md",
            Fixture::new(5, "Bread", "2026-09-13T12:00:00Z").kind("RECIPE"),
        ),
        (
            "cellar-note.md",
            Fixture::new(6, "Cellar Note", "2026-09-14T12:00:00Z")
                .kind("NOTE")
                .project("Cellar")
                .tags(&["wine"]),
        ),
    ];
    for (rel, page) in &pages {
        write(root, rel, &page.render());
    }
    write(
        root,
        "journals/2026-09-15.md",
        "---\ncreated_at: 2026-10-20T00:00:00Z\n---\n\n# 2026-09-15\n",
    );
    write(
        root,
        "ada.md",
        "+++\nid = \"00000000-0000-0000-0000-000000000101\"\ntitle = \"Ada\"\n\
         type = \"PERSON\"\ntags = [\"family\"]\ncreated_at = \"2020-01-01T00:00:00Z\"\n\
         birthday = 1983-05-12\n+++\n\n# Ada\n",
    );
    write(
        root,
        "bob.md",
        "+++\nid = \"00000000-0000-0000-0000-000000000102\"\ntitle = \"Bob\"\n\
         type = \"PERSON\"\ncreated_at = \"2020-01-01T00:00:00Z\"\n\
         birthday = \"02-29\"\n+++\n\n# Bob\n",
    );
}

fn setup() -> (TestServer, TempDir) {
    ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp()
}

async fn get_calendar(server: &TestServer, params: &[(&str, &str)]) -> axum_test::TestResponse {
    let mut request = server.get(ROUTE);
    for (key, value) in params {
        request = request.add_query_param(key, value);
    }
    request.await
}

fn titles(body: &Value) -> BTreeSet<String> {
    body["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["title"].as_str().map(str::to_string))
        .collect()
}

fn find<'a>(body: &'a Value, title: &str) -> Option<&'a Value> {
    body["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["title"].as_str() == Some(title))
}

#[tokio::test]
async fn returns_entries_in_window_with_slim_shape() {
    let (server, _tmp) = setup();
    let response = get_calendar(
        &server,
        &[("from", SEPT_FROM_LONDON), ("to", SEPT_TO_LONDON)],
    )
    .await;
    response.assert_status_ok();
    let body: Value = response.json();
    assert_eq!(body["truncated"], Value::Bool(false));
    let entries = body["entries"].as_array().unwrap();
    assert!(!entries.is_empty());
    let expected: BTreeSet<&str> = ["path", "title", "kind", "created_at", "journal_date"]
        .into_iter()
        .collect();
    for entry in entries {
        let keys: BTreeSet<&str> = entry
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, expected, "entry {entry}");
    }
    let got = titles(&body);
    assert!(got.contains("Mid Month"));
    assert!(!got.contains("Outside"));
}

#[tokio::test]
async fn journal_entries_carry_journal_date() {
    let (server, _tmp) = setup();
    let body: Value = get_calendar(
        &server,
        &[("from", SEPT_FROM_LONDON), ("to", SEPT_TO_LONDON)],
    )
    .await
    .json();
    let journal = body["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| {
            entry["path"]
                .as_str()
                .is_some_and(|p| p.starts_with("journals/"))
        })
        .expect("journal entry present");
    assert_eq!(journal["journal_date"], "2026-09-15");
    assert_eq!(journal["kind"], "JOURNAL");
}

#[tokio::test]
async fn offset_is_honoured_for_created_at() {
    let (server, _tmp) = setup();
    let london: Value = get_calendar(
        &server,
        &[("from", SEPT_FROM_LONDON), ("to", SEPT_TO_LONDON)],
    )
    .await
    .json();
    assert!(find(&london, "Early Bird").is_some());

    let utc: Value = get_calendar(
        &server,
        &[
            ("from", "2026-09-01T00:00:00+00:00"),
            ("to", "2026-10-01T00:00:00+00:00"),
        ],
    )
    .await
    .json();
    assert!(find(&utc, "Early Bird").is_none());
    assert!(find(&utc, "Mid Month").is_some());
}

#[tokio::test]
async fn filters_by_comma_separated_kind_tag_and_project() {
    let (server, _tmp) = setup();
    let window = [("from", SEPT_FROM_LONDON), ("to", SEPT_TO_LONDON)];

    let with = |extra: (&'static str, &'static str)| {
        let mut params = window.to_vec();
        params.push(extra);
        params
    };

    let kinds: Value = get_calendar(&server, &with(("kind", "RECIPE, NOTE,,")))
        .await
        .json();
    for entry in kinds["entries"].as_array().unwrap() {
        let kind = entry["kind"].as_str().unwrap();
        assert!(kind == "RECIPE" || kind == "NOTE", "unexpected kind {kind}");
    }
    let kind_titles = titles(&kinds);
    assert!(kind_titles.contains("Claret"));
    assert!(kind_titles.contains("Bread"));
    assert!(kind_titles.contains("Cellar Note"));
    assert!(!kind_titles.contains("2026-09-15"));

    let tagged: Value = get_calendar(&server, &with(("tag", "wine"))).await.json();
    assert_eq!(
        titles(&tagged),
        ["Claret", "Cellar Note"].map(String::from).into()
    );

    let project: Value = get_calendar(&server, &with(("project", "Cellar")))
        .await
        .json();
    assert_eq!(
        titles(&project),
        ["Claret", "Cellar Note"].map(String::from).into()
    );

    let mut all = window.to_vec();
    all.extend([("kind", "RECIPE"), ("tag", "wine"), ("project", "Cellar")]);
    let narrowed: Value = get_calendar(&server, &all).await.json();
    assert_eq!(titles(&narrowed), ["Claret"].map(String::from).into());

    let blank: Value = get_calendar(&server, &with(("tag", "  "))).await.json();
    assert!(titles(&blank).contains("Mid Month"));
}

#[tokio::test]
async fn rejects_bad_windows() {
    let (server, _tmp) = setup();
    let cases: [&[(&str, &str)]; 6] = [
        &[("to", SEPT_TO_LONDON)],
        &[("from", "yesterday"), ("to", SEPT_TO_LONDON)],
        &[("from", SEPT_FROM_LONDON), ("to", "tomorrow")],
        &[("from", SEPT_FROM_LONDON), ("to", SEPT_FROM_LONDON)],
        &[
            ("from", "2026-01-01T00:00:00+00:00"),
            ("to", "2027-05-16T00:00:00+00:00"),
        ],
        &[
            ("from", SEPT_FROM_LONDON),
            ("to", SEPT_TO_LONDON),
            ("kind", "NOPE"),
        ],
    ];
    for params in cases {
        let response = get_calendar(&server, params).await;
        assert_eq!(
            response.status_code(),
            StatusCode::BAD_REQUEST,
            "params {params:?}"
        );
    }
}

fn birthday_titles(body: &Value) -> Vec<String> {
    body["birthdays"]
        .as_array()
        .expect("birthdays array")
        .iter()
        .map(|b| b["title"].as_str().unwrap_or_default().to_string())
        .collect()
}

#[tokio::test]
async fn birthdays_carry_month_day_and_optional_year() {
    let (server, _tmp) = setup();
    let body: Value = get_calendar(
        &server,
        &[("from", SEPT_FROM_LONDON), ("to", SEPT_TO_LONDON)],
    )
    .await
    .json();
    let birthdays = body["birthdays"].as_array().unwrap();
    assert_eq!(birthday_titles(&body), vec!["Bob", "Ada"]);
    let bob = &birthdays[0];
    assert_eq!(bob["month"], 2);
    assert_eq!(bob["day"], 29);
    assert_eq!(bob["year"], Value::Null);
    let ada = &birthdays[1];
    assert_eq!(ada["year"], 1983);
    assert_eq!(ada["month"], 5);
    assert_eq!(ada["day"], 12);
    let keys: BTreeSet<&str> = ada
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        ["path", "title", "year", "month", "day"]
            .into_iter()
            .collect()
    );
    assert!(ada["path"].as_str().unwrap().ends_with("ada.md"));
}

#[tokio::test]
async fn birthdays_follow_the_kind_filter() {
    let (server, _tmp) = setup();
    let window = [("from", SEPT_FROM_LONDON), ("to", SEPT_TO_LONDON)];
    let with = |extra: (&'static str, &'static str)| {
        let mut params = window.to_vec();
        params.push(extra);
        params
    };

    let notes: Value = get_calendar(&server, &with(("kind", "NOTE"))).await.json();
    assert!(birthday_titles(&notes).is_empty());

    let people: Value = get_calendar(&server, &with(("kind", "NOTE,person")))
        .await
        .json();
    assert_eq!(birthday_titles(&people), vec!["Bob", "Ada"]);
}

#[tokio::test]
async fn birthdays_follow_tag_and_project_filters() {
    let (server, _tmp) = setup();
    let window = [("from", SEPT_FROM_LONDON), ("to", SEPT_TO_LONDON)];
    let with = |extra: (&'static str, &'static str)| {
        let mut params = window.to_vec();
        params.push(extra);
        params
    };

    let family: Value = get_calendar(&server, &with(("tag", "family"))).await.json();
    assert_eq!(birthday_titles(&family), vec!["Ada"]);

    let cellar: Value = get_calendar(&server, &with(("project", "Cellar")))
        .await
        .json();
    assert!(birthday_titles(&cellar).is_empty());
}

fn seed_todos(root: &Path) {
    write(
        root,
        "groceries.md",
        "---\nid: 00000000-0000-0000-0000-000000000201\ntitle: Groceries\n\
         created_at: 2020-01-01T00:00:00Z\n---\n\n\
         - [ ] Buy milk [due:: 2026-09-10] [priority:: P1]\n\
         - [x] Buy bread [due:: 2026-09-11]\n\
         - [ ] Someday\n",
    );
    write(
        root,
        "tasks/TSK-brave-finch-7q3zd.md",
        "---\nid: 00000000-0000-0000-0000-000000000202\ntitle: File taxes\ntype: TASK\n\
         project: home\nstatus: SEALED\npriority: P1\ndue: 2026-09-20\n\
         created_at: 2020-01-01T00:00:00Z\n---\n\n# File taxes\n",
    );
}

#[tokio::test]
async fn todos_carry_checkbox_todos_and_tasks_by_due_date() {
    let (server, _tmp) = ApiFixture::builder()
        .pre_index_seed(seed_todos)
        .build()
        .into_server_and_temp();

    let response = get_calendar(
        &server,
        &[("from", SEPT_FROM_LONDON), ("to", SEPT_TO_LONDON)],
    )
    .await;
    response.assert_status_ok();
    let body: Value = response.json();
    assert_eq!(body["truncated"], Value::Bool(false));
    let todos = body["todos"].as_array().unwrap();
    assert_eq!(todos.len(), 3, "{todos:?}");

    let milk = &todos[0];
    assert_eq!(milk["kind"], "todo");
    assert!(milk["content"].as_str().unwrap().starts_with("Buy milk"));
    assert_eq!(milk["status"], "todo");
    assert_eq!(milk["due"], "2026-09-10");
    assert_eq!(milk["priority"], "P1");
    assert_eq!(milk["page_path"], "groceries.md");
    assert_eq!(milk["page_title"], "Groceries");
    assert!(milk["span_start"].is_i64());

    let bread = &todos[1];
    assert_eq!(bread["status"], "done");
    assert_eq!(bread["priority"], Value::Null);

    let task = &todos[2];
    assert_eq!(task["kind"], "task");
    assert_eq!(task["id"], "00000000-0000-0000-0000-000000000202");
    assert_eq!(task["code"], "TSK-brave-finch-7q3zd");
    assert_eq!(task["title"], "File taxes");
    assert_eq!(task["status"], "SEALED");
    assert_eq!(task["priority"], "P1");
    assert_eq!(task["project"], "home");
    assert_eq!(task["due"], "2026-09-20");
    assert_eq!(task["path"], "tasks/TSK-brave-finch-7q3zd.md");

    let tasks_only = get_calendar(
        &server,
        &[
            ("from", SEPT_FROM_LONDON),
            ("to", SEPT_TO_LONDON),
            ("kind", "TASK"),
        ],
    )
    .await
    .json::<Value>();
    let kinds: Vec<&str> = tasks_only["todos"]
        .as_array()
        .unwrap()
        .iter()
        .map(|todo| todo["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, vec!["task"]);
}
