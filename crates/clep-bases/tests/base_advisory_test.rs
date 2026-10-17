use clep_bases::{
    base::{BaseDiagnosticSeverity, parse_base},
    base_document,
};
use std::{fs, path::Path};

#[test]
fn advisory_fields_and_row_templates_survive_safe_document_updates() {
    let raw = r###"# authored base
name = "Ledger"
[properties.amount]
type = "number"
description = "Amount due" # keep explanation
default = 12.5
format = "currency"
currency = "USD"
display = "bar"
target = 200

[[templates]]
# authored template
name = "Invoice"
body = "## Notes\n"
[templates.fields]
title = "New invoice"
amount = 42
"###;
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("bases")).unwrap();
    fs::write(root.path().join("bases/ledger.base.toml"), raw).unwrap();
    let loaded = base_document::load(root.path(), "ledger").unwrap();
    let mut file = loaded.definition.file.clone();
    assert_eq!(file.properties[0].1.default, Some(serde_json::json!(12.5)));
    assert_eq!(file.templates[0].fields["amount"], 42);
    let json = serde_json::to_value(&file).unwrap();
    let decoded = serde_json::from_value(json).unwrap();
    file = decoded;
    file.name = "Invoices".into();
    file.properties[0].1.description = Some("Invoice amount".into());
    file.templates[0]
        .fields
        .insert("amount".into(), serde_json::json!(75));
    let saved = base_document::update(root.path(), "ledger", &loaded.revision, &file, &[]).unwrap();
    assert_eq!(
        saved.definition.file.templates[0].body.as_deref(),
        Some("## Notes\n")
    );
    assert_eq!(saved.definition.file.templates[0].fields["amount"], 75);
    assert_eq!(
        saved.definition.file.properties[0].1.description.as_deref(),
        Some("Invoice amount")
    );
    let text = fs::read_to_string(root.path().join("bases/ledger.base.toml")).unwrap();
    assert!(text.contains("# keep explanation"));
    assert!(text.contains("# authored template"));
}

#[test]
fn invalid_advisory_values_have_actionable_diagnostics() {
    for declaration in [
        "type = 'number'\ndefault = 'twelve'",
        "type = 'select'\noptions = ['a']\ndefault = 'b'",
        "type = 'date'\ndefault = '2026-02-30'",
        "type = 'bool'\ndefault = 'true'",
        "type = 'multi_select'\noptions = ['a']\ndefault = ['b']",
        "type = 'number'\nformat = 'currency'\ncurrency = 'ZZZ'",
        "type = 'text'\nformat = 'percent'",
        "type = 'number'\ntarget = 0",
    ] {
        let (_, diagnostics) = parse_base(
            Path::new("bad.base.toml"),
            &format!("name = 'Bad'\n[properties.value]\n{declaration}\n"),
        );
        assert!(
            diagnostics
                .iter()
                .any(|d| matches!(d.severity, BaseDiagnosticSeverity::Error)),
            "{declaration}: {diagnostics:?}"
        );
    }
    for templates in [
        "[[templates]]\nname = 'A'\n[[templates]]\nname = 'A'",
        "[[templates]]\nname = ''",
        "[[templates]]\nname = 'A'\nfields = { unknown = 1 }",
        "[[templates]]\nname = 'A'\nfields = { value = 'wrong' }",
        "[[templates]]\nname = 'A'\nfields = { kind = 'MADE_UP' }",
        "[[templates]]\nname = 'A'\nfields = { tags = 'tag' }",
        "[[templates]]\nname = 'A'\nfields = { id = 'locked' }",
    ] {
        let (_, diagnostics) = parse_base(
            Path::new("bad.base.toml"),
            &format!("name = 'Bad'\n[properties.value]\ntype = 'number'\n{templates}\n"),
        );
        assert!(
            diagnostics
                .iter()
                .any(|d| matches!(d.severity, BaseDiagnosticSeverity::Error)),
            "{templates}: {diagnostics:?}"
        );
    }
}

#[test]
fn defaults_and_qualified_template_fields_survive_toml_roundtrip() {
    let raw = r#"
name = "Typed defaults"
[properties.text]
type = "text"
default = "Draft"
[properties.amount]
type = "number"
default = 2.5
[properties.done]
type = "bool"
default = false
[properties.day]
type = "date"
default = "2026-10-17"
[properties.moment]
type = "datetime"
default = "2026-10-17T10:30:00Z"
[properties.status]
type = "select"
options = ["queued"]
default = "queued"
[properties.labels]
type = "multi_select"
options = ["a", "b"]
default = ["a", "b"]
[properties.link]
type = "url"
default = "https://example.org"
[properties.related]
type = "relation"
default = ["[[Other]]"]
[properties.kind]
type = "number"
default = 7
[[templates]]
name = "Draft"
fields = { title = "A draft", "sys.kind" = "NOTE", "prop.kind" = 12, amount = 4, tags = ["draft"], aliases = [] }
"#;
    let (base, diagnostics) = parse_base(Path::new("typed.base.toml"), raw);
    assert!(
        !diagnostics
            .iter()
            .any(|d| matches!(d.severity, BaseDiagnosticSeverity::Error)),
        "{diagnostics:?}"
    );
    let base = base.unwrap();
    assert_eq!(base.file.templates[0].fields["prop.kind"], 12);
    let serialized = toml::to_string(&base.file).unwrap();
    let (roundtrip, diagnostics) = parse_base(Path::new("typed.base.toml"), &serialized);
    assert!(
        !diagnostics
            .iter()
            .any(|d| matches!(d.severity, BaseDiagnosticSeverity::Error)),
        "{diagnostics:?}"
    );
    let roundtrip = roundtrip.unwrap();
    assert_eq!(
        roundtrip.property("moment").unwrap().default,
        Some(serde_json::json!("2026-10-17T10:30:00Z"))
    );
    assert_eq!(roundtrip.file.templates[0].fields["prop.kind"], 12);
}

#[test]
fn creation_metadata_rejects_system_owned_custom_keys() {
    for key in ["title", "id", "conversation", "readonly"] {
        for metadata in [
            format!("[properties.{key}]\ntype = 'text'\ndefault = 'value'"),
            format!(
                "[properties.{key}]\ntype = 'text'\n[[templates]]\nname = 'Bad'\nfields = {{ 'prop.{key}' = 'value' }}"
            ),
        ] {
            let (_, diagnostics) = parse_base(
                Path::new("bad.base.toml"),
                &format!("name = 'Bad'\n{metadata}\n"),
            );
            assert!(
                diagnostics.iter().any(|diagnostic| {
                    matches!(diagnostic.severity, BaseDiagnosticSeverity::Error)
                        && diagnostic
                            .path
                            .as_ref()
                            .is_some_and(|path| path.contains(key))
                        && diagnostic.message.contains("creation")
                }),
                "{key}: {diagnostics:?}"
            );
        }
    }
}
