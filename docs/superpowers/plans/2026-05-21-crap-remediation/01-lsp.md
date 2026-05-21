# Slice 01 — LSP Layer CRAP Remediation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Read `00-overview.md` first — §3 (test conventions) and §5 (validation loop) are assumed here and not repeated.

**Goal:** Remove all ten `src/lsp/mod.rs` methods from the CRAP failure list by extracting their pure logic into testable submodules and adding unit + adapter tests, taking `src/lsp/mod.rs` from 0% coverage to ≥70% line coverage.

**Architecture:** `LspBackend` stays a thin tower-lsp adapter. Pure logic (range/URI/edit/diagnostic computation and the duplicated canonical-name SQL) moves into focused modules: `queries.rs`, `hover.rs`, `references.rs`, `code_action.rs`, `diagnostics.rs`, plus extensions to the existing `rename.rs` and `document.rs`. Tests are in-crate (`#[cfg(test)]`) so they can construct a `Client` and `AppState` directly.

**Tech Stack:** tower-lsp, rusqlite, ropey, tokio, `tempfile` (dev-dep, already present).

**Targets (from `00-overview.md` table):** #1 rename, #4 references, #5 code_action, #6 prepare_rename, #8 hover, #12 goto_definition, #15 did_save, #16 completion, #17 publish_diagnostics_for, #22 backlink_to_range.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/lsp/test_support.rs` | `#[cfg(test)]` harness: `test_client()`, `make_backend()`, `open_doc()` | Create |
| `src/lsp/queries.rs` | `canonical_to_vault_path` (the shared canonical→path lookup) | Create |
| `src/lsp/hover.rs` | `format_hover_resolved`, `format_hover_unresolved`, `extract_preview` | Create |
| `src/lsp/references.rs` | `vault_path_to_location` | Create |
| `src/lsp/code_action.rs` | `build_create_page_action`, `build_disambiguate_actions` | Create |
| `src/lsp/diagnostics.rs` | `compute_link_diagnostics` | Create |
| `src/lsp/document.rs` | add `body_span_to_range` | Modify |
| `src/lsp/rename.rs` | add `compute_new_vault_path`, `full_document_range`, `frontmatter_title_rename_range`, `fetch_canonical_names_for_path`, `find_referring_paths`, `build_wikilink_text_edits` | Modify |
| `src/lsp/mod.rs` | thin adapters; `pub(crate)` on `refresh_canonical_names`/`uri_to_vault_path`; module decls; `#[cfg(test)] mod tests` adapter tests | Modify |

---

## Task 1: Test harness

**Files:**
- Create: `src/lsp/test_support.rs`
- Modify: `src/lsp/mod.rs` (add module decls; widen two private fns)

- [ ] **Step 1: Widen visibility of the two helpers the harness needs**

In `src/lsp/mod.rs`, change the signatures at lines 1166 and 1177:

```rust
// was: fn uri_to_vault_path(&self, uri: &Url) -> Option<crate::vault::path::VaultPath>
pub(crate) fn uri_to_vault_path(&self, uri: &Url) -> Option<crate::vault::path::VaultPath>

// was: async fn refresh_canonical_names(&self)
pub(crate) async fn refresh_canonical_names(&self)
```

- [ ] **Step 2: Add module declarations to `src/lsp/mod.rs`**

After the existing `pub mod symbols;` (line 4), add:

```rust
pub mod code_action;
pub mod diagnostics;
pub mod hover;
pub mod queries;
pub mod references;

#[cfg(test)]
pub(crate) mod test_support;
```

- [ ] **Step 3: Write the harness**

Create `src/lsp/test_support.rs`:

```rust
//! Shared `#[cfg(test)]` helpers for driving `LspBackend` against a temp vault.
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use tempfile::TempDir;
use tokio::sync::{Mutex, RwLock, broadcast};
use tower_lsp::lsp_types::*;
use tower_lsp::{Client, LanguageServer, LspService};
use tower_lsp::jsonrpc::Result as JsonRpcResult;

use crate::api::AppState;
use crate::lsp::LspBackend;
use crate::lsp::document::Document;
use crate::vault::Vault;
use crate::vault::cas::ContentStore;
use crate::vault::index::VaultIndex;
use crate::vault::index_handle::IndexHandle;
use crate::vault::init::init_vault;

/// Minimal `LanguageServer` impl whose only purpose is to let `LspService::new`
/// hand us a live `Client` we can clone out.
struct ClientHolder {
    #[allow(dead_code)]
    client: Client,
}

#[tower_lsp::async_trait]
impl LanguageServer for ClientHolder {
    async fn initialize(&self, _: InitializeParams) -> JsonRpcResult<InitializeResult> {
        Ok(InitializeResult::default())
    }
    async fn shutdown(&self) -> JsonRpcResult<()> {
        Ok(())
    }
}

/// Construct a live `Client` for tests. tower-lsp does not expose a public
/// `Client` constructor, so we capture it from a throwaway service.
pub(crate) fn test_client() -> Client {
    let slot: Arc<OnceLock<Client>> = Arc::new(OnceLock::new());
    let slot2 = slot.clone();
    let (_service, _socket) = LspService::new(move |client| {
        let _ = slot2.set(client.clone());
        ClientHolder { client }
    });
    slot.get().expect("client captured by factory").clone()
}

/// Build an `LspBackend` over a fresh temp vault containing `files`
/// (relative path, contents). The index is built and links resolved.
pub(crate) fn make_backend(files: &[(&str, &str)]) -> (LspBackend, TempDir) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    for (rel, contents) in files {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, contents).unwrap();
    }

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let cas = ContentStore::open(&tmp.path().join("cas")).unwrap();
    let index_handle = IndexHandle::spawn(index, vault.clone());
    let (change_tx, _rx) = broadcast::channel(64);

    let state = Arc::new(AppState {
        vault,
        index: index_handle,
        cas: Arc::new(parking_lot::Mutex::new(cas)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: Arc::new(vec![]),
        delete_hooks: Arc::new(vec![]),
        archive_ingest_lock: tokio::sync::Mutex::new(()),
        bcl: None,
        location: None,
    });

    let backend = LspBackend {
        client: test_client(),
        state,
        documents: Mutex::new(HashMap::new()),
        canonical_names: Arc::new(RwLock::new(HashMap::new())),
    };
    (backend, tmp)
}

