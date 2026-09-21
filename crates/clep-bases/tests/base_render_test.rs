use std::fs;

use chrono::NaiveDate;
use clep_bases::base::{Filter, Op};
use clep_bases::base_render::{RenderSelection, render_base};
use clep_index::index::VaultIndex;
use clep_vault::Vault;
use clep_vault::init::init_vault;
use clep_vault::page::Page;
use clep_vault::path::VaultPath;
use tempfile::TempDir;

fn fixture(base: &str, pages: &[(&str, &str)]) -> (TempDir, Vault, VaultIndex, Page) {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path().join("vault");
    init_vault(&root).unwrap();
    fs::create_dir_all(root.join("bases")).unwrap();
    fs::write(root.join("bases/tastings.base.toml"), base).unwrap();
    fs::write(
        root.join("beers.md"),
        "+++\nid = \"019fd000-0000-7000-8000-000000000001\"\ntitle = \"Beer notebook\"\naudience = \"Friends\"\n+++\nDo not include this destination body.\n",
    )
    .unwrap();
    for (path, source) in pages {
        let absolute = root.join(path);
        fs::create_dir_all(absolute.parent().unwrap()).unwrap();
        fs::write(absolute, source).unwrap();
    }
    let vault = Vault::open(&root).unwrap();
    let mut index = VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
    index.build(&vault).unwrap();
    let destination =
        Page::from_file(&root.join("beers.md"), VaultPath::new("beers.md").unwrap()).unwrap();
    (temporary, vault, index, destination)
}

fn selection() -> RenderSelection {
    RenderSelection {
        base: "tastings".into(),
        view: Some("Public".into()),
        filter: Some(Filter::Cmp {
            field: "abv".into(),
            op: Op::Gt,
            value: serde_json::json!(4),
        }),
        sort: None,
        limit: None,
        template: "beer-notes".into(),
    }
}

const TODAY: NaiveDate = NaiveDate::from_ymd_opt(2026, 9, 21).unwrap();

#[test]
fn saved_selection_renders_native_properties_full_body_and_destination_context() {
    let body = "A luminous straw colour with a delicate, persistent foam. The first sip opens with crisp grain and a little fresh bread, followed by floral bitterness. It stays dry and precise all the way through the finish, without becoming thin or sharp. **Perfect balance**, and a beer worth returning to.\n";
    let selected = format!(
        "+++\nid = \"019fd000-0000-7000-8000-000000000002\"\ntitle = \"Pilsner\"\ntags = [\"beer\"]\nhops = [\"Saaz\", \"Hallertau\"]\nabv = 4.2\npublished = true\npath = \"Property path\"\n+++\n{body}"
    );
    let excluded = "+++\nid = \"019fd000-0000-7000-8000-000000000003\"\ntitle = \"Excluded\"\ntags = [\"beer\"]\nabv = 5.0\npublished = false\n+++\nPrivate tasting.\n";
    let weak = "+++\nid = \"019fd000-0000-7000-8000-000000000004\"\ntitle = \"Excluded by override\"\ntags = [\"beer\"]\nabv = 2.0\npublished = true\n+++\nWeak tasting.\n";
    let (_temporary, vault, index, destination) = fixture(
        r#"name = "Tastings"
filter = { field = "tags", op = "contains", value = "beer" }
[properties.hops]
type = "multi_select"
[properties.abv]
type = "number"
[properties.published]
type = "bool"
[properties.path]
type = "text"
[[views]]
name = "Public"
filter = { field = "published", op = "eq", value = true }
columns = ["title"]
"#,
        &[
            ("notes/pilsner.md", &selected),
            ("notes/excluded.md", excluded),
            ("notes/weak.md", weak),
        ],
    );
    let rendered = render_base(
        vault.root(),
        index.connection(),
        &selection(),
        &destination,
        "# {{ page.title }} for {{ page.properties.audience }}\n{% for beer in rows %}## {{ beer.title }} ({{ beer.properties.abv + 1 }})\n{{ beer.path }} / {{ beer.properties.path }}\nHops: {{ beer.properties.hops | join(', ') }}\n{{ beer.body }}{% endfor %}",
        TODAY,
    )
    .unwrap();
    assert_eq!(
        rendered.markdown,
        format!(
            "# Beer notebook for Friends\n## Pilsner (5.2)\nnotes/pilsner.md / Property path\nHops: Saaz, Hallertau\n{body}"
        )
    );
    assert_eq!(rendered.selected_count, 1);
    assert_eq!(rendered.limit, None);
}

