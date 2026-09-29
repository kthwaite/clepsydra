mod support;

use std::fs;
use std::io::{Cursor, Read};

use support::ApiFixture;

fn note(title: &str, body: &str) -> String {
    format!(
        "+++\nid = \"{}\"\ntitle = {title:?}\ntags = [\"private-metadata\"]\n+++\n{body}",
        uuid::Uuid::now_v7()
    )
}

fn document(bytes: &[u8]) -> String {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .unwrap()
        .read_to_string(&mut xml)
        .unwrap();
    xml
}

#[tokio::test]
async fn exports_saved_body_and_safe_unicode_download_without_frontmatter_or_writes() {
    let saved = note("Résumé / review", "Saved **body**.\n");
    let fixture = ApiFixture::builder()
        .pre_index_seed(move |root| {
            fs::write(root.join("report.md"), saved).unwrap();
        })
        .build();
    let original = fs::read_to_string(fixture.state.vault.root().join("report.md")).unwrap();
    let response = fixture
        .server
        .get("/api/vault/pages-export/word/report.md")
        .await;
    response.assert_status_ok();
    response.assert_header(
        "content-type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    response.assert_header("cache-control", "no-store");
    let disposition = response.header("content-disposition");
    assert!(
        disposition
            .to_str()
            .unwrap()
            .contains("filename*=UTF-8''R%C3%A9sum%C3%A9")
    );
    let xml = document(response.as_bytes());
    assert!(xml.contains("Résumé / review"));
    assert!(xml.contains("Saved "));
    assert!(xml.contains("body"));
    assert!(!xml.contains("private-metadata"));
    assert!(!xml.contains("+++"));
    assert_eq!(
        fs::read_to_string(fixture.state.vault.root().join("report.md")).unwrap(),
        original
    );
}

#[tokio::test]
async fn snapshots_base_template_page_and_block_embeds() {
    let fixture = ApiFixture::builder().pre_index_seed(|root| {
        fs::create_dir_all(root.join("bases")).unwrap();
        fs::create_dir_all(root.join(".clepsydra/templates")).unwrap();
        fs::write(root.join("bases/notes.base.toml"), "name = \"Notes\"\nfilter = { field = \"path\", op = \"eq\", value = \"source.md\" }\n").unwrap();
        fs::write(root.join(".clepsydra/templates/notes.md.jinja"), "{% for row in rows %}Template: {{ row.title }}{% endfor %}").unwrap();
        fs::write(root.join("source.md"), note("Source", "Embedded paragraph. ^abc123DEF0\n")).unwrap();
        fs::write(root.join("report.md"), note("Report", "![[Source]]\n\n((abc123DEF0))\n\n```base\nbase = \"notes\"\ntemplate = \"notes\"\n```\n")).unwrap();
    }).build();
    let response = fixture
        .server
        .get("/api/vault/pages-export/word/report.md")
        .await;
    response.assert_status_ok();
    let xml = document(response.as_bytes());
    assert_eq!(xml.matches("Embedded paragraph.").count(), 2);
    assert!(xml.contains("Template: Source"));
    assert!(!xml.contains("base ="));
}

#[tokio::test]
async fn grouped_base_snapshots_preserve_columns_sort_and_explicit_limits() {
    let fixture = ApiFixture::builder().pre_index_seed(|root| {
        fs::create_dir_all(root.join("bases")).unwrap();
        fs::write(root.join("bases/notes.base.toml"), "name = \"Notes\"\nfilter = { field = \"title\", op = \"starts_with\", value = \"Row \" }\n[[views]]\nname = \"Grouped\"\nlayout = \"table\"\ngroup_by = \"kind\"\ncolumns = [\"title\", \"kind\"]\nsort = [{ field = \"title\", dir = \"desc\" }]\n").unwrap();
        for i in 0..55 {
            fs::write(root.join(format!("row-{i:02}.md")), note(&format!("Row {i:02}"), "Body")).unwrap();
        }
        fs::write(root.join("all.md"), note("All", "```base\nbase = \"notes\"\nview = \"Grouped\"\n```\n")).unwrap();
        fs::write(root.join("limited.md"), note("Limited", "```base\nbase = \"notes\"\nview = \"Grouped\"\nlimit = 2\n```\n")).unwrap();
    }).build();
    let all = fixture
        .server
        .get("/api/vault/pages-export/word/all.md")
        .await;
    all.assert_status_ok();
    let xml = document(all.as_bytes());
    assert!(xml.contains("Row 00"));
    assert!(xml.find("Row 54").unwrap() < xml.find("Row 00").unwrap());
    assert!(xml.contains("NOTE"));
    let limited = fixture
        .server
        .get("/api/vault/pages-export/word/limited.md")
        .await;
    limited.assert_status_ok();
    let xml = document(limited.as_bytes());
    assert!(xml.contains("Row 54"));
    assert!(xml.contains("Row 53"));
    assert!(!xml.contains("Row 52"));
    assert!(xml.contains("2 of 55"));
}

#[tokio::test]
async fn rejects_encryption_private_paths_missing_assets_and_recursive_embeds() {
    let fixture = ApiFixture::builder().pre_index_seed(|root| {
        fs::write(root.join("encrypted.md"), format!("+++\nid = \"{}\"\ntitle = \"Encrypted\"\nencryption = {{ format = \"age\", version = 1, key_id = \"00000000-0000-0000-0000-000000000001\" }}\n+++\n{}", uuid::Uuid::now_v7(), clep_test_support::PRIVATE_NOTE_AGE)).unwrap();
        fs::write(root.join("missing.md"), note("Missing", "![Missing](/api/vault/attachments/missing.png)")).unwrap();
        fs::write(root.join("remote.md"), note("Remote", "![Remote](https://example.com/image.png)")).unwrap();
        fs::write(root.join("unsafe.md"), note("Unsafe", "![Unsafe](.clepsydra/config.toml)")).unwrap();
        fs::write(root.join("cycle.md"), note("Cycle", "![[Cycle]]")).unwrap();
    }).build();
    fixture
        .server
        .get("/api/vault/pages-export/word/encrypted.md")
        .await
        .assert_status_forbidden();
    fixture
        .server
        .get("/api/vault/pages-export/word/.clepsydra/config.toml")
        .await
        .assert_status_forbidden();
    fixture
        .server
        .get("/api/vault/pages-export/word/absent.md")
        .await
        .assert_status_not_found();
    for page in ["missing", "remote", "unsafe", "cycle"] {
        let response = fixture
            .server
            .get(&format!("/api/vault/pages-export/word/{page}.md"))
            .await;
        assert!(
            response.status_code().is_client_error(),
            "{page}: {}",
            response.text()
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn refuses_symlink_pages_and_assets() {
    let outside = tempfile::tempdir().unwrap();
    fs::write(
        outside.path().join("secret.md"),
        note("Secret", "Must not escape"),
    )
    .unwrap();
    let target = outside.path().join("secret.md");
    let fixture = ApiFixture::builder()
        .pre_index_seed(move |root| {
            std::os::unix::fs::symlink(&target, root.join("escape.md")).unwrap();
            fs::create_dir_all(root.join("_attachments")).unwrap();
            std::os::unix::fs::symlink(&target, root.join("_attachments/escape.png")).unwrap();
            fs::write(
                root.join("image.md"),
                note("Image", "![Secret](/api/vault/attachments/escape.png)"),
            )
            .unwrap();
        })
        .build();
    fixture
        .server
        .get("/api/vault/pages-export/word/escape.md")
        .await
        .assert_status_forbidden();
    let response = fixture
        .server
        .get("/api/vault/pages-export/word/image.md")
        .await;
    assert!(response.status_code().is_client_error());
}

#[tokio::test]
async fn exports_heading_sections_and_full_base_body_without_excerpt_loss() {
    let long_body = format!(
        "**Rich body** {}\n\n- Nested content\n",
        "retained ".repeat(300)
    );
    let source_body = long_body.clone();
    let fixture = ApiFixture::builder().pre_index_seed(move |root| {
        fs::create_dir_all(root.join("bases")).unwrap();
        fs::write(root.join("bases/notes.base.toml"), "name = \"Notes\"\nfilter = { field = \"path\", op = \"eq\", value = \"body.md\" }\n[[views]]\nname = \"Full\"\ncolumns = [\"title\", \"body\"]\n").unwrap();
        fs::write(root.join("body.md"), note("Body source", &source_body)).unwrap();
        fs::write(root.join("sections.md"), note("Sections", "## Selected\nIncluded section.\n\n### Child\nIncluded child.\n\n## Other\nExcluded section.\n")).unwrap();
        fs::write(root.join("report.md"), note("Report", "![[Sections#Selected]]\n\n```base\nbase = \"notes\"\nview = \"Full\"\n```\n")).unwrap();
    }).build();
    let response = fixture
        .server
        .get("/api/vault/pages-export/word/report.md")
        .await;
    response.assert_status_ok();
    let xml = document(response.as_bytes());
    assert!(xml.contains("Included section."));
    assert!(xml.contains("Included child."));
    assert!(!xml.contains("Excluded section."));
    assert_eq!(xml.matches("retained").count(), 300);
    assert!(xml.contains("Nested content"));
}

#[tokio::test]
async fn embeds_local_and_cas_images_as_document_media() {
    let mut png = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 2)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let png = png.into_inner();
    let local_png = png.clone();
    let name = if cfg!(windows) {
        "picture&copy;.png"
    } else {
        "picture>final&copy;.png"
    };
    let fixture = ApiFixture::builder()
        .pre_index_seed(move |root| {
            fs::create_dir_all(root.join("_attachments")).unwrap();
            fs::write(root.join("_attachments").join(name), local_png).unwrap();
        })
        .build();
    let hash = fixture
        .state
        .cas
        .lock()
        .store(&png, "image/png")
        .unwrap()
        .hash;
    let encoded = percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC);
    fs::write(
        fixture.state.vault.root().join("images.md"),
        note(
            "Images",
            &format!(
                "![Local](/api/vault/attachments/{encoded})\n\n![CAS](/api/vault/cas/{hash})\n"
            ),
        ),
    )
    .unwrap();
    let response = fixture
        .server
        .get("/api/vault/pages-export/word/images.md")
        .await;
    response.assert_status_ok();
    let xml = document(response.as_bytes());
    assert_eq!(xml.matches("<w:drawing>").count(), 2);
    let mut archive = zip::ZipArchive::new(Cursor::new(response.as_bytes())).unwrap();
    let names: Vec<_> = archive
        .file_names()
        .filter(|name| name.starts_with("word/media/") && !name.ends_with('/'))
        .map(str::to_owned)
        .collect();
    for name in names {
        let mut bytes = Vec::new();
        archive
            .by_name(&name)
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (2, 2));
    }
}

#[tokio::test]
async fn rejects_encoded_traversal_in_images() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::write(
                root.join("escape.md"),
                note("Escape", "![Escape](%2e%2e/secret.png)"),
            )
            .unwrap();
        })
        .build();
    let response = fixture
        .server
        .get("/api/vault/pages-export/word/escape.md")
        .await;
    response.assert_status_forbidden();
}

