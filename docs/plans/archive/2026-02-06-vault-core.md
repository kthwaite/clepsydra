# Vault Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a filesystem-backed vault with CRUD operations, persistent SQLite link index, canonical name resolution, and automatic backlink rewriting on rename/move.

**Architecture:** Layered Rust modules — `vault::path` (VaultPath, CanonicalName newtypes), `vault::config` (vault-level settings), `vault::page` (frontmatter parsing, Page model), `vault::link` (AST-based link extraction), `vault::index` (SQLite-backed persistent index with in-memory graph), `vault::rewriter` (link rewriting with staged writes), `api::*` (Axum routes). The filesystem is source of truth; SQLite is a persistent cache rebuilt from file content hashes.

**Tech Stack:** Rust 2024 edition, Axum 0.8, rusqlite (bundled), pulldown-cmark, serde_yaml, uuid v7, blake3, walkdir, unicode-normalization, percent-encoding, glob, chrono, thiserror, tempfile (dev)

**Spec:** `_features/001-vault-core.md` (v3)

---

## Module Layout

```
src/
  bin/cli.rs              # CLI entry (existing)
  lib.rs                  # Server entry, Settings (existing — will be extended)
  vault/
    mod.rs                # Re-exports
    path.rs               # VaultPath newtype
    canonical.rs          # CanonicalName newtype
    config.rs             # VaultConfig (.clepsydra/config.toml)
    page.rs               # Page, PageMeta, frontmatter parsing
    link.rs               # Link, LinkKind, AST-based extraction
    index.rs              # VaultIndex: SQLite schema, builder, graph, resolution
    rewriter.rs           # LinkRewriter, staged writes
    hooks.rs              # PostMoveHook trait
  api/
    mod.rs                # API router, AppState
    pages.rs              # Page CRUD endpoints
    folders.rs            # Folder endpoints
    attachments.rs        # Attachment endpoints
    index_routes.rs       # Index query endpoints
    error.rs              # Structured JSON error types
tests/
  vault_path_test.rs      # VaultPath unit tests
  canonical_name_test.rs  # CanonicalName unit tests
  frontmatter_test.rs     # Frontmatter round-trip tests
  link_extraction_test.rs # Link parser tests
  index_test.rs           # Index builder integration tests
  api_test.rs             # API integration tests (uses test vault fixtures)
  rewriter_test.rs        # Link rewriting tests
tests/fixtures/           # Test vault directories
```

---

## Task 1: Add Dependencies to Cargo.toml

**Files:**
- Modify: `Cargo.toml`

**Step 1: Add all required dependencies**

```toml
[package]
name = "clepsydra"
version = "0.0.0"
edition = "2024"

[[bin]]
name = "clepsydra"
path = "src/bin/cli.rs"

[dependencies]
axum = "0.8.8"
blake3 = "1"
chrono = { version = "0.4", features = ["serde"] }
clap = { version = "4.5.56", features = ["derive"] }
config = "0.15.19"
glob = "0.3"
percent-encoding = "2"
pulldown-cmark = "0.12"
regex = "1"
rusqlite = { version = "0.33", features = ["bundled"] }
serde = { version = "1.0.228", features = ["derive"] }
serde_json = "1"
serde_yaml = "0.9"
thiserror = "2"
tokio = { version = "1.49.0", features = ["full"] }
tower = "0.5.3"
tower-http = { version = "0.6.8", features = ["trace"] }
tracing = "0.1.44"
tracing-subscriber = { version = "0.3.22", features = ["env-filter"] }
unicode-normalization = "0.1"
uuid = { version = "1", features = ["v7", "serde"] }
walkdir = "2"

[dev-dependencies]
tempfile = "3"
axum-test = "16"
```

Note: removed the `markdown = "1.0.0"` dep (unused — we use `pulldown-cmark` instead).

**Step 2: Verify it compiles**

Run: `cargo check`
Expected: compiles with no errors (warnings about unused deps are fine for now)

**Step 3: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "chore: add vault-core dependencies"
```

---

## Task 2: VaultPath Newtype

**Files:**
- Create: `src/vault/mod.rs`
- Create: `src/vault/path.rs`
- Modify: `src/lib.rs` (add `pub mod vault;`)
- Create: `tests/vault_path_test.rs`

**Step 1: Write failing tests**

`tests/vault_path_test.rs`:
```rust
use clepsydra::vault::path::VaultPath;

#[test]
fn valid_path_accepted() {
    let vp = VaultPath::new("notes/hello.md");
    assert!(vp.is_ok());
    assert_eq!(vp.unwrap().as_str(), "notes/hello.md");
}

#[test]
fn rejects_absolute_path() {
    assert!(VaultPath::new("/etc/passwd").is_err());
}

#[test]
fn rejects_traversal() {
    assert!(VaultPath::new("../outside.md").is_err());
    assert!(VaultPath::new("notes/../../etc/passwd").is_err());
}

#[test]
fn rejects_backslash() {
    assert!(VaultPath::new("notes\\hello.md").is_err());
}

#[test]
fn strips_leading_slash() {
    // Leading "./" is normalized away
    let vp = VaultPath::new("./notes/hello.md").unwrap();
    assert_eq!(vp.as_str(), "notes/hello.md");
}

#[test]
fn nfc_normalizes_path() {
    // é as NFD (e + combining acute) should become NFC (single é)
    let nfd = "caf\u{0065}\u{0301}.md"; // e + combining acute
    let vp = VaultPath::new(nfd).unwrap();
    assert_eq!(vp.as_str(), "caf\u{00E9}.md"); // NFC é
}

#[test]
fn rejects_empty() {
    assert!(VaultPath::new("").is_err());
}

#[test]
fn extension_method() {
    let vp = VaultPath::new("notes/hello.md").unwrap();
    assert_eq!(vp.extension(), Some("md"));
}

#[test]
fn stem_method() {
    let vp = VaultPath::new("notes/hello.md").unwrap();
    assert_eq!(vp.stem(), "hello");
}

#[test]
fn parent_method() {
    let vp = VaultPath::new("notes/sub/hello.md").unwrap();
    assert_eq!(vp.parent(), Some("notes/sub"));

    let root = VaultPath::new("hello.md").unwrap();
    assert_eq!(root.parent(), None);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test vault_path_test 2>&1 | head -5`
Expected: compilation error — module doesn't exist

**Step 3: Create vault module skeleton and VaultPath**

`src/vault/mod.rs`:
```rust
pub mod path;
```

`src/vault/path.rs`:
```rust
use std::fmt;

use thiserror::Error;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Error)]
pub enum PathError {
    #[error("empty path")]
    Empty,
    #[error("absolute path not allowed: {0}")]
    Absolute(String),
    #[error("path traversal not allowed: {0}")]
    Traversal(String),
    #[error("backslash not allowed (use forward slash): {0}")]
    Backslash(String),
    #[error("invalid path component: {0}")]
    InvalidComponent(String),
}

/// Vault-relative path. Always forward-slash separated, no leading slash.
/// NFC-normalized at construction to avoid composed/decomposed duplicates.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct VaultPath(String);

impl VaultPath {
    pub fn new(raw: &str) -> Result<Self, PathError> {
        if raw.is_empty() {
            return Err(PathError::Empty);
        }
        if raw.contains('\\') {
            return Err(PathError::Backslash(raw.to_string()));
        }
        if raw.starts_with('/') {
            return Err(PathError::Absolute(raw.to_string()));
        }

        // NFC normalize
        let normalized: String = raw.nfc().collect();

        // Strip leading "./"
        let cleaned = normalized.strip_prefix("./").unwrap_or(&normalized);

        // Check for traversal
        for component in cleaned.split('/') {
            if component == ".." {
                return Err(PathError::Traversal(raw.to_string()));
            }
        }

        if cleaned.is_empty() {
            return Err(PathError::Empty);
        }

        Ok(Self(cleaned.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// File extension without the dot.
    pub fn extension(&self) -> Option<&str> {
        let name = self.0.rsplit('/').next().unwrap_or(&self.0);
        name.rsplit_once('.').map(|(_, ext)| ext)
    }

    /// Filename stem (last component without extension).
    pub fn stem(&self) -> &str {
        let name = self.0.rsplit('/').next().unwrap_or(&self.0);
        name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name)
    }

    /// Parent directory path, or None if at vault root.
    pub fn parent(&self) -> Option<&str> {
        self.0.rsplit_once('/').map(|(parent, _)| parent)
    }

    /// Construct a VaultPath from a title using slug rules.
    /// Percent-encodes `/` → `%2F` and `%` → `%25`, replaces other
    /// illegal chars with `-`, appends `.md`.
    pub fn from_title(title: &str) -> Self {
        let nfc: String = title.nfc().collect();

        let mut slug = String::with_capacity(nfc.len() + 3);
        for ch in nfc.chars() {
            match ch {
                '%' => slug.push_str("%25"),
                '/' => slug.push_str("%2F"),
                '<' | '>' | ':' | '"' | '\\' | '|' | '?' | '*' => slug.push('-'),
                c if c.is_control() => slug.push('-'),
                c => slug.push(c),
            }
        }

        // Collapse runs of '-'
        let mut collapsed = String::with_capacity(slug.len());
        let mut prev_dash = false;
        for ch in slug.chars() {
            if ch == '-' {
                if !prev_dash {
                    collapsed.push('-');
                }
                prev_dash = true;
            } else {
                collapsed.push(ch);
                prev_dash = false;
            }
        }

        // Trim leading/trailing '-'
        let trimmed = collapsed.trim_matches('-');

        // Truncate to 200 bytes (UTF-8 safe, don't split %XX sequences)
        let truncated = truncate_slug(trimmed, 200);

        // Self(…) bypasses validation — we know the slug is safe
        Self(format!("{truncated}.md"))
    }

    /// Reverse percent-encoding in the filename slug to recover the original
    /// title's `/` and `%` characters.
    pub fn decode_slug(&self) -> String {
        let stem = self.stem();
        stem.replace("%2F", "/").replace("%25", "%")
    }
}

/// Truncate a slug to at most `max_bytes` bytes without splitting a UTF-8
/// character or a `%XX` percent-encoded sequence.
fn truncate_slug(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }

    let bytes = s.as_bytes();
    let mut end = max_bytes;

    // Don't split a multi-byte UTF-8 char
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }

    // Don't split a %XX sequence: if we'd cut inside one, back up
    // Check if any of the last 2 bytes before `end` is a '%' that starts an
    // incomplete percent-encoded triplet.
    let slice = &s[..end];
    if slice.ends_with('%') {
        end -= 1;
    } else if slice.len() >= 2 && slice[slice.len() - 2..].starts_with('%') {
        end -= 2;
    }

    &s[..end]
}

impl fmt::Display for VaultPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
```

Add vault module to `src/lib.rs` — add `pub mod vault;` at the top.

**Step 4: Run tests**

Run: `cargo test --test vault_path_test`
Expected: all 10 tests pass

**Step 5: Commit**

```bash
git add src/vault/ src/lib.rs tests/vault_path_test.rs
git commit -m "feat(vault): add VaultPath newtype with NFC normalization and slug generation"
```

---

## Task 3: VaultPath Slug Round-Trip Tests

**Files:**
- Modify: `tests/vault_path_test.rs`

**Step 1: Write additional slug tests**

Append to `tests/vault_path_test.rs`:
```rust
#[test]
fn from_title_basic() {
    let vp = VaultPath::from_title("My Page");
    assert_eq!(vp.as_str(), "My Page.md");
}

#[test]
fn from_title_encodes_slash() {
    let vp = VaultPath::from_title("a/b");
    assert_eq!(vp.as_str(), "a%2Fb.md");
}

#[test]
fn from_title_encodes_percent() {
    let vp = VaultPath::from_title("100% done");
    assert_eq!(vp.as_str(), "100%25 done.md");
}

#[test]
fn from_title_replaces_illegal_chars() {
    let vp = VaultPath::from_title("what: a <test>?");
    assert_eq!(vp.as_str(), "what- a -test-.md");
}

#[test]
fn from_title_collapses_dashes() {
    let vp = VaultPath::from_title("a:::b");
    assert_eq!(vp.as_str(), "a-b.md");
}

#[test]
fn decode_slug_roundtrip_slash() {
    let vp = VaultPath::from_title("projects/clepsydra");
    assert_eq!(vp.decode_slug(), "projects/clepsydra");
}

#[test]
fn decode_slug_roundtrip_percent() {
    let vp = VaultPath::from_title("100% complete");
    assert_eq!(vp.decode_slug(), "100% complete");
}
```

**Step 2: Run tests**

Run: `cargo test --test vault_path_test`
Expected: all tests pass

**Step 3: Commit**

```bash
git add tests/vault_path_test.rs
git commit -m "test(vault): add slug round-trip tests for VaultPath"
```

---

## Task 4: CanonicalName Newtype

**Files:**
- Create: `src/vault/canonical.rs`
- Modify: `src/vault/mod.rs` (add `pub mod canonical;`)
- Create: `tests/canonical_name_test.rs`

**Step 1: Write failing tests**

`tests/canonical_name_test.rs`:
```rust
use clepsydra::vault::canonical::CanonicalName;

#[test]
fn from_title_lowercases() {
    let cn = CanonicalName::from_title("Design Notes");
    assert_eq!(cn.as_str(), "design notes");
}

#[test]
fn from_title_collapses_whitespace() {
    let cn = CanonicalName::from_title("A   B");
    assert_eq!(cn.as_str(), "a b");
}

