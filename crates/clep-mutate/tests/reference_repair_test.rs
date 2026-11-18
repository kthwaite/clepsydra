use std::fs;

use clep_index::index::VaultIndex;
use clep_index::reference_issues::{ReferenceIssue, ReferenceIssueFilter};
use clep_mutate::reference_repair::{
    ReferenceRepairAction, ReferenceRepairRequest, prepare_reference_repair,
};
use clep_vault::Vault;
use clep_vault::init::init_vault;
use tempfile::TempDir;
use uuid::Uuid;

fn page(n: u128, extra: &str, body: &str) -> String {
    format!(
        "+++\nid = \"{}\"\n{extra}created_at = 2026-01-02T03:04:05Z\nupdated_at = 2026-01-02T03:04:05Z\n+++\n{body}",
        Uuid::from_u128(0x019f_d000_0000_7000_8000_0000_0000_0000 + n)
    )
}

fn setup(files: &[(&str, String)]) -> (TempDir, Vault, VaultIndex) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("vault");
    init_vault(&root).unwrap();
    let vault = Vault::open(&root).unwrap();
    for (path, content) in files {
        fs::write(vault.root().join(path), content).unwrap();
    }
    let mut index = VaultIndex::open_in_memory().unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();
    (temp, vault, index)
}

fn replaceable_issues(index: &VaultIndex, source: &str) -> Vec<ReferenceIssue> {
    index
        .reference_issues(ReferenceIssueFilter {
            limit: u32::MAX,
            ..ReferenceIssueFilter::default()
        })
        .unwrap()
        .items
        .into_iter()
        .filter(|issue| issue.source_path == source && !issue.candidates.is_empty())
        .collect()
}

#[test]
fn replace_repairs_the_occurrence_its_issue_names_among_duplicate_property_values() {
    let (_temp, vault, index) = setup(&[
        (
            "a.md",
            page(1, "link = [\"Shared\", \"other\", \"Shared\"]\n", "one\n"),
        ),
        ("b.md", page(2, "title = \"Shared\"\n", "two\n")),
        ("c.md", page(3, "title = \"Shared\"\n", "three\n")),
        ("other.md", page(4, "", "four\n")),
    ]);

    // One issue per ambiguous value, each advertising Replace.
    let issues = replaceable_issues(&index, "a.md");
    assert_eq!(issues.len(), 2);
    let candidate = issues[0].candidates[0].page_id.clone();

    let contents: Vec<String> = issues
        .into_iter()
        .map(|issue| {
            let prepared = prepare_reference_repair(
                &vault,
                &index,
                ReferenceRepairRequest {
                    fingerprint: issue.fingerprint,
                    source_revision: issue.source_revision,
                    action: ReferenceRepairAction::Replace {
                        candidate_page_id: candidate.clone(),
                    },
                },
            )
            .unwrap();
            assert_eq!(prepared.before, "link: Shared");
            assert_eq!(prepared.after, format!("link: {candidate}"));
            let [clep_mutate::batch_mutation::BatchPathIntent::Write { content, .. }] =
                prepared.command.intents.as_slice()
            else {
                panic!("expected one write");
            };
            String::from_utf8(content.clone()).unwrap()
        })
        .collect();

    // Each repair replaces its own value and leaves the other one.
    let first = format!("link = [\"{candidate}\", \"other\", \"Shared\"]\n");
    let second = format!("link = [\"Shared\", \"other\", \"{candidate}\"]\n");
    let mut expected = vec![page(1, &first, "one\n"), page(1, &second, "one\n")];
    let mut contents = contents;
    expected.sort();
    contents.sort();
    assert_eq!(contents, expected);
}
