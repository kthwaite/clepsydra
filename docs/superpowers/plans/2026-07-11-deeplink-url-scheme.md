# Deep-Link URL Scheme (`clepsydra://` + `obsidian://` compat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a `clepsydra://page/<target>` (or Obsidian-compat `obsidian://…`) link — inside the editor or anywhere in macOS — opens the matching vault page in the Clepsydra UI, with an honest not-found page on misses.

**Architecture:** A pure Rust parser/resolver module (`src/deeplink.rs`) is shared by two HTTP endpoints — `GET /api/vault/resolve` (JSON, used by the editor) and root-level `GET /deeplink` (redirect, used by the OS handler) — plus two CLI subcommands: `open-url` (translates a scheme URL into a browser hit on `/deeplink`) and `register-url` (generates + installs a tiny AppleScript applet `.app` declaring `CFBundleURLTypes`, so macOS Launch Services routes the schemes to us). The React editor detects scheme links in `LinkElement`, resolves via the JSON endpoint, and opens a workspace tab; server-side misses land on a new `/link-miss` route.

**Tech Stack:** Rust (Axum 0.8, rusqlite, percent-encoding 2, clap), React 19 + TanStack Router, vitest + @testing-library/react, sonner toasts, macOS `osacompile`/`PlistBuddy`/`lsregister`.

## Global Constraints

- **No new Cargo or npm dependencies.** `percent-encoding = "2"`, `dirs`, `tempfile` already exist; UI already has sonner, vitest, @testing-library/react.
- **Decisions locked by the operator (do not re-litigate):**
  - Native grammar is verb-first: `clepsydra://page/<target>`. Only the `page` verb exists today; unknown verbs are parse errors.
  - Layered resolution order: exact vault path → canonical name (unique match only) → 8-char base62 shortid (unique match only).
  - Unresolved deep links land on a **not-found page** (`/link-miss?target=…`), never auto-create, never redirect to search. In-editor misses show a sonner error toast (stay in document).
  - `obsidian://` compat parses `open?vault=X&file=Y` and the `obsidian://vault/<vault>/<note>` shorthand only. `path=` param, other actions (`new`, `daily`, `search`), and the Advanced URI plugin surface are **out of scope**.
  - `vault=X` is accepted when X equals the basename of `[vault].root` or an entry in new config field `vault.obsidian_vault_aliases`; otherwise the link is a miss.
  - The editor handles both schemes unconditionally; the `--obsidian` flag only affects OS registration.
- **Out of scope:** `web+` registerProtocolHandler, Windows/Linux OS registration, `clepsydra://journal|search` verbs.
- Rust: rustfmt + clippy clean. TS: strict tsc, biome. `ui/src/routeTree.gen.ts` is generated — never hand-edit.
- Run commands from the repo root; use `bun --cwd ui …` / `cd ui && bunx …` only where the tool requires it.
- Branch: `feature/deeplink-url-scheme` off `develop`; commit after every task.

---

### Task 1: Deep-link parser (`src/deeplink.rs`)

**Files:**
- Create: `src/deeplink.rs`
- Modify: `src/lib.rs` (add `pub mod deeplink;` next to the other `pub mod` lines near the top)
- Test: `tests/deeplink_test.rs`

**Interfaces:**
- Consumes: `percent_encoding::percent_decode_str` (existing dep).
- Produces (used by Tasks 2–4 and 6 via HTTP):
  - `pub struct ParsedLink { pub target_raw: String, pub target_decoded: String, pub vault: Option<String> }`
  - `pub enum ParseError { UnsupportedScheme, UnsupportedAction(String), MissingTarget, MissingFileParam, Malformed(String) }` (derives `Debug, PartialEq, Eq`; implements `Display`)
  - `pub fn parse(url: &str) -> Result<ParsedLink, ParseError>`
  - `pub fn vault_matches(vault: Option<&str>, vault_root: &std::path::Path, aliases: &[String]) -> bool`
  - `pub fn deeplink_http_url(base: &str, raw_url: &str) -> String`

- [ ] **Step 1: Write the failing tests**

```rust
// tests/deeplink_test.rs
use std::path::Path;

use clepsydra::deeplink::{ParseError, deeplink_http_url, parse, vault_matches};

#[test]
fn parses_clepsydra_page_link() {
    let p = parse("clepsydra://page/projects/20260531.foo.aB3dE9xZ.md").unwrap();
    assert_eq!(p.target_raw, "projects/20260531.foo.aB3dE9xZ.md");
    assert_eq!(p.target_decoded, "projects/20260531.foo.aB3dE9xZ.md");
    assert_eq!(p.vault, None);
}

#[test]
fn decodes_percent_encoding_but_keeps_raw() {
    let p = parse("clepsydra://page/Clepsydra%20Redesign").unwrap();
    assert_eq!(p.target_raw, "Clepsydra%20Redesign");
    assert_eq!(p.target_decoded, "Clepsydra Redesign");
}

#[test]
fn clepsydra_scheme_is_case_insensitive() {
    assert!(parse("CLEPSYDRA://page/x").is_ok());
}

#[test]
fn clepsydra_unknown_verb_is_error() {
    assert_eq!(
        parse("clepsydra://journal/2026-07-11").unwrap_err(),
        ParseError::UnsupportedAction("journal".to_string())
    );
}

#[test]
fn clepsydra_empty_target_is_error() {
    assert_eq!(parse("clepsydra://page/").unwrap_err(), ParseError::MissingTarget);
    assert_eq!(parse("clepsydra://page").unwrap_err(), ParseError::MissingTarget);
}

#[test]
fn parses_obsidian_open_action() {
    let p = parse("obsidian://open?vault=brain&file=Sub%2FNote").unwrap();
    assert_eq!(p.vault, Some("brain".to_string()));
    // Query param values arrive fully decoded; raw == decoded for query form.
    assert_eq!(p.target_raw, "Sub/Note");
    assert_eq!(p.target_decoded, "Sub/Note");
}

#[test]
fn obsidian_open_without_vault_is_ok() {
    let p = parse("obsidian://open?file=Note").unwrap();
    assert_eq!(p.vault, None);
    assert_eq!(p.target_decoded, "Note");
}

#[test]
fn obsidian_open_without_file_is_error() {
    assert_eq!(
        parse("obsidian://open?vault=brain").unwrap_err(),
        ParseError::MissingFileParam
    );
}

#[test]
fn parses_obsidian_vault_shorthand() {
    let p = parse("obsidian://vault/my%20vault/my%20note").unwrap();
    assert_eq!(p.vault, Some("my vault".to_string()));
    assert_eq!(p.target_raw, "my%20note");
    assert_eq!(p.target_decoded, "my note");
}

#[test]
fn obsidian_absolute_path_form_is_unsupported() {
    assert!(matches!(
        parse("obsidian:///Users/kit/vault/note.md").unwrap_err(),
        ParseError::UnsupportedAction(_)
    ));
}

#[test]
fn other_schemes_are_rejected() {
    assert_eq!(parse("https://example.com").unwrap_err(), ParseError::UnsupportedScheme);
    assert_eq!(parse("not a url").unwrap_err(), ParseError::Malformed("missing ://".to_string()));
}

#[test]
fn fragment_is_stripped() {
    let p = parse("clepsydra://page/Note#heading").unwrap();
    assert_eq!(p.target_decoded, "Note");
}

#[test]
fn vault_matches_none_always_passes() {
    assert!(vault_matches(None, Path::new("/x/notes"), &[]));
}

#[test]
fn vault_matches_basename_and_aliases() {
    let root = Path::new("/Users/kit/notes");
    assert!(vault_matches(Some("notes"), root, &[]));
    assert!(vault_matches(Some("brain"), root, &["brain".to_string()]));
    assert!(!vault_matches(Some("other"), root, &[]));
}

#[test]
fn deeplink_http_url_encodes_the_scheme_url() {
    assert_eq!(
        deeplink_http_url("http://localhost:16667", "obsidian://open?vault=b&file=A B"),
        "http://localhost:16667/deeplink?url=obsidian%3A%2F%2Fopen%3Fvault%3Db%26file%3DA%20B"
    );
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --test deeplink_test`
Expected: FAIL to compile — `clepsydra::deeplink` module not found.

