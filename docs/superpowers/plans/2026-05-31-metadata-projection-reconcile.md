# Metadata Projection & Reconcile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a page's folder a *projection* of its declared kind/project: assigning kind/project (via API) writes frontmatter and moves the file to the projected folder, and a **conservative, idempotent reconcile** heals drift — fired from three triggers (assign endpoint, LSP save, `serve`-startup sweep) while the core index build stays filesystem-read-only.

**Architecture:** A pure `project_path()` computes the expected path from current path + declared metadata (declared kind forces the top folder; declared project forces the subfolder; **absent fields never relocate a page** — conservative). `reconcile_page()` applies it via the existing `MutationOp::MovePage` planner (which rewrites inbound links). Assign endpoints write frontmatter then reconcile. The sweep runs once at `serve` startup; `doctor`/diagnostics never call it.

**Tech Stack:** Rust 2024, Axum, rusqlite. Reuses `src/vault/mutation.rs` (`MovePage`), `src/vault/page.rs` (`write_page_content`), `src/vault/kind.rs` (Plan 1), the `state.index.with_index` + `state.change_tx` pattern from `move_page` (`src/api/pages.rs:640`).

**Reference docs:** `docs/adr/0001-metadata-projected-folder-layout.md`, `CONTEXT.md` (Drift, Reconcile).

**Depends on:** Plan 1 (kind/project on `PageMeta` + `kind.rs`), Plan 2 (unique filenames → collision-free moves). **Do not start before both land.**

---

## Conservative reconcile — the rule (read first)

`project_path(current, declared_kind, declared_project)` returns the expected path, or `None` if no move is warranted:

- **Top folder:** declared kind present → its `canonical_folder()`; **absent → keep the current top folder** (inference already makes folder == kind).
- **Subfolder:** declared project present → that slug; **absent → keep the current subfolder** (never strip an unmanaged subfolder).
- **Filename:** always preserved (Plan 2 owns filenames).
- Returns `None` when the computed path equals the current one.

So reconcile **only** moves a page when a *declared* field points somewhere the page isn't. A page with no `type:`/`project:` is never relocated — safe to sweep over any vault.

---

## File Structure

- `src/vault/projection.rs` — **new.** Pure `project_path()`. One responsibility: the path-projection rule.
- `src/vault/reconcile.rs` — **new.** `reconcile_page()` (one page) and `reconcile_all()` (sweep), both built on `MovePage`.
- `src/vault/mod.rs` — **modify.** Register both modules.
- `src/api/pages.rs` — **modify.** Add `assign_router()` (`POST /pages-assign/{*path}`) and a bulk assign handler; mirror `move_page`'s reindex/broadcast flow.
- `src/api/mod.rs` (or wherever routers nest) — **modify.** Mount the assign routers.
- `src/lsp/mod.rs:137` — **modify.** `did_save` reconciles the saved page after reindex.
- `src/lib.rs` — **modify.** `serve` startup runs `reconcile_all` once (read-only build path untouched).

---

## Task 1: Pure `project_path()`

**Files:**
- Create: `src/vault/projection.rs`
- Modify: `src/vault/mod.rs`
- Test: inline `#[cfg(test)]`

- [ ] **Step 1: Write the failing tests**

Create `src/vault/projection.rs`:

```rust
//! Conservative folder projection: compute a page's expected path from its
//! *declared* kind/project. Absent fields never relocate a page.
//! See docs/adr/0001-metadata-projected-folder-layout.md.

use super::kind::Kind;

/// Expected path for `current` given declared metadata, or `None` if the page
/// is already where its declared metadata projects it (no move needed).
pub fn project_path(
    current: &str,
    declared_kind: Option<Kind>,
    declared_project: Option<&str>,
) -> Option<String> {
    let trimmed = current.trim_start_matches('/');
    let comps: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    let filename = (*comps.last()?).to_string();
    let dirs = &comps[..comps.len() - 1];

    let current_top = dirs.first().copied();
    let current_sub = if dirs.len() >= 2 { Some(dirs[1..].join("/")) } else { None };

    // Declared kind forces the top folder; absent keeps the current one.
    let expected_top = match declared_kind {
        Some(k) => Some(k.canonical_folder().to_string()),
        None => current_top.map(str::to_string),
    };
    // Declared project forces the subfolder; absent keeps the current one.
    let expected_sub = match declared_project {
        Some(p) => Some(p.to_string()),
        None => current_sub,
    };

    let mut expected = String::new();
    if let Some(t) = &expected_top { expected.push_str(t); expected.push('/'); }
    if let Some(s) = &expected_sub { expected.push_str(s); expected.push('/'); }
    expected.push_str(&filename);

    if expected == trimmed { None } else { Some(expected) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declared_kind_moves_to_canonical_folder() {
        assert_eq!(project_path("projects/x.md", Some(Kind::Quote), None).as_deref(), Some("quotes/x.md"));
    }
    #[test]
    fn already_consistent_returns_none() {
        assert_eq!(project_path("quotes/x.md", Some(Kind::Quote), None), None);
        assert_eq!(project_path("notes/clep/x.md", None, Some("clep")), None);
    }
    #[test]
    fn absent_project_never_strips_subfolder() {
        // The conservative invariant: no declared project => leave the subfolder alone.
        assert_eq!(project_path("notes/clep/x.md", None, None), None);
    }
    #[test]
    fn declared_project_adds_subfolder() {
        assert_eq!(project_path("notes/x.md", None, Some("clep")).as_deref(), Some("notes/clep/x.md"));
    }
    #[test]
    fn kind_and_project_together() {
        assert_eq!(project_path("notes/x.md", Some(Kind::Quote), Some("clep")).as_deref(), Some("quotes/clep/x.md"));
    }
    #[test]
    fn root_level_file_with_declared_kind() {
        assert_eq!(project_path("x.md", Some(Kind::Note), None).as_deref(), Some("notes/x.md"));
        assert_eq!(project_path("x.md", None, None), None);
    }
}
```

- [ ] **Step 2: Register + run**

Add `pub mod projection;` to `src/vault/mod.rs`. Run: `cargo test --lib vault::projection`
Expected: 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/vault/projection.rs src/vault/mod.rs
git commit -m "feat(vault): conservative project_path() folder projection"
```

---

## Task 2: `reconcile_page` + `reconcile_all`

**Files:**
- Create: `src/vault/reconcile.rs`
- Modify: `src/vault/mod.rs`
- Test: inline `#[cfg(test)]` (temp vault + index fixture, as in `mutation.rs` tests)

- [ ] **Step 1: Write the failing test**

Create `src/vault/reconcile.rs`:

```rust
//! Reconcile: move drifted pages to their projected folder via the MovePage
//! planner. Idempotent and conservative (see projection.rs). Never called from
//! the read-only index build — only from serve startup, LSP save, and assign.

use super::index::{IndexError, VaultIndex};
use super::mutation::{MutationOp, MutationPlanner};
use super::page::Page;
use super::path::VaultPath;
use super::projection::project_path;
use super::Vault;

/// Reconcile a single page. Returns `Some(new_path)` if it was moved, else
/// `None`. Reads declared kind/project from the file's frontmatter.
pub fn reconcile_page(
    vault: &Vault,
    index: &VaultIndex,
    path: &str,
) -> Result<Option<String>, IndexError> {
    let vp = VaultPath::new(path).map_err(|e| IndexError::from_msg(e.to_string()))?;
    let abs = vault.resolve(&vp);
    if !abs.exists() {
        return Ok(None);
    }
    let page = Page::from_file(&abs, vp.clone()).map_err(|e| IndexError::from_msg(e.to_string()))?;
    let Some(dest) = project_path(path, page.meta.kind, page.meta.project.as_deref()) else {
        return Ok(None);
    };
    // Collision-free by construction (Plan 2), but guard anyway.
    if vault.resolve(&VaultPath::new(&dest).map_err(|e| IndexError::from_msg(e.to_string()))?).exists() {
        return Ok(None);
    }
    let planner = MutationPlanner::new(vault, index);
    let plan = planner.plan(&MutationOp::MovePage {
        source: path.to_string(),
        destination: dest.clone(),
    })?;
    plan.execute(vault, index, &[])?;
    Ok(Some(dest))
}

/// Reconcile every page in the index. Returns the number moved.
pub fn reconcile_all(vault: &Vault, index: &VaultIndex) -> Result<usize, IndexError> {
    let paths: Vec<String> = index
        .connection()
        .prepare("SELECT path FROM pages ORDER BY path")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<_, _>>()?;
    let mut moved = 0;
    for path in paths {
        if reconcile_page(vault, index, &path)?.is_some() {
            moved += 1;
        }
    }
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_declared_kind_and_is_idempotent() {
        // notes/q.md with `type: quote` -> should move to quotes/q.md, then no-op.
        let (vault, index) = fixture_with_pages(&[
            ("notes/q.md", "---\nid: 0190f8a0-0000-7000-8000-00000000000c\ntype: quote\n---\nbody"),
        ]);
        let dest = reconcile_page(&vault, &index, "notes/q.md").unwrap();
        assert_eq!(dest.as_deref(), Some("quotes/q.md"));
        // second run: file is now at quotes/q.md, consistent -> None
        assert_eq!(reconcile_page(&vault, &index, "quotes/q.md").unwrap(), None);
    }

    #[test]
    fn leaves_undeclared_pages_untouched() {
        let (vault, index) = fixture_with_pages(&[
            ("notes/sub/x.md", "---\nid: 0190f8a0-0000-7000-8000-00000000000d\n---\nbody"),
        ]);
        assert_eq!(reconcile_page(&vault, &index, "notes/sub/x.md").unwrap(), None);
    }
}
```

