mod support;

use std::fs;
use std::io::Cursor;

use base64::Engine;
use support::ApiFixture;

fn note(title: &str, body: &str) -> String {
    format!(
        "+++\nid = \"{}\"\ntitle = {title:?}\ntags = [\"private-metadata\"]\n+++\n{body}",
        uuid::Uuid::now_v7()
    )
}

/// The document after its embedded stylesheet (base64 font data can contain any text).
fn body(html: &str) -> &str {
    html.split_once("</style>").unwrap().1
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
        .get("/api/vault/pages-export/html/report.md")
        .await;
    response.assert_status_ok();
    response.assert_header("content-type", "text/html; charset=utf-8");
    response.assert_header("cache-control", "no-store");
    response.assert_header("x-content-type-options", "nosniff");
    let disposition = response.header("content-disposition");
    let disposition = disposition.to_str().unwrap();
    assert!(disposition.starts_with("attachment;"));
    assert!(disposition.contains("filename*=UTF-8''R%C3%A9sum%C3%A9%20%2D%20review%2Ehtml"));
    let html = response.text();
    assert!(html.contains("<title>Résumé / review</title>"));
    let body = body(&html);
    assert!(body.contains("Saved <strong>body</strong>."));
    assert!(!html.contains("private-metadata"));
    assert!(!body.contains("+++"));
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
        .get("/api/vault/pages-export/html/report.md")
        .await;
    response.assert_status_ok();
    let html = response.text();
    assert_eq!(html.matches("Embedded paragraph.").count(), 2);
    assert!(html.contains("Template: Source"));
    assert!(!html.contains("base ="));
}

#[tokio::test]
async fn rejects_encryption_private_paths_missing_assets_and_recursive_embeds() {
    let fixture = ApiFixture::builder().pre_index_seed(|root| {
        fs::write(root.join("encrypted.md"), format!("+++\nid = \"{}\"\ntitle = \"Encrypted\"\nencryption = {{ format = \"age\", version = 1, key_id = \"00000000-0000-0000-0000-000000000001\" }}\n+++\n{}", uuid::Uuid::now_v7(), clep_test_support::PRIVATE_NOTE_AGE)).unwrap();
        fs::write(root.join("missing.md"), note("Missing", "![Missing](/api/vault/attachments/missing.png)")).unwrap();
        fs::write(root.join("remote.md"), note("Remote", "![Remote](https://example.com/image.png)")).unwrap();
        fs::write(root.join("unsafe.md"), note("Unsafe", "![Unsafe](.clepsydra/config.toml)")).unwrap();
        fs::write(root.join("cycle.md"), note("Cycle", "![[Cycle]]")).unwrap();
        fs::write(root.join("raw.md"), note("Raw", "<script>alert(1)</script>")).unwrap();
    }).build();
    fixture
        .server
        .get("/api/vault/pages-export/html/encrypted.md")
        .await
        .assert_status_forbidden();
    fixture
        .server
        .get("/api/vault/pages-export/html/.clepsydra/config.toml")
        .await
        .assert_status_forbidden();
    fixture
        .server
        .get("/api/vault/pages-export/html/absent.md")
        .await
        .assert_status_not_found();
    for page in ["missing", "remote", "unsafe", "cycle", "raw"] {
        let response = fixture
            .server
            .get(&format!("/api/vault/pages-export/html/{page}.md"))
            .await;
        assert!(
            response.status_code().is_client_error(),
            "{page}: {}",
            response.text()
        );
    }
    fixture
        .server
        .get("/api/vault/pages-export/html/raw.md")
        .await
        .assert_status_unprocessable_entity();
}

#[tokio::test]
async fn inlines_local_and_cas_images_as_data_uris() {
    let mut png = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 2)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let png = png.into_inner();
    let local_png = png.clone();
    let fixture = ApiFixture::builder()
        .pre_index_seed(move |root| {
            fs::create_dir_all(root.join("_attachments")).unwrap();
            fs::write(root.join("_attachments/picture final.png"), local_png).unwrap();
        })
        .build();
    let hash = fixture
        .state
        .cas
        .lock()
        .store(&png, "image/png")
        .unwrap()
        .hash;
    fs::write(
        fixture.state.vault.root().join("images.md"),
        note(
            "Images",
            &format!(
                "![Local](/api/vault/attachments/picture%20final.png)\n\n![CAS](/api/vault/cas/{hash})\n"
            ),
        ),
    )
    .unwrap();
    let response = fixture
        .server
        .get("/api/vault/pages-export/html/images.md")
        .await;
    response.assert_status_ok();
    let html = response.text();
    let uri = format!(
        "src=\"data:image/png;base64,{}\"",
        base64::engine::general_purpose::STANDARD.encode(&png)
    );
    assert_eq!(html.matches(&uri).count(), 2);
    assert!(!html.contains("/api/vault/"));
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
    fixture
        .server
        .get("/api/vault/pages-export/html/escape.md")
        .await
        .assert_status_forbidden();
}
