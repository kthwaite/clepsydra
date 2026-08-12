# Fidelity Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the extension's fake snapshot (`documentElement.outerHTML` plus a regex image scrape) with a real SingleFile capture that the server deconstructs into content-addressed resources, so an archived page holds markdown for reading and a resource-referencing HTML document for fidelity.

**Architecture:** The content script runs `single-file-core` over the live DOM, then Readability over the same page visit. Cross-origin resource fetches relay through the service worker, because an MV3 content script's `fetch` is bound by the page's CORS policy, not the extension's host permissions. The multi-megabyte result reaches the worker in chunks. The worker converts the article HTML to markdown with **original** image URLs and POSTs one manifest. The server owns resource identity end to end: it decodes every `data:` URI out of the snapshot into the CAS, rewrites the snapshot to `cas:<hash>`, and rewrites the markdown through the same map by joining on the pre-inlining URLs SingleFile recorded.

**Tech Stack:** Rust 2024 (Axum 0.8, rusqlite, `regex`, new: `url`), TypeScript/Vite/Bun/vitest extension (new: `single-file-core` 1.5.84), React 19 UI (docs only).

**Spec:** `docs/superpowers/specs/2026-08-12-fidelity-capture-design.md`

## Global Constraints

- **Licence.** `single-file-core` is AGPL-3.0-or-later. Clepsydra has no `LICENSE` file and no `license` field, so it is private and unconveyed and the obligation does not attach. If the extension is ever published it must be AGPL-3.0-or-later. Do not add a `LICENSE` file as part of this work.
- **Size defaults.** `max_blob_size_mb` = **100**, `max_request_size_mb` = **250**, both measured in **decoded** bytes.
- **The HTTP body limit is derived, not equal.** `max_request_size_mb` is a *decoded content* budget; the transport carries base64, which inflates by 4/3. Setting `DefaultBodyLimit` to the same number makes the decoded check unreachable — the wire limit always fires first, and the reader gets a bare `413` naming nothing, which the Risks section says will read as a bug. The transport limit is therefore `max_request_size_mb * 4 / 3`, and the hardcoded router fallbacks match that derivation.
- **Hash split.** `archive.source_hash` = sha256 of the markdown **as captured** (pre-rewrite); duplicate detection keys on it. `archive.content_hash` = sha256 of the markdown **as stored** (post-rewrite); the read-only justification depends on it.
- **Strikethrough** stays single-tilde `~text~`, never GFM `~~text~~`.
- **Never reformat files this work does not touch.** Two formatters here will do it if invoked broadly:
  - **Never run bare `cargo fmt`.** `develop` is **not** `cargo fmt --check` clean — 22 pre-existing files fail it (139 hunks). A workspace-wide format rewrites files this work never touched. Check only what you changed: `rustfmt --check --edition 2024 <changed .rs files>` — and do **not** pass a `mod.rs`, because rustfmt follows `mod` declarations into every child and you are formatting the world again. A one-line `pub mod` addition needs no format check.
  - **Never run `biome check --write` across `ui/src`.** Same situation: the repo is not in a biome-formatted state and it would rewrite ~200 unrelated files. `bun run lint` in `extension/` is scoped to `extension/src` and is safe.
- **`bun run openapi` targets `localhost:3000`.** Regenerating against a server running an older binary silently produces a schema missing the new fields that still typechecks. Regenerate against a server built from the working tree (see Task 10).
- **Verification gates.** Scoped `rustfmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` for Rust; `bun run typecheck`, `bun run lint`, `bun run test`, `bun run build` in `extension/`. Report results explicitly.

## Deliberate deviations from the spec

Each of these was found while reading `single-file-core` 1.5.84 and gwern's `build/linkArchive.sh`. They are recorded here so a reviewer does not have to rediscover them.

1. **`insertMetaCSP: false` (spec silent, non-negotiable).** SingleFile injects `<meta http-equiv="content-security-policy" content="default-src 'none'; img-src 'self' data: ...">` by default. Served under the viewer's `Content-Security-Policy: sandbox`, the frame has an **opaque origin**, so `'self'` matches nothing and every deconstructed resource is blocked. Meta and header CSPs intersect, so the meta cannot be relaxed later by the header. The view endpoint's response header is the only CSP we want.

2. **`groupDuplicateImages: false` (spec silent).** With grouping on, a duplicate `<img>` has its `src` replaced by a CSS custom property, which destroys both the `data:` URI we deconstruct and the `data-sf-original-src` ↔ `src` pairing the markdown join depends on. The CAS deduplicates by hash across every page, which is strictly better.

3. **`blockScripts: true` unconditionally (spec says conditional).** The spec proposes gwern's Substack fingerprint check. Scripts can never execute in the viewer, so retaining them buys no fidelity, and blocking unconditionally makes the "site JS tears down the DOM after capture" failure structurally impossible instead of fingerprint-dependent. This removes the need to fetch the page a second time to fingerprint it.

4. **Error-page markers are gated on a short article (spec/gwern: ungated).** gwern greps the raw snapshot for `404 Not Found` and friends and accepts the false positives, because he eyeballs every capture in a browser. We do not. The check therefore fires only when Readability extracted **fewer than 1500 characters** — a page that yielded almost no article text *and* contains an error marker. An article that merely discusses HTTP status codes is not refused.

5. **Snapshot stores `cas:<hash>`, not `/api/vault/cas/<hash>` (resolves an apparent conflict between the two specs).** The capture spec says rewrite to `cas:`; the viewer spec says snapshot resources "live at `/api/vault/cas/{hash}`". Both hold: the stored artifact uses the origin-independent `cas:` form, matching the markdown convention and `ui/src/lib/resourceUrl.ts`, and the viewer's `view_snapshot` endpoint rewrites `cas:` → `/api/vault/cas/` at serve time. **The viewer plan must implement that rewrite** — nothing in this plan does.

6. **Chunked transfer over `chrome.runtime.sendMessage` (spec silent).** A snapshot is megabytes of string. Chrome requires messages to be JSON-serialisable and rejects oversized ones. The content script therefore sends the payload in ≤4 MB chunks. A `chrome.runtime.Port` was considered and rejected: it needs request/response correlation code that repeated `sendMessage` calls get for free.

7. **`blockVideos: false`, `blockAudios: false`.** gwern passes `--block-videos false --block-audios false` and relies on `--max-resource-size 100` to bound each one. We match him: an archive keeps what was there, and the per-resource cap plus the 250 MB request cap bound the damage.

8. **`--browser-height 10000` and `--browser-wait-until networkIdle` have no in-page equivalent.** They are Puppeteer options for gwern's headless CLI. We capture a tab the user already has open and loaded; `loadDeferredImages` scrolls the page itself. `loadDeferredImagesMaxIdleTime: 3000` carries over directly.

---

## File Structure

**Server — new**

| File | Responsibility |
|---|---|
| `src/vault/archive_snapshot.rs` | Every string transformation on an untrusted snapshot: lift `data:` URIs into resources, build the original-URL → hash map, rewrite markdown image URLs. Pure functions, no I/O, no `AppState`. This is the new attack surface the spec flags; keeping it I/O-free is what makes it exhaustively unit-testable. |

**Server — modified**

| File | Change |
|---|---|
| `src/vault/mod.rs` | Register `archive_snapshot`. |
| `src/vault/config.rs` | `max_blob_size_mb` 50 → 100, `max_request_size_mb` 100 → 250. |
| `src/vault/index.rs` | `find_by_archive_url` reads `$.archive.source_hash`. |
| `src/api/archive.rs` | `ArchiveRequest` loses `blobs` and `snapshot_hash`, gains `snapshot_html`; `BlobUpload` and `decode_and_verify_blobs` deleted; `validate_blob_sizes` → `validate_resource_sizes` over decoded bytes; `build_archive_meta` takes computed hashes; `ingest_archive` deconstructs, rewrites, and hashes. |
| `src/api/mod.rs`, `src/api/openapi.rs` | Body-limit default 250 MB; drop `BlobUpload` from the component list. |
| `tests/archive_test.rs` | Payload fixtures move from `blobs` to `snapshot_html`. |
| `Cargo.toml` | Add `url = "2"` (already in `Cargo.lock` via reqwest, so no new compile cost). |

**Extension — new**

| File | Responsibility |
|---|---|
| `src/lib/relay-fetch.ts` | The content-side `fetch` shim SingleFile calls, and the worker-side handler it relays to. |
| `src/lib/chunked-transfer.ts` | Split a large payload into messages; reassemble them. Pure. |
| `src/lib/capture-hygiene.ts` | Reject a corrupt or error-page capture before upload. Pure. |
| `src/lib/singlefile.ts` | The pinned SingleFile option set and the one call that uses it. Every non-default option carries the reason it is set. |
| `src/types/single-file-core.d.ts` | Module declaration; the package ships no types. |

**Extension — modified**

| File | Change |
|---|---|
| `src/content/capture.ts` | SingleFile first, then Readability, then hygiene, then chunked send. |
| `src/background/service-worker.ts` | Reassemble chunks, serve fetch relays, convert markdown with original URLs, POST the new manifest. |
| `src/lib/turndown-rules.ts` | `addCasImageRule` deleted; `addArchiveRules` / `convertArchiveHtml` lose their `resourceMap` parameter. |
| `src/lib/types.ts` | Manifest gains `snapshot_html`, loses `blobs`/`snapshot_hash`. |
| `src/options/options.html` | Size-limit copy: these now fail a capture, they no longer skip an image. |
| `scripts/verify-bundle.mjs` | Also verify the content-script bundle. |
| `package.json`, `vite.config.ts` | `single-file-core` dependency and alias. |

**Extension — deleted**

`src/lib/remote-resources.ts`, `src/lib/resource-extractor.ts`, and both `__tests__` files. All of it compensated for the absent archiver.

**Docs — modified**

`ui/src/docs/content/browser-extension.mdx`, `ui/src/docs/content/configuration.mdx`, `ui/src/docs/content/capture-feeds-and-archives.mdx`, `extension/README.md`, `ui/src/api/schema.d.ts` (regenerated).

---

## Task 1: Snapshot deconstruction

Lift every inlined `data:` URI out of a SingleFile snapshot into a list of content-addressed resources, leaving `cas:<hash>` behind.

**Files:**
- Create: `src/vault/archive_snapshot.rs`
- Modify: `src/vault/mod.rs` (add `pub mod archive_snapshot;` in alphabetical position, after `pub mod archive_hook;`)
- Modify: `Cargo.toml` (add `url = "2"` — used in Task 2, added here so the module compiles once)
- Test: inline `#[cfg(test)] mod tests` in `src/vault/archive_snapshot.rs`

**Interfaces:**
- Consumes: `crate::vault::cas::ContentStore::hash_bytes(&[u8]) -> String` (returns `"sha256:<64 hex>"`).
- Produces: `SnapshotResource { hash: String, content_type: String, bytes: Vec<u8> }`, `Deconstructed { html: String, resources: Vec<SnapshotResource> }`, `pub fn deconstruct(html: &str) -> Deconstructed`.

- [ ] **Step 1: Write the failing tests**

Create `src/vault/archive_snapshot.rs` with only the test module and the imports it needs, so the tests fail to compile against absent items:

```rust
//! Deconstruction of a SingleFile snapshot into content-addressed resources.
//!
//! SingleFile inlines every resource as a `data:` URI. That makes the snapshot
//! self-contained, and also makes it enormous, undeduplicated, and impossible to
//! load incrementally: a reader must download every byte of every image before
//! seeing anything. We pull those resources back out into the CAS and leave
//! `cas:<hash>` references behind.
//!
//! Everything here operates on attacker-authored markup. It parses nothing and
//! executes nothing — it matches a self-delimiting token and rewrites it.

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &str = "iVBORw0KGgo=";

    #[test]
    fn lifts_an_inlined_image_into_a_resource() {
        let html = format!(r#"<img src="data:image/png;base64,{PNG}">"#);

        let result = deconstruct(&html);

        assert_eq!(result.resources.len(), 1);
        assert_eq!(result.resources[0].content_type, "image/png");
        let hash = &result.resources[0].hash;
        assert_eq!(result.html, format!(r#"<img src="cas:{hash}">"#));
    }

    #[test]
    fn stores_one_resource_for_repeated_bytes() {
        let html = format!(
            r#"<img src="data:image/png;base64,{PNG}"><img src="data:image/png;base64,{PNG}">"#
        );

        let result = deconstruct(&html);

        assert_eq!(result.resources.len(), 1);
        let hash = &result.resources[0].hash;
        assert_eq!(result.html.matches(&format!("cas:{hash}")).count(), 2);
    }

    #[test]
    fn rewrites_data_uris_inside_css() {
        let html = format!(
            r#"<style>body{{background:url(data:image/png;base64,{PNG})}}</style>"#
        );

        let result = deconstruct(&html);

        assert_eq!(result.resources.len(), 1);
        let hash = &result.resources[0].hash;
        assert!(
            result.html.contains(&format!("url(cas:{hash})")),
            "got: {}",
            result.html
        );
    }

    #[test]
    fn keeps_media_type_parameters() {
        let html = r#"<link href="data:text/css;charset=utf-8;base64,Ym9keXt9">"#;

        let result = deconstruct(html);

        assert_eq!(result.resources[0].content_type, "text/css;charset=utf-8");
    }

    #[test]
    fn defaults_a_missing_media_type() {
        let html = r#"<img src="data:;base64,Ym9keXt9">"#;

        let result = deconstruct(html);

        assert_eq!(result.resources[0].content_type, "application/octet-stream");
    }

    #[test]
    fn leaves_singlefiles_empty_resource_alone() {
        // SingleFile writes `data:,` for a resource it could not fetch. There is
        // nothing to store, and rewriting it would invent a blob that never
        // existed.
        let html = r#"<img src="data:,">"#;

        let result = deconstruct(html);

        assert!(result.resources.is_empty());
        assert_eq!(result.html, html);
    }

    #[test]
    fn leaves_malformed_base64_verbatim() {
        let html = r#"<img src="data:image/png;base64,!!!!"><p>after</p>"#;

        let result = deconstruct(html);

        assert!(result.resources.is_empty());
        assert_eq!(result.html, html);
    }

    #[test]
    fn decoded_bytes_match_the_declared_payload() {
        let html = format!(r#"<img src="data:image/png;base64,{PNG}">"#);

        let result = deconstruct(&html);

        assert_eq!(
            result.resources[0].bytes,
            vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
        );
    }

    #[test]
    fn a_snapshot_with_no_resources_is_returned_unchanged() {
        let html = "<html><body><p>plain</p></body></html>";

        let result = deconstruct(html);

        assert!(result.resources.is_empty());
        assert_eq!(result.html, html);
    }
}
```