#[test]
fn grouped_render_uses_complete_rows_and_limits_the_global_sort_before_grouping() {
    let pages: Vec<_> = (0..60)
        .map(|index| {
            let category = if index == 59 { "Amber" } else { "Lager" };
            (
                format!("notes/{index:02}.md"),
                format!("+++\nid = \"019fd000-0000-7000-8000-{:012}\"\ntitle = \"Beer {index:02}\"\ntags = [\"beer\"]\ncategory = \"{category}\"\nrank = {}\n+++\n", index + 2, index / 2),
            )
        })
        .collect();
    let borrowed: Vec<_> = pages
        .iter()
        .map(|(path, source)| (path.as_str(), source.as_str()))
        .collect();
    let (_temporary, vault, index, destination) = fixture(
        r#"name = "Tastings"
filter = { field = "tags", op = "contains", value = "beer" }
[properties.category]
type = "select"
[properties.rank]
type = "number"
[[views]]
name = "Public"
group_by = "category"
sort = [{ field = "rank", dir = "desc" }]
"#,
        &borrowed,
    );
    let mut selected = selection();
    selected.filter = None;
    let template =
        "{% for group in groups %}{{ group.label }}:{{ group.rows | length }};{% endfor %}";
    let all = render_base(
        vault.root(),
        index.connection(),
        &selected,
        &destination,
        template,
        TODAY,
    )
    .unwrap();
    assert_eq!(all.markdown, "Amber:1;Lager:59;");
    assert_eq!(all.selected_count, 60);
    selected.limit = Some(3);
    let limited = render_base(
        vault.root(), index.connection(), &selected, &destination,
        "{% for row in rows %}{{ row.title }};{% endfor %}|{% for group in groups %}{{ group.key }}:{% for row in group.rows %}{{ row.title }};{% endfor %}|{% endfor %}",
        TODAY,
    ).unwrap();
    assert_eq!(
        limited.markdown,
        "Beer 58;Beer 59;Beer 56;|Amber:Beer 59;|Lager:Beer 58;Beer 56;|"
    );
    assert_eq!(limited.selected_count, 3);
    assert_eq!(limited.limit, Some(3));
    selected.sort = Some(Vec::new());
    let cleared = render_base(
        vault.root(),
        index.connection(),
        &selected,
        &destination,
        "{% for row in rows %}{{ row.title }};{% endfor %}",
        TODAY,
    )
    .unwrap();
    assert_eq!(cleared.markdown, "Beer 00;Beer 01;Beer 02;");

    let stored = clep_bases::base_document::load(vault.root(), "tastings").unwrap();
    let base = &stored.definition;
    let table = clep_bases::base_embed::composed_query_spec(
        base,
        base.view("Public").unwrap(),
        None,
        None,
        None,
        None,
    );
    let clep_bases::query::QueryOutput::Grouped { groups } = clep_bases::query::evaluate(
        index.connection(),
        &table,
        &clep_bases::query::QueryContext::for_base(base),
    )
    .unwrap() else {
        panic!("saved table should remain grouped")
    };
    assert_eq!(groups[1].key, serde_json::json!("Lager"));
    assert_eq!(groups[1].total, 59);
    assert_eq!(groups[1].rows.len(), 50);
}