/// File URI for a vault-relative path under the backend's vault root.
pub(crate) fn uri_for(backend: &LspBackend, rel: &str) -> Url {
    Url::from_file_path(backend.state.vault.root().join(rel)).unwrap()
}

/// Open `text` as a document at `uri` and refresh the canonical-name cache.
pub(crate) async fn open_doc(backend: &LspBackend, uri: &Url, text: &str) {
    backend.refresh_canonical_names().await;
    let mut docs = backend.documents.lock().await;
    docs.insert(uri.clone(), Document::from_text(text, 1));
}
```

- [ ] **Step 4: Add a smoke test that constructs the backend**

In `src/lsp/mod.rs`, add at the end of the file:

```rust
#[cfg(test)]
mod tests {
    use super::test_support::*;
    use tower_lsp::lsp_types::*;
    use tower_lsp::LanguageServer;

    #[tokio::test]
    async fn backend_constructs_and_opens_a_document() {
        let (backend, _tmp) = make_backend(&[("Note.md", "# Note\n\nbody\n")]);
        let uri = uri_for(&backend, "Note.md");
        open_doc(&backend, &uri, "# Note\n\nbody\n").await;
        let docs = backend.documents.lock().await;
        assert!(docs.contains_key(&uri));
    }
}
```

- [ ] **Step 5: Run and commit**

Run: `cargo test --lib lsp::tests::backend_constructs_and_opens_a_document`
Expected: PASS

```bash
git add src/lsp/test_support.rs src/lsp/mod.rs
git commit -m "test(lsp): add in-crate LspBackend test harness"
```

---

## Task 2: `canonical_to_vault_path` + `goto_definition` (#12)

The SQL `SELECT p.path FROM canonical_names cn JOIN pages p ON cn.page_id = p.id WHERE cn.canonical_name = ?1` is duplicated in `goto_definition` (line ~200), `hover` (~256), `references` (~360), and `rename` (~665/673). Extract it once.

**Files:**
- Create: `src/lsp/queries.rs`
- Modify: `src/lsp/mod.rs` (goto_definition, line 170; add `pub mod queries;` already done in Task 1)

- [ ] **Step 1: Write the failing test**

Create `src/lsp/queries.rs`:

```rust
//! Shared index queries used by multiple LSP request handlers.
use crate::vault::index_handle::IndexHandle;

/// Resolve a canonical name to the vault path of the first matching page.
/// Returns `None` if there is no match or the query fails (matching the
/// previous inline `.ok()` behavior).
pub async fn canonical_to_vault_path(index: &IndexHandle, canonical: &str) -> Option<String> {
    let canonical = canonical.to_string();
    index
        .with_index(move |idx, _vault| {
            idx.connection()
                .query_row(
                    "SELECT p.path FROM canonical_names cn \
                     JOIN pages p ON cn.page_id = p.id \
                     WHERE cn.canonical_name = ?1",
                    rusqlite::params![canonical],
                    |row| row.get::<_, String>(0),
                )
                .ok()
        })
        .await
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::test_support::make_backend;

    #[tokio::test]
    async fn resolves_known_canonical_name() {
        let (backend, _tmp) = make_backend(&[
            ("Target.md", "---\ntitle: Target\n---\nbody\n"),
        ]);
        let path = canonical_to_vault_path(&backend.state.index, "target").await;
        assert_eq!(path.as_deref(), Some("Target.md"));
    }

    #[tokio::test]
    async fn unknown_name_returns_none() {
        let (backend, _tmp) = make_backend(&[("Target.md", "# Target\n")]);
        assert!(canonical_to_vault_path(&backend.state.index, "nope").await.is_none());
    }
}
```

> Note: confirm the canonical form (`"target"` vs `"Target"`) against `CanonicalName::from_title` when the test first runs; adjust the expected key to the actual canonical string. The assertion on the resolved *path* is the invariant.

- [ ] **Step 2: Run to verify it fails to compile / fails**

Run: `cargo test --lib lsp::queries::tests`
Expected: FAIL (or compile error until the module body above is in place — it is, so expect PASS on the query but verify the canonical key; fix the expected key if needed).

- [ ] **Step 3: Refactor `goto_definition` to use the helper**

In `src/lsp/mod.rs` `goto_definition` (lines 170–229), replace the inline `with_index(... query_row ...)` block that maps a link's canonical target to a path with:

```rust
let target_path = crate::lsp::queries::canonical_to_vault_path(&self.state.index, &canonical).await;
```

Keep the surrounding link lookup and the `VaultPath::new` / `Url::from_file_path` → `GotoDefinitionResponse::Scalar` construction unchanged.

- [ ] **Step 4: Add the adapter test**

In `src/lsp/mod.rs` `mod tests`, add:

```rust
#[tokio::test]
async fn goto_definition_resolves_wikilink() {
    let (backend, _tmp) = make_backend(&[
        ("Source.md", "# Source\n\nsee [[Target]]\n"),
        ("Target.md", "# Target\n"),
    ]);
    let uri = uri_for(&backend, "Source.md");
    open_doc(&backend, &uri, "# Source\n\nsee [[Target]]\n").await;

    // Position inside the `[[Target]]` link on line 2.
    let params = GotoDefinitionParams {
        text_document_position_params: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            position: Position { line: 2, character: 8 },
        },
        work_done_progress_params: Default::default(),
        partial_result_params: Default::default(),
    };
    let resp = backend.goto_definition(params).await.unwrap();
    let Some(GotoDefinitionResponse::Scalar(loc)) = resp else {
        panic!("expected a scalar location, got {resp:?}");
    };
    assert!(loc.uri.path().ends_with("Target.md"));
}
```

- [ ] **Step 5: Run and commit**

Run: `cargo test --lib lsp::queries::tests lsp::tests::goto_definition_resolves_wikilink`
Expected: PASS

```bash
git add src/lsp/queries.rs src/lsp/mod.rs
git commit -m "refactor(lsp): extract canonical_to_vault_path; cover goto_definition"
```

---

## Task 3: `hover` helpers + adapter (#8)

**Files:**
- Create: `src/lsp/hover.rs`
- Modify: `src/lsp/mod.rs` (hover, line 231)

- [ ] **Step 1: Write the failing tests**

Create `src/lsp/hover.rs`:

```rust
//! Pure hover-content formatting helpers.

