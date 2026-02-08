use clepsydra::vault::import::parse_bibtex;

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