- [ ] **Step 3: Write the implementation**

```rust
// src/deeplink.rs
//! Parsing and target-building for `clepsydra://` / `obsidian://` deep links.
//!
//! Grammar (locked by design review, 2026-07-11):
//! - `clepsydra://page/<target>` — verb-first; only `page` exists today.
//! - `obsidian://open?vault=X&file=Y` and `obsidian://vault/<vault>/<note>` —
//!   compat dialect. `path=` and other actions are unsupported.

use std::fmt;
use std::path::Path;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};

/// Everything except RFC 3986 unreserved characters gets percent-encoded when
/// a scheme URL is embedded as a query value.
const QUERY_VALUE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedLink {
    /// Target exactly as it appeared in the URL (still percent-encoded).
    pub target_raw: String,
    /// Percent-decoded target.
    pub target_decoded: String,
    /// Vault name carried by obsidian:// links; `None` for clepsydra:// links.
    pub vault: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    UnsupportedScheme,
    UnsupportedAction(String),
    MissingTarget,
    MissingFileParam,
    Malformed(String),
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedScheme => write!(f, "unsupported scheme (expected clepsydra:// or obsidian://)"),
            Self::UnsupportedAction(a) => write!(f, "unsupported action: {a}"),
            Self::MissingTarget => write!(f, "link has no target"),
            Self::MissingFileParam => write!(f, "obsidian://open link is missing the file= parameter"),
            Self::Malformed(m) => write!(f, "malformed link: {m}"),
        }
    }
}

impl std::error::Error for ParseError {}

fn decode(raw: &str) -> Result<String, ParseError> {
    percent_decode_str(raw)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|_| ParseError::Malformed("invalid percent-encoding".to_string()))
}

/// Split off a `#fragment` suffix, if any.
fn strip_fragment(s: &str) -> &str {
    s.split_once('#').map_or(s, |(head, _)| head)
}

pub fn parse(url: &str) -> Result<ParsedLink, ParseError> {
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| ParseError::Malformed("missing ://".to_string()))?;
    let rest = strip_fragment(rest);

    match scheme.to_ascii_lowercase().as_str() {
        "clepsydra" => {
            let (verb, target) = rest.split_once('/').unwrap_or((rest, ""));
            if verb != "page" {
                if verb.is_empty() {
                    return Err(ParseError::MissingTarget);
                }
                return Err(ParseError::UnsupportedAction(verb.to_string()));
            }
            // Ignore any query string; no page parameters exist yet.
            let target = target.split_once('?').map_or(target, |(head, _)| head);
            if target.is_empty() {
                return Err(ParseError::MissingTarget);
            }
            Ok(ParsedLink {
                target_raw: target.to_string(),
                target_decoded: decode(target)?,
                vault: None,
            })
        }
        "obsidian" => {
            if let Some(query) = rest.strip_prefix("open?") {
                let mut vault = None;
                let mut file = None;
                for pair in query.split('&') {
                    let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                    match k {
                        "vault" => vault = Some(decode(v)?),
                        "file" => file = Some(decode(v)?),
                        _ => {}
                    }
                }
                let file = file.ok_or(ParseError::MissingFileParam)?;
                Ok(ParsedLink {
                    target_raw: file.clone(),
                    target_decoded: file,
                    vault,
                })
            } else if let Some(rest) = rest.strip_prefix("vault/") {
                let (vault, target) = rest
                    .split_once('/')
                    .ok_or(ParseError::MissingTarget)?;
                if target.is_empty() {
                    return Err(ParseError::MissingTarget);
                }
                Ok(ParsedLink {
                    target_raw: target.to_string(),
                    target_decoded: decode(target)?,
                    vault: Some(decode(vault)?),
                })
            } else {
                let action = rest.split(['/', '?']).next().unwrap_or("").to_string();
                Err(ParseError::UnsupportedAction(action))
            }
        }
        _ => Err(ParseError::UnsupportedScheme),
    }
}

/// An obsidian:// link's vault name is accepted when it matches the basename
/// of the configured vault root or one of the configured aliases.
pub fn vault_matches(vault: Option<&str>, vault_root: &Path, aliases: &[String]) -> bool {
    let Some(name) = vault else { return true };
    if vault_root.file_name().is_some_and(|b| b == name) {
        return true;
    }
    aliases.iter().any(|a| a == name)
}

