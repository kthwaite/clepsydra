# Inline Base Member Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create new vault pages from an inline Base-table draft row, atomically accepting only pages that match both Base membership and the active saved view.

**Architecture:** A new Base-member domain module evaluates complete page candidates and computes per-view creation capability without duplicating filter semantics in React. A dedicated `POST /api/vault/bases/{slug}/members` endpoint validates the loaded Base revision, coerces typed fields, derives a canonical path, evaluates membership plus the active view, and calls the mutation coordinator once. The frontend composes draft fields from the active view and server capability, renders one accessible draft row, and refreshes the authoritative Base query after creation.

**Tech Stack:** Rust 2024, Axum, serde/serde_json, toml, utoipa/OpenAPI, Tokio, React 19, TypeScript 5.9, TanStack Query, React Aria Components, Vitest, Testing Library, Biome, Bun.

## Global Constraints

- Bases remain non-owning filtered views; creating or deleting a Base never owns or deletes member pages.
- A failed member submission must leave neither a page file nor an index row.
- A successful candidate must match both Base membership and the named active-view filter.
- The server owns filter/capability semantics; React only renders the returned capability.
- The created page body is empty; body authoring remains out of scope.
- One inline draft may exist at a time.
- `ui/src/api/schema.d.ts` is generated from OpenAPI and must never be hand-edited.
- Reuse the existing mutation coordinator, filter matcher, typed cell registry, metadata controls, query invalidation helpers, and semantic UI tokens.
- Preserve unrelated work. Stage only paths named by the active task; never use `git add .` or `git add -A`.
- Every task follows red-green-refactor and ends with focused verification plus an exact-path commit.
- Execute implementation in an isolated worktree created through `using-git-worktrees`; merge the completed branch into `develop` only after review and all verification gates pass.

## File Structure

### Rust domain and API

- Create `src/vault/base_member.rs` — candidate filter context, membership/view evaluation, filter-field collection, tri-state blank-page capability analysis, and shared diagnostic DTOs.
- Modify `src/vault/base.rs` — expose the existing metadata comparison dispatcher to the sibling member module without changing LSP behavior.
- Modify `src/vault/mod.rs` — register the focused `base_member` module.
- Create `src/vault/property_value.rs` — strict JSON-to-native-TOML coercion for create-time Base fields.
- Modify `src/vault/new_note.rs` — add deterministic short-ID-aware canonical path construction for kind/project filing while retaining existing default-note behavior.
- Create `src/api/base_members.rs` — request/response types, structured validation errors, atomic endpoint, retryable generated-path collision handling, and route.
- Modify `src/api/bases.rs` — add per-view member-creation capability to `BaseDetailResponse` and merge the member route.
- Modify `src/api/error.rs` — add a `422` structured-detail constructor.
- Modify `src/api/mod.rs` — register the Base-member API module.
- Modify `src/api/openapi.rs` — publish endpoint and schemas.
- Modify `tests/bases_api.rs` — endpoint, capability, atomicity, typing, revision, view, and OpenAPI integration contracts.

### React client

- Regenerate `ui/src/api/schema.d.ts` — generated endpoint and schema types.
- Modify `ui/src/api/bases.ts` — member request/response exports, mutation hook, invalidation, and structured diagnostic decoding.
- Modify `ui/src/api/bases.test.ts` — member-mutation invalidation and diagnostic decoding.
- Create `ui/src/components/bases/member-draft.ts` — pure draft-field composition, ordering, default-value, and error-mapping helpers.
- Create `ui/src/components/bases/__tests__/member-draft.test.ts` — pure helper contracts.
- Create `ui/src/components/bases/BaseMemberDraft.tsx` — controlled draft form/table, typed property cells, system metadata controls, keyboard behavior, errors, and focus.
- Modify `ui/src/components/bases/EditableCell.tsx` and `ui/src/components/bases/cells/` — optional accessible labels for reuse inside a draft.
- Modify `ui/src/components/codex/KindSelect.tsx` and `ui/src/components/codex/ProjectCombo.tsx` — optional accessible labels while preserving existing defaults.
- Create `ui/src/components/bases/__tests__/BaseMemberDraft.test.tsx` — component behavior and accessibility contracts.
- Modify `ui/src/components/bases/BaseTable.tsx` — mutation ownership, capability selection, create state, invalidation, and created-row focus target.
- Modify `ui/src/components/bases/BaseTableView.tsx` — toolbar action, draft placement, disabled explanation, and created-title refs.
- Create `ui/src/components/bases/__tests__/BaseTable.test.tsx` — API wiring, failure preservation, and refresh contracts.
- Modify `ui/src/components/bases/__tests__/BaseTableView.test.tsx` — presentational toolbar, grouped rendering, and focus behavior.
- Modify `ui/src/docs/content/bases.mdx` — user-facing inline creation behavior and limitations.

---

### Task 1: Candidate Evaluation and Creation Capability

**Files:**
- Create: `src/vault/base_member.rs`
- Modify: `src/vault/base.rs:350-441`
- Modify: `src/vault/mod.rs`

**Interfaces:**
- Consumes: `BaseDefinition`, `Filter`, `Op`, `ViewDefinition`, `PageMeta`, and existing `cmp_matches_meta` semantics from `src/vault/base.rs`.
- Produces:
  - `pub enum BaseMemberScope { Membership, View, Field }`
  - `pub struct BaseMemberFieldRequirement { pub field: String, pub membership: bool, pub view: bool }`
  - `pub struct BaseMemberDiagnostic { pub scope: BaseMemberScope, pub field: Option<String>, pub filter_path: Option<String>, pub message: String }`
  - `pub struct BaseMemberCapability { pub view: String, pub enabled: bool, pub fields: Vec<BaseMemberFieldRequirement>, pub blockers: Vec<BaseMemberDiagnostic> }`
  - `pub struct CandidateDerived { pub word_count: u32, pub journal_date: Option<chrono::NaiveDate> }`
  - `pub fn candidate_matches(base: &BaseDefinition, view: &ViewDefinition, meta: &PageMeta, path: &str, derived: &CandidateDerived) -> Result<(), Vec<BaseMemberDiagnostic>>`
  - `pub fn creation_capabilities(base: &BaseDefinition) -> Vec<BaseMemberCapability>`

- [ ] **Step 1: Write failing unit tests for field collection and scope merging**