#[test]
fn member_links_and_attachments_keep_their_targets_without_reserializing_markdown() {
    let source = "+++\nid = \"019fd000-0000-7000-8000-000000000002\"\ntitle = \"Linked beer\"\ntags = [\"beer\"]\n+++\n![Bottle](./images/bottle.png \"Bottle title\")\n[Notes](other.md#tasting) and [space](<./two words.md> 'Keep title').\n[ref][details]\n\n[details]: ./detail.md \"Reference title\"\n\n[[./other.md|Explicit label]] and [[Canonical name|Unchanged label]].\n[Local](#aroma) [web](https://example.com/x) [email](mailto:a@example.com)\n`[literal](./unchanged.md)`\n\n```base\nbase = \"nested\"\n```\n";
    let (_temporary, vault, index, mut destination) = fixture(
        "name = \"Tastings\"\nfilter = { field = \"tags\", op = \"contains\", value = \"beer\" }\n",
        &[("notes/beer.md", source)],
    );
    destination.path = VaultPath::new("summaries/beers.md").unwrap();
    let mut selected = selection();
    selected.view = None;
    selected.filter = None;
    let rendered = render_base(
        vault.root(),
        index.connection(),
        &selected,
        &destination,
        "{{ rows[0].body }}",
        TODAY,
    )
    .unwrap();
    assert_eq!(
        rendered.markdown,
        "![Bottle](../notes/images/bottle.png \"Bottle title\")\n[Notes](../notes/other.md#tasting) and [space](<../notes/two%20words.md> 'Keep title').\n[ref][details]\n\n[details]: ../notes/detail.md \"Reference title\"\n\n[[../notes/other.md|Explicit label]] and [[Canonical name|Unchanged label]].\n[Local](../notes/beer.md#aroma) [web](https://example.com/x) [email](mailto:a@example.com)\n`[literal](./unchanged.md)`\n\n```base\nbase = \"nested\"\n```\n"
    );
}

#[test]
fn context_keeps_native_nested_values_but_hides_operational_metadata_and_destination_body() {
    let source = "+++\nid = \"019fd000-0000-7000-8000-000000000002\"\ntitle = \"Tasting\"\ntags = [\"beer\"]\nmeasured = 2026-09-20\norganic = true\nbatch = { values = [2, 3], label = \"<native>\" }\nconversation = { ledger_hash = \"source-secret\" }\n+++\nPublic body.\n";
    let (_temporary, vault, index, mut destination) = fixture(
        "name = \"Tastings\"\nfilter = { field = \"tags\", op = \"contains\", value = \"beer\" }\n",
        &[("notes/tasting.md", source)],
    );
    destination.meta.extra.insert(
        "conversation".into(),
        toml::Value::String("destination-secret".into()),
    );
    let mut selected = selection();
    selected.view = None;
    selected.filter = None;
    let rendered = render_base(
        vault.root(), index.connection(), &selected, &destination,
        "{{ page.body is defined }}|{{ page.properties.conversation is defined }}|{{ rows[0].properties.conversation is defined }}|{{ rows[0].properties.measured }}|{{ rows[0].properties.organic }}|{{ rows[0].properties.batch['values'] | sum }}|{{ rows[0].properties.batch.label }}|{{ rows[0].properties.missing | default('optional') }}",
        TODAY,
    ).unwrap();
    assert_eq!(
        rendered.markdown,
        "False|False|False|2026-09-20|True|5|<native>|optional"
    );
}