/// Markdown shown when hovering a link that resolves to a page.
pub fn format_hover_resolved(path: &str, title: Option<&str>, preview: &str) -> String {
    let display_title = title.unwrap_or(path);
    format!("**{display_title}**\n\n`{path}`\n\n---\n\n{preview}")
}

/// Markdown shown when hovering a link with no resolvable target.
pub fn format_hover_unresolved(target_raw: &str) -> String {
    format!("Unresolved link: `{target_raw}`")
}

/// First `max_lines` non-frontmatter body lines, joined with newlines.
pub fn extract_preview(content: &str, max_lines: usize) -> String {
    content
        .lines()
        .take(max_lines)
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_uses_title_when_present() {
        let s = format_hover_resolved("A.md", Some("Alpha"), "preview");
        assert!(s.contains("**Alpha**"));
        assert!(s.contains("`A.md`"));
        assert!(s.contains("preview"));
    }

    #[test]
    fn resolved_falls_back_to_path() {
        let s = format_hover_resolved("A.md", None, "p");
        assert!(s.contains("**A.md**"));
    }

    #[test]
    fn unresolved_mentions_target() {
        assert!(format_hover_unresolved("Ghost").contains("Ghost"));
    }

    #[test]
    fn preview_truncates_to_max_lines() {
        let p = extract_preview("a\nb\nc\nd", 2);
        assert_eq!(p, "a\nb");
    }
}
```

> Note: match `format_hover_resolved`'s exact format string to the current inline `format!` in `hover` (lines ~289–296) so the rendered hover is byte-identical. Adjust the literal above if the source differs (e.g. heading vs. bold), then update the test assertions to match.

- [ ] **Step 2: Run to verify**

Run: `cargo test --lib lsp::hover::tests`
Expected: PASS

- [ ] **Step 3: Refactor `hover`**

In `src/lsp/mod.rs` `hover` (231–302): replace the inline canonical→path lookup with `queries::canonical_to_vault_path`; replace the inline `format!` for the resolved case with `hover::format_hover_resolved(&path, title.as_deref(), &preview)`, the preview computation with `hover::extract_preview(&content, N)` (use the current line count `N`), and the unresolved branch with `hover::format_hover_unresolved(&target_raw)`.

- [ ] **Step 4: Add the adapter test**

In `mod tests`:

```rust
#[tokio::test]
async fn hover_renders_resolved_target_title() {
    let (backend, _tmp) = make_backend(&[
        ("Src.md", "# Src\n\n[[Target]]\n"),
        ("Target.md", "---\ntitle: Target Page\n---\nhello world\n"),
    ]);
    let uri = uri_for(&backend, "Src.md");
    open_doc(&backend, &uri, "# Src\n\n[[Target]]\n").await;
    let params = HoverParams {
        text_document_position_params: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            position: Position { line: 2, character: 4 },
        },
        work_done_progress_params: Default::default(),
    };
    let hover = backend.hover(params).await.unwrap().expect("hover present");
    let HoverContents::Markup(MarkupContent { value, .. }) = hover.contents else {
        panic!("expected markup hover");
    };
    assert!(value.contains("Target Page"));
}
```

- [ ] **Step 5: Run and commit**

Run: `cargo test --lib lsp::hover lsp::tests::hover_renders_resolved_target_title`
Expected: PASS

```bash
git add src/lsp/hover.rs src/lsp/mod.rs
git commit -m "refactor(lsp): extract hover formatting; cover hover"
```

---

## Task 4: `completion` adapter coverage (#16)

`completion` is already thin (it dispatches to `completion::wikilink_prefix`/`tag_prefix`). It only needs to be exercised.

**Files:** Modify `src/lsp/mod.rs` (test only)

- [ ] **Step 1: Write the failing test**

In `mod tests`:

```rust
#[tokio::test]
async fn completion_suggests_wikilink_targets() {
    let (backend, _tmp) = make_backend(&[
        ("Src.md", "# Src\n\n[[Tar\n"),
        ("Target.md", "# Target\n"),
    ]);
    let uri = uri_for(&backend, "Src.md");
    open_doc(&backend, &uri, "# Src\n\n[[Tar\n").await;
    let params = CompletionParams {
        text_document_position: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            position: Position { line: 2, character: 5 },
        },
        work_done_progress_params: Default::default(),
        partial_result_params: Default::default(),
        context: None,
    };
    let resp = backend.completion(params).await.unwrap();
    let items = match resp {
        Some(CompletionResponse::Array(v)) => v,
        Some(CompletionResponse::List(l)) => l.items,
        None => panic!("expected completions"),
    };
    assert!(items.iter().any(|i| i.label.contains("Target")));
}
```

- [ ] **Step 2: Run to verify it passes** (no production change needed)

Run: `cargo test --lib lsp::tests::completion_suggests_wikilink_targets`
Expected: PASS. If it fails because the prefix position is off by one, adjust `character` to land just after `Tar`.

- [ ] **Step 3: Add a no-completion case**

```rust
#[tokio::test]
async fn completion_returns_none_off_a_prefix() {
    let (backend, _tmp) = make_backend(&[("Src.md", "# Src\n\nplain text\n")]);
    let uri = uri_for(&backend, "Src.md");
    open_doc(&backend, &uri, "# Src\n\nplain text\n").await;
    let params = CompletionParams {
        text_document_position: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            position: Position { line: 2, character: 3 },
        },
        work_done_progress_params: Default::default(),
        partial_result_params: Default::default(),
        context: None,
    };
    assert!(backend.completion(params).await.unwrap().is_none());
}
```

- [ ] **Step 4: Run**

Run: `cargo test --lib lsp::tests::completion`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lsp/mod.rs
git commit -m "test(lsp): cover completion handler"
```

---

## Task 5: `compute_link_diagnostics` + `publish_diagnostics_for` + `did_save` (#17, #15)

**Files:**
- Create: `src/lsp/diagnostics.rs`
- Modify: `src/lsp/mod.rs` (publish_diagnostics_for line 1345; optionally `republish_all_diagnostics` helper used by did_open/did_change/did_save)

- [ ] **Step 1: Write the failing test**