> `fixture_with_pages` = the crate's temp-vault+index test helper (match the one `mutation.rs`/`index.rs` tests use). `IndexError::from_msg` = the crate's error-construction idiom; if `IndexError` exposes a different constructor, use it. `Page::from_file`, `MutationPlanner::new`, `plan.execute`, `vault.resolve`, `index.connection` are all confirmed present.

- [ ] **Step 2: Register + run**

Add `pub mod reconcile;` to `src/vault/mod.rs`. Run: `cargo test --lib vault::reconcile`
Expected: iterate to PASS (fix fixture/error idioms to match the crate).

- [ ] **Step 3: Commit**

```bash
git add src/vault/reconcile.rs src/vault/mod.rs
git commit -m "feat(vault): conservative reconcile_page + reconcile_all"
```

---

## Task 3: Assign endpoint (`POST /pages-assign/{*path}`)

**Files:**
- Modify: `src/api/pages.rs` (request type, `assign_router()`, handler)
- Modify: wherever routers are mounted (mirror how `move_router()` is nested — see `pages.rs:129-133`)
- Test: `src/api/pages.rs` async tests

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn assign_kind_writes_frontmatter_and_moves() {
    let state = test_state_with_pages(&[
        ("notes/q.md", "---\nid: 0190f8a0-0000-7000-8000-00000000000c\n---\nbody"),
    ]).await;

    let resp = assign_page(
        State(Arc::clone(&state)),
        Path("notes/q.md".to_string()),
        Json(AssignRequest { kind: Some("QUOTE".to_string()), project: None }),
    ).await.unwrap();

    // Returned detail reflects the new location + declared kind.
    assert_eq!(resp.0.path, "quotes/q.md");
    assert!(!state.vault.resolve(&VaultPath::new("notes/q.md").unwrap()).exists());
    assert!(state.vault.resolve(&VaultPath::new("quotes/q.md").unwrap()).exists());
}
```

> Match `test_state_with_pages` to the helper the other async handler tests use.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib api::pages::assign_kind_writes_frontmatter_and_moves`
Expected: FAIL — `assign_page`/`AssignRequest` absent.

- [ ] **Step 3: Add the request type**

In `src/api/pages.rs`:

```rust
#[derive(Debug, Deserialize, ToSchema)]
pub struct AssignRequest {
    /// New kind token (e.g. "QUOTE"); omitted leaves kind unchanged.
    #[serde(default)]
    pub kind: Option<String>,
    /// New project slug; `Some("")`/null semantics: present-with-value sets,
    /// `clear: true` clears. Omitted leaves project unchanged.
    #[serde(default)]
    pub project: Option<String>,
    /// Explicitly clear the project (move the page up out of its subfolder).
    #[serde(default)]
    pub clear_project: bool,
}
```

- [ ] **Step 4: Add the handler + router**

Add the handler. It (1) loads the page, (2) mutates declared `kind`/`project` in `meta`, (3) writes frontmatter via `write_page_content`, (4) reindexes the page so kind/inferred update even when no move occurs, (5) reconciles (may move + rewrite links), (6) broadcasts, (7) returns the `PageDetail` at the final path. Mirror `move_page`'s `with_index`/`change_tx` flow:

```rust
pub fn assign_router() -> Router<Arc<AppState>> {
    Router::new().route("/{*path}", post(assign_page))
}

#[utoipa::path(
    post,
    path = "/pages-assign/{path}",
    request_body = AssignRequest,
    responses(
        (status = 200, description = "Assigned + reconciled", body = PageDetailResponse),
        (status = 404, description = "Page not found", body = ApiError),
        (status = 400, description = "Invalid kind", body = ApiError),
    )
)]
pub async fn assign_page(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Json(body): Json<AssignRequest>,
) -> Result<Json<PageDetail>, ApiError> {
    let vp = VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;
    let abs = state.vault.resolve(&vp);
    if !abs.exists() {
        return Err(ApiError::not_found(format!("page not found: {path}")));
    }

    // 1-3. Load, mutate declared metadata, write frontmatter back.
    let mut page = Page::from_file(&abs, vp.clone())
        .map_err(|e| ApiError::internal(format!("read failed: {e}")))?;
    if let Some(ref k) = body.kind {
        let parsed = crate::vault::kind::Kind::from_token(k)
            .ok_or_else(|| ApiError::bad_request(format!("unknown kind: {k}")))?;
        page.meta.kind = Some(parsed);
    }
    if body.clear_project {
        page.meta.project = None;
    } else if let Some(ref p) = body.project {
        page.meta.project = Some(p.clone());
    }
    crate::vault::page::write_page_content(&abs, &page.meta, &page.body)
        .map_err(|e| ApiError::internal(format!("write failed: {e}")))?;

    // 4-5. Reindex (pick up frontmatter change), then reconcile (may move).
    let path_for_index = path.clone();
    let final_path = state
        .index
        .with_index(move |index, vault| {
            index.index_page_at(&path_for_index)?; // reindex content at current path
            let moved = crate::vault::reconcile::reconcile_page(vault, index, &path_for_index)?;
            Ok::<_, crate::vault::index::IndexError>(moved.unwrap_or(path_for_index))
        })
        .await
        .map_err(|e| ApiError::internal(format!("assign failed: {e}")))?
        .map_err(|e| ApiError::internal(format!("assign failed: {e}")))?;

    // 6. Broadcast.
    let _ = state.change_tx.send(SyncNotification::IndexChanged {
        upserted: vec![final_path.clone()],
        removed: if final_path != path { vec![path.clone()] } else { vec![] },
    });

    // 7. Return detail at the final path.
    let final_vp = VaultPath::new(&final_path).map_err(|e| ApiError::internal(e.to_string()))?;
    let final_abs = state.vault.resolve(&final_vp);
    let page = Page::from_file(&final_abs, final_vp.clone())
        .map_err(|e| ApiError::internal(format!("read failed: {e}")))?;
    let canonical = match page.meta.title {
        Some(ref t) => CanonicalName::from_title(t),
        None => CanonicalName::from_filename(final_vp.filename()),
    };
    Ok(Json(PageDetail {
        path: final_vp.as_str().to_string(),
        canonical_name: canonical.as_str().to_string(),
        meta: page.meta,
        body: page.body,
    }))
}
```

> `index.index_page_at(path)` stands for the crate's single-page (re)index entry point — the LSP `did_save` test (`lsp/mod.rs:1284`) calls something like `index_page`; grep `src/vault/index.rs` for the public single-page index method and use its real name/signature. If reindex requires the page content rather than a path, pass `&page`.
> `write_page_content` is imported at `pages.rs:22`. Confirm its exact signature (`(path, &PageMeta, &str)` order) and match it.

- [ ] **Step 5: Mount the router**

Where `move_router()` is mounted (grep for `.nest("/pages-move"` or `move_router`), add the assign router alongside, e.g. `.nest("/pages-assign", assign_router())`.

- [ ] **Step 6: Run to verify it passes**

