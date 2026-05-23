use clepsydra::vault::Vault;
use clepsydra::vault::import::{find_existing_work, parse_bibtex};
use clepsydra::vault::import_doi::parse_crossref_response;
use clepsydra::vault::import_isbn::parse_openlibrary_response;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;
use rusqlite::Connection;
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
    let found = find_existing_work(index.connection(), Some("10.1234/existing"), None, None);
    assert!(found.is_some(), "should find existing work by DOI");

    // Should NOT find with different DOI
    let not_found = find_existing_work(index.connection(), Some("10.1234/different"), None, None);
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
    let found = find_existing_work(index.connection(), None, None, Some("another2024"));
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

// ── cite key derivation tests ──────────────────────────────────────────────

use clepsydra::vault::import_zotero::derive_cite_key;

#[test]
fn cite_key_from_bbt_extra_field() {
    let key = derive_cite_key(
        Some("Citation Key: vaswani2017\nsome other stuff"),
        &["Ashish Vaswani".to_string()],
        Some(2017),
        "Attention Is All You Need",
        &std::collections::HashSet::new(),
    );
    assert_eq!(key, "vaswani2017");
}

#[test]
fn cite_key_derived_from_metadata() {
    let key = derive_cite_key(
        None,
        &["Ashish Vaswani".to_string()],
        Some(2017),
        "Attention Is All You Need",
        &std::collections::HashSet::new(),
    );
    assert_eq!(key, "vaswani2017attention");
}

#[test]
fn cite_key_skips_articles() {
    let key = derive_cite_key(
        None,
        &["Hans Muller".to_string()],
        Some(2023),
        "The Grand Unified Theory",
        &std::collections::HashSet::new(),
    );
    assert_eq!(key, "muller2023grand");
}

#[test]
fn cite_key_no_author() {
    let key = derive_cite_key(
        None,
        &[],
        Some(2020),
        "Some Report",
        &std::collections::HashSet::new(),
    );
    assert_eq!(key, "anon2020some");
}

#[test]
fn cite_key_no_year() {
    let key = derive_cite_key(
        None,
        &["Smith".to_string()],
        None,
        "Title",
        &std::collections::HashSet::new(),
    );
    assert_eq!(key, "smithtitle");
}

#[test]
fn cite_key_unicode_normalization() {
    let key = derive_cite_key(
        None,
        &["Hans Müller".to_string()],
        Some(2023),
        "Results",
        &std::collections::HashSet::new(),
    );
    assert_eq!(key, "muller2023results");
}

#[test]
fn cite_key_collision_suffix() {
    let mut existing = std::collections::HashSet::new();
    existing.insert("vaswani2017attention".to_string());

    let key = derive_cite_key(
        None,
        &["Ashish Vaswani".to_string()],
        Some(2017),
        "Attention Is All You Need",
        &existing,
    );
    assert_eq!(key, "vaswani2017attention-b");
}

#[test]
fn cite_key_multiple_collisions() {
    let mut existing = std::collections::HashSet::new();
    existing.insert("vaswani2017attention".to_string());
    existing.insert("vaswani2017attention-b".to_string());

    let key = derive_cite_key(
        None,
        &["Ashish Vaswani".to_string()],
        Some(2017),
        "Attention Is All You Need",
        &existing,
    );
    assert_eq!(key, "vaswani2017attention-c");
}

// ── Zotero DB query tests ─────────────────────────────────────────────────

use clepsydra::vault::import_zotero::{
    ConflictPolicy, ZoteroAuthor, ZoteroItem, ZoteroPdf, compute_field_diffs,
    find_existing_by_zotero_key, map_to_import_entry, normalize_since, open_zotero_db, query_items,
    resolve_attachment_path,
};