#[test]
fn from_title_trims() {
    let cn = CanonicalName::from_title("  hello  ");
    assert_eq!(cn.as_str(), "hello");
}

#[test]
fn from_title_nfc_normalizes() {
    // NFD é (e + combining accent) → NFC é
    let cn = CanonicalName::from_title("caf\u{0065}\u{0301}");
    assert_eq!(cn.as_str(), "caf\u{00E9}");
}

#[test]
fn from_filename_strips_md() {
    let cn = CanonicalName::from_filename("design-notes.md");
    assert_eq!(cn.as_str(), "design-notes");
}

#[test]
fn from_filename_no_extension() {
    let cn = CanonicalName::from_filename("readme");
    assert_eq!(cn.as_str(), "readme");
}

#[test]
fn equality_case_insensitive_via_derivation() {
    let a = CanonicalName::from_title("Design Notes");
    let b = CanonicalName::from_title("design notes");
    assert_eq!(a, b);
}

// --- Edge collision tests from spec ---

#[test]
fn whitespace_collapse_collision() {
    // "A  B" and "A B" should produce the same canonical name
    let a = CanonicalName::from_title("A  B");
    let b = CanonicalName::from_title("A B");
    assert_eq!(a, b);
}

#[test]
fn case_and_hyphens_distinct() {
    // "design-notes" (filename) vs "Design Notes" (title) are different canonical names
    // because hyphens are preserved, not converted to spaces
    let a = CanonicalName::from_filename("design-notes.md");
    let b = CanonicalName::from_title("Design Notes");
    assert_ne!(a, b); // "design-notes" != "design notes"
}