Add tests in `src/vault/base_member.rs` using parsed definitions so the test exercises actual AST shapes:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::base::parse_base;
    use std::path::Path;

    fn base(source: &str) -> BaseDefinition {
        parse_base(Path::new("bases/reading.base.toml"), source)
            .0
            .expect("valid base")
    }

    #[test]
    fn capability_orders_membership_and_view_fields_without_duplicates() {
        let base = base(r#"
name = "Reading"
[filter]
all = [
  { field = "kind", op = "eq", value = "BOOK" },
  { field = "status", op = "ne", value = "finished" }
]
[properties]
status = { type = "select", options = ["queued", "reading", "finished"] }
rating = { type = "number" }
[[views]]
name = "Unread"
layout = "table"
filter = { field = "status", op = "eq", value = "reading" }
columns = ["title", "rating"]
"#);

        let capability = creation_capabilities(&base).remove(0);
        assert!(capability.enabled);
        assert_eq!(
            capability.fields,
            vec![
                BaseMemberFieldRequirement {
                    field: "kind".into(), membership: true, view: false,
                },
                BaseMemberFieldRequirement {
                    field: "status".into(), membership: true, view: true,
                },
            ]
        );
    }
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cargo test vault::base_member::tests::capability_orders_membership_and_view_fields_without_duplicates -- --exact`

Expected: FAIL because `base_member` and `creation_capabilities` do not exist.

- [ ] **Step 3: Expose one shared filter dispatcher from `base.rs`**

Keep `base_matches_meta` behavior unchanged. Replace the private dispatcher with a crate-visible context-aware function:

```rust
pub(crate) struct MetaFilterContext<'a> {
    pub meta: &'a crate::vault::page::PageMeta,
    pub path: &'a str,
    pub word_count: Option<u32>,
    pub journal_date: Option<chrono::NaiveDate>,
}

pub(crate) fn filter_matches_meta(filter: &Filter, context: &MetaFilterContext<'_>) -> bool {
    match filter {
        Filter::All(children) => children.iter().all(|child| filter_matches_meta(child, context)),
        Filter::Any(children) => children.iter().any(|child| filter_matches_meta(child, context)),
        Filter::Not(child) => !filter_matches_meta(child, context),
        Filter::Cmp { field, op, value } => cmp_matches_meta(field, *op, value, context),
    }
}
```

Extend only the system-field scalar branch:

```rust
"word_count" => context.word_count.map(|value| value.to_string()),
"journal_date" => context.journal_date.map(|value| value.to_string()),
```

`base_matches_meta` passes `word_count: None` and `journal_date: None`, preserving its LSP contract. Candidate evaluation passes `Some(0)` for a new empty page.

- [ ] **Step 4: Implement field collection and tri-state capability analysis**

Create `src/vault/base_member.rs` with serde/utoipa derives on all response-facing types. Use a tri-state satisfiability model so disabling is conservative:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Possibility {
    AlwaysTrue,
    Maybe,
    AlwaysFalse,
}

fn all(values: impl Iterator<Item = Possibility>) -> Possibility {
    values.fold(Possibility::AlwaysTrue, |acc, value| match (acc, value) {
        (Possibility::AlwaysFalse, _) | (_, Possibility::AlwaysFalse) => Possibility::AlwaysFalse,
        (Possibility::AlwaysTrue, Possibility::AlwaysTrue) => Possibility::AlwaysTrue,
        _ => Possibility::Maybe,
    })
}

fn any(values: impl Iterator<Item = Possibility>) -> Possibility {
    values.fold(Possibility::AlwaysFalse, |acc, value| match (acc, value) {
        (Possibility::AlwaysTrue, _) | (_, Possibility::AlwaysTrue) => Possibility::AlwaysTrue,
        (Possibility::AlwaysFalse, Possibility::AlwaysFalse) => Possibility::AlwaysFalse,
        _ => Possibility::Maybe,
    })
}
```

Rules:

```rust
fn comparison_possibility(field: &str, op: Op, value: &serde_json::Value) -> Possibility {
    let bare = field.strip_prefix("sys.").or_else(|| field.strip_prefix("prop.")).unwrap_or(field);
    match bare {
        // A new empty body has exactly zero words.
        "word_count" => evaluate_fixed_scalar(Some("0"), op, value),
        // Inline Base creation never creates a journal-date projection.
        "journal_date" => evaluate_fixed_scalar(None, op, value),
        // User input or generated candidate state decides every other field.
        _ => Possibility::Maybe,
    }
}
```

Collect comparison fields in depth-first filter order. Merge duplicate bare field names while retaining the first occurrence and setting `membership`/`view` flags. A view is disabled only when `membership AND view` evaluates to `AlwaysFalse`; report each fixed-derived comparison that contributes an `AlwaysFalse` path.

- [ ] **Step 5: Add failing and passing tests for impossible derived filters and candidate matching**

Add:

```rust
#[test]
fn positive_word_count_disables_blank_member_creation() {
    let base = base(r#"
name = "Longform"
filter = { field = "word_count", op = "gt", value = 0 }
[[views]]
name = "All"
layout = "table"
"#);
    let capability = creation_capabilities(&base).remove(0);
    assert!(!capability.enabled);
    assert_eq!(capability.blockers[0].field.as_deref(), Some("word_count"));
    assert_eq!(capability.blockers[0].filter_path.as_deref(), Some("filter"));
}

#[test]
fn candidate_must_match_membership_and_view() {
    let base = base(READING_SOURCE);
    let view = &base.file.views[0];
    let mut meta = PageMeta::new();
    meta.title = Some("New Book".into());
    meta.kind = Some(Kind::Book);
    meta.extra.insert("status".into(), toml::Value::String("queued".into()));

    let errors = candidate_matches(
        &base,
        view,
        &meta,
        "books/20260809.new-book.Ab3xYz90.md",
        &CandidateDerived { word_count: 0, journal_date: None },
    ).unwrap_err();

    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].scope, BaseMemberScope::View);
    assert_eq!(errors[0].field.as_deref(), Some("status"));
}
```

Define `READING_SOURCE` in the test module with membership `kind = BOOK` and view `status = reading`. Make `candidate_matches` emit one diagnostic for each failing top-level scope; include the comparison field/filter path when the failing predicate is a comparison, otherwise include the scope root (`filter` or `views.<name>.filter`).

- [ ] **Step 6: Run domain tests and format**

Run: `cargo test vault::base_member -- --nocapture`

Expected: PASS.

Run: `cargo fmt --check`

Expected: PASS after running `cargo fmt` if formatting changed.

- [ ] **Step 7: Commit the domain slice**

```bash
git add src/vault/base.rs src/vault/base_member.rs src/vault/mod.rs
git commit -m "feat(bases): evaluate new member candidates"
```

---

### Task 2: Typed Property Coercion and Canonical Paths

**Files:**
- Create: `src/vault/property_value.rs`
- Modify: `src/vault/new_note.rs`
- Modify: `src/vault/mod.rs`