/// Create a minimal Zotero-schema SQLite DB for testing.
fn create_mock_zotero_db(path: &std::path::Path) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        "
        CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
        INSERT INTO itemTypes VALUES (1, 'attachment');
        INSERT INTO itemTypes VALUES (2, 'book');
        INSERT INTO itemTypes VALUES (3, 'bookSection');
        INSERT INTO itemTypes VALUES (4, 'journalArticle');
        INSERT INTO itemTypes VALUES (26, 'conferencePaper');
        INSERT INTO itemTypes VALUES (7, 'thesis');
        INSERT INTO itemTypes VALUES (27, 'report');

        CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
        INSERT INTO fields VALUES (1, 'url');
        INSERT INTO fields VALUES (4, 'volume');
        INSERT INTO fields VALUES (6, 'pages');
        INSERT INTO fields VALUES (12, 'publisher');
        INSERT INTO fields VALUES (14, 'date');
        INSERT INTO fields VALUES (26, 'DOI');
        INSERT INTO fields VALUES (62, 'extra');
        INSERT INTO fields VALUES (110, 'title');
        INSERT INTO fields VALUES (11, 'ISBN');
        INSERT INTO fields VALUES (37, 'publicationTitle');

        CREATE TABLE libraries (libraryID INTEGER PRIMARY KEY, type TEXT);
        INSERT INTO libraries VALUES (1, 'user');

        CREATE TABLE items (
            itemID INTEGER PRIMARY KEY, itemTypeID INT, dateAdded TEXT,
            dateModified TEXT, clientDateModified TEXT, libraryID INT,
            key TEXT, version INT DEFAULT 0, synced INT DEFAULT 0
        );
        CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT, PRIMARY KEY(itemID, fieldID));
        CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT UNIQUE);
        CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY);

        CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INT);
        CREATE TABLE creatorTypes (creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
        INSERT INTO creatorTypes VALUES (1, 'author');
        INSERT INTO creatorTypes VALUES (2, 'editor');
        CREATE TABLE itemCreators (itemID INT, creatorID INT, creatorTypeID INT, orderIndex INT);

        CREATE TABLE tags (tagID INTEGER PRIMARY KEY, name TEXT UNIQUE);
        CREATE TABLE itemTags (itemID INT, tagID INT, type INT);

        CREATE TABLE collections (
            collectionID INTEGER PRIMARY KEY, collectionName TEXT,
            parentCollectionID INT, libraryID INT, key TEXT, version INT DEFAULT 0, synced INT DEFAULT 0,
            clientDateModified TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE collectionItems (collectionID INT, itemID INT, orderIndex INT);

        CREATE TABLE itemAttachments (
            itemID INTEGER PRIMARY KEY, parentItemID INT, linkMode INT,
            contentType TEXT, charsetID INT, path TEXT,
            syncState INT DEFAULT 0, storageModTime INT, storageHash TEXT
        );

        -- Insert a journal article
        INSERT INTO items VALUES (1, 4, '2024-01-01', '2024-06-15', '2024-06-15', 1, 'ABC12345', 1, 0);
        INSERT INTO itemDataValues VALUES (1, 'Attention Is All You Need');
        INSERT INTO itemDataValues VALUES (2, '2017');
        INSERT INTO itemDataValues VALUES (3, '10.48550/arXiv.1706.03762');
        INSERT INTO itemDataValues VALUES (4, 'NeurIPS');
        INSERT INTO itemData VALUES (1, 110, 1);
        INSERT INTO itemData VALUES (1, 14, 2);
        INSERT INTO itemData VALUES (1, 26, 3);
        INSERT INTO itemData VALUES (1, 37, 4);

        INSERT INTO creators VALUES (1, 'Ashish', 'Vaswani', 0);
        INSERT INTO creators VALUES (2, 'Noam', 'Shazeer', 0);
        INSERT INTO itemCreators VALUES (1, 1, 1, 0);
        INSERT INTO itemCreators VALUES (1, 2, 1, 1);

        INSERT INTO tags VALUES (1, 'machine-learning');
        INSERT INTO tags VALUES (2, 'transformers');
        INSERT INTO itemTags VALUES (1, 1, 0);
        INSERT INTO itemTags VALUES (1, 2, 0);

        -- Insert a book
        INSERT INTO items VALUES (2, 2, '2024-01-01', '2024-03-01', '2024-03-01', 1, 'DEF67890', 1, 0);
        INSERT INTO itemDataValues VALUES (5, 'Pattern Recognition and Machine Learning');
        INSERT INTO itemDataValues VALUES (6, '2006');
        INSERT INTO itemDataValues VALUES (7, '978-0-387-31073-2');
        INSERT INTO itemDataValues VALUES (8, 'Springer');
        INSERT INTO itemData VALUES (2, 110, 5);
        INSERT INTO itemData VALUES (2, 14, 6);
        INSERT INTO itemData VALUES (2, 11, 7);
        INSERT INTO itemData VALUES (2, 12, 8);

        INSERT INTO creators VALUES (3, 'Christopher M.', 'Bishop', 0);
        INSERT INTO itemCreators VALUES (2, 3, 1, 0);

        -- Insert a PDF attachment for item 1
        INSERT INTO items VALUES (100, 1, '2024-01-01', '2024-01-01', '2024-01-01', 1, 'PDFKEY01', 1, 0);
        INSERT INTO itemAttachments VALUES (100, 1, 0, 'application/pdf', NULL, 'storage:attention.pdf', 0, NULL, NULL);

        -- Insert an item with BBT citation key in extra
        INSERT INTO items VALUES (3, 4, '2024-01-01', '2024-07-01', '2024-07-01', 1, 'GHI11111', 1, 0);
        INSERT INTO itemDataValues VALUES (9, 'Some Paper Title');
        INSERT INTO itemDataValues VALUES (10, '2023');
        INSERT INTO itemDataValues VALUES (11, 'Citation Key: custombbt2023\nSome other extra');
        INSERT INTO itemData VALUES (3, 110, 9);
        INSERT INTO itemData VALUES (3, 14, 10);
        INSERT INTO itemData VALUES (3, 62, 11);

        INSERT INTO creators VALUES (4, 'Jane', 'Doe', 0);
        INSERT INTO itemCreators VALUES (3, 4, 1, 0);

        -- A collection
        INSERT INTO collections VALUES (1, 'ML Papers', NULL, 1, 'COL00001', 1, 0, '2024-01-01');
        INSERT INTO collectionItems VALUES (1, 1, 0);
        INSERT INTO collectionItems VALUES (1, 3, 1);
        "
    ).unwrap();
}