Create `src/lsp/diagnostics.rs`:

```rust
//! Pure diagnostic computation for document links.
use std::collections::HashMap;
use std::path::Path;

use tower_lsp::lsp_types::Diagnostic;

use crate::lsp::document::Document;
use crate::vault::link::Link;

/// Compute LSP diagnostics for a document's links given a snapshot of the
/// canonical-name → paths map and the vault root. Pure: no I/O, no `self`.
pub fn compute_link_diagnostics(
    links: &[Link],
    canonical_names: &HashMap<String, Vec<String>>,
    vault_root: &Path,
    doc: &Document,
) -> Vec<Diagnostic> {
    // Move the body of the loop at src/lsp/mod.rs:1349-1408 here verbatim,
    // replacing `self.canonical_names` reads with `canonical_names`,
    // `self.state.vault.root()` with `vault_root`, and using `doc` for
    // `link_to_range`. Return the accumulated Vec<Diagnostic>.
    todo!("port loop body from publish_diagnostics_for")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::document::Document;

    #[test]
    fn unresolved_link_yields_a_diagnostic() {
        let doc = Document::from_text("# A\n\n[[Ghost]]\n", 1);
        let names: HashMap<String, Vec<String>> = HashMap::new();
        let diags = compute_link_diagnostics(&doc.links, &names, Path::new("/v"), &doc);
        assert_eq!(diags.len(), 1);
        assert!(diags[0].message.to_lowercase().contains("unresolved")
            || diags[0].code.is_some());
    }

    #[test]
    fn resolved_link_yields_no_diagnostic() {
        let doc = Document::from_text("# A\n\n[[Target]]\n", 1);
        let mut names = HashMap::new();
        names.insert("target".to_string(), vec!["Target.md".to_string()]);
        let diags = compute_link_diagnostics(&doc.links, &names, Path::new("/v"), &doc);
        assert!(diags.is_empty());
    }

    #[test]
    fn ambiguous_link_yields_a_diagnostic_with_related_info() {
        let doc = Document::from_text("# A\n\n[[Dup]]\n", 1);
        let mut names = HashMap::new();
        names.insert("dup".to_string(), vec!["a/Dup.md".to_string(), "b/Dup.md".to_string()]);
        let diags = compute_link_diagnostics(&doc.links, &names, Path::new("/v"), &doc);
        assert_eq!(diags.len(), 1);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib lsp::diagnostics::tests`
Expected: FAIL — `todo!` panics.

- [ ] **Step 3: Port the loop body**

Replace the `todo!` with the loop from `publish_diagnostics_for` (mod.rs lines 1349–1408), adapting the three field accesses noted in the comment. Then in `publish_diagnostics_for` (1345–1413), replace the loop with:

```rust
let names = self.canonical_names.read().await;
let diagnostics = crate::lsp::diagnostics::compute_link_diagnostics(
    &doc.links, &names, self.state.vault.root(), doc,
);
drop(names);
self.client.publish_diagnostics(uri.clone(), diagnostics, None).await;
```

- [ ] **Step 4: Add the `did_save` adapter test**

`did_save` calls the index then republishes diagnostics; exercising it covers #15.

```rust
#[tokio::test]
async fn did_save_reindexes_and_clears_diagnostics_path() {
    let (backend, _tmp) = make_backend(&[("Note.md", "# Note\n\n[[Note]]\n")]);
    let uri = uri_for(&backend, "Note.md");
    open_doc(&backend, &uri, "# Note\n\n[[Note]]\n").await;
    let params = DidSaveTextDocumentParams {
        text_document: TextDocumentIdentifier { uri: uri.clone() },
        text: None,
    };
    // Should not panic; drives index_page + resolve_links_for_page + republish.
    backend.did_save(params).await;
    let docs = backend.documents.lock().await;
    assert!(!docs.get(&uri).unwrap().dirty);
}
```

- [ ] **Step 5: Run and commit**

Run: `cargo test --lib lsp::diagnostics lsp::tests::did_save_reindexes_and_clears_diagnostics_path`
Expected: PASS

```bash
git add src/lsp/diagnostics.rs src/lsp/mod.rs
git commit -m "refactor(lsp): extract compute_link_diagnostics; cover publish + did_save"
```

---

## Task 6: `body_span_to_range` + `backlink_to_range` (#22)

**Files:**
- Modify: `src/lsp/document.rs` (add method), `src/lsp/mod.rs` (backlink_to_range line 1304)

- [ ] **Step 1: Write the failing test**

In `src/lsp/document.rs`, add inside `impl Document`:

```rust
    /// Convert a pair of body byte offsets to an LSP [`Range`].
    pub fn body_span_to_range(&self, start: usize, end: usize) -> Range {
        Range {
            start: self.byte_offset_to_position(start),
            end: self.byte_offset_to_position(end),
        }
    }
```

And add a test module at the end of `document.rs` (or extend the existing one):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_span_to_range_maps_offsets() {
        let doc = Document::from_text("line one\nline two\n", 1);
        let r = doc.body_span_to_range(0, 4);
        assert_eq!(r.start, Position { line: 0, character: 0 });
        assert_eq!(r.end, Position { line: 0, character: 4 });
    }
}
```

- [ ] **Step 2: Run to verify it passes**

Run: `cargo test --lib lsp::document::tests::body_span_to_range_maps_offsets`
Expected: PASS

- [ ] **Step 3: Refactor `backlink_to_range`**

In `mod.rs` `backlink_to_range` (1304–1338): when the source document is open, replace the two inline `byte_offset_to_position` calls with `doc.body_span_to_range(bl.span_start as usize, bl.span_end as usize)`; in the disk-read fallback, build a throwaway `document::Document::from_text(&content, 0)` and call `body_span_to_range` on it. Keep the negative-span (property ref) guard and the `Range::default()` fallback.

- [ ] **Step 4: Add an adapter test via `references`**

`backlink_to_range` is invoked while building `references` results. Cover it through a references call that crosses pages (this also pre-stages Task 7):

```rust
#[tokio::test]
async fn backlink_to_range_used_in_references() {
    let (backend, _tmp) = make_backend(&[
        ("Target.md", "# Target\n"),
        ("Other.md", "# Other\n\nlink to [[Target]]\n"),
    ]);
    let uri = uri_for(&backend, "Target.md");
    open_doc(&backend, &uri, "# Target\n").await;
    let params = ReferenceParams {
        text_document_position: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            position: Position { line: 0, character: 2 },
        },
        work_done_progress_params: Default::default(),
        partial_result_params: Default::default(),
        context: ReferenceContext { include_declaration: false },
    };
    let refs = backend.references(params).await.unwrap().unwrap_or_default();
    assert!(refs.iter().any(|l| l.uri.path().ends_with("Other.md")));
}
```

- [ ] **Step 5: Run and commit**

Run: `cargo test --lib lsp::document lsp::tests::backlink_to_range_used_in_references`
Expected: PASS

```bash
git add src/lsp/document.rs src/lsp/mod.rs
git commit -m "refactor(lsp): add Document::body_span_to_range; cover backlink_to_range"
```

---

## Task 7: `vault_path_to_location` + `references` (#4)

**Files:**
- Create: `src/lsp/references.rs`
- Modify: `src/lsp/mod.rs` (references line 336)

- [ ] **Step 1: Write the failing test**

Create `src/lsp/references.rs`:

```rust
//! Pure helpers for the `references` request.
use std::path::Path;