**Interfaces:**
- Consumes: `PropertyDefinition`, `PropertyType`, `Kind`, `VaultPath`, and `page_filename`.
- Produces:
  - `pub enum PropertyValueError`
  - `pub fn coerce_property_value(key: &str, value: &serde_json::Value, definition: &PropertyDefinition) -> Result<toml::Value, PropertyValueError>`
  - `pub(crate) fn build_projected_note_path(title: &str, created: DateTime<Utc>, kind: Kind, project: Option<&str>, short_id: &str) -> Result<VaultPath, NewNoteError>`

- [ ] **Step 1: Write failing coercion tests for every Base property type**

Create `src/vault/property_value.rs` with tests first:

```rust
#[test]
fn coercion_preserves_native_types() {
    assert_eq!(coerce("count", json!(3), property(PropertyType::Number)).unwrap(), toml::Value::Integer(3));
    assert_eq!(coerce("score", json!(3.5), property(PropertyType::Number)).unwrap(), toml::Value::Float(3.5));
    assert_eq!(coerce("done", json!(true), property(PropertyType::Bool)).unwrap(), toml::Value::Boolean(true));
    assert!(matches!(coerce("started", json!("2026-08-09"), property(PropertyType::Date)).unwrap(), toml::Value::Datetime(_)));
    assert!(matches!(coerce("seen", json!("2026-08-09T12:30:00Z"), property(PropertyType::Datetime)).unwrap(), toml::Value::Datetime(_)));
    assert_eq!(
        coerce("genres", json!(["sf", "essay"]), multi_select(&["sf", "essay"])).unwrap(),
        toml::Value::Array(vec![toml::Value::String("sf".into()), toml::Value::String("essay".into())]),
    );
}

#[test]
fn coercion_rejects_wrong_shapes_and_unknown_select_options() {
    let error = coerce("rating", json!("five"), property(PropertyType::Number)).unwrap_err();
    assert_eq!(error.to_string(), "rating must be a number");
    let error = coerce("status", json!("paused"), select(&["reading", "finished"])).unwrap_err();
    assert_eq!(error.to_string(), "status must be one of: reading, finished");
}
```

Also cover text, URL, relation, and select as strings; multi-select as a unique string array; invalid date/datetime; null; nested JSON objects; and non-finite numeric rejection where applicable.

- [ ] **Step 2: Run coercion tests and verify RED**

Run: `cargo test vault::property_value -- --nocapture`

Expected: FAIL because `property_value` is not registered or implemented.

- [ ] **Step 3: Implement strict native TOML coercion**

Use explicit type branches rather than string sniffing:

```rust
pub fn coerce_property_value(
    key: &str,
    value: &serde_json::Value,
    definition: &PropertyDefinition,
) -> Result<toml::Value, PropertyValueError> {
    match definition.property_type {
        PropertyType::Text | PropertyType::Url | PropertyType::Relation => {
            string_value(key, value).map(toml::Value::String)
        }
        PropertyType::Select => select_value(key, value, definition),
        PropertyType::MultiSelect => multi_select_value(key, value, definition),
        PropertyType::Number => number_value(key, value),
        PropertyType::Bool => value.as_bool().map(toml::Value::Boolean)
            .ok_or_else(|| PropertyValueError::shape(key, "a boolean")),
        PropertyType::Date => datetime_value(key, value, DateShape::Date),
        PropertyType::Datetime => datetime_value(key, value, DateShape::DateTime),
    }
}
```

Do not change property-patch advisory semantics in this task. This strict coercer applies only to pre-creation drafts where malformed input must not create a page.

- [ ] **Step 4: Write failing canonical-path tests**

Add to `src/vault/new_note.rs`:

```rust
#[test]
fn projected_note_path_uses_kind_project_and_supplied_short_id() {
    let created = chrono::DateTime::parse_from_rfc3339("2026-08-09T12:00:00Z").unwrap().to_utc();

    let path = build_projected_note_path(
        "The Left Hand of Darkness",
        created,
        Kind::Book,
        Some("ursula"),
        "Ab3xYz90",
    ).unwrap();

    assert_eq!(path.as_str(), "books/ursula/20260809.the-left-hand-of-darkness.Ab3xYz90.md");
}
```

Also assert `Kind::Note` with no project produces `notes/<filename>` and invalid project traversal is rejected by `VaultPath`/project validation.

- [ ] **Step 5: Implement deterministic projected path construction**

Add:

```rust
pub(crate) fn build_projected_note_path(
    title: &str,
    created: chrono::DateTime<chrono::Utc>,
    kind: Kind,
    project: Option<&str>,
    short_id: &str,
) -> Result<VaultPath, NewNoteError> {
    let title = title.trim();
    if title.is_empty() { return Err(NewNoteError::EmptyTitle); }
    let filename = crate::vault::page_filename::page_filename(created, title, short_id);
    let folder = match project.map(str::trim).filter(|value| !value.is_empty()) {
        Some(project) => format!("{}/{project}", kind.canonical_folder()),
        None => kind.canonical_folder().to_string(),
    };
    VaultPath::new(&format!("{folder}/{filename}"))
        .map_err(|error| NewNoteError::InvalidPath(error.to_string()))
}
```

The API validates project slugs before calling this helper. Leave `build_note_path` and CLI/default-page behavior unchanged.

- [ ] **Step 6: Run focused tests and format**

Run: `cargo test vault::property_value vault::new_note -- --nocapture`

Expected: PASS.

Run: `cargo fmt --check`

Expected: PASS.

- [ ] **Step 7: Commit coercion and path helpers**

```bash
git add src/vault/property_value.rs src/vault/new_note.rs src/vault/mod.rs
git commit -m "feat(vault): build typed Base member pages"
```

---

### Task 3: Atomic Base-Member API and OpenAPI Contract

**Files:**
- Create: `src/api/base_members.rs`
- Modify: `src/api/bases.rs`
- Modify: `src/api/pages.rs`
- Modify: `src/api/error.rs`
- Modify: `src/api/mod.rs`
- Modify: `src/api/openapi.rs`
- Modify: `tests/bases_api.rs`
- Regenerate: `ui/src/api/schema.d.ts`

**Interfaces:**
- Consumes: Task 1 capability/evaluation APIs; Task 2 coercion/path APIs; `base_document::load`; `MutationCoordinator::create_page`; `SyncNotification`.
- Produces:
  - `POST /api/vault/bases/{slug}/members`
  - `BaseMemberCreateRequest { base_revision, view, title, fields }`
  - `BaseMemberCreateResponse { id, path, title, revision }`
  - `BaseMemberValidationDetail { diagnostics }`
  - `BaseDetailResponse.member_creation: Vec<BaseMemberCapability>`
  - generated TypeScript schemas and path operation.

- [ ] **Step 1: Write failing API tests for successful atomic creation**

Append to `tests/bases_api.rs`:

```rust
#[tokio::test]
async fn create_base_member_writes_one_matching_typed_page() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let detail: serde_json::Value = fixture.server
        .get("/api/vault/bases/reading").await.json();
    let revision = detail["revision"].as_str().unwrap();

    let response = fixture.server
        .post("/api/vault/bases/reading/members")
        .json(&serde_json::json!({
            "base_revision": revision,
            "view": "Continues",
            "title": "The Left Hand of Darkness",
            "fields": {
                "kind": "BOOK",
                "author": "Le Guin",
                "status": "reading",
                "rating": 10,
                "started": "2026-08-09"
            }
        }))
        .await;

    response.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = response.json();
    let path = body["path"].as_str().unwrap();
    assert!(path.starts_with("books/20260809.the-left-hand-of-darkness."));

    let page = clepsydra::vault::page::Page::from_file(
        &fixture.state.vault.resolve(&clepsydra::vault::path::VaultPath::new(path).unwrap()),
        clepsydra::vault::path::VaultPath::new(path).unwrap(),
    ).unwrap();
    assert_eq!(page.meta.kind, Some(clepsydra::vault::kind::Kind::Book));
    assert_eq!(page.meta.extra["rating"], toml::Value::Integer(10));
    assert!(matches!(page.meta.extra["started"], toml::Value::Datetime(_)));
    assert!(page.body.is_empty());

    let view: serde_json::Value = fixture.server
        .get("/api/vault/bases/reading/views/continues").await.json();
    assert!(view["rows"].as_array().unwrap().iter().any(|row| row["id"] == body["id"]));
}
```

- [ ] **Step 2: Run the success test and verify RED**

Run: `cargo test --test bases_api create_base_member_writes_one_matching_typed_page -- --exact`

Expected: FAIL with `404` because the route does not exist.

- [ ] **Step 3: Add request, response, and structured error contracts**

Create `src/api/base_members.rs`:

```rust
#[derive(Debug, Deserialize, ToSchema)]
pub struct BaseMemberCreateRequest {
    pub base_revision: String,
    pub view: String,
    pub title: String,
    #[serde(default)]
    pub fields: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BaseMemberCreateResponse {
    pub id: String,
    pub path: String,
    pub title: String,
    pub revision: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BaseMemberValidationDetail {
    pub diagnostics: Vec<BaseMemberDiagnostic>,
}
```

Request field order is not semantically significant, so use the standard-library map and add no dependency. Add to `ApiError`:

```rust
pub fn unprocessable_with_detail(msg: impl Into<String>, detail: serde_json::Value) -> Self {
    Self { status: 422, error: msg.into(), detail: Some(detail), hint: None }
}
```

- [ ] **Step 4: Implement system/custom field conversion and candidate construction**

In `base_members.rs`, use these exact helpers:

```rust
fn apply_system_field(meta: &mut PageMeta, key: &str, value: &serde_json::Value)
    -> Result<bool, BaseMemberDiagnostic>;

fn apply_custom_field(
    meta: &mut PageMeta,
    base: &BaseDefinition,
    key: &str,
    value: &serde_json::Value,
) -> Result<(), BaseMemberDiagnostic>;
```

`apply_system_field` recognizes only `kind`, `project`, `tags`, and `aliases`. Default missing kind to `Kind::Note` and persist that declaration. Reject `id`, `path`, timestamps, `journal_date`, `word_count`, and `title` inside `fields`; title belongs at the top level. Change `validate_project_slug` in `src/api/pages.rs` to `pub(super)` and call `super::pages::validate_project_slug`; do not add a second validator. Change `document_error` in `src/api/bases.rs` to `pub(super)` so the member adapter reuses identical Base-file error mapping. `apply_custom_field` resolves bare or `prop.` keys against `BaseDefinition.file.properties`, rejects undeclared keys, and calls `coerce_property_value`.

- [ ] **Step 5: Implement the atomic handler with bounded collision retry**

Use a private implementation accepting an ID source so collision behavior is testable:

```rust
const MAX_PATH_ATTEMPTS: usize = 4;

async fn create_base_member_with_ids(
    state: Arc<AppState>,
    slug: String,
    request: BaseMemberCreateRequest,
    mut short_ids: impl Iterator<Item = String>,
) -> Result<BaseMemberCreateResponse, ApiError>;

pub async fn create_base_member(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(request): Json<BaseMemberCreateRequest>,
) -> Result<(StatusCode, Json<BaseMemberCreateResponse>), ApiError> {
    let ids = std::iter::repeat_with(crate::vault::block_id::generate_short_id);
    create_base_member_with_ids(state, slug, request, ids)
        .await
        .map(|response| (StatusCode::CREATED, Json(response)))
}
```

Handler order is mandatory:

```rust
let stored = base_document::load(state.vault.root(), &slug).map_err(document_error)?;
if stored.revision != request.base_revision {
    return Err(ApiError::conflict_with_detail(
        "base changed since the draft was opened",
        serde_json::json!({ "code": "base_revision_conflict", "current_revision": stored.revision }),
    ));
}
let view = stored.definition.view(&request.view).cloned()
    .ok_or_else(|| ApiError::not_found(format!("base `{slug}` has no view named `{}`", request.view)))?;
```

Then trim/validate title, build `PageMeta`, derive a path with the same `state.clock.now()` used for timestamps, call `candidate_matches` with `word_count: 0`/`journal_date: None`, and only then call `mutation_coordinator.create_page`. Retry only `MutationError::Conflict` messages caused by a generated-path collision; map all other errors through `super::mutation_error`. Emit the standard index-changed notification. Return `page_revision` from the created page content using the same response helper conventions as `pages.rs`.

- [ ] **Step 6: Add rejection and no-artifact tests**

Add a shared assertion:

```rust
fn collect_page_paths(root: &Path, current: &Path, paths: &mut Vec<String>) {
    for entry in fs::read_dir(current).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.is_dir() {
            collect_page_paths(root, &path, paths);
        } else if path.extension().is_some_and(|extension| extension == "md") {
            paths.push(path.strip_prefix(root).unwrap().to_string_lossy().into_owned());
        }
    }
}

fn page_paths(root: &Path) -> Vec<String> {
    let mut paths = Vec::new();
    collect_page_paths(root, root, &mut paths);
    paths.sort();
    paths
}
```

Test a snapshot before and after each rejection:

```rust
#[tokio::test]
async fn member_rejections_leave_no_file_or_index_row() {
    let fixture = ApiFixture::builder().pre_index_seed(seed).build();
    let before = page_paths(fixture.state.vault.root());
    let revision = current_base_revision(&fixture, "reading").await;

    for request in [
        json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Queued", "fields": { "kind": "BOOK", "status": "queued" } }),
        json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Wrong kind", "fields": { "kind": "NOTE", "status": "reading" } }),
        json!({ "base_revision": revision.clone(), "view": "Continues", "title": "Bad rating", "fields": { "kind": "BOOK", "status": "reading", "rating": "five" } }),
    ] {
        fixture.server.post("/api/vault/bases/reading/members").json(&request).await
            .assert_status(StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(page_paths(fixture.state.vault.root()), before);
    }
}
```