/// Build the local HTTP URL the OS handler opens for a raw scheme URL.
pub fn deeplink_http_url(base: &str, raw_url: &str) -> String {
    format!(
        "{base}/deeplink?url={}",
        utf8_percent_encode(raw_url, QUERY_VALUE)
    )
}
```

And in `src/lib.rs`, alongside the existing module declarations (e.g. next to `pub mod doctor;` / `pub mod vault;` — match whatever the file has near the top):

```rust
pub mod deeplink;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --test deeplink_test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deeplink.rs src/lib.rs tests/deeplink_test.rs
git commit -m "feat(deeplink): parse clepsydra:// and obsidian:// scheme URLs"
```

---

### Task 2: Layered target resolver

**Files:**
- Modify: `src/deeplink.rs` (append the resolver)
- Test: `tests/deeplink_test.rs` (append resolver tests)

**Interfaces:**
- Consumes: `crate::vault::canonical::CanonicalName` (`CanonicalName::new(&str)`, `.as_str()`); index schema tables `pages(id, path, canonical_name, …)` and `canonical_names(canonical_name, page_id)`.
- Produces (used by Task 3):
  - `pub fn resolve_target(conn: &rusqlite::Connection, raw: &str, decoded: &str) -> Result<Option<String>, rusqlite::Error>` — returns the matched vault path.

**Resolution order (locked):** exact path (raw, decoded, each with `.md` appended if absent) → canonical name of the last path segment, unique match only → shortid (`^[0-9A-Za-z]{8}$`), unique filename-suffix match only. Ambiguity at a layer falls through to the next; final ambiguity is a miss.

- [ ] **Step 1: Write the failing tests**

Append to `tests/deeplink_test.rs`. Build a real index the way `tests/support/mod.rs` does (init_vault → seed files → `VaultIndex::open` + `build` + `resolve_links`), then query through `index.connection()`:

```rust
use clepsydra::deeplink::resolve_target;
use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;

/// Seed a vault with three pages and return an open, built index.
/// - `projects/20260531.alpha.aB3dE9xZ.md` (title "Alpha Project")
/// - `20260601.beta.Zz9Yy8Xx.md`           (title "Beta")
/// - `dupe/20260601.beta2.Qq7Ww6Ee.md`     (title "Beta") — makes "beta" ambiguous
fn seeded_index() -> (tempfile::TempDir, VaultIndex) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    std::fs::create_dir_all(root.join("projects")).unwrap();
    std::fs::create_dir_all(root.join("dupe")).unwrap();
    std::fs::write(
        root.join("projects/20260531.alpha.aB3dE9xZ.md"),
        "---\nid: 0190f8a0-0000-7000-8000-0000000000a1\ntitle: Alpha Project\ncreated_at: 2026-05-31T12:00:00Z\n---\nbody\n",
    )
    .unwrap();
    std::fs::write(
        root.join("20260601.beta.Zz9Yy8Xx.md"),
        "---\nid: 0190f8a0-0000-7000-8000-0000000000a2\ntitle: Beta\ncreated_at: 2026-06-01T12:00:00Z\n---\nbody\n",
    )
    .unwrap();
    std::fs::write(
        root.join("dupe/20260601.beta2.Qq7Ww6Ee.md"),
        "---\nid: 0190f8a0-0000-7000-8000-0000000000a3\ntitle: Beta\ncreated_at: 2026-06-01T13:00:00Z\n---\nbody\n",
    )
    .unwrap();
    let vault = Vault::open(&root).unwrap();
    let mut index = VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();
    (tmp, index)
}

#[test]
fn resolves_exact_path() {
    let (_tmp, index) = seeded_index();
    let hit = resolve_target(
        index.connection(),
        "projects/20260531.alpha.aB3dE9xZ.md",
        "projects/20260531.alpha.aB3dE9xZ.md",
    )
    .unwrap();
    assert_eq!(hit.as_deref(), Some("projects/20260531.alpha.aB3dE9xZ.md"));
}

#[test]
fn resolves_path_without_md_extension() {
    let (_tmp, index) = seeded_index();
    let hit = resolve_target(
        index.connection(),
        "projects/20260531.alpha.aB3dE9xZ",
        "projects/20260531.alpha.aB3dE9xZ",
    )
    .unwrap();
    assert_eq!(hit.as_deref(), Some("projects/20260531.alpha.aB3dE9xZ.md"));
}

#[test]
fn resolves_unique_canonical_name_case_insensitively() {
    let (_tmp, index) = seeded_index();
    let hit = resolve_target(index.connection(), "alpha%20project", "Alpha Project").unwrap();
    assert_eq!(hit.as_deref(), Some("projects/20260531.alpha.aB3dE9xZ.md"));
}

#[test]
fn ambiguous_canonical_name_is_a_miss() {
    let (_tmp, index) = seeded_index();
    let hit = resolve_target(index.connection(), "Beta", "Beta").unwrap();
    assert_eq!(hit, None);
}

#[test]
fn resolves_shortid() {
    let (_tmp, index) = seeded_index();
    let hit = resolve_target(index.connection(), "aB3dE9xZ", "aB3dE9xZ").unwrap();
    assert_eq!(hit.as_deref(), Some("projects/20260531.alpha.aB3dE9xZ.md"));
}