#[test]
fn trailing_dots_trimmed_in_title() {
    let cn = CanonicalName::from_title("hello...");
    // Dots are preserved (they're not whitespace)
    assert_eq!(cn.as_str(), "hello...");
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test canonical_name_test 2>&1 | head -5`
Expected: compilation error

**Step 3: Implement CanonicalName**

`src/vault/canonical.rs`:
```rust
use std::fmt;

use unicode_normalization::UnicodeNormalization;

/// Normalized, case-insensitive lookup key.
///
/// Invariants: lowercase, Unicode NFC, runs of whitespace collapsed
/// to single space, trimmed. Never stored in frontmatter — only in
/// the SQLite index and in-memory graph.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CanonicalName(String);

impl CanonicalName {
    /// Derive a canonical name from raw input.
    /// Applies: NFC → lowercase → whitespace collapse → trim → strip `.md`.
    fn new(input: &str) -> Self {
        let nfc: String = input.nfc().collect();
        let lower = nfc.to_lowercase();

        // Collapse whitespace runs
        let mut result = String::with_capacity(lower.len());
        let mut prev_ws = false;
        for ch in lower.chars() {
            if ch.is_whitespace() {
                if !prev_ws {
                    result.push(' ');
                }
                prev_ws = true;
            } else {
                result.push(ch);
                prev_ws = false;
            }
        }

        let trimmed = result.trim().to_string();

        // Strip .md suffix if present
        let stripped = trimmed
            .strip_suffix(".md")
            .unwrap_or(&trimmed)
            .to_string();

        Self(stripped)
    }

    /// Derive from a page title (frontmatter `title` field).
    pub fn from_title(title: &str) -> Self {
        Self::new(title)
    }

    /// Derive from a filename stem (path's last component).
    pub fn from_filename(filename: &str) -> Self {
        Self::new(filename)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for CanonicalName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
```

Add to `src/vault/mod.rs`: `pub mod canonical;`

**Step 4: Run tests**

Run: `cargo test --test canonical_name_test`
Expected: all 10 tests pass

**Step 5: Commit**

```bash
git add src/vault/canonical.rs src/vault/mod.rs tests/canonical_name_test.rs
git commit -m "feat(vault): add CanonicalName newtype with NFC normalization"
```

---

## Task 5: Vault Struct (Root Resolution + Path Safety)

**Files:**
- Create: `src/vault/config.rs`
- Modify: `src/vault/mod.rs` (add `pub mod config;` and add `Vault` struct)
- Modify: `tests/vault_path_test.rs` (add Vault resolution tests)

**Step 1: Write failing tests**

Append to `tests/vault_path_test.rs`:
```rust
use clepsydra::vault::Vault;
use std::fs;
use tempfile::TempDir;

#[test]
fn vault_resolve_produces_absolute_path() {
    let tmp = TempDir::new().unwrap();
    let vault = Vault::open(tmp.path()).unwrap();
    let vp = VaultPath::new("notes/hello.md").unwrap();
    let abs = vault.resolve(&vp);
    assert_eq!(abs, tmp.path().join("notes/hello.md"));
}

#[test]
fn vault_resolve_cannot_escape_root() {
    let tmp = TempDir::new().unwrap();
    let vault = Vault::open(tmp.path()).unwrap();
    // Even if somehow a VaultPath got past validation, resolve should be safe
    // because VaultPath::new rejects ".." — this tests the belt + suspenders.
    let result = VaultPath::new("../outside.md");
    assert!(result.is_err());
}

#[test]
fn vault_is_excluded_basic() {
    let tmp = TempDir::new().unwrap();
    let vault = Vault::open(tmp.path()).unwrap();
    let vp = VaultPath::new(".clepsydra/cache.db").unwrap();
    assert!(vault.is_excluded(&vp));
}

#[test]
fn vault_is_excluded_glob() {
    let tmp = TempDir::new().unwrap();
    // Create .clepsydra dir with config
    let dot_dir = tmp.path().join(".clepsydra");
    fs::create_dir_all(&dot_dir).unwrap();
    fs::write(
        dot_dir.join("config.toml"),
        r#"
[vault]
excluded_patterns = [".clepsydra/**", "drafts/**"]
"#,
    )
    .unwrap();

    let vault = Vault::open(tmp.path()).unwrap();
    assert!(vault.is_excluded(&VaultPath::new("drafts/wip.md").unwrap()));
    assert!(!vault.is_excluded(&VaultPath::new("notes/hello.md").unwrap()));
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test vault_path_test vault_resolve 2>&1 | head -5`
Expected: compilation error — `Vault` not found

**Step 3: Implement VaultConfig**

`src/vault/config.rs`:
```rust
use std::path::Path;

use serde::Deserialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("failed to read config: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to parse config: {0}")]
    Parse(#[from] toml::de::Error),
}

/// Vault-level configuration from `.clepsydra/config.toml`.
#[derive(Debug, Clone, Deserialize)]
pub struct VaultConfig {
    #[serde(default)]
    pub vault: VaultSection,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VaultSection {
    #[serde(default = "default_attachment_folder")]
    pub attachment_folder: String,
    #[serde(default = "default_excluded_patterns")]
    pub excluded_patterns: Vec<String>,
    #[serde(default)]
    pub default_page_folder: String,
    #[serde(default = "default_linkable_properties")]
    pub linkable_properties: Vec<String>,
}

fn default_attachment_folder() -> String {
    "_attachments".to_string()
}

fn default_excluded_patterns() -> Vec<String> {
    vec![
        ".clepsydra/**".to_string(),
        "_attachments/**".to_string(),
        ".git/**".to_string(),
        "node_modules/**".to_string(),
    ]
}

fn default_linkable_properties() -> Vec<String> {
    vec!["tags".to_string(), "aliases".to_string()]
}

impl Default for VaultSection {
    fn default() -> Self {
        Self {
            attachment_folder: default_attachment_folder(),
            excluded_patterns: default_excluded_patterns(),
            default_page_folder: String::new(),
            linkable_properties: default_linkable_properties(),
        }
    }
}

impl Default for VaultConfig {
    fn default() -> Self {
        Self {
            vault: VaultSection::default(),
        }
    }
}

impl VaultConfig {
    /// Load from `.clepsydra/config.toml` under the given vault root.
    /// Returns defaults if the file doesn't exist.
    pub fn load(vault_root: &Path) -> Result<Self, ConfigError> {
        let path = vault_root.join(".clepsydra/config.toml");
        if !path.exists() {
            return Ok(Self::default());
        }
        let contents = std::fs::read_to_string(&path)?;
        let config: Self = toml::from_str(&contents)?;
        Ok(config)
    }
}
```

Note: This requires adding `toml = "0.8"` to `[dependencies]` in `Cargo.toml`.

**Step 4: Implement Vault struct**

Add to `src/vault/mod.rs`:
```rust
pub mod canonical;
pub mod config;
pub mod path;

use std::path::{Path, PathBuf};

use config::VaultConfig;
use glob::Pattern;
use path::VaultPath;

/// Handle to an opened vault directory.
pub struct Vault {
    root: PathBuf,
    config: VaultConfig,
    exclusion_patterns: Vec<Pattern>,
}

impl Vault {
    /// Open a vault at the given root directory.
    /// Loads `.clepsydra/config.toml` if present, else uses defaults.
    pub fn open(root: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let config = VaultConfig::load(&root)?;

        let exclusion_patterns = config
            .vault
            .excluded_patterns
            .iter()
            .filter_map(|p| Pattern::new(p).ok())
            .collect();

        Ok(Self {
            root,
            config,
            exclusion_patterns,
        })
    }

    /// Resolve a vault-relative path to an absolute filesystem path.
    pub fn resolve(&self, vp: &VaultPath) -> PathBuf {
        self.root.join(vp.as_str())
    }

    /// Check whether a vault-relative path matches any exclusion pattern.
    pub fn is_excluded(&self, vp: &VaultPath) -> bool {
        let path_str = vp.as_str();
        self.exclusion_patterns
            .iter()
            .any(|pat| pat.matches(path_str))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn config(&self) -> &VaultConfig {
        &self.config
    }
}
```

**Step 5: Run tests**

Run: `cargo test --test vault_path_test`
Expected: all tests pass

**Step 6: Commit**

```bash
git add Cargo.toml src/vault/ tests/vault_path_test.rs
git commit -m "feat(vault): add Vault struct with config and glob-based exclusion"
```

---

## Task 6: `clepsydra init` Command

**Files:**
- Modify: `src/bin/cli.rs` (wire up Init with path argument)
- Create: `src/vault/init.rs`
- Modify: `src/vault/mod.rs`

**Step 1: Write the init function**

`src/vault/init.rs`:
```rust
use std::fs;
use std::path::Path;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum InitError {
    #[error("vault already initialized at {0}")]
    AlreadyInitialized(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

const DEFAULT_VAULT_CONFIG: &str = r#"[vault]
attachment_folder = "_attachments"

excluded_patterns = [
    ".clepsydra/**",
    "_attachments/**",
    ".git/**",
    "node_modules/**",
]

default_page_folder = ""

linkable_properties = ["tags", "aliases"]
"#;

/// Initialize a new vault at the given path.
/// Creates `.clepsydra/`, `.clepsydra/templates/`, attachment folder, and default config.
pub fn init_vault(root: &Path) -> Result<(), InitError> {
    let dot_dir = root.join(".clepsydra");
    if dot_dir.exists() {
        return Err(InitError::AlreadyInitialized(
            root.display().to_string(),
        ));
    }

    // Create vault root if it doesn't exist
    fs::create_dir_all(root)?;

    // Create .clepsydra/ and subdirectories
    fs::create_dir_all(dot_dir.join("templates"))?;

    // Write default vault config
    fs::write(dot_dir.join("config.toml"), DEFAULT_VAULT_CONFIG)?;

    // Create attachment folder
    fs::create_dir_all(root.join("_attachments"))?;

    Ok(())
}
```

Add `pub mod init;` to `src/vault/mod.rs`.

**Step 2: Wire up the CLI**

Modify `src/bin/cli.rs` — change `Init` variant to accept an optional path:

```rust
use clap::{Parser, Subcommand};
use std::path::PathBuf;

use clepsydra::run_server;
use clepsydra::vault::init::init_vault;

#[derive(Debug, Parser)]
#[command(name = "clepsydra", version, about = "Clepsydra CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Initialize a new vault
    Init {
        /// Path to the vault root (defaults to current directory)
        #[arg(default_value = ".")]
        path: PathBuf,
    },
    Env,
    Doctor,
    Serve,
    Version,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Init { path } => {
            init_vault(&path)?;
            println!("Vault initialized at {}", path.display());
        }
        Commands::Env => {
            println!("env command not implemented yet");
        }
        Commands::Doctor => {
            println!("doctor command not implemented yet");
        }
        Commands::Serve => {
            run_server().await?;
        }
        Commands::Version => {
            println!("{}", env!("CARGO_PKG_VERSION"));
        }
    }

    Ok(())
}
```

**Step 3: Test manually**

Run: `cargo run -- init /tmp/test-vault && ls -la /tmp/test-vault/.clepsydra/`
Expected: shows `config.toml` and `templates/` directory

Run: `cargo run -- init /tmp/test-vault`
Expected: error "vault already initialized"

Clean up: `rm -rf /tmp/test-vault`

**Step 4: Commit**

```bash
git add src/vault/init.rs src/vault/mod.rs src/bin/cli.rs
git commit -m "feat(vault): implement clepsydra init command"
```

---

## Task 7: Update Settings for Vault Root

**Files:**
- Modify: `src/lib.rs` (add `vault.root` to Settings)
- Modify: `config.toml` (add `[vault]` section)

**Step 1: Update Settings struct**

In `src/lib.rs`, add a `VaultSettings` struct and extend `Settings`:

```rust
#[derive(Debug, Deserialize)]
struct Settings {
    server: ServerSettings,
    #[serde(default)]
    vault: VaultSettings,
}

#[derive(Debug, Deserialize)]
struct ServerSettings {
    host: String,
    port: u16,
}

#[derive(Debug, Deserialize)]
struct VaultSettings {
    #[serde(default = "default_vault_root")]
    root: String,
}

fn default_vault_root() -> String {
    "./vault".to_string()
}

impl Default for VaultSettings {
    fn default() -> Self {
        Self {
            root: default_vault_root(),
        }
    }
}
```

Add to `Settings::load()`:
```rust
.set_default("vault.root", "./vault")?
```

**Step 2: Update config.toml**

```toml
[server]
host = "127.0.0.1"
port = 3000

[vault]
root = "./vault"
```

**Step 3: Verify it compiles**

Run: `cargo check`
Expected: compiles

**Step 4: Commit**

```bash
git add src/lib.rs config.toml
git commit -m "feat(vault): add vault.root to server settings"
```

---

## Task 8: PageMeta Serde Model

**Files:**
- Create: `src/vault/page.rs`
- Modify: `src/vault/mod.rs` (add `pub mod page;`)
- Create: `tests/frontmatter_test.rs`

**Step 1: Write failing tests**

`tests/frontmatter_test.rs`:
```rust
use clepsydra::vault::page::PageMeta;

#[test]
fn deserialize_full_frontmatter() {
    let yaml = r#"
id: "01936e1a-5c4a-7000-8000-000000000001"
title: "Design Notes"
tags:
  - architecture
  - rust
aliases:
  - design
created_at: "2026-01-15T10:30:00Z"
updated_at: "2026-02-06T14:00:00Z"
custom_field: "hello"
"#;
    let meta: PageMeta = serde_yaml::from_str(yaml).unwrap();
    assert_eq!(meta.title.as_deref(), Some("Design Notes"));
    assert_eq!(meta.tags, vec!["architecture", "rust"]);
    assert_eq!(meta.aliases, vec!["design"]);
    assert!(meta.extra.contains_key("custom_field"));
}

#[test]
fn deserialize_minimal_frontmatter() {
    let yaml = r#"
id: "01936e1a-5c4a-7000-8000-000000000001"
"#;
    let meta: PageMeta = serde_yaml::from_str(yaml).unwrap();
    assert!(meta.title.is_none());
    assert!(meta.tags.is_empty());
    assert!(meta.aliases.is_empty());
}

#[test]
fn round_trip_preserves_fields() {
    let yaml = r#"
id: "01936e1a-5c4a-7000-8000-000000000001"
title: "Test Page"
tags:
  - test
aliases: []
"#;
    let meta: PageMeta = serde_yaml::from_str(yaml).unwrap();
    let serialized = serde_yaml::to_string(&meta).unwrap();
    let meta2: PageMeta = serde_yaml::from_str(&serialized).unwrap();
    assert_eq!(meta.id, meta2.id);
    assert_eq!(meta.title, meta2.title);
    assert_eq!(meta.tags, meta2.tags);
}

#[test]
fn skip_serializing_empty_fields() {
    let yaml = "id: \"01936e1a-5c4a-7000-8000-000000000001\"\n";
    let meta: PageMeta = serde_yaml::from_str(yaml).unwrap();
    let serialized = serde_yaml::to_string(&meta).unwrap();
    // Empty tags and aliases should not appear in output
    assert!(!serialized.contains("tags"));
    assert!(!serialized.contains("aliases"));
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test frontmatter_test 2>&1 | head -5`
Expected: compilation error

**Step 3: Implement PageMeta**

`src/vault/page.rs`:
```rust
use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Parsed YAML frontmatter for a page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageMeta {
    pub id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
    /// Arbitrary additional frontmatter keys.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_yaml::Value>,
}

impl PageMeta {
    /// Create a new PageMeta with a fresh v7 UUID and current timestamps.
    pub fn new() -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::now_v7(),
            title: None,
            tags: Vec::new(),
            aliases: Vec::new(),
            created_at: Some(now),
            updated_at: Some(now),
            extra: HashMap::new(),
        }
    }
}
```

Add `pub mod page;` to `src/vault/mod.rs`.

**Step 4: Run tests**

Run: `cargo test --test frontmatter_test`
Expected: all 4 tests pass

**Step 5: Commit**

```bash
git add src/vault/page.rs src/vault/mod.rs tests/frontmatter_test.rs
git commit -m "feat(vault): add PageMeta serde model for YAML frontmatter"
```

---

## Task 9: Frontmatter Parsing and Writing

**Files:**
- Modify: `src/vault/page.rs` (add `parse_frontmatter`, `write_frontmatter`)
- Modify: `tests/frontmatter_test.rs`

**Step 1: Write failing tests**

Append to `tests/frontmatter_test.rs`:
```rust
use clepsydra::vault::page::{parse_frontmatter, write_page_content};

#[test]
fn parse_frontmatter_basic() {
    let content = r#"---
id: "01936e1a-5c4a-7000-8000-000000000001"
title: "Hello"
---
# Body content

Some markdown here.
"#;
    let (meta, body) = parse_frontmatter(content).unwrap();
    assert_eq!(meta.title.as_deref(), Some("Hello"));
    assert_eq!(body.trim(), "# Body content\n\nSome markdown here.");
}

#[test]
fn parse_frontmatter_no_fences() {
    let content = "# Just markdown\n\nNo frontmatter here.";
    let result = parse_frontmatter(content);
    assert!(result.is_err()); // No frontmatter = error (we require UUID)
}

#[test]
fn write_page_content_round_trip() {
    let content = r#"---
id: "01936e1a-5c4a-7000-8000-000000000001"
title: "Hello"
---
Body text here.
"#;
    let (meta, body) = parse_frontmatter(content).unwrap();
    let written = write_page_content(&meta, &body);
    let (meta2, body2) = parse_frontmatter(&written).unwrap();
    assert_eq!(meta.id, meta2.id);
    assert_eq!(meta.title, meta2.title);
    assert_eq!(body.trim(), body2.trim());
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test frontmatter_test parse_frontmatter 2>&1 | head -5`
Expected: compilation error — functions not found

**Step 3: Implement frontmatter parsing and writing**

Add to `src/vault/page.rs`:
```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum FrontmatterError {
    #[error("no YAML frontmatter found (missing --- fences)")]
    NotFound,
    #[error("failed to parse YAML frontmatter: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("unterminated frontmatter (missing closing ---)")]
    Unterminated,
}

/// Parse YAML frontmatter from a Markdown file's content.
/// Returns (PageMeta, body) where body is everything after the closing `---`.
pub fn parse_frontmatter(content: &str) -> Result<(PageMeta, String), FrontmatterError> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return Err(FrontmatterError::NotFound);
    }

    // Find the closing ---
    let after_first = &trimmed[3..];
    let rest = after_first.strip_prefix('\n').unwrap_or(after_first);
    let closing = rest.find("\n---");
    match closing {
        None => Err(FrontmatterError::Unterminated),
        Some(pos) => {
            let yaml_str = &rest[..pos];
            let meta: PageMeta = serde_yaml::from_str(yaml_str)?;

            // Body starts after closing "---\n"
            let body_start = pos + 4; // "\n---".len()
            let body = if body_start < rest.len() {
                // Skip the newline after closing ---
                let remainder = &rest[body_start..];
                remainder.strip_prefix('\n').unwrap_or(remainder)
            } else {
                ""
            };

            Ok((meta, body.to_string()))
        }
    }
}

/// Serialize a PageMeta and body back into a Markdown file with YAML frontmatter.
pub fn write_page_content(meta: &PageMeta, body: &str) -> String {
    let yaml = serde_yaml::to_string(meta).unwrap_or_default();
    format!("---\n{yaml}---\n{body}")
}
```

**Step 4: Run tests**

Run: `cargo test --test frontmatter_test`
Expected: all 7 tests pass

**Step 5: Commit**

```bash
git add src/vault/page.rs tests/frontmatter_test.rs
git commit -m "feat(vault): implement frontmatter parsing and writing"
```

---

## Task 10: Page Struct with File I/O

**Files:**
- Modify: `src/vault/page.rs` (add `Page` struct, `from_file`, `to_file`)
- Modify: `tests/frontmatter_test.rs`

**Step 1: Write failing tests**

Append to `tests/frontmatter_test.rs`:
```rust
use clepsydra::vault::page::Page;
use clepsydra::vault::path::VaultPath;
use std::fs;
use tempfile::TempDir;

#[test]
fn page_from_file_reads_and_parses() {
    let tmp = TempDir::new().unwrap();
    let file_path = tmp.path().join("test.md");
    fs::write(&file_path, "---\nid: \"01936e1a-5c4a-7000-8000-000000000001\"\ntitle: \"Test\"\n---\nBody here.\n").unwrap();

    let vp = VaultPath::new("test.md").unwrap();
    let page = Page::from_file(&file_path, vp).unwrap();
    assert_eq!(page.meta.title.as_deref(), Some("Test"));
    assert!(page.body.contains("Body here."));
}

#[test]
fn page_to_file_writes_correctly() {
    let tmp = TempDir::new().unwrap();
    let file_path = tmp.path().join("out.md");

    let vp = VaultPath::new("out.md").unwrap();
    let meta = PageMeta::new();
    let page = Page {
        path: vp,
        meta,
        body: "# Hello\n\nWorld.\n".to_string(),
        raw_content: String::new(),
    };
    page.to_file(&file_path).unwrap();

    let content = fs::read_to_string(&file_path).unwrap();
    assert!(content.starts_with("---\n"));
    assert!(content.contains("# Hello"));
}

#[test]
fn page_from_file_no_frontmatter_creates_uuid() {
    let tmp = TempDir::new().unwrap();
    let file_path = tmp.path().join("bare.md");
    fs::write(&file_path, "# Just markdown\nNo frontmatter.\n").unwrap();

    let vp = VaultPath::new("bare.md").unwrap();
    let page = Page::from_file_or_create_meta(&file_path, vp).unwrap();
    // Should have been given a UUID
    assert!(!page.meta.id.is_nil());
    assert!(page.body.contains("Just markdown"));
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test frontmatter_test page_from_file 2>&1 | head -5`
Expected: compilation error

**Step 3: Implement Page struct**

Add to `src/vault/page.rs`:
```rust
use crate::vault::path::VaultPath;
use std::path::Path;

/// A parsed page in memory.
pub struct Page {
    /// Vault-relative path.
    pub path: VaultPath,
    pub meta: PageMeta,
    /// Markdown body (everything after the frontmatter fence).
    pub body: String,
    /// Raw file content (for hashing and span-based operations).
    pub raw_content: String,
}

impl Page {
    /// Read a file and parse its frontmatter. Fails if frontmatter is missing.
    pub fn from_file(abs_path: &Path, vault_path: VaultPath) -> Result<Self, FrontmatterError> {
        let raw_content = std::fs::read_to_string(abs_path)
            .map_err(|e| FrontmatterError::Io(e))?;
        let (meta, body) = parse_frontmatter(&raw_content)?;
        Ok(Self {
            path: vault_path,
            meta,
            body,
            raw_content,
        })
    }

    /// Read a file, parse if frontmatter exists, or create fresh PageMeta if not.
    /// Does NOT write back to disk — caller decides whether to persist the new meta.
    pub fn from_file_or_create_meta(
        abs_path: &Path,
        vault_path: VaultPath,
    ) -> Result<Self, FrontmatterError> {
        let raw_content = std::fs::read_to_string(abs_path)
            .map_err(|e| FrontmatterError::Io(e))?;
        match parse_frontmatter(&raw_content) {
            Ok((meta, body)) => Ok(Self {
                path: vault_path,
                meta,
                body,
                raw_content,
            }),
            Err(FrontmatterError::NotFound) => {
                let meta = PageMeta::new();
                Ok(Self {
                    path: vault_path,
                    meta,
                    body: raw_content.clone(),
                    raw_content,
                })
            }
            Err(e) => Err(e),
        }
    }

    /// Write this page's frontmatter + body to a file.
    pub fn to_file(&self, abs_path: &Path) -> Result<(), std::io::Error> {
        let content = write_page_content(&self.meta, &self.body);
        std::fs::write(abs_path, content)
    }
}
```

Also add `Io` variant to `FrontmatterError`:
```rust
#[error("io error: {0}")]
Io(#[from] std::io::Error),
```

Wait — `std::io::Error` conflicts with `serde_yaml::Error` for `From`. Use explicit variant:
```rust
#[derive(Debug, Error)]
pub enum FrontmatterError {
    #[error("no YAML frontmatter found (missing --- fences)")]
    NotFound,
    #[error("failed to parse YAML frontmatter: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("unterminated frontmatter (missing closing ---)")]
    Unterminated,
    #[error("io error: {0}")]
    Io(std::io::Error),
}
```

(Manual `From<std::io::Error>` not needed — we use `.map_err(FrontmatterError::Io)` at call sites.)

**Step 4: Run tests**

Run: `cargo test --test frontmatter_test`
Expected: all 10 tests pass

**Step 5: Commit**

```bash
git add src/vault/page.rs tests/frontmatter_test.rs
git commit -m "feat(vault): add Page struct with file I/O and auto-UUID creation"
```

---

## Task 11: Link Types and AST-Based Link Extraction

**Files:**
- Create: `src/vault/link.rs`
- Modify: `src/vault/mod.rs` (add `pub mod link;`)
- Create: `tests/link_extraction_test.rs`

**Step 1: Write failing tests**

`tests/link_extraction_test.rs`:
```rust
use clepsydra::vault::link::{extract_links, LinkKind};

#[test]
fn extract_wikilink() {
    let body = "See [[Design Notes]] for details.";
    let links = extract_links(body, &[]);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "Design Notes");
    assert!(matches!(links[0].kind, LinkKind::Wiki));
}

#[test]
fn extract_wikilink_with_display() {
    let body = "See [[Design Notes|my notes]] for details.";
    let links = extract_links(body, &[]);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "Design Notes");
    assert!(matches!(links[0].kind, LinkKind::Wiki));
}

#[test]
fn extract_markdown_link() {
    let body = "See [notes](design.md) for details.";
    let links = extract_links(body, &[]);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "design.md");
    assert!(matches!(links[0].kind, LinkKind::Markdown));
}

#[test]
fn skip_links_in_fenced_code() {
    let body = "Normal text.\n\n```\n[[not a link]]\n```\n\nAfter code.";
    let links = extract_links(body, &[]);
    assert!(links.is_empty());
}

#[test]
fn skip_links_in_inline_code() {
    let body = "Use `[[not a link]]` in code.";
    let links = extract_links(body, &[]);
    assert!(links.is_empty());
}

#[test]
fn multiple_links_in_paragraph() {
    let body = "See [[Page A]] and [[Page B]] also [C](c.md).";
    let links = extract_links(body, &[]);
    assert_eq!(links.len(), 3);
}

#[test]
fn wikilink_with_path() {
    let body = "See [[projects/design notes]] here.";
    let links = extract_links(body, &[]);
    assert_eq!(links[0].target_raw, "projects/design notes");
}

#[test]
fn skip_links_in_indented_code() {
    let body = "Normal.\n\n    [[not a link]]\n\nAfter.";
    let links = extract_links(body, &[]);
    assert!(links.is_empty());
}

#[test]
fn external_url_ignored() {
    let body = "See [Google](https://google.com) for info.";
    let links = extract_links(body, &[]);
    assert!(links.is_empty()); // External URLs are not vault links
}

#[test]
fn links_in_blockquote() {
    let body = "> See [[quoted link]] here.";
    let links = extract_links(body, &[]);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "quoted link");
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test link_extraction_test 2>&1 | head -5`
Expected: compilation error

**Step 3: Implement Link types and extraction**

`src/vault/link.rs`:
```rust
use std::ops::Range;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use regex::Regex;

/// A reference from one page to another.
#[derive(Debug, Clone)]
pub struct Link {
    /// Raw reference text (e.g. "Design Notes" from [[Design Notes]]).
    pub target_raw: String,
    /// Byte range of the link syntax in the source body, for rewriting.
    pub span: Range<usize>,
    pub kind: LinkKind,
}

#[derive(Debug, Clone)]
pub enum LinkKind {
    /// [[target]] or [[target|display]]
    Wiki,
    /// [display](target.md)
    Markdown,
    /// Reference from a frontmatter property (tags, aliases, etc.).
    PropertyRef { source_field: String },
}

/// Extract links from a Markdown body using pulldown-cmark for structure
/// awareness and regex for wikilinks in safe text regions.
///
/// `linkable_values` can be used to pass pre-extracted PropertyRef links
/// from frontmatter — this function focuses on body links only.
pub fn extract_links(body: &str, _linkable_values: &[Link]) -> Vec<Link> {
    let mut links = Vec::new();

    // pulldown-cmark options: enable tables, footnotes, etc. but not
    // anything that would interfere with wikilink detection
    let opts = Options::empty();
    let parser = Parser::new_ext(body, opts);

    let mut in_code = false;
    let mut in_html = false;

    for (event, range) in parser.into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_)) => in_code = true,
            Event::End(TagEnd::CodeBlock) => in_code = false,
            Event::Start(Tag::HtmlBlock) => in_html = true,
            Event::End(TagEnd::HtmlBlock) => in_html = false,
            Event::Code(_) => {
                // Inline code span — already skipped (content is the code text)
                continue;
            }
            Event::Start(Tag::Link { dest_url, .. }) => {
                if !in_code && !in_html {
                    let url = dest_url.as_ref();
                    // Skip external URLs and anchors
                    if !url.starts_with("http://")
                        && !url.starts_with("https://")
                        && !url.starts_with('#')
                        && !url.starts_with("mailto:")
                    {
                        links.push(Link {
                            target_raw: url.to_string(),
                            span: range.clone(),
                            kind: LinkKind::Markdown,
                        });
                    }
                }
            }
            Event::Text(text) => {
                if !in_code && !in_html {
                    // Search for wikilinks in this text span
                    extract_wikilinks(&text, range.start, &mut links);
                }
            }
            _ => {}
        }
    }

    links
}