Add distinct tests for blank title (`400`), stale Base revision (`409` plus current revision detail), unknown Base/view (`404`), unknown/reserved fields (`400`), all custom property types, and compound `all`/`any`/`not` filters. In `src/api/base_members.rs`, unit-test collision retry by passing `create_base_member_with_ids` an iterator whose first ID maps to a pre-seeded path and whose second ID is free; assert the response uses the second path and only that page is created. For index rollback, terminate the fixture index thread with `state.index.with_index(|_, _| -> () { panic!("terminate index thread for failure test") }).await`, submit a matching member, assert `500`, and assert the generated page file is absent, matching the existing coordinator failure contract.

- [ ] **Step 7: Test Base detail capability and route/OpenAPI registration**

Extend `get_base_returns_definition_and_unknown_is_404`:

```rust
assert_eq!(body["member_creation"][0]["view"], "Continues");
assert_eq!(body["member_creation"][0]["enabled"], true);
assert!(body["member_creation"][0]["fields"].as_array().unwrap()
    .iter().any(|field| field["field"] == "status" && field["membership"] == false && field["view"] == true));
```

Add OpenAPI assertions:

```rust
let document = serde_json::to_value(ApiDoc::openapi()).unwrap();
assert!(document["paths"]["/api/vault/bases/{slug}/members"]["post"].is_object());
assert!(document["components"]["schemas"]["BaseMemberCreateRequest"].is_object());
assert!(document["components"]["schemas"]["BaseMemberCapability"].is_object());
```

Register the handler path and every new schema in `src/api/openapi.rs`. Register `pub mod base_members;` in `src/api/mod.rs`. Merge the member route in `bases::router()`:

```rust
.route("/{slug}/members", post(super::base_members::create_base_member))
```

Populate `BaseDetailResponse.member_creation` with `creation_capabilities(&stored.definition)`.

- [ ] **Step 8: Run backend endpoint and OpenAPI tests**

Run: `cargo test --test bases_api`

Expected: PASS.

Run: `cargo test vault::base_member vault::property_value`

Expected: PASS.

Run: `cargo check --all-targets`

Expected: PASS.

- [ ] **Step 9: Regenerate the TypeScript OpenAPI client**

Start the backend through the harness service manager with a temporary initialized vault on port `3000`:

```text
application: cargo
args: ["run", "--", "serve", "--port", "3000"]
ready port: 3000
```

Run: `bun run --cwd ui openapi`

Expected: `ui/src/api/schema.d.ts` contains `post` for `/api/vault/bases/{slug}/members`, `BaseMemberCreateRequest`, `BaseMemberCreateResponse`, `BaseMemberCapability`, and `BaseDetailResponse.member_creation`.

Stop the backend service after generation.

- [ ] **Step 10: Commit the API slice**

```bash
git add src/api/base_members.rs src/api/bases.rs src/api/pages.rs src/api/error.rs src/api/mod.rs src/api/openapi.rs tests/bases_api.rs ui/src/api/schema.d.ts
git commit -m "feat(api): create Base members atomically"
```

---

### Task 4: Frontend Member API and Draft Model

**Files:**
- Modify: `ui/src/api/bases.ts`
- Create: `ui/src/components/bases/member-draft.ts`
- Modify: `ui/src/api/bases.test.ts`
- Create: `ui/src/components/bases/__tests__/member-draft.test.ts`

**Interfaces:**
- Consumes: generated `BaseMemberCreateRequest`, `BaseMemberCreateResponse`, `BaseMemberCapability`, `BaseMemberDiagnostic`, `BaseDetailResponse`, and existing query-key invalidation helpers.
- Produces:
  - `useCreateBaseMember()`
  - `invalidateBaseMemberQueries(queryClient: QueryClient): void`
  - `decodeBaseMemberDiagnostics(error: unknown): BaseMemberDiagnostic[]`
  - `DraftFieldKind = "title" | "kind" | "project" | "tags" | "aliases" | "property"`
  - `BaseMemberDraftField { key, kind, definition?, membership, viewOnly }`
  - `BaseMemberDraftValue { title: string, fields: Record<string, CellValue> }`
  - `composeMemberDraftFields(definition, viewName, capability)`
  - `initialMemberDraft(fields)`

- [ ] **Step 1: Write failing pure-model tests**

Create `member-draft.test.ts`:

```ts
it("orders title, active columns, then filter-only fields without duplicates", () => {
  const fields = composeMemberDraftFields(
    definition,
    "Continues",
    {
      view: "Continues",
      enabled: true,
      fields: [
        { field: "kind", membership: true, view: false },
        { field: "status", membership: false, view: true },
        { field: "author", membership: true, view: false },
      ],
      blockers: [],
    },
  );

  expect(fields.map((field) => field.key)).toEqual([
    "title",
    "author",
    "rating",
    "kind",
    "status",
  ]);
  expect(fields.find((field) => field.key === "status")).toMatchObject({
    membership: false,
    viewOnly: true,
  });
});

it("defaults creatable system values without inventing custom values", () => {
  const draft = initialMemberDraft([
    titleField,
    kindField,
    tagsField,
    propertyField("status"),
  ]);
  expect(draft).toEqual({ title: "", fields: { kind: "NOTE", tags: [] } });
});
```

Also test active views with no columns, `sys.`/`prop.` normalization, system read-only columns omitted, undeclared filter keys retained as non-creatable diagnostics rather than controls, and no mutation of generated API objects.

- [ ] **Step 2: Run the model test and verify RED**

Run: `bun run --cwd ui test src/components/bases/__tests__/member-draft.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement field composition as pure functions**

Use the Base’s active view and property map:

```ts
const CREATABLE_SYSTEM = new Set(["kind", "project", "tags", "aliases"]);
const READ_ONLY_SYSTEM = new Set([
  "id", "path", "created_at", "updated_at", "journal_date", "word_count",
]);