#[test]
fn source_changes_and_current_access_restrictions_never_render_stale_or_private_content() {
    use clep_bases::base_render::RenderError;

    let source = "+++\nid = \"019fd000-0000-7000-8000-000000000002\"\ntitle = \"Tasting\"\ntags = [\"beer\"]\n+++\nObserved body.\n";
    let (_temporary, vault, index, destination) = fixture(
        "name = \"Tastings\"\nfilter = { field = \"tags\", op = \"contains\", value = \"beer\" }\n",
        &[("notes/tasting.md", source)],
    );
    let mut selected = selection();
    selected.view = None;
    selected.filter = None;
    let render = || {
        render_base(
            vault.root(),
            index.connection(),
            &selected,
            &destination,
            "{{ rows[0].body }}",
            TODAY,
        )
    };
    let source_path = vault.root().join("notes/tasting.md");
    let observed = fs::read(&source_path).unwrap();
    fs::write(
        &source_path,
        source.replace("Observed body.", "Changed body."),
    )
    .unwrap();
    assert!(matches!(render(), Err(RenderError::SourceChanged(_))));
    fs::remove_file(&source_path).unwrap();
    assert!(matches!(render(), Err(RenderError::SourceChanged(_))));
    fs::write(&source_path, observed).unwrap();
    fs::write(
        vault.root().join(".clepsydra/config.toml"),
        "[vault]\nexcluded_patterns = [\"notes/**\"]\n",
    )
    .unwrap();
    assert!(matches!(render(), Err(RenderError::InaccessibleSource(_))));
}

#[test]
fn input_budget_is_checked_before_decoding_a_split_multibyte_character() {
    use clep_bases::base_render::{MAX_INPUT_BYTES, RenderError};

    let source = "+++\nid = \"019fd000-0000-7000-8000-000000000002\"\ntitle = \"Tasting\"\ntags = [\"beer\"]\n+++\nSmall body.\n";
    let (_temporary, vault, index, destination) = fixture(
        "name = \"Tastings\"\nfilter = { field = \"tags\", op = \"contains\", value = \"beer\" }\n",
        &[("notes/tasting.md", source)],
    );
    let mut selected = selection();
    selected.view = None;
    selected.filter = None;
    let template = "{{ rows[0].body }}";
    let read_cutoff = MAX_INPUT_BYTES - template.len() - destination.raw_content.len() + 1;
    let mut oversized = source.to_owned();
    oversized.push_str(&"x".repeat(read_cutoff - source.len() - 1));
    oversized.push('é');
    fs::write(vault.root().join("notes/tasting.md"), oversized).unwrap();
    assert!(matches!(
        render_base(
            vault.root(),
            index.connection(),
            &selected,
            &destination,
            template,
            TODAY
        ),
        Err(RenderError::ResourceLimit(_))
    ));
}

#[test]
fn template_failures_and_each_execution_budget_return_errors_not_partial_markdown() {
    use clep_bases::base_render::{MAX_OUTPUT_BYTES, MAX_TEMPLATE_BYTES, RenderError};

    let (_temporary, vault, index, destination) = fixture("name = \"Tastings\"\n", &[]);
    let mut selected = selection();
    selected.view = None;
    selected.filter = None;
    let render = |template: &str| {
        render_base(
            vault.root(),
            index.connection(),
            &selected,
            &destination,
            template,
            TODAY,
        )
    };
    assert!(
        matches!(render("partial {{ missing }}"), Err(RenderError::Template(error)) if error.kind() == minijinja::ErrorKind::UndefinedError)
    );
    assert!(matches!(
        render("{% include 'external' ignore missing %}"),
        Err(RenderError::Template(_))
    ));
    assert!(matches!(
        render("<!-- clep:generated\nversion = 1\n-->"),
        Err(RenderError::InvalidOutput(_))
    ));
    assert!(matches!(
        render(&"x".repeat(MAX_TEMPLATE_BYTES + 1)),
        Err(RenderError::ResourceLimit(_))
    ));
    assert!(matches!(
        render(&format!("prefix {{{{ 'x' * {} }}}}", MAX_OUTPUT_BYTES + 1)),
        Err(RenderError::ResourceLimit(_))
    ));
    assert!(matches!(
        render(
            "{% for a in range(1000) %}{% for b in range(1000) %}{% set value = a + b %}{% endfor %}{% endfor %}"
        ),
        Err(RenderError::ResourceLimit(_))
    ));
    assert!(matches!(
        render("{% for n in [1] recursive %}{{ loop([n]) }}{% endfor %}"),
        Err(RenderError::ResourceLimit(_))
    ));
}

