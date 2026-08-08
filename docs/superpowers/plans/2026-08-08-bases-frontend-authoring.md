# Bases Frontend Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users discover, create, preview, fully configure, save, and delete TOML-backed Bases from the frontend without losing external edits, comments, unknown TOML keys, pages, or page properties.

**Architecture:** `bases/*.base.toml` remains canonical. Rust owns validation, comment-preserving TOML mutation, revisions, atomic publication, preview evaluation, and deletion; React owns an explicit-save draft represented as an ordered editor model and talks only to typed domain endpoints. The saved table remains the usage surface while `/bases/$slug/edit` is a dedicated definition workspace.

**Tech Stack:** Rust 2024, Axum 0.8, serde, toml/toml_edit, blake3, utoipa, existing atomic-file helpers and query evaluator; React 19, TypeScript, TanStack Router/Query, React Aria Components, Tailwind v4, Vitest/Testing Library.

**Reference:** `docs/superpowers/specs/2026-08-08-bases-frontend-authoring-design.md`

## Global Constraints

- `bases/*.base.toml` is the only persisted definition format; no database mirror, generic vault-file writer, or persisted draft store.
- Bases remain non-owning. Deleting a base or declaration never deletes pages or page frontmatter.
- All mutations use an exact-content revision and return `409` on stale input; never silently overwrite external changes.
- New definitions use stable formatting. Existing updates preserve unsupported keys and comments; unchanged managed nodes remain byte-identical.
- Explicit Save publishes the complete draft atomically. Preview never writes.
- Slugs are chosen at creation and immutable afterward.
- Table is the only supported layout. Keep manual viewless files readable, but guided creation always creates an `All` view.
- Filter, property, sort, grouping, and aggregate controls must enforce the existing Rust domain model; do not add new operators, types, or layouts.
- React controls must be keyboard operable, text-labelled, and use existing Vessel tokens: zero border radius, no new literal palette, semantic `cl-*`, `text-ink`, `border-rule`, and `text-accent` classes.
- Reordering requires move-up/move-down controls; drag-and-drop cannot be the only interaction.
- `ui/src/api/schema.d.ts` and `ui/src/routeTree.gen.ts` are generated; never hand-edit either file.
- Preserve unrelated user work. Stage only paths named by the active task; never use `git add .` or `git add -A`.
- Every task follows red-green-refactor and ends with focused tests plus an exact-path commit.

---

## File Structure

### Backend

- `src/vault/base.rs` — extend the domain model for structured input, ordered property deserialization, diagnostic severity/path, and reusable validation.
- `src/vault/base_document.rs` — new canonical create/update/delete boundary: safe slug resolution, exact revisions, comment-preserving TOML merge, and atomic publication.
- `src/vault/mod.rs` — export `base_document`.
- `src/api/bases.rs` — request/response DTOs and list/detail/create/update/delete/preview handlers.
- `src/api/openapi.rs` — register new paths and schemas; provide a useful recursive Filter schema.
- `tests/bases_api.rs` — HTTP behavior, filesystem effects, conflicts, preview parity, counts, and non-owning deletion.

### Frontend shared model and API

- `ui/src/api/bases.ts` — generated-type aliases, list/create/update/delete/preview hooks, and cache invalidation.
- `ui/src/components/bases/definition-model.ts` — explicit recursive filter type, ordered draft model, wire conversion, defaults, and field capability helpers.
- `ui/src/components/bases/__tests__/definition-model.test.ts` — pure round-trip and capability tests.
- `ui/src/api/schema.d.ts` — regenerated from OpenAPI.

### Frontend discovery and creation

- `ui/src/routes/bases.index.tsx` — `/bases` route.
- `ui/src/components/bases/BasesIndex.tsx` — index states, summaries, diagnostics, and actions.
- `ui/src/components/bases/CreateBaseDialog.tsx` — guided name/slug/description/membership creation.
- `ui/src/components/bases/__tests__/BasesIndex.test.tsx` — index and delete behavior.
- `ui/src/components/bases/__tests__/CreateBaseDialog.test.tsx` — creation defaults and validation.

### Frontend definition workspace

- `ui/src/routes/bases.$slug.edit.tsx` — definition-workspace route.
- `ui/src/components/bases/BaseDefinitionWorkspace.tsx` — server/draft orchestration, section selection, preview, Save/Discard, conflict handling, and navigation guard.
- `ui/src/components/bases/DefinitionHeader.tsx` — dirty/validation/save state and primary actions.
- `ui/src/components/bases/GeneralEditor.tsx` — display name, description, immutable slug, open-file affordance.
- `ui/src/components/bases/MembershipEditor.tsx` — accessible recursive filter builder.
- `ui/src/components/bases/PropertiesEditor.tsx` — ordered typed schema editor.
- `ui/src/components/bases/ViewsEditor.tsx` — view list and selected-view configuration.
- `ui/src/components/bases/BasePreview.tsx` — bounded unsaved membership/view output states.
- `ui/src/components/bases/ValidationSummary.tsx` — diagnostic links and focus routing.
- `ui/src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx` — dirty, save, discard, conflict, and preview behavior.
- `ui/src/components/bases/__tests__/MembershipEditor.test.tsx` — recursive filter behavior and accessibility.
- `ui/src/components/bases/__tests__/PropertiesEditor.test.tsx` — all schema types, ordering, and non-migration warnings.
- `ui/src/components/bases/__tests__/ViewsEditor.test.tsx` — view duplication/order/configuration and valid capabilities.

### Integration and documentation

- `ui/src/components/bases/BaseTable.tsx` and `BaseTableView.tsx` — Configure affordance from saved usage surface.
- `ui/src/components/codex/CodexFrame.tsx` — first-class BASES navigation.
- `ui/src/components/codex/CommandPalette.tsx` — Open Bases command.
- `ui/src/docs/content/bases.mdx` — replace manual-only limitation with frontend authoring guidance and advanced-file caveats.

---

### Task 1: Structured Base Domain and Diagnostics

**Files:**
- Modify: `src/vault/base.rs:33-264,580-727`
- Test: inline `src/vault/base.rs` tests

**Interfaces:**
- Produces: `BaseFile: Deserialize`, ordered property-map deserialization, `BaseDiagnosticSeverity`, `BaseDiagnostic.path`, and `validate_definition(slug: &str, file: BaseFile) -> ValidationResult`.
- Consumed by: Tasks 2 and 3.

- [ ] **Step 1: Add failing ordered-input and diagnostic tests**

Add tests proving JSON/TOML map order survives structured deserialization and validation supplies machine-addressable diagnostics:

```rust
#[test]
fn structured_base_preserves_property_order() {
    let file: BaseFile = serde_json::from_value(serde_json::json!({
        "name": "Reading",
        "properties": {
            "status": { "type": "select", "options": ["queued", "reading"] },
            "rating": { "type": "number" }
        },
        "views": [{ "name": "All", "layout": "table" }]
    })).unwrap();
    assert_eq!(
        file.properties.iter().map(|(key, _)| key.as_str()).collect::<Vec<_>>(),
        vec!["status", "rating"]
    );
}

#[test]
fn structured_validation_addresses_duplicate_view() {
    let file = base_file_with_views(["All", "All"]);
    let result = validate_definition("reading", file);
    assert!(result.diagnostics.iter().any(|diagnostic| {
        diagnostic.severity == BaseDiagnosticSeverity::Error
            && diagnostic.path.as_deref() == Some("views[1].name")
    }));
}
```

- [ ] **Step 2: Run the focused tests and observe the expected failure**

Run: `cargo test vault::base::tests::structured_ -- --nocapture`

Expected: compilation fails because `BaseFile` is not `Deserialize` and the diagnostic fields/helper do not exist.

- [ ] **Step 3: Implement ordered deserialization and classified diagnostics**

Extend the domain without adding a parallel wire model:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum BaseDiagnosticSeverity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BaseDiagnostic {
    pub slug: String,
    pub severity: BaseDiagnosticSeverity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub message: String,
}

pub struct ValidationResult {
    pub definition: BaseDefinition,
    pub diagnostics: Vec<BaseDiagnostic>,
}

pub fn validate_definition(slug: &str, file: BaseFile) -> ValidationResult {
    let definition = BaseDefinition { slug: slug.to_owned(), file };
    let mut diagnostics = Vec::new();
    validate(&definition, &mut diagnostics);
    ValidationResult { definition, diagnostics }
}
```

Add `property_map::deserialize` using `serde::de::MapAccess` and change `BaseFile` to `#[derive(Deserialize)]`. Keep invalid manual property declarations recoverable through the existing `RawBaseFile` parse path.

Classification contract:

- error: empty name, empty/duplicate view name, unsupported layout;
- warning: system-field shadowing, undeclared field references, incompatible operator/type, non-groupable field, or invalid aggregate pairing;
- parse/type errors remain file-level errors with `path: None`.

Update existing diagnostic construction and assertions. Do not change filter/query semantics.

- [ ] **Step 4: Run domain tests**

Run: `cargo test vault::base::tests -- --nocapture`

Expected: all existing parser/validation tests and the new structured tests pass.

- [ ] **Step 5: Commit the domain contract**

```bash
git add src/vault/base.rs
git commit -m "feat(bases): accept structured definitions"
```

---

### Task 2: Revisioned Base Document Store

**Files:**
- Create: `src/vault/base_document.rs`
- Modify: `src/vault/mod.rs`
- Test: inline `src/vault/base_document.rs` tests

**Interfaces:**
- Consumes: `BaseFile`, `parse_base`, and `validate_definition` from Task 1; `atomic_create` and `atomic_replace` from `src/vault/atomic_file.rs`.
- Produces:

```rust
pub struct StoredBase {
    pub definition: BaseDefinition,
    pub diagnostics: Vec<BaseDiagnostic>,
    pub revision: String,
}

pub enum BaseDocumentError {
    InvalidSlug(String),
    NotFound(String),
    AlreadyExists(String),
    Conflict { current_revision: String },
    InvalidDefinition(Vec<BaseDiagnostic>),
    UnsupportedDocument(String),
    Io(std::io::Error),
}

pub fn create(root: &Path, slug: &str, file: &BaseFile) -> Result<StoredBase, BaseDocumentError>;
pub fn update(root: &Path, slug: &str, expected_revision: &str, file: &BaseFile) -> Result<StoredBase, BaseDocumentError>;
pub fn delete(root: &Path, slug: &str, expected_revision: &str) -> Result<(), BaseDocumentError>;
pub fn revision(raw: &str) -> String;
```

- [ ] **Step 1: Write failing safe-path and revision tests**

Cover traversal, no-overwrite, stale update, stable new-file formatting, comment/unknown-key preservation, and non-owning deletion:

```rust
#[test]
fn update_preserves_comments_unknown_keys_and_unchanged_nodes() {
    let fixture = fixture_base(
        "# owner note\nname = \"Reading\"\nplugin_key = \"keep\"\n\n[properties]\n# vocabulary\nstatus = { type = \"select\", options = [\"queued\"] }\n\n[[views]]\nname = \"All\"\nlayout = \"table\"\n",
    );
    let before = std::fs::read_to_string(fixture.path()).unwrap();
    let current = load_for_test(fixture.root(), "reading");
    let mut next = current.definition.file.clone();
    next.description = Some("Books".into());

    update(fixture.root(), "reading", &current.revision, &next).unwrap();
    let after = std::fs::read_to_string(fixture.path()).unwrap();

    assert!(after.contains("# owner note"));
    assert!(after.contains("plugin_key = \"keep\""));
    assert!(after.contains("# vocabulary"));
    assert!(after.contains("status = { type = \"select\", options = [\"queued\"] }"));
    assert_ne!(before, after);
}

#[test]
fn stale_update_does_not_touch_file() {
    let fixture = fixture_base(MINIMAL_BASE);
    let before = std::fs::read_to_string(fixture.path()).unwrap();
    let error = update(fixture.root(), "reading", "stale", &minimal_file()).unwrap_err();
    assert!(matches!(error, BaseDocumentError::Conflict { .. }));
    assert_eq!(std::fs::read_to_string(fixture.path()).unwrap(), before);
}
```

Also assert `../escape`, `/absolute`, `a/b`, `.` and empty slugs are rejected before filesystem access; `delete` removes only `bases/reading.base.toml` while a seeded Markdown page remains byte-identical.

- [ ] **Step 2: Run the focused tests and observe failure**

Run: `cargo test vault::base_document::tests -- --nocapture`

Expected: module/functions are absent.

- [ ] **Step 3: Implement safe resolution and exact revisions**

Use one direct child only:

```rust
fn base_path(root: &Path, slug: &str) -> Result<PathBuf, BaseDocumentError> {
    let safe = !slug.is_empty()
        && !slug.starts_with('.')
        && slug.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if !safe {
        return Err(BaseDocumentError::InvalidSlug(slug.to_owned()));
    }
    Ok(root.join("bases").join(format!("{slug}.base.toml")))
}

pub fn revision(raw: &str) -> String {
    blake3::hash(raw.as_bytes()).to_hex().to_string()
}
```

Create the directory if absent. Use `atomic_create` so an existing path is never replaced.

- [ ] **Step 4: Implement comment-preserving managed-node merge**

Parse the current and desired files as `toml_edit::DocumentMut`. Update only the managed top-level nodes `name`, `description`, `filter`, `properties`, and `views`; leave every unsupported key in the current document. For unchanged semantic values, leave the existing item untouched. For changed values, merge tables recursively and retain existing item/table decor before replacing values. If an unsupported item shape collides with a managed key and cannot be represented safely, return `UnsupportedDocument` rather than falling back to full serialization.