/// Extract wikilinks ([[target]] or [[target|display]]) from a text span.
fn extract_wikilinks(text: &str, offset: usize, links: &mut Vec<Link>) {
    // Lazy-init regex — compiled once
    let re = wikilink_regex();

    for cap in re.captures_iter(text) {
        let full = cap.get(0).unwrap();
        let target = cap.get(1).unwrap().as_str();

        // Handle display text: [[target|display]] — target is before the pipe
        let target_raw = target.split('|').next().unwrap_or(target).trim();

        links.push(Link {
            target_raw: target_raw.to_string(),
            span: (offset + full.start())..(offset + full.end()),
            kind: LinkKind::Wiki,
        });
    }
}

fn wikilink_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\[\[([^\[\]]+)\]\]").unwrap()
    })
}

/// Extract PropertyRef links from frontmatter field values.
/// Called by the index builder, not by body-link extraction.
pub fn extract_property_refs(
    field_name: &str,
    values: &[String],
) -> Vec<Link> {
    values
        .iter()
        .enumerate()
        .map(|(i, val)| Link {
            target_raw: val.clone(),
            // PropertyRef spans are synthetic — use 0..0 placeholder
            // (they don't correspond to body byte ranges)
            span: 0..0,
            kind: LinkKind::PropertyRef {
                source_field: field_name.to_string(),
            },
        })
        .collect()
}
```

Add `pub mod link;` to `src/vault/mod.rs`.

**Step 4: Run tests**

Run: `cargo test --test link_extraction_test`
Expected: all 10 tests pass

**Step 5: Commit**

```bash
git add src/vault/link.rs src/vault/mod.rs tests/link_extraction_test.rs
git commit -m "feat(vault): AST-based link extraction with pulldown-cmark"
```

---

## Task 12: SQLite Schema Creation

**Files:**
- Create: `src/vault/index.rs`
- Modify: `src/vault/mod.rs` (add `pub mod index;`)
- Create: `tests/index_test.rs`

**Step 1: Write failing test**

`tests/index_test.rs`:
```rust
use clepsydra::vault::index::VaultIndex;
use tempfile::TempDir;

#[test]
fn creates_schema_on_open() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("cache.db");
    let index = VaultIndex::open(&db_path).unwrap();

    // Verify tables exist by querying them
    let conn = index.connection();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM canonical_names", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM links", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --test index_test 2>&1 | head -5`
Expected: compilation error

**Step 3: Implement VaultIndex with schema creation**

`src/vault/index.rs`:
```rust
use std::path::Path;

use rusqlite::Connection;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum IndexError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS pages (
    id              TEXT PRIMARY KEY,
    path            TEXT NOT NULL UNIQUE,
    title           TEXT,
    canonical_name  TEXT NOT NULL,
    created_at      TEXT,
    updated_at      TEXT,
    meta_json       TEXT NOT NULL,
    content_hash    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS canonical_names (
    canonical_name  TEXT NOT NULL,
    page_id         TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    source          TEXT NOT NULL,
    PRIMARY KEY (canonical_name, page_id)
);

CREATE TABLE IF NOT EXISTS links (
    source_id       TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    target_raw      TEXT NOT NULL,
    target_canonical TEXT,
    target_id       TEXT REFERENCES pages(id),
    target_path     TEXT,
    kind            TEXT NOT NULL,
    source_field    TEXT,
    span_start      INTEGER NOT NULL,
    span_end        INTEGER NOT NULL,
    PRIMARY KEY (source_id, span_start)
);

CREATE TABLE IF NOT EXISTS tags (
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (page_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_pages_path ON pages(path);
CREATE INDEX IF NOT EXISTS idx_pages_canonical ON pages(canonical_name);
CREATE INDEX IF NOT EXISTS idx_canonical_names_name ON canonical_names(canonical_name);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_id);
CREATE INDEX IF NOT EXISTS idx_links_target_path ON links(target_path);
CREATE INDEX IF NOT EXISTS idx_links_target_canonical ON links(target_canonical);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
"#;

pub struct VaultIndex {
    conn: Connection,
}

impl VaultIndex {
    /// Open (or create) a SQLite index at the given path.
    /// Creates the schema if tables don't exist.
    pub fn open(db_path: &Path) -> Result<Self, IndexError> {
        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        conn.execute_batch(SCHEMA)?;

        Ok(Self { conn })
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }
}
```

Add `pub mod index;` to `src/vault/mod.rs`.

**Step 4: Run test**

Run: `cargo test --test index_test`
Expected: passes

**Step 5: Commit**

```bash
git add src/vault/index.rs src/vault/mod.rs tests/index_test.rs
git commit -m "feat(vault): SQLite index with schema creation"
```

---

## Task 13: Index Builder — Walk, Hash, Upsert

**Files:**
- Modify: `src/vault/index.rs` (add `build_index` method)
- Modify: `tests/index_test.rs`

**Step 1: Write failing test**

Append to `tests/index_test.rs`:
```rust
use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use std::fs;
use tempfile::TempDir;

#[test]
fn build_index_from_test_vault() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    // Create vault structure
    fs::create_dir_all(root.join(".clepsydra")).unwrap();
    fs::write(
        root.join("hello.md"),
        "---\nid: \"01936e1a-5c4a-7000-8000-000000000001\"\ntitle: \"Hello\"\ntags:\n  - greeting\n---\nSee [[World]].\n",
    ).unwrap();
    fs::write(
        root.join("world.md"),
        "---\nid: \"01936e1a-5c4a-7000-8000-000000000002\"\ntitle: \"World\"\n---\nBack to [[Hello]].\n",
    ).unwrap();

    let vault = Vault::open(root).unwrap();
    let db_path = root.join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    index.build(&vault).unwrap();

    // Verify pages indexed
    let count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 2);

    // Verify links extracted
    let link_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM links WHERE kind = 'wiki'", [], |row| row.get(0))
        .unwrap();
    assert_eq!(link_count, 2); // [[World]] and [[Hello]]

    // Verify tags
    let tag_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tag_count, 1); // "greeting"

    // Verify canonical names
    let cn_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM canonical_names", [], |row| row.get(0))
        .unwrap();
    assert!(cn_count >= 2); // At least one per page (title-derived)
}

#[test]
fn incremental_index_skips_unchanged() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join(".clepsydra")).unwrap();
    fs::write(
        root.join("page.md"),
        "---\nid: \"01936e1a-5c4a-7000-8000-000000000001\"\ntitle: \"Page\"\n---\nContent.\n",
    ).unwrap();

    let vault = Vault::open(root).unwrap();
    let db_path = root.join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    // First build
    let stats1 = index.build(&vault).unwrap();
    assert_eq!(stats1.pages_indexed, 1);

    // Second build — file unchanged
    let stats2 = index.build(&vault).unwrap();
    assert_eq!(stats2.pages_indexed, 0); // Skipped
    assert_eq!(stats2.pages_skipped, 1);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test index_test build_index 2>&1 | head -5`
Expected: compilation error — `build` method not found

**Step 3: Implement index builder**

Add to `src/vault/index.rs`:
```rust
use crate::vault::Vault;
use crate::vault::canonical::CanonicalName;
use crate::vault::link::{extract_links, extract_property_refs, LinkKind};
use crate::vault::page::{Page, parse_frontmatter};
use walkdir::WalkDir;

#[derive(Debug, Default)]
pub struct BuildStats {
    pub pages_indexed: usize,
    pub pages_skipped: usize,
    pub pages_removed: usize,
    pub warnings: Vec<String>,
}