export function composeMemberDraftFields(
  definition: BaseDetailResponse,
  viewName: string,
  capability: BaseMemberCapability,
): BaseMemberDraftField[] {
  const view = definition.views.find(
    (candidate) => asciiCaseFold(candidate.name) === asciiCaseFold(viewName),
  );
  const ordered = ["title", ...(view?.columns ?? []), ...capability.fields.map((item) => item.field)];
  // Normalize field prefixes, preserve first occurrence, and classify each key.
  return dedupeAndClassify(ordered, definition.properties ?? {}, capability);
}
```

`title` is always first. A Base-declared property becomes `kind: "property"` with its exact `PropertyDefinition`. Filter-only fields carry `membership` and `viewOnly` labels from capability. Omit repeated title and read-only derived controls.

- [ ] **Step 4: Add the mutation hook and structured diagnostic decoder**

In `ui/src/api/bases.ts` export generated types and add:

```ts
export function useCreateBaseMember() {
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/vault/bases/{slug}/members", {
    onSuccess: () => {
      invalidateByPath(qc, queryKeys.bases.pathPrefix);
      invalidateByPath(qc, queryKeys.query.pathPrefix);
      invalidateByPath(qc, queryKeys.pages.pathPrefix);
    },
  });
}
```

Decode only the server’s typed detail shape; unknown errors return an empty list:

```ts
export function decodeBaseMemberDiagnostics(error: unknown): BaseMemberDiagnostic[] {
  if (!isApiError(error) || typeof error.detail !== "object" || !error.detail) return [];
  const diagnostics = (error.detail as { diagnostics?: unknown }).diagnostics;
  return Array.isArray(diagnostics) ? diagnostics as BaseMemberDiagnostic[] : [];
}
```

Reuse `isApiError` from `#/api/error`.

- [ ] **Step 5: Test diagnostic decoding and query invalidation**

Add decoder and invalidation assertions in `ui/src/api/bases.test.ts`:

```ts
expect(decodeBaseMemberDiagnostics({
  status: 422,
  error: "candidate rejected",
  detail: { diagnostics: [{ scope: "view", field: "status", message: "must equal reading" }] },
})).toEqual([{ scope: "view", field: "status", message: "must equal reading" }]);
expect(decodeBaseMemberDiagnostics({ status: 500, error: "failed" })).toEqual([]);
expect(decodeBaseMemberDiagnostics({ detail: { diagnostics: "invalid" } })).toEqual([]);

const queryClient = new QueryClient();
const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
invalidateBaseMemberQueries(queryClient);
expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.bases.pathPrefix });
expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.query.pathPrefix });
expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.pages.pathPrefix });
```

`useCreateBaseMember` calls `invalidateBaseMemberQueries` in `onSuccess`; do not duplicate the three paths in the hook body.

Run: `bun run --cwd ui test src/api/bases.test.ts src/components/bases/__tests__/member-draft.test.ts`

Expected: PASS.

Run: `bun run --cwd ui typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the frontend model slice**

```bash
git add ui/src/api/bases.ts ui/src/api/bases.test.ts ui/src/components/bases/member-draft.ts ui/src/components/bases/__tests__/member-draft.test.ts
git commit -m "feat(ui): model inline Base member drafts"
```

---

### Task 5: Accessible Inline Draft Component

**Files:**
- Create: `ui/src/components/bases/BaseMemberDraft.tsx`
- Create: `ui/src/components/bases/__tests__/BaseMemberDraft.test.tsx`
- Modify: `ui/src/components/bases/EditableCell.tsx`
- Modify: `ui/src/components/bases/cells/types.ts`
- Modify: every editor in `ui/src/components/bases/cells/`
- Modify: `ui/src/components/bases/__tests__/cells.test.tsx`
- Modify: `ui/src/components/codex/KindSelect.tsx`
- Modify: `ui/src/components/codex/ProjectCombo.tsx`
- Modify: `ui/src/components/ui/tag-input.tsx`

**Interfaces:**
- Consumes: Task 4 draft field/value types, existing `EditableCell`, `CellValue`, `KindSelect`, `ProjectCombo`, and `TagInput`.
- Produces:

```ts
interface BaseMemberDraftProps {
  fields: BaseMemberDraftField[];
  projects: string[];
  isSaving: boolean;
  diagnostics: BaseMemberDiagnostic[];
  summaryError?: string;
  onSave(value: BaseMemberDraftValue): void;
  onCancel(): void;
}
```

- [ ] **Step 1: Write failing lifecycle and focus tests**

Create `BaseMemberDraft.test.tsx`:

```tsx
it("focuses title, preserves values, and submits the complete draft", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn();
  render(
    <BaseMemberDraft
      fields={fields}
      projects={["clepsydra"]}
      isSaving={false}
      diagnostics={[]}
      onSave={onSave}
      onCancel={vi.fn()}
    />,
  );

  const title = screen.getByRole("textbox", { name: "New member — Title" });
  expect(title).toHaveFocus();
  await user.type(title, "The Dispossessed");
  await user.click(screen.getByRole("button", { name: "Edit New member — Rating" }));
  await user.type(screen.getByRole("spinbutton", { name: "New member — Rating" }), "9");
  await user.click(screen.getByRole("button", { name: "Save new member" }));

  expect(onSave).toHaveBeenCalledWith({
    title: "The Dispossessed",
    fields: expect.objectContaining({ kind: "NOTE", rating: 9 }),
  });
});
```

Extend `CellEditorProps` and `EditableCellProps` with `ariaLabel?: string` and `ariaDescribedBy?: string`. Every cell editor uses `aria-label={ariaLabel ?? "<existing label>"}` plus `aria-describedby={ariaDescribedBy}`. Label the `EditableCell` display button `Edit ${ariaLabel}` when supplied and pass both accessibility props into the active editor. Extend `KindSelectProps`, `ProjectComboProps`, and `TagInputProps` with the same optional label/description inputs, defaulting to their existing labels. Cover defaults and overrides in `cells.test.tsx` and `BaseMemberDraft.test.tsx`.

- [ ] **Step 2: Write failing keyboard and error-focus tests**

```tsx
it("uses command-enter to save and escape to cancel after editors decline it", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn();
  const onCancel = vi.fn();
  renderDraft({ onSave, onCancel });
  await user.type(screen.getByRole("textbox", { name: "New member — Title" }), "A Book");
  await user.keyboard("{Meta>}{Enter}{/Meta}");
  expect(onSave).toHaveBeenCalledOnce();
  await user.keyboard("{Escape}");
  expect(onCancel).toHaveBeenCalledOnce();
});

it("associates diagnostics and focuses the first invalid field", () => {
  const { rerender } = renderDraft({ diagnostics: [] });
  rerender(renderDraftElement({
    diagnostics: [{ scope: "view", field: "status", filter_path: "views.Unread.filter", message: "status must equal unread" }],
    summaryError: "Candidate does not match the active view",
  }));
  expect(screen.getByRole("alert")).toHaveTextContent("Candidate does not match the active view");
  const status = screen.getByRole("button", { name: "Edit New member — Status" });
  expect(status).toHaveFocus();
  expect(status).toHaveAccessibleDescription("status must equal unread");
});
```

Also test blank title blocks local submit, saving disables controls, filter-only labels identify membership/view requirements, and Escape from an active property editor closes that editor without cancelling the row.

- [ ] **Step 3: Run component tests and verify RED**

Run: `bun run --cwd ui test src/components/bases/__tests__/BaseMemberDraft.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 4: Implement controlled field adapters**