use tower_lsp::lsp_types::{Location, Range, Url};

use crate::vault::path::VaultPath;

/// Build a `Location` for a vault path + range, resolving the path against the
/// vault root. Returns `None` if the absolute path is not representable as a
/// `file://` URL.
pub fn vault_path_to_location(vault_root: &Path, vp: &VaultPath, range: Range) -> Option<Location> {
    let abs = vault_root.join(vp.as_str());
    let uri = Url::from_file_path(abs).ok()?;
    Some(Location { uri, range })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_location_for_relative_path() {
        let vp = VaultPath::new("notes/A.md").unwrap();
        let loc = vault_path_to_location(
            Path::new("/vault"),
            &vp,
            Range::default(),
        )
        .unwrap();
        assert!(loc.uri.path().ends_with("notes/A.md"));
    }
}
```

- [ ] **Step 2: Run to verify it passes**

Run: `cargo test --lib lsp::references::tests`
Expected: PASS (confirm `VaultPath::new` accepts `"notes/A.md"`; if it requires NFC/percent handling adjust the input).

- [ ] **Step 3: Refactor `references`**

In `mod.rs` `references` (336–420): replace the inline canonical→path lookup with `queries::canonical_to_vault_path`; in the backlink loop, replace the inline `VaultPath::new(...)` + `Url::from_file_path(...)` + `Location { .. }` construction with `references::vault_path_to_location(self.state.vault.root(), &vp, range)` (using the range from `backlink_to_range`). Keep the empty-result `Ok(None)` branch.

- [ ] **Step 4: Add adapter tests**

The cross-page case is already covered by `backlink_to_range_used_in_references` (Task 6). Add the "link under cursor" path:

```rust
#[tokio::test]
async fn references_from_link_under_cursor() {
    let (backend, _tmp) = make_backend(&[
        ("A.md", "# A\n\n[[Target]]\n"),
        ("Target.md", "# Target\n"),
        ("B.md", "# B\n\n[[Target]]\n"),
    ]);
    let uri = uri_for(&backend, "A.md");
    open_doc(&backend, &uri, "# A\n\n[[Target]]\n").await;
    let params = ReferenceParams {
        text_document_position: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            position: Position { line: 2, character: 4 },
        },
        work_done_progress_params: Default::default(),
        partial_result_params: Default::default(),
        context: ReferenceContext { include_declaration: false },
    };
    let refs = backend.references(params).await.unwrap().unwrap_or_default();
    assert!(refs.iter().any(|l| l.uri.path().ends_with("B.md")));
}
```

- [ ] **Step 5: Run and commit**

Run: `cargo test --lib lsp::references lsp::tests::references_from_link_under_cursor`
Expected: PASS

```bash
git add src/lsp/references.rs src/lsp/mod.rs
git commit -m "refactor(lsp): extract vault_path_to_location; cover references"
```

---

## Task 8: `frontmatter_title_rename_range` + `prepare_rename` (#6)

**Files:**
- Modify: `src/lsp/rename.rs` (add helper + tests), `src/lsp/mod.rs` (prepare_rename line 561)

- [ ] **Step 1: Write the failing test**

In `src/lsp/rename.rs`, add:

```rust
use tower_lsp::lsp_types::{PrepareRenameResponse, Position, Range};

/// If `line_text` is a frontmatter `title:` line, return the rename range +
/// placeholder for the (possibly quoted) title value on `line_number`.
pub fn frontmatter_title_rename_range(
    line_text: &str,
    line_number: u32,
) -> Option<PrepareRenameResponse> {
    let rest = line_text.trim_start().strip_prefix("title:")?;
    let value = rest.trim();
    let unquoted = if (value.starts_with('"') && value.ends_with('"'))
        || (value.starts_with('\'') && value.ends_with('\''))
    {
        &value[1..value.len() - 1]
    } else {
        value
    };
    let start_char = line_text.find(unquoted).unwrap_or(0) as u32;
    Some(PrepareRenameResponse::RangeWithPlaceholder {
        range: Range {
            start: Position { line: line_number, character: start_char },
            end: Position { line: line_number, character: start_char + unquoted.len() as u32 },
        },
        placeholder: unquoted.to_string(),
    })
}
```

And in `rename.rs`'s test module:

```rust
#[test]
fn frontmatter_title_unquoted() {
    let r = frontmatter_title_rename_range("title: My Note", 0).unwrap();
    let PrepareRenameResponse::RangeWithPlaceholder { placeholder, .. } = r else {
        panic!()
    };
    assert_eq!(placeholder, "My Note");
}

#[test]
fn frontmatter_title_double_quoted() {
    let r = frontmatter_title_rename_range("title: \"My Note\"", 3).unwrap();
    let PrepareRenameResponse::RangeWithPlaceholder { placeholder, range } = r else {
        panic!()
    };
    assert_eq!(placeholder, "My Note");
    assert_eq!(range.start.line, 3);
}

