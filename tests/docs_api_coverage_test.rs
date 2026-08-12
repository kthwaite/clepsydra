use std::collections::{BTreeMap, BTreeSet};

use clepsydra::api::openapi::ApiDoc;
use utoipa::OpenApi;

const HTTP_METHODS: &[&str] = &["get", "put", "post", "delete", "options", "head", "patch", "trace"];

#[derive(Debug, Eq, Ord, PartialEq, PartialOrd)]
struct PublicOperation {
    method: String,
    path: String,
    tags: Vec<String>,
}

fn public_openapi_operations() -> BTreeSet<PublicOperation> {
    let document = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI should serialize");
    let paths = document["paths"]
        .as_object()
        .expect("OpenAPI paths should be an object");
    let mut operations = BTreeSet::new();

    for (path, item) in paths {
        let item = item
            .as_object()
            .unwrap_or_else(|| panic!("OpenAPI path item {path} should be an object"));
        for method in HTTP_METHODS {
            let Some(operation) = item.get(*method) else {
                continue;
            };
            let tags = operation["tags"]
                .as_array()
                .unwrap_or_else(|| panic!("{method} {path} should declare at least one tag"))
                .iter()
                .map(|tag| {
                    tag.as_str()
                        .unwrap_or_else(|| panic!("{method} {path} tag should be a string"))
                        .to_owned()
                })
                .collect::<Vec<_>>();
            assert!(!tags.is_empty(), "{method} {path} should declare at least one tag");

            operations.insert(PublicOperation {
                method: method.to_uppercase(),
                path: path.clone(),
                tags,
            });
        }
    }

    operations
}

fn documented_operations_by_tag(docs: &str) -> BTreeMap<&str, BTreeSet<&str>> {
    let mut sections = BTreeMap::<&str, BTreeSet<&str>>::new();
    let mut current_tag = None;

    for line in docs.lines() {
        if let Some(tag) = line.strip_prefix("## ") {
            current_tag = Some(tag);
        } else if line.starts_with("### `") {
            if let Some(tag) = current_tag {
                sections.entry(tag).or_default().insert(line);
            }
        }
    }

    sections
}

fn missing_operations(operations: &BTreeSet<PublicOperation>, docs: &str) -> Vec<String> {
    let documented = documented_operations_by_tag(docs);
    operations
        .iter()
        .filter_map(|operation| {
            let canonical = format!("### `{} {}`", operation.method, operation.path);
            let covered = operation.tags.iter().any(|tag| {
                documented
                    .get(tag.as_str())
                    .is_some_and(|headings| headings.contains(canonical.as_str()))
            });
            (!covered).then(|| {
                format!(
                    "{} {} [{}]",
                    operation.method,
                    operation.path,
                    operation.tags.join(", ")
                )
            })
        })
        .collect()
}

fn coverage_result(
    operations: &BTreeSet<PublicOperation>,
    docs: &str,
) -> Result<Vec<String>, &'static str> {
    if operations.is_empty() {
        Err("OpenAPI operation inventory is empty")
    } else {
        Ok(missing_operations(operations, docs))
    }
}

fn synthetic_operation() -> BTreeSet<PublicOperation> {
    BTreeSet::from([PublicOperation {
        method: "GET".to_owned(),
        path: "/api/vault/pages".to_owned(),
        tags: vec!["Pages".to_owned()],
    }])
}

#[test]
fn coverage_reports_a_missing_canonical_heading() {
    let missing = coverage_result(&synthetic_operation(), "## Pages\n")
        .expect("non-empty inventory should be checked");
    assert_eq!(missing, ["GET /api/vault/pages [Pages]"]);
}

#[test]
fn coverage_does_not_accept_a_bare_generated_tag_marker() {
    let docs = "## Pages\n<!-- generated-reference: Pages -->\n";
    let missing = coverage_result(&synthetic_operation(), docs)
        .expect("non-empty inventory should be checked");
    assert_eq!(missing, ["GET /api/vault/pages [Pages]"]);
}

#[test]
fn coverage_requires_the_heading_under_its_declared_tag_section() {
    let docs = "## Index\n### `GET /api/vault/pages`\n";
    let missing = coverage_result(&synthetic_operation(), docs)
        .expect("non-empty inventory should be checked");
    assert_eq!(missing, ["GET /api/vault/pages [Pages]"]);
}

#[test]
fn coverage_rejects_an_empty_operation_inventory() {
    assert_eq!(
        coverage_result(&BTreeSet::new(), "## Pages\n"),
        Err("OpenAPI operation inventory is empty")
    );
}

#[test]
fn every_openapi_operation_is_documented() {
    let operations = public_openapi_operations();
    let docs = std::fs::read_to_string("ui/src/docs/content/api-reference.mdx").unwrap_or_default();
    let missing = coverage_result(&operations, &docs)
        .expect("OpenAPI operation inventory should not be empty");

    assert!(
        missing.is_empty(),
        "{} of {} public OpenAPI operations lack canonical method/path headings:\n{}",
        missing.len(),
        operations.len(),
        missing.join("\n"),
    );
}