The public update flow is:

```rust
pub fn update(
    root: &Path,
    slug: &str,
    expected_revision: &str,
    file: &BaseFile,
) -> Result<StoredBase, BaseDocumentError> {
    let path = base_path(root, slug)?;
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| map_read_error(slug, error))?;
    let current_revision = revision(&raw);
    if current_revision != expected_revision {
        return Err(BaseDocumentError::Conflict { current_revision });
    }
    reject_blocking_diagnostics(validate_definition(slug, file.clone()))?;
    let content = merge_document(&raw, file)?;
    atomic_replace(&path, content.as_bytes()).map_err(map_publication_error)?;
    load_stored(&path, slug)
}
```

Use `toml_edit::ser::to_document(file)` for the desired managed shape. Unit tests—not comments—are the contract for preservation.

- [ ] **Step 5: Run document-store tests and formatting**

Run: `cargo test vault::base_document::tests -- --nocapture`

Run: `cargo fmt --check`

Expected: all pass; the preservation test proves unrelated bytes survive.

- [ ] **Step 6: Commit the document boundary**

```bash
git add src/vault/base_document.rs src/vault/mod.rs
git commit -m "feat(bases): add revisioned definition store"
```

---

### Task 3: Authoring HTTP Mutations and OpenAPI Contract

**Files:**
- Modify: `src/api/bases.rs`
- Modify: `src/api/openapi.rs`
- Modify: `src/api/error.rs`
- Modify: `tests/bases_api.rs`

**Interfaces:**
- Consumes: Task 2 document-store API and existing `SyncNotification::BaseRegistryChanged`.
- Produces:

```rust
pub struct CreateBaseRequest { pub slug: String, pub definition: BaseFile }
pub struct UpdateBaseRequest { pub expected_revision: String, pub definition: BaseFile }
pub struct DeleteBaseRequest { pub expected_revision: String }
pub struct BaseMutationResponse {
    #[serde(flatten)] pub definition: BaseDefinition,
    pub diagnostics: Vec<BaseDiagnostic>,
    pub revision: String,
}
```

- Produces typed `POST /api/vault/bases`, `PUT /api/vault/bases/{slug}`, and `DELETE /api/vault/bases/{slug}`.
- [ ] **Step 1: Add failing HTTP mutation tests**

Extend `tests/bases_api.rs` with contract-level tests:

```rust
#[tokio::test]
async fn create_update_and_delete_are_revision_guarded_and_non_owning() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let page_before = std::fs::read_to_string(fixture.temp_dir.path().join("a.md")).unwrap();

    let create = fixture.server.post("/api/vault/bases").json(&serde_json::json!({
        "slug": "books",
        "definition": {
            "name": "Books",
            "properties": { "status": { "type": "select", "options": [] } },
            "views": [{ "name": "All", "layout": "table" }]
        }
    })).await;
    create.assert_status_ok();
    let created: serde_json::Value = create.json();
    let revision = created["revision"].as_str().unwrap();

    fixture.server.put("/api/vault/bases/books").json(&serde_json::json!({
        "expected_revision": "stale",
        "definition": created_definition(&created)
    })).await.assert_status_conflict();

    fixture.server.delete("/api/vault/bases/books").json(&serde_json::json!({
        "expected_revision": revision
    })).await.assert_status_ok();

    assert_eq!(std::fs::read_to_string(fixture.temp_dir.path().join("a.md")).unwrap(), page_before);
}
```

Add separate tests for duplicate create, unsafe slug, blocking diagnostics, exact revision returned by detail, and no `base_registry_changed` notification after failed mutation.

- [ ] **Step 2: Run failing integration tests**

Run: `cargo test --test bases_api create_update_and_delete -- --nocapture`

Expected: POST/PUT/DELETE return method-not-allowed or do not compile.

- [ ] **Step 3: Implement DTOs, error mapping, handlers, and routes**

Map document errors precisely:

```rust
fn document_error(error: BaseDocumentError) -> ApiError {
    match error {
        BaseDocumentError::InvalidSlug(message) => ApiError::bad_request(message),
        BaseDocumentError::NotFound(message) => ApiError::not_found(message),
        BaseDocumentError::AlreadyExists(message) => ApiError::conflict(message),
        BaseDocumentError::Conflict { current_revision } => ApiError::conflict_with_detail(
            "base definition changed since expected_revision",
            serde_json::json!({ "revision": current_revision }),
        ),
        BaseDocumentError::InvalidDefinition(diagnostics) => ApiError::bad_request_with_detail(
            "base definition is invalid",
            serde_json::json!({ "diagnostics": diagnostics }),
        ),
        BaseDocumentError::UnsupportedDocument(message) => ApiError::conflict(message),
        BaseDocumentError::Io(error) => ApiError::internal(error.to_string()),
    }
}
```

Add `ApiError::bad_request_with_detail(msg, detail)` in `src/api/error.rs` with status 400, `detail: Some(detail)`, and `hint: None`; cover its serialized endpoint response in the invalid-definition test. Emit `BaseRegistryChanged` only after successful publication/deletion.

Register:

```rust
Router::new()
    .route("/", get(list_bases).post(create_base))
    .route("/{slug}", get(get_base).put(update_base).delete(delete_base))
    .route("/{slug}/views/{view}", get(evaluate_view))
```

- [ ] **Step 4: Register OpenAPI paths and schemas**

Add mutation handlers and all new DTO/diagnostic/document types to `ApiDoc`. Replace the opaque `Filter: Record<string, never>` schema with a manual recursive one-of schema for `all`, `any`, `not`, and comparison so regenerated TypeScript can represent authoring payloads without `as never` casts.

Extend the existing OpenAPI test to assert POST on `/api/vault/bases`, PUT/DELETE on `/api/vault/bases/{slug}`, required `expected_revision`, and a non-empty recursive Filter schema.

- [ ] **Step 5: Run focused and full backend checks for this contract**

Run: `cargo test --test bases_api -- --nocapture`

Run: `cargo test api::openapi -- --nocapture`

Run: `cargo fmt --check`

Expected: all pass.

- [ ] **Step 6: Commit the HTTP mutation contract**

```bash
git add src/api/bases.rs src/api/openapi.rs src/api/error.rs tests/bases_api.rs
git commit -m "feat(api): author base definitions"
```


---

### Task 4: Preview Evaluation and Index Counts

**Files:**
- Modify: `src/api/bases.rs`
- Modify: `src/api/openapi.rs`
- Modify: `tests/bases_api.rs`

**Interfaces:**
- Consumes: `validate_definition`, `QueryContext::for_base`, and `evaluate`.
- Produces:

```rust
pub struct BasePreviewRequest {
    pub definition: BaseFile,
    pub view: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

pub struct BasePreviewResponse {
    pub diagnostics: Vec<BaseDiagnostic>,
    pub output: Option<QueryOutput>,
    pub evaluation_error: Option<String>,
}
```

- Extends `BaseSummary` with `match_count: Option<u32>`.

- [ ] **Step 1: Add failing preview and count tests**

Test that previewing an unsaved status filter returns the same rows as saving the same definition and calling the view endpoint; verify preview does not create or alter a file. Test membership preview with `view: null`. Test unknown selected view returns `evaluation_error` with no write. Test `/bases` returns `match_count: 3` for the seeded reading membership and still lists other bases when one count cannot evaluate.

```rust
#[tokio::test]
async fn preview_matches_saved_evaluation_without_writing() {
    let (server, tmp) = ApiFixture::builder()
        .pre_index_seed(seed)
        .build()
        .into_server_and_temp();
    let before = std::fs::read_to_string(tmp.path().join("bases/reading.base.toml")).unwrap();

    let response = server.post("/api/vault/bases/preview").json(&serde_json::json!({
        "definition": preview_definition(),
        "view": "Continues",
        "limit": 25,
        "offset": 0
    })).await;
    response.assert_status_ok();
    assert_eq!(response.json::<serde_json::Value>()["output"]["total"], 2);
    assert_eq!(std::fs::read_to_string(tmp.path().join("bases/reading.base.toml")).unwrap(), before);
}
```

- [ ] **Step 2: Run failing preview test**

Run: `cargo test --test bases_api preview_matches_saved -- --nocapture`

Expected: 404 for the preview endpoint or missing summary field.

- [ ] **Step 3: Implement preview through the existing evaluator**

Use a synthetic slug only for diagnostics, combine membership and selected-view filters exactly as `evaluate_view` does, cap `limit` at 100, and return advisory diagnostics beside output. Structural errors return `output: None`; evaluation errors populate `evaluation_error` rather than masquerading as an empty result.

Extract the shared conversion from `(BaseDefinition, ViewDefinition, overrides)` to `QuerySpec` so saved evaluation and preview cannot drift.

- [ ] **Step 4: Implement independent membership counts**

For each parsed base, evaluate membership with no columns and `limit: Some(0)`, preserving the evaluator's true `total`. One error sets only that summary's `match_count` to `None`; it does not fail the list response.

Do the evaluations inside one `IndexHandle::with_index` closure to avoid repeated handle acquisition. Do not clone page rows because count output needs no materialized columns.

- [ ] **Step 5: Register Preview OpenAPI and run backend gates**

Run: `cargo test --test bases_api -- --nocapture`

Run: `cargo test`

Run: `cargo clippy --all-targets --all-features -- -D warnings`

Run: `cargo fmt --check`

Expected: all pass.

- [ ] **Step 6: Commit preview and counts**

```bash
git add src/api/bases.rs src/api/openapi.rs tests/bases_api.rs
git commit -m "feat(api): preview unsaved bases"
```

---

### Task 5: Generated Client and Ordered Draft Model

**Files:**
- Modify: `ui/src/api/schema.d.ts` by regeneration only
- Modify: `ui/src/api/bases.ts`
- Create: `ui/src/components/bases/definition-model.ts`
- Create: `ui/src/components/bases/__tests__/definition-model.test.ts`

**Interfaces:**
- Consumes: Tasks 3–4 OpenAPI.
- Produces:

```ts
export type FilterOp = "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "contains" | "in" | "links_to" | "is_empty" | "not_empty";
export type BaseFilter =
  | { all: BaseFilter[] }
  | { any: BaseFilter[] }
  | { not: BaseFilter }
  | { field: string; op: FilterOp; value?: unknown };

export interface DraftProperty { id: string; key: string; definition: PropertyDefinition }
export interface DraftView { id: string; name: string; layout: "table"; filter?: BaseFilter; sort: SortKey[]; group_by?: string; aggregates: Aggregate[]; columns: string[] }
export interface BaseDraft { name: string; description?: string; filter?: BaseFilter; properties: DraftProperty[]; views: DraftView[] }

export function fromWire(detail: BaseDetailResponse): BaseDraft;
export function toWire(draft: BaseDraft): BaseFile;
export function createMinimalDraft(name: string, description?: string, filter?: BaseFilter): BaseDraft;
```

- [ ] **Step 1: Regenerate OpenAPI types from the running backend**

Create a disposable configuration before starting the service:

1. Run `mktemp -d` and retain the returned directory as `<tmp>`.
2. Run `cargo run -- init <tmp>/vault`.
3. Create `<tmp>/xdg/clepsydra/config.toml` with:

```toml
[server]
host = "127.0.0.1"
port = 3000
dev_mode = true

[vault]
root = "<tmp>/vault"
```

4. Start `cargo run -- serve --port 3000` through the harness service manager with `XDG_CONFIG_HOME=<tmp>/xdg`; wait for port 3000.
5. Run `bun --cwd ui run openapi`.

Expected: generated paths include POST `/api/vault/bases`, PUT/DELETE `/api/vault/bases/{slug}`, POST `/api/vault/bases/preview`; `BaseDetailResponse` includes `revision`; `BaseSummary` includes nullable `match_count`; Filter is recursive rather than `Record<string, never>`.

Stop the temporary server and remove `<tmp>` after generation.

- [ ] **Step 2: Write failing ordered draft round-trip tests**

```ts
it("round-trips nested filters and property/view order", () => {
  const detail = baseDetail({
    filter: { all: [
      { field: "kind", op: "eq", value: "BOOK" },
      { any: [
        { field: "status", op: "eq", value: "reading" },
        { field: "status", op: "eq", value: "queued" },
      ] },
    ] },
    properties: {
      status: { type: "select", options: ["queued", "reading"] },
      rating: { type: "number" },
    },
  });
  const draft = fromWire(detail);
  expect(draft.properties.map((property) => property.key)).toEqual(["status", "rating"]);
  expect(toWire(draft)).toEqual(stripResponseFields(detail));
});

it("creates a valid minimal All view", () => {
  expect(createMinimalDraft("Books").views).toEqual([
    expect.objectContaining({ name: "All", layout: "table", columns: ["title"] }),
  ]);
});
```

- [ ] **Step 3: Run and observe failure**

Run: `bun --cwd ui run test src/components/bases/__tests__/definition-model.test.ts`

Expected: module/functions absent.

- [ ] **Step 4: Implement the pure model and field capabilities**

Use `crypto.randomUUID()` for editor-only stable row IDs; strip them in `toWire`. Build property objects with `Object.fromEntries(draft.properties.map(...))` so JSON insertion order follows the editor order.

Add pure helpers used by later controls:

```ts
export function operatorsFor(type: PropertyType | "system-multi" | "system-scalar"): FilterOp[];
export function canGroup(type: PropertyType | undefined): boolean;
export function aggregateFunctions(type: PropertyType | "word_count" | undefined): Array<"count" | "sum" | "avg" | "min" | "max">;
export function moveItem<T>(items: readonly T[], from: number, to: number): T[];
```

Match `PropertyType::is_ordered`, current group rules, aggregate rules, and system fields exactly.

- [ ] **Step 5: Add typed API hooks**

In `ui/src/api/bases.ts`, export aliases for list/file/mutation/preview DTOs and hooks:

```ts
export const useBases = () => $api.useQuery("get", "/api/vault/bases", {});
export const useCreateBase = () => $api.useMutation("post", "/api/vault/bases");
export const useUpdateBase = () => $api.useMutation("put", "/api/vault/bases/{slug}");
export const useDeleteBase = () => $api.useMutation("delete", "/api/vault/bases/{slug}");
export const usePreviewBase = () => $api.useMutation("post", "/api/vault/bases/preview");
```

On successful mutation, invalidate `queryKeys.bases.pathPrefix` and `queryKeys.query.pathPrefix`. Do not toast inside these generic hooks; workspace/index components own actionable copy.

- [ ] **Step 6: Run focused frontend checks and commit**

Run: `bun --cwd ui run test src/components/bases/__tests__/definition-model.test.ts`

Run: `bun --cwd ui run typecheck`

Expected: pass with no transport casts to `never`.

```bash
git add ui/src/api/schema.d.ts ui/src/api/bases.ts ui/src/components/bases/definition-model.ts ui/src/components/bases/__tests__/definition-model.test.ts
git commit -m "feat(ui): model editable base definitions"
```

---

### Task 6: Bases Index and Guided Creation

**Files:**
- Create: `ui/src/routes/bases.index.tsx`
- Create: `ui/src/components/bases/BasesIndex.tsx`
- Create: `ui/src/components/bases/CreateBaseDialog.tsx`
- Create: `ui/src/components/bases/__tests__/BasesIndex.test.tsx`
- Create: `ui/src/components/bases/__tests__/CreateBaseDialog.test.tsx`
- Modify: generated `ui/src/routeTree.gen.ts` through the router plugin only

**Interfaces:**
- Consumes: `useBases`, `useCreateBase`, `useDeleteBase`, `createMinimalDraft`, and `toWire` from Task 5.
- Produces: `/bases` discovery surface and guided create flow that navigates to `/bases/$slug/edit`.

- [ ] **Step 1: Write failing index-state tests**

Mock the API module. Cover loading, empty, summaries with match count, `null` count, saved diagnostics, and broken-file diagnostics. Assert actions are named `Open Reading Log`, `Configure Reading Log`, and `Delete Reading Log`.

