use clepsydra::vault::import::{find_existing_work, parse_bibtex};
use clepsydra::vault::import_doi::parse_crossref_response;
use clepsydra::vault::import_isbn::parse_openlibrary_response;
use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;
use std::fs;
use tempfile::TempDir;

#[test]
fn parse_single_article() {
    let bib = r#"
@article{vaswani2017attention,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam},
  journal = {NeurIPS},
  year = {2017},
  doi = {10.48550/arXiv.1706.03762}
}
"#;
    let entries = parse_bibtex(bib).unwrap();
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    assert_eq!(e.cite_key, "vaswani2017attention");
    assert_eq!(e.title, "Attention Is All You Need");
    assert_eq!(e.authors, vec!["Ashish Vaswani", "Noam Shazeer"]);
    assert_eq!(e.year, Some(2017));
    assert_eq!(e.venue, Some("NeurIPS".to_string()));
    assert_eq!(e.doi, Some("10.48550/arXiv.1706.03762".to_string()));
    assert!(matches!(
        e.work_type,
        clepsydra::vault::academic::WorkType::Paper
    ));
}

#[test]
fn parse_book_entry() {
    let bib = r#"
@book{bishop2006pattern,
  title = {Pattern Recognition and Machine Learning},
  author = {Bishop, Christopher M.},
  year = {2006},
  publisher = {Springer},
  isbn = {978-0-387-31073-2}
}
"#;
    let entries = parse_bibtex(bib).unwrap();
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    assert!(matches!(
        e.work_type,
        clepsydra::vault::academic::WorkType::Book
    ));
    assert_eq!(e.authors, vec!["Christopher M. Bishop"]);
    assert_eq!(e.publisher, Some("Springer".to_string()));
    assert_eq!(e.isbn, Some("978-0-387-31073-2".to_string()));
}

#[test]
fn parse_multiple_entries() {
    let bib = r#"
@article{paper1, title={First}, author={One, Author}, year={2020}}
@article{paper2, title={Second}, author={Two, Author}, year={2021}}
@book{book1, title={Third}, author={Three, Author}, year={2022}}
"#;
    let entries = parse_bibtex(bib).unwrap();
    assert_eq!(entries.len(), 3);
}

#[test]
fn author_name_normalization() {
    let bib = r#"
@article{test2024,
  title = {Test},
  author = {von Neumann, John and De Morgan, Augustus},
  year = {2024}
}
"#;
    let entries = parse_bibtex(bib).unwrap();
    let e = &entries[0];
    // "von Neumann, John" -> Person{given_name:"John", prefix:"von", name:"Neumann"} -> "John von Neumann"
    // "De Morgan, Augustus" -> Person{given_name:"Augustus", prefix:"", name:"De Morgan"} -> "Augustus De Morgan"
    assert_eq!(e.authors[0], "John von Neumann");
    assert_eq!(e.authors[1], "Augustus De Morgan");
}

#[test]
fn parse_thesis_and_report() {
    let bib = r#"
@phdthesis{smith2020, title={My Dissertation}, author={Smith, Jane}, year={2020}, school={MIT}}
@techreport{jones2021, title={Technical Report}, author={Jones, Bob}, year={2021}, institution={NIST}}
"#;
    let entries = parse_bibtex(bib).unwrap();
    assert_eq!(entries.len(), 2);
    assert!(matches!(
        entries[0].work_type,
        clepsydra::vault::academic::WorkType::Thesis
    ));
    assert!(matches!(
        entries[1].work_type,
        clepsydra::vault::academic::WorkType::Report
    ));
}

#[test]
fn parse_invalid_bibtex_returns_error() {
    // A malformed entry (missing '=' between field name and value) triggers a parse error.
    let bib = "@article{key, title {missing equals}}";
    let result = parse_bibtex(bib);
    assert!(result.is_err());
}

#[test]
fn parse_empty_input_returns_empty_vec() {
    let bib = "this is not valid bibtex at all";
    let entries = parse_bibtex(bib).unwrap();
    assert!(entries.is_empty());
}