#[test]
fn unknown_target_is_a_miss() {
    let (_tmp, index) = seeded_index();
    let hit = resolve_target(index.connection(), "no-such-page", "no-such-page").unwrap();
    assert_eq!(hit, None);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --test deeplink_test`
Expected: FAIL to compile — `resolve_target` not found.

- [ ] **Step 3: Write the implementation**

Append to `src/deeplink.rs`:

```rust
use rusqlite::{Connection, OptionalExtension, params};

use crate::vault::canonical::CanonicalName;

/// Layered lookup: exact path → unique canonical name → unique shortid.
///
/// `raw` is tried alongside `decoded` for path matches because vault paths may
/// legitimately contain percent-encoded bytes (VaultPath encodes `/` in slugs
/// as `%2F`), so the encoded form can itself be the stored path.
pub fn resolve_target(
    conn: &Connection,
    raw: &str,
    decoded: &str,
) -> Result<Option<String>, rusqlite::Error> {
    // 1. Exact path, with and without a supplied `.md`.
    let mut candidates: Vec<String> = Vec::new();
    for t in [raw, decoded] {
        candidates.push(t.to_string());
        if !t.ends_with(".md") {
            candidates.push(format!("{t}.md"));
        }
    }
    candidates.dedup();
    for cand in &candidates {
        let hit: Option<String> = conn
            .query_row("SELECT path FROM pages WHERE path = ?1", params![cand], |row| {
                row.get(0)
            })
            .optional()?;
        if hit.is_some() {
            return Ok(hit);
        }
    }

    // 2. Canonical name of the last path segment; only a unique match counts
    //    (mirrors wikilink resolution policy — ambiguity never picks silently).
    let name = decoded.rsplit('/').next().unwrap_or(decoded);
    let canonical = CanonicalName::new(name);
    let mut stmt = conn.prepare(
        "SELECT p.path FROM canonical_names cn JOIN pages p ON p.id = cn.page_id
         WHERE cn.canonical_name = ?1",
    )?;
    let paths: Vec<String> = stmt
        .query_map(params![canonical.as_str()], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    if let [only] = paths.as_slice() {
        return Ok(Some(only.clone()));
    }

    // 3. Shortid: the third dot-segment of the canonical filename scheme
    //    `<yyyymmdd>.<slug>.<shortid>.md`. Alphanumeric-only, so the LIKE
    //    pattern needs no escaping.
    if decoded.len() == 8 && decoded.chars().all(|c| c.is_ascii_alphanumeric()) {
        let mut stmt = conn.prepare("SELECT path FROM pages WHERE path LIKE '%.' || ?1 || '.md'")?;
        let paths: Vec<String> = stmt
            .query_map(params![decoded], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        if let [only] = paths.as_slice() {
            return Ok(Some(only.clone()));
        }
    }

    Ok(None)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --test deeplink_test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deeplink.rs tests/deeplink_test.rs
git commit -m "feat(deeplink): layered path/canonical/shortid target resolver"
```

---

### Task 3: Config alias field + HTTP endpoints (`/api/vault/resolve`, `/deeplink`)

**Files:**
- Modify: `src/vault/config.rs` (add `obsidian_vault_aliases` to `VaultSection`)
- Create: `src/api/deeplink.rs`
- Modify: `src/api/mod.rs` (module decl + merge into `api_router_with_archive_limit`)
- Modify: `src/lib.rs:348-356` (`build_router` — merge the root router)
- Modify: `src/api/openapi.rs` (register the resolve path + response schema)
- Modify: `tests/support/mod.rs:155-157` (merge root router into the test app)
- Test: `tests/api_deeplink_test.rs`

**Interfaces:**
- Consumes: `deeplink::{parse, vault_matches, resolve_target, ParseError}` from Tasks 1–2; `AppState` fields `vault` (`.root()`, `.config().vault`) and `index` (`.with_index(closure)`), per `src/api/pages.rs:342-377`.
- Produces:
  - `GET /api/vault/resolve?url=<scheme url>` → `200 {"path": "<vault path>"}` | `400` (parse error) | `404` (miss or vault mismatch). Consumed by Task 6's UI client.
  - `GET /deeplink?url=<scheme url>` → `307` to `/pages/<encoded path>` on hit, `307` to `/link-miss?target=<encoded url>` on miss/parse error. Consumed by Task 4's CLI and Task 7's route.
  - Config: `VaultConfig.vault.obsidian_vault_aliases: Vec<String>` (serde default `[]`).

- [ ] **Step 1: Add the config field**

In `src/vault/config.rs`, add to `VaultSection` (match the existing serde-default style used by sibling fields):

```rust
    /// Obsidian vault names accepted by obsidian:// compat links, in addition
    /// to the basename of the vault root.
    #[serde(default)]
    pub obsidian_vault_aliases: Vec<String>,
```

If `VaultSection` has a manual `Default` impl or a builder used in tests, add `obsidian_vault_aliases: Vec::new()` there too.

Run: `cargo build`
Expected: compiles.

- [ ] **Step 2: Write the failing integration tests**

```rust
// tests/api_deeplink_test.rs
mod support;

use axum::http::StatusCode;
use support::ApiFixture;

fn seed_alpha(root: &std::path::Path) {
    std::fs::create_dir_all(root.join("projects")).unwrap();
    std::fs::write(
        root.join("projects/20260531.alpha.aB3dE9xZ.md"),
        "---\nid: 0190f8a0-0000-7000-8000-0000000000a1\ntitle: Alpha Project\ncreated_at: 2026-05-31T12:00:00Z\n---\nbody\n",
    )
    .unwrap();
}

#[tokio::test]
async fn resolve_returns_path_for_clepsydra_link() {
    let fx = ApiFixture::builder().pre_index_seed(seed_alpha).build();
    let res = fx
        .server
        .get("/api/vault/resolve")
        .add_query_param("url", "clepsydra://page/Alpha%20Project")
        .await;
    res.assert_status(StatusCode::OK);
    let body: serde_json::Value = res.json();
    assert_eq!(body["path"], "projects/20260531.alpha.aB3dE9xZ.md");
}

#[tokio::test]
async fn resolve_handles_obsidian_open_with_matching_vault() {
    let fx = ApiFixture::builder().pre_index_seed(seed_alpha).build();
    // ApiFixture's vault root directory is named "vault" (tests/support/mod.rs:109).
    let res = fx
        .server
        .get("/api/vault/resolve")
        .add_query_param("url", "obsidian://open?vault=vault&file=Alpha%20Project")
        .await;
    res.assert_status(StatusCode::OK);
}

#[tokio::test]
async fn resolve_rejects_vault_mismatch_with_404() {
    let fx = ApiFixture::builder().pre_index_seed(seed_alpha).build();
    let res = fx
        .server
        .get("/api/vault/resolve")
        .add_query_param("url", "obsidian://open?vault=someone-elses&file=Alpha%20Project")
        .await;
    res.assert_status(StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn resolve_unknown_target_is_404_and_bad_url_is_400() {
    let fx = ApiFixture::builder().build();
    let miss = fx
        .server
        .get("/api/vault/resolve")
        .add_query_param("url", "clepsydra://page/nope")
        .await;
    miss.assert_status(StatusCode::NOT_FOUND);
    let bad = fx
        .server
        .get("/api/vault/resolve")
        .add_query_param("url", "clepsydra://frobnicate/x")
        .await;
    bad.assert_status(StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn deeplink_redirects_to_page_on_hit() {
    let fx = ApiFixture::builder().pre_index_seed(seed_alpha).build();
    let res = fx
        .server
        .get("/deeplink")
        .add_query_param("url", "clepsydra://page/aB3dE9xZ")
        .await;
    res.assert_status(StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(
        res.header("location"),
        "/pages/projects/20260531.alpha.aB3dE9xZ.md"
    );
}

#[tokio::test]
async fn deeplink_redirects_to_link_miss_on_miss() {
    let fx = ApiFixture::builder().build();
    let res = fx
        .server
        .get("/deeplink")
        .add_query_param("url", "clepsydra://page/nope")
        .await;
    res.assert_status(StatusCode::TEMPORARY_REDIRECT);
    let loc = res.header("location");
    let loc = loc.to_str().unwrap();
    assert!(loc.starts_with("/link-miss?target="), "got {loc}");
}
```

Note: `axum_test::TestServer` does not follow redirects by default, so 307 + `location` asserts work directly. If `add_query_param` is not available in the pinned `axum_test` version, fall back to pre-encoding: `.get("/api/vault/resolve?url=clepsydra%3A%2F%2Fpage%2FAlpha%2520Project")`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test --test api_deeplink_test`
Expected: FAIL — 404s from missing routes (or compile error on `api::deeplink`).

- [ ] **Step 4: Write the handlers**

```rust
// src/api/deeplink.rs
//! Deep-link endpoints: JSON resolution for the editor, redirect for the OS
//! URL handler.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Query, State};
use axum::response::{Json, Redirect};
use axum::routing::get;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;
use crate::deeplink;

/// Keep `/` so a vault path stays a path in the redirect location.
const PATH_KEEP_SLASH: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'/')
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

const QUERY_VALUE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

#[derive(Debug, Deserialize)]
pub struct DeepLinkParams {
    pub url: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ResolveResponse {
    /// Vault-relative path of the resolved page.
    pub path: String,
}

/// Parse + vault-check + resolve; `Ok(None)` is a miss, `Err` a parse error.
async fn resolve_pipeline(
    state: &Arc<AppState>,
    url: &str,
) -> Result<Option<String>, deeplink::ParseError> {
    let parsed = deeplink::parse(url)?;
    let aliases = state.vault.config().vault.obsidian_vault_aliases.clone();
    if !deeplink::vault_matches(parsed.vault.as_deref(), state.vault.root(), &aliases) {
        return Ok(None);
    }
    let raw = parsed.target_raw;
    let decoded = parsed.target_decoded;
    let found = state
        .index
        .with_index(move |index, _vault| {
            deeplink::resolve_target(index.connection(), &raw, &decoded).unwrap_or(None)
        })
        .await
        .unwrap_or(None);
    Ok(found)
}

#[utoipa::path(
    get,
    path = "/resolve",
    context_path = "/api/vault",
    tag = "Deeplink",
    params(("url" = String, Query, description = "clepsydra:// or obsidian:// URL")),
    responses(
        (status = 200, description = "Resolved page path", body = ResolveResponse),
        (status = 400, description = "Unparseable link", body = ApiError),
        (status = 404, description = "No page matches", body = ApiError)
    )
)]
pub async fn resolve_url(
    State(state): State<Arc<AppState>>,
    Query(params): Query<DeepLinkParams>,
) -> Result<Json<ResolveResponse>, ApiError> {
    let found = resolve_pipeline(&state, &params.url)
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    found
        .map(|path| Json(ResolveResponse { path }))
        .ok_or_else(|| ApiError::not_found(format!("no page matches: {}", params.url)))
}

/// Root-level redirect target for the OS URL handler. Misses and parse errors
/// both land on the UI's not-found page — an OS click must never dead-end on
/// a JSON error body.
pub async fn deeplink_redirect(
    State(state): State<Arc<AppState>>,
    Query(params): Query<DeepLinkParams>,
) -> Redirect {
    match resolve_pipeline(&state, &params.url).await {
        Ok(Some(path)) => {
            Redirect::temporary(&format!("/pages/{}", utf8_percent_encode(&path, PATH_KEEP_SLASH)))
        }
        _ => Redirect::temporary(&format!(
            "/link-miss?target={}",
            utf8_percent_encode(&params.url, QUERY_VALUE)
        )),
    }
}

/// Routes mounted under `/api/vault`.
pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/resolve", get(resolve_url))
}

/// Routes mounted at the server root (outside `/api`).
pub fn root_router() -> Router<Arc<AppState>> {
    Router::new().route("/deeplink", get(deeplink_redirect))
}
```

If `ApiError` doesn't implement the exact constructor names above, mirror `src/api/pages.rs` usage (`ApiError::bad_request`, `ApiError::not_found` — both exist there).

Wiring:
1. `src/api/mod.rs`: add `pub mod deeplink;` with the other module decls, and in `api_router_with_archive_limit` add `.merge(deeplink::router())` after the `.route("/uptime", …)` line.
2. `src/lib.rs` `build_router` (line ~353): after `.merge(api::openapi::router())`, add `.merge(api::deeplink::root_router())`.
3. `tests/support/mod.rs` (line ~155): change the app assembly to
   ```rust
   let app: Router = Router::new()
       .nest("/api/vault", api_router())
       .merge(clepsydra::api::deeplink::root_router())
       .with_state(Arc::clone(&state));
   ```
4. `src/api/openapi.rs`: add `crate::api::deeplink::resolve_url,` to the `paths(…)` list and `crate::api::deeplink::ResolveResponse,` to the `components(schemas(…))` list, following the existing entries' style.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --test api_deeplink_test`
Expected: all 6 tests PASS.
Also run: `cargo test --test api_test` (fixture change must not break existing tests).

- [ ] **Step 6: Commit**

```bash
git add src/api/deeplink.rs src/api/mod.rs src/api/openapi.rs src/lib.rs src/vault/config.rs tests/support/mod.rs tests/api_deeplink_test.rs
git commit -m "feat(api): deep-link resolve endpoint and /deeplink redirect"
```

---

### Task 4: CLI `open-url` subcommand

**Files:**
- Modify: `src/lib.rs:111` (make `Settings::load` public: `fn load` → `pub fn load`)
- Modify: `src/bin/cli.rs` (new variant + arm + tests)

**Interfaces:**
- Consumes: `clepsydra::Settings::load(&Path) -> Result<(Settings, PathBuf), _>`; `settings.server.{host, port, tls.enabled}`; `deeplink::deeplink_http_url` from Task 1.
- Produces: `clepsydra open-url <URL> [--print]` — builds `http(s)://host:port/deeplink?url=<enc>`; `--print` writes it to stdout, otherwise spawns macOS `open` with it. Task 5's applet invokes exactly `<binary> open-url <URL>`.

- [ ] **Step 1: Write the failing tests**

Append to `cli_tests` in `src/bin/cli.rs` (reuse `vault_in_tempdir` / `run_cli_in`):

```rust
    #[tokio::test]
    #[serial_test::serial]
    async fn open_url_print_returns_zero() {
        let (_dir, root) = vault_in_tempdir();
        let cli = Cli::try_parse_from([
            "clepsydra",
            "open-url",
            "clepsydra://page/whatever",
            "--print",
        ])
        .unwrap();
        let result = run_cli_in(&root, cli).await;
        assert_eq!(result.unwrap(), 0);
    }

    #[tokio::test]
    async fn open_url_requires_a_url_argument() {
        assert!(Cli::try_parse_from(["clepsydra", "open-url"]).is_err());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --bin clepsydra open_url`
Expected: FAIL to compile — no `open-url` variant.

- [ ] **Step 3: Implement**

In `src/lib.rs`, change `fn load(` to `pub fn load(` on `Settings::load` (line ~111) and keep the doc comment.

In `src/bin/cli.rs`, add the variant to `Commands`:

```rust
    #[command(
        about = "Open a clepsydra:// or obsidian:// URL in the running server's UI",
        long_about = "Translate a deep-link URL into a local HTTP hit on the server's /deeplink endpoint and open it in the default browser.\n\nThis is the entry point the macOS URL-handler applet (see `register-url`) invokes; it can also be called directly.",
        after_help = "Examples:\n  clepsydra open-url \"clepsydra://page/Alpha%20Project\"\n  clepsydra open-url \"obsidian://open?vault=brain&file=Note\" --print"
    )]
    OpenUrl {
        #[arg(value_name = "URL", help = "The scheme URL to open")]
        url: String,
        #[arg(long, help = "Print the translated HTTP URL instead of opening the browser")]
        print: bool,
    },
```

And the dispatch arm in `run_cli`:

```rust
        Commands::OpenUrl { url, print } => {
            let cwd = std::env::current_dir()?;
            let (settings, _config_path) = clepsydra::Settings::load(&cwd)?;
            let scheme = if settings.server.tls.enabled { "https" } else { "http" };
            let base = format!("{scheme}://{}:{}", settings.server.host, settings.server.port);
            let target = clepsydra::deeplink::deeplink_http_url(&base, &url);
            if print || !cfg!(target_os = "macos") {
                println!("{target}");
            } else {
                std::process::Command::new("open").arg(&target).status()?;
            }
            Ok(0)
        }
```

If `Settings` or its fields aren't already `pub`, make the minimal visibility changes in `src/lib.rs` (struct + `server` field + `ServerSettings` fields are already public per lib.rs:47-58; only `load` needs the change).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --bin clepsydra`
Expected: all cli_tests PASS (including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/bin/cli.rs src/lib.rs
git commit -m "feat(cli): open-url subcommand translating deep links to /deeplink hits"
```

---

### Task 5: CLI `register-url` — macOS handler applet

**Files:**
- Create: `src/macos_url_handler.rs`
- Modify: `src/lib.rs` (add `pub mod macos_url_handler;`)
- Modify: `src/bin/cli.rs` (new variant + arm + parse tests)
- Test: `tests/macos_url_handler_test.rs`

**Interfaces:**
- Consumes: `std::env::current_exe()`; macOS tools `osacompile`, `/usr/libexec/PlistBuddy`, `lsregister`.
- Produces:
  - `pub fn applescript_source(binary: &Path) -> String`
  - `pub fn plistbuddy_commands(include_obsidian: bool) -> Vec<String>`
  - `pub fn install(binary: &Path, include_obsidian: bool) -> Result<PathBuf, Box<dyn std::error::Error>>` — builds `~/Applications/Clepsydra URL Handler.app`, returns its path.
  - CLI: `clepsydra register-url [--obsidian]`.

- [ ] **Step 1: Write the failing tests (pure generators only — no macOS side effects)**

```rust
// tests/macos_url_handler_test.rs
use std::path::Path;

use clepsydra::macos_url_handler::{applescript_source, plistbuddy_commands};

#[test]
fn applescript_invokes_the_binary_with_open_url() {
    let src = applescript_source(Path::new("/usr/local/bin/clepsydra"));
    assert_eq!(
        src,
        "on open location theURL\n\tdo shell script \"\\\"/usr/local/bin/clepsydra\\\" open-url \" & quoted form of theURL\nend open location\n"
    );
}

#[test]
fn plist_commands_register_clepsydra_scheme() {
    let cmds = plistbuddy_commands(false);
    assert!(cmds.iter().any(|c| c == "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string clepsydra"));
    assert!(cmds.iter().all(|c| !c.contains("string obsidian")));
    assert!(cmds.iter().any(|c| c.starts_with("Set :CFBundleIdentifier")));
}

#[test]
fn plist_commands_add_obsidian_scheme_only_when_flagged() {
    let cmds = plistbuddy_commands(true);
    assert!(cmds.iter().any(|c| c == "Add :CFBundleURLTypes:1:CFBundleURLSchemes:0 string obsidian"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --test macos_url_handler_test`
Expected: FAIL to compile — module not found.

- [ ] **Step 3: Implement**

```rust
// src/macos_url_handler.rs
//! Generation and installation of the macOS URL-handler applet.
//!
//! Launch Services only routes custom schemes to an app bundle declaring
//! `CFBundleURLTypes`, and delivers the URL via an Apple Event that a plain
//! CLI binary cannot receive. The smallest bridge is a compiled AppleScript
//! applet whose `open location` handler shells back into `clepsydra open-url`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

const APP_NAME: &str = "Clepsydra URL Handler.app";
const BUNDLE_ID: &str = "md.clepsydra.url-handler";
const LSREGISTER: &str = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/// AppleScript source for the applet. The binary path is embedded inside an
/// AppleScript string literal, so its quotes are escaped for that context;
/// the user-controlled URL goes through `quoted form of` instead.
pub fn applescript_source(binary: &Path) -> String {
    format!(
        "on open location theURL\n\tdo shell script \"\\\"{}\\\" open-url \" & quoted form of theURL\nend open location\n",
        binary.display()
    )
}

/// PlistBuddy commands that declare the URL schemes on the applet's
/// Info.plist. Index 1 (obsidian) exists only when compat is requested.
pub fn plistbuddy_commands(include_obsidian: bool) -> Vec<String> {
    let mut cmds = vec![
        format!("Set :CFBundleIdentifier {BUNDLE_ID}"),
        "Add :CFBundleURLTypes array".to_string(),
        "Add :CFBundleURLTypes:0 dict".to_string(),
        "Add :CFBundleURLTypes:0:CFBundleURLName string Clepsydra deep link".to_string(),
        "Add :CFBundleURLTypes:0:CFBundleURLSchemes array".to_string(),
        "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string clepsydra".to_string(),
    ];
    if include_obsidian {
        cmds.extend([
            "Add :CFBundleURLTypes:1 dict".to_string(),
            "Add :CFBundleURLTypes:1:CFBundleURLName string Obsidian compat link".to_string(),
            "Add :CFBundleURLTypes:1:CFBundleURLSchemes array".to_string(),
            "Add :CFBundleURLTypes:1:CFBundleURLSchemes:0 string obsidian".to_string(),
        ]);
    }
    cmds
}

fn run_checked(mut cmd: Command, what: &str) -> Result<(), Box<dyn std::error::Error>> {
    let status = cmd.status()?;
    if !status.success() {
        return Err(format!("{what} failed with {status}").into());
    }
    Ok(())
}

/// Compile and install the applet into `~/Applications`, replacing any
/// previous installation, then force a Launch Services re-registration.
pub fn install(
    binary: &Path,
    include_obsidian: bool,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let apps = dirs::home_dir()
        .ok_or("cannot determine home directory")?
        .join("Applications");
    std::fs::create_dir_all(&apps)?;
    let app_path = apps.join(APP_NAME);
    if app_path.exists() {
        std::fs::remove_dir_all(&app_path)?;
    }

    let mut script = tempfile::Builder::new().suffix(".applescript").tempfile()?;
    script.write_all(applescript_source(binary).as_bytes())?;
    script.flush()?;

    let mut compile = Command::new("osacompile");
    compile.arg("-o").arg(&app_path).arg(script.path());
    run_checked(compile, "osacompile")?;

    let plist = app_path.join("Contents/Info.plist");
    for cmd in plistbuddy_commands(include_obsidian) {
        let mut pb = Command::new("/usr/libexec/PlistBuddy");
        pb.arg("-c").arg(&cmd).arg(&plist);
        run_checked(pb, "PlistBuddy")?;
    }

    let mut reg = Command::new(LSREGISTER);
    reg.arg("-f").arg(&app_path);
    run_checked(reg, "lsregister")?;

    Ok(app_path)
}
```

Add `pub mod macos_url_handler;` to `src/lib.rs` next to `pub mod deeplink;`.

CLI variant in `src/bin/cli.rs`:

```rust
    #[command(
        about = "Register the clepsydra:// URL scheme with macOS",
        long_about = "Build and install a small URL-handler app at ~/Applications/Clepsydra URL Handler.app that routes clepsydra:// links (and optionally obsidian:// links) to this clepsydra binary via `open-url`.\n\nmacOS only.",
        after_help = "Examples:\n  clepsydra register-url\n  clepsydra register-url --obsidian   # also claim obsidian:// (competes with Obsidian if installed)"
    )]
    RegisterUrl {
        #[arg(long, help = "Also register the obsidian:// scheme (compat mode)")]
        obsidian: bool,
    },
```

Dispatch arm:

```rust
        Commands::RegisterUrl { obsidian } => {
            if !cfg!(target_os = "macos") {
                return Err("register-url is only supported on macOS".into());
            }
            let binary = std::env::current_exe()?;
            let app = clepsydra::macos_url_handler::install(&binary, obsidian)?;
            println!("Installed URL handler at {}", app.display());
            println!("Registered scheme: clepsydra://");
            if obsidian {
                println!("Registered scheme: obsidian:// (note: competes with Obsidian.app if installed)");
            }
            Ok(0)
        }
```

Parse-level test to append to `cli_tests` (no install side effects):

```rust
    #[test]
    fn register_url_parses_with_and_without_obsidian_flag() {
        assert!(Cli::try_parse_from(["clepsydra", "register-url"]).is_ok());
        assert!(Cli::try_parse_from(["clepsydra", "register-url", "--obsidian"]).is_ok());
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --test macos_url_handler_test` then `cargo test --bin clepsydra`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/macos_url_handler.rs src/lib.rs src/bin/cli.rs tests/macos_url_handler_test.rs
git commit -m "feat(cli): register-url installs macOS scheme-handler applet"
```

---

### Task 6: Editor scheme-link handling

**Files:**
- Create: `ui/src/api/deeplink.ts`
- Create: `ui/src/editor/schemeLinks.ts`
- Modify: `ui/src/editor/elements/LinkElement.tsx:26-112`
- Test: `ui/src/editor/__tests__/schemeLinks.test.ts`

**Interfaces:**
- Consumes: `GET /api/vault/resolve?url=…` from Task 3; `useOpenTab()` (`(type: TabType, path?: string, label?: string) => void`); `toast` from `sonner`.
- Produces:
  - `resolveSchemeUrl(url: string): Promise<string | null>` in `ui/src/api/deeplink.ts`
  - `isSchemeLink(url: string): boolean` and `openSchemeLink(url: string, deps: SchemeLinkDeps): Promise<void>` in `ui/src/editor/schemeLinks.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// ui/src/editor/__tests__/schemeLinks.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSchemeUrl } from "#/api/deeplink";
import { isSchemeLink, openSchemeLink } from "#/editor/schemeLinks";

describe("isSchemeLink", () => {
  it("matches clepsydra:// and obsidian:// case-insensitively", () => {
    expect(isSchemeLink("clepsydra://page/x")).toBe(true);
    expect(isSchemeLink("OBSIDIAN://open?vault=v&file=f")).toBe(true);
  });

  it("does not match http, mailto, or vault paths", () => {
    expect(isSchemeLink("https://example.com")).toBe(false);
    expect(isSchemeLink("mailto:kit@example.com")).toBe(false);
    expect(isSchemeLink("projects/note.md")).toBe(false);
  });
});

describe("openSchemeLink", () => {
  it("opens a page tab when the target resolves", async () => {
    const openTab = vi.fn();
    const notify = vi.fn();
    await openSchemeLink("clepsydra://page/x", {
      resolve: async () => "projects/x.md",
      openTab,
      notify,
    });
    expect(openTab).toHaveBeenCalledWith("page", "projects/x.md");
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies on a miss without opening a tab", async () => {
    const openTab = vi.fn();
    const notify = vi.fn();
    await openSchemeLink("clepsydra://page/nope", {
      resolve: async () => null,
      openTab,
      notify,
    });
    expect(openTab).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("No page matches clepsydra://page/nope");
  });

  it("notifies when resolution throws", async () => {
    const notify = vi.fn();
    await openSchemeLink("clepsydra://page/x", {
      resolve: async () => {
        throw new Error("network down");
      },
      openTab: vi.fn(),
      notify,
    });
    expect(notify).toHaveBeenCalledWith("Could not resolve clepsydra://page/x");
  });
});

describe("resolveSchemeUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the path on 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ path: "a/b.md" }), { status: 200 })),
    );
    await expect(resolveSchemeUrl("clepsydra://page/b")).resolves.toBe("a/b.md");
    expect(fetch).toHaveBeenCalledWith(
      `/api/vault/resolve?url=${encodeURIComponent("clepsydra://page/b")}`,
    );
  });

  it("returns null on 404 and throws on 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await expect(resolveSchemeUrl("clepsydra://page/nope")).resolves.toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await expect(resolveSchemeUrl("clepsydra://page/x")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --cwd ui run test src/editor/__tests__/schemeLinks.test.ts` (if `--cwd` filtering misbehaves: `cd ui && bunx vitest run src/editor/__tests__/schemeLinks.test.ts`)
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement**

```typescript
// ui/src/api/deeplink.ts
export interface ResolveResponse {
  path: string;
}

/** Resolve a clepsydra:// or obsidian:// URL to a vault path; null on miss. */
export async function resolveSchemeUrl(url: string): Promise<string | null> {
  const res = await fetch(`/api/vault/resolve?url=${encodeURIComponent(url)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`resolve failed: ${res.status}`);
  const body: ResolveResponse = await res.json();
  return body.path;
}
```

```typescript
// ui/src/editor/schemeLinks.ts
export interface SchemeLinkDeps {
  resolve: (url: string) => Promise<string | null>;
  openTab: (type: "page", path: string) => void;
  notify: (message: string) => void;
}

/** Deep-link URLs the app resolves itself rather than treating as vault paths. */
export function isSchemeLink(url: string): boolean {
  return /^(clepsydra|obsidian):/i.test(url);
}

/** Resolve a scheme link and open it in a tab; misses and errors toast. */
export async function openSchemeLink(
  url: string,
  deps: SchemeLinkDeps,
): Promise<void> {
  try {
    const path = await deps.resolve(url);
    if (path) deps.openTab("page", path);
    else deps.notify(`No page matches ${url}`);
  } catch {
    deps.notify(`Could not resolve ${url}`);
  }
}
```

In `ui/src/editor/elements/LinkElement.tsx`:

```typescript
import { toast } from "sonner";
import { resolveSchemeUrl } from "#/api/deeplink";
import { isSchemeLink, openSchemeLink } from "#/editor/schemeLinks";
```

and change `doOpen` (lines 76-87) to branch before the external/vault-path split:

```typescript
  const doOpen = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      if (isSchemeLink(url)) {
        void openSchemeLink(url, {
          resolve: resolveSchemeUrl,
          openTab: (type, path) => openTab(type, path),
          notify: (message) => toast.error(message),
        });
      } else if (isExternal(url)) {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        openTab("page", url);
      }
      setOpen(false);
    },
    [url, openTab],
  );
```

Also update the comment on `isExternal` (line 26) to:
`/** External links open in the browser; scheme links resolve via the API; everything else is a vault path. */`

`safeHref` (line 112) already yields `undefined` for scheme links since `isExternal` rejects them — no change needed there.

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run: `cd ui && bunx vitest run src/editor/__tests__/schemeLinks.test.ts`
Expected: PASS.
Run: `bun --cwd ui run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/deeplink.ts ui/src/editor/schemeLinks.ts ui/src/editor/elements/LinkElement.tsx ui/src/editor/__tests__/schemeLinks.test.ts
git commit -m "feat(editor): resolve clepsydra:// and obsidian:// links in-app"
```

---

### Task 7: `/link-miss` route

**Files:**
- Create: `ui/src/routes/link-miss.tsx`
- Regenerate: `ui/src/routeTree.gen.ts` (via vite — never by hand)
- Test: `ui/src/routes/__tests__/link-miss.test.tsx`

**Interfaces:**
- Consumes: redirect target produced by Task 3 (`/link-miss?target=<encoded url>`).
- Produces: `LinkMissView({ target }: { target?: string })` exported for tests.

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/routes/__tests__/link-miss.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LinkMissView } from "#/routes/link-miss";

describe("LinkMissView", () => {
  it("shows the unresolved target", () => {
    render(<LinkMissView target="clepsydra://page/nope" />);
    expect(screen.getByText("clepsydra://page/nope")).toBeInTheDocument();
    expect(screen.getByText(/no page matches/i)).toBeInTheDocument();
  });

  it("renders without a target", () => {
    render(<LinkMissView />);
    expect(screen.getByText(/no page matches/i)).toBeInTheDocument();
  });
});
```

Note: `LinkMissView` deliberately renders no `<Link>`/router hooks so it can be tested without a router provider; the workspace escape hatch uses a plain `<a href="/workspace">`, which TanStack Router's browser history handles fine for a full-page entry point like this.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bunx vitest run src/routes/__tests__/link-miss.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the route**

```tsx
// ui/src/routes/link-miss.tsx
import { createFileRoute } from "@tanstack/react-router";

type LinkMissSearch = { target?: string };

export const Route = createFileRoute("/link-miss")({
  validateSearch: (search: Record<string, unknown>): LinkMissSearch => ({
    target: typeof search.target === "string" ? search.target : undefined,
  }),
  component: LinkMissPage,
});

function LinkMissPage() {
  const { target } = Route.useSearch();
  return <LinkMissView target={target} />;
}

export function LinkMissView({ target }: { target?: string }) {
  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center gap-4 p-8">
      <div className="cl-mono text-xs tracking-widest text-muted-foreground">
        DEEP LINK
      </div>
      <h1 className="text-xl font-semibold">No page matches this link</h1>
      {target && (
        <code className="cl-mono max-w-full truncate border border-border bg-muted px-2 py-1 text-sm">
          {target}
        </code>
      )}
      <a
        href="/workspace"
        className="underline decoration-1 underline-offset-2 hover:decoration-2"
      >
        Open workspace
      </a>
    </div>
  );
}
```

Then regenerate the route tree (the TanStack plugin runs during vite, and `bun run build` typechecks *before* vite would regenerate, so regenerate explicitly first):

Run: `cd ui && bunx vite build`
Expected: succeeds and updates `ui/src/routeTree.gen.ts` to include `/link-miss`.

- [ ] **Step 4: Run test + typecheck to verify they pass**

Run: `cd ui && bunx vitest run src/routes/__tests__/link-miss.test.tsx`
Expected: PASS.
Run: `bun --cwd ui run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/routes/link-miss.tsx ui/src/routes/__tests__/link-miss.test.tsx ui/src/routeTree.gen.ts
git commit -m "feat(ui): link-miss landing page for unresolved deep links"
```

---

### Task 8: Verification gates

- [ ] **Step 1: Rust gates**

Run each; all must pass cleanly:
```
cargo fmt --check
cargo clippy --all-targets
cargo test
```

- [ ] **Step 2: Frontend gates**

```
bun --cwd ui run typecheck
bun --cwd ui run lint
bun --cwd ui run test
```

- [ ] **Step 3: Fix anything the gates surface, re-run until green, then commit any fixes**

```bash
git add -A
git commit -m "chore: satisfy verification gates for deep-link feature"
```
(Skip the commit if the gates passed with no changes.)

- [ ] **Step 4: Manual smoke check (operator machine, optional but recommended)**

```
cargo run -- register-url --obsidian
open "clepsydra://page/<some real page title>"
```
Expected: browser opens the workspace with the page tab active.