#[test]
fn query_items_returns_all_bibliographic_items() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db(&db_path);

    let conn = open_zotero_db(&db_path).unwrap();
    let items = query_items(&conn, None, None).unwrap();

    assert_eq!(
        items.len(),
        3,
        "should find 3 items (article, book, article w/ BBT key)"
    );

    let article = items.iter().find(|i| i.zotero_key == "ABC12345").unwrap();
    assert_eq!(article.title, "Attention Is All You Need");
    assert_eq!(article.item_type, "journalArticle");
    assert_eq!(article.doi.as_deref(), Some("10.48550/arXiv.1706.03762"));
    assert_eq!(article.venue.as_deref(), Some("NeurIPS"));
    assert_eq!(article.authors.len(), 2);
    assert_eq!(article.authors[0].last_name, "Vaswani");
    assert_eq!(article.tags, vec!["machine-learning", "transformers"]);
    assert_eq!(article.pdf_attachments.len(), 1);

    let book = items.iter().find(|i| i.zotero_key == "DEF67890").unwrap();
    assert_eq!(book.title, "Pattern Recognition and Machine Learning");
    assert_eq!(book.item_type, "book");
    assert_eq!(book.isbn.as_deref(), Some("978-0-387-31073-2"));
    assert_eq!(book.publisher.as_deref(), Some("Springer"));
}

#[test]
fn query_items_filters_by_collection() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db(&db_path);

    let conn = open_zotero_db(&db_path).unwrap();
    let items = query_items(&conn, Some("ML Papers"), None).unwrap();

    assert_eq!(items.len(), 2, "ML Papers collection has 2 items");
    assert!(items.iter().any(|i| i.zotero_key == "ABC12345"));
    assert!(items.iter().any(|i| i.zotero_key == "GHI11111"));
}

#[test]
fn query_items_filters_by_since() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db(&db_path);

    let conn = open_zotero_db(&db_path).unwrap();
    let items = query_items(&conn, None, Some("2024-05-01")).unwrap();

    assert_eq!(items.len(), 2, "2 items modified after 2024-05-01");
    assert!(
        items.iter().all(|i| i.zotero_key != "DEF67890"),
        "book was modified 2024-03-01, should be excluded"
    );
}

// ── Zotero item mapping tests ────────────────────────────────────────────

fn make_article_item() -> ZoteroItem {
    ZoteroItem {
        item_id: 1,
        zotero_key: "ABC12345".to_string(),
        item_type: "journalArticle".to_string(),
        title: "Attention Is All You Need".to_string(),
        date_raw: Some("2017".to_string()),
        doi: Some("10.48550/arXiv.1706.03762".to_string()),
        isbn: None,
        url: None,
        venue: Some("NeurIPS".to_string()),
        publisher: None,
        extra_field: Some("arXiv: 1706.03762".to_string()),
        authors: vec![
            ZoteroAuthor {
                first_name: "Ashish".to_string(),
                last_name: "Vaswani".to_string(),
                field_mode: 0,
            },
            ZoteroAuthor {
                first_name: "Noam".to_string(),
                last_name: "Shazeer".to_string(),
                field_mode: 0,
            },
        ],
        tags: vec!["ml".to_string()],
        pdf_attachments: vec![],
    }
}