Add to `src/vault/mod.rs` between `pub mod archive_hook;` and `pub mod atomic_file;`:

```rust
pub mod archive_snapshot;
```

Add to `Cargo.toml` under `[dependencies]`, keeping alphabetical order (after `unicode-normalization`):

```toml
url = "2"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --lib archive_snapshot`
Expected: compile error — `cannot find function 'deconstruct' in this scope`.

- [ ] **Step 3: Write the implementation**

Insert above the `#[cfg(test)]` module in `src/vault/archive_snapshot.rs`:

```rust
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use regex::Regex;

use crate::vault::cas::ContentStore;

const OCTET_STREAM: &str = "application/octet-stream";

/// One resource lifted out of a snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotResource {
    /// `sha256:<hex>`, as produced by `ContentStore::hash_bytes`.
    pub hash: String,
    /// The media type as declared in the `data:` URI, parameters included, so it
    /// can be served back verbatim.
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// A snapshot with its resources extracted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deconstructed {
    /// The snapshot with every liftable `data:` URI replaced by `cas:<hash>`.
    pub html: String,
    /// Unique resources, in order of first appearance.
    pub resources: Vec<SnapshotResource>,
}

/// A base64 `data:` URI.
///
/// The token is self-delimiting, which is why a regex is the right tool here and
/// a DOM parser is not: these appear in attribute values, in `style` attributes,
/// and inside `<style>` and `@font-face` CSS. A DOM rewriter handles only the
/// first. The media-type group excludes `,` `"` `'` whitespace and `)`, so it
/// cannot run past the URI's own delimiter, and is lazy so it stops at the first
/// `;base64,`.
fn data_uri_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"data:([^,"'\s)]*?);base64,([A-Za-z0-9+/=]*)"#).unwrap())
}

/// Lift every inlined resource out of `html`, replacing it with `cas:<hash>`.
///
/// A `data:` URI that does not decode, or decodes to nothing, is left exactly as
/// it was: inventing a blob for it would be worse than leaving a dead reference
/// that at least records what the page claimed.
pub fn deconstruct(html: &str) -> Deconstructed {
    let mut resources: Vec<SnapshotResource> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut out = String::with_capacity(html.len());
    let mut last_end = 0;

    for caps in data_uri_regex().captures_iter(html) {
        let whole = caps.get(0).expect("group 0 always matches");
        let media_type = caps.get(1).expect("group 1 is not optional").as_str();
        let payload = caps.get(2).expect("group 2 is not optional").as_str();

        let Ok(bytes) = BASE64.decode(payload) else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }

        let hash = ContentStore::hash_bytes(&bytes);
        if seen.insert(hash.clone()) {
            resources.push(SnapshotResource {
                hash: hash.clone(),
                content_type: content_type_of(media_type),
                bytes,
            });
        }

        out.push_str(&html[last_end..whole.start()]);
        out.push_str("cas:");
        out.push_str(&hash);
        last_end = whole.end();
    }
    out.push_str(&html[last_end..]);

    Deconstructed {
        html: out,
        resources,
    }
}