Run: `cargo test --lib api::pages::assign_kind_writes_frontmatter_and_moves`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/api/pages.rs src/api/mod.rs
git commit -m "feat(api): POST /pages-assign — write kind/project + reconcile"
```

---

## Task 4: Bulk assign (`POST /pages-assign-bulk`)

**Files:**
- Modify: `src/api/pages.rs`
- Test: `src/api/pages.rs` async test

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn bulk_assign_moves_all_and_reports() {
    let state = test_state_with_pages(&[
        ("notes/a.md", "---\nid: 0190f8a0-0000-7000-8000-00000000000e\n---\nb"),
        ("notes/b.md", "---\nid: 0190f8a0-0000-7000-8000-00000000000f\n---\nb"),
    ]).await;

    let resp = assign_bulk(
        State(Arc::clone(&state)),
        Json(BulkAssignRequest {
            paths: vec!["notes/a.md".into(), "notes/b.md".into()],
            kind: Some("QUOTE".into()),
            project: Some("clep".into()),
            clear_project: false,
        }),
    ).await.unwrap();

    assert_eq!(resp.0.moved.len(), 2);
    assert!(resp.0.failed.is_empty());
    assert!(state.vault.resolve(&VaultPath::new("quotes/clep/a.md").unwrap()).exists());
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib api::pages::bulk_assign_moves_all_and_reports`
Expected: FAIL — types/handler absent.

- [ ] **Step 3: Implement (best-effort, per-path results)**

```rust
#[derive(Debug, Deserialize, ToSchema)]
pub struct BulkAssignRequest {
    pub paths: Vec<String>,
    #[serde(default)] pub kind: Option<String>,
    #[serde(default)] pub project: Option<String>,
    #[serde(default)] pub clear_project: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BulkAssignResponse {
    /// `from -> to` for each moved page.
    pub moved: Vec<(String, String)>,
    /// `path -> error` for failures (best-effort: one bad page doesn't abort).
    pub failed: Vec<(String, String)>,
}

pub async fn assign_bulk(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BulkAssignRequest>,
) -> Result<Json<BulkAssignResponse>, ApiError> {
    let mut moved = Vec::new();
    let mut failed = Vec::new();
    for path in body.paths {
        let req = AssignRequest {
            kind: body.kind.clone(),
            project: body.project.clone(),
            clear_project: body.clear_project,
        };
        match assign_page(State(Arc::clone(&state)), Path(path.clone()), Json(req)).await {
            Ok(detail) => moved.push((path, detail.0.path)),
            Err(e) => failed.push((path, e.to_string())),
        }
    }
    Ok(Json(BulkAssignResponse { moved, failed }))
}
```

> Route it on a non-wildcard path so it doesn't clash with the `{*path}` assign route — e.g. mount `assign_bulk` at `POST /pages-assign-bulk` as its own route, not under the `/{*path}` router.

- [ ] **Step 4: Run + commit**

Run: `cargo test --lib api::pages::bulk_assign_moves_all_and_reports`
Expected: PASS.

```bash
git add src/api/pages.rs src/api/mod.rs
git commit -m "feat(api): POST /pages-assign-bulk best-effort batch assign"
```

---

## Task 5: Trigger — LSP `did_save` reconciles

**Files:**
- Modify: `src/lsp/mod.rs:137` (`did_save`)
- Test: extend `did_save_reindexes_and_clears_dirty` (`lsp/mod.rs:1269`)

- [ ] **Step 1: Write/extend the failing test**

Add a focused test mirroring the existing `did_save` test setup, asserting a saved page with a declared kind mismatching its folder gets moved:

```rust
#[tokio::test]
async fn did_save_reconciles_declared_kind() {
    // Build the LSP backend over a temp vault with notes/q.md containing `type: quote`.
    // ... reuse the harness from did_save_reindexes_and_clears_dirty ...
    let backend = /* harness */;
    // simulate save of notes/q.md
    backend.did_save(DidSaveTextDocumentParams { /* uri = notes/q.md */ ..Default::default() }).await;
    // after save, the file should have moved to quotes/q.md
    assert!(vault_path_exists(&backend, "quotes/q.md"));
}
```