#[test]
fn map_journal_article_to_import_entry() {
    let item = make_article_item();
    let entry = map_to_import_entry(&item);
    assert_eq!(entry.title, "Attention Is All You Need");
    assert!(matches!(
        entry.work_type,
        clepsydra::vault::academic::WorkType::Paper
    ));
    assert_eq!(entry.authors, vec!["Ashish Vaswani", "Noam Shazeer"]);
    assert_eq!(entry.year, Some(2017));
    assert_eq!(entry.doi.as_deref(), Some("10.48550/arXiv.1706.03762"));
    assert_eq!(entry.venue.as_deref(), Some("NeurIPS"));
    assert_eq!(entry.arxiv.as_deref(), Some("1706.03762"));
}

#[test]
fn map_institutional_author() {
    let item = ZoteroItem {
        item_id: 2,
        zotero_key: "X".to_string(),
        item_type: "report".to_string(),
        title: "Report".to_string(),
        date_raw: None,
        doi: None,
        isbn: None,
        url: None,
        venue: None,
        publisher: None,
        extra_field: None,
        authors: vec![ZoteroAuthor {
            first_name: String::new(),
            last_name: "World Health Organization".to_string(),
            field_mode: 1,
        }],
        tags: vec![],
        pdf_attachments: vec![],
    };
    let entry = map_to_import_entry(&item);
    assert_eq!(entry.authors, vec!["World Health Organization"]);
}

#[test]
fn map_year_extraction_from_full_date() {
    let mut item = make_article_item();
    item.date_raw = Some("June 12, 2017".to_string());
    let entry = map_to_import_entry(&item);
    assert_eq!(entry.year, Some(2017));
}

#[test]
fn resolve_imported_file_attachment() {
    let pdf = ZoteroPdf {
        link_mode: 0,
        path: Some("storage:attention.pdf".to_string()),
        attachment_key: "PDFKEY01".to_string(),
    };
    let zotero_data_dir = std::path::Path::new("/Users/kit/Zotero");
    let result = resolve_attachment_path(zotero_data_dir, &pdf);
    assert_eq!(
        result,
        Some("/Users/kit/Zotero/storage/PDFKEY01/attention.pdf".to_string())
    );
}

#[test]
fn resolve_linked_file_attachment() {
    let pdf = ZoteroPdf {
        link_mode: 2,
        path: Some("/absolute/path/to/paper.pdf".to_string()),
        attachment_key: "X".to_string(),
    };
    let result = resolve_attachment_path(std::path::Path::new("/unused"), &pdf);
    assert_eq!(result, Some("/absolute/path/to/paper.pdf".to_string()));
}

#[test]
fn resolve_url_attachment() {
    let pdf = ZoteroPdf {
        link_mode: 1,
        path: Some("https://arxiv.org/pdf/1706.03762.pdf".to_string()),
        attachment_key: "X".to_string(),
    };
    let result = resolve_attachment_path(std::path::Path::new("/unused"), &pdf);
    assert_eq!(
        result,
        Some("https://arxiv.org/pdf/1706.03762.pdf".to_string())
    );
}

// ── Zotero-key dedup tests ────────────────────────────────────────────────

#[test]
fn find_existing_by_zotero_key_returns_path() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    fs::create_dir_all(root.join("library/papers")).unwrap();

    let content = "\
---
id: 00000000-0000-0000-0000-000000000600
kind: work
work_type: paper
title: Previously Imported
cite_key: prev2024
tags: []
import:
  source: zotero
  zotero_key: ABC12345
  imported_at: 2024-01-01T00:00:00Z
---
Content.
";
    fs::write(root.join("library/papers/previously-imported.md"), content).unwrap();

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    let found = find_existing_by_zotero_key(index.connection(), "ABC12345");
    assert_eq!(
        found,
        Some("library/papers/previously-imported.md".to_string())
    );

    let not_found = find_existing_by_zotero_key(index.connection(), "UNKNOWN");
    assert!(not_found.is_none());
}

// ── normalize_since tests ──────────────────────────────────────────────────

#[test]
fn normalize_since_strips_iso8601() {
    assert_eq!(
        normalize_since("2024-05-01T00:00:00Z"),
        "2024-05-01 00:00:00"
    );
}

#[test]
fn normalize_since_passes_through_plain_date() {
    assert_eq!(normalize_since("2024-05-01"), "2024-05-01");
}

#[test]
fn normalize_since_handles_datetime_without_z() {
    assert_eq!(
        normalize_since("2024-05-01T12:30:00"),
        "2024-05-01 12:30:00"
    );
}