#[cfg(unix)]
#[tokio::test]
async fn refuses_symlink_cas_blobs_even_when_their_contents_match() {
    let mut png = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 2)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let png = png.into_inner();
    let fixture = ApiFixture::builder().build();
    let hash = fixture
        .state
        .cas
        .lock()
        .store(&png, "image/png")
        .unwrap()
        .hash;
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("private.png");
    fs::write(&target, png).unwrap();
    let blob = fixture
        .state
        .cas
        .lock()
        .root()
        .join(clep_archive::cas::blob_relative_path(&hash).unwrap());
    fs::remove_file(&blob).unwrap();
    std::os::unix::fs::symlink(target, &blob).unwrap();
    fs::write(
        fixture.state.vault.root().join("report.md"),
        note("Report", &format!("![CAS](/api/vault/cas/{hash})")),
    )
    .unwrap();
    let response = fixture
        .server
        .get("/api/vault/pages-export/word/report.md")
        .await;
    assert!(response.status_code().is_client_error());
}

#[tokio::test]
async fn grouped_link_properties_export_labels_without_private_targets() {
    let fixture = ApiFixture::builder().pre_index_seed(|root| {
        fs::create_dir_all(root.join("bases")).unwrap();
        fs::write(root.join("bases/notes.base.toml"), "name = \"Notes\"\nfilter = { field = \"path\", op = \"eq\", value = \"source.md\" }\n[properties]\nsubject = { type = \"text\" }\n[[views]]\nname = \"Grouped\"\ngroup_by = \"subject\"\ncolumns = [\"title\"]\n").unwrap();
        let source = note("Source", "Content").replacen("\n+++\n", "\nsubject = \"[[private/secret.md|Public label]]\"\n+++\n", 1);
        fs::write(root.join("source.md"), source).unwrap();
        fs::write(root.join("report.md"), note("Report", "```base\nbase = \"notes\"\nview = \"Grouped\"\n```\n")).unwrap();
    }).build();
    let response = fixture
        .server
        .get("/api/vault/pages-export/word/report.md")
        .await;
    response.assert_status_ok();
    let xml = document(response.as_bytes());
    assert!(xml.contains("Public label"));
    assert!(!xml.contains("private/secret"));
}

#[tokio::test]
async fn embedded_pages_keep_their_own_footnote_definitions() {
    let fixture = ApiFixture::builder()
        .pre_index_seed(|root| {
            fs::write(
                root.join("source.md"),
                note(
                    "Source",
                    "Embedded claim[^1].\n\n[^1]: Embedded evidence.\n",
                ),
            )
            .unwrap();
            fs::write(
                root.join("report.md"),
                note(
                    "Report",
                    "Host claim[^1].\n\n![[Source]]\n\n[^1]: Host evidence.\n",
                ),
            )
            .unwrap();
        })
        .build();
    let response = fixture
        .server
        .get("/api/vault/pages-export/word/report.md")
        .await;
    response.assert_status_ok();
    let mut archive = zip::ZipArchive::new(Cursor::new(response.as_bytes())).unwrap();
    let mut notes = String::new();
    archive
        .by_name("word/footnotes.xml")
        .unwrap()
        .read_to_string(&mut notes)
        .unwrap();
    assert!(notes.contains("Host evidence."));
    assert!(notes.contains("Embedded evidence."));
    assert_eq!(notes.matches("<w:footnote ").count(), 2);
}