```tsx
it("explains non-owning bases and offers creation when empty", () => {
  render(<BasesIndexView bases={[]} diagnostics={[]} onCreate={vi.fn()} />);
  expect(screen.getByText(/saved, non-owning view/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create base" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Write failing creation tests**

Cover generated slug, user-edited slug, explicit All-pages membership, default `All` view, server field error retention, and successful navigation. The custom membership case belongs to Task 8, when the final recursive editor exists.

```tsx
it("submits a minimal valid base", async () => {
  const create = vi.fn().mockResolvedValue({ slug: "books" });
  render(<CreateBaseDialog isOpen onClose={vi.fn()} onCreate={create} />);
  await userEvent.type(screen.getByLabelText("Name"), "Books");
  await userEvent.click(screen.getByRole("button", { name: "Create base" }));
  expect(create).toHaveBeenCalledWith({
    slug: "books",
    definition: expect.objectContaining({
      name: "Books",
      views: [expect.objectContaining({ name: "All", layout: "table" })],
    }),
  });
});
```

- [ ] **Step 3: Run tests and observe failure**

Run: `bun --cwd ui run test src/components/bases/__tests__/BasesIndex.test.tsx src/components/bases/__tests__/CreateBaseDialog.test.tsx`

Expected: components absent.

- [ ] **Step 4: Implement the index and route**

Use existing Vessel table/card primitives and semantic tokens. Broken parse diagnostics remain visible with a **Copy base file path** action; they do not link to the structured editor. Delete opens a confirmation stating that pages and properties remain.

The route is:

```tsx
export const Route = createFileRoute("/bases/")({
  component: BasesIndexRoute,
});
```

Let the TanStack Router Vite plugin regenerate `routeTree.gen.ts` during typecheck/build.

- [ ] **Step 5: Implement guided creation**

Use React Aria `Dialog`, `TextField`, `Input`, and buttons. Generate a lowercase hyphenated slug from the name until the user edits the slug manually. Task 6 starts membership explicitly at All pages (`filter: undefined`); Task 8 embeds the final `MembershipEditor` into this dialog using the same `BaseFilter | undefined` field. Do not introduce an interim string filter or second rule control.

On success close the dialog and navigate:

```ts
navigate({
  to: "/bases/$slug/edit",
  params: { slug: response.slug },
});
```

- [ ] **Step 6: Run focused tests, typecheck, and commit**

Run: `bun --cwd ui run test src/components/bases/__tests__/BasesIndex.test.tsx src/components/bases/__tests__/CreateBaseDialog.test.tsx`

Run: `bun --cwd ui run typecheck`

Expected: pass; route tree regenerates without manual edits.

```bash
git add ui/src/routes/bases.index.tsx ui/src/components/bases/BasesIndex.tsx ui/src/components/bases/CreateBaseDialog.tsx ui/src/components/bases/__tests__/BasesIndex.test.tsx ui/src/components/bases/__tests__/CreateBaseDialog.test.tsx ui/src/routeTree.gen.ts
git commit -m "feat(ui): add bases index and creation"
```

---

### Task 7: Definition Workspace Shell and Save Lifecycle

**Files:**
- Create: `ui/src/routes/bases.$slug.edit.tsx`
- Create: `ui/src/components/bases/BaseDefinitionWorkspace.tsx`
- Create: `ui/src/components/bases/DefinitionHeader.tsx`
- Create: `ui/src/components/bases/GeneralEditor.tsx`
- Create: `ui/src/components/bases/ValidationSummary.tsx`
- Create: `ui/src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx`
- Modify: generated `ui/src/routeTree.gen.ts` through the router plugin only

**Interfaces:**
- Consumes: `useBase`, `useUpdateBase`, `fromWire`, `toWire`, and diagnostic DTOs.
- Produces: controlled section editors with `draft`, `setDraft`, `diagnostics`, and `focusDiagnostic(path)` contracts used by Tasks 8–10.

- [ ] **Step 1: Write failing lifecycle tests**

Mock data/mutations and cover initial hydration, dirty state, explicit save with original revision, discard, edits during in-flight save remaining dirty, stale conflict preserving the draft, refetch not overwriting dirty state, and unsaved navigation confirmation.

```tsx
it("preserves a dirty draft on revision conflict", async () => {
  updateBase.mockRejectedValue(conflict({ revision: "server-new" }));
  renderWorkspace();
  await userEvent.clear(screen.getByLabelText("Name"));
  await userEvent.type(screen.getByLabelText("Name"), "My Reading");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent(/changed outside clepsydra/i);
  expect(screen.getByLabelText("Name")).toHaveValue("My Reading");
  expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run and observe failure**

Run: `bun --cwd ui run test src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx`

Expected: route/components absent.

- [ ] **Step 3: Implement route and workspace state machine**

Use generation counters, matching the proven page-editor pattern, so a save only marks the submitted generation clean:

```ts
const editGeneration = useRef(0);
const savedGeneration = useRef(0);
const isDirty = editGeneration.current > savedGeneration.current;

const changeDraft = (update: (draft: BaseDraft) => BaseDraft) => {
  editGeneration.current += 1;
  setDraft(update);
};
```

Hydrate from server only on first load or when clean. Save `toWire(draft)` with the revision captured for that draft; on success replace both baseline and revision with the response. On `409`, retain the draft and show reload/review actions. Discard restores the last server baseline.

Use TanStack Router's blocker for in-app navigation and `beforeunload` for browser close/reload. The confirmation must offer Stay and Discard; Save remains in the workspace header rather than inside the blocker.

- [ ] **Step 4: Implement General and validation summary**

General edits name/description and displays the immutable slug and `bases/<slug>.base.toml` path. Render **Copy base file path** with the existing `CopyButton`; browsers cannot portably launch the user's local editor, so do not add a false Open action or a new backend endpoint.

`ValidationSummary` groups diagnostics by section. Each link carries the exact diagnostic path; section editors register focus targets in a `Map<string, HTMLElement>`.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `bun --cwd ui run test src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx`

Run: `bun --cwd ui run typecheck`

Expected: pass; no dirty draft is overwritten by query invalidation.

- [ ] **Step 6: Commit workspace lifecycle**

```bash
git add ui/src/routes/bases.$slug.edit.tsx ui/src/components/bases/BaseDefinitionWorkspace.tsx ui/src/components/bases/DefinitionHeader.tsx ui/src/components/bases/GeneralEditor.tsx ui/src/components/bases/ValidationSummary.tsx ui/src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx ui/src/routeTree.gen.ts
git commit -m "feat(ui): add base definition workspace"
```

---

### Task 8: Accessible Recursive Membership Editor

**Files:**
- Create: `ui/src/components/bases/MembershipEditor.tsx`
- Create: `ui/src/components/bases/FilterGroupEditor.tsx`
- Create: `ui/src/components/bases/FilterComparisonEditor.tsx`
- Create: `ui/src/components/bases/__tests__/MembershipEditor.test.tsx`
- Modify: `ui/src/components/bases/BaseDefinitionWorkspace.tsx`
- Modify: `ui/src/components/bases/CreateBaseDialog.tsx`

**Interfaces:**
- Consumes: `BaseFilter`, field definitions, `operatorsFor`, and workspace focus registration.
- Produces:

```ts
interface MembershipEditorProps {
  value: BaseFilter | undefined;
  properties: DraftProperty[];
  onChange(value: BaseFilter | undefined): void;
  registerFocus(path: string, element: HTMLElement | null): void;
}
```

- [ ] **Step 1: Write failing recursive behavior tests**

Cover All pages, adding comparison/all/any/not nodes, field-driven operators, value controls, nested removal collapsing to All pages only when root becomes empty, accessible group labels, and the guided creation dialog submitting the same edited filter.

```tsx
it("builds kind is BOOK and status is reading", async () => {
  const onChange = vi.fn();
  render(<MembershipEditor value={undefined} properties={properties} onChange={onChange} registerFocus={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Add condition" }));
  await userEvent.selectOptions(screen.getByLabelText("Field for condition 1"), "kind");
  await userEvent.selectOptions(screen.getByLabelText("Operator for condition 1"), "eq");
  await userEvent.type(screen.getByLabelText("Value for condition 1"), "BOOK");
  expect(latest(onChange)).toEqual({ field: "kind", op: "eq", value: "BOOK" });
});

it("labels nested boolean structure", () => {
  renderEditor({ all: [{ field: "kind", op: "eq", value: "BOOK" }, { any: [] }] });
  expect(screen.getByRole("group", { name: "Match all of 2 conditions" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Match any conditions" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run and observe failure**

Run: `bun --cwd ui run test src/components/bases/__tests__/MembershipEditor.test.tsx`

Expected: components absent.

- [ ] **Step 3: Implement immutable tree edits**

Represent child locations as index paths such as `["all", 1, "any", 0]`; implement pure `replaceFilterAtPath` and `removeFilterAtPath` helpers in `definition-model.ts` with tests. Do not mutate nested arrays.

Comparison controls:

- system multi fields (`tags`, `aliases`): contains/in/is_empty/not_empty;
- number/date/date-time: equality and ordering;
- relation: eq/ne/links_to/is_empty/not_empty;
- select/multi-select: option picker and compatible membership operators;
- bool: boolean select;
- value-less operators hide and delete `value`.

Use declared select options and existing page relation suggestions. Freeform remains available for open vocabularies.

- [ ] **Step 4: Implement accessible group controls**

Each group is a React Aria-labelled region. Buttons are named with position and operation: `Add condition to Match all`, `Convert condition 2 to Any group`, `Remove condition 2`. Nesting indentation is visual only; labels expose boolean meaning.

Reuse this editor in guided creation for the optional initial membership rule.

- [ ] **Step 5: Run tests, accessibility assertions, and commit**

Run: `bun --cwd ui run test src/components/bases/__tests__/MembershipEditor.test.tsx src/components/bases/__tests__/definition-model.test.ts`

Run: `bun --cwd ui run typecheck`

Expected: pass.

```bash
git add ui/src/components/bases/MembershipEditor.tsx ui/src/components/bases/FilterGroupEditor.tsx ui/src/components/bases/FilterComparisonEditor.tsx ui/src/components/bases/definition-model.ts ui/src/components/bases/__tests__/MembershipEditor.test.tsx ui/src/components/bases/__tests__/definition-model.test.ts ui/src/components/bases/BaseDefinitionWorkspace.tsx ui/src/components/bases/CreateBaseDialog.tsx
git commit -m "feat(ui): edit base membership rules"
```

---

### Task 9: Typed Properties Editor

**Files:**
- Create: `ui/src/components/bases/PropertiesEditor.tsx`
- Create: `ui/src/components/bases/PropertyDefinitionEditor.tsx`
- Create: `ui/src/components/bases/__tests__/PropertiesEditor.test.tsx`
- Modify: `ui/src/components/bases/BaseDefinitionWorkspace.tsx`

**Interfaces:**
- Consumes: `DraftProperty`, `PropertyType`, `moveItem`, system-field constants, and focus registration.
- Produces controlled ordered properties with no page-migration side effects.

- [ ] **Step 1: Write failing type and safety tests**

Cover all nine types; options only for select/multi-select; cardinality only for relation; open vocabulary empty options; duplicate/reserved/empty keys; move up/down; removal warning; rename warning.

```tsx
it.each([
  "text", "number", "bool", "date", "datetime", "select", "multi_select", "url", "relation",
] as const)("authors a %s property", async (type) => {
  const onChange = vi.fn();
  renderProperties({ onChange });
  await addProperty("field", type);
  expect(latest(onChange).properties.at(-1)?.definition.type).toBe(type);
});

it("states that removing a declaration keeps page values", async () => {
  renderProperties({ properties: [property("status", "select")] });
  await userEvent.click(screen.getByRole("button", { name: "Remove status" }));
  expect(screen.getByRole("dialog")).toHaveTextContent(/page frontmatter remains unchanged/i);
});
```

- [ ] **Step 2: Run and observe failure**

Run: `bun --cwd ui run test src/components/bases/__tests__/PropertiesEditor.test.tsx`

Expected: components absent.

- [ ] **Step 3: Implement ordered property authoring**

Render an ordered list with explicit `Move <key> up/down` buttons. Key validation is immediate and feeds local error diagnostics into the workspace Save eligibility.

Type change resets incompatible settings:

```ts
function changePropertyType(property: DraftProperty, type: PropertyType): DraftProperty {
  return {
    ...property,
    definition: {
      type,
      ...(type === "select" || type === "multi_select" ? { options: [] } : {}),
      ...(type === "relation" ? { many: true } : {}),
    },
  };
}
```

Option chips support add, rename, remove, move up, and move down. Empty options display “Open vocabulary”. Relation cardinality copy says the constraint is advisory.

- [ ] **Step 4: Implement rename/removal semantics**

Editing a persisted key displays: “This changes the declaration only. Existing page frontmatter is not renamed.” Require confirmation before committing the key edit into the draft. Removing a persisted declaration uses the same explicit non-migration message. Do not call page mutation APIs.

Show system fields in a separate read-only reference; prevent their bare names from being declared.

- [ ] **Step 5: Run tests and commit**

Run: `bun --cwd ui run test src/components/bases/__tests__/PropertiesEditor.test.tsx`

Run: `bun --cwd ui run typecheck`

Expected: pass.

```bash
git add ui/src/components/bases/PropertiesEditor.tsx ui/src/components/bases/PropertyDefinitionEditor.tsx ui/src/components/bases/__tests__/PropertiesEditor.test.tsx ui/src/components/bases/BaseDefinitionWorkspace.tsx
git commit -m "feat(ui): edit base property schemas"
```

---

### Task 10: Views Editor and Unsaved Preview

**Files:**
- Create: `ui/src/components/bases/ViewsEditor.tsx`
- Create: `ui/src/components/bases/ViewDefinitionEditor.tsx`
- Create: `ui/src/components/bases/BasePreview.tsx`
- Create: `ui/src/components/bases/__tests__/ViewsEditor.test.tsx`
- Modify: `ui/src/components/bases/BaseDefinitionWorkspace.tsx`
- Modify: `ui/src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx`

**Interfaces:**
- Consumes: `DraftView`, filter editor, field capabilities, `usePreviewBase`, and existing `BaseTableView` rendering contract.
- Produces: complete view authoring and debounced/superseded preview.

- [ ] **Step 1: Write failing view behavior tests**

Cover add, duplicate with unique name, rename, reorder, delete guard, visible-column order, ordered sorts, group capability, aggregate capability, table-only layout, and nested per-view filter.

```tsx
it("duplicates a view with an independent deep copy", async () => {
  const onChange = vi.fn();
  renderViews({ views: [view({ name: "All", columns: ["title", "status"] })], onChange });
  await userEvent.click(screen.getByRole("button", { name: "Duplicate All" }));
  const result = latest(onChange);
  expect(result.map((item) => item.name)).toEqual(["All", "All copy"]);
  expect(result[1]).not.toBe(result[0]);
  expect(result[1].columns).not.toBe(result[0].columns);
});

it("offers numeric aggregates only for numeric fields", () => {
  renderSelectedView({ properties: [property("rating", "number"), property("status", "select")] });
  expect(aggregateFieldOptions()).toContain("rating");
  expect(aggregateFieldOptions()).not.toContain("status");
});
```

- [ ] **Step 2: Write failing preview supersession tests**

Use fake timers. Change a draft twice before the debounce expires; assert one request for the newest draft. Resolve an older request after a newer request and assert the stale response never renders. Cover membership preview, selected-view preview, no matches, structural diagnostics, evaluation error, and network failure.

- [ ] **Step 3: Run and observe failure**

Run: `bun --cwd ui run test src/components/bases/__tests__/ViewsEditor.test.tsx src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx`

Expected: view/preview components absent.

- [ ] **Step 4: Implement complete view controls**

View list actions use immutable deep copies. Keep at least one view in the guided editor; manual viewless definitions loaded from disk show an empty state and **Add view** without fabricating one before the user edits.

Columns combine system fields and declarations. Sorts are ordered. Group fields call `canGroup`. Aggregate function/field choices call `aggregateFunctions`; `count` omits field. Embed `MembershipEditor` for the view filter and label it “Additional filter; always ANDed with base membership.”

- [ ] **Step 5: Implement debounced preview with request identity**

```ts
const requestId = useRef(0);
const preview = async (draft: BaseDraft, view?: string) => {
  const id = ++requestId.current;
  const response = await previewMutation.mutateAsync({
    body: { definition: toWire(draft), view, limit: 50, offset: 0 },
  });
  if (id === requestId.current) setPreviewResponse(response);
};
```

Debounce by 250 ms and clear the timer on unmount. Do not disable Save solely because preview networking failed. Render flat/grouped output using a read-only extraction of the existing base table presentation; do not fork query-output formatting.

Preview status uses `aria-live="polite"`; result refresh does not focus the table.

- [ ] **Step 6: Run focused tests and commit**

Run: `bun --cwd ui run test src/components/bases/__tests__/ViewsEditor.test.tsx src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx`

Run: `bun --cwd ui run typecheck`

Expected: pass.

```bash
git add ui/src/components/bases/ViewsEditor.tsx ui/src/components/bases/ViewDefinitionEditor.tsx ui/src/components/bases/BasePreview.tsx ui/src/components/bases/__tests__/ViewsEditor.test.tsx ui/src/components/bases/BaseDefinitionWorkspace.tsx ui/src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx
git commit -m "feat(ui): configure and preview base views"
```

---

### Task 11: Navigation, Usage-Surface Entry, and Documentation

**Files:**
- Modify: `ui/src/components/bases/BaseTable.tsx`
- Modify: `ui/src/components/bases/BaseTableView.tsx`
- Modify: `ui/src/components/bases/__tests__/BaseTableView.test.tsx`
- Modify: `ui/src/components/codex/CodexFrame.tsx`
- Modify: `ui/src/components/codex/CommandPalette.tsx`
- Modify: `ui/src/components/codex/__tests__/CodexFrame.test.tsx`
- Modify: `ui/src/components/codex/__tests__/CommandPalette.test.tsx`
- Modify: `ui/src/docs/content/bases.mdx`

**Interfaces:**
- Consumes: routes delivered by Tasks 6–7.
- Produces: discoverable BASES navigation, Configure action, and accurate user documentation.

- [ ] **Step 1: Write failing navigation and Configure tests**

Assert BASES is present in the header rail, active on `/bases`, and command palette action navigates to `/bases`. Extend `BaseTableView` props with `onConfigure`; clicking **Configure Reading Log** invokes it.

```tsx
it("opens definition workspace from a saved base", async () => {
  const props = renderView({ onConfigure: vi.fn() });
  await userEvent.click(screen.getByRole("button", { name: "Configure Reading Log" }));
  expect(props.onConfigure).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run and observe failure**

Run: `bun --cwd ui run test src/components/bases/__tests__/BaseTableView.test.tsx src/components/codex/__tests__/CodexFrame.test.tsx src/components/codex/__tests__/CommandPalette.test.tsx`

Expected: BASES nav and Configure action absent.

- [ ] **Step 3: Implement navigation and active-view detection**

Add `"bases"` to `View`, `NAV`, location detection, and `onNav`. Keep diegetic indexes sequential and adjust tests that assert labels/indexes. Add command-palette action “Open Bases”.

`BaseTable` navigates Configure to `/bases/$slug/edit`; `BaseTableView` remains presentational.

- [ ] **Step 4: Update Bases documentation**

Replace statements that frontend authoring is unavailable. Document:

- `/bases` discovery and guided creation;
- Configure workspace sections;
- explicit Save and revision conflicts;
- preview behavior;
- property rename/removal not migrating page keys;
- deletion preserving pages/properties;
- manual TOML as advanced escape hatch and parse-failure recovery.

Keep the TOML syntax reference; the UI removes the requirement, not the format.

- [ ] **Step 5: Run focused tests and commit**

Run: `bun --cwd ui run test src/components/bases/__tests__/BaseTableView.test.tsx`

Run: `bun --cwd ui run test src/components/codex/__tests__/CodexFrame.test.tsx src/components/codex/__tests__/CommandPalette.test.tsx`

Run: `bun --cwd ui run typecheck`

Expected: pass.

```bash
git add ui/src/components/bases/BaseTable.tsx ui/src/components/bases/BaseTableView.tsx ui/src/components/bases/__tests__/BaseTableView.test.tsx ui/src/components/codex/CodexFrame.tsx ui/src/components/codex/CommandPalette.tsx ui/src/components/codex/__tests__/CodexFrame.test.tsx ui/src/components/codex/__tests__/CommandPalette.test.tsx ui/src/docs/content/bases.mdx
git commit -m "feat(ui): expose bases authoring"
```

Add the exact modified Codex test paths to `git add`; never stage unrelated files.

---

### Task 12: End-to-End Verification and Cleanup

**Files:**
- Modify only files implicated by real verification failures.
- Do not create snapshot or source-text tests to bypass behavioral failures.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified end-to-end feature and completed repository gates.

- [ ] **Step 1: Run full backend verification**

Run:

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

Expected: all commands exit 0. Fix only failures caused by this feature; preserve unrelated work.

- [ ] **Step 2: Run full frontend verification**

Run:

```bash
bun --cwd ui run typecheck
bun --cwd ui run lint
bun --cwd ui run test
bun --cwd ui run build
```

Expected: all commands exit 0.

- [ ] **Step 3: Smoke the complete workflow in a real browser**

Start Clepsydra against a disposable initialized vault and use the browser tool at desktop and narrow widths:

1. Open `/bases`; confirm the empty state and create action.
2. Create “Reading Log”; confirm generated `reading-log` slug and `All` view.
3. Configure membership as `kind is BOOK AND (status is reading OR queued)`.
4. Add text `author`, select `status`, number `rating`, date `started`, and relation `series` properties.
5. Configure a grouped view by status, descending started sort, count, and average rating.
6. Confirm unsaved preview responds before Save and that keyboard focus stays in the edited control.
7. Save, reload, and confirm definition/order persisted.
8. Modify the TOML externally, attempt a stale Save, and confirm the draft remains with conflict recovery.
9. Edit a page's declared cell from the saved table.
10. Delete the base and confirm the Markdown page and frontmatter property remain unchanged.
11. Repeat rule/property/view reordering with keyboard buttons only.
12. At narrow width, confirm rail/workspace remain operable without horizontal action loss.

Capture exact observations; component tests are not a substitute for this smoke path.

- [ ] **Step 4: Cleanup after successful smoke**

Only after the smoke passes:

- remove temporary/disposable vault data;
- remove dead imports, obsolete manual-only copy, and any superseded base-authoring helpers;
- run `bun --cwd ui run knip` and resolve only newly introduced dead exports;
- confirm no `TODO`, placeholder, raw TOML editor, generic file writer, or backend draft store was introduced.

- [ ] **Step 5: Re-run affected gates after cleanup**

Re-run the backend/frontend command whose files changed during cleanup, then rerun the full test suites if behavior changed. Expected: exit 0.

- [ ] **Step 6: Commit verification cleanup**

Stage exact changed paths and commit only if cleanup changed tracked files:

```bash
git commit -m "chore(bases): finish authoring verification"
```

Do not create an empty commit.

---

## Spec Coverage Map

- Canonical TOML, comment/unknown-key preservation, revisions, atomic writes: Tasks 1–3.
- Create/update/delete and non-owning deletion: Tasks 2–3.
- Unsaved preview and match counts: Task 4.
- Typed generated client and ordered draft: Task 5.
- `/bases` discovery and guided minimal creation: Task 6.
- Dedicated workspace, explicit Save, dirty/conflict/navigation behavior: Task 7.
- Recursive membership: Task 8.
- All property types and non-migration semantics: Task 9.
- Full view editor and preview states: Task 10.
- Main navigation, command palette, Configure, and docs: Task 11.
- Accessibility, browser workflow, full gates, and cleanup: Tasks 6–12.