#[test]
fn non_title_line_returns_none() {
    assert!(frontmatter_title_rename_range("tags: [a]", 0).is_none());
}
```

> Note: align `frontmatter_title_rename_range` semantics exactly with the inline logic at mod.rs lines ~586–612 (quote handling, offset). Confirm whether the source uses `PrepareRenameResponse::RangeWithPlaceholder` or `::Range`; mirror it.

- [ ] **Step 2: Run to verify it fails then passes**

Run: `cargo test --lib lsp::rename::tests::frontmatter_title_unquoted`
Expected: FAIL before the helper compiles, PASS after.

- [ ] **Step 3: Refactor `prepare_rename`**

In `mod.rs` `prepare_rename` (561–635): keep the wiki-link case (Case 1) as is. For the frontmatter case (Case 2), after fetching the line text for `pos.line`, replace the inline quote-detection + range arithmetic with:

```rust
return Ok(rename::frontmatter_title_rename_range(&line_text, pos.line));
```

- [ ] **Step 4: Add adapter tests**

```rust
#[tokio::test]
async fn prepare_rename_on_wikilink() {
    let (backend, _tmp) = make_backend(&[
        ("A.md", "# A\n\n[[Target]]\n"),
        ("Target.md", "# Target\n"),
    ]);
    let uri = uri_for(&backend, "A.md");
    open_doc(&backend, &uri, "# A\n\n[[Target]]\n").await;
    let params = TextDocumentPositionParams {
        text_document: TextDocumentIdentifier { uri: uri.clone() },
        position: Position { line: 2, character: 4 },
    };
    assert!(backend.prepare_rename(params).await.unwrap().is_some());
}

#[tokio::test]
async fn prepare_rename_on_frontmatter_title() {
    let text = "---\ntitle: Old Title\n---\nbody\n";
    let (backend, _tmp) = make_backend(&[("A.md", text)]);
    let uri = uri_for(&backend, "A.md");
    open_doc(&backend, &uri, text).await;
    let params = TextDocumentPositionParams {
        text_document: TextDocumentIdentifier { uri: uri.clone() },
        position: Position { line: 1, character: 9 },
    };
    let resp = backend.prepare_rename(params).await.unwrap();
    assert!(matches!(resp, Some(PrepareRenameResponse::RangeWithPlaceholder { .. })));
}
```

- [ ] **Step 5: Run and commit**

Run: `cargo test --lib lsp::rename lsp::tests::prepare_rename`
Expected: PASS

```bash
git add src/lsp/rename.rs src/lsp/mod.rs
git commit -m "refactor(lsp): extract frontmatter_title_rename_range; cover prepare_rename"
```

---

## Task 9: `code_action` helpers + adapter (#5)

**Files:**
- Create: `src/lsp/code_action.rs`
- Modify: `src/lsp/mod.rs` (code_action line 980)

- [ ] **Step 1: Write the failing test**

Create `src/lsp/code_action.rs` with the two builders, porting the per-arm construction from mod.rs lines ~1000–1120:

```rust
//! Pure builders for code actions on link diagnostics.
use std::path::Path;

use tower_lsp::lsp_types::{
    CodeAction, CodeActionKind, CodeActionOrCommand, Diagnostic, Range, TextEdit, Url, WorkspaceEdit,
};

/// Build a "create page" action for an unresolved link target.
/// Returns `None` if the new page path is not representable as a URL.
pub fn build_create_page_action(
    target: &str,
    vault_root: &Path,
    diag: &Diagnostic,
    _uri: &Url,
) -> Option<CodeActionOrCommand> {
    // Port from the "unresolved-link" arm: compute the new page path under
    // vault_root from `target`, build the file URL, the create-file content,
    // and the WorkspaceEdit. Return CodeActionOrCommand::CodeAction(...).
    todo!("port unresolved-link arm")
}