`BaseMemberDraft` owns only unsaved form state initialized by `initialMemberDraft(fields)`. Declared properties reuse the existing click-to-edit lifecycle so only one editor auto-focuses and every value is committed into draft state before row submission:

```tsx
function DraftPropertyCell({ field, value, onChange, errorId }: DraftCellProps) {
  const label = `New member — ${fieldLabel(field.key)}`;
  return (
    <EditableCell
      value={value ?? null}
      definition={field.definition!}
      ariaLabel={label}
      ariaDescribedBy={errorId}
      onCommit={(next) => onChange(field.key, next)}
    />
  );
}
```

Use `KindSelect ariaLabel="New member — Kind"` with local `onAssign`, `ProjectCombo ariaLabel="New member — Project"` with local `onAssign`/`onClear`, and `TagInput` with labels `New member — Tags` and `New member — Aliases`. Render title as a normal labeled input. Render filter-only requirement text inside the column header/cell description, not only through color.

- [ ] **Step 5: Implement row keyboard ownership and errors**

Attach one `onKeyDown` to the draft form wrapper:

```tsx
const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
  if (event.defaultPrevented) return;
  if (event.key === "Escape") {
    event.preventDefault();
    onCancel();
    return;
  }
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    submit();
  }
};
```

Use stable IDs derived from `useId()` for `aria-describedby`. A row summary uses `role="alert"`; field messages use non-live descriptions to avoid duplicate announcements. On a diagnostics prop change, focus the first field named by a diagnostic. The component never clears its state after a rejected save.

- [ ] **Step 6: Run focused component and cell tests**

Run: `bun run --cwd ui test src/components/bases/__tests__/BaseMemberDraft.test.tsx src/components/bases/__tests__/cells.test.tsx`

Expected: PASS.

Run: `bun run --cwd ui typecheck`

Expected: PASS.

Run: `bunx --cwd ui biome lint src/components/bases/BaseMemberDraft.tsx src/components/bases/EditableCell.tsx src/components/bases/cells src/components/codex/KindSelect.tsx src/components/codex/ProjectCombo.tsx src/components/ui/tag-input.tsx src/components/bases/__tests__/BaseMemberDraft.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit the draft component**

```bash
git add ui/src/components/bases/BaseMemberDraft.tsx ui/src/components/bases/EditableCell.tsx ui/src/components/bases/cells ui/src/components/bases/__tests__/BaseMemberDraft.test.tsx ui/src/components/bases/__tests__/cells.test.tsx ui/src/components/codex/KindSelect.tsx ui/src/components/codex/ProjectCombo.tsx ui/src/components/ui/tag-input.tsx
git commit -m "feat(ui): render accessible Base member drafts"
```

---

### Task 6: Base Table Wiring, Refresh, and Focus

**Files:**
- Modify: `ui/src/components/bases/BaseTable.tsx`
- Modify: `ui/src/components/bases/BaseTableView.tsx`
- Create: `ui/src/components/bases/__tests__/BaseTable.test.tsx`
- Modify: `ui/src/components/bases/__tests__/BaseTableView.test.tsx`

**Interfaces:**
- Consumes: `useCreateBaseMember`, `decodeBaseMemberDiagnostics`, `composeMemberDraftFields`, `BaseMemberDraft`, Base detail `member_creation`, existing `useBaseView`, and `useProjects`.
- Produces: complete Add member workflow, disabled capability explanation, one-draft invariant, mutation submission, query refresh, grouped/sorted placement, and post-refresh title focus.

- [ ] **Step 1: Write failing toolbar/capability integration tests**

Extend `BaseTableView.test.tsx`:

```tsx
it("opens exactly one draft and explains disabled capability", async () => {
  const user = userEvent.setup();
  const { rerender } = renderView({
    memberCapability: enabledCapability,
    memberDraftOpen: false,
  });
  await user.click(screen.getByRole("button", { name: "Add member" }));
  expect(screen.getByRole("textbox", { name: "New member — Title" })).toHaveFocus();
  expect(screen.getAllByRole("button", { name: "Add member" })).toHaveLength(1);

  rerender(viewElement({
    memberCapability: {
      view: "Continues",
      enabled: false,
      fields: [],
      blockers: [{ scope: "membership", field: "word_count", filter_path: "filter", message: "word_count > 0 requires body content" }],
    },
  }));
  const add = screen.getByRole("button", { name: "Add member" });
  expect(add).toBeDisabled();
  expect(add).toHaveAccessibleDescription("word_count > 0 requires body content");
});
```

Keep `BaseTableView` presentational by adding explicit props for capability, draft visibility/state, and callbacks rather than importing API hooks into it.

- [ ] **Step 2: Write failing mutation/failure preservation test at `BaseTable` level**

Create `BaseTable.test.tsx`. Mock `useCreateBaseMember`, `useBase`, and `useBaseView` following the existing test module conventions. Assert the request exactly:

```tsx
expect(createMutateAsync).toHaveBeenCalledWith({
  params: { path: { slug: "reading" } },
  body: {
    base_revision: "base-rev-1",
    view: "Continues",
    title: "The Dispossessed",
    fields: { kind: "BOOK", status: "reading", rating: 9 },
  },
});
```

Reject with a `422` detail and assert title/rating remain populated. Resolve with `{ id, path, title, revision }`, update the mocked query output with that row, rerender, and assert the new title button receives focus.

- [ ] **Step 3: Run integration tests and verify RED**

Run: `bun run --cwd ui test src/components/bases/__tests__/BaseTable.test.tsx src/components/bases/__tests__/BaseTableView.test.tsx`

Expected: FAIL because Add member props/wiring do not exist.

- [ ] **Step 4: Wire mutation and capability selection in `BaseTable`**

Add state:

```ts
const [memberDraftOpen, setMemberDraftOpen] = useState(false);
const [memberError, setMemberError] = useState<string>();
const [memberDiagnostics, setMemberDiagnostics] = useState<BaseMemberDiagnostic[]>([]);
const [focusCreatedId, setFocusCreatedId] = useState<string>();
```

Select capability case-insensitively from `detail.data.member_creation`. On save:

```ts
async function createMember(value: BaseMemberDraftValue) {
  setMemberError(undefined);
  setMemberDiagnostics([]);
  try {
    const created = await createMemberMutation.mutateAsync({
      params: { path: { slug } },
      body: {
        base_revision: detail.data!.revision,
        view: activeView!,
        title: value.title.trim(),
        fields: value.fields,
      },
    });
    setMemberDraftOpen(false);
    setFocusCreatedId(created.id);
  } catch (error) {
    setMemberError(formatApiError(error, "Member could not be created."));
    setMemberDiagnostics(decodeBaseMemberDiagnostics(error));
  }
}
```

Do not clear draft component state on failure. Reset diagnostics only when the user edits/resubmits, cancels, changes views, or succeeds.

- [ ] **Step 5: Render the draft above flat/grouped results in `BaseTableView`**

Add the toolbar action next to Configure. Render one `BaseMemberDraft` immediately after the toolbar and before `viewError`/loading/groups/grid. The draft receives composed fields for the active view. Add member stays disabled while a draft is open, during mutation, or when capability is disabled. Associate the first blocker message with the disabled button through an ID-backed description.

Keep result tables unchanged; the draft does not claim a group before success.

- [ ] **Step 6: Implement created-row focus after authoritative refresh**

Keep title-button refs in `BaseTableView`:

```ts
const createdTitleRef = useRef<HTMLButtonElement | null>(null);
useEffect(() => {
  if (focusCreatedId && createdTitleRef.current) {
    createdTitleRef.current.focus();
    onCreatedRowFocused?.();
  }
}, [focusCreatedId, output, onCreatedRowFocused]);
```

Assign the ref only when `row.id === focusCreatedId`. `BaseTable` clears `focusCreatedId` through `onCreatedRowFocused`. If the refreshed query does not contain the ID, keep the marker through loading and clear it only after a settled successful output proves the row absent; surface a non-destructive notice rather than focusing an unrelated row.

- [ ] **Step 7: Run table tests and type/lint checks**

Run: `bun run --cwd ui test src/components/bases/__tests__/BaseTable.test.tsx src/components/bases/__tests__/BaseTableView.test.tsx src/components/bases/__tests__/BaseMemberDraft.test.tsx src/components/bases/__tests__/member-draft.test.ts`

Expected: PASS.

Run: `bun run --cwd ui typecheck`

Expected: PASS.

Run: `bun run --cwd ui lint`

Expected: PASS.

- [ ] **Step 8: Commit table integration**

```bash
git add ui/src/components/bases/BaseTable.tsx ui/src/components/bases/BaseTableView.tsx ui/src/components/bases/__tests__/BaseTable.test.tsx ui/src/components/bases/__tests__/BaseTableView.test.tsx
git commit -m "feat(ui): create members from Base tables"
```

---

### Task 7: Documentation, Browser Smoke Test, and Verification Gates

**Files:**
- Modify: `ui/src/docs/content/bases.mdx`
- Verify all files changed by Tasks 1-6.

**Interfaces:**
- Consumes: completed endpoint and UI.
- Produces: documented behavior, end-to-end browser proof, clean project verification gates, and a branch ready for review/merge.

- [ ] **Step 1: Update the Bases guide**

Add an **Add members inline** subsection near the existing table/editing section with this content, adapted to the guide’s established prose style:

```mdx
### Add members inline