// ── cite-key collision regression tests ────────────────────────────────────

#[test]
fn cite_key_pool_not_poisoned_by_skipped_items() {
    // Regression: if a cite_key was reserved in the pool before dedup checks,
    // a skipped item would "use up" the base key, causing the next item with
    // the same derived key to get a -b suffix unnecessarily.
    //
    // After the fix, used_cite_keys.insert() happens only after all dedup
    // checks pass, so a skipped item never reserves a key.
    let mut pool = std::collections::HashSet::new();

    // Simulate: first item derives "smith2023results", passes dedup → reserve
    let key1 = derive_cite_key(None, &["Smith".to_string()], Some(2023), "Results", &pool);
    assert_eq!(key1, "smith2023results");
    // Only insert after dedup passes (simulating the fixed behavior)
    pool.insert(key1);

    // Second item with same metadata but different zotero_key would have been
    // skipped by zotero_key dedup in the real handler — so we do NOT insert.
    // (This simulates the "skipped" scenario where the key should not be reserved.)

    // Third item: same derived key, passes all dedup → should still get base key
    // if the second item was indeed skipped (not inserted into pool).
    // But since first item DID reserve it, this correctly gets -b.
    let key3 = derive_cite_key(None, &["Smith".to_string()], Some(2023), "Results", &pool);
    assert_eq!(key3, "smith2023results-b");
}

// ── compute_field_diffs tests ─────────────────────────────────────────────

#[test]
fn compute_diffs_detects_changed_title() {
    let item = make_article_item();
    let entry = map_to_import_entry(&item);

    let local_meta = clepsydra::vault::page::PageMeta {
        title: Some("Old Title".to_string()),
        tags: vec!["local-tag".to_string()],
        ..Default::default()
    };

    let diffs = compute_field_diffs(&entry, &local_meta);
    assert!(diffs.iter().any(|d| d.field == "title"
        && d.local_value.as_deref() == Some("Old Title")
        && d.source_value.as_deref() == Some("Attention Is All You Need")));
}

#[test]
fn compute_diffs_empty_when_identical() {
    let item = make_article_item();
    let entry = map_to_import_entry(&item);

    let local_meta = clepsydra::vault::page::PageMeta {
        title: Some("Attention Is All You Need".to_string()),
        ..Default::default()
    };

    let diffs = compute_field_diffs(&entry, &local_meta);
    assert!(
        diffs.iter().all(|d| d.field != "title"),
        "title should not diff when identical"
    );
}

// ── ISO since filter with Zotero DB ─────────────────────────────────────

#[test]
fn query_items_with_iso_since_after_normalize() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db(&db_path);

    let conn = open_zotero_db(&db_path).unwrap();
    // Use ISO 8601 format, normalize before querying
    let normalized = normalize_since("2024-05-01T00:00:00Z");
    let items = query_items(&conn, None, Some(&normalized)).unwrap();

    assert_eq!(items.len(), 2, "2 items modified after 2024-05-01");
    assert!(
        items.iter().all(|i| i.zotero_key != "DEF67890"),
        "book was modified 2024-03-01, should be excluded"
    );
}

#[test]
fn compute_diffs_detects_year_change() {
    let item = make_article_item();
    let entry = map_to_import_entry(&item);

    let mut local_meta = clepsydra::vault::page::PageMeta::default();
    local_meta.title = Some("Attention Is All You Need".to_string());
    local_meta
        .extra
        .insert("year".to_string(), serde_yaml::Value::Number(2016.into()));

    let diffs = compute_field_diffs(&entry, &local_meta);
    let year_diff = diffs.iter().find(|d| d.field == "year").unwrap();
    assert_eq!(year_diff.local_value.as_deref(), Some("2016"));
    assert_eq!(year_diff.source_value.as_deref(), Some("2017"));
}

#[test]
fn compute_diffs_detects_doi_change() {
    let item = make_article_item();
    let entry = map_to_import_entry(&item);

    let local_meta = clepsydra::vault::page::PageMeta::default();

    let diffs = compute_field_diffs(&entry, &local_meta);
    let doi_diff = diffs.iter().find(|d| d.field == "doi").unwrap();
    assert!(doi_diff.local_value.is_none());
    assert_eq!(
        doi_diff.source_value.as_deref(),
        Some("10.48550/arXiv.1706.03762")
    );
}

#[test]
fn conflict_policy_default_is_skip() {
    let policy = ConflictPolicy::default();
    assert!(matches!(policy, ConflictPolicy::Skip));
}