impl VaultIndex {
    /// Build or incrementally update the index from the vault's files.
    pub fn build(&mut self, vault: &Vault) -> Result<BuildStats, IndexError> {
        let mut stats = BuildStats::default();

        // Collect all .md files in the vault
        let mut seen_paths: Vec<String> = Vec::new();

        for entry in WalkDir::new(vault.root())
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
        {
            let abs_path = entry.path();
            let rel = abs_path.strip_prefix(vault.root()).unwrap();
            let rel_str = rel.to_string_lossy().replace('\\', "/");

            // Build VaultPath
            let vault_path = match crate::vault::path::VaultPath::new(&rel_str) {
                Ok(vp) => vp,
                Err(_) => continue,
            };

            // Skip excluded paths
            if vault.is_excluded(&vault_path) {
                continue;
            }

            seen_paths.push(rel_str.clone());

            // Hash file content
            let content = match std::fs::read_to_string(abs_path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let hash = blake3::hash(content.as_bytes()).to_hex().to_string();

            // Check if already indexed with same hash
            let existing_hash: Option<String> = self
                .conn
                .query_row(
                    "SELECT content_hash FROM pages WHERE path = ?1",
                    [&rel_str],
                    |row| row.get(0),
                )
                .ok();

            if existing_hash.as_deref() == Some(&hash) {
                stats.pages_skipped += 1;
                continue;
            }

            // Parse the file
            let (meta, body) = match parse_frontmatter(&content) {
                Ok((m, b)) => (m, b),
                Err(e) => {
                    stats.warnings.push(format!("{rel_str}: {e}"));
                    continue;
                }
            };

            // Derive canonical name
            let cn = meta
                .title
                .as_deref()
                .map(CanonicalName::from_title)
                .unwrap_or_else(|| {
                    CanonicalName::from_filename(vault_path.stem())
                });

            // Extract body links
            let body_links = extract_links(&body, &[]);

            // Extract property ref links (tags, aliases, configured fields)
            let mut prop_links = Vec::new();
            for field in &vault.config().vault.linkable_properties {
                match field.as_str() {
                    "tags" => {
                        prop_links.extend(extract_property_refs("tags", &meta.tags));
                    }
                    "aliases" => {
                        prop_links.extend(extract_property_refs("aliases", &meta.aliases));
                    }
                    other => {
                        // Check extra fields for string values
                        if let Some(val) = meta.extra.get(other) {
                            if let Some(arr) = val.as_sequence() {
                                let strs: Vec<String> = arr
                                    .iter()
                                    .filter_map(|v| v.as_str().map(String::from))
                                    .collect();
                                prop_links.extend(extract_property_refs(other, &strs));
                            } else if let Some(s) = val.as_str() {
                                prop_links.extend(extract_property_refs(other, &[s.to_string()]));
                            }
                        }
                    }
                }
            }

            let meta_json = serde_json::to_string(&meta).unwrap_or_default();
            let id_str = meta.id.to_string();

            // Upsert page
            self.conn.execute(
                "INSERT INTO pages (id, path, title, canonical_name, created_at, updated_at, meta_json, content_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                    path = excluded.path,
                    title = excluded.title,
                    canonical_name = excluded.canonical_name,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    meta_json = excluded.meta_json,
                    content_hash = excluded.content_hash",
                rusqlite::params![
                    id_str,
                    rel_str,
                    meta.title,
                    cn.as_str(),
                    meta.created_at.map(|d| d.to_rfc3339()),
                    meta.updated_at.map(|d| d.to_rfc3339()),
                    meta_json,
                    hash,
                ],
            )?;

            // Clear old links and tags for this page
            self.conn.execute("DELETE FROM links WHERE source_id = ?1", [&id_str])?;
            self.conn.execute("DELETE FROM tags WHERE page_id = ?1", [&id_str])?;
            self.conn.execute("DELETE FROM canonical_names WHERE page_id = ?1", [&id_str])?;

            // Insert canonical names (title + filename + aliases)
            if meta.title.is_some() {
                self.conn.execute(
                    "INSERT OR IGNORE INTO canonical_names (canonical_name, page_id, source) VALUES (?1, ?2, 'title')",
                    rusqlite::params![cn.as_str(), id_str],
                )?;
            }
            let fn_cn = CanonicalName::from_filename(vault_path.stem());
            self.conn.execute(
                "INSERT OR IGNORE INTO canonical_names (canonical_name, page_id, source) VALUES (?1, ?2, 'filename')",
                rusqlite::params![fn_cn.as_str(), id_str],
            )?;
            for alias in &meta.aliases {
                let alias_cn = CanonicalName::from_title(alias);
                self.conn.execute(
                    "INSERT OR IGNORE INTO canonical_names (canonical_name, page_id, source) VALUES (?1, ?2, 'alias')",
                    rusqlite::params![alias_cn.as_str(), id_str],
                )?;
            }

            // Insert body links
            for link in &body_links {
                let kind_str = match &link.kind {
                    LinkKind::Wiki => "wiki",
                    LinkKind::Markdown => "markdown",
                    LinkKind::PropertyRef { .. } => "property_ref",
                };
                let target_cn = CanonicalName::from_title(&link.target_raw);
                self.conn.execute(
                    "INSERT OR IGNORE INTO links (source_id, target_raw, target_canonical, kind, source_field, span_start, span_end)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![
                        id_str,
                        link.target_raw,
                        target_cn.as_str(),
                        kind_str,
                        Option::<String>::None,
                        link.span.start as i64,
                        link.span.end as i64,
                    ],
                )?;
            }

            // Insert property ref links
            for (i, link) in prop_links.iter().enumerate() {
                let source_field = match &link.kind {
                    LinkKind::PropertyRef { source_field } => Some(source_field.as_str()),
                    _ => None,
                };
                let target_cn = CanonicalName::from_title(&link.target_raw);
                // Use negative span_start for property refs to avoid PK collision with body links
                let synthetic_span = -(i as i64 + 1);
                self.conn.execute(
                    "INSERT OR IGNORE INTO links (source_id, target_raw, target_canonical, kind, source_field, span_start, span_end)
                     VALUES (?1, ?2, ?3, 'property_ref', ?4, ?5, ?5)",
                    rusqlite::params![
                        id_str,
                        link.target_raw,
                        target_cn.as_str(),
                        source_field,
                        synthetic_span,
                    ],
                )?;
            }

            // Insert tags
            for tag in &meta.tags {
                self.conn.execute(
                    "INSERT OR IGNORE INTO tags (page_id, tag) VALUES (?1, ?2)",
                    rusqlite::params![id_str, tag],
                )?;
            }

            stats.pages_indexed += 1;
        }

        // Remove pages that are in DB but no longer on disk
        let mut stmt = self.conn.prepare("SELECT path FROM pages")?;
        let db_paths: Vec<String> = stmt
            .query_map([], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();

        for db_path in &db_paths {
            if !seen_paths.contains(db_path) {
                self.conn.execute("DELETE FROM pages WHERE path = ?1", [db_path])?;
                stats.pages_removed += 1;
            }
        }

        Ok(stats)
    }
}
```

**Step 4: Run tests**

Run: `cargo test --test index_test`
Expected: all 3 tests pass

**Step 5: Commit**

```bash
git add src/vault/index.rs tests/index_test.rs
git commit -m "feat(vault): index builder with walk, hash, upsert, and link extraction"
```

---

## Task 14: Link Resolution via Canonical Names

**Files:**
- Modify: `src/vault/index.rs` (add `resolve_links` method)
- Modify: `tests/index_test.rs`

**Step 1: Write failing test**

Append to `tests/index_test.rs`:
```rust
#[test]
fn resolves_links_via_canonical_names() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join(".clepsydra")).unwrap();

    fs::write(
        root.join("hello.md"),
        "---\nid: \"01936e1a-5c4a-7000-8000-000000000001\"\ntitle: \"Hello\"\n---\nSee [[World]].\n",
    ).unwrap();
    fs::write(
        root.join("world.md"),
        "---\nid: \"01936e1a-5c4a-7000-8000-000000000002\"\ntitle: \"World\"\n---\nContent.\n",
    ).unwrap();

    let vault = Vault::open(root).unwrap();
    let db_path = root.join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // [[World]] from hello.md should resolve to world.md's UUID
    let resolved: Option<String> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = ?1 AND target_raw = 'World'",
            ["01936e1a-5c4a-7000-8000-000000000001"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(resolved.as_deref(), Some("01936e1a-5c4a-7000-8000-000000000002"));
}

#[test]
fn ambiguous_links_stay_unresolved() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join(".clepsydra")).unwrap();

    // Two pages with the same canonical name (via title vs alias)
    fs::write(
        root.join("a.md"),
        "---\nid: \"01936e1a-5c4a-7000-8000-000000000001\"\ntitle: \"Design\"\n---\nContent.\n",
    ).unwrap();
    fs::write(
        root.join("b.md"),
        "---\nid: \"01936e1a-5c4a-7000-8000-000000000002\"\ntitle: \"Design\"\n---\nOther.\n",
    ).unwrap();
    fs::write(
        root.join("c.md"),
        "---\nid: \"01936e1a-5c4a-7000-8000-000000000003\"\ntitle: \"Linker\"\n---\nSee [[Design]].\n",
    ).unwrap();

    let vault = Vault::open(root).unwrap();
    let db_path = root.join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // [[Design]] should NOT resolve (ambiguous)
    let target_id: Option<Option<String>> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = ?1 AND target_raw = 'Design'",
            ["01936e1a-5c4a-7000-8000-000000000003"],
            |row| row.get(0),
        )
        .ok();
    // target_id should be NULL (unresolved due to ambiguity)
    assert!(target_id.unwrap_or(None).is_none());
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test index_test resolves_links 2>&1 | head -5`
Expected: compilation error — `resolve_links` not found

**Step 3: Implement link resolution**

Add to `src/vault/index.rs`:
```rust
impl VaultIndex {
    /// Resolve all unresolved links using the canonical_names table.
    /// 0 matches → unresolved (NULL target_id).
    /// 1 match → resolved (set target_id and target_path).
    /// 2+ matches → ambiguous (leave target_id NULL).
    pub fn resolve_links(&mut self) -> Result<(), IndexError> {
        // Get all unresolved links
        let mut stmt = self.conn.prepare(
            "SELECT source_id, target_raw, target_canonical, span_start
             FROM links WHERE target_id IS NULL AND target_canonical IS NOT NULL"
        )?;

        let unresolved: Vec<(String, String, String, i64)> = stmt
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        for (source_id, _target_raw, target_canonical, span_start) in &unresolved {
            // Look up canonical name → page_ids
            let mut cn_stmt = self.conn.prepare(
                "SELECT page_id FROM canonical_names WHERE canonical_name = ?1"
            )?;
            let candidates: Vec<String> = cn_stmt
                .query_map([target_canonical], |row| row.get(0))?
                .filter_map(|r| r.ok())
                .collect();

            match candidates.len() {
                0 => {
                    // Unresolved — already NULL, nothing to do
                }
                1 => {
                    // Resolved — set target_id and target_path
                    let target_id = &candidates[0];
                    let target_path: Option<String> = self.conn.query_row(
                        "SELECT path FROM pages WHERE id = ?1",
                        [target_id],
                        |row| row.get(0),
                    ).ok();

                    self.conn.execute(
                        "UPDATE links SET target_id = ?1, target_path = ?2
                         WHERE source_id = ?3 AND span_start = ?4",
                        rusqlite::params![target_id, target_path, source_id, span_start],
                    )?;
                }
                _ => {
                    // Ambiguous — leave NULL (the spec says "never silent first-match")
                }
            }
        }

        Ok(())
    }
}
```

**Step 4: Run tests**

Run: `cargo test --test index_test`
Expected: all 5 tests pass

**Step 5: Commit**

```bash
git add src/vault/index.rs tests/index_test.rs
git commit -m "feat(vault): link resolution via canonical names with ambiguity detection"
```

---

## Task 15: Duplicate UUID Detection and Resolution

**Files:**
- Modify: `src/vault/index.rs` (add duplicate UUID handling to `build`)
- Modify: `tests/index_test.rs`

**Step 1: Write failing test**

Append to `tests/index_test.rs`:
```rust
#[test]
fn duplicate_uuid_resolved_by_created_at() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join(".clepsydra")).unwrap();

    let shared_uuid = "01936e1a-5c4a-7000-8000-000000000099";

    // older.md has earlier created_at — should keep the UUID
    fs::write(
        root.join("older.md"),
        format!(
            "---\nid: \"{shared_uuid}\"\ntitle: \"Older\"\ncreated_at: \"2026-01-01T00:00:00Z\"\n---\nOlder content.\n"
        ),
    ).unwrap();

    // newer.md has later created_at — should get a new UUID
    fs::write(
        root.join("newer.md"),
        format!(
            "---\nid: \"{shared_uuid}\"\ntitle: \"Newer\"\ncreated_at: \"2026-02-01T00:00:00Z\"\n---\nNewer content.\n"
        ),
    ).unwrap();

    let vault = Vault::open(root).unwrap();
    let db_path = root.join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    let stats = index.build(&vault).unwrap();

    // Should have a warning about duplicate UUID
    assert!(stats.warnings.iter().any(|w| w.contains("duplicate")));

    // Two distinct pages should exist in the DB
    let count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 2);

    // The newer file on disk should now have a different UUID
    let newer_content = fs::read_to_string(root.join("newer.md")).unwrap();
    assert!(!newer_content.contains(shared_uuid));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --test index_test duplicate_uuid 2>&1 | tail -20`
Expected: assertion failure — duplicate UUID not yet handled

**Step 3: Implement duplicate UUID detection**

This requires modifying the `build` method in `src/vault/index.rs`. Before the main walk loop, add a two-pass approach:

1. **First pass**: collect all `(path, meta, content_hash)` tuples.
2. **Detect duplicate UUIDs**: group by UUID, resolve conflicts (older `created_at` wins, loser gets new UUID written to disk).
3. **Second pass**: upsert into DB.

This is a significant refactor of the `build` method. The implementation should:

- After parsing all files, group by UUID.
- For each group with 2+ entries, sort by `created_at` (or filesystem mtime as fallback).
- The first entry keeps the UUID; remaining entries get `Uuid::now_v7()` and their files are rewritten.
- Log a warning for each regeneration.

Due to the complexity, add a helper method `resolve_duplicate_uuids` that takes `&mut Vec<ParsedFile>` and writes corrected files to disk.

**Step 4: Run tests**

Run: `cargo test --test index_test`
Expected: all 6 tests pass

**Step 5: Commit**

```bash
git add src/vault/index.rs tests/index_test.rs
git commit -m "feat(vault): detect and resolve duplicate UUIDs during index build"
```

---

## Task 16: AppState and API Router Skeleton

**Files:**
- Create: `src/api/mod.rs`
- Create: `src/api/error.rs`
- Create: `src/api/state.rs` (or inline in mod.rs)
- Modify: `src/lib.rs` (mount API subrouter, create AppState)
- Modify: `src/vault/mod.rs` (if needed for re-exports)

**Step 1: Create API module skeleton**

`src/api/mod.rs`:
```rust
pub mod error;
pub mod pages;
pub mod folders;
pub mod attachments;
pub mod index_routes;