Choose **Add member** in a saved table view to open one temporary row. Enter a title and the visible/filter-required properties, then choose **Save** or press <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd>. Clepsydra creates the Markdown page only when its metadata matches both the Base membership filter and the active view filter. A rejected row remains editable and creates no file.

Press <kbd>Escape</kbd> to cancel after any open field editor has closed. Derived filters that an empty page cannot satisfy—for example `word_count > 0`—disable **Add member** and explain the blocking constraint. Create the page in Folio when initial body content is required.
```

Also state that creation makes a new page, not enrollment of an existing page, and that the final row moves to its real sort/group position after saving.

- [ ] **Step 2: Run focused backend and frontend suites**

Run: `cargo test --test bases_api`

Expected: PASS.

Run: `cargo test vault::base_member vault::property_value vault::new_note`

Expected: PASS.

Run: `bun run --cwd ui test src/components/bases/__tests__`

Expected: PASS.

- [ ] **Step 3: Start an isolated smoke-test server**

Create a temporary vault, initialize it with the project CLI, and seed:

```toml
# bases/reading.base.toml
name = "Reading"
filter = { field = "kind", op = "eq", value = "BOOK" }

[properties]
status = { type = "select", options = ["queued", "reading", "finished"] }
rating = { type = "number" }

[[views]]
name = "Reading"
layout = "table"
filter = { field = "status", op = "eq", value = "reading" }
group_by = "rating"
columns = ["title", "status", "rating"]
```

Start the backend through the harness service manager, configured to use only that temporary vault. Start the Vite frontend through the service manager with its existing backend proxy configuration. Do not use the user’s real vault.

- [ ] **Step 4: Exercise the changed path in Chromium**

Using the Browser tool:

1. Open the seeded Reading Base.
2. Choose **Add member** and verify focus starts in Title.
3. Enter title `The Dispossessed`, kind `BOOK`, status `reading`, and rating `9`.
4. Save with `Cmd+Enter`.
5. Verify the row appears under group `9` and its title link has focus.
6. Open the title in Folio and verify title/kind plus empty body.
7. Return to the Base, reload the page, and verify the row persists in group `9`.
8. Inspect the temporary vault file and verify one canonical `books/yyyymmdd.the-dispossessed.<shortid>.md` exists with native numeric `rating = 9` and `status = "reading"`.

Record the observed path and browser result in the implementation report; do not add screenshot artifacts unless a visual defect needs evidence.

- [ ] **Step 5: Run all repository verification gates**

Run: `cargo fmt --check`

Expected: PASS.

Run: `cargo check --all-targets`

Expected: PASS.

Run: `cargo clippy --all-targets -- -D warnings`

Expected: PASS.

Run: `cargo test`

Expected: PASS.

Run: `bun run --cwd ui typecheck`

Expected: PASS.

Run: `bun run --cwd ui lint`

Expected: PASS.

Run: `bun run --cwd ui test`

Expected: PASS.

- [ ] **Step 6: Commit documentation**

```bash
git add ui/src/docs/content/bases.mdx
git commit -m "docs(bases): explain inline member creation"
```

- [ ] **Step 7: Request code review and resolve findings**

Invoke `requesting-code-review`. Review against `docs/superpowers/specs/2026-08-09-inline-base-member-creation-design.md` and this plan. Fix only evidence-backed findings, rerun the focused test for each fix, then rerun every gate from Step 5.

- [ ] **Step 8: Finish and merge the feature branch**

Invoke `finishing-a-development-branch`. Present the verified branch result, merge into `develop` as required by the project workflow, and confirm the integration branch contains all task commits. Do not leave compatibility aliases, dead routes, stale generated schema, or temporary smoke-test files.