#[test]
fn encrypted_sources_fail_even_when_the_template_only_requests_titles() {
    use clep_bases::base_render::RenderError;

    let source = format!(
        "+++\nid = \"019fd000-0000-7000-8000-000000000002\"\ntitle = \"Private\"\ntags = [\"beer\"]\nencryption = {{ format = \"age\", version = 1, key_id = \"019fd000-0000-7000-8000-000000000003\" }}\n+++\n{}",
        clep_test_support::PRIVATE_NOTE_AGE,
    );
    let (_temporary, vault, index, destination) = fixture(
        "name = \"Tastings\"\nfilter = { field = \"tags\", op = \"contains\", value = \"beer\" }\n",
        &[("notes/private.md", &source)],
    );
    let mut selected = selection();
    selected.view = None;
    selected.filter = None;
    assert!(matches!(
        render_base(
            vault.root(),
            index.connection(),
            &selected,
            &destination,
            "{{ rows[0].title }}",
            TODAY
        ),
        Err(RenderError::InaccessibleSource(_))
    ));
}

#[cfg(unix)]
#[test]
fn symlink_source_cannot_escape_even_if_its_bytes_match_the_indexed_source() {
    use clep_bases::base_render::RenderError;

    let source = "+++\nid = \"019fd000-0000-7000-8000-000000000002\"\ntitle = \"Tasting\"\ntags = [\"beer\"]\n+++\nSecret body.\n";
    let (temporary, vault, index, destination) = fixture(
        "name = \"Tastings\"\nfilter = { field = \"tags\", op = \"contains\", value = \"beer\" }\n",
        &[("notes/tasting.md", source)],
    );
    let source_path = vault.root().join("notes/tasting.md");
    let external = temporary.path().join("external.md");
    fs::rename(&source_path, &external).unwrap();
    std::os::unix::fs::symlink(&external, &source_path).unwrap();
    let mut selected = selection();
    selected.view = None;
    selected.filter = None;
    assert!(matches!(
        render_base(
            vault.root(),
            index.connection(),
            &selected,
            &destination,
            "{{ rows[0].body }}",
            TODAY
        ),
        Err(RenderError::InaccessibleSource(_))
    ));
}

#[test]
fn row_budget_refuses_implicit_truncation_but_allows_an_explicit_thousand_row_snapshot() {
    use clep_bases::base_render::RenderError;

    let pages: Vec<_> = (0..1001)
        .map(|index| (
            format!("notes/{index:04}.md"),
            format!("+++\nid = \"019fd000-0000-7000-8000-{:012}\"\ntitle = \"Beer {index:04}\"\ntags = [\"beer\"]\nflag = {}\n+++\n", index + 2, index != 0),
        ))
        .collect();
    let borrowed: Vec<_> = pages
        .iter()
        .map(|(path, source)| (path.as_str(), source.as_str()))
        .collect();
    let (_temporary, vault, index, destination) = fixture(
        "name = \"Tastings\"\nfilter = { field = \"tags\", op = \"contains\", value = \"beer\" }\n[properties.flag]\ntype = \"bool\"\n[[views]]\nname = \"Public\"\ngroup_by = \"flag\"\n",
        &borrowed,
    );
    let mut selected = selection();
    selected.filter = None;
    let template = "{{ rows | length }}:{{ groups[0].key is boolean }}:{{ groups[0].key }}:{{ groups[1].rows | length }}";
    assert!(matches!(
        render_base(
            vault.root(),
            index.connection(),
            &selected,
            &destination,
            template,
            TODAY
        ),
        Err(RenderError::ResourceLimit(_))
    ));
    selected.limit = Some(1000);
    let bounded = render_base(
        vault.root(),
        index.connection(),
        &selected,
        &destination,
        template,
        TODAY,
    )
    .unwrap();
    assert_eq!(bounded.markdown, "1000:True:False:999");
    assert_eq!(bounded.selected_count, 1000);
    assert_eq!(bounded.limit, Some(1000));
}