> Reuse the exact harness/uri construction from the sibling test. `vault_path_exists` = whatever the test uses to check the on-disk vault.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib lsp::tests::did_save_reconciles_declared_kind`
Expected: FAIL — `did_save` reindexes but does not move.

- [ ] **Step 3: Call reconcile after reindex in `did_save`**

In `did_save` (`lsp/mod.rs:137`), after the existing reindex/resolve_links step for the saved document, add a reconcile call on that document's vault path, mirroring how the handler already accesses the index/vault. Pseudocode for the addition:

```rust
// (existing: index_page + resolve_links + republish for `path`)
if let Err(e) = self.with_index(|index, vault| {
    crate::vault::reconcile::reconcile_page(vault, index, &path)
}) {
    tracing::warn!("did_save reconcile failed for {path}: {e}");
}
```

> Match the LSP backend's actual index/vault accessor (it already has one — the reindex step uses it). If a move occurs, the LSP should also emit the workspace edit / refresh it already performs on rename; if the backend has rename plumbing, route through it. If not, a `tracing::warn!`-guarded best-effort reconcile is acceptable for v1 — note it.

- [ ] **Step 4: Run + commit**

Run: `cargo test --lib lsp`
Expected: PASS.

```bash
git add src/lsp/mod.rs
git commit -m "feat(lsp): reconcile saved page after did_save"
```

---

## Task 6: Trigger — `serve` startup sweep

**Files:**
- Modify: `src/lib.rs` (the `serve` startup path — `build_app_state` ~336 or `build_server_state` ~457)
- Test: `src/lib.rs` test module

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn serve_startup_reconciles_drifted_pages() {
    // Build app state over a temp vault containing notes/q.md with `type: quote`,
    // using the same constructor serve uses, then assert the sweep moved it.
    // ... arrange temp vault + config ...
    let (state, _settings) = build_server_state_for_test(/* temp vault */).await.unwrap();
    assert!(state.vault.resolve(&VaultPath::new("quotes/q.md").unwrap()).exists());
}
```

> Use the real serve-startup constructor. If `build_server_state` isn't directly test-constructable, call `reconcile_all` in a small wrapper the test can hit, then assert.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib serve_startup_reconciles_drifted_pages`
Expected: FAIL — startup doesn't sweep.

- [ ] **Step 3: Run the sweep once at startup**

In the `serve` startup path in `src/lib.rs` (after the initial index build completes and `state` is available, before the server begins serving), add:

```rust
// One-shot reconcile sweep: heal drift on startup (serve only — the read-only
// index build and doctor never call this). See ADR 0001.
match state.index.with_index(|index, vault| {
    crate::vault::reconcile::reconcile_all(vault, index)
}).await {
    Ok(Ok(n)) if n > 0 => tracing::info!("reconcile sweep moved {n} drifted page(s)"),
    Ok(Ok(_)) => {}
    Ok(Err(e)) | Err(e) => tracing::warn!("reconcile sweep failed: {e}"),
}
```

> Place this strictly in the `serve` runtime path. Confirm `doctor` (`diagnostics::run`) and any read-only rebuild do NOT route through this code. Match `with_index`'s actual return-nesting (the `move_page` handler shows the double-`map_err` shape).

- [ ] **Step 4: Run + commit**

Run: `cargo test --lib serve_startup_reconciles_drifted_pages`
Expected: PASS.

```bash
git add src/lib.rs
git commit -m "feat(serve): reconcile sweep on startup (read-only build untouched)"
```

---

## Final verification

- [ ] **Backend:** `cargo test` — all pass.
- [ ] **Lint:** `cargo clippy --all-targets` — clean.
- [ ] **Read-only boundary holds:** `cargo run -- doctor` over a vault with a drifted page (`type: quote` in `notes/`) reports health but does **not** move the file. Then `cargo run -- serve` moves it on startup.
- [ ] **Manual API:**
  - `POST /api/vault/pages-assign/notes/q.md {"kind":"QUOTE"}` → 200, file now at `quotes/q.md`, inbound `[[q]]` links still resolve.
  - `POST /api/vault/pages-assign-bulk {"paths":[...],"project":"clep"}` → all members now under `<kind>/clep/`.
  - Re-running either is a no-op (idempotent).

---

## Notes for the executor

- **Conservative is load-bearing.** Never strip or relocate a page because a field is *absent*. Only declared kind/project that points elsewhere causes a move. The startup sweep relies on this to be safe over real vaults.
- **Read-only boundary is load-bearing.** `reconcile_*` is invoked only from the assign endpoints, `did_save`, and the serve-startup sweep — never from the core index build, `doctor`, or any dry rebuild. If you find yourself adding a reconcile call inside the index-build function, stop: that breaks ADR 0001.
- Moves go through `MutationOp::MovePage`, so inbound-link rewriting is inherited — don't reimplement it.
- Collisions are impossible after Plan 2 (unique basenames); the `exists()` guard in `reconcile_page` is belt-and-braces, not the primary mechanism.