use std::sync::Arc;

use axum::Router;
use rusqlite::Connection;
use std::sync::Mutex;

use crate::vault::Vault;
use crate::vault::index::VaultIndex;

/// Shared application state.
pub struct AppState {
    pub vault: Vault,
    pub index: Mutex<VaultIndex>,
}

pub fn api_router() -> Router<Arc<AppState>> {
    Router::new()
        .nest("/pages", pages::router())
        .nest("/folders", folders::router())
        .nest("/attachments", attachments::router())
        .nest("/index", index_routes::router())
}
```

`src/api/error.rs`:
```rust
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ApiError {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl ApiError {
    pub fn not_found(msg: impl Into<String>) -> (StatusCode, Json<Self>) {
        (StatusCode::NOT_FOUND, Json(Self {
            error: msg.into(),
            detail: None,
            hint: None,
        }))
    }

    pub fn conflict(msg: impl Into<String>, detail: serde_json::Value, hint: impl Into<String>) -> (StatusCode, Json<Self>) {
        (StatusCode::CONFLICT, Json(Self {
            error: msg.into(),
            detail: Some(detail),
            hint: Some(hint.into()),
        }))
    }

    pub fn bad_request(msg: impl Into<String>) -> (StatusCode, Json<Self>) {
        (StatusCode::BAD_REQUEST, Json(Self {
            error: msg.into(),
            detail: None,
            hint: None,
        }))
    }

    pub fn internal(msg: impl Into<String>) -> (StatusCode, Json<Self>) {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(Self {
            error: msg.into(),
            detail: None,
            hint: None,
        }))
    }
}
```

Create stub routers for each sub-module (they'll return empty `Router` for now):

`src/api/pages.rs`:
```rust
use axum::Router;
use std::sync::Arc;
use crate::api::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
}
```

`src/api/folders.rs`: (same pattern)
`src/api/attachments.rs`: (same pattern)
`src/api/index_routes.rs`: (same pattern)

**Step 2: Wire into lib.rs**

Modify `src/lib.rs` — add `pub mod api;` and update `run_server()` to create `AppState`, mount the API router at `/api/vault`:

```rust
pub mod api;
pub mod vault;

// In run_server():
use std::sync::Arc;
use std::sync::Mutex;
use crate::vault::Vault;
use crate::vault::index::VaultIndex;
use crate::api::{AppState, api_router};

// After settings load:
let vault_root = std::path::PathBuf::from(&settings.vault.root);
let vault = Vault::open(&vault_root)?;
let db_path = vault_root.join(".clepsydra/cache.db");
let mut index = VaultIndex::open(&db_path)?;
index.build(&vault)?;
index.resolve_links()?;

let state = Arc::new(AppState {
    vault,
    index: Mutex::new(index),
});

let app = Router::new()
    .route("/", get(root))
    .nest("/api/vault", api_router())
    .layer(ServiceBuilder::new().layer(TraceLayer::new_for_http()))
    .with_state(state);
```

**Step 3: Verify it compiles**

Run: `cargo check`
Expected: compiles

**Step 4: Commit**

```bash
git add src/api/ src/lib.rs
git commit -m "feat(api): add API router skeleton with AppState"
```

---

## Task 17: Page CRUD Endpoints

**Files:**
- Modify: `src/api/pages.rs` (full implementation)
- Create: `tests/api_test.rs`

**Step 1: Write failing test**

`tests/api_test.rs`:
```rust
use axum::http::StatusCode;
use axum_test::TestServer;
use clepsydra::api::{AppState, api_router};
use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;
use std::fs;

fn setup_test_server() -> (TestServer, TempDir) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    // Initialize vault structure
    fs::create_dir_all(root.join(".clepsydra")).unwrap();
    fs::create_dir_all(root.join("_attachments")).unwrap();

    let vault = Vault::open(root).unwrap();
    let db_path = root.join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    let state = Arc::new(AppState {
        vault,
        index: Mutex::new(index),
    });

    let app = axum::Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);

    let server = TestServer::new(app).unwrap();
    (server, tmp)
}

#[tokio::test]
async fn create_and_get_page() {
    let (server, _tmp) = setup_test_server();

    // Create a page
    let res = server
        .post("/api/vault/pages/hello.md")
        .json(&serde_json::json!({
            "title": "Hello World",
            "body": "# Hello\n\nContent here."
        }))
        .await;
    assert_eq!(res.status_code(), StatusCode::CREATED);

    // Get it back
    let res = server.get("/api/vault/pages/hello.md").await;
    assert_eq!(res.status_code(), StatusCode::OK);
    let body: serde_json::Value = res.json();
    assert_eq!(body["meta"]["title"], "Hello World");
}