fn content_type_of(media_type: &str) -> String {
    let trimmed = media_type.trim();
    if trimmed.is_empty() {
        OCTET_STREAM.to_string()
    } else {
        trimmed.to_string()
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --lib archive_snapshot`
Expected: 9 passed.

- [ ] **Step 5: Verify the gates**

Run, as separate commands: `rustfmt --check --edition 2024 src/vault/archive_snapshot.rs`; `cargo clippy --all-targets -- -D warnings`. Do not run bare `cargo fmt`, and do not pass `src/vault/mod.rs` to rustfmt — see Global Constraints.
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/vault/archive_snapshot.rs src/vault/mod.rs Cargo.toml Cargo.lock
git commit -m "feat(archive): lift inlined snapshot resources into the CAS"
```

---

## Task 2: The markdown join

Build the original-URL → hash map from a deconstructed snapshot and rewrite the markdown's image URLs through it. This is what `saveOriginalURLs` exists for: without the pre-inlining URL there is nothing to match a markdown image against.

**Files:**
- Modify: `src/vault/archive_snapshot.rs`
- Test: inline `#[cfg(test)] mod tests` in the same file

**Interfaces:**
- Consumes: `deconstruct` from Task 1 (its `Deconstructed.html`, i.e. **after** `cas:` rewriting).
- Produces:
  - `pub fn original_url_map(html: &str, base_url: &str) -> BTreeMap<String, String>` — absolute original URL → `sha256:<hex>`.
  - `pub fn rewrite_markdown_images(markdown: &str, map: &BTreeMap<String, String>, base_url: &str) -> String`.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `mod tests` in `src/vault/archive_snapshot.rs`:

```rust
    const BASE: &str = "https://example.com/posts/one";

    #[test]
    fn maps_an_original_url_to_the_hash_that_replaced_it() {
        let html = r#"<img data-sf-original-src="https://cdn.example.com/a.png" src="cas:sha256:aa">"#;

        let map = original_url_map(html, BASE);

        assert_eq!(
            map.get("https://cdn.example.com/a.png"),
            Some(&"sha256:aa".to_string())
        );
    }

    #[test]
    fn absolutises_a_relative_original_url() {
        // SingleFile records the raw attribute value, so it is relative whenever
        // the page's markup was. The markdown carries absolute URLs, because
        // Readability resolves them. The map is what has to bridge that.
        let html = r#"<img data-sf-original-src="/img/a.png" src="cas:sha256:bb">"#;

        let map = original_url_map(html, BASE);

        assert_eq!(
            map.get("https://example.com/img/a.png"),
            Some(&"sha256:bb".to_string())
        );
    }

    #[test]
    fn ignores_an_element_whose_src_was_not_deconstructed() {
        let html = r#"<img data-sf-original-src="https://cdn.example.com/a.png" src="data:,">"#;

        let map = original_url_map(html, BASE);

        assert!(map.is_empty());
    }

    #[test]
    fn does_not_confuse_srcset_with_src() {
        let html = concat!(
            r#"<img data-sf-original-srcset="https://cdn.example.com/wide.png 2x" "#,
            r#"data-sf-original-src="https://cdn.example.com/a.png" src="cas:sha256:cc" "#,
            r#"srcset="cas:sha256:dd 2x">"#
        );

        let map = original_url_map(html, BASE);

        assert_eq!(map.len(), 1);
        assert_eq!(
            map.get("https://cdn.example.com/a.png"),
            Some(&"sha256:cc".to_string())
        );
    }

    #[test]
    fn pairs_within_one_tag_only() {
        let html = concat!(
            r#"<img data-sf-original-src="https://cdn.example.com/a.png">"#,
            r#"<img src="cas:sha256:ee">"#
        );

        let map = original_url_map(html, BASE);

        assert!(map.is_empty());
    }

    fn one_entry(url: &str, hash: &str) -> BTreeMap<String, String> {
        let mut map = BTreeMap::new();
        map.insert(url.to_string(), hash.to_string());
        map
    }

    #[test]
    fn rewrites_a_markdown_image_to_its_blob() {
        let map = one_entry("https://cdn.example.com/a.png", "sha256:aa");

        let out = rewrite_markdown_images(
            "text\n\n![a cat](https://cdn.example.com/a.png)\n",
            &map,
            BASE,
        );

        assert_eq!(out, "text\n\n![a cat](cas:sha256:aa)\n");
    }

    #[test]
    fn preserves_an_image_title() {
        let map = one_entry("https://cdn.example.com/a.png", "sha256:aa");

        let out = rewrite_markdown_images(
            r#"![a cat](https://cdn.example.com/a.png "Fig 1")"#,
            &map,
            BASE,
        );

        assert_eq!(out, r#"![a cat](cas:sha256:aa "Fig 1")"#);
    }

    #[test]
    fn leaves_an_unmatched_image_intact() {
        // Silently dropping it would produce markdown that claims an image was
        // archived when it was not.
        let map = one_entry("https://cdn.example.com/a.png", "sha256:aa");

        let out = rewrite_markdown_images("![b](https://cdn.example.com/b.png)", &map, BASE);

        assert_eq!(out, "![b](https://cdn.example.com/b.png)");
    }

    #[test]
    fn leaves_ordinary_links_alone() {
        // A link should still point at the live web; only images become blobs.
        let map = one_entry("https://cdn.example.com/a.png", "sha256:aa");

        let out = rewrite_markdown_images("[see it](https://cdn.example.com/a.png)", &map, BASE);

        assert_eq!(out, "[see it](https://cdn.example.com/a.png)");
    }

    #[test]
    fn matches_a_relative_markdown_url_against_an_absolute_map_key() {
        let map = one_entry("https://example.com/img/a.png", "sha256:aa");

        let out = rewrite_markdown_images("![a](/img/a.png)", &map, BASE);

        assert_eq!(out, "![a](cas:sha256:aa)");
    }

    #[test]
    fn deconstruct_and_map_compose_end_to_end() {
        let html = format!(
            r#"<img data-sf-original-src="https://cdn.example.com/a.png" src="data:image/png;base64,{PNG}">"#
        );

        let deconstructed = deconstruct(&html);
        let map = original_url_map(&deconstructed.html, BASE);
        let out = rewrite_markdown_images("![a](https://cdn.example.com/a.png)", &map, BASE);

        let hash = &deconstructed.resources[0].hash;
        assert_eq!(out, format!("![a](cas:{hash})"));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --lib archive_snapshot`
Expected: compile error — `cannot find function 'original_url_map' in this scope`.

- [ ] **Step 3: Write the implementation**

Add `use std::collections::BTreeMap;` and `use url::Url;` to the module's imports, then append below `content_type_of`:

```rust
/// One HTML tag, so an original URL is only ever paired with a `cas:` reference
/// that sits on the same element.
fn tag_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]+>").unwrap())
}

/// `data-sf-original-src="…"`, written by SingleFile's `saveOriginalURLs`.
fn original_src_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"data-sf-original-src\s*=\s*["']([^"']*)["']"#).unwrap())
}

/// `src="cas:…"`. The leading `(?:^|\s)` keeps this off `data-sf-original-src`,
/// which ends in `-src`; anchoring `src\s*=` keeps it off `srcset`.
fn cas_src_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?:^|\s)src\s*=\s*["']cas:([^"']*)["']"#).unwrap())
}

/// A markdown inline image, with an optional quoted title.
fn markdown_image_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"!\[([^\]]*)\]\(\s*([^()\s]+)((?:\s+"[^"]*")?)\s*\)"#).unwrap()
    })
}

/// Absolute original URL → the hash of the blob that replaced it.
///
/// Call this on the **deconstructed** snapshot: it pairs the
/// `data-sf-original-src` SingleFile recorded with the `cas:` reference
/// `deconstruct` left in that element's `src`. That pairing is the only link
/// between the markdown — which still carries live URLs — and the blobs.
pub fn original_url_map(html: &str, base_url: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for tag in tag_regex().find_iter(html) {
        let tag = tag.as_str();
        let (Some(original), Some(hash)) = (
            original_src_regex().captures(tag),
            cas_src_regex().captures(tag),
        ) else {
            continue;
        };
        let raw = original[1].trim();
        if raw.is_empty() {
            continue;
        }
        let key = absolutise(raw, base_url).unwrap_or_else(|| raw.to_string());
        map.insert(key, hash[1].to_string());
    }
    map
}

/// Point every archived image in `markdown` at its blob.
///
/// An image whose URL is not in the map is left exactly as it was. Dropping it
/// would be a silent lie about what the archive holds; leaving it is at least an
/// honest reference to the live web.
pub fn rewrite_markdown_images(
    markdown: &str,
    map: &BTreeMap<String, String>,
    base_url: &str,
) -> String {
    markdown_image_regex()
        .replace_all(markdown, |caps: &regex::Captures<'_>| {
            let alt = &caps[1];
            let url = &caps[2];
            let title = &caps[3];
            match lookup(map, url, base_url) {
                Some(hash) => format!("![{alt}](cas:{hash}{title})"),
                None => caps[0].to_string(),
            }
        })
        .into_owned()
}

fn lookup(map: &BTreeMap<String, String>, url: &str, base_url: &str) -> Option<String> {
    if let Some(hash) = map.get(url) {
        return Some(hash.clone());
    }
    let absolute = absolutise(url, base_url)?;
    map.get(&absolute).cloned()
}

fn absolutise(raw: &str, base_url: &str) -> Option<String> {
    let base = Url::parse(base_url).ok()?;
    base.join(raw).ok().map(String::from)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --lib archive_snapshot`
Expected: 21 passed.

- [ ] **Step 5: Verify the gates**

Run, as separate commands: `rustfmt --check --edition 2024 src/vault/archive_snapshot.rs`; `cargo clippy --all-targets -- -D warnings`. Do not run bare `cargo fmt` — see Global Constraints.
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/vault/archive_snapshot.rs
git commit -m "feat(archive): join markdown images to deconstructed blobs"
```

---

## Task 3: Server owns the resource map

Change the ingest contract: the request carries a snapshot, not blobs. The server deconstructs it, rewrites the markdown through the resulting map, and computes both stored hashes itself.

**Files:**
- Modify: `src/api/archive.rs`
- Modify: `src/vault/config.rs:183-189` (`default_max_blob_size_mb`, `default_max_request_size_mb`)
- Modify: `src/vault/index.rs:1410` (`find_by_archive_url` JSON path)
- Modify: `src/api/mod.rs:162` (`api_router` default limit)
- Modify: `src/api/openapi.rs:347` (drop `BlobUpload`)
- Test: `tests/archive_test.rs`, plus the inline `#[cfg(test)] mod tests` in `src/api/archive.rs`

**Interfaces:**
- Consumes: `crate::vault::archive_snapshot::{deconstruct, original_url_map, rewrite_markdown_images, SnapshotResource}` from Tasks 1–2.
- Produces:
  - `ArchiveRequest` without `blobs` / `snapshot_hash`, with `pub snapshot_html: String`.
  - `struct ArchiveHashes { source_hash: String, content_hash: String, snapshot_hash: String, resource_hashes: Vec<String> }`.
  - `fn build_archive_meta(req: &ArchiveRequest, hashes: &ArchiveHashes) -> PageMeta`.
  - `fn validate_resource_sizes(resources: &[SnapshotResource], snapshot_len: usize, max_blob_size_mb: u64, max_request_size_mb: u64) -> Result<(), ApiError>`.
  - Frontmatter gains `archive.source_hash` and `archive.resource_count`.

- [ ] **Step 1: Write the failing integration tests**

Append to `tests/archive_test.rs`:

```rust
/// The full pipeline over one capture: a snapshot with an inlined image, and
/// markdown that still points at the live URL.
fn fidelity_payload(url: &str, markdown: &str) -> serde_json::Value {
    // The `url` comment makes each page's snapshot distinct, so a shared image
    // is the only thing two captures can deduplicate on.
    let snapshot = format!(
        concat!(
            r#"<html><!-- {} --><body><img data-sf-original-src="https://cdn.example.com/a.png" "#,
            r#"src="data:image/png;base64,iVBORw0KGgo="></body></html>"#
        ),
        url
    );
    serde_json::json!({
        "url": url,
        "domain": "example.com",
        "title": "Fidelity Article",
        "captured_at": "2026-08-12T12:00:00Z",
        "content_hash": content_hash(markdown),
        "snapshot_html": snapshot,
        "markdown_body": markdown,
        "tags": ["archive", "example.com"],
    })
}

#[tokio::test]
async fn ingest_deconstructs_the_snapshot_into_the_cas() {
    let (server, _tmp, _state) = setup_server();
    let markdown = "![a](https://cdn.example.com/a.png)";

    let res = server
        .post("/api/vault/archive")
        .json(&fidelity_payload("https://example.com/one", markdown))
        .await;
    res.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = res.json();

    // The image and the snapshot: two blobs, neither sent by the client.
    assert_eq!(body["blobs_stored"], 2);

    let png_hash = sha256_hash(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    let blob = server.get(&format!("/api/vault/cas/{png_hash}")).await;
    blob.assert_status(StatusCode::OK);
}

#[tokio::test]
async fn stored_markdown_points_at_the_blob() {
    let (server, _tmp, _state) = setup_server();
    let markdown = "![a](https://cdn.example.com/a.png)";

    let res = server
        .post("/api/vault/archive")
        .json(&fidelity_payload("https://example.com/two", markdown))
        .await;
    let path = res.json::<serde_json::Value>()["vault_path"]
        .as_str()
        .unwrap()
        .to_string();

    let page = server.get(&format!("/api/vault/pages/{path}")).await;
    let detail: serde_json::Value = page.json();
    let png_hash = sha256_hash(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    assert_eq!(
        detail["body"].as_str().unwrap().trim(),
        format!("![a](cas:{png_hash})")
    );
}

#[tokio::test]
async fn stored_snapshot_has_no_inlined_resources() {
    let (server, _tmp, _state) = setup_server();

    let res = server
        .post("/api/vault/archive")
        .json(&fidelity_payload(
            "https://example.com/three",
            "![a](https://cdn.example.com/a.png)",
        ))
        .await;
    let path = res.json::<serde_json::Value>()["vault_path"]
        .as_str()
        .unwrap()
        .to_string();

    let detail: serde_json::Value = server.get(&format!("/api/vault/pages/{path}")).await.json();
    let snapshot_hash = detail["meta"]["archive"]["snapshot_hash"].as_str().unwrap();
    let snapshot = server.get(&format!("/api/vault/cas/{snapshot_hash}")).await;
    let html = String::from_utf8(snapshot.as_bytes().to_vec()).unwrap();

    assert!(!html.contains("base64,"), "snapshot still inlines a resource");
    assert!(html.contains("src=\"cas:sha256:"), "got: {html}");
}

#[tokio::test]
async fn content_hash_describes_the_stored_body_and_source_hash_the_capture() {
    let (server, _tmp, _state) = setup_server();
    let markdown = "![a](https://cdn.example.com/a.png)";

    let res = server
        .post("/api/vault/archive")
        .json(&fidelity_payload("https://example.com/four", markdown))
        .await;
    let path = res.json::<serde_json::Value>()["vault_path"]
        .as_str()
        .unwrap()
        .to_string();

    let detail: serde_json::Value = server.get(&format!("/api/vault/pages/{path}")).await.json();
    let archive = &detail["meta"]["archive"];
    assert_eq!(archive["source_hash"].as_str().unwrap(), content_hash(markdown));
    assert_eq!(
        archive["content_hash"].as_str().unwrap(),
        content_hash(detail["body"].as_str().unwrap())
    );
    assert_ne!(archive["content_hash"], archive["source_hash"]);
    assert_eq!(archive["resource_count"].as_i64(), Some(1));
}

#[tokio::test]
async fn re_encoding_an_image_does_not_read_as_a_changed_page() {
    // Change detection keys on the captured markdown, so a byte-different but
    // textually identical capture is the same page.
    let (server, _tmp, _state) = setup_server();
    let markdown = "![a](https://cdn.example.com/a.png)";
    let url = "https://example.com/five";

    server
        .post("/api/vault/archive")
        .json(&fidelity_payload(url, markdown))
        .await
        .assert_status(StatusCode::CREATED);

    let mut second = fidelity_payload(url, markdown);
    second["snapshot_html"] = serde_json::json!(concat!(
        r#"<html><body><img data-sf-original-src="https://cdn.example.com/a.png" "#,
        r#"src="data:image/png;base64,iVBORw0KGgoAAAA="></body></html>"#
    ));

    server
        .post("/api/vault/archive")
        .json(&second)
        .await
        .assert_status(StatusCode::OK);
}

#[tokio::test]
async fn an_unmatched_markdown_image_is_left_intact() {
    let (server, _tmp, _state) = setup_server();
    let markdown = "![b](https://cdn.example.com/b.png)";

    let res = server
        .post("/api/vault/archive")
        .json(&fidelity_payload("https://example.com/six", markdown))
        .await;
    let path = res.json::<serde_json::Value>()["vault_path"]
        .as_str()
        .unwrap()
        .to_string();

    let detail: serde_json::Value = server.get(&format!("/api/vault/pages/{path}")).await.json();
    assert_eq!(detail["body"].as_str().unwrap().trim(), markdown);
}

#[tokio::test]
async fn two_pages_sharing_an_image_store_one_blob() {
    // The dedup regression. It used to be the extension's job and is now a
    // property of the CAS, so it needs pinning at the new boundary.
    let (server, _tmp, state) = setup_server();

    server
        .post("/api/vault/archive")
        .json(&fidelity_payload("https://example.com/a", "![a](https://cdn.example.com/a.png)"))
        .await
        .assert_status(StatusCode::CREATED);
    let after_first = state.cas.lock().stats().unwrap().blob_count;

    let res = server
        .post("/api/vault/archive")
        .json(&fidelity_payload("https://example.com/b", "![a](https://cdn.example.com/a.png)"))
        .await;
    res.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = res.json();

    // The shared image dedupes; only the second snapshot is a new blob. The two
    // snapshots differ because `fidelity_payload` embeds each page's own title.
    assert_eq!(body["blobs_deduped"], 1);
    assert_eq!(body["blobs_stored"], 1);
    assert_eq!(state.cas.lock().stats().unwrap().blob_count, after_first + 1);
}

/// A server whose archive limits are small enough to exceed cheaply. The
/// defaults are 100 MB and 250 MB; driving a test payload past those would cost
/// hundreds of megabytes of allocation to prove a comparison.
fn setup_server_with_small_limits() -> (TestServer, TempDir, Arc<AppState>) {
    ApiFixture::builder()
        .configure(|root| {
            std::fs::write(
                root.join(".clepsydra/config.toml"),
                "[archive]\nmax_blob_size_mb = 1\nmax_request_size_mb = 2\n",
            )
            .unwrap();
        })
        .delete_hooks_with(|cas| {
            vec![Box::new(ArchiveDeleteHook {
                cas: Arc::clone(cas),
            }) as Box<dyn PostDeleteHook>]
        })
        .build()
        .into_parts()
}

#[tokio::test]
async fn an_oversized_resource_fails_the_whole_capture() {
    // A deliberate reversal of the skip-and-continue behaviour this replaced:
    // right for a best-effort image scrape, wrong for an archive.
    let (server, _tmp, state) = setup_server_with_small_limits();
    let before = state.cas.lock().stats().unwrap().blob_count;

    // 2 MB of base64 decodes to ~1.5 MB, over the configured 1 MB per resource.
    let payload_b64 = "A".repeat(2 * 1024 * 1024);
    let mut request = fidelity_payload("https://example.com/huge", "body");
    request["snapshot_html"] =
        serde_json::json!(format!(r#"<img src="data:image/png;base64,{payload_b64}">"#));

    let res = server.post("/api/vault/archive").json(&request).await;

    res.assert_status(StatusCode::BAD_REQUEST);
    assert!(res.text().contains("max_blob_size_mb"), "got: {}", res.text());
    // Size validation runs before anything is stored, so there is nothing to
    // roll back — which is the property worth pinning.
    assert_eq!(state.cas.lock().stats().unwrap().blob_count, before);
}

#[tokio::test]
async fn a_capture_over_the_total_budget_fails() {
    let (server, _tmp, state) = setup_server_with_small_limits();
    let before = state.cas.lock().stats().unwrap().blob_count;

    // Three resources, each under the 1 MB per-resource cap, together over the
    // 2 MB request cap. Distinct bytes, or the CAS would dedupe them to one.
    let images: String = ["A", "B", "C"]
        .iter()
        .map(|c| {
            let payload = c.repeat(1024 * 1024);
            format!(r#"<img src="data:image/png;base64,{payload}">"#)
        })
        .collect();
    let mut request = fidelity_payload("https://example.com/budget", "body");
    request["snapshot_html"] = serde_json::json!(images);

    let res = server.post("/api/vault/archive").json(&request).await;

    res.assert_status(StatusCode::BAD_REQUEST);
    assert!(
        res.text().contains("max_request_size_mb"),
        "got: {}",
        res.text()
    );
    assert_eq!(state.cas.lock().stats().unwrap().blob_count, before);
}
```

Then repair the existing integration tests, which all still send `blobs`:
- `archive_ingest_creates_page_and_stores_blobs`, `archive_duplicate_url_same_content_returns_200`, `archive_duplicate_url_different_content_returns_409`, `archive_page_is_readable_via_pages_api`, `archive_blob_deduplication`, `archive_content_hash_mismatch_rejected`, `archive_delete_decrements_cas_ref_count`, `delete_folder_recursive_runs_delete_hooks`, `rollback_on_index_failure_preserves_primary_and_compensates_every_blob`, and the `ingest_simple` helper.

In each: delete the `"blobs"` and `"snapshot_hash"` keys and add `"snapshot_html"`. Where a test needs a stored resource, use the `fidelity_payload` snapshot; where it does not, use `"snapshot_html": "<html><body><p>ok</p></body></html>"`. Delete `archive_blob_deduplication` outright — `two_pages_sharing_an_image_store_one_blob` above supersedes it, and dedup is now a property of the CAS rather than of the extension. Blob counts in the remaining assertions rise by one wherever the snapshot itself is now a stored blob.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --test archive_test`
Expected: compile error — `struct ArchiveRequest has no field named snapshot_html` / unknown field in the JSON payload.

- [ ] **Step 3: Change the request contract and the size check**

In `src/api/archive.rs`, replace the `snapshot_hash` and `blobs` fields of `ArchiveRequest`:

```rust
    /// sha256 of `markdown_body` exactly as sent. Verified on arrival as a
    /// transport check, then stored as `archive.source_hash`.
    pub content_hash: String,
    /// The SingleFile capture, resources still inlined as `data:` URIs. The
    /// server deconstructs it; the extension does not hash or split it.
    pub snapshot_html: String,
    pub markdown_body: String,
```

Delete `pub struct BlobUpload`, `fn decode_and_verify_blobs`, and `fn validate_blob_sizes` together with their four unit tests (`validate_blob_sizes_*`, `decode_and_verify_blobs_*`). Remove `crate::api::archive::BlobUpload,` from the `components(schemas(...))` list in `src/api/openapi.rs`.

Add in their place:

```rust
/// Reject a capture that exceeds the configured limits.
///
/// Unlike the resource scrape this replaced, an oversized capture fails the
/// whole archive rather than being trimmed: a snapshot missing arbitrary
/// resources is not a snapshot. The per-resource limit also bounds what
/// SingleFile is configured to inline, so hitting it here means the extension's
/// limit and the server's disagree.
fn validate_resource_sizes(
    resources: &[SnapshotResource],
    snapshot_len: usize,
    max_blob_size_mb: u64,
    max_request_size_mb: u64,
) -> Result<(), ApiError> {
    let max_blob_bytes = max_blob_size_mb * 1024 * 1024;
    let max_request_bytes = max_request_size_mb * 1024 * 1024;
    let mut total = snapshot_len as u64;
    for resource in resources {
        let size = resource.bytes.len() as u64;
        if size > max_blob_bytes {
            return Err(ApiError::bad_request(format!(
                "archived resource {} is {} bytes, over max_blob_size_mb ({} MB)",
                resource.hash, size, max_blob_size_mb
            )));
        }
        total += size;
    }
    if total > max_request_bytes {
        return Err(ApiError::bad_request(format!(
            "capture is {total} bytes, over max_request_size_mb ({max_request_size_mb} MB)"
        )));
    }
    Ok(())
}
```

Add the import `use crate::vault::archive_snapshot::{self, SnapshotResource};`.

- [ ] **Step 4: Rewrite `build_archive_meta` around computed hashes**

Replace the function and its signature:

```rust
/// The four hashes an archive page records, all computed by the server.
struct ArchiveHashes {
    /// Over the markdown as captured, before rewriting. Change detection keys on
    /// this, so a re-encoded image does not read as "the page changed".
    source_hash: String,
    /// Over the markdown as stored, after rewriting. Archived bodies are
    /// write-protected on the stated grounds that this describes the stored
    /// body, so it must be computed post-rewrite or that justification fails.
    content_hash: String,
    snapshot_hash: String,
    /// Every deconstructed resource, excluding the snapshot itself. The delete
    /// hook decrements each of these.
    resource_hashes: Vec<String>,
}

/// Build the PageMeta (with nested `archive` TOML table) for an ingest request.
fn build_archive_meta(req: &ArchiveRequest, hashes: &ArchiveHashes) -> PageMeta {
    fn ts(s: &str) -> toml::Value {
        toml::Value::String(s.to_string())
    }
    let mut meta = PageMeta::new();
    meta.title = Some(req.title.clone());
    meta.tags = req.tags.clone();
    // Declared explicitly rather than left to folder inference, so an archived
    // page is distinguishable from an ordinary note wherever it is filed.
    meta.kind = Some(Kind::Archive);

    let mut archive_map = toml::Table::new();
    archive_map.insert("url".into(), ts(&req.url));
    if let Some(ref canonical_url) = req.canonical_url {
        archive_map.insert("canonical_url".into(), ts(canonical_url));
    }
    archive_map.insert("domain".into(), ts(&req.domain));
    archive_map.insert("captured_at".into(), ts(&req.captured_at));
    archive_map.insert("content_hash".into(), ts(&hashes.content_hash));
    archive_map.insert("source_hash".into(), ts(&hashes.source_hash));
    archive_map.insert("snapshot_hash".into(), ts(&hashes.snapshot_hash));
    archive_map.insert(
        "resource_count".into(),
        toml::Value::Integer(hashes.resource_hashes.len() as i64),
    );
    if let Some(ref description) = req.description {
        archive_map.insert("description".into(), ts(description));
    }
    for (key, value) in [
        ("byline", &req.byline),
        ("site_name", &req.site_name),
        ("published_time", &req.published_time),
        ("lang", &req.lang),
        ("excerpt", &req.excerpt),
    ] {
        if let Some(value) = value.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()) {
            archive_map.insert(key.into(), ts(value));
        }
    }

    if !hashes.resource_hashes.is_empty() {
        let blobs: Vec<toml::Value> = hashes
            .resource_hashes
            .iter()
            .map(|h| toml::Value::String(h.clone()))
            .collect();
        archive_map.insert("blobs".into(), toml::Value::Array(blobs));
    }

    meta.extra
        .insert("archive".to_string(), toml::Value::Table(archive_map));
    meta
}
```

Update the four `build_archive_meta_*` unit tests and `request_fixture` in the same file: drop `snapshot_hash` and `blobs` from the fixture, add `snapshot_html: String::new()`, and pass an `ArchiveHashes` instead of a decoded-blob slice. Rename `build_archive_meta_includes_optional_fields_and_filters_snapshot_blob` to `build_archive_meta_lists_only_resource_blobs` — the snapshot is no longer in the same list to filter out, it is a separate field:

```rust
    fn hashes_fixture() -> ArchiveHashes {
        ArchiveHashes {
            source_hash: "sha256:src".to_string(),
            content_hash: "sha256:content".to_string(),
            snapshot_hash: "sha256:snap".to_string(),
            resource_hashes: vec!["sha256:img".to_string()],
        }
    }

    #[test]
    fn build_archive_meta_lists_only_resource_blobs() {
        let meta = build_archive_meta(&request_fixture(), &hashes_fixture());

        let archive = match meta.extra.get("archive") {
            Some(toml::Value::Table(m)) => m,
            other => panic!("expected archive mapping, got {other:?}"),
        };
        let blobs: Vec<&str> = archive["blobs"]
            .as_array()
            .expect("blobs array present")
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(blobs, vec!["sha256:img"]);
        assert_eq!(archive["resource_count"].as_integer(), Some(1));
        assert_eq!(archive["snapshot_hash"].as_str(), Some("sha256:snap"));
        assert_eq!(archive["source_hash"].as_str(), Some("sha256:src"));
    }
```

- [ ] **Step 5: Rewrite the ingest flow**

In `ingest_archive`, replace everything from the `validate_blob_sizes` call through the `store_decoded_blobs` call. The `content_hash` verification, the ingest lock, the duplicate check and the path resolution stay where they are; only the duplicate comparison and the blob handling change.

```rust
    // Verify content_hash matches markdown_body (don't trust client-provided hash)
    let computed_content_hash = ContentStore::hash_bytes(req.markdown_body.as_bytes());
    if computed_content_hash != req.content_hash {
        return Err(ApiError::bad_request(format!(
            "content_hash mismatch: declared={}, computed={}",
            req.content_hash, computed_content_hash
        )));
    }
    // The verified transport hash is exactly "the markdown as captured".
    let source_hash = req.content_hash.clone();

    let prefix = archive_config.default_path_prefix.clone();
    let max_blob_size_mb = archive_config.max_blob_size_mb;
    let max_request_size_mb = archive_config.max_request_size_mb;

    let _ingest_guard = state.archive_ingest_lock.lock().await;

    // 1. Check for existing archive of this URL via the index
    let url_for_lookup = req.url.clone();
    let existing = state
        .index
        .with_index(move |index, _vault| index.find_by_archive_url(&url_for_lookup))
        .await
        .map_err(|e| ApiError::internal(format!("index lookup: {e}")))?
        .map_err(|e| ApiError::internal(format!("index lookup: {e}")))?;

    if let Some((page_id, vault_path, existing_hash)) = existing {
        if existing_hash == source_hash {
            return Ok((
                StatusCode::OK,
                Json(ArchiveResponse {
                    page_id,
                    vault_path,
                    blobs_stored: 0,
                    blobs_deduped: 0,
                    status: ArchiveStatus::AlreadyExists,
                }),
            )
                .into_response());
        }
        return Err(ApiError::conflict_with_detail(
            format!("archive exists with different content: {}", req.url),
            serde_json::json!({
                "existing_hash": existing_hash,
                "new_hash": source_hash,
                "page_id": page_id,
                "vault_path": vault_path,
            }),
        ));
    }

    // 2. Validate path BEFORE touching CAS (prevents orphaned blobs on bad input)
    let slug = slugify(&req.title, 80);
    let vault_root = state.vault.root();
    let page_path =
        resolve_page_path(&prefix, &req.domain, &slug, |c| vault_root.join(c).exists())?;

    let vault_path = VaultPath::new(&page_path)
        .map_err(|e| ApiError::bad_request(format!("invalid generated path: {e}")))?;

    // 3. Deconstruct the snapshot and rewrite both artifacts from one map. The
    //    server is the only component that decides what a resource's identity
    //    is; splitting that across the extension let the markdown and the
    //    snapshot disagree about what they referenced.
    let deconstructed = archive_snapshot::deconstruct(&req.snapshot_html);
    validate_resource_sizes(
        &deconstructed.resources,
        deconstructed.html.len(),
        max_blob_size_mb,
        max_request_size_mb,
    )?;

    // The map is built from the rewritten snapshot, because it pairs each
    // `data-sf-original-src` with the `cas:` reference that just replaced that
    // element's `src`.
    let url_map = archive_snapshot::original_url_map(&deconstructed.html, &req.url);
    let markdown_body =
        archive_snapshot::rewrite_markdown_images(&req.markdown_body, &url_map, &req.url);
    let content_hash = ContentStore::hash_bytes(markdown_body.as_bytes());

    let snapshot_bytes = deconstructed.html.into_bytes();
    let snapshot_hash = ContentStore::hash_bytes(&snapshot_bytes);

    let resource_hashes: Vec<String> = deconstructed
        .resources
        .iter()
        .map(|r| r.hash.clone())
        .collect();

    let mut to_store: Vec<(String, Vec<u8>, String)> = deconstructed
        .resources
        .into_iter()
        .map(|r| (r.hash, r.bytes, r.content_type))
        .collect();
    to_store.push((
        snapshot_hash.clone(),
        snapshot_bytes,
        "text/html".to_string(),
    ));

    let (blobs_stored, blobs_deduped, stored_hashes) =
        match store_decoded_blobs(&state.cas, &to_store) {
            Ok(stored) => stored,
            Err(failure) => {
                return Err(rollback_cas(failure.primary, &state, &failure.ref_hashes));
            }
        };

    // 4. Create and index the page through the reviewed Created policy.
    let meta = build_archive_meta(
        &req,
        &ArchiveHashes {
            source_hash,
            content_hash,
            snapshot_hash,
            resource_hashes,
        },
    );
    let page_id = meta.id.to_string();
    let expected_page_content = write_page_content(&meta, &markdown_body);
```

Then in the `create_page` call below, change `body: req.markdown_body` to `body: markdown_body`. Everything from the compensation block onwards is unchanged.

- [ ] **Step 6: Point duplicate detection at `source_hash`**

`src/vault/index.rs:1410`:

```rust
            "SELECT id, path, json_extract(meta_json, '$.archive.source_hash')
             FROM pages
             WHERE json_extract(meta_json, '$.archive.url') = ?1",
```

- [ ] **Step 7: Raise the size limits**

`src/vault/config.rs`:

```rust
fn default_max_blob_size_mb() -> u64 {
    // Matches gwern's `--max-resource-size 100`. A media-heavy capture inlines
    // tens of megabytes and base64 adds a third.
    100
}

fn default_max_request_size_mb() -> u64 {
    // One page carrying several large resources, plus base64 overhead.
    250
}
```

`src/api/mod.rs:162` and `src/api/archive.rs:228` both become `250 * 1024 * 1024`, with their comments updated to say 250 MB. `run_server` already derives the real limit from config, so these two only govern tests and any caller that skips config.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cargo test --test archive_test && cargo test --lib archive`
Expected: all pass, including the seven new integration tests.

- [ ] **Step 9: Verify the gates**

Run, as separate commands: `rustfmt --check --edition 2024 src/api/archive.rs src/vault/config.rs src/vault/index.rs tests/archive_test.rs`; `cargo clippy --all-targets -- -D warnings`; `cargo test 2>&1 | grep -c '^test result: FAILED'`. Do not run bare `cargo fmt` — see Global Constraints.
Expected: clippy clean; the grep prints `0`. Count failures explicitly — parsing the summary line by field position mis-reads the `FAILED.` variant and has reported a green run over an aborted one.

- [ ] **Step 10: Commit**

```bash
git add src/api/archive.rs src/api/mod.rs src/api/openapi.rs src/vault/config.rs src/vault/index.rs tests/archive_test.rs
git commit -m "feat(archive): deconstruct captures server-side into the CAS"
```

---

## Task 4: Cross-origin fetch relay

SingleFile fetches every resource itself. In MV3 a content script's `fetch` is bound by the **page's** CORS policy, not the extension's host permissions, so most cross-origin resources fail — and `single-file-core` swallows a failed fetch into an empty resource, producing a snapshot that looks complete and is not. This is the failure the whole design exists to prevent, so the relay is not optional.

The page's own `fetch` is still tried first: it carries the session cookies that make paywalled and authenticated captures work, which is the entire reason capture stays in the browser.

**Files:**
- Create: `extension/src/lib/relay-fetch.ts`
- Test: `extension/src/lib/__tests__/relay-fetch.test.ts`

**Interfaces:**
- Produces:
  - `interface RelayResponse { status: number; headers: Record<string, string>; base64: string }`
  - `type RelayFailure = { error: string }`
  - `createRelayFetch(send: (message: unknown) => Promise<unknown>): (url: string, options?: { headers?: Record<string, string> }) => Promise<SingleFileResponse>` — content side.
  - `performRelayFetch(url: string, headers: Record<string, string> | undefined, fetchImpl?: typeof fetch): Promise<RelayResponse | RelayFailure>` — worker side.
  - `RELAY_FETCH = "relay_fetch"` message type.
- Consumed by: Task 7 (content script) and Task 8 (service worker).

`SingleFileResponse` is the shape `single-file-core`'s `util.getContent` requires: `{ status, url, headers: { get(name) }, arrayBuffer() }`. Nothing else is read.

- [ ] **Step 1: Write the failing tests**

```ts
// extension/src/lib/__tests__/relay-fetch.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRelayFetch, performRelayFetch } from "#/lib/relay-fetch";

function response(body: Uint8Array, init: { status?: number; type?: string } = {}) {
	return {
		ok: (init.status ?? 200) < 400,
		status: init.status ?? 200,
		headers: new Headers({ "content-type": init.type ?? "image/png" }),
		arrayBuffer: async () => body.buffer,
	} as unknown as Response;
}

describe("createRelayFetch", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses the page's own fetch when it succeeds", async () => {
		const pageFetch = vi.fn().mockResolvedValue(response(new Uint8Array([1, 2])));
		vi.stubGlobal("fetch", pageFetch);
		const send = vi.fn();

		const relayFetch = createRelayFetch(send);
		const result = await relayFetch("https://cdn.example.com/a.png");

		expect(await result.arrayBuffer()).toEqual(new Uint8Array([1, 2]).buffer);
		expect(send).not.toHaveBeenCalled();
	});

	it("relays when the page's fetch throws on CORS", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
		const send = vi.fn().mockResolvedValue({
			status: 200,
			headers: { "content-type": "image/png" },
			base64: "AQI=",
		});

		const relayFetch = createRelayFetch(send);
		const result = await relayFetch("https://cdn.example.com/a.png");

		expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
		expect(result.headers.get("content-type")).toBe("image/png");
	});

	it("relays when the page's fetch returns an error status", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(new Uint8Array(), { status: 403 })));
		const send = vi.fn().mockResolvedValue({
			status: 200,
			headers: {},
			base64: "AQI=",
		});

		const relayFetch = createRelayFetch(send);
		await relayFetch("https://cdn.example.com/a.png");

		expect(send).toHaveBeenCalledOnce();
	});

	it("propagates a relay failure so SingleFile records an empty resource", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("nope")));
		const send = vi.fn().mockResolvedValue({ error: "net::ERR_NAME_NOT_RESOLVED" });

		const relayFetch = createRelayFetch(send);

		await expect(relayFetch("https://cdn.example.com/a.png")).rejects.toThrow(
			"net::ERR_NAME_NOT_RESOLVED",
		);
	});

	it("looks headers up case-insensitively", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("nope")));
		const send = vi.fn().mockResolvedValue({
			status: 200,
			headers: { "content-type": "text/css" },
			base64: "",
		});

		const relayFetch = createRelayFetch(send);
		const result = await relayFetch("https://cdn.example.com/a.css");

		expect(result.headers.get("Content-Type")).toBe("text/css");
	});
});

describe("performRelayFetch", () => {
	it("returns status, headers and base64 bytes", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(response(new Uint8Array([1, 2])));

		const result = await performRelayFetch("https://cdn.example.com/a.png", undefined, fetchImpl);

		expect(result).toEqual({
			status: 200,
			headers: { "content-type": "image/png" },
			base64: "AQI=",
		});
	});

	it("sends cookies, because that is the point of relaying", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(response(new Uint8Array()));

		await performRelayFetch("https://cdn.example.com/a.png", undefined, fetchImpl);

		expect(fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: "include" });
	});

	it("reports a failure rather than throwing across the message boundary", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("ERR_CONNECTION_REFUSED"));

		const result = await performRelayFetch("https://cdn.example.com/a.png", undefined, fetchImpl);

		expect(result).toEqual({ error: "ERR_CONNECTION_REFUSED" });
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test relay-fetch`
Expected: FAIL — `Failed to resolve import "#/lib/relay-fetch"`.

- [ ] **Step 3: Write the implementation**

```ts
// extension/src/lib/relay-fetch.ts
/**
 * Resource fetching for SingleFile, across the content-script / worker boundary.
 *
 * An MV3 content script's `fetch` is subject to the *page's* CORS policy, not
 * the extension's host permissions, so most cross-origin resources fail there.
 * `single-file-core` turns a failed fetch into an empty resource without
 * complaining, which would give us snapshots that look complete and are not.
 *
 * The page's own fetch is still tried first: it carries the session cookies that
 * make paywalled and authenticated captures work, and those are the only reason
 * capture happens in the browser at all.
 */

export const RELAY_FETCH = "relay_fetch";

export interface RelayFetchRequest {
	type: typeof RELAY_FETCH;
	url: string;
	headers?: Record<string, string>;
}

export interface RelayResponse {
	status: number;
	/** Lower-cased header names. */
	headers: Record<string, string>;
	base64: string;
}

export interface RelayFailure {
	error: string;
}

/** The subset of `Response` that `single-file-core`'s `getContent` reads. */
export interface SingleFileResponse {
	status: number;
	url: string;
	headers: { get: (name: string) => string | null };
	arrayBuffer: () => Promise<ArrayBuffer>;
}

interface FetchOptions {
	headers?: Record<string, string>;
}

function decodeBase64(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

function encodeBase64(bytes: Uint8Array): string {
	const CHUNK_SIZE = 0x8000; // 32KB, to stay under the argument-count limit
	const parts: string[] = [];
	for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
		const end = Math.min(i + CHUNK_SIZE, bytes.length);
		let chunk = "";
		for (let j = i; j < end; j++) {
			chunk += String.fromCharCode(bytes[j]);
		}
		parts.push(chunk);
	}
	return btoa(parts.join(""));
}

/** Content-script side: try the page, fall back to the worker. */
export function createRelayFetch(
	send: (message: unknown) => Promise<unknown>,
): (url: string, options?: FetchOptions) => Promise<SingleFileResponse> {
	return async function relayFetch(url, options = {}) {
		try {
			const direct = await globalThis.fetch(url, {
				cache: "force-cache",
				headers: options.headers,
				referrerPolicy: "strict-origin-when-cross-origin",
			});
			if (direct.ok) {
				return direct as unknown as SingleFileResponse;
			}
		} catch {
			// CORS, mixed content, or a dead host. The relay may still manage it.
		}

		const relayed = (await send({
			type: RELAY_FETCH,
			url,
			headers: options.headers,
		} satisfies RelayFetchRequest)) as RelayResponse | RelayFailure;

		if ("error" in relayed) {
			throw new Error(relayed.error);
		}

		const buffer = decodeBase64(relayed.base64);
		return {
			status: relayed.status,
			url,
			headers: {
				get: (name: string) => relayed.headers[name.toLowerCase()] ?? null,
			},
			arrayBuffer: async () => buffer,
		};
	};
}

/**
 * Worker side. Never throws: a rejection would cross the message boundary as an
 * opaque "could not establish connection" and lose the actual cause.
 */
export async function performRelayFetch(
	url: string,
	headers: Record<string, string> | undefined,
	fetchImpl: typeof fetch = fetch,
): Promise<RelayResponse | RelayFailure> {
	try {
		const response = await fetchImpl(url, {
			cache: "force-cache",
			credentials: "include",
			headers,
			referrerPolicy: "strict-origin-when-cross-origin",
		});
		const bytes = new Uint8Array(await response.arrayBuffer());
		const collected: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			collected[key.toLowerCase()] = value;
		});
		return {
			status: response.status,
			headers: collected,
			base64: encodeBase64(bytes),
		};
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test relay-fetch`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add extension/src/lib/relay-fetch.ts extension/src/lib/__tests__/relay-fetch.test.ts
git commit -m "feat(extension): relay SingleFile resource fetches through the worker"
```

---

## Task 5: Chunked capture transfer

A snapshot is megabytes of string. Chrome requires extension messages to be JSON-serialisable and rejects oversized ones, so the content script sends the payload in pieces and the worker reassembles it.

**Files:**
- Create: `extension/src/lib/chunked-transfer.ts`
- Test: `extension/src/lib/__tests__/chunked-transfer.test.ts`

**Interfaces:**
- Produces:
  - `CHUNK_SIZE = 4 * 1024 * 1024`
  - `interface CaptureChunk { type: "capture_chunk"; captureId: string; index: number; total: number; text: string }`
  - `splitIntoChunks(captureId: string, text: string, size?: number): CaptureChunk[]`
  - `class ChunkAssembler { accept(chunk: CaptureChunk): string | null; forget(captureId: string): void; get pending(): number }`
- Consumed by: Task 7 (content script) and Task 8 (service worker).

`accept` returns the reassembled string on the chunk that completes a capture, and `null` otherwise.

- [ ] **Step 1: Write the failing tests**

```ts
// extension/src/lib/__tests__/chunked-transfer.test.ts
import { describe, expect, it } from "vitest";

import { ChunkAssembler, splitIntoChunks } from "#/lib/chunked-transfer";

describe("splitIntoChunks", () => {
	it("splits a payload into sized pieces that concatenate back", () => {
		const chunks = splitIntoChunks("cap-1", "abcdefg", 3);

		expect(chunks.map((c) => c.text)).toEqual(["abc", "def", "g"]);
		expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
		expect(chunks.every((c) => c.total === 3)).toBe(true);
	});

	it("emits a single chunk for a short payload", () => {
		expect(splitIntoChunks("cap-1", "abc", 1024)).toHaveLength(1);
	});

	it("emits one empty chunk for an empty payload", () => {
		// A zero-chunk capture would never complete on the receiving side.
		const chunks = splitIntoChunks("cap-1", "", 1024);

		expect(chunks).toEqual([
			{ type: "capture_chunk", captureId: "cap-1", index: 0, total: 1, text: "" },
		]);
	});
});

describe("ChunkAssembler", () => {
	it("returns null until the last chunk arrives", () => {
		const assembler = new ChunkAssembler();
		const chunks = splitIntoChunks("cap-1", "abcdefg", 3);

		expect(assembler.accept(chunks[0])).toBeNull();
		expect(assembler.accept(chunks[1])).toBeNull();
		expect(assembler.accept(chunks[2])).toBe("abcdefg");
	});

	it("reassembles out-of-order chunks", () => {
		const assembler = new ChunkAssembler();
		const [a, b, c] = splitIntoChunks("cap-1", "abcdefg", 3);

		expect(assembler.accept(c)).toBeNull();
		expect(assembler.accept(a)).toBeNull();
		expect(assembler.accept(b)).toBe("abcdefg");
	});

	it("keeps concurrent captures apart", () => {
		const assembler = new ChunkAssembler();
		const one = splitIntoChunks("cap-1", "aaaa", 2);
		const two = splitIntoChunks("cap-2", "bbbb", 2);

		expect(assembler.accept(one[0])).toBeNull();
		expect(assembler.accept(two[0])).toBeNull();
		expect(assembler.accept(one[1])).toBe("aaaa");
		expect(assembler.accept(two[1])).toBe("bbbb");
	});

	it("releases its buffer once a capture completes", () => {
		const assembler = new ChunkAssembler();
		const chunks = splitIntoChunks("cap-1", "abcd", 2);

		assembler.accept(chunks[0]);
		assembler.accept(chunks[1]);

		expect(assembler.pending).toBe(0);
	});

	it("ignores a duplicate chunk instead of double-counting it", () => {
		const assembler = new ChunkAssembler();
		const chunks = splitIntoChunks("cap-1", "abcd", 2);

		assembler.accept(chunks[0]);
		expect(assembler.accept(chunks[0])).toBeNull();
		expect(assembler.accept(chunks[1])).toBe("abcd");
	});

	it("forgets an abandoned capture", () => {
		// A tab closed mid-transfer would otherwise pin megabytes in a worker
		// that is meant to be able to suspend.
		const assembler = new ChunkAssembler();
		assembler.accept(splitIntoChunks("cap-1", "abcd", 2)[0]);

		assembler.forget("cap-1");

		expect(assembler.pending).toBe(0);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test chunked-transfer`
Expected: FAIL — `Failed to resolve import "#/lib/chunked-transfer"`.

- [ ] **Step 3: Write the implementation**

```ts
// extension/src/lib/chunked-transfer.ts
/**
 * Moving a capture from the content script to the service worker.
 *
 * A SingleFile snapshot is megabytes of string, and Chrome requires extension
 * messages to be JSON-serialisable and rejects oversized ones. So the payload
 * travels in pieces.
 *
 * A `chrome.runtime.Port` was the obvious alternative and is worse: it needs
 * request/response correlation code that repeated `sendMessage` calls get for
 * free, and it adds a disconnect lifecycle to reason about.
 */

export const CHUNK_SIZE = 4 * 1024 * 1024;

export const CAPTURE_CHUNK = "capture_chunk";

export interface CaptureChunk {
	type: typeof CAPTURE_CHUNK;
	captureId: string;
	index: number;
	total: number;
	text: string;
}

export function splitIntoChunks(
	captureId: string,
	text: string,
	size: number = CHUNK_SIZE,
): CaptureChunk[] {
	// One empty chunk rather than none: a zero-chunk capture never completes.
	const total = Math.max(1, Math.ceil(text.length / size));
	const chunks: CaptureChunk[] = [];
	for (let index = 0; index < total; index++) {
		chunks.push({
			type: CAPTURE_CHUNK,
			captureId,
			index,
			total,
			text: text.slice(index * size, (index + 1) * size),
		});
	}
	return chunks;
}

export class ChunkAssembler {
	private buffers = new Map<string, Map<number, string>>();

	/** The reassembled payload once every chunk has arrived, else null. */
	accept(chunk: CaptureChunk): string | null {
		let parts = this.buffers.get(chunk.captureId);
		if (!parts) {
			parts = new Map();
			this.buffers.set(chunk.captureId, parts);
		}
		parts.set(chunk.index, chunk.text);

		if (parts.size < chunk.total) return null;

		const ordered: string[] = [];
		for (let index = 0; index < chunk.total; index++) {
			ordered.push(parts.get(index) ?? "");
		}
		this.buffers.delete(chunk.captureId);
		return ordered.join("");
	}

	/** Drop a capture that will never complete, e.g. its tab closed. */
	forget(captureId: string): void {
		this.buffers.delete(captureId);
	}

	get pending(): number {
		return this.buffers.size;
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test chunked-transfer`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add extension/src/lib/chunked-transfer.ts extension/src/lib/__tests__/chunked-transfer.test.ts
git commit -m "feat(extension): move captures to the worker in chunks"
```

---

## Task 6: Capture hygiene

Refuse a capture that is corrupt or is an error page wearing an HTTP 200. Each check encodes a failure gwern actually hit (`gwern.net/build/linkArchive.sh:158-162`).

**Files:**
- Create: `extension/src/lib/capture-hygiene.ts`
- Test: `extension/src/lib/__tests__/capture-hygiene.test.ts`

**Interfaces:**
- Produces: `snapshotRejection(snapshotHtml: string, articleTextLength: number): string | null` — the reason to refuse, or `null` to proceed.
- Consumed by: Task 7 (content script).

Note the deviation recorded in **Global Constraints → Deliberate deviations #4**: gwern greps the raw snapshot unconditionally and accepts false positives because he reviews every capture in a browser. We gate the marker check on a short article, so a piece *about* HTTP status codes still archives.

- [ ] **Step 1: Write the failing tests**

```ts
// extension/src/lib/__tests__/capture-hygiene.test.ts
import { describe, expect, it } from "vitest";

import { snapshotRejection } from "#/lib/capture-hygiene";

const LONG_ARTICLE = 5000;
const SHORT_ARTICLE = 100;

function snapshot(body: string): string {
	return `<html><body>${body}${"x".repeat(2000)}</body></html>`;
}

describe("snapshotRejection", () => {
	it("accepts an ordinary capture", () => {
		expect(snapshotRejection(snapshot("<p>An article.</p>"), LONG_ARTICLE)).toBeNull();
	});

	it("refuses a capture under 1 KB as corrupt", () => {
		const reason = snapshotRejection("<html></html>", LONG_ARTICLE);

		expect(reason).toMatch(/1 KB|too small|truncated/i);
	});

	it("refuses an error page that returned HTTP 200", () => {
		const reason = snapshotRejection(snapshot("<h1>404 Not Found</h1>"), SHORT_ARTICLE);

		expect(reason).toMatch(/404 Not Found/);
	});

	it.each([
		"403 Forbidden",
		"Access Denied",
		"Download Limit Exceeded",
		"Instance has been rate limited",
		"Token is required",
	])("refuses a page reading %s", (marker) => {
		expect(snapshotRejection(snapshot(`<h1>${marker}</h1>`), SHORT_ARTICLE)).toContain(marker);
	});

	it("archives a long article that merely discusses an error code", () => {
		// The marker check is what makes false positives possible, so it only
		// fires on a page that also yielded almost no article text.
		expect(
			snapshotRejection(snapshot("<p>On seeing 404 Not Found in the wild…</p>"), LONG_ARTICLE),
		).toBeNull();
	});

	it("accepts a short capture with no error marker", () => {
		// A genuinely brief post is not a failure.
		expect(snapshotRejection(snapshot("<p>Short.</p>"), SHORT_ARTICLE)).toBeNull();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test capture-hygiene`
Expected: FAIL — `Failed to resolve import "#/lib/capture-hygiene"`.

- [ ] **Step 3: Write the implementation**

```ts
// extension/src/lib/capture-hygiene.ts
/**
 * Refuse a capture that is not worth storing.
 *
 * Adopted from gwern.net/build/linkArchive.sh, where each check encodes a
 * failure actually encountered: a snapshot truncated to nothing, and a server
 * returning its error page under HTTP 200.
 */

/** Below this a snapshot cannot contain a page, only a failure. */
const MIN_SNAPSHOT_BYTES = 1024;

/**
 * Above this much extracted article text, a marker is far likelier to be the
 * page's subject than its content. gwern greps unconditionally and accepts the
 * false positives because he reviews every capture; we do not.
 */
const ARTICLE_TEXT_FLOOR = 1500;

const ERROR_PAGE_MARKERS = [
	"403 Forbidden",
	"404 Not Found",
	"Access Denied",
	"Download Limit Exceeded",
	"Instance has been rate limited",
	"Token is required",
];

/** Why this capture must not be archived, or null to proceed. */
export function snapshotRejection(
	snapshotHtml: string,
	articleTextLength: number,
): string | null {
	if (snapshotHtml.length < MIN_SNAPSHOT_BYTES) {
		return `The capture is only ${snapshotHtml.length} bytes — under 1 KB, so it is truncated or empty rather than a page.`;
	}

	if (articleTextLength >= ARTICLE_TEXT_FLOOR) return null;

	const marker = ERROR_PAGE_MARKERS.find((m) => snapshotHtml.includes(m));
	if (marker) {
		return `The page reads as an error page ("${marker}") despite loading successfully. Nothing was archived.`;
	}

	return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test capture-hygiene`
Expected: 10 passed (5 plain cases plus the 5-marker `it.each`).

- [ ] **Step 5: Commit**

```bash
git add extension/src/lib/capture-hygiene.ts extension/src/lib/__tests__/capture-hygiene.test.ts
git commit -m "feat(extension): refuse corrupt and error-page captures"
```

---

## Task 7: SingleFile in the content script

Run a real archiver over the live DOM, then Readability over the same page visit, then send the result.

Order matters: SingleFile runs **first** because `loadDeferredImages` scrolls the page and forces lazy images to resolve, so the Readability clone taken afterwards sees images that were not there before. SingleFile itself works on a serialized copy of the document (`Runner` stores `util.serialize(doc)` and re-parses it), so it does not corrupt the live DOM the clone comes from.

**Files:**
- Create: `extension/src/lib/singlefile.ts`
- Create: `extension/src/types/single-file-core.d.ts`
- Modify: `extension/src/content/capture.ts`
- Modify: `extension/package.json` (add `"single-file-core": "1.5.84"` to `dependencies`)
- Modify: `extension/vite.config.ts` (alias, see Step 5)
- Test: `extension/src/lib/__tests__/singlefile.test.ts`

**Interfaces:**
- Consumes: `createRelayFetch` (Task 4), `splitIntoChunks` (Task 5), `snapshotRejection` (Task 6).
- Produces:
  - `snapshotOptions(input: { maxResourceSizeMb: number }): Record<string, unknown>`
  - `captureSnapshot(input: { maxResourceSizeMb: number }, initOptions: { fetch: unknown; frameFetch: unknown }): Promise<string>`
  - `CaptureResult` on `#/content/capture` loses nothing and gains nothing — `singlefile_html` now holds a real snapshot.
  - New message: `{ type: "capture_meta"; captureId: string } & Omit<CaptureResult, "singlefile_html">`, followed by the chunks.

- [ ] **Step 1: Install the dependency**

```bash
cd extension && bun add single-file-core@1.5.84
```

Verified: it bundles to ~800 KB minified with esbuild, resolves with no externals, and contains no bare `require(`.

- [ ] **Step 2: Write the failing tests**

`getPageData` needs a real browser, so the tests pin the option set — which is where the load-bearing decisions live — rather than the call.

```ts
// extension/src/lib/__tests__/singlefile.test.ts
import { describe, expect, it } from "vitest";

import { snapshotOptions } from "#/lib/singlefile";

describe("snapshotOptions", () => {
	it("records the pre-inlining URL of every resource", () => {
		// The only join between a markdown image and the blob the server stores.
		expect(snapshotOptions({ maxResourceSizeMb: 100 }).saveOriginalURLs).toBe(true);
	});

	it("does not inject a meta CSP", () => {
		// Served under CSP sandbox the frame has an opaque origin, so the meta's
		// img-src 'self' would match nothing and block every deconstructed
		// resource. Meta and header CSPs intersect; the header cannot relax it.
		expect(snapshotOptions({ maxResourceSizeMb: 100 }).insertMetaCSP).toBe(false);
	});

	it("does not group duplicate images", () => {
		// Grouping rewrites <img src> into a CSS variable, destroying both the
		// data: URI and the original-URL pairing. The CAS dedups by hash anyway.
		expect(snapshotOptions({ maxResourceSizeMb: 100 }).groupDuplicateImages).toBe(false);
	});

	it("blocks scripts", () => {
		// They can never run in the viewer, and stripping them stops a page's own
		// JS from tearing the DOM down after capture.
		expect(snapshotOptions({ maxResourceSizeMb: 100 }).blockScripts).toBe(true);
	});

	it("keeps video and audio, as gwern does", () => {
		const options = snapshotOptions({ maxResourceSizeMb: 100 });

		expect(options.blockVideos).toBe(false);
		expect(options.blockAudios).toBe(false);
	});

	it("declines oversized resources at capture time", () => {
		const options = snapshotOptions({ maxResourceSizeMb: 100 });

		expect(options.maxResourceSizeEnabled).toBe(true);
		expect(options.maxResourceSize).toBe(100);
	});

	it("inlines rather than compressing, because the server deconstructs", () => {
		expect(snapshotOptions({ maxResourceSizeMb: 100 }).compressContent).toBe(false);
	});

	it("waits for deferred images", () => {
		const options = snapshotOptions({ maxResourceSizeMb: 100 });

		expect(options.loadDeferredImages).toBe(true);
		expect(options.loadDeferredImagesMaxIdleTime).toBe(3000);
	});

	it("bounds a single resource fetch", () => {
		// SingleFile disables this by default. Without it one hung CDN stalls
		// the capture indefinitely — the bound `fetchRemoteImages` used to carry.
		expect(snapshotOptions({ maxResourceSizeMb: 100 }).networkTimeout).toBe(15_000);
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun run test singlefile`
Expected: FAIL — `Failed to resolve import "#/lib/singlefile"`.

- [ ] **Step 4: Write the implementation**

```ts
// extension/src/types/single-file-core.d.ts
declare module "single-file-core/single-file.js" {
	export interface PageData {
		content: string;
		title: string;
		filename: string;
		mimeType: string;
	}

	export function getPageData(
		options?: Record<string, unknown>,
		initOptions?: Record<string, unknown>,
		doc?: Document,
		win?: Window,
	): Promise<PageData>;
}
```

```ts
// extension/src/lib/singlefile.ts
import { getPageData } from "single-file-core/single-file.js";

/**
 * The SingleFile option set, pinned here rather than left to defaults.
 *
 * Four of these are load-bearing for how clepsydra stores a capture, and each
 * carries the reason it is set — because the failure mode of getting one wrong
 * is a snapshot that renders blank, not a crash.
 */
export function snapshotOptions(input: {
	maxResourceSizeMb: number;
}): Record<string, unknown> {
	return {
		// The join key between the markdown and the deconstructed snapshot. The
		// server rewrites a markdown image to a blob by matching the URL recorded
		// here as data-sf-original-src; without it there is nothing to match on.
		saveOriginalURLs: true,

		// SingleFile otherwise injects
		//   <meta http-equiv="content-security-policy" content="… img-src 'self' …">
		// Served under the viewer's `Content-Security-Policy: sandbox` the frame
		// has an opaque origin, so 'self' matches nothing and every deconstructed
		// resource is blocked. Meta and header CSPs intersect, so the header
		// cannot relax it afterwards.
		insertMetaCSP: false,

		// Grouping replaces a duplicate <img src> with a CSS custom property,
		// which destroys both the data: URI we deconstruct and the
		// data-sf-original-src ↔ src pairing. The CAS deduplicates by hash across
		// every page, which is strictly better.
		groupDuplicateImages: false,

		// Scripts can never execute in the viewer, so keeping them buys no
		// fidelity — and stripping them makes "the site's own JS tears the DOM
		// down after capture" structurally impossible rather than
		// fingerprint-dependent.
		blockScripts: true,

		// gwern keeps both and bounds them with a per-resource cap; so do we. An
		// archive keeps what was there.
		blockVideos: false,
		blockAudios: false,

		removeHiddenElements: true,
		removeUnusedStyles: true,
		removeUnusedFonts: true,
		removeFrames: false,
		compressHTML: true,
		compressCSS: true,

		// Inline every resource as a data: URI. The server pulls them back out;
		// compressContent would instead produce a zip we have no use for.
		compressContent: false,

		loadDeferredImages: true,
		loadDeferredImagesMaxIdleTime: 3000,

		// SingleFile disables its network timeout by default. The per-request
		// bound that `fetchRemoteImages` used to carry has to live somewhere, or
		// one hung CDN stalls the whole capture indefinitely.
		networkTimeout: 15_000,

		// Declined at capture time rather than producing a payload the server
		// will reject. Mirrors the server's archive.max_blob_size_mb.
		maxResourceSizeEnabled: true,
		maxResourceSize: input.maxResourceSizeMb,

		// Unused — we never write a file — but formatFilename runs regardless.
		filenameTemplate: "{page-title}.html",
	};
}

/** Capture the live document as self-contained HTML. */
export async function captureSnapshot(
	input: { maxResourceSizeMb: number },
	initOptions: { fetch: unknown; frameFetch: unknown },
): Promise<string> {
	const pageData = await getPageData(
		snapshotOptions(input),
		initOptions as Record<string, unknown>,
	);
	return pageData.content;
}
```

- [ ] **Step 5: Alias the package and rewrite the content script**

`extension/vite.config.ts`, inside `resolve.alias`, below the existing turndown entries:

```ts
			// Bundled into the content script, which is where SingleFile is
			// designed to run: it needs a real DOM, DOMParser, Blob and
			// FileReader. ~800 KB minified, injected on demand rather than on
			// every page load.
			"single-file-core": resolve(__dirname, "node_modules/single-file-core"),
```

Replace `extension/src/content/capture.ts` entirely:

```ts
/**
 * Content script injected into the active tab.
 *
 * Captures the page twice from one visit: SingleFile for a snapshot that still
 * renders when the origin is gone, and Readability for the article body that
 * becomes the markdown. SingleFile runs first because loading deferred images
 * scrolls the page, so the Readability clone taken afterwards sees images that
 * were not there before. SingleFile works on a serialized copy of the document,
 * so it does not corrupt the DOM that clone comes from.
 */

import { Readability } from "@mozilla/readability";
import { snapshotRejection } from "#/lib/capture-hygiene";
import { splitIntoChunks } from "#/lib/chunked-transfer";
import { createRelayFetch } from "#/lib/relay-fetch";
import { captureSnapshot } from "#/lib/singlefile";
import { DEFAULT_SETTINGS } from "#/lib/types";

export interface CaptureMetadata {
	url: string;
	canonical_url?: string;
	title: string;
	description?: string;
	article_html: string | null;
	article_text_length: number;
	/**
	 * Provenance Readability already parses out of the page. It used to be
	 * discarded along with the rest of the parse result, losing author and
	 * publication date for every archived page.
	 */
	byline?: string;
	site_name?: string;
	published_time?: string;
	lang?: string;
	excerpt?: string;
}

export interface CaptureMetaMessage {
	type: "capture_meta";
	captureId: string;
	/** Nested rather than spread, so the worker never has to strip envelope
	 *  fields back off with an unused-binding destructure. */
	metadata: CaptureMetadata;
}

/** Trim to a non-empty string, or drop it. */
function clean(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function send(message: unknown): Promise<unknown> {
	return chrome.runtime.sendMessage(message);
}

async function maxResourceSizeMb(): Promise<number> {
	try {
		const stored = await chrome.storage.sync.get("settings");
		const settings = { ...DEFAULT_SETTINGS, ...stored.settings };
		return settings.max_blob_size_mb;
	} catch {
		return DEFAULT_SETTINGS.max_blob_size_mb;
	}
}

async function capture(): Promise<void> {
	const relayFetch = createRelayFetch(send);
	const snapshotHtml = await captureSnapshot(
		{ maxResourceSizeMb: await maxResourceSizeMb() },
		{ fetch: relayFetch, frameFetch: relayFetch },
	);

	// Readability mutates the document it is given, so it gets a clone.
	const clonedDoc = document.cloneNode(true) as Document;
	const article = new Readability(clonedDoc).parse();
	const articleTextLength = article?.textContent?.length || 0;

	const rejection = snapshotRejection(snapshotHtml, articleTextLength);
	if (rejection) {
		await send({ type: "capture_error", error: rejection });
		return;
	}

	const captureId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const message: CaptureMetaMessage = {
		type: "capture_meta",
		captureId,
		metadata: {
			url: window.location.href,
			canonical_url:
				document.querySelector<HTMLLinkElement>("link[rel=canonical]")?.href ||
				undefined,
			title: document.title,
			description:
				document.querySelector<HTMLMetaElement>("meta[name=description]")
					?.content || undefined,
			article_html: article?.content || null,
			article_text_length: articleTextLength,
			byline: clean(article?.byline),
			site_name: clean(article?.siteName),
			published_time: clean(article?.publishedTime),
			// Readability does not report the document language; take it from the
			// document element, which is where pages actually declare it.
			lang: clean(article?.lang ?? document.documentElement.lang),
			excerpt: clean(article?.excerpt),
		},
	};

	await send(message);
	// Sequential, so the worker's idle timer is reset by each one and a slow
	// upload cannot outrun its own transport.
	for (const chunk of splitIntoChunks(captureId, snapshotHtml)) {
		await send(chunk);
	}
}

capture().catch((err) => {
	void send({ type: "capture_error", error: String(err) });
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run test singlefile && bun run typecheck`
Expected: 8 passed; typecheck clean. `service-worker.ts` will still reference the old `CaptureResult` — that is Task 8; if `typecheck` fails only there, proceed.

- [ ] **Step 7: Commit**

```bash
git add extension/src/lib/singlefile.ts extension/src/lib/__tests__/singlefile.test.ts \
        extension/src/types/single-file-core.d.ts extension/src/content/capture.ts \
        extension/vite.config.ts extension/package.json extension/bun.lock
git commit -m "feat(extension): capture with SingleFile instead of outerHTML"
```

---

## Task 8: The worker becomes a courier

Strip the extension's resource pipeline and leave the worker doing three things: serving fetch relays, reassembling the capture, and posting one manifest.

**Files:**
- Modify: `extension/src/background/service-worker.ts`
- Modify: `extension/src/lib/turndown-rules.ts`
- Modify: `extension/src/lib/types.ts`
- Modify: `extension/src/lib/__tests__/turndown-rules.test.ts`
- Delete: `extension/src/lib/remote-resources.ts`, `extension/src/lib/resource-extractor.ts`, `extension/src/lib/__tests__/remote-resources.test.ts`, `extension/src/lib/__tests__/resource-extractor.test.ts`

**Interfaces:**
- Consumes: `ChunkAssembler` (Task 5), `performRelayFetch` / `RELAY_FETCH` (Task 4), `CaptureMetaMessage` (Task 7).
- Produces: `ArchiveManifest` with `snapshot_html: string`, without `snapshot_hash` and `blobs`; `convertArchiveHtml(html: string): string` (no `resourceMap`); `addArchiveRules(td: TurndownService): void`.

All of the deleted code compensated for the absent archiver: a regex over `<img src>` in the Readability output, capped at 50, blind to `srcset`, `<picture>` and CSS backgrounds. SingleFile captures those properly. Hardening those guards earlier is what made it obvious they were the wrong layer — the work is superseded, not wasted.

- [ ] **Step 1: Write the failing tests**

Update `extension/src/lib/__tests__/turndown-rules.test.ts`: every call to `convertArchiveHtml(html, map)` / `addArchiveRules(td, map)` drops its second argument. Replace the `cas-images` cases with:

```ts
	it("keeps the original image URL for the server to rewrite", () => {
		// The server owns resource identity now: it holds the only map from an
		// original URL to a stored blob, so the markdown must arrive with the URL
		// that map is keyed on.
		const markdown = convertArchiveHtml(
			'<img src="https://cdn.example.com/a.png" alt="a cat">',
		);

		expect(markdown).toBe("![a cat](https://cdn.example.com/a.png)");
	});

	it("no longer emits cas: references", () => {
		const markdown = convertArchiveHtml('<img src="https://cdn.example.com/a.png">');

		expect(markdown).not.toContain("cas:");
		expect(markdown).not.toContain("unarchived");
	});
```

Then delete the two obsolete test files:

```bash
git rm extension/src/lib/__tests__/remote-resources.test.ts \
       extension/src/lib/__tests__/resource-extractor.test.ts \
       extension/src/lib/remote-resources.ts \
       extension/src/lib/resource-extractor.ts
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test turndown-rules`
Expected: FAIL — `Expected "![a cat](https://cdn.example.com/a.png)" but got "![a cat](https://cdn.example.com/a.png "unarchived")"`.

- [ ] **Step 3: Drop the CAS image rule**

In `extension/src/lib/turndown-rules.ts`, delete `addCasImageRule` entirely and change the two signatures:

```ts
/** Register every archive conversion rule on a Turndown instance. */
export function addArchiveRules(td: TurndownService): void {
	addTableSupport(td);
	addDemoteHeadingsRule(td);
	addFigureRule(td);
	addStrikethroughRule(td);
}

/**
 * Convert archived article HTML to markdown.
 *
 * Image URLs are left exactly as Readability resolved them — absolute, pointing
 * at the live web. The server rewrites them to `cas:` references, because it
 * holds the only map from an original URL to a stored blob.
 */
export function convertArchiveHtml(html: string): string {
	const td = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
	});
	addArchiveRules(td);
	return td.turndown(parseArchiveHtml(html));
}
```

Turndown's built-in image rule then handles `<img>`, emitting `![alt](src)` — which is what the server's `rewrite_markdown_images` regex matches.

- [ ] **Step 4: Update the manifest type**

In `extension/src/lib/types.ts`, replace `snapshot_hash` and `blobs` on `ArchiveManifest`:

```ts
export interface ArchiveManifest {
	url: string;
	canonical_url?: string;
	domain: string;
	title: string;
	description?: string;
	captured_at: string;
	/** sha256 of `markdown_body` as sent; the server's transport check. */
	content_hash: string;
	/** The SingleFile capture, resources still inlined. The server deconstructs it. */
	snapshot_html: string;
	markdown_body: string;
	tags: string[];
	/** Provenance parsed from the page by Readability; all optional. */
	byline?: string;
	site_name?: string;
	published_time?: string;
	lang?: string;
	excerpt?: string;
}
```

Delete the now-unused `BlobUpload` interface. Update the `ExtensionSettings` doc comment and defaults:

```ts
	/**
	 * Mirrors the server's `archive.max_blob_size_mb` / `max_request_size_mb`
	 * (src/vault/config.rs). The per-resource limit is handed to SingleFile so it
	 * declines an oversized resource at capture time; exceeding the total fails
	 * the whole capture, because a snapshot missing arbitrary resources is not a
	 * snapshot.
	 */
	max_blob_size_mb: number;
	max_request_size_mb: number;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
	server_url: "http://localhost:3000",
	default_tags: [],
	notify_on_success: true,
	notify_on_duplicate: true,
	max_blob_size_mb: 100,
	max_request_size_mb: 250,
};
```

- [ ] **Step 5: Rewrite the worker's capture path**

In `extension/src/background/service-worker.ts`:

Replace the import block's resource lines:

```ts
import type { CaptureMetadata, CaptureMetaMessage } from "#/content/capture";
import { ArchiveConflictError, ClepsydraClient } from "#/lib/api-client";
import { type CapturePhase, badgeFor, isTerminal } from "#/lib/badge";
import { CaptureQueue } from "#/lib/capture-queue";
import {
	CAPTURE_CHUNK,
	type CaptureChunk,
	ChunkAssembler,
} from "#/lib/chunked-transfer";
import { sha256String } from "#/lib/hasher";
import { executeCaptureScript } from "#/lib/inject-capture";
import { describeInjectionFailure } from "#/lib/injection";
import {
	RELAY_FETCH,
	type RelayFetchRequest,
	performRelayFetch,
} from "#/lib/relay-fetch";
import { convertArchiveHtml } from "#/lib/turndown-rules";
import type {
	ArchiveConflictDetail,
	ArchiveManifest,
	ExtensionSettings,
} from "#/lib/types";
import { DEFAULT_SETTINGS } from "#/lib/types";
```

Delete `uint8ToBase64`, `IMG_SRC_REGEX`, `MAX_REMOTE_IMAGES`, `RESOURCE_TIMEOUT_MS`, `extractImageSources`, `ResourceBundle`, `buildResourceMap`, and `appendIncompleteNote`. There is no partial capture to annotate any more: an incomplete one fails.

Replace `processCaptureResult` with:

```ts
/** Main pipeline: convert a completed capture and send it to the server. */
async function processCapture(
	metadata: CaptureMetadata,
	snapshotHtml: string,
	tabId: number | undefined,
): Promise<void> {
	const settings = await loadSettings();
	const client = new ClepsydraClient(settings.server_url);
	const capturedAt = new Date().toISOString();
	const domain = extractDomain(metadata.url);

	reportPhase(tabId, "uploading");

	// Image URLs stay as Readability resolved them. The server rewrites them to
	// cas: references by joining on the original URLs SingleFile recorded in the
	// snapshot — it holds the only map, so it does the only rewriting.
	const markdownBody =
		metadata.article_html && metadata.article_text_length >= 200
			? convertArchiveHtml(metadata.article_html)
			: buildFallbackMarkdown(metadata.url, capturedAt);

	const manifest: ArchiveManifest = {
		url: metadata.url,
		canonical_url: metadata.canonical_url,
		domain,
		title: metadata.title,
		description: metadata.description,
		captured_at: capturedAt,
		content_hash: await sha256String(markdownBody),
		snapshot_html: snapshotHtml,
		markdown_body: markdownBody,
		tags: ["archive", domain, currentMonthTag(), ...settings.default_tags],
		byline: metadata.byline,
		site_name: metadata.site_name,
		published_time: metadata.published_time,
		lang: metadata.lang,
		excerpt: metadata.excerpt,
	};

	try {
		const response = await client.ingestArchive(manifest);

		if (response.status === "already_exists") {
			reportPhase(tabId, "duplicate");
			if (settings.notify_on_duplicate) {
				showNotification(
					"Already Archived",
					`${metadata.title} was already saved.`,
				);
			}
		} else {
			reportPhase(tabId, "done");
			if (settings.notify_on_success) {
				showNotification(
					"Page Archived",
					`${metadata.title} → ${response.vault_path}`,
				);
			}
		}
	} catch (err) {
		if (err instanceof ArchiveConflictError) {
			reportPhase(tabId, "conflict");
			showNotification("Content Changed", describeConflict(metadata.title, err));
		} else {
			reportPhase(tabId, "error");
			showNotification("Archive Failed", String(err));
		}
	}
}
```

`buildFallbackMarkdown` loses its `snapshotHash` parameter — the extension never learns the hash now, because the server computes it after deconstruction:

```ts
/** Build fallback markdown when Readability fails. */
function buildFallbackMarkdown(url: string, capturedAt: string): string {
	return [
		"> Automated reader-mode extraction failed for this page.",
		"> The captured snapshot is still archived and viewable.",
		"",
		`**URL:** ${url}`,
		`**Captured:** ${capturedAt}`,
	].join("\n");
}
```

Replace the message listener. It now handles three inbound kinds, and `relay_fetch` is the only one that answers asynchronously — which is what `return true` is for:

```ts
/** Snapshot chunks in flight, keyed by capture id. */
const assembler = new ChunkAssembler();
/** Metadata that arrived ahead of its chunks. */
const pendingMetadata = new Map<string, { metadata: CaptureMetadata; tabId?: number }>();

type WorkerMessage =
	| CaptureMetaMessage
	| CaptureChunk
	| RelayFetchRequest
	| { type: "capture_error"; error: string }
	| { type: "capture_status"; tabId: number };

chrome.runtime.onMessage.addListener(
	(
		message: WorkerMessage,
		sender: chrome.runtime.MessageSender,
		sendResponse: (response?: unknown) => void,
	): boolean | undefined => {
		if (message.type === "capture_status") {
			// Answered synchronously, so no need to hold the channel open.
			sendResponse({ phase: phases.get(message.tabId) ?? null });
			return undefined;
		}

		if (message.type === RELAY_FETCH) {
			void performRelayFetch(message.url, message.headers).then(sendResponse);
			return true; // keep the channel open for the async reply
		}

		const tabId = sender.tab?.id;

		if (message.type === "capture_meta") {
			reportPhase(tabId, "processing");
			pendingMetadata.set(message.captureId, { metadata: message.metadata, tabId });
			return undefined;
		}

		if (message.type === CAPTURE_CHUNK) {
			const snapshotHtml = assembler.accept(message);
			if (snapshotHtml === null) return undefined;

			const pending = pendingMetadata.get(message.captureId);
			pendingMetadata.delete(message.captureId);
			if (!pending) {
				reportPhase(tabId, "error");
				showNotification("Archive Failed", "Capture metadata was lost in transit.");
				return undefined;
			}

			const started = captureQueue.run(pending.metadata.url, () =>
				processCapture(pending.metadata, snapshotHtml, pending.tabId).catch(
					(err) => {
						reportPhase(pending.tabId, "error");
						showNotification("Archive Failed", String(err));
					},
				),
			);
			if (!started) {
				showNotification(
					"Capture In Progress",
					`${pending.metadata.title} is already being archived.`,
				);
			}
			return undefined;
		}

		if (message.type === "capture_error") {
			reportPhase(tabId, "error");
			showNotification("Capture Failed", message.error);
		}
		return undefined;
	},
);
```

Extend the existing tab-removal listener so a tab closed mid-transfer does not pin megabytes in a worker that is meant to be able to suspend:

```ts
chrome.tabs.onRemoved?.addListener((tabId) => {
	phases.delete(tabId);
	for (const [captureId, pending] of pendingMetadata) {
		if (pending.tabId !== tabId) continue;
		pendingMetadata.delete(captureId);
		assembler.forget(captureId);
	}
});
```

Finally, update the `processing` badge title in `extension/src/lib/badge.ts` — "collecting images…" describes work that no longer happens here:

```ts
	processing: {
		text: "…",
		color: "#7c3aed",
		title: "Clepsydra: building the snapshot…",
		clearAfterMs: null,
	},
```

and its assertion in `extension/src/lib/__tests__/badge.test.ts` if one pins that string.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all suites pass with the two deleted files gone; typecheck and lint clean.

- [ ] **Step 7: Commit**

```bash
git add -A extension/src
git commit -m "refactor(extension): server owns the resource map; drop the scrape"
```

---

## Task 9: Prove the bundle, then prove the capture

The last regression here shipped green tests and a worker that threw on load, because the tests imported source modules while the browser loaded a bundle and the two resolved different builds of turndown. `verify-bundle.mjs` exists for exactly that class of failure, and the content script now carries ~800 KB of new third-party code that no test loads.

**Files:**
- Modify: `extension/scripts/verify-bundle.mjs`

**Interfaces:**
- Consumes: the built `dist/` from `vite build`.
- Produces: a non-zero exit when either bundle would fail in the browser.

- [ ] **Step 1: Extend the verifier to cover the content script**

Add a `chrome.runtime.onConnect` stub is *not* needed (Task 5 chose `sendMessage` over Ports), but `chrome.storage.sync.get` and `chrome.tabs.onRemoved` are now touched at module scope. Append before the final report:

```js
// The content script is an IIFE for a page context, so it cannot be imported
// here — but the failure mode that bit us is textual, and so is this check.
const contentPath = resolve(distDir, "content/capture.js");
const contentSource = await readFile(contentPath, "utf8");

if (/\brequire\s*\(/.test(contentSource)) {
	failures.push(
		"content bundle contains a bare require() call — it will throw the " +
			"moment the script is injected",
	);
}

// single-file-core is ~800 KB minified. A bundle far outside that has either
// lost it or swallowed something it should not have.
const contentMb = contentSource.length / 1024 / 1024;
if (contentMb < 0.5 || contentMb > 3) {
	failures.push(
		`content bundle is ${contentMb.toFixed(2)} MB, outside the expected ` +
			"0.5–3 MB — single-file-core is missing, or something else got bundled",
	);
}

if (!contentSource.includes("saveOriginalURLs")) {
	failures.push(
		"content bundle does not mention saveOriginalURLs — without it the " +
			"server cannot join a markdown image to its stored blob",
	);
}
```

Also add `onRemoved: listenerStub("tabs.onRemoved")` to the `chrome.tabs` stub, so the worker's module-scope registration does not throw.

- [ ] **Step 2: Run the build and the verifier**

Run: `cd extension && bun run build`
Expected: `✓ … loads with no DOM; registered N listeners`, then a clean exit.

- [ ] **Step 3: Prove the verifier still catches a real regression**

Temporarily change the `single-file-core` alias in `vite.config.ts` to a stub module that exports `getPageData` returning `{content: ""}`, rebuild, and confirm the size check fails. Revert.

Expected: `✗ bundle verification failed: content bundle is 0.0N MB, outside the expected 0.5–3 MB`.

- [ ] **Step 4: Capture a real page**

This is the step no test replaces. The tests pin the option set and the string transformations; only a browser proves that SingleFile runs, that the relay carries the resources, and that the deconstruction round-trips.

Two of the spec's extension tests land here rather than in vitest, because `getPageData` needs a real DOM, layout, and network stack:

| Spec test | Where it actually runs |
|---|---|
| "The content script produces a snapshot containing no `http:`/`https:` resource references" | Check 4 below, on a real capture. |
| "Original URLs survive into the snapshot for the server to join on" | Step 1's `saveOriginalURLs` bundle assertion, plus check 3 below (`resource_count` > 0 proves the join produced blobs). |

The rest of the spec's extension tests are unit tests: markdown retaining original URLs is Task 8 Step 1, and the sub-1 KB / error-page rejections are Task 6.

1. `cargo run -- serve` against a scratch vault.
2. Load `extension/dist` unpacked in Chrome; set the server URL in options.
3. Capture a media-heavy article — one with lazy-loaded images, a web font, and CSS background images.
4. Check, in order:
   - The badge moves through capturing → processing → uploading → done.
   - The archived page's markdown renders its images (they resolve through `cas:`).
   - `archive.resource_count` in the frontmatter is greater than zero and roughly matches the page.
   - `GET /api/vault/cas/<snapshot_hash>` downloads (it must — the G1 attachment rule still applies; inline rendering is the viewer's job).
   - The downloaded snapshot contains no `base64,` and no `http://`/`https://` resource references.
5. Capture a page containing an inline SVG asset and note whether it survives. **Expected to be a problem:** `image/svg+xml` is on `is_active_content`'s list, so `/api/vault/cas/{hash}` sends `Content-Disposition: attachment` for it. In `<img>` position an SVG cannot execute script, so the header protects nothing there, but browsers vary in honouring it for subresources. Record the result in the viewer spec's "Interaction with the CAS attachment rule" section. If it breaks, the fix is to distinguish navigation from subresource loading via `Sec-Fetch-Dest` — **not** to drop the attachment rule.
6. Capture a page behind a login, to confirm the page-fetch-first path in `createRelayFetch` is doing its job.

- [ ] **Step 5: Commit**

```bash
git add extension/scripts/verify-bundle.mjs
git commit -m "test(extension): verify the content bundle carries a real archiver"
```

---

## Task 10: Docs, schema, and the options copy

The request contract changed, so the generated types and every document describing the old pipeline are now wrong.

**Files:**
- Modify: `ui/src/api/schema.d.ts` (regenerated, not hand-edited)
- Modify: `ui/src/docs/content/browser-extension.mdx:110-125`
- Modify: `ui/src/docs/content/configuration.mdx:316-317,419-420`
- Modify: `ui/src/docs/content/capture-feeds-and-archives.mdx:29`
- Modify: `extension/README.md:60-70,120-126`
- Modify: `extension/src/options/options.html:44-56`

- [ ] **Step 1: Regenerate the OpenAPI schema against the working tree**

`bun run openapi` targets `localhost:3000`. Regenerating against a server running an older binary silently produces a schema missing the new fields that still typechecks — this has already happened once. Build from the working tree and use a throwaway vault on a free port:

```bash
cargo build
mkdir -p /tmp/clep-openapi-vault
./target/debug/clep --vault /tmp/clep-openapi-vault serve --port 3999 &
sleep 3
curl -s http://localhost:3999/api/openapi.json > /tmp/openapi.json
kill %1
```

Confirm the new contract is actually in it before generating:

```bash
grep -c 'snapshot_html' /tmp/openapi.json   # expect >= 1
grep -c 'BlobUpload' /tmp/openapi.json      # expect 0
```

Then regenerate from that file (`ui/package.json`'s `openapi` script points at the running server; either repoint it at `/tmp/openapi.json` for one run or start the throwaway server on port 3000 instead). Afterwards check the diff is small:

```bash
git diff --stat ui/src/api/schema.d.ts
```

Expected: tens of lines. **A diff of thousands of lines means biome reformatted the file** — restore it from HEAD and regenerate without running any formatter over it.

- [ ] **Step 2: Update the options copy**

The two size fields no longer skip an image; they fail a capture. `extension/src/options/options.html`:

```html
  <label for="max-blob-mb">Maximum resource size (MB)</label>
  <input type="number" id="max-blob-mb" min="1" step="1" />
  <p class="hint">
    A resource larger than this is left out of the capture. Match the server's
    <code>archive.max_blob_size_mb</code>.
  </p>

  <label for="max-request-mb">Maximum total capture size (MB)</label>
  <input type="number" id="max-request-mb" min="1" step="1" />
  <p class="hint">
    A capture over this size is refused outright rather than trimmed — a snapshot
    missing arbitrary resources is not a snapshot. Match the server's
    <code>archive.max_request_size_mb</code>.
  </p>
```

- [ ] **Step 3: Update the docs**

`ui/src/docs/content/configuration.mdx`: `max_blob_size_mb` default `50` → `100`, `max_request_size_mb` `100` → `250`, in both the table (lines 316–317) and the example block (lines 419–420).

`ui/src/docs/content/browser-extension.mdx`, the pipeline description at lines 110–125: replace the "hashes every resource and deduplicates blobs by hash" step and the manifest field list. The new pipeline is:

1. The content script runs SingleFile over the live DOM, inlining every resource, then Readability over the same page visit.
2. Cross-origin fetches relay through the service worker, because a content script's `fetch` obeys the page's CORS policy rather than the extension's host permissions.
3. The worker converts the article HTML to markdown with the original image URLs intact and POSTs `url`, `canonical_url`, `domain`, `title`, `description`, `captured_at`, `content_hash`, `snapshot_html`, `markdown_body`, `tags`, and the Readability provenance fields.
4. The server deconstructs the snapshot into the CAS, rewrites both the snapshot and the markdown to `cas:` references from one map, and computes `source_hash` (the capture) and `content_hash` (what it stored).

`ui/src/docs/content/capture-feeds-and-archives.mdx:29`: "hash, and base64 resource blobs to `POST /api/vault/archive`" → the extension posts markdown and a self-contained snapshot; the server stores the resources.

`extension/README.md`: the settings section (60–70) takes the new defaults and the fail-vs-skip wording; delete the "N resources could not be archived" note at 120–126 — that behaviour is gone.

- [ ] **Step 4: Verify the gates**

```bash
# Scoped: bare `cargo fmt` would rewrite 22 pre-existing files that already fail fmt on develop.
rustfmt --check --edition 2024 src/vault/archive_snapshot.rs src/api/archive.rs src/vault/config.rs src/vault/index.rs tests/archive_test.rs
cargo clippy --all-targets -- -D warnings
cargo test 2>&1 | grep -c '^test result: FAILED'   # expect 0
cd extension && bun run typecheck && bun run lint && bun run test && bun run build
cd ../ui && bun run typecheck && bun run lint && bun run test
```

Report each result explicitly. Do **not** run `biome check --write` across `ui/src` — the repo is not in a biome-formatted state and it would rewrite ~200 unrelated files.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/schema.d.ts ui/src/docs/content extension/README.md extension/src/options/options.html
git commit -m "docs: describe the SingleFile capture pipeline"
```

---

## Sequencing and risk

**Tasks 1–3 are server-side and land first.** Between Task 3 and Task 8 the shipped extension cannot talk to the server: it sends `blobs`, the server wants `snapshot_html`. That window is acceptable because the user has committed to capturing nothing until this ships ("i won't capture anything until this is complete though"), and there is exactly one archived page in the vault. Do not merge to `develop` mid-window.

**The one existing archive.** It was captured under the old pipeline and has `archive.content_hash` but no `archive.source_hash`, so `find_by_archive_url` will return an empty string for it after Task 3 Step 6. Re-capturing that URL will therefore 409 rather than matching. That is correct behaviour for one page and needs no migration; delete and re-capture it.

**What this forecloses.** The real HTTP exchange — status, response headers, redirect chain — is not recorded and cannot be reconstructed from these artifacts. A WACZ can be generated later from what is stored; headers that were never captured cannot. Accepted deliberately, per the spec's "Artifact choice".

**Untrusted input.** `src/vault/archive_snapshot.rs` operates on attacker-authored markup. It parses nothing and executes nothing — it matches a self-delimiting token and rewrites it — but it is a new surface. Its output is still served under the viewer's sandbox.

**Capture is slow and heavy.** SingleFile drives the page, forces lazy images, and waits. Captures will take seconds to tens of seconds. The queue, keepalive, per-request timeouts and badge phases were built for this and become load-bearing rather than precautionary.

**Follow-on.** The viewer spec (`2026-08-12-archived-page-viewer-design.md`) is unblocked by this work and is a short plan once it lands. It must implement the `cas:` → `/api/vault/cas/` rewrite at serve time (deviation #5), and it must resolve the SVG question recorded in Task 9 Step 4.