/// Build disambiguation actions when an ambiguous link has >1 candidate.
pub fn build_disambiguate_actions(
    target_raw: &str,
    candidate_paths: &[String],
    link_range: Range,
    _body_text: &str,
    diag: &Diagnostic,
    uri: &Url,
) -> Vec<CodeActionOrCommand> {
    // Port from the "ambiguous-link" arm: for each candidate path, build a
    // TextEdit rewriting the wikilink to disambiguate, wrapped in a CodeAction.
    todo!("port ambiguous-link arm")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diag(code: &str) -> Diagnostic {
        Diagnostic {
            range: Range::default(),
            code: Some(tower_lsp::lsp_types::NumberOrString::String(code.into())),
            ..Default::default()
        }
    }

    #[test]
    fn create_page_action_is_built_for_unresolved() {
        let uri = Url::from_file_path("/vault/A.md").unwrap();
        let action = build_create_page_action("Ghost", Path::new("/vault"), &diag("unresolved-link"), &uri);
        assert!(action.is_some());
    }

    #[test]
    fn disambiguate_builds_one_action_per_candidate() {
        let uri = Url::from_file_path("/vault/A.md").unwrap();
        let actions = build_disambiguate_actions(
            "Dup",
            &["a/Dup.md".into(), "b/Dup.md".into()],
            Range::default(),
            "[[Dup]]",
            &diag("ambiguous-link"),
            &uri,
        );
        assert_eq!(actions.len(), 2);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib lsp::code_action::tests`
Expected: FAIL — `todo!` panics.

- [ ] **Step 3: Port the arms and refactor the adapter**

Fill the two `todo!`s with the logic from `code_action`'s match arms. Then in `mod.rs` `code_action` (980–1131), replace the inner arm bodies with calls to `code_action::build_create_page_action(...)` and `code_action::build_disambiguate_actions(...)`, pushing their results into `actions`.

- [ ] **Step 4: Add the adapter test**

```rust
#[tokio::test]
async fn code_action_offers_create_page_for_unresolved_link() {
    let (backend, _tmp) = make_backend(&[("A.md", "# A\n\n[[Ghost]]\n")]);
    let uri = uri_for(&backend, "A.md");
    open_doc(&backend, &uri, "# A\n\n[[Ghost]]\n").await;
    // Build the diagnostics the editor would pass back in the request context.
    let names = backend.canonical_names.read().await.clone();
    let docs = backend.documents.lock().await;
    let doc = docs.get(&uri).unwrap();
    let diagnostics = crate::lsp::diagnostics::compute_link_diagnostics(
        &doc.links, &names, backend.state.vault.root(), doc,
    );
    drop(docs);
    let params = CodeActionParams {
        text_document: TextDocumentIdentifier { uri: uri.clone() },
        range: Range::default(),
        context: CodeActionContext { diagnostics, only: None, trigger_kind: None },
        work_done_progress_params: Default::default(),
        partial_result_params: Default::default(),
    };
    let actions = backend.code_action(params).await.unwrap().unwrap_or_default();
    assert!(!actions.is_empty());
}
```

- [ ] **Step 5: Run and commit**

Run: `cargo test --lib lsp::code_action lsp::tests::code_action_offers_create_page_for_unresolved_link`
Expected: PASS

```bash
git add src/lsp/code_action.rs src/lsp/mod.rs
git commit -m "refactor(lsp): extract code-action builders; cover code_action"
```

---

## Task 10: `rename` decomposition + adapter (#1)

The worst function in the codebase (CC 44, CRAP 1980). Extract five pure/SQL helpers, then thin the adapter.

**Files:**
- Modify: `src/lsp/rename.rs` (add helpers + tests), `src/lsp/mod.rs` (rename line 637)

- [ ] **Step 1: Add `compute_new_vault_path` + `full_document_range` with tests**

In `src/lsp/rename.rs`:

```rust
use crate::vault::path::VaultPath;
use crate::vault::canonical::CanonicalName;

/// Compute the target VaultPath for renaming a page to `new_name`, preserving
/// the original parent folder. Returns `None` if the result is not a valid path.
pub fn compute_new_vault_path(old_vp: &VaultPath, new_name: &str) -> Option<VaultPath> {
    let file = format!("{}.md", CanonicalName::from_title(new_name).as_str());
    let candidate = match old_vp.parent() {
        Some(parent) if !parent.as_str().is_empty() => format!("{}/{}", parent.as_str(), file),
        _ => file,
    };
    VaultPath::new(&candidate).ok()
}

/// Full-document LSP range spanning `text` (line 0 col 0 .. last line/col).
pub fn full_document_range(text: &str) -> tower_lsp::lsp_types::Range {
    use tower_lsp::lsp_types::{Position, Range};
    let line_count = text.lines().count().max(1);
    let last_line = (line_count - 1) as u32;
    let last_col = text.lines().last().map(|l| l.len()).unwrap_or(0) as u32;
    Range {
        start: Position { line: 0, character: 0 },
        end: Position { line: last_line, character: last_col },
    }
}

#[cfg(test)]
mod rename_path_tests {
    use super::*;

    #[test]
    fn new_path_preserves_parent_folder() {
        let old = VaultPath::new("notes/Old.md").unwrap();
        let new = compute_new_vault_path(&old, "Brand New").unwrap();
        assert!(new.as_str().starts_with("notes/"));
        assert!(new.as_str().ends_with(".md"));
    }

    #[test]
    fn full_range_spans_all_lines() {
        let r = full_document_range("a\nbb\nccc");
        assert_eq!(r.start.line, 0);
        assert_eq!(r.end.line, 2);
        assert_eq!(r.end.character, 3);
    }
}
```

> Note: confirm the actual filename-derivation in mod.rs lines ~711–717 (it may use `VaultPath::from_title` directly rather than `CanonicalName`). Mirror the source's exact derivation so renames produce identical paths.

- [ ] **Step 2: Add the SQL helpers with tests**

```rust
use rusqlite::Connection;

/// Canonical names registered for the page at `old_path`.
pub fn fetch_canonical_names_for_path(
    conn: &Connection,
    old_path: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT cn.canonical_name FROM canonical_names cn \
         JOIN pages p ON cn.page_id = p.id WHERE p.path = ?1",
    )?;
    let rows = stmt.query_map(rusqlite::params![old_path], |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// Paths of all pages that link to `old_path` (by resolved page id or by any of
/// `old_canonical_names`), excluding `old_path` itself.
pub fn find_referring_paths(
    conn: &Connection,
    old_path: &str,
    old_canonical_names: &[String],
) -> Result<Vec<String>, rusqlite::Error> {
    // Port the two queries from mod.rs lines ~766-833 (resolved-by-page-id and
    // unresolved-by-canonical-name), unioning the source paths into a sorted,
    // de-duplicated Vec, removing old_path. Use a BTreeSet<String> accumulator.
    todo!("port referring-paths queries")
}
```

Tests (build a vault, then open the index connection through `with_index`):

```rust
#[cfg(test)]
mod rename_sql_tests {
    use super::*;
    use crate::lsp::test_support::make_backend;

    #[tokio::test]
    async fn canonical_names_for_known_page() {
        let (backend, _tmp) = make_backend(&[
            ("Target.md", "---\ntitle: Target\naliases: [Tee]\n---\n"),
        ]);
        let names = backend
            .state
            .index
            .with_index(|idx, _| {
                fetch_canonical_names_for_path(idx.connection(), "Target.md").unwrap()
            })
            .await
            .unwrap();
        assert!(!names.is_empty());
    }

    #[tokio::test]
    async fn referring_paths_finds_linkers() {
        let (backend, _tmp) = make_backend(&[
            ("Target.md", "---\ntitle: Target\n---\n"),
            ("A.md", "# A\n\n[[Target]]\n"),
        ]);
        let cns = backend
            .state
            .index
            .with_index(|idx, _| {
                let cns = fetch_canonical_names_for_path(idx.connection(), "Target.md").unwrap();
                find_referring_paths(idx.connection(), "Target.md", &cns).unwrap()
            })
            .await
            .unwrap();
        assert!(cns.iter().any(|p| p == "A.md"));
    }
}
```

- [ ] **Step 3: Run to verify the SQL helper test fails**

Run: `cargo test --lib lsp::rename::rename_sql_tests`
Expected: FAIL — `find_referring_paths` is `todo!`.

- [ ] **Step 4: Port `find_referring_paths` and add `build_wikilink_text_edits`**

Fill the `todo!`. Then add:

```rust
use tower_lsp::lsp_types::{AnnotatedTextEdit, OneOf, TextEdit};
use crate::lsp::document::Document;

/// Build the wikilink-rewrite TextEdits for one referring document.
pub fn build_wikilink_text_edits(
    ref_doc: &Document,
    old_canonical_names: &[String],
    new_name: &str,
) -> Vec<OneOf<TextEdit, AnnotatedTextEdit>> {
    let mut edits = Vec::new();
    for link in &ref_doc.links {
        if link.span.start == 0 && link.span.end == 0 {
            continue;
        }
        if !link_matches_target(&link.target_raw, old_canonical_names) {
            continue;
        }
        let span_text = &ref_doc.body[link.span.clone()];
        let new_text = rewrite_wikilink(span_text, new_name);
        edits.push(OneOf::Left(TextEdit {
            range: ref_doc.link_to_range(link),
            new_text,
        }));
    }
    edits
}
```

with a unit test:

```rust
#[test]
fn wikilink_edits_rewrite_matching_links() {
    let doc = Document::from_text("# X\n\n[[Old]] and [[Other]]\n", 1);
    let edits = build_wikilink_text_edits(&doc, &["old".to_string()], "New");
    assert_eq!(edits.len(), 1);
}
```

> Note: confirm `rewrite_wikilink`/`link_matches_target` are reachable in-module (they are defined in `rename.rs`) and that `link_matches_target` keys on the same canonical form produced by `fetch_canonical_names_for_path`.

- [ ] **Step 5: Thin the `rename` adapter**

Rewrite `mod.rs` `rename` (637–978) to orchestrate the helpers:

1. Resolve `old_vp` (wiki-link case via `queries::canonical_to_vault_path`; frontmatter case unchanged).
2. `let new_vp = rename::compute_new_vault_path(&old_vp, &params.new_name).ok_or_else(|| jsonrpc_err("invalid name"))?;`
3. Conflict check (`new_vp != old_vp && new_abs.exists()` → error) — unchanged.
4. `let old_cns = self.state.index.with_index(move |idx,_| rename::fetch_canonical_names_for_path(idx.connection(), &old_path)).await...?;`
5. `let referring = self.state.index.with_index(move |idx,_| rename::find_referring_paths(idx.connection(), &old_path, &old_cns)).await...?;`
6. Build ops: the rename op (via `Url::from_file_path`), the frontmatter-title edit on the renamed file (`rename::full_document_range` + `update_frontmatter_title`), and per referring file `rename::build_wikilink_text_edits(ref_doc, &old_cns, &params.new_name)` (loading each ref doc from `self.documents` or disk).
7. `if ops.is_empty() { Ok(None) } else { Ok(Some(WorkspaceEdit { document_changes: Some(...), .. })) }`.

Target: adapter CC ≤ 12; each helper CC ≤ 8.

- [ ] **Step 6: Add adapter tests**

```rust
#[tokio::test]
async fn rename_wikilink_target_rewrites_referrers() {
    let (backend, _tmp) = make_backend(&[
        ("Target.md", "---\ntitle: Target\n---\nbody\n"),
        ("A.md", "# A\n\n[[Target]]\n"),
    ]);
    let uri = uri_for(&backend, "A.md");
    open_doc(&backend, &uri, "# A\n\n[[Target]]\n").await;
    let params = RenameParams {
        text_document_position: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            position: Position { line: 2, character: 4 },
        },
        new_name: "Renamed Target".to_string(),
        work_done_progress_params: Default::default(),
    };
    let edit = backend.rename(params).await.unwrap().expect("workspace edit");
    assert!(edit.document_changes.is_some());
}

#[tokio::test]
async fn rename_to_existing_path_is_rejected() {
    let (backend, _tmp) = make_backend(&[
        ("Target.md", "---\ntitle: Target\n---\n"),
        ("Existing.md", "---\ntitle: Existing\n---\n"),
        ("A.md", "# A\n\n[[Target]]\n"),
    ]);
    let uri = uri_for(&backend, "A.md");
    open_doc(&backend, &uri, "# A\n\n[[Target]]\n").await;
    let params = RenameParams {
        text_document_position: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            position: Position { line: 2, character: 4 },
        },
        new_name: "Existing".to_string(),
        work_done_progress_params: Default::default(),
    };
    assert!(backend.rename(params).await.is_err());
}
```

- [ ] **Step 7: Run and commit**

Run: `cargo test --lib lsp::rename lsp::tests::rename`
Expected: PASS

```bash
git add src/lsp/rename.rs src/lsp/mod.rs
git commit -m "refactor(lsp): decompose rename into testable helpers; cover rename"
```

---

## Task 11: Slice gate

- [ ] **Step 1: Full suite green**

Run: `cargo test`
Expected: PASS (no network access).

- [ ] **Step 2: CRAP gate**

Run: `./scripts/crap-check.sh`
Expected: failing count strictly below 26; **none** of the ten LSP functions appear in the `✗` rows.

Verify:
```bash
cargo crap --lcov lcov.info 2>&1 | rg '✗' | rg 'lsp/mod.rs' || echo "all LSP functions cleared"
```
Expected: `all LSP functions cleared`

- [ ] **Step 3: Confirm no new over-threshold helper**

If any newly-created helper (`compute_link_diagnostics`, `find_referring_paths`, `build_disambiguate_actions`, etc.) appears in the `✗` list, add a unit test for its uncovered branches and re-run. Do not leave the slice until the LSP set is fully cleared.

- [ ] **Step 4: Commit any final coverage top-ups**

```bash
git add -A
git commit -m "test(lsp): close remaining coverage gaps for slice 01"
```

---

## Self-Review (run after writing, before execution)

- **Spec coverage:** All ten targets have a task (T2 goto_definition, T3 hover, T4 completion, T5 publish_diagnostics_for + did_save, T6 backlink_to_range, T7 references, T8 prepare_rename, T9 code_action, T10 rename). ✓
- **New helpers covered:** Each created module has a `#[cfg(test)] mod tests`. The two `todo!`-seeded helpers (`compute_link_diagnostics`, `find_referring_paths`, `build_*_actions`) have tests written before the port. ✓
- **Type consistency:** `canonical_to_vault_path(&IndexHandle, &str) -> Option<String>` used identically in T2/T3/T7/T10; `vault_path_to_location` signature matches its callers. ✓
- **Risk:** the canonical-name *key* form (lowercased vs. title-cased) is the one runtime unknown — every test that asserts on a canonical key carries a note to confirm it on first run; assertions on resolved *paths* are stable regardless.