#[test]
fn dedup_by_doi_finds_existing() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    fs::create_dir_all(root.join("library/papers")).unwrap();

    let work_content = "\
---
id: 00000000-0000-0000-0000-000000000500
kind: work
work_type: paper
title: Existing Paper
cite_key: existing2024
tags: []
external_ids:
  doi: \"10.1234/existing\"
---
Content.
";
    fs::write(root.join("library/papers/existing.md"), work_content).unwrap();

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    // Should find by DOI
    let found = find_existing_work(
        index.connection(),
        Some("10.1234/existing"),
        None,
        None,
    );
    assert!(found.is_some(), "should find existing work by DOI");

    // Should NOT find with different DOI
    let not_found = find_existing_work(
        index.connection(),
        Some("10.1234/different"),
        None,
        None,
    );
    assert!(not_found.is_none());
}

#[test]
fn dedup_by_cite_key_finds_existing() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    fs::create_dir_all(root.join("library/papers")).unwrap();

    let work_content = "\
---
id: 00000000-0000-0000-0000-000000000501
kind: work
work_type: paper
title: Another Paper
cite_key: another2024
tags: []
---
Content.
";
    fs::write(root.join("library/papers/another.md"), work_content).unwrap();

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    // Should find by cite_key (via canonical_names table, populated by CiteKeyDeriver)
    let found = find_existing_work(
        index.connection(),
        None,
        None,
        Some("another2024"),
    );
    assert!(found.is_some(), "should find existing work by cite_key");
}

#[test]
fn parse_crossref_json_into_import_entry() {
    let json = serde_json::json!({
        "status": "ok",
        "message": {
            "type": "journal-article",
            "title": ["Nanometre-scale thermometry in a living cell"],
            "author": [
                {"given": "G.", "family": "Kucsko", "sequence": "first"},
                {"given": "P. C.", "family": "Maurer", "sequence": "additional"}
            ],
            "published-print": {"date-parts": [[2013, 8]]},
            "container-title": ["Nature"],
            "publisher": "Springer Science and Business Media LLC",
            "DOI": "10.1038/nature12373",
            "ISBN": null
        }
    });

    let entry = parse_crossref_response(&json).unwrap();
    assert_eq!(entry.title, "Nanometre-scale thermometry in a living cell");
    assert_eq!(entry.authors, vec!["G. Kucsko", "P. C. Maurer"]);
    assert_eq!(entry.year, Some(2013));
    assert_eq!(entry.venue, Some("Nature".to_string()));
    assert_eq!(entry.doi, Some("10.1038/nature12373".to_string()));
    assert!(matches!(
        entry.work_type,
        clepsydra::vault::academic::WorkType::Paper
    ));
    assert_eq!(entry.cite_key, "kucsko2013nanometrescale");
}

#[test]
fn parse_openlibrary_json_into_import_entry() {
    let json = serde_json::json!({
        "title": "Pattern Recognition and Machine Learning",
        "authors": [{"key": "/authors/OL1394865A"}],
        "publish_date": "2006",
        "publishers": ["Springer"],
        "isbn_13": ["9780387310732"],
        "isbn_10": ["0387310738"],
        "key": "/books/OL7941839M"
    });

    let authors = vec!["Christopher M. Bishop".to_string()];
    let entry = parse_openlibrary_response(&json, &authors, "978-0-387-31073-2").unwrap();
    assert_eq!(entry.title, "Pattern Recognition and Machine Learning");
    assert_eq!(entry.authors, vec!["Christopher M. Bishop"]);
    assert_eq!(entry.year, Some(2006));
    assert_eq!(entry.publisher, Some("Springer".to_string()));
    assert!(matches!(
        entry.work_type,
        clepsydra::vault::academic::WorkType::Book
    ));
    assert_eq!(entry.isbn, Some("978-0-387-31073-2".to_string()));
}