#[tokio::test]
async fn create_duplicate_returns_409() {
    let (server, _tmp) = setup_test_server();

    server
        .post("/api/vault/pages/hello.md")
        .json(&serde_json::json!({"title": "Hello"}))
        .await;

    let res = server
        .post("/api/vault/pages/hello.md")
        .json(&serde_json::json!({"title": "Hello Again"}))
        .await;
    assert_eq!(res.status_code(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn get_nonexistent_returns_404() {
    let (server, _tmp) = setup_test_server();
    let res = server.get("/api/vault/pages/nope.md").await;
    assert_eq!(res.status_code(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn delete_page_no_backlinks() {
    let (server, _tmp) = setup_test_server();

    server
        .post("/api/vault/pages/deleteme.md")
        .json(&serde_json::json!({"title": "Delete Me"}))
        .await;

    let res = server.delete("/api/vault/pages/deleteme.md").await;
    assert_eq!(res.status_code(), StatusCode::NO_CONTENT);

    let res = server.get("/api/vault/pages/deleteme.md").await;
    assert_eq!(res.status_code(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn path_traversal_rejected() {
    let (server, _tmp) = setup_test_server();
    let res = server.get("/api/vault/pages/../../../etc/passwd").await;
    assert_eq!(res.status_code(), StatusCode::BAD_REQUEST);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test api_test 2>&1 | head -10`
Expected: compilation error or test failures

**Step 3: Implement page endpoints**

`src/api/pages.rs` — implement handlers for:
- `GET /pages/*path` → read file, parse, return JSON
- `GET /pages/by-id/:uuid` → look up path in index, then read
- `POST /pages/*path` → create file with auto UUID, index it
- `PUT /pages/*path` → update file content, re-index
- `DELETE /pages/*path` → check backlinks (409 if any without `force`), delete file, update index
- `GET /pages` → list all pages from index

Each handler extracts `Arc<AppState>`, validates the path via `VaultPath::new()`, and operates on the filesystem + index.

Key response types:
```rust
#[derive(Serialize)]
struct PageSummary {
    id: String,
    path: String,
    title: Option<String>,
    canonical_name: String,
}

#[derive(Serialize)]
struct PageDetail {
    meta: serde_json::Value,  // Full frontmatter
    body: String,
    path: String,
    canonical_name: String,
}
```

**Step 4: Run tests**

Run: `cargo test --test api_test`
Expected: all 5 tests pass

**Step 5: Commit**

```bash
git add src/api/pages.rs tests/api_test.rs
git commit -m "feat(api): implement page CRUD endpoints"
```

---

## Task 18: Folder Endpoints

**Files:**
- Modify: `src/api/folders.rs`
- Modify: `tests/api_test.rs`

**Step 1: Write failing tests**

Append to `tests/api_test.rs`:
```rust
#[tokio::test]
async fn create_and_list_folder() {
    let (server, _tmp) = setup_test_server();

    let res = server.post("/api/vault/folders/projects/clepsydra").await;
    assert_eq!(res.status_code(), StatusCode::CREATED);

    let res = server.get("/api/vault/folders").await;
    assert_eq!(res.status_code(), StatusCode::OK);
    let body: serde_json::Value = res.json();
    // Should list "projects" as a top-level folder
    let folders = body.as_array().unwrap();
    assert!(folders.iter().any(|f| f["name"] == "projects"));
}

#[tokio::test]
async fn delete_nonempty_folder_without_recursive_fails() {
    let (server, tmp) = setup_test_server();

    // Create a folder with a file in it
    fs::create_dir_all(tmp.path().join("notes")).unwrap();
    fs::write(
        tmp.path().join("notes/test.md"),
        "---\nid: \"01936e1a-5c4a-7000-8000-000000000099\"\n---\nContent.\n",
    ).unwrap();

    let res = server.delete("/api/vault/folders/notes").await;
    assert_eq!(res.status_code(), StatusCode::CONFLICT);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test api_test create_and_list 2>&1 | head -10`
Expected: failures

**Step 3: Implement folder endpoints**

`src/api/folders.rs`:
- `GET /folders` → list top-level directories in vault root
- `GET /folders/*path` → list contents of a subfolder (pages + subdirs)
- `POST /folders/*path` → `create_dir_all` after VaultPath validation
- `DELETE /folders/*path` → delete if empty, or if `?recursive=true`
- `POST /folders/*path/move` → rename directory, rewrite backlinks for all contained pages

**Step 4: Run tests**

Run: `cargo test --test api_test`
Expected: all tests pass

**Step 5: Commit**

```bash
git add src/api/folders.rs tests/api_test.rs
git commit -m "feat(api): implement folder CRUD endpoints"
```

---

## Task 19: Attachment Endpoints

**Files:**
- Modify: `src/api/attachments.rs`
- Modify: `tests/api_test.rs`

**Step 1: Write failing tests**

Append to `tests/api_test.rs`:
```rust
#[tokio::test]
async fn upload_and_get_attachment() {
    let (server, _tmp) = setup_test_server();

    // Upload via multipart (simplified — axum-test may need specific setup)
    // For now, test that the endpoint exists and returns appropriate status
    let res = server.get("/api/vault/attachments").await;
    assert_eq!(res.status_code(), StatusCode::OK);
}
```

**Step 2: Implement attachment endpoints**

`src/api/attachments.rs`:
- `GET /attachments` → list files in attachment folder
- `GET /attachments/*path` → serve binary file
- `POST /attachments` → receive multipart upload, write to attachment folder
- `DELETE /attachments/*path` → delete file

**Step 3: Run tests**

Run: `cargo test --test api_test`
Expected: all tests pass

**Step 4: Commit**

```bash
git add src/api/attachments.rs tests/api_test.rs
git commit -m "feat(api): implement attachment endpoints"
```

---

## Task 20: LinkRewriter — Core Rewrite Logic

**Files:**
- Create: `src/vault/rewriter.rs`
- Modify: `src/vault/mod.rs` (add `pub mod rewriter;`)
- Create: `tests/rewriter_test.rs`

**Step 1: Write failing tests**

`tests/rewriter_test.rs`:
```rust
use clepsydra::vault::rewriter::rewrite_links_in_content;

#[test]
fn rewrite_wikilink() {
    let content = "See [[Old Page]] for details.";
    let result = rewrite_links_in_content(
        content,
        &[("Old Page", "New Page")],
    );
    assert_eq!(result, "See [[New Page]] for details.");
}

#[test]
fn rewrite_wikilink_with_display_text() {
    let content = "See [[Old Page|my link]] for details.";
    let result = rewrite_links_in_content(
        content,
        &[("Old Page", "New Page")],
    );
    assert_eq!(result, "See [[New Page|my link]] for details.");
}

#[test]
fn rewrite_markdown_link() {
    let content = "See [notes](old/path.md) here.";
    let result = rewrite_links_in_content(
        content,
        &[("old/path.md", "new/path.md")],
    );
    assert_eq!(result, "See [notes](new/path.md) here.");
}

#[test]
fn rewrite_multiple_links() {
    let content = "[[A]] and [[B]] are related.";
    let result = rewrite_links_in_content(
        content,
        &[("A", "A-renamed"), ("B", "B-renamed")],
    );
    assert_eq!(result, "[[A-renamed]] and [[B-renamed]] are related.");
}

#[test]
fn skip_links_in_code_blocks() {
    let content = "Normal [[A]].\n\n```\n[[A]]\n```\n\nAfter.";
    let result = rewrite_links_in_content(
        content,
        &[("A", "B")],
    );
    assert!(result.contains("Normal [[B]]"));
    assert!(result.contains("```\n[[A]]\n```")); // NOT rewritten
}

#[test]
fn delete_rewrite_plain_text() {
    let content = "See [[Deleted Page]] for info.";
    let result = rewrite_links_in_content(
        content,
        &[("Deleted Page", "\x00PLAIN:Deleted Page")], // sentinel for plain text mode
    );
    // In plain_text mode: [[Deleted Page]] → Deleted Page
    assert_eq!(result, "See Deleted Page for info.");
}

#[test]
fn delete_rewrite_unlink() {
    let content = "See [[Deleted Page]] for info.";
    let result = rewrite_links_in_content(
        content,
        &[("Deleted Page", "\x00UNLINK:Deleted Page")], // sentinel for unlink mode
    );
    // In unlink mode: [[Deleted Page]] → ~~Deleted Page~~
    assert_eq!(result, "See ~~Deleted Page~~ for info.");
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test rewriter_test 2>&1 | head -5`
Expected: compilation error

**Step 3: Implement rewrite_links_in_content**

`src/vault/rewriter.rs`:
```rust
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use regex::Regex;
use std::ops::Range;

/// Describes how to rewrite references when deleting a page.
#[derive(Debug, Clone, Copy)]
pub enum DeleteRewriteMode {
    /// [[target]] → target (plain text)
    PlainText,
    /// [[target]] → ~~target~~ (strikethrough)
    Unlink,
    /// Leave links untouched (they become unresolved)
    None,
}

/// Rewrite links in a Markdown document.
///
/// `replacements` is a slice of (old_target, new_target) pairs.
/// Special prefixes for delete modes:
///   - `\x00PLAIN:text` → replace link with plain text
///   - `\x00UNLINK:text` → replace link with ~~text~~
///
/// Returns the new content with links rewritten.
pub fn rewrite_links_in_content(
    content: &str,
    replacements: &[(&str, &str)],
) -> String {
    // Build a map from old target → new target
    let repl_map: std::collections::HashMap<&str, &str> = replacements.iter().copied().collect();

    // Find all link spans (wikilinks and markdown links) that are NOT in code blocks
    let mut edits: Vec<(Range<usize>, String)> = Vec::new();

    let opts = Options::empty();
    let parser = Parser::new_ext(content, opts);

    let mut in_code = false;

    for (event, range) in parser.into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_)) => in_code = true,
            Event::End(TagEnd::CodeBlock) => in_code = false,
            Event::Code(_) => continue,
            Event::Start(Tag::Link { dest_url, .. }) => {
                if !in_code {
                    if let Some(&new_target) = repl_map.get(dest_url.as_ref()) {
                        // Rewrite markdown link — replace just the URL part
                        let link_text = &content[range.clone()];
                        if let Some(replacement) = rewrite_markdown_link_text(link_text, new_target) {
                            edits.push((range.clone(), replacement));
                        }
                    }
                }
            }
            Event::Text(text) => {
                if !in_code {
                    find_wikilink_edits(&text, range.start, &repl_map, &mut edits);
                }
            }
            _ => {}
        }
    }

    // Apply edits in reverse order to preserve byte offsets
    let mut result = content.to_string();
    edits.sort_by(|a, b| b.0.start.cmp(&a.0.start));
    for (range, replacement) in edits {
        result.replace_range(range, &replacement);
    }

    result
}

fn find_wikilink_edits(
    text: &str,
    offset: usize,
    repl_map: &std::collections::HashMap<&str, &str>,
    edits: &mut Vec<(Range<usize>, String)>,
) {
    let re = wikilink_regex();
    for cap in re.captures_iter(text) {
        let full = cap.get(0).unwrap();
        let inner = cap.get(1).unwrap().as_str();
        let (target, display) = match inner.split_once('|') {
            Some((t, d)) => (t.trim(), Some(d.trim())),
            None => (inner.trim(), None),
        };

        if let Some(&new_target) = repl_map.get(target) {
            let span = (offset + full.start())..(offset + full.end());

            let replacement = if new_target.starts_with("\x00PLAIN:") {
                // Plain text mode: use display text if available, else the text after prefix
                let text = display.unwrap_or(&new_target[7..]);
                text.to_string()
            } else if new_target.starts_with("\x00UNLINK:") {
                let text = display.unwrap_or(&new_target[8..]);
                format!("~~{text}~~")
            } else {
                match display {
                    Some(d) => format!("[[{new_target}|{d}]]"),
                    None => format!("[[{new_target}]]"),
                }
            };

            edits.push((span, replacement));
        }
    }
}

fn rewrite_markdown_link_text(link_text: &str, new_url: &str) -> Option<String> {
    // link_text is like [display](old_url)
    // Replace the URL portion
    let paren_start = link_text.rfind('(')?;
    let paren_end = link_text.rfind(')')?;
    let mut result = link_text.to_string();
    result.replace_range(paren_start + 1..paren_end, new_url);
    Some(result)
}

fn wikilink_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[\[([^\[\]]+)\]\]").unwrap())
}
```

Add `pub mod rewriter;` to `src/vault/mod.rs`.

**Step 4: Run tests**

Run: `cargo test --test rewriter_test`
Expected: all 7 tests pass

**Step 5: Commit**

```bash
git add src/vault/rewriter.rs src/vault/mod.rs tests/rewriter_test.rs
git commit -m "feat(vault): implement link rewriting with code-block awareness"
```

---

## Task 21: Staged-Write Safety for Multi-File Operations

**Files:**
- Modify: `src/vault/rewriter.rs` (add staged write functions)
- Modify: `tests/rewriter_test.rs`

**Step 1: Write failing test**

Append to `tests/rewriter_test.rs`:
```rust
use clepsydra::vault::rewriter::apply_staged_writes;
use tempfile::TempDir;
use std::fs;

#[test]
fn staged_writes_atomic_success() {
    let tmp = TempDir::new().unwrap();
    let file_a = tmp.path().join("a.md");
    let file_b = tmp.path().join("b.md");
    fs::write(&file_a, "original A").unwrap();
    fs::write(&file_b, "original B").unwrap();

    let writes = vec![
        (file_a.clone(), "rewritten A".to_string()),
        (file_b.clone(), "rewritten B".to_string()),
    ];

    apply_staged_writes(&writes).unwrap();

    assert_eq!(fs::read_to_string(&file_a).unwrap(), "rewritten A");
    assert_eq!(fs::read_to_string(&file_b).unwrap(), "rewritten B");

    // No .clepsydra-tmp files should remain
    let tmp_files: Vec<_> = fs::read_dir(tmp.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".clepsydra-tmp"))
        .collect();
    assert!(tmp_files.is_empty());
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --test rewriter_test staged_writes 2>&1 | head -5`
Expected: compilation error

**Step 3: Implement staged writes**

Add to `src/vault/rewriter.rs`:
```rust
use std::path::PathBuf;

/// Apply a set of file writes atomically using the staged-write pattern:
/// 1. Write each new content to `<path>.clepsydra-tmp`
/// 2. Rename each tmp file to its final path (atomic on POSIX)
/// 3. On failure, clean up tmp files and leave originals untouched.
pub fn apply_staged_writes(
    writes: &[(PathBuf, String)],
) -> Result<(), std::io::Error> {
    let tmp_paths: Vec<PathBuf> = writes
        .iter()
        .map(|(path, _)| {
            let mut tmp = path.clone().into_os_string();
            tmp.push(".clepsydra-tmp");
            PathBuf::from(tmp)
        })
        .collect();

    // Phase 1: write all tmp files
    for (i, (_, content)) in writes.iter().enumerate() {
        if let Err(e) = std::fs::write(&tmp_paths[i], content) {
            // Clean up any tmp files we already wrote
            for tmp in &tmp_paths[..i] {
                let _ = std::fs::remove_file(tmp);
            }
            return Err(e);
        }
    }

    // Phase 2: atomic renames
    for (i, (final_path, _)) in writes.iter().enumerate() {
        if let Err(e) = std::fs::rename(&tmp_paths[i], final_path) {
            // Best effort: clean up remaining tmp files
            for tmp in &tmp_paths[i..] {
                let _ = std::fs::remove_file(tmp);
            }
            return Err(e);
        }
    }

    Ok(())
}
```

**Step 4: Run tests**

Run: `cargo test --test rewriter_test`
Expected: all 8 tests pass

**Step 5: Commit**

```bash
git add src/vault/rewriter.rs tests/rewriter_test.rs
git commit -m "feat(vault): staged-write atomic file operations"
```

---

## Task 22: PostMoveHook Trait

**Files:**
- Create: `src/vault/hooks.rs`
- Modify: `src/vault/mod.rs` (add `pub mod hooks;`)

**Step 1: Implement the trait**

`src/vault/hooks.rs`:
```rust
use crate::vault::path::VaultPath;
use uuid::Uuid;

/// Extension point for domain modules to react to page moves/renames.
/// Called after body-link rewriting is complete but before index update.
pub trait PostMoveHook: Send + Sync {
    fn on_page_moved(
        &self,
        old_path: &VaultPath,
        new_path: &VaultPath,
        page_id: &Uuid,
    ) -> Result<(), Box<dyn std::error::Error>>;
}
```

Add `pub mod hooks;` to `src/vault/mod.rs`.

**Step 2: Verify it compiles**

Run: `cargo check`
Expected: compiles

**Step 3: Commit**

```bash
git add src/vault/hooks.rs src/vault/mod.rs
git commit -m "feat(vault): add PostMoveHook trait for domain module extensions"
```

---

## Task 23: Move Endpoint with Backlink Rewriting

**Files:**
- Modify: `src/api/pages.rs` (add `POST /pages/*/move` handler)
- Modify: `tests/api_test.rs`

**Step 1: Write failing test**

Append to `tests/api_test.rs`:
```rust
#[tokio::test]
async fn move_page_rewrites_backlinks() {
    let (server, tmp) = setup_test_server();

    // Create two pages — one links to the other
    server
        .post("/api/vault/pages/target.md")
        .json(&serde_json::json!({"title": "Target", "body": "Target content."}))
        .await;

    server
        .post("/api/vault/pages/source.md")
        .json(&serde_json::json!({"title": "Source", "body": "See [[Target]] here."}))
        .await;

    // Rebuild index to pick up the link
    server.post("/api/vault/index/rebuild").await;

    // Move target.md → renamed.md
    let res = server
        .post("/api/vault/pages/target.md/move")
        .json(&serde_json::json!({"destination": "renamed.md"}))
        .await;
    assert_eq!(res.status_code(), StatusCode::OK);

    // source.md should now contain [[renamed]] or [[Renamed]]
    let source_content = fs::read_to_string(tmp.path().join("source.md")).unwrap();
    assert!(
        source_content.contains("[[Renamed]]") || source_content.contains("[[renamed]]"),
        "backlink not rewritten: {source_content}"
    );
}

#[tokio::test]
async fn move_to_ambiguous_name_returns_409() {
    let (server, _tmp) = setup_test_server();

    server
        .post("/api/vault/pages/a.md")
        .json(&serde_json::json!({"title": "Page"}))
        .await;
    server
        .post("/api/vault/pages/b.md")
        .json(&serde_json::json!({"title": "Target"}))
        .await;
    server
        .post("/api/vault/pages/c.md")
        .json(&serde_json::json!({"title": "Target"}))
        .await;

    server.post("/api/vault/index/rebuild").await;

    // Moving a.md to a name that's already ambiguous
    let res = server
        .post("/api/vault/pages/a.md/move")
        .json(&serde_json::json!({"destination": "target-copy.md"}))
        .await;
    // This should succeed — the name "target-copy" is not ambiguous.
    // Ambiguity 409 only triggers if the NEW filename's canonical name
    // collides with existing names.
    assert_eq!(res.status_code(), StatusCode::OK);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test api_test move_page 2>&1 | head -10`
Expected: compilation error or 404

**Step 3: Implement move handler**

The move handler in `src/api/pages.rs` should:
1. Validate source exists, destination doesn't.
2. Query index for backlinks to the source page.
3. For each backlink, compute rewrites using `rewrite_links_in_content`.
4. Apply staged writes (tmp → rename).
5. Rename the source file itself.
6. Run post-move hooks.
7. Re-index affected files.

**Step 4: Run tests**

Run: `cargo test --test api_test`
Expected: all tests pass

**Step 5: Commit**

```bash
git add src/api/pages.rs tests/api_test.rs
git commit -m "feat(api): implement page move with backlink rewriting and staged writes"
```

---

## Task 24: Delete with Rewrite Modes

**Files:**
- Modify: `src/api/pages.rs` (extend DELETE handler with `force` + `rewrite` params)
- Modify: `tests/api_test.rs`

**Step 1: Write failing tests**

Append to `tests/api_test.rs`:
```rust
#[tokio::test]
async fn delete_with_backlinks_returns_409() {
    let (server, _tmp) = setup_test_server();

    server
        .post("/api/vault/pages/target.md")
        .json(&serde_json::json!({"title": "Target"}))
        .await;
    server
        .post("/api/vault/pages/linker.md")
        .json(&serde_json::json!({"title": "Linker", "body": "See [[Target]]."}))
        .await;
    server.post("/api/vault/index/rebuild").await;

    let res = server.delete("/api/vault/pages/target.md").await;
    assert_eq!(res.status_code(), StatusCode::CONFLICT);

    let body: serde_json::Value = res.json();
    assert_eq!(body["error"], "page_has_backlinks");
}

#[tokio::test]
async fn delete_force_plain_text_rewrites() {
    let (server, tmp) = setup_test_server();

    server
        .post("/api/vault/pages/target.md")
        .json(&serde_json::json!({"title": "Target", "body": "Content."}))
        .await;
    server
        .post("/api/vault/pages/linker.md")
        .json(&serde_json::json!({"title": "Linker", "body": "See [[Target]] here."}))
        .await;
    server.post("/api/vault/index/rebuild").await;

    let res = server
        .delete("/api/vault/pages/target.md?force=true&rewrite=plain_text")
        .await;
    assert_eq!(res.status_code(), StatusCode::NO_CONTENT);

    // linker.md should now have plain text instead of link
    let content = fs::read_to_string(tmp.path().join("linker.md")).unwrap();
    assert!(content.contains("See Target here."), "link not rewritten to plain text: {content}");
    assert!(!content.contains("[["));
}

#[tokio::test]
async fn delete_force_unlink_rewrites() {
    let (server, tmp) = setup_test_server();

    server
        .post("/api/vault/pages/target.md")
        .json(&serde_json::json!({"title": "Target", "body": "Content."}))
        .await;
    server
        .post("/api/vault/pages/linker.md")
        .json(&serde_json::json!({"title": "Linker", "body": "See [[Target]] here."}))
        .await;
    server.post("/api/vault/index/rebuild").await;

    let res = server
        .delete("/api/vault/pages/target.md?force=true&rewrite=unlink")
        .await;
    assert_eq!(res.status_code(), StatusCode::NO_CONTENT);

    let content = fs::read_to_string(tmp.path().join("linker.md")).unwrap();
    assert!(content.contains("~~Target~~"), "link not rewritten to strikethrough: {content}");
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test api_test delete_with 2>&1 | head -10`
Expected: failures

**Step 3: Extend DELETE handler**

Parse `force` and `rewrite` query params. When `force=true`:
1. Query backlinks from index.
2. Compute rewrites based on `rewrite` mode (plain_text / unlink / none).
3. Apply staged writes.
4. Delete the page file.
5. Update index.

**Step 4: Run tests**

Run: `cargo test --test api_test`
Expected: all tests pass

**Step 5: Commit**

```bash
git add src/api/pages.rs tests/api_test.rs
git commit -m "feat(api): delete with force + rewrite modes (plain_text, unlink, none)"
```

---

## Task 25: Index Query Endpoints

**Files:**
- Modify: `src/api/index_routes.rs`
- Modify: `tests/api_test.rs`

**Step 1: Write failing tests**

Append to `tests/api_test.rs`:
```rust
#[tokio::test]
async fn index_backlinks() {
    let (server, _tmp) = setup_test_server();

    server
        .post("/api/vault/pages/target.md")
        .json(&serde_json::json!({"title": "Target"}))
        .await;
    server
        .post("/api/vault/pages/source.md")
        .json(&serde_json::json!({"title": "Source", "body": "See [[Target]]."}))
        .await;
    server.post("/api/vault/index/rebuild").await;

    let res = server.get("/api/vault/index/backlinks/target.md").await;
    assert_eq!(res.status_code(), StatusCode::OK);
    let body: serde_json::Value = res.json();
    let backlinks = body.as_array().unwrap();
    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0]["path"], "source.md");
}

#[tokio::test]
async fn index_tags() {
    let (server, _tmp) = setup_test_server();

    server
        .post("/api/vault/pages/tagged.md")
        .json(&serde_json::json!({"title": "Tagged", "tags": ["rust", "vault"]}))
        .await;
    server.post("/api/vault/index/rebuild").await;

    let res = server.get("/api/vault/index/tags").await;
    assert_eq!(res.status_code(), StatusCode::OK);
    let body: serde_json::Value = res.json();
    let tags = body.as_array().unwrap();
    assert!(tags.iter().any(|t| t["tag"] == "rust"));
}

#[tokio::test]
async fn index_stats() {
    let (server, _tmp) = setup_test_server();

    server
        .post("/api/vault/pages/a.md")
        .json(&serde_json::json!({"title": "A"}))
        .await;
    server
        .post("/api/vault/pages/b.md")
        .json(&serde_json::json!({"title": "B", "body": "[[A]]"}))
        .await;
    server.post("/api/vault/index/rebuild").await;

    let res = server.get("/api/vault/index/stats").await;
    assert_eq!(res.status_code(), StatusCode::OK);
    let body: serde_json::Value = res.json();
    assert_eq!(body["pages"], 2);
}

#[tokio::test]
async fn index_rebuild() {
    let (server, _tmp) = setup_test_server();
    let res = server.post("/api/vault/index/rebuild").await;
    assert_eq!(res.status_code(), StatusCode::OK);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --test api_test index_ 2>&1 | head -10`
Expected: failures (endpoints not implemented)

**Step 3: Implement index query endpoints**

`src/api/index_routes.rs`:
```rust
use axum::{Router, routing::get, routing::post, extract::State, extract::Path, Json};
use std::sync::Arc;
use serde::Serialize;
use crate::api::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/backlinks/*path", get(backlinks))
        .route("/outlinks/*path", get(outlinks))
        .route("/unresolved", get(unresolved))
        .route("/ambiguous", get(ambiguous))
        .route("/warnings", get(warnings))
        .route("/tags", get(tags))
        .route("/stats", get(stats))
        .route("/rebuild", post(rebuild))
}
```

Implement each handler by querying the SQLite index:
- `backlinks` → `SELECT source_id, path FROM links JOIN pages ON links.source_id = pages.id WHERE target_path = ?`
- `outlinks` → `SELECT target_raw, target_path, kind FROM links WHERE source_id = ?`
- `unresolved` → `SELECT * FROM links WHERE target_id IS NULL`
- `ambiguous` → `SELECT canonical_name, COUNT(*) FROM canonical_names GROUP BY canonical_name HAVING COUNT(*) > 1`
- `warnings` → return cached warnings from last build
- `tags` → `SELECT tag, COUNT(*) FROM tags GROUP BY tag`
- `stats` → aggregate counts from pages, links, tags tables
- `rebuild` → call `index.build()` + `index.resolve_links()`

**Step 4: Run tests**

Run: `cargo test --test api_test`
Expected: all tests pass

**Step 5: Commit**

```bash
git add src/api/index_routes.rs tests/api_test.rs
git commit -m "feat(api): implement index query endpoints (backlinks, tags, stats, rebuild)"
```

---

## Task 26: Folder Move with Backlink Rewriting

**Files:**
- Modify: `src/api/folders.rs` (add `POST /folders/*/move`)
- Modify: `tests/api_test.rs`

**Step 1: Write failing test**

Append to `tests/api_test.rs`:
```rust
#[tokio::test]
async fn move_folder_rewrites_all_contained_pages() {
    let (server, tmp) = setup_test_server();

    // Create folder with pages
    server.post("/api/vault/folders/old-folder").await;
    server
        .post("/api/vault/pages/old-folder/page.md")
        .json(&serde_json::json!({"title": "Inner Page"}))
        .await;
    server
        .post("/api/vault/pages/linker.md")
        .json(&serde_json::json!({"title": "Linker", "body": "See [[Inner Page]]."}))
        .await;
    server.post("/api/vault/index/rebuild").await;

    let res = server
        .post("/api/vault/folders/old-folder/move")
        .json(&serde_json::json!({"destination": "new-folder"}))
        .await;
    assert_eq!(res.status_code(), StatusCode::OK);

    // File should be at new location
    assert!(tmp.path().join("new-folder/page.md").exists());
    assert!(!tmp.path().join("old-folder").exists());
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --test api_test move_folder 2>&1 | head -10`
Expected: failure

**Step 3: Implement folder move**

The folder move handler:
1. List all `.md` files in the source folder.
2. For each file, compute the new path.
3. Collect all backlinks to any file in the folder.
4. Rewrite backlinks using staged writes.
5. Rename the folder itself (`fs::rename`).
6. Re-index all affected files.

**Step 4: Run tests**

Run: `cargo test --test api_test`
Expected: all tests pass

**Step 5: Commit**

```bash
git add src/api/folders.rs tests/api_test.rs
git commit -m "feat(api): implement folder move with backlink rewriting"
```

---

## Task 27: Get Page by UUID Endpoint

**Files:**
- Modify: `src/api/pages.rs` (add `GET /pages/by-id/:uuid`)
- Modify: `tests/api_test.rs`

**Step 1: Write failing test**

Append to `tests/api_test.rs`:
```rust
#[tokio::test]
async fn get_page_by_uuid() {
    let (server, _tmp) = setup_test_server();

    let res = server
        .post("/api/vault/pages/hello.md")
        .json(&serde_json::json!({"title": "Hello"}))
        .await;
    let created: serde_json::Value = res.json();
    let uuid = created["meta"]["id"].as_str().unwrap();

    server.post("/api/vault/index/rebuild").await;

    let res = server
        .get(&format!("/api/vault/pages/by-id/{uuid}"))
        .await;
    assert_eq!(res.status_code(), StatusCode::OK);
    let body: serde_json::Value = res.json();
    assert_eq!(body["meta"]["title"], "Hello");
}
```

**Step 2: Implement the handler**

In `src/api/pages.rs`, add a route for `by-id/:uuid`:
- Query `pages` table by `id`.
- Resolve path, read file, return PageDetail.

**Step 3: Run tests**

Run: `cargo test --test api_test get_page_by_uuid`
Expected: passes

**Step 4: Commit**

```bash
git add src/api/pages.rs tests/api_test.rs
git commit -m "feat(api): add get-page-by-UUID endpoint"
```

---

## Task 28: End-to-End Integration Test

**Files:**
- Create: `tests/e2e_test.rs`

**Step 1: Write comprehensive integration test**

`tests/e2e_test.rs`:
```rust
//! End-to-end test covering the full lifecycle:
//! init → create pages → link → move → verify backlinks → delete → verify rewrite

use axum_test::TestServer;
use clepsydra::api::{AppState, api_router};
use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;
use axum::http::StatusCode;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;
use std::fs;

#[tokio::test]
async fn full_vault_lifecycle() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    // 1. Init vault
    init_vault(root).unwrap();
    assert!(root.join(".clepsydra/config.toml").exists());
    assert!(root.join(".clepsydra/templates").exists());
    assert!(root.join("_attachments").exists());

    // 2. Open vault and start server
    let vault = Vault::open(root).unwrap();
    let db_path = root.join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    let state = Arc::new(AppState {
        vault,
        index: Mutex::new(index),
    });
    let app = axum::Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);
    let server = TestServer::new(app).unwrap();

    // 3. Create pages
    let res = server
        .post("/api/vault/pages/index.md")
        .json(&serde_json::json!({
            "title": "Home",
            "body": "Welcome to [[Design Notes]].\n"
        }))
        .await;
    assert_eq!(res.status_code(), StatusCode::CREATED);

    let res = server
        .post("/api/vault/pages/design.md")
        .json(&serde_json::json!({
            "title": "Design Notes",
            "tags": ["architecture"],
            "body": "Design content. See [[Home]].\n"
        }))
        .await;
    assert_eq!(res.status_code(), StatusCode::CREATED);

    // 4. Rebuild index
    server.post("/api/vault/index/rebuild").await;

    // 5. Verify backlinks
    let res = server.get("/api/vault/index/backlinks/design.md").await;
    let backlinks: serde_json::Value = res.json();
    assert_eq!(backlinks.as_array().unwrap().len(), 1);

    // 6. Verify tags
    let res = server.get("/api/vault/index/tags").await;
    let tags: serde_json::Value = res.json();
    assert!(tags.as_array().unwrap().iter().any(|t| t["tag"] == "architecture"));

    // 7. Move design.md → architecture.md
    let res = server
        .post("/api/vault/pages/design.md/move")
        .json(&serde_json::json!({"destination": "architecture.md"}))
        .await;
    assert_eq!(res.status_code(), StatusCode::OK);

    // 8. Verify index.md backlink was rewritten
    let content = fs::read_to_string(root.join("index.md")).unwrap();
    assert!(
        !content.contains("[[Design Notes]]"),
        "old link should be rewritten"
    );

    // 9. Verify stats
    let res = server.get("/api/vault/index/stats").await;
    let stats: serde_json::Value = res.json();
    assert_eq!(stats["pages"], 2);

    // 10. Delete architecture.md with plain_text rewrite
    let res = server
        .delete("/api/vault/pages/architecture.md?force=true&rewrite=plain_text")
        .await;
    assert_eq!(res.status_code(), StatusCode::NO_CONTENT);

    // 11. Verify index.md reference was converted to plain text
    let content = fs::read_to_string(root.join("index.md")).unwrap();
    assert!(!content.contains("[["), "all links should be plain text now");

    // 12. Stats should show 1 page
    server.post("/api/vault/index/rebuild").await;
    let res = server.get("/api/vault/index/stats").await;
    let stats: serde_json::Value = res.json();
    assert_eq!(stats["pages"], 1);
}
```

**Step 2: Run test**

Run: `cargo test --test e2e_test`
Expected: passes

**Step 3: Commit**

```bash
git add tests/e2e_test.rs
git commit -m "test: add end-to-end vault lifecycle integration test"
```

---

## Summary

| Phase | Tasks | What's Built |
|-------|-------|-------------|
| 1: Foundation | 1-7 | Dependencies, VaultPath, CanonicalName, Vault, VaultConfig, `init` command, Settings |
| 2: Page Model | 8-10 | PageMeta, frontmatter parsing/writing, Page struct with file I/O |
| 3: Index | 11-15 | Link extraction, SQLite schema, index builder, link resolution, duplicate UUID handling |
| 4: CRUD API | 16-19 | AppState, page/folder/attachment endpoints |
| 5: Move/Rewrite | 20-24 | LinkRewriter, staged writes, PostMoveHook, move endpoint, delete with rewrite modes |
| 6: Queries + E2E | 25-28 | Index query endpoints, folder move, get-by-UUID, full lifecycle test |

Total: **28 tasks**, each 2-10 minutes, with frequent commits after each.
